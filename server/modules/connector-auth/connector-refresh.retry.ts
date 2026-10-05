import { createHmac } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { parse as parseForm } from 'node:querystring';
import { setTimeout as delay } from 'node:timers/promises';
import { decodeJwt } from 'jose';
import { errors } from 'oidc-provider';
import type Provider from 'oidc-provider';
import type { KoaContextWithOIDC } from 'oidc-provider';
import type { IncomingMessage } from 'node:http';
import type { ConnectorAuthConfig, ConnectorAuthStore } from './connector-auth.types';
import type { ConnectorAuthDiagnostics, ConnectorRefreshRetryStage } from './connector-auth.diagnostics';
import { authNow, authRecord } from './connector-auth.types';
import { connectorFeishuAccountMatches } from './connector-feishu.permissions';
import { connectorRefreshConsent } from './connector-refresh.consent';
import { ConnectorAuthUnavailableError, connectorAuthStorageOperation } from './connector-auth.unavailable';

export const CONNECTOR_REFRESH_RETRY_SECONDS: number = 30;
export const CONNECTOR_REFRESH_COOLDOWN_SECONDS: number = 60;
export const CONNECTOR_REFRESH_LEASE_SECONDS: number = 300;
const MAX_FORM_BYTES: number = 32768;
const MAX_CREDENTIAL_BYTES: number = 16384;
const FORM_KEYS: readonly string[] = ['grant_type', 'client_id', 'refresh_token', 'scope', 'resource'];

interface RetryRequest { token: string; scope?: string; resource?: string; shape: string }
interface RetryBinding {
  v: 1; sourceHash: string; requestShape: string; requestFingerprint: string;
  grantId: string; accountId: string; clientId: string; resource: string; sourceExpiresAt: number; sourceScope: string;
}
interface RetryJournal extends RetryBinding {
  status: 'pending' | 'completed'; createdAt?: number; retryUntil?: number; successorHash?: string;
}
interface RefreshReceipt extends RetryBinding {
  createdAt: number; retryUntil: number; cooldownUntil: number; accessExpiresAt: number;
  successorExpiresAt: number; successorHash: string; response: Record<string, unknown>;
}
type RetryHash = (domain: string, value: string) => string;
type ParsedRequest = IncomingMessage & { body?: unknown };
interface ReceiptTiming { deadline: number; accessExpiresAt: number }
interface RotationAttempt { consumeAttempted: boolean }
const rotationAttempts: AsyncLocalStorage<RotationAttempt> = new AsyncLocalStorage<RotationAttempt>();

/** Mark the uncertainty boundary before invoking the real store, including thrown/lost acknowledgements. */
export function connectorRefreshRetryStore(store: ConnectorAuthStore): ConnectorAuthStore {
  return {
    get: (model, key) => store.get(model, key),
    put: (model, key, payload, expiresAt, uid, grantId) => store.put(model, key, payload, expiresAt, uid, grantId),
    findUid: (model, uid) => store.findUid(model, uid),
    remove: (model, key) => store.remove(model, key),
    revokeGrant: (grantId) => store.revokeGrant(grantId),
    acquireLease: (key, ttlSeconds) => store.acquireLease(key, ttlSeconds),
    releaseLease: (key, leaseToken) => store.releaseLease(key, leaseToken),
    consume(model: string, key: string): Promise<boolean> {
      const attempt: RotationAttempt | undefined = rotationAttempts.getStore();
      if (model === 'RefreshToken' && attempt) attempt.consumeAttempted = true;
      return store.consume(model, key);
    },
  };
}

function seconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function singleResource(value: unknown, resource: string): boolean {
  return value === resource || (Array.isArray(value) && value.length === 1 && value[0] === resource);
}

function credential(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_CREDENTIAL_BYTES &&
    /^[\x21-\x7e]+$/u.test(value);
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (key: string, item: unknown): unknown => {
    if (key === 'consumed') return undefined;
    return authRecord(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]): number =>
      a < b ? -1 : a > b ? 1 : 0)) : item;
  });
}

