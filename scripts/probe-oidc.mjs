import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import express from 'express';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { discoverAuthorizationServerMetadata } from '@modelcontextprotocol/sdk/client/auth.js';
const require = createRequire(import.meta.url);
const { createConnectorOidc } = require('../dist/server/modules/connector-auth/connector-oidc.factory.js');
const { ConnectorAuthDiagnostics } = require('../dist/server/modules/connector-auth/connector-auth.diagnostics.js');
const diagnosticRecords = [];
const diagnostics = new ConnectorAuthDiagnostics((entry) => diagnosticRecords.push(JSON.parse(entry)));
const callbackDiagnosticRecords = [];
const callbackDiagnostics = new ConnectorAuthDiagnostics((entry) => callbackDiagnosticRecords.push(JSON.parse(entry)));
callbackDiagnostics.callback('synthetic-private-stage', false, 1.4, 'synthetic-private-ok',
  'synthetic-private-code', Number.NaN, Number.POSITIVE_INFINITY);
assert.deepEqual(callbackDiagnosticRecords, [{ event: 'connector_feishu_callback', stage: 'other', ok: false,
  durationMs: 1, accessTokenLength: 0, refreshTokenLength: 0 }], 'callback diagnostics accept no arbitrary provider content');
new ConnectorAuthDiagnostics(() => { throw Error('synthetic-log-failure'); })
  .callback('complete', true, 1, true, 0, 4097, 4097);
const { ConnectorFeishuFlow } = require('../dist/server/modules/connector-auth/connector-feishu.flow.js');
const { loadConnectorAuthConfig } = require('../dist/server/modules/connector-auth/connector-auth.config.js');
const { connectorAdapter } = require('../dist/server/modules/connector-auth/connector-oidc.adapter.js');
const { ConnectorAuthService } = require('../dist/server/modules/connector-auth/connector-auth.service.js');
const { ConnectorAuthController } = require('../dist/server/modules/connector-auth/connector-auth.controller.js');
const { connectorFeishuHttp } = require('../dist/server/modules/connector-auth/connector-feishu.http.js');
const { connectorPrivacyMiddleware } =
  require('../dist/server/modules/connector-privacy/connector-privacy.middleware.js');
const { storageCommandSchema } = require('../dist/server/modules/connector-auth-storage/connector-auth-storage.contract.js');

// In-process protocol tests only: synthetic identities/keys, fake upstream, isolated memory store.
// Production always injects ConnectorAuthStorageService and has no test login/client endpoint.
const records = new Map();
const now = () => Math.floor(Date.now() / 1000);
const storageKey = (model, key) => `${model}:${key}`;
const revokedGrants = new Set();
const leases = new Map();
const store = {
  async get(model, key) {
    const value = records.get(storageKey(model, key));
    if (!value || value.expiresAt <= now()) return undefined;
    if ((model === 'Grant' && revokedGrants.has(key)) || revokedGrants.has(value.payload.grantId)) return undefined;
    return structuredClone(value.payload);
  },
  async put(model, key, payload, expiresAt, uid, grantId) {
    // Keep the double at least as strict as the encrypted production JSON store.
    assert.deepEqual(payload, JSON.parse(JSON.stringify(payload)));
    storageCommandSchema.parse(JSON.parse(JSON.stringify({ operation: 'put', model, key, payload, expiresAt, uid, grantId })));
    if ((model === 'Grant' && revokedGrants.has(key)) || revokedGrants.has(grantId)) throw Error('revoked');
    const previous = records.get(storageKey(model, key));
    const stored = structuredClone(payload);
    if (previous?.payload.consumed) stored.consumed = previous.payload.consumed;
    records.set(storageKey(model, key), { model, key, payload: stored, expiresAt, uid, grantId });
  },
  async consume(model, key) {
    // Deliberately no await between read and update: models the backing store's atomic CAS.
    const value = records.get(storageKey(model, key));
    if (!value || value.expiresAt <= now() || value.payload.consumed) return false;
    value.payload.consumed = now(); return true;
  },
  async remove(model, key) { records.delete(storageKey(model, key)); },
  async revokeGrant(id) {
    revokedGrants.add(id);
    for (const [key, value] of records) {
      if (value.grantId === id || (value.model === 'Grant' && value.key === id)) records.delete(key);
    }
  },
  async findUid(model, uid) {
    for (const value of records.values()) {
      if (value.model === model && value.uid === uid) return this.get(model, value.key);
    }
  },
  async acquireLease(key) {
    if (leases.has(key)) return undefined;
    const token = randomBytes(32).toString('hex'); leases.set(key, token); return token;
  },
  async releaseLease(key, token) { if (leases.get(key) === token) leases.delete(key); },
};
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = { ...privateKey.export({ format: 'jwk' }), alg: 'RS256', use: 'sig', kid: 'synthetic-only' };
const publicUrl = 'https://issuer.test/app/connector-test';
const config = {
  publicUrl, issuer: `${publicUrl}/oidc`, resource: `${publicUrl}/mcp`, signingJwks: { keys: [key] },
  cookieKeys: [randomBytes(32).toString('hex')], feishuAppId: 'synthetic-app',
  feishuAppSecret: 'synthetic-secret', feishuScopes: 'offline_access synthetic:read synthetic:write',
};
const client = {
  client_id: 'protocol-test', client_name: 'Protocol test',
  redirect_uris: ['https://client.test/callback'], response_types: ['code'],
  grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none',
};
assert.throws(() => loadConnectorAuthConfig({}));

