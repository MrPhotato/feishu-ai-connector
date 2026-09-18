import { All, Controller, Get, Logger, Post, Req, Res, ServiceUnavailableException } from '@nestjs/common';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Request, Response } from 'express';
import { ConnectorAuthService } from '../connector-auth/connector-auth.service';
import type { VerifiedMcpAuthorization } from '../connector-auth/connector-auth.types';
import { FeishuToolsService } from './feishu-tools.service';
import { createFeishuMcpServer } from './feishu-tools.mcp';
import { probeFeishuCli } from './feishu-cli.runner';
import { connectorPrivateRequest, connectorPrivateResponse } from '../connector-privacy/connector-privacy.middleware';

type McpRequestMethod = 'initialize' | 'notifications_initialized' | 'tools_list' | 'tools_call' | 'other';
type McpFailureStage = 'none' | 'privacy' | 'authentication' | 'executor' | 'native_probe'
  | 'registration' | 'connect' | 'handle_request' | 'close' | 'unsupported_method';

function requestMethod(body: unknown): McpRequestMethod {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'other';
  switch (Reflect.get(body, 'method')) {
    case 'initialize': return 'initialize';
    case 'notifications/initialized': return 'notifications_initialized';
    case 'tools/list': return 'tools_list';
    case 'tools/call': return 'tools_call';
    default: return 'other';
  }
}

@Controller()
class FeishuToolsController {
  private readonly logger: Logger = new Logger('FeishuMcpDiagnostics');

  constructor(private readonly auth: ConnectorAuthService, private readonly tools: FeishuToolsService) {}

  @Get('.well-known/oauth-protected-resource/mcp')
  metadata(@Res() response: Response): void {
    const base: string = this.auth.getPublicUrl();
    response.setHeader('Cache-Control', 'no-store').json({
      resource: `${base}/mcp`, authorization_servers: [`${base}/oidc`],
      scopes_supported: ['feishu.read', 'feishu.write'], bearer_methods_supported: ['header'],
    });
  }

  private async authenticate(request: Request, response: Response): Promise<VerifiedMcpAuthorization | undefined> {
    const base: string = this.auth.getPublicUrl();
    try {
      const match: RegExpMatchArray | null = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9._~-]+)$/u) ?? null;
      if (!match || match[1].length > 16384) throw new Error('Invalid bearer');
      return await this.auth.verifyMcpAuthorization(match[1]);
    } catch (error: unknown) {
      if (error instanceof ServiceUnavailableException) throw error;
      response.status(401).setHeader('Cache-Control', 'no-store')
        .setHeader('WWW-Authenticate',
          `Bearer resource_metadata=${JSON.stringify(`${base}/.well-known/oauth-protected-resource/mcp`)}, error="invalid_token"`)
        .json({ error: 'invalid_token', message: '请连接并授权后再访问。' });
      return undefined;
    }
  }

  @Post('mcp')
  async execute(@Req() request: Request, @Res() response: Response): Promise<void> {
    const started: number = performance.now();
    let method: McpRequestMethod = 'other';
    let nativeEnabled: boolean = false;
    let stage: McpFailureStage = 'privacy';
    let failureStage: McpFailureStage = 'none';
    let privateResponse: Response | undefined;
    try {
      privateResponse = connectorPrivateResponse(response);
      const privateRequest: Request = connectorPrivateRequest(request);
      method = requestMethod(privateRequest.body);
      stage = 'authentication';
      const authorization: VerifiedMcpAuthorization | undefined = await this.authenticate(privateRequest, privateResponse);
      if (!authorization) { failureStage = 'authentication'; return; }
      privateResponse.setHeader('Cache-Control', 'no-store');
      stage = 'executor';
      const executor = this.tools.forRequest(authorization.principal.accountId, authorization.account);
      stage = 'native_probe';
      nativeEnabled = process.env.CONNECTOR_NATIVE_CLI_ENABLED === 'true'
        && (await probeFeishuCli()).available;
      stage = 'registration';
      const server: McpServer = createFeishuMcpServer(executor, authorization.principal,
        nativeEnabled ? executor.executeTask.bind(executor) : undefined,
        nativeEnabled ? executor.executeNative.bind(executor) : undefined);
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, enableJsonResponse: true,
      });
      try {
        stage = 'connect';
        await server.connect(transport);
        stage = 'handle_request';
        await transport.handleRequest(privateRequest, privateResponse, privateRequest.body);
        stage = 'close';
      } finally {
        await server.close();
      }
    } catch {
      failureStage = stage;
      this.unavailable(privateResponse ?? response);
    } finally {
      this.recordRequest(method, nativeEnabled, response.statusCode, started, failureStage);
    }
  }

  @All('mcp')
  async unsupported(@Req() request: Request, @Res() response: Response): Promise<void> {
    const started: number = performance.now();
    let stage: McpFailureStage = 'privacy';
    let failureStage: McpFailureStage = 'none';
    let privateResponse: Response | undefined;
    try {
      privateResponse = connectorPrivateResponse(response);
      const privateRequest: Request = connectorPrivateRequest(request);
      stage = 'authentication';
      if (!await this.authenticate(privateRequest, privateResponse)) { failureStage = 'authentication'; return; }
      failureStage = 'unsupported_method';
      privateResponse.status(405).setHeader('Cache-Control', 'no-store').setHeader('Allow', 'POST').end();
    } catch {
      failureStage = stage;
      this.unavailable(privateResponse ?? response);
    } finally {
      this.recordRequest('other', false, response.statusCode, started, failureStage);
    }
  }

  private recordRequest(method: McpRequestMethod, nativeEnabled: boolean, statusCode: number,
    started: number, failureStage: McpFailureStage): void {
    // Emit only fixed categories and numeric diagnostics, never errors or request/response data.
    // Before authentication/registration completes, false/3 denotes the unselected native group.
    try {
      this.logger.log(JSON.stringify({ event: 'connector_mcp_request', method, nativeEnabled,
        toolCount: nativeEnabled ? 16 : 3,
        statusCode: Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599 ? statusCode : 0,
        durationMs: Math.max(0, Math.round(performance.now() - started)), failureStage }));
    } catch { /* Diagnostic sink failures must not affect the request or log sensitive context. */ }
  }

  private unavailable(response: Response): void {
    // Never propagate SDK/HTTP errors or private request bodies into platform interceptors.
    if (response.headersSent) {
      if (!response.writableEnded) response.end();
      return;
    }
    response.status(503).setHeader('Cache-Control', 'no-store')
      .setHeader('Content-Type', 'application/json').end('{"error":"connector_unavailable"}');
  }
}

export { FeishuToolsController };
