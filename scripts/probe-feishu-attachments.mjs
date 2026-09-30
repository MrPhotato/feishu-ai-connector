import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// Synthetic response fixtures for the pinned official CLI 1.0.95 only. No user data, CLI execution or network.
globalThis.fetch = async () => { throw new Error('Network forbidden.'); };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireDependency = createRequire(import.meta.url);
const source = path.join(root, 'server/modules/feishu-tools/feishu-attachments.ts');
function load(file) {
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((name) => name.startsWith('.')
    ? load(path.resolve(path.dirname(file), `${name}.ts`)) : requireDependency(name), module, module.exports);
  return module.exports;
}
const { attachmentDownloadSchema, buildAttachmentPlan, executeAttachmentDownload } = load(source);
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; };
const flag = (plan, name) => plan.argv[plan.argv.indexOf(name) + 1];
const mail = { source: 'mail', messageId: 'TUlHc1NoWFhJMXgyUi9VZTNVL3h6UnlkRUdzPQ==', attachmentIds: ['a1', 'a2'] };
const message = { source: 'message', messageId: 'om_synthetic', fileKey: 'img_v3_synthetic', type: 'image' };
const drive = { source: 'drive', fileToken: 'synthetic_file' };
const docx = { source: 'docx', documentToken: 'synthetic_docx', format: 'pdf' };
const success = (data = {}, files) => ({ exitCode: 0, output: { ok: true, data }, ...(files ? { files } : {}) });
const execute = (request, reply) => executeAttachmentDownload(buildAttachmentPlan(request), async () => reply);
const file = (name = 'attachment.bin', content = 'synthetic attachment') => ({ name,
  mimeType: 'application/octet-stream', byteLength: Buffer.byteLength(content),
  dataBase64: Buffer.from(content).toString('base64') });
const link = (id) => ({ attachment_id: id, download_url: `https://sample.feishu.cn/mail/attachment/${id}?sign=synthetic` });

for (const request of [mail, message, drive, docx, { ...docx, format: 'docx' }, { ...docx, format: 'markdown' }]) {
  const plan = buildAttachmentPlan(request);
  check(plan.mode === 'read' && flag(plan, '--as') === 'user', 'each plan is read-only and explicitly user-bound');
  check(flag(plan, '--format') === 'json', 'machine-readable output fixed');
  let calls = 0;
  await executeAttachmentDownload(plan, async (argv, options) => {
    calls++; assert.deepEqual(argv, plan.argv);
    check(options.collectFiles === (request.source !== 'mail'), 'only binary commands opt into file collection');
    check(options.timeoutMs === undefined && options.files === undefined, 'no timeout increase or caller-supplied files');
    return success();
  });
  check(calls === 1, 'one fixed invocation; no implicit retries');
}
const mailPlan = buildAttachmentPlan(mail);
check(mailPlan.argv.slice(0, 3).join(' ') === 'mail user_mailbox.message.attachments download_url',
  'actual singular message resource');
assert.deepEqual(JSON.parse(flag(mailPlan, '--params')),
  { user_mailbox_id: 'me', message_id: mail.messageId, attachment_ids: mail.attachmentIds }); checks++;
assert.deepEqual(mailPlan.scopeGroups, [['mail:user_mailbox.message.body:read']]); checks++;
check(flag(buildAttachmentPlan(message), '--output') === 'output/attachment.bin', 'fixed IM output');
check(flag(buildAttachmentPlan(drive), '--output') === 'output/attachment.bin', 'fixed Drive output');
check(flag(buildAttachmentPlan(docx), '--output-dir') === 'output' &&
  flag(buildAttachmentPlan(docx), '--file-name') === 'attachment', 'fixed export directory and basename');
assert.deepEqual(buildAttachmentPlan(drive).scopeGroups, [['drive:file:download']]); checks++;
assert.deepEqual(buildAttachmentPlan(docx).scopeGroups, [['docs:document:export']]); checks++;
assert.deepEqual(buildAttachmentPlan({ ...docx, format: 'markdown' }).scopeGroups,
  [['docx:document:readonly', 'docx:document']]); checks++;

for (const invalid of [
  { ...mail, userMailboxId: 'somebody@example.com' }, { ...mail, attachmentIds: [] },
  { ...mail, attachmentIds: ['a1', 'a1'] }, { ...mail, attachmentIds: Array(21).fill('a') },
  { ...mail, messageId: '@private-file' }, { ...mail, messageId: 'secret\nvalue' },
  { ...drive, fileToken: '../secret' }, { ...drive, fileToken: '@file' }, { ...drive, fileToken: '--host' },
  { ...drive, fileToken: 'https://malicious.example/file' }, { ...drive, output: '../../secret' },
  { ...drive, host: 'malicious.example' }, { ...drive, accessToken: 'synthetic-token' },
  { ...message, messageId: 'oc_chat' }, { ...message, fileKey: '@secret' }, { ...message, type: 'folder' },
  { ...docx, format: 'html' }, { ...docx, fileName: '../../secret' }, { ...docx, documentToken: 'a'.repeat(513) },
  ...['../secret', 'folder/file.pdf', 'folder\\file.pdf', 'name\r\nheader', '.env', 'nul.pdf', 'name.']
    .map((fileName) => ({ ...drive, fileName })),
]) check(!attachmentDownloadSchema.safeParse(invalid).success, 'reject unsafe or unsupported request');

