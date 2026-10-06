import 'reflect-metadata';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Logger } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadDeploymentConfig, assertCompatibleCloudIdentity, deploymentFetch } from './lib/deployment-config.mjs';
import { readCloudEnvironment } from './lib/deployment-platform.mjs';

// Explicit post-deployment probe: UUID-scoped synthetic OAuth fixtures only, no employee lookup.
// The fake Feishu account has no business scopes or usable Feishu credentials. Its phone call
// must stop at the scope guard. Revoke only this fixture and remove its account in finally.
const require = createRequire(import.meta.url);
const CLIENT_ID = 'chatgpt_confidential';
const envKeys = ['CONNECTOR_STORAGE_API_KEY', 'CONNECTOR_STORAGE_ENCRYPTION_KEY',
  'CONNECTOR_PUBLIC_URL', 'CONNECTOR_DEPLOYMENT_CONFIG'];
const previousEnv = new Map(envKeys.map(key => [key, process.env[key]]));
const loggerMethods = ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'];
const originalLoggers = new Map(loggerMethods.map(method => [method, Logger.prototype[method]]));
for (const method of loggerMethods) Logger.prototype[method] = () => {};
const started = performance.now();
const fixture = { accountId: undefined, grantId: undefined };
const observations = {};
let phase = 'configuration';
let checks = 0;
let passed = false;
let cleanupComplete = true;
let store;
let mcp;
let environment = [];
let secret;
let bearer;
function stage(next) {
  phase = next;
  console.log(JSON.stringify({ phase, elapsedMs: Math.round(performance.now() - started) }));
}
function check(value) { assert.ok(value); checks++; }
try {
  const deployment = loadDeploymentConfig();
  environment = readCloudEnvironment(deployment.miaodaAppId);
  assertCompatibleCloudIdentity(environment, deployment);
  for (const key of ['CONNECTOR_STORAGE_API_KEY', 'CONNECTOR_STORAGE_ENCRYPTION_KEY']) {
    const value = environment.find(item => item.key === key)?.value;
    check(typeof value === 'string' && value);
    process.env[key] = value;
  }
  secret = environment.find(item => item.key === 'CONNECTOR_CHATGPT_CLIENT_SECRET')?.value;
  check(typeof secret === 'string' && secret);
  check(secret !== environment.find(item => item.key === 'FEISHU_APP_SECRET')?.value);
  environment.length = 0;
  process.env.CONNECTOR_PUBLIC_URL = deployment.publicUrl;
  delete process.env.CONNECTOR_DEPLOYMENT_CONFIG;
  const { ConnectorAuthStorageCrypto } = require('../dist/server/modules/connector-auth-storage/connector-auth-storage.crypto.js');
  const { ConnectorAuthStorageService } = require('../dist/server/modules/connector-auth-storage/connector-auth-storage.service.js');
  const { createConnectorOidc } = require('../dist/server/modules/connector-auth/connector-oidc.factory.js');
  const { ConnectorAuthDiagnostics } = require('../dist/server/modules/connector-auth/connector-auth.diagnostics.js');
  store = new ConnectorAuthStorageService(new ConnectorAuthStorageCrypto());
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const config = { publicUrl: deployment.publicUrl, issuer: deployment.publicUrl + '/oidc',
    resource: deployment.publicUrl + '/mcp',
    signingJwks: { keys: [{ ...privateKey.export({ format: 'jwk' }), alg: 'RS256', use: 'sig', kid: 'synthetic-phone-probe' }] },
    cookieKeys: [randomBytes(32).toString('hex')], feishuAppId: deployment.feishuAppId,
    feishuAppSecret: 'synthetic-unused', feishuScopes: 'synthetic:read', chatgptClientSecret: secret };
  const { provider } = createConnectorOidc(config, store, { diagnostics: new ConnectorAuthDiagnostics(() => {}) });
  const client = await provider.Client.find(CLIENT_ID);
  check(client);
  stage('prepare_synthetic_fixture');
  const suffix = randomUUID();
  fixture.accountId = 'synthetic-phone:' + suffix;
  const now = Math.floor(Date.now() / 1000);
  const expiry = now + 900;
  const grant = new provider.Grant({ accountId: fixture.accountId, clientId: CLIENT_ID, exp: expiry, expiresIn: 900 });
  grant.jti = grant.generateTokenId();
  fixture.grantId = grant.jti;
  grant.addResourceScope(config.resource, 'feishu.read');
  await store.put('FeishuAccount', fixture.accountId, { tenant_key: 'synthetic-phone', open_id: suffix,
    access_token: 'synthetic-no-feishu-business-access', access_expires_at: expiry, scope: 'synthetic:read' }, expiry);
  check(await grant.save() === fixture.grantId);
  await store.put('Consent', fixture.grantId, { accountId: fixture.accountId, grantId: fixture.grantId,
    clientId: CLIENT_ID, resource: config.resource, scopes: ['feishu.read'], expiresAt: expiry },
  expiry, undefined, fixture.grantId);
  const refresh = new provider.RefreshToken({ accountId: fixture.accountId, client, grantId: fixture.grantId,
    scope: 'feishu.read', resource: config.resource, expiresWithSession: false,
    iiat: now, authTime: now, gty: 'authorization_code', exp: expiry, expiresIn: expiry - Math.floor(Date.now() / 1000) });
  const refreshValue = await refresh.save();
  async function tokenRequest() {
    const response = await deploymentFetch(deployment, config.issuer + '/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT_ID,
        client_secret: secret, refresh_token: refreshValue, resource: config.resource, scope: 'feishu.read' }).toString(),
    });
    check(response.status === 200);
    const body = await response.json();
    check(typeof body.access_token === 'string' && body.access_token);
    check(body.refresh_token === refreshValue);
    return body.access_token;
  }
  stage('synthetic_cloud_authorization');
  bearer = await tokenRequest();
  mcp = new Client({ name: 'synthetic-phone-deployment-probe', version: '0.4.6' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(config.resource), {
    requestInit: { headers: { Authorization: 'Bearer ' + bearer } },
    fetch: (url, init) => deploymentFetch(deployment, url, init),
  }));
  stage('discover_phone_tool');
  const listed = await mcp.listTools();
  const phone = listed.tools.find(tool => tool.name === 'feishu_get_user_phone');
  check(listed.tools.length === 18);
  check(phone?.annotations?.readOnlyHint === true && phone.annotations.destructiveHint === false);
  check(phone.inputSchema?.properties?.query && phone.inputSchema?.properties?.userId);
  check(!phone.inputSchema.properties.url && !phone.inputSchema.properties.method && !phone.inputSchema.properties.token);
  observations.tools = listed.tools.length;
  observations.phoneTool = phone.name;
  observations.serverVersion = mcp.getServerVersion()?.version;
  check(observations.serverVersion === '0.4.6');
  stage('phone_scope_guard');
  const result = await mcp.callTool({ name: phone.name, arguments: { query: 'Synthetic Fixture' } });
  check(result.isError === true && result.structuredContent?.ok === false);
  check(result.structuredContent?.error?.code === 'feishu_scope_missing');
  check(result.structuredContent.error.scopeGroups?.some(group => group.includes('contact:user.phone:readonly')));
  observations.phoneResult = result.structuredContent.error.code;
  stage('connection_survives_missing_scope');
  check(await store.get('Grant', fixture.grantId));
  check(await store.get('Consent', fixture.grantId));
  const account = await store.get('FeishuAccount', fixture.accountId);
  check(account && account.revoked !== true);
  const catalog = await mcp.callTool({ name: 'feishu_native_catalog', arguments: { operation: 'contact.+get-user' } });
  check(catalog.isError !== true && catalog.structuredContent?.ok === true);
  bearer = await tokenRequest();
  observations.connectionPreserved = true;
  passed = true;
} catch {
  // Never print raw assertion values or exception stacks: they may contain credentials.
  process.exitCode = 1;
} finally {
  const failedPhase = passed ? undefined : phase;
  stage('cleanup');
  if (mcp) await mcp.close().catch(() => { cleanupComplete = false; });
  if (store && fixture.grantId) {
    try { await store.revokeGrant(fixture.grantId); } catch { cleanupComplete = false; }
  }
  if (store && fixture.accountId) {
    try { await store.remove('FeishuAccount', fixture.accountId); } catch { cleanupComplete = false; }
  }
  environment.length = 0;
  secret = undefined;
  bearer = undefined;
  for (const [key, value] of previousEnv) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  for (const [method, original] of originalLoggers) Logger.prototype[method] = original;
  if (!cleanupComplete) process.exitCode = 1;
  console.log(JSON.stringify({ ok: passed && cleanupComplete, failedPhase, checks, observations,
    syntheticFixtures: fixture.accountId ? 1 : 0, cleanupComplete, realEmployeeLookup: false,
    grantTombstonesRetained: true, durationMs: Math.round(performance.now() - started) }));
}
