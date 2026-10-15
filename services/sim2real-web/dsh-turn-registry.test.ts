import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSim2RealWebApp } from './server.js';
import { DshTurnRegistry } from './dsh-turn-registry.js';
import { askDsh } from '../../server/agent-runtime/dsh-runtime.js';

vi.mock('../../server/agent-runtime/dsh-runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../server/agent-runtime/dsh-runtime.js')>()),
  askDsh: vi.fn(),
}));

// The fixture models identities already verified by an auth adapter; production
// adapters never derive a principal from this test-only request header.
vi.mock('./studio-sso-auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./studio-sso-auth.js')>()),
  studioSsoAuth: {
    isMultiUserDeployment: () => true,
    resolvePrincipal: (request: { headers: Record<string, unknown> }) => {
      const accountId = request.headers['x-test-account'];
      return typeof accountId === 'string' ? { accountId, roles: ['operator'] } : null;
    },
    resolveAccessToken: () => null,
  },
}));

const originalEnv = { ...process.env };
const temporaryRoots: string[] = [];
const servers: Array<ReturnType<ReturnType<typeof createSim2RealWebApp>['listen']>> = [];
const pendingReplies: Array<() => void> = [];

beforeEach(() => {
  vi.mocked(askDsh).mockReset();
  vi.mocked(askDsh).mockResolvedValue({ text: '完成', toolTrail: [], events: [] });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  pendingReplies.splice(0).forEach((resolve) => resolve());
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-dsh-turns-'));
  temporaryRoots.push(root);
  process.env.RDK_SIM2REAL_DEPLOYMENT = 'local';
  process.env.RDK_SIM2REAL_STORAGE_DIR = path.join(root, 'ledger');
  process.env.RDK_SIM2REAL_REQUIRE_MICRODUCK = '0';
  delete process.env.RDK_SIM2REAL_DSH_RUNTIME;
  const app = createSim2RealWebApp();
  app.locals.dshRuntime = { __stub: 'turn-registry' };
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sim2real/dsh/chat`;
}

function post(base: string, turnId: string, account = 'alice') {
  return fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-account': account },
    body: JSON.stringify({ message: account, turnId }),
  });
}

async function poll(base: string, turnId: string, account = 'alice') {
  const response = await fetch(`${base}/turns/${turnId}`, {
    headers: { 'x-test-account': account },
  });
  return { status: response.status, body: await response.json() };
}

function cancel(base: string, turnId: string, account = 'alice') {
  return fetch(`${base}/turns/${turnId}/cancel`, {
    method: 'POST',
    headers: { 'x-test-account': account },
  });
}

function deferReplies() {
  vi.mocked(askDsh).mockImplementation(
    (_runtime, prompt) =>
      new Promise((resolve) => {
        pendingReplies.push(() => resolve({ text: prompt, toolTrail: [], events: [] }));
      }),
  );
}

describe('detached DSH turn ownership and lifecycle', () => {
  it('aborts a stalled provider at its deadline without any poll requests', async () => {
    vi.useFakeTimers();
    const registry = new DshTurnRegistry();
    const controller = new AbortController();
    const registration = registry.register('unpolled-timeout', {
      ownerScope: 'alice',
      publicSessionId: 'sim2real-timeout',
      controller,
    });
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(controller.signal.aborted).toBe(true);
    expect(registration).toMatchObject({
      record: { status: 'failed', failure: { body: { error: 'DSH_TURN_TIMEOUT' } } },
    });
  });

  it('keeps the same turn key independent for two authenticated owners', async () => {
    const base = await fixture();
    deferReplies();
    const alice = post(base, 'owner-collision', 'alice');
    const bob = post(base, 'owner-collision', 'bob');
    await vi.waitFor(() => expect(pendingReplies).toHaveLength(2));
    pendingReplies.splice(0).forEach((resolve) => resolve());
    await Promise.all([alice, bob]);
    expect(await poll(base, 'owner-collision', 'alice')).toMatchObject({
      status: 200,
      body: { status: 'complete', text: 'alice' },
    });
    expect(await poll(base, 'owner-collision', 'bob')).toMatchObject({
      status: 200,
      body: { status: 'complete', text: 'bob' },
    });
  });

  it('cancels a legacy turn when the client disconnects after uploading its message', async () => {
    const base = await fixture();
    deferReplies();
    const controller = new AbortController();
    const posting = fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-account': 'alice' },
      body: JSON.stringify({ message: 'legacy request' }),
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(pendingReplies).toHaveLength(1));
    const signal = vi.mocked(askDsh).mock.calls[0][2]?.signal;
    controller.abort();
    await expect(posting).rejects.toThrow();
    await vi.waitFor(() => expect(signal?.aborted).toBe(true), { timeout: 1000 });
  });

  it('rejects a repeated owner turn key without executing the prompt twice', async () => {
    const base = await fixture();
    deferReplies();
    const first = post(base, 'duplicate-turn');
    await vi.waitFor(() => expect(pendingReplies).toHaveLength(1));
    const second = post(base, 'duplicate-turn');
    // Resolve a duplicate too on the old implementation, so the failing
    // assertion cannot leave an HTTP request hanging during teardown.
    await new Promise((resolve) => setTimeout(resolve, 30));
    pendingReplies.splice(0).forEach((resolve) => resolve());
    const [, duplicate] = await Promise.all([first, second]);
    expect(duplicate.status).toBe(409);
    expect(askDsh).toHaveBeenCalledTimes(1);
  });

  it('keeps cancellation terminal when the provider resolves after abort', async () => {
    const base = await fixture();
    deferReplies();
    const posting = post(base, 'cancel-then-resolve');
    await vi.waitFor(() => expect(pendingReplies).toHaveLength(1));
    expect((await cancel(base, 'cancel-then-resolve')).status).toBe(200);
    pendingReplies.splice(0).forEach((resolve) => resolve());
    await posting;
    expect(await poll(base, 'cancel-then-resolve')).toMatchObject({
      status: 200,
      body: { status: 'failed', error: 'DSH_TURN_CANCELLED' },
    });
  });

  it.each(['before', 'after'] as const)(
    'returns a cancelled queued POST while a later turn submitted %s cancellation still waits for the active turn',
    async (laterSubmission) => {
      const base = await fixture();
      vi.mocked(askDsh).mockImplementation(async (_runtime, prompt) => {
        if (prompt === 'A') {
          return new Promise((resolve) => {
            pendingReplies.push(() => resolve({ text: 'A done', toolTrail: [], events: [] }));
          });
        }
        return { text: prompt, toolTrail: [], events: [] };
      });
      const postSession = (name: string) =>
        fetch(base, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-test-account': 'alice' },
          body: JSON.stringify({
            message: name,
            turnId: `queued-${laterSubmission}-${name}`,
            sessionId: `sim2real-queue-${laterSubmission}`,
          }),
        });
      const first = postSession('A');
      await vi.waitFor(() => expect(pendingReplies).toHaveLength(1));
      let stopped: Response | undefined;
      const second = postSession('B').then((response) => {
        stopped = response;
        return response;
      });
      await vi.waitFor(async () =>
        expect(await poll(base, `queued-${laterSubmission}-B`)).toMatchObject({
          body: { status: 'running' },
        }),
      );
      let third: Promise<Response> | undefined;
      if (laterSubmission === 'before') {
        third = postSession('C');
        await vi.waitFor(async () =>
          expect(await poll(base, `queued-${laterSubmission}-C`)).toMatchObject({
            body: { status: 'running' },
          }),
        );
      }
      try {
        expect((await cancel(base, `queued-${laterSubmission}-B`)).status).toBe(200);
        if (laterSubmission === 'after') third = postSession('C');
        await vi.waitFor(() => expect(stopped).toBeDefined(), { timeout: 1000 });
        expect(await stopped!.json()).toMatchObject({ error: 'DSH_TURN_CANCELLED' });
        await vi.waitFor(async () =>
          expect(await poll(base, `queued-${laterSubmission}-C`)).toMatchObject({
            body: { status: 'running' },
          }),
        );
        expect(askDsh).toHaveBeenCalledTimes(1);
      } finally {
        pendingReplies.splice(0).forEach((resolve) => resolve());
        await Promise.all([first, second, third]);
      }
      expect(vi.mocked(askDsh).mock.calls.map((call) => call[1])).toEqual(['A', 'C']);
    },
  );

  it('expires completed turns during polling even when no new turn is registered', async () => {
    const base = await fixture();
    await post(base, 'expired-complete');
    const future = Date.now() + 15 * 60_000 + 1;
    vi.spyOn(Date, 'now').mockReturnValue(future);
    expect((await poll(base, 'expired-complete')).status).toBe(404);
  });

  it('aborts a timed-out provider and preserves timeout if it later resolves', async () => {
    const base = await fixture();
    deferReplies();
    const posting = post(base, 'timeout-then-resolve');
    await vi.waitFor(() => expect(pendingReplies).toHaveLength(1));
    const signal = vi.mocked(askDsh).mock.calls[0][2]?.signal;
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 15 * 60_000 + 1);
    expect(await poll(base, 'timeout-then-resolve')).toMatchObject({
      body: { status: 'failed', error: 'DSH_TURN_TIMEOUT' },
    });
    expect(signal?.aborted).toBe(true);
    pendingReplies.splice(0).forEach((resolve) => resolve());
    await posting;
    expect(await poll(base, 'timeout-then-resolve')).toMatchObject({
      body: { status: 'failed', error: 'DSH_TURN_TIMEOUT' },
    });
  });

  it('bounds active turns even when the oldest registry entry is still running', async () => {
    const base = await fixture();
    deferReplies();
    const postings = Array.from({ length: 64 }, (_, index) => post(base, `active-${index}`));
    await vi.waitFor(() => expect(pendingReplies).toHaveLength(64));
    const overflow = post(base, 'active-overflow');
    await new Promise((resolve) => setTimeout(resolve, 30));
    pendingReplies.splice(0).forEach((resolve) => resolve());
    const [response] = await Promise.all([overflow, ...postings]);
    expect(response.status).toBe(429);
    expect(askDsh).toHaveBeenCalledTimes(64);
  });

  it('retains each owner early cancellation when another owner uses the same key', async () => {
    const base = await fixture();
    await cancel(base, 'early-collision', 'alice');
    await cancel(base, 'early-collision', 'bob');
    await post(base, 'early-collision', 'alice');
    expect(await poll(base, 'early-collision', 'alice')).toMatchObject({
      body: { status: 'failed', error: 'DSH_TURN_CANCELLED' },
    });
    expect(askDsh).not.toHaveBeenCalled();
  });

  it('does not expose another application instance turn through the shared process', async () => {
    const first = await fixture();
    const second = await fixture();
    await post(first, 'separate-apps');
    expect((await poll(second, 'separate-apps')).status).toBe(404);
  });
});
