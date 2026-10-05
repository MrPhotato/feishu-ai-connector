import 'reflect-metadata';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Logger } from '@nestjs/common';
import { loadDeploymentConfig, assertCompatibleCloudIdentity, deploymentFetch } from './lib/deployment-config.mjs';
import { readCloudEnvironment } from './lib/deployment-platform.mjs';

// Run explicitly only after the confidential-client release is deployed. This script writes UUID-scoped synthetic
// OAuth fixtures through encrypted cloud storage. It does not log in a real user or call any Feishu business API.
// Local RSA keys only instantiate the fixture provider; /oidc/token responses are signed by the cloud deployment.
const require = createRequire(import.meta.url);
const CLIENT_ID = 'chatgpt_confidential';
const MAX_RESPONSE_BYTES = 128 * 1024;
const fixtures = [];
const metrics = [];
const storageOperations = new Map();
const storageFailures = new Map();
const allowedOperations = new Set(['get', 'put', 'consume', 'remove', 'revokeGrant', 'findUid', 'acquireLease', 'releaseLease']);
const allowedModels = new Set(['FeishuAccount', 'Grant', 'Consent', 'RefreshToken', 'RefreshRetry', 'RefreshResponse', 'none']);
const allowedFailures = new Set(['validation', 'config', 'http', 'network_timeout', 'network', 'response_invalid']);
const loggerMethods = ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'];
const originalLogger = new Map(loggerMethods.map((method) => [method, Logger.prototype[method]]));
const envKeys = ['CONNECTOR_STORAGE_API_KEY', 'CONNECTOR_STORAGE_ENCRYPTION_KEY', 'CONNECTOR_PUBLIC_URL', 'CONNECTOR_DEPLOYMENT_CONFIG'];
const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
const started = performance.now();
let phase = 'configuration';
let checks = 0;
let ok = false;
let cleanupComplete = true;
let store;
let deployment;
let environment = [];
let tokenRequests = 0;
let clientSecret;
let cleanedAccounts = 0;
let revokedGrants = 0;

function captureDiagnostic(message) {
  try {
    const row = typeof message === 'string' ? JSON.parse(message) : undefined;
    if (row?.event !== 'connector_auth_storage') return;
    const operation = allowedOperations.has(row.operation) ? row.operation : 'other';
    const model = allowedModels.has(row.model) ? row.model : 'other';
    const key = `${operation}:${model}`;
    const metric = storageOperations.get(key) ?? { count: 0, failed: 0, durationMs: 0 };
    metric.count++;
    metric.failed += row.ok === false ? 1 : 0;
    metric.durationMs += Number.isFinite(row.durationMs) && row.durationMs >= 0 ? Math.round(row.durationMs) : 0;
    storageOperations.set(key, metric);
    if (row.ok === false) {
      const reason = allowedFailures.has(row.failureReason) ? row.failureReason : 'other';
      const status = Number.isInteger(row.upstreamStatus) && row.upstreamStatus >= 100 && row.upstreamStatus <= 599
        ? row.upstreamStatus : 0;
      const failure = `${reason}:${status}`;
      storageFailures.set(failure, (storageFailures.get(failure) ?? 0) + 1);
    }
  } catch { /* Never print arbitrary logger arguments, errors, ciphertext, IDs or credentials. */ }
}
for (const method of loggerMethods) Logger.prototype[method] = captureDiagnostic;

