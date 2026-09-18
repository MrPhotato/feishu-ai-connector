import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve, relative, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadDeploymentConfig, validateDeploymentConfig, assertCompatibleCloudIdentity,
  assertDeploymentEnvironment, deploymentFetch,
} from './lib/deployment-config.mjs';
import { generateDeploymentPlugin } from './generate-deployment-plugin.mjs';

// Synthetic local files and in-memory platform mocks only: no cloud CLI, credentials, or network.
const root = fileURLToPath(new URL('../', import.meta.url));
const generatedRoot = resolve(root, 'deployment/generated');
await mkdir(generatedRoot, { recursive: true });
const temporary = await mkdtemp(resolve(generatedRoot, 'offline-check-'));
const secretMarker = 'synthetic-secret-must-never-appear-in-output';
const profiles = ['alpha', 'bravo'].map(name => ({ miaodaAppId: `app_${name}00`,
  publicUrl: `https://${name}.example.com/app/app_${name}00`, feishuAppId: `cli_${name}00000000`,
  defaultTimezone: name === 'alpha' ? 'Asia/Singapore' : 'Europe/London',
  displayName: `${name} connector`, author: `${name} maintainer` }));
const originalFetch = globalThis.fetch;
let checks = 0;
let simulatedRequests = 0;
const check = (value, message) => { assert.ok(value, message); checks += 1; };
globalThis.fetch = async (_input, init) => {
  simulatedRequests += 1;
  check(init.redirect !== 'follow', 'redirect following is forbidden');
  return new Response(null, { status: 302, headers: { location: 'https://external.example.com/' } });
};

async function outputFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...await outputFiles(target));
    else result.push({ path: relative(directory, target), content: await readFile(target, 'utf8') });
  }
  return result;
}

function cloudItems(profile) {
  return [
    { key: 'CONNECTOR_PUBLIC_URL', value: profile.publicUrl },
    { key: 'FEISHU_APP_ID', value: profile.feishuAppId },
    { key: 'CONNECTOR_DEFAULT_TIMEZONE', value: profile.defaultTimezone },
    ...['CONNECTOR_STORAGE_API_KEY', 'CONNECTOR_STORAGE_ENCRYPTION_KEY', 'CONNECTOR_COOKIE_KEYS',
      'CONNECTOR_SIGNING_JWKS', 'FEISHU_APP_SECRET', 'CONNECTOR_FEISHU_SCOPES']
      .map(key => ({ key, value: secretMarker })),
  ];
}

function scriptBody(name) {
  return readFileSync(resolve(root, `scripts/${name}`), 'utf8')
    .replace(/^import .*;\r?\n/gmu, '').replaceAll('import.meta.url', JSON.stringify(new URL(name, import.meta.url).href));
}

function configureFixture(items, profile, args = []) {
  const writes = [];
  const logs = [];
  const fakeProcess = { argv: ['node', 'configure', ...args] };
  const denySecrets = () => { throw new Error('An existing secret must never be regenerated.'); };
  const invoke = new Function('randomBytes', 'generateKeyPairSync', 'readFileSync', 'loadDeploymentConfig',
    'assertCompatibleCloudIdentity', 'platformCommand', 'readCloudEnvironment', 'process', 'console',
    scriptBody('configure-cloud-auth.mjs'));
  let error;
  try {
    invoke(denySecrets, denySecrets, () => JSON.stringify({ scopes: { user: ['synthetic:read'] } }),
      () => profile, assertCompatibleCloudIdentity,
      (_appId, command, input) => { writes.push({ command, input }); return {}; },
      () => structuredClone(items), fakeProcess, { log: value => logs.push(value) });
  } catch (caught) { error = caught; }
  return { writes, logs, error, exitCode: fakeProcess.exitCode };
}

