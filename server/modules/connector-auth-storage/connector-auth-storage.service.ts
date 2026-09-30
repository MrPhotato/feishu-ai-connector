import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type {
  ConnectorAuthStorageRequest, ConnectorAuthStorageResponse, ConnectorAuthStorageFileChunkEntry,
} from '@shared/api.interface';
import {
  storageCommandSchema, storageEnvelopeSchema, storageResponseSchema, validateStorageJson,
  storageFileBatchCommandSchema, validateStorageFileBatchEnvelope, validateStorageFileBatchResponse,
  STORAGE_FILE_BATCH_MAX_BYTES,
} from './connector-auth-storage.contract';
import { ConnectorAuthStorageCrypto, STORAGE_REQUEST_AAD } from './connector-auth-storage.crypto';
import { connectorAuthDiagnostics } from '../connector-auth/connector-auth.diagnostics';
import type { ConnectorStorageFailureReason } from '../connector-auth/connector-auth.diagnostics';
import { connectorPublicUrl } from '../../config/connector-deployment.config';

/** Server-only classification; the public HTTP exception retains its fixed 503 message. */
class ConnectorStorageUnavailableError extends ServiceUnavailableException {
  readonly failureReason: ConnectorStorageFailureReason;
  readonly upstreamStatus: number;

  constructor(failureReason: ConnectorStorageFailureReason, upstreamStatus: number = 0) {
    super('Authorization storage is unavailable.');
    this.failureReason = failureReason;
    this.upstreamStatus = Number.isInteger(upstreamStatus) && upstreamStatus >= 100 && upstreamStatus <= 599
      ? upstreamStatus : 0;
  }
}

@Injectable()
class ConnectorAuthStorageService {
  constructor(private readonly crypto: ConnectorAuthStorageCrypto) {}

  async get(model: string, key: string): Promise<Record<string, unknown> | undefined> {
    return (await this.relay({ operation: 'get', model, key })).record;
  }

  async put(
    model: string, key: string, payload: Record<string, unknown>, expiresAt: number,
    uid?: string, grantId?: string,
  ): Promise<void> {
    await this.relay({ operation: 'put', model, key, payload, expiresAt, uid, grantId });
  }

  async getFileChunks(keys: string[]): Promise<Array<Record<string, unknown> | undefined>> {
    const results = await this.relayFiles('get', keys.map((key): ConnectorAuthStorageRequest =>
      ({ operation: 'get', model: 'FeishuFileChunk', key })));
    return results.map((result): Record<string, unknown> | undefined => result.record);
  }

  async putFileChunks(entries: ConnectorAuthStorageFileChunkEntry[]): Promise<void> {
    await this.relayFiles('put', entries.map(({ key, payload, expiresAt }): ConnectorAuthStorageRequest =>
      ({ operation: 'put', model: 'FeishuFileChunk', key, payload, expiresAt })));
  }

  async consume(model: string, key: string): Promise<boolean> {
    const result: ConnectorAuthStorageResponse = await this.relay({ operation: 'consume', model, key });
    if (typeof result.consumed !== 'boolean') {
      throw new ConnectorStorageUnavailableError('response_invalid');
    }
    return result.consumed;
  }

  async remove(model: string, key: string): Promise<void> {
    await this.relay({ operation: 'remove', model, key });
  }

  async revokeGrant(grantId: string): Promise<void> {
    await this.relay({ operation: 'revokeGrant', grantId });
  }

  async findUid(model: string, uid: string): Promise<Record<string, unknown> | undefined> {
    return (await this.relay({ operation: 'findUid', model, uid })).record;
  }

  async acquireLease(key: string, ttlSeconds: number = 90): Promise<string | undefined> {
    return (await this.relay({ operation: 'acquireLease', key, ttlSeconds })).leaseToken;
  }

  async releaseLease(key: string, leaseToken: string): Promise<void> {
    await this.relay({ operation: 'releaseLease', key, leaseToken });
  }

