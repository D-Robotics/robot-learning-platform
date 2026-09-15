/**
 * d-obs 事件埋点上报器（零依赖：node:crypto + 全局 fetch）。
 *
 * 职责边界：本模块只做"采集 → 队列 → 批量单飞 POST /api/ops/events"。
 * 领域事件映射、HTTP 5xx 钩子、登录与进程错误埋点都通过 reportEvent 进来，
 * 传输失败绝不影响业务主链路（与插件总线同一约定：错误消毒后打 stderr）。
 *
 * 契约（d-obs docs/event-ingest.md）：schema 'rdk.dobs.ops-events.v1'，
 * 批次 ≤64 条；eventId 是幂等键（d-obs 侧指纹去重 1h），重试整批重放安全。
 *
 * env（未配置即整体停用，本地开发/CI 零影响）：
 *   RDK_SIM2REAL_DOBS_URL          上报地址（如 http://127.0.0.1:18093）
 *   RDK_SIM2REAL_DOBS_TOKEN_FILE   64-hex 探针 token 文件路径
 *   RDK_SIM2REAL_DOBS_REPORT_ENABLED=0  kill switch
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { Sim2RealDomainEvent, Sim2RealDomainEventType } from '../../shared/sim2real-events.js';
import { redactInternalError } from './http-helpers.js';

export const DOBS_OPS_EVENTS_SCHEMA = 'rdk.dobs.ops-events.v1' as const;

export const DOBS_URL_ENV = 'RDK_SIM2REAL_DOBS_URL';
export const DOBS_TOKEN_FILE_ENV = 'RDK_SIM2REAL_DOBS_TOKEN_FILE';
export const DOBS_REPORT_ENABLED_ENV = 'RDK_SIM2REAL_DOBS_REPORT_ENABLED';

const COMPONENT = 'sim2real-web';
const TOKEN_RE = /^[a-f0-9]{64}$/i;

const QUEUE_CAP = 1_000;
const BATCH_MAX = 64;
const BATCH_MIN_FLUSH = 8;
const FLUSH_INTERVAL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 6_000;
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000] as const;
const MAX_CONSECUTIVE_FAILURES = 5;

export type DobsOpsEventInput = {
  eventCode: string;
  outcome: 'ok' | 'error' | 'rejected' | 'degraded';
  severityHint?: 'info' | 'warning' | 'critical';
  safeSummary?: string;
  metadata?: Record<string, string | number | boolean | null | undefined>;
  correlation?: {
    runId?: string;
    userId?: string;
    sessionId?: string;
    deviceId?: string;
  };
  eventId?: string;
  occurredAt?: string;
};

export type DobsOpsReporterOptions = {
  url?: string;
  tokenFile?: string;
  enabled?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
  logError?: (message: string) => void;
  flushIntervalMs?: number;
};

export type DobsOpsReporter = {
  readonly enabled: boolean;
  reportEvent(input: DobsOpsEventInput): void;
  /** 领域事件 → 低敏 ops 事件的映射插件处理器。 */
  onDomainEvent(event: Sim2RealDomainEvent): void;
  /** 插件总线订阅的事件集（排除 telemetry.appended 防噪音）。 */
  readonly domainEventFilter: readonly Sim2RealDomainEventType[];
  health(): {
    enabled: boolean;
    configured: boolean;
    queued: number;
    dropped: number;
    lastErrorAt?: string;
    lastFlushAt?: string;
  };
  flush(): Promise<void>;
  dispose(): void;
};

/** 领域事件类型 → event_code（d-obs 工作台按 event_code 聚合展示）。 */
const DOMAIN_EVENT_CODES: Partial<Record<Sim2RealDomainEventType, string>> = {
  'project.created': 'project_created',
  'project.updated': 'project_updated',
  'dataset.created': 'dataset_created',
  'dataset.updated': 'dataset_updated',
  'model.created': 'model_registered',
  'run.created': 'run_created',
  'run.updated': 'run_status_changed',
  'deployment.created': 'deployment_created',
  'deployment.updated': 'deployment_status_changed',
  'evaluation.created': 'evaluation_created',
  'evaluation.updated': 'evaluation_updated',
  'artifact.created': 'artifact_created',
  'artifact.updated': 'artifact_updated',
  'artifact.revoked': 'artifact_revoked',
};

