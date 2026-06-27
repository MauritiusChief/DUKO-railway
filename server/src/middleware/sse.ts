/**
 * SSE (Server-Sent Events) 连接管理
 *
 * 管理单个客户端 SSE 连接的创建、事件写入、心跳保活和清理。
 */

import type { Response } from 'express';

const HEARTBEAT_MS = 15_000;

export class SSEConnection {
  private res: Response;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(res: Response) {
    this.res = res;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    this.heartbeat = setInterval(() => {
      if (!this.closed) {
        this.res.write(':heartbeat\n\n');
      }
    }, HEARTBEAT_MS);

    res.on('close', () => this.close());
  }

  send(type: string, data: unknown): void {
    if (this.closed) return;
    const payload = JSON.stringify(data);
    this.res.write(`event: ${type}\ndata: ${payload}\n\n`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    this.res.end();
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
