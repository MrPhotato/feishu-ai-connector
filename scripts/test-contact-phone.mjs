import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Synthetic read-only contact fixtures. No CLI business requests, network or real phone numbers.
globalThis.fetch = async () => { throw new Error('Network forbidden.'); };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireDependency = createRequire(import.meta.url);
const cache = new Map();
function loadTs(file) {
  const absolute = path.resolve(file);
  if (cache.has(absolute)) return cache.get(absolute).exports;
  const loaded = { exports: {} };
  cache.set(absolute, loaded);
  const compiled = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  new Function('require', 'module', 'exports', compiled)(
    (specifier) => specifier.startsWith('.')
      ? loadTs(path.resolve(path.dirname(absolute), `${specifier}.ts`)) : requireDependency(specifier),
    loaded, loaded.exports,
  );
  return loaded.exports;
}
const moduleRoot = path.join(root, 'server/modules/feishu-tools');
const { buildCliTask, executeCliTask } = loadTs(path.join(moduleRoot, 'feishu-cli.tasks.ts'));
const { parseFeishuTaskRequest } = loadTs(path.join(moduleRoot, 'feishu-task-tools.contract.ts'));
const make = (args) => buildCliTask(parseFeishuTaskRequest('get_user_phone', args), 'ou_synthetic_actor');
const success = (data, identity = 'user') => ({ exitCode: 0, output: { ok: true, identity, data } });
const userId = 'ou_synthetic_target';
const user = { open_id: userId, name: 'Synthetic Contact', mobile: '+1-202-555-0100', mobile_visible: true };
const searchUser = { open_id: userId, localized_name: 'Synthetic Contact', department: 'Synthetic Team' };
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
async function execute(plan, responses) {
  const calls = [];
  const result = await executeCliTask(plan, async (argv, budget) => {
    calls.push({ argv: [...argv], budget });
    const reply = responses[calls.length - 1];
    if (!reply) throw new Error('Unexpected additional request');
    return reply;
  });
  return { result, calls };
}
const byId = make({ userId });
check(byId.mode === 'read' && byId.argv[0] === 'api' && byId.argv[1] === 'GET', 'read-only fixed raw API method');
check(byId.argv[2] === `/open-apis/contact/v3/users/${userId}`, 'fixed official user-detail path');
assert.deepEqual(JSON.parse(byId.argv[byId.argv.indexOf('--params') + 1]),
  { user_id_type: 'open_id', department_id_type: 'open_department_id' }); checks++;
check(byId.argv[byId.argv.indexOf('--as') + 1] === 'user' && !byId.argv.includes('bot'), 'user identity only');
assert.deepEqual(byId.scopeGroups, [['contact:contact.base:readonly', 'contact:contact:access_as_app',
  'contact:contact:readonly', 'contact:contact:readonly_as_app'], ['contact:user.phone:readonly']]); checks++;
const byName = make({ query: 'Synthetic Contact' });
check(byName.argv[0] === 'contact' && byName.argv[1] === '+search-user', 'query uses existing contact search');
check(byName.scopeGroups.at(-1)[0] === 'contact:user:search', 'query requires search permission');
check(byName.argv[byName.argv.indexOf('--page-size') + 1] === '30', 'bounded candidate search');
for (const args of [
  {}, { query: 'Synthetic', userId }, { userId: 'me' }, { userId: 'on_synthetic' }, { userId: 'ou_' },
  { userId: 'ou_safe/../other' }, { userId: 'ou_safe?x=y' }, { userId: 'ou_safe%2Fother' },
  { userId: 'https://evil.invalid/user' }, { userId: 'ou_x#fragment' }, { userId: 'ou_x\\target' },
  { userId: `ou_${'x'.repeat(129)}` }, { query: '' }, { query: 'x'.repeat(51) },
  { userId, method: 'POST' }, { userId, host: 'https://evil.invalid' },
  { userId, accessToken: 'synthetic' }, { userId, as: 'bot' },
]) { assert.throws(() => make(args)); checks++; }
const literalQuery = '--as=bot; $(not-a-shell)';
const literal = make({ query: literalQuery });
check(literal.argv[literal.argv.indexOf('--query') + 1] === literalQuery, 'query retained as one literal argv value');
check(literal.argv[literal.argv.indexOf('--as') + 1] === 'user', 'query cannot replace fixed identity');

let run = await execute(byId, [success({ user: { ...user, unrelated: 'must-not-leak', access_token: 'not-returned' } })]);
check(run.result.ok && run.result.data.result.status === 'phone_returned' && run.calls.length === 1, 'explicit ID reads once');
assert.deepEqual(run.result.data.result.user, { openId: userId, name: user.name, mobile: user.mobile }); checks++;
check(!JSON.stringify(run.result).includes('must-not-leak') && !JSON.stringify(run.result).includes('not-returned'),
  'detail response exposes only identity/name/mobile');
run = await execute(byName, [success({ users: [searchUser], has_more: false }), success({ user })]);
check(run.result.ok && run.result.data.result.status === 'phone_returned' && run.calls.length === 2, 'unique complete candidate resolved');
check(run.calls[1].argv[2].endsWith(userId), 'detail uses returned candidate ID');
check(run.calls.every((call) => call.budget > 0 && call.budget <= 30000), 'two calls share bounded request budget');
for (const search of [
  { users: [searchUser, { ...searchUser, open_id: 'ou_synthetic_second' }], has_more: false },
  { users: [searchUser], has_more: true }, { users: [], has_more: true },
]) {
  run = await execute(byName, [success(search)]);
  check(run.result.ok && run.result.data.result.status === 'needs_disambiguation' && run.calls.length === 1,
    'ambiguous/incomplete search never reads a phone');
}
run = await execute(byName, [success({ users: [], has_more: false })]);
check(run.result.ok && run.result.data.result.status === 'no_matching_user' && run.calls.length === 1,
  'empty search is scoped evidence, no profile request');
