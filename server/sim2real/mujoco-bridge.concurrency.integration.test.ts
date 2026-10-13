import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMujocoApiBridge } from './mujoco-bridge.js';
import type { Sim2RealAuthPort } from './sim2real-auth.js';

// All identities below are local verified-principal fixtures, never production SSO.
// The TTL case adjusts the isolated Python child via private stdin; the source
// janitor and signed HTTP routes still perform every expiry and quota release.
// Opt in after preparing the same Python environment as verify:task-simulation:
// RDK_SIM2REAL_BRIDGE_INTEGRATION=1 npx vitest run --configLoader runner
//   server/sim2real/mujoco-bridge.concurrency.integration.test.ts
// The fixture runs source Python and the source Node bridge on ephemeral
// loopback ports. The auth port stands for an already-verified principal;
// it does not change or imitate a production SSO deployment.
describe.skipIf(process.env.RDK_SIM2REAL_BRIDGE_INTEGRATION !== '1')(
  'real Node-to-Python mixed-session concurrency',
  () => {
    const environment = { ...process.env };
    const secret = `integration-only-${randomUUID()}-${randomUUID()}`;
    let python: ChildProcess;
    let node: http.Server;
    let temporary: string;
    let pythonUrl: string;
    let nodeUrl: string;
    let pythonOutput = '';
    const auth: Sim2RealAuthPort = {
      isMultiUserDeployment: () => true,
      resolvePrincipal: (request) => {
        const session = /^Bearer verified-fixture-(account-[0-9]+|alice|bob|carol)$/.exec(
          String(request.headers.authorization || ''),
        );
        return session
          ? {
              accountId: session[1],
              displayName: '同名用户',
              roles: ['operator'],
            }
          : null;
      },
      resolveAccessToken: () => null,
    };

    async function request(
      actor: string | null,
      method: string,
      suffix: string,
      body?: unknown,
      headers: Record<string, string> = {},
    ) {
      const response = await fetch(`${nodeUrl}/mujoco/api/${suffix}`, {
        method,
        headers: {
          ...(actor ? { authorization: `Bearer verified-fixture-${actor}` } : {}),
          ...(['POST', 'DELETE'].includes(method) ? { origin: nodeUrl } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, payload: await response.json() };
    }

    beforeAll(async () => {
      temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-node-python-identity-'));
      process.env.RDK_SIM2REAL_SIMULATION_SECRET = secret;
      process.env.RDK_SIM2REAL_DEPLOYMENT = 'web-cloud';
      process.env.RDK_SIM2REAL_STORAGE_DIR = path.join(temporary, 'node-ledger');
      delete process.env.RDK_SIM2REAL_PUBLIC_ORIGIN;
      const pythonExecutable = process.env.RDK_SIM2REAL_PYTHON || path.resolve('.venv/bin/python');
      python = spawn(
        pythonExecutable,
        [
          '-u',
          '-c',
          [
            'import json,socket,sys,threading,uvicorn',
            'import app as playground, task_simulation as tasks',
            'playground.SESSION_CLEANUP_INTERVAL_SECONDS=0.02',
            'def configure_ttl():',
            '    for line in sys.stdin:',
            '        if line.strip()=="shorten-ttl":',
            '            playground.SESSION_TTL_SECONDS=tasks.TASK_SESSION_TTL_SECONDS=0.5',
            '            print("short-ttl-ready",flush=True)',
            'threading.Thread(target=configure_ttl,daemon=True).start()',
            'sock=socket.socket();sock.bind(("127.0.0.1",0));sock.listen(128)',
            'print(json.dumps({"port":sock.getsockname()[1]}),flush=True)',
            'uvicorn.Server(uvicorn.Config(playground.app,log_level="error")).run(sockets=[sock])',
          ].join('\n'),
        ],
        {
          cwd: path.resolve('services/mujoco-web'),
          env: {
            ...process.env,
            PYTHONDONTWRITEBYTECODE: '1',
            RDK_SIM2REAL_STORAGE_DIR: path.join(temporary, 'python-ledger'),
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      python.stdout!.on('data', (chunk: Buffer) => {
        pythonOutput += chunk.toString('utf8');
      });
      python.stderr!.on('data', (chunk: Buffer) => {
        pythonOutput += chunk.toString('utf8');
      });
      const deadline = Date.now() + 15_000;
      while (!pythonUrl && Date.now() < deadline) {
        const match = /\{"port": (\d+)\}/.exec(pythonOutput);
        if (match) pythonUrl = `http://127.0.0.1:${match[1]}`;
        else if (python.exitCode !== null)
          throw new Error(`Python fixture failed: ${pythonOutput}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!pythonUrl) throw new Error(`Python fixture did not start: ${pythonOutput}`);
      await vi.waitFor(
        async () => {
          const health = await fetch(`${pythonUrl}/healthz`);
          expect(health.status).toBe(200);
        },
        { timeout: 10_000 },
      );
      process.env.RDK_SIM2REAL_MUJOCO_WEB_URL = pythonUrl;
      const app = express();
      app.use(express.json({ limit: '2mb' }));
      app.all(['/mujoco/api', '/mujoco/api/{*splat}'], createMujocoApiBridge({ auth }));
      node = http.createServer(app);
      await new Promise<void>((resolve, reject) => {
        node.once('error', reject);
        node.listen(0, '127.0.0.1', resolve);
      });
      nodeUrl = `http://127.0.0.1:${(node.address() as AddressInfo).port}`;
    }, 25_000);

    afterAll(async () => {
      if (node)
        await new Promise<void>((resolve) => {
          node.closeAllConnections();
          node.close(() => resolve());
        });
      if (python && python.exitCode === null) {
        const exited = new Promise<void>((resolve) => {
          python.once('exit', () => resolve());
        });
        python.kill('SIGTERM');
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
        if (python.exitCode === null) {
          python.kill('SIGKILL');
          await exited;
        }
      }
      for (const key of Object.keys(process.env))
        if (!(key in environment)) delete process.env[key];
      Object.assign(process.env, environment);
      if (temporary) await fs.rm(temporary, { recursive: true, force: true });
    });

    type OwnedSession = {
      actor: string;
      suffix: string;
      task: boolean;
      initial: { replay: unknown };
    };

    async function create(actor: string, task: boolean): Promise<OwnedSession> {
      const root = task ? 'task-sessions' : 'sessions';
      const created = await request(
        actor,
        'POST',
        root,
        task ? { taskId: 'balance-stilts', seed: 23 } : { model: 'originbot', seed: 23 },
      );
      expect(created.status, `${actor} ${root}`).toBe(200);
      return {
        actor,
        task,
        initial: created.payload,
        suffix: `${root}/${task ? created.payload.sessionId : created.payload.id}`,
      };
    }

    async function close(sessions: OwnedSession[]) {
      await Promise.all(sessions.map(({ actor, suffix }) => request(actor, 'DELETE', suffix)));
    }

    it('atomically enforces one owner quota during mixed-engine creation and deletion races', async () => {
      const sessions: OwnedSession[] = [];
      async function contend(actor: string, count: number) {
        const created = await Promise.all(
          Array.from({ length: count }, (_, index) => {
            const task = index % 2 === 0;
            const root = task ? 'task-sessions' : 'sessions';
            return request(
              actor,
              'POST',
              root,
              task ? { taskId: 'balance-stilts' } : { model: 'originbot' },
            ).then((result) => {
              if (result.status === 200)
                sessions.push({
                  actor,
                  task,
                  initial: result.payload,
                  suffix: `${root}/${task ? result.payload.sessionId : result.payload.id}`,
                });
              return result.status;
            });
          }),
        );
        return created.sort((a, b) => a - b);
      }
      try {
        expect(await contend('alice', 12)).toEqual([...Array(4).fill(200), ...Array(8).fill(429)]);
        expect(await contend('bob', 4)).toEqual(Array(4).fill(200));
        const alice = sessions.filter(({ actor }) => actor === 'alice');
        const denied = await Promise.all(
          alice.map(({ suffix }) => request('bob', 'DELETE', suffix)),
        );
        expect(denied.map(({ status }) => status)).toEqual(Array(4).fill(404));
        expect((await request('alice', 'POST', 'sessions', { model: 'originbot' })).status).toBe(
          429,
        );
        expect(
          (await request('bob', 'POST', 'task-sessions', { taskId: 'balance-stilts' })).status,
        ).toBe(429);
        const closed = await Promise.all(
          alice.map(({ actor, suffix }) => request(actor, 'DELETE', suffix)),
        );
        expect(closed.map(({ status }) => status)).toEqual(Array(4).fill(200));
        expect(await contend('alice', 12)).toEqual([...Array(4).fill(200), ...Array(8).fill(429)]);
        const stillBob = await Promise.all(
          sessions
            .filter(({ actor }) => actor === 'bob')
            .map(({ actor, suffix }) => request(actor, 'GET', `${suffix}/state`)),
        );
        expect(stillBob.map(({ status }) => status)).toEqual(Array(4).fill(200));
      } finally {
        await close(sessions);
      }
    });

    it('keeps concurrent authenticated physics identical to serial execution despite foreign writes', async () => {
      const sessions: OwnedSession[] = [];
      try {
        sessions.push(
          ...(await Promise.all(
            ['alice', 'bob', 'carol'].flatMap((actor) => [
              create(actor, true),
              create(actor, false),
            ]),
          )),
        );
        const expected = new Map<string, unknown>();
        const action = ({ task }: OwnedSession) =>
          task ? { action: Array(14).fill(0.15) } : { controls: [0.6, 0.3] };
        for (const session of sessions) {
          for (let index = 0; index < 4; index += 1) {
            const result = await request(
              session.actor,
              'POST',
              `${session.suffix}/step`,
              action(session),
            );
            expect(result.status).toBe(200);
            expected.set(session.suffix, result.payload.replay);
          }
          expect(
            (await request(session.actor, 'POST', `${session.suffix}/reset`, { seed: 23 })).status,
          ).toBe(200);
        }
        const results = await Promise.all(
          sessions.flatMap((session) => {
            const other = session.actor === 'alice' ? 'bob' : 'alice';
            return [
              ...Array.from({ length: 4 }, () =>
                request(session.actor, 'POST', `${session.suffix}/step`, action(session)),
              ),
              ...(
                [
                  ['GET', '/state', undefined],
                  ['POST', '/step', action(session)],
                  ['POST', '/reset', {}],
                  ['POST', '/replay', session.initial.replay],
                  ['DELETE', '', undefined],
                ] as Array<[string, string, unknown]>
              ).map(([method, suffix, payload]) =>
                request(other, method, session.suffix + suffix, payload, {
                  'x-rdk-simulation-owner': Buffer.from(session.actor).toString('base64url'),
                  'x-rdk-simulation-signature': 'browser-cannot-impersonate-owner',
                }),
              ),
            ];
          }),
        );
        expect(results.map(({ status }) => status).sort((a, b) => a - b)).toEqual([
          ...Array(24).fill(200),
          ...Array(30).fill(404),
        ]);
        for (const session of sessions) {
          const state = await request(session.actor, 'GET', `${session.suffix}/state`);
          expect(state.status).toBe(200);
          expect(state.payload.replay, session.suffix).toEqual(expected.get(session.suffix));
          expect(state.payload.time).toBeGreaterThan(0);
        }
        const deleted = await Promise.all(
          sessions.map(({ actor, suffix }) => request(actor, 'DELETE', suffix)),
        );
        expect(deleted.map(({ status }) => status)).toEqual(Array(6).fill(200));
        const missing = await Promise.all(
          sessions.map(({ actor, suffix }) => request(actor, 'GET', `${suffix}/state`)),
        );
        expect(missing.map(({ status }) => status)).toEqual(Array(6).fill(404));
      } finally {
        await close(sessions);
      }
    });

    it('bounds the combined global session pool under forty cross-account HTTP contenders', async () => {
      const sessions: OwnedSession[] = [];
      try {
        const responses = await Promise.all(
          Array.from({ length: 40 }, async (_, index) => {
            const actor = `account-${Math.floor(index / 4)}`;
            const task = index % 2 === 0;
            const root = task ? 'task-sessions' : 'sessions';
            const result = await request(
              actor,
              'POST',
              root,
              task ? { taskId: 'balance-stilts' } : { model: 'originbot' },
            );
            if (result.status === 200)
              sessions.push({
                actor,
                task,
                initial: result.payload,
                suffix: `${root}/${task ? result.payload.sessionId : result.payload.id}`,
              });
            return result;
          }),
        );
        expect(responses.map(({ status }) => status).sort((a, b) => a - b)).toEqual([
          ...Array(32).fill(200),
          ...Array(8).fill(429),
        ]);
        expect(new Set(sessions.map(({ suffix }) => suffix)).size).toBe(32);
        expect((await request('alice', 'POST', 'sessions', { model: 'originbot' })).status).toBe(
          429,
        );
        expect(
          (await request('alice', 'POST', 'task-sessions', { taskId: 'balance-stilts' })).status,
        ).toBe(429);
        for (const session of sessions) {
          expect((await request(session.actor, 'GET', `${session.suffix}/state`)).status).toBe(200);
        }
      } finally {
        await close(sessions);
      }
    });

    it('reclaims an idle owner across the bridge while active owner requests retain their sessions', async () => {
      const sessions: OwnedSession[] = [];
      try {
        sessions.push(
          ...(await Promise.all(
            ['alice', 'bob'].flatMap((actor) =>
              [true, true, false, false].map((task) => create(actor, task)),
            ),
          )),
        );
        python.stdin!.write('shorten-ttl\n');
        await vi.waitFor(() => expect(pythonOutput).toContain('short-ttl-ready'), {
          timeout: 1000,
        });
        const alice = sessions.filter(({ actor }) => actor === 'alice');
        const bob = sessions.filter(({ actor }) => actor === 'bob');
        const deadline = Date.now() + 3000;
        let expired = false;
        while (!expired && Date.now() < deadline) {
          const kept = await Promise.all(
            bob.map(({ actor, suffix }) => request(actor, 'GET', `${suffix}/state`)),
          );
          expect(kept.map(({ status }) => status)).toEqual(Array(4).fill(200));
          // A signed foreign GET must never count as activity for Alice.
          const denied = await Promise.all(
            alice.map(({ suffix }) => request('bob', 'GET', `${suffix}/state`)),
          );
          expect(denied.map(({ status }) => status)).toEqual(Array(4).fill(404));
          const replacements = await request('alice', 'POST', 'task-sessions', {
            taskId: 'balance-stilts',
          });
          if (replacements.status === 200) {
            sessions.push({
              actor: 'alice',
              suffix: `task-sessions/${replacements.payload.sessionId}`,
              task: true,
              initial: replacements.payload,
            });
            expired = true;
          } else expect(replacements.status).toBe(429);
          if (!expired) await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(expired).toBe(true);
        const gone = await Promise.all(
          alice.map(({ actor, suffix }) => request(actor, 'GET', `${suffix}/state`)),
        );
        expect(gone.map(({ status }) => status)).toEqual(Array(4).fill(404));
        const alive = await Promise.all(
          bob.map(({ actor, suffix }) => request(actor, 'GET', `${suffix}/state`)),
        );
        expect(alive.map(({ status }) => status)).toEqual(Array(4).fill(200));
        const replenished = await Promise.all(
          [true, false, false].map((task) => create('alice', task)),
        );
        sessions.push(...replenished);
        expect((await request('alice', 'POST', 'sessions', { model: 'originbot' })).status).toBe(
          429,
        );
      } finally {
        await close(sessions);
      }
    });
  },
);
