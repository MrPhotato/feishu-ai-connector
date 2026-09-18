/** Build-time installation only. Never invoke this from an HTTP request/startup hook. */
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const maxArchiveBytes = 100 * 1024 * 1024;
const maxBinaryBytes = 200 * 1024 * 1024;
const release = JSON.parse(await readFile(new URL('./release-manifest.json', import.meta.url), 'utf8'));

export function selectAsset(platform, arch) {
  const normalized = platform === 'windows' ? 'win32' : platform;
  const asset = release.assets.find((candidate) => candidate.platform === normalized && candidate.arch === arch);
  if (!asset) throw new Error('Unsupported CLI target platform/architecture.');
  return { ...asset, version: release.version,
    url: `${release.repository}/releases/download/${release.sourceTag}/${asset.archive}` };
}

export function verifyArchive(bytes, asset) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > maxArchiveBytes ||
      createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
    throw new Error('Official CLI archive failed SHA256 validation.');
  }
}

export function parseArguments(args) {
  const options = { platform: process.platform, arch: process.arch };
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!['--platform', '--arch', '--output', '--archive'].includes(name) ||
        typeof value !== 'string' || !value || value.startsWith('--') ||
        Object.hasOwn(options, `provided:${name}`)) throw new Error('Invalid installer arguments.');
    options[name.slice(2)] = value;
    options[`provided:${name}`] = true;
  }
  if (!options.output) throw new Error('Required: --output <binary-file-path>.');
  return options;
}

async function download(url) {
  // Release CDN redirects are expected; the pinned digest authenticates the final bytes.
  const response = await fetch(url, { signal: AbortSignal.timeout(120000), redirect: 'follow' });
  if (!response.ok || !response.body || new URL(response.url).protocol !== 'https:') {
    throw new Error('Official CLI archive download failed.');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maxArchiveBytes) throw new Error('Official CLI archive is too large.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function installCli(options) {
  const asset = selectAsset(options.platform, options.arch);
  const target = resolve(options.output);
  if (!isAbsolute(target) || target === dirname(target)) throw new Error('Invalid output file.');
  const archive = options.archive ? await readFile(resolve(options.archive)) : await download(asset.url);
  verifyArchive(archive, asset);
  // Extract exactly the known regular executable to stdout, never an archive tree to the workspace.
  const archivePath = join(tmpdir(), `feishu-cli-build-${randomUUID()}-${asset.archive}`);
  const stagedTarget = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(archivePath, archive, { mode: 0o600, flag: 'wx' });
    const { stdout } = await runFile('tar', ['-xOf', archivePath, asset.entry], {
      encoding: 'buffer', maxBuffer: maxBinaryBytes, timeout: 60000, windowsHide: true,
    });
    const magicValid = asset.platform === 'linux'
      ? stdout.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
      : stdout.subarray(0, 2).equals(Buffer.from('MZ'));
    if (!magicValid) throw new Error('Official CLI executable has an unexpected file format.');
    await mkdir(dirname(target), { recursive: true });
    await writeFile(stagedTarget, stdout, { mode: 0o755, flag: 'wx' });
    await chmod(stagedTarget, 0o755);
    await rename(stagedTarget, target);
    return { version: release.version, platform: asset.platform, arch: asset.arch, output: target,
      archiveSha256: asset.sha256, binarySha256: createHash('sha256').update(stdout).digest('hex'),
      size: stdout.length };
  } finally {
    // Only individual random files created above are removed. No recursive deletion.
    await rm(archivePath, { force: true });
    await rm(stagedTarget, { force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { process.stdout.write(`${JSON.stringify(await installCli(parseArguments(process.argv.slice(2))))}\n`); }
  catch { process.stderr.write('CLI preparation failed; verify target, network, tar and pinned archive digest.\n'); process.exitCode = 1; }
}
