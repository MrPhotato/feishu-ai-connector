import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { validateStorageJson } from './connector-auth-storage.contract';

const STORAGE_REQUEST_AAD: string = 'connector-auth-storage:request:v1';

@Injectable()
class ConnectorAuthStorageCrypto {
  hash(purpose: 'key' | 'uid' | 'grant', ...parts: string[]): string {
    return createHmac('sha256', this.derive('index'))
      .update(JSON.stringify([purpose, ...parts])).digest('hex');
  }

  recordAad(model: string, keyHash: string): string {
    return JSON.stringify(['connector-auth-storage:record:v1', model, keyHash]);
  }

  responseAad(request: string): string {
    return `connector-auth-storage:response:v1:${createHash('sha256').update(request).digest('hex')}`;
  }

  seal(value: unknown, aad: string): string {
    validateStorageJson(value);
    const nonce: Buffer = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.derive('encryption'), nonce);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext: Buffer = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return ['v1', nonce.toString('base64url'), ciphertext.toString('base64url'),
      cipher.getAuthTag().toString('base64url')].join(':');
  }

  open(sealed: string, aad: string): unknown {
    if (sealed.length > 70000) throw new Error('Storage request rejected.');
    const parts: string[] = sealed.split(':');
    if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Storage request rejected.');
    const nonce: Buffer = Buffer.from(parts[1], 'base64url');
    const ciphertext: Buffer = Buffer.from(parts[2], 'base64url');
    const tag: Buffer = Buffer.from(parts[3], 'base64url');
    if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length > 49152) {
      throw new Error('Storage request rejected.');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.derive('encryption'), nonce);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    const plaintext: string = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    const value: unknown = JSON.parse(plaintext);
    validateStorageJson(value);
    return value;
  }

  private derive(purpose: 'index' | 'encryption'): Buffer {
    const encoded: string = process.env.CONNECTOR_STORAGE_ENCRYPTION_KEY ?? '';
    if (!/^[0-9a-fA-F]{64}$/u.test(encoded)) throw new Error('Storage configuration unavailable.');
    return createHmac('sha256', Buffer.from(encoded, 'hex'))
      .update(`connector-auth-storage:${purpose}:v1`).digest();
  }
}

export { ConnectorAuthStorageCrypto, STORAGE_REQUEST_AAD };
