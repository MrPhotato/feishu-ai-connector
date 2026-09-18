import Provider, { errors, interactionPolicy } from 'oidc-provider';
import type { Account, AccessToken, Client, ClientCredentials, ClientMetadata, Configuration,
  KoaContextWithOIDC, RefreshToken } from 'oidc-provider';
import { createLocalJWKSet, jwtVerify } from 'jose';
import type { JWK, JWTVerifyResult } from 'jose';
import type { Request, Response } from 'express';
import { connectorAdapter } from './connector-oidc.adapter';
import { CONNECTOR_CHATGPT_CALLBACK } from './connector-auth.config';
import { authNow, authRecord } from './connector-auth.types';
import { CONNECTOR_CONNECTION_TTL, CONNECTOR_RESOURCE_SCOPES, connectorRefreshConsent } from './connector-refresh.consent';
import { connectorAuthDiagnostics } from './connector-auth.diagnostics';
import type { ConnectorAuthDiagnostics } from './connector-auth.diagnostics';
import type { ConnectorAuthConfig, ConnectorAuthStore, McpPrincipal, VerifiedMcpAuthorization } from './connector-auth.types';
import { connectorFeishuAccountMatches, connectorFeishuPermissionsComplete } from './connector-feishu.permissions';

export interface ConnectorOidcOptions {
  /** Only test harnesses pass this argument; the production service never supplies it. */
  testClient?: ClientMetadata;
  diagnostics?: ConnectorAuthDiagnostics;
}

export interface ConnectorOidc {
  provider: Provider;
  mount(request: Request, response: Response): Promise<void>;
  verifyMcpToken(token: string): Promise<McpPrincipal>;
  verifyMcpAuthorization(token: string): Promise<VerifiedMcpAuthorization>;
}

