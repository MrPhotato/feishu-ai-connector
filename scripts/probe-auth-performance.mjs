import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { SignJWT } from 'jose';

// No network or credential configuration: independent synthetic signatures and mutable test records.
const require = createRequire(import.meta.url);
const { createConnectorOidc } = require('../dist/server/modules/connector-auth/connector-oidc.factory.js');
const { ConnectorAuthDiagnostics } = require('../dist/server/modules/connector-auth/connector-auth.diagnostics.js');
const { connectorRefreshConsent } = require('../dist/server/modules/connector-auth/connector-refresh.consent.js');
const { storageCommandSchema } = require('../dist/server/modules/connector-auth-storage/connector-auth-storage.contract.js');
const records = new Map();
const calls = [];
let active = 0;
let maxActive = 0;
const store = {
  async get(model, key) {
    calls.push(model); active += 1; maxActive = Math.max(active, maxActive);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    const found = records.get(`${model}:${key}`);
    if (found instanceof Error) throw found;
    return structuredClone(found);
  },
};
const messages = [];
const diagnostics = new ConnectorAuthDiagnostics((message) => messages.push(JSON.parse(message)));
const sentinel = `synthetic-private-${randomBytes(8).toString('hex')}`;
diagnostics.token(sentinel, 200, 1.2, sentinel);
diagnostics.storage(sentinel, sentinel, false, -1);
assert.deepEqual(messages[0], { event: 'connector_oauth_token', grantType: 'other', status: 200, durationMs: 1, expiresIn: 0 });
assert.deepEqual(messages[1], { event: 'connector_auth_storage', operation: 'other', model: 'none', ok: false, durationMs: 0 });
new ConnectorAuthDiagnostics(() => { throw Error(sentinel); }).token('refresh_token', 200, 1, 600);
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...privateKey.export({ format: 'jwk' }), alg: 'RS256', use: 'sig', kid: 'synthetic' };
const config = {
  publicUrl: 'https://issuer.test/app/test', issuer: 'https://issuer.test/app/test/oidc',
  resource: 'https://issuer.test/app/test/mcp', signingJwks: { keys: [jwk] }, cookieKeys: ['1'.repeat(64)],
  feishuAppId: 'synthetic', feishuAppSecret: sentinel, feishuScopes: 'synthetic:read',
};
const oidc = createConnectorOidc(config, store, { diagnostics });
const now = Math.floor(Date.now() / 1000);
assert.equal(storageCommandSchema.safeParse({ operation: 'put', model: 'FeishuAction', key: 'synthetic-action-hash',
  payload: { payloadHash: 'synthetic-payload-hash', status: 'pending' }, expiresAt: now + 60 }).success, true);
async function identity(label) {
  const accountId = `synthetic-tenant:synthetic-${label}`;
  const grantId = `synthetic-grant-${label}`;
  const account = { tenant_key: 'synthetic-tenant', open_id: `synthetic-${label}`, access_token: `${sentinel}-${label}`,
    revoked: false, scope: 'synthetic:read', access_expires_at: now + 3600 };
  const grant = { accountId, clientId: 'chatgpt', exp: now + 3600, resources: { [config.resource]: 'feishu.read' } };
  records.set(`FeishuAccount:${accountId}`, account); records.set(`Grant:${grantId}`, grant);
  const token = await new SignJWT({ grant_id: grantId, client_id: 'chatgpt', scope: 'feishu.read' })
    .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'synthetic' })
    .setIssuer(config.issuer).setAudience(config.resource).setSubject(accountId)
    .setJti(`synthetic-jti-${label}`).setIssuedAt().setExpirationTime('10m').sign(privateKey);
  return { accountId, grantId, account, grant, token };
}
const first = await identity('first');
const second = await identity('second');
const verified = await oidc.verifyMcpAuthorization(first.token);
assert.equal(maxActive, 2, 'Grant and account reads are concurrent');
assert.deepEqual(calls, ['Grant', 'FeishuAccount']);
assert.deepEqual(verified.principal, { accountId: first.accountId, scopes: ['feishu.read'] });
assert.equal(verified.account.access_token, first.account.access_token);
assert.ok(!JSON.stringify(verified.principal).includes(sentinel), 'legacy principal never contains credentials');
verified.account.access_token = 'mutated-test-copy';
calls.length = 0;
const [nextFirst, nextSecond] = await Promise.all([
  oidc.verifyMcpAuthorization(first.token), oidc.verifyMcpAuthorization(second.token),
]);
assert.equal(calls.length, 4, 'new requests always re-read current grant and account');
assert.equal(nextFirst.account.access_token, first.account.access_token);
assert.equal(nextSecond.account.access_token, second.account.access_token);
assert.deepEqual(await oidc.verifyMcpToken(first.token), verified.principal, 'original API remains compatible');
const detachedVerifier = oidc.verifyMcpToken;
assert.deepEqual(await detachedVerifier(first.token), verified.principal, 'legacy callback needs no receiver binding');
for (const invalid of [undefined, { ...first.grant, accountId: second.accountId },
  { ...first.grant, clientId: 'another-client' }, { ...first.grant, resources: {} }, Error(sentinel)]) {
  records.set(`Grant:${first.grantId}`, invalid);
  await assert.rejects(() => oidc.verifyMcpAuthorization(first.token));
}
records.set(`Grant:${first.grantId}`, first.grant);
records.set(`FeishuAccount:${first.accountId}`, { ...first.account, revoked: true });
await assert.rejects(() => oidc.verifyMcpAuthorization(first.token), 'revocation is visible on the next request');
assert.equal((await oidc.verifyMcpAuthorization(second.token)).principal.accountId, second.accountId);
records.set(`Consent:${second.grantId}`, { grantId: second.grantId, accountId: second.accountId, clientId: 'chatgpt',
  resource: config.resource, expiresAt: now + 3600, scopes: ['feishu.read'] });
active = 0; maxActive = 0; calls.length = 0;
assert.equal(await connectorRefreshConsent(store, config.resource, second.grantId, second.accountId,
  'chatgpt', new Set(['feishu.read'])), true);
assert.equal(maxActive, 2, 'Consent and Grant are independently checked in parallel');
assert.deepEqual(calls, ['Consent', 'Grant']);
records.set(`Grant:${second.grantId}`, undefined);
assert.equal(await connectorRefreshConsent(store, config.resource, second.grantId, second.accountId,
  'chatgpt', new Set(['feishu.read'])), false);
for (const sensitive of [sentinel, first.accountId, second.accountId, first.grantId, second.grantId, first.token]) {
  assert.ok(!JSON.stringify(messages).includes(sensitive), 'diagnostics omit all user/credential identifiers');
}
console.log('PASS: safe fixed-field diagnostics, concurrent live authorization reads, request/account isolation, immediate revocation visibility, legacy principal compatibility, fail-closed storage and consent.');