  private async relay(input: ConnectorAuthStorageRequest): Promise<ConnectorAuthStorageResponse> {
    const started: number = performance.now();
    let ok: boolean = false;
    let failureReason: ConnectorStorageFailureReason = 'validation';
    let upstreamStatus: number = 0;
    let signal: AbortSignal | undefined;
    try {
      validateStorageJson(input);
      // Match JSON persistence semantics: omit optional undefined properties before
      // strict validation, as oidc-provider payloads may contain such properties.
      const command = storageCommandSchema.parse(JSON.parse(JSON.stringify(input)));
      // Same validated, server-configured deployment as OAuth; no per-request target override.
      failureReason = 'config';
      const configuredBase: string = connectorPublicUrl();
      const apiKey: string = process.env.CONNECTOR_STORAGE_API_KEY ?? '';
      if (!apiKey || apiKey.length > 4096 || /[\s\u0000-\u001f\u007f]/u.test(apiKey)) {
        throw new Error('Storage configuration unavailable.');
      }
      const timed = { issuedAt: Date.now(), command };
      failureReason = 'validation';
      validateStorageJson(timed);
      failureReason = 'config';
      const sealed: string = this.crypto.seal(timed, STORAGE_REQUEST_AAD);
      // Native fetch avoids platform HTTP-client logging of headers or request bodies.
      // Redirects are prohibited so the API Key can never be forwarded to another host.
      signal = AbortSignal.timeout(15000);
      failureReason = 'network';
      const response: Response = await fetch(`${configuredBase}/openapi/connector-auth-storage/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ sealed }),
        redirect: 'error',
        signal,
      });
      upstreamStatus = response.status;
      if (!response.ok) {
        failureReason = 'http';
        await response.body?.cancel().catch((): void => undefined);
        throw new Error('Storage operation unavailable.');
      }
      if (!response.headers.get('content-type')?.includes('application/json')) {
        failureReason = 'response_invalid';
        await response.body?.cancel().catch((): void => undefined);
        throw new Error('Storage operation unavailable.');
      }
      const responseText: string = await this.readLimitedBody(response);
      failureReason = 'response_invalid';
      const envelope = storageEnvelopeSchema.parse(JSON.parse(responseText));
      const result = storageResponseSchema.parse(this.crypto.open(
        envelope.sealed, this.crypto.responseAad(sealed),
      ));
      if (command.operation === 'consume' && (result.consumed === undefined || result.record !== undefined)) {
        throw new Error('Storage operation unavailable.');
      }
      if (command.operation !== 'consume' && result.consumed !== undefined) {
        throw new Error('Storage operation unavailable.');
      }
      if (command.operation !== 'get' && command.operation !== 'findUid' && result.record !== undefined) {
        throw new Error('Storage operation unavailable.');
      }
      if (command.operation !== 'acquireLease' && result.leaseToken !== undefined) {
        throw new Error('Storage operation unavailable.');
      }
      ok = true;
      return result;
    } catch (error: unknown) {
      if (error instanceof ConnectorStorageUnavailableError) failureReason = error.failureReason;
      else if (failureReason === 'network' && signal?.aborted) failureReason = 'network_timeout';
      // Never attach causes, fetch options, SQL, ciphertext, or payloads to an error.
      throw new ConnectorStorageUnavailableError(failureReason, upstreamStatus);
    } finally {
      connectorAuthDiagnostics.storage(input.operation, 'model' in input ? input.model : undefined,
        ok, performance.now() - started, ok ? undefined : failureReason, upstreamStatus);
    }
  }

  /** File-only batching never changes the ordinary OAuth storage relay or retries mutations. */
  private async relayFiles(operation: 'get' | 'put', inputs: ConnectorAuthStorageRequest[]): Promise<ConnectorAuthStorageResponse[]> {
    const started: number = performance.now();
    let ok: boolean = false;
    let failureReason: ConnectorStorageFailureReason = 'validation';
    let upstreamStatus: number = 0;
    let signal: AbortSignal | undefined;
    try {
      if (inputs.length < 1 || inputs.length > 16) throw new Error('File batch rejected.');
      inputs.forEach(validateStorageJson);
      const commands = storageFileBatchCommandSchema.parse(JSON.parse(JSON.stringify(inputs)));
      const timedCommands = commands.map((command) => ({ issuedAt: Date.now(), command }));
      timedCommands.forEach(validateStorageJson);
      failureReason = 'config';
      const configuredBase: string = connectorPublicUrl();
      const apiKey: string = process.env.CONNECTOR_STORAGE_API_KEY ?? '';
      if (!apiKey || apiKey.length > 4096 || /[\s\u0000-\u001f\u007f]/u.test(apiKey)) {
        throw new Error('Storage configuration unavailable.');
      }
      const sealed: string[] = timedCommands.map((timed): string => this.crypto.seal(timed, STORAGE_REQUEST_AAD));
      failureReason = 'validation';
      const body: string = JSON.stringify(validateStorageFileBatchEnvelope({ sealed }));
      signal = AbortSignal.timeout(15000);
      failureReason = 'network';
      const response: Response = await fetch(`${configuredBase}/openapi/connector-auth-storage/execute`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body, redirect: 'error', signal,
      });
      upstreamStatus = response.status;
      if (!response.ok) {
        failureReason = 'http';
        await response.body?.cancel().catch((): void => undefined);
        throw new Error('Storage operation unavailable.');
      }
      if (!response.headers.get('content-type')?.includes('application/json')) {
        failureReason = 'response_invalid';
        await response.body?.cancel().catch((): void => undefined);
        throw new Error('Storage operation unavailable.');
      }
      const responseText: string = await this.readLimitedBody(response, STORAGE_FILE_BATCH_MAX_BYTES);
      failureReason = 'response_invalid';
      const envelope = validateStorageFileBatchEnvelope(JSON.parse(responseText));
      if (envelope.sealed.length !== sealed.length) throw new Error('File batch response rejected.');
      const results: ConnectorAuthStorageResponse[] = envelope.sealed.map((result, index): ConnectorAuthStorageResponse =>
        validateStorageFileBatchResponse(this.crypto.open(result, this.crypto.responseAad(sealed[index])), operation));
      ok = true;
      return results;
    } catch (error: unknown) {
      if (error instanceof ConnectorStorageUnavailableError) failureReason = error.failureReason;
      else if (failureReason === 'network' && signal?.aborted) failureReason = 'network_timeout';
      throw new ConnectorStorageUnavailableError(failureReason, upstreamStatus);
    } finally {
      connectorAuthDiagnostics.storage(operation === 'get' ? 'getFileChunks' : 'putFileChunks', 'FeishuFileChunk',
        ok, performance.now() - started, ok ? undefined : failureReason, upstreamStatus, inputs.length);
    }
  }

  private async readLimitedBody(response: Response, maxBytes: number = 72000): Promise<string> {
    if (!response.body) throw new ConnectorStorageUnavailableError('response_invalid', response.status);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total: number = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        total += part.value.byteLength;
        if (total > maxBytes) throw new ConnectorStorageUnavailableError('response_invalid', response.status);
        chunks.push(part.value);
      }
      return Buffer.concat(chunks).toString('utf8');
    } finally {
      await reader.cancel().catch((): void => undefined);
      reader.releaseLock();
    }
  }
}

export { ConnectorAuthStorageService, ConnectorStorageUnavailableError };
export type { ConnectorStorageFailureReason };
