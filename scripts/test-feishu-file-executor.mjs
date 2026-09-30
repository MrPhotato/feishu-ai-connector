import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// Real executor, catalog, attachment adapter, delivery and MCP serialization. Only
// account/storage and the CLI runner are synthetic. No credentials or sockets.
const forbidden = () => { throw new Error('Network and process execution forbidden in this test.'); };
globalThis.fetch = forbidden;
process.env.CONNECTOR_PUBLIC_URL = 'https://connector.example.test';
delete process.env.CONNECTOR_DEPLOYMENT_CONFIG;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dependency = createRequire(import.meta.url);
const cache = new Map();
const stubs = {
  'node:https': { request: forbidden }, 'node:dns/promises': { lookup: forbidden },
  'node:child_process': { spawn: forbidden },
};
function load(file) {
  const absolute = path.resolve(root, file);
  if (cache.has(absolute)) return cache.get(absolute).exports;
  const module = { exports: {} };
  cache.set(absolute, module);
  const code = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  new Function('require', 'module', 'exports', '__dirname', code)((name) => stubs[name] ?? (name.startsWith('.')
    ? load(path.resolve(path.dirname(absolute), `${name}.ts`)) : dependency(name)),
  module, module.exports, path.dirname(absolute));
  return module.exports;
}
const { FeishuToolExecutor } = load('server/modules/feishu-tools/feishu-tools.executor.ts');
const { createFeishuMcpServer } = load('server/modules/feishu-tools/feishu-tools.mcp.ts');
const { retrieveFile } = load('server/modules/feishu-tools/feishu-file-delivery.ts');
const { validateStorageJson } = load('server/modules/connector-auth-storage/connector-auth-storage.contract.ts');
const principal = { accountId: 'synthetic-tenant:synthetic-user', grantId: 'synthetic-grant',
  clientId: 'synthetic-chatgpt-client', scopes: ['feishu.read'] };
const expires = Math.floor(Date.now() / 1000) + 3600;
const resource = `${process.env.CONNECTOR_PUBLIC_URL}/mcp`;
const bytes = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(80_000, 37)]);
const binaryFile = { name: 'attachment.bin', mimeType: 'application/octet-stream',
  byteLength: bytes.length, dataBase64: bytes.toString('base64') };
const attachment = { task: 'download_attachment', arguments: {
  source: 'drive', fileToken: 'synthetic-file-token', fileName: 'synthetic-report.pdf',
} };
const generic = { task: 'native_read', arguments: { operation: 'drive.+download',
  arguments: { flags: { 'file-token': 'synthetic-file-token', output: 'output/attachment.bin' } } } };
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
function fixture() {
  const map = new Map([
    [`FeishuAccount:${principal.accountId}`, { tenant_key: 'synthetic-tenant', open_id: 'synthetic-user',
      access_token: 'synthetic-access-value', refresh_token: 'synthetic-refresh-value',
      access_expires_at: expires, refresh_expires_at: expires, scope: 'drive:file:download' }],
    [`Grant:${principal.grantId}`, { accountId: principal.accountId, clientId: principal.clientId,
      exp: expires, resources: { [resource]: 'feishu.read' } }],
    [`Consent:${principal.grantId}`, { accountId: principal.accountId, clientId: principal.clientId,
      grantId: principal.grantId, resource, scopes: ['feishu.read'], expiresAt: expires }],
  ]);
  const calls = []; const puts = [];
  let reply = async () => ({ exitCode: 0, output: { ok: true, data: { size_bytes: bytes.length } }, files: [binaryFile] });
  const store = {
    async get(model, key) { return structuredClone(map.get(`${model}:${key}`)); },
    async put(model, key, payload, expiresAt) {
      validateStorageJson({ operation: 'put', model, key, payload, expiresAt });
      puts.push({ model, key, payload: structuredClone(payload), expiresAt });
      map.set(`${model}:${key}`, structuredClone(payload));
    },
    async acquireLease() { throw new Error('Read-only test must not acquire a write/refresh lease.'); },
    async releaseLease() { throw new Error('Read-only test must not release a write/refresh lease.'); },
  };
  const executor = new FeishuToolExecutor(store, forbidden,
    () => ({ clientId: 'synthetic-app-id', clientSecret: 'synthetic-secret-never-used' }), undefined,
    async (argv, credentials, options) => { calls.push(structuredClone({ argv, credentials, options })); return reply(); });
  return { map, calls, puts, store, executor, set reply(value) { reply = value; } };
}
function verifyLink(result, test) {
  check(result.ok === true && result.data.files.length === 1, 'one successful file link returned');
  const link = result.data.files[0];
  const ticket = new URL(link.downloadUrl).searchParams.get('ticket');
  check(/^[A-Za-z0-9_-]{43}$/u.test(ticket), 'unguessable ticket shape');
  check(link.byteLength === bytes.length, 'original length retained');
  check(Date.parse(link.expiresAt) <= Date.now() + 900_000 && Date.parse(link.expiresAt) > Date.now() + 890_000,
    'download capability expires within fifteen minutes');
  const serialized = JSON.stringify(result);
  check(!serialized.includes('dataBase64') && !serialized.includes(binaryFile.dataBase64) &&
    !serialized.includes('synthetic-access-value') && !serialized.includes('synthetic-refresh-value'),
  'tool result has no binary base64 or tokens');
  const manifest = test.map.get(`FeishuFile:${ticket}`);
  check(manifest.accountId === principal.accountId && manifest.grantId === principal.grantId &&
    manifest.clientId === principal.clientId && JSON.stringify(manifest.scopes) === '["feishu.read"]',
  'manifest bound to verified account, grant, client and resource scope');
  check(test.puts.at(-1).model === 'FeishuFile' && test.puts.slice(0, -1).every((row) =>
    row.model === 'FeishuFileChunk' && row.payload.accountId === principal.accountId &&
    row.payload.grantId === principal.grantId), 'grant-bound chunks precede manifest publication');
  return { link, ticket, manifest };
}

