import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { loadDeploymentConfig, assertDeploymentEnvironment, deploymentFetch } from './lib/deployment-config.mjs';

// Reads configuration without printing it. Never accepts credentials as CLI arguments.
// All records created here are random synthetic test data, isolated by a fresh prefix.
const deployment = loadDeploymentConfig();
assertDeploymentEnvironment(deployment);
const verifiedBase = deployment.publicUrl;
const requestAad = 'connector-auth-storage:request:v1';
const configuredBase = process.env.CONNECTOR_PUBLIC_URL ?? verifiedBase;
const apiKey = process.env.CONNECTOR_STORAGE_API_KEY ?? '';
const encryptionKey = process.env.CONNECTOR_STORAGE_ENCRYPTION_KEY ?? '';
const prefix = `synthetic-storage-${randomUUID()}`;
const modelKeys = [];
const leases = [];
let grantId;
let passed = 0;

function derivedKey() {
  return createHmac('sha256', Buffer.from(encryptionKey, 'hex'))
    .update('connector-auth-storage:encryption:v1').digest();
}

function seal(value, aad) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derivedKey(), nonce);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return ['v1', nonce.toString('base64url'), ciphertext.toString('base64url'),
    cipher.getAuthTag().toString('base64url')].join(':');
}

function open(value, aad) {
  const parts = value.split(':');
  assert.equal(parts.length, 4);
  assert.equal(parts[0], 'v1');
  const decipher = createDecipheriv('aes-256-gcm', derivedKey(), Buffer.from(parts[1], 'base64url'));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(parts[3], 'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(parts[2], 'base64url')),
    decipher.final()]).toString('utf8'));
}

