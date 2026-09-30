import { errors } from 'oidc-provider';
import type { Adapter, AdapterFactory, AdapterPayload } from 'oidc-provider';
import { setTimeout as delay } from 'node:timers/promises';
import { authNow, authRecord } from './connector-auth.types';
import type { ConnectorAuthStore } from './connector-auth.types';
import { ConnectorAuthUnavailableError, connectorAuthStorageOperation } from './connector-auth.unavailable';
import { ConnectorStorageUnavailableError } from '../connector-auth-storage/connector-auth-storage.service';

function samePayload(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const canonical = (value: Record<string, unknown>): string => JSON.stringify(value,
    (_key: string, item: unknown): unknown => authRecord(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]): number => a < b ? -1 : a > b ? 1 : 0)) : item);
  return canonical(left) === canonical(right);
}

function recoverableStorageError(error: unknown): boolean {
  return error instanceof ConnectorStorageUnavailableError &&
    (error.failureReason === 'network' || error.failureReason === 'network_timeout' ||
      (error.failureReason === 'http' && (error.upstreamStatus === 429 || error.upstreamStatus === 408 ||
        error.upstreamStatus >= 500)));
}

/** Recover only this newly issued token's idempotent persistence, never its predecessor's consume. */
async function saveRefreshToken(
  store: ConnectorAuthStore, id: string, payload: Record<string, unknown>, expiresAt: number,
  uid?: string, grantId?: string,
): Promise<void> {
  const started: number = performance.now();
  const canStart: () => boolean = (): boolean => performance.now() - started < 20000 && expiresAt > authNow();
  if (!canStart()) throw new ConnectorAuthUnavailableError();
  try { await store.put('RefreshToken', id, payload, expiresAt, uid, grantId); return; }
  catch (error: unknown) {
    if (!recoverableStorageError(error)) throw new ConnectorAuthUnavailableError();
  }
  // At most five persistence rounds. The 20s budget bounds new I/O starts; an
  // already started relay retains its own 15s timeout, without orphaning a write.
  for (const backoff of [500, 1000, 2000, 4000]) {
    const pause: number = backoff + Math.floor(Math.random() * 251);
    if (!canStart() || performance.now() - started + pause >= 20000) break;
    await delay(pause);
    if (!canStart()) break;
    let stored: Record<string, unknown> | undefined;
    try { stored = await store.get('RefreshToken', id); }
    catch (error: unknown) {
      if (!recoverableStorageError(error)) throw new ConnectorAuthUnavailableError();
      // In particular, do not blindly put after an uncertain readback. A 429 may
      // share the initial write's quota window, so only retry after another delay.
      continue;
    }
    if (stored) {
      if (expiresAt > authNow() && !Object.prototype.hasOwnProperty.call(stored, 'consumed') &&
        samePayload(stored, payload)) return;
      throw new ConnectorAuthUnavailableError();
    }
    if (!canStart()) break;
    try { await store.put('RefreshToken', id, payload, expiresAt, uid, grantId); return; }
    catch (error: unknown) {
      if (!recoverableStorageError(error)) throw new ConnectorAuthUnavailableError();
      // Retry this exact new artifact only. The repository retains consumedAt,
      // absolute expiry and bindings and checks revocation before/after the write.
    }
  }
  throw new ConnectorAuthUnavailableError();
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
