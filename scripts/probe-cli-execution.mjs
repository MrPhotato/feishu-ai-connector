import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Synthetic accounts only. The sole real CLI execution is credential-free --version/skills.
globalThis.fetch = async () => { throw new Error('Network forbidden.'); };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const moduleRoot = path.join(root, 'server/modules/feishu-tools');
const requireDependency = createRequire(import.meta.url);
function loader(stubs = {}) {
  const cache = new Map();
  function load(file) {
    const absolute = path.resolve(file);
    if (cache.has(absolute)) return cache.get(absolute).exports;
    const module = { exports: {} };
    cache.set(absolute, module);
    const compiled = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    new Function('require', 'module', 'exports', '__dirname', compiled)(
      (specifier) => stubs[specifier] ?? (specifier.startsWith('.')
        ? load(path.resolve(path.dirname(absolute), `${specifier}.ts`)) : requireDependency(specifier)),
      module, module.exports, path.dirname(absolute),
    );
    return module.exports;
  }
  return (name) => load(path.join(moduleRoot, name));
}
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const load = loader();
const real = load('feishu-cli.runner.ts');
const synthetic = { appId: 'cli_synthetic', accessToken: 'synthetic-access-one' };
const environment = real.isolatedEnvironment(path.resolve(os.tmpdir(), 'synthetic-not-created'), synthetic);
for (const key of ['PATH', 'NODE_OPTIONS', 'HTTP_PROXY', 'HTTPS_PROXY', 'FEISHU_APP_SECRET',
  'LARKSUITE_CLI_APP_SECRET', 'LARKSUITE_CLI_TENANT_ACCESS_TOKEN', 'LARKSUITE_CLI_PROFILE']) {
  check(environment[key] === undefined, `parent environment excluded: ${key}`);
}
check(environment.LARKSUITE_CLI_STRICT_MODE === 'user', 'strict user identity');
assert.throws(() => real.isolatedEnvironment('relative', synthetic), /cli_credentials_invalid/);
assert.throws(() => real.isolatedEnvironment(os.tmpdir(), { ...synthetic, accessToken: 'bad\nvalue' }), /cli_credentials_invalid/);
checks += 2;

// Wrap only spawn's executable to run a controlled child. All options/environment/cwd and
// the timeout/output/cleanup lifecycle are the actual production implementation.
const launches = [];
let childProgram = 'process.stdout.write(JSON.stringify({ok:true,data:{cwd:process.cwd(),env:process.env}}))';
let ignoreTerm = false;
const signals = [];
const production = loader({ 'node:child_process': { spawn: (binary, args, options) => {
  launches.push({ binary, args, options });
  const child = spawn(process.execPath, ['-e', childProgram], options);
  const kill = child.kill.bind(child);
  child.kill = (signal) => { signals.push(signal); return ignoreTerm && signal === 'SIGTERM' ? true : kill(signal); };
  return child;
} } })('feishu-cli.runner.ts');
const parallel = await Promise.all([
  production.runFeishuCli(['fixed', 'read'], synthetic),
  production.runFeishuCli(['fixed', 'read'], { ...synthetic, accessToken: 'synthetic-access-two' }),
]);
check(parallel[0].output.data.env.LARKSUITE_CLI_USER_ACCESS_TOKEN === synthetic.accessToken, 'first child gets own token');
check(parallel[1].output.data.env.LARKSUITE_CLI_USER_ACCESS_TOKEN === 'synthetic-access-two', 'second child gets own token');
check(parallel[0].output.data.cwd !== parallel[1].output.data.cwd, 'parallel isolated directories');
for (const launch of launches) {
  check(launch.options.shell === false && launch.options.windowsHide === true, 'no shell / hidden child');
  check(launch.binary === path.join(moduleRoot, 'assets', process.platform === 'win32' ? 'lark-cli.exe' : 'lark-cli'), 'fixed executable');
  check(!fs.existsSync(launch.options.cwd), 'finished child directory removed');
}
ignoreTerm = true;
childProgram = 'setInterval(()=>{},1000)';
const started = Date.now();
await assert.rejects(production.runFeishuCli(['fixed'], synthetic, { timeoutMs: 50 }), /cli_timeout/);
check(signals.includes('SIGTERM') && signals.includes('SIGKILL'), 'SIGKILL fallback for unresponsive child');
check(Date.now() - started < 4000 && !fs.existsSync(launches.at(-1).options.cwd), 'timeout is bounded and cleaned');
ignoreTerm = false;
childProgram = 'process.stdout.write("x".repeat(5*1024*1024));setInterval(()=>{},1000)';
await assert.rejects(production.runFeishuCli(['fixed'], synthetic), /cli_output_limit/); checks++;
childProgram = 'process.stderr.write("synthetic-secret-error");process.exitCode=1';
await assert.rejects(production.runFeishuCli(['fixed'], synthetic), (error) => error.message === 'cli_invalid_output'); checks++;
await assert.rejects(production.runFeishuCli(['fixed'], synthetic, { timeoutMs: 0 }), /cli_timeout/); checks++;
const runtime = await real.probeFeishuCli();
check(runtime.available && runtime.version === '1.0.95', 'actual pinned CLI credential-free probe');

