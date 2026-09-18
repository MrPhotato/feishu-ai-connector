import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { validateDeploymentConfig } from './lib/deployment-config.mjs';

// Offline migration checks: synthetic credentials and a fake gateway, no env file or live data.
const require = createRequire(import.meta.url);
const { connectorPublicUrl, connectorFeishuAppId, connectorDefaultTimezone } =
  require('../dist/server/config/connector-deployment.config.js');
const { ConnectorAuthStorageService } =
  require('../dist/server/modules/connector-auth-storage/connector-auth-storage.service.js');
const { ConnectorAuthStorageCrypto, STORAGE_REQUEST_AAD } =
  require('../dist/server/modules/connector-auth-storage/connector-auth-storage.crypto.js');
const { ConnectorAuthService } = require('../dist/server/modules/connector-auth/connector-auth.service.js');
const deployments = ['https://alpha.example/app/app_alpha01', 'https://beta.example/app/app_beta001'];
const invalidUrls = [undefined, '', 'http://alpha.example/app/app_one', 'https://user:pass@alpha.example',
  'https://alpha.example/path?target=another', 'https://alpha.example/path#fragment',
  'https://alpha.example/path/../other', 'https://alpha.example/%2e%2e/other',
  'https://alpha.example//other', 'https://alpha.example\\other',
  'https://127.0.0.1', 'https://169.254.169.254', 'https://[::1]', 'https://localhost',
  'https://app.localhost', ' https://alpha.example', 'https://alpha.example\n',
  'https://alpha.example./path', 'https://2130706433', '//alpha.example'];
let checks = 0;
for (const value of deployments) {
  assert.equal(connectorPublicUrl({ CONNECTOR_PUBLIC_URL: value }), value);
  assert.equal(connectorPublicUrl({ CONNECTOR_PUBLIC_URL: `${value}/` }), value);
  checks += 2;
}
for (const value of invalidUrls) {
  assert.throws(() => connectorPublicUrl({ CONNECTOR_PUBLIC_URL: value }));
  checks++;
}
assert.equal(connectorFeishuAppId({ FEISHU_APP_ID: 'cli_otherEnterprise' }), 'cli_otherEnterprise');
for (const value of [undefined, '', 'app_wrong', 'cli_invalid/']) {
  assert.throws(() => connectorFeishuAppId({ FEISHU_APP_ID: value }));
}
assert.equal(connectorDefaultTimezone({}), 'UTC');
checks += 6;
for (const offset of ['+08:00', '+0800', '-05']) {
  assert.throws(() => connectorDefaultTimezone({ CONNECTOR_DEFAULT_TIMEZONE: offset }));
  checks++;
}

const profile = { miaodaAppId: 'app_alpha01', publicUrl: deployments[0], feishuAppId: 'cli_alpha0001',
  defaultTimezone: 'Asia/Singapore', displayName: 'Example connector', author: 'Example operator' };
const configured = { CONNECTOR_DEPLOYMENT_CONFIG: JSON.stringify(profile),
  CONNECTOR_PUBLIC_URL: deployments[1], FEISHU_APP_ID: 'cli_legacy', CONNECTOR_DEFAULT_TIMEZONE: 'UTC' };
assert.equal(connectorPublicUrl(configured), profile.publicUrl);
assert.equal(connectorFeishuAppId(configured), profile.feishuAppId);
assert.equal(connectorDefaultTimezone(configured), profile.defaultTimezone);
checks += 3;
for (const candidate of [profile,
  JSON.parse(readFileSync(new URL('../deployment/instance.example.json', import.meta.url), 'utf8'))]) {
  const validated = validateDeploymentConfig(candidate);
  const cloud = { CONNECTOR_DEPLOYMENT_CONFIG: JSON.stringify(validated) };
  assert.equal(connectorPublicUrl(cloud), validated.publicUrl);
  assert.equal(connectorFeishuAppId(cloud), validated.feishuAppId);
  assert.equal(connectorDefaultTimezone(cloud), validated.defaultTimezone);
  checks += 3;
}
for (const invalid of ['', '{', 'null', '[]', JSON.stringify({ ...profile, appSecret: 'never-here' }),
  JSON.stringify({ ...profile, miaodaAppId: 'app_mismatch' }),
  JSON.stringify({ ...profile, defaultTimezone: 'not/a/timezone' }),
  JSON.stringify({ ...profile, feishuAppId: 'invalid' }),
  JSON.stringify({ ...profile, author: 'bad\nname' }),
  JSON.stringify({ ...profile, publicUrl: 'http://alpha.example/app/app_one' })]) {
  assert.throws(() => connectorPublicUrl({ ...configured, CONNECTOR_DEPLOYMENT_CONFIG: invalid }),
    'bad cloud JSON must not silently fall back to an old instance');
  checks++;
}

