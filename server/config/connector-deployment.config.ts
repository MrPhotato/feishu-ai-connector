import { ServiceUnavailableException } from '@nestjs/common';
import { isIP } from 'node:net';

interface DeploymentOverrides {
  publicUrl?: string;
  feishuAppId?: string;
  defaultTimezone?: string;
}

/** The cloud JSON contains non-secret deployment settings; credentials remain separate env values. */
function deploymentOverrides(env: NodeJS.ProcessEnv): DeploymentOverrides {
  if (env.CONNECTOR_DEPLOYMENT_CONFIG === undefined) return {};
  try {
    const encoded: string = env.CONNECTOR_DEPLOYMENT_CONFIG;
    if (encoded.length > 8192) throw new Error('Invalid deployment configuration');
    const value: unknown = JSON.parse(encoded);
    const keys: string[] = ['miaodaAppId', 'publicUrl', 'feishuAppId', 'defaultTimezone', 'displayName', 'author'];
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid configuration');
    const record: Record<string, unknown> = value as Record<string, unknown>;
    if (Object.keys(record).length !== keys.length ||
      keys.some((key: string) => typeof record[key] !== 'string' || !record[key] ||
        String(record[key]).trim() !== record[key] || /[\u0000-\u001f\u007f]/u.test(String(record[key]))) ||
      Object.keys(record).some((key: string) => !keys.includes(key))) throw new Error('Invalid configuration');
    // Narrow these public values only after the complete allowlist/type checks above.
    const miaodaAppId: string = String(record.miaodaAppId);
    const publicUrl: string = validatePublicUrl(String(record.publicUrl));
    const feishuAppId: string = validateAppId(String(record.feishuAppId));
    const defaultTimezone: string = validateTimezone(String(record.defaultTimezone));
    if (!/^app_[a-z0-9]{5,64}$/u.test(miaodaAppId) || !/^cli_[A-Za-z0-9]{8,64}$/u.test(feishuAppId) ||
      new URL(publicUrl).pathname !== `/app/${miaodaAppId}` || new URL(publicUrl).port ||
      [record.displayName, record.author].some((item: unknown) =>
        String(item).length > 100)) {
      throw new Error('Invalid configuration');
    }
    return { publicUrl, feishuAppId, defaultTimezone };
  } catch {
    throw new ServiceUnavailableException('部署配置无效。');
  }
}

/** Deployment-admin configuration only. Never infer this address from a request or Host header. */
export function connectorPublicUrl(env: NodeJS.ProcessEnv = process.env): string {
  return validatePublicUrl(deploymentOverrides(env).publicUrl ?? env.CONNECTOR_PUBLIC_URL ?? '');
}

function validatePublicUrl(value: string): string {
  try {
    if (!value || value.length > 2048 ||
      !/^https:\/\/[a-zA-Z0-9.-]+(?::[0-9]+)?(?:\/[a-zA-Z0-9_-]+)*\/?$/u.test(value)) {
      throw new Error('Invalid deployment URL');
    }
    const publicUrl: string = value.replace(/\/$/u, '');
    const parsed: URL = new URL(publicUrl);
    if (parsed.protocol !== 'https:' || parsed.search || parsed.hash || parsed.username || parsed.password ||
      !parsed.hostname.includes('.') || parsed.hostname.endsWith('.') || isIP(parsed.hostname) ||
      /(?:^|\.)(?:localhost|local|internal)$/iu.test(parsed.hostname) ||
      `${parsed.origin}${parsed.pathname === '/' ? '' : parsed.pathname}` !== publicUrl) {
      throw new Error('Invalid deployment URL');
    }
    return publicUrl;
  } catch {
    throw new ServiceUnavailableException('连接服务地址尚未配置或配置无效。');
  }
}

export function connectorFeishuAppId(env: NodeJS.ProcessEnv = process.env): string {
  return validateAppId(deploymentOverrides(env).feishuAppId ?? env.FEISHU_APP_ID ?? '');
}

function validateAppId(appId: string): string {
  if (!/^cli_[a-zA-Z0-9]+$/u.test(appId)) {
    throw new ServiceUnavailableException('飞书应用身份尚未配置或配置无效。');
  }
  return appId;
}

export function connectorDefaultTimezone(env: NodeJS.ProcessEnv = process.env): string {
  return validateTimezone(deploymentOverrides(env).defaultTimezone ?? env.CONNECTOR_DEFAULT_TIMEZONE ?? 'UTC');
}

function validateTimezone(timezone: string): string {
  try {
    // Go's CLI TZ uses zoneinfo names; Intl also accepts numeric offsets that Go would treat as UTC.
    if (!timezone || timezone.length > 80 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/u.test(timezone)) {
      throw new Error('Invalid timezone');
    }
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format(0);
    return timezone;
  } catch {
    throw new ServiceUnavailableException('默认时区配置无效。');
  }
}