const { FeishuToolExecutor } = load('feishu-tools.executor.ts');
const { buildCliTask, executeCliTask } = load('feishu-cli.tasks.ts');
const { parseFeishuTaskRequest } = load('feishu-task-tools.contract.ts');
const catalog = JSON.parse(fs.readFileSync(path.join(moduleRoot, 'assets/api-catalog.json'), 'utf8'));
const scopes = [...new Set([...catalog.methods.flatMap((entry) => entry.scopeGroups.flat()),
  'contact:user:search', 'search:docs:read', 'mail:user_mailbox:readonly', 'mail:user_mailbox.message:send'])];
const intent = '用户本次明确要求向指定收件人创建这封测试草稿。';
const principal = { accountId: 'tenant:ou_one', scopes: ['feishu.read', 'feishu.write'] };
function account(openId = 'ou_one') {
  return { tenant_key: 'tenant', open_id: openId, access_token: `synthetic-${openId}-access`,
    refresh_token: `synthetic-${openId}-refresh`, access_expires_at: Math.floor(Date.now() / 1000) + 3600,
    scope: scopes.join(' ') };
}
function fixture() {
  const data = new Map([['FeishuAccount:tenant:ou_one', account()], ['FeishuAccount:tenant:ou_two', account('ou_two')]]);
  const leases = new Set(); const calls = []; const puts = []; let gets = 0;
  let reply = async () => ({ exitCode: 0, output: { ok: true, data: { done: true } } });
  const store = {
    async get(model, key) { if (model === 'FeishuAccount') gets++; return structuredClone(data.get(`${model}:${key}`)); },
    async put(model, key, payload) { puts.push({ model, key, payload: structuredClone(payload) }); data.set(`${model}:${key}`, structuredClone(payload)); },
    async acquireLease(key) { if (leases.has(key)) return undefined; leases.add(key); return 'synthetic-lease'; },
    async releaseLease(key) { leases.delete(key); },
  };
  const executor = new FeishuToolExecutor(store, async () => { throw new Error('Network forbidden'); },
    () => ({ clientId: 'cli_synthetic', clientSecret: 'never-pass-to-cli' }), undefined,
    async (argv, credentials, options) => { calls.push({ argv, credentials, options }); return reply(argv, credentials); });
  return { executor, data, calls, puts, store, get gets() { return gets; }, set reply(value) { reply = value; } };
}
const read = { task: 'find_people', arguments: { query: 'synthetic' } };
const write = { task: 'create_mail_draft', arguments: { to: ['synthetic@example.invalid'], subject: 'Test', body: 'Body', userIntent: intent } };
const f = fixture();
const scoped = f.executor.forRequest(principal.accountId, account());
check((await scoped.executeTask(principal, read)).ok && f.gets === 0, 'verified account reused only within request');
check((await f.executor.executeTask(principal, read)).ok && f.gets === 1, 'separate request re-reads account');
check((await scoped.executeTask({ ...principal, accountId: 'tenant:ou_two' }, read)).ok &&
  f.calls.at(-1).credentials.accessToken === account('ou_two').access_token && f.gets === 2, 'different account cannot reuse snapshot');
