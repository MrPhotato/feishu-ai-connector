import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dependency = createRequire(import.meta.url);
function loader(stubs = {}, timer = setTimeout) {
const cache = new Map();
function load(file) {
  const absolute = path.resolve(root, file);
  if (cache.has(absolute)) return cache.get(absolute).exports;
  const module = { exports: {} }; cache.set(absolute, module);
  const code = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  new Function('require', 'module', 'exports', 'setTimeout', code)((name) => stubs[name] ?? (name.startsWith('.')
    ? load(path.resolve(path.dirname(absolute), `${name}.ts`)) : dependency(name)), module, module.exports, timer);
  return module.exports;
}
return load;
}
const load = loader();
process.env.CONNECTOR_PUBLIC_URL = 'https://connector.example.test';
delete process.env.CONNECTOR_DEPLOYMENT_CONFIG;
const { publishFile, retrieveFile } = load('server/modules/feishu-tools/feishu-file-delivery.ts');
const { publicAddress, inputUrl, hostFileSchema } = load('server/modules/feishu-tools/feishu-file-input.ts');
const { validateStorageJson } = load('server/modules/connector-auth-storage/connector-auth-storage.contract.ts');
const principal = { accountId: 'tenant:ou_synthetic', scopes: ['feishu.read'], grantId: 'grant_synthetic', clientId: 'chatgpt' };
const expiry = Math.floor(Date.now() / 1000) + 3600;
const map = new Map([
  ['FeishuAccount:tenant:ou_synthetic', { tenant_key: 'tenant', open_id: 'ou_synthetic' }],
  ['Grant:grant_synthetic', { accountId: principal.accountId, clientId: 'chatgpt', exp: expiry,
    resources: { 'https://connector.example.test/mcp': 'feishu.read' } }],
  ['Consent:grant_synthetic', { accountId: principal.accountId, clientId: 'chatgpt', grantId: principal.grantId,
    resource: 'https://connector.example.test/mcp', scopes: ['feishu.read'], expiresAt: expiry }],
]);
const store = {
  async get(model, key) { return structuredClone(map.get(`${model}:${key}`)); },
  async put(model, key, payload, expiresAt) {
    validateStorageJson({ operation: 'put', model, key, payload, expiresAt });
    map.set(`${model}:${key}`, structuredClone(payload));
  },
};
const bytes = Buffer.alloc(80_000, 37);
const file = { name: 'report.txt', mimeType: 'text/plain', dataBase64: bytes.toString('base64'), byteLength: bytes.length };
const link = await publishFile(store, principal, file);
const ticket = new URL(link.downloadUrl).searchParams.get('ticket');
assert.equal(ticket.length, 43);
assert.equal(link.byteLength, bytes.length);
assert.ok(Date.parse(link.expiresAt) > Date.now() + 890000 && Date.parse(link.expiresAt) <= Date.now() + 900000);
assert(!link.downloadUrl.includes(principal.accountId));
assert.deepEqual((await retrieveFile(store, ticket)).bytes, bytes);
assert.ok([...map.entries()].filter(([key]) => key.startsWith('FeishuFileChunk:'))
  .every(([, value]) => value.grantId === principal.grantId), 'chunks are indexed to the same grant for revocation');
assert.equal(await retrieveFile(store, `${ticket}x`), undefined);
const manifestKey = `FeishuFile:${ticket}`;
const original = structuredClone(map.get(manifestKey));
for (const change of [{ expiresAt: 1 }, { accountId: 'other:ou_synthetic' }, { parts: 1000000 },
  { byteLength: 100000000 }, { clientId: 'wrong' }, { grantId: 'missing' }, { scopes: ['feishu.write'] }]) {
  map.set(manifestKey, { ...original, ...change });
  assert.equal(await retrieveFile(store, ticket), undefined);
}
map.set(manifestKey, original);
const consent = map.get('Consent:grant_synthetic');
map.delete('Consent:grant_synthetic');
assert.equal(await retrieveFile(store, ticket), undefined);
map.set('Consent:grant_synthetic', consent);
const chunkKey = `FeishuFileChunk:${ticket}:0`;
const chunk = map.get(chunkKey);
map.set(chunkKey, { ...chunk, accountId: 'other' });
await assert.rejects(retrieveFile(store, ticket), /file_delivery_invalid/);
map.set(chunkKey, { ...chunk, data: Buffer.alloc(24576, 99).toString('base64') });
await assert.rejects(retrieveFile(store, ticket), /file_delivery_invalid/);
map.set(chunkKey, chunk);

