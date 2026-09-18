import { z } from 'zod';
import { operation, pageSize, pageToken, resourceId, segment, shortText, timestampSeconds } from './feishu-tools.registry';
import type { FeishuOperation } from './feishu-tools.registry';

const MESSAGE_DOC_OPERATIONS: FeishuOperation[] = [
  operation({
    id: 'im.messages.search', title: '搜索消息', mode: 'read',
    description: '按关键词搜索一页消息；返回飞书原生搜索结果，不自动补全群名称或表情。',
    scopeGroups: [['search:message']],
    inputSchema: z.object({
      query: shortText, chatIds: z.array(resourceId).max(20).optional(),
      senderIds: z.array(resourceId).max(20).optional(),
      startTime: z.iso.datetime({ offset: true }).optional(),
      endTime: z.iso.datetime({ offset: true }).optional(), pageSize, pageToken,
    }).strict().refine((value): boolean => !value.startTime || !value.endTime ||
      Date.parse(value.startTime) <= Date.parse(value.endTime), '开始时间不能晚于结束时间'),
    request: (value) => ({
      method: 'POST', path: '/open-apis/im/v1/messages/search',
      query: { page_size: value.pageSize, page_token: value.pageToken },
      body: { query: value.query, filter: {
        chat_ids: value.chatIds, from_ids: value.senderIds,
        time_range: value.startTime || value.endTime
          ? { start_time: value.startTime, end_time: value.endTime } : undefined,
      } },
    }),
  }),
  operation({
    id: 'im.messages.history', title: '读取聊天历史', mode: 'read',
    description: '读取指定本人可访问会话的一页历史。不会自动读取所有聊天或跨页扫描。',
    scopeGroups: [
      ['im:message:readonly', 'im:message'],
      ['im:message.p2p_msg:get_as_user'], ['im:message.group_msg:get_as_user'],
    ],
    inputSchema: z.object({
      chatId: resourceId, pageSize, pageToken,
      startTime: timestampSeconds.optional(), endTime: timestampSeconds.optional(),
    }).strict().refine((value): boolean => !value.startTime || !value.endTime ||
      Number(value.startTime) <= Number(value.endTime), '开始时间不能晚于结束时间'),
    request: (value) => ({
      method: 'GET', path: '/open-apis/im/v1/messages', query: {
        container_id_type: 'chat', container_id: value.chatId,
        page_size: value.pageSize, page_token: value.pageToken,
        start_time: value.startTime, end_time: value.endTime, sort_type: 'ByCreateTimeAsc',
      },
    }),
  }),
  operation({
    id: 'im.messages.send_text', title: '以本人身份发送文字消息', mode: 'write',
    description: '仅在本次用户明确指定收件人与内容时发送；发件人是已授权用户。',
    scopeGroups: [['im:message'], ['im:message.send_as_user']],
    inputSchema: z.object({
      receiveIdType: z.enum(['open_id', 'chat_id']), receiveId: resourceId,
      text: z.string().min(1).max(10000), idempotencyKey: z.string().min(1).max(50),
    }).strict(),
    request: (value) => ({
      method: 'POST', path: '/open-apis/im/v1/messages',
      query: { receive_id_type: value.receiveIdType },
      body: { receive_id: value.receiveId, msg_type: 'text',
        content: JSON.stringify({ text: value.text }), uuid: value.idempotencyKey },
    }),
  }),
  operation({
    id: 'im.messages.reply_text', title: '以本人身份回复文字消息', mode: 'write',
    description: '仅在本次用户明确指定原消息与回复内容时执行。',
    scopeGroups: [['im:message'], ['im:message.send_as_user']],
    inputSchema: z.object({
      messageId: resourceId, text: z.string().min(1).max(10000),
      replyInThread: z.boolean().default(false), idempotencyKey: z.string().min(1).max(50),
    }).strict(),
    request: (value) => ({
      method: 'POST', path: `/open-apis/im/v1/messages/${segment(value.messageId)}/reply`,
      body: { msg_type: 'text', content: JSON.stringify({ text: value.text }),
        reply_in_thread: value.replyInThread, uuid: value.idempotencyKey },
    }),
  }),
  operation({
    id: 'docx.documents.read_text', title: '读取文档正文', mode: 'read',
    description: '读取原生 Docx 纯文本；不包含所有嵌入资源，也不使用 CLI 的 docs_ai XML 增强接口。',
    scopeGroups: [['docx:document:readonly', 'docx:document']],
    inputSchema: z.object({ documentId: resourceId }).strict(),
    request: (value) => ({ method: 'GET',
      path: `/open-apis/docx/v1/documents/${segment(value.documentId)}/raw_content` }),
  }),
  operation({
    id: 'docx.blocks.list', title: '读取文档块', mode: 'read',
    description: '按页读取文档块及块 ID，供精确编辑定位使用。',
    scopeGroups: [['docx:document:readonly', 'docx:document']],
    inputSchema: z.object({ documentId: resourceId, pageSize, pageToken }).strict(),
    request: (value) => ({ method: 'GET',
      path: `/open-apis/docx/v1/documents/${segment(value.documentId)}/blocks`,
      query: { page_size: value.pageSize, page_token: value.pageToken } }),
  }),
  operation({
    id: 'docx.documents.create', title: '创建文档', mode: 'write',
    description: '在指定目录创建空文档；正文通过后续添加段落操作写入。',
    scopeGroups: [['docx:document:create', 'docx:document']],
    inputSchema: z.object({ title: shortText, folderToken: resourceId.optional() }).strict(),
    request: (value) => ({ method: 'POST', path: '/open-apis/docx/v1/documents',
      body: { title: value.title, folder_token: value.folderToken } }),
  }),
  operation({
    id: 'docx.blocks.append_paragraphs', title: '添加文档段落', mode: 'write',
    description: '在明确的父块下添加最多 20 段纯文本；不覆盖整篇文档。',
    scopeGroups: [['docx:document:write_only', 'docx:document']],
    inputSchema: z.object({
      documentId: resourceId, parentBlockId: resourceId,
      paragraphs: z.array(z.string().min(1).max(5000)).min(1).max(20),
      revisionId: z.number().int().min(0).optional(),
    }).strict(),
    request: (value) => ({
      method: 'POST',
      path: `/open-apis/docx/v1/documents/${segment(value.documentId)}/blocks/${segment(value.parentBlockId)}/children`,
      query: { document_revision_id: value.revisionId },
      body: { index: -1, children: value.paragraphs.map((text: string) => ({
        block_type: 2, text: { elements: [{ text_run: { content: text } }] },
      })) },
    }),
  }),
  operation({
    id: 'docx.blocks.replace_text', title: '替换指定文档块文字', mode: 'write',
    description: '替换已定位块的全部文字元素；会重置该块文字格式。建议先读块并传入版本号。',
    scopeGroups: [['docx:document:write_only', 'docx:document']],
    inputSchema: z.object({
      documentId: resourceId, blockId: resourceId, text: z.string().min(1).max(10000),
      revisionId: z.number().int().min(0).optional(),
    }).strict(),
    request: (value) => ({ method: 'PATCH',
      path: `/open-apis/docx/v1/documents/${segment(value.documentId)}/blocks/${segment(value.blockId)}`,
      query: { document_revision_id: value.revisionId },
      body: { update_text_elements: { elements: [{ text_run: { content: value.text } }] } },
    }),
  }),
  operation({
    id: 'drive.files.list', title: '读取文件夹内容', mode: 'read',
    description: '列出指定非根文件夹的一页文件；根目录接口不支持分页，因此不提供隐式根目录查询。',
    scopeGroups: [['space:document:retrieve', 'drive:drive:readonly', 'drive:drive']],
    inputSchema: z.object({ folderToken: resourceId, pageSize, pageToken }).strict(),
    request: (value) => ({ method: 'GET', path: '/open-apis/drive/v1/files',
      query: { folder_token: value.folderToken, page_size: value.pageSize, page_token: value.pageToken } }),
  }),
  operation({
    id: 'drive.folders.create', title: '创建文件夹', mode: 'write',
    description: '在明确的父文件夹下创建文件夹。', scopeGroups: [['space:folder:create', 'drive:drive']],
    inputSchema: z.object({ name: shortText, folderToken: resourceId }).strict(),
    request: (value) => ({ method: 'POST', path: '/open-apis/drive/v1/files/create_folder',
      body: { name: value.name, folder_token: value.folderToken } }),
  }),
  operation({
    id: 'wiki.nodes.get', title: '读取知识库节点信息', mode: 'read',
    description: '解析 Wiki 节点与底层资源类型。正文需使用相应文档或表格工具读取。',
    scopeGroups: [['wiki:node:read', 'wiki:wiki:readonly', 'wiki:wiki']],
    inputSchema: z.object({ token: resourceId }).strict(),
    request: (value) => ({ method: 'GET', path: '/open-apis/wiki/v2/spaces/get_node',
      query: { token: value.token, obj_type: 'wiki' } }),
  }),
];

export { MESSAGE_DOC_OPERATIONS };
