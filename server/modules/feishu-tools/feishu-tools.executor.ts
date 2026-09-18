import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { FeishuToolMode, FeishuToolResult, FeishuToolsCatalog } from '@shared/api.interface';
import type { McpPrincipal } from '../connector-auth/connector-auth.types';
import { MESSAGE_DOC_OPERATIONS } from './feishu-message-doc.operations';
import { CALENDAR_TASK_OPERATIONS } from './feishu-calendar-task.operations';
import { TABLE_OPERATIONS } from './feishu-table.operations';
import { DISCOVERY_OPERATIONS } from './feishu-discovery.operations';
import { catalogEntry } from './feishu-tools.registry';
import type { FeishuOperation, FeishuRequest } from './feishu-tools.registry';
import { runFeishuCli } from './feishu-cli.runner';
import type { FeishuCliReply } from './feishu-cli.runner';
import { buildCliTask, executeCliTask, cliFailure } from './feishu-cli.tasks';
import { buildNativePlan, discoverNative } from './feishu-cli.catalog';
import { parseFeishuTaskRequest } from './feishu-task-tools.contract';
import type { FeishuTaskRequest } from './feishu-task-tools.contract';
import { parseFeishuNativeRequest } from './feishu-task-tools.native';
import type { FeishuNativeRequest } from './feishu-task-tools.native';

interface FeishuToolsStore {
  get(model: string, key: string): Promise<Record<string, unknown> | undefined>;
  put(model: string, key: string, value: Record<string, unknown>, expiresAt: number): Promise<void>;
  acquireLease(key: string, ttlSeconds?: number): Promise<string | undefined>;
  releaseLease(key: string, leaseToken: string): Promise<void>;
}
interface FeishuHttpRequest {
  url: string;
  method: FeishuRequest['method'];
  headers: Record<string, string>;
  query?: FeishuRequest['query'];
  body?: unknown;
}
interface FeishuHttpReply { status: number; body: unknown }
type FeishuTransport = (request: FeishuHttpRequest) => Promise<FeishuHttpReply>;
interface FeishuAppCredentials { clientId: string; clientSecret: string }
interface RequestAccount { accountId: string; account: Record<string, unknown> }
type NativeRunner = typeof runFeishuCli;

