import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

interface FeishuCliInputFile { name: string; base64: string; mimeType?: string }
interface FeishuCliOutputFile { name: string; mimeType?: string; dataBase64: string; byteLength: number }
interface FeishuCliFileOptions {
  files?: readonly FeishuCliInputFile[];
  collectFiles?: boolean;
  maxFileBytes?: number;
}
interface FeishuCliFileManifest { inputPaths: ReadonlySet<string>; collectFiles: boolean; maxFileBytes: number }

const MAX_FILE_BYTES: number = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES: number = 20 * 1024 * 1024;
const MAX_FILES: number = 20;
const INPUT_FILE_FLAGS: Set<string> = new Set([
  '--file', '--body-file', '--ids-file', '--image', '--video', '--audio', '--video-cover',
  '--template-content-file', '--patch-file',
]);
const LITERAL_FLAGS: Record<string, readonly string[]> = {
  'im +messages-search': ['--query'], 'drive +search': ['--query'], 'docs +fetch': ['--keyword'],
  'contact +search-user': ['--query'], 'mail +triage': ['--query', '--filter'],
  'mail +draft-create': ['--body', '--subject', '--to', '--cc', '--bcc'],
};
const OUTPUT_MIMES: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', txt: 'text/plain', csv: 'text/csv', json: 'application/json',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function safeName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && name.length <= 128 &&
    Buffer.byteLength(name, 'utf8') <= 240 && name.trim() === name && !name.startsWith('.') &&
    !/[\x00-\x1f\x7f<>:"/\\|?*]/u.test(name) && !/[. ]$/u.test(name) &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name);
}

function boundedFileBytes(value: number | undefined): number {
  const limit: number = value ?? MAX_FILE_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_FILE_BYTES) throw new Error('cli_file_limit');
  return limit;
}

function inside(root: string, path: string): boolean {
  const child: string = relative(root, path);
  return Boolean(child) && !child.startsWith('..') && !isAbsolute(child);
}

async function prepareCliFiles(directory: string, options: FeishuCliFileOptions): Promise<FeishuCliFileManifest> {
  const maxFileBytes: number = boundedFileBytes(options.maxFileBytes);
  const files: readonly FeishuCliInputFile[] = options.files ?? [];
  if (!Array.isArray(files) || files.length > MAX_FILES ||
    (options.collectFiles !== undefined && typeof options.collectFiles !== 'boolean')) throw new Error('cli_file_limit');
  const names: Set<string> = new Set();
  const decoded: { name: string; content: Buffer }[] = [];
  let total: number = 0;
  // Validate the whole manifest before materializing anything. Base64 is canonical, never a data URL.
  for (const file of files) {
    if (!file || !safeName(file.name) || names.has(file.name.toLowerCase()) || typeof file.base64 !== 'string' ||
      file.base64.length > 4 * Math.ceil(maxFileBytes / 3) ||
      file.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(file.base64)) {
      throw new Error('cli_file_input_invalid');
    }
    const content: Buffer = Buffer.from(file.base64, 'base64');
    total += content.length;
    if (content.toString('base64') !== file.base64 || content.length > maxFileBytes || total > MAX_TOTAL_BYTES) {
      throw new Error('cli_file_limit');
    }
    names.add(file.name.toLowerCase()); decoded.push({ name: file.name, content });
  }
  if (decoded.length) {
    await mkdir(join(directory, 'input'), { mode: 0o700 });
    for (const file of decoded) await writeFile(join(directory, 'input', file.name), file.content, { flag: 'wx', mode: 0o600 });
  }
  if (options.collectFiles) await mkdir(join(directory, 'output'), { mode: 0o700 });
  return { inputPaths: new Set(decoded.map((file): string => `input/${file.name}`)),
    collectFiles: options.collectFiles === true, maxFileBytes };
}

