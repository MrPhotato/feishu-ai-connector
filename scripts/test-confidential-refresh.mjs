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

// Only synthetic credentials, actual provider code and loopback HTTP are used.
// Two independent module/provider instances share an expiry-aware storage double.
// No environment files, existing credentials, cloud APIs or build output are read.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dependency = createRequire(import.meta.url);
const ActualDate = Date;
const actualDateNow = Date.now;
let advanceMs = 0;
// jose reads new Date(), while provider/storage read Date.now(); advance both clocks.
globalThis.Date = class SyntheticDate extends ActualDate {
  constructor(...args) { super(...(args.length ? args : [actualDateNow() + advanceMs])); }
  static now() { return actualDateNow() + advanceMs; }
};
const now = () => Math.floor(Date.now() / 1000);
const absoluteTtl = 30 * 86400;
const publicClientId = 'chatgpt';
const confidentialClientId = 'chatgpt_confidential';
const privateValues = new Set();
const diagnosticRecords = [];
const checks = [];
const servers = [];
function isolatedLoader() {
  const cache = new Map();
  function load(relative) {
    const absolute = path.resolve(root, relative);
    if (cache.has(absolute)) return cache.get(absolute).exports;
    const module = { exports: {} };
    cache.set(absolute, module);
    const compiled = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
        esModuleInterop: true, experimentalDecorators: true }, fileName: absolute,
    }).outputText;
    new Function('require', 'module', 'exports', compiled)((specifier) => specifier.startsWith('.')
      ? load(path.resolve(path.dirname(absolute), specifier + '.ts')) : dependency(specifier), module, module.exports);
    return module.exports;
  }
  return load;
}
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const clientSecret = randomBytes(32).toString('base64url');
const upstreamSecret = randomBytes(32).toString('base64url');
privateValues.add(clientSecret); privateValues.add(upstreamSecret);
const config = {
  publicUrl: 'https://issuer.test/app/confidential-test',
  issuer: 'https://issuer.test/app/confidential-test/oidc',
  resource: 'https://issuer.test/app/confidential-test/mcp',
  cookieKeys: [randomBytes(32).toString('hex')],
  signingJwks: { keys: [{ ...privateKey.export({ format: 'jwk' }), kid: 'synthetic', use: 'sig', alg: 'RS256' }] },
  feishuAppId: 'cli_synthetic', feishuAppSecret: upstreamSecret,
  feishuScopes: 'offline_access synthetic:read', chatgptClientSecret: clientSecret,
};
const configEnv = {
  CONNECTOR_PUBLIC_URL: config.publicUrl, CONNECTOR_SIGNING_JWKS: JSON.stringify(config.signingJwks),
  CONNECTOR_COOKIE_KEYS: JSON.stringify(config.cookieKeys), FEISHU_APP_ID: config.feishuAppId,
  FEISHU_APP_SECRET: upstreamSecret, CONNECTOR_FEISHU_SCOPES: config.feishuScopes,
  CONNECTOR_CHATGPT_CLIENT_SECRET: clientSecret,
};
const storageKey = (model, id) => model + ':' + id;
const backend = { rows: new Map(), revoked: new Set(), leases: new Map(), calls: [],
  hook: undefined, consumes: 0, revocations: 0 };
