import { Module, RequestMethod } from '@nestjs/common';
import type { MiddlewareConsumer, NestModule } from '@nestjs/common';
import { connectorPrivacyMiddleware } from './connector-privacy.middleware';

@Module({})
class ConnectorPrivacyModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(connectorPrivacyMiddleware).forRoutes({ path: '*', method: RequestMethod.ALL });
  }
}
export { ConnectorPrivacyModule };
