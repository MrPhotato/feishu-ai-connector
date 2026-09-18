import { Logger } from '@nestjs/common';

type DiagnosticWriter = (message: string) => void;
const logger: Logger = new Logger('ConnectorAuthDiagnostics');
const operations: readonly string[] = ['get', 'put', 'consume', 'remove', 'revokeGrant', 'findUid',
  'acquireLease', 'releaseLease'];
const models: readonly string[] = ['AccessToken', 'AuthorizationCode', 'ClientCredentials', 'DeviceCode',
  'Grant', 'IdToken', 'Interaction', 'RefreshToken', 'Session', 'ReplayDetection',
  'PushedAuthorizationRequest', 'BackchannelAuthenticationRequest', 'FeishuAccount', 'FeishuState',
  'Consent', 'FeishuLoginState', 'FeishuLoginResult', 'ConsentCSRF', 'FeishuAction'];
const callbackStages: readonly string[] = ['state', 'code', 'token_exchange', 'token_fields',
  'user_info', 'account_binding', 'handoff', 'denied', 'complete'];

function milliseconds(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

/** Only fixed enums, counts and timings enter these records. Never accept an arbitrary log payload. */
export class ConnectorAuthDiagnostics {
  constructor(private readonly write: DiagnosticWriter = (message: string): void => logger.log(message)) {}

  private emit(value: Record<string, string | number | boolean>): void {
    // Diagnostics must not change whether an authorization succeeds.
    try { this.write(JSON.stringify(value)); } catch { /* No fallback logger receives sensitive context. */ }
  }

  token(grantType: unknown, status: number, durationMs: number, expiresIn: unknown): void {
    const grant: string = grantType === 'authorization_code' || grantType === 'refresh_token' ? grantType : 'other';
    const expiry: number = typeof expiresIn === 'number' && Number.isSafeInteger(expiresIn) &&
      expiresIn > 0 && expiresIn <= 30 * 86400 ? expiresIn : 0;
    this.emit({ event: 'connector_oauth_token', grantType: grant,
      status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0,
      durationMs: milliseconds(durationMs), expiresIn: expiry });
  }

  authorization(ok: boolean, durationMs: number, signatureMs: number, storageMs: number): void {
    this.emit({ event: 'connector_mcp_authorization', ok, durationMs: milliseconds(durationMs),
      signatureMs: milliseconds(signatureMs), storageMs: milliseconds(storageMs) });
  }

  callback(stage: unknown, ok: boolean, durationMs: number, providerOk: unknown, providerCode: unknown,
    accessTokenLength: number, refreshTokenLength: number): void {
    const length: (value: number) => number = (value: number): number =>
      Number.isSafeInteger(value) && value >= 0 && value <= 262144 ? value : 0;
    const value: Record<string, string | number | boolean> = { event: 'connector_feishu_callback',
      stage: typeof stage === 'string' && callbackStages.includes(stage) ? stage : 'other',
      ok, durationMs: milliseconds(durationMs), accessTokenLength: length(accessTokenLength),
      refreshTokenLength: length(refreshTokenLength) };
    if (typeof providerOk === 'boolean') value.providerOk = providerOk;
    if (typeof providerCode === 'number' && Number.isSafeInteger(providerCode) &&
      providerCode >= 0 && providerCode <= 2147483647) value.providerCode = providerCode;
    this.emit(value);
  }

  storage(operation: unknown, model: unknown, ok: boolean, durationMs: number): void {
    this.emit({ event: 'connector_auth_storage', operation: typeof operation === 'string' &&
      operations.includes(operation) ? operation : 'other', model: typeof model === 'string' &&
      models.includes(model) ? model : 'none', ok, durationMs: milliseconds(durationMs) });
  }
}

export const connectorAuthDiagnostics: ConnectorAuthDiagnostics = new ConnectorAuthDiagnostics();
