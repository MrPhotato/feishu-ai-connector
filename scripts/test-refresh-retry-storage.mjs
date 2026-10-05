import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { getTableColumns } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pg-proxy';
import ts from 'typescript';

// Real repository, encryption and generated PostgreSQL; a bounded in-memory SQL driver, no network or real data.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dependency = createRequire(import.meta.url);
const cache = new Map();
function load(file) {
  const absolute = path.resolve(root, file);
  if (cache.has(absolute)) return cache.get(absolute).exports;
  const module = { exports: {} }; cache.set(absolute, module);
  const source = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    experimentalDecorators: true, emitDecoratorMetadata: true,
  } }).outputText;
  new Function('require', 'module', 'exports', source)((name) => {
    if (name === '@lark-apaas/fullstack-nestjs-core') return { DRIZZLE_DATABASE: 'synthetic-db' };
    if (name.startsWith('@server/')) return load(`server/${name.slice(8)}.ts`);
    if (name.startsWith('.')) return load(path.resolve(path.dirname(absolute), `${name}.ts`));
    return dependency(name);
  }, module, module.exports);
  return module.exports;
}
process.env.CONNECTOR_STORAGE_ENCRYPTION_KEY = '12'.repeat(32);
const { ConnectorAuthStorageRepository } = load('server/modules/connector-auth-storage/connector-auth-storage.repository.ts');
const { ConnectorAuthStorageCrypto } = load('server/modules/connector-auth-storage/connector-auth-storage.crypto.ts');
const { storageCommandSchema, storageFileBatchCommandSchema } = load('server/modules/connector-auth-storage/connector-auth-storage.contract.ts');
const { ConnectorAuthDiagnostics } = load('server/modules/connector-auth/connector-auth.diagnostics.ts');
const { connectorAuthRecord } = load('server/database/schema.ts');
const crypto = new ConnectorAuthStorageCrypto();
const columns = Object.entries(getTableColumns(connectorAuthRecord));
const names = new Map(columns.map(([key, column]) => [column.name, key]));
const driverRow = (row) => columns.map(([key]) => row[key] instanceof Date ? row[key].toISOString() : row[key]);
const rows = new Map();
const queries = [];
let claimGate;
let serial = 0;
const identity = (row) => `${row.model}:${row.keyHash}`;
function whereMatches(row, sql, params) {
  const where = sql.slice(sql.indexOf(' where ') + 7);
  const predicates = [...where.matchAll(/"connector_auth_record"\."([^"]+)" (is null|= \$\d+|> \$\d+)/gu)];
  assert.ok(predicates.length > 0, 'test driver never accepts an unconstrained query');
  return predicates.every(([, column, operation]) => {
    const value = row[names.get(column)];
    if (operation === 'is null') return value == null;
    const expected = params[Number(operation.match(/\d+/u)[0]) - 1];
    return operation.startsWith('>') ? new Date(value).getTime() > new Date(expected).getTime() : value === expected;
  });
}
const db = drizzle(async (sql, params) => {
  queries.push({ sql, params });
  if (sql.startsWith('select ')) {
    const matches = [...rows.values()].filter((row) => whereMatches(row, sql, params));
    const result = matches.map((row) => sql.startsWith('select "id" from') ? [row.id] : driverRow(row));
    if (claimGate && !sql.startsWith('select "id" from') && params.includes(claimGate.keyHash)) {
      const gate = claimGate;
      if (++gate.reads === 2) { claimGate = undefined; gate.release(); }
      await gate.promise; // Both instances receive a snapshot with consumedAt=NULL before either performs its CAS.
    }
    return { rows: result };
  }
  if (sql.startsWith('insert ')) {
    const insert = sql.match(/^insert into "connector_auth_record" \(([^)]+)\) values \(([^)]+)\)/u);
    assert.ok(insert);
    const fields = insert[1].split(', ').map((field) => field.replaceAll('"', ''));
    const values = insert[2].split(', ');
    const incoming = { id: `synthetic-${++serial}`, consumedAt: null, uidHash: null, grantHash: null,
      createdAt: new Date(), updatedAt: new Date(), createdBy: null, updatedBy: null };
    fields.forEach((field, index) => {
      if (values[index] === 'default') return;
      assert.match(values[index], /^\$\d+$/u);
      const value = params[Number(values[index].slice(1)) - 1];
      incoming[names.get(field)] = field === 'expires_at' ? new Date(value) : value;
    });
    const key = identity(incoming);
    const previous = rows.get(key);
    if (sql.includes('do nothing')) {
      if (!previous) rows.set(key, incoming);
      return { rows: [] };
    }
    const update = sql.split('do update set ')[1];
    assert.ok(update);
    assert.doesNotMatch(update.split(' where ')[0], /"(?:consumed_at|uid_hash|grant_hash)"/u);
    assert.match(update, /"uid_hash" (?:is null|= \$\d+)/u);
    assert.match(update, /"grant_hash" (?:is null|= \$\d+)/u);
    if (previous && !whereMatches(previous, sql, params)) return { rows: [] };
    rows.set(key, previous ? { ...previous, payloadCiphertext: incoming.payloadCiphertext, expiresAt: incoming.expiresAt } : incoming);
    return { rows: [[rows.get(key).id]] };
  }
  if (sql.startsWith('update ')) {
    assert.match(sql, /"consumed_at" is null/u);
    assert.match(sql, /"expires_at" > \$\d+/u);
    const matches = [...rows.values()].filter((row) => whereMatches(row, sql, params));
    assert.ok(matches.length <= 1);
    for (const row of matches) row.consumedAt = new Date(params[0]); // Atomic driver turn; second CAS sees this value.
    return { rows: matches.map((row) => [row.id]) };
  }
  assert.match(sql, /^delete from /u);
  for (const [key, row] of rows) if (whereMatches(row, sql, params)) rows.delete(key);
  return { rows: [] };
});
const first = new ConnectorAuthStorageRepository(db, crypto);
const second = new ConnectorAuthStorageRepository(db, crypto);
const oldTokenHash = crypto.hash('key', 'oauth-refresh-retry:v1', 'synthetic-old-refresh-token');
const fingerprint = crypto.hash('key', 'oauth-refresh-request:v1', 'synthetic-exact-request');
const grantId = 'synthetic-grant';
const expiry = Math.floor(Date.now() / 1000) + 3600;
const responseExpiry = Math.floor(Date.now() / 1000) + 45;
const command = (model, extra = {}) => ({ operation: 'put', model, key: oldTokenHash, uid: fingerprint, grantId,
  payload: { grantId, accountId: 'tenant:synthetic', requestFingerprint: fingerprint,
    ...(model === 'RefreshResponse' ? { tokenResponse: { refresh_token: 'synthetic-successor', access_token: 'synthetic-access' } } : {}) },
  expiresAt: model === 'RefreshResponse' ? responseExpiry : expiry, ...extra });
