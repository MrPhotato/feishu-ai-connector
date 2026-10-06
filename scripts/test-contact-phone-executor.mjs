import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Exercise the real task parser, scope gate, phone adapter and executor. Only
// credential storage and the CLI runner are synthetic; no sockets or subprocesses.
const forbidden = () => { throw new Error('Network and process execution forbidden in this test.'); };
globalThis.fetch = forbidden;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dependency = createRequire(import.meta.url);
const cache = new Map();
const stubs = {
  'node:http': { request: forbidden }, 'node:https': { request: forbidden },
  'node:dns/promises': { lookup: forbidden }, 'node:child_process': { spawn: forbidden },
};
function load(file) {
  const absolute = path.resolve(root, file);
  if (cache.has(absolute)) return cache.get(absolute).exports;
  const module = { exports: {} };
  cache.set(absolute, module);
  const code = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  new Function('require', 'module', 'exports', '__dirname', code)((name) => stubs[name] ?? (name.startsWith('.')
    ? load(path.resolve(path.dirname(absolute), `${name}.ts`)) : dependency(name)),
  module, module.exports, path.dirname(absolute));
  return module.exports;
}
const { FeishuToolExecutor } = load('server/modules/feishu-tools/feishu-tools.executor.ts');
const baseScopes = ['contact:contact.base:readonly', 'contact:contact:access_as_app',
  'contact:contact:readonly', 'contact:contact:readonly_as_app'];
const phoneScope = 'contact:user.phone:readonly';
const searchScope = 'contact:user:search';
const selectedId = 'ou_synthetic_selected';
const direct = { task: 'get_user_phone', arguments: { userId: selectedId } };
const byName = { task: 'get_user_phone', arguments: { query: 'Synthetic Colleague' } };
const findPeople = { task: 'find_people', arguments: { query: 'Synthetic Colleague' } };
const principal = { accountId: 'synthetic-tenant:ou_synthetic_caller', grantId: 'synthetic-grant',
  clientId: 'chatgpt', scopes: ['feishu.read'] };
const secondPrincipal = { ...principal, accountId: 'synthetic-tenant:ou_synthetic_other', grantId: 'other-grant' };
const expiresAt = Math.floor(Date.now() / 1000) + 3600;
let checks = 0;
function check(condition, description) { assert.ok(condition, description); checks++; }
function equal(actual, expected, description) { assert.deepEqual(actual, expected, description); checks++; }
function account(openId, scopes, suffix) {
  return { tenant_key: 'synthetic-tenant', open_id: openId, scope: scopes.join(' '),
    access_token: `synthetic-access-${suffix}`, refresh_token: `synthetic-refresh-${suffix}`,
    access_expires_at: expiresAt, refresh_expires_at: expiresAt };
}
function success(data) { return { exitCode: 0, output: { ok: true, identity: 'user', data } }; }
function defaultReply(argv) {
  if (argv[0] === 'contact' && argv[1] === '+search-user') return success({
    users: [{ open_id: selectedId, localized_name: 'Synthetic Colleague',
      enterprise_email: 'synthetic@example.test', department: 'Synthetic Department' }], has_more: false,
  });
  if (argv[0] === 'api' && argv[1] === 'GET') return success({
    user: { open_id: selectedId, name: 'Synthetic Colleague', mobile: 'SYNTHETIC-PHONE', mobile_visible: true },
  });
  throw new Error('Unexpected synthetic CLI command.');
}
function fixture(scopes = [baseScopes[0], phoneScope, searchScope]) {
  const records = new Map([
    [`FeishuAccount:${principal.accountId}`, account('ou_synthetic_caller', scopes, 'caller')],
    [`FeishuAccount:${secondPrincipal.accountId}`, account('ou_synthetic_other', scopes, 'other')],
    [`Grant:${principal.grantId}`, { accountId: principal.accountId, exp: expiresAt }],
    [`Consent:${principal.grantId}`, { accountId: principal.accountId, expiresAt }],
    ['RefreshToken:synthetic-connector-refresh', { grantId: principal.grantId, exp: expiresAt }],
  ]);
  const baseline = structuredClone(records);
  const reads = []; const mutations = []; const calls = [];
  let reply = defaultReply;
  const mutate = (operation) => async (...args) => {
    mutations.push({ operation, args }); throw new Error('Read task attempted to mutate authorization storage.');
  };
  const store = {
    async get(model, key) { reads.push({ model, key }); return structuredClone(records.get(`${model}:${key}`)); },
    put: mutate('put'), consume: mutate('consume'), remove: mutate('remove'), revokeGrant: mutate('revokeGrant'),
    acquireLease: mutate('acquireLease'), releaseLease: mutate('releaseLease'), findUid: mutate('findUid'),
  };
  const executor = new FeishuToolExecutor(store, forbidden,
    () => ({ clientId: 'cli_synthetic_phone_app', clientSecret: 'synthetic-app-secret-never-used' }), undefined,
    async (argv, credentials, options) => {
      calls.push(structuredClone({ argv, credentials, options }));
      return reply(argv, credentials);
    });
  return { records, baseline, reads, mutations, calls, executor,
    set reply(value) { reply = value; } };
}
function unchanged(test) {
  equal(test.mutations, [], 'phone lookup never writes, deletes, consumes or revokes credentials/grants');
  equal(test.records, test.baseline, 'account, grant, consent and refresh records are unchanged');
  check(test.reads.every((read) => read.model === 'FeishuAccount'), 'executor only reads caller account storage');
}
function checkRunner(test, expectedToken) {
  check(test.calls.length > 0, 'synthetic CLI was reached');
  for (const call of test.calls) {
    equal(call.credentials, { appId: 'cli_synthetic_phone_app', accessToken: expectedToken },
      'only the selected caller user token is injected; no refresh token or app secret');
    check(call.argv[call.argv.indexOf('--as') + 1] === 'user', 'CLI identity is explicitly user');
    check(!call.argv.some((part) => part.includes('synthetic-access-') || part.includes('synthetic-refresh-')),
      'tokens never enter argv');
  }
}
function noCredentialOutput(result) {
  const output = JSON.stringify(result);
  check(!['synthetic-access-', 'synthetic-refresh-', 'synthetic-app-secret'].some((value) => output.includes(value)),
    'public task response contains no injected credentials');
}

