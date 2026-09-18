import { z } from 'zod';
import { connectorDefaultTimezone } from '../../config/connector-deployment.config';
import { operation, pageSize, pageToken, resourceId, segment, shortText, timestampSeconds } from './feishu-tools.registry';
import type { FeishuOperation } from './feishu-tools.registry';

const CALENDAR_TASK_OPERATIONS: FeishuOperation[] = [
  operation({
    id: 'calendar.events.list', title: '读取日程列表', mode: 'read',
    description: '读取指定日历的一页日程；时间为 Unix 秒。',
    scopeGroups: [['calendar:calendar.event:read', 'calendar:calendar:readonly', 'calendar:calendar']],
    inputSchema: z.object({
      calendarId: resourceId, startTime: timestampSeconds, endTime: timestampSeconds,
      pageSize: z.literal(50).default(50), pageToken,
    }).strict().refine((value): boolean => Number(value.startTime) < Number(value.endTime), '时间范围无效'),
    request: (value) => ({ method: 'GET',
      path: `/open-apis/calendar/v4/calendars/${segment(value.calendarId)}/events`,
      query: { start_time: value.startTime, end_time: value.endTime,
        page_size: value.pageSize, page_token: value.pageToken } }),
  }),
  operation({
    id: 'calendar.events.get', title: '读取日程详情', mode: 'read',
    description: '读取指定日程详情。',
    scopeGroups: [['calendar:calendar.event:read', 'calendar:calendar:readonly', 'calendar:calendar']],
    inputSchema: z.object({ calendarId: resourceId, eventId: resourceId }).strict(),
    request: (value) => ({ method: 'GET',
      path: `/open-apis/calendar/v4/calendars/${segment(value.calendarId)}/events/${segment(value.eventId)}` }),
  }),
  operation({
    id: 'calendar.events.create', title: '创建日程', mode: 'write',
    description: '在指定日历创建定时日程，不添加参会人或视频会议。Unix 秒需 startTime < endTime。',
    scopeGroups: [['calendar:calendar.event:create', 'calendar:calendar']],
    inputSchema: z.object({
      calendarId: resourceId, summary: shortText, description: z.string().max(10000).optional(),
      startTime: timestampSeconds, endTime: timestampSeconds,
      timezone: z.string().min(1).max(80).default((): string => connectorDefaultTimezone()),
    }).strict().refine((value): boolean => Number(value.startTime) < Number(value.endTime), '时间范围无效'),
    request: (value) => ({ method: 'POST',
      path: `/open-apis/calendar/v4/calendars/${segment(value.calendarId)}/events`,
      body: { summary: value.summary, description: value.description,
        start_time: { timestamp: value.startTime, timezone: value.timezone },
        end_time: { timestamp: value.endTime, timezone: value.timezone },
        vchat: { vc_type: 'no_meeting' } } }),
  }),
  operation({
    id: 'calendar.events.update', title: '修改日程', mode: 'write',
    description: '只修改传入的标题、描述或成对的起止时间。通知选项须明确指定。',
    scopeGroups: [['calendar:calendar.event:update', 'calendar:calendar']],
    inputSchema: z.object({
      calendarId: resourceId, eventId: resourceId, summary: shortText.optional(),
      description: z.string().max(10000).optional(),
      startTime: timestampSeconds.optional(), endTime: timestampSeconds.optional(),
      timezone: z.string().min(1).max(80).optional(), notifyAttendees: z.boolean(),
    }).strict().refine((value): boolean => Boolean(value.summary || value.description !== undefined || value.startTime),
      '至少指定一个要修改的字段')
      .refine((value): boolean => (!value.startTime && !value.endTime) || Boolean(value.startTime && value.endTime &&
        Number(value.startTime) < Number(value.endTime)), '起止时间必须成对且顺序正确'),
    request: (value) => ({ method: 'PATCH',
      path: `/open-apis/calendar/v4/calendars/${segment(value.calendarId)}/events/${segment(value.eventId)}`,
      body: { summary: value.summary, description: value.description,
        start_time: value.startTime ? { timestamp: value.startTime, timezone: value.timezone } : undefined,
        end_time: value.endTime ? { timestamp: value.endTime, timezone: value.timezone } : undefined,
        need_notification: value.notifyAttendees } }),
  }),
  operation({
    id: 'calendar.events.delete', title: '删除日程', mode: 'write',
    description: '删除明确指定的日程，可能影响该日程的参与人。',
    scopeGroups: [['calendar:calendar.event:delete', 'calendar:calendar.event:writeonly', 'calendar:calendar']],
    inputSchema: z.object({ calendarId: resourceId, eventId: resourceId, notifyAttendees: z.boolean() }).strict(),
    request: (value) => ({ method: 'DELETE',
      path: `/open-apis/calendar/v4/calendars/${segment(value.calendarId)}/events/${segment(value.eventId)}`,
      query: { need_notification: value.notifyAttendees } }),
  }),
  operation({
    id: 'task.tasks.list', title: '读取任务列表', mode: 'read',
    description: '读取本人可访问的一页任务。', scopeGroups: [['task:task:read', 'task:task:write']],
    inputSchema: z.object({ pageSize, pageToken, completed: z.boolean().optional() }).strict(),
    request: (value) => ({ method: 'GET', path: '/open-apis/task/v2/tasks',
      query: { page_size: value.pageSize, page_token: value.pageToken,
        completed: value.completed, user_id_type: 'open_id' } }),
  }),
  operation({
    id: 'task.tasks.get', title: '读取任务详情', mode: 'read',
    description: '读取指定任务。', scopeGroups: [['task:task:read', 'task:task:write']],
    inputSchema: z.object({ taskGuid: resourceId }).strict(),
    request: (value) => ({ method: 'GET', path: `/open-apis/task/v2/tasks/${segment(value.taskGuid)}`,
      query: { user_id_type: 'open_id' } }),
  }),
  operation({
    id: 'task.tasks.create', title: '创建任务', mode: 'write',
    description: '创建标题与描述组成的任务；当前不实现指派他人、清单与提醒。',
    scopeGroups: [['task:task:write', 'task:task:writeonly']],
    inputSchema: z.object({ summary: shortText, description: z.string().max(10000).optional(),
      idempotencyKey: z.string().min(1).max(100) }).strict(),
    request: (value) => ({ method: 'POST', path: '/open-apis/task/v2/tasks',
      query: { user_id_type: 'open_id' },
      body: { summary: value.summary, description: value.description, client_token: value.idempotencyKey } }),
  }),
  operation({
    id: 'task.tasks.update', title: '修改或完成任务', mode: 'write',
    description: '仅更新传入字段；completedAt 使用 Unix 毫秒字符串，0 表示恢复未完成。',
    scopeGroups: [['task:task:write', 'task:task:writeonly']],
    inputSchema: z.object({
      taskGuid: resourceId, summary: shortText.optional(), description: z.string().max(10000).optional(),
      completedAt: z.string().regex(/^\d{1,14}$/u).optional(),
    }).strict().refine((value): boolean => value.summary !== undefined || value.description !== undefined ||
      value.completedAt !== undefined, '至少指定一个要修改的字段'),
    request: (value) => {
      const task: Record<string, unknown> = {};
      if (value.summary !== undefined) task.summary = value.summary;
      if (value.description !== undefined) task.description = value.description;
      if (value.completedAt !== undefined) task.completed_at = value.completedAt;
      return { method: 'PATCH', path: `/open-apis/task/v2/tasks/${segment(value.taskGuid)}`,
        query: { user_id_type: 'open_id' }, body: { task, update_fields: Object.keys(task) } };
    },
  }),
  operation({
    id: 'task.tasks.delete', title: '删除任务', mode: 'write',
    description: '删除明确指定的任务。', scopeGroups: [['task:task:delete', 'task:task:write']],
    inputSchema: z.object({ taskGuid: resourceId }).strict(),
    request: (value) => ({ method: 'DELETE', path: `/open-apis/task/v2/tasks/${segment(value.taskGuid)}` }),
  }),
];

export { CALENDAR_TASK_OPERATIONS };
