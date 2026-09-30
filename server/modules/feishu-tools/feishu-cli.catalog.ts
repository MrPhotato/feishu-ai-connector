import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
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
  permissionChange?: boolean;
  requiresBridgeConfirmation?: boolean;
  inputSchema: Record<string, unknown>;
  kind?: 'api' | 'shortcut' | 'utility';
  availability?: string;
  reason?: string;
  reasonDetail?: string;
  alternative?: string;
  scopeValidation?: string;
  flags?: { name: string; type: string; description: string }[];
  fileFlags?: string[];
  outputFlags?: string[];
  managedFlags?: string[];
  blockedFlags?: { name: string; reason: string }[];
  supportsAs?: boolean;
  supportsFormat?: boolean;
  help?: string;
}
interface NativeCatalog { cliVersion: string; methods: NativeMethod[] }
interface NativePlan {
  argv: string[]; scopeGroups: string[][]; mode: FeishuToolMode;
  runnerOptions?: { collectFiles?: boolean; allowTextOutput?: boolean };
}
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
      ...(method.permissionChange ? { permissionChange: true } : {}),
      kind: method.kind ?? 'api', availability: method.availability ?? 'executable', reason: method.reason,
      reasonDetail: method.reasonDetail, alternative: method.alternative,
      scopeValidation: method.scopeValidation ?? 'declared', inputSchema: method.inputSchema,
      ...(method.help ? { help: method.help, managedFlags: method.managedFlags, blockedFlags: method.blockedFlags } : {}),
      backend: 'official-cli', cliVersion: catalog.cliVersion } };
  }
  const query: string = args.query?.trim().toLowerCase() ?? '';
  const methods: NativeMethod[] = catalog.methods.filter((item: NativeMethod): boolean =>
    (!args.domain || item.service === args.domain) && (!args.mode || item.mode === args.mode) &&
    (!query || `${item.schemaPath} ${item.description}`.toLowerCase().includes(query)));
  if (!args.domain && !query && !args.pageToken && args.pageSize === undefined) {
    const domains: Map<string, number> = new Map();
    for (const method of methods) domains.set(method.service, (domains.get(method.service) ?? 0) + 1);
    return { ok: true, data: { cliVersion: catalog.cliVersion, domains: [...domains].map(([domain, count]) => ({ domain, count })),
      total: methods.length, executableCount: methods.filter((item: NativeMethod): boolean =>
        !item.availability || item.availability === 'executable').length,
      next: '按 query 搜索或选择领域；目录包括有明确限制的命令，执行前读取精确 schema 与 availability。' } };
  }
  const fingerprint: string = createHash('sha256').update(JSON.stringify([args.domain, args.mode, query]))
    .digest('hex').slice(0, 16);
  let offset: number = 0;
  if (args.pageToken) {
    const match: RegExpExecArray | null = /^v1_(\d+)_([a-f0-9]{16})$/u.exec(args.pageToken);
    if (!match || match[2] !== fingerprint || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) > methods.length) {
      return { ok: false, error: { code: 'invalid_page_token', message: '分页参数与当前目录查询不匹配。' } };
    }
    offset = Number(match[1]);
  }
  const pageSize: number = args.pageSize ?? 30;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    return { ok: false, error: { code: 'invalid_page_size', message: '每页数量应为 1 至 100。' } };
  }
  const page: NativeMethod[] = methods.slice(offset, offset + pageSize);
  const hasMore: boolean = offset + page.length < methods.length;
  return { ok: true, data: { domain: args.domain, query, operations: page.map((item: NativeMethod) => ({
    operation: item.schemaPath, description: item.description, mode: item.mode,
    kind: item.kind ?? 'api', availability: item.availability ?? 'executable', reason: item.reason,
    reasonDetail: item.reasonDetail, alternative: item.alternative,
  })), count: page.length, total: methods.length, hasMore,
  pageToken: hasMore ? `v1_${offset + page.length}_${fingerprint}` : '', complete: !hasMore } };
}

