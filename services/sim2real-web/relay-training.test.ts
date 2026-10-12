import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = await readFile(
  fileURLToPath(new URL('./public/relay-training.js', import.meta.url)),
  'utf8',
);
const digest = 'a'.repeat(64);
const run = {
  id: 'relay-1',
  modelId: 'model-1',
  backend: 'local',
  status: 'running',
  relayAgentUrl: 'http://127.0.0.1:19190/proxy',
  externalRunId: 'worker-1',
};
const completed = { status: 'completed', mock: false, artifact: { sha256: digest } };

function harness(
  options: {
    fetch?: typeof fetch;
    request?: (path: string, init: RequestInit) => Promise<unknown>;
  } = {},
) {
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let sequence = 0;
  const context = {
    AbortController,
    setTimeout,
    clearTimeout,
    SimTrainingRelay: null as unknown as {
      create: (options: unknown) => {
        reconcile: (overview: unknown, options?: unknown) => void;
        stop: () => void;
      };
    },
  };
  runInNewContext(source, context);
  const fetchMock = vi.fn(
    options.fetch ||
      (async (url: RequestInfo | URL) =>
        String(url).endsWith('/artifact')
          ? new Response(new Uint8Array([1, 2, 3]))
          : Response.json(completed)),
  );
  const request = vi.fn(options.request || (async () => ({ ok: true })));
  const onError = vi.fn();
  const onComplete = vi.fn();
  const relay = context.SimTrainingRelay.create({
    fetch: fetchMock,
    request,
    onError,
    onComplete,
    schedule: (callback: () => void, delay: number) => {
      const id = ++sequence;
      timers.set(id, { callback, delay });
      return id;
    },
    cancel: (id: number) => timers.delete(id),
  });
  const overview = (accountId = 'owner-one', runs = [run]) => ({
    identity: { accountId },
    runs,
    models: [],
  });
  const advance = async () => {
    const entry = [...timers.entries()].sort((a, b) => a[1].delay - b[1].delay)[0];
    expect(entry).toBeDefined();
    timers.delete(entry[0]);
    entry[1].callback();
  };
  return { relay, overview, fetchMock, request, onError, onComplete, timers, advance };
}

