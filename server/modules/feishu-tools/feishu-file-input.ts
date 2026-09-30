import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { z } from 'zod';
import type { ClientRequest } from 'node:http';
import type { LookupAddress } from 'node:dns';
import { safeCliFileName } from './feishu-cli.files';

// All four fields are declared for the ChatGPT fileParams contract. Only ID and URL are required.
const hostFileSchema = z.object({
  download_url: z.string().url().max(16000), file_id: z.string().min(1).max(500),
  mime_type: z.string().max(200).optional(),
  file_name: z.string().max(128).refine(safeCliFileName, '文件名不受支持').optional(),
}).strict();
type HostFile = z.output<typeof hostFileSchema>;
interface InputFile { name: string; base64: string; mimeType?: string }
const INPUT_LIMIT: number = 10 * 1024 * 1024;

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c]: number[] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  // Only ordinary global unicast IPv6, excluding transition/special/documentation ranges.
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/iu.test(address) &&
    !/^200[12]:/iu.test(address) && !/^3fff:/iu.test(address);
}
function inputUrl(value: string): URL {
  const url: URL = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
    isIP(url.hostname) || !url.hostname.includes('.') || url.hostname.endsWith('.local') ||
    url.hostname.endsWith('.internal')) throw new Error('file_input_url_invalid');
  return url;
}

/** No cookies/Authorization are forwarded. Every redirect is DNS-checked and connected to the checked IP. */
async function downloadInput(value: string, deadline: number, limit: number, redirects: number = 0): Promise<Buffer> {
  const url: URL = inputUrl(value);
  const addresses: LookupAddress[] = await new Promise((accept, reject): void => {
    const timer: NodeJS.Timeout = setTimeout((): void => reject(new Error('file_input_timeout')),
      Math.max(1, deadline - Date.now()));
    lookup(url.hostname, { all: true, verbatim: true }).then(accept,
      (): void => reject(new Error('file_input_unavailable'))).finally((): void => clearTimeout(timer));
  });
  if (!addresses.length || addresses.some((item): boolean => !publicAddress(item.address))) {
    throw new Error('file_input_url_invalid');
  }
  if (Date.now() >= deadline) throw new Error('file_input_timeout');
  const selected: LookupAddress = addresses.find((item): boolean => item.family === 4) ?? addresses[0];
  type Hop = { kind: 'redirect'; url: string } | { kind: 'file'; bytes: Buffer };
  const hop: Hop = await new Promise<Hop>((accept, reject): void => {
    let settled: boolean = false;
    let responded: boolean = false;
    let req: ClientRequest | undefined;
    const finish = (error?: string, result?: Hop): void => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(new Error(error));
      else if (result) accept(result);
    };
    const timer: NodeJS.Timeout = setTimeout((): void => {
      finish('file_input_timeout'); req?.destroy();
    }, Math.max(1, deadline - Date.now()));
    try { req = request(url, {
      method: 'GET', agent: false, family: selected.family,
      lookup: (_hostname, _options, callback): void => callback(null, selected.address, selected.family),
      headers: { Accept: '*/*', 'Accept-Encoding': 'identity' },
    }, (response): void => {
      responded = true;
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
        try {
          if (redirects >= 3 || !response.headers.location) finish('file_input_url_invalid');
          else finish(undefined, { kind: 'redirect', url: new URL(response.headers.location, url).href });
        } catch { finish('file_input_url_invalid'); }
        response.destroy(); req?.destroy();
        return;
      }
      const length: string | undefined = response.headers['content-length'];
      if (response.statusCode !== 200 || (length !== undefined &&
        (!/^\d+$/u.test(length) || Number(length) > limit)) ||
        (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
        finish('file_input_unavailable'); response.destroy(); req?.destroy(); return;
      }
      const chunks: Buffer[] = [];
      let total: number = 0;
      response.on('data', (chunk: Buffer): void => {
        if (settled) return;
        total += chunk.length;
        if (total > limit) { finish('file_input_limit'); response.destroy(); req?.destroy(); return; }
        chunks.push(chunk);
      });
      response.on('end', (): void => {
        if (!response.complete || (length !== undefined && Number(length) !== total)) finish('file_input_unavailable');
        else finish(undefined, { kind: 'file', bytes: Buffer.concat(chunks) });
      });
      response.on('error', (): void => finish('file_input_unavailable'));
      response.on('aborted', (): void => finish('file_input_unavailable'));
      response.on('close', (): void => { if (!settled) finish('file_input_unavailable'); });
    });
    req.on('close', (): void => { if (!responded) finish('file_input_unavailable'); });
    req.on('error', (): void => finish('file_input_unavailable'));
    req.end();
    } catch { finish('file_input_unavailable'); req?.destroy(); }
  });
  return hop.kind === 'file' ? hop.bytes : downloadInput(hop.url, deadline, limit, redirects + 1);
}

async function materializeHostFiles(files: HostFile[] | undefined): Promise<InputFile[]> {
  const inputs: HostFile[] = z.array(hostFileSchema).max(20).parse(files ?? []);
  if (!inputs.length) return [];
  const names: Set<string> = new Set();
  const output: InputFile[] = [];
  let total: number = 0;
  const prepared: Array<{ file: HostFile; name: string }> = [];
  for (const [index, file] of inputs.entries()) {
    const name: string = file.file_name ?? `file-${index + 1}.bin`;
    if (!safeCliFileName(name) || names.has(name.toLowerCase())) {
      throw new Error('file_input_name_invalid');
    }
    inputUrl(file.download_url);
    names.add(name.toLowerCase());
    prepared.push({ file, name });
  }
  const batchDeadline: number = Date.now() + 30000;
  for (const { file, name } of prepared) {
    if (Date.now() >= batchDeadline || total >= 20 * 1024 * 1024) throw new Error('file_input_limit');
    const bytes: Buffer = await downloadInput(file.download_url, Math.min(batchDeadline, Date.now() + 15000),
      Math.min(INPUT_LIMIT, 20 * 1024 * 1024 - total));
    total += bytes.length;
    if (total > 20 * 1024 * 1024) throw new Error('file_input_limit');
    output.push({ name, base64: bytes.toString('base64'), mimeType: file.mime_type });
  }
  return output;
}

export { hostFileSchema, materializeHostFiles, publicAddress, inputUrl };
export type { HostFile };
