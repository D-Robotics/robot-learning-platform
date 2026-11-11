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
  const fetchPlatform = async (pathname, options = {}, accountId) => {
    const cookie = pathname === '/healthz' ? null : await auth.cookie({ accountId });
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
      if (cookie) await auth.invalidate(cookie);
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
    async readTrainingRun(runId, { signal } = {}) {
      if (typeof runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(runId))
        throw Error('原 Run 标识无效。');
      const response = await fetchPlatform('/api/v1/duck/runs/' + encodeURIComponent(runId), {
        headers: { accept: 'application/json' },
        signal,
      });
      const value = await response.json();
      if (!response.ok || value.run?.id !== runId)
        throw Error('当前账号无法读取这条 Run，请核对原运行链接。');
      return value.run;
    },
    async verifyLegacyDanceVideo(runId, receipt, { signal } = {}) {
      if (
        typeof runId !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(runId) ||
        !/^[a-f0-9]{64}$/.test(receipt?.sha256 ?? '') ||
        !Number.isSafeInteger(receipt.sizeBytes) ||
        receipt.sizeBytes < 1 ||
        receipt.sizeBytes > 50 * 1024 * 1024
      )
        return null;
      const route = '/api/v1/duck/runs/' + encodeURIComponent(runId) + '/dance-video';
      try {
        const response = await fetchPlatform(route, {
          headers: { accept: 'video/mp4' },
          signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
        });
        if (
          !response.ok ||
          response.headers.get('content-type')?.split(';')[0] !== 'video/mp4' ||
          !response.body ||
          (response.headers.has('content-length') &&
            Number(response.headers.get('content-length')) !== receipt.sizeBytes)
        ) {
          await response.body?.cancel().catch(() => {});
          return null;
        }
        const reader = response.body.getReader();
        const digest = createHash('sha256');
        let size = 0;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > receipt.sizeBytes) {
            await reader.cancel();
            return null;
          }
          digest.update(value);
        }
        return size === receipt.sizeBytes && digest.digest('hex') === receipt.sha256
          ? '.' + route
          : null;
      } catch {
        signal?.throwIfAborted();
        return null;
      }
    },
    async workshopSession(operation, input = {}, { signal, accountId } = {}) {
      if (!['list', 'create', 'select', 'read'].includes(operation)) throw Error('课程操作无效。');
      if (
        ['select', 'read'].includes(operation) &&
        !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(input.contextId ?? '')
      )
        throw Error('课程标识无效。');
      const suffix =
        operation === 'select'
          ? '/' + encodeURIComponent(input.contextId) + '/select'
          : operation === 'read'
            ? '/' + encodeURIComponent(input.contextId)
            : '';
      const write = ['create', 'select'].includes(operation);
      const response = await fetchPlatform(
        '/api/v1/duck/workshop-sessions' + suffix,
        {
          method: write ? 'POST' : 'GET',
          headers: {
            accept: 'application/json',
            ...(write ? { 'content-type': 'application/json' } : {}),
          },
          ...(write ? { body: JSON.stringify(operation === 'select' ? {} : input) } : {}),
          signal,
        },
        accountId,
      );
      const chunks = [];
      let size = 0;
      if (response.body)
        for await (const chunk of response.body) {
          size += chunk.byteLength;
          if (size > 65536) throw Error('课程回执超出预算。');
          chunks.push(Buffer.from(chunk));
        }
      let value;
      try {
        value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw Error('课程接口没有返回有效回执。');
      }
      if (!response.ok || value.ok !== true || value.schemaVersion !== 1)
        throw new PluginRequestError(
          value.code ?? 'WORKSHOP_UNAVAILABLE',
          value.message ?? '课程接口尚未就绪，请更新平台服务。',
          { httpStatus: response.status },
        );
      return value;
    },
    async developmentTarget(operation, { accountId, targetId, signal } = {}) {
      if (!accountId || !['compute', 'boards', 'test-compute', 'connect-board'].includes(operation))
        throw Error('请选择当前账号下的明确设备。');
      const write = operation === 'test-compute' || operation === 'connect-board';
      if (write && (typeof targetId !== 'string' || !targetId.trim() || targetId.length > 160))
        throw Error('设备标识无效。');
      const path =
        operation === 'compute' || operation === 'test-compute'
          ? '/api/sim2real/compute-resources'
          : '/api/sim2real/device-connections';
      const suffix = write
        ? '/' + encodeURIComponent(targetId) + (operation === 'test-compute' ? '/test' : '/connect')
        : '';
      const response = await fetchPlatform(
        path + suffix,
        {
          method: write ? 'POST' : 'GET',
          headers: {
            accept: 'application/json',
            ...(write ? { 'content-type': 'application/json' } : {}),
          },
          ...(write ? { body: '{}' } : {}),
          signal,
        },
        accountId,
      );
      const message = write
        ? '平台未能完成设备连接检查，请到学习平台查看该设备的状态。'
        : '当前账号暂时无法读取这类设备。';
      if (!response.ok)
        throw new PluginRequestError('DEVELOPMENT_TARGET_UNAVAILABLE', message, {
          httpStatus: response.status,
        });
      const value = await response.json();
      if (value?.ok !== true) throw Error(message);
      return value;
    },
    async experimentSession(operation, input = {}, { signal } = {}) {
      if (!['capabilities', 'remember', 'resume'].includes(operation))
        throw new PluginRequestError('EXPERIMENT_INVALID_OPERATION', '实验会话操作无效。');
      if (
        operation !== 'capabilities' &&
        !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(input.contextId ?? '')
      )
        throw new PluginRequestError('EXPERIMENT_INVALID_ID', '请选择明确实验。');
      const pathname =
        '/api/v1/duck/experiments' +
        (operation === 'capabilities'
          ? '/capabilities'
          : operation === 'resume'
            ? '/' + encodeURIComponent(input.contextId)
            : '');
      const response = await fetchPlatform(pathname, {
        method: operation === 'remember' ? 'POST' : 'GET',
        headers: {
          accept: 'application/json',
          ...(operation === 'remember' ? { 'content-type': 'application/json' } : {}),
        },
        ...(operation === 'remember' ? { body: JSON.stringify(input) } : {}),
        signal,
      });
      if (operation === 'capabilities' && response.status === 404) return { supported: false };
      const chunks = [];
      let size = 0;
      if (response.body)
        for await (const chunk of response.body) {
          size += chunk.byteLength;
          if (size > 65536)
            throw new PluginRequestError('EXPERIMENT_RESPONSE_TOO_LARGE', '实验回执超出预算。');
          chunks.push(Buffer.from(chunk));
        }
      let value;
      try {
        value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new PluginRequestError('EXPERIMENT_RESPONSE_INVALID', '实验接口没有返回有效回执。');
      }
      if (!response.ok)
        throw new PluginRequestError(
          value.code ?? 'EXPERIMENT_REQUEST_REJECTED',
          value.message ?? '无法读取本次实验。',
          { httpStatus: response.status },
        );
      if (
        value.ok !== true ||
        value.schemaVersion !== 1 ||
        (operation === 'capabilities' && value.ownerScoped !== true)
      )
        throw new PluginRequestError('EXPERIMENT_RESPONSE_INVALID', '实验接口契约不匹配。');
      return { ...value, supported: true };
    },
    async courseReadiness({ computeResourceId, device = 'cuda', signal } = {}) {
      if (
        typeof computeResourceId !== 'string' ||
        !computeResourceId.trim() ||
        computeResourceId.length > 160 ||
        device !== 'cuda'
      )
        throw new PluginRequestError('INVALID_COURSE_RESOURCE', '请选择明确的课程资源。');
      const response = await fetchPlatform(
        '/api/v1/duck/compute-resources/' + encodeURIComponent(computeResourceId) + '/preflight',
        {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ taskId: 'originman-recovery', device }),
          signal,
        },
      );
      const chunks = [];
      let size = 0;
      if (response.body)
        for await (const chunk of response.body) {
          size += chunk.byteLength;
          if (size > 65536)
            throw new PluginRequestError(
              'PREFLIGHT_RESPONSE_INVALID',
              '课程预检回执超出预算；没有提交训练。',
            );
          chunks.push(Buffer.from(chunk));
        }
      let value;
      try {
        value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        if (response.status === 404)
          return { supported: false, trainingSubmitted: false, taskEnvironmentVerified: false };
        throw new PluginRequestError(
          'PREFLIGHT_RESPONSE_INVALID',
          '课程预检未返回有效回执；没有提交训练。',
        );
      }
      if (response.status === 404 || value.error === 'SIM2REAL_PREFLIGHT_NOT_SUPPORTED')
        return { supported: false, trainingSubmitted: false, taskEnvironmentVerified: false };
      if (!response.ok)
        throw new PluginRequestError(
          'COURSE_PREFLIGHT_REJECTED',
          '课程预检被平台拒绝，请维护者检查当前资源；没有提交训练。',
          { httpStatus: response.status },
        );
      return value;
    },
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
      // Older retained cores omit the platform's structured pre-engine diagnostic.
      // Enrich only failed empty logs through the same owner-authorized read API.
      if (method === 'tools/call' && params.name === 'rdk_run_logs' && !result.isError) {
        let value = result.structuredContent;
        if (!value) {
          try {
            value = JSON.parse(result.content?.find((c) => c.type === 'text')?.text);
          } catch {}
        }
        if (
          value?.status === 'failed' &&
          Array.isArray(value.lines) &&
          value.lines.length === 0 &&
          !value.diagnostic
        ) {
          const id = params.arguments?.runId;
          if (typeof id === 'string' && id.length > 0 && id.length <= 160) {
            const response = await fetchPlatform(
              '/api/v1/duck/runs/' + encodeURIComponent(id) + '/logs',
              { method: 'GET', headers: { accept: 'application/json' }, signal: options?.signal },
            );
            if (!response.ok)
              throw new PluginRequestError(
                'RUN_DIAGNOSTIC_UNAVAILABLE',
                '当前账号无法读取该Run的启动诊断；保留原Run，不重交。',
                { httpStatus: response.status },
              );
            const chunks = [];
            let size = 0;
            if (response.body)
              for await (const chunk of response.body) {
                size += chunk.byteLength;
                if (size > 65536)
                  throw new PluginRequestError('RUN_DIAGNOSTIC_INVALID', '启动诊断超出读取预算。');
                chunks.push(Buffer.from(chunk));
              }
            let body;
            try {
              body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
              throw new PluginRequestError('RUN_DIAGNOSTIC_INVALID', '平台未返回有效启动诊断。');
            }
            const d = body.diagnostic;
            if (
              body.runId === id &&
              body.logAvailability === 'not-started' &&
              body.trainingStarted === false &&
              d &&
              typeof d.code === 'string' &&
              d.code.length <= 80 &&
              typeof d.message === 'string' &&
              d.message.length <= 500 &&
              typeof d.nextAction === 'string' &&
              d.nextAction.length <= 500 &&
              typeof d.outcomeUnknown === 'boolean'
            ) {
              value = {
                ...value,
                logAvailability: 'not-started',
                trainingStarted: false,
                diagnostic: {
                  code: d.code,
                  message: d.message,
                  nextAction: d.nextAction,
                  outcomeUnknown: d.outcomeUnknown,
                },
              };
              return {
                ...result,
                structuredContent: value,
                content: [{ type: 'text', text: JSON.stringify(value) }],
              };
            }
          }
        }
      }
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
