import { isIP } from 'node:net';
import { z } from 'zod';
import type { FeishuToolResult } from '@shared/api.interface';
import type { FeishuCliOptions, FeishuCliReply } from './feishu-cli.runner';
import type { FeishuCliOutputFile } from './feishu-cli.files';

const ATTACHMENT_TOKEN: z.ZodString = z.string().min(1).max(512).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u);
const ATTACHMENT_MAIL_ID: z.ZodString = z.string().min(1).max(2048).regex(/^[A-Za-z0-9_+=/-]+$/u);
const ATTACHMENT_NAME = z.string().min(1).max(128).refine((name: string): boolean =>
  Buffer.byteLength(name, 'utf8') <= 240 && name.trim() === name && !name.startsWith('.') &&
  !/[\x00-\x1f\x7f<>:"/\\|?*]/u.test(name) && !/[. ]$/u.test(name) &&
  !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name), '文件名必须是安全的单个文件名。');
const attachmentRequestSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('mail'),
    messageId: ATTACHMENT_MAIL_ID,
    attachmentIds: z.array(ATTACHMENT_MAIL_ID).min(1).max(20)
      .refine((ids: string[]): boolean => new Set(ids).size === ids.length, '附件 ID 不能重复。'),
  }).strict(),
  z.object({
    source: z.literal('message'),
    messageId: z.string().max(512).regex(/^om_[A-Za-z0-9_-]+$/u),
    fileKey: ATTACHMENT_TOKEN,
    type: z.enum(['image', 'file']).describe('图片用 image；消息文件、音频或视频用 file。'),
    fileName: ATTACHMENT_NAME.optional(),
  }).strict(),
  z.object({ source: z.literal('drive'), fileToken: ATTACHMENT_TOKEN, fileName: ATTACHMENT_NAME.optional() }).strict(),
  z.object({
    source: z.literal('docx'), documentToken: ATTACHMENT_TOKEN,
    format: z.enum(['pdf', 'docx', 'markdown']).default('pdf'),
  }).strict(),
]);

// MCP tools/list requires a top-level object; keep branch validation internal rather than emitting top-level oneOf.
const attachmentDownloadSchema = z.object({
  source: z.enum(['mail', 'message', 'drive', 'docx']),
  messageId: ATTACHMENT_MAIL_ID.optional().describe('mail/message 必填：来源邮件或聊天消息 ID。'),
  attachmentIds: z.array(ATTACHMENT_MAIL_ID).min(1).max(20).optional().describe('mail 必填：邮件中的附件 ID。'),
  fileKey: ATTACHMENT_TOKEN.optional().describe('message 必填：消息中的图片或文件 key。'),
  type: z.enum(['image', 'file']).optional().describe('message 必填；图片用 image，其他消息文件用 file。'),
  fileToken: ATTACHMENT_TOKEN.optional().describe('drive 必填：已上传文件的 token，不适用于 Docx。'),
  documentToken: ATTACHMENT_TOKEN.optional().describe('docx 必填：文档 token。'),
  format: z.enum(['pdf', 'docx', 'markdown']).optional().describe('仅 docx，可省略时默认 pdf。'),
  fileName: ATTACHMENT_NAME.optional().describe('仅 message/drive：读取结果中的原文件名，仅用于下载展示。'),
}).strict().superRefine((input, context): void => {
  const parsed = attachmentRequestSchema.safeParse(input);
  if (!parsed.success) for (const issue of parsed.error.issues) {
    context.addIssue({ code: 'custom', message: issue.message, path: issue.path });
  }
});

type AttachmentDownloadRequest = z.infer<typeof attachmentRequestSchema>;
interface AttachmentPlan {
  request: AttachmentDownloadRequest;
  source: AttachmentDownloadRequest['source'];
  mode: 'read';
  scopeGroups: string[][];
  argv: string[];
  collectFiles: boolean;
}
type AttachmentRun = (argv: readonly string[], options: FeishuCliOptions) => Promise<FeishuCliReply>;
interface MailAttachmentLink { attachmentId: string; downloadUrl: string }

