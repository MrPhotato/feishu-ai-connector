import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { validateDeploymentConfig } from './lib/deployment-config.mjs';
import { readCloudEnvironment } from './lib/deployment-platform.mjs';

// Pull only the non-secret profile; never persist or print other returned environment values.
if (process.argv.length !== 4 || process.argv[2] !== '--app-id'
  || !/^app_[a-z0-9]{5,64}$/u.test(process.argv[3])) {
  throw new Error('Usage: node scripts/pull-deployment-config.mjs --app-id <miaoda-app-id>');
}
const appId = process.argv[3];
const items = readCloudEnvironment(appId);
const encoded = items.find(item => item.key === 'CONNECTOR_DEPLOYMENT_CONFIG')?.value;
items.length = 0;
if (typeof encoded !== 'string' || !encoded) {
  throw new Error('Cloud deployment JSON is missing; initialize it from a reviewed local profile first.');
}
let deployment;
try { deployment = validateDeploymentConfig(JSON.parse(encoded)); }
catch { throw new Error('Cloud deployment JSON is invalid; no values were written.'); }
if (deployment.miaodaAppId !== appId) throw new Error('Cloud deployment JSON belongs to a different application.');
const target = fileURLToPath(new URL('../deployment/instance.local.json', import.meta.url));
await mkdir(dirname(target), { recursive: true });
await writeFile(target, `${JSON.stringify(deployment, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
console.log('Non-secret deployment profile saved to deployment/instance.local.json.');
