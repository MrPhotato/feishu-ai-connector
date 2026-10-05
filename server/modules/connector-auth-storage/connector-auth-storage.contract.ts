import { z } from 'zod';

const STORAGE_MODELS = [
  'AccessToken', 'AuthorizationCode', 'BackchannelAuthenticationRequest',
  'ClientCredentials', 'DeviceCode', 'Grant', 'IdToken', 'Interaction',
  'RefreshToken', 'RefreshRetry', 'RefreshResponse', 'ReplayDetection', 'Session', 'PushedAuthorizationRequest',
  'FeishuAccount', 'FeishuState', 'Consent', 'FeishuLoginState',
  'FeishuLoginResult', 'ConsentCSRF', 'FeishuAction', 'FeishuFile', 'FeishuFileChunk',
] as const;

const storageModelSchema = z.enum(STORAGE_MODELS);
const storageKeySchema = z.string().min(1).max(4096);
const storagePayloadSchema = z.record(z.string(), z.json());
const storageCommandSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('get'), model: storageModelSchema, key: storageKeySchema }).strict(),
  z.object({
    operation: z.literal('put'), model: storageModelSchema, key: storageKeySchema,
    payload: storagePayloadSchema, expiresAt: z.number().int().min(1).max(253402300799),
    uid: storageKeySchema.optional(), grantId: storageKeySchema.optional(),
  }).strict(),
  z.object({ operation: z.literal('consume'), model: storageModelSchema, key: storageKeySchema }).strict(),
  z.object({ operation: z.literal('remove'), model: storageModelSchema, key: storageKeySchema }).strict(),
  z.object({ operation: z.literal('revokeGrant'), grantId: storageKeySchema }).strict(),
  z.object({ operation: z.literal('findUid'), model: storageModelSchema, uid: storageKeySchema }).strict(),
  z.object({ operation: z.literal('acquireLease'), key: storageKeySchema,
    ttlSeconds: z.number().int().min(30).max(300).default(90) }).strict(),
  z.object({ operation: z.literal('releaseLease'), key: storageKeySchema,
    leaseToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u) }).strict(),
]);
const storageEnvelopeSchema = z.object({
  sealed: z.string().min(40).max(70000).regex(/^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/u),
}).strict();
const storageTimedCommandSchema = z.object({
  issuedAt: z.number().int(),
  command: storageCommandSchema,
}).strict();
const storageResponseSchema = z.object({
  ok: z.literal(true),
  record: storagePayloadSchema.optional(),
  consumed: z.boolean().optional(),
  leaseToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u).optional(),
}).strict();

type StorageCommand = z.infer<typeof storageCommandSchema>;

const STORAGE_FILE_BATCH_MAX_BYTES: number = 960000;
const storageFileBatchEnvelopeSchema = z.object({
  sealed: z.array(storageEnvelopeSchema.shape.sealed).min(1).max(16),
}).strict();
const storageFileBatchCommandSchema = z.array(storageCommandSchema).min(1).max(16).superRefine((commands, context): void => {
  const firstOperation: string = commands[0]?.operation ?? '';
  const keys: Set<string> = new Set();
  for (const command of commands) {
    if ((command.operation !== 'get' && command.operation !== 'put') ||
      command.model !== 'FeishuFileChunk' || command.operation !== firstOperation || keys.has(command.key)) {
      context.addIssue({ code: 'custom', message: 'File batch rejected.' });
      return;
    }
    keys.add(command.key);
  }
});

function validateStorageFileBatchEnvelope(value: unknown): z.infer<typeof storageFileBatchEnvelopeSchema> {
  const serialized: string | undefined = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > STORAGE_FILE_BATCH_MAX_BYTES) {
    throw new Error('File batch rejected.');
  }
  return storageFileBatchEnvelopeSchema.parse(value);
}

function validateStorageFileBatchResponse(value: unknown, operation: 'get' | 'put'): z.infer<typeof storageResponseSchema> {
  validateStorageJson(value);
  const result = storageResponseSchema.parse(value);
  if (result.consumed !== undefined || result.leaseToken !== undefined ||
    (operation === 'put' && result.record !== undefined)) throw new Error('File batch response rejected.');
  return result;
}

// Bound both bytes and depth before recursive validation or encryption.
function validateStorageJson(value: unknown): void {
  const serialized: string | undefined = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > 49152) {
    throw new Error('Storage request rejected.');
  }
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let visited: number = 0;
  while (pending.length > 0) {
    const item: { value: unknown; depth: number } | undefined = pending.pop();
    if (!item) break;
    visited += 1;
    if (item.depth > 24 || visited > 8192) throw new Error('Storage request rejected.');
    if (typeof item.value !== 'object' || item.value === null) continue;
    for (const [key, child] of Object.entries(item.value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw new Error('Storage request rejected.');
      }
      pending.push({ value: child, depth: item.depth + 1 });
    }
  }
}

export {
  storageCommandSchema, storageEnvelopeSchema, storagePayloadSchema,
  storageResponseSchema, storageTimedCommandSchema, validateStorageJson,
  STORAGE_FILE_BATCH_MAX_BYTES, storageFileBatchEnvelopeSchema, storageFileBatchCommandSchema,
  validateStorageFileBatchEnvelope, validateStorageFileBatchResponse,
};
export type { StorageCommand };
