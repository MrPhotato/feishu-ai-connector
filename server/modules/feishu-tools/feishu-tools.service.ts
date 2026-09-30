import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import type { AxiosResponse } from 'axios';
import { ConnectorAuthStorageService } from '../connector-auth-storage/connector-auth-storage.service';
import { loadConnectorAuthConfig } from '../connector-auth/connector-auth.config';
import type { ConnectorAuthConfig } from '../connector-auth/connector-auth.types';
import { FeishuToolExecutor } from './feishu-tools.executor';
import type { FeishuAppCredentials, FeishuHttpRequest, FeishuHttpReply } from './feishu-tools.executor';
import { retrieveFile } from './feishu-file-delivery';
import type { DeliveredFile } from './feishu-file-delivery';

@Injectable()
class FeishuToolsService extends FeishuToolExecutor {
  constructor(private readonly fileStorage: ConnectorAuthStorageService, http: HttpService) {
    super(fileStorage, async (request: FeishuHttpRequest): Promise<FeishuHttpReply> => {
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

  downloadFile(ticket: string): Promise<DeliveredFile | undefined> {
    return retrieveFile(this.fileStorage, ticket);
  }
}

export { FeishuToolsService };
