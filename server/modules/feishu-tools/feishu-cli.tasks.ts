import type { FeishuToolMode, FeishuToolResult } from '@shared/api.interface';
import type { FeishuTaskRequest } from './feishu-task-tools.contract';
import type { FeishuCliReply } from './feishu-cli.runner';

interface CliTaskPlan {
  argv: string[];
  mode: FeishuToolMode;
  scopeGroups: string[][];
  effectiveFilters: Record<string, unknown>;
  documentPages?: number;
  expectedDraftId?: string;
}
type CliTaskRun = (argv: readonly string[], timeoutMs?: number) => Promise<FeishuCliReply>;

const MESSAGE_SCOPES: string[][] = [
  ['im:message:readonly', 'im:message'], ['im:message.p2p_msg:get_as_user'],
  ['im:message.group_msg:get_as_user'],
];
const MAIL_READ_SCOPES: string[][] = ['mail:user_mailbox.message:readonly',
  'mail:user_mailbox.message.address:read', 'mail:user_mailbox.message.subject:read',
  'mail:user_mailbox.message.body:read'].map((scope: string): string[] => [scope]);

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function flag(argv: string[], name: string, value: unknown): void {
  if (value === undefined || value === false) return;
  if (value === true) { argv.push(`--${name}`); return; }
  argv.push(`--${name}`, Array.isArray(value) ? value.join(',') : String(value));
}
function people(ids: string[] | undefined, openId: string): string[] | undefined {
  return ids?.map((id: string): string => id === 'me' ? openId : id);
}
function assertDocumentReference(reference: string): void {
  if (/^[A-Za-z0-9_-]+$/u.test(reference)) return;
  const url: URL = new URL(reference);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
    !['feishu.cn', 'larksuite.com', 'doubao.com'].some((host: string): boolean =>
      url.hostname === host || url.hostname.endsWith(`.${host}`)) ||
    !/^\/(docx|wiki)\/[A-Za-z0-9_-]+\/?$/u.test(url.pathname)) throw new Error('document_reference_invalid');
}