function buildAttachmentPlan(input: unknown): AttachmentPlan {
  const request: AttachmentDownloadRequest = attachmentRequestSchema.parse(input);
  let argv: string[];
  let scopeGroups: string[][];
  switch (request.source) {
    case 'mail':
      argv = ['mail', 'user_mailbox.message.attachments', 'download_url', '--params', JSON.stringify({
        user_mailbox_id: 'me', message_id: request.messageId, attachment_ids: request.attachmentIds,
      })];
      scopeGroups = [['mail:user_mailbox.message.body:read']];
      break;
    case 'message':
      argv = ['im', '+messages-resources-download', '--message-id', request.messageId,
        '--file-key', request.fileKey, '--type', request.type, '--output', 'output/attachment.bin'];
      scopeGroups = [['im:message:readonly', 'im:message']];
      break;
    case 'drive':
      argv = ['drive', '+download', '--file-token', request.fileToken, '--output', 'output/attachment.bin'];
      scopeGroups = [['drive:file:download']];
      break;
    case 'docx':
      argv = ['drive', '+export', '--token', request.documentToken, '--doc-type', 'docx',
        '--file-extension', request.format, '--file-name', 'attachment', '--output-dir', 'output'];
      scopeGroups = request.format === 'markdown'
        ? [['docx:document:readonly', 'docx:document']] : [['docs:document:export']];
      break;
  }
  argv.push('--as', 'user', '--format', 'json');
  return { request, source: request.source, mode: 'read', scopeGroups, argv,
    collectFiles: request.source !== 'mail' };
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failure(code: string, message: string, data?: unknown): FeishuToolResult {
  return { ok: false, ...(data === undefined ? {} : { data }), error: { code, message } };
}

// These links come only from the authenticated, fixed mail API response. Never fetch caller-supplied URLs.
// The API does not document a universal expiry or a complete CDN hostname list; neither is invented here.
function officialLink(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 16384 || /[\x00-\x20\x7f\\]/u.test(value)) return false;
  try {
    const url: URL = new URL(value);
    const hostname: string = url.hostname.toLowerCase();
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash &&
      (!url.port || url.port === '443') && hostname.includes('.') && !hostname.endsWith('.') &&
      !hostname.endsWith('.localhost') && !hostname.endsWith('.local') &&
      !hostname.endsWith('.internal') && !isIP(hostname) && !hostname.startsWith('[');
  } catch { return false; }
}

function mailResult(request: Extract<AttachmentDownloadRequest, { source: 'mail' }>, data: unknown): FeishuToolResult {
  const invalid = (): FeishuToolResult => failure('attachment_response_invalid', '飞书附件返回结果不完整或来源不匹配。');
  if (!object(data) || (data.download_urls !== undefined && !Array.isArray(data.download_urls)) ||
    (data.failed_ids !== undefined && !Array.isArray(data.failed_ids)) ||
    (data.failed_reasons !== undefined && !Array.isArray(data.failed_reasons))) return invalid();
  const requested: Set<string> = new Set(request.attachmentIds);
  const seen: Set<string> = new Set();
  const failed: Set<string> = new Set();
  const links: MailAttachmentLink[] = [];
  for (const item of (data.download_urls ?? []) as unknown[]) {
    if (!object(item) || typeof item.attachment_id !== 'string' || !requested.has(item.attachment_id) ||
      seen.has(item.attachment_id) || !officialLink(item.download_url)) return invalid();
    seen.add(item.attachment_id);
    links.push({ attachmentId: item.attachment_id, downloadUrl: item.download_url });
  }
  for (const id of (data.failed_ids ?? []) as unknown[]) {
    if (typeof id !== 'string' || !requested.has(id) || seen.has(id) || failed.has(id)) return invalid();
    failed.add(id);
  }
  for (const item of (data.failed_reasons ?? []) as unknown[]) {
    if (!object(item) || typeof item.attachment_id !== 'string' || !requested.has(item.attachment_id) ||
      seen.has(item.attachment_id)) return invalid();
    failed.add(item.attachment_id);
  }
  // An omitted requested attachment is unconfirmed, never silently counted as a successful batch.
  for (const id of requested) if (!seen.has(id)) failed.add(id);
  const result: Record<string, unknown> = { source: 'mail', downloaded: false, delivery: 'official_temporary_url',
    links, failedAttachmentIds: [...failed], complete: failed.size === 0,
    notice: '已获取飞书官方附件链接，尚未下载或读取文件内容；有效期与访问限制由飞书控制。' };
  if (failed.size) return failure(links.length ? 'attachment_partial_failure' : 'attachment_download_failed',
    '部分或全部附件未取得下载链接，请核对附件 ID 和当前用户的邮件权限。', result);
  return { ok: true, data: result };
}

function expectedFileName(request: Exclude<AttachmentDownloadRequest, { source: 'mail' }>): string {
  return request.source === 'docx'
    ? `attachment.${request.format === 'markdown' ? 'md' : request.format}` : 'attachment.bin';
}

