import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { installCli, selectAsset } from '../native/prepare-cli.mjs';

const assets = new URL('../server/modules/feishu-tools/assets/', import.meta.url);
await mkdir(assets, { recursive: true });
// Vendor the verified Linux dependency so cloud builds do not depend on GitHub availability.
const archive = process.platform === 'linux' && process.arch === 'x64'
  ? fileURLToPath(new URL(`../native/vendor/${selectAsset('linux', 'x64').archive}`, import.meta.url)) : undefined;
const installed = await installCli({ platform: process.platform, arch: process.arch,
  ...(archive ? { archive } : {}),
  output: fileURLToPath(new URL(process.platform === 'win32' ? 'lark-cli.exe' : 'lark-cli', assets)) });
await copyFile(new URL('../native/generated/api-catalog.json', import.meta.url), new URL('api-catalog.json', assets));
await copyFile(new URL('../native/THIRD_PARTY_NOTICES.md', import.meta.url), new URL('THIRD_PARTY_NOTICES.md', assets));
console.log(`Official Feishu CLI ${installed.version} prepared for ${installed.platform}/${installed.arch}; archive verified.`);