/** Preserve the provider's form parser input, including duplicate parameters. */
async function readForm(ctx: KoaContextWithOIDC): Promise<Record<string, unknown>> {
  const req: ParsedRequest = ctx.req;
  let body: unknown = req.body;
  if (req.readable) {
    const chunks: Buffer[] = [];
    let bytes: number = 0;
    for await (const part of req.iterator({ destroyOnReturn: false })) {
      const chunk: Buffer = Buffer.isBuffer(part) ? part : Buffer.from(part as string);
      bytes += chunk.length;
      if (bytes > MAX_FORM_BYTES) throw new errors.InvalidRequest('Invalid token request');
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks, bytes).toString('utf8');
    req.body = body;
  }
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body === 'string') {
    if (Buffer.byteLength(body, 'utf8') > MAX_FORM_BYTES) throw new errors.InvalidRequest('Invalid token request');
    return parseForm(body, undefined, undefined, { maxKeys: 0 });
  }
  if (authRecord(body) && Buffer.byteLength(JSON.stringify(body), 'utf8') <= MAX_FORM_BYTES) return body;
  throw new errors.InvalidRequest('Invalid token request');
}

function parseRetryRequest(
  ctx: KoaContextWithOIDC, form: Record<string, unknown>, config: ConnectorAuthConfig,
  clientId: string, hash: RetryHash,
): RetryRequest {
  if (!/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/iu.test(ctx.get('content-type')) ||
    ctx.querystring || ['authorization', 'dpop', 'oauth-client-attestation', 'oauth-client-attestation-pop']
      .some((name: string): boolean => ctx.get(name) !== '') ||
    Object.keys(form).some((name: string): boolean => !FORM_KEYS.includes(name)) ||
    Object.values(form).some((value: unknown): boolean => typeof value !== 'string') ||
    form.client_id !== clientId || !credential(form.refresh_token) ||
    (form.resource !== undefined && form.resource !== config.resource)) {
    throw new errors.InvalidRequest('Invalid token request');
  }
  let scope: string | undefined;
  if (form.scope !== undefined) {
    if (typeof form.scope !== 'string' || form.scope.length > 4096 || !form.scope ||
      !form.scope.split(' ').every((value: string): boolean => /^[\x21\x23-\x5b\x5d-\x7e]+$/u.test(value))) {
      throw new errors.InvalidScope('Invalid scope', '');
    }
    scope = [...new Set(form.scope.split(' '))].sort().join(' ');
  }
  const resource: string | undefined = typeof form.resource === 'string' ? form.resource : undefined;
  return { token: form.refresh_token, scope, resource,
    shape: hash('shape', JSON.stringify([clientId, resource ?? null, scope ?? null])) };
}

function sourceBinding(
  source: Record<string, unknown> | undefined, request: RetryRequest, config: ConnectorAuthConfig,
  clientId: string, hash: RetryHash,
): RetryBinding | undefined {
  if (!source || source.clientId !== clientId || typeof source.grantId !== 'string' || !source.grantId ||
    typeof source.accountId !== 'string' || !source.accountId || !seconds(source.exp) || source.exp <= authNow() ||
    typeof source.scope !== 'string' || source.jkt !== undefined || source['x5t#S256'] !== undefined ||
    source.attestationJkt !== undefined) return undefined;
  const resources: unknown[] = Array.isArray(source.resource) ? source.resource : [source.resource];
  if (resources.length !== 1 || resources[0] !== config.resource) return undefined;
  const scopes: string[] = source.scope.split(' ');
  // With openid and an omitted resource the provider may target UserInfo. Do not
  // conflate that response with this application-specific MCP response cache.
  if (!request.resource && scopes.includes('openid')) return undefined;
  if (request.scope && request.scope.split(' ').some((scope: string): boolean => !scopes.includes(scope))) {
    throw new errors.InvalidScope('Invalid scope', '');
  }
  const sourceHash: string = hash('source', request.token);
  return { v: 1, sourceHash, requestShape: request.shape,
    requestFingerprint: hash('fingerprint', `${sourceHash}:${request.shape}`),
    grantId: source.grantId, accountId: source.accountId, clientId, resource: config.resource,
    sourceExpiresAt: source.exp, sourceScope: source.scope };
}