const logs = [];
const diagnostics = new ConnectorAuthDiagnostics((value) => logs.push(JSON.parse(value)));
for (const model of ['RefreshRetry', 'RefreshResponse']) {
  assert.ok(storageCommandSchema.safeParse(command(model)).success);
  assert.ok(storageCommandSchema.safeParse({ operation: 'get', model, key: oldTokenHash }).success);
  assert.equal(storageFileBatchCommandSchema.safeParse([{ operation: 'get', model, key: oldTokenHash }]).success, false);
  await first.execute(command(model));
  assert.deepEqual((await second.execute({ operation: 'get', model, key: oldTokenHash })).record, command(model).payload);
  diagnostics.storage('get', model, true, 1);
  assert.equal(logs.at(-1).model, model);
}
assert.ok(!JSON.stringify(logs).includes(oldTokenHash));
assert.ok(!JSON.stringify(logs).includes('synthetic-successor'));

// Real SQL compare-and-set, exercised by two repository instances that both observe the old snapshot.
const gate = Promise.withResolvers();
claimGate = { keyHash: crypto.hash('key', 'RefreshRetry', oldTokenHash), reads: 0, promise: gate.promise, release: gate.resolve };
const claims = await Promise.all([first, second].map((repository) => repository.execute({
  operation: 'consume', model: 'RefreshRetry', key: oldTokenHash,
})));
assert.deepEqual(claims.map((value) => value.consumed).sort(), [false, true]);
assert.equal(queries.filter(({ sql }) => sql.startsWith('update ')).length, 2, 'both instances reached the atomic CAS');
const consumed = (await first.execute({ operation: 'get', model: 'RefreshRetry', key: oldTokenHash })).record.consumed;
assert.ok(Number.isInteger(consumed));

await second.execute(command('RefreshRetry', { payload: { ...command('RefreshRetry').payload, consumed: 0 } }));
assert.equal((await first.execute({ operation: 'get', model: 'RefreshRetry', key: oldTokenHash })).record.consumed, consumed);
assert.equal((await second.execute({ operation: 'consume', model: 'RefreshRetry', key: oldTokenHash })).consumed, false);
for (const model of ['RefreshRetry', 'RefreshResponse']) {
  const before = structuredClone(rows.get(`${model}:${crypto.hash('key', model, oldTokenHash)}`));
  await assert.rejects(second.execute(command(model, { uid: 'different-request-fingerprint' })), /Storage operation unavailable/u);
  assert.deepEqual(rows.get(identity(before)), before, 'immutable fingerprint conflict cannot modify the row');
  await assert.rejects(second.execute(command(model, { grantId: 'other-grant',
    payload: { ...command(model).payload, grantId: 'other-grant' } })), /Storage operation unavailable/u);
  assert.deepEqual(rows.get(identity(before)), before, 'immutable grant conflict cannot modify the row');
  assert.equal(before.expiresAt.getTime(), command(model).expiresAt * 1000, 'absolute TTL is preserved');
}

const unrelated = command('RefreshResponse', { key: 'other-key', grantId: 'other-grant',
  payload: { grantId: 'other-grant', accountId: 'other-account' } });
await first.execute(unrelated);
const revokeStart = queries.length;
await first.execute({ operation: 'revokeGrant', grantId });
assert.match(queries[revokeStart].sql, /^insert /u);
assert.ok(queries[revokeStart].params.includes('GrantRevocation'), 'permanent tombstone precedes row deletion');
assert.equal(queries[revokeStart + 2].sql.includes('"grant_hash" ='), true);
for (const model of ['RefreshRetry', 'RefreshResponse']) {
  assert.equal((await second.execute({ operation: 'get', model, key: oldTokenHash })).record, undefined);
  assert.equal(rows.has(`${model}:${crypto.hash('key', model, oldTokenHash)}`), false);
  await assert.rejects(second.execute(command(model)), /Storage operation unavailable/u);
}
assert.deepEqual((await second.execute({ operation: 'get', model: unrelated.model, key: unrelated.key })).record, unrelated.payload);
assert.equal((await second.execute({ operation: 'consume', model: 'RefreshRetry', key: oldTokenHash })).consumed, false);
console.log(JSON.stringify({ ok: true, network: false, database: 'synthetic SQL driver',
  coverage: 'new model schemas and safe diagnostics; encrypted roundtrip; two-instance consume CAS; immutable fingerprint/grant; upsert preserves consumedAt and absolute expiry; grant tombstone deletes both models and blocks resurrection' }));
