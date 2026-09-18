import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import express from 'express';
import { from } from 'rxjs';

// The installed SDK implementation is exercised unchanged. Its log sinks are in-memory doubles;
// the harness never instantiates the platform logger service, calls a platform API, or reads env secrets.
const require = createRequire(import.meta.url);
const { connectorPrivacyMiddleware, connectorPrivateRequest, connectorPrivateResponse } =
  require('../dist/server/modules/connector-privacy/connector-privacy.middleware.js');
const { LoggerModule } = require('@lark-apaas/nestjs-logger');
const LoggingInterceptor = Reflect.getMetadata('providers', LoggerModule)
  .find((provider) => typeof provider === 'function' && provider.name === 'LoggingInterceptor');
assert.equal(typeof LoggingInterceptor, 'function');
const marker = `synthetic-private-${randomBytes(12).toString('hex')}`;
const sensitive = {
  code: `${marker}-code`, refresh: `${marker}-refresh`, verifier: `${marker}-verifier`,
  ticket: `${marker}-ticket`, state: `${marker}-state`, uid: `${marker}-uid`,
  apiKey: `${marker}-api-key`, cookie: `${marker}-cookie`, setCookie: `${marker}-set-cookie`,
  result: `${marker}-result`, sealed: `${marker}-sealed`, query: `${marker}-query`,
};
const captured = [];
const requests = [];
const traceLogger = { logStructured: (...args) => captured.push(args) };
const appLogger = { log: (...args) => captured.push(args), error: (...args) => captured.push(args) };
let contextState = {};
const requestContext = {
  setContext: (value) => { contextState = { ...contextState, ...value }; },
  getContext: () => contextState,
};
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.all('*', connectorPrivacyMiddleware);
let interceptor;
function handle(action) {
  return (req, res) => {
    const originalHeaders = { ...req.headers };
    const context = { getType: () => 'http', switchToHttp: () => ({
      getRequest: () => req, getResponse: () => res,
    }) };
    interceptor.intercept(context, { handle: () => from((async () => {
      const privateReq = connectorPrivateRequest(req);
      const privateRes = connectorPrivateResponse(res);
      assert.equal(privateReq.headers.authorization, `Bearer ${sensitive.apiKey}`);
      assert.equal(privateReq.headers.cookie, `test=${sensitive.cookie}`);
      privateReq.headers.host = 'synthetic-private-host';
      await action(privateReq, privateRes);
      assert.equal(req.headers.host, originalHeaders.host);
      assert.equal(req.body, undefined);
      assert.equal(Object.keys(req.query).length, 0);
      assert.equal(Reflect.get(res, '__finalResponseBody'), undefined);
      requests.push({ url: req.url, originalUrl: req.originalUrl, path: req.path, body: req.body });
      // Deliberately void: the platform logs any returned controller data independently.
    })()) }).subscribe({
      error: () => { if (!res.headersSent) res.status(503).end(); },
    });
  };
}
app.post('/oidc/token', handle((req, res) => {
  assert.equal(req.body.code, sensitive.code);
  assert.equal(req.body.refresh_token, sensitive.refresh);
  assert.equal(req.body.code_verifier, sensitive.verifier);
  res.status(200).setHeader('Set-Cookie', `test=${sensitive.setCookie}; HttpOnly; Secure`)
    .json({ access_token: sensitive.result, refresh_token: sensitive.refresh });
}));
app.get('/auth/feishu/callback', handle((req, res) => {
  assert.equal(req.query.code, sensitive.code);
  assert.equal(req.query.state, sensitive.state);
  res.redirect(303, `/interaction/${sensitive.uid}/finish?ticket=${sensitive.ticket}`);
}));
app.get('/interaction/:uid/finish', handle((req, res) => {
  assert.equal(req.params.uid, sensitive.uid);
  assert.equal(req.query.ticket, sensitive.ticket);
  res.status(400).type('text/html').send(`<html>${sensitive.result}</html>`);
}));
app.post('/openapi/connector-auth-storage/execute', handle((req, res) => {
  assert.equal(req.body.sealed, sensitive.sealed);
  res.status(200).json({ sealed: sensitive.result });
}));
app.post('/mcp', handle((req, res) => {
  assert.equal(req.body.params.query, sensitive.query);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: sensitive.result }));
  res.end();
}));
app.post('/oidc/error', handle(() => { throw new Error('Synthetic safe failure.'); }));
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const headers = { Authorization: `Bearer ${sensitive.apiKey}`, Cookie: `test=${sensitive.cookie}` };
try {
  for (const environment of ['production', 'development']) {
    process.env.NODE_ENV = environment;
    for (const logBodies of [true, false]) {
      interceptor = new LoggingInterceptor(traceLogger, requestContext, appLogger, {
        logRequestBody: logBodies, logResponseBody: logBodies, maxBodyLength: null,
      });
      const tokenPath = logBodies ? '/OIDC/token' : '/oidc/token';
      const token = await fetch(`${base}${tokenPath}?private=${sensitive.query}`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code: sensitive.code, refresh_token: sensitive.refresh,
          code_verifier: sensitive.verifier }),
      });
      assert.equal(token.status, 200);
      assert.equal((await token.json()).access_token, sensitive.result);
      assert.equal(token.headers.get('set-cookie').includes(sensitive.setCookie), true);
      const callback = await fetch(`${base}/auth/feishu/callback?code=${sensitive.code}&state=${sensitive.state}`, {
        headers, redirect: 'manual',
      });
      assert.equal(callback.status, 303);
      assert.equal(callback.headers.get('location').includes(sensitive.ticket), true);
      const finish = await fetch(`${base}${callback.headers.get('location')}`, { headers });
      assert.equal(finish.status, 400);
      assert.equal((await finish.text()).includes(sensitive.result), true);
      const storage = await fetch(`${base}/openapi/connector-auth-storage/execute`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sealed: sensitive.sealed }),
      });
      assert.equal(storage.status, 200);
      assert.equal((await storage.json()).sealed, sensitive.result);
      const mcp = await fetch(`${base}/mcp`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { query: sensitive.query } }),
      });
      assert.equal(mcp.status, 200);
      assert.equal((await mcp.json()).result, sensitive.result);
      const failure = await fetch(`${base}/oidc/error?private=${sensitive.query}`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ private: sensitive.result }),
      });
      assert.equal(failure.status, 503);
    }
  }
  assert.equal(requests.length, 20);
  assert.equal(captured.length > 40, true);
  const serialized = JSON.stringify({ captured, requests });
  assert.equal(serialized.includes(marker), false, 'Private marker reached the SDK log sink.');
  assert.equal(serialized.includes('duration_ms'), true);
  assert.equal(serialized.includes('/oidc/token'), true);
  console.log('PASS: installed logger production/development and body flags; OAuth, storage, MCP bodies, URLs and cookies isolated.');
} catch {
  console.error('FAIL: connector privacy probe failed. No payloads are printed.');
  process.exitCode = 1;
} finally {
  await new Promise((resolve) => server.close(resolve));
}
