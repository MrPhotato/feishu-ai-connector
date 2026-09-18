import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Local-only configuration and request construction. No .env, credentials, or network.
globalThis.fetch = async () => { throw new Error('Network forbidden.'); };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireDependency = createRequire(import.meta.url);
const modules = new Map();
function loadTs(file) {
  const absolute = path.resolve(root, file);
  if (modules.has(absolute)) return modules.get(absolute).exports;
  const loaded = { exports: {} };
  modules.set(absolute, loaded);
  const compiled = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: absolute,
  }).outputText;
  const localRequire = (specifier) => specifier.startsWith('.')
    ? loadTs(path.resolve(path.dirname(absolute), `${specifier}.ts`)) : requireDependency(specifier);
  new Function('require', 'module', 'exports', '__dirname', compiled)(
    localRequire, loaded, loaded.exports, path.dirname(absolute),
  );
  return loaded.exports;
}

const originalDefault = process.env.CONNECTOR_DEFAULT_TIMEZONE;
const originalHostTimezone = process.env.TZ;
const originalDeployment = process.env.CONNECTOR_DEPLOYMENT_CONFIG;
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
try {
  delete process.env.CONNECTOR_DEPLOYMENT_CONFIG;
  process.env.CONNECTOR_DEFAULT_TIMEZONE = 'Asia/Tokyo';
  process.env.TZ = 'Pacific/Honolulu';
  const { connectorDefaultTimezone } = loadTs('server/config/connector-deployment.config.ts');
  const { isolatedEnvironment } = loadTs('server/modules/feishu-tools/feishu-cli.runner.ts');
  const { CALENDAR_TASK_OPERATIONS } = loadTs('server/modules/feishu-tools/feishu-calendar-task.operations.ts');
  const { catalogEntry } = loadTs('server/modules/feishu-tools/feishu-tools.registry.ts');
  const create = CALENDAR_TASK_OPERATIONS.find((item) => item.id === 'calendar.events.create');
  const update = CALENDAR_TASK_OPERATIONS.find((item) => item.id === 'calendar.events.update');
  assert.ok(create && update);
  const input = { calendarId: 'synthetic-calendar', summary: 'Synthetic timezone check',
    startTime: '1700000000', endTime: '1700003600' };
  const directory = path.resolve(os.tmpdir(), 'synthetic-timezone-not-created');
  const request = () => create.request(input).body;

  check(connectorDefaultTimezone({}) === 'UTC', 'unset deployment timezone defaults to UTC');
  check(request().start_time.timezone === 'Asia/Tokyo', 'configured timezone is applied to calendar creation');
  check(isolatedEnvironment(directory).TZ === 'Asia/Tokyo', 'CLI receives the deployment timezone');

  process.env.CONNECTOR_DEFAULT_TIMEZONE = 'America/New_York';
  const changed = request();
  check(changed.start_time.timezone === 'America/New_York' && changed.end_time.timezone === 'America/New_York',
    'calendar start/end resolve configuration after module import');
  check(isolatedEnvironment(directory).TZ === 'America/New_York', 'CLI resolves configuration for each invocation');
  check(catalogEntry(create).inputSchema.properties.timezone.default === 'America/New_York',
    'catalog default agrees with current runtime configuration');

  delete process.env.CONNECTOR_DEFAULT_TIMEZONE;
  check(request().start_time.timezone === 'UTC' && request().end_time.timezone === 'UTC',
    'calendar has a neutral UTC default without configuration');
  check(isolatedEnvironment(directory).TZ === 'UTC', 'CLI ignores the host timezone when configuration is absent');
  const explicit = create.request({ ...input, timezone: 'Europe/Paris' }).body;
  check(explicit.start_time.timezone === 'Europe/Paris' && explicit.end_time.timezone === 'Europe/Paris',
    'an explicit request timezone overrides the deployment default');
  const patch = update.request({ ...input, eventId: 'synthetic-event', notifyAttendees: false }).body;
  check(patch.start_time.timezone === undefined && patch.end_time.timezone === undefined,
    'PATCH omission retains existing timezone behavior');
  const explicitPatch = update.request({ ...input, eventId: 'synthetic-event', notifyAttendees: false,
    timezone: 'Europe/Paris' }).body;
  check(explicitPatch.start_time.timezone === 'Europe/Paris' && explicitPatch.end_time.timezone === 'Europe/Paris',
    'PATCH retains explicitly supplied timezone');

  process.env.CONNECTOR_DEFAULT_TIMEZONE = 'Invalid/Timezone';
  process.env.CONNECTOR_DEPLOYMENT_CONFIG = JSON.stringify({
    miaodaAppId: 'app_timezonefixture', publicUrl: 'https://timezone.example/app/app_timezonefixture',
    feishuAppId: 'cli_timezonefixture', defaultTimezone: 'Europe/London',
    displayName: 'Synthetic timezone fixture', author: 'Test fixture',
  });
  check(request().start_time.timezone === 'Europe/London' && request().end_time.timezone === 'Europe/London',
    'calendar resolves cloud JSON timezone ahead of the legacy environment variable');
  check(isolatedEnvironment(directory).TZ === 'Europe/London',
    'CLI resolves cloud JSON timezone ahead of the legacy environment variable');
  check(create.request({ ...input, timezone: 'Europe/Paris' }).body.start_time.timezone === 'Europe/Paris',
    'an explicit calendar timezone also overrides the cloud JSON default');
  delete process.env.CONNECTOR_DEPLOYMENT_CONFIG;

  for (const invalid of ['Invalid/Timezone', '../../etc/passwd', 'UTC\n']) {
    assert.throws(() => connectorDefaultTimezone({ CONNECTOR_DEFAULT_TIMEZONE: invalid }));
    checks++;
  }
  process.env.CONNECTOR_DEFAULT_TIMEZONE = 'Invalid/Timezone';
  assert.throws(() => request()); checks++;
  assert.throws(() => isolatedEnvironment(directory)); checks++;
  check(create.request({ ...input, timezone: 'Europe/Paris' }).body.start_time.timezone === 'Europe/Paris',
    'explicit timezone does not accidentally consult the default configuration');
  console.log(JSON.stringify({ ok: true, checks, network: false, credentials: false }));
} finally {
  if (originalDefault === undefined) delete process.env.CONNECTOR_DEFAULT_TIMEZONE;
  else process.env.CONNECTOR_DEFAULT_TIMEZONE = originalDefault;
  if (originalHostTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = originalHostTimezone;
  if (originalDeployment === undefined) delete process.env.CONNECTOR_DEPLOYMENT_CONFIG;
  else process.env.CONNECTOR_DEPLOYMENT_CONFIG = originalDeployment;
}
