import { BadRequestException, Controller, Get, Header, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { CredentialProbeService } from './credential-probe.service';
import type { CredentialProbeResult, CredentialProbeRole } from '@shared/api.interface';

function validateProbeRequest(request: Request): CredentialProbeRole {
  const body: unknown = request.body;
  const hasEmptyBody: boolean = body === undefined || body === null || (
    typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0
  );
  if (Object.keys(request.query).length > 0 || !hasEmptyBody) {
    throw new BadRequestException('This fixed synthetic probe accepts no parameters.');
  }
  if (request.userContext?.isSystemAccount === true) {
    return 'system';
  }
  return request.userContext?.userId ? 'authenticated' : 'anonymous';
}

// Intentionally public: verifies anonymous/session RLS using only synthetic rows.
// Platform identity is observed, never written or replaced by this controller.
@Controller('credential-probe')
class CredentialProbeController {
  constructor(private readonly probe: CredentialProbeService) {}

  @Post('check')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  check(@Req() request: Request): Promise<CredentialProbeResult> {
    return this.probe.check(validateProbeRequest(request));
  }

  @Get('observe')
  @Header('Cache-Control', 'no-store')
  observe(@Req() request: Request): Promise<Pick<CredentialProbeResult, 'roleCategory' | 'read'>> {
    return this.probe.observeRead(validateProbeRequest(request));
  }
}

export { CredentialProbeController, validateProbeRequest };
