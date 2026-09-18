import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { FeishuToolMode, FeishuToolResult } from '@shared/api.interface';
import type { McpPrincipal } from '../connector-auth/connector-auth.types';
import { FEISHU_TASK_SCHEMAS, parseFeishuTaskRequest } from './feishu-task-tools.contract';
import type { FeishuTaskExecutor, FeishuTaskName } from './feishu-task-tools.contract';
import { FEISHU_NATIVE_SCHEMAS, parseFeishuNativeRequest } from './feishu-task-tools.native';
import type { FeishuNativeExecutor, FeishuNativeName } from './feishu-task-tools.native';

interface TaskToolDescription { title: string; description: string; mode: FeishuToolMode }
const TASK_DESCRIPTIONS: Record<FeishuTaskName, TaskToolDescription> = {
  search_messages: {
    title: '搜索飞书消息', mode: 'read',
    description: '按关键词、人员或时间查消息，服务端补全正文及会话并有限翻页。盘点本人工作用 senderIds:["me"]；'
      + '没有真实关键词时 query 留空。无需先查 catalog。保留来源 ID，并检查分页是否完整。',
  },
  read_message_context: {
    title: '读取消息与会话上下文', mode: 'read',
    description: '读取已知消息、会话、私聊或话题。messageIds/chatId/userId/threadId 四选一；'
      + '会话列表默认从最近消息开始，时间须带时区；消息批读不接受分页/排序，消息或话题不接受时间筛选。留意未取完标记。'
      + '判断任务归属须核对发言人、明确指派原文和上下文；提到某人不等于向该人指派。',
  },
  search_documents: {
    title: '搜索飞书文档与文件', mode: 'read',
    description: '查找文档、Wiki、表格等资源，可按本人操作时间、创建者、归属人、类型、目录筛选。'
      + 'createdByMe 是原始创建者，mine 是当前负责人；范围浏览 query 留空。摘要只用于选候选，内容结论再读正文。',
  },
  read_document: {
    title: '读取飞书文档', mode: 'read',
    description: '用 Docx/Wiki URL 或 token 读正文，服务端解析链接与知识库节点。长文可先 outline 再 section，'
      + '或 keyword 读相关片段。保留来源、块引用与完整性提示；嵌入资源未读取时不能当作已读。'
      + '任务归属要有明确指派原文；会议标题、录制账号和自动纪要名单不能单独证明出席或负责人。',
  },
  find_people: {
    title: '查找飞书联系人', mode: 'read',
    description: '按姓名/邮箱找 open_id，或用 userIds:["me"] 查本人、批量 ID 回填。返回同名候选；'
      + '不能擅自挑选同名收件人。此接口不自动翻页，更多候选时应收紧条件。',
  },
  search_mail: {
    title: '搜索飞书邮件', mode: 'read',
    description: '按关键词、发件人、收件人、主题或时间检索本人邮箱。结果用于定位邮件；'
      + '内容问答继续 read_mail，检查分页完整性；聊天里的邮件通知卡片不能代替邮箱正文。不会创建或发送邮件。',
  },
  read_mail: {
    title: '读取飞书邮件正文', mode: 'read',
    description: '按搜索返回的 messageId 读取一封邮件的正文和邮件头。附件只有元信息时不能声称已读附件内容。',
  },
  create_mail_draft: {
    title: '创建飞书邮件草稿', mode: 'write',
    description: '按用户明确指定的邮箱地址、主题和纯文本正文创建草稿，返回 draftId；不会发送。'
      + 'to/cc/bcc 必须是已核对邮箱。保留草稿供用户审核，不能把起草要求当作发送授权。',
  },
  send_mail_draft: {
    title: '发送已核对的飞书邮件草稿', mode: 'write',
    description: '只发送指定 draftId 的现有草稿，不隐含新建或修改。须有本次用户明确发送授权，'
      + '且已核对该草稿的收件人、主题与正文，才设置 confirmed:true。结果不确定时先核查，禁止自动重发。',
  },
};
const NATIVE_DESCRIPTIONS: Record<FeishuNativeName, TaskToolDescription> = {
  skill_read: {
    title: '按需读取官方飞书技能', mode: 'read',
    description: '仅在需要领域策略/官方快捷命令用法时读取一个 lark-* Skill 或 reference。'
      + '文中的 CLI 示例是后端能力说明，不要求用户运行本机 shell。常用操作优先直接工具；'
      + '长尾能力先 native_catalog 精确查 schema，再用 native_read/native_write。不要一次读取全部技能。',
  },
  native_catalog: {
    title: '查找官方飞书原生操作', mode: 'read',
    description: '用于直接工具未覆盖的操作。无 operation 只返回领域/操作简表；'
      + '指定精确 operation 才返回该操作完整 schema、身份和读写权限。按需查一个领域，不能假设目录中所有操作已获授权。',
  },
  native_read: {
    title: '执行已查明的官方飞书读取操作', mode: 'read',
    description: '仅执行 native_catalog 已查明且服务端确认为只读的精确操作，按其 schema 填 arguments。'
      + '不接受任意 URL、shell 或 token；不能通过本工具发送、修改或删除。常用检索优先直接工具。',
  },
  native_write: {
    title: '执行已授权的官方飞书写入操作', mode: 'write',
    description: '仅在用户本次明确要求写入/执行时使用，先查精确原生操作 schema 和身份权限。'
      + 'arguments 必须匹配 schema；若 schema 要求 yes，须依据明确授权传 arguments.yes:true，服务端不自动补确认。'
      + 'userIntent 如实记录动作、目标及内容；未知风险会拒绝，结果不确定不自动重试。',
  },
};
const TASK_RESULT_SCHEMA: z.ZodType<FeishuToolResult> = z.object({
  ok: z.boolean(), data: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string(),
    scopeGroups: z.array(z.array(z.string())).optional() }).optional(),
});