const direct = fixture();
const result = await direct.executor.executeNative(principal, attachment);
const { link, ticket } = verifyLink(result, direct);
check(link.name === 'synthetic-report.pdf' && link.mimeType === 'application/pdf', 'attachment naming and MIME are preserved');
check(direct.calls.length === 1 && direct.calls[0].options.collectFiles === true &&
  direct.calls[0].argv.includes('output/attachment.bin'), 'actual attachment plan requests isolated output collection');
assert.deepEqual((await retrieveFile(direct.store, ticket)).bytes, bytes); checks++;

// Each retrieval reads current account/grant/consent state, even for an already issued link.
const modifications = [
  ['FeishuAccount', principal.accountId, (value) => ({ ...value, revoked: true })],
  ['FeishuAccount', principal.accountId, (value) => ({ ...value, open_id: 'another-user' })],
  ['Grant', principal.grantId, () => undefined],
  ['Grant', principal.grantId, (value) => ({ ...value, accountId: 'another:account' })],
  ['Grant', principal.grantId, (value) => ({ ...value, clientId: 'another-client' })],
  ['Grant', principal.grantId, (value) => ({ ...value, exp: 1 })],
  ['Grant', principal.grantId, (value) => ({ ...value, resources: { [resource]: 'feishu.write' } })],
  ['Consent', principal.grantId, () => undefined],
  ['Consent', principal.grantId, (value) => ({ ...value, clientId: 'another-client' })],
  ['Consent', principal.grantId, (value) => ({ ...value, scopes: ['feishu.write'] })],
  ['Consent', principal.grantId, (value) => ({ ...value, resource: 'https://other.example.test/mcp' })],
  ['FeishuFile', ticket, (value) => ({ ...value, expiresAt: 1 })],
];
for (const [model, key, change] of modifications) {
  const address = `${model}:${key}`; const previous = direct.map.get(address);
  direct.map.set(address, change(structuredClone(previous)));
  check(await retrieveFile(direct.store, ticket) === undefined, `changed ${model} authorization invalidates prior link`);
  direct.map.set(address, previous);
}
assert.deepEqual((await retrieveFile(direct.store, ticket)).bytes, bytes); checks++;

const native = fixture();
const nativeResult = await native.executor.executeNative(principal, generic);
const nativeLink = verifyLink(nativeResult, native);
check(native.calls[0].argv.includes('--output=output/attachment.bin') && native.calls[0].options.collectFiles === true &&
  native.calls[0].options.allowTextOutput === true, 'full native catalog plan also collects outputs');
assert.deepEqual((await retrieveFile(native.store, nativeLink.ticket)).bytes, bytes); checks++;

for (const request of [attachment, generic]) {
  for (const makeReply of [
    async () => { throw new Error('synthetic runner failure'); },
    async () => ({ exitCode: 1, output: { ok: false, error: { code: 'synthetic' } }, files: [binaryFile] }),
    async () => ({ exitCode: 0, output: { ok: false, error: { code: 'synthetic' } }, files: [binaryFile] }),
  ]) {
    const failed = fixture(); failed.reply = makeReply;
    check(!(await failed.executor.executeNative(principal, request)).ok && failed.puts.length === 0,
      'failed CLI must never publish supplied file artifacts');
  }
  const unscoped = fixture();
  check(!(await unscoped.executor.executeNative({ ...principal, scopes: ['feishu.write'] }, request)).ok &&
    unscoped.calls.length === 0 && unscoped.puts.length === 0, 'missing connector read scope stops runner and publication');
  const revoked = fixture();
  revoked.map.get(`FeishuAccount:${principal.accountId}`).revoked = true;
  check(!(await revoked.executor.executeNative(principal, request)).ok && revoked.calls.length === 0 && revoked.puts.length === 0,
    'revoked account stops runner and publication');
}
const missingScope = fixture();
missingScope.map.get(`FeishuAccount:${principal.accountId}`).scope = '';
check((await missingScope.executor.executeNative(principal, attachment)).error.code === 'feishu_scope_missing' &&
  missingScope.calls.length === 0 && missingScope.puts.length === 0, 'known attachment upstream scope enforced before CLI');

// Verify the complete public MCP response too, rather than inspecting the executor only.
const protocol = fixture();
const server = createFeishuMcpServer(protocol.executor, principal, undefined,
  (actor, request) => protocol.executor.executeNative(actor, request));
const client = new Client({ name: 'synthetic-file-executor-test', version: '1.0.0' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport); await client.connect(clientTransport);
try {
  for (const request of [attachment, generic]) {
    const response = await client.callTool({ name: `feishu_${request.task}`, arguments: request.arguments });
    check(response.isError === false && response.structuredContent.ok === true, 'real MCP call succeeds');
    const file = response.structuredContent.data.files[0];
    check(response.content.some((content) => content.type === 'resource_link' && content.uri === file.downloadUrl),
      'MCP includes a resource_link to the same published file');
    check(!JSON.stringify(response).includes('dataBase64') && !JSON.stringify(response).includes(binaryFile.dataBase64),
      'neither MCP structured output nor content duplicates binary base64');
    assert.deepEqual((await retrieveFile(protocol.store, new URL(file.downloadUrl).searchParams.get('ticket'))).bytes, bytes);
    checks++;
  }
} finally { await client.close(); await server.close(); }
console.log(JSON.stringify({ ok: true, checks, network: false, realCliCalls: false,
  coverage: 'actual attachment/native executor -> grant-bound manifest-last delivery -> revoke-aware retrieval -> MCP resource_link without base64' }));
