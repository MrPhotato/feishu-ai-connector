import React, { useEffect, useState } from 'react';
import { ArrowUpRight, ChevronDown, Copy, Link2 } from 'lucide-react';
import type { ConnectorStatus } from '@shared/api.interface';
import { connectorHome } from '@client/src/api';
import { Button } from '@client/src/components/ui/button';

const ConnectorHome: React.FC = () => {
  const [status, setStatus] = useState<ConnectorStatus | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<boolean>(false);
  const [copyMessage, setCopyMessage] = useState<string>('');
  const [attempt, setAttempt] = useState<number>(0);

  useEffect(() => {
    const controller: AbortController = new AbortController();
    setLoading(true);
    setError(false);
    connectorHome.getStatus(controller.signal).then((result: ConnectorStatus): void => {
      setStatus(result);
    }).catch((): void => {
      if (!controller.signal.aborted) {
        setStatus(null);
        setError(true);
      }
    }).finally((): void => { if (!controller.signal.aborted) setLoading(false); });
    return (): void => controller.abort();
  }, [attempt]);

  const ready: boolean = Boolean(status?.configured && !loading && !error);
  const serviceLabel: string = loading ? '正在检查服务' : error ? '服务暂不可用' : ready ? '服务在线' : '服务配置中';
  const copyAddress = async (): Promise<void> => {
    if (!ready || !status) return;
    try {
      await navigator.clipboard.writeText(status.mcpUrl);
      setCopyMessage('连接地址已复制');
    } catch {
      setCopyMessage('请展开“首次连接设置”，手动复制连接地址。');
    }
  };

  return (
    <main className="min-h-screen bg-background px-6 py-14 text-foreground sm:px-8 sm:py-24">
      <div className="mx-auto w-full min-w-0 max-w-xl">
        <header>
          <div className="mb-8 flex items-center justify-between gap-4">
            <div className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Link2 className="size-5" aria-hidden="true" />
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status" aria-live="polite">
              <span className={`size-1.5 rounded-full ${ready ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`}
                aria-hidden="true" />
              <span>{serviceLabel}</span>
              {error && (
                <Button variant="ghost" size="sm" onClick={(): void => setAttempt(attempt + 1)}
                  data-ai-section-type="button">重试</Button>
              )}
            </div>
          </div>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">飞书 AI 连接器</h1>
          <p className="mt-5 max-w-md text-base leading-8 text-muted-foreground">
            在 ChatGPT 中查询消息和文档，并按你的指令处理工作。
          </p>
        </header>

        <div className="mt-9 flex flex-col gap-3 sm:flex-row">
          <Button asChild size="lg" className="min-h-11 sm:px-6" data-ai-section-type="button">
            <a href="https://chatgpt.com/plugins" target="_blank" rel="noopener noreferrer">
              前往 ChatGPT<ArrowUpRight aria-hidden="true" />
            </a>
          </Button>
          <Button variant="outline" size="lg" className="min-h-11 sm:px-6" disabled={!ready}
            onClick={copyAddress} data-ai-section-type="button">
            <Copy aria-hidden="true" />复制连接地址
          </Button>
        </div>
        <p className="mt-3 min-h-5 text-xs leading-5 text-muted-foreground" role="status" aria-live="polite">
          {copyMessage}
        </p>

        <details className="group mt-7 border-y border-border/70 py-5">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-sm font-medium
            focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
            [&::-webkit-details-marker]:hidden">
            首次连接设置
            <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180"
              aria-hidden="true" />
          </summary>
          <div className="pt-5 text-sm">
            <p className="mb-5 leading-6 text-muted-foreground">在 ChatGPT 中创建自定义连接，填写以下信息：</p>
            <dl className="space-y-4">
              <div>
                <dt className="mb-2 text-xs text-muted-foreground">连接地址</dt>
                <dd className="select-all break-all rounded-md bg-muted/50 px-3 py-2.5 text-xs leading-6">
                  {status?.mcpUrl || '服务就绪后显示'}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-muted-foreground">认证方式</dt>
                <dd className="font-medium">OAuth</dd>
              </div>
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-muted-foreground">客户端 ID</dt>
                <dd className="select-all font-mono text-xs">chatgpt</dd>
              </div>
            </dl>
            <p className="mt-5 text-xs leading-6 text-muted-foreground">无需填写客户端密钥。创建后按提示完成飞书授权。</p>
            <p className="mt-2 text-xs leading-6 text-muted-foreground">
              高级设置：基础范围留空，关闭 OIDC；默认范围保留 feishu.read 和 feishu.write。
            </p>
          </div>
        </details>
        <p className="mt-6 text-xs leading-6 text-muted-foreground">访问范围以本人飞书授权为准。</p>
      </div>
    </main>
  );
};

export default ConnectorHome;
