import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadDeploymentConfig, deploymentFetch } from './lib/deployment-config.mjs';

if (process.argv.length !== 2) throw new Error('Select the deployment with CONNECTOR_DEPLOYMENT_FILE, not a URL argument.');
const deployment = loadDeploymentConfig();
const base = deployment.publicUrl;
const observations = [];
for (const path of ['/connector-probe/health', '/.well-known/connector-probe', '/connector-probe/bearer']) {
  const response = await deploymentFetch(deployment, `${base}${path}`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(20000),
  });
  const body = await response.text();
  const location = response.headers.get('location');
  const redirect = location ? new URL(location, base) : null;
  let probe = null;
  try {
    const data = JSON.parse(body);
    if (data.service === 'feishu-ai-connector' || data.phase === 'transport-probe') {
      probe = data;
    }
  } catch {
    // An HTML login page is evidence of an incompatible gateway, not a success.
  }
  observations.push({
    path,
    status: response.status,
    contentType: response.headers.get('content-type'),
    wwwAuthenticate: response.headers.get('www-authenticate'),
    redirect: redirect ? `${redirect.origin}${redirect.pathname}` : null,
    probe,
  });
}
const routePassed = observations[0].probe?.service === 'feishu-ai-connector';
let mcp = { passed: false, reason: 'Public route did not reach the application.' };
if (routePassed) {
  const client = new Client({ name: 'connector-remote-verifier', version: '0.1.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/connector-probe/mcp`), {
      fetch: (url, init) => deploymentFetch(deployment, url, init),
    }));
    const tools = await client.listTools();
    const result = await client.callTool({ name: 'connector_probe', arguments: {} });
    mcp = {
      passed: tools.tools.some((tool) => tool.name === 'connector_probe') &&
        result.structuredContent?.personalDataConnected === false,
      tools: tools.tools.map((tool) => tool.name),
      result: result.structuredContent,
    };
  } catch {
    mcp = { passed: false, reason: 'Transport verification failed; response details withheld.' };
  } finally {
    await client.close();
  }
}
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), base, observations, mcp }, null, 2));
if (!mcp.passed) process.exitCode = 1;
