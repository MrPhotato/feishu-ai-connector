import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// This probe uses synthetic in-memory credentials and an injected transport only.
// It never loads .env, starts OAuth, opens a socket, or sends a Feishu request.
const requireDependency = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modules = new Map();
const moduleStubs = new Map();
function loadTs(file) {
  const absolute = path.resolve(file);
  if (modules.has(absolute)) return modules.get(absolute).exports;
  const loaded = { exports: {} };
  modules.set(absolute, loaded);
  const compiled = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      esModuleInterop: true, experimentalDecorators: true },
    fileName: absolute,
  }).outputText;
  const localRequire = (specifier) => moduleStubs.has(specifier) ? moduleStubs.get(specifier) : specifier.startsWith('.')
    ? loadTs(path.resolve(path.dirname(absolute), `${specifier}.ts`)) : requireDependency(specifier);
  new Function('require', 'module', 'exports', compiled)(localRequire, loaded, loaded.exports);
  return loaded.exports;
}
const directory = path.join(root, 'server/modules/feishu-tools');
const { FEISHU_OPERATIONS, FeishuToolExecutor } = loadTs(path.join(directory, 'feishu-tools.executor.ts'));
const { authenticateBearer, createFeishuMcpServer } = loadTs(path.join(directory, 'feishu-tools.mcp.ts'));
const allScopes = [...new Set(FEISHU_OPERATIONS.flatMap((entry) => entry.scopeGroups.flat()))].join(' ');
const accountId = 'test-tenant:test-user';
const principal = { accountId, scopes: ['feishu.read', 'feishu.write'] };
const intent = '用户明确要求在本次操作中修改指定的测试资源。';
const currentTime = () => Math.floor(Date.now() / 1000);
function account(extra = {}) {
  return {
    tenant_key: 'test-tenant', open_id: 'test-user', access_token: 'synthetic-access-token',
    refresh_token: 'synthetic-refresh-token', access_expires_at: currentTime() + 3600,
    refresh_expires_at: currentTime() + 86400, scope: allScopes, revoked: false, ...extra,
  };
}
function fixture(initial = account(), customTransport) {
  let saved = structuredClone(initial);
  let leaseHeld = false;
  const requests = [];
  const writes = [];
  const store = {
    async get(model, key) { assert.equal(model, 'FeishuAccount'); assert.equal(key, accountId); return structuredClone(saved); },
    async put(model, key, value) {
      assert.equal(model, 'FeishuAccount'); assert.equal(key, accountId);
      writes.push(structuredClone(value)); saved = structuredClone(value);
    },
    async acquireLease(key, ttl) {
      assert.equal(key, `feishu-refresh:${accountId}`); assert.equal(ttl, 90);
      if (leaseHeld) return undefined; leaseHeld = true; return 'synthetic-lease-owner';
    },
    async releaseLease(key, owner) {
      assert.equal(key, `feishu-refresh:${accountId}`); assert.equal(owner, 'synthetic-lease-owner'); leaseHeld = false;
    },
  };
  const transport = async (request) => {
    requests.push(structuredClone(request));
    return customTransport ? customTransport(request) : { status: 200, body: { code: 0, data: { accepted: true } } };
  };
  const executor = new FeishuToolExecutor(store, transport,
    () => ({ clientId: 'test-app', clientSecret: 'synthetic-client-secret' }));
  return { executor, requests, writes, saved: () => saved };
}

