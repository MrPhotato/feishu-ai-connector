import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import type { FeishuFileLink } from '@shared/api.interface';
import type { FeishuToolsStore } from './feishu-tools.executor';
import { connectorPublicUrl } from '../../config/connector-deployment.config';
import type { McpPrincipal } from '../connector-auth/connector-auth.types';

interface DownloadFile { name: string; mimeType?: string; dataBase64: string; byteLength: number }
interface DeliveredFile { name: string; mimeType: string; bytes: Buffer; accountId: string }
const FILE_TTL: number = 900;
const CHUNK_BYTES: number = 24576;
const MAX_FILE_BYTES: number = 10 * 1024 * 1024;
const FILE_TICKET: RegExp = /^[A-Za-z0-9_-]{43}$/u;
const FILE_CONCURRENCY: number = 4;
const FILE_TRANSFER_TIMEOUT_MS: number = 85000;
const FILE_BATCH_SIZE: number = 16;
let nextFileBatchAt: number = 0;

interface FileTransfer { deadline: number; stopped: boolean }
interface FileAuthorization {
  accountId: string; grantId: string; clientId: string; scopes: unknown[]; expiresAt: number;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function safeName(name: string): string {
  const result: string = name.split(/[\\/]/u).pop()?.replace(/[\x00-\x1f\x7f]/gu, '').slice(0, 180) ?? '';
  return result && result !== '.' && result !== '..' ? result : 'attachment.bin';
}
function safeMime(mime: string | undefined): string {
  return mime && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/iu.test(mime) ? mime : 'application/octet-stream';
}
function transientStorageFailure(error: unknown): boolean {
  if (!(error instanceof Error) || !('failureReason' in error) || !('upstreamStatus' in error)) return false;
  return error.failureReason === 'network' || error.failureReason === 'network_timeout' ||
    (error.failureReason === 'http' && typeof error.upstreamStatus === 'number' &&
      (error.upstreamStatus === 408 || error.upstreamStatus === 429 || error.upstreamStatus >= 500));
}
function deliveryFailure(error: unknown): Error {
  if (error instanceof Error && ['file_delivery_invalid', 'file_delivery_timeout'].includes(error.message)) return error;
  return new Error('file_delivery_unavailable');
}
async function fileOperation<T>(transfer: FileTransfer, action: () => Promise<T>): Promise<T> {
  // Only idempotent file get/put operations use this recovery. Never retry authorization consumption or business writes.
  for (let attempt: number = 0; attempt < 3; attempt++) {
    if (transfer.stopped) throw new Error('file_delivery_unavailable');
    if (Date.now() >= transfer.deadline) throw new Error('file_delivery_timeout');
    try { return await action(); }
    catch (error: unknown) {
      if (!transientStorageFailure(error) || attempt === 2) throw deliveryFailure(error);
      const delay: number = 500 * (2 ** attempt) + Math.floor(Math.random() * 250);
      if (Date.now() + delay >= transfer.deadline) throw new Error('file_delivery_timeout');
      await wait(delay);
    }
  }
  throw new Error('file_delivery_unavailable');
}
async function parallel<T>(
  count: number, transfer: FileTransfer, action: (index: number) => Promise<T>, concurrency: number = FILE_CONCURRENCY,
): Promise<T[]> {
  const results: T[] = new Array<T>(count);
  let next: number = 0;
  let failure: Error | undefined;
  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, async (): Promise<void> => {
    while (!transfer.stopped && next < count) {
      const index: number = next++;
      try { results[index] = await fileOperation(transfer, (): Promise<T> => action(index)); }
      catch (error: unknown) { failure ??= deliveryFailure(error); transfer.stopped = true; }
    }
  }));
  // Drain the already-started workers before replying; none may keep writing after a failed response.
  if (failure) throw failure;
  return results;
}

async function fileBatch<T>(transfer: FileTransfer, action: () => Promise<T>): Promise<T> {
  // Share a modest request rate across file transfers in this process, leaving capacity for OAuth reads.
  const scheduledAt: number = Math.max(Date.now(), nextFileBatchAt);
  nextFileBatchAt = scheduledAt + 500;
  if (scheduledAt >= transfer.deadline) throw new Error('file_delivery_timeout');
  const delay: number = scheduledAt - Date.now();
  if (delay > 0) await wait(delay);
  if (transfer.stopped) throw new Error('file_delivery_unavailable');
  if (Date.now() >= transfer.deadline) throw new Error('file_delivery_timeout');
  return action();
}

