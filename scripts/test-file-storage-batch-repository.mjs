import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { getTableColumns } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pg-proxy';
import ts from 'typescript';

// Actual repository, crypto and Drizzle SQL generation; synthetic driver results only, no database or network.
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
const { connectorAuthRecord } = load('server/database/schema.ts');
const crypto = new ConnectorAuthStorageCrypto();
assert.equal(connectorAuthRecord.payloadCiphertext.name, 'payload_ciphertext', 'EXCLUDED name matches generated schema');
assert.equal(connectorAuthRecord.expiresAt.name, 'expires_at', 'EXCLUDED expiry name matches generated schema');
const columns = Object.keys(getTableColumns(connectorAuthRecord));
const expiry = Math.floor(Date.now() / 1000) + 900;
const grant = 'synthetic-grant';
const grantHash = crypto.hash('grant', grant);
const model = 'FeishuFileChunk';
const put = (index, extra = {}) => ({ operation: 'put', model, key: `synthetic-ticket:${index}`,
  payload: { grantId: grant, accountId: 'tenant:synthetic', index, data: Buffer.from(`chunk-${index}`).toString('base64') },
  expiresAt: expiry, ...extra });
const get = (index) => ({ operation: 'get', model, key: `synthetic-ticket:${index}` });
function row(index, options = {}) {
  const keyHash = crypto.hash('key', model, get(index).key);
  const payload = { ...put(index).payload, ...options.payload };
  return { id: `synthetic-${index}`, model, keyHash, uidHash: null, grantHash,
    payloadCiphertext: crypto.seal(payload, crypto.recordAad(model, keyHash)),
    expiresAt: new Date(expiry * 1000), consumedAt: null,
    createdAt: new Date(), createdBy: null, updatedAt: new Date(), updatedBy: null, ...options };
}
const driverRow = (value) => columns.map((name) => value[name] instanceof Date ? value[name].toISOString() : value[name]);
function fixture(steps) {
  const queries = [];
  const db = drizzle(async (sql, params) => {
    const index = queries.length;
    queries.push({ sql, params });
    assert.ok(index < steps.length, 'unexpected additional database query');
    return { rows: await steps[index]({ sql, params }) };
  });
  return { repository: new ConnectorAuthStorageRepository(db, crypto), queries,
    done() { assert.equal(queries.length, steps.length, 'expected bounded query count'); } };
}
function tombstone(expected, result = []) {
  return ({ sql, params }) => {
    assert.match(sql, /^select /u);
    assert.match(sql, /"model" = \$1/u);
    assert.equal(params[0], 'GrantRevocation');
    for (const hash of expected) assert.ok(params.includes(hash));
    assert.doesNotMatch(sql, /expires_at/u, 'revocation tombstones never expire through query filtering');
    return result;
  };
}
function checkBulkInsert(commands, rowsReturned = commands.length, ciphers = []) {
  return ({ sql, params }) => {
    assert.match(sql, /^insert into "connector_auth_record"/u);
    assert.match(sql, /on conflict \("model","key_hash"\) do update set /u);
    assert.match(sql, /"payload_ciphertext" = excluded\.payload_ciphertext/u);
    assert.match(sql, /"expires_at" = excluded\.expires_at/u);
    const update = sql.split('do update set ')[1];
    assert.doesNotMatch(update.split(' where ')[0], /"(?:consumed_at|uid_hash|grant_hash)"/u,
      'upsert cannot reset consumption or replace bindings');
    const uid = commands[0].uid ?? commands[0].payload.uid;
    if (uid) {
      assert.match(update, /where \("connector_auth_record"\."uid_hash" = \$\d+ and "connector_auth_record"\."grant_hash" = /u);
      assert.ok(params.includes(crypto.hash('uid', model, uid)));
    } else {
      assert.match(update, /where \("connector_auth_record"\."uid_hash" is null and "connector_auth_record"\."grant_hash" = /u);
    }
    const encrypted = params.filter((value) => typeof value === 'string' && value.startsWith('v1:'));
    assert.equal(encrypted.length, commands.length);
    assert.equal(new Set(encrypted).size, commands.length, 'each record uses independent encryption');
    for (const [index, command] of commands.entries()) {
      const hash = crypto.hash('key', model, command.key);
      assert.ok(params.includes(hash));
      assert.ok(params.includes(new Date(command.expiresAt * 1000).toISOString()));
      const expected = { ...command.payload }; delete expected.consumed;
      assert.deepEqual(crypto.open(encrypted[index], crypto.recordAad(model, hash)), expected);
      assert.throws(() => crypto.open(encrypted[index], crypto.recordAad(model, `${hash}-wrong`)), 'record AAD binds exact key');
    }
    ciphers.push(encrypted);
    return Array.from({ length: rowsReturned }, (_, index) => [`synthetic-${index}`]);
  };
}

for (const count of [1, 8, 16]) {
  const commands = Array.from({ length: count }, (_, index) => put(index));
  const ciphers = [];
  const f = fixture([tombstone([grantHash]), checkBulkInsert(commands, count, ciphers), tombstone([grantHash]),
    tombstone([grantHash]), checkBulkInsert(commands, count, ciphers), tombstone([grantHash])]);
  assert.deepEqual(await f.repository.executeFileBatch(commands), commands.map(() => ({ ok: true })));
  assert.deepEqual(await f.repository.executeFileBatch(commands), commands.map(() => ({ ok: true })));
  assert.notDeepEqual(ciphers[0], ciphers[1], 'retry reseals payload but preserves exact keys, content and absolute expiry');
  f.done();
}
const uidCommands = [put(0, { uid: 'synthetic-uid', payload: { ...put(0).payload, consumed: 999 } }),
  put(1, { payload: { ...put(1).payload, uid: 'synthetic-uid' } })];
const withUid = fixture([tombstone([grantHash]), checkBulkInsert(uidCommands), tombstone([grantHash])]);
assert.deepEqual(await withUid.repository.executeFileBatch(uidCommands), [{ ok: true }, { ok: true }]);
withUid.done();

// Out-of-order results, missing key, more than one grant, and a consumed payload all use only two queries.
const otherGrantHash = crypto.hash('grant', 'other-grant');
const consumedAt = new Date('2026-01-01T00:00:00Z');
const first = row(0, { payload: { consumed: 999 } });
const second = row(1, { consumedAt });
const revoked = row(2, { grantHash: otherGrantHash });
const reads = fixture([({ sql, params }) => {
  assert.match(sql, /"key_hash" in \(/u);
  assert.match(sql, /"expires_at" > /u);
  assert.equal(params[0], model);
  for (const index of [0, 1, 2, 3]) assert.ok(params.includes(crypto.hash('key', model, get(index).key)));
  return [driverRow(revoked), driverRow(second), driverRow(first)];
}, tombstone([grantHash, otherGrantHash], [[otherGrantHash]])]);
const result = await reads.repository.executeFileBatch([get(0), get(1), get(2), get(3)]);
assert.equal(result[0].record.index, 0);
assert.equal(result[0].record.consumed, undefined, 'payload cannot forge consumption');
assert.equal(result[1].record.index, 1);
assert.equal(result[1].record.consumed, Math.floor(consumedAt.getTime() / 1000));
assert.deepEqual(result.slice(2), [{ ok: true, record: undefined }, { ok: true, record: undefined }]);
reads.done();
const absent = fixture([() => []]);
assert.deepEqual(await absent.repository.executeFileBatch([get(9)]), [{ ok: true, record: undefined }]);
absent.done();
const fullRead = fixture([() => Array.from({ length: 16 }, (_, index) => driverRow(row(index))).reverse(),
  tombstone([grantHash])]);
assert.deepEqual((await fullRead.repository.executeFileBatch(Array.from({ length: 16 }, (_, index) => get(index))))
  .map((item) => item.record.index), Array.from({ length: 16 }, (_, index) => index));
fullRead.done();

// No writes before an existing revoke; a revoke racing after insertion triggers bounded cleanup.
const beforeRevoke = fixture([tombstone([grantHash], [['revoked']])]);
await assert.rejects(beforeRevoke.repository.executeFileBatch([put(0)]), /Storage operation unavailable/u);
beforeRevoke.done();
const afterRevoke = fixture([tombstone([grantHash]), checkBulkInsert([put(0), put(1)]),
  tombstone([grantHash], [['revoked']]), ({ sql, params }) => {
    assert.match(sql, /^delete from /u);
    assert.match(sql, /"grant_hash" = /u);
    assert.match(sql, /"key_hash" in \(/u);
    assert.deepEqual(params, [model, grantHash, crypto.hash('key', model, get(0).key), crypto.hash('key', model, get(1).key)]);
    return [];
  }]);
await assert.rejects(afterRevoke.repository.executeFileBatch([put(0), put(1)]), /Storage operation unavailable/u);
afterRevoke.done();
const bindingConflict = fixture([tombstone([grantHash]), checkBulkInsert([put(0), put(1)], 1), tombstone([grantHash])]);
await assert.rejects(bindingConflict.repository.executeFileBatch([put(0), put(1)]), /Storage operation unavailable/u);
bindingConflict.done();

const noSql = fixture([]);
for (const invalid of [null, [], Array.from({ length: 17 }, (_, index) => get(index)), [get(0), get(0)],
  [get(0), put(1)], [{ ...get(0), model: 'Grant' }], [{ operation: 'consume', model, key: 'synthetic' }],
  [{ ...get(0), unknown: 'reject' }], [put(0, { payload: {} })],
  [put(0), put(1, { grantId: 'different' })], [put(0), put(1, { payload: { grantId: 'different' } })],
  [put(0), put(1, { uid: 'different' })], [put(0, { uid: 'a', payload: { grantId: grant, uid: 'b' } })],
  [put(0, { expiresAt: 0 })], [put(0, { payload: { grantId: grant, data: 'x'.repeat(49152) } })]]) {
  await assert.rejects(noSql.repository.executeFileBatch(invalid), /Storage request rejected/u);
}
noSql.done();

const wrongAad = row(0);
wrongAad.payloadCiphertext = crypto.seal(put(0).payload, crypto.recordAad(model, 'wrong-key'));
const corrupt = fixture([() => [driverRow(wrongAad)], tombstone([grantHash])]);
await assert.rejects(corrupt.repository.executeFileBatch([get(0)]));
corrupt.done();
const old = row(0, { expiresAt: new Date(1) });
const expiryDefense = fixture([() => [driverRow(old)], tombstone([grantHash])]);
assert.deepEqual(await expiryDefense.repository.executeFileBatch([get(0)]), [{ ok: true, record: undefined }]);
expiryDefense.done();

console.log('PASS: file-only batch validation; real Drizzle SQL bounded to 2 read / 3 write queries; input order/missing/revoked rows; per-record AES-GCM/AAD; immutable conflict bindings and consumedAt; fixed-expiry retries; before/after revoke safeguards. Synthetic driver, no network/database.');
