import 'reflect-metadata';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import express from 'express';
import ts from 'typescript';

// Synthetic keys, in-memory records and loopback protocol requests only. No env or cloud access.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireDependency = createRequire(import.meta.url);
const cache = new Map();
let recoveryElapsed = 0;
const recoverySleeps = [];
function loadTs(file) {
  const absolute = path.resolve(file);
  if (cache.has(absolute)) return cache.get(absolute).exports;
  const loaded = { exports: {} };
  cache.set(absolute, loaded);
  const compiled = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      esModuleInterop: true, experimentalDecorators: true }, fileName: absolute,
  }).outputText;
  const isAdapter = absolute.endsWith('connector-oidc.adapter.ts');
  const localRequire = (specifier) => isAdapter && specifier === 'node:timers/promises'
    ? { setTimeout: async (ms) => { recoverySleeps.push(ms); recoveryElapsed += ms; } }
    : specifier.startsWith('.') ? loadTs(path.resolve(path.dirname(absolute), `${specifier}.ts`)) : requireDependency(specifier);
  new Function('require', 'module', 'exports', 'performance', compiled)(localRequire, loaded, loaded.exports,
    isAdapter ? { now: () => recoveryElapsed } : performance);
  return loaded.exports;
}
const authPath = path.join(root, 'server/modules/connector-auth');
const { createConnectorOidc } = loadTs(path.join(authPath, 'connector-oidc.factory.ts'));
const { ConnectorAuthUnavailableError } = loadTs(path.join(authPath, 'connector-auth.unavailable.ts'));
const { ConnectorAuthService } = loadTs(path.join(authPath, 'connector-auth.service.ts'));
const { connectorAdapter } = loadTs(path.join(authPath, 'connector-oidc.adapter.ts'));
const { ConnectorStorageUnavailableError } = loadTs(path.join(root,
  'server/modules/connector-auth-storage/connector-auth-storage.service.ts'));