function matchingBinding(value: Record<string, unknown>, binding: RetryBinding, current: boolean = false): boolean {
  return value.v === 1 && value.grantId === binding.grantId && value.accountId === binding.accountId &&
    value.clientId === binding.clientId && value.resource === binding.resource &&
    value.requestShape === binding.requestShape && value.sourceScope === binding.sourceScope &&
    (current ? value.successorHash === binding.sourceHash && value.successorExpiresAt === binding.sourceExpiresAt :
      value.sourceHash === binding.sourceHash && value.sourceExpiresAt === binding.sourceExpiresAt &&
      value.requestFingerprint === binding.requestFingerprint);
}

function receiptRecord(value: Record<string, unknown> | undefined): value is Record<string, unknown> & RefreshReceipt {
  return !!value && value.v === 1 && typeof value.sourceHash === 'string' && typeof value.requestFingerprint === 'string' &&
    typeof value.successorHash === 'string' && seconds(value.createdAt) && seconds(value.retryUntil) &&
    seconds(value.cooldownUntil) && seconds(value.accessExpiresAt) && seconds(value.sourceExpiresAt) &&
    seconds(value.successorExpiresAt) && value.retryUntil === value.createdAt + CONNECTOR_REFRESH_RETRY_SECONDS &&
    value.cooldownUntil === value.createdAt + CONNECTOR_REFRESH_COOLDOWN_SECONDS &&
    value.createdAt <= authNow() && authRecord(value.response) && credential(value.response.refresh_token) &&
    credential(value.response.access_token) && value.response.token_type === 'Bearer' &&
    typeof value.response.scope === 'string';
}

function completedJournal(binding: RetryBinding, receipt: RefreshReceipt): RetryJournal {
  return { ...binding, status: 'completed', createdAt: receipt.createdAt,
    retryUntil: receipt.retryUntil, successorHash: receipt.successorHash };
}

/** Only identical encrypted records are retried. A failed or uncertain CAS is never retried. */
async function persistVerified(
  store: ConnectorAuthStore, model: 'RefreshRetry' | 'RefreshResponse', key: string,
  payload: RetryJournal | RefreshReceipt, expiresAt: number, uid: string,
): Promise<void> {
  const serialized: Record<string, unknown> = { ...payload };
  const started: number = performance.now();
  for (let attempt: number = 0; attempt < 3; attempt += 1) {
    if (expiresAt <= authNow() || performance.now() - started >= 12000) break;
    if (attempt) await delay(attempt * 150);
    try { await store.put(model, key, serialized, expiresAt, uid, payload.grantId); } catch { /* Read back an uncertain commit. */ }
    let observed: Record<string, unknown> | undefined;
    try { observed = await store.get(model, key); } catch { continue; }
    if (observed) {
      if (canonical(observed) !== canonical(serialized)) throw new ConnectorAuthUnavailableError();
      return;
    }
  }
  throw new ConnectorAuthUnavailableError();
}

async function liveAuthorization(store: ConnectorAuthStore, binding: RetryBinding, scopes: string): Promise<boolean> {
  const [consent, account]: [boolean, Record<string, unknown> | undefined] = await Promise.all([
    connectorRefreshConsent(store, binding.resource, binding.grantId, binding.accountId,
      binding.clientId, new Set(scopes.split(' '))),
    connectorAuthStorageOperation(() => store.get('FeishuAccount', binding.accountId)),
  ]);
  return consent && connectorFeishuAccountMatches(account, binding.accountId);
}

/** The unique claimant may unlock only after its provider invocation has fully ended before any RT consume. */
async function releaseUnusedClaim(
  store: ConnectorAuthStore, binding: RetryBinding, ctx: KoaContextWithOIDC, attempt: RotationAttempt,
): Promise<void> {
  if (attempt.consumeAttempted || (authRecord(ctx.body) &&
    (typeof ctx.body.access_token === 'string' || typeof ctx.body.refresh_token === 'string'))) return;
  try {
    const journal: Record<string, unknown> | undefined = await store.get('RefreshRetry', binding.sourceHash);
    if (!journal || journal.status !== 'pending' || !seconds(journal.consumed) || !matchingBinding(journal, binding)) return;
    // A receipt means that completion is being recovered; its claim must survive.
    if (await store.get('RefreshResponse', binding.sourceHash)) return;
    // Never retry this delete: if its acknowledgement is lost, a later request
    // may already have created a new claim under the same immutable binding.
    await store.remove('RefreshRetry', binding.sourceHash);
  } catch { /* Uncertain cleanup keeps the durable fence; it never retries provider rotation. */ }
}

