import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Only synthetic environment values and source modules; no credentials, cloud, or build output.
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
  new Function('require', 'module', 'exports', compiled)(localRequire, loaded, loaded.exports);
  return loaded.exports;
}

const { loadConnectorAuthConfig } = loadTs('server/modules/connector-auth/connector-auth.config.ts');
const env = {
  CONNECTOR_PUBLIC_URL: 'https://auth.example/app/synthetic', FEISHU_APP_ID: 'cli_synthetic',
  FEISHU_APP_SECRET: 'synthetic-secret', CONNECTOR_COOKIE_KEYS: JSON.stringify(['k'.repeat(32)]),
  CONNECTOR_SIGNING_JWKS: JSON.stringify({ keys: [{ kty: 'RSA', d: 'synthetic', n: 'synthetic', e: 'AQAB', kid: 'test' }] }),
  CONNECTOR_FEISHU_SCOPES: 'offline_access synthetic:read',
};
let checks = 0;
function expectScopes(patch, expected) {
  assert.equal(loadConnectorAuthConfig({ ...env, ...patch }).feishuScopes, expected);
  checks++;
}
function expectRejected(patch) {
  assert.throws(() => loadConnectorAuthConfig({ ...env, ...patch }), (error) =>
    error.getStatus() === 503 && error.message === '连接服务尚未完成配置。');
  checks++;
}

expectScopes({}, env.CONNECTOR_FEISHU_SCOPES);
expectScopes({ CONNECTOR_FEISHU_ADDITIONAL_SCOPES: '' }, env.CONNECTOR_FEISHU_SCOPES);
expectScopes({ CONNECTOR_FEISHU_ADDITIONAL_SCOPES: '   ' }, env.CONNECTOR_FEISHU_SCOPES);
expectScopes({ CONNECTOR_FEISHU_SCOPES: '  offline_access  synthetic:read  offline_access ',
  CONNECTOR_FEISHU_ADDITIONAL_SCOPES: ' synthetic:read synthetic:write synthetic:write synthetic.other:read ' },
'offline_access synthetic:read synthetic:write synthetic.other:read');
// Match the previous trim + internal-space grammar; do not normalize illegal inner whitespace.
expectScopes({ CONNECTOR_FEISHU_SCOPES: '\t offline_access synthetic:read \n',
  CONNECTOR_FEISHU_ADDITIONAL_SCOPES: 'synthetic_without_colon synthetic-name:read' },
'offline_access synthetic:read synthetic_without_colon synthetic-name:read');
for (const invalid of ['scope:read,scope:write', '["scope:read"]', 'scope:read\nscope:write',
  'scope:read\tscope:write', 'scope:read\u0000', 'scope:read scope/write', 0, null, ['scope:read']]) {
  expectRejected({ CONNECTOR_FEISHU_SCOPES: invalid });
  expectRejected({ CONNECTOR_FEISHU_ADDITIONAL_SCOPES: invalid });
}
for (const primary of [undefined, '', '   ']) {
  expectRejected({ CONNECTOR_FEISHU_SCOPES: primary, CONNECTOR_FEISHU_ADDITIONAL_SCOPES: 'synthetic:read' });
}

// Two platform-sized settings must retain every scope after their combined length exceeds 4096.
const scopes = Array.from({ length: 227 }, (_, i) => `synthetic:permission_${String(i).padStart(3, '0')}:read`);
const primary = scopes.slice(0, 91).join(' ');
const additional = scopes.slice(91).join(' ');
assert.ok(primary.length <= 4096 && additional.length <= 4096 && scopes.join(' ').length > 4096); checks++;
expectScopes({ CONNECTOR_FEISHU_SCOPES: primary, CONNECTOR_FEISHU_ADDITIONAL_SCOPES: additional }, scopes.join(' '));
console.log(JSON.stringify({ passed: true, checks, realNetworkCalls: 0 }));
