import { APP_FILTER } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { PlatformModule } from '@lark-apaas/fullstack-nestjs-core';

import { GlobalExceptionFilter } from './common/filters/exception.filter';
import { ViewModule } from './modules/view/view.module';
import { ConnectorProbeModule } from './modules/connector-probe/connector-probe.module';
import { CredentialProbeModule } from './modules/credential-probe/credential-probe.module';
import { ConnectorAuthModule } from './modules/connector-auth/connector-auth.module';
import { ConnectorAuthStorageModule } from './modules/connector-auth-storage/connector-auth-storage.module';
import { FeishuToolsModule } from './modules/feishu-tools/feishu-tools.module';
import { ConnectorPrivacyModule } from './modules/connector-privacy/connector-privacy.module';

@Module({
  imports: [
    ConnectorPrivacyModule,
    // 平台 Module，提供平台能力
    PlatformModule.forRoot(),
    // ====== @route-section: business-modules START ======
    ConnectorProbeModule,
    CredentialProbeModule,
    ConnectorAuthStorageModule,
    ConnectorAuthModule,
    FeishuToolsModule,
    // ====== @route-section: business-modules END ======

    // ⚠️ @route-order: last
    // ViewModule is the fallback route module, must be registered last.
    ViewModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
  ],
})
export class AppModule {}