// Exercise production configuration validation without reading an env file or contacting storage.
const names = ['CONNECTOR_PUBLIC_URL', 'CONNECTOR_SIGNING_JWKS', 'CONNECTOR_COOKIE_KEYS', 'FEISHU_APP_ID',
  'FEISHU_APP_SECRET', 'CONNECTOR_FEISHU_SCOPES', 'CONNECTOR_STORAGE_ENCRYPTION_KEY', 'CONNECTOR_STORAGE_API_KEY',
  'CONNECTOR_DEPLOYMENT_CONFIG', 'CONNECTOR_DEFAULT_TIMEZONE'];
const previousEnvironment = Object.fromEntries(names.map((name) => [name, process.env[name]]));
try {
  for (const name of names) delete process.env[name];
  const service = new ConnectorAuthService({});
  assert.equal(service.getStatus().configured, false);
  assert.equal(service.getStatus().mcpUrl, '', 'missing deployment never falls back to another instance');
  assert.throws(() => service.getPublicUrl());
  Object.assign(process.env, {
    CONNECTOR_PUBLIC_URL: publicUrl, FEISHU_APP_ID: 'cli_readiness',
    CONNECTOR_SIGNING_JWKS: JSON.stringify(config.signingJwks), CONNECTOR_COOKIE_KEYS: JSON.stringify(config.cookieKeys),
    FEISHU_APP_SECRET: 'synthetic-readiness-secret', CONNECTOR_FEISHU_SCOPES: 'offline_access synthetic:read',
    CONNECTOR_STORAGE_ENCRYPTION_KEY: '12'.repeat(32), CONNECTOR_STORAGE_API_KEY: 'synthetic-readiness-api-key',
  });
  const ready = service.getStatus();
  assert.equal(ready.configured, true, 'valid runtime configuration, with no storage methods, needs no I/O');
  assert.deepEqual(Object.keys(ready).sort(), ['configured', 'mcpUrl', 'oauthClientId', 'message'].sort());
  assert.ok(!JSON.stringify(ready).includes('synthetic'));
  process.env.CONNECTOR_STORAGE_ENCRYPTION_KEY = 'invalid';
  assert.equal(service.getStatus().configured, false);
  process.env.CONNECTOR_SIGNING_JWKS = 'invalid';
  assert.equal(service.getStatus().configured, false);
} finally {
  for (const name of names) {
    if (previousEnvironment[name] === undefined) delete process.env[name];
    else process.env[name] = previousEnvironment[name];
  }
}

const originalFetch = globalThis.fetch;
try {
  let called = false;
  globalThis.fetch = async (_url, init) => {
    called = true;
    assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal);
    return new Response('{"access_token":"synthetic-only"}', { status: 200 });
  };
  const reply = await connectorFeishuHttp('https://accounts.feishu.cn/oauth/v3/token', {
    method: 'POST', headers: {}, body: '{}',
  });
  assert.equal(reply.ok, true); assert.equal(called, true);
  called = false;
  await assert.rejects(() => connectorFeishuHttp('https://attacker.test/token', { method: 'POST', headers: {} }));
  assert.equal(called, false, 'upstream allowlist rejects before network');
  globalThis.fetch = async () => new Response('synthetic-secret '.repeat(20000));
  await assert.rejects(() => connectorFeishuHttp('https://accounts.feishu.cn/oauth/v3/token', {
    method: 'POST', headers: {},
  }), (error) => error.message === 'Feishu authorization service unavailable' && !error.cause);
} finally { globalThis.fetch = originalFetch; }

const oidc = createConnectorOidc(config, store, { testClient: client, diagnostics });
let expectedChallenge;
let upstreamCalls = 0;
let syntheticOpenId = 'ou_protocol_test_a';
let syntheticGrantedScopes;
let syntheticRefresh = true;
let syntheticTokenOverrides = {};
const flow = new ConnectorFeishuFlow(config, store, oidc.provider, async (url, init) => {
  upstreamCalls += 1;
  if (url === 'https://accounts.feishu.cn/oauth/v3/token') {
    const params = JSON.parse(init.body);
    assert.equal(params.code, 'synthetic-code');
    assert.equal(params.redirect_uri, `${publicUrl}/auth/feishu/callback`);
    assert.equal(params.client_id, config.feishuAppId);
    assert.equal(createHash('sha256').update(params.code_verifier).digest('base64url'), expectedChallenge);
    return { ok: true, body: { code: 0, access_token: 'synthetic-upstream-access', expires_in: 3600,
      ...(syntheticRefresh ? { refresh_token: 'synthetic-upstream-refresh', refresh_token_expires_in: 7200 } : {}),
      scope: syntheticGrantedScopes ?? config.feishuScopes, ...syntheticTokenOverrides } };
  }
  assert.equal(url, 'https://open.feishu.cn/open-apis/authen/v1/user_info');
  assert.equal(new Headers(init.headers).get('Authorization'),
    `Bearer ${syntheticTokenOverrides.access_token ?? 'synthetic-upstream-access'}`, 'credential is safe as one header value');
  return { ok: true, body: { code: 0, data: { tenant_key: 'tenant_protocol', open_id: syntheticOpenId, name: 'Synthetic' } } };
}, diagnostics);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.urlencoded({ extended: false }));
app.use((req, _res, next) => { req.headers['x-forwarded-proto'] = 'https'; next(); });
app.use(connectorPrivacyMiddleware);
const visibleLogs = [];
const privateValues = new Set(['synthetic-code', 'synthetic-upstream-access', 'synthetic-upstream-refresh']);
app.use((req, res, next) => {
  const started = { url: req.originalUrl, body: req.body, query: req.query };
  for (const method of ['json', 'send']) {
    const original = res[method].bind(res);
    res[method] = (body) => { res.__finalResponseBody = body; return original(body); };
  }
  res.on('finish', () => visibleLogs.push(JSON.stringify({ started, url: req.url, body: req.body,
    captured: res.__finalResponseBody })));
  next();
});
const router = express.Router();
// Use the production controller so security headers and generic error mapping are exercised.
const controller = new ConnectorAuthController({
  mount: (req, res) => oidc.mount(req, res),
  interaction: (req, res) => flow.showInteraction(req, res),
  callback: (req, res) => flow.feishuCallback(req, res),
  finish: (req, res) => flow.finishLogin(req, res),
  consent: (req, res) => flow.confirmConsent(req, res),
});
router.all('/oidc/*', (req, res) => controller.oidc(req, res));
router.get('/interaction/:uid', (req, res) => controller.interaction(req, res));
router.get('/auth/feishu/callback', (req, res) => controller.callback(req, res));
router.get('/interaction/:uid/finish', (req, res) => controller.finish(req, res));
router.post('/interaction/:uid/confirm', (req, res) => controller.consent(req, res));
app.use(new URL(publicUrl).pathname, router);
// The managed gateway strips the app prefix before requests reach Nest.
app.use(router);
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const local = `http://127.0.0.1:${server.address().port}`;

