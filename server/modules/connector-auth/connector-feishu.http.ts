import type { FeishuHttp, FeishuHttpResponse } from './connector-auth.types';

/** Avoid platform HTTP logging interceptors for authorization codes and credentials. */
export const connectorFeishuHttp: FeishuHttp = async (url, init): Promise<FeishuHttpResponse> => {
  try {
    if (!['https://accounts.feishu.cn/oauth/v3/token',
      'https://open.feishu.cn/open-apis/authen/v1/user_info'].includes(url)) throw new Error('Invalid endpoint');
    const response: globalThis.Response = await fetch(url, {
      ...init, redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    const maximumBytes: number = 262144;
    if (Number(response.headers.get('content-length')) > maximumBytes || !response.body) {
      await response.body?.cancel();
      throw new Error('Invalid response');
    }
    const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length: number = 0;
    try {
      while (true) {
        const part: ReadableStreamReadResult<Uint8Array> = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > maximumBytes) {
          await reader.cancel();
          throw new Error('Invalid response');
        }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return { ok: response.ok, body };
  } catch {
    // Never attach fetch errors or response bodies: they may contain upstream secrets.
    throw new Error('Feishu authorization service unavailable');
  }
};
