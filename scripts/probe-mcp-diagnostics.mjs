import 'reflect-metadata';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { from } from 'rxjs';
import ts from 'typescript';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Exercise the source controller, real MCP transport and installed privacy/logging paths.
// Only synthetic authentication/executors and a fake CLI availability probe are injected.
// No environment file, real token, CLI process or external network request is used.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireDependency = createRequire(import.meta.url);
const { Logger, ServiceUnavailableException } = requireDependency('@nestjs/common');
const { LoggerModule } = requireDependency('@lark-apaas/nestjs-logger');
const cache = new Map();
let available = true;
let probeFails = false;
function loadTs(file) {
  const absolute = path.resolve(file);
  if (cache.has(absolute)) return cache.get(absolute).exports;
  const loaded = { exports: {} };
  cache.set(absolute, loaded);
  const compiled = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      esModuleInterop: true, experimentalDecorators: true }, fileName: absolute,
  }).outputText;
  const localRequire = (specifier) => {
    if (specifier === './feishu-cli.runner') return { probeFeishuCli: async () => {
      if (probeFails) throw new Error(marker);
      return { available };
    } };
    return specifier.startsWith('.')
      ? loadTs(path.resolve(path.dirname(absolute), `${specifier}.ts`)) : requireDependency(specifier);
  };
  new Function('require', 'module', 'exports', compiled)(localRequire, loaded, loaded.exports);
  return loaded.exports;
}
const { FeishuToolsController } = loadTs(path.join(root, 'server/modules/feishu-tools/feishu-tools.controller.ts'));
const { connectorPrivacyMiddleware } = loadTs(path.join(root,
  'server/modules/connector-privacy/connector-privacy.middleware.ts'));
const marker = `synthetic-sensitive-${randomBytes(12).toString('hex')}`;
const otherMarker = `${marker}-other`;
const modernVersion = '2026-07-28';
const records = [];
const platformLogs = [];
const authenticated = [];
const executed = [];
const originalLog = Logger.prototype.log;
const originalFlag = process.env.CONNECTOR_NATIVE_CLI_ENABLED;
Logger.prototype.log = function (message) { records.push(JSON.parse(message)); };
const LoggingInterceptor = Reflect.getMetadata('providers', LoggerModule)
  .find((provider) => typeof provider === 'function' && provider.name === 'LoggingInterceptor');
