import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { connectorAuthRecord } from '@server/database/schema';
import type { ConnectorAuthStorageResponse } from '@shared/api.interface';
import { ConnectorAuthStorageCrypto } from './connector-auth-storage.crypto';
import {
  storageCommandSchema, storagePayloadSchema, validateStorageJson, type StorageCommand,
} from './connector-auth-storage.contract';

type AuthRecord = typeof connectorAuthRecord.$inferSelect;
type NewAuthRecord = typeof connectorAuthRecord.$inferInsert;
type PutCommand = Extract<StorageCommand, { operation: 'put' }>;
type GetCommand = Extract<StorageCommand, { operation: 'get' }>;
const REVOCATION_MODEL: string = 'GrantRevocation';
const LEASE_MODEL: string = 'RefreshLease';

@Injectable()
class ConnectorAuthStorageRepository {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly crypto: ConnectorAuthStorageCrypto,
  ) {}

  async execute(command: StorageCommand): Promise<ConnectorAuthStorageResponse> {
    if ((command.operation === 'get' || command.operation === 'put') && command.model === 'FeishuFile') {
      // Links expire immediately; encrypted file rows are removed on the next publish/download attempt.
      // OAuth records, revocation tombstones and refresh leases are never part of this cleanup.
      await this.db.delete(connectorAuthRecord).where(and(
        or(eq(connectorAuthRecord.model, 'FeishuFile'), eq(connectorAuthRecord.model, 'FeishuFileChunk')),
        lte(connectorAuthRecord.expiresAt, new Date()),
      ));
    }
    switch (command.operation) {
      case 'get': return { ok: true, record: await this.get(command.model, command.key) };
      case 'findUid': return { ok: true, record: await this.findUid(command.model, command.uid) };
      case 'put': await this.put(command); return { ok: true };
      case 'consume': return { ok: true, consumed: await this.consume(command.model, command.key) };
      case 'remove': await this.remove(command.model, command.key); return { ok: true };
      case 'revokeGrant': await this.revokeGrant(command.grantId); return { ok: true };
      case 'acquireLease': return { ok: true, leaseToken: await this.acquireLease(command.key, command.ttlSeconds) };
      case 'releaseLease': await this.releaseLease(command.key, command.leaseToken); return { ok: true };
    }
  }

  async executeFileBatch(commands: StorageCommand[]): Promise<ConnectorAuthStorageResponse[]> {
    // Defend this boundary independently of the HTTP envelope/controller. Never batch OAuth state changes.
    if (!Array.isArray(commands) || commands.length < 1 || commands.length > 16) {
      throw new Error('Storage request rejected.');
    }
    const parsed: Array<GetCommand | PutCommand> = commands.map((command: StorageCommand): GetCommand | PutCommand => {
      validateStorageJson(command);
      const result = storageCommandSchema.safeParse(command);
      if (!result.success || (result.data.operation !== 'get' && result.data.operation !== 'put') ||
        result.data.model !== 'FeishuFileChunk') throw new Error('Storage request rejected.');
      return result.data;
    });
    const first: GetCommand | PutCommand = parsed[0];
    if (parsed.some((command: GetCommand | PutCommand): boolean => command.operation !== first.operation) ||
      new Set(parsed.map((command: GetCommand | PutCommand): string => command.key)).size !== parsed.length) {
      throw new Error('Storage request rejected.');
    }
    if (first.operation === 'get') return this.getFileBatch(parsed.map((command: GetCommand | PutCommand): string => command.key));
    const puts: PutCommand[] = parsed.filter((command: GetCommand | PutCommand): command is PutCommand => command.operation === 'put');
    await this.putFileBatch(puts);
    return puts.map((): ConnectorAuthStorageResponse => ({ ok: true }));
  }

  private async getFileBatch(keys: string[]): Promise<ConnectorAuthStorageResponse[]> {
    const hashes: string[] = keys.map((key: string): string => this.crypto.hash('key', 'FeishuFileChunk', key));
    const rows: AuthRecord[] = await this.db.select().from(connectorAuthRecord).where(and(
      eq(connectorAuthRecord.model, 'FeishuFileChunk'), inArray(connectorAuthRecord.keyHash, hashes),
      gt(connectorAuthRecord.expiresAt, new Date()),
    ));
    const grantHashes: string[] = [...new Set(rows.map((row: AuthRecord): string | null => row.grantHash)
      .filter((hash: string | null): hash is string => hash !== null))];
    const revoked: Array<{ keyHash: string }> = grantHashes.length ? await this.db.select({ keyHash: connectorAuthRecord.keyHash })
      .from(connectorAuthRecord).where(and(eq(connectorAuthRecord.model, REVOCATION_MODEL),
        inArray(connectorAuthRecord.keyHash, grantHashes))) : [];
    const revokedHashes: Set<string> = new Set(revoked.map((row: { keyHash: string }): string => row.keyHash));
    const byHash: Map<string, AuthRecord> = new Map(rows.map((row: AuthRecord): [string, AuthRecord] => [row.keyHash, row]));
    return hashes.map((hash: string): ConnectorAuthStorageResponse => {
      const row: AuthRecord | undefined = byHash.get(hash);
      // Recheck expiry after the revocation query, which itself may have waited on the database.
      const allowed: boolean = !!row && row.expiresAt.getTime() > Date.now() &&
        (!row.grantHash || !revokedHashes.has(row.grantHash));
      return { ok: true, record: allowed && row ? this.decodePayload(row) : undefined };
    });
  }

  private async putFileBatch(commands: PutCommand[]): Promise<void> {
    let binding: { uidHash: string | null; grantHash: string } | undefined;
    const values: NewAuthRecord[] = commands.map((command: PutCommand): NewAuthRecord => {
      const keyHash: string = this.crypto.hash('key', command.model, command.key);
      const uid: string | undefined = this.resolveIndex(command.uid, command.payload.uid);
      const grantId: string | undefined = this.resolveIndex(command.grantId, command.payload.grantId);
      if (!grantId) throw new Error('Storage request rejected.');
      const uidHash: string | null = uid ? this.crypto.hash('uid', command.model, uid) : null;
      const grantHash: string = this.crypto.hash('grant', grantId);
      if (binding && (binding.uidHash !== uidHash || binding.grantHash !== grantHash)) {
        throw new Error('Storage request rejected.');
      }
      binding ??= { uidHash, grantHash };
      const payload: Record<string, unknown> = { ...command.payload };
      delete payload.consumed;
      return { model: command.model, keyHash, uidHash, grantHash,
        payloadCiphertext: this.crypto.seal(payload, this.crypto.recordAad(command.model, keyHash)),
        expiresAt: new Date(command.expiresAt * 1000) };
    });
    if (!binding) throw new Error('Storage request rejected.');
    const { uidHash, grantHash } = binding;
    if (await this.isRevoked(grantHash)) throw new Error('Storage operation unavailable.');
    const rows: Array<{ id: string }> = await this.db.insert(connectorAuthRecord).values(values).onConflictDoUpdate({
      target: [connectorAuthRecord.model, connectorAuthRecord.keyHash],
      // Each excluded value remains encrypted with its own model/key AAD. Never reset consumedAt or bindings.
      set: { payloadCiphertext: sql`excluded.payload_ciphertext`, expiresAt: sql`excluded.expires_at`, updatedAt: new Date() },
      setWhere: and(uidHash ? eq(connectorAuthRecord.uidHash, uidHash) : isNull(connectorAuthRecord.uidHash),
        eq(connectorAuthRecord.grantHash, grantHash)),
    }).returning({ id: connectorAuthRecord.id });
    // A racing revoke cannot resurrect usable chunks, including when some conflicting rows were rejected.
    if (await this.isRevoked(grantHash)) {
      await this.db.delete(connectorAuthRecord).where(and(eq(connectorAuthRecord.model, 'FeishuFileChunk'),
        eq(connectorAuthRecord.grantHash, grantHash),
        inArray(connectorAuthRecord.keyHash, values.map((value: NewAuthRecord): string => value.keyHash))));
      throw new Error('Storage operation unavailable.');
    }
    if (rows.length !== commands.length) throw new Error('Storage operation unavailable.');
  }

  private async get(model: string, key: string): Promise<Record<string, unknown> | undefined> {
    const keyHash: string = this.crypto.hash('key', model, key);
    const rows: AuthRecord[] = await this.db.select().from(connectorAuthRecord)
      .where(and(eq(connectorAuthRecord.model, model), eq(connectorAuthRecord.keyHash, keyHash),
        gt(connectorAuthRecord.expiresAt, new Date()))).limit(1);
    return this.decode(rows[0]);
  }

  private async findUid(model: string, uid: string): Promise<Record<string, unknown> | undefined> {
    const rows: AuthRecord[] = await this.db.select().from(connectorAuthRecord)
      .where(and(eq(connectorAuthRecord.model, model),
        eq(connectorAuthRecord.uidHash, this.crypto.hash('uid', model, uid)),
        gt(connectorAuthRecord.expiresAt, new Date()))).limit(2);
    if (rows.length > 1) throw new Error('Storage operation unavailable.');
    return this.decode(rows[0]);
  }

  private async decode(row: AuthRecord | undefined): Promise<Record<string, unknown> | undefined> {
    if (!row || await this.isRevoked(row.grantHash)) return undefined;
    return this.decodePayload(row);
  }

  private decodePayload(row: AuthRecord): Record<string, unknown> {
    const payload: Record<string, unknown> = storagePayloadSchema.parse(
      this.crypto.open(row.payloadCiphertext, this.crypto.recordAad(row.model, row.keyHash)),
    );
    delete payload.consumed;
    if (row.consumedAt) payload.consumed = Math.floor(row.consumedAt.getTime() / 1000);
    return payload;
  }

  private async put(command: PutCommand): Promise<void> {
    const keyHash: string = this.crypto.hash('key', command.model, command.key);
    const uid: string | undefined = this.resolveIndex(command.uid, command.payload.uid);
    const grantId: string | undefined = command.model === 'Grant'
      ? command.key : this.resolveIndex(command.grantId, command.payload.grantId);
    const uidHash: string | null = uid ? this.crypto.hash('uid', command.model, uid) : null;
    const grantHash: string | null = grantId ? this.crypto.hash('grant', grantId) : null;
    if (await this.isRevoked(grantHash)) throw new Error('Storage operation unavailable.');
    const payload: Record<string, unknown> = { ...command.payload };
    delete payload.consumed;
    const payloadCiphertext: string = this.crypto.seal(payload, this.crypto.recordAad(command.model, keyHash));
    const expiresAt: Date = new Date(command.expiresAt * 1000);
    // Index bindings are immutable. Crucially, consumedAt is absent from the update.
    const rows: Array<{ id: string }> = await this.db.insert(connectorAuthRecord).values({
      model: command.model, keyHash, uidHash, grantHash, payloadCiphertext, expiresAt,
    }).onConflictDoUpdate({
      target: [connectorAuthRecord.model, connectorAuthRecord.keyHash],
      set: { payloadCiphertext, expiresAt, updatedAt: new Date() },
      setWhere: and(uidHash ? eq(connectorAuthRecord.uidHash, uidHash) : isNull(connectorAuthRecord.uidHash),
        grantHash ? eq(connectorAuthRecord.grantHash, grantHash) : isNull(connectorAuthRecord.grantHash)),
    }).returning({ id: connectorAuthRecord.id });
    if (rows.length !== 1) throw new Error('Storage operation unavailable.');
    // A revoke racing with this upsert cannot resurrect a usable record.
    if (await this.isRevoked(grantHash)) {
      await this.db.delete(connectorAuthRecord).where(and(eq(connectorAuthRecord.model, command.model),
        eq(connectorAuthRecord.keyHash, keyHash)));
      throw new Error('Storage operation unavailable.');
    }
  }

  private resolveIndex(explicit: string | undefined, stored: unknown): string | undefined {
    if (stored !== undefined && (typeof stored !== 'string' || stored.length === 0 || stored.length > 4096)) {
      throw new Error('Storage request rejected.');
    }
    if (explicit !== undefined && stored !== undefined && explicit !== stored) {
      throw new Error('Storage request rejected.');
    }
    return explicit ?? (typeof stored === 'string' ? stored : undefined);
  }

  private async consume(model: string, key: string): Promise<boolean> {
    const keyHash: string = this.crypto.hash('key', model, key);
    const rows: AuthRecord[] = await this.db.select().from(connectorAuthRecord)
      .where(and(eq(connectorAuthRecord.model, model), eq(connectorAuthRecord.keyHash, keyHash),
        gt(connectorAuthRecord.expiresAt, new Date()))).limit(1);
    const row: AuthRecord | undefined = rows[0];
    if (!row || row.consumedAt || await this.isRevoked(row.grantHash)) return false;
    const claimed: Array<{ id: string }> = await this.db.update(connectorAuthRecord)
      .set({ consumedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(connectorAuthRecord.id, row.id), isNull(connectorAuthRecord.consumedAt),
        gt(connectorAuthRecord.expiresAt, new Date())))
      .returning({ id: connectorAuthRecord.id });
    return claimed.length === 1 && !await this.isRevoked(row.grantHash);
  }

  private async remove(model: string, key: string): Promise<void> {
    if (model === 'Grant') return this.revokeGrant(key);
    await this.db.delete(connectorAuthRecord).where(and(eq(connectorAuthRecord.model, model),
      eq(connectorAuthRecord.keyHash, this.crypto.hash('key', model, key))));
  }

  private async revokeGrant(grantId: string): Promise<void> {
    const grantHash: string = this.crypto.hash('grant', grantId);
    // Permanent, private tombstone precedes deletion. It is not an API-allowed model.
    await this.db.insert(connectorAuthRecord).values({
      model: REVOCATION_MODEL,
      keyHash: grantHash,
      payloadCiphertext: this.crypto.seal({ revoked: true }, this.crypto.recordAad(REVOCATION_MODEL, grantHash)),
      expiresAt: new Date('9999-12-31T23:59:59.000Z'),
    }).onConflictDoNothing({ target: [connectorAuthRecord.model, connectorAuthRecord.keyHash] });
    await this.db.delete(connectorAuthRecord).where(and(eq(connectorAuthRecord.model, 'Grant'),
      eq(connectorAuthRecord.keyHash, this.crypto.hash('key', 'Grant', grantId))));
    await this.db.delete(connectorAuthRecord).where(eq(connectorAuthRecord.grantHash, grantHash));
  }

  private async isRevoked(grantHash: string | null): Promise<boolean> {
    if (!grantHash) return false;
    const rows: Array<{ id: string }> = await this.db.select({ id: connectorAuthRecord.id })
      .from(connectorAuthRecord).where(and(eq(connectorAuthRecord.model, REVOCATION_MODEL),
        eq(connectorAuthRecord.keyHash, grantHash))).limit(1);
    return rows.length > 0;
  }

  private async acquireLease(key: string, ttlSeconds: number): Promise<string | undefined> {
    const keyHash: string = this.crypto.hash('key', LEASE_MODEL, key);
    const owner: string = randomBytes(32).toString('base64url');
    const now: Date = new Date();
    const expiresAt: Date = new Date(now.getTime() + ttlSeconds * 1000);
    const payloadCiphertext: string = this.crypto.seal({ owner }, this.crypto.recordAad(LEASE_MODEL, keyHash));
    const claimed: Array<{ id: string }> = await this.db.insert(connectorAuthRecord).values({
      model: LEASE_MODEL, keyHash, payloadCiphertext, expiresAt,
    }).onConflictDoUpdate({
      target: [connectorAuthRecord.model, connectorAuthRecord.keyHash],
      set: { payloadCiphertext, expiresAt, updatedAt: now },
      setWhere: lte(connectorAuthRecord.expiresAt, now),
    }).returning({ id: connectorAuthRecord.id });
    return claimed.length === 1 ? owner : undefined;
  }

  private async releaseLease(key: string, leaseToken: string): Promise<void> {
    const keyHash: string = this.crypto.hash('key', LEASE_MODEL, key);
    const rows: AuthRecord[] = await this.db.select().from(connectorAuthRecord)
      .where(and(eq(connectorAuthRecord.model, LEASE_MODEL), eq(connectorAuthRecord.keyHash, keyHash))).limit(1);
    const row: AuthRecord | undefined = rows[0];
    if (!row) return;
    const payload: Record<string, unknown> = storagePayloadSchema.parse(
      this.crypto.open(row.payloadCiphertext, this.crypto.recordAad(LEASE_MODEL, keyHash)),
    );
    if (typeof payload.owner !== 'string') throw new Error('Storage operation unavailable.');
    const owner: Buffer = Buffer.from(payload.owner, 'utf8');
    const candidate: Buffer = Buffer.from(leaseToken, 'utf8');
    if (owner.length !== candidate.length || !timingSafeEqual(owner, candidate)) return;
    // Match the version observed above, so an expired/reacquired lease cannot be deleted.
    await this.db.delete(connectorAuthRecord).where(and(eq(connectorAuthRecord.id, row.id),
      eq(connectorAuthRecord.payloadCiphertext, row.payloadCiphertext)));
  }
}

export { ConnectorAuthStorageRepository };