run = await execute(byName, [success({ users: [{ ...searchUser, mobile: 'must-not-leak', token: 'must-not-leak' },
  { ...searchUser, open_id: 'ou_second' }], has_more: false })]);
check(!JSON.stringify(run.result).includes('must-not-leak'), 'disambiguation candidates exclude phone and unrelated fields');
for (const search of [{}, { users: [] }, { users: [], has_more: 'false' },
  { users: [{}], has_more: false }, { users: [{ open_id: 'ou_x/../../' }], has_more: false },
  { users: [null], has_more: false }, { users: [{ ...searchUser, localized_name: 'x'.repeat(257) }], has_more: false },
  { users: [{ ...searchUser, email: 'x'.repeat(321) }], has_more: false },
  { users: [{ ...searchUser, department: 'x'.repeat(2049) }], has_more: false },
  { users: Array.from({ length: 31 }, () => searchUser), has_more: false }]) {
  run = await execute(byName, [success(search)]);
  check(!run.result.ok && run.result.error.code === 'contact_response_invalid' && run.calls.length === 1,
    'malformed candidate result cannot create a false unique match');
}
for (const mobile of [undefined, null, '', '   ']) {
  run = await execute(byId, [success({ user: { ...user, mobile } })]);
  check(run.result.ok && run.result.data.result.status === 'phone_not_returned'
    && !('mobile' in run.result.data.result.user), 'empty phone has no invented reason');
}
run = await execute(byId, [success({ user: { ...user, mobile_visible: false } })]);
check(run.result.ok && run.result.data.result.status === 'phone_not_visible'
  && !JSON.stringify(run.result).includes(user.mobile), 'explicit invisibility suppresses even an included mobile');
run = await execute(byId, [success({ user: { ...user, mobile: '+1-202-***-0100' } })]);
check(run.result.ok && run.result.data.result.user.mobile === '+1-202-***-0100', 'mask retained without reconstruction');
for (const profile of [{ ...user, mobile: 123 }, { ...user, mobile: 'x'.repeat(129) },
  { ...user, name: 'x'.repeat(257) }, { ...user, mobile_visible: 'false' }, { ...user, mobile_visible: null }, { ...user, open_id: 'ou_other' },
  { name: 'Synthetic Contact', mobile: user.mobile }, undefined, null, []]) {
  run = await execute(byId, [success({ user: profile })]);
  check(!run.result.ok && run.result.error.code === 'contact_response_invalid', 'malformed/mismatched detail rejected');
}
for (const identity of ['bot', '', null, 'tenant']) {
  run = await execute(byId, [success({ user }, identity)]);
  check(!run.result.ok && !JSON.stringify(run.result).includes(user.mobile), 'non-user response identity rejected');
}
const missingIdentity = success({ user }); delete missingIdentity.output.identity;
run = await execute(byId, [missingIdentity]);
check(!run.result.ok, 'missing response identity rejected');
for (const plan of [byId, byName]) {
  for (const code of [99991672, 99991679, 99991676, 41050, 41012, 40001, 40003]) {
    // Pinned v1.0.95 errs/problem.go + internal/errclass/codemeta.go + output/errors.go.
    const authorization = [99991672, 99991679, 99991676].includes(code);
    const subtype = { 99991672: 'app_scope_not_applied', 99991679: 'missing_scope',
      99991676: 'token_scope_insufficient', 41050: 'unknown', 41012: 'unknown' }[code] || 'api_error';
    const reply = { exitCode: authorization ? 3 : [41050, 41012].includes(code) ? 1 : 4,
      output: { ok: false, identity: 'user',
      error: { type: authorization ? 'authorization' : 'api', code, subtype,
        ...(authorization ? { missing_scopes: ['contact:user.phone:readonly'] } : {}),
        message: 'synthetic raw payload must-not-leak' } } };
    run = await execute(plan, [reply]);
    check(!run.result.ok && run.calls.length === 1 && !JSON.stringify(run.result).includes('must-not-leak'),
      'upstream errors are not success, reauthorization failure or automatic retry');
    check(run.result.error.message.includes(String(code)), 'upstream business code preserved');
  }
}
run = await execute(byName, [success({ users: [searchUser], has_more: false }),
  { exitCode: 1, output: { ok: false, error: { code: 99991679 } } }]);
check(!run.result.ok && run.result.error.code === 'feishu_phone_permission_missing' && run.calls.length === 2,
  'permission failure after resolution remains scoped to the phone query');
const originalNow = Date.now;
try {
  let clock = originalNow(); Date.now = () => clock;
  const calls = [];
  const result = await executeCliTask(byName, async (argv) => {
    calls.push(argv); clock += 29500; return success({ users: [searchUser], has_more: false });
  });
  check(!result.ok && result.error.code === 'contact_lookup_timeout' && calls.length === 1,
    'spent search budget cannot initiate a late detail request');
} finally { Date.now = originalNow; }
console.log(`PASS: ${checks} contact-phone boundary and response assertions (synthetic only).`);