// Both missing field scope and missing interface scope stop before either lookup step.
for (const request of [direct, byName]) {
  for (const [scopes, missing] of [
    [[baseScopes[0], searchScope], [[phoneScope]]],
    [[phoneScope, searchScope], [baseScopes]],
    [[searchScope], [baseScopes, [phoneScope]]],
    [['contact:user.base:readonly', phoneScope, searchScope], [baseScopes]],
  ]) {
    const test = fixture(scopes);
    const result = await test.executor.executeTask(principal, request);
    check(result.ok === false && result.error.code === 'feishu_scope_missing', 'missing phone scope is a task permission failure');
    equal(result.error.scopeGroups, missing, 'missing groups preserve AND-of-OR scope semantics');
    equal(test.calls, [], 'scope failure occurs before any CLI call');
    const normal = await test.executor.executeTask(principal, findPeople);
    check(normal.ok === true && test.calls.length === 1, 'ordinary people search still works after denied phone lookup');
    unchanged(test); noCredentialOutput(result);
  }
}

// Every documented base alternative is sufficient; user.base is not substituted.
for (const baseScope of baseScopes) {
  const test = fixture([baseScope, phoneScope]);
  const result = await test.executor.executeTask(principal, direct);
  check(result.ok === true && result.data.result.status === 'phone_returned', 'each base OR alternative accepts direct ID lookup');
  checkRunner(test, 'synthetic-access-caller');
  equal(test.calls[0].argv.slice(0, 3), ['api', 'GET', `/open-apis/contact/v3/users/${selectedId}`],
    'phone access is limited to the fixed documented GET endpoint');
  equal(JSON.parse(test.calls[0].argv[test.calls[0].argv.indexOf('--params') + 1]),
    { user_id_type: 'open_id', department_id_type: 'open_department_id' }, 'ID types are fixed');
  unchanged(test); noCredentialOutput(result);
}
const missingSearch = fixture([baseScopes[0], phoneScope]);
const searchDenied = await missingSearch.executor.executeTask(principal, byName);
equal(searchDenied.error.scopeGroups, [[searchScope]], 'name lookup additionally requires search scope');
equal(missingSearch.calls, [], 'missing search scope rejects before CLI'); unchanged(missingSearch);

