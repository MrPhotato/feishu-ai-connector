import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export function platformCommand(appId, args, input) {
  if (!/^app_[a-z0-9]{5,64}$/u.test(appId)) throw new Error('A valid target Miaoda app ID is required.');
  const command = process.platform === 'win32' ? process.execPath : 'lark-cli';
  if (process.platform === 'win32' && !process.env.APPDATA) throw new Error('The official CLI installation is unavailable.');
  const prefix = process.platform === 'win32'
    ? [join(process.env.APPDATA, 'npm/node_modules/@larksuite/cli/scripts/run.js')] : [];
  const result = spawnSync(command, [...prefix, 'apps', ...args, '--app-id', appId, '--as', 'user'], {
    encoding: 'utf8', input, windowsHide: true, timeout: 45000, maxBuffer: 4 * 1024 * 1024,
  });
  try {
    const parsed = JSON.parse(result.stdout);
    if (result.status !== 0 || !parsed.ok) throw new Error();
    return parsed.data;
  } catch {
    throw new Error('Platform command failed; sensitive output withheld.');
  }
}

export function readCloudEnvironment(appId) {
  const result = platformCommand(appId, ['+env-list', '--environment', 'online', '--include-values']);
  if (result?.has_more || !Array.isArray(result?.items)) {
    throw new Error('Cannot verify the full cloud configuration; sensitive output withheld.');
  }
  return result.items;
}
