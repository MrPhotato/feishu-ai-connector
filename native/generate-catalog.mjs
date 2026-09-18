/** Build-time, no credentials: project the official embedded API catalog into user/business JSON methods. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const release = JSON.parse(await readFile(new URL('./release-manifest.json', import.meta.url), 'utf8'));
const businessServices = new Set(['approval', 'attendance', 'base', 'calendar', 'contact', 'docs', 'docx',
  'drive', 'im', 'mail', 'markdown', 'mindnotes', 'minutes', 'note', 'okr', 'search', 'sheets',
  'slides', 'task', 'vc', 'whiteboard', 'wiki']);

function fileReason(schema) {
  if (!schema || typeof schema !== 'object') return undefined;
  if (schema.format === 'binary' || schema.format === 'byte' ||
      schema.carrier === '--file' || /^(--file|--output|--output-dir|--body-file)$/u.test(schema.flag || '')) {
    return 'file_carrier';
  }
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'properties' && value && typeof value === 'object' &&
      Object.keys(value).some((name) => /^(file_path|file_content|output_path|output_dir)$/u.test(name))) {
      return 'local_file_parameter';
    }
    if (value && typeof value === 'object' && fileReason(value)) return 'file_carrier';
  }
  return undefined;
}

export function projectMethod(method) {
  if (!method || typeof method.name !== 'string') return { reason: 'invalid_metadata' };
  const command = method.name.split(' ');
  if (command.length !== 3 || command.some((part) => !/^[a-z][a-z0-9_.]*$/u.test(part))) {
    return { reason: 'noncanonical_command' };
  }
  if (!businessServices.has(command[0])) return { reason: 'nonbusiness_service' };
  if (!Array.isArray(method._meta?.access_tokens) || !method._meta.access_tokens.includes('user')) {
    return { reason: 'not_user_identity' };
  }
  if (/(^|_)(upload|download|import|export)(_|$)/u.test(command[2])) return { reason: 'file_operation' };
  if (method.inputSchema?.type !== 'object' || !method.inputSchema.properties ||
      Object.keys(method.inputSchema.properties).some((name) => !['params', 'data', 'yes'].includes(name))) {
    return { reason: 'non_json_input' };
  }
  for (const [name, value] of Object.entries(method.inputSchema.properties)) {
    if (value.type !== (name === 'yes' ? 'boolean' : 'object')) return { reason: 'non_json_input' };
  }
  const unsafe = fileReason(method.inputSchema);
  if (unsafe) return { reason: unsafe };
  const required = method._meta.required_scopes || [];
  const scopes = method._meta.scopes || [];
  const scopeGroups = required.length ? required.map((scope) => [scope]) : (scopes.length ? [scopes] : []);
  return { method: { ...method, command, schemaPath: command.join('.'), service: command[0], scopeGroups,
    requiresExplicitConfirmation: method._meta.risk === 'high-risk-write',
    mode: method._meta.risk === 'read' ? 'read' : 'write' } };
}

export async function generateCatalog(binary, output) {
  if (!isAbsolute(binary)) throw new Error('An absolute, trusted native binary path is required.');
  const root = await mkdtemp(join(tmpdir(), 'feishu-cli-catalog-'));
  const env = { HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root,
    XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root, LARKSUITE_CLI_CONFIG_DIR: root,
    LARKSUITE_CLI_STRICT_MODE: 'user', NO_COLOR: '1', LANG: 'C.UTF-8' };
  if (process.platform === 'win32' && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  try {
    const common = { cwd: root, env, timeout: 60000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 };
    const version = (await runFile(binary, ['--version'], common)).stdout.trim();
    if (version !== `lark-cli version ${release.version}`) throw new Error('Native binary version mismatch.');
    const raw = (await runFile(binary, ['schema'], common)).stdout;
    const original = JSON.parse(raw);
    if (!Array.isArray(original)) throw new Error('Unexpected official schema output.');
    const methods = [];
    const excluded = [];
    for (const candidate of original) {
      const result = projectMethod(candidate);
      if (result.method) methods.push(result.method);
      else excluded.push({ name: candidate.name, reason: result.reason });
    }
    const catalog = { cliVersion: release.version, source: `official lark-cli ${release.version} schema (strict user)`,
      schemaSha256: createHash('sha256').update(raw).digest('hex'),
      policy: 'User-identity business JSON methods; read only when official risk=read; no local file transfers.',
      count: methods.length, methods, excluded };
    const target = resolve(output);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(catalog, null, 2)}\n`);
    return { cliVersion: release.version, count: methods.length, excluded: excluded.length, output: target };
  } finally {
    // Generated private temp directory only; verify its canonical lexical boundary before removal.
    const underTemp = relative(resolve(tmpdir()), root);
    if (!underTemp || underTemp.startsWith('..') || isAbsolute(underTemp)) throw new Error('Unsafe catalog cleanup.');
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--binary' || args[2] !== '--output') throw new Error('Invalid arguments.');
    process.stdout.write(`${JSON.stringify(await generateCatalog(resolve(args[1]), args[3]))}\n`);
  } catch { process.stderr.write('CLI catalog generation failed; verify the pinned binary and output path.\n'); process.exitCode = 1; }
}