function buildCliTask(request: FeishuTaskRequest, openId: string): CliTaskPlan {
  let argv: string[];
  let scopes: string[][];
  const effective: Record<string, unknown> = { ...request.arguments };
  delete effective.userIntent;
  delete effective.body;
  delete effective.idempotencyKey;
  let documentPages: number | undefined;
  switch (request.task) {
    case 'search_messages': {
      const a = request.arguments;
      argv = ['im', '+messages-search', '--no-reactions'];
      for (const [name, value] of Object.entries({ query: a.query, sender: people(a.senderIds, openId),
        'chat-id': a.chatIds, start: a.startTime, end: a.endTime, 'chat-type': a.chatType,
        'sender-type': a.senderType, 'exclude-sender-type': a.excludeSenderType,
        'include-attachment-type': a.attachmentType, 'is-at-me': a.isAtMe,
        'at-chatter-ids': people(a.atChatterIds, openId), 'page-size': a.pageSize,
        'page-limit': a.pageLimit, 'page-token': a.pageToken })) flag(argv, name, value);
      scopes = [['search:message'], ...MESSAGE_SCOPES];
      effective.senderIds = people(a.senderIds, openId);
      break;
    }
    case 'read_message_context': {
      const a = request.arguments;
      argv = ['im', a.messageIds ? '+messages-mget' : a.threadId ? '+threads-messages-list' : '+chat-messages-list',
        '--no-reactions'];
      if (a.messageIds) flag(argv, 'message-ids', a.messageIds);
      else {
        // These listing shortcuts only auto-paginate when --page-all is present.
        // Unlike +messages-search, --page-limit alone is not an enable switch.
        argv.push('--page-all');
        flag(argv, 'thread', a.threadId);
        flag(argv, 'chat-id', a.chatId);
        flag(argv, 'user-id', a.userId === 'me' ? openId : a.userId);
        if (!a.threadId) { flag(argv, 'start', a.startTime); flag(argv, 'end', a.endTime); }
        flag(argv, 'order', a.order ?? 'desc'); flag(argv, 'page-size', a.pageSize ?? 50);
        flag(argv, 'page-limit', a.pageLimit ?? 2); flag(argv, 'page-token', a.pageToken);
      }
      scopes = MESSAGE_SCOPES;
      break;
    }
    case 'search_documents': {
      const a = request.arguments;
      argv = ['drive', '+search'];
      let start: string | undefined = a.startTime;
      let end: string | undefined = a.endTime;
      if (a.timeField === 'edited' || a.timeField === 'commented') {
        if (start) start = new Date(Math.floor(Date.parse(start) / 3600000) * 3600000).toISOString();
        if (end) end = new Date(Math.ceil(Date.parse(end) / 3600000) * 3600000).toISOString();
        effective.startTime = start; effective.endTime = end; effective.timePrecision = 'hour';
      }
      if (a.timeField === 'opened' && (!start ||
        (Date.parse(end ?? new Date().toISOString()) - Date.parse(start)) > 90 * 86400000)) {
        throw new Error('opened_range_exceeds_90_days');
      }
      for (const [name, value] of Object.entries({ query: a.query, mine: a.mine,
        'created-by-me': a.createdByMe, 'creator-ids': people(a.ownerIds, openId),
        'original-creator-ids': people(a.creatorIds, openId), 'sharer-ids': people(a.sharerIds, openId),
        'chat-ids': a.chatIds, 'doc-types': a.docTypes, 'folder-tokens': a.folderTokens,
        'space-ids': a.spaceIds, 'only-title': a.onlyTitle, 'only-comment': a.onlyComment,
        sort: a.sort, 'page-size': a.pageSize, 'page-token': a.pageToken })) flag(argv, name, value);
      if (a.timeField) { flag(argv, `${a.timeField}-since`, start); flag(argv, `${a.timeField}-until`, end); }
      scopes = [['search:docs:read']]; documentPages = a.pageLimit;
      break;
    }
    case 'read_document': {
      const a = request.arguments;
      assertDocumentReference(a.reference);
      argv = ['docs', '+fetch'];
      for (const [name, value] of Object.entries({ doc: a.reference, scope: a.scope, detail: a.detail,
        'doc-format': a.format, keyword: a.keyword, 'start-block-id': a.startBlockId,
        'end-block-id': a.endBlockId, 'context-before': a.contextBefore,
        'context-after': a.contextAfter, 'max-depth': a.maxDepth })) flag(argv, name, value);
      scopes = [['docx:document:readonly', 'docx:document']];
      break;
    }
    case 'find_people': {
      const a = request.arguments;
      argv = ['contact', '+search-user'];
      for (const [name, value] of Object.entries({ query: a.query, 'user-ids': a.userIds,
        'has-chatted': a.hasChatted, 'exclude-external-users': a.excludeExternalUsers,
        'page-size': a.pageSize })) flag(argv, name, value);
      scopes = a.query || !a.userIds ? [['contact:user:search']] : [['contact:user.base:readonly']];
      break;
    }
    case 'search_mail': {
      const a = request.arguments;
      argv = ['mail', '+triage', '--mailbox', 'me'];
      const filter: Record<string, unknown> = {};
      if (a.from) filter.from = [a.from];
      if (a.to) filter.to = [a.to];
      if (a.subject) filter.subject = a.subject;
      if (a.startTime || a.endTime) filter.time_range = { start_time: a.startTime, end_time: a.endTime };
      flag(argv, 'query', a.query); flag(argv, 'folder-id', a.folderId);
      if (Object.keys(filter).length) flag(argv, 'filter', JSON.stringify(filter));
      flag(argv, 'max', a.pageSize * a.pageLimit); flag(argv, 'page-token', a.pageToken);
      scopes = MAIL_READ_SCOPES;
      break;
    }
    case 'read_mail':
      argv = ['mail', '+message', '--mailbox', 'me', '--message-id', request.arguments.messageId, '--html=false'];
      scopes = MAIL_READ_SCOPES; break;
    case 'create_mail_draft': {
      const a = request.arguments;
      if (/[\r\n]/u.test(a.subject)) throw new Error('subject_must_be_one_line');
      argv = ['mail', '+draft-create', '--mailbox', 'me', '--plain-text', '--no-signature',
        '--subject', a.subject, '--body', a.body];
      for (const recipient of a.to) argv.push('--to', recipient);
      for (const recipient of a.cc ?? []) argv.push('--cc', recipient);
      for (const recipient of a.bcc ?? []) argv.push('--bcc', recipient);
      scopes = [['mail:user_mailbox:readonly'], ['mail:user_mailbox.message:modify']];
      break;
    }
    case 'send_mail_draft':
      argv = ['mail', '+draft-send', '--mailbox', 'me', '--draft-id', request.arguments.draftId, '--yes'];
      scopes = [['mail:user_mailbox.message:send']]; break;
  }
  argv.push('--as', 'user');
  if (request.task !== 'read_document') argv.push('--format', 'json');
  return { argv, mode: request.task === 'create_mail_draft' || request.task === 'send_mail_draft' ? 'write' : 'read',
    scopeGroups: scopes, effectiveFilters: effective, documentPages,
    ...(request.task === 'send_mail_draft' ? { expectedDraftId: request.arguments.draftId } : {}) };
}

function cliFailure(reply: FeishuCliReply): FeishuToolResult {
  const error: Record<string, unknown> = object(reply.output) && object(reply.output.error) ? reply.output.error : {};
  const subtype: string = typeof error.subtype === 'string' && /^[a-z_]+$/u.test(error.subtype)
    ? error.subtype : 'operation_failed';
  const scopes: string[] = Array.isArray(error.missing_scopes)
    ? error.missing_scopes.filter((scope: unknown): scope is string =>
      typeof scope === 'string' && /^[a-z0-9_.:-]+$/u.test(scope)) : [];
  return { ok: false, error: { code: `cli_${subtype}`,
    message: reply.exitCode === 10 ? '该操作需要明确确认；本次未执行。'
      : `官方飞书 CLI 未确认操作成功${typeof error.code === 'number' ? `（${error.code}）` : ''}。`
        + (scopes.length ? `缺少权限：${scopes.join('、')}。` : '请核对账号授权、对象权限及应用接口资格；写入不要盲目重试。'),
    ...(scopes.length ? { scopeGroups: [scopes] } : {}) } };
}

