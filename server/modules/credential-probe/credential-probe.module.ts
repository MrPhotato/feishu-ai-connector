import { Module } from '@nestjs/common';
import { CredentialProbeController } from './credential-probe.controller';
import { CredentialProbeOpenapiController } from './credential-probe.openapi.controller';
import { CredentialProbeService } from './credential-probe.service';

@Module({
  controllers: [CredentialProbeController, CredentialProbeOpenapiController],
  providers: [CredentialProbeService],
})
class CredentialProbeModule {}

export { CredentialProbeModule };