function attachmentMime(bytes: Buffer, name?: string): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) return 'application/pdf';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).equals(Buffer.from('RIFF')) &&
    bytes.subarray(8, 12).equals(Buffer.from('WEBP'))) return 'image/webp';
  const extension: string = name?.split('.').at(-1)?.toLowerCase() ?? '';
  const types: Record<string, string> = {
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    zip: 'application/zip', txt: 'text/plain', csv: 'text/csv', md: 'text/markdown',
  };
  return types[extension] ?? 'application/octet-stream';
}

function binaryResult(
  request: Exclude<AttachmentDownloadRequest, { source: 'mail' }>, reply: FeishuCliReply,
): FeishuToolResult {
  const data: unknown = object(reply.output) ? reply.output.data : undefined;
  if (request.source === 'docx' && object(data) && data.ready === false) {
    const ticket: unknown = data.ticket;
    return failure('attachment_export_pending', '文档导出尚未完成，请续查现有导出任务；不要重复创建导出。', {
      source: 'docx', downloaded: false, complete: false,
      ...(typeof ticket === 'string' && ATTACHMENT_TOKEN.safeParse(ticket).success ? { ticket } : {}),
    });
  }
  if (!Array.isArray(reply.files) || reply.files.length !== 1) {
    return failure('attachment_file_unavailable', '未取得附件文件内容，不能确认下载完成。');
  }
  const file: FeishuCliOutputFile = reply.files[0];
  const maximum: number = 10 * 1024 * 1024;
  if (!object(file) || file.name !== expectedFileName(request) ||
    !Number.isSafeInteger(file.byteLength) || file.byteLength < 0 || file.byteLength > maximum ||
    typeof file.dataBase64 !== 'string' || file.dataBase64.length > 4 * Math.ceil(maximum / 3) ||
    (file.mimeType !== undefined && (typeof file.mimeType !== 'string' ||
      !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu.test(file.mimeType)))) {
    return failure('attachment_file_invalid', '附件文件未通过大小和内容完整性检查。');
  }
  const bytes: Buffer = Buffer.from(file.dataBase64, 'base64');
  if (bytes.length !== file.byteLength || bytes.toString('base64') !== file.dataBase64 ||
    (object(data) && data.size_bytes !== undefined && data.size_bytes !== file.byteLength)) {
    return failure('attachment_file_invalid', '附件文件未通过大小和内容完整性检查。');
  }
  const mimeType: string = request.source === 'docx'
    ? ({ pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      markdown: 'text/markdown' })[request.format] : attachmentMime(bytes, request.fileName);
  const name: string = request.source === 'docx' ? file.name : request.fileName ?? file.name;
  // Internal binary handoff only. The MCP layer must replace files with account-bound short-lived delivery links.
  return { ok: true, data: { source: request.source, downloaded: true, complete: true,
    files: [{ name, mimeType, byteLength: file.byteLength, dataBase64: file.dataBase64 }] } };
}

async function executeAttachmentDownload(plan: AttachmentPlan, run: AttachmentRun): Promise<FeishuToolResult> {
  // Stored delivery plans are data, not executable argv. Rebuild and check before invoking the runner.
  let canonical: AttachmentPlan;
  try {
    canonical = buildAttachmentPlan(plan.request);
    if (plan.source !== canonical.source || plan.mode !== 'read' || plan.collectFiles !== canonical.collectFiles ||
      JSON.stringify(plan.argv) !== JSON.stringify(canonical.argv) ||
      JSON.stringify(plan.scopeGroups) !== JSON.stringify(canonical.scopeGroups)) throw new Error('invalid_plan');
  } catch { return failure('attachment_request_invalid', '附件下载请求无效。'); }
  let reply: FeishuCliReply;
  try { reply = await run(canonical.argv, { collectFiles: canonical.collectFiles }); }
  catch (error: unknown) {
    return error instanceof Error && error.message === 'cli_timeout'
      ? failure('attachment_timeout', canonical.source === 'docx'
        ? '本次文档导出等待超时，未确认下载完成；请先查询导出状态，不要盲目重复导出。'
        : '附件下载超时，未确认下载完成。')
      : failure('attachment_download_failed', '附件下载未完成，请核对文件权限、大小及连接状态。');
  }
  if (reply.exitCode !== 0 || !object(reply.output) || reply.output.ok !== true) {
    return failure('cli_operation_failed', '官方飞书 CLI 未确认附件操作成功，请核对权限与来源。');
  }
  return canonical.request.source === 'mail'
    ? mailResult(canonical.request, reply.output.data) : binaryResult(canonical.request, reply);
}

export { attachmentDownloadSchema, buildAttachmentPlan, executeAttachmentDownload };
export type { AttachmentDownloadRequest, AttachmentPlan, AttachmentRun };