class Browser {
  cookies = new Map();
  constructor(stripPrefix = false) { this.stripPrefix = stripPrefix; }
  async request(url, init = {}) {
    const logical = new URL(url);
    assert.equal(logical.origin, new URL(publicUrl).origin);
    const headers = new Headers(init.headers);
    const cookies = [...this.cookies.values()].filter((cookie) => logical.pathname.startsWith(cookie.path));
    if (cookies.length) headers.set('cookie', cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '));
    const path = this.stripPrefix ? logical.pathname.replace(new URL(publicUrl).pathname, '') : logical.pathname;
    const response = await fetch(`${local}${path}${logical.search}`, { ...init, headers, redirect: 'manual' });
    for (const cookie of response.headers.getSetCookie()) {
      const [nameValue, ...attributes] = cookie.split(';').map((part) => part.trim());
      const split = nameValue.indexOf('=');
      const name = nameValue.slice(0, split);
      const path = attributes.find((part) => /^path=/iu.test(part))?.slice(5) || '/';
      const id = `${name}:${path}`;
      if (attributes.some((part) => /^max-age=0$/iu.test(part)) || nameValue.slice(split + 1) === '') this.cookies.delete(id);
      else this.cookies.set(id, { name, value: nameValue.slice(split + 1), path });
    }
    return response;
  }
}
const redirect = (response) => { assert.ok([302, 303].includes(response.status)); return response.headers.get('location'); };
function authUrl(verifier, additional = {}, oauthOnly = false) {
  const params = new URLSearchParams({
    client_id: client.client_id, redirect_uri: client.redirect_uris[0], response_type: 'code',
    scope: 'openid offline_access feishu.read feishu.write', resource: config.resource,
    state: 'synthetic-rp-state', nonce: 'synthetic-rp-nonce', prompt: 'consent',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    ...additional,
  });
  if (oauthOnly) {
    params.set('scope', 'feishu.read feishu.write');
    params.delete('prompt'); params.delete('nonce');
  }
  return `${config.issuer}/auth?${params}`;
}

async function authorize(decision = 'allow', exerciseFailures = false, stripPrefix = false, oauthOnly = false) {
  const browser = new Browser(stripPrefix);
  const verifier = randomBytes(32).toString('base64url');
  privateValues.add(verifier);
  let response = await browser.request(authUrl(verifier, {}, oauthOnly));
  response = await browser.request(redirect(response));
  const feishuUrl = new URL(redirect(response));
  assert.equal(feishuUrl.origin, 'https://accounts.feishu.cn');
  expectedChallenge = feishuUrl.searchParams.get('code_challenge');
  privateValues.add(feishuUrl.searchParams.get('state'));
  const callback = `${publicUrl}/auth/feishu/callback?${new URLSearchParams({
    state: feishuUrl.searchParams.get('state'), code: 'synthetic-code',
  })}`;
  if (exerciseFailures) {
    const calls = upstreamCalls;
    assert.equal((await new Browser().request(callback)).status, 400);
    assert.equal(upstreamCalls, calls, 'invalid cookie must never call upstream');
  }
  response = await browser.request(callback);
  const finishUrl = redirect(response);
  const ticket = new URL(finishUrl).searchParams.get('ticket');
  privateValues.add(ticket);
  if (exerciseFailures) {
    assert.equal((await browser.request(callback)).status, 400, 'state replay');
    assert.equal((await new Browser().request(finishUrl)).status, 400, 'handoff needs interaction cookie');
  }
  if (exerciseFailures) {
    const leaseKey = `feishu-refresh:tenant_protocol:${syntheticOpenId}`;
    const held = await store.acquireLease(leaseKey, 90);
    const before = await store.get('FeishuAccount', `tenant_protocol:${syntheticOpenId}`);
    const blocked = await browser.request(finishUrl);
    assert.equal(blocked.status, 503, 'new login waits for in-flight old credential refresh');
    assert.match(await blocked.text(), /继续授权/u);
    assert.equal((await store.get('FeishuLoginResult', ticket)).consumed, undefined, 'busy lease preserves new tokens');
    assert.deepEqual(await store.get('FeishuAccount', `tenant_protocol:${syntheticOpenId}`), before);
    if (before) await store.put('FeishuAccount', `tenant_protocol:${syntheticOpenId}`,
      { ...before, access_token: 'old-refresh-completed' }, now() + 7200);
    await store.releaseLease(leaseKey, held);
  }
  response = await browser.request(finishUrl);
  assert.equal((await store.get('FeishuAccount', `tenant_protocol:${syntheticOpenId}`)).access_token,
    syntheticTokenOverrides.access_token ?? 'synthetic-upstream-access', 'new authorization wins after the old refresh releases its lease');
  if (exerciseFailures) assert.equal((await browser.request(finishUrl)).status, 400, 'handoff consumed once after lease');
  response = await browser.request(redirect(response));
  const consentUrl = redirect(response);
  response = await browser.request(consentUrl);
  assert.equal(response.status, 200);
  // This is a response/header contract test, not a browser simulation. Per WHATWG Fetch's
  // append-a-request-origin-header algorithm, no-referrer nulls a native form POST's Origin;
  // origin retains the source origin without exposing the interaction path in Referer.
  assert.equal(response.headers.get('referrer-policy'), 'origin', 'production consent HTML must support native form POST');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy'), /form-action 'self'/u);
  const page = await response.text();
  assert.match(page, /读取/u); assert.match(page, /创建或修改/u);
  assert.match(page, /持续连接最多 30 天/u); assert.match(page, /撤销授权/u);
  assert.ok(!page.includes('synthetic-upstream-access'));
  const csrf = /name="csrf" value="([^"]+)"/u.exec(page)[1];
  privateValues.add(csrf);
  const consentInit = { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded',
    origin: new URL(publicUrl).origin }, body: new URLSearchParams({ csrf, decision }) };
  if (exerciseFailures) {
    const nullOrigin = await browser.request(`${consentUrl}/confirm`, { ...consentInit,
      headers: { ...consentInit.headers, origin: 'null' } });
    assert.equal(nullOrigin.status, 400, 'do not weaken strict Origin checks to accommodate the old header policy');
    assert.equal(nullOrigin.headers.get('referrer-policy'), 'no-referrer', 'other controller responses retain privacy policy');
    assert.deepEqual(await nullOrigin.json(), { error: 'invalid_request',
      error_description: '授权未完成，请从 ChatGPT 重新发起连接。' });
    assert.equal((await browser.request(`${consentUrl}/confirm`, { ...consentInit,
      body: new URLSearchParams({ csrf: 'wrong', decision }) })).status, 400);
    assert.equal((await browser.request(`${consentUrl}/confirm`, { ...consentInit,
      headers: { ...consentInit.headers, origin: 'https://attacker.test' } })).status, 400);
  }
  response = await browser.request(`${consentUrl}/confirm`, consentInit);
  response = await browser.request(redirect(response));
  const clientCallback = new URL(redirect(response));
  assert.equal(clientCallback.origin, 'https://client.test');
  assert.equal(clientCallback.searchParams.get('iss'), config.issuer);
  assert.equal(clientCallback.searchParams.get('state'), 'synthetic-rp-state');
  if (clientCallback.searchParams.has('code')) privateValues.add(clientCallback.searchParams.get('code'));
  return { browser, verifier, callback: clientCallback };
}