// Hold a real async chunk read after it captured valid data, then change authorization before it completes.
// This models an already-started relay response arriving after revocation, without relying on chunk deletion.
const authorizationKeys = ['FeishuAccount:tenant:ou_synthetic', 'Grant:grant_synthetic', 'Consent:grant_synthetic'];
const authorizationSnapshot = authorizationKeys.map((key) => [key, structuredClone(map.get(key))]);
const realNow = Date.now;
for (const [label, mutate] of [
  ['account revoked', () => map.set(authorizationKeys[0], { ...map.get(authorizationKeys[0]), revoked: true })],
  ['account identity changed', () => map.set(authorizationKeys[0], { ...map.get(authorizationKeys[0]), open_id: 'other' })],
  ['grant revoked', () => map.delete(authorizationKeys[1])],
  ['grant client changed', () => map.set(authorizationKeys[1], { ...map.get(authorizationKeys[1]), clientId: 'other' })],
  ['grant scope removed', () => map.set(authorizationKeys[1], { ...map.get(authorizationKeys[1]),
    resources: { 'https://connector.example.test/mcp': 'feishu.write' } })],
  ['grant expired', () => map.set(authorizationKeys[1], { ...map.get(authorizationKeys[1]), exp: 1 })],
  ['consent withdrawn', () => map.delete(authorizationKeys[2])],
  ['consent account changed', () => map.set(authorizationKeys[2], { ...map.get(authorizationKeys[2]), accountId: 'other' })],
  ['consent scope removed', () => map.set(authorizationKeys[2], { ...map.get(authorizationKeys[2]), scopes: [] })],
  ['consent expired', () => map.set(authorizationKeys[2], { ...map.get(authorizationKeys[2]), expiresAt: 1 })],
  ['ticket expired', () => { Date.now = () => original.expiresAt * 1000; }],
]) {
  const started = Promise.withResolvers();
  const resume = Promise.withResolvers();
  let returned = false;
  const retrieval = retrieveFile({ ...store, async get(model, key) {
    const captured = await store.get(model, key);
    if (model === 'FeishuFileChunk' && key === `${ticket}:0`) {
      started.resolve();
      await resume.promise;
    }
    return captured;
  } }, ticket).then((result) => { returned = true; return result; });
  try {
    await started.promise;
    assert.equal(returned, false, `${label}: download is still pending`);
    mutate();
    resume.resolve();
    assert.equal(await retrieval, undefined, `${label}: no bytes released after authorization changed`);
  } finally {
    resume.resolve();
    Date.now = realNow;
    for (const [key, value] of authorizationSnapshot) map.set(key, structuredClone(value));
  }
}

