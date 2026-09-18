import { z } from 'zod';
import { operation, pageSize, pageToken, resourceId, segment } from './feishu-tools.registry';
import type { FeishuOperation } from './feishu-tools.registry';

const DISCOVERY_OPERATIONS: FeishuOperation[] = [
  operation({
    id: 'calendar.calendars.list', title: '查找本人日历', mode: 'read',
    description: '列出已授权用户的日历，每页固定最多 50 条，供后续日程操作选择 calendarId。',
    scopeGroups: [['calendar:calendar:read', 'calendar:calendar:readonly', 'calendar:calendar']],
    inputSchema: z.object({ pageSize: z.literal(50).default(50), pageToken }).strict(),
    request: (value) => ({ method: 'GET', path: '/open-apis/calendar/v4/calendars',
      query: { page_size: value.pageSize, page_token: value.pageToken } }),
  }),
  operation({
    id: 'calendar.calendars.primary', title: '获取本人主日历', mode: 'read',
    description: '查询当前授权用户主日历；这是只读 POST，不允许指定其他操作用户。',
    scopeGroups: [['calendar:calendar:read', 'calendar:calendar:readonly']],
    inputSchema: z.object({}).strict(),
    request: () => ({ method: 'POST', path: '/open-apis/calendar/v4/calendars/primary' }),
  }),
  operation({
    id: 'contact.users.search', title: '按姓名或邮箱查找联系人', mode: 'read',
    description: '搜索本人可见联系人，最多 30 条；有更多结果时需收紧关键词。同名候选不能自动选作发送对象。',
    scopeGroups: [['contact:user:search']],
    inputSchema: z.object({ query: z.string().trim().min(1).max(50),
      pageSize: z.number().int().min(1).max(30).default(20) }).strict(),
    request: (value) => ({ method: 'POST', path: '/open-apis/contact/v3/users/search',
      query: { page_size: value.pageSize }, body: { query: value.query } }),
  }),
  operation({
    id: 'drive.documents.search', title: '搜索云文档与云空间文件', mode: 'read',
    description: '通过关键词发现 Docx、Sheets、Base、Wiki 与文件 ID；返回原生搜索结果，total 仅供参考。',
    scopeGroups: [['search:docs:read']],
    inputSchema: z.object({ query: z.string().trim().min(1).max(30), pageSize, pageToken }).strict(),
    request: (value) => ({ method: 'POST', path: '/open-apis/search/v2/doc_wiki/search',
      body: { query: value.query, page_size: value.pageSize, page_token: value.pageToken,
        doc_filter: {}, wiki_filter: {} } }),
  }),
  operation({
    id: 'base.tables.list', title: '读取多维表格数据表列表', mode: 'read',
    description: '发现指定 Base 内的数据表 ID，单次最多 50 条。',
    scopeGroups: [['base:table:read', 'bitable:app:readonly', 'bitable:app']],
    inputSchema: z.object({ appToken: resourceId, pageSize, pageToken }).strict(),
    request: (value) => ({ method: 'GET',
      path: `/open-apis/bitable/v1/apps/${segment(value.appToken)}/tables`,
      query: { page_size: value.pageSize, page_token: value.pageToken } }),
  }),
  operation({
    id: 'base.fields.list', title: '读取多维表格字段定义', mode: 'read',
    description: '读取指定数据表的字段名、ID 与类型，供记录读写前核对。',
    scopeGroups: [['base:field:read', 'bitable:app:readonly', 'bitable:app']],
    inputSchema: z.object({ appToken: resourceId, tableId: resourceId, pageSize, pageToken }).strict(),
    request: (value) => ({ method: 'GET',
      path: `/open-apis/bitable/v1/apps/${segment(value.appToken)}/tables/${segment(value.tableId)}/fields`,
      query: { page_size: value.pageSize, page_token: value.pageToken } }),
  }),
  operation({
    id: 'sheets.sheets.list', title: '读取工作表列表', mode: 'read',
    description: '读取指定电子表格的工作表 ID、名称和网格信息；该原生接口无分页，响应仍受 1 MiB 上限。',
    scopeGroups: [['sheets:spreadsheet:readonly', 'sheets:spreadsheet:read',
      'sheets:spreadsheet', 'drive:drive:readonly', 'drive:drive']],
    inputSchema: z.object({ spreadsheetToken: resourceId }).strict(),
    request: (value) => ({ method: 'GET',
      path: `/open-apis/sheets/v3/spreadsheets/${segment(value.spreadsheetToken)}/sheets/query` }),
  }),
];

export { DISCOVERY_OPERATIONS };
