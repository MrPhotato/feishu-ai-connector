import { authNow } from './connector-auth.types';

export function connectorFeishuAccountMatches(
  account: Record<string, unknown> | undefined, accountId: string,
): account is Record<string, unknown> {
  return Boolean(account && account.revoked !== true && typeof account.tenant_key === 'string' &&
    typeof account.open_id === 'string' && `${account.tenant_key}:${account.open_id}` === accountId &&
    typeof account.access_token === 'string' && account.access_token);
}

/** Only used during a new browser authorization, never as an MCP-wide permission requirement. */
export function connectorFeishuPermissionsComplete(account: Record<string, unknown>, requested: string): boolean {
  const granted: Set<string> = new Set(typeof account.scope === 'string'
    ? account.scope.split(/[\s,]+/u).filter(Boolean) : []);
  return requested.split(/\s+/u).filter(Boolean).every((scope: string): boolean => {
    if (scope !== 'offline_access') return granted.has(scope);
    // Feishu only issues refresh credentials for offline_access. Do not infer business
    // permissions from this credential, or require its name to be echoed in access-token scope.
    return typeof account.refresh_token === 'string' && Boolean(account.refresh_token) &&
      typeof account.refresh_expires_at === 'number' && Number.isSafeInteger(account.refresh_expires_at) &&
      account.refresh_expires_at > authNow() + 30 && account.refresh_pending !== true;
  });
}