function isBareMailTriage(plan: CliTaskPlan, output: Record<string, unknown>): boolean {
  // CLI 1.0.95 mail_triage.go prints this JSON directly; +message still uses the ok/data envelope.
  const fields: string[] = ['messages', 'mailbox_id', 'count', 'has_more', 'page_token', 'notice'];
  return plan.mode === 'read' && plan.argv[0] === 'mail' && plan.argv[1] === '+triage' &&
    Object.keys(output).every((key: string) => fields.includes(key)) &&
    typeof output.mailbox_id === 'string' && output.mailbox_id.length > 0 &&
    Array.isArray(output.messages) && output.count === output.messages.length &&
    typeof output.has_more === 'boolean' && typeof output.page_token === 'string' &&
    (output.notice === undefined || typeof output.notice === 'string') &&
    output.messages.every((message: unknown) => object(message) &&
      typeof message.message_id === 'string' && message.message_id.length > 0 &&
      message.mailbox_id === output.mailbox_id);
}

async function executeCliTask(plan: CliTaskPlan, run: CliTaskRun): Promise<FeishuToolResult> {
  const deadline: number = Date.now() + 30000;
  let reply: FeishuCliReply = await run(plan.argv, Math.max(1, deadline - Date.now()));
  if (reply.exitCode !== 0 || !object(reply.output)) return cliFailure(reply);
  const bareTriage: boolean = isBareMailTriage(plan, reply.output);
  if (reply.output.ok !== true && !bareTriage) return cliFailure(reply);
  let data: unknown = bareTriage ? reply.output : reply.output.data;
  if (plan.argv[0] === 'mail' && plan.argv[1] === '+draft-create' && object(data)) {
    // The named tool has already created the requested plain-text draft; CLI composition tips are redundant.
    const draftData: Record<string, unknown> = { ...data };
    delete draftData.compose_hint;
    delete draftData.draft_edit_hint;
    data = draftData;
  }
  // Pinned CLI batchSendOutput: shortcuts/mail/mail_draft_send.go (v1.0.95).
  // A generic success envelope alone does not prove this particular draft was sent.
  if (plan.expectedDraftId && (!object(data) || data.total !== 1 || data.success_count !== 1 ||
    data.failure_count !== 0 || data.aborted === true || data.abort_error !== undefined ||
    (data.failed !== undefined && (!Array.isArray(data.failed) || data.failed.length !== 0)) ||
    !Array.isArray(data.sent) || data.sent.length !== 1 || !object(data.sent[0]) ||
    data.sent[0].draft_id !== plan.expectedDraftId)) {
    return { ok: false, error: { code: 'cli_draft_send_unconfirmed',
      message: '未确认指定草稿全部发送成功，请先核对发件箱或发送状态；本次不会自动重试。' } };
  }
  let pages: number = 1;
  if (plan.documentPages && object(data)) {
    let page: Record<string, unknown> = data;
    const results: unknown[] = Array.isArray(page.results) ? [...page.results] : [];
    const cursors: Set<string> = new Set();
    while (page.has_more === true && typeof page.page_token === 'string' && page.page_token &&
      pages < plan.documentPages && Date.now() < deadline - 5000) {
      if (cursors.has(page.page_token)) break;
      cursors.add(page.page_token);
      const argv: string[] = [...plan.argv];
      const index: number = argv.indexOf('--page-token');
      if (index >= 0) argv.splice(index, 2);
      argv.push('--page-token', page.page_token);
      reply = await run(argv, Math.max(1, deadline - Date.now()));
      if (reply.exitCode !== 0 || !object(reply.output) || reply.output.ok !== true || !object(reply.output.data)) {
        return { ok: true, data: { backend: 'official-cli', result: { ...page, results },
          complete: false, stopReason: 'next_page_failed', effectiveFilters: plan.effectiveFilters } };
      }
      page = reply.output.data; pages++;
      if (Array.isArray(page.results)) results.push(...page.results);
    }
    const unique: Map<string, unknown> = new Map();
    for (const result of results) unique.set(JSON.stringify(result), result);
    data = { ...page, results: [...unique.values()], pagesFetched: pages };
  }
  const hasMore: unknown = object(data) ? data.has_more : undefined;
  return { ok: true, data: { backend: 'official-cli', cliVersion: '1.0.95', result: data,
    effectiveFilters: plan.effectiveFilters,
    ...(typeof hasMore === 'boolean' ? { complete: !hasMore, hasMore,
      ...(hasMore ? { stopReason: 'configured_limit' } : {}) } : { completeness: 'see_result' }) } };
}

export { buildCliTask, executeCliTask, cliFailure, object };
export type { CliTaskPlan, CliTaskRun };
