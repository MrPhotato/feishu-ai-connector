import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { ConnectorAuthStorageRequest, ConnectorAuthStorageResponse } from '@shared/api.interface';
import {
  storageCommandSchema, storageEnvelopeSchema, storageResponseSchema, validateStorageJson,
} from './connector-auth-storage.contract';
import { ConnectorAuthStorageCrypto, STORAGE_REQUEST_AAD } from './connector-auth-storage.crypto';
import { connectorAuthDiagnostics } from '../connector-auth/connector-auth.diagnostics';
import { connectorPublicUrl } from '../../config/connector-deployment.config';

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

  async consume(model: string, key: string): Promise<boolean> {
    const result: ConnectorAuthStorageResponse = await this.relay({ operation: 'consume', model, key });
    if (typeof result.consumed !== 'boolean') {
      throw new ServiceUnavailableException('Authorization storage is unavailable.');
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
    try {
      validateStorageJson(input);
      // Match JSON persistence semantics: omit optional undefined properties before
      // strict validation, as oidc-provider payloads may contain such properties.
      const command = storageCommandSchema.parse(JSON.parse(JSON.stringify(input)));
      // Same validated, server-configured deployment as OAuth; no per-request target override.
      const configuredBase: string = connectorPublicUrl();
      const apiKey: string = process.env.CONNECTOR_STORAGE_API_KEY ?? '';
      if (!apiKey || apiKey.length > 4096 || /[\s\u0000-\u001f\u007f]/u.test(apiKey)) {
        throw new Error('Storage configuration unavailable.');
      }
      const sealed: string = this.crypto.seal({ issuedAt: Date.now(), command }, STORAGE_REQUEST_AAD);
      // Native fetch avoids platform HTTP-client logging of headers or request bodies.
      // Redirects are prohibited so the API Key can never be forwarded to another host.
      const response: Response = await fetch(`${configuredBase}/openapi/connector-auth-storage/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ sealed }),
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
        await response.body?.cancel();
        throw new Error('Storage operation unavailable.');
      }
      const responseText: string = await this.readLimitedBody(response);
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
    } catch {
      // Never attach causes, fetch options, SQL, ciphertext, or payloads to an error.
      throw new ServiceUnavailableException('Authorization storage is unavailable.');
    } finally {
      connectorAuthDiagnostics.storage(input.operation, 'model' in input ? input.model : undefined,
        ok, performance.now() - started);
    }
  }

  private async readLimitedBody(response: Response): Promise<string> {
    if (!response.body) throw new Error('Storage operation unavailable.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total: number = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        total += part.value.byteLength;
        if (total > 72000) throw new Error('Storage operation unavailable.');
        chunks.push(part.value);
      }
      return Buffer.concat(chunks).toString('utf8');
    } finally {
      await reader.cancel().catch((): void => undefined);
      reader.releaseLock();
    }
  }
}

export { ConnectorAuthStorageService };
