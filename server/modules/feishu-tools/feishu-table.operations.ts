import { z } from 'zod';
import { operation, pageSize, pageToken, resourceId, segment } from './feishu-tools.registry';
import type { FeishuOperation } from './feishu-tools.registry';

interface RangeDimensions { rows: number; columns: number }
function rangeDimensions(value: string): RangeDimensions | undefined {
  const match: RegExpMatchArray | null = value.match(/^[A-Za-z0-9_-]{1,80}!([A-Z]{1,3})([1-9]\d{0,5})(?::([A-Z]{1,3})([1-9]\d{0,5}))?$/u);
  if (!match) return undefined;
  const column = (letters: string): number => Array.from(letters)
    .reduce((total: number, letter: string): number => total * 26 + letter.charCodeAt(0) - 64, 0);
  const rows: number = Number(match[4] || match[2]) - Number(match[2]) + 1;
  const columns: number = column(match[3] || match[1]) - column(match[1]) + 1;
  return rows > 0 && columns > 0 && rows * columns <= 1000 ? { rows, columns } : undefined;
}

const cellRange: z.ZodString = z.string().min(1).max(140)
  .refine((value: string): boolean => Boolean(rangeDimensions(value)),
    '必须是 sheetId!A1:B10 格式的明确区域，且最多 1000 个单元格');
const scalarCell = z.union([z.string().max(10000), z.number().finite(), z.boolean(), z.null()]);
const baseFields = z.record(z.string().min(1).max(100),
  z.union([scalarCell, z.array(z.string().max(1000)).max(50)]))
  .refine((value): boolean => Object.keys(value).length > 0 && Object.keys(value).length <= 50,
    '每次需要 1 至 50 个字段');

const TABLE_OPERATIONS: FeishuOperation[] = [
  operation({
    id: 'sheets.values.read', title: '读取表格单元格', mode: 'read',
    description: '读取明确的 A1 区域，最多 1000 格；不读取整表或高级图表。',
    scopeGroups: [['sheets:spreadsheet:readonly', 'sheets:spreadsheet', 'drive:drive:readonly', 'drive:drive']],
    inputSchema: z.object({ spreadsheetToken: resourceId, range: cellRange }).strict(),
    request: (value) => ({ method: 'GET',
      path: `/open-apis/sheets/v2/spreadsheets/${segment(value.spreadsheetToken)}/values/${segment(value.range)}` }),
  }),
  operation({
    id: 'sheets.values.write', title: '写入表格单元格', mode: 'write',
    description: '覆盖明确区域中的值，最多 1000 格；会替换对应原值和公式，不改变整表结构。',
    scopeGroups: [['sheets:spreadsheet', 'drive:drive']],
    inputSchema: z.object({ spreadsheetToken: resourceId, range: cellRange,
      values: z.array(z.array(scalarCell).min(1).max(1000)).min(1).max(1000),
    }).strict().refine((value): boolean => {
      const dimensions: RangeDimensions | undefined = rangeDimensions(value.range);
      return Boolean(dimensions && value.values.length <= dimensions.rows &&
        value.values.every((row): boolean => row.length === value.values[0].length && row.length <= dimensions.columns) &&
        value.values.length * value.values[0].length <= 1000);
    }, '值必须是矩形，且不能超过指定区域或 1000 格'),
    request: (value) => ({ method: 'PUT',
      path: `/open-apis/sheets/v2/spreadsheets/${segment(value.spreadsheetToken)}/values`,
      body: { valueRange: { range: value.range, values: value.values } } }),
  }),
  operation({
    id: 'base.records.list', title: '读取多维表格记录', mode: 'read',
    description: '读取指定数据表的一页记录；可选视图，不自动读取其它表。',
    scopeGroups: [['bitable:app:readonly', 'bitable:app']],
    inputSchema: z.object({ appToken: resourceId, tableId: resourceId,
      viewId: resourceId.optional(), pageSize, pageToken }).strict(),
    request: (value) => ({ method: 'GET',
      path: `/open-apis/bitable/v1/apps/${segment(value.appToken)}/tables/${segment(value.tableId)}/records`,
      query: { page_size: value.pageSize, page_token: value.pageToken, view_id: value.viewId,
        user_id_type: 'open_id' } }),
  }),
  operation({
    id: 'base.records.get', title: '读取多维表格单条记录', mode: 'read',
    description: '读取已明确 ID 的单条记录。', scopeGroups: [['bitable:app:readonly', 'bitable:app']],
    inputSchema: z.object({ appToken: resourceId, tableId: resourceId, recordId: resourceId }).strict(),
    request: (value) => ({ method: 'GET',
      path: `/open-apis/bitable/v1/apps/${segment(value.appToken)}/tables/${segment(value.tableId)}/records/${segment(value.recordId)}`,
      query: { user_id_type: 'open_id' } }),
  }),
  operation({
    id: 'base.records.create', title: '创建多维表格记录', mode: 'write',
    description: '新增一条记录，支持文本、数字、布尔、空值及字符串数组；复杂附件/人员字段暂不支持。',
    scopeGroups: [['base:record:create', 'bitable:app']],
    inputSchema: z.object({ appToken: resourceId, tableId: resourceId, fields: baseFields }).strict(),
    request: (value) => ({ method: 'POST',
      path: `/open-apis/bitable/v1/apps/${segment(value.appToken)}/tables/${segment(value.tableId)}/records`,
      query: { user_id_type: 'open_id' }, body: { fields: value.fields } }),
  }),
  operation({
    id: 'base.records.update', title: '修改多维表格记录', mode: 'write',
    description: '只修改指定记录中传入的字段；字段类型必须与该表真实结构一致。',
    scopeGroups: [['base:record:update', 'bitable:app']],
    inputSchema: z.object({ appToken: resourceId, tableId: resourceId, recordId: resourceId, fields: baseFields }).strict(),
    request: (value) => ({ method: 'PUT',
      path: `/open-apis/bitable/v1/apps/${segment(value.appToken)}/tables/${segment(value.tableId)}/records/${segment(value.recordId)}`,
      query: { user_id_type: 'open_id' }, body: { fields: value.fields } }),
  }),
  operation({
    id: 'base.records.delete', title: '删除多维表格记录', mode: 'write',
    description: '删除明确指定的一条记录；不提供批量删除。',
    scopeGroups: [['base:record:delete', 'bitable:app']],
    inputSchema: z.object({ appToken: resourceId, tableId: resourceId, recordId: resourceId }).strict(),
    request: (value) => ({ method: 'DELETE',
      path: `/open-apis/bitable/v1/apps/${segment(value.appToken)}/tables/${segment(value.tableId)}/records/${segment(value.recordId)}` }),
  }),
];

export { TABLE_OPERATIONS, rangeDimensions };
