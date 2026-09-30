import 'reflect-metadata';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Synthetic encryption keys and fetch doubles only. Never load an env file or contact the cloud.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dependency = createRequire(import.meta.url);
const cache = new Map();
const stubs = {};
let controller;
const signalFactory = { timeout(milliseconds) {
  assert.equal(milliseconds, 15000);
  controller = new AbortController(); return controller.signal;
} };
function load(file) {
  const absolute = path.resolve(root, file);
  if (cache.has(absolute)) return cache.get(absolute).exports;
  const module = { exports: {} }; cache.set(absolute, module);
  const code = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      esModuleInterop: true, experimentalDecorators: true },
  }).outputText;
  new Function('require', 'module', 'exports', 'AbortSignal', code)((name) => stubs[name] ?? (name.startsWith('.')
    ? load(path.resolve(path.dirname(absolute), `${name}.ts`)) : dependency(name)), module, module.exports, signalFactory);
  return module.exports;
}
const { ServiceUnavailableException } = dependency('@nestjs/common');
const { ConnectorAuthDiagnostics } = load('server/modules/connector-auth/connector-auth.diagnostics.ts');
const messages = [];
const diagnostics = new ConnectorAuthDiagnostics((message) => messages.push(JSON.parse(message)));
stubs['../connector-auth/connector-auth.diagnostics'] = { connectorAuthDiagnostics: diagnostics };
const { ConnectorAuthStorageCrypto, STORAGE_REQUEST_AAD } = load('server/modules/connector-auth-storage/connector-auth-storage.crypto.ts');
const { ConnectorAuthStorageService, ConnectorStorageUnavailableError } =
  load('server/modules/connector-auth-storage/connector-auth-storage.service.ts');
const crypto = new ConnectorAuthStorageCrypto();
const store = new ConnectorAuthStorageService(crypto);
const sentinel = 'synthetic-private-payload-and-error';
let requests = [];
let fetchImpl;
globalThis.fetch = async (url, init) => {
  requests.push({ url, init });
  assert.equal(url, 'https://relay.example.test/openapi/connector-auth-storage/execute');
  assert.equal(init.redirect, 'error');
  assert.equal(init.method, 'POST');
  return fetchImpl(url, init);
};
function setup() {
  process.env.CONNECTOR_PUBLIC_URL = 'https://relay.example.test';
  process.env.CONNECTOR_STORAGE_API_KEY = 'synthetic-api-key';
  process.env.CONNECTOR_STORAGE_ENCRYPTION_KEY = '12'.repeat(32);
  delete process.env.CONNECTOR_DEPLOYMENT_CONFIG;
  requests = []; messages.length = 0;
}
function response(init, result = { ok: true }, extra = {}) {
  const { sealed } = JSON.parse(init.body);
  const timed = crypto.open(sealed, STORAGE_REQUEST_AAD);
  assert.ok(timed.issuedAt > Date.now() - 1000);
  return new Response(JSON.stringify({ sealed: crypto.seal(result, crypto.responseAad(sealed)) }), {
    status: 200, headers: { 'Content-Type': 'application/json' }, ...extra,
  });
}
const put = () => store.put('FeishuFileChunk', 'synthetic-ticket:0', { data: sentinel,
  accountId: 'synthetic-account', grantId: 'synthetic-grant', index: 0 }, Math.floor(Date.now() / 1000) + 900);
let checks = 0;
async function expectFailure(action, reason, status = 0, expectedCalls = 1) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof ConnectorStorageUnavailableError);
    assert.ok(error instanceof ServiceUnavailableException);
    assert.equal(error.getStatus(), 503);
    assert.equal(error.failureReason, reason);
    assert.equal(error.upstreamStatus, status);
    assert.equal(error.cause, undefined);
    assert.deepEqual(error.getResponse(), { statusCode: 503, message: 'Authorization storage is unavailable.',
      error: 'Service Unavailable' });
    assert.ok(!JSON.stringify(error).includes(sentinel));
    return true;
  });
  assert.equal(requests.length, expectedCalls, 'relay never retries any operation implicitly');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].failureReason, reason);
  assert.equal(messages[0].upstreamStatus, status);
  assert.equal(messages[0].ok, false);
  assert.ok(!JSON.stringify(messages).includes(sentinel));
  assert.ok(!JSON.stringify(messages).includes('synthetic-api-key'));
  assert.ok(!JSON.stringify(messages).includes('synthetic-account'));
  assert.ok(!JSON.stringify(messages).includes('synthetic-grant'));
  checks++;
}

setup(); await expectFailure(() => store.get(sentinel, 'synthetic'), 'validation', 0, 0);
setup(); await expectFailure(() => store.put('FeishuFile', 'synthetic', { data: 'x'.repeat(49152) }, 1), 'validation', 0, 0);
setup(); delete process.env.CONNECTOR_STORAGE_API_KEY; await expectFailure(put, 'config', 0, 0);
setup(); process.env.CONNECTOR_PUBLIC_URL = 'http://private.invalid'; await expectFailure(put, 'config', 0, 0);
setup(); process.env.CONNECTOR_STORAGE_ENCRYPTION_KEY = sentinel; await expectFailure(put, 'config', 0, 0);

