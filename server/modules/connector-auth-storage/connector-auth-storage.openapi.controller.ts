import {
  Controller, Header, HttpCode, Post, Req, Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ConnectorAuthStorageResponse } from '@shared/api.interface';
import { storageEnvelopeSchema, storageTimedCommandSchema } from './connector-auth-storage.contract';
import { ConnectorAuthStorageCrypto, STORAGE_REQUEST_AAD } from './connector-auth-storage.crypto';
import { ConnectorAuthStorageRepository } from './connector-auth-storage.repository';
import { connectorPrivateRequest, connectorPrivateResponse } from '../connector-privacy/connector-privacy.middleware';

@Controller('openapi/connector-auth-storage')
class ConnectorAuthStorageOpenapiController {
  constructor(
    private readonly crypto: ConnectorAuthStorageCrypto,
    private readonly repository: ConnectorAuthStorageRepository,
  ) {}

  @Post('execute')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async connectorAuthStorageExecute(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    // This /openapi path is authenticated by the managed API Key gateway.
    // Its effective database access is verified with RLS probes; userContext is
    // not a reliable indicator of the gateway's database execution identity.
    const privateRequest: Request = connectorPrivateRequest(request);
    const privateResponse: Response = connectorPrivateResponse(response);
    try {
      if (Object.keys(privateRequest.query).length > 0) throw new Error('Storage request rejected.');
      const envelope = storageEnvelopeSchema.parse(privateRequest.body);
      const timed = storageTimedCommandSchema.parse(this.crypto.open(envelope.sealed, STORAGE_REQUEST_AAD));
      if (Math.abs(Date.now() - timed.issuedAt) > 60000) throw new Error('Storage request rejected.');
      const result: ConnectorAuthStorageResponse = await this.repository.execute(timed.command);
      privateResponse.status(200).json({ sealed: this.crypto.seal(result, this.crypto.responseAad(envelope.sealed)) });
    } catch {
      privateResponse.status(503).json({ error: 'temporarily_unavailable' });
    }
  }
}

export { ConnectorAuthStorageOpenapiController };