export function createConnectorOidc(
  config: ConnectorAuthConfig, store: ConnectorAuthStore, options: ConnectorOidcOptions = {},
): ConnectorOidc {
  const diagnostics: ConnectorAuthDiagnostics = options.diagnostics ?? connectorAuthDiagnostics;
  const client: ClientMetadata = options.testClient || {
    client_id: 'chatgpt', client_name: 'ChatGPT', redirect_uris: [CONNECTOR_CHATGPT_CALLBACK],
    response_types: ['code'], grant_types: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_method: 'none', application_type: 'web', id_token_signed_response_alg: 'RS256',
  };
  const policy: interactionPolicy.DefaultPolicy = interactionPolicy.base();
  // findAccount already reads live account state during this request. Keep this snapshot
  // inside the request only; no successful authorization is cached across requests.
  const upstreamAccounts: WeakMap<KoaContextWithOIDC, Record<string, unknown>> = new WeakMap();
  policy.get('login')?.checks.add(new interactionPolicy.Check(
    'feishu_scopes_changed', 'Feishu authorization must be updated',
    (ctx: KoaContextWithOIDC): boolean => {
      const accountId: string | undefined = ctx.oidc.session.accountId;
      if (!accountId) return false; // The provider's no_session check requests the first login.
      const account: Record<string, unknown> | undefined = upstreamAccounts.get(ctx);
      if (!connectorFeishuAccountMatches(account, accountId)) throw new errors.AccessDenied();
      if (connectorFeishuPermissionsComplete(account, config.feishuScopes)) return false;
      // A newly completed upstream login may be partially granted. End this transaction
      // safely instead of repeatedly redirecting to Feishu or claiming missing permissions.
      if (ctx.oidc.result?.login) throw new errors.AccessDenied('Required Feishu authorization was not granted');
      return true;
    },
  ));
  policy.get('consent')?.checks.add(new interactionPolicy.Check(
    'connector_persistent_connection', 'persistent connection requires explicit consent',
    async (ctx: KoaContextWithOIDC): Promise<boolean> => {
      if (ctx.oidc.client.clientId !== client.client_id || ![...ctx.oidc.requestParamScopes]
        .some((scope: string) => CONNECTOR_RESOURCE_SCOPES.includes(scope))) return false;
      return !await connectorRefreshConsent(store, config.resource, ctx.oidc.grant.jti,
        ctx.oidc.session.accountId, client.client_id, ctx.oidc.requestParamScopes);
    },
  ));
  const configuration: Configuration = {
    adapter: connectorAdapter(store), clients: [client], jwks: config.signingJwks,
    responseTypes: ['code'], subjectTypes: ['public'], clientAuthMethods: ['none'],
    scopes: ['openid', 'offline_access'],
    claims: { openid: ['sub'] },
    cookies: {
      keys: config.cookieKeys,
      names: { session: 'connector_oidc_session', interaction: 'connector_oidc_interaction', resume: 'connector_oidc_resume' },
      long: { httpOnly: true, sameSite: 'lax', secure: true },
      short: { httpOnly: true, sameSite: 'lax', secure: true },
    },
    features: {
      devInteractions: { enabled: false }, registration: { enabled: false },
      revocation: {
        enabled: true,
        allowedPolicy(_ctx: KoaContextWithOIDC, caller: Client, token: AccessToken | ClientCredentials | RefreshToken): boolean {
          return caller.clientId === client.client_id && token.clientId === caller.clientId;
        },
      },
      rpInitiatedLogout: { enabled: false },
      resourceIndicators: {
        enabled: true,
        getResourceServerInfo(_ctx: KoaContextWithOIDC, resource: string) {
          if (resource !== config.resource) throw new errors.InvalidTarget('Unknown resource');
          return { scope: 'feishu.read feishu.write', audience: config.resource,
            accessTokenTTL: 600, accessTokenFormat: 'jwt' as const, jwt: { sign: { alg: 'RS256' as const } } };
        },
      },
    },
    pkce: { required: () => true },
    interactions: { policy, url: (_ctx: KoaContextWithOIDC, interaction: { uid: string }): string =>
      `${config.publicUrl}/interaction/${encodeURIComponent(interaction.uid)}` },
    ttl: { AccessToken: 600, IdToken: 600, AuthorizationCode: 120, Interaction: 600,
      Session: 86400, Grant: CONNECTOR_CONNECTION_TTL,
      RefreshToken(ctx: KoaContextWithOIDC, token: RefreshToken): number {
        const expiresAt: number = Math.min(token.iiat + CONNECTOR_CONNECTION_TTL,
          ctx.oidc.entities.Grant?.exp ?? Number.POSITIVE_INFINITY,
          ctx.oidc.entities.RotatedRefreshToken?.exp ?? Number.POSITIVE_INFINITY);
        const remaining: number = expiresAt - authNow();
        if (remaining <= 0) throw new errors.InvalidGrant();
        return remaining;
      },
    },
    async issueRefreshToken(_ctx, caller, source): Promise<boolean> {
      return caller.clientId === client.client_id && caller.grantTypeAllowed('refresh_token') &&
        await connectorRefreshConsent(store, config.resource, source.grantId, source.accountId,
          caller.clientId, source.scopes);
    },
    async expiresWithSession(_ctx, source): Promise<boolean> {
      return source.clientId !== client.client_id || !await connectorRefreshConsent(store, config.resource,
        source.grantId, source.accountId, client.client_id, source.scopes);
    },
    async rotateRefreshToken(ctx: KoaContextWithOIDC): Promise<boolean> {
      const source: RefreshToken | undefined = ctx.oidc.entities.RefreshToken;
      if (!source || source.clientId !== client.client_id || !await connectorRefreshConsent(store, config.resource,
        source.grantId, source.accountId, client.client_id, source.scopes)) throw new errors.InvalidGrant();
      return true;
    },
    async findAccount(ctx: KoaContextWithOIDC, id: string): Promise<Account | undefined> {
      const account: Record<string, unknown> | undefined = await store.get('FeishuAccount', id);
      if (!connectorFeishuAccountMatches(account, id)) return undefined;
      upstreamAccounts.set(ctx, account);
      return { accountId: id, claims: (): { sub: string } => ({ sub: id }) };
    },
    extraTokenClaims(_ctx: KoaContextWithOIDC, token: AccessToken | ClientCredentials): Record<string, unknown> {
      if (!('grantId' in token) || typeof token.grantId !== 'string') throw new errors.InvalidGrant('Missing grant');
      return { grant_id: token.grantId };
    },
    renderError(ctx: KoaContextWithOIDC, out: { error?: string }): void {
      ctx.type = 'application/json';
      ctx.body = { error: out.error || 'server_error', error_description: 'Authorization could not be completed.' };
    },
  };
  const provider: Provider = new Provider(config.issuer, configuration);
  provider.proxy = true;
  // Avoid Koa's default stderr handler printing third-party bodies or sensitive request context.
  provider.silent = true;
  // Supported provider middleware observes only the selected numeric/enum response fields.
  provider.use(async (ctx: KoaContextWithOIDC, next: () => Promise<unknown>): Promise<void> => {
    if (ctx.path !== '/token' || ctx.method !== 'POST') { await next(); return; }
    const started: number = performance.now();
    let completed: boolean = false;
    try { await next(); completed = true; } finally {
      const reply: unknown = ctx.body;
      diagnostics.token(ctx.oidc.params?.grant_type, completed ? ctx.status : 0, performance.now() - started,
        authRecord(reply) ? reply.expires_in : undefined);
    }
  });
  const callback: ReturnType<Provider['callback']> = provider.callback();
  const publicKeys: JWK[] = config.signingJwks.keys.map((key: JWK): JWK => ({
    kty: key.kty, kid: key.kid, use: 'sig', alg: 'RS256', n: key.n, e: key.e,
  }));
  const keyResolver: ReturnType<typeof createLocalJWKSet> = createLocalJWKSet({ keys: publicKeys });
  const oidc: ConnectorOidc = {
    provider,
    async mount(request: Request, response: Response): Promise<void> {
      const originalUrl: string = request.originalUrl;
      const incomingUrl: string = request.url;
      const mountedPath: string = new URL(config.issuer).pathname;
      const requestPath: string = new URL(incomingUrl, config.publicUrl).pathname;
      const suffix: string = requestPath.startsWith(mountedPath) ? incomingUrl.slice(mountedPath.length) :
        incomingUrl.startsWith('/oidc') ? incomingUrl.slice('/oidc'.length) : '';
      if (!suffix.startsWith('/')) {
        response.status(404).json({ error: 'not_found' }); return;
      }
      // Restore the externally visible prefix stripped by the managed app gateway. Host/HTTPS are
      // fixed from deployment configuration, never copied from untrusted forwarded request headers.
      request.originalUrl = `${mountedPath}${suffix}`;
      request.url = suffix;
      request.headers.host = new URL(config.publicUrl).host;
      request.headers['x-forwarded-host'] = new URL(config.publicUrl).host;
      request.headers['x-forwarded-proto'] = 'https';
      try { await callback(request, response); } finally {
        request.originalUrl = originalUrl; request.url = incomingUrl;
      }
    },
    async verifyMcpToken(token: string): Promise<McpPrincipal> {
      return (await oidc.verifyMcpAuthorization(token)).principal;
    },
    async verifyMcpAuthorization(token: string): Promise<VerifiedMcpAuthorization> {
      const started: number = performance.now();
      let signatureMs: number = 0;
      let storageMs: number = 0;
      let ok: boolean = false;
      try {
        const result: JWTVerifyResult = await jwtVerify(token, keyResolver, {
          issuer: config.issuer, audience: config.resource, algorithms: ['RS256'], typ: 'at+jwt',
          requiredClaims: ['exp', 'iat', 'sub', 'jti', 'grant_id', 'client_id'], clockTolerance: 0,
        });
        signatureMs = performance.now() - started;
        const { payload } = result;
        if (typeof payload.sub !== 'string' || typeof payload.grant_id !== 'string' ||
          payload.client_id !== client.client_id || typeof payload.scope !== 'string') throw new Error('Invalid token');
        const storageStarted: number = performance.now();
        // Independent reads remain live on every request; no successful authorization is cached.
        const reads: PromiseSettledResult<Record<string, unknown> | undefined>[] = await Promise.allSettled([
          store.get('Grant', payload.grant_id), store.get('FeishuAccount', payload.sub),
        ]);
        storageMs = performance.now() - storageStarted;
        if (reads[0].status !== 'fulfilled' || reads[1].status !== 'fulfilled') throw new Error('Invalid token');
        const grant: Record<string, unknown> | undefined = reads[0].value;
        const account: Record<string, unknown> | undefined = reads[1].value;
        const scopes: string[] = payload.scope.split(' ').filter(Boolean);
        const grantedScopes: unknown = grant && authRecord(grant.resources) ? grant.resources[config.resource] : undefined;
        if (!grant || grant.accountId !== payload.sub || grant.clientId !== client.client_id ||
          !account || account.revoked === true || !scopes.length ||
          typeof grantedScopes !== 'string' || scopes.some((scope: string) =>
            !['feishu.read', 'feishu.write'].includes(scope) || !grantedScopes.split(' ').includes(scope))) {
          throw new Error('Invalid token');
        }
        ok = true;
        return { principal: { accountId: payload.sub, scopes }, account };
      } finally {
        diagnostics.authorization(ok, performance.now() - started, signatureMs || performance.now() - started, storageMs);
      }
    },
  };
  return oidc;
}
