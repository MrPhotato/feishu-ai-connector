import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import type Provider from 'oidc-provider';
import type { Grant, Interaction } from 'oidc-provider';
import { authNow, authRecord, authStrings } from './connector-auth.types';
import { CONNECTOR_CONNECTION_TTL, CONNECTOR_RESOURCE_SCOPES } from './connector-refresh.consent';
import { connectorAuthDiagnostics } from './connector-auth.diagnostics';
import type { ConnectorAuthDiagnostics } from './connector-auth.diagnostics';
import type { ConnectorAuthConfig, ConnectorAuthStore, FeishuHttp, FeishuHttpResponse } from './connector-auth.types';

function randomValue(): string { return randomBytes(32).toString('base64url'); }
function digest(value: string): string { return createHash('sha256').update(value).digest('base64url'); }
function equalDigest(value: string, expected: string): boolean {
  const actual: Buffer = Buffer.from(digest(value));
  const reference: Buffer = Buffer.from(expected);
  return actual.length === reference.length && timingSafeEqual(actual, reference);
}
function cookieValue(request: Request, name: string): string {
  const values: string[] = (request.headers.cookie || '').split(';').map((part: string) => part.trim());
  const found: string[] = values.filter((part: string) => part.startsWith(`${name}=`));
  return found.length === 1 ? found[0].slice(name.length + 1) : '';
}
function html(value: string): string {
  return value.replace(/[&<>"']/gu, (character: string) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character] || ''));
}
function field(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096) throw new Error('Invalid request');
  return value;
}
function credential(value: unknown): string {
  // Provider credentials can grow with granted scopes. This is not the limit for
  // state, codes or identifiers; printable ASCII also prevents header injection.
  if (typeof value !== 'string' || !value || value.length > 16384 || !/^[\x21-\x7e]+$/u.test(value)) {
    throw new Error('Invalid credential');
  }
  return value;
}
function positiveNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid response');
  return value;
}

export class ConnectorFeishuFlow {
  constructor(
    private readonly config: ConnectorAuthConfig,
    private readonly store: ConnectorAuthStore,
    private readonly provider: Provider,
    private readonly http: FeishuHttp,
    private readonly diagnostics: ConnectorAuthDiagnostics = connectorAuthDiagnostics,
  ) {}

  private async interaction(request: Request, response: Response): Promise<Interaction> {
    const details: Interaction = await this.provider.interactionDetails(request, response);
    if (details.uid !== request.params.uid) throw new Error('Interaction mismatch');
    return details;
  }

