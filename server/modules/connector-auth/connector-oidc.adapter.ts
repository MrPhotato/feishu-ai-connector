import { errors } from 'oidc-provider';
import type { Adapter, AdapterFactory, AdapterPayload } from 'oidc-provider';
import { authNow, authRecord } from './connector-auth.types';
import type { ConnectorAuthStore } from './connector-auth.types';

/** The provider never receives its development-only memory adapter. */
export function connectorAdapter(store: ConnectorAuthStore): AdapterFactory {
  return (model: string): Adapter => ({
    async upsert(id: string, payload: AdapterPayload, expiresIn?: number): Promise<void> {
      const expiresAt: number = expiresIn === undefined ? authNow() + 365 * 86400 : authNow() + expiresIn;
      // Provider payloads contain optional undefined fields; persistence uses JSON semantics.
      const serialized: unknown = JSON.parse(JSON.stringify(payload));
      if (!authRecord(serialized)) throw new Error('Invalid authorization record');
      await store.put(model, id, serialized, expiresAt, payload.uid, payload.grantId);
    },
    async find(id: string): Promise<AdapterPayload | undefined> {
      // This authenticated record was originally produced by oidc-provider's adapter contract.
      return await store.get(model, id) as AdapterPayload | undefined;
    },
    async findByUid(uid: string): Promise<AdapterPayload | undefined> {
      return await store.findUid(model, uid) as AdapterPayload | undefined;
    },
    async findByUserCode(): Promise<undefined> { return undefined; },
    async consume(id: string): Promise<void> {
      if (!await store.consume(model, id)) {
        const payload: Record<string, unknown> | undefined = await store.get(model, id);
        if (typeof payload?.grantId === 'string') await store.revokeGrant(payload.grantId);
        throw new errors.InvalidGrant('Authorization artifact already used or expired');
      }
    },
    async destroy(id: string): Promise<void> { await store.remove(model, id); },
    async revokeByGrantId(grantId: string): Promise<void> { await store.revokeGrant(grantId); },
  });
}
