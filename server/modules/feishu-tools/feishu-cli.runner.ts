import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { connectorDefaultTimezone } from '../../config/connector-deployment.config';

interface FeishuCliCredentials { appId: string; accessToken: string }
interface FeishuCliReply { exitCode: number; output: unknown }
interface FeishuCliOptions { timeoutMs?: number }
interface FeishuCliRuntime {
  available: boolean;
  version?: string;
  platform: string;
  architecture: string;
  errorCode?: string;
}

const CLI_TIMEOUT_MS: number = 25000;
const CLI_OUTPUT_LIMIT: number = 4 * 1024 * 1024;
let runtimeProbe: Promise<FeishuCliRuntime> | undefined;

function binaryPath(): string {
  return join(__dirname, 'assets', process.platform === 'win32' ? 'lark-cli.exe' : 'lark-cli');
}

function isolatedEnvironment(directory: string, credentials?: FeishuCliCredentials): NodeJS.ProcessEnv {
  if (!isAbsolute(directory) || (credentials && (!/^cli_[A-Za-z0-9]+$/u.test(credentials.appId) ||
    !credentials.accessToken || credentials.accessToken.length > 16384 ||
    /[\x00-\x20\x7f]/u.test(credentials.accessToken)))) throw new Error('cli_credentials_invalid');
  const env: NodeJS.ProcessEnv = {
    HOME: directory, USERPROFILE: directory, APPDATA: directory, LOCALAPPDATA: directory,
    XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory,
    TMPDIR: directory, TMP: directory, TEMP: directory,
    LARKSUITE_CLI_CONFIG_DIR: join(directory, 'config'),
    LARKSUITE_CLI_BRAND: 'feishu', LARKSUITE_CLI_STRICT_MODE: 'user',
    LARKSUITE_CLI_DEFAULT_AS: 'user', NO_COLOR: '1', TZ: connectorDefaultTimezone(),
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
  };
  if (process.platform === 'win32' && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  if (credentials) {
    env.LARKSUITE_CLI_APP_ID = credentials.appId;
    env.LARKSUITE_CLI_USER_ACCESS_TOKEN = credentials.accessToken;
  }
  return env;
}

async function cleanup(directory: string): Promise<void> {
  const base: string = resolve(tmpdir());
  const target: string = resolve(directory);
  const within: string = relative(base, target);
  if (!within || within.startsWith('..') || isAbsolute(within) || !within.startsWith('feishu-cli-')) {
    throw new Error('cli_cleanup_boundary');
  }
  await rm(target, { recursive: true, force: true });
}

async function executeBinary(argv: readonly string[], credentials?: FeishuCliCredentials, options: FeishuCliOptions = {}): Promise<{
  exitCode: number; stdout: string; stderr: string;
}> {
  if (argv.length > 100 || argv.some((value: string): boolean => value.includes('\0')) ||
    Buffer.byteLength(JSON.stringify(argv), 'utf8') > 131072) throw new Error('cli_arguments_limit');
  const timeoutMs: number = Math.min(options.timeoutMs ?? CLI_TIMEOUT_MS, CLI_TIMEOUT_MS);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('cli_timeout');
  const directory: string = await mkdtemp(join(tmpdir(), 'feishu-cli-'));
  try {
    await mkdir(join(directory, 'config'));
    return await new Promise((accept, reject): void => {
      // Never invoke a shell or inherit the server's environment/credentials.
      const child: ChildProcessWithoutNullStreams = spawn(binaryPath(), [...argv], {
        cwd: directory, env: isolatedEnvironment(directory, credentials),
        shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      const chunks: Buffer[] = [];
      const errorChunks: Buffer[] = [];
      let bytes: number = 0;
      let failure: string | undefined;
      let forceTimer: NodeJS.Timeout | undefined;
      const terminate = (reason: string): void => {
        if (failure) return;
        failure = reason;
        // A hung process must not keep credentials and a pending write alive indefinitely.
        forceTimer = setTimeout((): void => { child.kill('SIGKILL'); }, 250);
        child.kill('SIGTERM');
      };
      const timer: NodeJS.Timeout = setTimeout((): void => terminate('cli_timeout'), timeoutMs);
      child.stdin.end();
      child.stdout.on('data', (chunk: Buffer): void => {
        bytes += chunk.length;
        if (bytes > CLI_OUTPUT_LIMIT) { terminate('cli_output_limit'); return; }
        chunks.push(chunk);
      });
      // Keep stderr in memory only: the CLI writes structured errors here. Never log raw diagnostics.
      child.stderr.on('data', (chunk: Buffer): void => {
        bytes += chunk.length;
        if (bytes > CLI_OUTPUT_LIMIT) { terminate('cli_output_limit'); return; }
        errorChunks.push(chunk);
      });
      child.once('error', (): void => {
        if (child.pid !== undefined) { terminate('cli_runtime_unavailable'); return; }
        clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer);
        reject(new Error('cli_runtime_unavailable'));
      });
      child.once('close', (code: number | null): void => {
        clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer);
        if (failure) { reject(new Error(failure)); return; }
        accept({ exitCode: code ?? -1, stdout: Buffer.concat(chunks).toString('utf8'),
          stderr: Buffer.concat(errorChunks).toString('utf8') });
      });
    });
  } finally {
    await cleanup(directory);
  }
}

async function runFeishuCli(
  argv: readonly string[], credentials?: FeishuCliCredentials, options: FeishuCliOptions = {},
): Promise<FeishuCliReply> {
  const result = await executeBinary(argv, credentials, options);
  try {
    const output: unknown = JSON.parse(result.exitCode === 0 ? result.stdout : result.stderr);
    return { exitCode: result.exitCode, output };
  }
  catch { throw new Error('cli_invalid_output'); }
}

function probeFeishuCli(): Promise<FeishuCliRuntime> {
  // Constant, credential-free probe; public callers cannot select a command or cause repeated spawning.
  runtimeProbe ??= executeBinary(['--version']).then((result): FeishuCliRuntime => {
    const version: string | undefined = result.stdout.match(/\b1\.0\.95\b/u)?.[0];
    return { available: result.exitCode === 0 && Boolean(version), version,
      platform: process.platform, architecture: process.arch,
      ...(result.exitCode === 0 && version ? {} : { errorCode: 'cli_version_mismatch' }) };
  }).catch((): FeishuCliRuntime => ({ available: false, platform: process.platform,
    architecture: process.arch, errorCode: 'cli_runtime_unavailable' }));
  return runtimeProbe;
}

export { runFeishuCli, probeFeishuCli, isolatedEnvironment };
export type { FeishuCliCredentials, FeishuCliReply, FeishuCliRuntime, FeishuCliOptions };