/** Binary data is encrypted by the existing storage relay, never kept in a public bucket. */
async function publishFile(store: FeishuToolsStore, principal: McpPrincipal, file: DownloadFile): Promise<FeishuFileLink> {
  const { accountId, grantId, clientId } = principal;
  if (!accountId || !grantId || !clientId || !principal.scopes.length ||
    !Number.isSafeInteger(file.byteLength) || file.byteLength < 0 || file.byteLength > MAX_FILE_BYTES ||
    typeof file.dataBase64 !== 'string' || file.dataBase64.length > Math.ceil(MAX_FILE_BYTES / 3) * 4) {
    throw new Error('file_delivery_invalid');
  }
  const bytes: Buffer = Buffer.from(file.dataBase64, 'base64');
  if (bytes.length !== file.byteLength || bytes.toString('base64') !== file.dataBase64) {
    throw new Error('file_delivery_invalid');
  }
  const ticket: string = randomBytes(32).toString('base64url');
  const expiresAt: number = Math.floor(Date.now() / 1000) + FILE_TTL;
  const parts: number = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES));
  const transfer: FileTransfer = { deadline: Date.now() + FILE_TRANSFER_TIMEOUT_MS, stopped: false };
  const entry = (index: number): { key: string; payload: Record<string, unknown>; expiresAt: number } => ({
    key: `${ticket}:${index}`, payload: {
      data: bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES).toString('base64'),
      accountId, grantId, index,
    }, expiresAt,
  });
  if (store.putFileChunks) {
    await parallel(Math.ceil(parts / FILE_BATCH_SIZE), transfer, async (batch: number): Promise<void> => {
      const start: number = batch * FILE_BATCH_SIZE;
      const entries = Array.from({ length: Math.min(FILE_BATCH_SIZE, parts - start) },
        (_, offset: number) => entry(start + offset));
      await fileBatch(transfer, (): Promise<void> => store.putFileChunks!(entries));
    }, 2);
  } else {
    await parallel(parts, transfer, async (index: number): Promise<void> => {
      const part = entry(index);
      await store.put('FeishuFileChunk', part.key, part.payload, part.expiresAt);
    });
  }
  const name: string = safeName(file.name);
  const mimeType: string = safeMime(file.mimeType);
  // Publish the manifest last. A partial upload can never become a downloadable file.
  await fileOperation(transfer, (): Promise<void> => store.put('FeishuFile', ticket,
    { accountId, grantId, clientId, scopes: principal.scopes,
    name, mimeType, byteLength: bytes.length, parts,
    sha256: createHash('sha256').update(bytes).digest('hex'), expiresAt }, expiresAt));
  return { name, mimeType, byteLength: bytes.length,
    downloadUrl: `${connectorPublicUrl()}/mcp/files/download?ticket=${ticket}`,
    expiresAt: new Date(expiresAt * 1000).toISOString() };
}

async function fileAuthorized(store: FeishuToolsStore, manifest: FileAuthorization): Promise<boolean> {
  if (!Number.isFinite(manifest.expiresAt) || manifest.expiresAt <= Math.floor(Date.now() / 1000)) return false;
  const [account, grant, consent] = await Promise.all([
    store.get('FeishuAccount', manifest.accountId), store.get('Grant', manifest.grantId),
    store.get('Consent', manifest.grantId),
  ]);
  if (!account || account.revoked === true ||
    `${String(account.tenant_key)}:${String(account.open_id)}` !== manifest.accountId) return false;
  const resource: string = `${connectorPublicUrl()}/mcp`;
  const now: number = Math.floor(Date.now() / 1000);
  if (manifest.expiresAt <= now || !grant || !consent ||
    grant.accountId !== manifest.accountId || grant.clientId !== manifest.clientId ||
    Number(grant.exp) <= now || !Number.isFinite(grant.exp) || !object(grant.resources) ||
    typeof grant.resources[resource] !== 'string' || consent.accountId !== manifest.accountId ||
    consent.grantId !== manifest.grantId || consent.clientId !== manifest.clientId || consent.resource !== resource ||
    Number(consent.expiresAt) <= now || !Number.isFinite(consent.expiresAt) || !Array.isArray(consent.scopes)) return false;
  const granted: string[] = String(grant.resources[resource]).split(' ');
  if (manifest.scopes.some((scope: unknown): boolean => typeof scope !== 'string' ||
    !['feishu.read', 'feishu.write'].includes(scope) || !granted.includes(scope) ||
    !(consent.scopes as unknown[]).includes(scope))) return false;
  return true;
}

