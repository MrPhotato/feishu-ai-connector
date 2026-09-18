import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ConnectorStatus } from '@shared/api.interface';
import { ConnectorAuthStorageService } from '../connector-auth-storage/connector-auth-storage.service';
import { connectorPublicUrl, loadConnectorAuthConfig } from './connector-auth.config';
import { connectorDefaultTimezone } from '../../config/connector-deployment.config';
import { createConnectorOidc } from './connector-oidc.factory';
import type { ConnectorOidc } from './connector-oidc.factory';
import { ConnectorFeishuFlow } from './connector-feishu.flow';
import { connectorFeishuHttp } from './connector-feishu.http';
import type { ConnectorAuthConfig, McpPrincipal, VerifiedMcpAuthorization } from './connector-auth.types';

interface ConnectorAuthRuntime { oidc: ConnectorOidc; flow: ConnectorFeishuFlow }

@Injectable()
export class ConnectorAuthService {
  private runtime?: ConnectorAuthRuntime;

  constructor(private readonly storage: ConnectorAuthStorageService) {}

  private getRuntime(): ConnectorAuthRuntime {
    if (this.runtime) return this.runtime;
    try {
      const config: ConnectorAuthConfig = loadConnectorAuthConfig();
      const oidc: ConnectorOidc = createConnectorOidc(config, this.storage);
      this.runtime = { oidc, flow: new ConnectorFeishuFlow(config, this.storage, oidc.provider, connectorFeishuHttp) };
      return this.runtime;
    } catch {
      throw new ServiceUnavailableException('连接服务尚未完成配置。');
    }
  }

  getPublicUrl(): string { return connectorPublicUrl(); }

  getStatus(): ConnectorStatus {
    let mcpUrl: string = '';
    let configured: boolean = false;
    try {
      const publicUrl: string = this.getPublicUrl();
      mcpUrl = `${publicUrl}/mcp`;
      const config: ConnectorAuthConfig = loadConnectorAuthConfig();
      const storageKey: string = process.env.CONNECTOR_STORAGE_ENCRYPTION_KEY || '';
      const apiKey: string = process.env.CONNECTOR_STORAGE_API_KEY || '';
      if (!/^[0-9a-fA-F]{64}$/u.test(storageKey) ||
        !apiKey || apiKey.length > 4096 || /[\s\u0000-\u001f\u007f]/u.test(apiKey) ||
        !/^cli_[a-zA-Z0-9]+$/u.test(config.feishuAppId) ||
        /[\s\u0000-\u001f\u007f]/u.test(config.feishuAppSecret) ||
        config.feishuAppSecret.length > 4096 ||
        !/^[a-zA-Z0-9_:.-]+(?: +[a-zA-Z0-9_:.-]+)*$/u.test(config.feishuScopes)) {
        throw new Error('Invalid configuration');
      }
      connectorDefaultTimezone();
      // Initializes and validates signing/cookie configuration only; no storage or upstream I/O.
      this.getRuntime();
      configured = true;
    } catch {
      // Readiness is public. Do not expose missing variable names, secret values, or causes.
    }
    return {
      configured, mcpUrl, oauthClientId: 'chatgpt',
      message: configured ? '服务配置已就绪，请从 ChatGPT 发起连接并完成飞书授权。' :
        '服务正在配置中，连接入口将在配置完成后开放。',
    };
  }

  async verifyMcpToken(token: string): Promise<McpPrincipal> {
    return (await this.verifyMcpAuthorization(token)).principal;
  }

  async verifyMcpAuthorization(token: string): Promise<VerifiedMcpAuthorization> {
    const runtime: ConnectorAuthRuntime = this.getRuntime();
    try { return await runtime.oidc.verifyMcpAuthorization(token); } catch {
      throw new UnauthorizedException('连接已失效，请重新授权。');
    }
  }

  async mount(request: Request, response: Response): Promise<void> {
    await this.getRuntime().oidc.mount(request, response);
  }

  async interaction(request: Request, response: Response): Promise<void> {
    await this.getRuntime().flow.showInteraction(request, response);
  }
  async callback(request: Request, response: Response): Promise<void> {
    await this.getRuntime().flow.feishuCallback(request, response);
  }
  async finish(request: Request, response: Response): Promise<void> {
    await this.getRuntime().flow.finishLogin(request, response);
  }
  async consent(request: Request, response: Response): Promise<void> {
    await this.getRuntime().flow.confirmConsent(request, response);
  }
}
