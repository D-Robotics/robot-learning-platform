#!/usr/bin/env node
/** Read-only experience preparation. All business reads go through existing MCP tools. */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export function isDirectInvocation(moduleUrl, entry = process.argv[1]) {
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(entry);
  } catch {
    return false;
  }
}

export function readToolResult(result) {
  let payload = result.structuredContent;
  if (payload == null) {
    const text = result.content?.find((x) => x.type === 'text')?.text;
    if (typeof text !== 'string') throw new Error('MCP tool returned no readable result.');
    try {
      payload = JSON.parse(text);
    } catch (error) {
      if (!result.isError) throw error;
      payload = { error: { message: text } };
    }
  }
  if (result.isError || payload?.ok === false) {
    const detail = payload?.error ?? {};
    const message =
      (typeof detail === 'string' ? detail : detail.message) ??
      payload?.message ??
      'MCP tool failed.';
    throw Object.assign(new Error(message), {
      platformCode: detail.platformCode ?? payload?.platformCode,
      httpStatus: detail.httpStatus ?? payload?.httpStatus,
    });
  }
  return payload;
}

export function validateProfile(value) {
  if (value?.robot !== undefined && !['microduck', 'originman'].includes(value.robot))
    throw new Error('Unsupported robot; no implicit robot fallback.');
  if (!value || value.schemaVersion !== 1 || typeof value.id !== 'string' || !value.id.trim())
    throw new Error('Profile requires schemaVersion=1 and a nonempty id.');
  if (!['reference', 'trained'].includes(value.policy?.source))
    throw new Error('policy.source must be reference or trained.');
  if (
    value.policy.source === 'trained' &&
    (typeof value.policy.runId !== 'string' ||
      !value.policy.runId.trim() ||
      !/^[a-f0-9]{64}$/.test(value.policy.sha256 ?? ''))
  )
    throw new Error(
      'Trained policy requires an explicit runId and SHA-256; latest is not selected.',
    );
  if (
    value.requiredTools !== undefined &&
    (!Array.isArray(value.requiredTools) || value.requiredTools.some((x) => typeof x !== 'string'))
  )
    throw new Error('requiredTools must be a string array.');
  if (
    value.trainingTemplate !== undefined &&
    (!value.trainingTemplate ||
      typeof value.trainingTemplate !== 'object' ||
      Array.isArray(value.trainingTemplate))
  )
    throw new Error('trainingTemplate must be an object.');
  return value;
}

