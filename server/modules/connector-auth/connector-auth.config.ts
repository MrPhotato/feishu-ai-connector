import { ServiceUnavailableException } from '@nestjs/common';
import type { JWK } from 'jose';
import { authRecord, authStrings } from './connector-auth.types';
import type { ConnectorAuthConfig } from './connector-auth.types';
import { connectorFeishuAppId, connectorPublicUrl } from '../../config/connector-deployment.config';

export const CONNECTOR_CHATGPT_CALLBACK: string = 'https://chatgpt.com/connector_platform_oauth_redirect';
export { connectorPublicUrl };

export function loadConnectorAuthConfig(env: NodeJS.ProcessEnv = process.env): ConnectorAuthConfig {
  try {
    const publicUrl: string = connectorPublicUrl(env);
    const feishuAppId: string = connectorFeishuAppId(env);
    const signing: unknown = JSON.parse(env.CONNECTOR_SIGNING_JWKS || 'null');
    const cookieKeys: string[] = authStrings(JSON.parse(env.CONNECTOR_COOKIE_KEYS || 'null'));
    const secret: string = env.FEISHU_APP_SECRET || '';
    const scopes: string = (env.CONNECTOR_FEISHU_SCOPES || '').trim();
    if (!authRecord(signing) || !Array.isArray(signing.keys) || !signing.keys.length ||
      !cookieKeys.length || cookieKeys.some((key: string) => key.length < 32) || !secret || !scopes) {
      throw new Error('Missing configuration');
    }
    const keys: JWK[] = signing.keys.map((key: unknown): JWK => {
      if (!authRecord(key) || key.kty !== 'RSA' || typeof key.d !== 'string' ||
        typeof key.n !== 'string' || typeof key.e !== 'string' || typeof key.kid !== 'string' ||
        !key.kid || (key.alg !== undefined && key.alg !== 'RS256')) throw new Error('Invalid key');
      return { ...key, use: 'sig', alg: 'RS256' };
    });
    return {
      publicUrl, issuer: `${publicUrl}/oidc`, resource: `${publicUrl}/mcp`, signingJwks: { keys }, cookieKeys,
      feishuAppId, feishuAppSecret: secret, feishuScopes: scopes,
    };
  } catch {
    throw new ServiceUnavailableException('连接服务尚未完成配置。');
  }
}