// Expiry must also be checked after the final authorization reads, not just before awaiting them.
const finalAuthorizationStarted = Promise.withResolvers();
const finalAuthorizationResume = Promise.withResolvers();
let consentReads = 0;
const finalAuthorization = retrieveFile({ ...store, async get(model, key) {
  const captured = await store.get(model, key);
  if (model === 'Consent' && ++consentReads === 2) {
    finalAuthorizationStarted.resolve();
    await finalAuthorizationResume.promise;
  }
  return captured;
} }, ticket);
try {
  await finalAuthorizationStarted.promise;
  Date.now = () => original.expiresAt * 1000;
  finalAuthorizationResume.resolve();
  assert.equal(await finalAuthorization, undefined, 'ticket expiry during final authorization read denies download');
} finally {
  finalAuthorizationResume.resolve();
  Date.now = realNow;
}
assert.deepEqual((await retrieveFile(store, ticket)).bytes, bytes, 'unchanged authorization still permits download');
await assert.rejects(publishFile(store, { ...principal, grantId: undefined }, file), /file_delivery_invalid/);
await assert.rejects(publishFile(store, principal, { ...file, byteLength: 2 }), /file_delivery_invalid/);
const failingMap = new Map();
await assert.rejects(publishFile({ ...store, async put(model, key, payload) {
  if (model === 'FeishuFileChunk') throw new Error('simulated outage');
  failingMap.set(key, payload);
} }, principal, file));
assert.equal(failingMap.size, 0, 'failed chunks cannot publish a usable manifest');
const delayedMap = new Map();
const delayedWrites = [];
const delayedPublish = publishFile({ ...store, async put(model, key, payload) {
  if (model === 'FeishuFileChunk') await new Promise((resolve) => delayedWrites.push(resolve));
  delayedMap.set(`${model}:${key}`, payload);
} }, principal, file);
await new Promise((resolve) => setImmediate(resolve));
assert.equal([...delayedMap.keys()].some((key) => key.startsWith('FeishuFile:')), false);
for (const resolve of delayedWrites) resolve();
await delayedPublish;
assert.equal([...delayedMap.keys()].at(-1).startsWith('FeishuFile:'), true, 'manifest is committed only after every chunk');

// A failed worker stops new chunks, but the caller waits for already-started writes to finish.
const largeBytes = Buffer.alloc(7_563_270, 37);
const largeFile = { ...file, dataBase64: largeBytes.toString('base64'), byteLength: largeBytes.length };
const pendingWrites = [];
let startedWrites = 0;
let failureReturned = false;
const drainedFailure = publishFile({ ...store, async put(model) {
  assert.equal(model, 'FeishuFileChunk', 'no manifest after failed transfer');
  if (++startedWrites === 1) throw new Error('private backend detail');
  await new Promise((resolve) => pendingWrites.push(resolve));
} }, principal, largeFile).then(() => assert.fail('must reject'), (error) => {
  failureReturned = true; assert.equal(error.message, 'file_delivery_unavailable');
});
await new Promise((resolve) => setImmediate(resolve));
assert.equal(startedWrites, 4, 'bounded concurrency');
assert.equal(failureReturned, false, 'do not return while a write remains active');
for (const resolve of pendingWrites) resolve();
await drainedFailure;
await new Promise((resolve) => setImmediate(resolve));
assert.equal(startedWrites, 4, 'no background continuation after failure');

const recovered = loader({ 'node:timers/promises': { setTimeout: async () => {} } })
  ('server/modules/feishu-tools/feishu-file-delivery.ts');
const attempts = new Map();
const immutable = new Map();
const transient = (status) => Object.assign(new Error('private upstream detail'),
  { failureReason: 'http', upstreamStatus: status });
const recoveredLink = await recovered.publishFile({ ...store, async put(model, key, payload, expiresAt) {
  const identity = `${model}:${key}`;
  const serialized = JSON.stringify({ payload, expiresAt });
  if (immutable.has(identity)) assert.equal(serialized, immutable.get(identity), 'retry preserves key/payload/absolute expiry');
  immutable.set(identity, serialized);
  const attempt = (attempts.get(identity) ?? 0) + 1;
  attempts.set(identity, attempt);
  // Includes a lost acknowledgement: the same immutable file record may already be written.
  await store.put(model, key, payload, expiresAt);
  if (attempt === 1) throw transient(model === 'FeishuFile' ? 503 : 429);
} }, principal, file);
assert.ok([...attempts.values()].every((attempt) => attempt === 2));
let reads = 0;
const recoveredTicket = new URL(recoveredLink.downloadUrl).searchParams.get('ticket');
assert.deepEqual((await recovered.retrieveFile({ ...store, async get(model, key) {
  if (model === 'FeishuFile' && ++reads === 1) throw transient(429);
  return store.get(model, key);
} }, recoveredTicket)).bytes, bytes);
assert.equal(reads, 2);
for (const status of [400, 401, 403]) {
  let puts = 0;
  await assert.rejects(recovered.publishFile({ ...store, async put() { puts++; throw transient(status); } },
    principal, { ...file, byteLength: 1, dataBase64: 'eA==' }), /file_delivery_unavailable/);
  assert.equal(puts, 1, 'permanent HTTP failure is not retried');
}
let cappedAttempts = 0;
await assert.rejects(recovered.publishFile({ ...store, async put() { cappedAttempts++; throw transient(503); } },
  principal, { ...file, byteLength: 1, dataBase64: 'eA==' }), /file_delivery_unavailable/);