export async function prepareExperience(profile, call, { baseUrl, tools, action = 'check' }) {
  validateProfile(profile);
  if (!['check', 'prepare', 'recover'].includes(action)) throw new Error('Unknown action.');
  const checks = [];
  const blocked = (id, reason) => checks.push({ id, status: 'blocked', reason });
  const required = new Set([
    'rdk_platform_status',
    'rdk_simulator_open',
    ...(profile.requiredTools ?? []),
  ]);
  if (profile.policy.source === 'trained') required.add('rdk_training_status');
  for (const name of required)
    if (!tools.includes(name)) blocked(name, '当前插件未提供所需工具，请核对兼容版本。');
  if (checks.some((check) => check.status === 'blocked'))
    return { status: 'blocked', profileId: profile.id, checks };
  const status = await call('rdk_platform_status', {});
  const degradations = status.health?.degraded ?? [];
  const blockingDegradations = degradations.filter(
    (reason) => !(profile.robot === 'originman' && reason === 'microduck-not-mounted'),
  );
  if (status.ok !== true || status.health?.ready !== true || blockingDegradations.length)
    blocked('platform', '平台未就绪或处于降级状态。');
  if (degradations.length !== blockingDegradations.length)
    checks.push({
      id: 'optional-microduck',
      status: 'not-required',
      reason: 'OriginMan 受扰恢复不依赖 MicroDuck 仿真资源；其他降级项仍阻塞。',
    });
  if (status.session?.authenticated !== true && status.authMode !== 'standalone-anonymous')
    blocked('session', '当前平台会话未认证，请在当前客户端登录。');
  if (checks.some((check) => check.status === 'blocked'))
    return { status: 'blocked', profileId: profile.id, checks };
  checks.push({ id: 'platform', status: 'passed' });
  if (profile.policy.source === 'trained') {
    const run = await call('rdk_training_status', { runId: profile.policy.runId });
    if (run.runId !== profile.policy.runId || run.status !== 'completed')
      blocked('policy', '指定训练尚未完成或返回的 Run 不匹配；不会换成另一条 Run。');
    // Status projections do not carry artifact SHA, retention or independent quality evidence.
    // Keep this explicit rather than inferring verified quality from completed.
    checks.push({
      id: 'policy-provenance',
      status: 'needs-verification',
      reason: '页面加载前核对指定 ONNX 摘要、非 mock 来源及独立评测；completed 不等于质量通过。',
    });
  }
  if (checks.some((c) => c.status === 'blocked'))
    return { status: 'blocked', profileId: profile.id, checks };
  let entry;
  try {
    entry = await call('rdk_simulator_open', {
      ...(profile.robot ? { robot: profile.robot } : {}),
      ...(profile.policy.source === 'trained' ? { runId: profile.policy.runId } : {}),
    });
  } catch (error) {
    if (
      profile.robot === 'originman' ||
      profile.policy.source !== 'reference' ||
      error.platformCode !== 'SIM2REAL_API_NOT_FOUND' ||
      error.httpStatus !== 404 ||
      !tools.includes('rdk_workspace_overview')
    )
      throw error;
    const overview = await call('rdk_workspace_overview', {});
    const simulator = overview.integrations?.simulator;
    if (typeof simulator === 'string') entry = { entryUrl: simulator };
    else if (simulator && typeof simulator.entryUrl === 'string') entry = simulator;
    else throw error;
    checks.push({
      id: 'simulator-api',
      status: 'compatibility',
      reason: '新版仿真入口 API 不存在；使用同账号 overview 提供的参考仿真入口，页面仍需实测。',
    });
  }
  if (profile.robot && entry.robot !== profile.robot)
    return {
      status: 'blocked',
      profileId: profile.id,
      checks: [
        ...checks,
        {
          id: 'robot',
          status: 'blocked',
          reason: 'Platform returned a different robot; refusing fallback.',
        },
      ],
    };
  if (entry.available === false)
    return {
      status: 'blocked',
      profileId: profile.id,
      checks: [
        ...checks,
        { id: 'simulator', status: 'blocked', reason: '平台报告参考仿真资源未就绪。' },
      ],
    };
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : baseUrl + '/');
  // Preserve a reverse proxy mount when older tools return root-relative paths.
  const rawEntry = String(entry.entryUrl ?? entry.url ?? entry.hostAction?.url ?? '');
  const relativeEntry = rawEntry.startsWith(base.pathname)
    ? rawEntry.slice(base.pathname.length)
    : rawEntry.replace(/^\/(?!\/)/, '');
  const target = new URL(relativeEntry, base);
  if (
    !rawEntry ||
    !['http:', 'https:'].includes(target.protocol) ||
    target.origin !== base.origin ||
    target.username ||
    target.password ||
    !target.pathname.startsWith(base.pathname)
  )
    throw new Error('Simulator entry must stay inside the configured platform origin and mount.');
  return {
    status: checks.some((c) => c.status === 'needs-verification')
      ? 'needs-verification'
      : 'prepared',
    profileId: profile.id,
    action,
    checks,
    entryUrl: target.href,
    policy: profile.policy,
    trainingTemplate: profile.trainingTemplate ?? null,
    execution: {
      browserOpened: false,
      policyLoaded: false,
      simulationRunning: false,
      resetCompleted: false,
    },
    next:
      profile.robot === 'originman'
        ? [
            '打开入口，确认 OriginMan 受扰恢复面板及当前账号。',
            '读取课程目录，核对 14→2 契约和执行资源，再显式提交训练与父 Run 评测。',
            '参考站姿与传统反馈用于主线；短训练如实对比。仅仿真，不产生真机部署资格。',
          ]
        : action === 'recover'
          ? [
              '在宿主可用的浏览器中停止当前仿真；有未保存录制时先处理保存。',
              '使用页面恢复初始场景，再重新选择配置指定策略，观察恢复结果。',
            ]
          : [
              '在宿主可用的浏览器中打开 entryUrl，观察引擎就绪。',
              '按配置选择参考或指定 Run 策略；核对加载结果，再尝试行走、停止。',
            ],
    note: '这里只做实时自检与准备；页面操作成功需宿主实际观察。训练模板仅供后续显式提交。',
  };
}

