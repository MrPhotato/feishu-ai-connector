import type { JWK } from 'jose';

/** Persistence supplied by the encrypted server-side credential store. Times are Unix seconds. */
export interface ConnectorAuthStore {
  get(model: string, key: string): Promise<Record<string, unknown> | undefined>;
  put(model: string, key: string, payload: Record<string, unknown>, expiresAt: number,
    uid?: string, grantId?: string): Promise<void>;
  consume(model: string, key: string): Promise<boolean>;
  remove(model: string, key: string): Promise<void>;
  revokeGrant(grantId: string): Promise<void>;
  findUid(model: string, uid: string): Promise<Record<string, unknown> | undefined>;
  acquireLease(key: string, ttlSeconds?: number): Promise<string | undefined>;
  releaseLease(key: string, leaseToken: string): Promise<void>;
}

export interface ConnectorAuthConfig {
  publicUrl: string;
  issuer: string;
  resource: string;
  feishuAppId: string;
  feishuAppSecret: string;
  feishuScopes: string;
  signingJwks: { keys: JWK[] };
  cookieKeys: string[];
}

export interface McpPrincipal {
  accountId: string;
  scopes: string[];
}

/** Server-only, single HTTP request context. Never serialize or cache these upstream credentials. */
export interface VerifiedMcpAuthorization {
  principal: McpPrincipal;
  account: Record<string, unknown>;
}

export interface FeishuHttpResponse {
  ok: boolean;
  body: unknown;
}

export type FeishuHttp = (url: string, init: {
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
}) => Promise<FeishuHttpResponse>;

export function authRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function authStrings(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item: unknown) => typeof item === 'string')) return [];
  return value;
}

export function authNow(): number {
  return Math.floor(Date.now() / 1000);
}
