import 'reflect-metadata';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Entirely synthetic: real crypto, privacy middleware, controller and relay; no cloud or env-file access.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dependency = createRequire(import.meta.url);
const cache = new Map();
const stubs = { './connector-auth-storage.repository': { ConnectorAuthStorageRepository: class {} } };
let abort;
const signalFactory = { timeout(ms) { assert.equal(ms, 15000); abort = new AbortController(); return abort.signal; } };
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
const { ConnectorAuthDiagnostics } = load('server/modules/connector-auth/connector-auth.diagnostics.ts');
const messages = [];
stubs['../connector-auth/connector-auth.diagnostics'] = {
  connectorAuthDiagnostics: new ConnectorAuthDiagnostics((message) => messages.push(JSON.parse(message))),
};
const contract = load('server/modules/connector-auth-storage/connector-auth-storage.contract.ts');
assert.equal(contract.STORAGE_FILE_BATCH_MAX_BYTES, 960000);
assert.ok(contract.STORAGE_FILE_BATCH_MAX_BYTES < 1024 * 1024);
function envelopeWithBytes(byteLength) {
  const count = 16;
  const overhead = Buffer.byteLength(JSON.stringify({ sealed: Array(count).fill('') }));
  const content = byteLength - overhead;
  const sealed = Array.from({ length: count }, (_, index) => {
    const length = Math.floor(content / count) + (index < content % count ? 1 : 0);
    return `v1:${'a'.repeat(length - 7)}:b:c`;
  });
  const value = { sealed };
  assert.equal(Buffer.byteLength(JSON.stringify(value)), byteLength);
  assert.ok(sealed.every((entry) => entry.length >= 40 && entry.length <= 70000));
  return value;
}
assert.equal(contract.validateStorageFileBatchEnvelope(envelopeWithBytes(960000)).sealed.length, 16);
assert.throws(() => contract.validateStorageFileBatchEnvelope(envelopeWithBytes(960001)), /File batch rejected/u);
const openapi = JSON.parse(fs.readFileSync(path.join(root, 'docs/openapi.json'), 'utf8'));
const endpoint = openapi.paths['/openapi/connector-auth-storage/execute'].post;
for (const schema of [endpoint.requestBody.content['application/json'].schema,
  endpoint.responses['200'].content['application/json'].schema]) {
  const array = schema.properties.sealed.oneOf.find((variant) => variant.type === 'array');
  assert.equal(array.maxItems, 16); assert.equal(array.minItems, 1);
  assert.equal(array.items.maxLength, 70000, 'per-record encrypted limit is unchanged');
  assert.match(schema.properties.sealed.description, /960000/u);
}
const { ConnectorAuthStorageCrypto, STORAGE_REQUEST_AAD } = load('server/modules/connector-auth-storage/connector-auth-storage.crypto.ts');
const { ConnectorAuthStorageService, ConnectorStorageUnavailableError } = load('server/modules/connector-auth-storage/connector-auth-storage.service.ts');
const { ConnectorAuthStorageOpenapiController } = load('server/modules/connector-auth-storage/connector-auth-storage.openapi.controller.ts');
const { connectorPrivacyMiddleware } = load('server/modules/connector-privacy/connector-privacy.middleware.ts');
process.env.CONNECTOR_PUBLIC_URL = 'https://relay.example.test';
process.env.CONNECTOR_STORAGE_API_KEY = 'synthetic-api-key';
process.env.CONNECTOR_STORAGE_ENCRYPTION_KEY = '12'.repeat(32);
delete process.env.CONNECTOR_DEPLOYMENT_CONFIG;
const crypto = new ConnectorAuthStorageCrypto();
const store = new ConnectorAuthStorageService(crypto);
const rows = new Map();
const expiresAt = Math.floor(Date.now() / 1000) + 900;
const entries = Array.from({ length: 16 }, (_, index) => ({ key: `synthetic-file:${index}`, expiresAt,
  payload: { grantId: 'synthetic-grant', index, data: Buffer.alloc(24576, index).toString('base64') } }));