function stage(next) {
  phase = next;
  console.log(JSON.stringify({ phase, elapsedMs: Math.round(performance.now() - started) }));
}
async function jsonBody(response) {
  assert.ok(response.headers.get('content-type')?.includes('application/json'));
  assert.ok(response.body);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      assert.ok(size <= MAX_RESPONSE_BYTES);
      chunks.push(part.value);
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
    return parsed;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
async function tokenRequest(token, label, { secret = clientSecret, discard = false } = {}) {
  stage(label);
  const begin = performance.now();
  let status = 0;
  tokenRequests++;
  try {
    const params = { grant_type: 'refresh_token', client_id: CLIENT_ID,
      refresh_token: token, resource: `${deployment.publicUrl}/mcp`, scope: 'feishu.read' };
    if (secret !== null) params.client_secret = secret;
    const response = await deploymentFetch(deployment, `${deployment.publicUrl}/oidc/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(params).toString(), redirect: 'error', signal: AbortSignal.timeout(60000),
    });
    status = response.status;
    assert.ok(response.headers.get('cache-control')?.split(',').some((value) => value.trim() === 'no-store'));
    assert.ok(response.headers.get('pragma')?.split(',').some((value) => value.trim() === 'no-cache'));
    checks += 2;
    if (discard) {
      // The server has completed and sent headers; discard the whole body to model a lost success response.
      await response.body?.cancel();
      return { status, discarded: true };
    }
    const body = await jsonBody(response);
    return { body, status };
  } finally {
    metrics.push({ phase: label, status, durationMs: Math.round(performance.now() - begin) });
  }
}
function success(reply, sourceToken) {
  assert.equal(reply.status, 200);
  assert.equal(reply.body.token_type, 'Bearer');
  assert.equal(reply.body.scope, 'feishu.read');
  assert.ok(typeof reply.body.access_token === 'string' && reply.body.access_token.length > 0);
  assert.equal(reply.body.refresh_token, sourceToken);
  assert.ok(Number.isInteger(reply.body.expires_in) && reply.body.expires_in > 0 && reply.body.expires_in <= 600);
  checks += 6;
}
function rejected(reply, expectedError) {
  assert.ok(reply.status === 400 || reply.status === 401);
  assert.equal(reply.body.error, expectedError);
  assert.equal(reply.body.access_token, undefined);
  assert.equal(reply.body.refresh_token, undefined);
  checks += 4;
}
async function unchanged(fixture) {
  const record = await store.get('RefreshToken', fixture.oldToken);
  assert.ok(record);
  assert.equal(record.exp, fixture.expiry);
  assert.equal(record.iiat, fixture.issuedAt);
  assert.equal(record.consumed, undefined);
  assert.ok(await store.get('Grant', fixture.grantId));
  checks += 5;
}
async function revoke(token) {
  stage('client_revocation');
  const begin = performance.now();
  let status = 0;
  try {
    const response = await deploymentFetch(deployment, `${deployment.publicUrl}/oidc/token/revocation`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: clientSecret,
        token, token_type_hint: 'refresh_token' }).toString(), redirect: 'error', signal: AbortSignal.timeout(60000),
    });
    status = response.status;
    await response.body?.cancel();
    assert.equal(status, 200);
    checks++;
  } finally { metrics.push({ phase: 'client_revocation', status, durationMs: Math.round(performance.now() - begin) }); }
}

try {
  deployment = loadDeploymentConfig();
  environment = readCloudEnvironment(deployment.miaodaAppId);
  assertCompatibleCloudIdentity(environment, deployment);
  for (const key of ['CONNECTOR_STORAGE_API_KEY', 'CONNECTOR_STORAGE_ENCRYPTION_KEY']) {
    const value = environment.find((item) => item.key === key)?.value;
    assert.ok(typeof value === 'string' && value);
    process.env[key] = value;
  }
  clientSecret = environment.find((item) => item.key === 'CONNECTOR_CHATGPT_CLIENT_SECRET')?.value;
  assert.ok(typeof clientSecret === 'string' && clientSecret);
  assert.notEqual(clientSecret, environment.find((item) => item.key === 'FEISHU_APP_SECRET')?.value);
  environment.length = 0;
  process.env.CONNECTOR_PUBLIC_URL = deployment.publicUrl;
  delete process.env.CONNECTOR_DEPLOYMENT_CONFIG;
  const { ConnectorAuthStorageCrypto } = require('../dist/server/modules/connector-auth-storage/connector-auth-storage.crypto.js');
  const { ConnectorAuthStorageService } = require('../dist/server/modules/connector-auth-storage/connector-auth-storage.service.js');
  const { createConnectorOidc } = require('../dist/server/modules/connector-auth/connector-oidc.factory.js');
  const { ConnectorAuthDiagnostics } = require('../dist/server/modules/connector-auth/connector-auth.diagnostics.js');
  store = new ConnectorAuthStorageService(new ConnectorAuthStorageCrypto());
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const signingKey = { ...privateKey.export({ format: 'jwk' }), alg: 'RS256', use: 'sig', kid: 'synthetic-cloud-refresh-fixture' };
  const config = { publicUrl: deployment.publicUrl, issuer: `${deployment.publicUrl}/oidc`,
    resource: `${deployment.publicUrl}/mcp`, signingJwks: { keys: [signingKey] },
    cookieKeys: [randomBytes(32).toString('hex')], feishuAppId: deployment.feishuAppId,
    feishuAppSecret: 'synthetic-never-used', feishuScopes: 'synthetic:read', chatgptClientSecret: clientSecret };
  const { provider } = createConnectorOidc(config, store, { diagnostics: new ConnectorAuthDiagnostics(captureDiagnostic) });
  const client = await provider.Client.find(CLIENT_ID);
  assert.ok(client);

  async function prepare(label) {
    stage(label);
    const suffix = randomUUID();
    const fixture = { accountId: `synthetic-confidential:${suffix}`, grantId: undefined, oldToken: undefined };
    fixtures.push(fixture); // Track before any cloud write, including an acknowledgement lost during preparation.
    const now = Math.floor(Date.now() / 1000);
    const expiry = now + 900;
    fixture.issuedAt = now - 3600;
    fixture.expiry = expiry;
    // Pin the absolute expiry on the model itself: save() may serialize a computed exp without updating the object.
    const grant = new provider.Grant({ accountId: fixture.accountId, clientId: CLIENT_ID, exp: expiry, expiresIn: 900 });
    grant.jti = grant.generateTokenId();
    fixture.grantId = grant.jti;
    grant.addResourceScope(config.resource, 'feishu.read');
    await store.put('FeishuAccount', fixture.accountId, { tenant_key: 'synthetic-confidential', open_id: suffix,
      access_token: 'synthetic-no-feishu-business-access', expires_at: expiry, scope: 'synthetic:read' }, expiry);
    assert.equal(await grant.save(), fixture.grantId);
    assert.equal(grant.exp, expiry);
    await store.put('Consent', fixture.grantId, { accountId: fixture.accountId, grantId: fixture.grantId,
      clientId: CLIENT_ID, resource: config.resource, scopes: ['feishu.read'], expiresAt: expiry },
    expiry, undefined, fixture.grantId);
    // Explicit expiresIn avoids invoking the request-context TTL hook outside a token request.
    const refreshRemaining = grant.exp - Math.floor(Date.now() / 1000);
    assert.ok(Number.isInteger(refreshRemaining) && refreshRemaining > 0 && refreshRemaining <= 900);
    const refresh = new provider.RefreshToken({ accountId: fixture.accountId, client, grantId: fixture.grantId,
      scope: 'feishu.read', resource: config.resource, expiresWithSession: false,
      iiat: fixture.issuedAt, authTime: fixture.issuedAt, gty: 'authorization_code', exp: grant.exp, expiresIn: refreshRemaining });
    fixture.oldToken = await refresh.save();
    assert.ok(typeof fixture.oldToken === 'string' && fixture.oldToken);
    return fixture;
  }

  const fixture = await prepare('prepare_hour_old_confidential_token');
  success(await tokenRequest(fixture.oldToken, 'normal_refresh'), fixture.oldToken);
  await unchanged(fixture);

  const concurrent = await Promise.allSettled([
    tokenRequest(fixture.oldToken, 'concurrent_refresh_a'),
    tokenRequest(fixture.oldToken, 'concurrent_refresh_b'),
  ]);
  for (const result of concurrent) {
    assert.equal(result.status, 'fulfilled');
    success(result.value, fixture.oldToken);
  }
  await unchanged(fixture);

  const discarded = await tokenRequest(fixture.oldToken, 'discard_success_body', { discard: true });
  assert.equal(discarded.status, 200); assert.equal(discarded.discarded, true); checks += 2;
  success(await tokenRequest(fixture.oldToken, 'recover_discarded_response'), fixture.oldToken);
  await unchanged(fixture);

  rejected(await tokenRequest(fixture.oldToken, 'missing_client_secret', { secret: null }), 'invalid_client');
  await unchanged(fixture);
  rejected(await tokenRequest(fixture.oldToken, 'wrong_client_secret', {
    secret: `wrong-${randomBytes(32).toString('base64url')}`,
  }), 'invalid_client');
  await unchanged(fixture);
  success(await tokenRequest(fixture.oldToken, 'valid_after_rejected_client_auth'), fixture.oldToken);
  await unchanged(fixture);

  await revoke(fixture.oldToken);
  assert.equal(await store.get('Grant', fixture.grantId), undefined); checks++;
  rejected(await tokenRequest(fixture.oldToken, 'refresh_after_revocation'), 'invalid_grant');
  ok = true;
} catch {
  // Assertion values and exception stacks may contain token strings. Report only a fixed phase and numeric metrics.
  process.exitCode = 1;
} finally {
  const failedPhase = ok ? undefined : phase;
  stage('cleanup');
  environment.length = 0;
  clientSecret = undefined;
  if (store) {
    for (const fixture of fixtures) {
      if (fixture.grantId) {
        try { await store.revokeGrant(fixture.grantId); revokedGrants++; }
        catch { cleanupComplete = false; }
      }
      try { await store.remove('FeishuAccount', fixture.accountId); cleanedAccounts++; }
      catch { cleanupComplete = false; }
    }
  }
  if (!cleanupComplete) process.exitCode = 1;
  for (const [key, value] of previousEnv) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  for (const [method, original] of originalLogger) Logger.prototype[method] = original;
  console.log(JSON.stringify({ ok: ok && cleanupComplete, failedPhase, checks, tokenRequests,
    syntheticFixtures: fixtures.length, realBusinessData: false, durationMs: Math.round(performance.now() - started),
    metrics, cleanupComplete, cleanedAccounts, revokedGrants, grantTombstonesRetained: true,
    storageFailures: Object.fromEntries(storageFailures), storageOperations: Object.fromEntries(storageOperations) }));
}