try {
  for (const [index, profile] of profiles.entries()) {
    const filename = resolve(temporary, `profile-${index}.json`);
    await writeFile(filename, JSON.stringify(profile));
    assert.deepEqual(loadDeploymentConfig({ env: { CONNECTOR_DEPLOYMENT_FILE: filename } }), profile); checks += 1;
    const output = resolve(temporary, `instance-${index}/feishu`);
    await generateDeploymentPlugin(profile, output);
    const mcp = JSON.parse(await readFile(resolve(output, 'mcp.json'), 'utf8'));
    const legacy = JSON.parse(await readFile(resolve(output, '.codex-plugin/plugin.json'), 'utf8'));
    check(mcp.mcpServers.feishu.url === `${profile.publicUrl}/mcp`, 'each generated plugin targets only its profile');
    check(legacy.interface.displayName === profile.displayName && legacy.author.name === profile.author,
      'display identity comes from the non-secret profile');
    const files = await outputFiles(output);
    check(files.filter(file => file.path === 'SKILL.md').length === 4, 'all four domain skills are copied');
    check(!files.some(file => file.path.includes('instance.local') || file.content.includes(secretMarker)),
      'generated package excludes private profile and synthetic credential');
    check(!files.some(file => file.content.includes(profiles[1 - index].publicUrl)), 'deployment profiles do not bleed into one another');
  }
  assert.throws(() => loadDeploymentConfig({ file: resolve(temporary, 'missing.json'), env: {} }), /configuration is unavailable/); checks += 1;
  for (const patch of [
    { secret: secretMarker }, { feishuAppId: secretMarker }, { author: '' },
    { publicUrl: 'http://alpha.example.com/app/app_alpha00' },
    { publicUrl: 'https://user:password@alpha.example.com/app/app_alpha00' },
    { publicUrl: `${profiles[0].publicUrl}?token=${secretMarker}` },
    { publicUrl: `${profiles[0].publicUrl}#fragment` },
    { publicUrl: 'https://alpha.example.com:8443/app/app_alpha00' },
    { publicUrl: 'https://alpha.example.com./app/app_alpha00' },
    { publicUrl: 'https://alpha.example.com/app/app_other00' },
    { publicUrl: 'https://alpha.example.com/app/../app/app_alpha00' },
    { publicUrl: 'https://127.0.0.1/app/app_alpha00' },
    { defaultTimezone: '+08:00' }, { defaultTimezone: '+0800' }, { defaultTimezone: '-05' },
  ]) {
    let failure;
    try { validateDeploymentConfig({ ...profiles[0], ...patch }); } catch (error) { failure = error; }
    check(failure && !failure.message.includes(secretMarker), 'invalid fields fail without echoing their values');
  }
  for (const timezone of ['UTC', 'Etc/GMT+8']) {
    check(validateDeploymentConfig({ ...profiles[0], defaultTimezone: timezone }).defaultTimezone === timezone,
      'IANA-style timezone names remain supported');
  }
  assert.throws(() => assertDeploymentEnvironment(profiles[0], { CONNECTOR_PUBLIC_URL: profiles[1].publicUrl })); checks += 1;
  const target = `${profiles[0].publicUrl}/openapi/connector-auth-storage/execute`;
  const reply = await deploymentFetch(profiles[0], target, { method: 'POST', headers: { Authorization: `Bearer ${secretMarker}` } });
  check(reply.status === 302 && simulatedRequests === 1, 'redirect is returned once and never followed');
  for (const url of [`${profiles[1].publicUrl}/mcp`, 'https://alpha.example.com/app/app_other00/mcp',
    `${profiles[0].publicUrl}/%2e%2e/mcp`]) {
    await assert.rejects(() => deploymentFetch(profiles[0], url)); checks += 1;
  }
  await assert.rejects(() => deploymentFetch(profiles[0], target, { redirect: 'follow' })); checks += 1;
  const metadataUrl = 'https://alpha.example.com/.well-known/oauth-authorization-server/app/app_alpha00/oidc';
  await deploymentFetch(profiles[0], metadataUrl, {}, { discovery: true });
  await assert.rejects(() => deploymentFetch(profiles[0], metadataUrl,
    { headers: { Authorization: `Bearer ${secretMarker}` } }, { discovery: true })); checks += 1;
  check(simulatedRequests === 2, 'rejected requests never reach the simulated transport');

  const items = cloudItems(profiles[0]);
  const checked = configureFixture(items, profiles[0], ['--check']);
  check(!checked.error && checked.writes.length === 0 && !checked.exitCode, 'cloud check performs no writes');
  const migrated = configureFixture(items, profiles[0]);
  check(!migrated.error && migrated.writes.length === 1, 'existing secrets are neither replaced nor regenerated');
  check(migrated.writes[0].command.includes('CONNECTOR_DEPLOYMENT_CONFIG'), 'migration writes only non-secret profile JSON');
  assert.deepEqual(JSON.parse(migrated.writes[0].input), profiles[0]); checks += 1;
  for (const mismatched of [profiles[1], { ...profiles[0], feishuAppId: profiles[1].feishuAppId }]) {
    const rejected = configureFixture(items, mismatched);
    check(rejected.error && rejected.writes.length === 0, 'identity mismatch fails before any cloud write');
  }
  const wrongJson = [...items, { key: 'CONNECTOR_DEPLOYMENT_CONFIG', value: JSON.stringify(profiles[1]) }];
  check(Boolean(configureFixture(wrongJson, profiles[0]).error), 'conflicting cloud JSON cannot be silently overwritten');
  check(!JSON.stringify([checked.logs, migrated.logs]).includes(secretMarker), 'configuration diagnostics contain no credential values');

  const pulled = [];
  const pullLogs = [];
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const pull = new AsyncFunction('mkdir', 'writeFile', 'fileURLToPath', 'dirname', 'validateDeploymentConfig',
    'readCloudEnvironment', 'process', 'console', scriptBody('pull-deployment-config.mjs'));
  await pull(async () => {}, async (_target, content) => pulled.push(content), fileURLToPath, dirname,
    validateDeploymentConfig, () => [...cloudItems(profiles[0]),
      { key: 'CONNECTOR_DEPLOYMENT_CONFIG', value: JSON.stringify(profiles[0]) }],
    { argv: ['node', 'pull', '--app-id', profiles[0].miaodaAppId] }, { log: value => pullLogs.push(value) });
  check(pulled.length === 1 && !JSON.stringify([pulled, pullLogs]).includes(secretMarker),
    'pull persists only non-secret deployment JSON');
  assert.deepEqual(JSON.parse(pulled[0]), profiles[0]); checks += 1;
  for (const filename of ['mcp.json', '.mcp.json']) {
    const template = JSON.parse(await readFile(resolve(root, 'plugins/feishu', filename), 'utf8'));
    check(Object.keys(template.mcpServers).length === 0, 'repository template has no active remote endpoint');
  }
  console.log(JSON.stringify({ passed: true, checks, deployments: 2, realNetworkCalls: 0, realCloudCommands: 0 }));
} finally {
  globalThis.fetch = originalFetch;
  const within = relative(generatedRoot, temporary);
  if (!within || within.startsWith('..') || isAbsolute(within)) throw new Error('Unsafe test cleanup path.');
  await rm(temporary, { recursive: true, force: true });
}
