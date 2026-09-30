import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// Actual MCP registration, executor, attachment adapter, runner lifecycle and file publication.
// The child program emulates pinned CLI stdout/stderr/files; it is not a real Feishu acceptance test.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dependency = createRequire(import.meta.url);
const forbidden = () => { throw new Error('Network forbidden in this synthetic test.'); };
globalThis.fetch = forbidden;
delete process.env.CONNECTOR_DEPLOYMENT_CONFIG;
process.env.CONNECTOR_PUBLIC_URL = 'https://connector.example.test';
process.env.CONNECTOR_DEFAULT_TIMEZONE = 'UTC';
const logs = []; const launches = []; const cache = new Map();
let childProgram; let timeoutMs = 2000;
const stubs = {
  '@nestjs/common': { Logger: class { log(message) { logs.push(JSON.parse(message)); } } },
  'node:https': { request: forbidden }, 'node:dns/promises': { lookup: forbidden },
  'node:child_process': { spawn(binary, argv, options) {
    launches.push({ binary, argv, cwd: options.cwd });
    assert.equal(options.shell, false);
    assert.equal(options.env.LARKSUITE_CLI_USER_ACCESS_TOKEN, 'synthetic-access');
    return spawn(process.execPath, ['-e', childProgram], options);
  } },
};
function load(file) {
  const absolute = path.resolve(root, file);
  if (cache.has(absolute)) return cache.get(absolute).exports;
  const module = { exports: {} }; cache.set(absolute, module);
  const code = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  new Function('require', 'module', 'exports', '__dirname', code)((name) => stubs[name] ?? (name.startsWith('.')
    ? load(path.resolve(path.dirname(absolute), `${name}.ts`)) : dependency(name)),
  module, module.exports, path.dirname(absolute));
  return module.exports;
}
const { FeishuToolExecutor } = load('server/modules/feishu-tools/feishu-tools.executor.ts');
const { createFeishuMcpServer } = load('server/modules/feishu-tools/feishu-tools.mcp.ts');
const { runFeishuCli } = load('server/modules/feishu-tools/feishu-cli.runner.ts');
const { FeishuAttachmentDiagnostics } = load('server/modules/feishu-tools/feishu-attachment.diagnostics.ts');
const { validateStorageJson } = load('server/modules/connector-auth-storage/connector-auth-storage.contract.ts');
const principal = { accountId: 'synthetic-tenant:synthetic-user', grantId: 'synthetic-grant',
  clientId: 'chatgpt', scopes: ['feishu.read'] };
let storageFailure;
const stored = [];
const store = {
  async get(model) {
    assert.equal(model, 'FeishuAccount');
    return { tenant_key: 'synthetic-tenant', open_id: 'synthetic-user', access_token: 'synthetic-access',
      refresh_token: 'synthetic-refresh', access_expires_at: Math.floor(Date.now() / 1000) + 3600,
      scope: 'im:message:readonly drive:file:download docs:document:export docx:document:readonly mail:user_mailbox.message.body:read' };
  },
  async put(model, key, payload, expiresAt) {
    validateStorageJson({ operation: 'put', model, key, payload, expiresAt });
    if (storageFailure) throw new Error(storageFailure);
    stored.push({ model, key, payload });
  },
  acquireLease: forbidden, releaseLease: forbidden,
};
const executor = new FeishuToolExecutor(store, forbidden, () => ({ clientId: 'cli_synthetic', clientSecret: 'unused' }),
  undefined, (argv, credentials, options) => runFeishuCli(argv, credentials, { ...options, timeoutMs }));
