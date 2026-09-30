import {
  Controller, Header, HttpCode, Post, Req, Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ConnectorAuthStorageResponse } from '@shared/api.interface';
import {
  storageEnvelopeSchema, storageTimedCommandSchema, storageFileBatchCommandSchema,
  validateStorageFileBatchEnvelope, validateStorageFileBatchResponse,
} from './connector-auth-storage.contract';
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
      if (Array.isArray(privateRequest.body?.sealed)) {
        await this.executeFileBatch(privateRequest, privateResponse);
        return;
      }
      const envelope = storageEnvelopeSchema.parse(privateRequest.body);
      const timed = storageTimedCommandSchema.parse(this.crypto.open(envelope.sealed, STORAGE_REQUEST_AAD));
      if (Math.abs(Date.now() - timed.issuedAt) > 60000) throw new Error('Storage request rejected.');
      const result: ConnectorAuthStorageResponse = await this.repository.execute(timed.command);
      privateResponse.status(200).json({ sealed: this.crypto.seal(result, this.crypto.responseAad(envelope.sealed)) });
    } catch {
      privateResponse.status(503).json({ error: 'temporarily_unavailable' });
    }
  }

  private async executeFileBatch(privateRequest: Request, privateResponse: Response): Promise<void> {
    const envelope = validateStorageFileBatchEnvelope(privateRequest.body);
    // Fully validate every entry before the repository receives any command.
    const commands = storageFileBatchCommandSchema.parse(envelope.sealed.map((sealed) => {
      const timed = storageTimedCommandSchema.parse(this.crypto.open(sealed, STORAGE_REQUEST_AAD));
      if (Math.abs(Date.now() - timed.issuedAt) > 60000) throw new Error('File batch rejected.');
      return timed.command;
    }));
    const operation = commands[0].operation;
    if (operation !== 'get' && operation !== 'put') throw new Error('File batch rejected.');
    const results: ConnectorAuthStorageResponse[] = await this.repository.executeFileBatch(commands);
    if (results.length !== commands.length) throw new Error('File batch response rejected.');
    const sealed: string[] = results.map((result, index): string => this.crypto.seal(
      validateStorageFileBatchResponse(result, operation), this.crypto.responseAad(envelope.sealed[index]),
    ));
    privateResponse.status(200).json(validateStorageFileBatchEnvelope({ sealed }));
  }
}

export { ConnectorAuthStorageOpenapiController };
