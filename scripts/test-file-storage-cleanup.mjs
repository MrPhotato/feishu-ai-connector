import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PgDialect } from 'drizzle-orm/pg-core';
import ts from 'typescript';

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
const { ConnectorAuthStorageRepository } = load('server/modules/connector-auth-storage/connector-auth-storage.repository.ts');
const dialect = new PgDialect();
const deletes = []; const inserts = [];
const db = {
  select() { return { from() { return { where() { return { async limit() { return []; } }; } }; } }; },
  delete() { return { async where(condition) { deletes.push(dialect.sqlToQuery(condition)); } }; },
  insert() { return { values(value) {
    inserts.push(value);
    return { onConflictDoUpdate() { return { async returning() { return [{ id: 'synthetic' }]; } }; },
      async onConflictDoNothing() {} };
  } }; },
};
const crypto = { hash: (...values) => values.join(':'), seal: () => 'synthetic-ciphertext', recordAad: () => 'synthetic-aad' };
const repository = new ConnectorAuthStorageRepository(db, crypto);
const ordinary = ['FeishuAccount', 'Grant', 'Session', 'AuthorizationCode', 'Consent', 'FeishuFileChunk'];
for (const model of ordinary) await repository.execute({ operation: 'get', model, key: 'synthetic' });
assert.equal(deletes.length, 0, 'ordinary OAuth/chunk reads never trigger cleanup');
await repository.execute({ operation: 'get', model: 'FeishuFile', key: 'missing-download' });
assert.equal(deletes.length, 1, 'download attempt cleans expired file records, even if ticket is absent');
function assertFileCleanup(query) {
  assert.match(query.sql, /^\(\("connector_auth_record"\."model" = \$1 or "connector_auth_record"\."model" = \$2\) and "connector_auth_record"\."expires_at" <= \$3\)$/u);
  assert.deepEqual(query.params.slice(0, 2), ['FeishuFile', 'FeishuFileChunk']);
  const cutoff = new Date(query.params[2]).getTime();
  assert.ok(cutoff <= Date.now() && cutoff > Date.now() - 5000);
  // The compiled SQL predicate's model set excludes every OAuth/lease/tombstone model, even expired ones.
  for (const model of [...ordinary.filter((name) => name !== 'FeishuFileChunk'), 'RefreshLease', 'GrantRevocation']) {
    assert.ok(!query.params.slice(0, 2).includes(model));
  }
}
assertFileCleanup(deletes[0]);
const expiry = Math.floor(Date.now() / 1000) + 900;
await repository.execute({ operation: 'put', model: 'FeishuFileChunk', key: 'ticket:0',
  payload: { grantId: 'grant_synthetic', data: 'eA==', accountId: 'tenant:user', index: 0 }, expiresAt: expiry });
assert.equal(deletes.length, 1, 'chunks do not each issue a full cleanup');
assert.equal(inserts.at(-1).grantHash, 'grant:grant_synthetic', 'chunk grant binding participates in revocation');
await repository.execute({ operation: 'put', model: 'FeishuFile', key: 'ticket',
  payload: { grantId: 'grant_synthetic' }, expiresAt: expiry });
assert.equal(deletes.length, 2);
assertFileCleanup(deletes[1]);
await repository.execute({ operation: 'revokeGrant', grantId: 'grant_synthetic' });
assert.equal(inserts.at(-1).model, 'GrantRevocation');
assert.match(deletes.at(-1).sql, /"grant_hash" = \$1/u);
assert.deepEqual(deletes.at(-1).params, ['grant:grant_synthetic'], 'revocation removes bound chunks and manifest together');
console.log('PASS: generated Drizzle SQL restricts lazy expiry cleanup to file/chunk models; OAuth records retained; chunk grant binding and revocation verified. No database connection.');
