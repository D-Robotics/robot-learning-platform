import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { BUILTIN_MICRODUCK_MODEL } from '../../shared/sim2real.js';
import type { Device } from '../../shared/types.js';
import { createSim2RealTelemetryAttestationToken } from '../sim2real/telemetry-attestation.js';
import type { Sim2RealAuthPort } from '../sim2real/sim2real-auth.js';
import { createSim2RealRun, listSim2RealTelemetry } from '../sim2real/sim2real-store.js';
import { registerSim2RealTelemetryRoutes } from './sim2real-telemetry-routes.js';

const SECRET = 'telemetry-route-attestation-test-secret-0123456789';
const roots: string[] = [];
const previousStorage = process.env.RDK_SIM2REAL_STORAGE_DIR;
const previousDeployment = process.env.RDK_SIM2REAL_DEPLOYMENT;
const previousSecret = process.env.RDK_SIM2REAL_TELEMETRY_ATTESTATION_SECRET;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  if (previousStorage === undefined) delete process.env.RDK_SIM2REAL_STORAGE_DIR;
  else process.env.RDK_SIM2REAL_STORAGE_DIR = previousStorage;
  if (previousDeployment === undefined) delete process.env.RDK_SIM2REAL_DEPLOYMENT;
  else process.env.RDK_SIM2REAL_DEPLOYMENT = previousDeployment;
  if (previousSecret === undefined) delete process.env.RDK_SIM2REAL_TELEMETRY_ATTESTATION_SECRET;
  else process.env.RDK_SIM2REAL_TELEMETRY_ATTESTATION_SECRET = previousSecret;
});

type RecordedResponse = Response & {
  statusCode: number;
  body?: unknown;
  headers: Record<string, string>;
};

function responseRecorder(resolve: (response: RecordedResponse) => void): RecordedResponse {
  const response = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    locals: {} as Record<string, unknown>,
    status(code: number) {
      response.statusCode = code;
      return response;
    },
    setHeader(name: string, value: string) {
      response.headers[name.toLowerCase()] = String(value);
      return response;
    },
    json(payload: unknown) {
      response.body = payload;
      resolve(response as RecordedResponse);
      return response;
    },
  } as unknown as RecordedResponse;
  return response;
}

function routeHandler(router: Router, method: string, routePath: string) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  const handler = layer?.route?.stack[0]?.handle;
  if (!handler) throw new Error(`route not registered: ${method} ${routePath}`);
  return handler;
}

async function invoke(
  router: Router,
  method: string,
  routePath: string,
  input: Partial<Request>,
): Promise<RecordedResponse> {
  return new Promise((resolve, reject) => {
    const response = responseRecorder(resolve);
    const request = {
      body: {},
      params: {},
      query: {},
      headers: {},
      ...input,
    } as unknown as Request;
    routeHandler(router, method, routePath)(request, response, ((error?: unknown) => {
      if (error) reject(error);
    }) as NextFunction);
  });
}

function device(owner: string): Device & { bridgeOwnerKey: string } {
  return {
    id: 'board-1',
    host: '127.0.0.1',
    port: 22,
    username: 'root',
    status: 'connected',
    lastCheckedAt: new Date().toISOString(),
    bridgeOwnerKey: `sso:${owner}:web`,
  };
}

function buildRouter(principal?: string): Router {
  const router = Router();
  const auth: Sim2RealAuthPort = {
    isMultiUserDeployment: () => true,
    resolvePrincipal: () => (principal ? { accountId: principal } : null),
    resolveAccessToken: () => null,
  };
  registerSim2RealTelemetryRoutes(router, {
    auth,
    // Token-authenticated uploads must not call this resolver when the
    // cookie/SSO principal is absent; the test intentionally throws if they
    // do so, proving the no-cookie path is independent.
    requestOwner: () => {
      if (!principal) throw new Error('requestOwner should not run for a valid token');
      return principal;
    },
    visibleDevices: async () => [device('alice')],
    storageError: (_request, response, error) => {
      response.status(500).json({ ok: false, error: String(error) });
    },
  });
  return router;
}

