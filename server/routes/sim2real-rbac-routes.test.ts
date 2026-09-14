import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { BUILTIN_MICRODUCK_MODEL } from '../../shared/sim2real.js';
import type { Sim2RealAuthPort } from '../sim2real/sim2real-auth.js';
import { createSim2RealRouter } from './sim2real-routes.js';

const roots: string[] = [];
const previousStorage = process.env.RDK_SIM2REAL_STORAGE_DIR;
const previousData = process.env.RDK_DATA_DIR;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  if (previousStorage === undefined) delete process.env.RDK_SIM2REAL_STORAGE_DIR;
  else process.env.RDK_SIM2REAL_STORAGE_DIR = previousStorage;
  if (previousData === undefined) delete process.env.RDK_DATA_DIR;
  else process.env.RDK_DATA_DIR = previousData;
});

function authFor(role: string): Sim2RealAuthPort {
  return {
    isMultiUserDeployment: () => true,
    resolvePrincipal: (request) => ({
      accountId: 'rbac-test-user',
      roles: [String(request.headers['x-test-role'] || role)],
    }),
    resolveAccessToken: () => null,
  };
}

async function startApp(role: string): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-sim2real-rbac-'));
  roots.push(root);
  process.env.RDK_SIM2REAL_STORAGE_DIR = path.join(root, 'sim2real');
  process.env.RDK_DATA_DIR = path.join(root, 'data');
  const app = express();
  app.use(express.json());
  app.use(createSim2RealRouter({ auth: authFor(role) }));
  const server = await new Promise<http.Server>((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('RBAC test server did not bind');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

describe('Sim2Real route RBAC boundary', () => {
  it('keeps a viewer read-only across workspace mutations', async () => {
    const server = await startApp('viewer');
    try {
      const read = await fetch(`${server.baseUrl}/api/sim2real/models`, {
        headers: { 'x-test-role': 'viewer' },
      });
      expect(read.status).toBe(200);

      const write = await fetch(`${server.baseUrl}/api/sim2real/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-role': 'viewer' },
        body: JSON.stringify({ name: 'should-be-denied' }),
      });
      expect(write.status).toBe(403);
      expect(await write.json()).toMatchObject({
        code: 'SIM2REAL_PERMISSION_DENIED',
        permission: 'sim2real:edit',
      });
    } finally {
      await server.close();
    }
  });

  it('fails closed for an explicit empty or unknown role claim on reads', async () => {
    const server = await startApp('not-a-role');
    try {
      const unknown = await fetch(`${server.baseUrl}/api/sim2real/models`, {
        headers: { 'x-test-role': 'not-a-role' },
      });
      expect(unknown.status).toBe(403);
      expect(await unknown.json()).toMatchObject({
        code: 'SIM2REAL_PERMISSION_DENIED',
        permission: 'sim2real:read',
      });

      const empty = await fetch(`${server.baseUrl}/api/sim2real/models`, {
        headers: { 'x-test-role': '' },
      });
      expect(empty.status).toBe(403);
      expect(await empty.json()).toMatchObject({
        code: 'SIM2REAL_PERMISSION_DENIED',
        permission: 'sim2real:read',
      });
    } finally {
      await server.close();
    }
  });

  it('lets an editor prepare workspace data while reserving deployment for operators', async () => {
    const server = await startApp('editor');
    try {
      const project = await fetch(`${server.baseUrl}/api/sim2real/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-role': 'editor' },
        body: JSON.stringify({ name: 'editor-project' }),
      });
      expect(project.status).toBe(201);

      const deployment = await fetch(`${server.baseUrl}/api/sim2real/deployments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-role': 'editor' },
        body: JSON.stringify({
          modelId: BUILTIN_MICRODUCK_MODEL.id,
          deviceId: 'missing-device',
          mode: 'preflight',
        }),
      });
      expect(deployment.status).toBe(403);
      expect(await deployment.json()).toMatchObject({
        code: 'SIM2REAL_PERMISSION_DENIED',
        permission: 'sim2real:operate',
      });
    } finally {
      await server.close();
    }
  });

  it('allows an operator to submit a contract run without granting workspace edits', async () => {
    const server = await startApp('operator');
    try {
      const run = await fetch(`${server.baseUrl}/api/sim2real/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-role': 'operator' },
        body: JSON.stringify({ modelId: BUILTIN_MICRODUCK_MODEL.id, backend: 'contract' }),
      });
      expect(run.status).toBe(201);

      const project = await fetch(`${server.baseUrl}/api/sim2real/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-role': 'operator' },
        body: JSON.stringify({ name: 'should-be-editor-only' }),
      });
      expect(project.status).toBe(403);
    } finally {
      await server.close();
    }
  });

  it('reserves deployment approval for owner/admin governance roles', async () => {
    const server = await startApp('operator');
    try {
      const approval = await fetch(
        `${server.baseUrl}/api/sim2real/deployments/does-not-matter/approval`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-test-role': 'operator' },
          body: JSON.stringify({ decision: 'approved' }),
        },
      );
      expect(approval.status).toBe(403);
      expect(await approval.json()).toMatchObject({
        code: 'SIM2REAL_PERMISSION_DENIED',
        permission: 'sim2real:approve',
      });
    } finally {
      await server.close();
    }
  });
});