const interceptor = new LoggingInterceptor(
  { logStructured: (...args) => platformLogs.push(args) },
  { setContext: () => {}, getContext: () => ({}) },
  { log: (...args) => platformLogs.push(args), error: (...args) => platformLogs.push(args) },
  { logRequestBody: true, logResponseBody: true, maxBodyLength: null },
);
let authMode = 'valid';
let executorFails = false;
let downloadMode = 'valid';
const controller = new FeishuToolsController({
  getPublicUrl: () => 'https://example.invalid/app/test',
  verifyMcpAuthorization: async (token) => {
    authenticated.push(token);
    if (authMode === 'invalid') throw new Error(marker);
    if (authMode === 'unavailable') throw new ServiceUnavailableException(marker);
    await new Promise((resolve) => setTimeout(resolve, 15));
    return { principal: { accountId: token, scopes: ['feishu.read', 'feishu.write'] },
      account: { access_token: token } };
  },
}, {
  downloadFile: async (ticket) => {
    assert.equal(ticket, marker);
    if (downloadMode === 'failure') throw new Error(marker);
    if (downloadMode === 'expired') return undefined;
    return { name: '测试附件.txt', mimeType: 'text/plain', bytes: Buffer.from(marker) };
  },
  forRequest: (accountId, account) => {
    if (executorFails) throw new Error(marker);
    assert.equal(account.access_token, accountId);
    const execute = async (principal) => {
      assert.equal(principal.accountId, accountId);
      executed.push(accountId);
      return { ok: true, data: accountId };
    };
    return { catalog: () => ({ operations: [] }), execute,
      executeTask: execute, executeNative: execute };
  },
});
const app = express();
app.use(express.json());
app.all('*', connectorPrivacyMiddleware);
app.get('/mcp/files/download', (req, res) => {
  const context = { getType: () => 'http', switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) };
  interceptor.intercept(context, { handle: () => from(controller.download(req, res)) })
    .subscribe({ error: () => { if (!res.headersSent) res.status(500).end(); } });
});
app.all('/mcp', (req, res) => {
  const context = { getType: () => 'http', switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) };
  interceptor.intercept(context, { handle: () => from(req.method === 'POST'
    ? controller.execute(req, res) : controller.unsupported(req, res)) })
    .subscribe({ error: () => { if (!res.headersSent) res.status(500).end(); } });
});
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let step = 'setup';
function modernParams(params = {}, version = modernVersion) {
  return { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': version,
    'io.modelcontextprotocol/clientInfo': { name: marker, version: '1.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {} } };
}
function modernHeaders(method, params = {}, version = modernVersion) {
  return { 'MCP-Protocol-Version': version, 'Mcp-Method': method,
    ...(typeof params.name === 'string' ? { 'Mcp-Name': params.name } : {}) };
}
async function request(method, params, { httpMethod = 'POST', authorization = true, notification = false,
  headers = {}, token = marker } = {}) {
  const before = records.length;
  const response = await fetch(`${base}/mcp?private=${marker}`, {
    method: httpMethod,
    headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json',
      Cookie: `private=${marker}`, ...(authorization ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    ...(httpMethod === 'POST' ? { body: JSON.stringify({ jsonrpc: '2.0',
      ...(notification ? {} : { id: marker }), method, params }) } : {}),
  });
  const text = await response.text();
  // HTTP finish and controller finally can be delivered in either order.
  for (let retry = 0; records.length === before && retry < 20; retry += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(records.length, before + 1, 'One diagnostic per request');
  const record = records.at(-1);
  assert.deepEqual(Object.keys(record).sort(),
    ['event', 'method', 'nativeEnabled', 'toolCount', 'statusCode', 'durationMs', 'failureStage'].sort());
  assert.equal(record.event, 'connector_mcp_request');
  assert.equal(record.statusCode, response.status);
  assert.ok(Number.isInteger(record.durationMs) && record.durationMs >= 0);
  if (text) assert.ok(response.headers.get('content-type')?.includes('application/json'), 'MCP never switches to SSE');
  return { response, text, record };
}
try {
  step = 'file_download_privacy';
  for (const [mode, status] of [['valid', 200], ['expired', 410], ['failure', 503]]) {
    downloadMode = mode;
    const response = await fetch(`${base}/mcp/files/download?ticket=${marker}`);
    assert.equal(response.status, status);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const body = await response.text();
    assert.equal(body.includes(marker), mode === 'valid');
    if (mode === 'valid') assert.ok(response.headers.get('content-disposition').startsWith('attachment;'));
  }
  process.env.CONNECTOR_NATIVE_CLI_ENABLED = 'true';
  step = 'modern_without_initialize';
  let result = await request('tools/list', modernParams(), { headers: modernHeaders('tools/list') });
  assert.equal(result.response.status, 200);
  assert.equal(JSON.parse(result.text).result.tools.length, 18);
  step = 'modern_discover';
  result = await request('server/discover', modernParams(), { headers: modernHeaders('server/discover') });
  assert.equal(result.response.status, 200);
  assert.ok(JSON.parse(result.text).result.capabilities.tools);
  assert.equal(result.record.method, 'server_discover');
  step = 'modern_call';
  const call = { name: 'feishu_find_people', arguments: { query: marker } };
  result = await request('tools/call', modernParams(call), { headers: modernHeaders('tools/call', call) });
  assert.equal(result.response.status, 200);
  assert.equal(JSON.parse(result.text).result.structuredContent.data, marker);
  step = 'modern_identity_isolation';
  const authBefore = authenticated.length;
  for (const token of [otherMarker, marker, otherMarker]) {
    result = await request('tools/call', modernParams(call), { headers: modernHeaders('tools/call', call), token });
    assert.equal(JSON.parse(result.text).result.structuredContent.data, token);
  }
  assert.deepEqual(authenticated.slice(authBefore), [otherMarker, marker, otherMarker]);
  assert.deepEqual(executed.slice(-3), [otherMarker, marker, otherMarker]);
  step = 'modern_concurrent_identity_isolation';
  await Promise.all([marker, otherMarker].map(async (token) => {
    const response = await fetch(`${base}/mcp`, { method: 'POST',
      headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`, ...modernHeaders('tools/call', call) },
      body: JSON.stringify({ jsonrpc: '2.0', id: token, method: 'tools/call', params: modernParams(call) }),
    });
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-type')?.includes('application/json'));
    assert.equal((await response.json()).result.structuredContent.data, token);
  }));
  step = 'modern_invalid_protocol';
  const executedBefore = executed.length;
  for (const [params, headers, code] of [
    [modernParams(call, '2099-01-01'), modernHeaders('tools/call', call, '2099-01-01'), -32022],
    [modernParams(call), modernHeaders('tools/call', call, '2025-11-25'), -32020],
    [call, modernHeaders('tools/call', call), -32602],
    [{ ...call, _meta: { 'io.modelcontextprotocol/protocolVersion': 20260728 } }, modernHeaders('tools/call', call), -32602],
  ]) {
    result = await request('tools/call', params, { headers });
    assert.equal(result.response.status, 400);
    assert.equal(JSON.parse(result.text).error.code, code);
  }
  assert.equal(executed.length, executedBefore, 'Modern validation failures never execute or fall back');
  step = 'modern_json_only';
  result = await request('subscriptions/listen', modernParams({ notifications: {} }), {
    headers: modernHeaders('subscriptions/listen'),
  });
  assert.ok(JSON.parse(result.text).error, 'Streaming subscriptions are unavailable on this JSON-only platform');
  step = 'modern_authentication';
  result = await request('tools/list', modernParams(), { headers: modernHeaders('tools/list'), authorization: false });
  assert.equal(result.response.status, 401);
  authMode = 'invalid';
  result = await request('tools/list', modernParams(), { headers: modernHeaders('tools/list') });
  assert.equal(result.response.status, 401);
  authMode = 'unavailable';
  result = await request('tools/list', modernParams(), { headers: modernHeaders('tools/list') });
  assert.equal(result.response.status, 503);
  authMode = 'valid';
  step = 'initialize';
  result = await request('initialize', { protocolVersion: '2025-03-26', capabilities: {},
    clientInfo: { name: marker, version: '1.0.0' } });
  assert.equal(result.record.method, 'initialize');
  assert.equal(result.response.status, 200);
  assert.ok(result.record.durationMs >= 10, 'Includes awaited authentication time');
  step = 'tools_list';
  result = await request('tools/list', {});
  assert.equal(JSON.parse(result.text).result.tools.length, 18);
  assert.equal(result.record.nativeEnabled, true);
  assert.equal(result.record.toolCount, 18);
  assert.equal(result.record.method, 'tools_list');
  assert.equal(result.record.failureStage, 'none');
  step = 'notification';
  result = await request('notifications/initialized', {}, { notification: true });
  assert.equal(result.record.method, 'notifications_initialized');
  assert.equal(result.response.status, 202);
  step = 'legacy_sdk';
  const legacy = new LegacyClient({ name: marker, version: '1.0.0' });
  try {
    await legacy.connect(new LegacyTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${marker}` } },
      fetch: async (url, init) => {
        const response = await fetch(url, init);
        if (response.status === 200) assert.ok(response.headers.get('content-type')?.includes('application/json'));
        return response;
      },
    }));
    assert.equal((await legacy.listTools()).tools.length, 18);
    assert.equal((await legacy.callTool(call)).structuredContent.data, marker);
  } finally { await legacy.close(); }
  step = 'tool_result_privacy';
  result = await request('tools/call', { name: 'feishu_find_people', arguments: { query: marker } });
  assert.equal(result.record.method, 'tools_call');
  assert.ok(result.text.includes(marker), 'Synthetic result delivered to caller');
  step = 'unknown_method_privacy';
  result = await request(marker, { private: marker });
  assert.equal(result.record.method, 'other');
  step = 'disabled';
  process.env.CONNECTOR_NATIVE_CLI_ENABLED = 'false';
  result = await request('tools/list', {});
  assert.equal(JSON.parse(result.text).result.tools.length, 3);
  assert.equal(result.record.toolCount, 3);
  assert.equal(result.record.nativeEnabled, false);
  step = 'unavailable_binary';
  process.env.CONNECTOR_NATIVE_CLI_ENABLED = 'true';
  available = false;
  result = await request('tools/list', {});
  assert.equal(JSON.parse(result.text).result.tools.length, 3);
  assert.equal(result.record.nativeEnabled, false);
  available = true;
  step = 'missing_bearer';
  result = await request('tools/list', { private: marker }, { authorization: false });
  assert.equal(result.response.status, 401);
  assert.equal(result.record.failureStage, 'authentication');
  assert.equal(result.record.method, 'tools_list');
  step = 'invalid_bearer';
  authMode = 'invalid';
  result = await request('tools/list', {});
  assert.equal(result.response.status, 401);
  assert.equal(result.record.failureStage, 'authentication');
  step = 'authentication_unavailable';
  authMode = 'unavailable';
  result = await request('tools/list', {});
  assert.equal(result.response.status, 503);
  assert.equal(result.record.failureStage, 'authentication');
  assert.deepEqual(JSON.parse(result.text), { error: 'connector_unavailable' });
  authMode = 'valid';
  step = 'executor_failure';
  executorFails = true;
  result = await request('tools/list', {});
  assert.equal(result.record.failureStage, 'executor');
  assert.equal(result.response.status, 503);
  executorFails = false;
  step = 'probe_failure';
  probeFails = true;
  result = await request('tools/list', {});
  assert.equal(result.record.failureStage, 'native_probe');
  assert.equal(result.response.status, 503);
  probeFails = false;
  step = 'unsupported_http';
  result = await request(undefined, undefined, { httpMethod: 'GET' });
  assert.equal(result.response.status, 405);
  assert.equal(result.record.failureStage, 'unsupported_method');
  step = 'unsupported_unauthenticated';
  result = await request(undefined, undefined, { httpMethod: 'GET', authorization: false });
  assert.equal(result.response.status, 401);
  assert.equal(result.record.failureStage, 'authentication');
  step = 'logger_failure';
  Logger.prototype.log = () => { throw new Error(marker); };
  const response = await fetch(`${base}/mcp`, { method: 'GET' });
  assert.equal(response.status, 401);
  await response.text();
  step = 'log_privacy';
  assert.equal(JSON.stringify({ records, platformLogs }).includes(marker), false);
  assert.ok(platformLogs.length > 0, 'Installed platform logger was exercised');
  console.log('PASS: modern direct discovery/list/call, legacy SDK JSON, version rejection, per-request identities, authentication, privacy and diagnostics.');
} catch {
  console.error(`FAIL: MCP diagnostic probe at ${step}; no request, result or error content printed.`);
  process.exitCode = 1;
} finally {
  Logger.prototype.log = originalLog;
  if (originalFlag === undefined) delete process.env.CONNECTOR_NATIVE_CLI_ENABLED;
  else process.env.CONNECTOR_NATIVE_CLI_ENABLED = originalFlag;
  await new Promise((resolve) => server.close(resolve));
}
