// 零依赖响应压缩：Node 内建 zlib，不引入 compression 包（发行版保持
// 除 express 外零运行时依赖）。
//
// 两条路径：
// 1. 静态文本资源（js/css/html/json/svg/geojson）：整文件 gzip，结果按
//    (path, mtime) 缓存在内存。启动后每个文件只压缩一次，比逐请求流式
//    压缩更快且行为可预测。仅当 URL 带 ?v= 版本参数或生产模式时缓存
//    头允许长缓存。
// 2. API JSON：请求级流式 gzip（res.end 拦截），healthz 这类小响应
//    (<1KB) 自动跳过。
//
// 安全边界：
// - text/event-stream（SSE）绝不压缩——缓冲会杀死事件流；
// - 已带 Content-Encoding 的响应（microduck 代理 stream 分支）跳过；
// - 204/304/HEAD 不动 body；
// - 未声明接受 gzip 的客户端直通。
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { gzip, constants as zlibConstants } from 'node:zlib';

const COMPRESSIBLE_EXT = new Set([
  '.js',
  '.mjs',
  '.css',
  '.html',
  '.json',
  '.svg',
  '.geojson',
  '.txt',
  '.map',
]);
// 该分支绕过 express.static，必须自己补 MIME——否则 charset 丢失（HTML
// 乱码），且 X-Content-Type-Options: nosniff 会让浏览器拒收无 MIME 的
// CSS/JS（整页样式崩塌）。取值对齐 express.send 的默认类型表。
const MIME_BY_EXT: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.geojson': 'application/geo+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};
const COMPRESSIBLE_MIME =
  /^(?:text\/|application\/(?:json|javascript|xml|manifest\+json|ld\+json))/i;
const JSON_MIN_BYTES = 1024;
const GZIP_OPTS = { level: zlibConstants.Z_DEFAULT_COMPRESSION, memLevel: 8 };
const MAX_CACHE_BYTES = 32 * 1024 * 1024;

interface CachedEntry {
  data: Buffer;
  mtimeMs: number;
}

const staticCache = new Map<string, CachedEntry>();

interface ZlibError extends Error {
  errno?: number;
}

function acceptsGzip(request: Request): boolean {
  const header = request.headers['accept-encoding'];
  const value = Array.isArray(header) ? header[0] : header;
  return /\b(?:gzip|x-gzip)\b/i.test(String(value || ''));
}

export function createResponseCompressionMiddleware(): RequestHandler {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (!acceptsGzip(request) || request.method !== 'GET') {
      next();
      return;
    }
    const ext = path.extname(request.path || '');
    if (COMPRESSIBLE_EXT.has(ext)) {
      // 首页与 /index.html 由动态入口处理（需注入 base-path meta），
      // 其余压缩交给静态分支。
      if (request.path === '/' || request.path === '/index.html') {
        patchJsonResponse(request, response);
        next();
        return;
      }
      void serveCompressedStatic(request, response, next);
      return;
    }
    patchJsonResponse(request, response);
    next();
  };
}

// ---------- 路径 1：静态文件整文件压缩 + mtime 缓存 ----------

async function serveCompressedStatic(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const ext = path.extname(request.path || '');
    const filePath = resolveStaticFile(request.path);
    if (!filePath) {
      patchJsonResponse(request, response);
      next();
      return;
    }
    const info = await stat(filePath);
    if (!info.isFile() || info.size > MAX_CACHE_BYTES) {
      patchJsonResponse(request, response);
      next();
      return;
    }
    const cached = staticCache.get(filePath);
    let data: Buffer;
    if (cached && cached.mtimeMs === info.mtimeMs) {
      data = cached.data;
    } else {
      const raw = await readFile(filePath);
      data = await gzipAsync(raw);
      staticCache.set(filePath, { data, mtimeMs: info.mtimeMs });
      if (staticCache.size > 64) {
        // 简单的容量上限：最早的条目先走（插入序即访问近似）。
        const oldest = staticCache.keys().next().value;
        if (oldest) staticCache.delete(oldest);
      }
    }
    response.setHeader('Content-Type', MIME_BY_EXT[ext] ?? 'application/octet-stream');
    response.setHeader('Content-Encoding', 'gzip');
    response.setHeader('Content-Length', String(data.length));
    response.setHeader('Vary', 'Accept-Encoding');
    response.setHeader('ETag', buildGzipEtag(data));
    // 与 express.static 的 setHeaders 策略对齐：HTML 入口必须可再验证，
    // 才能及时拿到 cache-busted 资源（app.js?v=…）的新引用。
    if (ext === '.html' || request.path.includes('/originbot-sim/')) {
      response.setHeader('Cache-Control', 'no-cache');
    } else if (request.query.v !== undefined) {
      response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      response.setHeader('Cache-Control', 'public, max-age=0');
    }
    // sendFile 分支不再进入；直接把压缩字节发出去。
    // Express Response#end 透传底层 http 签名：`as never` keeps the call
    // compiling without pretending the Express overloads accept this shape.
    response.end(data as never, 'utf-8' as never, undefined as never);
  } catch {
    // 文件不存在或读失败：交回静态/SPA 路由处理（会走 404 或 fallback）。
    patchJsonResponse(request, response);
    next();
  }
}