async function tokenRequest(parameters) {
  return new Browser().request(`${config.issuer}/token`, { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(parameters) });
}
function codeParameters(authorization) {
  return { grant_type: 'authorization_code', client_id: client.client_id,
    code: authorization.callback.searchParams.get('code'), code_verifier: authorization.verifier,
    redirect_uri: client.redirect_uris[0], resource: config.resource };
}

async function reconnectEntry(browser) {
  const verifier = randomBytes(32).toString('base64url'); privateValues.add(verifier);
  const response = await browser.request(authUrl(verifier, {}, true));
  return { verifier, location: redirect(response) };
}
async function incrementalCallback(browser, entry, callbackFields = {}) {
  const feishuUrl = new URL(redirect(await browser.request(entry.location)));
  assert.equal(feishuUrl.origin, 'https://accounts.feishu.cn');
  assert.equal(feishuUrl.searchParams.get('scope'), config.feishuScopes, 'new upstream request uses current configured scopes');
  expectedChallenge = feishuUrl.searchParams.get('code_challenge');
  privateValues.add(feishuUrl.searchParams.get('state'));
  return browser.request(`${publicUrl}/auth/feishu/callback?${new URLSearchParams({
    state: feishuUrl.searchParams.get('state'), code: 'synthetic-code', ...callbackFields,
  })}`);
}
async function incrementalResume(browser, response) {
  const finish = redirect(response);
  privateValues.add(new URL(finish).searchParams.get('ticket'));
  response = await browser.request(finish);
  response = await browser.request(redirect(response));
  const callback = new URL(redirect(response));
  assert.equal(callback.origin, 'https://client.test');
  if (callback.searchParams.has('code')) privateValues.add(callback.searchParams.get('code'));
  return callback;
}