async function sendSealed(sealed, key = apiKey) {
  const response = await deploymentFetch(deployment, `${verifiedBase}/openapi/connector-auth-storage/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ sealed }),
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  return response;
}

async function call(command) {
  const sealed = seal({ issuedAt: Date.now(), command }, requestAad);
  const response = await sendSealed(sealed);
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('Synthetic storage operation rejected.');
  }
  const envelope = await response.json();
  assert.deepEqual(Object.keys(envelope), ['sealed']);
  assert.equal(typeof envelope.sealed, 'string');
  const aad = `connector-auth-storage:response:v1:${createHash('sha256').update(sealed).digest('hex')}`;
  const decoded = open(envelope.sealed, aad);
  assert.equal(decoded.ok, true);
  return decoded;
}

async function put(model, key, payload, expiresAt, extras = {}) {
  modelKeys.push([model, key]);
  await call({ operation: 'put', model, key, payload, expiresAt, ...extras });
}

async function expectRejected(command, issuedAt = Date.now(), aad = requestAad) {
  const response = await sendSealed(seal({ issuedAt, command }, aad));
  assert.equal(response.status, 503);
  await response.body?.cancel();
  passed += 1;
}

async function checkLeases() {
  const leaseKey = `${prefix}-lease`;
  const leaseClaims = await Promise.all([
    call({ operation: 'acquireLease', key: leaseKey, ttlSeconds: 30 }),
    call({ operation: 'acquireLease', key: leaseKey, ttlSeconds: 30 }),
  ]);
  const winners = leaseClaims.filter((result) => typeof result.leaseToken === 'string');
  assert.equal(winners.length, 1);
  const owner = winners[0].leaseToken;
  leases.push([leaseKey, owner]);
  await call({ operation: 'releaseLease', key: leaseKey, leaseToken: randomBytes(32).toString('base64url') });
  assert.equal((await call({ operation: 'acquireLease', key: leaseKey, ttlSeconds: 30 })).leaseToken, undefined);
  await call({ operation: 'releaseLease', key: leaseKey, leaseToken: owner });
  const nextOwner = (await call({ operation: 'acquireLease', key: leaseKey, ttlSeconds: 30 })).leaseToken;
  assert.equal(typeof nextOwner, 'string');
  assert.notEqual(nextOwner, owner);
  leases.push([leaseKey, nextOwner]);
  await call({ operation: 'releaseLease', key: leaseKey, leaseToken: owner });
  assert.equal((await call({ operation: 'acquireLease', key: leaseKey, ttlSeconds: 30 })).leaseToken, undefined);
  await new Promise((resolve) => setTimeout(resolve, 31000));
  const expiredReplacement = (await call({ operation: 'acquireLease', key: leaseKey, ttlSeconds: 30 })).leaseToken;
  assert.equal(typeof expiredReplacement, 'string');
  leases.push([leaseKey, expiredReplacement]);
  await call({ operation: 'releaseLease', key: leaseKey, leaseToken: nextOwner });
  assert.equal((await call({ operation: 'acquireLease', key: leaseKey, ttlSeconds: 30 })).leaseToken, undefined);
  passed += 3;
}

try {
  assert.equal(configuredBase.replace(/\/$/u, ''), verifiedBase);
  assert.match(encryptionKey, /^[0-9a-fA-F]{64}$/u);
  assert.ok(apiKey && !/[\s\u0000-\u001f\u007f]/u.test(apiKey));
  const expiresAt = Math.floor(Date.now() / 1000) + 600;
  const missing = await call({ operation: 'get', model: 'Session', key: `${prefix}-absent` });
  assert.equal(missing.record, undefined);
  passed += 1;
  await checkLeases();

  const sessionKey = `${prefix}-session`;
  const uid = `${prefix}-uid`;
  await put('Session', sessionKey, { synthetic: true, uid }, expiresAt, { uid });
  assert.equal((await call({ operation: 'findUid', model: 'Session', uid })).record?.synthetic, true);
  await call({ operation: 'remove', model: 'Session', key: sessionKey });
  assert.equal((await call({ operation: 'findUid', model: 'Session', uid })).record, undefined);
  passed += 1;

  grantId = `${prefix}-grant`;
  const codeKey = `${prefix}-code`;
  const tokenKey = `${prefix}-token`;
  await put('Grant', grantId, { synthetic: true }, expiresAt);
  await put('AuthorizationCode', codeKey, { synthetic: true, grantId }, expiresAt, { grantId });
  await put('AccessToken', tokenKey, { synthetic: true, grantId }, expiresAt, { grantId });
  const claims = await Promise.all([
    call({ operation: 'consume', model: 'AuthorizationCode', key: codeKey }),
    call({ operation: 'consume', model: 'AuthorizationCode', key: codeKey }),
  ]);
  assert.equal(claims.filter((result) => result.consumed === true).length, 1);
  assert.equal(claims.filter((result) => result.consumed === false).length, 1);
  const consumed = (await call({ operation: 'get', model: 'AuthorizationCode', key: codeKey })).record?.consumed;
  assert.equal(typeof consumed, 'number');
  await put('AuthorizationCode', codeKey, { synthetic: true, grantId }, expiresAt, { grantId });
  assert.equal((await call({ operation: 'get', model: 'AuthorizationCode', key: codeKey })).record?.consumed, consumed);
  assert.equal((await call({ operation: 'consume', model: 'AuthorizationCode', key: codeKey })).consumed, false);
  passed += 2;

  await put('FeishuState', codeKey, { synthetic: true, isolatedModel: true }, expiresAt);
  assert.equal((await call({ operation: 'get', model: 'FeishuState', key: codeKey })).record?.isolatedModel, true);
  const expiredKey = `${prefix}-expired`;
  await put('FeishuState', expiredKey, { synthetic: true }, Math.floor(Date.now() / 1000) - 1);
  assert.equal((await call({ operation: 'get', model: 'FeishuState', key: expiredKey })).record, undefined);
  passed += 2;

  await call({ operation: 'revokeGrant', grantId });
  for (const [model, key] of [['Grant', grantId], ['AuthorizationCode', codeKey], ['AccessToken', tokenKey]]) {
    assert.equal((await call({ operation: 'get', model, key })).record, undefined);
  }
  passed += 1;
  await expectRejected({ operation: 'put', model: 'AuthorizationCode', key: codeKey,
    payload: { synthetic: true, grantId }, expiresAt, grantId });

  const validCommand = { operation: 'get', model: 'Session', key: `${prefix}-absent` };
  await expectRejected({ ...validCommand, arbitrarySql: 'not-a-query' });
  await expectRejected({ ...validCommand, model: 'GrantRevocation' });
  await expectRejected(validCommand, Date.now() - 120000);
  await expectRejected(validCommand, Date.now(), 'wrong-aad');
  const invalidKeyResponse = await sendSealed(
    seal({ issuedAt: Date.now(), command: validCommand }, requestAad), 'synthetic-invalid-key',
  );
  assert.equal(invalidKeyResponse.status, 403);
  await invalidKeyResponse.body?.cancel();
  passed += 1;
} catch {
  // Assertions can embed values; never print the caught exception or response.
  process.exitCode = 1;
} finally {
  if (apiKey && /^[0-9a-fA-F]{64}$/u.test(encryptionKey)
    && configuredBase.replace(/\/$/u, '') === verifiedBase) {
    for (const [model, key] of modelKeys) {
      try { await call({ operation: 'remove', model, key }); } catch { process.exitCode = 1; }
    }
    for (const [key, leaseToken] of leases) {
      try { await call({ operation: 'releaseLease', key, leaseToken }); } catch { process.exitCode = 1; }
    }
    if (grantId) {
      try { await call({ operation: 'revokeGrant', grantId }); } catch { process.exitCode = 1; }
    }
  }
}

if (process.exitCode === 1) {
  console.error(`Synthetic auth-storage checks or cleanup failed after ${passed} passing checks. Details suppressed.`);
} else {
  console.log(`Synthetic auth-storage checks passed: ${passed}; cleanup completed. No personal credentials used.`);
}