const { ServiceUnavailableException, UnauthorizedException } = requireDependency('@nestjs/common');
const privateMarker = `synthetic-private-${randomBytes(12).toString('hex')}`;
const actualDateNow = Date.now;
let clockAdvanceMs = 0;
Date.now = () => actualDateNow() + clockAdvanceMs;
const now = () => Math.floor(Date.now() / 1000);
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const config = {
  publicUrl: 'https://issuer.test/app/outage-test', issuer: 'https://issuer.test/app/outage-test/oidc',
  resource: 'https://issuer.test/app/outage-test/mcp',
  signingJwks: { keys: [{ ...privateKey.export({ format: 'jwk' }), kid: 'synthetic', use: 'sig', alg: 'RS256' }] },
  cookieKeys: ['1'.repeat(64)], feishuAppId: 'synthetic-app', feishuAppSecret: privateMarker,
  feishuScopes: 'offline_access synthetic:read',
};
const diagnostics = { token() {}, authorization() {}, refreshRetry() {} };
const records = new Map();
const calls = [];
let fault;
let refreshPutFault;
const refreshPutAttempts = [];
let refreshReadAttempts = 0;
const revokedGrants = new Set();
const leases = new Map();
let consumed = 0;
let revoked = 0;
function key(model, id) { return `${model}:${id}`; }
function checkFault(operation, model, id) {
  calls.push({ operation, model, id });
  if (fault?.operation === operation && fault.model === model &&
    (!fault.newRefreshOnly || id === refreshPutAttempts[0]?.id) &&
    calls.filter((call) => call.operation === operation && call.model === model &&
      (!fault.newRefreshOnly || call.id === refreshPutAttempts[0]?.id)).length === fault.occurrence) {
    throw Error(privateMarker);
  }
}
const store = {
  async get(model, id) {
    checkFault('get', model, id);
    if (model === 'RefreshToken' && refreshPutFault && id === refreshPutAttempts[0]?.id) {
      refreshReadAttempts++;
      if (refreshPutFault === 'put429-read429' && refreshReadAttempts === 1) {
        throw new ConnectorStorageUnavailableError('http', 429);
      }
      if (refreshPutFault === 'lost-ack-read-outages' && refreshReadAttempts <= 2) {
        throw new ConnectorStorageUnavailableError(refreshReadAttempts === 1 ? 'network_timeout' : 'http', 503);
      }
      if (refreshPutFault === 'read-permanent') throw new ConnectorStorageUnavailableError('network');
      if (refreshPutFault === 'read-config') throw new ConnectorStorageUnavailableError('config');
      if (refreshPutFault === 'budget-after-read') recoveryElapsed += 20000;
    }
    const found = records.get(key(model, id));
    if ((model === 'Grant' && revokedGrants.has(id)) || revokedGrants.has(found?.grantId)) return undefined;
    return found && found.expiresAt > now() ? structuredClone(found.payload) : undefined;
  },
  async put(model, id, payload, expiresAt, uid, grantId) {
    checkFault('put', model);
    const recovering = model === 'RefreshToken' && refreshPutFault;
    if (recovering) {
      refreshPutAttempts.push(structuredClone({ id, payload, expiresAt, uid, grantId }));
      if (refreshPutFault === 'permanent') throw new ConnectorStorageUnavailableError('http', 503);
      if (refreshPutAttempts.length === 1 && refreshPutFault.startsWith('nonretry-')) {
        const name = refreshPutFault.slice('nonretry-'.length);
        if (name === 'unknown') throw Error(privateMarker);
        if (/^\d+$/u.test(name)) throw new ConnectorStorageUnavailableError('http', Number(name));
        throw new ConnectorStorageUnavailableError(name);
      }
      if (refreshPutAttempts.length === 1 && ['before-once', 'put429-read429', 'read-permanent',
        'read-config', 'budget-before-read', 'budget-after-read'].includes(refreshPutFault)) {
        if (refreshPutFault === 'budget-before-read') recoveryElapsed += 19500;
        throw new ConnectorStorageUnavailableError(refreshPutFault === 'put429-read429' ? 'http' : 'network_timeout',
          refreshPutFault === 'put429-read429' ? 429 : 0);
      }
      if (refreshPutFault === 'revoked' && refreshPutAttempts.length === 1) {
        await store.revokeGrant(grantId); throw new ConnectorStorageUnavailableError('network_timeout');
      }
    }
    if ((model === 'Grant' && revokedGrants.has(id)) || revokedGrants.has(grantId)) throw Error(privateMarker);
    const saved = structuredClone(payload);
    const previous = records.get(key(model, id));
    if (previous?.payload.consumed) saved.consumed = previous.payload.consumed;
    records.set(key(model, id), { model, id, payload: saved, expiresAt, uid, grantId });
    if (recovering && refreshPutAttempts.length === 1 &&
      ['after-once', 'lost-ack-read-outages', 'different-payload', 'consumed'].includes(refreshPutFault)) {
      if (refreshPutFault === 'different-payload') saved.scope = 'synthetic:conflicting-scope';
      if (refreshPutFault === 'consumed') saved.consumed = now();
      throw new ConnectorStorageUnavailableError('network_timeout');
    }
  },
  async consume(model, id) {
    checkFault('consume', model);
    const found = records.get(key(model, id));
    if (!found || found.expiresAt <= now() || found.payload.consumed) return false;
    if (model === 'RefreshToken') consumed += 1;
    found.payload.consumed = now(); return true;
  },
  async remove(model, id) { checkFault('remove', model); records.delete(key(model, id)); },
  async revokeGrant(id) {
    checkFault('revokeGrant', 'Grant'); revoked += 1;
    revokedGrants.add(id);
    for (const [recordKey, record] of records) {
      if (recordKey === key('Grant', id) || record.grantId === id) records.delete(recordKey);
    }
  },
  async findUid(model, uid) {
    checkFault('findUid', model);
    for (const record of records.values()) {
      if (record.model === model && record.uid === uid && record.expiresAt > now()) return store.get(model, record.id);
    }
  },
  async acquireLease(leaseKey, ttlSeconds = 90) {
    if (leases.get(leaseKey)?.expiresAt > now()) return undefined;
    const token = randomBytes(32).toString('base64url');
    leases.set(leaseKey, { token, expiresAt: now() + ttlSeconds }); return token;
  },
  async releaseLease(leaseKey, token) { if (leases.get(leaseKey)?.token === token) leases.delete(leaseKey); },
};
const oidc = createConnectorOidc(config, store, { diagnostics });
const service = new ConnectorAuthService(store);
// Inject only the synthetic runtime; never invoke environment-dependent production initialization.
service.runtime = { oidc };
const app = express();
app.all('/app/outage-test/oidc/*', (req, res) => {
  void oidc.mount(req, res).catch(() => { if (!res.headersSent) res.status(500).end(); });
});
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const tokenUrl = `http://127.0.0.1:${server.address().port}/app/outage-test/oidc/token`;

