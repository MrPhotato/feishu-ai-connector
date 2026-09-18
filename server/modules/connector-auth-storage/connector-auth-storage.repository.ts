import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, eq, gt, isNull, lte } from 'drizzle-orm';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { connectorAuthRecord } from '@server/database/schema';
import type { ConnectorAuthStorageResponse } from '@shared/api.interface';
import { ConnectorAuthStorageCrypto } from './connector-auth-storage.crypto';
import { storagePayloadSchema, type StorageCommand } from './connector-auth-storage.contract';

type AuthRecord = typeof connectorAuthRecord.$inferSelect;
type PutCommand = Extract<StorageCommand, { operation: 'put' }>;
const REVOCATION_MODEL: string = 'GrantRevocation';
const LEASE_MODEL: string = 'RefreshLease';

@Injectable()
class ConnectorAuthStorageRepository {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly crypto: ConnectorAuthStorageCrypto,
  ) {}

  async execute(command: StorageCommand): Promise<ConnectorAuthStorageResponse> {
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
