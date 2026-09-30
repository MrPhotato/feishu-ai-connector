import { createHash } from 'node:crypto';
import type { Response } from 'express';

const ERROR_PAGE_CSS: string = `
:root { color-scheme: light; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center;
  padding: 24px; background: #f5f7fa; color: #17212f; }
main { width: 100%; max-width: 480px; padding: 36px; background: #fff;
  border: 1px solid #dde3eb; border-radius: 16px; box-shadow: 0 8px 32px #17212f08; }
.label { margin: 0 0 20px; color: #526174; font-size: 14px; }
h1 { margin: 0 0 16px; font-size: 26px; line-height: 1.35; }
p { margin: 0; font-size: 16px; line-height: 1.75; overflow-wrap: anywhere; }
a { display: inline-block; margin-top: 24px; padding: 12px 20px; border-radius: 8px;
  background: #2458bd; color: #fff; font-weight: 600; text-decoration: none; }
a:hover { background: #194495; }
a:focus-visible { outline: 3px solid #17212f; outline-offset: 4px; }
.note { margin-top: 20px; color: #526174; font-size: 14px; }
@media (max-width: 420px) { body { padding: 16px; } main { padding: 28px 24px; } }
`;
const ERROR_PAGE_STYLE_HASH: string = createHash('sha256').update(ERROR_PAGE_CSS).digest('base64');

/** Fixed copy only: never include errors, request URLs, codes, state, or retry tickets. */
function sendConnectorBrowserError(response: Response, unavailable: boolean): void {
  if (response.headersSent) { response.end(); return; }
  const title: string = unavailable ? '连接服务暂时不可用' : '飞书连接未完成';
  const message: string = unavailable
    ? '请稍后回到 ChatGPT，重新发起飞书连接。'
    : '本次授权未完成，请回到 ChatGPT，重新发起飞书连接。';
  response.removeHeader('Location');
  response.removeHeader('Refresh');
  response.set({
    'Cache-Control': 'no-store',
    'Pragma': 'no-cache',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': `default-src 'none'; script-src 'none'; ` +
      `style-src 'sha256-${ERROR_PAGE_STYLE_HASH}'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
  });
  response.status(unavailable ? 503 : 400).type('html').send(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${title} · 飞书 AI 连接器</title>
<style>${ERROR_PAGE_CSS}</style>
</head>
<body>
<main aria-labelledby="error-title">
<p class="label">飞书 AI 连接器</p>
<h1 id="error-title">${title}</h1>
<p>${message}</p>
<a href="https://chatgpt.com/" rel="noreferrer">返回 ChatGPT</a>
<p class="note">请关闭此页，无需刷新或返回上一步。</p>
</main>
</body>
</html>`);
}

export { sendConnectorBrowserError };
