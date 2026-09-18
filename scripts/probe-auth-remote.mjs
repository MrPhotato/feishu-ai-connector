import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { discoverOAuthServerInfo, extractWWWAuthenticateParams } from '@modelcontextprotocol/sdk/client/auth.js';
import { loadDeploymentConfig, deploymentFetch } from './lib/deployment-config.mjs';

const deployment = loadDeploymentConfig();
const base = deployment.publicUrl;
let phase = 'protected-resource';
const cookies = new Map();
async function ownRequest(url, options = {}) {
  const parsed = new URL(url);
  assert.equal(parsed.origin, new URL(base).origin);
  assert.ok(parsed.pathname.startsWith(new URL(base).pathname + '/'));
  const response = await deploymentFetch(deployment, url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(25000),
    headers: { ...options.headers, Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') } });
  for (const item of response.headers.getSetCookie()) {
    const pair = item.split(';', 1)[0];
    const separator = pair.indexOf('=');
    cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  return response;
}

try {
  const unauthenticated = await ownRequest(`${base}/mcp`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(unauthenticated.status, 401);
  const challenge = extractWWWAuthenticateParams(unauthenticated);
  assert.equal(challenge.resourceMetadataUrl?.href, `${base}/.well-known/oauth-protected-resource/mcp`);
  await unauthenticated.body?.cancel();
  phase = 'discovery';
  const info = await discoverOAuthServerInfo(`${base}/mcp`, {
    resourceMetadataUrl: challenge.resourceMetadataUrl,
    fetchFn: (url, options) => deploymentFetch(deployment, url,
      { ...options, signal: AbortSignal.timeout(20000) }, { discovery: true }),
  });
  const metadata = info.authorizationServerMetadata;
  // SDK's OIDC schema drops extension fields; verify those on the public raw document.
  const rawMetadata = await (await ownRequest(`${base}/oidc/.well-known/openid-configuration`)).json();
  assert.equal(info.resourceMetadata.resource, `${base}/mcp`);
  assert.equal(metadata.issuer, `${base}/oidc`);
  assert.equal(rawMetadata.authorization_response_iss_parameter_supported, true);
  assert.ok(metadata.code_challenge_methods_supported.includes('S256'));
  assert.ok(rawMetadata.revocation_endpoint?.startsWith(`${base}/oidc/`));
  assert.ok(metadata.scopes_supported.includes('offline_access'));
  phase = 'jwks';
  const jwks = await (await ownRequest(metadata.jwks_uri)).json();
  assert.ok(jwks.keys.length > 0);
  assert.ok(jwks.keys.every(key => key.kty === 'RSA' && key.alg === 'RS256' && !key.d && !key.p && !key.q));
  phase = 'authorization-storage-relay';
  const verifier = randomBytes(32).toString('base64url');
  const start = new URL(metadata.authorization_endpoint);
  start.search = new URLSearchParams({ client_id: 'chatgpt', response_type: 'code',
    redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
    resource: `${base}/mcp`, scope: 'openid offline_access feishu.read feishu.write',
    prompt: 'consent', state: randomBytes(24).toString('base64url'),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
  const authorization = await ownRequest(start);
  assert.ok([302, 303].includes(authorization.status));
  const interaction = authorization.headers.get('location');
  assert.ok(interaction?.startsWith(`${base}/interaction/`));
  await authorization.body?.cancel();
  phase = 'feishu-state-storage-relay';
  const next = await ownRequest(interaction);
  assert.ok([302, 303].includes(next.status));
  const upstream = new URL(next.headers.get('location'));
  assert.equal(upstream.origin, 'https://accounts.feishu.cn');
  assert.equal(upstream.searchParams.get('client_id'), deployment.feishuAppId);
  assert.equal(upstream.searchParams.get('redirect_uri'), `${base}/auth/feishu/callback`);
  assert.equal(upstream.searchParams.get('code_challenge_method'), 'S256');
  await next.body?.cancel();
  console.log(JSON.stringify({ passed: true, discovery: true, publicJwksOnly: true,
    managedServerStorageRelay: true, feishuAuthorizationPrepared: true, personalOAuthCompleted: false }));
} catch {
  console.error(JSON.stringify({ passed: false, phase, details: 'Suppressed to protect authorization data.' }));
  process.exitCode = 1;
} finally {
  cookies.clear();
}
