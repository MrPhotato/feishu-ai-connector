import 'reflect-metadata';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import express from 'express';
import ts from 'typescript';

// Real provider and loopback HTTP only. Independent module caches represent separate instances;
// only the atomic, expiry-aware storage double is shared. No env files or external APIs are read.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dependency = createRequire(import.meta.url);
const actualDateNow = Date.now;
let advanceMs = 0;
Date.now = () => actualDateNow() + advanceMs;
const now = () => Math.floor(Date.now() / 1000);
const privateValues = new Set();
const diagnostics = [];
function isolatedLoader() {
  const cache = new Map();
  function load(relative) {
    const absolute = path.resolve(root, relative);
    if (cache.has(absolute)) return cache.get(absolute).exports;
    const module = { exports: {} }; cache.set(absolute, module);
    const compiled = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
        esModuleInterop: true, experimentalDecorators: true }, fileName: absolute,
    }).outputText;
    new Function('require', 'module', 'exports', compiled)((specifier) => specifier.startsWith('.')
      ? load(path.resolve(path.dirname(absolute), `${specifier}.ts`)) : dependency(specifier), module, module.exports);
    return module.exports;
  }
  return load;
}
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const config = {
  publicUrl: 'https://issuer.test/app/retry-test', issuer: 'https://issuer.test/app/retry-test/oidc',
  resource: 'https://issuer.test/app/retry-test/mcp', cookieKeys: ['1'.repeat(64)],
  signingJwks: { keys: [{ ...privateKey.export({ format: 'jwk' }), kid: 'synthetic', use: 'sig', alg: 'RS256' }] },
  feishuAppId: 'synthetic-app', feishuAppSecret: 'synthetic-secret', feishuScopes: 'offline_access synthetic:read',
};
const key = (model, id) => `${model}:${id}`;
const backend = { rows: new Map(), leases: new Map(), revoked: new Set(), calls: [], hook: undefined, errors: [] };
const counters = { refreshConsumes: 0, journalConsumes: 0, revocations: 0, issuedIds: new Set() };
function barrier() {
  let release; let entered;
  const reached = new Promise((resolve) => { entered = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  return { reached, release, async hold() { entered(); await blocked; } };
}
function makeStore(instance, StorageError) {
  const hook = async (stage, operation, model, id, extra = {}) => {
    const event = { stage, operation, model, id, instance, ...extra };
    if (stage === 'before') backend.calls.push(event);
    const fault = await backend.hook?.(event);
    if (fault) throw new StorageError(fault.reason, fault.status ?? 0);
  };
  const store = {
    async get(model, id) {
      await hook('before', 'get', model, id);
      const row = backend.rows.get(key(model, id));
      if (!row || row.expiresAt <= now() || backend.revoked.has(row.grantId) ||
        (model === 'Grant' && backend.revoked.has(id))) return undefined;
      await hook('after', 'get', model, id);
      return { ...structuredClone(row.payload), ...(row.consumed ? { consumed: row.consumed } : {}) };
    },
    async put(model, id, payload, expiresAt, uid, explicitGrant) {
      await hook('before', 'put', model, id, { payload, expiresAt, uid, grantId: explicitGrant });
      assert.deepEqual(payload, JSON.parse(JSON.stringify(payload)));
      const grantId = model === 'Grant' ? id : explicitGrant ?? payload.grantId;
      const actualUid = uid ?? payload.uid;
      if (backend.revoked.has(grantId)) throw new StorageError('http', 503);
      const previous = backend.rows.get(key(model, id));
      if (previous && (previous.uid !== actualUid || previous.grantId !== grantId)) throw new StorageError('validation');
      const clean = structuredClone(payload); delete clean.consumed;
      backend.rows.set(key(model, id), { model, id, payload: clean, expiresAt, uid: actualUid,
        grantId, consumed: previous?.consumed });
      if (model === 'RefreshToken' && !previous) counters.issuedIds.add(id);
      await hook('after', 'put', model, id, { payload, expiresAt, uid, grantId });
    },
    async consume(model, id) {
      await hook('before', 'consume', model, id);
      const row = backend.rows.get(key(model, id));
      // The check and mutation are synchronous, modeling the repository's atomic CAS.
      if (!row || row.expiresAt <= now() || row.consumed || backend.revoked.has(row.grantId)) return false;
      row.consumed = now();
      if (model === 'RefreshToken') counters.refreshConsumes++;
      if (model === 'RefreshRetry') counters.journalConsumes++;
      await hook('after', 'consume', model, id);
      return true;
    },
    async remove(model, id) { await hook('before', 'remove', model, id); backend.rows.delete(key(model, id)); },
    async revokeGrant(id) {
      await hook('before', 'revokeGrant', 'Grant', id);
      counters.revocations++; backend.revoked.add(id);
      for (const [entryKey, row] of backend.rows) if (row.grantId === id || entryKey === key('Grant', id)) backend.rows.delete(entryKey);
    },
    async findUid(model, uid) {
      await hook('before', 'findUid', model, uid);
      const row = [...backend.rows.values()].find((entry) => entry.model === model && entry.uid === uid);
      return row ? store.get(model, row.id) : undefined;
    },
    async acquireLease(leaseKey, ttlSeconds = 90) {
      await hook('before', 'acquireLease', 'RefreshLease', leaseKey);
      if (backend.leases.get(leaseKey)?.expiresAt > now()) return undefined;
      const token = randomBytes(32).toString('base64url');
      backend.leases.set(leaseKey, { token, expiresAt: now() + ttlSeconds }); return token;
    },
    async releaseLease(leaseKey, token) {
      await hook('before', 'releaseLease', 'RefreshLease', leaseKey);
      if (backend.leases.get(leaseKey)?.token === token) backend.leases.delete(leaseKey);
    },
  };
  return store;
}
const servers = [];
async function listen(server) {
  servers.push(server); server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function instance(name) {
  const load = isolatedLoader();
  const { createConnectorOidc } = load('server/modules/connector-auth/connector-oidc.factory.ts');
  const { ConnectorAuthDiagnostics } = load('server/modules/connector-auth/connector-auth.diagnostics.ts');
  const { ConnectorStorageUnavailableError } = load('server/modules/connector-auth-storage/connector-auth-storage.service.ts');
  const store = makeStore(name, ConnectorStorageUnavailableError);
  const oidc = createConnectorOidc(config, store, { diagnostics: new ConnectorAuthDiagnostics((message) => diagnostics.push(message)) });
  oidc.provider.on('error', (error) => backend.errors.push({ name: error.name,
    frames: String(error.stack).split('\n').slice(1, 5) }));
  const app = express();
  app.all('/app/retry-test/oidc/*', (req, res) => {
    void oidc.mount(req, res).catch(() => { if (!res.headersSent) res.status(503).json({ error: 'temporarily_unavailable' }); });
  });
  return { name, oidc, store, origin: await listen(createServer(app)) };
}
const a = await instance('a');
const b = await instance('b');
assert.notEqual(a.oidc.provider, b.oidc.provider);
let dropNextSuccess = false;
let dropped;
const proxy = await listen(createServer(async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const response = await fetch(`${a.origin}${req.url}`, { method: req.method, redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: Buffer.concat(chunks) });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (dropNextSuccess && response.status === 200) {
      dropNextSuccess = false; dropped = JSON.parse(bytes.toString('utf8'));
      // This is a real transport failure after the backend fully persisted and returned success.
      res.destroy(); return;
    }
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(bytes);
  } catch { res.destroy(); }
}));
function parameters(token, overrides = {}) {
  return new URLSearchParams({ grant_type: 'refresh_token', client_id: 'chatgpt',
    refresh_token: token, resource: config.resource, ...overrides });
}
async function request(target, params, headers = {}) {
  const response = await fetch(`${typeof target === 'string' ? target : target.origin}/app/retry-test/oidc/token`, {
    method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: params,
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`Non-JSON synthetic protocol reply: ${JSON.stringify(backend.errors)}`); }
  for (const value of [body.access_token, body.refresh_token]) if (value) privateValues.add(value);
  return { status: response.status, body, headers: response.headers };
}
async function fixture() {
  advanceMs = 0; backend.rows.clear(); backend.leases.clear(); backend.revoked.clear(); backend.calls.length = 0; backend.hook = undefined;
  counters.refreshConsumes = 0; counters.journalConsumes = 0; counters.revocations = 0; counters.issuedIds.clear();
  backend.errors.length = 0; dropNextSuccess = false; dropped = undefined;
  const accountId = 'synthetic-tenant:synthetic-user';
  await a.store.put('FeishuAccount', accountId, { tenant_key: 'synthetic-tenant', open_id: 'synthetic-user',
    access_token: 'synthetic-upstream-token', scope: 'synthetic:read', revoked: false }, now() + 3600);
  const grant = new a.oidc.provider.Grant({ accountId, clientId: 'chatgpt' });
  grant.addResourceScope(config.resource, 'feishu.read feishu.write'); const grantId = await grant.save();
  await a.store.put('Consent', grantId, { accountId, grantId, clientId: 'chatgpt', resource: config.resource,
    scopes: ['feishu.read', 'feishu.write'], expiresAt: now() + 3600 }, now() + 3600, undefined, grantId);
  const client = await a.oidc.provider.Client.find('chatgpt');
  const source = new a.oidc.provider.RefreshToken({ accountId, client, grantId, scope: 'feishu.read feishu.write',
    resource: config.resource, expiresWithSession: false, expiresIn: 3600, gty: 'authorization_code' });
  const token = await source.save(); privateValues.add(token);
  privateValues.add(accountId); privateValues.add(grantId);
  const sourceExpiresAt = backend.rows.get(key('RefreshToken', token)).payload.exp;
  backend.calls.length = 0; counters.issuedIds.clear();
  return { token, accountId, grantId, sourceExpiresAt };
}
function noTokens(result) { assert.ok(result.status >= 400); assert.equal(result.body.access_token, undefined); assert.equal(result.body.refresh_token, undefined); }
function sameTokens(left, right) {
  assert.equal(left.access_token, right.access_token); assert.equal(left.refresh_token, right.refresh_token);
  assert.equal(left.scope, right.scope); assert.equal(left.token_type, right.token_type);
}
let checks = 0;
try {
  const lost = await fixture(); dropNextSuccess = true;
  await assert.rejects(() => request(proxy, parameters(lost.token)));
  assert.ok(dropped?.access_token && dropped?.refresh_token, 'backend really completed before the socket was dropped');
  privateValues.add(dropped.access_token); privateValues.add(dropped.refresh_token);
  advanceMs += 5000;
  const recovered = await request(b, parameters(lost.token));
  assert.equal(recovered.status, 200); sameTokens(recovered.body, dropped);
  assert.ok(recovered.body.expires_in <= dropped.expires_in - 5, 'replaying cannot extend the access token lifetime');
  assert.match(recovered.headers.get('cache-control'), /no-store/u);
  assert.equal(counters.refreshConsumes, 1); assert.equal(counters.journalConsumes, 1);
  assert.equal(counters.issuedIds.size, 1); assert.equal(counters.revocations, 0);
  assert.equal((await b.oidc.verifyMcpToken(recovered.body.access_token)).accountId, lost.accountId); checks++;
  const cooldown = await request(b, parameters(recovered.body.refresh_token));
  assert.equal(cooldown.status, 200); sameTokens(cooldown.body, recovered.body);
  assert.equal(counters.refreshConsumes, 1); assert.equal(counters.issuedIds.size, 1); checks++;
  const journal = [...backend.rows.values()].find((row) => row.model === 'RefreshRetry');
  const receipt = [...backend.rows.values()].find((row) => row.model === 'RefreshResponse');
  assert.equal(journal.expiresAt, lost.sourceExpiresAt);
  assert.ok(receipt.expiresAt <= receipt.payload.createdAt + 60);
  assert.equal(backend.rows.get(key('RefreshToken', recovered.body.refresh_token)).payload.exp, lost.sourceExpiresAt); checks++;
  advanceMs += 61000;
  const next = await request(a, parameters(recovered.body.refresh_token));
  assert.equal(next.status, 200); assert.notEqual(next.body.refresh_token, recovered.body.refresh_token);
  assert.equal(counters.refreshConsumes, 2);
  const replay = await request(b, parameters(lost.token));
  assert.equal(replay.status, 400); assert.ok(counters.revocations > 0);
  await assert.rejects(() => b.oidc.verifyMcpToken(next.body.access_token)); checks++;

  for (const expireLease of [false, true]) {
    const f = await fixture(); const gate = barrier(); let held = false;
    backend.hook = async (event) => {
      if (!held && event.instance === 'a' && event.stage === 'after' && event.operation === 'consume' && event.model === 'RefreshRetry') {
        held = true; await gate.hold();
      }
    };
    const first = request(a, parameters(f.token)); await gate.reached;
    if (expireLease) advanceMs += 301000;
    const contending = await request(b, parameters(f.token));
    assert.equal(contending.status, 503); noTokens(contending);
    assert.equal(counters.journalConsumes, 1); assert.equal(counters.refreshConsumes, 0);
    assert.equal(counters.revocations, 0);
    gate.release(); const completed = await first; assert.equal(completed.status, 200);
    const retried = await request(b, parameters(f.token));
    assert.equal(retried.status, 200); sameTokens(retried.body, completed.body);
    assert.equal(counters.refreshConsumes, 1); assert.equal(counters.issuedIds.size, 1); checks++;
  }

  for (const change of [
    (params) => params.set('client_id', 'other-client'),
    (params) => params.set('scope', 'feishu.read'),
    (params) => params.set('scope', 'synthetic:unapproved'),
    (params) => params.set('resource', 'https://other.test/mcp'),
    (params) => params.append('resource', config.resource),
    (params) => params.append('refresh_token', params.get('refresh_token')),
    (params) => params.set('unknown_parameter', 'unexpected'),
    (params) => params.set('client_secret', 'unexpected'),
  ]) {
    const f = await fixture(); const initial = await request(a, parameters(f.token)); assert.equal(initial.status, 200);
    const altered = parameters(f.token); change(altered);
    noTokens(await request(b, altered));
    assert.equal(counters.refreshConsumes, 1); assert.equal(counters.issuedIds.size, 1); checks++;
  }
  const extraAuth = await fixture(); assert.equal((await request(a, parameters(extraAuth.token))).status, 200);
  noTokens(await request(b, parameters(extraAuth.token), { Authorization: 'Bearer synthetic-unrelated' }));
  assert.equal(counters.refreshConsumes, 1); checks++;

  // Empty form segments still count toward querystring's maxKeys. A 64-key parser
  // silently drops the tail and could mistake these altered requests for exact retries.
  for (const tail of ['unknown_parameter=unexpected', 'resource=' + encodeURIComponent(config.resource)]) {
    const f = await fixture(); const initial = await request(a, parameters(f.token)); assert.equal(initial.status, 200);
    const padded = parameters(f.token).toString() + '&'.repeat(70) + tail;
    noTokens(await request(b, padded));
    assert.equal(counters.refreshConsumes, 1); assert.equal(counters.issuedIds.size, 1); checks++;
  }
  const corrected = await fixture();
  const invalidScope = await request(a, parameters(corrected.token, { scope: 'synthetic:unapproved' }));
  assert.equal(invalidScope.status, 400); noTokens(invalidScope);
  assert.equal(counters.journalConsumes, 0); assert.equal(counters.refreshConsumes, 0);
  const validScope = await request(b, parameters(corrected.token));
  assert.equal(validScope.status, 200, 'correcting an invalid scope must not leave a pending rotation');
  assert.equal(counters.journalConsumes, 1); assert.equal(counters.refreshConsumes, 1); checks++;

  const shortened = await fixture();
  const shortenedExpiry = now() + 1800;
  const shortGrant = backend.rows.get(key('Grant', shortened.grantId));
  shortGrant.payload.exp = shortenedExpiry; shortGrant.expiresAt = shortenedExpiry;
  const shortReply = await request(a, parameters(shortened.token));
  assert.equal(shortReply.status, 200, 'a valid grant may shorten the successor lifetime');
  const shortSuccessor = backend.rows.get(key('RefreshToken', shortReply.body.refresh_token));
  assert.equal(shortSuccessor.payload.exp, shortenedExpiry);
  assert.ok(shortSuccessor.payload.exp < shortened.sourceExpiresAt);
  const shortRetry = await request(b, parameters(shortened.token));
  assert.equal(shortRetry.status, 200); sameTokens(shortRetry.body, shortReply.body); checks++;

  const slowRelease = await fixture(); assert.equal((await request(a, parameters(slowRelease.token))).status, 200);
  backend.hook = async (event) => {
    if (event.instance === 'b' && event.stage === 'before' && event.operation === 'releaseLease') advanceMs += 31000;
  };
  const lateReply = await request(b, parameters(slowRelease.token));
  assert.equal(lateReply.status, 503, 'a lease release delay must not send cached tokens beyond the retry window');
  noTokens(lateReply); assert.equal(counters.refreshConsumes, 1); assert.equal(counters.revocations, 0); checks++;

  for (const mutation of ['revoked-grant', 'revoked-account', 'missing-consent', 'expired-consent', 'expired-grant',
    'wrong-consent-client', 'wrong-consent-resource', 'reduced-consent', 'successor-consumed', 'successor-expired']) {
    const f = await fixture(); const initial = await request(a, parameters(f.token)); assert.equal(initial.status, 200);
    if (mutation === 'revoked-grant') await a.store.revokeGrant(f.grantId);
    if (mutation === 'revoked-account') backend.rows.get(key('FeishuAccount', f.accountId)).payload.revoked = true;
    if (mutation === 'missing-consent') backend.rows.delete(key('Consent', f.grantId));
    if (mutation === 'expired-consent') backend.rows.get(key('Consent', f.grantId)).payload.expiresAt = now() - 1;
    if (mutation === 'expired-grant') backend.rows.get(key('Grant', f.grantId)).expiresAt = now() - 1;
    if (mutation === 'wrong-consent-client') backend.rows.get(key('Consent', f.grantId)).payload.clientId = 'other';
    if (mutation === 'wrong-consent-resource') backend.rows.get(key('Consent', f.grantId)).payload.resource = 'https://other.test/mcp';
    if (mutation === 'reduced-consent') backend.rows.get(key('Consent', f.grantId)).payload.scopes = ['feishu.read'];
    if (mutation === 'successor-consumed') backend.rows.get(key('RefreshToken', initial.body.refresh_token)).consumed = now();
    if (mutation === 'successor-expired') backend.rows.get(key('RefreshToken', initial.body.refresh_token)).expiresAt = now() - 1;
    noTokens(await request(b, parameters(f.token)));
    assert.equal(counters.refreshConsumes, 1); assert.equal(counters.issuedIds.size, 1); checks++;
  }

  for (const model of ['RefreshResponse', 'RefreshRetry']) {
    const f = await fixture(); let injected = false;
    backend.hook = async (event) => {
      if (!injected && event.stage === 'after' && event.operation === 'put' && event.model === model &&
        (model !== 'RefreshRetry' || event.payload.status === 'completed')) {
        injected = true; return { reason: 'network_timeout' };
      }
    };
    const initial = await request(a, parameters(f.token));
    assert.equal(injected, true); assert.equal(initial.status, 200, 'lost persistence acknowledgement recovers exact artifact');
    const retried = await request(b, parameters(f.token)); assert.equal(retried.status, 200); sameTokens(retried.body, initial.body);
    assert.equal(counters.refreshConsumes, 1); assert.equal(counters.journalConsumes, 1); assert.equal(counters.issuedIds.size, 1); checks++;
  }
  const unreadable = await fixture(); const stored = await request(a, parameters(unreadable.token)); assert.equal(stored.status, 200);
  backend.hook = async (event) => event.stage === 'before' && event.operation === 'get' && event.model === 'RefreshResponse'
    ? { reason: 'network_timeout' } : undefined;
  const unavailable = await request(b, parameters(unreadable.token)); assert.equal(unavailable.status, 503); noTokens(unavailable);
  assert.equal(counters.refreshConsumes, 1); assert.equal(counters.revocations, 0);
  backend.hook = undefined;
  const retryRead = await request(b, parameters(unreadable.token)); assert.equal(retryRead.status, 200); sameTokens(retryRead.body, stored.body); checks++;

  const uncertain = await fixture(); let consumeAckLost = false;
  backend.hook = async (event) => {
    if (!consumeAckLost && event.stage === 'after' && event.operation === 'consume' && event.model === 'RefreshRetry') {
      consumeAckLost = true; return { reason: 'network_timeout' };
    }
  };
  noTokens(await request(a, parameters(uncertain.token)));
  backend.hook = undefined; advanceMs += 301000;
  const pending = await request(b, parameters(uncertain.token)); assert.equal(pending.status, 503); noTokens(pending);
  assert.equal(counters.journalConsumes, 1); assert.equal(counters.refreshConsumes, 0);
  assert.equal(counters.issuedIds.size, 0); assert.equal(counters.revocations, 0); checks++;

  // Entering the provider is recoverable only when that request certainly did
  // not even attempt the source RT consume. Unknown consume outcomes stay closed.
  const preConsumeFailure = await fixture(); let grantReads = 0;
  backend.hook = async (event) => {
    if (event.stage === 'before' && event.operation === 'get' && event.model === 'Grant' && ++grantReads === 2) {
      return { reason: 'network_timeout' };
    }
  };
  const beforeConsume = await request(a, parameters(preConsumeFailure.token));
  assert.equal(beforeConsume.status, 503); noTokens(beforeConsume);
  assert.equal(counters.journalConsumes, 1); assert.equal(counters.refreshConsumes, 0);
  backend.hook = undefined;
  const afterRecovery = await request(b, parameters(preConsumeFailure.token));
  assert.equal(afterRecovery.status, 200, 'a completed pre-consume failure must permit a corrected retry');
  assert.equal(counters.journalConsumes, 2); assert.equal(counters.refreshConsumes, 1);
  assert.equal(counters.issuedIds.size, 1); assert.equal(counters.revocations, 0); checks++;

  for (const failureStage of ['before', 'after']) {
    const f = await fixture(); let injected = false;
    backend.hook = async (event) => {
      if (!injected && event.stage === failureStage && event.operation === 'consume' && event.model === 'RefreshToken') {
        injected = true; return { reason: 'network_timeout' };
      }
    };
    const failed = await request(a, parameters(f.token));
    assert.equal(failed.status, 503); noTokens(failed); assert.equal(injected, true);
    backend.hook = undefined; advanceMs += 301000;
    const retried = await request(b, parameters(f.token));
    assert.equal(retried.status, 503); noTokens(retried);
    assert.equal(backend.calls.filter((event) => event.operation === 'consume' && event.model === 'RefreshToken').length, 1,
      'even a failed consume attempt must never be retried after the lease expires');
    assert.equal(counters.journalConsumes, 1); assert.equal(counters.refreshConsumes, failureStage === 'before' ? 0 : 1);
    assert.equal(counters.issuedIds.size, 0); assert.equal(counters.revocations, 0); checks++;
  }

  const expired = await fixture(); assert.equal((await request(a, parameters(expired.token))).status, 200);
  advanceMs += 3601000;
  noTokens(await request(b, parameters(expired.token))); assert.equal(counters.refreshConsumes, 1); checks++;
  for (const value of privateValues) assert.ok(!diagnostics.join('\n').includes(value), 'diagnostics never expose token values or raw identity/grant identifiers'); checks++;
  console.log(JSON.stringify({ ok: true, checks, externalNetwork: false,
    coverage: 'lost HTTP success, independent instances, exact retries and cooldown, CAS beyond lease expiry, live bindings/revocation/expiry, persistence acknowledgement loss, no consume replay, genuine replay revocation' }));
} finally {
  backend.hook = undefined; Date.now = actualDateNow;
  for (const server of servers) server.closeAllConnections();
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
}