describe('telemetry Bearer attestation route', () => {
  it('binds a cookie-less upload to the signed owner/run/device and persists attested=true', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-telemetry-attestation-'));
    roots.push(root);
    process.env.RDK_SIM2REAL_STORAGE_DIR = path.join(root, 'sim2real');
    process.env.RDK_SIM2REAL_DEPLOYMENT = 'local';
    process.env.RDK_SIM2REAL_TELEMETRY_ATTESTATION_SECRET = SECRET;
    const run = await createSim2RealRun(
      {
        modelId: BUILTIN_MICRODUCK_MODEL.id,
        backend: 'contract',
        status: 'completed',
        summary: 'attestation route fixture',
      },
      'alice',
    );
    const token = createSim2RealTelemetryAttestationToken(
      { owner: 'alice', runId: run.id, deviceId: 'board-1', expiresInSeconds: 300 },
      { secret: SECRET },
    );
    const response = await invoke(buildRouter(), 'post', '/api/sim2real/telemetry', {
      headers: { authorization: `Bearer ${token}` },
      body: {
        sequence: 0,
        samples: [{ t: 0, reward: 1, observation: Array(61).fill(0), action: Array(14).fill(0) }],
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.body).toMatchObject({
      ok: true,
      telemetry: {
        runId: run.id,
        deviceId: 'board-1',
        source: 'board-agent',
        attested: true,
      },
    });
    const stored = await listSim2RealTelemetry(run.id, 'alice');
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ source: 'board-agent', attested: true });

    // A network retry with a fresh transport key must not inflate attested
    // evidence when the accepted chunk bytes are identical.
    const replay = await invoke(buildRouter(), 'post', '/api/sim2real/telemetry', {
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'retry-2' },
      body: {
        sequence: 0,
        samples: [{ t: 0, reward: 1, observation: Array(61).fill(0), action: Array(14).fill(0) }],
      },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toMatchObject({ ok: true, duplicate: true, telemetry: { attested: true } });
    expect(await listSim2RealTelemetry(run.id, 'alice')).toHaveLength(1);
  });

  it('rejects invalid signatures, claim mismatches and a different cookie owner', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-telemetry-attestation-'));
    roots.push(root);
    process.env.RDK_SIM2REAL_STORAGE_DIR = path.join(root, 'sim2real');
    process.env.RDK_SIM2REAL_DEPLOYMENT = 'local';
    process.env.RDK_SIM2REAL_TELEMETRY_ATTESTATION_SECRET = SECRET;
    const run = await createSim2RealRun(
      {
        modelId: BUILTIN_MICRODUCK_MODEL.id,
        backend: 'contract',
        status: 'completed',
        summary: 'attestation route fixture',
      },
      'alice',
    );
    const token = createSim2RealTelemetryAttestationToken(
      { owner: 'alice', runId: run.id, deviceId: 'board-1', expiresInSeconds: 300 },
      { secret: SECRET },
    );
    const parts = token.split('.');
    const badToken = `${parts[0]}.${parts[1]}.${parts[2][0] === 'a' ? 'b' : 'a'}${parts[2].slice(1)}`;
    const invalid = await invoke(buildRouter(), 'post', '/api/sim2real/telemetry', {
      headers: { authorization: `Bearer ${badToken}` },
      body: { sequence: 0, samples: [{ t: 0 }] },
    });
    expect(invalid.statusCode).toBe(401);

    const mismatched = await invoke(buildRouter(), 'post', '/api/sim2real/runs/:id/telemetry', {
      params: { id: 'other-run' },
      headers: { authorization: `Bearer ${token}` },
      body: { sequence: 0, samples: [{ t: 0 }] },
    });
    expect(mismatched.statusCode).toBe(403);

    const cookieMismatch = await invoke(buildRouter('bob'), 'post', '/api/sim2real/telemetry', {
      headers: { authorization: `Bearer ${token}` },
      body: { samples: [{ t: 0 }] },
    });
    expect(cookieMismatch.statusCode).toBe(403);
  });
});