function safeFilePath(value: string, direction: 'input' | 'output'): boolean {
  const parts: string[] = value.split('/');
  return parts.length === 2 && parts[0] === direction && Boolean(parts[1]) &&
    parts[1].length <= 128 && parts[1].trim() === parts[1] && !parts[1].startsWith('.') && !/[. ]$/u.test(parts[1]) &&
    !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(parts[1]) &&
    !/[\x00-\x1f\x7f<>:"\\|?*]/u.test(parts[1]);
}

function safeInlineValue(value: string): boolean {
  // The CLI is not an OS sandbox. Inline content must not cause local-file or image URL loading.
  if (value.trimStart().startsWith('{') || value.trimStart().startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(value);
      const strings: unknown[] = [parsed];
      while (strings.length) {
        const next: unknown = strings.pop();
        if (typeof next === 'string' && !safeInlineValue(next)) return false;
        if (Array.isArray(next)) strings.push(...next);
        else if (object(next)) strings.push(...Object.values(next));
      }
    } catch { /* CLI validates malformed structured content; raw scanning still applies. */ }
  }
  return !value.trimStart().startsWith('@') && value !== '-' && !/[\x00]/u.test(value) &&
    !/(?:file:\/\/|(?:[A-Za-z]:[\\/])|(?:^|[\s"'=])\.\.\/|<\s*(?:img|image)\b|!\[)/iu.test(value);
}

function defaultOutput(method: NativeMethod, supplied: Record<string, unknown>): [string, string] | undefined {
  // Only commands documented to create a file by default need a controlled destination.
  // Optional offload flags must not change ordinary JSON/inline reads into downloads.
  const defaults: Record<string, [string, string]> = {
    'apps +db-data-export': ['output', 'output/result.csv'],
    'apps +file-download': ['output', 'output/result'],
    'base +record-download-attachment': ['output', 'output'],
    'docs +media-download': ['output', 'output/result'],
    'docs +media-preview': ['output', 'output/result'],
    'docs +resource-download': ['output', 'output/result'],
    'drive +cover': ['output', 'output/result'],
    'drive +download': ['output', 'output/result'],
    'drive +export': ['output-dir', 'output'],
    'drive +export-download': ['output-dir', 'output'],
    'drive +preview': ['output', 'output/result'],
    'drive +version-get': ['output', 'output/result'],
    'im +messages-resources-download': ['output', 'output/result'],
    'minutes +download': ['output-dir', 'output'],
    'slides +media-download': ['output-dir', 'output'],
    'slides +screenshot': ['output-dir', 'output'],
    'vc +meeting-screenshot': ['output', 'output/result.jpg'],
  };
  if (supplied['list-only'] === true || supplied['url-only'] === true) return undefined;
  if (method.name === 'minutes +detail' && supplied.transcript === true) return ['output-dir', 'output'];
  if (method.name === 'whiteboard +export' && supplied['output-type'] === 'preview') {
    return ['output', 'output/result.png'];
  }
  if (method.name === 'note +transcript') {
    return ['output', supplied['transcript-format'] === 'plain_text' ? 'output/result.txt' : 'output/result.md'];
  }
  return defaults[method.name];
}

function shortcutPlan(method: NativeMethod, args: Record<string, unknown>, mode: FeishuToolMode): NativePlan {
  const supplied: Record<string, unknown> = object(args.flags) ? args.flags : {};
  const hasYes: boolean = Boolean(method.flags?.some((flag: { name: string }): boolean => flag.name === 'yes'));
  if (method.requiresBridgeConfirmation && args.confirmed !== true) throw new Error('native_confirmation_required');
  if (method.requiresExplicitConfirmation && hasYes && supplied.yes !== true) {
    throw new Error('native_confirmation_required');
  }
  const argv: string[] = [...method.command];
  if (method.supportsAs) argv.push('--as=user');
  const baseArtifact: boolean = /^base \+record-(?:get|list|search)$/u.test(method.name) && supplied.output !== undefined;
  if (baseArtifact && (typeof supplied.output !== 'string' || !supplied.output.endsWith('.ndjson'))) {
    throw new Error('native_arguments_invalid');
  }
  if (method.supportsFormat) argv.push(`--format=${baseArtifact ? 'ndjson' : 'json'}`);
  let collectFiles: boolean = false;
  for (const [name, value] of Object.entries(supplied)) {
    const flag: { name: string; type: string; description: string } | undefined = method.flags?.find(
      (item: { name: string }): boolean => item.name === name);
    if (!flag || !/^[a-z][a-z0-9_-]*$/u.test(name)) throw new Error('native_flag_invalid');
    const values: unknown[] = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (!['string', 'boolean', 'number'].includes(typeof item) ||
        (typeof item === 'number' && !Number.isFinite(item))) throw new Error('native_flag_invalid');
      const text: string = String(item);
      if (method.outputFlags?.includes(name)) {
        if (text !== 'output' && !safeFilePath(text, 'output')) {
          throw new Error('native_file_reference_invalid');
        }
        collectFiles = true;
      } else if (method.fileFlags?.includes(name)) {
        if (!safeFilePath(text, 'input')) throw new Error('native_file_reference_invalid');
      } else if (!safeInlineValue(text)) throw new Error('native_inline_reference_invalid');
      argv.push(`--${name}=${text}`);
    }
  }
  // Mandatory/default file creation stays inside output/. Optional output flags remain optional.
  const outputFlags: string[] = method.outputFlags ?? [];
  const automatic: [string, string] | undefined = defaultOutput(method, supplied);
  if (automatic && outputFlags.includes(automatic[0]) &&
    !outputFlags.some((name: string): boolean => supplied[name] !== undefined)) {
    argv.push(`--${automatic[0]}=${automatic[1]}`);
    collectFiles = true;
  }
  return { argv, mode, scopeGroups: method.scopeGroups,
    runnerOptions: { allowTextOutput: true, ...(collectFiles ? { collectFiles: true } : {}) } };
}

async function buildNativePlan(
  request: Extract<FeishuNativeRequest, { task: 'native_read' | 'native_write' }>,
): Promise<NativePlan> {
  const mode: FeishuToolMode = request.task === 'native_read' ? 'read' : 'write';
  const catalog: NativeCatalog = await nativeCatalog();
  const method: NativeMethod | undefined = catalog.methods.find((item: NativeMethod): boolean =>
    item.schemaPath === request.arguments.operation && item.mode === mode);
  if (!method) throw new Error('native_operation_not_available');
  if (method.availability && method.availability !== 'executable') throw new Error('native_execution_restricted');
  const args: Record<string, unknown> = request.arguments.arguments;
  if (Object.keys(args).some((key: string): boolean =>
    !(method.kind === 'shortcut' ? ['flags', ...(method.requiresBridgeConfirmation ? ['confirmed'] : [])]
      : ['params', 'data', 'file', 'yes']).includes(key))) {
    throw new Error('native_arguments_invalid');
  }
  let validate: ValidateFunction | undefined = validators.get(method.schemaPath);
  if (!validate) {
    validate = ajv.compile(method.inputSchema);
    validators.set(method.schemaPath, validate);
  }
  if (!validate(args)) throw new Error('native_arguments_invalid');
  if (method.kind === 'shortcut') return shortcutPlan(method, args, mode);
  if (method.requiresExplicitConfirmation && args.yes !== true) throw new Error('native_confirmation_required');
  // Only the pinned catalog chooses the command. Values travel as JSON, never as flags or a shell string.
  if (method.command.length !== 3 || method.command.some((part: string): boolean =>
    !/^[a-z][a-z0-9_.]*$/u.test(part))) throw new Error('native_command_invalid');
  const argv: string[] = [...method.command, '--as', 'user', '--format', 'json'];
  if (args.params !== undefined) argv.push('--params', JSON.stringify(args.params));
  if (args.data !== undefined) argv.push('--data', JSON.stringify(args.data));
  if (args.file !== undefined) {
    if (!object(args.file)) throw new Error('native_file_reference_invalid');
    for (const [field, filePath] of Object.entries(args.file)) {
      if (!/^[a-z][a-z0-9_]*$/u.test(field) || typeof filePath !== 'string' || !safeFilePath(filePath, 'input')) {
        throw new Error('native_file_reference_invalid');
      }
      argv.push('--file', `${field}=${filePath}`);
    }
  }
  if (method.requiresExplicitConfirmation && args.yes === true) argv.push('--yes');
  return { argv, scopeGroups: method.scopeGroups, mode };
}

export { discoverNative, buildNativePlan };
export type { NativePlan };
