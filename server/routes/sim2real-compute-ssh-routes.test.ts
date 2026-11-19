import { afterEach, expect, it } from 'vitest';
import express from 'express';
import { once } from 'node:events';
import { publicEncrypt, constants } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { Device } from '../../shared/types.js';
import { registerComputeSshRoutes } from './sim2real-compute-ssh-routes.js';

const roots: string[] = [];
const servers: Server[] = [];
const previous = process.env.RDK_SIM2REAL_STORAGE_DIR;
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  if (previous === undefined) delete process.env.RDK_SIM2REAL_STORAGE_DIR;
  else process.env.RDK_SIM2REAL_STORAGE_DIR = previous;
});

it('reuses the authorized Studio target, source-bound job and original resource across both API prefixes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'worker-ssh-api-'));
  roots.push(root);
  process.env.RDK_SIM2REAL_STORAGE_DIR = root;
  const device = {
    id: 'owned-device',
    host: 'fixture-only',
    username: 'fixture',
    status: 'connected',
    lastCheckedAt: new Date().toISOString(),
  } as Device;
  let publicKey = '';
  let ready = false;
  let unconfirmed = false;
  let invalidReceipt = false;
  const token = 'aB2_'.repeat(16);
  const executed: string[] = [];
  const app = express();
  app.use(express.json());
  const router = express.Router();
  for (const prefix of ['/api/sim2real', '/api/v1/duck'])
    registerComputeSshRoutes(
      router,
      {
        owner: (request, response) => {
          const owner = String(request.headers['x-fixture-owner'] ?? '');
          if (!owner) {
            response.sendStatus(401);
            return null;
          }
          return owner;
        },
        device: async (_request, response, owner, id) => {
          if (owner !== 'alice' || id !== device.id) {
            response.sendStatus(404);
            return null;
          }
          return device;
        },
        execute: async (_request, _response, selected, command) => {
          expect(selected).toBe(device);
          // The actual SSH adapter receives a fixed Python program, never user shell text.
          const encoded = /b64decode\("([A-Za-z0-9+/=]+)"\)/.exec(command)![1];
          const python = Buffer.from(encoded, 'base64').toString();
          expect(command.length).toBeLessThan(4000);
          executed.push(python);
          if (python.includes('cfg=root/')) {
            const key = /write_text\(("(?:[^"\\]|\\.)*")\)/.exec(python)![1];
            publicKey = JSON.parse(key);
            return unconfirmed
              ? 'SSH receipt interrupted'
              : 'RDK_WORKER_DEPLOYMENT={"state":"starting"}';
          }
          return (
            'RDK_WORKER_DEPLOYMENT=' +
            JSON.stringify(
              ready
                ? {
                    state: 'ready',
                    sealedToken: invalidReceipt
                      ? Buffer.alloc(256).toString('base64')
                      : publicEncrypt(
                          {
                            key: publicKey,
                            padding: constants.RSA_PKCS1_OAEP_PADDING,
                            oaepHash: 'sha256',
                          },
                          Buffer.from(token),
                        ).toString('base64'),
                  }
                : { state: 'installing' },
            )
          );
        },
        bundleOrigin: () => 'https://platform.fixture.test/robotics-learning',
      },
      prefix,
    );
  app.use(router);
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error();
  const base = 'http://127.0.0.1:' + address.port;
  const call = (route: string, body = {}, owner = 'alice') =>
    fetch(base + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fixture-owner': owner },
      body: JSON.stringify(body),
    });
  const input = {
    deviceId: device.id,
    name: 'Isolated CPU Worker',
    runnerUrl: 'https://worker.fixture.test/train',
  };
  const first = await call('/api/v1/duck/compute-ssh/deployments', input);
  expect(first.status).toBe(202);
  const draft = await first.json();
  expect(draft.deploymentId).toMatch(/^[a-f0-9]{64}$/);
  const repeat = await (await call('/api/sim2real/compute-ssh/deployments', input)).json();
  expect(repeat.deploymentId).toBe(draft.deploymentId);
  expect(executed[0].replace('/api/v1/duck/', '/api/sim2real/')).toBe(executed[1]);
  const poll = '/api/v1/duck/compute-ssh/deployments/' + draft.deploymentId + '/poll';
  expect((await (await call(poll)).json()).state).toBe('installing');
  expect((await call(poll, {}, 'bob')).status).toBe(404);
  ready = true;
  invalidReceipt = true;
  expect((await call(poll)).status).toBe(502);
  invalidReceipt = false;
  const result = await (await call(poll)).json();
  const restored = await (await call(poll)).json();
  expect(result.state).toBe('registered');
  expect(restored.computeResourceId).toBe(result.computeResourceId);
  expect(JSON.stringify(result)).not.toMatch(/sealedToken|privateKey|runnerToken/);
  expect(JSON.stringify(result)).not.toContain(token);
  const bundleUrl = /urlopen\(("(?:[^"\\]|\\.)*")/.exec(executed[0])![1];
  const url = new URL(JSON.parse(bundleUrl));
  const bundlePath = url.pathname.replace('/robotics-learning', '');
  expect((await fetch(base + bundlePath)).status).toBe(200);
  expect((await fetch(base + bundlePath.replace(/[a-f0-9]{64}$/, '0'.repeat(64)))).status).toBe(
    404,
  );
  expect(
    (await call('/api/v1/duck/compute-ssh/deployments', { ...input, command: 'untrusted' })).status,
  ).toBe(400);
  expect((await call('/api/v1/duck/compute-ssh/deployments', input, 'bob')).status).toBe(404);
  expect((await call('/api/v1/duck/compute-ssh/deployments', input, '')).status).toBe(401);
  unconfirmed = true;
  const interrupted = await call('/api/v1/duck/compute-ssh/deployments', input);
  expect(interrupted.status).toBe(502);
  expect(interrupted.headers.get('x-rdk-compute-deployment-id')).toBe(draft.deploymentId);
  expect((await interrupted.json()).deploymentId).toBe(draft.deploymentId);
});
