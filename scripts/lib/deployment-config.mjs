import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const fields = ['miaodaAppId', 'publicUrl', 'feishuAppId', 'defaultTimezone', 'displayName', 'author'];
const privateKeyNames = ['CONNECTOR_STORAGE_API_KEY', 'CONNECTOR_STORAGE_ENCRYPTION_KEY',
  'CONNECTOR_SIGNING_JWKS', 'CONNECTOR_COOKIE_KEYS', 'FEISHU_APP_SECRET'];

function invalid(message) { throw new Error(`Deployment configuration ${message}.`); }

export function validateDeploymentConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))) {
    invalid('must contain only the six documented non-secret fields');
  }
  for (const field of fields) {
    if (typeof value[field] !== 'string' || !value[field] || value[field] !== value[field].trim()
      || /[\u0000-\u001f\u007f]/u.test(value[field])) invalid(`has an invalid ${field}`);
  }
  if (!/^app_[a-z0-9]{5,64}$/u.test(value.miaodaAppId)) invalid('has an invalid miaodaAppId');
  if (!/^cli_[A-Za-z0-9]{8,64}$/u.test(value.feishuAppId)) invalid('has an invalid feishuAppId');
  if (value.displayName.length > 100 || value.author.length > 100) invalid('has an overlong display name or author');
  let publicUrl;
  try { publicUrl = new URL(value.publicUrl); } catch { invalid('has an invalid publicUrl'); }
  const canonical = value.publicUrl.replace(/\/$/u, '');
  if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password || publicUrl.search
    || publicUrl.hash || publicUrl.port || publicUrl.href.replace(/\/$/u, '') !== canonical
    || publicUrl.pathname.replace(/\/$/u, '') !== `/app/${value.miaodaAppId}`
    || isIP(publicUrl.hostname) || !publicUrl.hostname.includes('.') || publicUrl.hostname.endsWith('.')
    || /(?:^|\.)(?:localhost|local|internal)$/iu.test(publicUrl.hostname)) {
    invalid('requires a canonical HTTPS publicUrl with the matching /app/<miaodaAppId> path');
  }
  try {
    if (value.defaultTimezone.length > 80
      || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/u.test(value.defaultTimezone)) throw new Error();
    new Intl.DateTimeFormat('en', { timeZone: value.defaultTimezone }).format(0);
  } catch { invalid('has an invalid defaultTimezone'); }
  return Object.freeze({ ...value, publicUrl: canonical });
}

export function loadDeploymentConfig({ env = process.env, file } = {}) {
  const configured = file ?? env.CONNECTOR_DEPLOYMENT_FILE;
  if (configured !== undefined && (typeof configured !== 'string' || !configured.trim()
    || configured.includes('\0'))) invalid('has an invalid profile path');
  const filename = configured === undefined
    ? resolve(repositoryRoot, 'deployment/instance.local.json') : resolve(configured);
  let content;
  try {
    if (!statSync(filename).isFile() || statSync(filename).size > 16384) invalid('profile is not a small JSON file');
    content = readFileSync(filename, 'utf8');
  } catch {
    invalid('is unavailable; create deployment/instance.local.json from instance.example.json or set CONNECTOR_DEPLOYMENT_FILE');
  }
  let value;
  try { value = JSON.parse(content); } catch { invalid('profile must be valid JSON'); }
  return validateDeploymentConfig(value);
}

export function assertDeploymentEnvironment(config, env = process.env) {
  if (env.CONNECTOR_PUBLIC_URL !== undefined
    && env.CONNECTOR_PUBLIC_URL.replace(/\/$/u, '') !== config.publicUrl) {
    invalid('does not match the provided CONNECTOR_PUBLIC_URL');
  }
}

// Check before the first mutation; never combine a new public identity with old secrets.
export function assertCompatibleCloudIdentity(items, config) {
  if (!Array.isArray(items) || items.some(item => !item || typeof item.key !== 'string')) {
    invalid('cannot verify the existing cloud identity');
  }
  const existing = new Map(items.map(item => [item.key, item.value]));
  if (existing.size !== items.length) invalid('contains duplicate cloud keys');
  const desired = { CONNECTOR_PUBLIC_URL: config.publicUrl, FEISHU_APP_ID: config.feishuAppId };
  for (const [key, value] of Object.entries(desired)) {
    if (existing.has(key) && existing.get(key) !== value) invalid(`does not match existing cloud ${key}`);
  }
  let cloudProfile;
  if (existing.has('CONNECTOR_DEPLOYMENT_CONFIG')) {
    try { cloudProfile = validateDeploymentConfig(JSON.parse(existing.get('CONNECTOR_DEPLOYMENT_CONFIG'))); }
    catch { invalid('cannot verify the existing cloud deployment JSON'); }
    if (['miaodaAppId', 'publicUrl', 'feishuAppId'].some(key => cloudProfile[key] !== config[key])) {
      invalid('does not match the existing cloud deployment identity');
    }
  }
  if (privateKeyNames.some(key => existing.has(key)) && !cloudProfile
    && (!existing.has('CONNECTOR_PUBLIC_URL') || !existing.has('FEISHU_APP_ID'))) {
    invalid('cannot verify an existing secret-bearing cloud identity; review it before setup');
  }
}

export function assertDeploymentUrl(config, input, { discovery = false } = {}) {
  let url;
  try { url = new URL(input instanceof Request ? input.url : input); } catch { invalid('request URL is invalid'); }
  const base = new URL(config.publicUrl);
  const withinApp = url.pathname === base.pathname || url.pathname.startsWith(`${base.pathname}/`);
  const discoveryPaths = ['oauth-authorization-server', 'openid-configuration', 'oauth-protected-resource']
    .flatMap(kind => [`/.well-known/${kind}`, `/.well-known/${kind}${base.pathname}/oidc`,
      `/.well-known/${kind}${base.pathname}/mcp`]);
  if (url.origin !== base.origin || url.username || url.password || url.hash
    || /%(?:2f|5c|2e)/iu.test(url.pathname)
    || (!withinApp && (!discovery || !discoveryPaths.includes(url.pathname)))) {
    invalid('request must stay within the configured application');
  }
  return url;
}

export async function deploymentFetch(config, input, init = {}, options = {}) {
  const url = assertDeploymentUrl(config, input, options);
  if (init.redirect !== undefined && !['error', 'manual'].includes(init.redirect)) {
    invalid('requests must not follow redirects');
  }
  if (!url.pathname.startsWith(new URL(config.publicUrl).pathname)) {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    if ((init.method ?? (input instanceof Request ? input.method : 'GET')) !== 'GET'
      || headers.has('authorization') || headers.has('cookie')) invalid('discovery outside the app must be an unauthenticated GET');
  }
  return fetch(input, { ...init, redirect: init.redirect ?? 'error',
    signal: init.signal ?? AbortSignal.timeout(25000) });
}
