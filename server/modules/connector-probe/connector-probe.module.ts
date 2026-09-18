import { Module } from '@nestjs/common';
import { ConnectorProbeController } from './connector-probe.controller';

@Module({ controllers: [ConnectorProbeController] })
export class ConnectorProbeModule {}
