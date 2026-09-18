import { Controller, Header, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { validateProbeRequest } from './credential-probe.controller';
import { CredentialProbeService } from './credential-probe.service';
import type { CredentialProbeResult } from '@shared/api.interface';

// The managed gateway authenticates this path with a route-scoped API Key.
// No business-code identity elevation or authentication replacement is used.
@Controller('openapi/credential-probe')
class CredentialProbeOpenapiController {
  constructor(private readonly probe: CredentialProbeService) {}

  @Post('check')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  credentialStorageProbeCheck(@Req() request: Request): Promise<CredentialProbeResult> {
    validateProbeRequest(request);
    return this.probe.check('apiKey');
  }
}

export { CredentialProbeOpenapiController };
