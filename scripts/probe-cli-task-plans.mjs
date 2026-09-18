import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Contract fixtures, based on CLI 1.0.95 help/schema; no CLI execution or network.
globalThis.fetch = async () => { throw new Error('Network forbidden.'); };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireDependency = createRequire(import.meta.url);
const cache = new Map();
function loadTs(file) {
  const absolute = path.resolve(file);
  if (cache.has(absolute)) return cache.get(absolute).exports;
  const loaded = { exports: {} };
  cache.set(absolute, loaded);
  const compiled = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  new Function('require', 'module', 'exports', compiled)(
    (specifier) => specifier.startsWith('.')
      ? loadTs(path.resolve(path.dirname(absolute), `${specifier}.ts`)) : requireDependency(specifier),
    loaded, loaded.exports,
  );
  return loaded.exports;
}
const moduleRoot = path.join(root, 'server/modules/feishu-tools');
const { buildCliTask, executeCliTask } = loadTs(path.join(moduleRoot, 'feishu-cli.tasks.ts'));
const { parseFeishuTaskRequest } = loadTs(path.join(moduleRoot, 'feishu-task-tools.contract.ts'));
const ownId = 'ou_synthetic_current';
const intent = '用户本次明确指定该草稿与内容，并要求执行相应动作。';
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks += 1; };
const make = (task, args) => buildCliTask(parseFeishuTaskRequest(task, args), ownId);
const value = (argv, name) => { const index = argv.indexOf(`--${name}`); return index < 0 ? undefined : argv[index + 1]; };

const search = make('search_messages', { senderIds: ['me', 'ou_other'],
  atChatterIds: ['me'], startTime: '2026-09-10T00:00:00+08:00', endTime: '2026-09-18T12:00:00+08:00' });
check(value(search.argv, 'sender') === `${ownId},ou_other`, 'me is deterministically resolved');
check(value(search.argv, 'at-chatter-ids') === ownId, 'at-me ID resolution');
check(value(search.argv, 'query') === '', 'empty query is not omitted/replaced for activity review');
check(value(search.argv, 'start') === '2026-09-10T00:00:00+08:00', 'message timezone boundary retained');
check(search.argv.includes('--no-reactions'), 'unneeded reaction fetch is disabled');

for (const target of [{ chatId: 'oc_synthetic' }, { userId: 'ou_synthetic' }, { threadId: 'omt_synthetic' }]) {
  const plan = make('read_message_context', { ...target, pageLimit: 3, pageSize: 25 });
  check(plan.argv.includes('--page-all'), 'chat/p2p/thread automatic paging is explicitly enabled');
  check(value(plan.argv, 'page-limit') === '3' && value(plan.argv, 'page-size') === '25', 'bounded pages retained');
}
const batch = make('read_message_context', { messageIds: ['om_one', 'om_two'] });
check(batch.argv[1] === '+messages-mget' && value(batch.argv, 'message-ids') === 'om_one,om_two', 'message IDs batch fetch');
check(!batch.argv.some((arg) => ['--page-all', '--page-size', '--page-limit', '--order', '--start'].includes(arg)),
  'mget is not given unsupported listing/time flags');

const docs = make('search_documents', { query: '', createdByMe: true, ownerIds: ['ou_owner'],
  timeField: 'created', startTime: '2026-09-01T00:00:00+08:00', pageLimit: 3 });
check(docs.argv.includes('--created-by-me') && value(docs.argv, 'creator-ids') === 'ou_owner',
  'original creator vs current owner mappings remain distinct');
check(value(docs.argv, 'created-since') === '2026-09-01T00:00:00+08:00', 'correct document time-field flag');
check(value(docs.argv, 'page-size') === '15' && docs.documentPages === 3, 'document pages are orchestrated externally');
check(!docs.argv.includes('--page-limit'), 'drive search is not given unsupported page-limit');
const hourly = make('search_documents', { timeField: 'edited',
  startTime: '2026-09-18T16:23:45+08:00', endTime: '2026-09-18T17:28:00+08:00' });
check(value(hourly.argv, 'edited-since') === '2026-09-18T08:00:00.000Z'
  && value(hourly.argv, 'edited-until') === '2026-09-18T10:00:00.000Z', 'hourly aggregate expands outward');
assert.throws(() => make('search_documents', { timeField: 'opened',
  startTime: '2026-01-01T00:00:00+08:00', endTime: '2026-09-01T00:00:00+08:00' }), /90_days/);
checks += 1;

const readDoc = make('read_document', { reference: 'https://sample.feishu.cn/wiki/token#share-anchor',
  scope: 'keyword', keyword: '部署|发布', contextBefore: 1, contextAfter: 2, detail: 'with-ids' });
