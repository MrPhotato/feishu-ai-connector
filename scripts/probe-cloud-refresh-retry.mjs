import 'reflect-metadata';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { Logger } from '@nestjs/common';
import { loadDeploymentConfig, assertCompatibleCloudIdentity, deploymentFetch } from './lib/deployment-config.mjs';
import { readCloudEnvironment } from './lib/deployment-platform.mjs';

// Run explicitly only after the refresh-retry release is deployed. This script writes UUID-scoped synthetic
// OAuth fixtures through encrypted cloud storage. It does not log in a real user or call any Feishu business API.
// Local RSA keys only instantiate the fixture provider; /oidc/token responses are signed by the cloud deployment.
const require = createRequire(import.meta.url);
const WINDOW_MS = 30000;
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
async function tokenRequest(token, label) {
  stage(label);
  const begin = performance.now();
  let status = 0;
  tokenRequests++;
  try {
    const response = await deploymentFetch(deployment, `${deployment.publicUrl}/oidc/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: 'chatgpt',
        refresh_token: token, resource: `${deployment.publicUrl}/mcp`, scope: 'feishu.read' }).toString(),
      redirect: 'error', signal: AbortSignal.timeout(60000),
    });
    status = response.status;
    // Consume the complete response before simulating that the client never retained its replacement RT.
    const body = await jsonBody(response);
    assert.ok(response.headers.get('cache-control')?.split(',').some((value) => value.trim() === 'no-store'));
    assert.ok(response.headers.get('pragma')?.split(',').some((value) => value.trim() === 'no-cache'));
    checks += 2;
    return { body, status, completedAt: performance.now(), durationMs: performance.now() - begin };
  } finally {
    metrics.push({ phase: label, status, durationMs: Math.round(performance.now() - begin) });
  }
}
function success(reply) {
  assert.equal(reply.status, 200);
  assert.equal(reply.body.token_type, 'Bearer');
  assert.equal(reply.body.scope, 'feishu.read');
  assert.ok(typeof reply.body.access_token === 'string' && reply.body.access_token.length > 0);
  assert.ok(typeof reply.body.refresh_token === 'string' && reply.body.refresh_token.length > 0);
  assert.ok(Number.isInteger(reply.body.expires_in) && reply.body.expires_in > 0 && reply.body.expires_in <= 600);
  checks += 6;
}
function sameTokens(first, second) {
  success(second);
  assert.equal(second.body.access_token, first.body.access_token);
  assert.equal(second.body.refresh_token, first.body.refresh_token);
  assert.ok(second.body.expires_in < first.body.expires_in, 'cached lifetime must decrease');
  checks += 3;
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
    feishuAppSecret: 'synthetic-never-used', feishuScopes: 'synthetic:read' };
  const { provider } = createConnectorOidc(config, store, { diagnostics: new ConnectorAuthDiagnostics(captureDiagnostic) });
  const client = await provider.Client.find('chatgpt');
  assert.ok(client);

  async function prepare(label) {
    stage(label);
    const suffix = randomUUID();
    const fixture = { accountId: `synthetic-refresh:${suffix}`, grantId: undefined, oldToken: undefined };
    fixtures.push(fixture); // Track before any cloud write, including an acknowledgement lost during preparation.
    const now = Math.floor(Date.now() / 1000);
    const expiry = now + 900;
    // Pin the absolute expiry on the model itself: save() may serialize a computed exp without updating the object.
    const grant = new provider.Grant({ accountId: fixture.accountId, clientId: 'chatgpt', exp: expiry, expiresIn: 900 });
    grant.jti = grant.generateTokenId();
    fixture.grantId = grant.jti;
    grant.addResourceScope(config.resource, 'feishu.read');
    await store.put('FeishuAccount', fixture.accountId, { tenant_key: 'synthetic-refresh', open_id: suffix,
      access_token: 'synthetic-no-feishu-business-access', expires_at: expiry, scope: 'synthetic:read' }, expiry);
    assert.equal(await grant.save(), fixture.grantId);
    assert.equal(grant.exp, expiry);
    await store.put('Consent', fixture.grantId, { accountId: fixture.accountId, grantId: fixture.grantId,
      clientId: 'chatgpt', resource: config.resource, scopes: ['feishu.read'], expiresAt: expiry },
    expiry, undefined, fixture.grantId);
    // Explicit expiresIn avoids invoking the request-context TTL hook outside a token request.
    const refreshRemaining = grant.exp - Math.floor(Date.now() / 1000);
    assert.ok(Number.isInteger(refreshRemaining) && refreshRemaining > 0 && refreshRemaining <= 900);
    const refresh = new provider.RefreshToken({ accountId: fixture.accountId, client, grantId: fixture.grantId,
      scope: 'feishu.read', resource: config.resource, expiresWithSession: false,
      iiat: now, authTime: now, gty: 'authorization_code', exp: grant.exp, expiresIn: refreshRemaining });
    fixture.oldToken = await refresh.save();
    assert.ok(typeof fixture.oldToken === 'string' && fixture.oldToken);
    return fixture;
  }

  const oldRetryFixture = await prepare('prepare_old_retry');
  const initial = await tokenRequest(oldRetryFixture.oldToken, 'first_rotation');
  success(initial);
  assert.notEqual(initial.body.refresh_token, oldRetryFixture.oldToken); checks++;
  // No cloud reads, JWT verification, or other fixtures between these two requests.
  await delay(1100);
  const oldRetry = await tokenRequest(oldRetryFixture.oldToken, 'old_token_retry');
  sameTokens(initial, oldRetry);

  const cooldownFixture = await prepare('prepare_current_cooldown');
  const fresh = await tokenRequest(cooldownFixture.oldToken, 'cooldown_first_rotation');
  success(fresh);
  assert.notEqual(fresh.body.refresh_token, cooldownFixture.oldToken); checks++;
  await delay(1100);
  const cooled = await tokenRequest(fresh.body.refresh_token, 'current_token_cooldown');
  sameTokens(fresh, cooled);

  stage('wait_expired_retry_window');
  // Response creation precedes its complete receipt, so this exceeds the server's 30s cache lifetime.
  const replayAfter = initial.completedAt + WINDOW_MS + 1100;
  while (performance.now() < replayAfter) await delay(Math.min(5000, replayAfter - performance.now()));
  const expired = await tokenRequest(oldRetryFixture.oldToken, 'expired_old_token_replay');
  assert.equal(expired.status, 400);
  assert.equal(expired.body.error, 'invalid_grant');
  assert.equal(await store.get('Grant', oldRetryFixture.grantId), undefined);
  checks += 3;
  ok = true;
} catch {
  // Assertion values and exception stacks may contain token strings. Report only a fixed phase and numeric metrics.
  process.exitCode = 1;
} finally {
  const failedPhase = ok ? undefined : phase;
  stage('cleanup');
  environment.length = 0;
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
