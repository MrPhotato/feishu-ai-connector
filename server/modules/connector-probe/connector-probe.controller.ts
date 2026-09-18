import { All, Controller, Get, Post, Req, Res } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Request, Response } from 'express';
import type { ConnectorProbeResult } from '@shared/api.interface';
import { probeFeishuCli } from '../feishu-tools/feishu-cli.runner';
import type { FeishuCliRuntime } from '../feishu-tools/feishu-cli.runner';

function probeResult(): ConnectorProbeResult {
  return {
    service: 'feishu-ai-connector',
    phase: 'transport-probe',
    version: '0.1.0',
    personalDataConnected: false,
  };
}

// Protocol probes carry no user data and do not replace platform authentication.
// Non-business routes test whether the managed gateway supports MCP at all.
// PlatformModule, CSRF protections, and all platform guards remain unchanged.
@Controller()
export class ConnectorProbeController {
  @Get('connector-probe/cli')
  async getCliRuntime(): Promise<FeishuCliRuntime> {
    return probeFeishuCli();
  }

  @Get(['connector-probe/health', '.well-known/connector-probe'])
  getHealth(): ConnectorProbeResult {
    return probeResult();
  }

  @All('connector-probe/bearer')
  requireBearer(@Res() response: Response): void {
    response
      .status(401)
      .setHeader('WWW-Authenticate', 'Bearer realm="connector-transport-probe"')
      .setHeader('Cache-Control', 'no-store')
      .json({ error: 'invalid_token', phase: 'transport-probe' });
  }

  @Get('connector-probe/mcp')
  rejectEventStream(@Res() response: Response): void {
    response.status(405).setHeader('Allow', 'POST').end();
  }

  @Post('connector-probe/mcp')
  async callMcp(@Req() request: Request, @Res() response: Response): Promise<void> {
    const server: McpServer = new McpServer({
      name: 'feishu-connector-transport-probe',
      version: '0.1.0',
    });
    server.registerTool(
      'connector_probe',
      {
        title: '连接测试',
        description: '仅检查连接服务，不访问飞书账号、聊天或文档。',
        inputSchema: {},
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => ({
        content: [{ type: 'text', text: JSON.stringify(probeResult()) }],
        structuredContent: { ...probeResult() },
      }),
    );
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } finally {
      await server.close();
    }
  }
}