for (const delta of [
  { argv: ['auth', 'status'] }, { source: 'drive' }, { mode: 'write' }, { collectFiles: true },
  { scopeGroups: [] }, { request: { ...mail, host: 'malicious.example' } },
]) {
  let calls = 0;
  const result = await executeAttachmentDownload({ ...mailPlan, ...delta }, async () => { calls++; return success(); });
  check(!result.ok && calls === 0 && result.error.code === 'attachment_request_invalid',
    'tampered persisted plans do not become executable commands');
}

let result = await execute(mail, success({ download_urls: [link('a1'), link('a2')], failed_ids: [],
  extra: 'synthetic-secret-do-not-return' }));
check(result.ok && result.data.downloaded === false && result.data.links.length === 2 && result.data.complete,
  'mail returns verified official URLs without claiming binary download');
check(!JSON.stringify(result).includes('synthetic-secret-do-not-return') && !('expiresAt' in result.data),
  'no raw upstream fields or invented URL expiry');
result = await execute(mail, success({ download_urls: [link('a1')], failed_ids: ['a2'],
  failed_reasons: [{ attachment_id: 'a2', reason: 'synthetic-raw-sensitive-error' }] }));
check(!result.ok && result.error.code === 'attachment_partial_failure' && result.data.links.length === 1 &&
  result.data.failedAttachmentIds[0] === 'a2', 'explicit partial batch failures are preserved');
check(!JSON.stringify(result).includes('synthetic-raw-sensitive-error'), 'raw reasons are not disclosed');
result = await execute(mail, success({ download_urls: [link('a1')] }));
check(!result.ok && result.data.failedAttachmentIds[0] === 'a2', 'missing requested IDs cannot count as success');
result = await execute(mail, success({ failed_ids: ['a1', 'a2'] }));
check(!result.ok && result.error.code === 'attachment_download_failed', 'all-failed batch is a failure');
for (const data of [
  { download_urls: [link('outside')] }, { download_urls: [link('a1'), link('a1')] },
  { download_urls: [link('a1')], failed_ids: ['a1'] }, { download_urls: [], failed_ids: ['outside'] },
  { download_urls: [], failed_reasons: [{ attachment_id: 'outside' }] },
  { download_urls: [link('a1')], failed_reasons: [{ attachment_id: 'a1' }] },
  { download_urls: 'invalid' }, { failed_ids: 'invalid' }, { failed_reasons: 'invalid' },
]) {
  result = await execute(mail, success(data));
  check(!result.ok && result.error.code === 'attachment_response_invalid', 'response IDs/shape fail closed');
}
for (const url of [
  'http://sample.feishu.cn/a', 'file:///etc/passwd', 'https://user:password@sample.feishu.cn/a',
  'https://127.0.0.1/a', 'https://[::1]/a', 'https://localhost/a', 'https://host.local/a',
  'https://host.internal/a', 'https://sample.feishu.cn:8080/a', 'https://sample.feishu.cn/a#fragment',
  'https://sample.feishu.cn/\nsecret', 'https://sample.feishu.cn\\@other.example/a',
]) {
  result = await execute({ ...mail, attachmentIds: ['a1'] },
    success({ download_urls: [{ attachment_id: 'a1', download_url: url }] }));
  check(!result.ok && result.error.code === 'attachment_response_invalid', 'unsafe download URL is never delivered');
}
result = await execute({ ...mail, attachmentIds: ['a1'] }, success({ download_urls: [
  { attachment_id: 'a1', download_url: 'https://cdn.provider.example/synthetic?signature=synthetic' },
] }));
check(result.ok, 'valid API-returned CDN links do not depend on an invented domain allowlist');

for (const [request, name] of [
  [message, 'attachment.bin'], [drive, 'attachment.bin'], [docx, 'attachment.pdf'],
  [{ ...docx, format: 'docx' }, 'attachment.docx'], [{ ...docx, format: 'markdown' }, 'attachment.md'],
]) {
  const artifact = file(name);
  result = await execute(request, success({ saved_path: '/private/synthetic/temp/never-return', size_bytes: artifact.byteLength }, [artifact]));
  check(result.ok && result.data.downloaded === true && result.data.files[0].name === name,
    'actual collected bytes are handed off internally');
  check(!JSON.stringify(result).includes('/private/synthetic'), 'local filesystem paths never escape');
}
result = await execute(docx, success({ ready: false, ticket: 'synthetic_ticket', next_command: 'untrusted shell' }));
check(!result.ok && result.error.code === 'attachment_export_pending' && result.data.ticket === 'synthetic_ticket' &&
  result.data.downloaded === false && !JSON.stringify(result).includes('untrusted shell'),
  'pending export preserves only a safe resumable ticket and is never false success');