let repositoryCalls = 0;
let ordinaryCalls = 0;
let repositoryImpl = async (commands) => commands.map((command) => {
  if (command.operation === 'put') { rows.set(command.key, command.payload); return { ok: true }; }
  return { ok: true, ...(rows.has(command.key) ? { record: rows.get(command.key) } : {}) };
});
const controller = new ConnectorAuthStorageOpenapiController(crypto, {
  async execute(command) { ordinaryCalls++; assert.equal(command.model, 'Grant'); return { ok: true, record: { synthetic: true } }; },
  async executeFileBatch(commands) { repositoryCalls++; return repositoryImpl(commands); },
});
let checks = 0;
let requests = 0;
let wireBodies = [];
async function callController(body, query = {}) {
  const request = { body, query, headers: { authorization: 'Bearer synthetic-api-key' },
    url: '/openapi/connector-auth-storage/execute', originalUrl: '/openapi/connector-auth-storage/execute', params: {} };
  let output;
  const response = { statusCode: 200, status(status) { this.statusCode = status; return this; },
    json(value) { output = value; return this; }, send() {}, redirect() {} };
  let next = false;
  connectorPrivacyMiddleware(request, response, () => { next = true; });
  assert.equal(next, true); assert.equal(request.body, undefined);
  // A platform logger wrapping serializers after middleware must not receive ciphertext.
  response.json = () => { throw new Error('Privacy boundary bypassed.'); };
  await controller.connectorAuthStorageExecute(request, response);
  return { status: response.statusCode, body: output };
}
const routeFetch = async (_url, init) => {
  const result = await callController(JSON.parse(init.body));
  return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'Content-Type': 'application/json' } });
};
let fetchImpl = routeFetch;
globalThis.fetch = async (url, init) => {
  requests++; wireBodies.push(init.body);
  assert.equal(url, 'https://relay.example.test/openapi/connector-auth-storage/execute');
  assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
  assert.equal(init.headers.Authorization, 'Bearer synthetic-api-key');
  assert.ok(Buffer.byteLength(init.body) <= 960000);
  return fetchImpl(url, init);
};
function reset() { requests = 0; repositoryCalls = 0; wireBodies = []; messages.length = 0; fetchImpl = routeFetch; }
function encrypted(commands, offsets = []) {
  return { sealed: commands.map((command, index) => crypto.seal({ command, issuedAt: Date.now() + (offsets[index] ?? 0) }, STORAGE_REQUEST_AAD)) };
}
const getCommand = (key = 'synthetic-file:0') => ({ operation: 'get', model: 'FeishuFileChunk', key });
const putCommand = (entry = entries[0]) => ({ operation: 'put', model: 'FeishuFileChunk', ...entry });
async function rejectedController(body, query) {
  const before = repositoryCalls;
  const result = await callController(body, query);
  assert.deepEqual(result, { status: 503, body: { error: 'temporarily_unavailable' } });
  assert.equal(repositoryCalls, before, 'invalid batch never reaches the repository'); checks++;
}
async function rejectedRelay(action, reason, status = 0, count = 1) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof ConnectorStorageUnavailableError); assert.equal(error.getStatus(), 503);
    assert.equal(error.failureReason, reason); assert.equal(error.upstreamStatus, status);
    assert.equal(error.cause, undefined); return true;
  });
  assert.equal(requests, count, 'relay never retries a batch implicitly');
  assert.equal(messages.at(-1).failureReason, reason); checks++;
}

reset(); await store.putFileChunks(entries);
assert.equal(requests, 1); assert.equal(repositoryCalls, 1); assert.equal(rows.size, 16);
assert.ok(Buffer.byteLength(wireBodies[0]) > 560000, '16 full chunks exercise the increased aggregate limit');
assert.equal(messages[0].operation, 'putFileChunks'); assert.equal(messages[0].batchSize, 16);
const decoded = JSON.parse(wireBodies[0]).sealed.map((sealed) => crypto.open(sealed, STORAGE_REQUEST_AAD));
assert.deepEqual(decoded.map(({ command }) => command), entries.map((entry) => putCommand(entry))); checks++;
reset(); const result = await store.getFileChunks(entries.map(({ key }) => key).reverse());
assert.deepEqual(result, entries.map(({ payload }) => payload).reverse());
assert.equal(requests, 1); assert.equal(repositoryCalls, 1); assert.equal(messages[0].operation, 'getFileChunks'); checks++;
reset(); assert.deepEqual(await store.getFileChunks(['missing', entries[2].key]), [undefined, entries[2].payload]); checks++;
reset(); assert.deepEqual(await store.get('Grant', 'ordinary'), { synthetic: true });
assert.equal(ordinaryCalls, 1); assert.equal(repositoryCalls, 0);
assert.equal(typeof JSON.parse(wireBodies[0]).sealed, 'string'); checks++;

for (const keys of [[], Array.from({ length: 17 }, (_, i) => `${i}`), ['duplicate', 'duplicate'], ['']]) {
  reset(); await rejectedRelay(() => store.getFileChunks(keys), 'validation', 0, 0);
}
reset(); await rejectedRelay(() => store.putFileChunks([{ ...entries[0], payload: { data: 'x'.repeat(49152) } }]), 'validation', 0, 0);
reset(); await rejectedRelay(() => store.putFileChunks([{ ...entries[0], payload: JSON.parse('{"constructor":"forbidden"}') }]), 'validation', 0, 0);
const aggregateOversized = entries.map((entry) => ({ ...entry, payload: { ...entry.payload, data: 'x'.repeat(46000) } }));
reset(); await rejectedRelay(() => store.putFileChunks(aggregateOversized), 'validation', 0, 0);