const fixtures = {
  'im.messages.search': { query: 'test', pageSize: 3, pageToken: 'cursor-test' },
  'im.messages.history': { chatId: 'oc_test' },
  'im.messages.send_text': { receiveIdType: 'chat_id', receiveId: 'oc_test', text: 'test', idempotencyKey: 'test-send' },
  'im.messages.reply_text': { messageId: 'om_test', text: 'test', idempotencyKey: 'test-reply' },
  'docx.documents.read_text': { documentId: 'doc_test' },
  'docx.blocks.list': { documentId: 'doc_test' },
  'docx.documents.create': { title: 'test' },
  'docx.blocks.append_paragraphs': { documentId: 'doc_test', parentBlockId: 'block_test', paragraphs: ['test'] },
  'docx.blocks.replace_text': { documentId: 'doc_test', blockId: 'block_test', text: 'test', revisionId: 12 },
  'drive.files.list': { folderToken: 'folder_test' },
  'drive.folders.create': { name: 'test', folderToken: 'folder_test' },
  'wiki.nodes.get': { token: 'wiki_test' },
  'calendar.events.list': { calendarId: 'cal_test@group.calendar.feishu.cn', startTime: '1700000000', endTime: '1700003600' },
  'calendar.events.get': { calendarId: 'cal_test', eventId: 'event_test' },
  'calendar.events.create': { calendarId: 'cal_test', summary: 'test', startTime: '1700000000', endTime: '1700003600' },
  'calendar.events.update': { calendarId: 'cal_test', eventId: 'event_test', summary: 'test', notifyAttendees: false },
  'calendar.events.delete': { calendarId: 'cal_test', eventId: 'event_test', notifyAttendees: false },
  'task.tasks.list': {}, 'task.tasks.get': { taskGuid: 'task_test' },
  'task.tasks.create': { summary: 'test', idempotencyKey: 'test-task' },
  'task.tasks.update': { taskGuid: 'task_test', completedAt: '0' }, 'task.tasks.delete': { taskGuid: 'task_test' },
  'sheets.values.read': { spreadsheetToken: 'sheet_test', range: 'tab_test!A1:B2' },
  'sheets.values.write': { spreadsheetToken: 'sheet_test', range: 'tab_test!A1:B2', values: [['a', 1], ['b', 2]] },
  'base.records.list': { appToken: 'base_test', tableId: 'table_test' },
  'base.records.get': { appToken: 'base_test', tableId: 'table_test', recordId: 'record_test' },
  'base.records.create': { appToken: 'base_test', tableId: 'table_test', fields: { Title: 'test' } },
  'base.records.update': { appToken: 'base_test', tableId: 'table_test', recordId: 'record_test', fields: { Title: 'test' } },
  'base.records.delete': { appToken: 'base_test', tableId: 'table_test', recordId: 'record_test' },
  'calendar.calendars.list': {}, 'calendar.calendars.primary': {},
  'contact.users.search': { query: 'test name' }, 'drive.documents.search': { query: 'test document' },
  'base.tables.list': { appToken: 'base_test' }, 'base.fields.list': { appToken: 'base_test', tableId: 'table_test' },
  'sheets.sheets.list': { spreadsheetToken: 'sheet_test' },
};
assert.equal(FEISHU_OPERATIONS.length, 36);
assert.equal(new Set(FEISHU_OPERATIONS.map((entry) => entry.id)).size, 36);
const proposedPermissions = JSON.parse(fs.readFileSync(path.join(root, 'docs/read-write-permissions.json'), 'utf8'));
assert.deepEqual(proposedPermissions.scopes.tenant, []);
assert.equal(proposedPermissions.scopes.user.length, 24);
for (const entry of FEISHU_OPERATIONS) {
  assert.ok(entry.scopeGroups.every((group) => group.some((scope) => proposedPermissions.scopes.user.includes(scope))),
    `Permission proposal must cover ${entry.id}`);
}
for (const entry of FEISHU_OPERATIONS) {
  const test = fixture();
  const result = await test.executor.execute(principal, entry.mode, entry.id, fixtures[entry.id], intent);
  assert.equal(result.ok, true, entry.id);
  assert.equal(test.requests.length, 1);
  const url = new URL(test.requests[0].url);
  assert.equal(url.origin, 'https://open.feishu.cn');
  assert.ok(url.pathname.startsWith('/open-apis/'));
  assert.equal(url.username, ''); assert.equal(url.search, '');
  const readPosts = ['im.messages.search', 'calendar.calendars.primary', 'contact.users.search', 'drive.documents.search'];
  if (entry.mode === 'read' && !readPosts.includes(entry.id)) assert.equal(test.requests[0].method, 'GET');
}

const safe = fixture();
assert.equal((await safe.executor.execute(principal, 'read', 'im.messages.send_text', fixtures['im.messages.send_text'], intent)).ok, false);
assert.equal((await safe.executor.execute(principal, 'write', 'im.messages.send_text', fixtures['im.messages.send_text'])).error.code, 'user_intent_required');
assert.equal((await safe.executor.execute({ ...principal, scopes: ['feishu.read'] }, 'write', 'task.tasks.delete', { taskGuid: 'task_test' }, intent)).error.code, 'connector_scope_missing');
assert.equal((await safe.executor.execute(principal, 'read', 'raw.request', { url: 'https://example.com' })).ok, false);
for (const bad of [
  { chatId: '../secret' }, { chatId: '%2Fsecret' }, { chatId: '..' },
  { chatId: 'oc_test', pageSize: 51 }, { chatId: 'oc_test', pageSize: 0 },
  { chatId: 'oc_test', pageToken: 'x'.repeat(4097) }, { chatId: 'oc_test', method: 'DELETE' },
]) assert.equal((await safe.executor.execute(principal, 'read', 'im.messages.history', bad)).error.code, 'invalid_arguments');
assert.equal((await safe.executor.execute(principal, 'read', 'sheets.values.read', { spreadsheetToken: 'sheet', range: 'tab!A1:Z1000' })).ok, false);
assert.equal((await safe.executor.execute(principal, 'write', 'sheets.values.write', { spreadsheetToken: 'sheet', range: 'tab!A1', values: [[1, 2]] }, intent)).ok, false);
assert.equal(safe.requests.length, 0);

