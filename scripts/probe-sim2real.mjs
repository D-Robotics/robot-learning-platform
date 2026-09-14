#!/usr/bin/env node

/**
 * External operational probe for a running Sim2Real service.
 *
 * It checks the three endpoints an ingress/load-balancer needs: health,
 * readiness and Prometheus metrics.  The probe is intentionally independent
 * of the service's TypeScript modules so it can run from a monitoring host or
 * a post-deploy job with only Node.js installed.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_RETRIES = 2;

function parseArgs(argv) {
  const options = {
    url:
      process.env.RDK_SIM2REAL_PROBE_URL ||
      `http://127.0.0.1:${process.env.RDK_SIM2REAL_PORT || 18102}`,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    retries: DEFAULT_RETRIES,
    allowDegraded: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--url') options.url = argv[++index] || '';
    else if (arg === '--timeout-ms')
      options.timeoutMs = boundedNumber(argv[++index], 100, 30_000, DEFAULT_TIMEOUT_MS);
    else if (arg === '--retries')
      options.retries = boundedNumber(argv[++index], 0, 5, DEFAULT_RETRIES);
    else if (arg === '--allow-degraded') options.allowDegraded = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(
        '用法: probe-sim2real.mjs [--url URL] [--timeout-ms N] [--retries N] [--allow-degraded] [--json]',
      );
      process.exit(0);
    } else throw new Error(`未知参数 ${arg}`);
  }
  return options;
}

function boundedNumber(raw, min, max, fallback) {
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function normalizeBaseUrl(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw));
  } catch {
    throw new Error('探针 URL 不是合法 URL');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('探针 URL 只能使用无凭据的 http(s) Origin/路径');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed;
}

function endpoint(base, suffix) {
  const path = `${base.pathname || ''}/${suffix}`.replace(/\/+/g, '/');
  const url = new URL(base.toString());
  url.pathname = path.startsWith('/') ? path : `/${path}`;
  url.search = '';
  url.hash = '';
  return url;
}

async function fetchWithRetry(url, options) {
  let lastError;
  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    const startedAt = Date.now();
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(options.timeoutMs),
        headers: { accept: 'application/json, text/plain' },
      });
      const contentType = response.headers.get('content-type') || '';
      const text = await response.text();
      let body = null;
      if (contentType.includes('json')) {
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
      }
      return {
        status: response.status,
        contentType,
        body,
        text,
        durationMs: Date.now() - startedAt,
        requestId: response.headers.get('x-request-id') || '',
      };
    } catch (error) {
      lastError = error;
      if (attempt < options.retries)
        await new Promise((resolve) => setTimeout(resolve, Math.min(250, 50 * 2 ** attempt)));
    }
  }
  return {
    error: lastError instanceof Error ? lastError.message : String(lastError),
    durationMs: 0,
  };
}

function check(checks, id, ok, detail, hint) {
  checks.push({ id, status: ok ? 'pass' : 'fail', detail, ...(hint ? { hint } : {}) });
}

export async function probeSim2Real({
  url,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retries = DEFAULT_RETRIES,
  allowDegraded = false,
} = {}) {
  const base = normalizeBaseUrl(url);
  const checks = [];
  const options = { timeoutMs, retries };
  const health = await fetchWithRetry(endpoint(base, 'healthz'), options);
  check(
    checks,
    'healthz',
    health.status === 200 && health.body?.ok === true && health.body?.service === 'sim2real-web',
    health.error
      ? `请求失败：${health.error}`
      : `HTTP ${health.status ?? 0} · ${health.durationMs} ms`,
    '确认进程、端口和反向代理路由',
  );
  if (health.body && typeof health.body === 'object') {
    // The published contract uses numeric schemaVersion=1.  Older standalone
    // releases emitted the equivalent string "v1"; accept that representation
    // during a rolling upgrade so a monitor does not page while instances are
    // being replaced, but reject arbitrary/missing values.
    const schema = health.body.schemaVersion;
    const schemaValid =
      (typeof schema === 'number' && Number.isSafeInteger(schema) && schema > 0) ||
      (typeof schema === 'string' && /^v?\d+$/.test(schema));
    check(
      checks,
      'health-contract',
      schemaValid &&
        typeof health.body.ready === 'boolean' &&
        typeof health.body.storage === 'object',
      '健康响应包含 schema、ready 和 storage 字段',
      '升级服务或检查健康响应契约',
    );
  } else {
    check(
      checks,
      'health-contract',
      false,
      '健康响应不是 JSON',
      '确认网关没有把 HTML 错误页转发给探针',
    );
  }

  const ready = await fetchWithRetry(endpoint(base, 'readyz'), options);
  const readyOk = ready.status === 200 && ready.body?.ok === true && ready.body?.ready === true;
  const degradedAllowed = allowDegraded && ready.status === 503 && ready.body?.ready === false;
  check(
    checks,
    'readyz',
    readyOk || degradedAllowed,
    ready.error
      ? `请求失败：${ready.error}`
      : `HTTP ${ready.status ?? 0} · ready=${String(ready.body?.ready)} · ${ready.durationMs} ms`,
    degradedAllowed
      ? '当前为降级就绪；修复 degraded 后再接收生产流量'
      : '检查 storage、SSO、MicroDuck 和 runner 配置',
  );

  const metrics = await fetchWithRetry(endpoint(base, 'metrics'), options);
  const metricsText = metrics.text || '';
  const metricsOk =
    metrics.status === 200 &&
    metrics.contentType.includes('text/plain') &&
    metricsText.includes('sim2real_http_requests_total') &&
    metricsText.includes('sim2real_process_uptime_seconds');
  check(
    checks,
    'metrics',
    metricsOk,
    metrics.error
      ? `请求失败：${metrics.error}`
      : `HTTP ${metrics.status ?? 0} · ${metrics.durationMs} ms`,
    '确认 /metrics 未被鉴权或网关 HTML fallback 拦截',
  );
  check(
    checks,
    'metrics-redaction',
    !/(authorization|cookie|token|secret|password)/i.test(metricsText),
    '指标输出未发现凭据字段',
    '不要把请求头、token 或 secret 加入 Prometheus 标签/值',
  );

  return {
    ok: checks.every((item) => item.status === 'pass'),
    target: `${base.origin}${base.pathname || ''}`,
    checkedAt: new Date().toISOString(),
    checks,
    responses: {
      healthz: {
        status: health.status ?? 0,
        durationMs: health.durationMs,
        requestId: health.requestId || undefined,
      },
      readyz: {
        status: ready.status ?? 0,
        durationMs: ready.durationMs,
        requestId: ready.requestId || undefined,
      },
      metrics: {
        status: metrics.status ?? 0,
        durationMs: metrics.durationMs,
        requestId: metrics.requestId || undefined,
      },
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await probeSim2Real(options);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`\nRDK Sim2Real 服务探针 — ${report.target}`);
    for (const item of report.checks) {
      console.log(`  ${item.status === 'pass' ? '✓' : '✗'} ${item.id} — ${item.detail}`);
      if (item.hint && item.status === 'fail') console.log(`      ↳ ${item.hint}`);
    }
    console.log(`\n结论: ${report.ok ? '通过' : '阻断'}\n`);
  }
  process.exitCode = report.ok ? 0 : 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error) => {
    console.error(
      `[sim2real-probe] FAIL — ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