for (const status of [400, 401, 408, 429, 500, 502, 503, 504]) {
  setup(); fetchImpl = async () => new Response(sentinel, { status });
  await expectFailure(put, 'http', status);
  assert.equal(messages[0].model, 'FeishuFileChunk');
}
setup(); fetchImpl = async () => { throw new TypeError(sentinel); };
await expectFailure(put, 'network');
setup(); fetchImpl = async () => { controller.abort(); throw new Error(sentinel); };
await expectFailure(put, 'network_timeout');
setup(); fetchImpl = async () => new Response(new ReadableStream({ start(stream) { stream.error(new Error(sentinel)); } }),
  { headers: { 'Content-Type': 'application/json' } });
await expectFailure(put, 'network', 200);
setup(); fetchImpl = async () => new Response(new ReadableStream({ start(stream) {
  controller.abort(); stream.error(new Error(sentinel));
} }), { headers: { 'Content-Type': 'application/json' } });
await expectFailure(put, 'network_timeout', 200);

for (const makeResponse of [
  () => new Response(sentinel, { headers: { 'Content-Type': 'text/plain' } }),
  () => new Response(sentinel, { headers: { 'Content-Type': 'application/json' } }),
  () => new Response(null, { headers: { 'Content-Type': 'application/json' } }),
  () => new Response('x'.repeat(72001), { headers: { 'Content-Type': 'application/json' } }),
  () => new Response(JSON.stringify({ sealed: sentinel }), { headers: { 'Content-Type': 'application/json' } }),
  (_url, init) => response(init, { ok: false }),
  (_url, init) => response(init, { ok: true, consumed: true }),
  (_url, init) => response(init, { ok: true, record: { data: sentinel } }),
  (_url, init) => response(init, { ok: true, leaseToken: 'x'.repeat(43) }),
  (_url, init) => {
    const { sealed } = JSON.parse(init.body);
    return new Response(JSON.stringify({ sealed: crypto.seal({ ok: true }, crypto.responseAad(`${sealed}wrong`)) }),
      { headers: { 'Content-Type': 'application/json' } });
  },
]) {
  setup(); fetchImpl = async (...args) => makeResponse(...args);
  await expectFailure(put, 'response_invalid', 200);
}

const commands = [
  ['get', () => store.get('FeishuFile', 'synthetic'), { ok: true, record: { data: sentinel } }],
  ['put', put, { ok: true }],
  ['consume', () => store.consume('RefreshToken', 'synthetic'), { ok: true, consumed: true }],
  ['remove', () => store.remove('FeishuFile', 'synthetic'), { ok: true }],
  ['revokeGrant', () => store.revokeGrant('synthetic-grant'), { ok: true }],
  ['findUid', () => store.findUid('Session', 'synthetic-uid'), { ok: true }],
  ['acquireLease', () => store.acquireLease('synthetic-lease'), { ok: true, leaseToken: 'x'.repeat(43) }],
  ['releaseLease', () => store.releaseLease('synthetic-lease', 'x'.repeat(43)), { ok: true }],
];
for (const [operation, action, result] of commands) {
  setup(); fetchImpl = async (_url, init) => response(init, result);
  await action();
  assert.equal(requests.length, 1); assert.equal(messages.length, 1);
  assert.equal(messages[0].ok, true); assert.equal(messages[0].operation, operation);
  assert.equal(messages[0].upstreamStatus, 200); assert.equal(messages[0].failureReason, undefined);
  setup(); fetchImpl = async () => new Response(sentinel, { status: 503 });
  await expectFailure(action, 'http', 503);
}
setup(); fetchImpl = async (_url, init) => response(init);
await expectFailure(() => store.consume('RefreshToken', 'synthetic'), 'response_invalid', 200);

messages.length = 0;
diagnostics.storage(sentinel, sentinel, false, -1, sentinel, sentinel);
assert.deepEqual(messages[0], { event: 'connector_auth_storage', operation: 'other', model: 'none',
  ok: false, durationMs: 0, upstreamStatus: 0 });
diagnostics.storage('put', 'FeishuFile', true, 1, 'http', 200);
assert.equal(messages[1].model, 'FeishuFile'); assert.equal(messages[1].failureReason, undefined);
assert.ok(!JSON.stringify(messages).includes(sentinel));
new ConnectorAuthDiagnostics(() => { throw Error(sentinel); }).storage('put', 'FeishuFileChunk', false, 1, 'http', 503);
checks += 3;
console.log(JSON.stringify({ ok: true, checks, network: false,
  coverage: 'six safe failure categories, numeric HTTP status, file model names, unchanged 503 response, no payload disclosure, no relay mutation retries' }));
