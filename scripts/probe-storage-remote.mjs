import { loadDeploymentConfig, deploymentFetch } from './lib/deployment-config.mjs';
import { platformCommand } from './lib/deployment-platform.mjs';

const deployment = loadDeploymentConfig();
const base = deployment.publicUrl;
const cli = args => platformCommand(deployment.miaodaAppId, args);

async function check(name, path, key, method = 'POST') {
  const response = await deploymentFetch(deployment, `${base}${path}`, {
    method, redirect: 'manual', signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    ...(method === 'POST' ? { body: '{}' } : {}),
  });
  const body = await response.json().catch(() => ({}));
  const result = body.phase ? body : body.data;
  const known = result?.phase === 'synthetic-storage-probe';
  console.log(JSON.stringify({ name, status: response.status, ...(known ? { result } : {}) }));
  return { status: response.status, result: known ? result : undefined };
}

let keyId;
try {
  const created = cli(['+openapi-key-create', '--name', 'temporary-credential-isolation-probe',
    '--scope-api', 'POST /openapi/credential-probe/check']);
  keyId = created.api_key_id;
  if (typeof keyId !== 'string' || typeof created.api_key !== 'string') {
    console.log(JSON.stringify({ responseFields: Object.keys(created), keyFields: Object.keys(created.key ?? {}) }));
    throw new Error('Unexpected API Key response structure; no secret was printed.');
  }
  const system = await check('system', '/openapi/credential-probe/check', created.api_key);
  const anonymous = await check('anonymous', '/credential-probe/check');
  const missing = await check('missing-key', '/openapi/credential-probe/check');
  const invalid = await check('invalid-key', '/openapi/credential-probe/check', 'invalid-test-key');
  const otherMethod = await check('unscoped-method', '/openapi/credential-probe/check', created.api_key, 'GET');
  const repeated = await check('system-repeat', '/openapi/credential-probe/check', created.api_key);
  const passed = system.result?.roleCategory === 'apiKey' && system.result.expectedIsolation
    && repeated.result?.expectedIsolation && anonymous.result?.roleCategory === 'anonymous'
    && anonymous.result.expectedIsolation && [missing, invalid, otherMethod].every(x => x.status === 401 || x.status === 403);
  console.log(JSON.stringify({ passed, ordinaryUserSessionTested: false }));
  if (!passed) process.exitCode = 1;
} finally {
  if (keyId) {
    cli(['+openapi-key-disable', '--key-id', keyId]);
    console.log('Temporary probe key disabled.');
  }
}