async function serveReceipt(
  ctx: KoaContextWithOIDC, store: ConnectorAuthStore, binding: RetryBinding,
  receipt: RefreshReceipt, hash: RetryHash, current: boolean,
): Promise<ReceiptTiming> {
  const deadline: number = Math.min(current ? receipt.cooldownUntil : receipt.retryUntil,
    receipt.sourceExpiresAt, receipt.successorExpiresAt, receipt.accessExpiresAt);
  if (authNow() >= deadline || hash('source', String(receipt.response.refresh_token)) !== receipt.successorHash) {
    throw new ConnectorAuthUnavailableError();
  }
  const [active, successor]: [boolean, Record<string, unknown> | undefined] = await Promise.all([
    liveAuthorization(store, binding, String(receipt.response.scope)),
    connectorAuthStorageOperation(() => store.get('RefreshToken', String(receipt.response.refresh_token))),
  ]);
  if (!active || !successor || successor.consumed !== undefined || successor.exp !== receipt.successorExpiresAt ||
    successor.clientId !== binding.clientId || successor.accountId !== binding.accountId || successor.grantId !== binding.grantId ||
    successor.scope !== binding.sourceScope || !singleResource(successor.resource, binding.resource)) {
    throw new errors.InvalidGrant();
  }
  // Re-check after all I/O. A slow store must not stretch either fixed window.
  const respondedAt: number = authNow();
  if (respondedAt >= deadline) throw new ConnectorAuthUnavailableError();
  ctx.status = 200;
  ctx.type = 'application/json';
  ctx.body = { ...receipt.response, expires_in: receipt.accessExpiresAt - respondedAt };
  return { deadline, accessExpiresAt: receipt.accessExpiresAt };
}

function successfulReceipt(
  ctx: KoaContextWithOIDC, binding: RetryBinding, hash: RetryHash,
): RefreshReceipt | undefined {
  if (ctx.status !== 200 || !authRecord(ctx.body) || !credential(ctx.body.refresh_token) ||
    !credential(ctx.body.access_token) || ctx.body.token_type !== 'Bearer' || typeof ctx.body.scope !== 'string') return undefined;
  const claims = decodeJwt(ctx.body.access_token);
  if (!seconds(claims.exp) || claims.exp <= authNow() || claims.sub !== binding.accountId ||
    claims.client_id !== binding.clientId || claims.grant_id !== binding.grantId || claims.aud !== binding.resource ||
    claims.scope !== ctx.body.scope || !ctx.body.scope || ctx.body.scope.split(' ').some((scope: string): boolean =>
      !['feishu.read', 'feishu.write'].includes(scope) || !binding.sourceScope.split(' ').includes(scope))) {
    throw new ConnectorAuthUnavailableError();
  }
  const createdAt: number = authNow();
  return { ...binding, createdAt, retryUntil: createdAt + CONNECTOR_REFRESH_RETRY_SECONDS,
    cooldownUntil: createdAt + CONNECTOR_REFRESH_COOLDOWN_SECONDS, accessExpiresAt: claims.exp,
    successorExpiresAt: binding.sourceExpiresAt, successorHash: hash('source', ctx.body.refresh_token),
    response: JSON.parse(JSON.stringify(ctx.body)) as Record<string, unknown> };
}

