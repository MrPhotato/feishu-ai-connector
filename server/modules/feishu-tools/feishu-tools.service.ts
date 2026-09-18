import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import type { AxiosResponse } from 'axios';
import { ConnectorAuthStorageService } from '../connector-auth-storage/connector-auth-storage.service';
import { loadConnectorAuthConfig } from '../connector-auth/connector-auth.config';
import type { ConnectorAuthConfig } from '../connector-auth/connector-auth.types';
import { FeishuToolExecutor } from './feishu-tools.executor';
import type { FeishuAppCredentials, FeishuHttpRequest, FeishuHttpReply } from './feishu-tools.executor';

@Injectable()
class FeishuToolsService extends FeishuToolExecutor {
  constructor(storage: ConnectorAuthStorageService, http: HttpService) {
    super(storage, async (request: FeishuHttpRequest): Promise<FeishuHttpReply> => {
      const reply: AxiosResponse<unknown> = await firstValueFrom(http.request<unknown>({
        url: request.url, method: request.method, params: request.query,
        headers: request.headers, data: request.body,
        timeout: 15000, maxRedirects: 0, maxContentLength: 1048576, maxBodyLength: 131072,
        validateStatus: (): boolean => true,
      }));
      return { status: reply.status, body: reply.data };
    }, (): FeishuAppCredentials => {
      const config: ConnectorAuthConfig = loadConnectorAuthConfig();
      return { clientId: config.feishuAppId, clientSecret: config.feishuAppSecret };
    });
  }
}

export { FeishuToolsService };
