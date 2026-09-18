import { copyFile, mkdir, readFile, lstat } from 'node:fs/promises';
import { resolve, relative, dirname, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Explicit reviewed files only. Never copy Git history, local configuration, or entire directories.
const source = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const check = args[0] === '--check';
const outputArg = check ? args[1] : args[0];
if (!outputArg || args.length !== (check ? 2 : 1)) {
  throw new Error('Usage: node scripts/export-public-source.mjs [--check] <public-checkout-directory>');
}
const output = resolve(outputArg);
const boundary = relative(source, output);
const reverse = relative(output, source);
if (!boundary || (!boundary.startsWith(`..${sep}`) && !isAbsolute(boundary)) ||
  (!reverse.startsWith(`..${sep}`) && !isAbsolute(reverse))) {
  throw new Error('Use a separate public checkout outside the private project.');
}
const manifest = JSON.parse(await readFile(new URL('../deployment/public-source-files.json', import.meta.url), 'utf8'));
if (manifest.version !== 1 || !Array.isArray(manifest.files) || new Set(manifest.files).size !== manifest.files.length) {
  throw new Error('Invalid public source manifest.');
}
for (const file of manifest.files) {
  if (typeof file !== 'string' || file.includes('\\') || file.split('/').some(part => !part || part === '.' || part === '..') ||
    isAbsolute(file) || /(?:^|\/)(?:\.git|node_modules|dist|tmp|logs)(?:\/|$)/u.test(file) ||
    /(?:^|\/)\.env(?:$|\.)/u.test(file) && file !== '.env.example' ||
    file === '.spark/meta.json' || file.endsWith('.local.json') || file.startsWith('deployment/generated/')) {
    throw new Error('Public source manifest contains a prohibited path.');
  }
  const from = resolve(source, file);
  const to = resolve(output, file);
  if (!(await lstat(from)).isFile()) throw new Error(`Public source must be a regular file: ${file}`);
  if (check) {
    if (!(await readFile(from)).equals(await readFile(to))) throw new Error(`Public source differs: ${file}`);
  } else {
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
  }
}
console.log(JSON.stringify({ [check ? 'verified' : 'exported']: true, files: manifest.files.length,
  gitHistoryCopied: false, cloudConfigurationCopied: false }));
