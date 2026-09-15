import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createResponseCompressionMiddleware } from './response-compression.js';

// 只测中间件本身（JSON 压缩路径 + SSE 直通 + 小响应跳过）；静态文件路径
// 依赖磁盘布局，由浏览器端到端验证覆盖。
// 注意：不能用裸 fetch 验证线上字节——undici 会自动补发 Accept-Encoding 并
// 透明解压 gzip，这里用 http.get 控制真实的 wire 格式。

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function httpGet(url: string, acceptEncoding?: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = http.get(
      url,
      { headers: acceptEncoding ? { 'accept-encoding': acceptEncoding } : undefined },
      (message) => {
        const chunks: Buffer[] = [];
        message.on('data', (chunk: Buffer) => chunks.push(chunk));
        message.on('end', () => {
          resolve({
            status: message.statusCode ?? 0,
            headers: message.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    request.on('error', reject);
  });
}

// 与 response-compression.ts 的 PUBLIC_ROOT_INTERNAL 同一公式。
const PUBLIC_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../services/sim2real-web/public',
);

describe('response compression middleware', () => {
  let server: Server | null = null;

  afterEach(() => {
    server?.close();
    server = null;
  });

  function startApp(handler: express.RequestHandler): Promise<string> {
    const app = express();
    app.use(createResponseCompressionMiddleware());
    app.get('/api/thing', (_req, res) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: true, blob: 'x'.repeat(2048) }));
    });
    app.get('/api/stream', (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.end('data: hello\n\n');
    });
    app.use(handler);
    return new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`);
      });
    });
  }

  it('always declares a MIME Content-Type with charset when serving compressed static files', async () => {
    // 回归：静态压缩分支曾绕过 express.static 丢掉 Content-Type——
    // nosniff 会让浏览器拒收无 MIME 的 CSS/JS，charset 丢失则 HTML 乱码。
    // 中间件按模块位置反解 PUBLIC_ROOT；theme-boot.js 是其中确定存在的小文件。
    const file = await stat(path.join(PUBLIC_ROOT, 'theme-boot.js')).then(
      () => 'theme-boot.js',
      () => null,
    );
    expect(file).not.toBeNull();
    const app = express();
    app.use(createResponseCompressionMiddleware());
    const base = await new Promise<string>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`);
      });
    });
    const res = await httpGet(base + '/theme-boot.js', 'gzip');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(zlib.gunzipSync(res.body).length).toBeGreaterThan(0);
  });

  it('compresses a JSON response for gzip-capable clients', async () => {
    const base = await startApp(express.json());
    const raw = await httpGet(base + '/api/thing', 'gzip');
    expect(raw.status).toBe(200);
    expect(raw.headers['content-encoding']).toBe('gzip');
    const payload = JSON.parse(zlib.gunzipSync(raw.body).toString('utf-8'));
    expect(payload.ok).toBe(true);
    expect(payload.blob).toHaveLength(2048);
  });

  it('passes through unchanged for clients that do not accept gzip', async () => {
    const base = await startApp(express.json());
    const raw = await httpGet(base + '/api/thing', 'identity');
    expect(raw.status).toBe(200);
    expect(raw.headers['content-encoding']).toBeUndefined();
    const payload = JSON.parse(raw.body.toString('utf-8'));
    expect(payload.ok).toBe(true);
    expect(payload.blob).toHaveLength(2048);
  });

  it('never compresses an SSE stream', async () => {
    const base = await startApp(express.json());
    const response = await fetch(base + '/api/stream', {
      headers: { 'Accept-Encoding': 'gzip' },
    });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(await response.text()).toBe('data: hello\n\n');
  });

  it('declares Vary: Accept-Encoding on compressed responses', async () => {
    const base = await startApp(express.json());
    const response = await fetch(base + '/api/thing', {
      headers: { 'Accept-Encoding': 'gzip' },
    });
    expect(String(response.headers.get('vary'))).toMatch(/accept-encoding/i);
  });
});
