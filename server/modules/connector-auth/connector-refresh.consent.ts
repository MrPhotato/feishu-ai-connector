import { authNow, authRecord, authStrings } from './connector-auth.types';
import type { ConnectorAuthStore } from './connector-auth.types';

export const CONNECTOR_CONNECTION_TTL: number = 30 * 86400;
export const CONNECTOR_RESOURCE_SCOPES: readonly string[] = ['feishu.read', 'feishu.write'];

/** Separate explicit persistence consent from OIDC identity scopes and resource permissions. */
export async function connectorRefreshConsent(
  store: ConnectorAuthStore, resource: string, grantId: string | undefined,
  accountId: string | undefined, clientId: string, scopes: Set<string>,
): Promise<boolean> {
  if (!grantId || !accountId) return false;
  const reads: PromiseSettledResult<Record<string, unknown> | undefined>[] = await Promise.allSettled([
    store.get('Consent', grantId), store.get('Grant', grantId),
  ]);
  if (reads[0].status !== 'fulfilled' || reads[1].status !== 'fulfilled') return false;
  const consent: Record<string, unknown> | undefined = reads[0].value;
  const grant: Record<string, unknown> | undefined = reads[1].value;
  if (!consent || !grant || consent.grantId !== grantId || consent.accountId !== accountId ||
    consent.clientId !== clientId || consent.resource !== resource || grant.accountId !== accountId ||
    grant.clientId !== clientId || typeof consent.expiresAt !== 'number' || consent.expiresAt <= authNow() ||
    typeof grant.exp !== 'number' || grant.exp <= authNow() || !authRecord(grant.resources)) return false;
  const granted: unknown = grant.resources[resource];
  const approved: string[] = authStrings(consent.scopes);
  const requested: string[] = [...scopes].filter((scope: string) => CONNECTOR_RESOURCE_SCOPES.includes(scope));
  return typeof granted === 'string' && requested.length > 0 && approved.length > 0 &&
    approved.every((scope: string) => CONNECTOR_RESOURCE_SCOPES.includes(scope) && granted.split(' ').includes(scope)) &&
    requested.every((scope: string) => approved.includes(scope));
}
