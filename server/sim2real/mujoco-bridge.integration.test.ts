import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMujocoApiBridge } from './mujoco-bridge.js';
import type { Sim2RealAuthPort } from './sim2real-auth.js';

// Opt in after preparing the same Python environment as verify:task-simulation:
// RDK_SIM2REAL_BRIDGE_INTEGRATION=1 npx vitest run --configLoader runner
//   server/sim2real/mujoco-bridge.integration.test.ts
// The fixture runs source Python and the source Node bridge on ephemeral
// loopback ports. The auth port stands for an already-verified principal;
// it does not change or imitate a production SSO deployment.
describe.skipIf(process.env.RDK_SIM2REAL_BRIDGE_INTEGRATION !== '1')(
  'real Node-to-Python simulation identity bridge',
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
        const session = String(request.headers.authorization || '');
        return session === 'Bearer verified-fixture-alice' ||
          session === 'Bearer verified-fixture-bob'
          ? {
              accountId: session.endsWith('alice') ? 'alice' : 'bob',
              displayName: '同名用户',
              roles: ['operator'],
            }
          : null;
      },
      resolveAccessToken: () => null,
    };

    async function request(
      actor: 'alice' | 'bob' | null,
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

    function signed(
      owner: string,
      method: string,
      url: URL,
      body: string,
      timestamp = String(Math.floor(Date.now() / 1000)),
    ) {
      const encoded = Buffer.from(owner, 'utf8').toString('base64url');
      const hash = createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex');
      return {
        'content-type': 'application/json',
        'x-rdk-simulation-owner': encoded,
        'x-rdk-simulation-timestamp': timestamp,
        'x-rdk-simulation-signature': createHmac('sha256', secret)
          .update(`v1\n${timestamp}\n${encoded}\n${method}\n${url.pathname}${url.search}\n${hash}`)
          .digest('hex'),
      };
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
            'import json,socket,uvicorn',
            'from app import app',
            'sock=socket.socket();sock.bind(("127.0.0.1",0));sock.listen(128)',
            'print(json.dumps({"port":sock.getsockname()[1]}),flush=True)',
            'uvicorn.Server(uvicorn.Config(app,log_level="error")).run(sockets=[sock])',
          ].join('\n'),
        ],
        {
          cwd: path.resolve('services/mujoco-web'),
          env: {
            ...process.env,
            PYTHONDONTWRITEBYTECODE: '1',
            RDK_SIM2REAL_STORAGE_DIR: path.join(temporary, 'python-ledger'),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
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

    it('creates, reads, steps, resets, replays and deletes real engine and OriginBot sessions for their owner', async () => {
      for (const task of [true, false]) {
        const root = task ? 'task-sessions' : 'sessions';
        const created = await request(
          'alice',
          'POST',
          root,
          task ? { taskId: 'balance-stilts', seed: 7 } : { model: 'originbot', seed: 7 },
        );
        expect(created.status).toBe(200);
        const id = task ? created.payload.sessionId : created.payload.id;
        const suffix = `${root}/${id}`;
        expect(
          (await request('alice', 'GET', `${suffix}/state?frame=2&label=%E9%B8%AD`)).status,
        ).toBe(200);
        const stepped = await request(
          'alice',
          'POST',
          `${suffix}/step`,
          task ? { action: Array(14).fill(0.2), steps: 2 } : { controls: [0.5, 0.4], steps: 2 },
        );
        expect(stepped.status).toBe(200);
        expect(stepped.payload.time).toBeGreaterThan(0);
        expect(stepped.payload.qpos).not.toEqual(created.payload.qpos);
        for (const [method, operation, payload] of [
          ['GET', '/state', undefined],
          ['POST', '/step', task ? { action: Array(14).fill(0) } : { controls: [0, 0] }],
          ['POST', '/reset', {}],
          ['POST', '/replay', stepped.payload.replay],
          ['DELETE', '', undefined],
          ...(!task
            ? [
                ['GET', '/frame.jpg', undefined],
                ['GET', '/depth.png', undefined],
              ]
            : []),
        ] as Array<[string, string, unknown]>) {
          const foreign = await request('bob', method, suffix + operation, payload, {
            'x-rdk-simulation-owner': Buffer.from('alice').toString('base64url'),
          });
          expect(foreign.status, `${root} Bob ${method} ${operation}`).toBe(404);
        }
        const untouched = await request('alice', 'GET', `${suffix}/state`);
        expect(untouched.payload.replay).toEqual(stepped.payload.replay);
        const reset = await request('alice', 'POST', `${suffix}/reset`, {});
        expect(reset.status).toBe(200);
        expect(reset.payload.time).toBe(0);
        const replay = await request('alice', 'POST', `${suffix}/replay`, stepped.payload.replay);
        expect(replay.status).toBe(200);
        expect(replay.payload.replay).toEqual(stepped.payload.replay);
        expect((await request('alice', 'DELETE', suffix)).status).toBe(200);
        expect((await request('alice', 'GET', `${suffix}/state`)).status).toBe(404);
      }
    });

    it('keeps concurrent Alice and Bob sessions and their actor contexts separate', async () => {
      const created = await Promise.all(
        ['alice', 'bob'].map((owner) =>
          request(owner as 'alice' | 'bob', 'POST', 'task-sessions', { taskId: 'balance-stilts' }),
        ),
      );
      expect(created.map((result) => result.status)).toEqual([200, 200]);
      const [alice, bob] = created.map((result) => result.payload.sessionId);
      expect(alice).not.toBe(bob);
      const matrix = await Promise.all([
        request('alice', 'GET', `task-sessions/${alice}/state`),
        request('bob', 'GET', `task-sessions/${bob}/state`),
        request('alice', 'GET', `task-sessions/${bob}/state`),
        request('bob', 'GET', `task-sessions/${alice}/state`),
      ]);
      expect(matrix.map((result) => result.status)).toEqual([200, 200, 404, 404]);
      await Promise.all([
        request('alice', 'DELETE', `task-sessions/${alice}`),
        request('bob', 'DELETE', `task-sessions/${bob}`),
      ]);
    });

    it('shares the per-account session quota across both simulators and releases it on delete', async () => {
      const sessions: Array<{ actor: 'alice' | 'bob'; suffix: string }> = [];
      async function create(actor: 'alice' | 'bob', task: boolean) {
        const root = task ? 'task-sessions' : 'sessions';
        const result = await request(
          actor,
          'POST',
          root,
          task ? { taskId: 'balance-stilts' } : { model: 'originbot' },
        );
        expect(result.status).toBe(200);
        const id = task ? result.payload.sessionId : result.payload.id;
        const suffix = `${root}/${id}`;
        sessions.push({ actor, suffix });
        return suffix;
      }
      try {
        const first = await create('alice', true);
        await create('alice', true);
        await create('alice', false);
        await create('alice', false);
        expect(
          (await request('alice', 'POST', 'task-sessions', { taskId: 'balance-stilts' })).status,
        ).toBe(429);
        expect((await request('alice', 'POST', 'sessions', { model: 'originbot' })).status).toBe(
          429,
        );
        await create('bob', true);
        expect((await request('alice', 'DELETE', first)).status).toBe(200);
        await create('alice', false);
        expect(
          (await request('alice', 'POST', 'task-sessions', { taskId: 'balance-stilts' })).status,
        ).toBe(429);
      } finally {
        await Promise.all(sessions.map(({ actor, suffix }) => request(actor, 'DELETE', suffix)));
      }
    });

    it('rejects anonymous bridge requests, unsigned direct Python access, CSRF and signed body/owner/path tampering', async () => {
      const created = await request('alice', 'POST', 'task-sessions', { taskId: 'balance-stilts' });
      const suffix = `task-sessions/${created.payload.sessionId}`;
      expect((await request(null, 'GET', `${suffix}/state`)).status).toBe(401);
      expect(
        (await request(null, 'POST', 'task-sessions', { taskId: 'balance-stilts' })).status,
      ).toBe(401);
      const direct = new URL(`${pythonUrl}/api/${suffix}/step`);
      const raw = JSON.stringify({ action: Array(14).fill(0) });
      const unsigned = await fetch(direct, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      expect(unsigned.status).toBe(401);
      expect((await unsigned.json()).error).toBe('SIMULATION_AUTH_INVALID');
      expect((await fetch(`${pythonUrl}/api/${suffix}/state`)).status).toBe(401);
      const headers = signed('alice', 'POST', direct, raw);
      for (const [url, body, altered] of [
        [direct.href, JSON.stringify({ action: Array(14).fill(1) }), headers],
        [
          direct.href,
          raw,
          { ...headers, 'x-rdk-simulation-owner': Buffer.from('bob').toString('base64url') },
        ],
        [`${direct.href}?different=1`, raw, headers],
        [
          direct.href,
          raw,
          signed('alice', 'POST', direct, raw, String(Math.floor(Date.now() / 1000) - 120)),
        ],
      ] as Array<[string, string, Record<string, string>]>) {
        expect((await fetch(url, { method: 'POST', headers: altered, body })).status).toBe(401);
      }
      const csrf = await request(
        'alice',
        'POST',
        `${suffix}/step`,
        { action: Array(14).fill(1) },
        { origin: 'https://attacker.test' },
      );
      expect(csrf.status).toBe(403);
      expect(csrf.payload.error).toBe('SIM2REAL_CSRF_BLOCKED');
      expect(
        (await request('alice', 'DELETE', suffix, undefined, { origin: 'https://attacker.test' }))
          .status,
      ).toBe(403);
      const state = await request('alice', 'GET', `${suffix}/state`, undefined, {
        'x-rdk-simulation-owner': Buffer.from('bob').toString('base64url'),
        'x-rdk-simulation-signature': 'forged',
      });
      expect(state.status).toBe(200);
      expect(state.payload.stepCount).toBe(0);
      expect((await request('alice', 'DELETE', suffix)).status).toBe(200);
    });
  },
);
