import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadDeploymentConfig, assertCompatibleCloudIdentity } from './lib/deployment-config.mjs';
import { platformCommand, readCloudEnvironment } from './lib/deployment-platform.mjs';

// Development setup only. Secrets stay in process memory and go to the owned app via stdin.
// Never rotate existing cloud keys implicitly; doing so would invalidate stored credentials.
if (process.argv.slice(2).some(arg => arg !== '--check') || process.argv.length > 3) {
  throw new Error('Usage: node scripts/configure-cloud-auth.mjs [--check]');
}
const deployment = loadDeploymentConfig();
const appId = deployment.miaodaAppId;
const environment = 'online';
const cli = (args, input) => platformCommand(appId, args, input);
const existing = readCloudEnvironment(appId);
assertCompatibleCloudIdentity(existing, deployment);
const configured = new Set(existing.map(item => item.key));
if (process.argv.includes('--check')) {
  const required = ['FEISHU_APP_SECRET', 'CONNECTOR_STORAGE_API_KEY', 'CONNECTOR_STORAGE_ENCRYPTION_KEY',
    'CONNECTOR_COOKIE_KEYS', 'CONNECTOR_SIGNING_JWKS', 'CONNECTOR_FEISHU_SCOPES'];
  const missingKeys = required.filter(key => !existing.some(item => item.key === key
    && typeof item.value === 'string' && item.value.length > 0));
  console.log(JSON.stringify({ identityMatches: true, presenceOnly: true,
    deploymentConfigPresent: configured.has('CONNECTOR_DEPLOYMENT_CONFIG'), missingKeys,
    cloudWrites: 0 }));
  if (missingKeys.length) process.exitCode = 1;
} else {
  const encodedProfile = JSON.stringify(deployment);
  const currentProfile = existing.find(item => item.key === 'CONNECTOR_DEPLOYMENT_CONFIG')?.value;
  if (currentProfile !== encodedProfile) {
    cli(['+env-set', '--environment', environment, '--key', 'CONNECTOR_DEPLOYMENT_CONFIG', '--value', '-', '--yes'], encodedProfile);
    console.log('CONNECTOR_DEPLOYMENT_CONFIG: configured');
  }
  existing.length = 0;
  function setOnce(key, value) {
    if (configured.has(key)) { console.log(`${key}: preserved`); return; }
    cli(['+env-set', '--environment', environment, '--key', key, '--value', '-', '--yes'],
      typeof value === 'function' ? value() : value);
    configured.add(key);
    console.log(`${key}: configured`);
  }

  setOnce('CONNECTOR_PUBLIC_URL', deployment.publicUrl);
  setOnce('FEISHU_APP_ID', deployment.feishuAppId);
  setOnce('CONNECTOR_DEFAULT_TIMEZONE', deployment.defaultTimezone);
  const permissions = JSON.parse(readFileSync(new URL('../docs/read-write-permissions.json', import.meta.url), 'utf8'));
  setOnce('CONNECTOR_FEISHU_SCOPES', permissions.scopes.user.join(' '));
  setOnce('CONNECTOR_STORAGE_ENCRYPTION_KEY', () => randomBytes(32).toString('hex'));
  setOnce('CONNECTOR_COOKIE_KEYS', () => JSON.stringify([randomBytes(48).toString('base64url')]));
  if (!configured.has('CONNECTOR_SIGNING_JWKS')) {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
    const key = privateKey.export({ format: 'jwk' });
    setOnce('CONNECTOR_SIGNING_JWKS', JSON.stringify({ keys: [{ ...key, kid: randomBytes(12).toString('hex'), alg: 'RS256', use: 'sig' }] }));
  }

  if (!configured.has('CONNECTOR_STORAGE_API_KEY')) {
    const spec = JSON.parse(readFileSync(new URL('../docs/openapi.json', import.meta.url), 'utf8'));
    const path = '/openapi/connector-auth-storage/execute';
    if (!spec.paths[path]?.post?.operationId) throw new Error('Storage route is not yet registered in the app API document.');
    const created = cli(['+openapi-key-create', '--name', 'connector-auth-storage-server', '--scope-api', `POST ${path}`]);
    if (typeof created.api_key !== 'string' || typeof created.api_key_id !== 'string') throw new Error('Unexpected key response; inspect redacted key list.');
    try { setOnce('CONNECTOR_STORAGE_API_KEY', created.api_key); } catch (error) {
      cli(['+openapi-key-disable', '--key-id', created.api_key_id]);
      throw error;
    }
  }
  console.log(`FEISHU_APP_SECRET: ${configured.has('FEISHU_APP_SECRET') ? 'already configured' : 'requires the new Feishu application credential'}`);
}