const FEISHU_OPERATIONS: FeishuOperation[] = [
  ...MESSAGE_DOC_OPERATIONS, ...CALENDAR_TASK_OPERATIONS, ...TABLE_OPERATIONS, ...DISCOVERY_OPERATIONS,
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function now(): number { return Math.floor(Date.now() / 1000); }
function failure(code: string, message: string, scopeGroups?: string[][]): FeishuToolResult {
  return { ok: false, error: { code, message, ...(scopeGroups ? { scopeGroups } : {}) } };
}
function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function validAccount(account: Record<string, unknown> | undefined, accountId: string): account is Record<string, unknown> {
  return Boolean(account && account.revoked !== true &&
    `${String(account.tenant_key)}:${String(account.open_id)}` === accountId &&
    typeof account.access_token === 'string' && account.access_token &&
    positive(account.access_expires_at) && typeof account.scope === 'string');
}
function sanitize(value: unknown, credentials: string[], depth: number = 0): unknown {
  if (depth > 40) return '[内容层级过深]';
  if (typeof value === 'string') {
    return credentials.reduce((result: string, credential: string): string =>
      credential ? result.split(credential).join('[REDACTED]') : result, value);
  }
  if (Array.isArray(value)) return value.map((item: unknown): unknown => sanitize(item, credentials, depth + 1));
  if (!isObject(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^(access_token|refresh_token|id_token|client_secret|authorization)$/iu.test(key)) continue;
    result[key] = sanitize(item, credentials, depth + 1);
  }
  return result;
}

class FeishuToolExecutor {
  constructor(
    private readonly store: FeishuToolsStore,
    private readonly transport: FeishuTransport,
    private readonly credentials: () => FeishuAppCredentials,
    private readonly requestAccount?: RequestAccount,
    private readonly nativeRunner: NativeRunner = runFeishuCli,
  ) {}

  forRequest(accountId: string, account: Record<string, unknown>): FeishuToolExecutor {
    return new FeishuToolExecutor(this.store, this.transport, this.credentials, { accountId, account }, this.nativeRunner);
  }

  async executeTask(principal: McpPrincipal, input: FeishuTaskRequest): Promise<FeishuToolResult> {
    try {
      const request: FeishuTaskRequest = parseFeishuTaskRequest(input.task, input.arguments);
      const plan = buildCliTask(request, principal.accountId.slice(principal.accountId.indexOf(':') + 1));
      const account: Record<string, unknown> | FeishuToolResult = await this.cliAccount(principal, plan.mode, plan.scopeGroups);
      if ('ok' in account) return account as FeishuToolResult;
      const action = async (): Promise<FeishuToolResult> => sanitize(await executeCliTask(plan,
        (argv: readonly string[], timeoutMs?: number): Promise<FeishuCliReply> => this.nativeRunner(argv, {
          appId: this.credentials().clientId, accessToken: String(account.access_token),
        }, { timeoutMs })), [String(account.access_token), String(account.refresh_token ?? '')]) as FeishuToolResult;
      const result: FeishuToolResult = plan.mode === 'write'
        ? await this.writeOnce(principal.accountId, request.task, request.arguments, action) : await action();
      return sanitize(result, [String(account.access_token), String(account.refresh_token ?? '')]) as FeishuToolResult;
    } catch (error: unknown) { return this.nativeFailure(error); }
  }

  async executeNative(principal: McpPrincipal, input: FeishuNativeRequest): Promise<FeishuToolResult> {
    try {
      const request: FeishuNativeRequest = parseFeishuNativeRequest(input.task, input.arguments);
      if (!principal.accountId || !principal.scopes.some((scope: string): boolean =>
        scope === 'feishu.read' || scope === 'feishu.write')) return failure('connector_scope_missing', '请先连接并授权。');
      if (request.task === 'native_catalog') return await discoverNative(request);
      if (request.task === 'skill_read') {
        const reply: FeishuCliReply = await this.nativeRunner(['skills', 'read', request.arguments.skill, '--json']);
        if (reply.exitCode !== 0 || !isObject(reply.output) || typeof reply.output.skill !== 'string' ||
          typeof reply.output.path !== 'string' || typeof reply.output.content !== 'string') return cliFailure(reply);
        return { ok: true, data: { source: 'official-cli-bundled-skill', cliVersion: '1.0.95',
          usage: '这是官方工作流参考。云端优先调用明确任务工具；原生命令先查 native_catalog，'
            + '再把 params/data JSON 交给 native_read/write。不要执行本机 shell、auth login 或更新命令。'
            + '缺权限通过连接器增量授权；引用的 references 可继续用 skill_read。',
          content: { skill: reply.output.skill, path: reply.output.path, content: reply.output.content } } };
      }
      const plan = await buildNativePlan(request);
      const account: Record<string, unknown> | FeishuToolResult = await this.cliAccount(principal, plan.mode, plan.scopeGroups);
      if ('ok' in account) return account as FeishuToolResult;
      const action = async (): Promise<FeishuToolResult> => {
        const reply: FeishuCliReply = await this.nativeRunner(plan.argv, {
          appId: this.credentials().clientId, accessToken: String(account.access_token),
        });
        if (reply.exitCode !== 0 || !isObject(reply.output) || reply.output.ok !== true) return cliFailure(reply);
        return { ok: true, data: { backend: 'official-cli', operation: request.arguments.operation,
          result: sanitize(reply.output.data, [String(account.access_token), String(account.refresh_token ?? '')]) } };
      };
      const result: FeishuToolResult = plan.mode === 'write'
        ? await this.writeOnce(principal.accountId, request.arguments.operation, request.arguments.arguments, action)
        : await action();
      return sanitize(result, [String(account.access_token), String(account.refresh_token ?? '')]) as FeishuToolResult;
    } catch (error: unknown) { return this.nativeFailure(error); }
  }

  private nativeFailure(error: unknown): FeishuToolResult {
    if (error instanceof z.ZodError) return failure('invalid_arguments',
      error.issues.slice(0, 4).map((issue): string => `${issue.path.join('.')}: ${issue.message}`).join('；'));
    const safeCodes: string[] = ['native_confirmation_required', 'native_arguments_invalid',
      'native_operation_not_available', 'native_command_invalid', 'cli_catalog_invalid',
      'opened_range_exceeds_90_days', 'document_reference_invalid', 'subject_must_be_one_line',
      'cli_arguments_limit', 'cli_timeout', 'cli_output_limit', 'cli_runtime_unavailable',
      'cli_cleanup_boundary', 'cli_invalid_output', 'cli_credentials_invalid'];
    const code: string = error instanceof Error && safeCodes.includes(error.message) ? error.message : 'cli_unavailable';
    const messages: Record<string, string> = {
      native_confirmation_required: '该操作要求明确确认后再传 arguments.yes=true；本次未执行。',
      native_arguments_invalid: '参数不符合官方定义，请读取该操作的 native_catalog 参数。',
      native_operation_not_available: '该原生操作未开放，或使用了错误的读写入口。',
      opened_range_exceeds_90_days: '按打开时间搜索时，请明确起始时间并将每段范围限制在 90 天以内。',
      document_reference_invalid: '请提供有效飞书 Docx/Wiki 链接或 token。',
      subject_must_be_one_line: '邮件主题不能包含换行。',
    };
    return failure(code, messages[code] ?? '官方 CLI 未完成调用；执行结果未确认，写入不要自动重试。');
  }

  private async cliAccount(
    principal: McpPrincipal, mode: FeishuToolMode, groups: string[][],
  ): Promise<Record<string, unknown> | FeishuToolResult> {
    if (!principal.accountId || !principal.scopes.includes(`feishu.${mode}`)) {
      return failure('connector_scope_missing', `需要连接器授权 feishu.${mode}。`);
    }
    const account: Record<string, unknown> | FeishuToolResult = await this.getAccount(principal.accountId);
    if ('ok' in account) return account;
    const scopes: Set<string> = new Set(String(account.scope).split(/[\s,]+/u).filter(Boolean));
    const missing: string[][] = groups.filter((group: string[]): boolean =>
      !group.some((scope: string): boolean => scopes.has(scope)));
    return missing.length ? failure('feishu_scope_missing',
      `缺少飞书用户权限：${missing.map((group: string[]): string => group.join(' 或 ')).join('；')}。请增量授权。`, missing) : account;
  }

  private async writeOnce(
    accountId: string, operationId: string, argumentsValue: Record<string, unknown>,
    action: () => Promise<FeishuToolResult>,
  ): Promise<FeishuToolResult> {
    const value: Record<string, unknown> = { ...argumentsValue };
    delete value.userIntent; delete value.idempotencyKey;
    // JSON objects with reordered keys describe the same operation; arrays remain ordered.
    const canonical: string = JSON.stringify([operationId, value], (_key: string, item: unknown): unknown =>
      isObject(item) ? Object.fromEntries(Object.entries(item).sort(([a]: [string, unknown], [b]: [string, unknown]) =>
        a < b ? -1 : a > b ? 1 : 0)) : item);
    const digest: string = createHash('sha256').update(canonical).digest('hex');
    const key: string = createHash('sha256').update(JSON.stringify([accountId, operationId,
      typeof argumentsValue.idempotencyKey === 'string' ? argumentsValue.idempotencyKey : digest])).digest('hex');
    const lease: string | undefined = await this.store.acquireLease(`cli-action:${key}`, 90);
    if (!lease) return failure('action_in_progress', '同一操作正在执行，请稍后核对结果。');
    try {
      const previous: Record<string, unknown> | undefined = await this.store.get('FeishuAction', key);
      if (previous) {
        if (previous.digest !== digest) return failure('idempotency_conflict', '该幂等标识已用于不同内容。');
        if (previous.status === 'complete' && isObject(previous.result)) return previous.result as unknown as FeishuToolResult;
        return failure('action_uncertain', '此前同一写入结果尚未确认，请先查询实际状态；本次未重复执行。');
      }
      const expires: number = now() + (argumentsValue.idempotencyKey ? 86400 : 600);
      await this.store.put('FeishuAction', key, { digest, status: 'pending' }, expires);
      const result: FeishuToolResult = await action();
      // Preserve pending on failure: transport errors and partial write outcomes must never replay automatically.
      if (result.ok) await this.store.put('FeishuAction', key, { digest, status: 'complete', result }, expires);
      return result;
    } finally { await this.store.releaseLease(`cli-action:${key}`, lease); }
  }

  catalog(mode?: FeishuToolMode): FeishuToolsCatalog {
    return { operations: FEISHU_OPERATIONS.filter((item: FeishuOperation): boolean => !mode || item.mode === mode)
      .map(catalogEntry) };
  }

  async execute(
    principal: McpPrincipal,
    mode: FeishuToolMode,
    operationId: string,
    argumentsValue: unknown,
    intent?: string,
  ): Promise<FeishuToolResult> {
    if (!principal.accountId || !principal.scopes.includes(`feishu.${mode}`)) {
      return failure('connector_scope_missing', `需要连接器授权 feishu.${mode}。`);
    }
    const item: FeishuOperation | undefined = FEISHU_OPERATIONS.find(
      (candidate: FeishuOperation): boolean => candidate.id === operationId && candidate.mode === mode,
    );
    if (!item) return failure('operation_not_available', '该操作未注册，或不能由当前读写入口执行。');
    if (mode === 'write' && (!intent || intent.trim().length < 8 || intent.length > 2000)) {
      return failure('user_intent_required', '需要本次用户明确要求的操作、对象与内容说明。');
    }
    let request: FeishuRequest;
    try {
      if (Buffer.byteLength(JSON.stringify(argumentsValue) || '', 'utf8') > 131072) {
        return failure('arguments_too_large', '单次操作参数不能超过 128 KiB。');
      }
      request = item.request(argumentsValue);
    } catch (error: unknown) {
      if (error instanceof z.ZodError) {
        return failure('invalid_arguments', error.issues.map((issue): string =>
          `${issue.path.join('.') || 'arguments'}: ${issue.message}`).slice(0, 5).join('；'));
      }
      return failure('invalid_arguments', '参数未通过校验。');
    }
    try {
      const accountResult: Record<string, unknown> | FeishuToolResult = await this.getAccount(principal.accountId);
      if ('ok' in accountResult) return accountResult as FeishuToolResult;
      const account: Record<string, unknown> = accountResult;
      const scopeSet: Set<string> = new Set(String(account.scope).split(/[\s,]+/u).filter(Boolean));
      const missing: string[][] = item.scopeGroups.filter(
        (group: string[]): boolean => !group.some((scope: string): boolean => scopeSet.has(scope)),
      );
      if (missing.length) return failure('feishu_scope_missing',
        `缺少飞书用户权限：${missing.map((group: string[]): string => group.join(' 或 ')).join('；')}。请增量授权。`, missing);
      const token: string = String(account.access_token);
      const reply: FeishuHttpReply = await this.transport({
        url: this.apiUrl(request.path), method: request.method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        query: request.query, body: request.body,
      });
      if (reply.status < 200 || reply.status >= 300 || !isObject(reply.body) || reply.body.code !== 0) {
        const apiCode: string = isObject(reply.body) && typeof reply.body.code === 'number'
          ? String(reply.body.code) : `HTTP_${reply.status}`;
        return failure(`feishu_${apiCode}`,
          '飞书未确认操作成功。请核对权限、对象状态与应用资格；写操作不要自动重试。', item.scopeGroups);
      }
      return { ok: true, data: sanitize(reply.body.data ?? {},
        [token, typeof account.refresh_token === 'string' ? account.refresh_token : '']) };
    } catch {
      // Axios/storage errors may include Authorization or sealed credential payloads.
      return failure('upstream_unavailable', '连接或凭证存储暂不可用；未确认执行结果，写操作不要自动重试。');
    }
  }

  private apiUrl(path: string): string {
    if (!path.startsWith('/open-apis/') || path.includes('?') || path.includes('#') || path.includes('\\')) {
      throw new Error('Unregistered path');
    }
    const url: URL = new URL(path, 'https://open.feishu.cn');
    if (url.origin !== 'https://open.feishu.cn' || url.pathname !== path) throw new Error('Invalid path');
    return url.toString();
  }

  private async getAccount(accountId: string): Promise<Record<string, unknown> | FeishuToolResult> {
    const account: Record<string, unknown> | undefined = this.requestAccount?.accountId === accountId
      ? this.requestAccount.account : await this.store.get('FeishuAccount', accountId);
    if (!validAccount(account, accountId)) return failure('feishu_reauthorization_required', '飞书授权不存在或已撤销，请重新授权。');
    if (account.refresh_pending !== true && Number(account.access_expires_at) > now() + 60) return account;
    if (typeof account.refresh_token !== 'string' || !account.refresh_token ||
      !positive(account.refresh_expires_at) || account.refresh_expires_at <= now() + 30) {
      return failure('feishu_reauthorization_required', '飞书授权已到期，且没有可用的刷新授权，请重新授权。');
    }
    return this.refreshAccount(accountId);
  }

  private async refreshAccount(accountId: string): Promise<Record<string, unknown> | FeishuToolResult> {
    const leaseKey: string = `feishu-refresh:${accountId}`;
    const lease: string | undefined = await this.store.acquireLease(leaseKey, 90);
    if (!lease) return failure('refresh_in_progress', '飞书授权正在刷新，请稍后再调用；本次没有重复刷新。');
    try {
      const account: Record<string, unknown> | undefined = await this.store.get('FeishuAccount', accountId);
      if (!validAccount(account, accountId)) return failure('feishu_reauthorization_required', '飞书授权已失效，请重新授权。');
      if (account.refresh_pending === true) return failure('refresh_uncertain', '刷新状态不确定，请重新授权。');
      if (Number(account.access_expires_at) > now() + 60) return account;
      if (typeof account.refresh_token !== 'string' || !positive(account.refresh_expires_at) ||
        account.refresh_expires_at <= now() + 30) return failure('feishu_reauthorization_required', '刷新授权已到期，请重新授权。');
      const app: FeishuAppCredentials = this.credentials();
      if (!app.clientId || !app.clientSecret) return failure('configuration_missing', '飞书连接尚未配置完成。');
      // Persist before spending a single-use refresh token; uncertain outcomes never replay it.
      await this.store.put('FeishuAccount', accountId, { ...account, refresh_pending: true }, account.refresh_expires_at);
      const reply: FeishuHttpReply = await this.transport({
        url: 'https://accounts.feishu.cn/oauth/v3/token', method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: {
          grant_type: 'refresh_token', client_id: app.clientId,
          client_secret: app.clientSecret, refresh_token: account.refresh_token,
        },
      });
      if (reply.status < 200 || reply.status >= 300 || !isObject(reply.body) || reply.body.code !== 0 ||
        reply.body.error !== undefined || typeof reply.body.access_token !== 'string' || !reply.body.access_token ||
        !positive(reply.body.expires_in) || typeof reply.body.scope !== 'string' ||
        typeof reply.body.refresh_token !== 'string' || !reply.body.refresh_token ||
        !positive(reply.body.refresh_token_expires_in)) {
        return failure('feishu_reauthorization_required', '飞书令牌刷新未完成，请重新授权；不会自动重复提交刷新。');
      }
      const refreshExpiresAt: number = now() + reply.body.refresh_token_expires_in;
      const updated: Record<string, unknown> = {
        ...account, access_token: reply.body.access_token, access_expires_at: now() + reply.body.expires_in,
        refresh_token: reply.body.refresh_token, refresh_expires_at: refreshExpiresAt,
        scope: reply.body.scope, refresh_pending: false, updated_at: now(),
      };
      await this.store.put('FeishuAccount', accountId, updated, refreshExpiresAt);
      return updated;
    } finally {
      // The lease is owner-checked by storage; release failure must never replay refresh.
      await this.store.releaseLease(leaseKey, lease);
    }
  }
}

export { FEISHU_OPERATIONS, FeishuToolExecutor, failure };
export type { FeishuToolsStore, FeishuHttpRequest, FeishuHttpReply, FeishuTransport, FeishuAppCredentials };