function makeStore(instance, StorageError) {
  async function before(operation, model, id) {
    backend.calls.push({ instance, operation, model, id });
    await backend.hook?.({ instance, operation, model, id, StorageError });
  }
  const store = {
    async get(model, id) {
      await before('get', model, id);
      const row = backend.rows.get(storageKey(model, id));
      if (!row || row.expiresAt <= now() || backend.revoked.has(row.grantId) ||
        (model === 'Grant' && backend.revoked.has(id))) return undefined;
      return structuredClone(row.payload);
    },
    async put(model, id, payload, expiresAt, uid, explicitGrantId) {
      await before('put', model, id);
      assert.deepEqual(payload, JSON.parse(JSON.stringify(payload)));
      const grantId = model === 'Grant' ? id : explicitGrantId ?? payload.grantId;
      if (backend.revoked.has(grantId)) throw new StorageError('http', 503);
      const previous = backend.rows.get(storageKey(model, id));
      const saved = structuredClone(payload);
      if (previous?.payload.consumed) saved.consumed = previous.payload.consumed;
      backend.rows.set(storageKey(model, id), { model, id, payload: saved, expiresAt,
        uid: uid ?? payload.uid, grantId });
    },
    async consume(model, id) {
      await before('consume', model, id);
      const row = backend.rows.get(storageKey(model, id));
      // No await between the check and mutation: model the production atomic CAS.
      if (!row || row.expiresAt <= now() || row.payload.consumed || backend.revoked.has(row.grantId)) return false;
      row.payload.consumed = now();
      if (model === 'RefreshToken') backend.consumes++;
      return true;
    },
    async remove(model, id) { await before('remove', model, id); backend.rows.delete(storageKey(model, id)); },
    async revokeGrant(id) {
      await before('revokeGrant', 'Grant', id);
      backend.revocations++; backend.revoked.add(id);
      for (const [key, row] of backend.rows) {
        if (row.grantId === id || key === storageKey('Grant', id)) backend.rows.delete(key);
      }
    },
    async findUid(model, uid) {
      await before('findUid', model, uid);
      const row = [...backend.rows.values()].find((entry) => entry.model === model && entry.uid === uid);
      return row ? store.get(model, row.id) : undefined;
    },
    async acquireLease(id, ttlSeconds = 90) {
      await before('acquireLease', 'RefreshLease', id);
      if (backend.leases.get(id)?.expiresAt > now()) return undefined;
      const token = randomBytes(32).toString('base64url');
      backend.leases.set(id, { token, expiresAt: now() + ttlSeconds });
      return token;
    },
    async releaseLease(id, token) {
      await before('releaseLease', 'RefreshLease', id);
      if (backend.leases.get(id)?.token === token) backend.leases.delete(id);
    },
  };
  return store;
}
async function listen(server) {
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  return 'http://127.0.0.1:' + server.address().port;
}
async function makeInstance(name, options = {}) {
  const load = isolatedLoader();
  const { createConnectorOidc } = load('server/modules/connector-auth/connector-oidc.factory.ts');
  const { ConnectorAuthDiagnostics } = load('server/modules/connector-auth/connector-auth.diagnostics.ts');
  const { ConnectorStorageUnavailableError } = load('server/modules/connector-auth-storage/connector-auth-storage.service.ts');
  const store = makeStore(name, ConnectorStorageUnavailableError);
  const oidc = createConnectorOidc(options.config ?? config, store, {
    diagnostics: new ConnectorAuthDiagnostics((entry) => diagnosticRecords.push(entry)),
  });
  const app = express();
  app.all('/app/confidential-test/oidc/*', (req, res) => {
    void oidc.mount(req, res).catch(() => {
      if (!res.headersSent) res.status(503).json({ error: 'temporarily_unavailable' });
    });
  });
  return { name, load, createConnectorOidc, store, oidc, origin: await listen(createServer(app)) };
}
function parameters(token, overrides = {}) {
  return new URLSearchParams({ grant_type: 'refresh_token', client_id: confidentialClientId,
    client_secret: clientSecret, refresh_token: token, resource: config.resource, ...overrides });
}
function publicParameters(token) {
  const result = parameters(token, { client_id: publicClientId });
  result.delete('client_secret');
  return result;
}
async function request(target, params, suffix = '/token', headers = {}) {
  const response = await fetch((typeof target === 'string' ? target : target.origin) +
    '/app/confidential-test/oidc' + suffix, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: params, signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  for (const value of [body.access_token, body.refresh_token]) if (value) privateValues.add(value);
  return { status: response.status, body, headers: response.headers };
}
function denied(result) {
  assert.ok(result.status >= 400 && result.status < 500, 'invalid authorization must be rejected, got ' + result.status + ' ' + String(result.body.error));
  assert.equal(result.body.access_token, undefined);
  assert.equal(result.body.refresh_token, undefined);
}
function unchanged(f) {
  const row = backend.rows.get(storageKey('RefreshToken', f.token));
  assert.ok(row, 'original refresh credential remains stored');
  assert.equal(row.payload.exp, f.sourceExpiresAt, 'refresh never extends the original expiry');
  assert.equal(row.expiresAt, f.storageExpiresAt, 'storage expiry never slides');
  assert.equal(row.payload.consumed, undefined, 'authenticated reusable refresh credential is not consumed');
}
async function successful(target, f, params = parameters(f.token)) {
  const result = await request(target, params);
  assert.equal(result.status, 200);
  assert.equal(result.body.refresh_token, f.token);
  assert.equal(result.body.token_type, 'Bearer');
  assert.ok(typeof result.body.access_token === 'string' && result.body.access_token);
  assert.ok(Number.isInteger(result.body.expires_in) && result.body.expires_in > 0);
  assert.match(result.headers.get('cache-control'), /no-store/u);
  const principal = await target.oidc.verifyMcpToken(result.body.access_token);
  assert.equal(principal.accountId, f.accountId);
  assert.equal(principal.clientId, confidentialClientId);
  unchanged(f);
  return result;
}
async function run(name, fn) {
  try { await fn(); checks.push(name); }
  catch (error) { throw new Error('Confidential refresh scenario failed: ' + name, { cause: error }); }
}
let a; let b; let proxy;
let dropNextSuccess = false;
let dropped;
async function fixture(clientId = confidentialClientId) {
  advanceMs = 0;
  backend.rows.clear(); backend.revoked.clear(); backend.leases.clear(); backend.calls.length = 0;
  backend.hook = undefined; backend.consumes = 0; backend.revocations = 0;
  dropNextSuccess = false; dropped = undefined;
  const accountId = 'synthetic-tenant:synthetic-user';
  await a.store.put('FeishuAccount', accountId, { tenant_key: 'synthetic-tenant', open_id: 'synthetic-user',
    access_token: 'synthetic-upstream-token', scope: 'synthetic:read', revoked: false }, now() + 32 * 86400);
  const grant = new a.oidc.provider.Grant({ accountId, clientId });
  grant.addResourceScope(config.resource, 'feishu.read feishu.write');
  const grantId = await grant.save();
  await a.store.put('Consent', grantId, { accountId, grantId, clientId, resource: config.resource,
    scopes: ['feishu.read', 'feishu.write'], expiresAt: now() + absoluteTtl }, now() + absoluteTtl, undefined, grantId);
  const client = await a.oidc.provider.Client.find(clientId);
  assert.ok(client, 'requested client must be registered explicitly');
  const source = new a.oidc.provider.RefreshToken({ accountId, client, grantId,
    scope: 'feishu.read feishu.write', resource: config.resource,
    expiresWithSession: false, expiresIn: absoluteTtl, gty: 'authorization_code' });
  const token = await source.save();
  [token, accountId, grantId].forEach((value) => privateValues.add(value));
  const row = backend.rows.get(storageKey('RefreshToken', token));
  backend.calls.length = 0;
  return { token, accountId, grantId, sourceExpiresAt: row.payload.exp, storageExpiresAt: row.expiresAt };
}
try {
  a = await makeInstance('a'); b = await makeInstance('b');
  assert.notEqual(a.oidc.provider, b.oidc.provider);
  proxy = await listen(createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const response = await fetch(a.origin + req.url, { method: req.method, redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: Buffer.concat(chunks),
        signal: AbortSignal.timeout(15000) });
      const bytes = Buffer.from(await response.arrayBuffer());
      if (dropNextSuccess && response.status === 200) {
        dropNextSuccess = false;
        dropped = JSON.parse(bytes.toString('utf8'));
        [dropped.access_token, dropped.refresh_token].forEach((value) => privateValues.add(value));
        res.destroy(); return;
      }
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(bytes);
    } catch { res.destroy(); }
  }));
  const { loadConnectorAuthConfig } = a.load('server/modules/connector-auth/connector-auth.config.ts');
  await run('valid separate client secret is loaded from the explicit environment', async () => {
    assert.equal(loadConnectorAuthConfig(configEnv).chatgptClientSecret, clientSecret);
    const client = await a.oidc.provider.Client.find(confidentialClientId);
    assert.equal(client.clientAuthMethod, 'client_secret_post');
    const legacy = await a.oidc.provider.Client.find(publicClientId);
    assert.equal(legacy.clientAuthMethod, 'none');
  });
  for (const [name, value] of [
    ['empty', ''], ['short', 'short'], ['whitespace', ' '.repeat(43)],
    ['non-base64url', '+'.repeat(43)], ['upstream-secret-reuse', upstreamSecret],
  ]) {
    await run('invalid ' + name + ' secret fails closed in config and provider', async () => {
      assert.throws(() => loadConnectorAuthConfig({ ...configEnv, CONNECTOR_CHATGPT_CLIENT_SECRET: value }));
      assert.throws(() => a.createConnectorOidc({ ...config, chatgptClientSecret: value }, a.store));
    });
  }
  await run('undefined secret preserves only the legacy public registration', async () => {
    const env = { ...configEnv }; delete env.CONNECTOR_CHATGPT_CLIENT_SECRET;
    const loaded = loadConnectorAuthConfig(env);
    assert.equal(loaded.chatgptClientSecret, undefined);
    const legacy = a.createConnectorOidc(loaded, a.store);
    assert.ok(await legacy.provider.Client.find(publicClientId));
    assert.equal(await legacy.provider.Client.find(confidentialClientId), undefined);
  });
  await run('correct secret refreshes through the authenticated provider without public receipts', async () => {
    const f = await fixture();
    await successful(a, f);
    assert.equal(backend.consumes, 0); assert.equal(backend.revocations, 0);
    assert.equal(backend.calls.some((entry) => ['RefreshRetry', 'RefreshResponse'].includes(entry.model)), false);
  });
  await run('two independent workers may refresh the same credential concurrently', async () => {
    const f = await fixture();
    let waiting = 0; let release;
    const gate = new Promise((resolve) => { release = resolve; });
    backend.hook = async (event) => {
      if (event.operation === 'get' && event.model === 'RefreshToken' && event.id === f.token && waiting < 2) {
        waiting++;
        if (waiting === 2) release();
        await gate;
      }
    };
    await Promise.all([successful(a, f), successful(b, f)]);
    assert.equal(waiting, 2);
    assert.equal(backend.consumes, 0); assert.equal(backend.revocations, 0);
  });
  await run('a lost completed HTTP response does not spend the refresh credential', async () => {
    const f = await fixture(); dropNextSuccess = true;
    await assert.rejects(() => request(proxy, parameters(f.token)));
    assert.ok(dropped?.access_token, 'the upstream really returned success before its response was dropped');
    assert.equal(dropped.refresh_token, f.token);
    advanceMs += 5000;
    await successful(b, f);
    assert.equal(backend.consumes, 0); assert.equal(backend.revocations, 0);
  });
  await run('a worker retaining its credential for 58 minutes recovers without extending its expiry', async () => {
    const f = await fixture(); const initial = await successful(a, f);
    advanceMs += 58 * 60000;
    await assert.rejects(() => b.oidc.verifyMcpToken(initial.body.access_token));
    await successful(b, f);
    assert.equal(backend.consumes, 0); assert.equal(backend.revocations, 0);
  });
  for (const [name, modify] of [
    ['missing secret', (params) => params.delete('client_secret')],
    ['wrong secret', (params) => params.set('client_secret', randomBytes(32).toString('base64url'))],
    ['duplicated secret', (params) => params.append('client_secret', clientSecret)],
  ]) {
    await run(name + ' is denied before grant mutation and a correct retry still works', async () => {
      const f = await fixture(); await successful(a, f); const params = parameters(f.token); modify(params);
      denied(await request(b, params)); unchanged(f);
      assert.equal(backend.revocations, 0);
      assert.ok(await a.store.get('Grant', f.grantId));
      await successful(a, f);
    });
  }
  await run('public refresh tokens cannot be upgraded using confidential credentials', async () => {
    const f = await fixture(publicClientId);
    denied(await request(a, parameters(f.token)));
    assert.equal(backend.revocations, 0);
    const valid = await request(b, publicParameters(f.token));
    assert.equal(valid.status, 200); assert.notEqual(valid.body.refresh_token, f.token);
    assert.equal(backend.consumes, 1);
  });
  await run('confidential refresh tokens cannot be redeemed as the public client', async () => {
    const f = await fixture();
    denied(await request(b, publicParameters(f.token)));
    assert.equal(backend.revocations, 0);
    await successful(a, f);
  });
  for (const [name, overrides] of [
    ['unknown resource', { resource: 'https://other.test/mcp' }],
    ['unapproved scope', { scope: 'feishu.read synthetic:unapproved' }],
  ]) {
    await run(name + ' is rejected without poisoning the valid grant', async () => {
      const f = await fixture();
      denied(await request(a, parameters(f.token, overrides)));
      assert.equal(backend.revocations, 0);
      await successful(b, f);
    });
  }
  await run('a narrower requested scope cannot regain write privileges in that access token', async () => {
    const f = await fixture(); const result = await successful(a, f, parameters(f.token, { scope: 'feishu.read' }));
    assert.equal(result.body.scope, 'feishu.read');
    assert.deepEqual((await a.oidc.verifyMcpToken(result.body.access_token)).scopes, ['feishu.read']);
  });
  const mutations = {
    'missing consent': (f) => backend.rows.delete(storageKey('Consent', f.grantId)),
    'expired consent': (f) => { backend.rows.get(storageKey('Consent', f.grantId)).payload.expiresAt = now() - 1; },
    'wrong consent client': (f) => { backend.rows.get(storageKey('Consent', f.grantId)).payload.clientId = publicClientId; },
    'wrong consent resource': (f) => { backend.rows.get(storageKey('Consent', f.grantId)).payload.resource = 'https://other.test/mcp'; },
    'wrong consent account': (f) => { backend.rows.get(storageKey('Consent', f.grantId)).payload.accountId = 'other:account'; },
    'reduced consent': (f) => { backend.rows.get(storageKey('Consent', f.grantId)).payload.scopes = ['feishu.read']; },
    'missing account': (f) => backend.rows.delete(storageKey('FeishuAccount', f.accountId)),
    'revoked account': (f) => { backend.rows.get(storageKey('FeishuAccount', f.accountId)).payload.revoked = true; },
    'mismatched account identity': (f) => { backend.rows.get(storageKey('FeishuAccount', f.accountId)).payload.open_id = 'different'; },
    'missing grant': (f) => backend.rows.delete(storageKey('Grant', f.grantId)),
    'expired grant': (f) => { backend.rows.get(storageKey('Grant', f.grantId)).payload.exp = now() - 1; },
    'wrong grant client': (f) => { backend.rows.get(storageKey('Grant', f.grantId)).payload.clientId = publicClientId; },
    'wrong grant account': (f) => { backend.rows.get(storageKey('Grant', f.grantId)).payload.accountId = 'other:account'; },
    'removed grant resource': (f) => { delete backend.rows.get(storageKey('Grant', f.grantId)).payload.resources[config.resource]; },
    'expired refresh credential': (f) => { backend.rows.get(storageKey('RefreshToken', f.token)).payload.exp = now() - 1; },
  };
  for (const [name, modify] of Object.entries(mutations)) {
    await run(name + ' is checked again on every confidential refresh', async () => {
      const f = await fixture(); await successful(a, f);
      modify(f);
      denied(await request(b, parameters(f.token)));
    });
  }
  await run('absolute 30 day expiry is not renewed by repeated activity', async () => {
    const f = await fixture();
    await successful(a, f);
    advanceMs += 29 * 86400000;
    await successful(b, f);
    advanceMs += 86400000 + 1000;
    denied(await request(a, parameters(f.token)));
  });
  await run('revocation endpoint invalidates reusable refresh and prior access tokens', async () => {
    const f = await fixture(); const before = await successful(a, f);
    const revoke = await request(a, new URLSearchParams({ client_id: confidentialClientId,
      client_secret: clientSecret, token: f.token, token_type_hint: 'refresh_token' }), '/token/revocation');
    assert.equal(revoke.status, 200);
    denied(await request(b, parameters(f.token)));
    await assert.rejects(() => b.oidc.verifyMcpToken(before.body.access_token));
  });
  await run('storage outage preserves the credential for a subsequent authenticated retry', async () => {
    const f = await fixture();
    backend.hook = async ({ operation, model, StorageError }) => {
      if (operation === 'get' && model === 'Consent') throw new StorageError('http', 503);
    };
    const failed = await request(b, parameters(f.token));
    assert.equal(failed.status, 503); assert.equal(failed.body.access_token, undefined);
    assert.equal(failed.body.refresh_token, undefined);
    assert.equal(backend.revocations, 0); unchanged(f);
    backend.hook = undefined;
    await successful(a, f);
  });
  await run('legacy public mode still rotates and revokes out of window replay', async () => {
    const f = await fixture(publicClientId);
    const initial = await request(a, publicParameters(f.token));
    assert.equal(initial.status, 200); assert.notEqual(initial.body.refresh_token, f.token);
    advanceMs += 61000;
    const next = await request(b, publicParameters(initial.body.refresh_token));
    assert.equal(next.status, 200);
    denied(await request(a, publicParameters(f.token)));
    assert.ok(backend.revocations > 0);
    await assert.rejects(() => b.oidc.verifyMcpToken(next.body.access_token));
  });
  await run('equivalent Basic transport still requires the real client secret on every request', async () => {
    const f = await fixture(); await successful(a, f);
    const params = parameters(f.token); params.delete('client_secret');
    // oidc-provider deliberately accepts Basic and POST as equivalent secret transports.
    const authorization = 'Basic ' + Buffer.from(confidentialClientId + ':' + clientSecret).toString('base64');
    privateValues.add(authorization);
    const valid = await request(b, params, '/token', { Authorization: authorization });
    assert.equal(valid.status, 200); assert.equal(valid.body.refresh_token, f.token);
    const wrongAuthorization = 'Basic ' + Buffer.from(confidentialClientId + ':incorrect').toString('base64');
    denied(await request(b, params, '/token', { Authorization: wrongAuthorization }));
    assert.equal(backend.revocations, 0); unchanged(f);
    await successful(a, f);
  });
  await run('wrong-secret revocation cannot invalidate an authorized reusable credential', async () => {
    const f = await fixture(); const before = await successful(a, f);
    const badRevoke = await request(b, new URLSearchParams({ client_id: confidentialClientId,
      client_secret: randomBytes(32).toString('base64url'), token: f.token,
      token_type_hint: 'refresh_token' }), '/token/revocation');
    denied(badRevoke);
    assert.equal(backend.revocations, 0);
    assert.equal((await a.oidc.verifyMcpToken(before.body.access_token)).accountId, f.accountId);
    await successful(a, f);
  });
  await run('unknown refresh credentials return no tokens and do not revoke other grants', async () => {
    const f = await fixture(); await successful(a, f);
    denied(await request(b, parameters(randomBytes(32).toString('base64url'))));
    assert.equal(backend.revocations, 0); unchanged(f);
    await successful(a, f);
  });
  await run('shortening a live grant limits reuse before the refresh credential absolute expiry', async () => {
    const f = await fixture();
    const grant = backend.rows.get(storageKey('Grant', f.grantId));
    grant.payload.exp = now() + 120; grant.expiresAt = grant.payload.exp;
    await successful(a, f);
    advanceMs += 121000;
    denied(await request(b, parameters(f.token)));
    unchanged(f);
  });
  await run('diagnostics expose no secrets, tokens or synthetic account identifiers', async () => {
    const encoded = diagnosticRecords.join('\n');
    for (const value of privateValues) assert.equal(encoded.includes(value), false);
  });
  console.log(JSON.stringify({ ok: true, checks: checks.length, transport: 'loopback',
    actualProvider: true, independentInstances: 2, cloudCalls: 0 }));
} finally {
  globalThis.Date = ActualDate;
  await Promise.all(servers.map((server) => new Promise((resolve) => {
    server.close(resolve); server.closeAllConnections();
  })));
}