assert.equal(cappedAttempts, 3, 'bounded retries only');

// The deployed relay batches eight individually encrypted chunks per HTTP request.
const batchWaits = [];
const batched = loader({ 'node:timers/promises': { setTimeout: async (ms) => { batchWaits.push(ms); } } })
  ('server/modules/feishu-tools/feishu-file-delivery.ts');
let putBatches = 0;
let getBatches = 0;
const batchStore = { ...store,
  async putFileChunks(entries) {
    putBatches++;
    assert(entries.length >= 1 && entries.length <= 8);
    for (const entry of entries) await store.put('FeishuFileChunk', entry.key, entry.payload, entry.expiresAt);
  },
  async getFileChunks(keys) {
    getBatches++;
    assert(keys.length >= 1 && keys.length <= 8);
    return Promise.all(keys.map((key) => store.get('FeishuFileChunk', key)));
  },
  async put(model, ...args) { assert.notEqual(model, 'FeishuFileChunk'); await store.put(model, ...args); },
  async get(model, ...args) { assert.notEqual(model, 'FeishuFileChunk'); return store.get(model, ...args); },
};
const batchLink = await batched.publishFile(batchStore, principal, largeFile);
const batchTicket = new URL(batchLink.downloadUrl).searchParams.get('ticket');
assert.deepEqual((await batched.retrieveFile(batchStore, batchTicket)).bytes, largeBytes);
assert.equal(putBatches, 39, '308 chunks use only 39 batch HTTP writes');
assert.equal(getBatches, 39, '308 chunks use only 39 batch HTTP reads');
assert(batchWaits.some((ms) => ms >= 250), 'file batches reserve paced request slots');
await assert.rejects(batched.retrieveFile({ ...batchStore, async getFileChunks() { return []; } }, batchTicket),
  /file_delivery_invalid/, 'incomplete batch cannot release file bytes');
let batchAttempts = 0;
let originalBatch;
await batched.publishFile({ ...batchStore, async putFileChunks(entries) {
  if (originalBatch) assert.deepEqual(entries, originalBatch, 'batch retry is identical');
  else originalBatch = structuredClone(entries);
  await batchStore.putFileChunks(entries);
  if (++batchAttempts === 1) throw transient(429);
} }, principal, file);
assert.equal(batchAttempts, 2);
let revokeBatch;
const revokingDownload = batched.retrieveFile({ ...batchStore, async getFileChunks(keys) {
  const rows = await batchStore.getFileChunks(keys);
  if (!revokeBatch) await new Promise((resolve) => { revokeBatch = resolve; });
  return rows;
} }, batchTicket);
while (!revokeBatch) await new Promise((resolve) => setImmediate(resolve));
map.set(authorizationKeys[0], { ...map.get(authorizationKeys[0]), revoked: true });
revokeBatch();
assert.equal(await revokingDownload, undefined, 'revocation during batch reads remains effective');
for (const [key, value] of authorizationSnapshot) map.set(key, structuredClone(value));

for (const address of ['0.0.0.0', '127.0.0.1', '10.2.3.4', '172.16.0.1', '192.168.1.1',
  '169.254.169.254', '100.64.1.2', '198.18.0.2', '192.0.2.1', '203.0.113.1', '::1',
  '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1', '2002:7f00:1::']) assert.equal(publicAddress(address), false, address);
assert.equal(publicAddress('8.8.8.8'), true);
assert.equal(publicAddress('2606:4700:4700::1111'), true);
for (const url of ['http://example.com/file', 'https://127.0.0.1/file', 'https://a:b@example.com/file',
  'https://example.com:123/file', 'https://test.local/file']) assert.throws(() => inputUrl(url));
