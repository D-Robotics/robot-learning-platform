import http from 'node:http';
import { existsSync } from 'node:fs';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { connectMcp } from './experience.mjs';
import { createPluginAuth } from './plugin-auth.mjs';
import { PluginRequestError, loginRequired, publicFailure } from './plugin-errors.mjs';

export function proxyRequestHeaders(input, body, cookie) {
  const headers = {
    accept: 'application/json',
    ...(body.length ? { 'content-type': 'application/json' } : {}),
    ...(cookie ? { cookie } : {}),
  };
  for (const name of ['x-sim2real-turn-id', 'idempotency-key', 'accept-language', 'if-match'])
    if (typeof input[name] === 'string') headers[name] = input[name];
  return headers;
}
/** The retained core receives only a secret loopback credential; real cookies stay in this owner. */
export async function connectAuthenticatedCore({
  env = process.env,
  fetchImpl = fetch,
  authentication,
  cacheDirectory,
  connect = connectMcp,
} = {}) {
  const auth = authentication ?? createPluginAuth({ env, fetchImpl, cacheDirectory });
  const secret = randomBytes(32).toString('hex');
  const digest = (s) => createHash('sha256').update(s).digest();
  const sendFailure = (res, error) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const value = publicFailure(error);
    res.writeHead(value.httpStatus, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(value));
  };
  const fetchPlatform = async (pathname, options = {}) => {
    const cookie = pathname === '/healthz' ? null : await auth.cookie();
    const response = await fetchImpl(auth.audience + pathname, {
      ...options,
      headers: { ...options.headers, ...(cookie ? { cookie } : {}) },
      redirect: 'error',
      signal: AbortSignal.any([
        ...(options.signal ? [options.signal] : []),
        AbortSignal.timeout(120000),
      ]),
    });
    if (response.status === 401) {
      await auth.invalidate();
      throw loginRequired();
    }
    return response;
  };
  const server = http.createServer(async (req, res) => {
    try {
      const presented = String(req.headers.cookie ?? '');
      if (
        req.headers.origin ||
        !timingSafeEqual(digest(presented), digest('rdk_plugin_proxy=' + secret)) ||
        !/^\/(healthz|api\/sim2real(?:\/|$)|api\/v1\/duck(?:\/|$))/.test(req.url ?? '')
      ) {
        res.writeHead(403);
        res.end();
        return;
      }
      let body = Buffer.alloc(0);
      for await (const chunk of req) {
        body = Buffer.concat([body, chunk]);
        if (body.length > 2 * 1024 * 1024) {
          res.writeHead(413);
          res.end();
          return;
        }
      }
      const controller = new AbortController();
      res.once('close', () => controller.abort());
      const response = await fetchPlatform(req.url ?? '/', {
        method: req.method,
        headers: proxyRequestHeaders(req.headers, body, null),
        ...(body.length ? { body } : {}),
        signal: controller.signal,
      });
      res.writeHead(response.status, {
        'content-type': response.headers.get('content-type') || 'application/json',
        'cache-control': 'no-store',
      });
      if (response.body)
        Readable.fromWeb(response.body)
          .on('error', () => res.destroy())
          .pipe(res);
      else res.end();
    } catch (error) {
      sendFailure(res, error);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const childEnv = {
    ...env,
    RDK_SIM2REAL_MCP_BASE_URL: 'http://127.0.0.1:' + server.address().port,
    RDK_SIM2REAL_MCP_COOKIE: 'rdk_plugin_proxy=' + secret,
  };
  for (const key of [
    'RDK_SIM2REAL_MCP_USERNAME',
    'RDK_SIM2REAL_MCP_PASSWORD',
    'RDK_STUDIO_LOGIN_SESSION',
    'RDK_STUDIO_LOGIN_ACCOUNT',
    'RDK_STUDIO_LOGIN_ORIGIN',
  ])
    delete childEnv[key];
  let upstream;
  try {
    upstream = connect({
      env: childEnv,
      ...(existsSync(new URL('./start-core-mcp.mjs', import.meta.url))
        ? { args: [fileURLToPath(new URL('./start-core-mcp.mjs', import.meta.url))] }
        : {}),
    });
  } catch (error) {
    await new Promise((resolve) => server.close(resolve));
    throw error;
  }
  let closed = false;
  return {
    authentication: auth,
    async readModels({ signal } = {}) {
      const response = await fetchPlatform('/api/v1/duck/models', {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal,
      });
      if (!response.ok)
        throw new PluginRequestError(
          response.status === 403 ? 'PERMISSION_DENIED' : 'PLATFORM_REQUEST_REJECTED',
          '无法读取当前账号的课程模型。',
          { httpStatus: response.status },
        );
      const chunks = [];
      let size = 0;
      if (response.body)
        for await (const chunk of response.body) {
          size += chunk.byteLength;
          if (size > 2 * 1024 * 1024)
            throw new PluginRequestError('MODEL_RESPONSE_TOO_LARGE', '模型清单超出读取预算。');
          chunks.push(Buffer.from(chunk));
        }
      let value;
      try {
        value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new PluginRequestError('MODEL_RESPONSE_INVALID', '平台未返回有效的模型清单。');
      }
      if (!Array.isArray(value?.models))
        throw new PluginRequestError('MODEL_RESPONSE_INVALID', '平台未返回明确的模型清单。');
      return value;
    },
    notify(method, params) {
      return upstream.notify(method, params);
    },
    async request(method, params, options) {
      const result = await upstream.request(method, params, options);
      if (method === 'tools/call' && params.name === 'rdk_platform_status' && !result.isError) {
        let value = result.structuredContent;
        if (!value) {
          try {
            value = JSON.parse(result.content?.find((c) => c.type === 'text')?.text);
          } catch {}
        }
        if (value) {
          value = { ...value, baseUrl: auth.audience, authMode: auth.mode };
          if (value.session?.authenticated !== true) value.authentication = await auth.status();
          return {
            ...result,
            structuredContent: value,
            content: [{ type: 'text', text: JSON.stringify(value) }],
          };
        }
      }
      return result;
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await upstream.close();
      } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    },
  };
}
