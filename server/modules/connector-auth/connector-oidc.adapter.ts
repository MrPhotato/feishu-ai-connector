import { errors } from 'oidc-provider';
import type { Adapter, AdapterFactory, AdapterPayload } from 'oidc-provider';
import { authNow, authRecord } from './connector-auth.types';
import type { ConnectorAuthStore } from './connector-auth.types';
import { ConnectorAuthUnavailableError, connectorAuthStorageOperation } from './connector-auth.unavailable';

function samePayload(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const canonical = (value: Record<string, unknown>): string => JSON.stringify(value,
    (_key: string, item: unknown): unknown => authRecord(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]): number => a < b ? -1 : a > b ? 1 : 0)) : item);
  return canonical(left) === canonical(right);
}

/** Recover only this newly issued token's idempotent persistence, never its predecessor's consume. */
async function saveRefreshToken(
  store: ConnectorAuthStore, id: string, payload: Record<string, unknown>, expiresAt: number,
  uid?: string, grantId?: string,
): Promise<void> {
  for (let attempt: number = 0; attempt < 2; attempt++) {
    try { await store.put('RefreshToken', id, payload, expiresAt, uid, grantId); return; }
    catch {
      // A timeout may mean either no write or a lost acknowledgement. Read the exact
      // key before retrying; never replace a different or already consumed artifact.
      const stored: Record<string, unknown> | undefined = await connectorAuthStorageOperation(() =>
        store.get('RefreshToken', id));
      if (stored) {
        if (expiresAt > authNow() && !Object.prototype.hasOwnProperty.call(stored, 'consumed') &&
          samePayload(stored, payload)) return;
        throw new ConnectorAuthUnavailableError();
      }
      if (attempt === 1 || expiresAt <= authNow()) throw new ConnectorAuthUnavailableError();
      // Retry exactly once, retaining absolute expiry and payload. Storage preserves
      // consumedAt and checks revocation tombstones before and after every upsert.
    }
  }
}

/** The provider never receives its development-only memory adapter. */
export function connectorAdapter(store: ConnectorAuthStore): AdapterFactory {
  return (model: string): Adapter => ({
    async upsert(id: string, payload: AdapterPayload, expiresIn?: number): Promise<void> {
      const expiresAt: number = expiresIn === undefined ? authNow() + 365 * 86400 : authNow() + expiresIn;
      // Provider payloads contain optional undefined fields; persistence uses JSON semantics.
      const serialized: unknown = JSON.parse(JSON.stringify(payload));
      if (!authRecord(serialized)) throw new Error('Invalid authorization record');
      if (model === 'RefreshToken') {
        await saveRefreshToken(store, id, serialized, expiresAt, payload.uid, payload.grantId);
      } else {
        await connectorAuthStorageOperation(() => store.put(model, id, serialized, expiresAt, payload.uid, payload.grantId));
      }
    },
    async find(id: string): Promise<AdapterPayload | undefined> {
      // This authenticated record was originally produced by oidc-provider's adapter contract.
      return await connectorAuthStorageOperation(() => store.get(model, id)) as AdapterPayload | undefined;
    },
    async findByUid(uid: string): Promise<AdapterPayload | undefined> {
      return await connectorAuthStorageOperation(() => store.findUid(model, uid)) as AdapterPayload | undefined;
    },
    async findByUserCode(): Promise<undefined> { return undefined; },
    async consume(id: string): Promise<void> {
      if (!await connectorAuthStorageOperation(() => store.consume(model, id))) {
        const payload: Record<string, unknown> | undefined = await connectorAuthStorageOperation(() => store.get(model, id));
        if (typeof payload?.grantId === 'string') {
          const grantId: string = payload.grantId;
          await connectorAuthStorageOperation(() => store.revokeGrant(grantId));
        }
        throw new errors.InvalidGrant('Authorization artifact already used or expired');
      }
    },
    async destroy(id: string): Promise<void> { await connectorAuthStorageOperation(() => store.remove(model, id)); },
    async revokeByGrantId(grantId: string): Promise<void> {
      await connectorAuthStorageOperation(() => store.revokeGrant(grantId));
    },
  });
}
