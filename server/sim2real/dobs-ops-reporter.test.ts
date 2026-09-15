import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createDobsOpsReporter,
  DOBS_OPS_EVENTS_SCHEMA,
  DOBS_REPORT_ENABLED_ENV,
  DOBS_TOKEN_FILE_ENV,
  DOBS_URL_ENV,
  type DobsOpsEventInput,
} from './dobs-ops-reporter.js';
import type { Sim2RealDomainEvent } from '../../shared/sim2real-events.js';

const originalEnv = { ...process.env };
const temporaryFiles: string[] = [];

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  for (const file of temporaryFiles.splice(0)) {
    void fs.rm(file, { force: true }).catch(() => {});
  }
  vi.restoreAllMocks();
});

const TOKEN = 'a'.repeat(64);

async function tokenFile(): Promise<string> {
  const file = path.join(os.tmpdir(), `dobs-reporter-test-${Date.now()}-${Math.random()}.token`);
  await fs.writeFile(file, TOKEN, 'utf8');
  temporaryFiles.push(file);
  return file;
}

type FetchCall = { url: string; body: Record<string, unknown>; headers: Record<string, string> };

function fakeFetch(handler: (call: FetchCall) => { status: number; ok?: boolean }) {
  const calls: FetchCall[] = [];
  const impl: typeof fetch = async (input, init) => {
    const call: FetchCall = {
      url: String(input),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    const result = handler(call);
    return new Response(JSON.stringify({ ok: result.ok ?? true }), {
      status: result.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { impl, calls };
}

function domainEvent(overrides: Partial<Sim2RealDomainEvent> = {}): Sim2RealDomainEvent {
  return {
    id: '0b74e5c1-1111-4a2b-9c3d-1234567890ab',
    type: 'run.updated',
    at: '2026-09-15T08:00:00.000Z',
    entityId: 'run-1',
    data: { status: 'failed', engine: 'starter-ppo' },
    ...overrides,
  };
}

describe('createDobsOpsReporter', () => {
  it('未配置 env 时整体停用：reportEvent 空转、不读文件不发请求', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 202 }));
    const reporter = createDobsOpsReporter({ fetchImpl: impl, flushIntervalMs: 0 });
    expect(reporter.enabled).toBe(false);
    reporter.reportEvent({ eventCode: 'run_created', outcome: 'ok' });
    reporter.onDomainEvent(domainEvent());
    await reporter.flush();
    expect(calls.length).toBe(0);
    expect(reporter.health()).toEqual({ enabled: false, configured: false, queued: 0, dropped: 0 });
    reporter.dispose();
  });

  it('kill switch：RDK_SIM2REAL_DOBS_REPORT_ENABLED=0 时即使配置齐全也停用', async () => {
    process.env[DOBS_URL_ENV] = 'http://127.0.0.1:47110';
    process.env[DOBS_TOKEN_FILE_ENV] = await tokenFile();
    process.env[DOBS_REPORT_ENABLED_ENV] = '0';
    const { impl, calls } = fakeFetch(() => ({ status: 202 }));
    const reporter = createDobsOpsReporter({ fetchImpl: impl, flushIntervalMs: 0 });
    expect(reporter.enabled).toBe(false);
    reporter.reportEvent({ eventCode: 'run_created', outcome: 'ok' });
    await reporter.flush();
    expect(calls.length).toBe(0);
    reporter.dispose();
  });

  it('领域事件映射：run failed → outcome=error + warning；事件 id 作幂等键', async () => {
    const file = await tokenFile();
    const { impl, calls } = fakeFetch(() => ({ status: 202 }));
    const reporter = createDobsOpsReporter({
      url: 'http://127.0.0.1:47110',
      tokenFile: file,
      fetchImpl: impl,
      flushIntervalMs: 0,
    });
    reporter.onDomainEvent(domainEvent());
    await reporter.flush();
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('http://127.0.0.1:47110/api/ops/events');
    expect(calls[0].headers['x-rdk-tenant-probe-token']).toBe(TOKEN);
    const body = calls[0].body;
    expect(body.schema).toBe(DOBS_OPS_EVENTS_SCHEMA);
    expect(body.producedBy).toBe('sim2real-web');
    const event = (body.events as Array<Record<string, unknown>>)[0];
    expect(event.eventId).toBe('0b74e5c1-1111-4a2b-9c3d-1234567890ab');
    expect(event.eventCode).toBe('run_status_changed');
    expect(event.outcome).toBe('error');
    expect(event.severityHint).toBe('warning');
    expect((event.correlation as Record<string, unknown>).runId).toBe('run-1');
    expect((event.metadata as Record<string, unknown>).status).toBe('failed');
    reporter.dispose();
  });

  it('领域事件映射：completed → outcome=ok；telemetry.appended 被忽略（防噪音）', async () => {
    const file = await tokenFile();
    const { impl, calls } = fakeFetch(() => ({ status: 202 }));
    const reporter = createDobsOpsReporter({
      url: 'http://127.0.0.1:47110',
      tokenFile: file,
      fetchImpl: impl,
      flushIntervalMs: 0,
    });
    reporter.onDomainEvent(domainEvent({ data: { status: 'completed' } }));
    reporter.onDomainEvent(
      domainEvent({ type: 'telemetry.appended', data: { sampleCount: 500 } as unknown }),
    );
    await reporter.flush();
    expect(calls.length).toBe(1);
    const event = (calls[0].body.events as Array<Record<string, unknown>>)[0];
    expect(event.outcome).toBe('ok');
    expect(event.severityHint).toBeUndefined();
    expect(reporter.domainEventFilter).not.toContain('telemetry.appended');
    reporter.dispose();
  });

  it('队列上限保护：超量事件不崩、批量分片送达、队列不无限增长', async () => {
    const file = await tokenFile();
    const { impl, calls } = fakeFetch(() => ({ status: 202 }));
    const reporter = createDobsOpsReporter({
      url: 'http://127.0.0.1:47110',
      tokenFile: file,
      fetchImpl: impl,
      flushIntervalMs: 0,
    });
    const input: DobsOpsEventInput = { eventCode: 'run_created', outcome: 'ok' };
    for (let index = 0; index < 1_005; index += 1) {
      reporter.reportEvent({ ...input, eventId: `evt-${index}` });
    }
    // 满 8 条自动单飞批量（≤64/批）：1005 条事件分多批链式送达。自动
    // flush 不返回 promise 给调用方，等一小段时间让整条链落地。
    await new Promise((resolve) => setTimeout(resolve, 200));
    const delivered = calls.flatMap((call) => call.body.events as unknown[]);
    expect(delivered.length).toBeGreaterThan(0);
    expect(reporter.health().queued).toBeLessThan(10);
    expect(calls.every((call) => (call.body.events as unknown[]).length <= 64)).toBe(true);
    reporter.dispose();
  });

  it('失败退避重试：批次退回队列头部，重试成功后批次完整送达', async () => {
    const file = await tokenFile();
    let failOnce = true;
    const { impl, calls } = fakeFetch(() => {
      if (failOnce) {
        failOnce = false;
        return { status: 503, ok: false };
      }
      return { status: 202 };
    });
    const logError = vi.fn();
    const reporter = createDobsOpsReporter({
      url: 'http://127.0.0.1:47110',
      tokenFile: file,
      fetchImpl: impl,
      flushIntervalMs: 0,
      logError,
    });
    reporter.reportEvent({ eventCode: 'run_created', outcome: 'ok', eventId: 'evt-retry' });
    await reporter.flush();
    expect(reporter.health().queued).toBe(1);
    expect(logError).toHaveBeenCalledTimes(1);
    // 模拟退避定时器触发后的重试。
    await reporter.flush();
    expect(reporter.health().queued).toBe(0);
    const delivered = calls.flatMap((call) => call.body.events as unknown[]);
    expect(delivered).toHaveLength(2);
    expect((delivered[0] as Record<string, unknown>).eventId).toBe('evt-retry');
    expect((delivered[1] as Record<string, unknown>).eventId).toBe('evt-retry');
    expect(reporter.health().lastFlushAt).toBeDefined();
    reporter.dispose();
  });

  it('连续 5 次失败熔断：丢批并清理积压，业务回调不抛', async () => {
    const file = await tokenFile();
    const { impl } = fakeFetch(() => ({ status: 503, ok: false }));
    const logError = vi.fn();
    const reporter = createDobsOpsReporter({
      url: 'http://127.0.0.1:47110',
      tokenFile: file,
      fetchImpl: impl,
      flushIntervalMs: 0,
      logError,
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      reporter.reportEvent({ eventCode: 'http_5xx', outcome: 'error', eventId: `evt-${attempt}` });
      await reporter.flush();
    }
    expect(reporter.health().dropped).toBe(5);
    expect(reporter.health().queued).toBe(0);
    expect(logError).toHaveBeenCalled();
    reporter.dispose();
  });

  it('401 触发 token 轮换：缓存失效重读文件后同一批次成功送达', async () => {
    const file = await tokenFile();
    let rejectedFirst = true;
    const { impl, calls } = fakeFetch(() => {
      if (rejectedFirst) {
        rejectedFirst = false;
        return { status: 401, ok: false };
      }
      return { status: 202 };
    });
    const reporter = createDobsOpsReporter({
      url: 'http://127.0.0.1:47110',
      tokenFile: file,
      fetchImpl: impl,
      flushIntervalMs: 0,
    });
    reporter.reportEvent({ eventCode: 'run_created', outcome: 'ok', eventId: 'evt-auth' });
    await reporter.flush();
    expect(calls.length).toBe(2);
    expect(reporter.health().queued).toBe(0);
    const delivered = (calls[1].body.events as Array<Record<string, unknown>>)[0];
    expect(delivered.eventId).toBe('evt-auth');
    reporter.dispose();
  });

  it('token 文件非法（非 64-hex）：flush 失败进退避，不抛异常', async () => {
    const badFile = path.join(os.tmpdir(), `dobs-bad-token-${Date.now()}.token`);
    await fs.writeFile(badFile, 'not-hex', 'utf8');
    temporaryFiles.push(badFile);
    const { impl, calls } = fakeFetch(() => ({ status: 202 }));
    const logError = vi.fn();
    const reporter = createDobsOpsReporter({
      url: 'http://127.0.0.1:47110',
      tokenFile: badFile,
      fetchImpl: impl,
      flushIntervalMs: 0,
      logError,
    });
    reporter.reportEvent({ eventCode: 'run_created', outcome: 'ok' });
    await reporter.flush();
    expect(calls.length).toBe(0);
    expect(logError).toHaveBeenCalledTimes(1);
    expect(reporter.health().queued).toBe(1);
    reporter.dispose();
  });
});
