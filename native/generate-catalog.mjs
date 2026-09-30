/** Build-time, no credentials: index the pinned CLI schema and complete visible command tree. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const release = JSON.parse(await readFile(new URL('./release-manifest.json', import.meta.url), 'utf8'));
const managedFlags = new Set(['as', 'profile', 'format', 'jq', 'help', 'verbose', 'debug',
  'app-secret', 'user-access-token', 'tenant-access-token', 'access-token',
  'host', 'base-url', 'endpoint', 'proxy', 'auth-proxy', 'insecure', 'skip-tls-verify',
  'watch', 'follow', 'wait', 'daemon', 'background', 'exec', 'shell']);
const unsupportedFileFlags = new Set(['inline', 'output-template', 'output-prefix', 'from-clipboard',
  'body-file', 'patch-file', 'template-content-file', 'set-template-content-file']);

export function helpChildren(help) {
  let active = false;
  const result = [];
  for (const line of help.split(/\r?\n/u)) {
    if (/^(Lark domains|Agent tooling|CLI management|Additional Commands|Available Commands):$/u.test(line)) {
      active = true; continue;
    }
    if (active && line && !line.startsWith(' ')) active = false;
    // Cobra uses just ONE space after the longest name. Requiring two silently drops commands.
    const match = active && /^  ([+a-zA-Z][\w.+-]*)(?:\s+.*)?$/u.exec(line);
    if (match) result.push(match[1]);
  }
  return result;
}

export function helpFlags(help) {
  const flags = [];
  for (const line of help.split(/\r?\n/u)) {
    const match = /^\s+(?:-[\w?],\s+)?(--[a-z][a-z0-9_-]*)(.*)$/u.exec(line);
    if (!match) continue;
    const columns = `${match[1]}${match[2]}`.split(/\s{2,}/u);
    const head = columns[0].split(/\s+/u);
    const description = columns.slice(1).join(' ');
    const cliType = head.slice(1).join(' ');
    const type = !cliType ? 'boolean' : /^(?:int|int32|int64|uint|uint32|uint64)$/u.test(cliType)
      ? 'integer' : /^(?:float32|float64)$/u.test(cliType) ? 'number'
        : /^(?:stringArray|stringSlice|strings)$/u.test(cliType) ? 'array' : 'string';
    flags.push({ name: match[1].slice(2), type, cliType, description });
  }
  return flags;
}

function inputFileFlag(flag) {
  if (/remote (?:file )?path|JSON (?:array|object)|input (?:type|format)/iu.test(flag.description)) return false;
  return /^(?:file|file-path|input-file|body-file|patch-file|attach|image|audio|video|cover|thumbnail|content-file|eml-file|html-file)$/u.test(flag.name)
    || /(?:local (?:file|image|audio)|relative (?:file )?path|file path|within cwd|path to a (?:JSON|file))/iu.test(flag.description)
      && /(?:file|path|attach|image|audio|video|input)$/u.test(flag.name);
}

function permissionChange(command) {
  return command[0] === 'apps' && /^\+(?:access-scope-set|member-(?:add|remove|update|settings-set)|role-(?:create|delete|update|member-add|member-remove))$/u.test(command[1]);
}

function limitation(command, reason) {
  if (!reason) return {};
  if (reason === 'identity_restricted') return {
    reasonDetail: '官方命令仅支持 bot 身份；当前连接器按本人的 user_access_token 执行。',
    alternative: '需要独立的机器人授权与身份隔离适配，不能复用当前个人身份调用。',
  };
  if (reason === 'unknown_risk') return {
    reasonDetail: '固定版本的公开帮助未声明读写风险，当前尚未核实执行契约。',
    alternative: '先核对官方源码并补充专用计划；本条只提供发现和帮助信息。',
  };
  if (reason === 'persistent_job_required') return {
    reasonDetail: '事件和邮箱监听使用持续连接或守护进程；当前入口只执行一次有时限的请求。',
    alternative: '事件列表/schema 可从官方 CLI 本地查看；订阅需另建具备取消、续传和身份隔离的后台任务。',
  };
  const name = command.join(' ');
  if (/^(?:auth|config|profile|whoami)(?: |$)/u.test(name)) return {
    reasonDetail: '该命令管理宿主登录、账号配置或身份状态，不能由业务请求改写。',
    alternative: '使用连接器的飞书 OAuth 登录、重新授权或断开连接；不使用服务器磁盘登录。',
  };
  if (name === 'api') return {
    reasonDetail: '任意原生 HTTP 路径尚未完成重定向、认证路径与风险隔离适配。',
    alternative: '优先检索已注册 API；未覆盖路径待增加固定官方域名、方法与路径验证的专用入口。',
  };
  if (/^(?:schema|skills |help)/u.test(name)) return {
    reasonDetail: '此 CLI 辅助命令由连接器现有发现接口提供，不接受自由位置参数。',
    alternative: '使用 native_catalog 获取目录/schema，或 skill_read 按需读取官方 Skills。',
  };
  return { reasonDetail: '该命令涉及本地工作区、凭据/环境管理、脚本或持久文件状态，尚无对应的隔离执行适配。',
    alternative: '通过正常开发者工作区执行；云端需专用隔离适配后开放，不能依靠临时 cwd 当作系统沙箱。' };
}

function shortcutBlock(command, help, flags, risk, identities) {
  const name = command.join(' ');
  if (identities.length && !identities.includes('user')) return 'identity_restricted';
  if (!risk) return 'unknown_risk';
  if (/(?:\+watch|\+listen|\+stream)$/u.test(name)) return 'persistent_job_required';
  if (command[0] === 'apps') {
    if (/^\+(?:env-|git-credential-|openapi-key-|db-execute$|init$|html-publish$|chat$|session-create$|session-stop$|plugin-install$|plugin-uninstall$)/u.test(command[1])) {
      return 'host_managed';
    }
  }
  if (name === 'docs +script') return 'host_managed';
  if (flags.some((flag) => /^(?:cwd|workdir|working-dir|project-dir|local-dir|exec|shell)$/u.test(flag.name))) {
    return 'host_managed';
  }
  return undefined;
}

export function projectCommand(command, help) {
  const flags = helpFlags(help);
  const shortcut = command.some((part) => part.startsWith('+'));
  const risk = /^Risk: (read|write|high-risk-write)\s*$/mu.exec(help)?.[1];
  const identityDescription = flags.find((flag) => flag.name === 'as')?.description || '';
  const identities = [...new Set(identityDescription.match(/\b(?:user|bot)\b/gu) || [])];
  const reason = shortcut ? shortcutBlock(command, help, flags, risk, identities)
    : command[0] === 'event' ? 'persistent_job_required' : 'host_managed';
  const requiresBridgeConfirmation = (permissionChange(command) || risk === 'high-risk-write') &&
    !flags.some((flag) => flag.name === 'yes');
  const safeFlags = flags.filter((flag) => !managedFlags.has(flag.name) &&
    !(flag.name === 'json' && flag.type === 'boolean') &&
    !/^jq(?:-|$)/u.test(flag.name) &&
    !flag.name.startsWith('print-') && !unsupportedFileFlags.has(flag.name) &&
    !(command.join(' ') === 'docs +resource-update' && flag.name === 'url'));
  const properties = {};
  for (const flag of safeFlags) {
    properties[flag.name] = { type: flag.type, description: flag.description,
      ...(flag.type === 'array' ? { items: { type: 'string' }, maxItems: 100 } : {}) };
  }
  const fileFlags = safeFlags.filter(inputFileFlag).map((flag) => flag.name);
  const outputFlags = safeFlags.filter((flag) => /^(?:output|output-dir|output-file|output-path|download-dir)$/u.test(flag.name))
    .map((flag) => flag.name);
  // Flags expose only their official types. Conditional requirements remain enforced by the CLI.
  return { name: command.join(' '), command, schemaPath: command.join('.'), service: command[0],
    kind: shortcut ? 'shortcut' : 'utility', description: help.split(/\r?\n/u)[0],
    mode: risk === 'read' ? 'read' : 'write', requiresExplicitConfirmation: risk === 'high-risk-write' || permissionChange(command),
    ...(permissionChange(command) ? { permissionChange: true } : {}),
    ...(requiresBridgeConfirmation ? { requiresBridgeConfirmation: true } : {}),
    availability: reason || 'executable', ...(reason ? { reason } : {}),
    ...limitation(command, reason),
    scopeGroups: [], scopeValidation: 'upstream', metadataSource: 'official-help',
    _meta: { risk: risk || 'unknown', access_tokens: identities, scopes: [], required_scopes: [] },
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      flags: { type: 'object', additionalProperties: false, properties },
      ...(requiresBridgeConfirmation ? { confirmed: { type: 'boolean', const: true,
        description: 'Explicit confirmation of this operation; the bridge consumes this field.' } } : {}),
    } }, flags: safeFlags, fileFlags, outputFlags,
    managedFlags: flags.filter((flag) => !safeFlags.includes(flag)).map((flag) => flag.name),
    blockedFlags: flags.filter((flag) => !safeFlags.includes(flag)).map((flag) => ({ name: flag.name,
      reason: unsupportedFileFlags.has(flag.name) || command.join(' ') === 'docs +resource-update' && flag.name === 'url'
        ? '需要专用文件/内容适配：可能读系统剪贴板、嵌套本地文件或直接下载 URL；请改用已开放的 inline 内容或 input/<附件名>。'
        : '输出、身份、宿主或调试参数由连接器管理；不能通过业务参数覆写。' })),
    supportsAs: flags.some((flag) => flag.name === 'as'),
    supportsFormat: flags.some((flag) => flag.name === 'format'),
    help };
}

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
  const user = Array.isArray(method._meta?.access_tokens) && method._meta.access_tokens.includes('user');
  if (method.inputSchema?.type !== 'object' || !method.inputSchema.properties ||
      Object.keys(method.inputSchema.properties).some((name) => !['params', 'data', 'file', 'yes'].includes(name))) {
    return { reason: 'non_json_input' };
  }
  for (const [name, value] of Object.entries(method.inputSchema.properties)) {
    if (value.type !== (name === 'yes' ? 'boolean' : 'object')) return { reason: 'non_json_input' };
  }
  const unsafe = fileReason({ ...method.inputSchema,
    properties: Object.fromEntries(Object.entries(method.inputSchema.properties).filter(([name]) => name !== 'file')) });
  if (unsafe) return { reason: unsafe };
  const required = method._meta.required_scopes || [];
  const scopes = method._meta.scopes || [];
  const scopeGroups = required.length ? required.map((scope) => [scope]) : (scopes.length ? [scopes] : []);
  return { method: { ...method, command, schemaPath: command.join('.'), service: command[0], scopeGroups,
    kind: 'api', availability: user ? 'executable' : 'identity_restricted',
    ...(user ? {} : { reason: 'not_user_identity' }), scopeValidation: 'declared',
    ...limitation(command, user ? undefined : 'identity_restricted'),
    metadataSource: 'official-schema',
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
    const apiNames = new Set(original.map((method) => method.name));
    const queue = [[]];
    let commandCount = 0;
    while (queue.length) {
      const command = queue.shift();
      if (apiNames.has(command.join(' '))) { commandCount += 1; continue; }
      const help = (await runFile(binary, [...command, '--help'], common)).stdout;
      commandCount += 1;
      if (commandCount > 2000) throw new Error('Unexpected official command tree size');
      const children = helpChildren(help);
      for (const child of children) queue.push([...command, child]);
      if (command.length && !children.length) methods.push(projectCommand(command, help));
    }
    methods.sort((left, right) => left.schemaPath.localeCompare(right.schemaPath, 'en'));
    for (const method of methods) {
      if (method.availability !== 'executable') excluded.push({ name: method.name, reason: method.reason });
    }
    const catalog = { cliVersion: release.version, source: `official lark-cli ${release.version} schema and complete --help tree`,
      schemaSha256: createHash('sha256').update(raw).digest('hex'),
      policy: 'All visible commands are discoverable; only registered user operations with supported execution boundaries run.',
      count: methods.length, executableCount: methods.filter((method) => method.availability === 'executable').length,
      commandCount, methods, excluded };
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