/** A fixed, application-specific retry exception; not a general OAuth client-authentication layer. */
export function installConnectorRefreshRetry(
  provider: Provider, store: ConnectorAuthStore, config: ConnectorAuthConfig, clientId: string,
  diagnostics: ConnectorAuthDiagnostics,
): void {
  const hash: RetryHash = (domain: string, value: string): string => createHmac('sha256', config.cookieKeys[0])
    .update(`connector-refresh-retry:v1:${domain}:`).update(value).digest('hex');
  provider.use(async (ctx: KoaContextWithOIDC, next: () => Promise<unknown>): Promise<void> => {
    if (ctx.path !== '/token' || ctx.method !== 'POST') { await next(); return; }
    const started: number = performance.now();
    let stage: ConnectorRefreshRetryStage = 'rejected';
    let ok: boolean = false;
    let refresh: boolean = false;
    let lease: string | undefined;
    let leaseKey: string | undefined;
    let timing: ReceiptTiming | undefined;
    ctx.set('Cache-Control', 'no-store');
    ctx.set('Pragma', 'no-cache');
    try {
      const form: Record<string, unknown> = await readForm(ctx);
      if (form.grant_type !== 'refresh_token') { await next(); return; }
      refresh = true;
      ctx.state.connectorRefreshRetryRequest = true;
      const request: RetryRequest = parseRetryRequest(ctx, form, config, clientId, hash);
      let source: Record<string, unknown> | undefined = await connectorAuthStorageOperation(() => store.get('RefreshToken', request.token));
      const binding: RetryBinding | undefined = sourceBinding(source, request, config, clientId, hash);
      if (!binding) { await next(); return; }
      leaseKey = hash('lease', binding.grantId);
      for (const pause of [0, 250, 500]) {
        if (pause) await delay(pause);
        lease = await connectorAuthStorageOperation(() => store.acquireLease(leaseKey!, CONNECTOR_REFRESH_LEASE_SECONDS));
        if (lease) break;
      }
      if (!lease) { stage = 'lease_busy'; throw new ConnectorAuthUnavailableError(); }
      source = await connectorAuthStorageOperation(() => store.get('RefreshToken', request.token));
      if (!source || !sourceBinding(source, request, config, clientId, hash)) { await next(); return; }
      let journal: Record<string, unknown> | undefined = await connectorAuthStorageOperation(() => store.get('RefreshRetry', binding.sourceHash));
      if (journal && !matchingBinding(journal, binding)) throw new errors.InvalidRequest('Refresh request does not match');
      if (journal?.status === 'completed' && seconds(journal.retryUntil) && authNow() >= journal.retryUntil) {
        stage = 'expired_replay'; await next(); return;
      }
      if (journal?.status === 'completed' || journal?.consumed !== undefined) {
        const receipt: Record<string, unknown> | undefined = await connectorAuthStorageOperation(() => store.get('RefreshResponse', binding.sourceHash));
        if (!receiptRecord(receipt) || !matchingBinding(receipt, binding)) { stage = 'uncertain'; throw new ConnectorAuthUnavailableError(); }
        if (journal.status !== 'completed') {
          await persistVerified(store, 'RefreshRetry', binding.sourceHash, completedJournal(binding, receipt),
            binding.sourceExpiresAt, binding.requestFingerprint);
        }
        stage = 'old_retry'; timing = await serveReceipt(ctx, store, binding, receipt, hash, false); ok = true; return;
      }
      const currentReceipt: Record<string, unknown> | undefined = await connectorAuthStorageOperation(() =>
        store.findUid('RefreshResponse', binding.sourceHash));
      if (currentReceipt && !receiptRecord(currentReceipt)) { stage = 'uncertain'; throw new ConnectorAuthUnavailableError(); }
      if (currentReceipt && receiptRecord(currentReceipt) && authNow() < currentReceipt.cooldownUntil) {
        if (!matchingBinding(currentReceipt, binding, true)) { stage = 'cooldown_mismatch'; throw new ConnectorAuthUnavailableError(); }
        const predecessorJournal: Record<string, unknown> | undefined = await connectorAuthStorageOperation(() =>
          store.get('RefreshRetry', currentReceipt.sourceHash));
        if (!predecessorJournal || predecessorJournal.status !== 'completed' ||
          predecessorJournal.successorHash !== binding.sourceHash ||
          predecessorJournal.requestFingerprint !== currentReceipt.requestFingerprint ||
          predecessorJournal.grantId !== binding.grantId || predecessorJournal.accountId !== binding.accountId) {
          stage = 'uncertain'; throw new ConnectorAuthUnavailableError();
        }
        stage = 'cooldown'; timing = await serveReceipt(ctx, store, binding, currentReceipt, hash, true); ok = true; return;
      }
      if (source.consumed !== undefined) { stage = 'expired_replay'; await next(); return; }
      if (!await liveAuthorization(store, binding, request.scope ?? String(source.scope))) { await next(); return; }
      if (!journal) {
        await persistVerified(store, 'RefreshRetry', binding.sourceHash, { ...binding, status: 'pending' },
          binding.sourceExpiresAt, binding.requestFingerprint);
        journal = await connectorAuthStorageOperation(() => store.get('RefreshRetry', binding.sourceHash));
      }
      if (!journal || journal.status !== 'pending' || !matchingBinding(journal, binding) ||
        !await connectorAuthStorageOperation(() => store.consume('RefreshRetry', binding.sourceHash))) {
        stage = 'uncertain'; throw new ConnectorAuthUnavailableError();
      }
      // Only this CAS winner can release a claim, and only after a completed
      // provider invocation that never attempted to consume the source token.
      stage = 'rotation';
      const attempt: RotationAttempt = { consumeAttempted: false };
      try { await rotationAttempts.run(attempt, next); }
      finally { await releaseUnusedClaim(store, binding, ctx, attempt); }
      const receipt: RefreshReceipt | undefined = successfulReceipt(ctx, binding, hash);
      if (!receipt) return;
      const successor: Record<string, unknown> | undefined = await connectorAuthStorageOperation(() =>
        store.get('RefreshToken', String(receipt.response.refresh_token)));
      if (!successor || successor.consumed !== undefined || !seconds(successor.exp) || successor.exp <= authNow() ||
        successor.exp > binding.sourceExpiresAt ||
        successor.clientId !== binding.clientId || successor.accountId !== binding.accountId || successor.grantId !== binding.grantId ||
        successor.scope !== binding.sourceScope || !singleResource(successor.resource, binding.resource)) {
        throw new ConnectorAuthUnavailableError();
      }
      receipt.successorExpiresAt = successor.exp;
      await persistVerified(store, 'RefreshResponse', binding.sourceHash, receipt,
        Math.min(binding.sourceExpiresAt, receipt.cooldownUntil), receipt.successorHash);
      await persistVerified(store, 'RefreshRetry', binding.sourceHash, completedJournal(binding, receipt),
        binding.sourceExpiresAt, binding.requestFingerprint);
      timing = await serveReceipt(ctx, store, binding, receipt, hash, true);
      ok = true;
    } catch (error: unknown) {
      const protocolError: errors.OIDCProviderError | undefined = error instanceof errors.OIDCProviderError ? error : undefined;
      const unavailable: boolean = error instanceof ConnectorAuthUnavailableError || !protocolError;
      if (unavailable && stage === 'rejected') stage = 'storage_unavailable';
      ctx.status = unavailable ? 503 : protocolError!.statusCode;
      ctx.type = 'application/json';
      ctx.body = { error: unavailable ? 'temporarily_unavailable' : protocolError!.error,
        error_description: unavailable ? 'Authorization is temporarily unavailable. Please retry later.' : 'Invalid refresh request.' };
    } finally {
      if (lease && leaseKey) {
        try { await store.releaseLease(leaseKey, lease); } catch { /* The lease expires; never repeat rotation to release it. */ }
      }
      if (timing && ctx.status === 200 && authRecord(ctx.body)) {
        const sentAt: number = authNow();
        if (sentAt >= timing.deadline) {
          stage = 'uncertain'; ok = false; ctx.status = 503;
          ctx.body = { error: 'temporarily_unavailable', error_description: 'Authorization is temporarily unavailable. Please retry later.' };
        } else ctx.body = { ...ctx.body, expires_in: timing.accessExpiresAt - sentAt };
      }
      if (refresh) diagnostics.refreshRetry?.(stage, ok, performance.now() - started);
    }
  });
}
