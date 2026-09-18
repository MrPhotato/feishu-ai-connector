import { z } from 'zod';
import type { FeishuOperationCatalogEntry, FeishuToolMode } from '@shared/api.interface';

interface FeishuRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

interface FeishuOperation {
  id: string;
  title: string;
  description: string;
  mode: FeishuToolMode;
  scopeGroups: string[][];
  inputSchema: z.ZodType;
  request: (argumentsValue: unknown) => FeishuRequest;
}

interface OperationDefinition<T extends z.ZodType> {
  id: string;
  title: string;
  description: string;
  mode: FeishuToolMode;
  scopeGroups: string[][];
  inputSchema: T;
  request: (argumentsValue: z.output<T>) => FeishuRequest;
}

function operation<T extends z.ZodType>(definition: OperationDefinition<T>): FeishuOperation {
  return {
    ...definition,
    request: (argumentsValue: unknown): FeishuRequest =>
      definition.request(definition.inputSchema.parse(argumentsValue)),
  };
}

function catalogEntry(item: FeishuOperation): FeishuOperationCatalogEntry {
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    mode: item.mode,
    scopeGroups: item.scopeGroups,
    inputSchema: z.toJSONSchema(item.inputSchema, { target: 'draft-7' }),
  };
}

// Only registered templates can choose methods and paths. IDs are single segments.
function segment(value: string): string { return encodeURIComponent(value); }

const resourceId: z.ZodString = z.string().min(1).max(256)
  .regex(/^[A-Za-z0-9_@.-]+$/u)
  .refine((value: string): boolean => value !== '.' && value !== '..');
const pageSize: z.ZodDefault<z.ZodNumber> = z.number().int().min(1).max(50).default(20);
const pageToken: z.ZodOptional<z.ZodString> = z.string().min(1).max(4096).optional();
const timestampSeconds: z.ZodString = z.string().regex(/^\d{1,11}$/u);
const shortText: z.ZodString = z.string().min(1).max(1000);

export { operation, catalogEntry, segment, resourceId, pageSize, pageToken, timestampSeconds, shortText };
export type { FeishuRequest, FeishuOperation };