const insufficient = fixture(account({ scope: 'search:message' }));
const missing = await insufficient.executor.execute(principal, 'read', 'docx.documents.read_text', { documentId: 'doc' });
assert.equal(missing.error.code, 'feishu_scope_missing');
assert.ok(missing.error.scopeGroups[0].includes('docx:document:readonly'));
assert.equal(insufficient.requests.length, 0);
for (const invalid of [account({ revoked: true }), account({ open_id: 'other-user' }),
  account({ access_expires_at: currentTime() - 1, refresh_token: undefined })]) {
  const test = fixture(invalid);
  assert.equal((await test.executor.execute(principal, 'read', 'task.tasks.get', { taskGuid: 'task' })).ok, false);
  assert.equal(test.requests.length, 0);
}

const redaction = fixture(account(), async () => ({ status: 200, body: { code: 0, data: {
  access_token: 'synthetic-access-token', nested: { refresh_token: 'synthetic-refresh-token' },
  echo: 'before synthetic-access-token after', page_token: 'legitimate-page-cursor',
} } }));
const redacted = await redaction.executor.execute(principal, 'read', 'task.tasks.get', { taskGuid: 'task' });
assert.ok(!JSON.stringify(redacted).includes('synthetic-access-token'));
assert.ok(!JSON.stringify(redacted).includes('synthetic-refresh-token'));
assert.equal(redacted.data.page_token, 'legitimate-page-cursor');
const upstreamError = fixture(account(), async () => { throw new Error('secret request config synthetic-access-token'); });
assert.ok(!JSON.stringify(await upstreamError.executor.execute(principal, 'read', 'task.tasks.get', { taskGuid: 'task' })).includes('synthetic-access-token'));

let releaseRefresh;
let notifyStarted;
const started = new Promise((resolve) => { notifyStarted = resolve; });
const paused = new Promise((resolve) => { releaseRefresh = resolve; });
let refreshCalls = 0;
const refreshing = fixture(account({ access_expires_at: currentTime() + 10 }), async (request) => {
  if (request.url === 'https://accounts.feishu.cn/oauth/v3/token') {
    refreshCalls += 1; assert.equal(request.body.grant_type, 'refresh_token');
    assert.equal(request.body.client_id, 'test-app'); notifyStarted(); await paused;
    return { status: 200, body: { code: 0, access_token: 'synthetic-new-access', refresh_token: 'synthetic-new-refresh',
      expires_in: 7200, refresh_token_expires_in: 86400, scope: allScopes } };
  }
  assert.equal(request.headers.Authorization, 'Bearer synthetic-new-access');
  return { status: 200, body: { code: 0, data: {} } };
});
const first = refreshing.executor.execute(principal, 'read', 'task.tasks.get', { taskGuid: 'task' });
await started;
const second = await refreshing.executor.execute(principal, 'read', 'task.tasks.get', { taskGuid: 'task' });
assert.equal(second.error.code, 'refresh_in_progress');
releaseRefresh(); assert.equal((await first).ok, true); assert.equal(refreshCalls, 1);
assert.equal(refreshing.writes[0].refresh_pending, true);
assert.equal(refreshing.saved().refresh_pending, false);
assert.equal(refreshing.saved().refresh_token, 'synthetic-new-refresh');
await refreshing.executor.execute(principal, 'read', 'task.tasks.get', { taskGuid: 'task' });
assert.equal(refreshCalls, 1);

let failedRefreshCalls = 0;
const uncertain = fixture(account({ access_expires_at: currentTime() + 10 }), async () => {
  failedRefreshCalls += 1; throw new Error('simulated uncertain network result');
});
assert.equal((await uncertain.executor.execute(principal, 'read', 'task.tasks.get', { taskGuid: 'task' })).ok, false);
assert.equal((await uncertain.executor.execute(principal, 'read', 'task.tasks.get', { taskGuid: 'task' })).error.code, 'refresh_uncertain');
assert.equal(failedRefreshCalls, 1);