/** Gate file carriers, not prose. The backend still owns command-specific flags and network policy. */
function validateCliFileArguments(argv: readonly string[], manifest: FeishuCliFileManifest): void {
  const literals: readonly string[] = LITERAL_FLAGS[`${argv[0]} ${argv[1]}`] ?? [];
  for (let index: number = 0; index < argv.length; index++) {
    const argument: string = argv[index];
    const separator: number = argument.startsWith('--') ? argument.indexOf('=') : -1;
    const flag: string = separator > 0 ? argument.slice(0, separator) : argument;
    if (!flag.startsWith('--')) continue;
    const value: string | undefined = separator > 0 ? argument.slice(separator + 1) : argv[index + 1];
    if (value === undefined) continue;
    if (INPUT_FILE_FLAGS.has(flag) && !manifest.inputPaths.has(value)) {
      // Raw API multipart carriers use --file field=input/name; shortcuts use the path directly.
      const named: RegExpMatchArray | null = flag === '--file'
        ? value.match(/^[a-z][a-z0-9_]*=(input\/.+)$/u) : null;
      if (!named || !manifest.inputPaths.has(named[1])) throw new Error('cli_file_reference_invalid');
    }
    if (flag === '--output' || flag === '--output-path' || flag === '--output-dir') {
      const parts: string[] = value.split('/');
      if (!manifest.collectFiles || parts[0] !== 'output' ||
        (flag === '--output-path' && parts.length < 2) || parts.slice(1).some((part: string): boolean => !safeName(part))) {
        throw new Error('cli_file_reference_invalid');
      }
    }
    if (flag === '--file-name' && !safeName(value)) throw new Error('cli_file_reference_invalid');
    if (value.startsWith('@') && !literals.includes(flag) && !manifest.inputPaths.has(value.slice(1))) {
      throw new Error('cli_file_reference_invalid');
    }
  }
  for (let index: number = 0; index < argv.length; index++) {
    if (!argv[index].startsWith('@')) continue;
    const previous: string = argv[index - 1] ?? '';
    if (!literals.includes(previous) && !manifest.inputPaths.has(argv[index].slice(1))) {
      throw new Error('cli_file_reference_invalid');
    }
  }
}

function credentialContent(content: Buffer, credentials: readonly string[]): boolean {
  for (const credential of credentials) {
    if (credential && [credential, Buffer.from(credential).toString('base64')]
      .some((value: string): boolean => content.includes(Buffer.from(value)))) return true;
  }
  // Never deliver credential/config dumps produced by development commands as user attachments.
  const text: string = content.toString('utf8');
  return /["'](?:access_?token|refresh_?token|id_?token|client_?secret|app_?secret|api_?key|authorization)["']\s*:\s*["'][^"']+/iu
    .test(text) || /(?:^|\n)\s*(?:export\s+)?[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)\s*=/u.test(text) ||
    /["'](?:HOME|USERPROFILE|LARKSUITE_CLI_[A-Z_]+)["']\s*:/u.test(text);
}

async function collectCliFiles(
  directory: string, manifest: FeishuCliFileManifest, credentials: readonly string[] = [],
): Promise<FeishuCliOutputFile[]> {
  if (!manifest.collectFiles) return [];
  const root: string = await realpath(directory);
  const output: string = join(root, 'output');
  const outputStat: Stats = await lstat(output);
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink() || await realpath(output) !== output) {
    throw new Error('cli_file_output_invalid');
  }
  const files: FeishuCliOutputFile[] = [];
  let total: number = 0;
  let entries: number = 0;
  const visit = async (path: string, depth: number): Promise<void> => {
    if (depth > 4) throw new Error('cli_file_limit');
    const names: string[] = await readdir(path);
    if (names.length > MAX_FILES) throw new Error('cli_file_limit');
    for (const name of names.sort()) {
      if (++entries > 100) throw new Error('cli_file_limit');
      if (!safeName(name) || /^(?:config|credentials?|environment|env)(?:\.|$)/iu.test(name)) {
        throw new Error('cli_file_output_invalid');
      }
      const target: string = resolve(path, name);
      if (!inside(output, target)) throw new Error('cli_file_output_invalid');
      const before: Stats = await lstat(target);
      if (before.isSymbolicLink() || await realpath(target) !== target) throw new Error('cli_file_output_invalid');
      if (before.isDirectory()) { await visit(target, depth + 1); continue; }
      if (!before.isFile() || before.nlink !== 1 || before.size > manifest.maxFileBytes ||
        files.length >= MAX_FILES || total + before.size > MAX_TOTAL_BYTES) throw new Error('cli_file_limit');
      const handle: FileHandle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let content: Buffer;
      try {
        const after: Stats = await handle.stat();
        if (!after.isFile() || after.nlink !== 1 || after.ino !== before.ino || after.dev !== before.dev ||
          after.size !== before.size) throw new Error('cli_file_output_invalid');
        const buffer: Buffer = Buffer.alloc(before.size + 1);
        let offset: number = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        if (offset !== before.size) throw new Error('cli_file_output_invalid');
        content = buffer.subarray(0, offset);
      } finally { await handle.close(); }
      if (credentialContent(content, credentials)) throw new Error('cli_file_sensitive_output');
      total += content.length;
      const extension: string = name.split('.').at(-1)?.toLowerCase() ?? '';
      files.push({ name: relative(output, target).split('\\').join('/'),
        mimeType: OUTPUT_MIMES[extension] ?? 'application/octet-stream',
        dataBase64: content.toString('base64'), byteLength: content.length });
    }
  };
  await visit(output, 0);
  return files;
}

export { prepareCliFiles, validateCliFileArguments, collectCliFiles, safeName as safeCliFileName };
export type { FeishuCliInputFile, FeishuCliOutputFile, FeishuCliFileOptions, FeishuCliFileManifest };