async function retrieveFile(store: FeishuToolsStore, ticket: string): Promise<DeliveredFile | undefined> {
  if (!FILE_TICKET.test(ticket)) return undefined;
  const transfer: FileTransfer = { deadline: Date.now() + FILE_TRANSFER_TIMEOUT_MS, stopped: false };
  const manifest: Record<string, unknown> | undefined = await fileOperation(transfer,
    (): Promise<Record<string, unknown> | undefined> => store.get('FeishuFile', ticket));
  if (!manifest || typeof manifest.accountId !== 'string' || typeof manifest.grantId !== 'string' ||
    typeof manifest.clientId !== 'string' || !Array.isArray(manifest.scopes) || !manifest.scopes.length ||
    typeof manifest.expiresAt !== 'number' || !Number.isSafeInteger(manifest.parts) ||
    Number(manifest.parts) < 1 || Number(manifest.parts) > Math.ceil(MAX_FILE_BYTES / CHUNK_BYTES) ||
    !Number.isSafeInteger(manifest.byteLength) || Number(manifest.byteLength) < 0 ||
    Number(manifest.byteLength) > MAX_FILE_BYTES || typeof manifest.name !== 'string' ||
    typeof manifest.mimeType !== 'string' || typeof manifest.sha256 !== 'string') return undefined;
  const authorization: FileAuthorization = {
    accountId: manifest.accountId, grantId: manifest.grantId, clientId: manifest.clientId,
    scopes: manifest.scopes, expiresAt: manifest.expiresAt,
  };
  if (!await fileAuthorized(store, authorization)) return undefined;
  const decodeChunk = (chunk: Record<string, unknown> | undefined, index: number): Buffer => {
    if (!object(chunk) || chunk.accountId !== manifest.accountId || chunk.grantId !== manifest.grantId || chunk.index !== index ||
      typeof chunk.data !== 'string' || chunk.data.length > CHUNK_BYTES / 3 * 4) throw new Error('file_delivery_invalid');
    const bytes: Buffer = Buffer.from(chunk.data, 'base64');
    if (bytes.toString('base64') !== chunk.data) throw new Error('file_delivery_invalid');
    return bytes;
  };
  let chunks: Buffer[];
  if (store.getFileChunks) {
    const batches: Buffer[][] = await parallel(Math.ceil(Number(manifest.parts) / FILE_BATCH_SIZE), transfer,
      async (batch: number): Promise<Buffer[]> => {
        const start: number = batch * FILE_BATCH_SIZE;
        const keys: string[] = Array.from({ length: Math.min(FILE_BATCH_SIZE, Number(manifest.parts) - start) },
          (_, offset: number): string => `${ticket}:${start + offset}`);
        const records = await fileBatch(transfer, () => store.getFileChunks!(keys));
        if (records.length !== keys.length) throw new Error('file_delivery_invalid');
        return records.map((record, offset: number): Buffer => decodeChunk(record, start + offset));
      }, 2);
    chunks = batches.flat();
  } else {
    chunks = await parallel(Number(manifest.parts), transfer, async (index: number): Promise<Buffer> =>
      decodeChunk(await store.get('FeishuFileChunk', `${ticket}:${index}`), index));
  }
  const bytes: Buffer = Buffer.concat(chunks);
  if (bytes.length !== manifest.byteLength || createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) {
    throw new Error('file_delivery_invalid');
  }
  // Chunk reads may finish after expiry or revocation; recheck current authorization before releasing any bytes.
  if (!await fileAuthorized(store, authorization)) return undefined;
  return { name: safeName(manifest.name), mimeType: safeMime(manifest.mimeType), bytes, accountId: manifest.accountId };
}

export { publishFile, retrieveFile };
export type { DownloadFile, DeliveredFile };