try {
  // Real controller, PKCE/cookie/state and encrypted-store schema boundaries, synthetic credentials only.
  // This verifies the >4KiB hypothesis without claiming it caused the production callback failure.
  for (const length of [4097, 16384]) {
    syntheticTokenOverrides = { access_token: `synthetic-access-${'a'.repeat(length - 17)}`,
      refresh_token: `synthetic-refresh-${'r'.repeat(length - 18)}` };
    for (const token of Object.values(syntheticTokenOverrides)) privateValues.add(token);
    const accepted = await authorize();
    assert.ok(accepted.callback.searchParams.has('code'), 'bounded long credentials complete the real controller flow');
    const account = await store.get('FeishuAccount', `tenant_protocol:${syntheticOpenId}`);
    assert.equal(account.access_token.length, length); assert.equal(account.refresh_token.length, length);
    assert.deepEqual(diagnosticRecords.filter((entry) => entry.event === 'connector_feishu_callback').at(-1), {
      event: 'connector_feishu_callback', stage: 'complete', ok: true,
      durationMs: diagnosticRecords.filter((entry) => entry.event === 'connector_feishu_callback').at(-1).durationMs,
      accessTokenLength: length, refreshTokenLength: length, providerOk: true, providerCode: 0,
    });
  }
  syntheticTokenOverrides = {};
  const callbackFailure = async (expectedStage, callbackFields = {}) => {
    const before = await store.get('FeishuAccount', `tenant_protocol:${syntheticOpenId}`);
    const fresh = new Browser();
    const reply = await incrementalCallback(fresh, await reconnectEntry(fresh), callbackFields);
    assert.equal(reply.status, 400, 'invalid provider credential/ordinary field is rejected');
    assert.deepEqual(await reply.json(), { error: 'invalid_request',
      error_description: '授权未完成，请从 ChatGPT 重新发起连接。' });
    assert.deepEqual(await store.get('FeishuAccount', `tenant_protocol:${syntheticOpenId}`), before,
      'failed callback never overwrites stored account');
    const diagnostic = diagnosticRecords.filter((entry) => entry.event === 'connector_feishu_callback').at(-1);
    assert.equal(diagnostic.stage, expectedStage); assert.equal(diagnostic.ok, false);
  };
  for (const key of ['access_token', 'refresh_token']) {
    for (const value of ['x'.repeat(16385), '', 123, null, 'has space', 'has\tcontrol', 'has\r\nheader', 'has\u007fcontrol', 'nonascii-\u00a0']) {
      syntheticTokenOverrides = { [key]: value };
      if (typeof value === 'string' && value) privateValues.add(value);
      await callbackFailure('token_fields');
    }
  }
  syntheticTokenOverrides = {};
  syntheticTokenOverrides = { code: 20001 };
  await callbackFailure('token_exchange');
  assert.equal(diagnosticRecords.filter((entry) => entry.event === 'connector_feishu_callback').at(-1).providerCode, 20001);
  syntheticTokenOverrides = {};
  const callsBeforeFieldFailures = upstreamCalls;
  await callbackFailure('state', { state: 's'.repeat(4097) });
  await callbackFailure('code', { code: 'c'.repeat(4097) });
  assert.equal(upstreamCalls, callsBeforeFieldFailures, 'ordinary input limits reject before credential exchange');
  const ordinaryOpenId = syntheticOpenId;
  syntheticOpenId = 'o'.repeat(4097);
  await callbackFailure('account_binding');
  syntheticOpenId = ordinaryOpenId;

  const browser = new Browser();
  const discoveryResponse = await browser.request(`${config.issuer}/.well-known/openid-configuration`);
  assert.equal(discoveryResponse.headers.get('referrer-policy'), 'no-referrer');
  const discovery = await discoveryResponse.json();
  assert.equal(discovery.issuer, config.issuer);
  assert.equal(discovery.authorization_response_iss_parameter_supported, true);
  assert.ok(discovery.code_challenge_methods_supported.includes('S256'));
  assert.equal(discovery.token_endpoint, `${config.issuer}/token`);
  assert.equal(discovery.authorization_endpoint, `${config.issuer}/auth`);
  assert.equal(discovery.revocation_endpoint, `${config.issuer}/token/revocation`);
  const strippedDiscovery = await (await new Browser(true).request(`${config.issuer}/.well-known/openid-configuration`)).json();
  assert.equal(strippedDiscovery.authorization_endpoint, discovery.authorization_endpoint);
  assert.equal(strippedDiscovery.token_endpoint, discovery.token_endpoint);
  const discovered = await discoverAuthorizationServerMetadata(config.issuer, {
    fetchFn: async (url, init) => new Browser().request(String(url), init),
  });
  assert.equal(discovered.issuer, config.issuer, 'real OIDC path fallback via official MCP SDK');
  const jwks = await (await browser.request(discovery.jwks_uri)).json();
  assert.ok(jwks.keys.length); assert.ok(jwks.keys.every((entry) => !entry.d && !entry.p && !entry.q));
  const publicKeyResolver = createLocalJWKSet(jwks);

  const badRedirect = await browser.request(authUrl(randomBytes(32).toString('base64url'), { redirect_uri: 'https://attacker.test/' }));
  assert.equal(badRedirect.status, 400);
  const missingPkceUrl = new URL(authUrl(randomBytes(32).toString('base64url')));
  missingPkceUrl.searchParams.delete('code_challenge'); missingPkceUrl.searchParams.delete('code_challenge_method');
  const missingPkce = await browser.request(missingPkceUrl.href);
  assert.equal(new URL(redirect(missingPkce)).searchParams.get('error'), 'invalid_request');
  const wrongResource = await browser.request(authUrl(randomBytes(32).toString('base64url'), { resource: 'https://attacker.test/mcp' }));
  assert.equal(new URL(redirect(wrongResource)).searchParams.get('error'), 'invalid_target');

  const denied = await authorize('deny');
  assert.equal(denied.callback.searchParams.get('error'), 'access_denied');
  assert.equal(denied.callback.searchParams.get('code'), null);
  const allowed = await authorize('allow', true);
  assert.ok(allowed.callback.searchParams.get('code'));
  const invalidVerifier = await tokenRequest({ ...codeParameters(allowed), code_verifier: randomBytes(32).toString('base64url') });
  assert.equal(invalidVerifier.status, 400);
  const exchanged = await tokenRequest(codeParameters(allowed));
  assert.equal(exchanged.status, 200);
  const tokens = await exchanged.json();
  for (const value of [tokens.id_token, tokens.access_token, tokens.refresh_token]) privateValues.add(value);
  assert.ok(tokens.refresh_token, 'offline_access with explicit consent issues refresh token');
  const id = await jwtVerify(tokens.id_token, publicKeyResolver, { issuer: config.issuer, audience: client.client_id, algorithms: ['RS256'] });
  assert.equal(id.payload.nonce, 'synthetic-rp-nonce');
  assert.deepEqual(await oidc.verifyMcpToken(tokens.access_token), {
    accountId: 'tenant_protocol:ou_protocol_test_a', scopes: ['feishu.read', 'feishu.write'],
  });
  const tampered = tokens.access_token.split('.'); tampered[1] = Buffer.from('{"sub":"attacker"}').toString('base64url');
  await assert.rejects(() => oidc.verifyMcpToken(tampered.join('.')));
  await assert.rejects(() => oidc.verifyMcpToken(tokens.id_token));

  const refreshed = await tokenRequest({ grant_type: 'refresh_token', client_id: client.client_id,
    refresh_token: tokens.refresh_token, resource: config.resource });
  assert.equal(refreshed.status, 200);
  const renewed = await refreshed.json();
  privateValues.add(renewed.access_token); privateValues.add(renewed.refresh_token);
  assert.notEqual(renewed.refresh_token, tokens.refresh_token);
  assert.equal((await oidc.verifyMcpToken(renewed.access_token)).accountId, 'tenant_protocol:ou_protocol_test_a');
  const replayRefresh = await tokenRequest({ grant_type: 'refresh_token', client_id: client.client_id,
    refresh_token: tokens.refresh_token, resource: config.resource });
  assert.equal(replayRefresh.status, 400);
  await assert.rejects(() => oidc.verifyMcpToken(renewed.access_token), 'refresh replay revokes the grant');
  assert.equal((await tokenRequest(codeParameters(allowed))).status, 400);

  syntheticOpenId = 'ou_protocol_test_b';
  const secondUser = await authorize('allow', false, true);
  const secondTokenReply = await tokenRequest(codeParameters(secondUser));
  assert.equal(secondTokenReply.status, 200);
  const secondTokens = await secondTokenReply.json();
  privateValues.add(secondTokens.access_token); privateValues.add(secondTokens.refresh_token);
  assert.equal((await oidc.verifyMcpToken(secondTokens.access_token)).accountId, 'tenant_protocol:ou_protocol_test_b');
  const revoked = await new Browser(true).request(discovery.revocation_endpoint, { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
      client_id: client.client_id, token: secondTokens.refresh_token, token_type_hint: 'refresh_token',
    }) });
  assert.equal(revoked.status, 200);
  await assert.rejects(() => oidc.verifyMcpToken(secondTokens.access_token), 'HTTP revocation invalidates existing JWT');
  const revokedRefresh = await tokenRequest({ grant_type: 'refresh_token', client_id: client.client_id,
    refresh_token: secondTokens.refresh_token, resource: config.resource });
  assert.equal(revokedRefresh.status, 400, 'HTTP revocation invalidates the refresh token');

  // Standard OAuth 2 request: no OIDC base scopes, nonce, or prompt=consent.
  // The server must still require explicit persistence consent and issue a bounded refresh token.
  const oauthDenied = await authorize('deny', false, false, true);
  assert.equal(oauthDenied.callback.searchParams.get('error'), 'access_denied');
  const oauth = await authorize('allow', false, false, true);
  const oauthReply = await tokenRequest(codeParameters(oauth));
  assert.equal(oauthReply.status, 200);
  const oauthTokens = await oauthReply.json();
  assert.equal(oauthTokens.scope, 'feishu.read feishu.write', 'response scope remains effective resource scope');
  assert.equal(oauthTokens.id_token, undefined, 'pure OAuth does not fabricate OIDC identity or scopes');
  assert.ok(oauthTokens.refresh_token, 'explicit 30-day consent permits OAuth refresh without offline_access');
  privateValues.add(oauthTokens.access_token); privateValues.add(oauthTokens.refresh_token);
  const oauthJwt = await jwtVerify(oauthTokens.access_token, publicKeyResolver, {
    issuer: config.issuer, audience: config.resource, algorithms: ['RS256'], typ: 'at+jwt',
  });
  assert.equal(oauthJwt.payload.scope, 'feishu.read feishu.write');
  const oauthGrantId = oauthJwt.payload.grant_id;
  const consent = await store.get('Consent', oauthGrantId);
  assert.equal(consent.accountId, oauthJwt.payload.sub);
  assert.equal(consent.clientId, client.client_id); assert.equal(consent.resource, config.resource);
  assert.ok(consent.expiresAt <= consent.consentedAt + 30 * 86400);
  const firstRefresh = await oidc.provider.RefreshToken.find(oauthTokens.refresh_token);
  assert.equal(Boolean(firstRefresh.expiresWithSession), false, 'explicit persistence survives browser session expiry');
  assert.ok(firstRefresh.exp <= consent.expiresAt);

  // Reconnecting with a live provider session must check actual upstream permissions,
  // without adding a new requirement to ordinary MCP requests or refresh grants.
  const incrementalId = oauthJwt.payload.sub;
  const beforeIncremental = await store.get('FeishuAccount', incrementalId);
  const beforeCalls = upstreamCalls;
  const completeEntry = await reconnectEntry(oauth.browser);
  assert.equal(new URL(completeEntry.location).origin, 'https://client.test', 'complete account reuses session without upstream login');
  assert.equal(upstreamCalls, beforeCalls);
  await store.put('FeishuAccount', incrementalId,
    { ...beforeIncremental, scope: beforeIncremental.scope.replace('offline_access', '').trim() }, now() + 7200);
  assert.equal(new URL((await reconnectEntry(oauth.browser)).location).origin, 'https://client.test',
    'valid upstream refresh credential proves offline_access even when absent from access-token scope');

  config.feishuScopes += ' mail:user_mailbox:readonly mail:user_mailbox.message:modify';
  const missingEntry = await reconnectEntry(oauth.browser);
  assert.equal(new URL(missingEntry.location).origin, new URL(publicUrl).origin, 'new business scope requests a login interaction');
  const updatedCallback = await incrementalResume(oauth.browser, await incrementalCallback(oauth.browser, missingEntry));
  assert.ok(updatedCallback.searchParams.has('code'), 'incremental login resumes the original real OAuth transaction');
  const updatedAccount = await store.get('FeishuAccount', incrementalId);
  assert.equal(updatedAccount.scope, config.feishuScopes);
  assert.equal(upstreamCalls, beforeCalls + 2, 'only token exchange plus user info for incremental consent');
  const updatedTokens = await tokenRequest(codeParameters({ verifier: missingEntry.verifier, callback: updatedCallback }));
  assert.equal(updatedTokens.status, 200);
  const updatedTokenBody = await updatedTokens.json();
  privateValues.add(updatedTokenBody.access_token); privateValues.add(updatedTokenBody.refresh_token);
  assert.equal((await oidc.verifyMcpToken(updatedTokenBody.access_token)).accountId, incrementalId);
  assert.equal(new URL((await reconnectEntry(oauth.browser)).location).origin, 'https://client.test', 'updated account reuses session again');

  // Revoked and corrupted account rows must never be treated as a usable prior login.
  for (const invalid of [{ revoked: true }, { open_id: 'wrong-account' }]) {
    await store.put('FeishuAccount', incrementalId, { ...updatedAccount, ...invalid }, now() + 7200);
    const deniedEntry = new URL((await reconnectEntry(oauth.browser)).location);
    assert.equal(deniedEntry.origin, 'https://client.test');
    assert.equal(deniedEntry.searchParams.get('error'), 'access_denied');
    assert.equal(deniedEntry.searchParams.has('code'), false);
  }
  await store.put('FeishuAccount', incrementalId, { ...updatedAccount, scope: beforeIncremental.scope }, now() + 7200);
  const wrongAccountEntry = await reconnectEntry(oauth.browser);
  const savedOpenId = syntheticOpenId;
  syntheticOpenId = 'ou_wrong_incremental_account';
  const wrongAccountReply = await incrementalCallback(oauth.browser, wrongAccountEntry);
  assert.equal(wrongAccountReply.status, 400, 'incremental login cannot silently switch account');
  assert.equal(await store.get('FeishuAccount', 'tenant_protocol:ou_wrong_incremental_account'), undefined);
  assert.equal((await store.get('FeishuAccount', incrementalId)).scope, beforeIncremental.scope, 'mismatch does not replace credentials');
  syntheticOpenId = savedOpenId;

  // Missing grant and missing/expired refresh are distinct; neither fabricates permission.
  const partialEntry = await reconnectEntry(oauth.browser);
  syntheticGrantedScopes = beforeIncremental.scope;
  const partialCallback = await incrementalResume(oauth.browser, await incrementalCallback(oauth.browser, partialEntry));
  assert.equal(partialCallback.searchParams.get('error'), 'access_denied', 'partial grants terminate instead of looping');
  assert.equal(partialCallback.searchParams.has('code'), false);
  syntheticGrantedScopes = undefined;
  for (const invalid of [{ refresh_token: '' }, { refresh_expires_at: now() - 1 }]) {
    await store.put('FeishuAccount', incrementalId, { ...updatedAccount, ...invalid }, now() + 7200);
    assert.equal(new URL((await reconnectEntry(oauth.browser)).location).origin, new URL(publicUrl).origin,
      'offline_access text alone cannot substitute for usable refresh credentials');
  }
  const noRefreshEntry = await reconnectEntry(oauth.browser);
  syntheticRefresh = false;
  const noRefreshCallback = await incrementalResume(oauth.browser, await incrementalCallback(oauth.browser, noRefreshEntry));
  assert.equal(noRefreshCallback.searchParams.get('error'), 'access_denied', 'new upstream login without offline credential does not loop or invent refresh');
  syntheticRefresh = true;
  await store.put('FeishuAccount', incrementalId, updatedAccount, now() + 7200);
  const ordinaryCalls = upstreamCalls;
  config.feishuScopes += ' synthetic:not-yet-granted';
  assert.equal((await oidc.verifyMcpToken(updatedTokenBody.access_token)).accountId, incrementalId,
    'ordinary MCP authorization is not blocked by newly configured upstream scopes');
  assert.equal(upstreamCalls, ordinaryCalls);
  config.feishuScopes = updatedAccount.scope;

  // An old resource Grant without explicit persistent consent must not bypass the consent page.
  await store.remove('Consent', oauthGrantId);
  const renewedAuthorization = await oauth.browser.request(authUrl(randomBytes(32).toString('base64url'), {}, true));
  const renewedConsentUrl = redirect(renewedAuthorization);
  assert.equal(new URL(renewedConsentUrl).origin, new URL(publicUrl).origin);
  const renewedConsentPage = await oauth.browser.request(renewedConsentUrl);
  assert.equal(renewedConsentPage.status, 200);
  assert.match(await renewedConsentPage.text(), /持续连接最多 30 天/u);
  const missingConsentRefresh = await tokenRequest({ grant_type: 'refresh_token', client_id: client.client_id,
    refresh_token: oauthTokens.refresh_token, resource: config.resource });
  assert.equal(missingConsentRefresh.status, 400, 'refresh requires live explicit consent');
  for (const invalid of [{ accountId: 'another-account' }, { clientId: 'another-client' },
    { resource: 'https://another.test/mcp' }, { scopes: ['feishu.read'] }, { expiresAt: now() - 1 }]) {
    await store.put('Consent', oauthGrantId, { ...consent, ...invalid }, consent.expiresAt, undefined, oauthGrantId);
    assert.equal((await tokenRequest({ grant_type: 'refresh_token', client_id: client.client_id,
      refresh_token: oauthTokens.refresh_token, resource: config.resource })).status, 400, 'refresh validates all consent bindings');
  }
  await store.put('Consent', oauthGrantId, consent, consent.expiresAt, undefined, oauthGrantId);
  for (const record of records.values()) if (record.model === 'Session') await store.remove('Session', record.key);
  const actualNow = Date.now;
  let oauthRefreshedReply;
  try {
    Date.now = () => actualNow() + 60000;
    oauthRefreshedReply = await tokenRequest({ grant_type: 'refresh_token', client_id: client.client_id,
      refresh_token: oauthTokens.refresh_token, resource: config.resource });
  } finally { Date.now = actualNow; }
  assert.equal(oauthRefreshedReply.status, 200, 'refresh works after browser session removal');
  const oauthRefreshed = await oauthRefreshedReply.json();
  privateValues.add(oauthRefreshed.access_token); privateValues.add(oauthRefreshed.refresh_token);
  assert.equal(oauthRefreshed.scope, 'feishu.read feishu.write'); assert.equal(oauthRefreshed.id_token, undefined);
  assert.notEqual(oauthRefreshed.refresh_token, oauthTokens.refresh_token);
  const nextRefresh = await oidc.provider.RefreshToken.find(oauthRefreshed.refresh_token);
  assert.equal(nextRefresh.exp, firstRefresh.exp, 'rotation cannot extend the original 30-day authorization');
  assert.equal(nextRefresh.iiat, firstRefresh.iiat);
  const oauthRevoked = await browser.request(discovery.revocation_endpoint, { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
      client_id: client.client_id, token: oauthRefreshed.refresh_token, token_type_hint: 'refresh_token',
    }) });
  assert.equal(oauthRevoked.status, 200);
  assert.equal(await store.get('Consent', oauthGrantId), undefined, 'revocation deletes persistence consent');
  await assert.rejects(() => oidc.verifyMcpToken(oauthRefreshed.access_token));
  assert.equal((await tokenRequest({ grant_type: 'refresh_token', client_id: client.client_id,
    refresh_token: oauthRefreshed.refresh_token, resource: config.resource })).status, 400);

  const race = await authorize();
  const racers = await Promise.all([tokenRequest(codeParameters(race)), tokenRequest(codeParameters(race))]);
  assert.ok(racers.filter((reply) => reply.status === 200).length <= 1, 'CAS never issues twice');
  assert.ok(racers.some((reply) => reply.status === 400), 'replay is rejected');
  // A replay revokes the entire grant. The first request may consequently fail closed while
  // persisting its refresh token, rather than returning an already-revoked access token.
  for (const reply of racers) {
    if (reply.status === 200) {
      const raceTokens = await reply.json();
      await assert.rejects(() => oidc.verifyMcpToken(raceTokens.access_token));
    } else assert.ok([400, 500].includes(reply.status));
  }
  const adapter = connectorAdapter(store)('AuthorizationCode');
  await adapter.upsert('atomic-test', { kind: 'AuthorizationCode' }, 60);
  const consumes = await Promise.allSettled([adapter.consume('atomic-test'), adapter.consume('atomic-test')]);
  assert.equal(consumes.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(consumes.filter((result) => result.status === 'rejected').length, 1);
  const logged = visibleLogs.join('\n');
  for (const value of privateValues) assert.ok(!logged.includes(value), 'sensitive request/response never reaches logger-visible objects');
  for (const value of privateValues) assert.ok(!JSON.stringify(diagnosticRecords).includes(value), 'diagnostics excludes private values');
  for (const grantType of ['authorization_code', 'refresh_token']) assert.ok(diagnosticRecords.some((entry) =>
    entry.event === 'connector_oauth_token' && entry.grantType === grantType && entry.status === 200 && entry.expiresIn === 600));
  console.log('PASS: OIDC/OAuth discovery/gateway paths, readiness, bounded upstream HTTP, JWKS/PKCE/resource, Feishu state/cookie/handoff, incremental scope reauthorization/account binding/offline credential/partial-grant checks, consent headers/Origin/CSRF, pure OAuth explicit 30-day consent, session-independent bounded refresh/rotation, consent/account isolation, refresh replay/CAS/HTTP revocation, new-login refresh lease, private request/response logging.');
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
