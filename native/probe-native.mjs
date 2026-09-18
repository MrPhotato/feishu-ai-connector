import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import ts from 'typescript';
import { parseArguments, selectAsset, verifyArchive } from './prepare-cli.mjs';
import { projectMethod } from './generate-catalog.mjs';

const source = await readFile(new URL('./bridge-contract.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022, strict: true } }).outputText;
// Only compile the checked-in pure helper; no request text is evaluated or executable.
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled)(createRequire(import.meta.url), module, module.exports);
const { nativeCredentialEnvironment, missingNativeScopeGroups } = module.exports;
const fake = { appId: 'cli_synthetic123', accessToken: 'synthetic-token-marker', scopes: ['mail:read'] };
const root = join(tmpdir(), 'synthetic-isolated-native');
const env = nativeCredentialEnvironment(fake, { invocationRoot: root,
  ...(process.platform === 'win32' ? { windowsSystemRoot: process.env.SystemRoot } : {}) });
assert.equal(env.LARKSUITE_CLI_USER_ACCESS_TOKEN, fake.accessToken);
assert.equal(env.LARKSUITE_CLI_STRICT_MODE, 'user');
assert.equal(env.LARKSUITE_CLI_DEFAULT_AS, 'user');
assert.equal(env.HOME, root);
assert.equal(env.LARKSUITE_CLI_CONFIG_DIR, join(root, 'lark-config'));
for (const forbidden of ['PATH', 'NODE_OPTIONS', 'HTTP_PROXY', 'HTTPS_PROXY', 'LARKSUITE_CLI_APP_SECRET',
  'LARKSUITE_CLI_TENANT_ACCESS_TOKEN', 'LARKSUITE_CLI_AUTH_PROXY', 'LARKSUITE_CLI_PROFILE']) {
  assert.equal(env[forbidden], undefined);
}
assert.throws(() => nativeCredentialEnvironment({ ...fake, accessToken: '' }, { invocationRoot: root }));
assert.throws(() => nativeCredentialEnvironment({ ...fake, accessToken: 'bad\nvalue' }, { invocationRoot: root }));
assert.throws(() => nativeCredentialEnvironment(fake, { invocationRoot: 'relative' }));
assert.deepEqual(missingNativeScopeGroups(['read'], [['read', 'write'], ['body']]), [['body']]);
assert.deepEqual(missingNativeScopeGroups(['read', 'body'], [['read', 'write'], ['body']]), []);
assert.deepEqual(missingNativeScopeGroups(['read'], [[]]), [[]]);

// The child receives only our isolated env, never inherited ambient credentials/proxies.
const run = promisify(execFile);
const result = await run(process.execPath, ['-e',
  "process.stdout.write(JSON.stringify({token:process.env.LARKSUITE_CLI_USER_ACCESS_TOKEN==='synthetic-token-marker',user:process.env.LARKSUITE_CLI_STRICT_MODE==='user',secret:!!process.env.LARKSUITE_CLI_APP_SECRET,proxy:!!process.env.HTTPS_PROXY}))"],
{ env, windowsHide: true, timeout: 5000 });
assert.deepEqual(JSON.parse(result.stdout), { token: true, user: true, secret: false, proxy: false });
const windows = selectAsset('windows', 'x64');
assert.equal(windows.entry, 'lark-cli.exe');
assert.equal(selectAsset('linux', 'arm64').version, '1.0.95');
assert.throws(() => selectAsset('linux', 'ia32'));
assert.throws(() => verifyArchive(Buffer.from('tampered'), windows));
assert.throws(() => parseArguments(['--output', 'ok', '--output', 'other']));
assert.throws(() => parseArguments(['--shell', 'cmd']));
assert.equal(parseArguments(['--output', 'binary']).output, 'binary');

const sample = { name: 'mail user_mailboxes search', inputSchema: { type: 'object', properties: {
  params: { type: 'object' }, data: { type: 'object' },
} }, _meta: { risk: 'write', access_tokens: ['user'], scopes: ['umbrella', 'alternative'], required_scopes: [] } };
assert.deepEqual(projectMethod(sample).method.scopeGroups, [['umbrella', 'alternative']]);
assert.equal(projectMethod(sample).method.mode, 'write');
assert.equal(projectMethod({ ...sample, name: 'apps applications delete' }).reason, 'nonbusiness_service');
assert.equal(projectMethod({ ...sample, name: 'mail files download' }).reason, 'file_operation');
assert.equal(projectMethod({ ...sample, _meta: { ...sample._meta, access_tokens: ['bot'] } }).reason, 'not_user_identity');
const confirmed = { ...sample, inputSchema: { type: 'object', properties: { ...sample.inputSchema.properties,
  yes: { type: 'boolean', flag: '--yes' } } },
  _meta: { ...sample._meta, risk: 'high-risk-write', required_scopes: ['read', 'body'] } };
assert.equal(projectMethod(confirmed).method.requiresExplicitConfirmation, true);
assert.deepEqual(projectMethod(confirmed).method.scopeGroups, [['read'], ['body']]);
assert.equal(projectMethod({ ...sample, inputSchema: { type: 'object', properties: { file: { type: 'string' } } } }).reason,
  'non_json_input');
assert.equal(projectMethod({ ...sample, inputSchema: { type: 'object', properties: {
  data: { type: 'object', properties: { file_path: { type: 'string' } } } } } }).reason, 'file_carrier');

const binary = process.argv[2];
if (binary) {
  const safeEnv = { ...env };
  delete safeEnv.LARKSUITE_CLI_APP_ID;
  delete safeEnv.LARKSUITE_CLI_USER_ACCESS_TOKEN;
  const common = { env: safeEnv, windowsHide: true, timeout: 20000, maxBuffer: 2 * 1024 * 1024 };
  assert.equal((await run(resolve(binary), ['--version'], common)).stdout.trim(), 'lark-cli version 1.0.95');
  const skills = JSON.parse((await run(resolve(binary), ['skills', 'list'], common)).stdout);
  assert.ok(skills.skills.some((skill) => skill.name === 'lark-mail'));
  const mail = JSON.parse((await run(resolve(binary), ['skills', 'read', 'lark-mail', '--json'], common)).stdout);
  assert.match(mail.content, /draft-create/u);
  const schema = JSON.parse((await run(resolve(binary), ['schema', 'mail.user_mailbox.drafts.create'], common)).stdout);
  assert.ok(schema._meta.scopes.includes('mail:user_mailbox.message:modify'));
}
process.stdout.write('PASS: pinned assets, digest rejection, per-request credential env, scope semantics, catalog projection, and optional real native discovery.\n');