let verifies = 0;
const verifier = async (token) => { verifies += 1; assert.equal(token, 'synthetic-jwt'); return principal; };
await assert.rejects(authenticateBearer(undefined, verifier));
await assert.rejects(authenticateBearer('Bearer a b', verifier));
await authenticateBearer('Bearer synthetic-jwt', verifier);
await authenticateBearer('Bearer synthetic-jwt', verifier);
assert.equal(verifies, 2);
await assert.rejects(authenticateBearer('Bearer invalid', async () => { throw new Error('invalid JWT'); }));

moduleStubs.set('../connector-auth/connector-auth.service', { ConnectorAuthService: class {} });
moduleStubs.set('./feishu-tools.service', { FeishuToolsService: class {} });
const { FeishuToolsController } = loadTs(path.join(directory, 'feishu-tools.controller.ts'));
const { connectorPrivacyMiddleware } = loadTs(path.join(directory, '../connector-privacy/connector-privacy.middleware.ts'));
const base = 'https://example.com/app/test';
const auth = { getPublicUrl: () => base,
  verifyMcpAuthorization: async (token) => ({ principal: await verifier(token), account: account() }) };
const controller = new FeishuToolsController(auth, fixture().executor);
function responseFixture() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; return this; },
    json(body) { this.body = body; return this; }, end() { return this; },
  };
}
const metadataResponse = responseFixture();
controller.metadata(metadataResponse);
assert.equal(metadataResponse.body.resource, `${base}/mcp`);
assert.deepEqual(metadataResponse.body.authorization_servers, [`${base}/oidc`]);
assert.deepEqual(metadataResponse.body.scopes_supported, ['feishu.read', 'feishu.write']);
const deniedResponse = responseFixture();
const deniedRequest = { headers: {}, originalUrl: '/mcp', url: '/mcp', body: { privateProbe: true }, query: {} };
connectorPrivacyMiddleware(deniedRequest, deniedResponse, () => {});
await controller.execute(deniedRequest, deniedResponse);
assert.equal(deniedResponse.statusCode, 401);
assert.equal(deniedRequest.body, undefined);
assert.ok(deniedResponse.headers['WWW-Authenticate'].includes(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`));
const unsupportedResponse = responseFixture();
const unsupportedRequest = { headers: { authorization: 'Bearer synthetic-jwt' },
  originalUrl: '/mcp', url: '/mcp', body: undefined, query: {} };
connectorPrivacyMiddleware(unsupportedRequest, unsupportedResponse, () => {});
await controller.unsupported(unsupportedRequest, unsupportedResponse);
assert.equal(unsupportedResponse.statusCode, 405);
assert.equal(unsupportedResponse.headers.Allow, 'POST');

const mcpFixture = fixture();
const server = createFeishuMcpServer(mcpFixture.executor, principal);
const client = new Client({ name: 'synthetic-probe', version: '1.0.0' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport); await client.connect(clientTransport);
try {
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((entry) => entry.name).sort(), ['feishu_catalog', 'feishu_read', 'feishu_write']);
  assert.equal(tools.tools.find((entry) => entry.name === 'feishu_write').annotations.destructiveHint, true);
  assert.equal(tools.tools.find((entry) => entry.name === 'feishu_read').annotations.readOnlyHint, true);
  const catalog = await client.callTool({ name: 'feishu_catalog', arguments: {} });
  assert.equal(catalog.structuredContent.operations.length, 36);
  assert.ok(catalog.structuredContent.operations.every((entry) => entry.inputSchema === undefined));
  for (const entry of catalog.structuredContent.operations) {
    const detail = await client.callTool({ name: 'feishu_catalog', arguments: { operation: entry.id } });
    assert.equal(detail.structuredContent.operations.length, 1);
    assert.equal(detail.structuredContent.operations[0].inputSchema.type, 'object');
  }
  const response = await client.callTool({ name: 'feishu_read', arguments: {
    operation: 'task.tasks.get', arguments: { taskGuid: 'task_test' },
  } });
  assert.equal(response.structuredContent.ok, true);
  const rejected = await client.callTool({ name: 'feishu_read', arguments: {
    operation: 'task.tasks.delete', arguments: { taskGuid: 'task_test' },
  } });
  assert.equal(rejected.isError, true); assert.equal(mcpFixture.requests.length, 1);
} finally { await client.close(); await server.close(); }

process.stdout.write('PASS: 36 registered operations; strict parameters; read/write isolation; scope/account binding; redaction; distributed refresh contract; MCP discovery and execution. No network requests made.\n');