function resolveStaticFile(urlPath: string): string | null {
  const clean = path.posix.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  if (clean.includes('..')) return null;
  const target = path.join(PUBLIC_ROOT_INTERNAL, clean);
  if (!target.startsWith(PUBLIC_ROOT_INTERNAL + path.sep) && target !== PUBLIC_ROOT_INTERNAL)
    return null;
  return target;
}

// PUBLIC_ROOT 与 server.ts 的静态目录一致；通过模块 URL 解析避免循环导入。
const PUBLIC_ROOT_INTERNAL = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../services/sim2real-web/public',
);

function buildGzipEtag(data: Buffer): string {
  const hash = createHash('sha1').update(data).digest('hex').slice(0, 16);
  return `"gz-${hash}"`;
}

function gzipAsync(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    gzip(input, GZIP_OPTS, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

// ---------- 路径 2：API JSON 请求级压缩 ----------

function patchJsonResponse(request: Request, response: Response): void {
  if (request.method === 'HEAD') return;
  const originalEnd = response.end.bind(response);
  let decided = false;
  let compressing = false;

  function decide(): boolean {
    if (decided) return compressing;
    decided = true;
    if (response.headersSent) return (compressing = false);
    if (response.getHeader('content-encoding')) return (compressing = false);
    const contentType = String(response.getHeader('content-type') || '');
    // SSE 与非文本直通。
    if (/text\/event-stream/i.test(contentType)) return (compressing = false);
    if (!COMPRESSIBLE_MIME.test(contentType)) return (compressing = false);
    const contentLength = Number(response.getHeader('content-length') || 0);
    // 已知长度的小 JSON 压缩得不偿失（gzip 头开销 + CPU）。
    if (contentLength > 0 && contentLength < JSON_MIN_BYTES) return (compressing = false);
    compressing = true;
    response.removeHeader('content-length');
    response.setHeader('Content-Encoding', 'gzip');
    const vary = String(response.getHeader('vary') || '');
    if (!/accept-encoding/i.test(vary)) {
      response.setHeader('Vary', vary ? vary + ', Accept-Encoding' : 'Accept-Encoding');
    }
    return compressing;
  }

  response.end = function patchedEnd(
    chunk?: unknown,
    encoding?: unknown,
    cb?: unknown,
  ): typeof response {
    if (!decide()) {
      return originalEnd(chunk as never, encoding as never, cb as never);
    }
    let payload: Buffer | string | undefined;
    if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) payload = chunk;
    gzip(payload ?? Buffer.alloc(0), GZIP_OPTS, (error, result) => {
      if (error) {
        // Content-Encoding 已声明无法回收；GET 幂等，断连让客户端重试。
        response.destroy();
        return;
      }
      if (!response.headersSent) {
        response.setHeader('Content-Length', String(result.length));
      }
      // http.ServerResponse#end accepts (chunk, encoding?, cb?) — passing the
      // callback in the third slot without an encoding is valid at runtime;
      // the overloads just refuse `undefined` literals, hence the assertion.
      originalEnd(result as never, undefined as unknown as BufferEncoding, cb as never);
    });
    return response;
  };
}