const names = ['CONNECTOR_DEPLOYMENT_CONFIG', 'CONNECTOR_PUBLIC_URL', 'CONNECTOR_STORAGE_API_KEY',
  'CONNECTOR_STORAGE_ENCRYPTION_KEY'];
const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
const originalFetch = globalThis.fetch;
const crypto = new ConnectorAuthStorageCrypto();
const service = new ConnectorAuthStorageService(crypto);
let networkCalls = 0;
try {
  delete process.env.CONNECTOR_DEPLOYMENT_CONFIG;
  Object.assign(process.env, { CONNECTOR_STORAGE_API_KEY: 'synthetic-deployment-api-key',
    CONNECTOR_STORAGE_ENCRYPTION_KEY: randomBytes(32).toString('hex') });
  for (const base of deployments) {
    process.env.CONNECTOR_PUBLIC_URL = base;
    globalThis.fetch = async (url, init) => {
      networkCalls++;
      assert.equal(url, `${base}/openapi/connector-auth-storage/execute`);
      assert.equal(init.redirect, 'error', 'a gateway redirect cannot receive the API key');
      assert.equal(init.headers.Authorization, 'Bearer synthetic-deployment-api-key');
      assert.ok(init.signal instanceof AbortSignal);
      const { sealed } = JSON.parse(init.body);
      const request = crypto.open(sealed, STORAGE_REQUEST_AAD);
      assert.deepEqual(request.command, { operation: 'get', model: 'Session', key: 'synthetic-session' });
      return Response.json({ sealed: crypto.seal({ ok: true, record: { synthetic: true } }, crypto.responseAad(sealed)) });
    };
    assert.deepEqual(await service.get('Session', 'synthetic-session'), { synthetic: true });
    checks++;
  }
  // Production cloud JSON is sufficient, even after legacy single-value settings are removed.
  process.env.CONNECTOR_DEPLOYMENT_CONFIG = JSON.stringify(profile);
  delete process.env.CONNECTOR_PUBLIC_URL;
  globalThis.fetch = async (url, init) => {
    networkCalls++;
    assert.equal(url, `${profile.publicUrl}/openapi/connector-auth-storage/execute`);
    const { sealed } = JSON.parse(init.body);
    return Response.json({ sealed: crypto.seal({ ok: true }, crypto.responseAad(sealed)) });
  };
  assert.equal(await service.get('Session', 'synthetic-session'), undefined);
  delete process.env.CONNECTOR_DEPLOYMENT_CONFIG;
  checks++;
  globalThis.fetch = async () => { networkCalls++; throw new Error('Unexpected network'); };
  for (const url of invalidUrls) {
    if (url === undefined) delete process.env.CONNECTOR_PUBLIC_URL;
    else process.env.CONNECTOR_PUBLIC_URL = url;
    const previousCalls = networkCalls;
    await assert.rejects(() => service.get('Session', 'synthetic-session'),
      (error) => error.message === 'Authorization storage is unavailable.' && !error.cause);
    assert.equal(networkCalls, previousCalls, 'bad config is rejected before credentials leave the process');
    checks++;
  }
  delete process.env.CONNECTOR_PUBLIC_URL;
  const status = new ConnectorAuthService({}).getStatus();
  assert.equal(status.configured, false);
  assert.equal(status.mcpUrl, '');
  assert.ok(!JSON.stringify(status).includes(process.env.CONNECTOR_STORAGE_API_KEY));
  checks++;
} finally {
  globalThis.fetch = originalFetch;
  for (const name of names) {
    if (prior[name] === undefined) delete process.env[name];
    else process.env[name] = prior[name];
  }
}
console.log(`PASS: ${checks} deployment checks; two isolated targets, no implicit company instance, rejected malformed URLs, protected credential relay.`);
