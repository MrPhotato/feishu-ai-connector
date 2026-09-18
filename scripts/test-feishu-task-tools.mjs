import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// Offline MCP protocol tests: synthetic principals and injected executors only.
// No .env, OAuth, sockets, CLI business calls, or real Feishu/mail operations.
globalThis.fetch = async () => { throw new Error('Network is forbidden in this test.'); };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireDependency = createRequire(import.meta.url);
const cache = new Map();
function loadTs(file) {
  const absolute = path.resolve(file);
  if (cache.has(absolute)) return cache.get(absolute).exports;
  const loaded = { exports: {} };
  cache.set(absolute, loaded);
  const compiled = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: absolute,
  }).outputText;
  const localRequire = (specifier) => specifier.startsWith('.')
    ? loadTs(path.resolve(path.dirname(absolute), `${specifier}.ts`)) : requireDependency(specifier);
  new Function('require', 'module', 'exports', compiled)(localRequire, loaded, loaded.exports);
  return loaded.exports;
}
const moduleRoot = path.join(root, 'server/modules/feishu-tools');
const { createFeishuMcpServer } = loadTs(path.join(moduleRoot, 'feishu-tools.mcp.ts'));
const { FEISHU_OPERATIONS } = loadTs(path.join(moduleRoot, 'feishu-tools.executor.ts'));
const { catalogEntry } = loadTs(path.join(moduleRoot, 'feishu-tools.registry.ts'));
const { FEISHU_TASK_SCHEMAS } = loadTs(path.join(moduleRoot, 'feishu-task-tools.contract.ts'));
const { FEISHU_NATIVE_SCHEMAS } = loadTs(path.join(moduleRoot, 'feishu-task-tools.native.ts'));
const principal = { accountId: 'synthetic-tenant:synthetic-user', scopes: ['feishu.read', 'feishu.write'] };
const userIntent = '用户本次明确要求对指定测试草稿执行该动作。';
const invocations = [];
const nativeInvocations = [];
const legacyInvocations = [];
const legacy = {
  catalog(mode) { return { operations: FEISHU_OPERATIONS.filter((entry) => !mode || mode === entry.mode).map(catalogEntry) }; },
  async execute(actor, mode, operation, args, intent) {
    legacyInvocations.push({ actor, mode, operation, args, intent });
    return { ok: true, data: { operation } };
  },
};
const taskExecutor = async (actor, request) => {
  invocations.push(structuredClone({ actor, request }));
  return { ok: true, data: { acceptedTask: request.task, arguments: request.arguments } };
};
const nativeExecutor = async (actor, request) => {
  nativeInvocations.push(structuredClone({ actor, request }));
  return { ok: true, data: { acceptedTask: request.task } };
};
async function fixture(actor = principal, task = taskExecutor, native = nativeExecutor) {
  const server = createFeishuMcpServer(legacy, actor, task, native);
  const client = new Client({ name: 'offline-task-tools-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { server, client, close: async () => { await client.close(); await server.close(); } };
}
let assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions += 1; };
const runtime = await fixture();
try {
  const { tools } = await runtime.client.listTools();
  check(tools.length === 16, '9 common + 4 native + 3 legacy tools');
  const commonNames = Object.keys(FEISHU_TASK_SCHEMAS).map((name) => `feishu_${name}`);
  const nativeNames = Object.keys(FEISHU_NATIVE_SCHEMAS).map((name) => `feishu_${name}`);
  for (const name of [...commonNames, ...nativeNames]) {
    const entry = tools.find((tool) => tool.name === name);
    check(Boolean(entry), `published tool ${name}`);
    check(entry.inputSchema.additionalProperties === false, `strict input ${name}`);
    check(Boolean(entry.outputSchema), `output contract ${name}`);
    const write = ['feishu_create_mail_draft', 'feishu_send_mail_draft', 'feishu_native_write'].includes(name);
    check(entry.annotations.readOnlyHint === !write && entry.annotations.destructiveHint === write,
      `correct read/write annotations ${name}`);
  }
  const searchDoc = tools.find((tool) => tool.name === 'feishu_search_documents');
  check(searchDoc.inputSchema.properties.pageSize.maximum === 20, 'document page size is capped at 20');
  check(!searchDoc.inputSchema.properties.arguments, 'common tool uses direct fields, not opaque arguments');

  const examples = {
    search_messages: { senderIds: ['me'], startTime: '2026-09-10T00:00:00+08:00',
      endTime: '2026-09-18T12:00:00+08:00' },
    read_message_context: { messageIds: ['om_synthetic'] },
    search_documents: { createdByMe: true, timeField: 'created', startTime: '2026-09-01T00:00:00+08:00' },
    read_document: { reference: 'https://test.feishu.cn/wiki/synthetic', scope: 'keyword', keyword: '部署' },
    find_people: { userIds: ['me'] },
    search_mail: { from: 'alice@example.com', subject: '验收' },
    read_mail: { messageId: 'synthetic-message-id==' },
    create_mail_draft: { to: ['alice@example.com'], cc: ['bob@example.com'],
      subject: '测试草稿', body: '这是离线测试正文，不会发送。', userIntent, idempotencyKey: 'synthetic-draft-1' },
    send_mail_draft: { draftId: 'synthetic-draft', userIntent, confirmed: true },
  };
  for (const [task, args] of Object.entries(examples)) {
    const before = invocations.length;
    const response = await runtime.client.callTool({ name: `feishu_${task}`, arguments: args });
    check(!response.isError && response.structuredContent.ok, `valid ${task}`);
    check(invocations.length === before + 1, `one executor call ${task}`);
    const invoked = invocations.at(-1);
    check(invoked.actor.accountId === principal.accountId && invoked.request.task === task, `bound actor/task ${task}`);
  }
  check(invocations[0].request.arguments.query === '', 'activity search does not invent keyword');
  check(invocations[0].request.arguments.pageLimit === 3, 'bounded automatic paging default');
  check(invocations[1].request.arguments.order === undefined, 'batch message read does not invent sort');
  check(invocations[2].request.arguments.pageSize === 15, 'doc search default respects CLI');
  check(legacyInvocations.length === 0, 'common requests need no legacy catalog/operation round-trip');

  const invalid = [
    ['search_messages', {}], ['search_messages', { query: 'x', pageLimit: 11 }],
    ['search_messages', { query: 'x', startTime: '2026-09-18T12:00:00' }],
    ['search_messages', { query: 'x', startTime: '2026-09-18T12:00:00+08:00', endTime: '2026-09-01T12:00:00+08:00' }],
    ['search_messages', { query: 'x', token: 'must-not-be-accepted' }],
    ['read_message_context', { chatId: 'oc_one', userId: 'ou_two' }],
    ['read_message_context', { messageIds: ['om_one'], pageSize: 10 }],
    ['read_message_context', { messageIds: ['om_one'], order: 'asc' }],
    ['read_message_context', { threadId: 'omt_one', startTime: '2026-09-18T00:00:00+08:00' }],
    ['search_documents', { query: 'x', pageSize: 21 }],
    ['search_documents', { folderTokens: ['fld_one'], spaceIds: ['space_one'] }],
    ['search_documents', { mine: true, ownerIds: ['ou_one'] }],
    ['search_documents', { createdByMe: true, creatorIds: ['ou_one'] }],
    ['search_documents', { startTime: '2026-09-18T00:00:00+08:00' }],
    ['read_document', { reference: 'token', scope: 'keyword' }],
    ['read_document', { reference: 'token', scope: 'section' }],
    ['read_document', { reference: 'token', scope: 'range' }],
    ['read_document', { reference: 'token', detail: 'with-ids', format: 'markdown' }],
    ['find_people', {}], ['search_mail', { query: 'x'.repeat(51) }],
    ['create_mail_draft', { to: ['not-email'], subject: 'test', body: 'test', userIntent }],
    ['send_mail_draft', { draftId: 'draft', userIntent }],
    ['send_mail_draft', { draftId: 'draft', userIntent, confirmed: false }],
    ['send_mail_draft', { draftId: 'draft', userIntent, confirmed: true, body: 'implicit mutation' }],
  ];
  for (const [task, args] of invalid) {
    const before = invocations.length;
    const response = await runtime.client.callTool({ name: `feishu_${task}`, arguments: args });
    check(response.isError, `reject invalid ${task}`);
    check(invocations.length === before, `invalid ${task} never reaches executor`);
  }

  for (const [task, args] of Object.entries({
    skill_read: { skill: 'lark-mail/references/lark-mail-search.md' },
    native_catalog: { domain: 'mail', operation: 'mail.v1.user_mailbox_message.get', mode: 'read' },
    native_read: { operation: 'mail.v1.user_mailbox_message.get', arguments: { message_id: 'synthetic' } },
    native_write: { operation: 'mail.v1.user_mailbox_message.send', arguments: { yes: true }, userIntent },
  })) {
    const result = await runtime.client.callTool({ name: `feishu_${task}`, arguments: args });
    check(!result.isError && nativeInvocations.at(-1).request.task === task, `native contract ${task}`);
  }
  check(nativeInvocations.at(-1).request.arguments.arguments.yes === true, 'native yes preserved, not manufactured');
  for (const [task, args] of [
    ['skill_read', { skill: '../../.env' }],
    ['native_read', { operation: 'https://example.com/send', arguments: {} }],
    ['native_read', { operation: 'mail.get', arguments: {}, userIntent }],
    ['native_write', { operation: 'mail.send', arguments: {} }],
  ]) {
    const before = nativeInvocations.length;
    const result = await runtime.client.callTool({ name: `feishu_${task}`, arguments: args });
    check(result.isError && nativeInvocations.length === before, `native rejects invalid ${task}`);
  }
  const summary = await runtime.client.callTool({ name: 'feishu_catalog', arguments: { domain: 'docx' } });
  check(summary.structuredContent.operations.length > 0, 'legacy domain filter returns matches');
  check(summary.structuredContent.operations.every((item) => item.id.startsWith('docx.') && !item.inputSchema),
    'legacy domain catalog contains summaries, not huge schemas');
  const precise = await runtime.client.callTool({ name: 'feishu_catalog', arguments: { operation: 'docx.documents.read_text' } });
  check(precise.structuredContent.operations.length === 1
    && precise.structuredContent.operations[0].inputSchema.properties.documentId, 'single operation returns full schema');
  await runtime.client.callTool({ name: 'feishu_read', arguments: { operation: 'docx.documents.read_text', arguments: { documentId: 'doc_test' } } });
  check(legacyInvocations.at(-1).operation === 'docx.documents.read_text', 'legacy execution remains wired');

  console.log(JSON.stringify({ phase: 'offline-protocol', assertions,
    tools: tools.length, commonTools: commonNames.length, nativeTools: nativeNames.length,
    listBytes: Buffer.byteLength(JSON.stringify(tools)), realNetworkCalls: 0 }));
} finally { await runtime.close(); }

const readOnly = await fixture({ ...principal, scopes: ['feishu.read'] });
try {
  const before = invocations.length;
  const denied = await readOnly.client.callTool({ name: 'feishu_send_mail_draft',
    arguments: { draftId: 'synthetic-draft', userIntent, confirmed: true } });
  check(denied.isError && denied.structuredContent.error.code === 'connector_scope_missing', 'read grant cannot send');
  check(invocations.length === before, 'write denied before backend');
} finally { await readOnly.close(); }

const failureRuntime = await fixture(principal, async () => { throw new Error('secret-error-must-not-escape'); });
try {
  const failure = await failureRuntime.client.callTool({ name: 'feishu_find_people', arguments: { userIds: ['me'] } });
  check(failure.isError && !JSON.stringify(failure).includes('secret-error-must-not-escape'), 'provider error remains private');
} finally { await failureRuntime.close(); }

const legacyOnlyServer = createFeishuMcpServer(legacy, principal);
const legacyOnlyClient = new Client({ name: 'legacy-only-test', version: '1.0.0' });
const [legacyClientTransport, legacyServerTransport] = InMemoryTransport.createLinkedPair();
await legacyOnlyServer.connect(legacyServerTransport);
await legacyOnlyClient.connect(legacyClientTransport);
try {
  check((await legacyOnlyClient.listTools()).tools.length === 3, 'no injected backend means no advertised new capabilities');
} finally { await legacyOnlyClient.close(); await legacyOnlyServer.close(); }

const pluginRoot = path.join(root, 'plugins/feishu');
const portable = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'plugin.json'), 'utf8'));
const mcp = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'mcp.json'), 'utf8'));
const compatibility = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.codex-plugin/plugin.json'), 'utf8'));
check(portable.name === 'feishu' && portable.name === compatibility.name, 'portable and compatibility identities agree');
check(portable.version === compatibility.version, 'portable and compatibility versions agree');
check(Object.keys(mcp.mcpServers).length === 0, 'portable template cannot connect to an existing deployment');
check(!JSON.stringify(mcp).match(/token|secret|authorization/i), 'plugin config does not embed credentials');
const skillDirs = fs.readdirSync(path.join(pluginRoot, 'skills'));
check(skillDirs.length === 4, 'four focused domain skills');
for (const directory of skillDirs) {
  const skill = fs.readFileSync(path.join(pluginRoot, 'skills', directory, 'SKILL.md'), 'utf8');
  check(skill.startsWith('---\n') && skill.includes(`name: ${directory}\n`), `skill metadata ${directory}`);
}
console.log(JSON.stringify({ status: 'passed', assertions, actualCloudActivation: 'not tested', realNetworkCalls: 0 }));
