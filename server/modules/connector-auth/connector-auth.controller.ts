import { All, Controller, Get, Post, Req, Res, ServiceUnavailableException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ConnectorAuthService } from './connector-auth.service';
import { CONNECTOR_CHATGPT_CALLBACK } from './connector-auth.config';
import { connectorPrivateRequest, connectorPrivateResponse } from '../connector-privacy/connector-privacy.middleware';

@Controller()
export class ConnectorAuthController {
  constructor(private readonly auth: ConnectorAuthService) {}

  private async handle(response: Response, operation: () => Promise<void>): Promise<void> {
    response.set({
      'Cache-Control': 'no-store', 'Pragma': 'no-cache', 'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': `default-src 'none'; form-action 'self' ${CONNECTOR_CHATGPT_CALLBACK}; frame-ancestors 'none'; base-uri 'none'`,
    });
    try { await operation(); } catch (error: unknown) {
      if (response.headersSent) { response.end(); return; }
      const unavailable: boolean = error instanceof ServiceUnavailableException;
      response.status(unavailable ? 503 : 400).json({
        error: unavailable ? 'temporarily_unavailable' : 'invalid_request',
        error_description: unavailable ? '连接服务尚未完成配置。' : '授权未完成，请从 ChatGPT 重新发起连接。',
      });
    }
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
    const privateResponse: Response = connectorPrivateResponse(response);
    await this.handle(privateResponse, () => this.auth.interaction(connectorPrivateRequest(request), privateResponse));
  }

  @Get('auth/feishu/callback')
  async callback(@Req() request: Request, @Res() response: Response): Promise<void> {
    const privateResponse: Response = connectorPrivateResponse(response);
    await this.handle(privateResponse, () => this.auth.callback(connectorPrivateRequest(request), privateResponse));
  }

  @Get('interaction/:uid/finish')
  async finish(@Req() request: Request, @Res() response: Response): Promise<void> {
    const privateResponse: Response = connectorPrivateResponse(response);
    await this.handle(privateResponse, () => this.auth.finish(connectorPrivateRequest(request), privateResponse));
  }

  @Post('interaction/:uid/confirm')
  async consent(@Req() request: Request, @Res() response: Response): Promise<void> {
    const privateResponse: Response = connectorPrivateResponse(response);
    await this.handle(privateResponse, () => this.auth.consent(connectorPrivateRequest(request), privateResponse));
  }
}