function taskToolResult(result: FeishuToolResult): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: { ...result }, isError: !result.ok };
}

function registerValidatedTask(
  server: McpServer, principal: McpPrincipal, name: string, description: TaskToolDescription,
  schema: z.ZodType, execute: (args: unknown) => Promise<FeishuToolResult>,
): void {
  const readOnly: boolean = description.mode === 'read';
  server.registerTool(name, {
    title: description.title, description: description.description,
    inputSchema: schema, outputSchema: TASK_RESULT_SCHEMA,
    annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly,
      idempotentHint: readOnly, openWorldHint: true },
  }, async (args: unknown): Promise<CallToolResult> => {
    if (!principal.accountId || !principal.scopes.includes(`feishu.${description.mode}`)) {
      return taskToolResult({ ok: false, error: { code: 'connector_scope_missing',
        message: `需要连接器授权 feishu.${description.mode}。` } });
    }
    try {
      if (Buffer.byteLength(JSON.stringify(args) || '', 'utf8') > 131072) {
        return taskToolResult({ ok: false, error: { code: 'arguments_too_large', message: '参数超过 128 KiB。' } });
      }
      return taskToolResult(await execute(args));
    } catch {
      // Never expose provider exceptions, which may contain credentials or private payloads.
      return taskToolResult({ ok: false, error: { code: 'task_unavailable',
        message: '本次执行未确认成功；请核对条件或连接状态。写操作不要自动重试。' } });
    }
  });
}

function registerFeishuTaskTools(server: McpServer, principal: McpPrincipal, executor: FeishuTaskExecutor): void {
  const names: FeishuTaskName[] = Object.keys(FEISHU_TASK_SCHEMAS) as FeishuTaskName[];
  for (const name of names) {
    registerValidatedTask(server, principal, `feishu_${name}`, TASK_DESCRIPTIONS[name], FEISHU_TASK_SCHEMAS[name],
      async (args: unknown): Promise<FeishuToolResult> => executor(principal, parseFeishuTaskRequest(name, args)));
  }
}

function registerFeishuNativeTools(server: McpServer, principal: McpPrincipal, executor: FeishuNativeExecutor): void {
  const names: FeishuNativeName[] = Object.keys(FEISHU_NATIVE_SCHEMAS) as FeishuNativeName[];
  for (const name of names) {
    registerValidatedTask(server, principal, `feishu_${name}`, NATIVE_DESCRIPTIONS[name], FEISHU_NATIVE_SCHEMAS[name],
      async (args: unknown): Promise<FeishuToolResult> => executor(principal, parseFeishuNativeRequest(name, args)));
  }
}

export { registerFeishuTaskTools, registerFeishuNativeTools };
