import { Logger } from '@nestjs/common';

type DiagnosticWriter = (message: string) => void;
const logger: Logger = new Logger('FeishuAttachmentDiagnostics');
const commands: Record<string, string> = {
  mail: 'mail.user_mailbox.message.attachments.download_url',
  message: 'im.+messages-resources-download', drive: 'drive.+download', docx: 'drive.+export',
};
const stages: readonly string[] = ['account', 'cli', 'result_validation', 'file_delivery'];
const failureCodes: readonly string[] = ['none', 'cli_timeout', 'cli_invalid_output', 'cli_runtime_unavailable',
  'cli_output_limit', 'cli_file_limit', 'cli_file_output_invalid', 'cli_file_sensitive_output',
  'attachment_timeout', 'attachment_download_failed', 'attachment_file_invalid', 'attachment_file_unavailable',
  'attachment_response_invalid', 'attachment_partial_failure', 'attachment_export_pending', 'cli_operation_failed',
  'file_delivery_unavailable', 'file_delivery_timeout', 'file_delivery_invalid', 'feishu_scope_missing',
  'feishu_reauthorization_required', 'refresh_in_progress', 'refresh_uncertain'];
const errorTypes: readonly string[] = ['api', 'auth', 'validation', 'network', 'internal', 'runtime',
  'api_error', 'auth_error', 'validation_error', 'network_error', 'internal_error'];
const errorSubtypes: readonly string[] = ['api_error', 'api_failed', 'http_error', 'request_failed', 'timeout',
  'permission_denied', 'scope_missing', 'invalid_argument', 'invalid_arguments', 'not_found', 'unauthorized',
  'token_expired', 'rate_limit', 'rate_limited', 'operation_failed'];

function member(value: unknown, allowed: readonly string[], fallback: string): string {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Fixed labels and bounded numbers only; never log argv, exception text, output or file links. */
class FeishuAttachmentDiagnostics {
  constructor(private readonly write: DiagnosticWriter = (message: string): void => logger.log(message)) {}

  stage(source: unknown, stage: unknown, ok: boolean, durationMs: number,
    failureCode: unknown = 'none', exitCode?: unknown, output?: unknown): void {
    const safeSource: string = member(source, Object.keys(commands), 'other');
    const error: Record<string, unknown> | undefined = object(output) && object(output.error) ? output.error : undefined;
    const numericCode: unknown = error?.code;
    const record: Record<string, string | number | boolean> = {
      event: 'connector_attachment', source: safeSource, command: commands[safeSource] ?? 'other',
      stage: member(stage, stages, 'other'), ok: ok === true,
      durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? Math.round(durationMs) : 0,
      failureCode: member(failureCode, failureCodes, 'other'),
    };
    if (exitCode !== undefined) record.exitCode = typeof exitCode === 'number' && Number.isInteger(exitCode) &&
      exitCode >= -1 && exitCode <= 255 ? exitCode : -1;
    if (error) {
      record.providerCode = typeof numericCode === 'number' && Number.isSafeInteger(numericCode) &&
        numericCode >= 0 && numericCode <= 2147483647 ? numericCode : -1;
      record.errorType = member(error.type, errorTypes, 'other');
      record.errorSubtype = member(error.subtype, errorSubtypes, 'other');
    }
    try { this.write(JSON.stringify(record)); } catch { /* Logging cannot change the operation outcome. */ }
  }
}

const feishuAttachmentDiagnostics: FeishuAttachmentDiagnostics = new FeishuAttachmentDiagnostics();
export { FeishuAttachmentDiagnostics, feishuAttachmentDiagnostics };
