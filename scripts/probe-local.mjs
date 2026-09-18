import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ConnectorProbeModule } from '../dist/server/modules/connector-probe/connector-probe.module.js';

// Tests the registered probe module, not the remote platform gateway.
// No .env file or personal credentials are loaded.
const app = await NestFactory.create(ConnectorProbeModule, { logger: false });
const client = new Client({ name: 'connector-local-verifier', version: '0.1.0' });
try {
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const health = await fetch(`${base}/connector-probe/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).personalDataConnected, false);
  const discovery = await fetch(`${base}/.well-known/connector-probe`);
  assert.equal(discovery.status, 200);
  const rejected = await fetch(`${base}/connector-probe/bearer`);
  assert.equal(rejected.status, 401);
  assert.match(rejected.headers.get('www-authenticate'), /^Bearer /);
  const events = await fetch(`${base}/connector-probe/mcp`);
  assert.equal(events.status, 405);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/connector-probe/mcp`)));
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), ['connector_probe']);
  const result = await client.callTool({ name: 'connector_probe', arguments: {} });
  assert.equal(result.structuredContent?.personalDataConnected, false);
  assert.equal(result.structuredContent?.phase, 'transport-probe');
  console.log('PASS: health, well-known route, 401/header, no-SSE, MCP initialization/list/call.');
} finally {
  await client.close();
  await app.close();
}