  async showInteraction(request: Request, response: Response): Promise<void> {
    const details: Interaction = await this.interaction(request, response);
    if (details.prompt.name === 'login') {
      const expectedAccountId: string | undefined = details.prompt.reasons.includes('feishu_scopes_changed')
        ? details.session?.accountId : undefined;
      await this.startFeishu(details.uid, response, expectedAccountId); return;
    }
    if (details.prompt.name !== 'consent' || !details.session?.accountId) throw new Error('Unsupported interaction');
    const csrf: string = randomValue();
    await this.store.put('ConsentCSRF', csrf, {
      uid: details.uid, accountId: details.session.accountId, clientId: details.params.client_id,
    }, authNow() + 600);
    const requested: string[] = typeof details.params.scope === 'string' ? details.params.scope.split(' ') : [];
    const items: string[] = [];
    if (requested.includes('feishu.read')) items.push('读取你有权限访问的飞书信息。');
    if (requested.includes('feishu.write')) items.push('按你的请求创建或修改飞书内容，包括通过已开放工具发送消息。');
    if (requested.some((scope: string) => CONNECTOR_RESOURCE_SCOPES.includes(scope))) {
      items.push('允许 ChatGPT 在本次授权后持续连接最多 30 天。你可以随时断开连接并撤销授权；到期后需重新同意。');
    }
    const action: string = `${this.config.publicUrl}/interaction/${encodeURIComponent(details.uid)}/confirm`;
    // Fetch serializes Origin as null for a form POST under no-referrer. Keep strict
    // Origin validation while disclosing only the site's origin, never this page's path.
    response.set('Referrer-Policy', 'origin').type('html').send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1"><title>授权飞书 AI 连接器</title>
      <body><main><h1>允许 ChatGPT 使用你的飞书账号</h1><p>本次连接请求以下权限：</p>
      <ul>${items.map((item: string) => `<li>${html(item)}</li>`).join('')}</ul>
      <p>实际访问仍受你的飞书权限限制。你可以取消本次连接。</p>
      <form method="post" action="${html(action)}"><input type="hidden" name="csrf" value="${csrf}">
      <button name="decision" value="allow" type="submit">同意并连接</button>
      <button name="decision" value="deny" type="submit">取消</button></form></main></body></html>`);
  }

  private async startFeishu(uid: string, response: Response, expectedAccountId?: string): Promise<void> {
    const state: string = randomValue();
    const verifier: string = randomValue();
    const browserBinding: string = randomValue();
    await this.store.put('FeishuLoginState', state, {
      uid, verifier, browserDigest: digest(browserBinding),
      ...(expectedAccountId ? { expectedAccountId } : {}),
    }, authNow() + 600);
    const callbackUrl: string = `${this.config.publicUrl}/auth/feishu/callback`;
    response.cookie('connector_feishu_login', browserBinding, {
      httpOnly: true, secure: true, sameSite: 'lax', maxAge: 600000, path: new URL(callbackUrl).pathname,
    });
    const authorize: URL = new URL('https://accounts.feishu.cn/open-apis/authen/v1/authorize');
    authorize.search = new URLSearchParams({
      client_id: this.config.feishuAppId, response_type: 'code', redirect_uri: callbackUrl,
      scope: this.config.feishuScopes, state, code_challenge: digest(verifier), code_challenge_method: 'S256',
    }).toString();
    response.redirect(303, authorize.href);
  }

  async feishuCallback(request: Request, response: Response): Promise<void> {
    const started: number = performance.now();
    let stage: string = 'state';
    let ok: boolean = false;
    let providerOk: boolean | undefined;
    let providerCode: unknown;
    let accessTokenLength: number = 0;
    let refreshTokenLength: number = 0;
    try {
      const state: string = field(request.query.state);
      const saved: Record<string, unknown> | undefined = await this.store.get('FeishuLoginState', state);
      if (!saved || saved.consumed || typeof saved.browserDigest !== 'string' ||
        !equalDigest(cookieValue(request, 'connector_feishu_login'), saved.browserDigest)) throw new Error('Invalid state');
      const uid: string = field(saved.uid);
      const verifier: string = field(saved.verifier);
      if (!await this.store.consume('FeishuLoginState', state)) throw new Error('Replayed state');
      response.clearCookie('connector_feishu_login', {
        httpOnly: true, secure: true, sameSite: 'lax', path: new URL(`${this.config.publicUrl}/auth/feishu/callback`).pathname,
      });
      if (request.query.error) {
        stage = 'denied';
        await this.finishHandoff(uid, { denied: true }, response); ok = true; return;
      }
      stage = 'code';
      const code: string = field(request.query.code);
      stage = 'token_exchange';
      const tokenReply: FeishuHttpResponse = await this.http('https://accounts.feishu.cn/oauth/v3/token', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
          grant_type: 'authorization_code', client_id: this.config.feishuAppId, client_secret: this.config.feishuAppSecret,
          code, redirect_uri: `${this.config.publicUrl}/auth/feishu/callback`, code_verifier: verifier,
        }),
      });
      providerOk = tokenReply.ok;
      providerCode = authRecord(tokenReply.body) ? tokenReply.body.code : undefined;
      if (!tokenReply.ok || !authRecord(tokenReply.body) ||
        (tokenReply.body.code !== undefined && tokenReply.body.code !== 0)) throw new Error('Feishu authorization failed');
      const token: Record<string, unknown> = tokenReply.body;
      stage = 'token_fields';
      accessTokenLength = typeof token.access_token === 'string' ? token.access_token.length : 0;
      refreshTokenLength = typeof token.refresh_token === 'string' ? token.refresh_token.length : 0;
      const accessToken: string = credential(token.access_token);
      const accessExpiresAt: number = authNow() + positiveNumber(token.expires_in);
      const refreshToken: string | undefined = token.refresh_token === undefined ? undefined : credential(token.refresh_token);
      const refreshExpiresAt: number = refreshToken ? authNow() + positiveNumber(token.refresh_token_expires_in) : accessExpiresAt;
      stage = 'user_info';
      providerOk = undefined; providerCode = undefined;
      const userReply: FeishuHttpResponse = await this.http('https://open.feishu.cn/open-apis/authen/v1/user_info', {
        method: 'GET', headers: { Authorization: `Bearer ${accessToken}` },
      });
      providerOk = userReply.ok;
      providerCode = authRecord(userReply.body) ? userReply.body.code : undefined;
      if (!userReply.ok || !authRecord(userReply.body) || userReply.body.code !== 0 ||
        !authRecord(userReply.body.data)) throw new Error('Feishu identity unavailable');
      const user: Record<string, unknown> = userReply.body.data;
      stage = 'account_binding';
      const tenantKey: string = field(user.tenant_key);
      const openId: string = field(user.open_id);
      if (tenantKey.includes(':') || openId.includes(':')) throw new Error('Invalid account identity');
      const accountId: string = `${tenantKey}:${openId}`;
      if (saved.expectedAccountId !== undefined && saved.expectedAccountId !== accountId) {
        throw new Error('Incremental authorization account mismatch');
      }
      const account: Record<string, unknown> = {
        tenant_key: tenantKey, open_id: openId, name: typeof user.name === 'string' ? user.name : '',
        access_token: accessToken, access_expires_at: accessExpiresAt,
        ...(refreshToken ? { refresh_token: refreshToken } : {}), refresh_expires_at: refreshExpiresAt,
        scope: typeof token.scope === 'string' ? token.scope : '', updated_at: authNow(), revoked: false,
      };
      // Stage the newly issued credentials in encrypted storage. Account replacement happens
      // under the same lease used by upstream refresh, so an old refresh cannot overwrite it.
      stage = 'handoff';
      await this.finishHandoff(uid, { accountId, account, expiresAt: refreshExpiresAt }, response);
      stage = 'complete'; ok = true;
    } finally {
      this.diagnostics.callback(stage, ok, performance.now() - started, providerOk, providerCode,
        accessTokenLength, refreshTokenLength);
    }
  }

  private async finishHandoff(uid: string, outcome: Record<string, unknown>, response: Response): Promise<void> {
    const ticket: string = randomValue();
    await this.store.put('FeishuLoginResult', ticket, { uid, ...outcome }, authNow() + 120);
    response.redirect(303, `${this.config.publicUrl}/interaction/${encodeURIComponent(uid)}/finish?ticket=${ticket}`);
  }

  async finishLogin(request: Request, response: Response): Promise<void> {
    const details: Interaction = await this.interaction(request, response);
    if (details.prompt.name !== 'login') throw new Error('Invalid interaction');
    const ticket: string = field(request.query.ticket);
    const result: Record<string, unknown> | undefined = await this.store.get('FeishuLoginResult', ticket);
    if (!result || result.consumed || result.uid !== details.uid) throw new Error('Invalid handoff');
    if (result.denied === true) {
      if (!await this.store.consume('FeishuLoginResult', ticket)) throw new Error('Invalid handoff');
      await this.provider.interactionFinished(request, response, {
        error: 'access_denied', error_description: 'End-User declined Feishu authorization.',
      }, { mergeWithLastSubmission: false }); return;
    }
    const accountId: string = field(result.accountId);
    const leaseKey: string = `feishu-refresh:${accountId}`;
    const lease: string | undefined = await this.store.acquireLease(leaseKey, 90);
    if (!lease) {
      const retry: string = `${this.config.publicUrl}/interaction/${encodeURIComponent(details.uid)}/finish?ticket=${encodeURIComponent(ticket)}`;
      response.status(503).type('html').send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1"><title>请稍后继续</title>
        <body><main><h1>账号连接正在更新</h1><p>请稍候片刻，再继续完成这次授权。</p>
        <a href="${html(retry)}">继续授权</a></main></body></html>`);
      return;
    }
    try {
      const current: Record<string, unknown> | undefined = await this.store.get('FeishuLoginResult', ticket);
      if (!current || current.consumed || current.uid !== details.uid || current.accountId !== accountId ||
        !authRecord(current.account) || typeof current.expiresAt !== 'number' || current.expiresAt <= authNow() ||
        !await this.store.consume('FeishuLoginResult', ticket)) throw new Error('Invalid handoff');
      await this.store.put('FeishuAccount', accountId, current.account, current.expiresAt);
    } finally { await this.store.releaseLease(leaseKey, lease); }
    await this.provider.interactionFinished(request, response, {
      login: { accountId, amr: ['federated'] },
    }, { mergeWithLastSubmission: false });
  }

  async confirmConsent(request: Request, response: Response): Promise<void> {
    if (request.headers.origin !== new URL(this.config.publicUrl).origin) throw new Error('Origin mismatch');
    const details: Interaction = await this.interaction(request, response);
    if (details.prompt.name !== 'consent' || !details.session?.accountId || !authRecord(request.body)) {
      throw new Error('Invalid consent');
    }
    const csrf: string = field(request.body.csrf);
    const saved: Record<string, unknown> | undefined = await this.store.get('ConsentCSRF', csrf);
    if (!saved || saved.consumed || saved.uid !== details.uid || saved.accountId !== details.session.accountId ||
      saved.clientId !== details.params.client_id || !await this.store.consume('ConsentCSRF', csrf)) {
      throw new Error('Invalid consent state');
    }
    if (request.body.decision === 'deny') {
      await this.provider.interactionFinished(request, response, {
        error: 'access_denied', error_description: 'End-User declined the requested access.',
      }, { mergeWithLastSubmission: false }); return;
    }
    if (request.body.decision !== 'allow') throw new Error('Invalid decision');
    const clientId: string = field(details.params.client_id);
    let grant: Grant | undefined = details.grantId ? await this.provider.Grant.find(details.grantId) : undefined;
    if (grant && (grant.accountId !== details.session.accountId || grant.clientId !== clientId)) {
      throw new Error('Grant mismatch');
    }
    if (!grant) grant = new this.provider.Grant({ accountId: details.session.accountId, clientId });
    const missing: Record<string, unknown> = details.prompt.details;
    const oidcScopes: string[] = authStrings(missing.missingOIDCScope);
    if (oidcScopes.length) grant.addOIDCScope(oidcScopes.join(' '));
    const claims: string[] = authStrings(missing.missingOIDCClaims);
    if (claims.length) grant.addOIDCClaims(claims);
    if (authRecord(missing.missingResourceScopes)) {
      for (const [resource, scopes] of Object.entries(missing.missingResourceScopes)) {
        if (resource !== this.config.resource) throw new Error('Unknown resource');
        const requested: string[] = authStrings(scopes);
        if (requested.some((scope: string) => !['feishu.read', 'feishu.write'].includes(scope))) {
          throw new Error('Invalid scope');
        }
        grant.addResourceScope(resource, requested.join(' '));
      }
    }
    const grantId: string = await grant.save();
    const scopes: string[] = grant.getResourceScope(this.config.resource).split(' ').filter(Boolean);
    if (scopes.length) {
      const savedGrant: Record<string, unknown> | undefined = await this.store.get('Grant', grantId);
      if (!savedGrant || typeof savedGrant.exp !== 'number') throw new Error('Invalid grant');
      const expiresAt: number = Math.min(savedGrant.exp, authNow() + CONNECTOR_CONNECTION_TTL);
      await this.store.put('Consent', grantId, {
        grantId, accountId: details.session.accountId, clientId, resource: this.config.resource,
        scopes, consentedAt: authNow(), expiresAt,
      }, expiresAt, undefined, grantId);
    }
    await this.provider.interactionFinished(request, response, { consent: { grantId } }, {
      mergeWithLastSubmission: true,
    });
  }
}
