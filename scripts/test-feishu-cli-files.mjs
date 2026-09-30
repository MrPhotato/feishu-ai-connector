import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, symlink, link, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const moduleRoot = path.join(root, 'server/modules/feishu-tools');
const requireDependency = createRequire(import.meta.url);
function loader(stubs = {}) {
  const cache = new Map();
  function load(absolute) {
    if (cache.has(absolute)) return cache.get(absolute).exports;
    const module = { exports: {} }; cache.set(absolute, module);
    const compiled = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    } }).outputText;
    new Function('require', 'module', 'exports', '__dirname', compiled)((specifier) =>
      stubs[specifier] ?? (specifier.startsWith('.')
        ? load(path.resolve(path.dirname(absolute), `${specifier}.ts`)) : requireDependency(specifier)),
    module, module.exports, path.dirname(absolute));
    return module.exports;
  }
  return (name) => load(path.join(moduleRoot, name));
}
const { prepareCliFiles, validateCliFileArguments, collectCliFiles } = loader()('feishu-cli.files.ts');
const temp = await mkdtemp(path.join(os.tmpdir(), 'feishu-cli-files-test-'));
const content = Buffer.from('Synthetic attachment bytes.');
const input = { name: '用户资料.txt', base64: content.toString('base64'), mimeType: 'text/plain' };
let caseId = 0;
let checks = 0;
async function fixture(options = { files: [input], collectFiles: true }) {
  const directory = path.join(temp, String(caseId++)); await mkdir(directory);
  return { directory, manifest: await prepareCliFiles(directory, options) };
}
async function rejects(operation, expected) { await assert.rejects(operation, expected); checks++; }
function throws(operation, expected) { assert.throws(operation, expected); checks++; }
try {
  const first = await fixture();
  assert.deepEqual(await readFile(path.join(first.directory, 'input', input.name)), content); checks++;
  for (const argv of [
    ['im', 'images', 'create', '--file', `input/${input.name}`],
    ['im', 'images', 'create', '--file', `image=input/${input.name}`],
    ['im', 'files', 'create', `--file=file=input/${input.name}`],
    ['im', 'messages', 'create', '--data', `@input/${input.name}`],
    ['im', 'messages', 'create', `--data=@input/${input.name}`],
    ['drive', '+download', '--output', 'output/attachment.bin'],
    ['base', '+attachment-download', '--output', 'output'],
    ['docs', '+export', '--output-dir', 'output', '--file-name', 'attachment'],
    ['mail', '+draft-create', '--body', '@./literal-text', '--subject=@literal-subject'],
  ]) { validateCliFileArguments(argv, first.manifest); checks++; }
  for (const argv of [
    ['im', 'messages', 'create', '--data', '@../config/auth.json'],
    ['im', 'messages', 'create', '--data=@input/missing.json'],
    ['im', 'images', 'create', '--file', '../outside'],
    ['im', 'images', 'create', '--file', 'image=../outside'],
    ['im', 'images', 'create', '--file', `../image=input/${input.name}`],
    ['im', 'images', 'create', '--file', 'https://example.invalid/file'],
    ['im', 'images', 'create', '--file', path.join(temp, 'file')],
    ['drive', '+download', '--output', 'output/../config/file'],
    ['drive', '+download', '--output', 'output\\file'],
    ['drive', '+download', '--output-dir', '/tmp/output'],
    ['docs', '+export', '--output-dir', 'output', '--file-name', '../file'],
    ['other', '@config/credentials.json'],
  ]) throws(() => validateCliFileArguments(argv, first.manifest), /cli_file_reference_invalid/);
  const noOutput = await fixture({});
  throws(() => validateCliFileArguments(['drive', '+download', '--output', 'output/file'], noOutput.manifest),
    /cli_file_reference_invalid/);
  for (const name of ['../escape', '/tmp/escape', 'C:\\escape', 'a/b', 'a\\b', '..', '.env', 'CON', 'NUL.txt',
    'name:stream', 'a\0b', 'a\nb', 'trailing.', 'trailing ', '']) {
    await rejects(() => fixture({ files: [{ ...input, name }] }), /cli_file_input_invalid/);
  }
  for (const base64 of ['data:text/plain;base64,YQ==', 'YQ', 'YR==', 'YQ==\n', '____']) {
    await rejects(() => fixture({ files: [{ ...input, base64 }] }), /cli_file_(?:input_invalid|limit)/);
  }
  await rejects(() => fixture({ files: [{ name: 'A.txt', base64: '' }, { name: 'a.txt', base64: '' }] }),
    /cli_file_input_invalid/);
  await rejects(() => fixture({ files: [input], maxFileBytes: 1 }), /cli_file_input_invalid|cli_file_limit/);
  await rejects(() => fixture({ maxFileBytes: 11 * 1024 * 1024 }), /cli_file_limit/);
  await rejects(() => fixture({ files: Array.from({ length: 21 }, (_, n) => ({ name: `${n}.txt`, base64: '' })) }),
    /cli_file_limit/);
  const sevenMiB = Buffer.alloc(7 * 1024 * 1024).toString('base64');
  await rejects(() => fixture({ files: [0, 1, 2].map((n) => ({ name: `${n}.bin`, base64: sevenMiB })) }),
    /cli_file_limit/);
  await mkdir(path.join(first.directory, 'config'));
  await writeFile(path.join(first.directory, 'config/credentials.json'), '{"access_token":"never-return"}');
  await writeFile(path.join(first.directory, 'unrelated.txt'), 'never-return');
  await writeFile(path.join(first.directory, 'output/attachment.bin'), content);
  const collected = await collectCliFiles(first.directory, first.manifest);
  assert.deepEqual(collected, [{ name: 'attachment.bin', mimeType: 'application/octet-stream',
    dataBase64: content.toString('base64'), byteLength: content.length }]); checks++;
  assert.deepEqual(await collectCliFiles(first.directory, noOutput.manifest), []); checks++;
  for (const [name, body, credentials, expected] of [
    ['.env', 'SYNTHETIC_SECRET=test', [], 'cli_file_output_invalid'],
    ['config.json', '{}', [], 'cli_file_output_invalid'],
    ['result.json', '{"accessToken":"synthetic-secret"}', [], 'cli_file_sensitive_output'],
    ['result.json', '{"HOME":"synthetic-path"}', [], 'cli_file_sensitive_output'],
    ['result.txt', 'API_SECRET=synthetic', [], 'cli_file_sensitive_output'],
    ['attachment.bin', 'prefix-synthetic-access-suffix', ['synthetic-access'], 'cli_file_sensitive_output'],
    ['attachment.bin', Buffer.from('synthetic-access').toString('base64'), ['synthetic-access'], 'cli_file_sensitive_output'],
  ]) {
    const test = await fixture({ collectFiles: true });
    await writeFile(path.join(test.directory, 'output', name), body);
    await rejects(() => collectCliFiles(test.directory, test.manifest, credentials), new RegExp(expected));
  }
  const large = await fixture({ collectFiles: true, maxFileBytes: 8 });
  await writeFile(path.join(large.directory, 'output/large.bin'), Buffer.alloc(9));
  await rejects(() => collectCliFiles(large.directory, large.manifest), /cli_file_limit/);
  const outputCount = await fixture({ collectFiles: true });
  for (let n = 0; n < 21; n++) await writeFile(path.join(outputCount.directory, `output/${n}.txt`), 'test');
  await rejects(() => collectCliFiles(outputCount.directory, outputCount.manifest), /cli_file_limit/);
  const outside = path.join(temp, 'outside'); await mkdir(outside);
  await writeFile(path.join(outside, 'private.txt'), 'synthetic-private');
  const linked = await fixture({ collectFiles: true });
  await symlink(outside, path.join(linked.directory, 'output/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await rejects(() => collectCliFiles(linked.directory, linked.manifest), /cli_file_output_invalid/);
  const rootLink = await fixture({});
  await symlink(outside, path.join(rootLink.directory, 'output'), process.platform === 'win32' ? 'junction' : 'dir');
  await rejects(() => collectCliFiles(rootLink.directory, { ...rootLink.manifest, collectFiles: true }), /cli_file_output_invalid/);
  const hardLink = await fixture({ collectFiles: true });
  await link(path.join(outside, 'private.txt'), path.join(hardLink.directory, 'output/linked.txt'));
  await rejects(() => collectCliFiles(hardLink.directory, hardLink.manifest), /cli_file_limit/);

  // Production runner lifecycle, but a controlled child process replaces the executable.
  const launches = [];
  let childProgram = 'const fs=require("node:fs"); fs.copyFileSync("input/test.txt","output/attachment.txt");' +
    'process.stdout.write(JSON.stringify({ok:true,data:{done:true}}));';
  const runner = loader({ 'node:child_process': { spawn: (binary, argv, options) => {
    launches.push({ binary, argv, options });
    return spawn(process.execPath, ['-e', childProgram], options);
  } } })('feishu-cli.runner.ts');
  const credentials = { appId: 'cli_synthetic', accessToken: 'synthetic-runner-access' };
  const options = { files: [{ name: 'test.txt', base64: content.toString('base64') }], collectFiles: true };
  const reply = await runner.runFeishuCli(['fixed', '--file', 'input/test.txt', '--output', 'output/attachment.txt'],
    credentials, options);
  assert.deepEqual(reply.output, { ok: true, data: { done: true } });
  assert.equal(reply.files[0].dataBase64, options.files[0].base64);
  assert.equal(reply.files[0].mimeType, 'text/plain');
  assert.ok(!fs.existsSync(launches.at(-1).options.cwd)); checks += 4;
  const launched = launches.length;
  await rejects(() => runner.runFeishuCli(['fixed', '--file', '../outside'], credentials, options), /cli_file_reference_invalid/);
  assert.equal(launches.length, launched); checks++;
  childProgram = 'process.stdout.write("Verified plain text");';
  await rejects(() => runner.runFeishuCli(['fixed'], credentials), /cli_invalid_output/);
  assert.deepEqual((await runner.runFeishuCli(['fixed'], credentials, { allowTextOutput: true })).output,
    { ok: true, data: { text: 'Verified plain text' } }); checks++;
  childProgram = 'process.stderr.write("synthetic-private-error");process.exitCode=1;';
  await rejects(() => runner.runFeishuCli(['fixed'], credentials, { allowTextOutput: true }), /cli_invalid_output/);
  childProgram = 'require("node:fs").writeFileSync("output/attachment.txt","File only");';
  const fileOnly = await runner.runFeishuCli(['fixed'], credentials, { collectFiles: true });
  assert.deepEqual(fileOnly.output, { ok: true, data: { text: '' } });
  assert.equal(fileOnly.files.length, 1); checks += 2;
  childProgram = 'const fs=require("node:fs"); fs.writeFileSync("output/token.txt",process.env.LARKSUITE_CLI_USER_ACCESS_TOKEN);' +
    'process.stdout.write(JSON.stringify({ok:true,data:{done:true}}));';
  await rejects(() => runner.runFeishuCli(['fixed'], credentials, { collectFiles: true }), /cli_file_sensitive_output/);
  childProgram = 'setInterval(()=>{},1000)';
  await rejects(() => runner.runFeishuCli(['fixed'], credentials, { ...options, timeoutMs: 50 }), /cli_timeout/);
  assert.ok(launches.every(({ options: item }) => !fs.existsSync(item.cwd))); checks++;
  console.log(`PASS: ${checks} file manifest/base64/path/budget, symlink/hardlink, sensitive-output, ` +
    'literal-text compatibility, runner collection-before-cleanup and timeout checks.');
} finally {
  const beneath = path.relative(path.resolve(os.tmpdir()), path.resolve(temp));
  assert.ok(beneath.startsWith('feishu-cli-files-test-') && !beneath.includes(path.sep));
  await rm(temp, { recursive: true, force: true });
}