assert.equal(inputUrl('https://files.example.com/file?signature=synthetic').protocol, 'https:');
assert(hostFileSchema.safeParse({ download_url: 'https://files.example.com/file', file_id: 'file_synthetic' }).success);

// Exercise the actual downloader with Node stream/request-shaped doubles; no real network or credentials.
function httpFixture(steps, answers = [{ address: '8.8.8.8', family: 4 }], fastTimers = false) {
  const requests = []; const resolutions = []; const pinned = []; const destroyed = [];
  const module = loader({
    'node:dns/promises': { lookup: async (hostname) => {
      resolutions.push(hostname);
      if (typeof answers === 'function') return answers(hostname, resolutions.length);
      return answers;
    } },
    'node:https': { request: (url, options, callback) => {
      const index = requests.length;
      requests.push({ url: String(url), options });
      assert.equal(options.agent, false);
      assert.equal(options.rejectUnauthorized, undefined, 'TLS validation remains enabled');
      assert.deepEqual(options.headers, { Accept: '*/*', 'Accept-Encoding': 'identity' });
      const req = new EventEmitter();
      req.destroy = () => { destroyed.push(index); queueMicrotask(() => req.emit('close')); };
      req.end = () => queueMicrotask(() => {
        options.lookup(url.hostname, {}, (error, address, family) => {
          assert.equal(error, null); pinned.push({ address, family });
        });
        // Even if the transport asks again, it must use the already checked address.
        options.lookup(url.hostname, {}, (error, address) => { assert.equal(error, null); assert.equal(address, pinned.at(-1).address); });
        const step = steps[index] ?? {};
        if (step.error) { req.emit('error', new Error('synthetic upstream private detail')); return; }
        if (step.noResponse) { req.emit('close'); return; }
        if (step.hang) return;
        const response = new PassThrough();
        response.statusCode = step.status ?? 200;
        response.headers = step.headers ?? {};
        response.complete = step.complete ?? true;
        callback(response);
        if (response.destroyed) return;
        if (step.aborted) { response.emit('aborted'); return; }
        if (step.closed) { response.emit('close'); return; }
        if (step.bodyError) { response.emit('error', new Error('private response detail')); return; }
        for (const chunk of step.chunks ?? [Buffer.from('synthetic file')]) {
          if (!response.destroyed) response.write(chunk);
        }
        if (!response.destroyed) response.end();
      });
      return req;
    } },
  }, fastTimers ? (fn, delay) => setTimeout(fn, Math.min(delay, 20)) : setTimeout)
    ('server/modules/feishu-tools/feishu-file-input.ts');
  return { ...module, requests, resolutions, pinned, destroyed };
}
const hostFile = { download_url: 'https://files.example.com/file?signature=synthetic', file_id: 'synthetic-file',
  file_name: 'attachment.txt', mime_type: 'text/plain' };
