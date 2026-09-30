import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { helpChildren, helpFlags, projectCommand, projectMethod } from '../native/generate-catalog.mjs';

// Fixed official metadata, synthetic arguments only: no native process, credentials, or network.
globalThis.fetch = async () => { throw new Error('Network forbidden'); };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const moduleRoot = path.join(root, 'server/modules/feishu-tools');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'native/generated/api-catalog.json'), 'utf8'));
assert.equal(fs.readFileSync(path.join(moduleRoot, 'assets/api-catalog.json'), 'utf8'),
  fs.readFileSync(path.join(root, 'native/generated/api-catalog.json'), 'utf8'));
const compiled = ts.transpileModule(fs.readFileSync(path.join(moduleRoot, 'feishu-cli.catalog.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const module = { exports: {} };
const dependencies = createRequire(import.meta.url);
new Function('require', 'module', 'exports', '__dirname', compiled)((specifier) =>
  specifier === './feishu-cli.tasks' ? { object: (x) => Boolean(x) && typeof x === 'object' && !Array.isArray(x) }
    : dependencies(specifier), module, module.exports, moduleRoot);
const { discoverNative, buildNativePlan } = module.exports;
let checks = 0;
const check = (condition, name) => { assert.ok(condition, name); checks += 1; };
const make = (operation, args = {}, mode = 'write') => buildNativePlan({
  task: `native_${mode}`, arguments: { operation, arguments: args, userIntent: 'Synthetic explicit user request.' },
});
const deny = async (operation, args = {}, mode = 'write') => {
  await assert.rejects(make(operation, args, mode)); checks += 1;
};
const discover = (args = {}) => discoverNative({ task: 'native_catalog', arguments: args });
const find = (name) => catalog.methods.find((method) => method.name === name);

check(catalog.cliVersion === '1.0.95' && catalog.count === 818, 'pinned full leaf tree');
check(catalog.methods.filter((m) => m.kind === 'api').length === 251, 'all official API metadata');
check(catalog.methods.filter((m) => m.kind === 'shortcut').length === 532, 'all shortcuts');
check(catalog.methods.filter((m) => m.kind === 'utility').length === 35, 'all utility leaves');
check(new Set(catalog.methods.map((m) => m.schemaPath)).size === 818, 'unique exact operation identifiers');
check(catalog.executableCount === catalog.methods.filter((m) => m.availability === 'executable').length,
  'discoverable count is separate from executable count');
assert.deepEqual(helpChildren('Lark domains:\n  application Longest name\n  mail        Email\n\nFlags:\n'),
  ['application', 'mail']); checks += 1;
const flags = helpFlags('      --input_format string   format\n      --yes                   confirm\n      --names strings         list');
assert.deepEqual(flags.map((f) => [f.name, f.type]), [['input_format', 'string'], ['yes', 'boolean'], ['names', 'array']]);
checks += 1;
for (const method of catalog.methods.filter((m) => m.help)) {
  assert.deepEqual(projectCommand(method.command, method.help), method); checks += 1;
}
const apiSample = { name: 'new_domain new_resource read', inputSchema: { type: 'object', properties: {} },
  _meta: { risk: 'read', access_tokens: ['user'], scopes: ['a', 'b'], required_scopes: [] } };
assert.deepEqual(projectMethod(apiSample).method.scopeGroups, [['a', 'b']]); checks += 1;
assert.deepEqual(projectMethod({ ...apiSample, _meta: { ...apiSample._meta, required_scopes: ['a', 'c'] } })
  .method.scopeGroups, [['a'], ['c']]); checks += 1;
check(projectMethod({ ...apiSample, name: 'mail resource download_url' }).method.availability === 'executable',
  'filename is not treated as an execution risk');

const summary = await discover();
check(summary.ok && summary.data.total === 818 && summary.data.executableCount === catalog.executableCount,
  'compact catalog summary');
const first = await discover({ domain: 'mail', pageSize: 7 });
check(first.ok && first.data.count === 7 && first.data.hasMore, 'first bounded page');
const second = await discover({ domain: 'mail', pageSize: 7, pageToken: first.data.pageToken });
check(second.ok && second.data.operations[0].operation !== first.data.operations[0].operation, 'next page advances');
check(!(await discover({ domain: 'drive', pageToken: first.data.pageToken })).ok, 'cursor bound to filters');
check(!(await discover({ domain: 'mail', pageToken: 'v1_999999999999999999_0000000000000000' })).ok, 'invalid cursor');
check(!(await discover({ pageSize: 0 })).ok, 'nonpositive page size rejected');
const queried = await discover({ query: 'draft' });
check(queried.ok && queried.data.operations.some((x) => x.operation === 'mail.+draft-create'), 'query searches shortcuts');
const exact = await discover({ operation: 'mail.+triage' });
check(exact.ok && exact.data.scopeValidation === 'upstream' && exact.data.help.includes('Usage:'), 'exact typed flags and help');
check((await discover({ operation: 'auth.login' })).data.availability === 'host_managed', 'blocked entries remain discoverable');

const triage = await make('mail.+triage', { flags: { query: 'sample', max: 5 } }, 'read');
check(triage.argv.includes('--as=user') && triage.argv.includes('--format=json') && triage.argv.includes('--max=5'),
  'shortcut controlled argv and identity');
check(triage.runnerOptions.allowTextOutput === true, 'only shortcut plans permit successful text');
for (const name of ['as', 'profile', 'host', 'debug', 'user-access-token', 'jq']) {
  await deny('mail.+triage', { flags: { [name]: 'unsafe' } }, 'read');
}
await deny('mail.+triage', { flags: { max: '5' } }, 'read');
await deny('mail.+triage', { flags: { query: '@../secret' } }, 'read');
await deny('mail.+triage', { flags: { query: '-' } }, 'read');
await deny('mail.+triage', { flags: { query: 'x' }, arbitrary: true }, 'read');
const docs = await make('docs.+update', { flags: { command: 'append', doc: 'doxSynthetic', content: 'Safe plain text' } });
check(docs.argv.includes('--command=append'), 'business command flag is not shell execution');
const fields = await make('base.+field-create', { flags: { json: '{"name":"Example","type":"text"}' } });
check(fields.argv.includes('--json={"name":"Example","type":"text"}'), 'business JSON flag survives output flag filtering');
const whiteboard = await make('whiteboard.+update', { flags: { input_format: 'mermaid', source: 'graph LR; A-->B' } });
check(whiteboard.argv.includes('--input_format=mermaid'), 'underscore flag retained');
for (const content of ['<img src="/etc/passwd">', '![image](http://127.0.0.1)',
  '{"body":"\\u003cimg src=\\\"/etc/passwd\\\"\\u003e"}']) {
  await deny('docs.+update', { flags: { command: 'append', content } });
}
await deny('docs.+resource-update', { flags: { url: 'https://example.com/image.png' } });
await deny('mail.+draft-create', { flags: { 'body-file': 'input/body.html' } });

const upload = await make('im.images.create', { data: { image_type: 'message' }, file: { image: 'input/photo.png' } });
check(upload.argv.includes('image=input/photo.png') && !upload.runnerOptions, 'raw multipart uses manifest carrier');
for (const value of ['/etc/passwd', '../x', 'input/../x', 'input/.hidden', 'input/CON', 'https://example.com/x']) {
  await deny('im.images.create', { data: { image_type: 'message' }, file: { image: value } });
}
const attachment = await make('task.+upload-attachment', { flags: { file: 'input/report.pdf', 'resource-id': 'task_synthetic' } });
check(attachment.argv.includes('--file=input/report.pdf'), 'safe upload shortcut');
const remotePath = await make('apps.+file-get', { flags: { path: '/folder/resource' } }, 'read');
check(remotePath.argv.includes('--path=/folder/resource'), 'remote business path is not a local file');
const download = await make('drive.+download', { flags: { 'file-token': 'fileSynthetic' } }, 'read');
check(download.argv.includes('--file-token=fileSynthetic') && download.argv.includes('--output=output/result')
  && download.runnerOptions.collectFiles, 'resource token and bounded output');
const slides = await make('slides.+media-download', { flags: { 'file-token': 'fileSynthetic' } }, 'read');
check(slides.argv.includes('--output-dir=output'), 'multiple output alternatives choose controlled directory');
const sheet = await make('sheets.+table-get', { flags: { 'output-path': 'output/result.json' } }, 'read');
check(sheet.runnerOptions.collectFiles, 'output-path is controlled');
for (const operation of ['base.+record-get', 'base.+record-list', 'base.+record-search']) {
  const inline = await make(operation, { flags: {} }, 'read');
  check(inline.argv.includes('--format=json') && !inline.argv.some((arg) => arg.startsWith('--output='))
    && !inline.runnerOptions.collectFiles, `${operation} preserves inline JSON by default`);
  const artifact = await make(operation, { flags: { output: 'output/records.ndjson' } }, 'read');
  check(artifact.argv.includes('--format=ndjson') && artifact.argv.includes('--output=output/records.ndjson')
    && artifact.runnerOptions.collectFiles, `${operation} uses the official NDJSON artifact contract`);
  await deny(operation, { flags: { output: 'output/records.json' } }, 'read');
  await deny(operation, { flags: { 'jq-records': 'env' } }, 'read');
}
for (const operation of ['sheets.+cells-get', 'sheets.+csv-get', 'sheets.+table-get',
  'sheets.+workbook-export', 'slides.+xml-get', 'markdown.+fetch', 'apps.+db-sync-create']) {
  const plan = await make(operation, { flags: operation === 'apps.+db-sync-create' ? { yes: true } : {} },
    operation === 'apps.+db-sync-create' ? 'write' : 'read');
  check(!plan.argv.some((arg) => /^--output(?:-path)?=/u.test(arg)) && !plan.runnerOptions.collectFiles,
    `${operation} optional output is not forced`);
}
const database = await make('apps.+db-data-export', { flags: {} }, 'read');
check(database.argv.includes('--output=output/result.csv'), 'database export gets a documented extension');
const baseFiles = await make('base.+record-download-attachment', { flags: {} }, 'read');
check(baseFiles.argv.includes('--output=output'), 'multiple Base attachments use existing output directory');
const minutes = await make('minutes.+detail', { flags: {} }, 'read');
check(!minutes.runnerOptions.collectFiles, 'metadata-only minutes detail does not create files');
const transcript = await make('minutes.+detail', { flags: { transcript: true } }, 'read');
check(transcript.argv.includes('--output-dir=output'), 'transcript output is captured when requested');
await deny('drive.+download', { flags: { output: '../leak' } }, 'read');
await deny('apps.+member-add', { flags: { 'app-id': 'app_synthetic' } });
const member = await make('apps.+member-add', { flags: { 'app-id': 'app_synthetic', yes: true } });
check(member.argv.includes('--yes=true'), 'official permission confirmation flag');
await deny('apps.+access-scope-set', { flags: { scope: 'tenant' } });
const scope = await make('apps.+access-scope-set', { flags: { scope: 'tenant' }, confirmed: true });
check(!scope.argv.some((arg) => arg.includes('confirmed')) && scope.argv.includes('--scope=tenant'),
  'bridge confirmation never becomes an unknown CLI flag');
for (const name of ['auth login', 'api', 'apps +env-list', 'apps +openapi-key-get', 'drive +sync',
  'docs +script', 'event consume', 'mail +watch', 'im messages urgent_sms']) {
  const method = find(name); await deny(method.schemaPath, {}, method.mode);
}
console.log(`PASS: ${checks} catalog coverage, metadata, pagination, typed argv, confirmation, and file-boundary assertions.`);
