import { Module } from '@nestjs/common';
import { ConnectorAuthStorageModule } from '../connector-auth-storage/connector-auth-storage.module';
import { ConnectorAuthController } from './connector-auth.controller';
import { ConnectorAuthService } from './connector-auth.service';

@Module({
  imports: [ConnectorAuthStorageModule], controllers: [ConnectorAuthController],
  providers: [ConnectorAuthService], exports: [ConnectorAuthService],
})
export class ConnectorAuthModule {}