function pickStatus(data: Record<string, unknown>): string | undefined {
  const value = data?.status;
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 40) : undefined;
}

function pickString(data: Record<string, unknown>, key: string, cap: number): string | undefined {
  const value = data?.[key];
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, cap) : undefined;
}

function envEnabled(): boolean {
  return String(process.env[DOBS_REPORT_ENABLED_ENV] ?? '').trim() !== '0';
}

export function createDobsOpsReporter(options: DobsOpsReporterOptions = {}): DobsOpsReporter {
  const url = String(options.url ?? process.env[DOBS_URL_ENV] ?? '').trim();
  const tokenFile = String(options.tokenFile ?? process.env[DOBS_TOKEN_FILE_ENV] ?? '').trim();
  const configured = url.length > 0 && tokenFile.length > 0;
  const enabled = (options.enabled ?? envEnabled()) && configured;
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const logError =
    options.logError ??
    ((message: string) => {
      console.error(message);
    });

  interface QueuedEvent extends DobsOpsEventInput {
    eventId: string;
    occurredAt: string;
  }

  const queue: QueuedEvent[] = [];
  let dropped = 0;
  let inFlight: Promise<void> | null = null;
  let flushTimer: ReturnType<typeof setInterval> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let consecutiveFailures = 0;
  let retryIndex = 0;
  let lastErrorAt: string | undefined;
  let lastFlushAt: string | undefined;
  let disposed = false;
  let cachedToken = '';
  let tokenLoadedAt = 0;

  if (enabled && (options.flushIntervalMs ?? FLUSH_INTERVAL_MS) > 0) {
    flushTimer = setInterval(() => {
      void flush();
    }, options.flushIntervalMs ?? FLUSH_INTERVAL_MS);
    flushTimer.unref?.();
  }

  async function loadToken(): Promise<string> {
    if (cachedToken && now() - tokenLoadedAt < 60_000) return cachedToken;
    const token = String(await readFile(tokenFile, 'utf8')).trim();
    if (!TOKEN_RE.test(token)) throw new Error(`d-obs token file ${tokenFile} is not 64-hex`);
    cachedToken = token;
    tokenLoadedAt = now();
    return token;
  }

  function invalidateToken(): void {
    cachedToken = '';
    tokenLoadedAt = 0;
  }

  function reportEvent(input: DobsOpsEventInput): void {
    if (!enabled || disposed) return;
    if (queue.length >= QUEUE_CAP) {
      // 溢出丢最旧：新鲜事件比老事件更有诊断价值，丢旧计数可观测。
      queue.shift();
      dropped += 1;
    }
    queue.push({
      ...input,
      eventId: input.eventId ?? randomUUID(),
      occurredAt: input.occurredAt ?? new Date(now()).toISOString(),
    });
    if (queue.length >= BATCH_MIN_FLUSH) void flush();
  }

  function onDomainEvent(event: Sim2RealDomainEvent): void {
    const eventCode = DOMAIN_EVENT_CODES[event.type];
    if (!eventCode) return;
    const data =
      event.data && typeof event.data === 'object' && !Array.isArray(event.data)
        ? (event.data as Record<string, unknown>)
        : {};
    const status = pickStatus(data);
    const failed = status === 'failed' || status === 'blocked';
    const correlation: DobsOpsEventInput['correlation'] = {};
    const runId =
      pickString(data, 'runId', 200) ??
      (event.type.startsWith('run.') ? event.entityId : undefined);
    if (runId) correlation.runId = runId;
    if (event.owner) correlation.userId = event.owner.slice(0, 200);
    const deviceId = pickString(data, 'deviceId', 200);
    if (deviceId) correlation.deviceId = deviceId;
    reportEvent({
      eventCode,
      outcome: failed ? 'error' : 'ok',
      ...(failed ? { severityHint: 'warning' } : {}),
      ...(status ? { safeSummary: `${event.type} status=${status}` } : {}),
      metadata: {
        domainEventType: event.type,
        ...(pickString(data, 'engine', 40) ? { engine: pickString(data, 'engine', 40) } : {}),
        ...(pickString(data, 'backend', 40) ? { backend: pickString(data, 'backend', 40) } : {}),
        ...(pickString(data, 'taskId', 80) ? { taskId: pickString(data, 'taskId', 80) } : {}),
        ...(pickString(data, 'modelId', 200) ? { modelId: pickString(data, 'modelId', 200) } : {}),
        ...(status ? { status } : {}),
      },
      ...(Object.keys(correlation).length ? { correlation } : {}),
      eventId: event.id,
      occurredAt: event.at,
    });
  }

  async function postBatch(batch: QueuedEvent[]): Promise<'ok' | 'retry' | 'auth'> {
    const token = await loadToken();
    const response = await doFetch(`${url}/api/ops/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-rdk-tenant-probe-token': token,
        'user-agent': 'sim2real-dobs-reporter/1',
      },
      body: JSON.stringify({
        schema: DOBS_OPS_EVENTS_SCHEMA,
        producedBy: COMPONENT,
        events: batch.slice(0, BATCH_MAX).map((event) => ({
          eventId: event.eventId,
          component: COMPONENT,
          eventCode: event.eventCode,
          outcome: event.outcome,
          ...(event.severityHint ? { severityHint: event.severityHint } : {}),
          ...(event.safeSummary ? { safeSummary: event.safeSummary } : {}),
          ...(event.metadata ? { metadata: event.metadata } : {}),
          ...(event.correlation ? { correlation: event.correlation } : {}),
          occurredAt: event.occurredAt,
        })),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 401) return 'auth';
    // 202 接受即成功；其余（429/5xx，以及除 401 外的 4xx 契约错误）统一按
    // 可重试处理，交给连续失败熔断兜底，避免细分语义造成丢批过早。
    if (response.ok) return 'ok';
    return 'retry';
  }

  async function flush(): Promise<void> {
    if (!enabled || disposed || inFlight) return;
    if (queue.length === 0) return;
    const batch = queue.splice(0, BATCH_MAX);
    inFlight = (async () => {
      try {
        const result = await postBatch(batch);
        if (result === 'auth') {
          invalidateToken();
          const retry = await postBatch(batch);
          if (retry === 'auth') {
            // token 轮换后仍被拒：事件退回队列头部，等下次 flush 再试一次。
            queue.unshift(...batch);
            throw new Error('d-obs rejected token after rotation');
          }
          if (retry === 'retry') throw new Error('d-obs unavailable after auth retry');
        } else if (result === 'retry') {
          throw new Error('d-obs ingest unavailable');
        }
        consecutiveFailures = 0;
        retryIndex = 0;
        lastFlushAt = new Date(now()).toISOString();
      } catch (error) {
        consecutiveFailures += 1;
        lastErrorAt = new Date(now()).toISOString();
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          // 熔断：目标长时间不可用时丢弃积压（含已 splice 的本批），防止
          // 队列被陈旧事件占满。
          const droppedNow = batch.length + queue.length;
          dropped += droppedNow;
          queue.length = 0;
          consecutiveFailures = 0;
          logError(`[sim2real] d-obs reporter dropped ${droppedNow} events after failures`);
        } else {
          queue.unshift(...batch);
          const delay = RETRY_DELAYS_MS[Math.min(retryIndex, RETRY_DELAYS_MS.length - 1)];
          retryIndex += 1;
          if (retryTimer) clearTimeout(retryTimer);
          retryTimer = setTimeout(() => {
            void flush();
          }, delay);
          retryTimer.unref?.();
          logError(
            `[sim2real] d-obs reporter flush failed (${redactInternalError(error)}), retry in ${delay}ms`,
          );
        }
      } finally {
        inFlight = null;
        // 锁释放后仍有积压（自动 flush 在锁期间被跳过的批次）且无退避
        // 定时器接管时，立即续一批；失败路径由 retryTimer 调度，不叠加。
        if (!disposed && queue.length >= BATCH_MIN_FLUSH && !retryTimer) {
          void flush();
        }
      }
    })();
    await inFlight;
  }

  function dispose(): void {
    disposed = true;
    if (flushTimer) clearInterval(flushTimer);
    if (retryTimer) clearTimeout(retryTimer);
  }

  return {
    enabled,
    reportEvent,
    onDomainEvent,
    domainEventFilter: Object.keys(DOMAIN_EVENT_CODES) as Sim2RealDomainEventType[],
    health: () => ({
      enabled,
      configured,
      queued: queue.length,
      dropped,
      ...(lastErrorAt ? { lastErrorAt } : {}),
      ...(lastFlushAt ? { lastFlushAt } : {}),
    }),
    flush,
    dispose,
  };
}