const full = fixture();
const found = await full.executor.executeTask(principal, byName);
check(found.ok === true && found.data.result.status === 'phone_returned' && full.calls.length === 2,
  'authorized unambiguous lookup runs search then detail');
checkRunner(full, 'synthetic-access-caller'); unchanged(full); noCredentialOutput(found);

// The same executor must never reuse one user's token for another user.
const isolated = fixture();
const scoped = isolated.executor.forRequest(principal.accountId,
  structuredClone(isolated.records.get(`FeishuAccount:${principal.accountId}`)));
const first = await scoped.executeTask(principal, direct);
const second = await scoped.executeTask(secondPrincipal, direct);
check(first.ok && second.ok, 'request-bound executor supports only matching snapshots and reloads other accounts');
equal(isolated.calls.map((call) => call.credentials.accessToken), ['synthetic-access-caller', 'synthetic-access-other'],
  'sequential accounts use their own exact access token');
equal(isolated.reads, [{ model: 'FeishuAccount', key: secondPrincipal.accountId }],
  'other account lookup cannot reuse the first request snapshot');
unchanged(isolated); noCredentialOutput(first); noCredentialOutput(second);
const mismatched = fixture();
const wrongSnapshot = mismatched.executor.forRequest(secondPrincipal.accountId,
  structuredClone(mismatched.records.get(`FeishuAccount:${principal.accountId}`)));
check((await wrongSnapshot.executeTask(secondPrincipal, direct)).ok === false && mismatched.calls.length === 0,
  'mismatched account identity stops before credential injection'); unchanged(mismatched);

const noRead = fixture();
const noReadResult = await noRead.executor.executeTask({ ...principal, scopes: ['feishu.write'] }, direct);
check(noReadResult.error.code === 'connector_scope_missing' && noRead.calls.length === 0 && noRead.reads.length === 0,
  'connector read scope is required before account or CLI access'); unchanged(noRead);

// An upstream business permission failure must not revoke the existing connection.
// Fixed CLI v1.0.95: internal/errclass/codemeta*.go and internal/output/exitcode.go.
// The contact-specific codes are unregistered and retain the API/unknown fallback.
for (const [code, type, subtype, exitCode] of [
  [99991672, 'authorization', 'app_scope_not_applied', 3],
  [99991679, 'authorization', 'missing_scope', 3],
  [99991676, 'authorization', 'token_scope_insufficient', 3],
  [41050, 'api', 'unknown', 1],
  [41012, 'api', 'unknown', 1],
]) {
  const test = fixture();
  test.reply = (argv) => argv[0] === 'api'
    ? { exitCode, output: { ok: false, identity: 'user', error: { code, type, subtype,
      message: 'synthetic-access-caller synthetic-refresh-caller must never be echoed' } } }
    : defaultReply(argv);
  const failed = await test.executor.executeTask(principal, direct);
  check(failed.ok === false && !/reauthorization_required|invalid_grant/u.test(failed.error.code),
    'upstream business error is not converted into connection revocation');
  noCredentialOutput(failed);
  check((await test.executor.executeTask(principal, findPeople)).ok === true,
    'existing ordinary search remains usable after upstream permission failure');
  unchanged(test);
}

// Both the search and detail success envelopes must attest the user identity.
for (const request of [direct, byName]) {
  for (const identity of [undefined, 'bot']) {
    const test = fixture();
    test.reply = (argv) => {
      const result = defaultReply(argv);
      if (identity === undefined) delete result.output.identity;
      else result.output.identity = identity;
      return result;
    };
    const result = await test.executor.executeTask(principal, request);
    check(result.ok === false && result.error.code === 'contact_response_invalid',
      'missing or non-user CLI identity cannot return a phone number');
    check(test.calls.length === 1, 'invalid search envelope cannot trigger detail request');
    unchanged(test); noCredentialOutput(result);
  }
}
console.log(JSON.stringify({ ok: true, checks, network: false, realCliCalls: false, realPersonalData: false,
  coverage: 'real executor scope preflight, base OR plus phone AND, per-user token isolation, no authorization mutation, ordinary search survives phone permission failures, user envelope identity' }));
