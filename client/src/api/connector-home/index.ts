import { resolveAppUrl } from '@lark-apaas/client-toolkit/utils/resolveAppUrl';
import type { ConnectorStatus } from '@shared/api.interface';

/** Public protocol endpoint: no account information or platform /api mutation. */
export async function getStatus(signal?: AbortSignal): Promise<ConnectorStatus> {
  const response: Response = await fetch(resolveAppUrl('/connector/status'), {
    method: 'GET', credentials: 'same-origin', cache: 'no-store', signal,
  });
  if (!response.ok) throw new Error('暂时无法获取服务状态，请稍后重试。');
  const value: unknown = await response.json();
  if (typeof value !== 'object' || value === null || !('configured' in value) ||
    typeof value.configured !== 'boolean' || !('mcpUrl' in value) || typeof value.mcpUrl !== 'string' ||
    !('oauthClientId' in value) || value.oauthClientId !== 'chatgpt' ||
    !('message' in value) || typeof value.message !== 'string') {
    throw new Error('服务状态暂不可用，请稍后重试。');
  }
  return { configured: value.configured, mcpUrl: value.mcpUrl, oauthClientId: value.oauthClientId,
    message: value.message };
}