const server = createFeishuMcpServer(executor, principal, undefined, executor.executeNative.bind(executor));
const client = new Client({ name: 'synthetic-attachment-execution', version: '1.0.0' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport); await client.connect(clientTransport);
let checks = 0;
function check(value, label) { assert.ok(value, label); checks++; }
const requests = [
  { source: 'message', messageId: 'om_synthetic', fileKey: 'file_synthetic', type: 'file', fileName: '合成附件.docx' },
  { source: 'drive', fileToken: 'synthetic_drive' },
  { source: 'docx', documentToken: 'synthetic_docx', format: 'markdown' },
  { source: 'mail', messageId: 'synthetic_mail', attachmentIds: ['synthetic_attachment'] },
];
function programFor(request, outputMode = 'json') {
  if (request.source === 'mail') return 'process.stdout.write(JSON.stringify({ok:true,data:{download_urls:' +
    '[{attachment_id:"synthetic_attachment",download_url:"https://mail.example.test/attachment?sign=synthetic"}],failed_ids:[]}}));';
  const name = request.source === 'docx' ? 'attachment.md' : 'attachment.bin';
  return `require('node:fs').writeFileSync('output/${name}', 'synthetic file bytes');` +
    (outputMode === 'empty' ? '' : 'process.stdout.write(JSON.stringify({ok:true,data:{size_bytes:20}}));');
}
async function call(request) {
  return client.callTool({ name: 'feishu_download_attachment', arguments: request });
}
try {
  for (const request of requests) {
    childProgram = programFor(request);
    const before = launches.length;
    const result = await call(request);
    check(result.isError === false && result.structuredContent.ok, `${request.source}: named MCP succeeds`);
    check(launches.length === before + 1 && !fs.existsSync(launches.at(-1).cwd), 'single real process and isolated cleanup');
    check(logs.some((row) => row.source === request.source && row.stage === 'cli' && row.ok && row.exitCode === 0),
      'successful CLI stage is recorded');
    check(!JSON.stringify(result).includes('dataBase64') && !JSON.stringify(result).includes('synthetic-access'),
      'no binary or credentials returned in MCP data');
    if (request.source !== 'mail') check(result.content.some((item) => item.type === 'resource_link'), 'published resource link');
    else check(result.structuredContent.data.downloaded === false, 'mail URL does not falsely claim binary download');
  }
  childProgram = programFor(requests[0], 'empty');
  check((await call(requests[0])).isError === false, 'real runner file-only stdout contract works for named tool');

  for (const code of ['file_delivery_unavailable', 'file_delivery_timeout']) {
    childProgram = programFor(requests[0]); storageFailure = code;
    const before = launches.length;
    const result = await call(requests[0]);
    check(result.isError && result.structuredContent.error.code === code, 'delivery failure retains accurate code');
    check(!result.content.some((item) => item.type === 'resource_link') &&
      !JSON.stringify(result).includes('dataBase64'), 'failed publication never returns a file or partial content');
    check(launches.length === before + 1, 'storage failure never reruns the CLI');
    check(logs.some((row) => row.stage === 'file_delivery' && !row.ok && row.failureCode === code),
      'delivery failure has a safe stage diagnostic');
    const native = await executor.executeNative(principal, { task: 'native_read', arguments: {
      operation: 'drive.+download', arguments: { flags: { 'file-token': 'synthetic', output: 'output/attachment.bin' } },
    } });
    check(!native.ok && native.error.code === code, 'native file operation shares accurate delivery error mapping');
    storageFailure = undefined;
  }
  childProgram = 'process.stderr.write(JSON.stringify({ok:false,error:{type:"api",subtype:"permission_denied",' +
    'code:4039,message:"SENSITIVE_BODY_SENTINEL"}}));process.exitCode=1;';
  let before = stored.length;
  let result = await call(requests[0]);
  check(result.isError && result.structuredContent.error.code === 'cli_operation_failed' && stored.length === before,
    'real runner stderr JSON failure is distinct and never publishes files');
  check(logs.some((row) => row.exitCode === 1 && row.providerCode === 4039 &&
    row.errorType === 'api' && row.errorSubtype === 'permission_denied'), 'safe numeric API error and fixed enums retained');
  childProgram = 'process.stdout.write("SENSITIVE_BODY_SENTINEL");';
  result = await call(requests[0]);
  check(result.isError && result.structuredContent.error.code === 'attachment_download_failed', 'invalid stdout fails closed');
  check(logs.some((row) => row.stage === 'cli' && row.failureCode === 'cli_invalid_output'), 'JSON parse failure visible by fixed code');
  childProgram = 'setInterval(()=>{},1000);'; timeoutMs = 50;
  result = await call(requests[0]); timeoutMs = 2000;
  check(result.isError && result.structuredContent.error.code === 'attachment_timeout', 'real runner timeout remains distinct');
  check(logs.some((row) => row.failureCode === 'cli_timeout'), 'timeout has safe diagnostic');
  before = launches.length;
  result = await call({ source: 'message', messageId: 'om_synthetic' });
  check(result.isError && launches.length === before, 'invalid source-specific MCP input never runs a child');

  const redacted = [];
  new FeishuAttachmentDiagnostics((line) => redacted.push(JSON.parse(line))).stage('SENSITIVE_BODY_SENTINEL',
    'SENSITIVE_BODY_SENTINEL', false, Infinity, 'SENSITIVE_BODY_SENTINEL', 'SENSITIVE_BODY_SENTINEL',
    { error: { code: 'SENSITIVE_BODY_SENTINEL', type: 'SENSITIVE_BODY_SENTINEL', subtype: 'SENSITIVE_BODY_SENTINEL' } });
  check(redacted[0].source === 'other' && redacted[0].providerCode === -1 && redacted[0].durationMs === 0,
    'unknown diagnostic fields cannot smuggle arbitrary text');
  new FeishuAttachmentDiagnostics(() => { throw new Error('sink failed'); }).stage('message', 'cli', true, 1);
  checks++;
  check(!JSON.stringify([...logs, ...redacted]).includes('SENSITIVE_BODY_SENTINEL') &&
    !JSON.stringify(logs).includes('om_synthetic') && !JSON.stringify(logs).includes('synthetic-access') &&
    !JSON.stringify(logs).includes('https://'), 'no token, ID, response body or download URL in any diagnostic');
} finally { await client.close(); await server.close(); }
console.log(JSON.stringify({ ok: true, checks, network: false, realFeishuOperations: 0,
  coverage: 'named MCP -> real runner synthetic child -> validated file/URL result -> delivery; fixed safe diagnostics' }));
