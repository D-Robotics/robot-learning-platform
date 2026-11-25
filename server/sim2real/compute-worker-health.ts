import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Sim2RealComputeResource } from '../../shared/sim2real.js';
import { normalizeComputeRunnerUrl } from './robogo-runner.js';

const COMPUTE_HEALTH_RESPONSE_MAX_BYTES = 32 * 1024;

/** Keep operator-visible worker fields bounded and free of terminal controls. */
export function safeComputeHealthText(value: unknown, max = 160): string {
  if (typeof value !== 'string') return '';
  let output = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    output += code >= 0 && code <= 0x1f ? ' ' : code === 0x7f ? ' ' : character;
    if (output.length >= max) break;
  }
  return output.trim().slice(0, max);
}

/**
 * Read a health response without allowing a remote worker to make this web
 * process buffer an unbounded body.  A content-length hint is checked before
 * streaming, then the stream is bounded again for chunked responses.
 */
async function boundedComputeHealthText(response: globalThis.Response): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared != null) {
    const normalized = declared.trim();
    const length = /^\d+$/.test(normalized) ? Number(normalized) : Number.NaN;
    if (!Number.isSafeInteger(length) || length < 0 || length > COMPUTE_HEALTH_RESPONSE_MAX_BYTES) {
      throw new Error('compute_health_response_too_large');
    }
  }
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > COMPUTE_HEALTH_RESPONSE_MAX_BYTES) {
      throw new Error('compute_health_response_too_large');
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > COMPUTE_HEALTH_RESPONSE_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error('compute_health_response_too_large');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

interface ComputeHealthPayload {
  engines?: string[];
  mock?: boolean;
  cuda?: boolean;
  gpuName?: string;
  vramMb?: number;
  maxConcurrentJobs?: number;
  activeJobs?: number;
  queuedJobs?: number;
}

/** Accept only the small, explicit health contract used by the worker. */
function parseComputeHealthPayload(text: string): ComputeHealthPayload | null {
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const source = parsed as Record<string, unknown>;
  // HTTP 200 alone is not proof that a worker is configured or ready.  The
  // worker's explicit boolean is the source of truth for readiness.
  if (source.ok !== true) return null;
  const boundedInteger = (key: string, min: number, max: number): number | undefined => {
    if (source[key] == null) return undefined;
    const value = Number(source[key]);
    return Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
  };
  const maxConcurrentJobs = boundedInteger('maxConcurrentJobs', 1, 32);
  const vramMb = boundedInteger('vramMb', 0, 2_000_000);
  const activeJobs = boundedInteger('activeJobs', 0, maxConcurrentJobs ?? 32);
  const queuedJobs = boundedInteger('queuedJobs', 0, 1000);
  // If a worker sends a field, reject malformed values rather than silently
  // storing a misleading partial health record.
  if (source.maxConcurrentJobs != null && maxConcurrentJobs == null) return null;
  if (source.vramMb != null && vramMb == null) return null;
  const gpuName = safeComputeHealthText(source.gpuName, 160);
  const engines = Array.isArray(source.engines)
    ? source.engines
        .filter(
          (engine): engine is string =>
            typeof engine === 'string' && /^[a-z][a-z0-9-]{1,31}$/.test(engine),
        )
        .slice(0, 64)
    : undefined;
  return {
    ...(engines ? { engines } : {}),
    ...(typeof source.mock === 'boolean' ? { mock: source.mock } : {}),
    ...(typeof source.cuda === 'boolean' ? { cuda: source.cuda } : {}),
    ...(gpuName ? { gpuName } : {}),
    ...(vramMb == null ? {} : { vramMb }),
    ...(maxConcurrentJobs == null ? {} : { maxConcurrentJobs }),
    ...(activeJobs == null ? {} : { activeJobs }),
    ...(queuedJobs == null ? {} : { queuedJobs }),
  };
}

type Diagnostic = {
  code: string;
  message: string;
  recovery: string;
  httpStatus?: number;
};

export function computeWorkerHealthPatch(
  { diagnostic, payload }: { diagnostic: Diagnostic; payload: ComputeHealthPayload | null },
  checkedAt: string,
): Partial<Sim2RealComputeResource> {
  return {
    status: payload ? 'online' : 'offline',
    message: diagnostic.message,
    lastCheckedAt: checkedAt,
    engines: payload?.engines ?? [],
    mock: payload?.mock,
    ...(payload?.cuda == null ? {} : { cuda: payload.cuda }),
    ...(payload?.gpuName ? { gpuName: payload.gpuName } : {}),
    ...(payload?.vramMb == null ? {} : { vramMb: payload.vramMb }),
    ...(payload?.maxConcurrentJobs == null ? {} : { maxConcurrentJobs: payload.maxConcurrentJobs }),
    activeJobs: payload?.activeJobs,
    queuedJobs: payload?.queuedJobs,
  };
}

const workerFailures = {
  timeout: {
    code: 'WORKER_TIMEOUT',
    message: '连接超时：Worker 未在 5 秒内完成健康响应。',
    recovery: '确认服务正在监听，检查防火墙和 /healthz 的响应时间后再测试。',
  },
  dns: {
    code: 'WORKER_DNS_FAILED',
    message: 'Worker 域名无法解析。',
    recovery: '检查域名拼写及 A/AAAA 记录，再从平台网络测试解析。',
  },
  refused: {
    code: 'WORKER_CONNECTION_REFUSED',
    message: 'Worker 拒绝了 TCP 连接。',
    recovery: '确认 Worker 已启动，检查公开端口、反向代理和防火墙。',
  },
  tls: {
    code: 'WORKER_TLS_FAILED',
    message: 'Worker 的 TLS 握手或证书校验失败。',
    recovery: '核对 HTTPS 域名、证书有效期和完整证书链，再测试连接。',
  },
  transport: {
    code: 'WORKER_NETWORK_FAILED',
    message: 'Worker 连接中断或网络不可达。',
    recovery: '检查平台到 Worker 的路由与防火墙，确认 HTTPS 端点可达。',
  },
} satisfies Record<string, Diagnostic>;

function networkFailure(error: unknown, timedOut: boolean): Diagnostic {
  const cause = error instanceof Error ? (error.cause ?? error) : error;
  const causes = cause instanceof AggregateError ? cause.errors : [cause];
  const codes = causes.map((item) => String(item?.code ?? ''));
  if (
    timedOut ||
    codes.some((code) =>
      ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'].includes(code),
    )
  )
    return workerFailures.timeout;
  if (codes.some((code) => ['ENOTFOUND', 'EAI_AGAIN', 'ENODATA'].includes(code)))
    return workerFailures.dns;
  if (codes.includes('ECONNREFUSED')) return workerFailures.refused;
  if (
    codes.some((code) =>
      /^(ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO_|UNABLE_TO_|SELF_SIGNED_)/.test(code),
    )
  )
    return workerFailures.tls;
  if (cause instanceof Error && cause.message === 'unexpected redirect')
    return {
      code: 'WORKER_REDIRECT',
      message: 'Worker 的健康接口返回了重定向。',
      recovery: '把 Runner URL 改为最终服务地址，确保对应的 /healthz 直接返回 JSON。',
    };
  return workerFailures.transport;
}

async function resolvedAddresses(host: string): Promise<string[]> {
  if (isIP(host)) return [host];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      lookup(host, { all: true })
        .then((entries) => [...new Set(entries.map((entry) => entry.address))].slice(0, 8))
        .catch(() => []),
      new Promise<string[]>((resolve) => {
        timer = setTimeout(() => resolve([]), 250);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function probeComputeWorker(runnerUrl: string, token: string) {
  let endpoint: URL;
  try {
    endpoint = new URL(normalizeComputeRunnerUrl(runnerUrl, 'server-runner'));
  } catch (error) {
    return {
      payload: null,
      diagnostic: {
        code: 'WORKER_URL_INVALID',
        message: error instanceof Error ? error.message : 'Runner 地址无效。',
        recovery: '修正当前算力资源的 Runner 地址，再测试连接。',
      },
    };
  }
  endpoint.pathname = endpoint.pathname.slice(0, -'/train'.length) + '/healthz';
  const host = endpoint.hostname.replace(/^\[|\]$/g, '');
  const port = Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80));
  const headers = {
    accept: 'application/json',
    ...(token ? { authorization: 'Bearer ' + token } : {}),
  };
  const signal = AbortSignal.timeout(5_000);
  let diagnostic: Diagnostic;
  let payload: ComputeHealthPayload | null = null;
  try {
    const result = await fetch(endpoint, { method: 'GET', headers, redirect: 'error', signal });
    if (!result.ok) {
      await result.body?.cancel().catch(() => undefined);
      diagnostic = {
        code: 'WORKER_HTTP_ERROR',
        httpStatus: result.status,
        message: `Worker 返回 HTTP ${result.status}。`,
        recovery:
          result.status === 401 || result.status === 403
            ? '确认平台登记的 bearer token 与 Worker 一致，并允许 GET /healthz。'
            : result.status === 404
              ? '核对反向代理路径，确保 /train 的同级 /healthz 已暴露。'
              : '查看 Worker 服务和反向代理日志，恢复 /healthz 的 2xx 响应。',
      };
    } else {
      try {
        payload = parseComputeHealthPayload(await boundedComputeHealthText(result));
        diagnostic = payload
          ? {
              code: 'WORKER_HEALTHY',
              message: 'Worker 连接正常。',
              recovery: '按返回的 engines 和 cuda 选择训练配置。',
            }
          : {
              code: 'WORKER_HEALTH_PAYLOAD_INVALID',
              message: 'Worker 返回无效健康响应。',
              recovery: '检查 GET /healthz 的 JSON 对象，健康时必须返回 ok: true。',
            };
      } catch (error) {
        await result.body?.cancel().catch(() => undefined);
        if (signal.aborted) throw error;
        const overLimit =
          error instanceof Error && error.message === 'compute_health_response_too_large';
        diagnostic = {
          code: overLimit ? 'WORKER_HEALTH_BODY_TOO_LARGE' : 'WORKER_HEALTH_BODY_UNREADABLE',
          message: overLimit
            ? 'Worker 健康响应过大，已拒绝。'
            : 'Worker 健康响应无法读取，已拒绝。',
          recovery: '检查 /healthz 响应体完整性，并保持在 32 KiB 以内。',
        };
      }
    }
  } catch (error) {
    diagnostic = networkFailure(error, signal.aborted);
  }
  return {
    payload,
    diagnostic: {
      ...diagnostic,
      endpoint: {
        host,
        port,
        path: endpoint.pathname,
        resolvedAddresses:
          diagnostic.code === 'WORKER_DNS_FAILED' ? [] : await resolvedAddresses(host),
      },
    },
  };
}