export function connectMcp({
  command = process.execPath,
  args = [
    fileURLToPath(
      new URL(
        existsSync(new URL('./start-core-mcp.mjs', import.meta.url))
          ? './start-core-mcp.mjs'
          : './start-mcp.mjs',
        import.meta.url,
      ),
    ),
  ],
  timeoutMs = 120000,
  env = process.env,
} = {}) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'], env });
  let sequence = 0;
  const pending = new Map();
  const rejectAll = (error) => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    pending.clear();
  };
  child.on('error', rejectAll);
  child.on('exit', () => rejectAll(new Error('MCP child exited.')));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    if (line.length > 1048576) {
      rejectAll(new Error('MCP response too large.'));
      child.kill();
      return;
    }
    try {
      const message = JSON.parse(line);
      const p = pending.get(message.id);
      if (!p) return;
      pending.delete(message.id);
      clearTimeout(p.timer);
      if (message.error) p.reject(new Error(message.error.message));
      else p.resolve(message.result);
    } catch {
      rejectAll(new Error('Invalid MCP protocol response.'));
    }
  });
  return {
    notify(method, params = {}) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    },
    request(method, params = {}, { signal } = {}) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error('MCP request cancelled.'));
          return;
        }
        const id = ++sequence;
        const cancel = () => {
          clearTimeout(timer);
          pending.delete(id);
          child.stdin.write(
            JSON.stringify({
              jsonrpc: '2.0',
              method: 'notifications/cancelled',
              params: { requestId: id },
            }) + '\n',
          );
          reject(new Error('MCP request cancelled.'));
        };
        const cleanup = () => signal?.removeEventListener('abort', cancel);
        const succeed = (value) => {
          cleanup();
          resolve(value);
        };
        const fail = (error) => {
          cleanup();
          reject(error);
        };
        const timer = setTimeout(() => {
          pending.delete(id);
          child.stdin.write(
            JSON.stringify({
              jsonrpc: '2.0',
              method: 'notifications/cancelled',
              params: { requestId: id },
            }) + '\n',
          );
          fail(new Error('MCP request timed out; no write will be retried.'));
        }, timeoutMs);
        pending.set(id, { resolve: succeed, reject: fail, timer });
        signal?.addEventListener('abort', cancel, { once: true });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    async close() {
      rejectAll(new Error('MCP connection closed.'));
      child.stdin.end();
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
        lines.close();
        return;
      }
      await new Promise((resolve) => {
        const timer = setTimeout(() => child.kill('SIGTERM'), 1000);
        const force = setTimeout(() => child.kill('SIGKILL'), 3000);
        child.once('exit', () => {
          clearTimeout(timer);
          clearTimeout(force);
          lines.close();
          resolve();
        });
      });
    },
  };
}

export async function main(args) {
  const [action, profileFile, ...rest] = args;
  if (rest.length || !['check', 'prepare', 'recover', 'validate'].includes(action) || !profileFile)
    throw new Error('Usage: experience.mjs check|prepare|recover|validate PROFILE.json');
  const profile = validateProfile(JSON.parse(readFileSync(profileFile, 'utf8')));
  if (action === 'validate') return { status: 'valid', profileId: profile.id };
  const client = connectMcp();
  try {
    await client.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'experience-preparation', version: '1.0.0' },
    });
    const catalog = await client.request('tools/list');
    const call = async (name, arguments_) => {
      const result = await client.request('tools/call', { name, arguments: arguments_ });
      return readToolResult(result);
    };
    const status = await call('rdk_platform_status', {});
    return await prepareExperience(profile, call, {
      baseUrl: status.baseUrl,
      tools: catalog.tools.map((t) => t.name),
      action,
    });
  } finally {
    await client.close();
  }
}
if (isDirectInvocation(import.meta.url)) {
  main(process.argv.slice(2))
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      if (result.status === 'blocked' || result.status === 'needs-verification')
        process.exitCode = 2;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
