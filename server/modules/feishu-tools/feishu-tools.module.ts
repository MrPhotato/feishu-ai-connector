import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConnectorAuthModule } from '../connector-auth/connector-auth.module';
import { ConnectorAuthStorageModule } from '../connector-auth-storage/connector-auth-storage.module';
import { FeishuToolsController } from './feishu-tools.controller';
import { FeishuToolsService } from './feishu-tools.service';

@Module({
  imports: [HttpModule, ConnectorAuthModule, ConnectorAuthStorageModule],
  controllers: [FeishuToolsController], providers: [FeishuToolsService], exports: [FeishuToolsService],
})
class FeishuToolsModule {}

export { FeishuToolsModule };