check(readDoc.argv[0] === 'docs' && readDoc.argv[1] === '+fetch', 'enhanced reader uses official fetch shortcut');
check(value(readDoc.argv, 'doc').endsWith('#share-anchor'), 'preserves selected document anchor');
check(value(readDoc.argv, 'keyword') === '部署|发布' && value(readDoc.argv, 'context-after') === '2', 'partial-read flags retained');
check(value(readDoc.argv, 'doc-format') === 'xml', 'block-ID detail defaults to XML rather than downgraded Markdown');
const selectedDoc = make('read_document', { reference: 'https://sample.feishu.cn/wiki/token#share-anchor' });
check(!selectedDoc.argv.includes('--scope'), 'default fetch does not suppress the URL selection anchor');
for (const reference of ['https://evil.example/docx/x', 'http://sample.feishu.cn/docx/x',
  'https://user:pass@sample.feishu.cn/docx/x', 'https://sample.feishu.cn/sheets/x']) {
  assert.throws(() => make('read_document', { reference })); checks += 1;
}

const mail = make('search_mail', { from: 'alice@example.com', to: 'bob@example.com', subject: '验收',
  startTime: '2026-09-10T00:00:00+08:00', endTime: '2026-09-18T12:00:00+08:00', pageSize: 30, pageLimit: 4 });
const filter = JSON.parse(value(mail.argv, 'filter'));
check(filter.from[0] === 'alice@example.com' && filter.to[0] === 'bob@example.com', 'triage address filter arrays');
check(filter.time_range.start_time === '2026-09-10T00:00:00+08:00', 'mail time_range uses timezone ISO, not unix timestamp');
check(value(mail.argv, 'max') === '120', 'triage receives bounded max, not unsupported page-size/page-limit');
const readMail = make('read_mail', { messageId: 'synthetic==' });
check(readMail.argv.includes('--html=false'), 'message reader requests plain text');
const readScopes = ['mail:user_mailbox.message:readonly', 'mail:user_mailbox.message.address:read',
  'mail:user_mailbox.message.subject:read', 'mail:user_mailbox.message.body:read'];
check(readScopes.every((scope) => mail.scopeGroups.some((group) => group.length === 1 && group[0] === scope))
  && mail.scopeGroups.length === 4, 'all four independent mail read permissions');
check(JSON.stringify(readMail.scopeGroups) === JSON.stringify(mail.scopeGroups), 'mail body reader checks same four permissions');

const draft = make('create_mail_draft', { to: ['alice@example.com', 'bob@example.com'], cc: ['cc@example.com'],
  bcc: ['bcc@example.com'], subject: '测试草稿', body: '$(not-a-shell) <test>', userIntent: intent });
check(draft.argv.filter((arg) => arg === '--to').length === 2, 'CLI stringArray uses repeated recipient flags');
check(draft.argv.includes('--plain-text') && draft.argv.includes('--no-signature'), 'explicit plain-text, no implicit signature');
check(value(draft.argv, 'body') === '$(not-a-shell) <test>', 'body stays a single literal argument');
check(!draft.argv.includes('--yes') && draft.mode === 'write', 'creating draft does not imply send confirmation');
check(!('body' in draft.effectiveFilters) && !('userIntent' in draft.effectiveFilters), 'sensitive content not echoed as filters');
const send = make('send_mail_draft', { draftId: 'synthetic-draft', confirmed: true, userIntent: intent });
check(send.argv[1] === '+draft-send' && value(send.argv, 'draft-id') === 'synthetic-draft'
  && send.argv.includes('--yes'), 'confirmed send maps only to existing draft');
check(send.scopeGroups[0][0] === 'mail:user_mailbox.message:send', 'precise send scope');

const ok = (data) => ({ exitCode: 0, output: { ok: true, data } });
// Pinned mail_triage.go emits bare JSON (with optional notice); mail_message.go uses Runtime.Out.
const triageOutput = { messages: [
  { message_id: 'synthetic-mail-one', mailbox_id: 'me', subject: 'Synthetic search result', labels: 'INBOX' },
  { message_id: 'synthetic-mail-two', mailbox_id: 'me', error: 'metadata not returned by batch_get' },
], mailbox_id: 'me', count: 2, has_more: true, page_token: 'search:synthetic-cursor',
notice: 'Synthetic search notice.' };
let triageCalls = 0;
const triaged = await executeCliTask(mail, async () => {
  triageCalls += 1; return { exitCode: 0, output: triageOutput };
});
check(triaged.ok && triageCalls === 1, 'bare triage success needs no additional CLI call');
assert.deepEqual(triaged.data.result, triageOutput); checks += 1;
check(triaged.data.complete === false && triaged.data.hasMore === true
  && triaged.data.stopReason === 'configured_limit', 'bare triage preserves bounded paging semantics');
