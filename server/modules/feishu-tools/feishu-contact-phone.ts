import type {
  FeishuPhoneCandidate, FeishuPhoneLookupRequest, FeishuPhoneLookupResult, FeishuToolResult,
} from '@shared/api.interface';
import type { CliTaskPlan, CliTaskRun } from './feishu-cli.tasks';
import type { FeishuCliReply } from './feishu-cli.runner';

const PHONE_OPEN_ID: RegExp = /^ou_[A-Za-z0-9_-]+$/u;
const PHONE_BASE_SCOPE_GROUP: string[] = [
  'contact:contact.base:readonly', 'contact:contact:access_as_app',
  'contact:contact:readonly', 'contact:contact:readonly_as_app',
];
const PHONE_FIELD_SCOPE: string = 'contact:user.phone:readonly';
type PhoneFailure = (reply: FeishuCliReply) => FeishuToolResult;

function phoneObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function phoneId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && PHONE_OPEN_ID.test(value);
}
function boundedPhoneText(value: unknown, maximum: number): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.length <= maximum);
}
function phoneText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
function phoneResult(result: FeishuPhoneLookupResult): FeishuToolResult {
  return { ok: true, data: { backend: 'official-cli', cliVersion: '1.0.95', result } };
}
function invalidPhoneResponse(): FeishuToolResult {
  return { ok: false, error: { code: 'contact_response_invalid',
    message: '飞书联系人响应的身份、目标或结构未通过校验，本次未返回手机号。' } };
}
function phoneDetailArguments(openId: string): string[] {
  if (!phoneId(openId)) throw new Error('native_arguments_invalid');
  // This is the only raw API path exposed by this task. The caller cannot set method, host or flags.
  return ['api', 'GET', '/open-apis/contact/v3/users/' + openId,
    '--params', JSON.stringify({ user_id_type: 'open_id', department_id_type: 'open_department_id' }),
    '--as', 'user', '--format', 'json'];
}
function buildContactPhonePlan(input: FeishuPhoneLookupRequest): CliTaskPlan {
  const scopeGroups: string[][] = [[...PHONE_BASE_SCOPE_GROUP], [PHONE_FIELD_SCOPE]];
  if (input.query) scopeGroups.push(['contact:user:search']);
  const argv: string[] = input.query
    ? ['contact', '+search-user', '--query', input.query, '--page-size', '30', '--as', 'user', '--format', 'json']
    : phoneDetailArguments(String(input.userId));
  return { argv, mode: 'read', scopeGroups, effectiveFilters: {}, phoneLookup: { ...input } };
}
function phonePermissionFailure(reply: FeishuCliReply, fail: PhoneFailure): FeishuToolResult {
  const error: Record<string, unknown> = phoneObject(reply.output) && phoneObject(reply.output.error)
    ? reply.output.error : {};
  // CLI v1.0.95 errs.Problem.Code is an integer on the error object, not a nested details field.
  if (typeof error.code === 'number' && [99991672, 99991679, 99991676].includes(error.code)) {
    return { ok: false, error: { code: 'feishu_phone_permission_missing',
      message: '飞书返回权限不足（' + String(error.code) + '）。请分别核对应用权限开通和用户增量授权；'
        + '应用权限开通后仍需重新授权，本次不会撤销现有连接。' } };
  }
  if (error.code === 41050) return { ok: false, error: { code: 'feishu_contact_not_visible',
    message: '目标联系人不在本次调用身份的可见范围内（41050）；未返回手机号。' } };
  if (error.code === 41012) return { ok: false, error: { code: 'feishu_contact_invalid_id',
    message: '飞书未接受该用户 ID（41012）；请核对目标标识，不据此推断离职或不存在。' } };
  return fail(reply);
}
function phoneData(reply: FeishuCliReply): Record<string, unknown> | undefined {
  if (reply.exitCode !== 0 || !phoneObject(reply.output) || reply.output.ok !== true
    || reply.output.identity !== 'user' || reply.output.error !== undefined || !phoneObject(reply.output.data)) {
    return undefined;
  }
  return reply.output.data;
}
function phoneCandidate(value: unknown): FeishuPhoneCandidate | undefined {
  if (!phoneObject(value) || !phoneId(value.open_id) || !boundedPhoneText(value.localized_name, 256)
    || !boundedPhoneText(value.enterprise_email, 320) || !boundedPhoneText(value.email, 320)
    || !boundedPhoneText(value.department, 2048)) return undefined;
  return { openId: value.open_id,
    ...(phoneText(value.localized_name) ? { name: phoneText(value.localized_name) } : {}),
    ...(phoneText(value.enterprise_email) ? { enterpriseEmail: phoneText(value.enterprise_email) } : {}),
    ...(phoneText(value.email) ? { email: phoneText(value.email) } : {}),
    ...(phoneText(value.department) ? { department: phoneText(value.department) } : {}),
  };
}
function phoneReplyError(reply: FeishuCliReply, fail: PhoneFailure): FeishuToolResult {
  return reply.exitCode !== 0 || (phoneObject(reply.output) && reply.output.ok === false)
    ? phonePermissionFailure(reply, fail) : invalidPhoneResponse();
}
async function executeContactPhone(plan: CliTaskPlan, run: CliTaskRun, fail: PhoneFailure): Promise<FeishuToolResult> {
  const lookup: FeishuPhoneLookupRequest | undefined = plan.phoneLookup;
  if (!lookup || plan.mode !== 'read') return invalidPhoneResponse();
  const deadline: number = Date.now() + 30000;
  let selectedId: string | undefined = lookup.userId;
  let reply: FeishuCliReply = await run(plan.argv, Math.max(1, deadline - Date.now()));
  let data: Record<string, unknown> | undefined = phoneData(reply);
  if (!data) return phoneReplyError(reply, fail);
  if (lookup.query) {
    if (!Array.isArray(data.users) || data.users.length > 30 || typeof data.has_more !== 'boolean') {
      return invalidPhoneResponse();
    }
    const candidates: FeishuPhoneCandidate[] = [];
    for (const value of data.users) {
      const candidate: FeishuPhoneCandidate | undefined = phoneCandidate(value);
      if (!candidate) return invalidPhoneResponse();
      candidates.push(candidate);
    }
    if (candidates.length !== 1 || data.has_more) return phoneResult({
      status: candidates.length === 0 && !data.has_more ? 'no_matching_user' : 'needs_disambiguation',
      candidates, hasMore: data.has_more,
      message: candidates.length === 0 && !data.has_more ? '本次搜索未返回匹配联系人；不代表该员工不存在。'
        : '请依据候选确认目标 open_id 或细化姓名/邮箱后再查询；尚未读取任何候选的手机号。',
    });
    selectedId = candidates[0].openId;
    const remaining: number = deadline - Date.now();
    if (remaining < 1000) return { ok: false, error: { code: 'contact_lookup_timeout',
      message: '联系人搜索耗时已达本次预算，尚未读取手机号；可使用已确认的 open_id 重试。' } };
    reply = await run(phoneDetailArguments(selectedId), remaining);
    data = phoneData(reply);
    if (!data) return phoneReplyError(reply, fail);
  }
  if (!phoneId(selectedId) || !phoneObject(data.user) || data.user.open_id !== selectedId) {
    return invalidPhoneResponse();
  }
  const profile: Record<string, unknown> = data.user;
  if (!boundedPhoneText(profile.name, 256) || !boundedPhoneText(profile.en_name, 256)
    || !boundedPhoneText(profile.mobile, 128)
    || (profile.mobile_visible !== undefined && typeof profile.mobile_visible !== 'boolean')) {
    return invalidPhoneResponse();
  }
  const name: string | undefined = phoneText(profile.name) ?? phoneText(profile.en_name);
  const user: { openId: string; name?: string; mobile?: string } = { openId: selectedId, ...(name ? { name } : {}) };
  if (profile.mobile_visible === false) return phoneResult({ status: 'phone_not_visible', user,
    message: '飞书返回 mobile_visible=false，本次不显示手机号。' });
  if (profile.mobile !== undefined && profile.mobile !== null && typeof profile.mobile !== 'string') {
    return invalidPhoneResponse();
  }
  const mobile: string | undefined = phoneText(profile.mobile);
  return phoneResult({ status: mobile ? 'phone_returned' : 'phone_not_returned',
    user: { ...user, ...(mobile ? { mobile } : {}) },
    message: mobile ? '手机号按飞书本次响应原样返回；若含掩码，不补全或推测。'
      : '飞书本次未返回非空手机号；不能据此判断号码不存在、未填写或被隐藏。' });
}

export { buildContactPhonePlan, executeContactPhone };
