import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Ajv from 'ajv';
import type { ValidateFunction } from 'ajv';
import type { FeishuToolResult, FeishuToolMode } from '@shared/api.interface';
import type { FeishuNativeRequest } from './feishu-task-tools.native';
import { object } from './feishu-cli.tasks';

interface NativeMethod {
  name: string;
  description: string;
  command: string[];
  schemaPath: string;
  service: string;
  mode: FeishuToolMode;
  scopeGroups: string[][];
  requiresExplicitConfirmation: boolean;
  inputSchema: Record<string, unknown>;
}
interface NativeCatalog { cliVersion: string; methods: NativeMethod[] }
interface NativePlan { argv: string[]; scopeGroups: string[][]; mode: FeishuToolMode }
const validators: Map<string, ValidateFunction> = new Map();
const ajv: Ajv = new Ajv({ strict: false, validateFormats: false, allErrors: false });
let catalogPromise: Promise<NativeCatalog> | undefined;

async function nativeCatalog(): Promise<NativeCatalog> {
  catalogPromise ??= readFile(join(__dirname, 'assets', 'api-catalog.json'), 'utf8').then((text: string) => {
    const value: unknown = JSON.parse(text);
    if (!object(value) || value.cliVersion !== '1.0.95' || !Array.isArray(value.methods)) {
      throw new Error('cli_catalog_invalid');
    }
    return value as unknown as NativeCatalog;
  });
  return catalogPromise;
}

async function discoverNative(request: Extract<FeishuNativeRequest, { task: 'native_catalog' }>): Promise<FeishuToolResult> {
  const catalog: NativeCatalog = await nativeCatalog();
  const args = request.arguments;
  if (args.operation) {
    const method: NativeMethod | undefined = catalog.methods.find((item: NativeMethod): boolean =>
      item.schemaPath === args.operation && (!args.domain || item.service === args.domain)
      && (!args.mode || item.mode === args.mode));
    if (!method) return { ok: false, error: { code: 'operation_not_available', message: '没有匹配的已注册用户操作。' } };
    return { ok: true, data: { operation: method.schemaPath, description: method.description, mode: method.mode,
      scopeGroups: method.scopeGroups, requiresExplicitConfirmation: method.requiresExplicitConfirmation,
      inputSchema: method.inputSchema, backend: 'official-cli', cliVersion: catalog.cliVersion } };
  }
  const methods: NativeMethod[] = catalog.methods.filter((item: NativeMethod): boolean =>
    (!args.domain || item.service === args.domain) && (!args.mode || item.mode === args.mode));
  if (!args.domain) {
    const domains: Map<string, number> = new Map();
    for (const method of methods) domains.set(method.service, (domains.get(method.service) ?? 0) + 1);
    return { ok: true, data: { cliVersion: catalog.cliVersion, domains: [...domains].map(([domain, count]) => ({ domain, count })),
      total: methods.length, next: '选择一个领域查看操作；选定操作后只读取该操作的完整参数。' } };
  }
  return { ok: true, data: { domain: args.domain, operations: methods.map((item: NativeMethod) => ({
    operation: item.schemaPath, description: item.description, mode: item.mode,
  })), count: methods.length } };
}

async function buildNativePlan(
  request: Extract<FeishuNativeRequest, { task: 'native_read' | 'native_write' }>,
): Promise<NativePlan> {
  const mode: FeishuToolMode = request.task === 'native_read' ? 'read' : 'write';
  const catalog: NativeCatalog = await nativeCatalog();
  const method: NativeMethod | undefined = catalog.methods.find((item: NativeMethod): boolean =>
    item.schemaPath === request.arguments.operation && item.mode === mode);
  if (!method) throw new Error('native_operation_not_available');
  const args: Record<string, unknown> = request.arguments.arguments;
  if (Object.keys(args).some((key: string): boolean => !['params', 'data', 'yes'].includes(key))) {
    throw new Error('native_arguments_invalid');
  }
  let validate: ValidateFunction | undefined = validators.get(method.schemaPath);
  if (!validate) {
    validate = ajv.compile(method.inputSchema);
    validators.set(method.schemaPath, validate);
  }
  if (!validate(args)) throw new Error('native_arguments_invalid');
  if (method.requiresExplicitConfirmation && args.yes !== true) throw new Error('native_confirmation_required');
  // Only the pinned catalog chooses the command. Values travel as JSON, never as flags or a shell string.
  if (method.command.length !== 3 || method.command.some((part: string): boolean =>
    !/^[a-z][a-z0-9_.]*$/u.test(part))) throw new Error('native_command_invalid');
  const argv: string[] = [...method.command, '--as', 'user', '--format', 'json'];
  if (args.params !== undefined) argv.push('--params', JSON.stringify(args.params));
  if (args.data !== undefined) argv.push('--data', JSON.stringify(args.data));
  if (method.requiresExplicitConfirmation && args.yes === true) argv.push('--yes');
  return { argv, scopeGroups: method.scopeGroups, mode };
}

export { discoverNative, buildNativePlan };
export type { NativePlan };