let count = f.calls.length;
check(!(await scoped.executeTask({ ...principal, scopes: ['feishu.read'] }, write)).ok && f.calls.length === count, 'read authorization cannot write');
check(!(await f.executor.forRequest(principal.accountId, { ...account(), scope: '' }).executeTask(principal, read)).ok &&
  f.calls.length === count, 'missing upstream scope never spawns');
check(!(await f.executor.forRequest(principal.accountId, { ...account(), revoked: true }).executeTask(principal, read)).ok,
  'revoked account denied');
for (const reference of ['https://evil.invalid/docx/token', 'file:///tmp/token', 'https://feishu.cn.evil.invalid/docx/token']) {
  check(!(await scoped.executeTask(principal, { task: 'read_document', arguments: { reference } })).ok, 'arbitrary document host rejected');
}
for (const operation of ['auth.login', 'drive.files.upload', 'im;whoami', 'https://evil.invalid']) {
  check(!(await scoped.executeNative(principal, { task: 'native_read', arguments: { operation, arguments: {} } })).ok,
    'unregistered command/file/host rejected');
}
const nativeArgs = { params: { user_mailbox_id: 'me' }, data: { raw: 'synthetic-mail' } };
const native = (args = nativeArgs, task = 'native_write') => ({ task, arguments: {
  operation: 'mail.user_mailbox.drafts.create', arguments: args, ...(task === 'native_write' ? { userIntent: intent } : {}),
} });
check(!(await scoped.executeNative(principal, native(nativeArgs, 'native_read'))).ok, 'native write cannot use read entry');
for (const key of ['host', 'file', 'config', 'as']) {
  check(!(await scoped.executeNative(principal, native({ ...nativeArgs, [key]: 'synthetic' }))).ok, 'extra native flags rejected');
}
check(!(await scoped.executeNative(principal, { task: 'skill_read', arguments: { skill: '../../.env' } })).ok, 'skill path traversal rejected');
check(f.calls.length === count, 'all invalid requests stopped before CLI');
const sensitive = catalog.methods.find((entry) => entry.schemaPath === 'approval.instances.cancel');
check(sensitive?.requiresExplicitConfirmation === true, 'pinned cancel operation is high risk');
check(!(await scoped.executeNative(principal, { task: 'native_write', arguments: {
  operation: sensitive.schemaPath, arguments: { data: { instance_code: 'synthetic-instance' } }, userIntent: intent,
} })).ok && f.calls.length === count, 'high risk requires explicit yes before spawn');
const literal = buildCliTask(parseFeishuTaskRequest(write.task, { ...write.arguments, body: '@./synthetic-file' }), 'ou_one');
check(literal.argv[literal.argv.indexOf('--body') + 1] === '@./synthetic-file' &&
  literal.argv.includes('--plain-text') && literal.argv.includes('--no-signature') &&
  !literal.argv.includes('--body-file') && !literal.argv.includes('--attach'), 'mail body is literal with local file/HTML paths disabled');
const skill = await real.runFeishuCli(['skills', 'read', 'lark-mail', '--json']);
f.reply = async () => skill;
check((await scoped.executeNative(principal, { task: 'skill_read', arguments: { skill: 'lark-mail' } })).ok,
  'actual CLI skill shape accepted without credentials');
check(f.calls.at(-1).credentials === undefined, 'bundled skill read has no credentials');

const w = fixture();
w.reply = async (_argv, credentials) => ({ exitCode: 0, output: { ok: true, data: {
  access_token: credentials.accessToken, nested: { Authorization: 'Bearer synthetic', echo: credentials.accessToken },
} } });
const result = await w.executor.executeNative(principal, native());
check(result.ok, 'native write completes');
check(!JSON.stringify(result).includes(account().access_token) && !JSON.stringify(w.puts).includes(account().access_token),
  'returned and persisted idempotency result is sanitized');
check((await w.executor.executeNative(principal, native({ data: { raw: 'synthetic-mail' }, params: { user_mailbox_id: 'me' } }))).ok &&
  w.calls.length === 1, 'reordered object keys reuse same idempotent write');
check((await w.executor.executeNative({ ...principal, accountId: 'tenant:ou_two' }, native())).ok && w.calls.length === 2,
  'idempotency results isolated by account');
