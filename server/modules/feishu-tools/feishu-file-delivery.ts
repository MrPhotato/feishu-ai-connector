import { createHash, randomBytes } from 'node:crypto';
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
async function parallel<T>(count: number, action: (index: number) => Promise<T>): Promise<T[]> {
  const results: T[] = new Array<T>(count);
  let next: number = 0;
  await Promise.all(Array.from({ length: Math.min(12, count) }, async (): Promise<void> => {
    while (next < count) { const index: number = next++; results[index] = await action(index); }
  }));
  return results;
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
  await parallel(parts, async (index: number): Promise<void> => {
    await store.put('FeishuFileChunk', `${ticket}:${index}`, {
      data: bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES).toString('base64'),
      accountId, grantId, index,
    }, expiresAt);
  });
  const name: string = safeName(file.name);
  const mimeType: string = safeMime(file.mimeType);
  // Publish the manifest last. A partial upload can never become a downloadable file.
  await store.put('FeishuFile', ticket, { accountId, grantId, clientId, scopes: principal.scopes,
    name, mimeType, byteLength: bytes.length, parts,
    sha256: createHash('sha256').update(bytes).digest('hex'), expiresAt }, expiresAt);
  return { name, mimeType, byteLength: bytes.length,
    downloadUrl: `${connectorPublicUrl()}/mcp/files/download?ticket=${ticket}`,
    expiresAt: new Date(expiresAt * 1000).toISOString() };
}

async function retrieveFile(store: FeishuToolsStore, ticket: string): Promise<DeliveredFile | undefined> {
  if (!FILE_TICKET.test(ticket)) return undefined;
  const manifest: Record<string, unknown> | undefined = await store.get('FeishuFile', ticket);
  if (!manifest || typeof manifest.accountId !== 'string' || typeof manifest.grantId !== 'string' ||
    typeof manifest.clientId !== 'string' || !Array.isArray(manifest.scopes) || !manifest.scopes.length ||
    typeof manifest.expiresAt !== 'number' ||
    manifest.expiresAt <= Math.floor(Date.now() / 1000) || !Number.isSafeInteger(manifest.parts) ||
    Number(manifest.parts) < 1 || Number(manifest.parts) > Math.ceil(MAX_FILE_BYTES / CHUNK_BYTES) ||
    !Number.isSafeInteger(manifest.byteLength) || Number(manifest.byteLength) < 0 ||
    Number(manifest.byteLength) > MAX_FILE_BYTES || typeof manifest.name !== 'string' ||
    typeof manifest.mimeType !== 'string' || typeof manifest.sha256 !== 'string') return undefined;
  const [account, grant, consent] = await Promise.all([
    store.get('FeishuAccount', manifest.accountId), store.get('Grant', manifest.grantId),
    store.get('Consent', manifest.grantId),
  ]);
  if (!account || account.revoked === true ||
    `${String(account.tenant_key)}:${String(account.open_id)}` !== manifest.accountId) return undefined;
  const resource: string = `${connectorPublicUrl()}/mcp`;
  const now: number = Math.floor(Date.now() / 1000);
  if (!grant || !consent || grant.accountId !== manifest.accountId || grant.clientId !== manifest.clientId ||
    Number(grant.exp) <= now || !Number.isFinite(grant.exp) || !object(grant.resources) ||
    typeof grant.resources[resource] !== 'string' || consent.accountId !== manifest.accountId ||
    consent.grantId !== manifest.grantId || consent.clientId !== manifest.clientId || consent.resource !== resource ||
    Number(consent.expiresAt) <= now || !Number.isFinite(consent.expiresAt) || !Array.isArray(consent.scopes)) return undefined;
  const granted: string[] = String(grant.resources[resource]).split(' ');
  if (manifest.scopes.some((scope: unknown): boolean => typeof scope !== 'string' ||
    !['feishu.read', 'feishu.write'].includes(scope) || !granted.includes(scope) ||
    !(consent.scopes as unknown[]).includes(scope))) return undefined;
  const chunks: Buffer[] = await parallel(Number(manifest.parts), async (index: number): Promise<Buffer> => {
    const chunk: Record<string, unknown> | undefined = await store.get('FeishuFileChunk', `${ticket}:${index}`);
    if (!object(chunk) || chunk.accountId !== manifest.accountId || chunk.grantId !== manifest.grantId || chunk.index !== index ||
      typeof chunk.data !== 'string' || chunk.data.length > CHUNK_BYTES / 3 * 4) throw new Error('file_delivery_invalid');
    const bytes: Buffer = Buffer.from(chunk.data, 'base64');
    if (bytes.toString('base64') !== chunk.data) throw new Error('file_delivery_invalid');
    return bytes;
  });
  const bytes: Buffer = Buffer.concat(chunks);
  if (bytes.length !== manifest.byteLength || createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) {
    throw new Error('file_delivery_invalid');
  }
  return { name: safeName(manifest.name), mimeType: safeMime(manifest.mimeType), bytes, accountId: manifest.accountId };
}

export { publishFile, retrieveFile };
export type { DownloadFile, DeliveredFile };
