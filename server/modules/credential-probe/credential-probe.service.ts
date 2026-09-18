import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { eq } from 'drizzle-orm';
import { credentialStorageProbe } from '@server/database/schema';
import type {
  CredentialProbeCleanup,
  CredentialProbeOutcome,
  CredentialProbeResult,
  CredentialProbeRole,
} from '@shared/api.interface';

const PROBE_SEED_ID: string = '00000000-0000-4000-8000-000000000001';
const PROBE_INSERT_ID: string = '00000000-0000-4000-8000-000000000002';
const PROBE_VALUE: string = 'credential-storage-probe-v1';

function isPermissionDenied(error: unknown): boolean {
  let current: unknown = error;
  for (let depth: number = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null) {
      return false;
    }
    if ('code' in current && current.code === '42501') {
      return true;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

@Injectable()
class CredentialProbeService {
  private checking: boolean = false;

  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async observeRead(
    roleCategory: CredentialProbeRole,
  ): Promise<Pick<CredentialProbeResult, 'roleCategory' | 'read'>> {
    const read: CredentialProbeOutcome = await this.observe(async (): Promise<boolean> => {
      const rows: Array<{ id: string }> = await this.db.select({ id: credentialStorageProbe.id })
        .from(credentialStorageProbe).where(eq(credentialStorageProbe.id, PROBE_SEED_ID)).limit(1);
      return rows.length === 1;
    });
    return { roleCategory, read };
  }

  async check(roleCategory: CredentialProbeRole): Promise<CredentialProbeResult> {
    if (this.checking) {
      throw new ServiceUnavailableException('Run the synthetic storage checks sequentially.');
    }
    this.checking = true;
    try {
      const read: CredentialProbeOutcome = await this.observe(async (): Promise<boolean> => {
        const rows: Array<{ id: string }> = await this.db
          .select({ id: credentialStorageProbe.id })
          .from(credentialStorageProbe)
          .where(eq(credentialStorageProbe.id, PROBE_SEED_ID))
          .limit(1);
        return rows.length === 1;
      });
      const insert: CredentialProbeOutcome = await this.observe(async (): Promise<boolean> => {
        const rows: Array<{ id: string }> = await this.db
          .insert(credentialStorageProbe)
          .values({ id: PROBE_INSERT_ID, probeValue: PROBE_VALUE })
          .returning({ id: credentialStorageProbe.id });
        return rows.length === 1;
      });
      const update: CredentialProbeOutcome = await this.observe(async (): Promise<boolean> => {
        const rows: Array<{ id: string }> = await this.db
          .update(credentialStorageProbe)
          .set({ probeValue: PROBE_VALUE, updatedAt: new Date() })
          .where(eq(credentialStorageProbe.id, PROBE_SEED_ID))
          .returning({ id: credentialStorageProbe.id });
        return rows.length === 1;
      });
      const deleted: CredentialProbeOutcome = await this.observe(async (): Promise<boolean> => {
        const rows: Array<{ id: string }> = await this.db
          .delete(credentialStorageProbe)
          .where(eq(credentialStorageProbe.id, PROBE_SEED_ID))
          .returning({ id: credentialStorageProbe.id });
        return rows.length === 1;
      });
      const cleanup: CredentialProbeCleanup = await this.cleanUp(insert, deleted);
      const expected: CredentialProbeOutcome = roleCategory === 'system' || roleCategory === 'apiKey'
        ? 'allowed' : 'denied';
      const expectedIsolation: boolean = read === expected && insert === expected
        && update === expected && deleted === expected && cleanup !== 'error';
      return {
        phase: 'synthetic-storage-probe',
        roleCategory,
        read,
        insert,
        update,
        delete: deleted,
        cleanup,
        expectedIsolation,
      };
    } finally {
      this.checking = false;
    }
  }

  private async observe(operation: () => Promise<boolean>): Promise<CredentialProbeOutcome> {
    try {
      return await operation() ? 'allowed' : 'denied';
    } catch (error: unknown) {
      // Only actual permission errors qualify as denial. Never expose SQL/error details.
      return isPermissionDenied(error) ? 'denied' : 'error';
    }
  }

  private async cleanUp(
    insert: CredentialProbeOutcome,
    deleted: CredentialProbeOutcome,
  ): Promise<CredentialProbeCleanup> {
    if (insert !== 'allowed' && deleted !== 'allowed') {
      return 'notNeeded';
    }
    let complete: boolean = true;
    if (deleted === 'allowed') {
      const restore: CredentialProbeOutcome = await this.observe(async (): Promise<boolean> => {
        const rows: Array<{ id: string }> = await this.db
          .insert(credentialStorageProbe)
          .values({ id: PROBE_SEED_ID, probeValue: PROBE_VALUE })
          .returning({ id: credentialStorageProbe.id });
        return rows.length === 1;
      });
      complete = restore === 'allowed';
    }
    if (insert === 'allowed') {
      const remove: CredentialProbeOutcome = await this.observe(async (): Promise<boolean> => {
        const rows: Array<{ id: string }> = await this.db
          .delete(credentialStorageProbe)
          .where(eq(credentialStorageProbe.id, PROBE_INSERT_ID))
          .returning({ id: credentialStorageProbe.id });
        return rows.length === 1;
      });
      complete = complete && remove === 'allowed';
    }
    return complete ? 'complete' : 'error';
  }
}

export { CredentialProbeService };
