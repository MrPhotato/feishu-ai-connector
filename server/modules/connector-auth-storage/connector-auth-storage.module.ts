import { Module } from '@nestjs/common';
import { ConnectorAuthStorageCrypto } from './connector-auth-storage.crypto';
import { ConnectorAuthStorageOpenapiController } from './connector-auth-storage.openapi.controller';
import { ConnectorAuthStorageRepository } from './connector-auth-storage.repository';
import { ConnectorAuthStorageService } from './connector-auth-storage.service';

@Module({
  controllers: [ConnectorAuthStorageOpenapiController],
  providers: [ConnectorAuthStorageCrypto, ConnectorAuthStorageRepository, ConnectorAuthStorageService],
  exports: [ConnectorAuthStorageService],
})
class ConnectorAuthStorageModule {}

export { ConnectorAuthStorageModule };