result = await execute(drive, success({ saved_path: '/tmp/removed-file' }));
check(!result.ok && result.error.code === 'attachment_file_unavailable', 'saved_path alone is not downloadable content');
for (const files of [[], [file(), file()]]) {
  result = await execute(drive, success({}, files));
  check(!result.ok, 'single-source plan must deliver exactly one artifact');
}
for (const delta of [
  { name: '../secret' }, { name: 'other.bin' }, { mimeType: 'text/plain\r\nSet-Cookie: leak' },
  { byteLength: -1 }, { byteLength: 10 * 1024 * 1024 + 1 }, { byteLength: 0 },
  { dataBase64: '!!!' }, { dataBase64: `${file().dataBase64}\n` },
]) {
  result = await execute(drive, success({}, [{ ...file(), ...delta }]));
  check(!result.ok && result.error.code === 'attachment_file_invalid', 'invalid bytes/size/name/headers fail closed');
}
result = await execute(drive, success({ size_bytes: 99999 }, [file()]));
check(!result.ok, 'CLI byte count must match the collected artifact');
result = await execute(drive, success({ size_bytes: 0 }, [file('attachment.bin', '')]));
check(result.ok && result.data.files[0].byteLength === 0, 'valid empty attachments are not rejected');
for (const [content, mimeType] of [
  [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), 'image/png'],
  [Buffer.from([255, 216, 255, 224]), 'image/jpeg'],
  [Buffer.from('%PDF-synthetic'), 'application/pdf'],
  [Buffer.from('GIF89asynthetic'), 'image/gif'],
  [Buffer.from('RIFF0000WEBPsynthetic'), 'image/webp'],
]) {
  const plan = buildAttachmentPlan({ ...message, fileName: '原始附件.bin' });
  check(flag(plan, '--output') === 'output/attachment.bin', 'display filename never changes the CLI filesystem path');
  result = await executeAttachmentDownload(plan, async () => success({}, [
    { ...file('attachment.bin', content), mimeType: 'text/html' },
  ]));
  check(result.ok && result.data.files[0].name === '原始附件.bin' && result.data.files[0].mimeType === mimeType,
    'display name preserved and detected bytes take precedence over declared MIME');
}
result = await execute({ ...drive, fileName: '工作表.xlsx' }, success({}, [file()]));
check(result.ok && result.data.files[0].mimeType ===
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'known file extension supplies fallback MIME');
result = await execute({ ...drive, fileName: 'unexpected.html' }, success({}, [file()]));
check(result.ok && result.data.files[0].mimeType === 'application/octet-stream', 'active-content MIME is never inferred');
for (const reply of [
  { exitCode: 1, output: { ok: true, data: 'synthetic-secret' } },
  { exitCode: 0, output: { ok: false, error: { message: 'synthetic-secret' } } },
  { exitCode: 0, output: 'synthetic-secret' },
]) {
  result = await execute(drive, reply);
  check(!result.ok && !JSON.stringify(result).includes('synthetic-secret'), 'upstream failure is sanitized');
}
for (const request of [drive, docx]) {
  let calls = 0;
  result = await executeAttachmentDownload(buildAttachmentPlan(request), async () => {
    calls++; throw new Error('cli_timeout');
  });
  check(!result.ok && result.error.code === 'attachment_timeout' && calls === 1, 'timeout never retries automatically');
}
result = await executeAttachmentDownload(buildAttachmentPlan(drive), async () => { throw new Error('synthetic-token-value'); });
check(!result.ok && !JSON.stringify(result).includes('synthetic-token-value'), 'thrown diagnostics never disclose credentials');

// Exercise the actual SDK tools/list JSON schema and its call-time validation, not only Zod inference.
const server = new McpServer({ name: 'synthetic-attachment-contract', version: '1.0.0' });
const client = new Client({ name: 'synthetic-attachment-client', version: '1.0.0' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
let toolCalls = 0;
server.registerTool('feishu_download_attachment', { inputSchema: attachmentDownloadSchema }, async (args) => {
  toolCalls++;
  return { content: [{ type: 'text', text: JSON.stringify(buildAttachmentPlan(args).request) }] };
});
await server.connect(serverTransport);
await client.connect(clientTransport);
try {
  const { tools } = await client.listTools();
  check(tools.length === 1 && tools[0].inputSchema.type === 'object' &&
    !tools[0].inputSchema.oneOf && !tools[0].inputSchema.anyOf, 'actual tools/list emits a top-level object schema');
  check(tools[0].inputSchema.additionalProperties === false &&
    tools[0].inputSchema.properties.source.enum.length === 4, 'actual tools/list preserves strict properties and four sources');
  const accepted = await client.callTool({ name: 'feishu_download_attachment', arguments: { ...drive, fileName: 'original.pdf' } });
  check(!accepted.isError && toolCalls === 1, 'actual SDK accepts a valid source-specific input');
  const rejected = await client.callTool({ name: 'feishu_download_attachment', arguments: { source: 'drive', messageId: 'wrong' } });
  check(rejected.isError && toolCalls === 1, 'actual SDK rejects incomplete or mixed-source inputs before execution');
} finally { await client.close(); await server.close(); }
console.log(JSON.stringify({ ok: true, checks, networkCalls: 0, realUserOperations: 0 }));
