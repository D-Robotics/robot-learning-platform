import { afterEach, expect, test, vi } from 'vitest';
import { probeComputeWorker } from './compute-worker-health.js';
import { normalizeComputeRunnerUrl } from './robogo-runner.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test.each([
  ['http://worker.example.com/train', /公网 Worker 必须使用 HTTPS/],
  ['https://worker.example.com/post', /路径必须以 \/train 结尾/],
  ['https://127.0.0.1/train', /回环、私网或保留地址/],
  ['https://192.168.0.2/train', /回环、私网或保留地址/],
  ['https://worker.example.com/train?token=hidden', /查询参数/],
])('classifies invalid compute URL %s', (url, message) => {
  vi.stubEnv('RDK_SIM2REAL_COMPUTE_ALLOW_PRIVATE_HTTPS_HOSTS', '');
  expect(() => normalizeComputeRunnerUrl(url, 'server-runner')).toThrow(message);
});

const localTrain = 'http://127.0.0.1:9173/rl/train';

test('GET sibling healthz accepts the published schema without launching training', async () => {
  const fetchCheck = vi.fn(async (url: URL, init: RequestInit) => {
    expect(url.pathname).toBe('/rl/healthz');
    expect(init).toMatchObject({
      method: 'GET',
      redirect: 'error',
      headers: { accept: 'application/json', authorization: 'Bearer fixture-token' },
    });
    expect(init.body).toBeUndefined();
    return Response.json({ ok: true, engines: ['starter-ppo'], cuda: true, maxConcurrentJobs: 2 });
  });
  vi.stubGlobal('fetch', fetchCheck);
  expect(await probeComputeWorker(localTrain, 'fixture-token')).toMatchObject({
    payload: { engines: ['starter-ppo'], cuda: true, maxConcurrentJobs: 2 },
    diagnostic: {
      code: 'WORKER_HEALTHY',
      endpoint: {
        host: '127.0.0.1',
        port: 9173,
        path: '/rl/healthz',
        resolvedAddresses: ['127.0.0.1'],
      },
    },
  });
  expect(fetchCheck).toHaveBeenCalledTimes(1);
});

test.each([
  ['ENOTFOUND', 'WORKER_DNS_FAILED'],
  ['ECONNREFUSED', 'WORKER_CONNECTION_REFUSED'],
  ['CERT_HAS_EXPIRED', 'WORKER_TLS_FAILED'],
  ['UND_ERR_CONNECT_TIMEOUT', 'WORKER_TIMEOUT'],
])('reports %s without displaying raw transport errors', async (code, expected) => {
  vi.stubGlobal('fetch', async () => {
    const cause = Object.assign(new Error('sensitive upstream details'), { code });
    throw new TypeError('fetch failed', { cause });
  });
  const result = await probeComputeWorker(localTrain, '');
  expect(result).toMatchObject({
    payload: null,
    diagnostic: { code: expected, recovery: expect.any(String) },
  });
  expect(JSON.stringify(result)).not.toContain('sensitive upstream details');
});

test('distinguishes HTTP 404 from a successful response with invalid health JSON', async () => {
  const fetchCheck = vi
    .fn()
    .mockResolvedValueOnce(new Response('{}', { status: 404 }))
    .mockResolvedValueOnce(Response.json({ worker: 'missing ok flag' }));
  vi.stubGlobal('fetch', fetchCheck);
  expect(await probeComputeWorker(localTrain, '')).toMatchObject({
    diagnostic: {
      code: 'WORKER_HTTP_ERROR',
      httpStatus: 404,
      recovery: expect.stringContaining('/healthz'),
    },
  });
  expect(await probeComputeWorker(localTrain, '')).toMatchObject({
    diagnostic: { code: 'WORKER_HEALTH_PAYLOAD_INVALID' },
  });
});
