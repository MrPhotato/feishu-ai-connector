import { All, Controller, Get, Post, Req, Res, ServiceUnavailableException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ConnectorAuthService } from './connector-auth.service';
import { CONNECTOR_CHATGPT_CALLBACK } from './connector-auth.config';
import { connectorPrivateRequest, connectorPrivateResponse } from '../connector-privacy/connector-privacy.middleware';
import { sendConnectorBrowserError } from './connector-auth.error-page';
import { ConnectorAuthUnavailableError } from './connector-auth.unavailable';

@Controller()
export class ConnectorAuthController {
  constructor(private readonly auth: ConnectorAuthService) {}

  private async handle(
    response: Response, operation: () => Promise<void>, browserError: boolean = false,
  ): Promise<void> {
    response.set({
      'Cache-Control': 'no-store', 'Pragma': 'no-cache', 'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': `default-src 'none'; form-action 'self' ${CONNECTOR_CHATGPT_CALLBACK}; frame-ancestors 'none'; base-uri 'none'`,
    });
    try { await operation(); } catch (error: unknown) {
      if (response.headersSent) { response.end(); return; }
      const unavailable: boolean = error instanceof ServiceUnavailableException || error instanceof ConnectorAuthUnavailableError;
      if (browserError) { sendConnectorBrowserError(response, unavailable); return; }
      response.status(unavailable ? 503 : 400).json({
        error: unavailable ? 'temporarily_unavailable' : 'invalid_request',
        error_description: unavailable ? '连接服务尚未完成配置。' : '授权未完成，请从 ChatGPT 重新发起连接。',
      });
    }
  }

  private async browser(
    request: Request, response: Response, operation: (request: Request, response: Response) => Promise<void>,
  ): Promise<void> {
    let privateResponse: Response;
    try { privateResponse = connectorPrivateResponse(response); } catch {
      // Fail closed if privacy middleware is unavailable; the fallback contains no request data.
      sendConnectorBrowserError(response, true); return;
    }
    await this.handle(privateResponse, () => operation(connectorPrivateRequest(request), privateResponse), true);
  }

  @All('oidc/*')
  async oidc(@Req() request: Request, @Res() response: Response): Promise<void> {
    const privateResponse: Response = connectorPrivateResponse(response);
    await this.handle(privateResponse, () => this.auth.mount(connectorPrivateRequest(request), privateResponse));
  }

  @Get('connector/status')
  async status(@Res() response: Response): Promise<void> {
    await this.handle(response, async (): Promise<void> => { response.json(this.auth.getStatus()); });
  }

  @Get('interaction/:uid')
  async interaction(@Req() request: Request, @Res() response: Response): Promise<void> {
    await this.browser(request, response, (req: Request, res: Response) => this.auth.interaction(req, res));
  }

  @Get('auth/feishu/callback')
  async callback(@Req() request: Request, @Res() response: Response): Promise<void> {
    await this.browser(request, response, (req: Request, res: Response) => this.auth.callback(req, res));
  }

  @Get('interaction/:uid/finish')
  async finish(@Req() request: Request, @Res() response: Response): Promise<void> {
    await this.browser(request, response, (req: Request, res: Response) => this.auth.finish(req, res));
  }

  @Post('interaction/:uid/confirm')
  async consent(@Req() request: Request, @Res() response: Response): Promise<void> {
    await this.browser(request, response, (req: Request, res: Response) => this.auth.consent(req, res));
  }
}
