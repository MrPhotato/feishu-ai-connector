import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import express from 'express';

const require = createRequire(import.meta.url);
const { ServiceUnavailableException } = require('@nestjs/common');
const { ConnectorAuthUnavailableError } =
  require('../dist/server/modules/connector-auth/connector-auth.unavailable.js');
const { ConnectorAuthController } =
  require('../dist/server/modules/connector-auth/connector-auth.controller.js');
const { connectorPrivacyMiddleware } =
  require('../dist/server/modules/connector-privacy/connector-privacy.middleware.js');

// Only an in-process synthetic service is used. No upstream, credentials, or env files.
const privateCode = 'synthetic-private-code';
const privateState = 'synthetic-private-state';
const privateTicket = 'synthetic-private-ticket';
const privateUid = 'synthetic-private-uid';
const privateError = 'synthetic-private-error <script>alert("secret")</script>';
let mode = 'invalid';
let calls = 0;
function fail() {
  if (mode === 'storage-unavailable') throw new ConnectorAuthUnavailableError();
  if (mode === 'unavailable') throw new ServiceUnavailableException(privateError);
  throw new Error(privateError, { cause: { code: privateCode, state: privateState } });
}
async function browserOperation(req, res) {
  calls += 1;
  assert.equal(req.query.code, privateCode, 'service still sees its private request');
  assert.equal(req.query.state, privateState);
  if (req.params.uid) assert.equal(req.params.uid, privateUid);
  if (req.method === 'POST') assert.equal(req.body.csrf, privateTicket);
  if (mode === 'success') { res.redirect('https://chatgpt.com/'); return; }
  if (mode === 'already-sent') { res.status(204).end(); throw new Error(privateError); }
  // A late failure must restore the strict error-page policy, not preserve retry/navigation headers.
  res.set('Referrer-Policy', 'origin');
  res.set('Location', `https://issuer.test/callback?code=${privateCode}`);
  res.set('Refresh', `0;url=https://issuer.test/callback?state=${privateState}`);
  fail();
}
const controller = new ConnectorAuthController({
  interaction: browserOperation, callback: browserOperation,
  finish: browserOperation, consent: browserOperation,
  async mount(_req, res) {
    calls += 1;
    if (mode === 'success') { res.json({ issuer: 'https://issuer.test/oidc' }); return; }
    fail();
  },
  getStatus() {
    calls += 1;
    if (mode === 'success') return { configured: true };
    fail();
  },
});
const app = express();
app.disable('x-powered-by');
app.use(express.urlencoded({ extended: false }));
app.use(connectorPrivacyMiddleware);
const logs = [];
app.use((req, res, next) => {
  const started = { url: req.originalUrl, query: req.query, body: req.body };
  for (const method of ['send', 'json']) {
    const original = res[method].bind(res);
    res[method] = (body) => { res.__observedBody = body; return original(body); };
  }
  res.on('finish', () => logs.push(JSON.stringify({ started, body: res.__observedBody })));
  next();
});
const router = express.Router();
router.get('/interaction/:uid', (req, res) => controller.interaction(req, res));
router.get('/auth/feishu/callback', (req, res) => controller.callback(req, res));
router.get('/interaction/:uid/finish', (req, res) => controller.finish(req, res));
router.post('/interaction/:uid/confirm', (req, res) => controller.consent(req, res));
router.all('/oidc/*', (req, res) => controller.oidc(req, res));
router.get('/connector/status', (_req, res) => controller.status(res));
app.get('/missing-privacy', (req, res) => controller.callback(req, res));
app.use('/app/synthetic-test', router);
app.use(router);
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const routes = [
  ['GET', `/interaction/${privateUid}`],
  ['GET', '/auth/feishu/callback'],
  ['GET', `/interaction/${privateUid}/finish`],
  ['POST', `/interaction/${privateUid}/confirm`],
];
async function browserRequest(method, path) {
  const query = new URLSearchParams({ code: privateCode, state: privateState, ticket: privateTicket });
  return fetch(`${base}${path}?${query}`, {
    method, redirect: 'manual', headers: { accept: 'application/json',
      ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    ...(method === 'POST' ? { body: new URLSearchParams({ csrf: privateTicket }) } : {}),
  });
}
async function assertErrorPage(response, unavailable) {
  assert.equal(response.status, unavailable ? 503 : 400);
  assert.match(response.headers.get('content-type'), /^text\/html; charset=utf-8$/iu);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('pragma'), 'no-cache');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('location'), null);
  assert.equal(response.headers.get('refresh'), null);
  const html = await response.text();
  assert.match(html, /<html lang="zh-CN">/u);
  assert.match(html, unavailable ? /连接服务暂时不可用/u : /飞书连接未完成/u);
  assert.match(html, /重新发起飞书连接/u);
  assert.match(html, /无需刷新或返回上一步/u);
  assert.match(html, /name="viewport"/u);
  assert.doesNotMatch(html, /<script|<form|<iframe|http-equiv|\son\w+=|\sstyle=/iu);
  assert.deepEqual([...html.matchAll(/href="([^"]+)"/gu)].map((match) => match[1]), ['https://chatgpt.com/']);
  const css = /<style>([\s\S]*?)<\/style>/u.exec(html)?.[1];
  assert.ok(css);
  assert.match(css, /color-scheme: light/u);
  const hash = createHash('sha256').update(css).digest('base64');
  const csp = response.headers.get('content-security-policy');
  assert.ok(csp.includes(`style-src 'sha256-${hash}'`), 'only the exact stylesheet is allowed');
  for (const directive of ["default-src 'none'", "script-src 'none'", "form-action 'none'",
    "frame-ancestors 'none'", "base-uri 'none'"]) assert.ok(csp.includes(directive));
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*/u);
  for (const value of [privateCode, privateState, privateTicket, privateUid, privateError]) {
    assert.ok(!html.includes(value), 'error page contains no request or exception data');
    assert.ok(!JSON.stringify([...response.headers]).includes(value));
  }
}
let browserFailures = 0;
try {
  for (const failure of ['invalid', 'unavailable', 'storage-unavailable']) {
    mode = failure;
    const unavailable = failure !== 'invalid';
    for (const prefix of ['', '/app/synthetic-test']) {
      for (const [method, path] of routes) {
        const before = calls;
        await assertErrorPage(await browserRequest(method, `${prefix}${path}`), unavailable);
        assert.equal(calls, before + 1, 'failed authorizations are not retried');
        browserFailures += 1;
      }
      for (const path of ['/oidc/token', '/connector/status']) {
        const reply = await fetch(`${base}${prefix}${path}`);
        assert.equal(reply.status, unavailable ? 503 : 400);
        assert.match(reply.headers.get('content-type'), /^application\/json/iu);
        assert.deepEqual(await reply.json(), {
          error: unavailable ? 'temporarily_unavailable' : 'invalid_request',
          error_description: unavailable
            ? '连接服务尚未完成配置。' : '授权未完成，请从 ChatGPT 重新发起连接。',
        });
      }
    }
  }
  mode = 'success';
  for (const [method, path] of routes) {
    const reply = await browserRequest(method, path);
    assert.equal(reply.status, 302, 'successful authorization redirects are unchanged');
    assert.equal(reply.headers.get('location'), 'https://chatgpt.com/');
  }
  assert.deepEqual(await (await fetch(`${base}/oidc/discovery`)).json(), { issuer: 'https://issuer.test/oidc' });
  assert.deepEqual(await (await fetch(`${base}/connector/status`)).json(), { configured: true });
  mode = 'already-sent';
  assert.equal((await browserRequest('GET', '/auth/feishu/callback')).status, 204,
    'already-sent responses are not rewritten');
  const before = calls;
  await assertErrorPage(await fetch(`${base}/missing-privacy`), true);
  assert.equal(calls, before, 'missing privacy middleware cannot invoke the auth service');
  const visible = logs.join('\n');
  for (const value of [privateCode, privateState, privateTicket, privateUid, privateError]) {
    assert.ok(!visible.includes(value), 'request/error details never reach logger-visible objects');
  }
  console.log(`PASS: ${browserFailures} browser failure cases; Chinese HTML/CSP hash/mobile layout, ` +
    'no secret/retry link, protocol JSON, success redirects, sent-response and privacy fail-closed checks.');
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