async function fixture() {
  fault = undefined; refreshPutFault = undefined; refreshPutAttempts.length = 0; revokedGrants.clear();
  clockAdvanceMs = 0; leases.clear();
  refreshReadAttempts = 0; recoveryElapsed = 0; recoverySleeps.length = 0;
  records.clear(); calls.length = 0; consumed = 0; revoked = 0;
  const accountId = 'synthetic-tenant:synthetic-user';
  await store.put('FeishuAccount', accountId, { tenant_key: 'synthetic-tenant', open_id: 'synthetic-user',
    access_token: privateMarker, scope: 'synthetic:read', revoked: false }, now() + 3600);
  const grant = new oidc.provider.Grant({ accountId, clientId: 'chatgpt' });
  grant.addResourceScope(config.resource, 'feishu.read feishu.write');
  const grantId = await grant.save();
  await store.put('Consent', grantId, { accountId, grantId, clientId: 'chatgpt', resource: config.resource,
    scopes: ['feishu.read', 'feishu.write'], expiresAt: now() + 3600 }, now() + 3600, undefined, grantId);
  const client = await oidc.provider.Client.find('chatgpt');
  const refresh = new oidc.provider.RefreshToken({ accountId, client, grantId,
    scope: 'feishu.read feishu.write', resource: config.resource, expiresWithSession: false,
    expiresIn: 3600, gty: 'authorization_code' });
  const refreshToken = await refresh.save();
  calls.length = 0;
  return { accountId, grantId, refreshToken };
}
async function refreshRequest(refreshToken) {
  const response = await fetch(tokenUrl, { method: 'POST', redirect: 'manual',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: 'chatgpt',
      refresh_token: refreshToken, resource: config.resource }) });
  const text = await response.text();
  assert.ok(!text.includes(privateMarker), 'protocol errors never expose storage error content');
  return { status: response.status, body: JSON.parse(text) };
}
let checks = 0;
try {
  // The final case reproduces the incident: the grant's second read (inside consent) times out.
  for (const [model, occurrence] of [['RefreshToken', 1], ['Grant', 1], ['FeishuAccount', 1],
    ['Consent', 1], ['Grant', 2]]) {
    const f = await fixture();
    fault = { operation: 'get', model, occurrence };
    const result = await refreshRequest(f.refreshToken);
    assert.equal(result.status, 503, `${model} read outage must not be invalid_grant`);
    assert.equal(result.body.error, 'temporarily_unavailable');
    assert.equal(result.body.access_token, undefined); assert.equal(result.body.refresh_token, undefined);
    assert.equal(consumed, 0, 'validation reads happen before consuming the refresh token');
    assert.equal(revoked, 0, 'temporary read failure must not revoke the grant');
    assert.ok(records.has(key('Grant', f.grantId)));
    fault = undefined; calls.length = 0;
    const recovered = await refreshRequest(f.refreshToken);
    assert.equal(recovered.status, 200, `${model}:${occurrence}: same unconsumed refresh token works after storage recovery`);
    assert.notEqual(recovered.body.refresh_token, f.refreshToken);
    assert.equal(consumed, 1); assert.equal(revoked, 0);
    checks += 1;
  }

  // Authoritatively invalid authorization still fails closed with 400 and no issued credentials.
  for (const invalid of ['missing-consent', 'expired-consent', 'wrong-account', 'missing-grant', 'expired-refresh']) {
    const f = await fixture();
    const consent = records.get(key('Consent', f.grantId));
    if (invalid === 'missing-consent') records.delete(key('Consent', f.grantId));
    if (invalid === 'expired-consent') consent.payload.expiresAt = now() - 1;
    if (invalid === 'wrong-account') consent.payload.accountId = 'synthetic-other:other';
    if (invalid === 'missing-grant') records.delete(key('Grant', f.grantId));
    if (invalid === 'expired-refresh') records.get(key('RefreshToken', f.refreshToken)).expiresAt = now() - 1;
    const result = await refreshRequest(f.refreshToken);
    assert.equal(result.status, 400, invalid);
    assert.equal(result.body.error, 'invalid_grant');
    assert.equal(result.body.access_token, undefined); assert.equal(consumed, 0);
    checks += 1;
  }

  // Real provider rotation: old token is consumed before the newly issued token is saved.
  // Recover classified write failures and even temporary readback failures without
  // replaying consume, changing the new token ID, extending expiry or weakening reuse detection.
  for (const scenario of ['before-once', 'after-once', 'put429-read429', 'lost-ack-read-outages']) {
    const f = await fixture(); refreshPutFault = scenario;
    const recovered = await refreshRequest(f.refreshToken);
    assert.equal(recovered.status, 200, `${scenario}: new token persistence recovers`);
    assert.ok(recovered.body.access_token); assert.ok(recovered.body.refresh_token);
    assert.notEqual(recovered.body.refresh_token, f.refreshToken);
    assert.equal(consumed, 1); assert.equal(revoked, 0);
    const expectedPuts = ['before-once', 'put429-read429'].includes(scenario) ? 2 : 1;
    assert.equal(refreshPutAttempts.length, expectedPuts);
    if (expectedPuts === 2) assert.deepEqual(refreshPutAttempts[1], refreshPutAttempts[0],
      'retry keeps exact ID, payload, absolute expiry and bindings');
    assert.equal(recoverySleeps.length, scenario === 'lost-ack-read-outages' ? 3 : scenario === 'put429-read429' ? 2 : 1);
    recoverySleeps.forEach((ms, index) => assert.ok(ms >= 500 * (2 ** index) && ms <= 500 * (2 ** index) + 250,
      'all recovery reads use exponential backoff with bounded jitter'));
    assert.equal(calls.filter((call) => call.operation === 'consume' && call.model === 'RefreshToken').length, 1);
    assert.equal((await service.verifyMcpAuthorization(recovered.body.access_token)).principal.accountId, f.accountId);
    refreshPutFault = undefined; calls.length = 0;
    clockAdvanceMs += 61000;
    const next = await refreshRequest(recovered.body.refresh_token);
    assert.equal(next.status, 200, 'next rotation succeeds with recovered token');
    assert.equal(consumed, 2); assert.equal(revoked, 0);
    const replay = await refreshRequest(f.refreshToken);
    assert.equal(replay.status, 400); assert.equal(replay.body.error, 'invalid_grant');
    assert.ok(revoked > 0, 'old token replay still revokes grant after recovery');
    await assert.rejects(() => service.verifyMcpAuthorization(next.body.access_token), UnauthorizedException);
    checks += 1;
  }
  for (const scenario of ['permanent', 'different-payload', 'consumed', 'revoked', 'read-permanent',
    'read-config', 'budget-before-read', 'budget-after-read']) {
    const f = await fixture(); refreshPutFault = scenario;
    const result = await refreshRequest(f.refreshToken);
    assert.equal(result.status, 503, `${scenario}: uncertain token persistence fails closed`);
    assert.equal(result.body.error, 'temporarily_unavailable');
    assert.equal(result.body.access_token, undefined); assert.equal(result.body.refresh_token, undefined);
    assert.equal(consumed, 1, 'predecessor consume never repeats');
    assert.equal(refreshPutAttempts.length, scenario === 'permanent' ? 5 : scenario === 'revoked' ? 2 : 1,
      'only a confirmed missing token permits another identical put; temporary failure has at most five rounds');
    assert.ok(recoverySleeps.length <= 4);
    if (scenario === 'read-permanent') assert.equal(refreshReadAttempts, 4);
    if (scenario === 'budget-before-read') { assert.equal(refreshReadAttempts, 0); assert.equal(recoverySleeps.length, 0); }
    if (scenario === 'budget-after-read') assert.equal(refreshReadAttempts, 1, 'no put starts after the 20s budget');
    if (scenario === 'revoked') {
      assert.ok(revokedGrants.has(f.grantId));
      assert.equal(await store.get('Grant', f.grantId), undefined);
      assert.equal(await store.get('RefreshToken', refreshPutAttempts[0].id), undefined,
        'revocation tombstone prevents delayed retry from resurrecting token');
    } else assert.equal(revoked, 0, 'a storage failure alone does not revoke authorization');
    refreshPutFault = undefined;
    clockAdvanceMs += 31000;
    const replay = await refreshRequest(f.refreshToken);
    assert.equal(replay.status, scenario === 'revoked' ? 400 : 503,
      'uncertain pending rotation never reenters the provider or invents credentials; explicit revocation stays invalid');
    assert.equal(replay.body.access_token, undefined); assert.equal(replay.body.refresh_token, undefined);
    assert.equal(consumed, 1);
    checks += 1;
  }

  const unreadable = await fixture(); refreshPutFault = 'before-once';
  fault = { operation: 'get', model: 'RefreshToken', occurrence: 1, newRefreshOnly: true };
  const unreadableResult = await refreshRequest(unreadable.refreshToken);
  assert.equal(unreadableResult.status, 503);
  assert.equal(refreshPutAttempts.length, 1, 'failed readback cannot trigger blind put retry');
  assert.equal(consumed, 1); assert.equal(revoked, 0); checks += 1;

  for (const reason of ['validation', 'config', 'response_invalid', '400', '401', '403', '404', 'unknown']) {
    const f = await fixture(); refreshPutFault = `nonretry-${reason}`;
    const result = await refreshRequest(f.refreshToken);
    assert.equal(result.status, 503); assert.equal(result.body.error, 'temporarily_unavailable');
    assert.equal(consumed, 1); assert.equal(revoked, 0);
    assert.equal(refreshPutAttempts.length, 1); assert.equal(refreshReadAttempts, 0);
    assert.equal(recoverySleeps.length, 0, 'unclassified or permanent failures are never retried'); checks++;
  }
  await fixture();
  await assert.rejects(() => connectorAdapter(store)('RefreshToken').upsert('synthetic-expired', {}, 0),
    ConnectorAuthUnavailableError);
  assert.equal(calls.filter((call) => call.operation === 'put').length, 0, 'expired artifact is never persisted'); checks++;

  // Other model mutations retain their single-attempt behavior.
  await fixture(); fault = { operation: 'put', model: 'Grant', occurrence: 1 };
  await assert.rejects(() => connectorAdapter(store)('Grant').upsert('synthetic-new-grant', {}, 60),
    ConnectorAuthUnavailableError);
  assert.equal(calls.filter((call) => call.operation === 'put' && call.model === 'Grant').length, 1);
  checks += 1;

  const f = await fixture();
  const successful = await refreshRequest(f.refreshToken);
  assert.equal(successful.status, 200);
  const accessToken = successful.body.access_token;
  assert.equal((await service.verifyMcpAuthorization(accessToken)).principal.accountId, f.accountId);
  for (const model of ['Grant', 'FeishuAccount']) {
    calls.length = 0; fault = { operation: 'get', model, occurrence: 1 };
    await assert.rejects(() => oidc.verifyMcpAuthorization(accessToken), ConnectorAuthUnavailableError);
    calls.length = 0;
    await assert.rejects(() => service.verifyMcpAuthorization(accessToken), (error) =>
      error instanceof ServiceUnavailableException && error.getStatus() === 503 && !error.message.includes(privateMarker));
    fault = undefined; calls.length = 0;
    assert.equal((await service.verifyMcpAuthorization(accessToken)).principal.accountId, f.accountId);
    checks += 1;
  }
  records.get(key('FeishuAccount', f.accountId)).payload.revoked = true;
  await assert.rejects(() => service.verifyMcpAuthorization(accessToken), (error) =>
    error instanceof UnauthorizedException && error.getStatus() === 401);
  records.get(key('FeishuAccount', f.accountId)).payload.revoked = false;
  clockAdvanceMs += 31000;
  const replay = await refreshRequest(f.refreshToken);
  assert.equal(replay.status, 400); assert.equal(replay.body.error, 'invalid_grant');
  assert.ok(revoked > 0, 'actual refresh replay still revokes the authorization');
  await assert.rejects(() => service.verifyMcpAuthorization(accessToken), UnauthorizedException);
  checks += 1;

  // Unknown mutation outcomes must not be relabeled as replay, retried, or trigger extra revocation.
  const adapter = connectorAdapter(store)('RefreshToken');
  const f2 = await fixture();
  fault = { operation: 'consume', model: 'RefreshToken', occurrence: 1 };
  await assert.rejects(() => adapter.consume(f2.refreshToken), ConnectorAuthUnavailableError);
  assert.equal(calls.filter((call) => call.operation === 'consume').length, 1);
  assert.equal(revoked, 0);
  checks += 1;
  console.log(`PASS: ${checks} auth outage/invalidity scenarios; pre-consumption recovery, bounded exact-payload refresh persistence recovery, lost acknowledgements, no consume retry, OAuth/MCP 503, revocation and replay enforcement.`);
} finally {
  Date.now = actualDateNow;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
