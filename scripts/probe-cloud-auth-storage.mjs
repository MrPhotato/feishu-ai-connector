import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadDeploymentConfig, assertCompatibleCloudIdentity } from './lib/deployment-config.mjs';
import { readCloudEnvironment } from './lib/deployment-platform.mjs';

// Credentials are captured in memory, never displayed or passed as command arguments.
const deployment = loadDeploymentConfig();
const items = readCloudEnvironment(deployment.miaodaAppId);
assertCompatibleCloudIdentity(items, deployment);
const config = new Map(items.map(item => [item.key, item.value]));
items.length = 0;
const testEnv = { ...process.env, CONNECTOR_PUBLIC_URL: deployment.publicUrl };
for (const key of ['CONNECTOR_STORAGE_API_KEY', 'CONNECTOR_STORAGE_ENCRYPTION_KEY']) {
  const value = config.get(key);
  if (typeof value !== 'string' || !value) throw new Error(`Required cloud configuration is missing: ${key}`);
  testEnv[key] = value;
}
config.clear();
const child = spawn(process.execPath,
  [fileURLToPath(new URL('./probe-auth-storage.mjs', import.meta.url))],
  { env: testEnv, stdio: 'inherit', windowsHide: true });
child.on('error', () => { console.error('Could not start synthetic cloud checks.'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