const keyed = fixture();
const explicit = { ...write, arguments: { ...write.arguments, idempotencyKey: 'synthetic-action-key' } };
check((await keyed.executor.executeTask(principal, explicit)).ok, 'explicit idempotency write');
check((await keyed.executor.executeTask(principal, { ...explicit, arguments: { ...explicit.arguments, body: 'Changed' } })).error.code ===
  'idempotency_conflict' && keyed.calls.length === 1, 'same key with different content rejected');
const failed = fixture();
failed.reply = async () => { throw new Error('synthetic_secret_lowercase'); };
const failure = await failed.executor.executeTask(principal, write);
check(!failure.ok && !JSON.stringify(failure).includes('synthetic_secret'), 'unknown exception never exposed');
check((await failed.executor.executeTask(principal, write)).error.code === 'action_uncertain' && failed.calls.length === 1,
  'uncertain write remains pending and never retries');
const busy = fixture(); let finish;
busy.reply = () => new Promise((resolve) => { finish = resolve; });
const pending = busy.executor.executeTask(principal, write);
while (!finish) await new Promise((resolve) => setTimeout(resolve, 0));
check((await busy.executor.executeTask(principal, write)).error.code === 'action_in_progress' && busy.calls.length === 1,
  'concurrent duplicate is blocked by lease');
finish({ exitCode: 0, output: { ok: true, data: {} } }); await pending;
const lost = fixture(); const put = lost.store.put;
lost.store.put = async (model, key, payload) => {
  if (payload.status === 'complete') throw new Error('synthetic-persistence-failure');
  return put(model, key, payload);
};
check(!(await lost.executor.executeTask(principal, write)).ok, 'success-ledger persistence failure is unconfirmed');
check((await lost.executor.executeTask(principal, write)).error.code === 'action_uncertain' && lost.calls.length === 1,
  'lost completion ledger does not retry external write');

const draft = buildCliTask(parseFeishuTaskRequest('send_mail_draft', { draftId: 'synthetic-draft', userIntent: intent, confirmed: true }), 'ou_one');
const ledger = { total: 1, success_count: 1, failure_count: 0, sent: [{ draft_id: 'synthetic-draft', message_id: 'synthetic-message' }] };
check((await executeCliTask(draft, async () => ({ exitCode: 0, output: { ok: true, data: ledger } }))).ok,
  'official draft success ledger accepted');
for (const data of [{ ...ledger, failure_count: 1 }, { ...ledger, failed: [{ draft_id: 'synthetic-draft', error: 'synthetic' }] },
  { ...ledger, aborted: true }, { ...ledger, sent: [{ draft_id: 'wrong-draft' }] }, {}, { ...ledger, total: 2 }]) {
  check(!(await executeCliTask(draft, async () => ({ exitCode: 0, output: { ok: true, data } }))).ok,
    'draft failures/malformed/mismatched ledger cannot be overall success');
}
const partial = fixture();
partial.reply = async () => ({ exitCode: 0, output: { ok: true, data: { ...ledger, failure_count: 1 } } });
const send = { task: 'send_mail_draft', arguments: { draftId: 'synthetic-draft', userIntent: intent, confirmed: true } };
check(!(await partial.executor.executeTask(principal, send)).ok &&
  (await partial.executor.executeTask(principal, send)).error.code === 'action_uncertain' && partial.calls.length === 1,
  'per-draft send failure remains pending and cannot repeat');
const actualNow = Date.now; let clock = actualNow(); const budgets = [];
try {
  Date.now = () => clock;
  const plan = buildCliTask(parseFeishuTaskRequest('search_documents', { query: 'synthetic', pageLimit: 2 }), 'ou_one');
  await executeCliTask(plan, async (_argv, budget) => {
    budgets.push(budget); clock += 12000;
    return { exitCode: 0, output: { ok: true, data: { results: [], has_more: true, page_token: String(budgets.length) } } };
  });
} finally { Date.now = actualNow; }
check(budgets.length === 2 && budgets[0] === 30000 && budgets[1] === 18000, 'pagination passes remaining overall budget');
check(launches.every((item) => !fs.existsSync(item.options.cwd)), 'all process paths cleaned');
console.log(`PASS: ${checks} CLI execution/security checks; synthetic identities only, no Feishu business requests.`);