const emptyTriage = { messages: [], mailbox_id: 'me', count: 0, has_more: false, page_token: '' };
const empty = await executeCliTask(mail, async () => ({ exitCode: 0, output: emptyTriage }));
check(empty.ok && empty.data.complete === true && empty.data.result.count === 0, 'empty bare triage is successful');
for (const output of [
  { ...emptyTriage, ok: false },
  { ...emptyTriage, code: 4039, msg: 'Synthetic API error' },
  { ...emptyTriage, error: { code: 4039 } },
  { code: 4039, msg: 'Synthetic API error' },
  { ...emptyTriage, messages: null },
  { ...emptyTriage, messages: ['invalid'], count: 1 },
  { ...emptyTriage, messages: [{ message_id: '', mailbox_id: 'me' }], count: 1 },
  { ...emptyTriage, messages: [{ message_id: 'synthetic', mailbox_id: 'other' }], count: 1 },
  { ...emptyTriage, count: 1 },
  { ...emptyTriage, count: '0' },
  { ...emptyTriage, mailbox_id: '' },
  { ...emptyTriage, has_more: 'false' },
  { ...emptyTriage, page_token: null },
  { ...emptyTriage, notice: {} },
  {}, null, [],
]) {
  const rejected = await executeCliTask(mail, async () => ({ exitCode: 0, output }));
  check(!rejected.ok, 'malformed triage and explicit errors cannot become successful empty searches');
}
const unsuccessfulTriage = await executeCliTask(mail, async () => ({ exitCode: 1, output: emptyTriage }));
check(!unsuccessfulTriage.ok, 'bare triage requires successful process exit');
for (const plan of [readMail, draft, send, search, { ...mail, mode: 'write' }]) {
  const rejected = await executeCliTask(plan, async () => ({ exitCode: 0, output: emptyTriage }));
  check(!rejected.ok, 'bare triage compatibility does not extend to other commands or writes');
}
const messageOutput = { message_id: 'synthetic==', subject: 'Synthetic mail', body_plain_text: 'Synthetic content' };
const message = await executeCliTask(readMail, async () => ok(messageOutput));
check(message.ok, 'message reading retains its official success envelope');
assert.deepEqual(message.data.result, messageOutput); checks += 1;
const bareMessage = await executeCliTask(readMail, async () => ({ exitCode: 0, output: messageOutput }));
check(!bareMessage.ok, 'message reading does not accept an undocumented bare response');
// Official 1.0.95 +draft-create output shape: draft_id, optional reference/lint fields and two composition hints.
const createdDraft = { draft_id: 'synthetic-created-draft',
  reference: 'https://applink.feishu.cn/client/mail/open?draft_id=synthetic-created-draft',
  lint_applied: [{ code: 'synthetic_lint', message: 'Synthetic business detail retained.' }],
  compose_hint: 'Read skills/lark-mail-html.md before composing.',
  draft_edit_hint: 'Run another CLI command to edit the created draft.' };
let draftCalls = 0;
const created = await executeCliTask(draft, async () => { draftCalls += 1; return ok(createdDraft); });
check(created.ok && draftCalls === 1, 'successful draft normalization adds no CLI calls');
check(created.data.result.draft_id === createdDraft.draft_id
  && created.data.result.reference === createdDraft.reference, 'created draft ID and reference are preserved');
const expectedDraft = { ...createdDraft };
delete expectedDraft.compose_hint;
delete expectedDraft.draft_edit_hint;
assert.deepEqual(created.data.result, expectedDraft); checks += 1;
check('compose_hint' in createdDraft && 'draft_edit_hint' in createdDraft, 'normalization does not mutate CLI output');
const unchangedRead = await executeCliTask(readMail, async () => ok(createdDraft));
assert.deepEqual(unchangedRead.data.result, createdDraft); checks += 1;
const pages = [ok({ results: [{ token: 'one' }], has_more: true, page_token: 'cursor-one' }),
  ok({ results: [{ token: 'one' }, { token: 'two' }], has_more: false, page_token: '' })];
const argvCalls = [];
const merged = await executeCliTask(docs, async (argv) => { argvCalls.push(argv); return pages.shift(); });
check(argvCalls.length === 2 && value(argvCalls[1], 'page-token') === 'cursor-one', 'server consumes next page');
check(value(argvCalls[1], 'created-since') === value(argvCalls[0], 'created-since'), 'pagination freezes time/filter values');
check(merged.ok && merged.data.complete === true && merged.data.result.results.length === 2, 'merge and duplicate removal');

const failedPages = [ok({ results: [{ token: 'one' }], has_more: true, page_token: 'resume-one' }),
  { exitCode: 1, output: { ok: false, error: { subtype: 'server_error' } } }];
const partial = await executeCliTask(docs, async () => failedPages.shift());
check(partial.ok && partial.data.complete === false && partial.data.stopReason === 'next_page_failed', 'next-page failure explicitly partial');
check(partial.data.result.page_token === 'resume-one' && partial.data.result.results.length === 1, 'partial preserves evidence and resume cursor');

let repeated = 0;
const repeatedCursor = await executeCliTask(docs, async () => {
  repeated += 1; return ok({ results: [{ token: 'one' }], has_more: true, page_token: 'same-cursor' });
});
check(repeated === 2 && repeatedCursor.data.complete === false, 'repeated cursors cannot cause unbounded paging');
const single = make('search_documents', { query: 'test', pageLimit: 1 });
const capped = await executeCliTask(single, async () => ok({ results: [], has_more: true, page_token: 'next' }));
check(capped.data.complete === false && capped.data.stopReason === 'configured_limit', 'one page is never mislabeled exhaustive');
console.log(JSON.stringify({ status: 'passed', checks, cliVersion: '1.0.95', realCliExecutions: 0, realNetworkCalls: 0 }));