describe('local-agent relay recovery transport', () => {
  it('retries a lost submit response at the real train endpoint with the same worker key', async () => {
    const keys: string[] = [];
    const h = harness({
      fetch: async (url, init) => {
        if (String(url) === run.relayAgentUrl + '/train' && init?.method === 'POST') {
          const key = new Headers(init.headers).get('idempotency-key') || '';
          keys.push(key);
          if (keys.length === 1) throw new TypeError('accepted submit response lost');
          return Response.json({ runId: 'worker-1' });
        }
        if (String(url) === run.relayAgentUrl + '/runs/worker-1')
          return Response.json({ status: 'completed', mock: true });
        return Response.json({ error: 'not_found' }, { status: 404 });
      },
    });
    h.relay.reconcile({
      ...h.overview(),
      runs: [{ ...run, externalRunId: undefined, status: 'queued' }],
      models: [
        {
          id: run.modelId,
          manifest: {
            schemaVersion: 1,
            modelId: 'test',
            version: '1',
            contract: { id: 'test-v1' },
            artifacts: [],
          },
        },
      ],
    });
    await vi.waitFor(() => expect(h.onError).toHaveBeenCalledOnce());
    expect(h.request).not.toHaveBeenCalled();
    await h.advance();
    await vi.waitFor(() => expect(h.onComplete).toHaveBeenCalledOnce());
    expect(keys).toEqual(['relay-relay-1', 'relay-relay-1']);
    expect(h.request.mock.calls.map(([path]) => path)).toEqual([
      '/sim2real/runs/relay-1/relay/claim',
      '/sim2real/runs/relay-1/relay/sync',
    ]);
    h.relay.stop();
  });

  it('rejects an oversized declared artifact before reading or completing it', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const cancel = vi.fn(async () => undefined);
    const response = {
      ok: true,
      headers: new Headers({ 'content-length': String(50 * 1024 * 1024 + 1) }),
      body: { cancel, getReader: vi.fn() },
      arrayBuffer,
    } as unknown as Response;
    const h = harness({
      fetch: async (url) =>
        String(url).endsWith('/artifact') ? response : Response.json(completed),
    });
    h.relay.reconcile(h.overview());
    await vi.waitFor(() => expect(h.onError).toHaveBeenCalledOnce());
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(h.request).not.toHaveBeenCalled();
    expect(h.onComplete).not.toHaveBeenCalled();
    h.relay.stop();
  });

  it.each([null, '1'])(
    'bounds and cancels streamed artifacts with content-length %s',
    async (length) => {
      const chunk = new Uint8Array(20 * 1024 * 1024);
      const read = vi
        .fn()
        .mockResolvedValueOnce({ done: false, value: chunk })
        .mockResolvedValueOnce({ done: false, value: chunk })
        .mockResolvedValueOnce({ done: false, value: chunk })
        .mockResolvedValue({ done: true });
      const cancel = vi.fn(async () => undefined);
      const releaseLock = vi.fn();
      const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
      const response = {
        ok: true,
        headers: new Headers(length === null ? {} : { 'content-length': length }),
        body: { getReader: () => ({ read, cancel, releaseLock }) },
        arrayBuffer,
      } as unknown as Response;
      const h = harness({
        fetch: async (url) =>
          String(url).endsWith('/artifact') ? response : Response.json(completed),
      });
      h.relay.reconcile(h.overview());
      await vi.waitFor(() => expect(h.onError).toHaveBeenCalledOnce());
      expect(read).toHaveBeenCalledTimes(3);
      expect(cancel).toHaveBeenCalledOnce();
      expect(releaseLock).toHaveBeenCalledOnce();
      expect(arrayBuffer).not.toHaveBeenCalled();
      expect(h.request).not.toHaveBeenCalled();
      expect(h.onComplete).not.toHaveBeenCalled();
      expect(h.timers.size).toBe(0);
      h.relay.stop();
    },
  );

  it('retries a transient worker status failure with backoff', async () => {
    let attempts = 0;
    const h = harness({
      fetch: async (url) => {
        if (String(url).endsWith('/artifact')) return new Response(new Uint8Array([1]));
        attempts += 1;
        return attempts === 1
          ? Response.json({ error: 'temporarily unavailable' }, { status: 503 })
          : Response.json(completed);
      },
    });
    h.relay.reconcile(h.overview());
    await vi.waitFor(() => expect(h.onError).toHaveBeenCalledTimes(1));
    expect([...h.timers.values()].map((timer) => timer.delay)).toEqual([1000]);
    await h.advance();
    await vi.waitFor(() => expect(h.onComplete).toHaveBeenCalledOnce());
    expect(attempts).toBe(2);
    h.relay.stop();
  });

  it('withholds completed while upload fails, retries it, and avoids reupload after a lost final sync', async () => {
    let uploads = 0;
    let syncs = 0;
    const h = harness({
      request: async (path) => {
        if (path.endsWith('/relay/artifact') && ++uploads === 1)
          throw Object.assign(new Error('upload offline'), { status: 503 });
        if (path.endsWith('/relay/sync') && ++syncs === 1)
          throw Object.assign(new Error('sync response lost'), { status: 503 });
        return { ok: true };
      },
    });
    h.relay.reconcile(h.overview());
    await vi.waitFor(() => expect(h.onError).toHaveBeenCalledTimes(1));
    expect(syncs).toBe(0);
    await h.advance();
    await vi.waitFor(() => expect(h.onError).toHaveBeenCalledTimes(2));
    await h.advance();
    await vi.waitFor(() => expect(h.onComplete).toHaveBeenCalledOnce());
    expect(uploads).toBe(2);
    expect(syncs).toBe(2);
    h.relay.stop();
  });

  it('bounds failed attempts and does not restart exhausted runs on background overviews', async () => {
    const h = harness({ fetch: async () => Response.json({ error: 'busy' }, { status: 429 }) });
    h.relay.reconcile(h.overview());
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      await vi.waitFor(() => expect(h.onError).toHaveBeenCalledTimes(attempt));
      if (attempt < 6) await h.advance();
    }
    expect(h.timers.size).toBe(0);
    h.relay.reconcile(h.overview());
    expect(h.fetchMock).toHaveBeenCalledTimes(6);
    expect(h.onError.mock.calls[5][1].retrying).toBe(false);
    h.relay.reconcile(h.overview(), { retryPaused: true });
    await vi.waitFor(() => expect(h.onError).toHaveBeenCalledTimes(7));
    h.relay.stop();
  });

  it('deduplicates recovery and aborts the old owner before any later platform mutation', async () => {
    let resolveWorker!: (response: Response) => void;
    const h = harness({
      fetch: async () =>
        new Promise<Response>((resolve) => {
          resolveWorker = resolve;
        }),
    });
    h.relay.reconcile(h.overview());
    h.relay.reconcile(h.overview());
    expect(h.fetchMock).toHaveBeenCalledOnce();
    const signal = h.fetchMock.mock.calls[0][1]?.signal;
    h.relay.reconcile(h.overview('owner-two', []));
    expect(signal?.aborted).toBe(true);
    resolveWorker(Response.json(completed));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.request).not.toHaveBeenCalled();
    expect(h.timers.size).toBe(0);
    h.relay.stop();
  });

  it('does not retry permanent authorization failures or pretend a real missing artifact is complete', async () => {
    const unauthorized = harness({
      fetch: async () => Response.json({ error: 'wrong owner' }, { status: 401 }),
    });
    unauthorized.relay.reconcile(unauthorized.overview());
    await vi.waitFor(() => expect(unauthorized.onError).toHaveBeenCalledOnce());
    expect(unauthorized.timers.size).toBe(0);
    expect(unauthorized.request).not.toHaveBeenCalled();
    unauthorized.relay.stop();
    const missing = harness({
      fetch: async () => Response.json({ status: 'completed', mock: false }),
    });
    missing.relay.reconcile(missing.overview());
    await vi.waitFor(() => expect(missing.onError).toHaveBeenCalledOnce());
    expect(missing.request).not.toHaveBeenCalled();
    missing.relay.stop();
  });

  it('repairs a legacy completed relay run with missing platform bytes', async () => {
    const h = harness();
    h.relay.reconcile(h.overview('owner-one', [{ ...run, status: 'completed' }]));
    await vi.waitFor(() => expect(h.onComplete).toHaveBeenCalledOnce());
    expect(h.request.mock.calls.map(([path]) => path)).toEqual([
      '/sim2real/runs/relay-1/relay/artifact',
      '/sim2real/runs/relay-1/relay/sync',
    ]);
    h.relay.reconcile(h.overview());
    expect(h.fetchMock).toHaveBeenCalledTimes(2);
    h.relay.stop();
  });

  it('accepts only a claim conflict for the same worker run and preserves mock protocol completion', async () => {
    const h = harness({
      fetch: async (_url, init) =>
        String(_url) === run.relayAgentUrl + '/train' && init?.method === 'POST'
          ? Response.json({ runId: 'worker-1' })
          : String(_url) === run.relayAgentUrl + '/runs/worker-1'
            ? Response.json(
                init?.method === 'POST'
                  ? { runId: 'worker-1' }
                  : { status: 'completed', mock: true },
              )
            : Response.json({ error: 'not_found' }, { status: 404 }),
      request: async (path) => {
        if (path.endsWith('/relay/claim'))
          throw Object.assign(new Error('already claimed'), { status: 409 });
        return { run: { externalRunId: 'worker-1' } };
      },
    });
    const manifest = {
      schemaVersion: 1,
      modelId: 'test',
      displayName: 'Test',
      version: '1',
      contract: { id: 'test-v1' },
      robot: {},
      simulator: {},
      artifacts: [],
    };
    h.relay.reconcile({
      ...h.overview(),
      runs: [{ ...run, externalRunId: undefined, status: 'queued' }],
      models: [{ id: 'model-1', manifest }],
    });
    await vi.waitFor(() => expect(h.onComplete).toHaveBeenCalledOnce());
    expect(h.request.mock.calls.map(([path]) => path)).toEqual([
      '/sim2real/runs/relay-1/relay/claim',
      '/sim2real/runs/relay-1',
      '/sim2real/runs/relay-1/relay/sync',
    ]);
    expect(JSON.parse(String(h.fetchMock.mock.calls[0][1]?.body)).idempotencyKey).toBe(
      'relay-relay-1',
    );
    h.relay.stop();
  });

  it('refuses a claim conflict that belongs to a different worker run', async () => {
    const h = harness({
      fetch: async () => Response.json({ runId: 'worker-1' }),
      request: async (path) => {
        if (path.endsWith('/relay/claim'))
          throw Object.assign(new Error('another run claimed'), { status: 409 });
        return { run: { externalRunId: 'worker-other' } };
      },
    });
    const manifest = {
      schemaVersion: 1,
      modelId: 'test',
      contract: { id: 'test-v1' },
      artifacts: [],
    };
    h.relay.reconcile({
      ...h.overview(),
      runs: [{ ...run, externalRunId: undefined, status: 'queued' }],
      models: [{ id: 'model-1', manifest }],
    });
    await vi.waitFor(() => expect(h.onError).toHaveBeenCalledOnce());
    expect(h.timers.size).toBe(0);
    expect(h.fetchMock).toHaveBeenCalledOnce();
    expect(h.onComplete).not.toHaveBeenCalled();
    h.relay.stop();
  });
});