const httpOk = httpFixture([{}], (_host, call) => call === 1
  ? [{ address: '8.8.8.8', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]);
assert.deepEqual(await httpOk.materializeHostFiles([hostFile]), [{ name: 'attachment.txt',
  base64: Buffer.from('synthetic file').toString('base64'), mimeType: 'text/plain' }]);
assert.equal(httpOk.resolutions.length, 1, 'transport cannot re-resolve into a private address');
assert.equal(httpOk.pinned[0].address, '8.8.8.8');
for (const addresses of [[], [{ address: '127.0.0.1', family: 4 }],
  [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]]) {
  const test = httpFixture([], addresses);
  await assert.rejects(test.materializeHostFiles([hostFile]), /file_input_url_invalid/);
  assert.equal(test.requests.length, 0);
}
const ipv6 = httpFixture([{}], [{ address: '2606:4700:4700::1111', family: 6 }]);
await ipv6.materializeHostFiles([hostFile]); assert.equal(ipv6.requests[0].options.family, 6);
const redirected = httpFixture([{ status: 302, headers: { location: '/new-file' } }, {}]);
await redirected.materializeHostFiles([hostFile]);
assert.deepEqual(redirected.resolutions, ['files.example.com', 'files.example.com']);
assert.equal(redirected.requests[1].url, 'https://files.example.com/new-file');
assert.ok(redirected.destroyed.includes(0), 'old redirect body is closed, not drained');
const rebound = httpFixture([{ status: 302, headers: { location: '/new-file' } }], (_host, count) =>
  [{ address: count === 1 ? '8.8.8.8' : '10.0.0.1', family: 4 }]);
await assert.rejects(rebound.materializeHostFiles([hostFile]), /file_input_url_invalid/);
assert.equal(rebound.requests.length, 1, 'redirect DNS is checked again before opening a socket');
for (const location of ['http://files.example.com/file', 'https://127.0.0.1/file',
  'https://user:password@example.com/file', 'file:///private']) {
  const test = httpFixture([{ status: 302, headers: { location } }]);
  await assert.rejects(test.materializeHostFiles([hostFile]), /file_input_url_invalid/);
  assert.equal(test.requests.length, 1);
}
const loop = httpFixture(Array.from({ length: 4 }, () => ({ status: 302, headers: { location: '/again' } })));
await assert.rejects(loop.materializeHostFiles([hostFile]), /file_input_url_invalid/);
assert.equal(loop.requests.length, 4, 'at most three redirects');
for (const step of [{ noResponse: true }, { error: true }, { status: 403 }, { complete: false },
  { headers: { 'content-length': '99999999' } }, { headers: { 'content-length': '-1' } },
  { headers: { 'content-length': 'abc' } }, { headers: { 'content-length': '1' } },
  { headers: { 'content-encoding': 'gzip' } }, { aborted: true }, { closed: true }, { bodyError: true }]) {
  const test = httpFixture([step]);
  await assert.rejects(test.materializeHostFiles([hostFile]), /file_input_unavailable/);
}
const oversized = httpFixture([{ chunks: [Buffer.alloc(10 * 1024 * 1024), Buffer.from('x')] }]);
await assert.rejects(oversized.materializeHostFiles([hostFile]), /file_input_limit/);
assert.ok(oversized.destroyed.length);
const timedOut = httpFixture([{ hang: true }], undefined, true);
await assert.rejects(timedOut.materializeHostFiles([hostFile]), /file_input_timeout/);
assert.ok(timedOut.destroyed.length);
const dnsTimeout = httpFixture([], () => new Promise(() => {}), true);
await assert.rejects(dnsTimeout.materializeHostFiles([hostFile]), /file_input_timeout/);
assert.equal(dnsTimeout.requests.length, 0);
const dnsError = httpFixture([], async () => { throw new Error('private DNS detail'); });
await assert.rejects(dnsError.materializeHostFiles([hostFile]), (error) => error.message === 'file_input_unavailable');
const invalidBatch = httpFixture([]);
await assert.rejects(invalidBatch.materializeHostFiles([hostFile, { ...hostFile, file_name: '../escape' }]));
await assert.rejects(invalidBatch.materializeHostFiles([hostFile, { ...hostFile, file_name: 'ATTACHMENT.txt' }]));
await assert.rejects(invalidBatch.materializeHostFiles([{ ...hostFile, unknown: 'field' }]));
assert.equal(invalidBatch.requests.length, 0, 'entire file manifest is validated before any network access');
const totalLimit = httpFixture([0, 1, 2].map(() => ({ chunks: [Buffer.alloc(7 * 1024 * 1024)] })));
await assert.rejects(totalLimit.materializeHostFiles([0, 1, 2].map((index) =>
  ({ ...hostFile, file_name: `attachment-${index}.bin` }))), /file_input_limit/);
console.log(JSON.stringify({ ok: true, checks: 'binary round-trip, expiry, account/grant/consent binding and async mid-download revocation, expiry during final authorization read, chunk grant isolation, manifest-last, tamper, partial writes; real downloader with HTTPS/DNS doubles: pinning, rebinding, redirects, private addresses, missing/aborted responses, byte limits, DNS/HTTP deadlines, strict whole-batch file input', network: false }));
