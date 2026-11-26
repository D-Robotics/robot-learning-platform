import http from 'node:http';
import { existsSync } from 'node:fs';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { connectMcp } from './experience.mjs';
import { createPluginAuth } from './plugin-auth.mjs';
import { PluginRequestError, loginRequired, publicFailure } from './plugin-errors.mjs';
import {
  datasetEvidenceList,
  inspectWorkspace,
  matchesRunIdentifier,
} from './workspace-evidence.mjs';

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

async function boardConnectionError(response, fallback) {
  let message = '';
  const reader = response.body?.getReader();
  if (reader) {
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (typeof payload.message === 'string') message = payload.message;
          break;
        }
        size += value.byteLength;
        if (size > 4096) break;
        chunks.push(Buffer.from(value));
      }
    } catch {
      // An unreadable response still yields the generic public error.
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  const options = { httpStatus: response.status, retryable: response.status >= 500 };
  // Use fixed public messages. An SSH error can contain private endpoints or user names.
  if (/connection timed out|operation timed out|连接超时/i.test(message))
    return new PluginRequestError('BOARD_SSH_TIMEOUT', '平台连不到板卡的 SSH 端口。', {
      ...options,
      nextAction:
        '如果板卡在局域网或 Type-C 网络，请在与板卡相连的 Studio 中检查设备连接。云平台需使用能访问板卡的连接。',
    });
  if (/permission denied|authentication failed|认证失败/i.test(message))
    return new PluginRequestError('BOARD_SSH_AUTH_FAILED', '平台到板卡的 SSH 认证失败。', {
      ...options,
      retryable: false,
      nextAction: '在 Studio 的设备连接设置里核对板端账号和认证方式。学习平台的登录无需重做。',
    });
  if (/board.?agent|板端\s*agent/i.test(message))
    return new PluginRequestError('BOARD_AGENT_UNAVAILABLE', '板端服务探测未通过。', {
      ...options,
      nextAction: '在 Studio 设备详情检查 BoardAgent 状态，再测试连接。',
    });
  return new PluginRequestError('DEVELOPMENT_TARGET_UNAVAILABLE', fallback, options);
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
  let bridgeSession = null;
  let connectingBoard = null;
  const recordingTools = new Set([
    'rdk_recordings_list',
    'rdk_recording_read',
    'rdk_recording_create',
    'rdk_recording_append',
  ]);
  let recordingSupport;
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
    const sessionProbe = pathname === '/api/sim2real/auth/session' && options.method === 'GET';
    let cookie = null;
    if (pathname !== '/healthz') {
      try {
        cookie = await auth.cookie({ accountId });
      } catch (error) {
        if (!sessionProbe || error.needsLogin !== true) throw error;
      }
    }
    if (bridgeSession && bridgeSession.accountCookie !== cookie) bridgeSession = null;
    const boardRoute =
      /^\/api\/(?:v1\/duck|sim2real)\/(?:board-station|deployments|local-bridge|compute-ssh)(?:[/?]|$)/.test(
        pathname,
      );
    const requestCookie =
      cookie && boardRoute && bridgeSession ? `${cookie}; ${bridgeSession.deviceCookie}` : cookie;
    const response = await fetchImpl(auth.audience + pathname, {
      ...options,
      headers: { ...options.headers, ...(requestCookie ? { cookie: requestCookie } : {}) },
      redirect: 'error',
      signal: AbortSignal.any([
        ...(options.signal ? [options.signal] : []),
        AbortSignal.timeout(120000),
      ]),
    });
    if (response.status === 401) {
      bridgeSession = null;
      if (cookie) await auth.invalidate(cookie);
      throw loginRequired();
    }
    return response;
  };
  async function supportsRecordings(signal) {
    try {
      signal?.throwIfAborted();
      const cookie = await auth.cookie();
      if (recordingSupport?.cookie === cookie && recordingSupport.expiresAt > Date.now())
        return recordingSupport.supported;
      const response = await fetchPlatform('/api/sim2real/recordings', {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(1000)]),
      });
      await response.body?.cancel();
      signal?.throwIfAborted();
      // Only an explicit collection-route 404 proves this optional API is absent.
      // Auth failures, transient transport errors and 5xx keep their normal meaning.
      const supported = response.status === 404 ? false : response.ok ? true : undefined;
      if (supported !== undefined && (await auth.cookie()) === cookie)
        recordingSupport = { cookie, supported, expiresAt: Date.now() + 60000 };
      return supported;
    } catch {
      signal?.throwIfAborted();
      return undefined;
    }
  }
  async function verifiedWorkspaceAccount() {
    const session = await auth.status();
    if (session.authenticated === true && session.accountId) return session.accountId;
    if (session.needsLogin === true) throw loginRequired();
    throw new PluginRequestError(
      session.error ?? 'WORKSPACE_ACCOUNT_UNVERIFIED',
      session.message ?? '当前账号尚未验证，无法读取工作区。',
      { httpStatus: session.httpStatus ?? 503, nextAction: session.nextAction },
    );
  }
  async function readWorkspaceJson(route, signal, accountId, request = {}) {
    const response = await fetchPlatform(
      '/api/v1/duck' + route,
      {
        method: 'GET',
        ...request,
        headers: { accept: 'application/json', ...request.headers },
        signal,
      },
      accountId,
    );
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength;
      if (size > 4 * 1024 * 1024)
        throw new PluginRequestError('WORKSPACE_RESPONSE_TOO_LARGE', '平台响应超过读取上限。', {
          httpStatus: 502,
        });
      chunks.push(Buffer.from(chunk));
    }
    let value;
    try {
      value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      if (response.ok)
        throw new PluginRequestError('WORKSPACE_INVALID_RESPONSE', '平台未返回有效的工作区证据。', {
          httpStatus: 502,
        });
    }
    if (!response.ok || value?.ok !== true) {
      const code = value?.error ?? value?.code;
      throw new PluginRequestError(
        typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,100}$/.test(code)
          ? code
          : 'WORKSPACE_READ_FAILED',
        request.method && typeof value?.message === 'string'
          ? value.message.slice(0, 500)
          : '平台未能完成这项工作区查询。',
        {
          httpStatus: response.ok ? 502 : response.status,
          retryable: value?.retryable === true,
          ...(typeof value?.nextAction === 'string' && {
            nextAction: value.nextAction.slice(0, 500),
          }),
        },
      );
    }
    return value;
  }
  const apiResult = (value, isError = false) => ({
    ...(isError && { isError }),
    structuredContent: value,
    content: [{ type: 'text', text: JSON.stringify(value) }],
  });
  async function trainingPreflight(args, signal) {
    const id = typeof args.computeResourceId === 'string' ? args.computeResourceId.trim() : '';
    if (!id || id.length > 160) {
      throw new PluginRequestError('DSH_CAPABILITY_REJECTED', '请选择有效的训练算力 ID。', {
        httpStatus: 400,
        nextAction: '从当前账号的算力列表选择资源后重试预检。',
      });
    }
    const input = {};
    for (const field of ['taskId', 'engine', 'device']) {
      if (args[field] === undefined) continue;
      if (typeof args[field] !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(args[field])) {
        throw new PluginRequestError(
          'DSH_CAPABILITY_REJECTED',
          '训练预检的任务、引擎或设备标识无效。',
          {
            httpStatus: 400,
          },
        );
      }
      input[field] = args[field];
    }
    const accountId = await verifiedWorkspaceAccount();
    try {
      return await readWorkspaceJson(
        '/compute-resources/' + encodeURIComponent(id) + '/preflight',
        signal,
        accountId,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        },
      );
    } catch (error) {
      if (
        error.httpStatus === 404 &&
        ['SIM2REAL_API_NOT_FOUND', 'WORKSPACE_READ_FAILED'].includes(error.code)
      ) {
        throw new PluginRequestError(
          'PLATFORM_FEATURE_UNAVAILABLE',
          '当前平台未提供算力环境预检。',
          {
            httpStatus: 501,
            nextAction: '可检查所选 Worker 的连接。请维护者更新平台后再核验任务环境。',
          },
        );
      }
      throw error;
    }
  }
  async function readRunLogs(args, signal) {
    const { runId, after = 0 } = args;
    if (
      typeof runId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(runId) ||
      !Number.isSafeInteger(after) ||
      after < 0
    ) {
      throw new PluginRequestError(
        'DSH_CAPABILITY_REJECTED',
        '请提供完整 Run ID 和有效的日志游标。',
        {
          httpStatus: 400,
        },
      );
    }
    const accountId = await verifiedWorkspaceAccount();
    const body = await readWorkspaceJson(
      '/runs/' + encodeURIComponent(runId) + '/logs?after=' + after,
      signal,
      accountId,
      { method: 'GET' },
    );
    if (
      body.runId !== runId ||
      typeof body.status !== 'string' ||
      !Array.isArray(body.lines) ||
      body.lines.length > 600 ||
      !Number.isSafeInteger(body.total) ||
      body.total < 0 ||
      !Number.isSafeInteger(body.retainedFrom) ||
      body.retainedFrom < 0
    ) {
      throw new PluginRequestError(
        'RUN_LOG_RESPONSE_INVALID',
        '平台未返回本次 Run 的有效日志回执。',
        {
          httpStatus: 502,
        },
      );
    }
    let nextAfter = after;
    const lines = body.lines.slice(0, 200).map((line) => {
      if (
        !Number.isSafeInteger(line?.n) ||
        line.n <= nextAfter ||
        line.n > body.total ||
        !['stdout', 'stderr'].includes(line.stream) ||
        typeof line.text !== 'string' ||
        line.text.length > 2_000
      ) {
        throw new PluginRequestError('RUN_LOG_RESPONSE_INVALID', '平台返回的日志游标或格式无效。', {
          httpStatus: 502,
        });
      }
      nextAfter = line.n;
      return { n: line.n, stream: line.stream, text: line.text };
    });
    const d = body.diagnostic;
    const diagnostic =
      body.logAvailability === 'not-started' &&
      body.trainingStarted === false &&
      typeof d?.code === 'string' &&
      d.code.length <= 80 &&
      typeof d.message === 'string' &&
      d.message.length <= 500 &&
      typeof d.nextAction === 'string' &&
      d.nextAction.length <= 500 &&
      typeof d.outcomeUnknown === 'boolean'
        ? {
            code: d.code,
            message: d.message,
            nextAction: d.nextAction,
            outcomeUnknown: d.outcomeUnknown,
          }
        : null;
    return {
      runId,
      status: body.status,
      total: body.total,
      retainedFrom: body.retainedFrom,
      truncated: body.truncated === true,
      lines,
      nextAfter,
      hasMore: lines.length > 0 && nextAfter < body.total,
      ...(body.source === 'retained-tail' && {
        source: body.source,
        ...(typeof body.stdoutTail === 'string' && { stdoutTail: body.stdoutTail.slice(-2000) }),
        ...(typeof body.stderrTail === 'string' && { stderrTail: body.stderrTail.slice(-2000) }),
      }),
      ...(diagnostic && { logAvailability: 'not-started', trainingStarted: false, diagnostic }),
    };
  }
  async function connectBoard(connectionId, signal) {
    if (typeof connectionId !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(connectionId))
      throw new PluginRequestError(
        'DSH_CAPABILITY_REJECTED',
        '请提供设备发现返回的完整 connectionId。',
        { httpStatus: 400 },
      );
    const accountId = await verifiedWorkspaceAccount();
    const catalog = await readWorkspaceJson('/device-connections', signal, accountId);
    const device = catalog.studioDevices?.find(
      (item) => item.id === connectionId && item.provider === 'studio-local-bridge',
    );
    if (!device) return null;
    const runConnect = async () => {
      const presence = await readWorkspaceJson('/local-bridge/status', signal, accountId);
      const matches = (presence.bridges ?? []).flatMap((bridge) =>
        bridge.online === true
          ? (bridge.devices ?? [])
              .filter(
                (entry) =>
                  entry.bridgeDeviceId === device.bridgeDeviceId && entry.host === device.host,
              )
              .map(() => bridge)
          : [],
      );
      if (matches.length !== 1)
        throw new PluginRequestError(
          'STUDIO_BRIDGE_DEVICE_UNAVAILABLE',
          '当前账号下未找到唯一在线的目标 Bridge 设备。',
          { httpStatus: 409 },
        );
      const accountCookie = await auth.cookie({ accountId });
      const response = await fetchPlatform(
        '/api/v1/duck/local-bridge/devices/' +
          encodeURIComponent(device.bridgeDeviceId) +
          '/connect',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ bridgeId: matches[0].bridgeId }),
          signal,
        },
        accountId,
      );
      if (!response.ok)
        throw await boardConnectionError(response, 'Studio 未通过目标设备连接验证。');
      const result = await response.json();
      const deviceCookies = (response.headers.getSetCookie?.() ?? []).filter(
        (value) =>
          value.length <= 4096 &&
          /^rdk_studio_devices=[^;\s]+;/.test(value) &&
          !/[\u0000-\u001f\u007f]/.test(value) &&
          /;\s*HttpOnly(?:;|$)/i.test(value) &&
          /;\s*Secure(?:;|$)/i.test(value) &&
          !/;\s*Domain=/i.test(value),
      );
      if (
        result.ok !== true ||
        result.device?.id !== connectionId ||
        result.device?.host !== device.host ||
        deviceCookies.length !== 1
      )
        throw new PluginRequestError(
          'STUDIO_BRIDGE_SESSION_UNCONFIRMED',
          'Studio 尚未返回这台板卡的已验证设备会话。',
          { httpStatus: 502 },
        );
      if ((await auth.cookie({ accountId })) !== accountCookie)
        throw new PluginRequestError(
          'AUTH_OPERATION_SUPERSEDED',
          '登录会话已变化，请重新连接设备。',
          { httpStatus: 409 },
        );
      bridgeSession = { accountCookie, deviceCookie: deviceCookies[0].split(';')[0] };
      return {
        connectionId,
        transport: 'studio-local-bridge',
        sessionBound: true,
        verification: 'studio-connect',
        motionStarted: false,
      };
    };
    const pending = (connectingBoard ?? Promise.resolve()).catch(() => {}).then(runConnect);
    connectingBoard = pending;
    try {
      return await pending;
    } finally {
      if (connectingBoard === pending) connectingBoard = null;
    }
  }
  async function computeTool(name, args, signal) {
    const validId =
      typeof args.computeResourceId === 'string' &&
      args.computeResourceId.trim().length > 0 &&
      args.computeResourceId.trim().length <= 160;
    const registering = name === 'rdk_compute_resource_register';
    const testing = name === 'rdk_compute_resource_test';
    if (!registering && !validId)
      throw new PluginRequestError('DSH_CAPABILITY_REJECTED', '请提供有效的 computeResourceId。', {
        httpStatus: 400,
        nextAction: '调用 rdk_compute_resources_list，使用当前账号下的完整资源 ID。',
      });
    const key = args.idempotencyKey;
    if (
      key !== undefined &&
      (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(key.trim()))
    )
      throw new PluginRequestError(
        'DSH_CAPABILITY_REJECTED',
        'idempotencyKey 必须为 1–128 字符的稳定键。',
        { httpStatus: 400 },
      );
    const json = {};
    for (const field of ['name', 'runnerUrl', 'runnerToken', 'source', 'maxConcurrentJobs']) {
      if (!testing && args[field] !== undefined) {
        const expected = field === 'maxConcurrentJobs' ? 'number' : 'string';
        if (
          typeof args[field] !== expected ||
          (expected === 'number' && !Number.isInteger(args[field]))
        )
          throw new PluginRequestError('DSH_CAPABILITY_REJECTED', field + ' 类型不正确。', {
            httpStatus: 400,
          });
        json[field] = args[field];
      }
    }
    if (registering && (!json.name?.trim() || !json.runnerUrl?.trim()))
      throw new PluginRequestError('DSH_CAPABILITY_REJECTED', 'name 和 runnerUrl 必填。', {
        httpStatus: 400,
      });
    if (json.source !== undefined && !['local-agent', 'server-runner'].includes(json.source))
      throw new PluginRequestError(
        'DSH_CAPABILITY_REJECTED',
        'source 可选 server-runner 或 local-agent。',
        { httpStatus: 400 },
      );
    const accountId = await verifiedWorkspaceAccount();
    if (registering && key) json.idempotencyKey = key.trim();
    const id = registering ? '' : args.computeResourceId.trim();
    const value = await readWorkspaceJson(
      '/compute-resources' + (id ? '/' + encodeURIComponent(id) : '') + (testing ? '/test' : ''),
      signal,
      accountId,
      {
        method: registering || testing ? 'POST' : 'PATCH',
        headers: {
          'content-type': 'application/json',
          ...(key && { 'idempotency-key': key.trim() }),
        },
        body: JSON.stringify(json),
      },
    );
    const resource = value.computeResource ?? value.resource;
    if (!resource?.id || (id && resource.id !== id))
      throw new PluginRequestError('WORKSPACE_INVALID_RESPONSE', '平台未确认当前算力资源的标识。', {
        httpStatus: 502,
      });
    if (!testing) return { computeResource: resource, nextTool: 'rdk_compute_resource_test' };
    return {
      id,
      ok: true,
      connected: value.connected === true,
      browserRelay: value.browserRelay === true,
      status: resource.status,
      message: resource.message ?? value.message,
      health: resource.health ?? value.health,
      lastCheckedAt: resource.lastCheckedAt,
      cuda: resource.cuda,
      gpuName: resource.gpuName,
      vramMb: resource.vramMb,
      mock: resource.mock,
      engines: resource.engines ?? value.engines,
      ...(value.diagnostic && {
        diagnostic: value.diagnostic,
        recovery: value.diagnostic.recovery,
      }),
    };
  }
  async function listArtifacts(args, signal) {
    const query = new URLSearchParams();
    for (const field of ['type', 'modelId', 'runId', 'projectId', 'taskId', 'status', 'query']) {
      if (typeof args[field] === 'string' && args[field].trim())
        query.set(field === 'query' ? 'q' : field, args[field].trim().slice(0, 200));
    }
    const filtered = query.size > 0;
    const limit = Number.isFinite(args.limit)
      ? Math.max(1, Math.min(500, Math.trunc(args.limit)))
      : 50;
    query.set('limit', String(limit));
    const value = await readWorkspaceJson(
      '/artifacts?' + query,
      signal,
      await verifiedWorkspaceAccount(),
    );
    if (!Array.isArray(value.artifacts))
      throw new PluginRequestError('WORKSPACE_INVALID_RESPONSE', '平台未返回制品列表。', {
        httpStatus: 502,
      });
    const returned = value.artifacts.length;
    const modern = value.returned === returned;
    const total = modern ? value.total : value.available;
    const available = modern
      ? value.available
      : !filtered
        ? total
        : returned < limit
          ? returned
          : null;
    if (
      !Number.isSafeInteger(total) ||
      total < returned ||
      (available !== null &&
        (!Number.isSafeInteger(available) || available < returned || available > total))
    )
      throw new PluginRequestError('WORKSPACE_INVALID_RESPONSE', '平台返回的制品计数无效。', {
        httpStatus: 502,
      });
    const fields = [
      'id',
      'name',
      'type',
      'status',
      'format',
      'modelId',
      'runId',
      'uri',
      'sampleCount',
    ];
    return {
      total,
      available,
      returned,
      artifacts: value.artifacts.map((item) =>
        Object.fromEntries(
          fields.filter((key) => item?.[key] !== undefined).map((key) => [key, item[key]]),
        ),
      ),
    };
  }
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
    async inspectWorkspace(args, { signal } = {}) {
      const accountId = await verifiedWorkspaceAccount();
      return inspectWorkspace(args, (route) => readWorkspaceJson(route, signal, accountId), {
        signal,
        baseUrl: auth.audience,
      });
    },
    async readDatasets({ signal } = {}) {
      const accountId = await verifiedWorkspaceAccount();
      const value = await readWorkspaceJson('/datasets', signal, accountId);
      const { items: datasets, studentReply } = datasetEvidenceList(
        value,
        auth.audience,
        undefined,
        Infinity,
      );
      return { datasets, studentReply };
    },
    async listOriginmanMotion({ signal } = {}) {
      return readWorkspaceJson(
        '/originman-motion/catalog',
        signal,
        await verifiedWorkspaceAccount(),
      );
    },
    async previewOriginmanMotion(composition, { signal } = {}) {
      return readWorkspaceJson(
        '/originman-motion/preview',
        signal,
        await verifiedWorkspaceAccount(),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(composition),
        },
      );
    },
    async submitOriginmanMotion(args, { signal } = {}) {
      const accountId = await verifiedWorkspaceAccount();
      const {
        contextId,
        computeResourceId,
        numEnvs,
        composition,
        trainingSteps,
        expectedTrajectorySha256,
        expectedStanceProfile,
      } = args;
      const post = (route, body, headers) =>
        readWorkspaceJson(route, signal, accountId, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(body),
        });
      const { modelId } = await post('/originman-reference/model', { computeResourceId });
      const taskId = 'originman-reference-track';
      const result = await post(
        '/runs',
        {
          modelId,
          computeResourceId,
          requestedVia: 'agent',
          taskId,
          backend: 'local',
          label: 'OriginMan · 参考舞蹈',
          training: {
            profile: trainingSteps === 8192 ? 'smoke' : 'standard',
            algorithm: 'ppo',
            engine: 'originman-reference-ppo',
            video: true,
            maxIterations: trainingSteps / 4096,
            numEnvs,
            originmanReference: {
              composition,
              expectedTrajectorySha256,
              ...(expectedStanceProfile && { expectedStanceProfile }),
              trainingSteps,
              seed: 7,
            },
          },
        },
        { 'Idempotency-Key': 'originman-motion-' + contextId },
      );
      if (!result.run?.id || result.run.taskId !== taskId)
        throw new PluginRequestError(
          'WORKSPACE_EVIDENCE_MISMATCH',
          '平台未确认新建的参考舞蹈 Run。',
          {
            httpStatus: 502,
          },
        );
      return { ...result, taskId };
    },
    async rehearseOriginmanDanceCpu({ runId, deviceId }, { signal } = {}) {
      const accountId = await verifiedWorkspaceAccount();
      const requestSignal = AbortSignal.any([
        AbortSignal.timeout(30_000),
        ...(signal ? [signal] : []),
      ]);
      const read = (route, options) => readWorkspaceJson(route, requestSignal, accountId, options);
      const { run } = await read('/runs/' + encodeURIComponent(runId));
      if (run?.id !== runId)
        throw new PluginRequestError('WORKSPACE_EVIDENCE_MISMATCH', '平台未确认指定的原 Run。', {
          httpStatus: 502,
        });
      const steps = run.metrics?.trainingSteps;
      const status = {
        runId,
        run: {
          id: run.id,
          status: run.status,
          trainingSteps: Number.isSafeInteger(steps) && steps > 0 ? steps : null,
          qualityGatePassed: run.metrics?.originmanDance?.qualityGatePassed ?? null,
          artifact: {
            format: run.artifact?.format ?? null,
            sha256: run.artifact?.sha256 ?? null,
            deployable: run.artifact?.deployable ?? null,
          },
        },
        motionAuthorized: false,
        authorizesDeployment: false,
      };
      const blocked = (blocker, nextAction) => ({
        ...status,
        phase: 'preflight',
        status: 'blocked',
        blocker,
        nextAction,
        stopWorkflow: true,
      });
      if (
        run.status !== 'completed' ||
        run.mock === true ||
        run.contractId !== 'custom-policy-originman-dance-v2' ||
        run.artifact?.format !== 'onnx' ||
        !/^[a-f0-9]{64}$/.test(run.artifact?.sha256 ?? '')
      )
        return blocked(
          'run-not-ready',
          '请核对原 Run 是否已完成并生成 OriginMan 舞蹈 v2 的原始 ONNX。',
        );

      const { devices } = await read('/board-station/devices');
      if (!Array.isArray(devices))
        throw new PluginRequestError('WORKSPACE_INVALID_RESPONSE', '平台未返回可核对的设备清单。', {
          httpStatus: 502,
        });
      const eligible = (device) =>
        device?.boardPlatform === 'rdk-x5' && device.status === 'connected';
      const device = deviceId && devices.find((item) => item?.id === deviceId);
      if (!deviceId && !devices.some(eligible))
        return blocked(
          'x5-not-connected',
          '当前没有已接通的 RDK X5。请在设备管理接通实体 X5，确认设备隧道与新版 BoardAgent 可用，再用真实设备 ID 复测同一 Run。',
        );
      if (!deviceId)
        return blocked(
          'x5-device-id-required',
          '请指定一台已接通的 RDK X5 设备 ID，再复测同一 Run。',
        );
      if (!eligible(device))
        return blocked(
          'x5-device-unavailable',
          '指定设备未登记为已接通的 RDK X5。请在设备管理核对原设备及隧道状态。',
        );

      const receipt = await read(
        '/board-station/originman-dance-cpu-rehearsal?' + new URLSearchParams({ deviceId }),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ runId }),
        },
      );
      if (
        receipt.runId !== runId ||
        receipt.deviceId !== deviceId ||
        receipt.sha256 !== run.artifact.sha256 ||
        receipt.staged !== true ||
        receipt.loaded !== true
      )
        throw new PluginRequestError(
          'WORKSPACE_EVIDENCE_MISMATCH',
          '板端回执与指定原 Run 或设备不一致。',
          {
            httpStatus: 502,
          },
        );
      return { ...receipt, ...status, phase: 'rehearsal' };
    },
    async verifyPolicyDownload(runId, sha256, { signal } = {}) {
      const response = await fetchPlatform(
        '/api/v1/duck/runs/' + encodeURIComponent(runId) + '/artifact',
        {
          method: 'HEAD',
          signal: AbortSignal.any([AbortSignal.timeout(8000), ...(signal ? [signal] : [])]),
        },
      );
      return (
        response.ok &&
        response.headers.get('x-artifact-sha256') === sha256 &&
        /^attachment\b/i.test(response.headers.get('content-disposition') ?? '')
      );
    },
    async readLearningRuns({ danceOnly = false, signal } = {}) {
      const accountId = await verifiedWorkspaceAccount();
      const route = '/runs?limit=12' + (danceOnly ? '&taskId=originman-dance' : '');
      const { runs } = await readWorkspaceJson(route, signal, accountId);
      if (!Array.isArray(runs))
        throw new PluginRequestError('WORKSPACE_INVALID_RESPONSE', '平台未返回近期运行列表。', {
          httpStatus: 502,
        });
      return runs
        .filter(
          (run) => typeof run?.id === 'string' && (!danceOnly || run.taskId === 'originman-dance'),
        )
        .slice(0, 6)
        .map(({ id, label, taskId, status, createdAt, training }) => ({
          id,
          label: label ?? training?.originmanDance?.title,
          taskId,
          status,
          createdAt,
        }));
    },
    async readTelemetrySummary(name, args, { signal } = {}) {
      const { runId, limit = 50 } = args;
      const list = name === 'rdk_telemetry_list';
      if (
        typeof runId !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(runId) ||
        Object.keys(args).some((key) => key !== 'runId' && !(list && key === 'limit')) ||
        !Number.isFinite(limit)
      )
        return null;
      const query = list
        ? '/telemetry?includeSamples=false&limit=' + Math.min(200, Math.max(1, Math.trunc(limit)))
        : '/replay?includeFrames=false';
      const response = await fetchPlatform(
        '/api/v1/duck/runs/' + encodeURIComponent(runId) + query,
        { signal },
      );
      if (
        !response.ok ||
        response.headers.get('x-rdk-telemetry-summary') !== '1' ||
        !response.body
      ) {
        await response.body?.cancel().catch(() => {});
        return null;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > 512 * 1024) return null;
        chunks.push(Buffer.from(chunk));
      }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (value?.ok !== true || value.runId !== runId) return null;
      if (!list) {
        if (!Number.isSafeInteger(value.frameCount) || value.frameCount < 0) return null;
        return {
          runId,
          frameCount: value.frameCount,
          replay: value.replay ?? {},
          evaluation: {
            status: value.evaluation?.status ?? null,
            warnings: Array.isArray(value.evaluation?.warnings)
              ? value.evaluation.warnings.slice(0, 10)
              : [],
          },
        };
      }
      if (
        !Array.isArray(value.telemetry) ||
        value.telemetry.length > 200 ||
        value.telemetry.some(
          (chunk) => !Number.isSafeInteger(chunk?.sampleCount) || chunk.sampleCount < 0,
        )
      )
        return null;
      return {
        runId,
        count: value.telemetry.length,
        telemetry: value.telemetry.map(
          ({ id, source, sequence, receivedAt, sampleCount, droppedCount, attested }) => ({
            id,
            source,
            sequence: sequence ?? null,
            receivedAt,
            sampleCount,
            droppedCount: droppedCount ?? null,
            attested: attested === true,
          }),
        ),
      };
    },
    async readTrainingRun(runId, { signal, allowPrefix = false } = {}) {
      if (typeof runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(runId))
        throw Error('原 Run 标识无效。');
      const response = await fetchPlatform('/api/v1/duck/runs/' + encodeURIComponent(runId), {
        headers: { accept: 'application/json' },
        signal,
      });
      const value = await response.json();
      const code = value?.code ?? value?.error;
      if (
        (response.status === 404 && code === 'SIM2REAL_RUN_NOT_FOUND') ||
        (response.status === 409 && code === 'SIM2REAL_RUN_ID_AMBIGUOUS')
      )
        throw new PluginRequestError(code, value.message, { httpStatus: response.status });
      if (
        !response.ok ||
        !(allowPrefix ? matchesRunIdentifier(runId, value.run?.id) : value.run?.id === runId)
      )
        throw Error('当前账号无法读取这条 Run，请核对原运行链接。');
      return {
        ...value.run,
        ...(typeof value.workshopEvidenceIssue === 'string' && {
          workshopEvidenceIssue: value.workshopEvidenceIssue,
        }),
      };
    },
    async readDanceTrajectoryVerification(runId, expectedSha256, { signal } = {}) {
      const accountId = await verifiedWorkspaceAccount();
      const value = await readWorkspaceJson(
        '/runs/' + encodeURIComponent(runId) + '/dance-trajectory',
        AbortSignal.any([AbortSignal.timeout(17000), ...(signal ? [signal] : [])]),
        accountId,
      );
      const proof = value.verification;
      if (
        value.ok !== true ||
        value.runId !== runId ||
        proof?.trajectorySha256 !== expectedSha256 ||
        !Number.isSafeInteger(proof.controlSteps) ||
        proof.controlSteps < 1 ||
        proof.poseFrames !== proof.controlSteps + 1 ||
        proof.controlHz !== 50
      )
        throw new Error('Worker 步序回执未与所选 Run 绑定。');
      return proof;
    },
    async startDanceGoal(args, { signal } = {}) {
      const response = await fetchPlatform('/api/v1/duck/dance-goals', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(args),
        signal,
      });
      const value = await response.json().catch(() => null);
      if (!response.ok || value?.ok !== true || !value.goal?.id)
        throw new PluginRequestError(
          'DANCE_GOAL_UNAVAILABLE',
          value?.message ?? '平台暂时无法接收后台舞蹈实验，未确认新训练。',
          { httpStatus: response.status },
        );
      return value.goal;
    },
    async readDanceGoal(id, { signal } = {}) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,23}$/.test(id ?? '')) throw Error('原实验标识无效。');
      const response = await fetchPlatform('/api/v1/duck/dance-goals/' + encodeURIComponent(id), {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal,
      });
      const value = await response.json().catch(() => null);
      if (response.status === 404) return null;
      if (!response.ok || value?.ok !== true || value.goal?.id !== id)
        throw new PluginRequestError(
          'DANCE_GOAL_UNAVAILABLE',
          value?.message ?? '暂时无法读取原后台实验。',
          { httpStatus: response.status },
        );
      return value.goal;
    },
    async readDanceEvaluationRun(runId, { signal } = {}) {
      if (typeof runId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/.test(runId))
        throw Error('原舞蹈训练标识无效。');
      const response = await fetchPlatform(
        '/api/v1/duck/runs/' + encodeURIComponent(runId) + '/dance-evaluation',
        { method: 'GET', headers: { accept: 'application/json' }, signal },
      );
      const value = await response.json().catch(() => null);
      if (response.status === 404 && value?.ok === false) return null;
      if (response.ok && value?.ok === true && value.evaluation) return value.evaluation;
      throw new PluginRequestError(
        'DANCE_EVALUATION_UNAVAILABLE',
        value?.message || '平台暂时无法查询原 Run 的独立舞蹈评测。',
        { httpStatus: response.status },
      );
    },
    async evaluateDanceRun(runId, { signal } = {}) {
      if (typeof runId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/.test(runId))
        throw Error('原舞蹈训练标识无效。');
      const response = await fetchPlatform(
        '/api/v1/duck/runs/' + encodeURIComponent(runId) + '/dance-evaluation',
        {
          method: 'POST',
          headers: { accept: 'application/json' },
          signal,
        },
      );
      const value = await response.json().catch(() => null);
      if (!response.ok || value?.ok !== true)
        throw new PluginRequestError(
          'DANCE_EVALUATION_UNAVAILABLE',
          value?.message || '平台暂时无法生成独立舞蹈评测。',
          { httpStatus: response.status },
        );
      return value.evaluation;
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
    async developmentTarget(operation, { accountId, targetId, input, deploymentId, signal } = {}) {
      if (['ssh-devices', 'deploy-compute', 'deployment-status'].includes(operation)) {
        if (!accountId) throw Error('请先连接学习平台账号。');
        let route;
        let body;
        if (operation === 'ssh-devices') {
          const presence = await fetchPlatform(
            '/api/v1/duck/local-bridge/status',
            { signal },
            accountId,
          );
          if (!presence.ok)
            throw new PluginRequestError(
              'COMPUTE_SSH_DISCOVERY_UNAVAILABLE',
              'Studio 设备发现暂不可用。',
              { httpStatus: presence.status },
            );
          await presence.body?.cancel();
          route = '/api/v1/duck/device-connections';
        } else if (operation === 'deploy-compute') {
          if (!input || typeof input.deviceId !== 'string') throw Error('请指定 Studio 设备。');
          const connected = await connectBoard(input.deviceId, signal);
          if (!connected)
            throw new PluginRequestError(
              'COMPUTE_SSH_STUDIO_CONNECTION_REQUIRED',
              '当前设备尚未接入 Studio Local Bridge。',
              { httpStatus: 409 },
            );
          route = '/api/v1/duck/compute-ssh/deployments';
          body = input;
        } else {
          if (!/^[a-f0-9]{64}$/.test(deploymentId ?? '')) throw Error('部署标识无效。');
          const original = await fetchPlatform(
            '/api/v1/duck/compute-ssh/deployments/' + deploymentId,
            { signal },
            accountId,
          );
          const record = await original.json().catch(() => null);
          if (
            !original.ok ||
            record?.deploymentId !== deploymentId ||
            typeof record.deviceId !== 'string'
          )
            throw new PluginRequestError(
              'COMPUTE_SSH_DEPLOYMENT_NOT_FOUND',
              '当前账号找不到原部署。',
              { httpStatus: original.status },
            );
          if (!(await connectBoard(record.deviceId, signal)))
            throw new PluginRequestError(
              'COMPUTE_SSH_STUDIO_CONNECTION_REQUIRED',
              '原开发机尚未接通 Studio。',
              { httpStatus: 409 },
            );
          route = '/api/v1/duck/compute-ssh/deployments/' + deploymentId + '/poll';
          body = {};
        }
        const response = await fetchPlatform(
          route,
          {
            method: body === undefined ? 'GET' : 'POST',
            headers: {
              accept: 'application/json',
              ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal,
          },
          accountId,
        );
        const value = await response.json().catch(() => null);
        if (!response.ok || value?.ok !== true) {
          const originalId = response.headers.get('x-rdk-compute-deployment-id');
          if (operation === 'deploy-compute' && /^[a-f0-9]{64}$/.test(originalId ?? ''))
            return { ok: true, deploymentId: originalId, state: 'unconfirmed' };
          throw new PluginRequestError(
            typeof value?.error === 'string' && /^COMPUTE_SSH_[A-Z_]+$/.test(value.error)
              ? value.error
              : 'COMPUTE_SSH_UNAVAILABLE',
            'Studio SSH 部署尚未完成，请保留原部署标识并检查连接与平台配置。',
            { httpStatus: response.status },
          );
        }
        return value;
      }
      if (
        !accountId ||
        !['compute', 'boards', 'test-compute', 'connect-board', 'register-compute'].includes(
          operation,
        )
      )
        throw Error('请选择当前账号下的明确设备。');
      const register = operation === 'register-compute';
      const write = register || operation === 'test-compute' || operation === 'connect-board';
      if (
        write &&
        !register &&
        (typeof targetId !== 'string' || !targetId.trim() || targetId.length > 160)
      )
        throw Error('设备标识无效。');
      const path =
        operation === 'compute' || operation === 'test-compute' || register
          ? '/api/sim2real/compute-resources'
          : '/api/sim2real/device-connections';
      const suffix =
        write && !register
          ? '/' +
            encodeURIComponent(targetId) +
            (operation === 'test-compute' ? '/test' : '/connect')
          : '';
      const response = await fetchPlatform(
        path + suffix,
        {
          method: write ? 'POST' : 'GET',
          headers: {
            accept: 'application/json',
            ...(write ? { 'content-type': 'application/json' } : {}),
          },
          ...(write ? { body: register ? JSON.stringify(input) : '{}' } : {}),
          signal,
        },
        accountId,
      );
      const message = write
        ? '平台未能完成设备连接检查，请到学习平台查看该设备的状态。'
        : '当前账号暂时无法读取这类设备。';
      if (!response.ok && operation === 'connect-board')
        throw await boardConnectionError(response, message);
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
      if (
        method === 'tools/call' &&
        ['rdk_training_preflight', 'rdk_run_logs'].includes(params.name)
      ) {
        try {
          const handler =
            params.name === 'rdk_training_preflight' ? trainingPreflight : readRunLogs;
          return apiResult(await handler(params.arguments ?? {}, options?.signal));
        } catch (error) {
          options?.signal?.throwIfAborted();
          return apiResult(publicFailure(error), true);
        }
      }
      if (
        method === 'tools/call' &&
        recordingTools.has(params.name) &&
        (await supportsRecordings(options?.signal)) === false
      )
        return apiResult(
          {
            ok: false,
            error: 'PLATFORM_FEATURE_UNAVAILABLE',
            message: '当前平台未提供状态录制接口；可使用仿真轨迹录制与下载。没有执行写入。',
          },
          true,
        );
      if (method === 'tools/call' && params.name === 'rdk_device_connect') {
        try {
          const connected = await connectBoard(params.arguments?.connectionId, options?.signal);
          if (connected) return apiResult(connected);
        } catch (error) {
          options?.signal?.throwIfAborted();
          return apiResult(publicFailure(error), true);
        }
      }
      if (
        method === 'tools/call' &&
        ([
          'rdk_compute_resource_register',
          'rdk_compute_resource_update',
          'rdk_compute_resource_test',
        ].includes(params.name) ||
          params.name === 'rdk_artifacts_list')
      ) {
        try {
          const args = params.arguments ?? {};
          const value =
            params.name === 'rdk_artifacts_list'
              ? await listArtifacts(args, options?.signal)
              : await computeTool(params.name, args, options?.signal);
          return apiResult(value);
        } catch (error) {
          options?.signal?.throwIfAborted();
          return apiResult(publicFailure(error), true);
        }
      }
      const result = await upstream.request(method, params, options);
      if (method === 'tools/list' && Array.isArray(result.tools)) {
        const supported = result.tools.some((tool) => recordingTools.has(tool.name))
          ? await supportsRecordings(options?.signal)
          : undefined;
        return {
          ...result,
          tools: result.tools
            .filter((tool) => supported !== false || !recordingTools.has(tool.name))
            .map((tool) =>
              tool.name === 'rdk_device_connect'
                ? {
                    ...tool,
                    description:
                      '连接并验证已发现的目标板卡。connectionId 使用 rdk_device_discover 返回的完整平台设备 ID。Local Bridge 连接保留当前账号的设备会话，通过 Studio 原有验证，不加载或启动策略。' +
                      tool.description,
                  }
                : tool,
            ),
        };
      }
      if (method === 'tools/call' && params.name === 'rdk_platform_status') {
        let value = result.structuredContent;
        if (!value) {
          try {
            value = JSON.parse(result.content?.find((c) => c.type === 'text')?.text);
          } catch {}
        }
        if (value && typeof value === 'object') {
          value = { ...value, baseUrl: auth.audience, authMode: auth.mode };
          if (value.session?.authenticated !== true) value.authentication = await auth.status();
          const readyForLogin =
            value.health?.ready === true &&
            value.session?.authenticated === false &&
            value.authentication?.needsLogin === true;
          if (readyForLogin || value.connection?.state === 'authentication-required') {
            value.ok = true;
            value.canAccessWorkspace = false;
            value.connection = {
              state: 'authentication-required',
              recovery:
                '调用 rdk_auth_login 并在浏览器授权；Studio 使用账号继承时请先在账户菜单登录。',
            };
          }
          return {
            ...result,
            ...(readyForLogin && { isError: false }),
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
      bridgeSession = null;
      try {
        await upstream.close();
      } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    },
  };
}