for (const commands of [
  [], Array.from({ length: 17 }, (_, i) => getCommand(`${i}`)), [getCommand(), getCommand()],
  [{ ...getCommand(), model: 'RefreshToken' }], [{ ...getCommand(), operation: 'consume' }],
  [{ ...getCommand(), operation: 'remove' }], [{ operation: 'revokeGrant', grantId: 'synthetic-grant' }],
  [getCommand(), { ...putCommand(), key: 'different' }], [{ ...getCommand(), extra: true }],
]) await rejectedController(encrypted(commands));
await rejectedController(encrypted([getCommand(), getCommand('other')], [0, -61000]));
await rejectedController(encrypted([getCommand()], [61000]));
await rejectedController(encrypted([getCommand()]), { forbidden: 'value' });
await rejectedController({ ...encrypted([getCommand()]), extra: true });
await rejectedController({ sealed: ['v1:a:b:c'] });
await rejectedController({ sealed: ['x'.repeat(70001)] });
await rejectedController({ sealed: Array(16).fill(`v1:${'a'.repeat(69990)}:b:c`) });
await rejectedController(envelopeWithBytes(960001));
await rejectedController(encrypted(aggregateOversized.map((entry) => putCommand(entry))));
const invalidAad = { sealed: [crypto.seal({ issuedAt: Date.now(), command: getCommand() }, 'incorrect')] };
await rejectedController(invalidAad);
const altered = encrypted([getCommand()]);
altered.sealed[0] = altered.sealed[0].replace(/^v1:(.)/u, (_prefix, first) => `v1:${first === 'a' ? 'b' : 'a'}`);
await rejectedController(altered);

const jsonResponse = (body) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
function encryptedResponse(init, results) {
  const request = JSON.parse(init.body);
  return { sealed: results.map((value, index) => crypto.seal(value, crypto.responseAad(request.sealed[index]))) };
}
for (const modify of [
  (body) => ({ sealed: body.sealed.slice(1) }),
  (body) => ({ sealed: [...body.sealed, body.sealed[0]] }),
  (body) => ({ sealed: [...body.sealed].reverse() }),
  (body) => ({ sealed: [body.sealed[0], body.sealed[0]] }),
  (body) => ({ ...body, extra: true }),
]) {
  reset(); fetchImpl = async (_url, init) => jsonResponse(modify(encryptedResponse(init, [{ ok: true }, { ok: true }])));
  await rejectedRelay(() => store.getFileChunks(['one', 'two']), 'response_invalid', 200);
}
for (const invalid of [{ ok: false }, { ok: true, consumed: true }, { ok: true, leaseToken: 'a'.repeat(43) },
  { ok: true, record: { private: 'value' } }, { ok: true, extra: true }]) {
  reset(); fetchImpl = async (_url, init) => jsonResponse(encryptedResponse(init, [invalid]));
  await rejectedRelay(() => store.putFileChunks([entries[0]]), 'response_invalid', 200);
}
for (const status of [408, 429, 500, 503]) {
  reset(); fetchImpl = async () => new Response('synthetic-sensitive-upstream-body', { status });
  await rejectedRelay(() => store.getFileChunks(['one']), 'http', status);
}
reset(); fetchImpl = async () => { throw new Error('synthetic-sensitive-network-error'); };
await rejectedRelay(() => store.getFileChunks(['one']), 'network');
reset(); fetchImpl = async () => { abort.abort(); throw new Error('synthetic-sensitive-timeout'); };
await rejectedRelay(() => store.getFileChunks(['one']), 'network_timeout');
for (const response of [() => new Response(null, { headers: { 'Content-Type': 'application/json' } }),
  () => new Response('x'.repeat(960001), { headers: { 'Content-Type': 'application/json' } }),
  () => new Response('{}', { headers: { 'Content-Type': 'text/plain' } })]) {
  reset(); fetchImpl = async () => response();
  await rejectedRelay(() => store.getFileChunks(['one']), 'response_invalid', 200);
}

// Malformed repository results cannot escape as valid encrypted success responses.
for (const returned of [[], [{ ok: true }, { ok: true }], [{ ok: true, record: {} }]]) {
  reset(); repositoryImpl = async () => returned;
  const reply = await callController(encrypted([putCommand()]));
  assert.deepEqual(reply, { status: 503, body: { error: 'temporarily_unavailable' } }); checks++;
}
assert.throws(() => contract.validateStorageJson({ value: 'x'.repeat(49152) }));
assert.throws(() => crypto.seal({ value: 'x'.repeat(49152) }, STORAGE_REQUEST_AAD));
for (const size of [1, 8, 16, 17, 0, -1, 1.5, '16']) {
  stubs['../connector-auth/connector-auth.diagnostics'].connectorAuthDiagnostics
    .storage('getFileChunks', 'FeishuFileChunk', true, 1, undefined, 200, size);
  assert.equal(messages.at(-1).batchSize, [1, 8, 16].includes(size) ? size : 0);
  checks++;
}
assert.ok(!JSON.stringify(messages).includes('synthetic-sensitive'));
assert.ok(!JSON.stringify(messages).includes('synthetic-api-key'));
assert.ok(!JSON.stringify(messages).includes('synthetic-grant')); checks++;
console.log(JSON.stringify({ ok: true, checks, network: false, batchSize: 16,
  coverage: 'independent AAD, ordered encrypted controller-relay roundtrip, per-entry and aggregate limits, file-only same-operation batches, all-before-write validation, safe failure classes, privacy middleware' }));
