import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { expect, it, vi } from 'vitest';

import { originmanReferenceDigest } from '../../server/sim2real/originman-reference-digest.js';
import {
  createSim2RealComputeResource,
  createSim2RealModel,
} from '../../server/sim2real/sim2real-store.js';
import {
  encodeStudioWebCloudCookie,
  STUDIO_WEB_CLOUD_SESSION_COOKIE,
} from '../../server/sim2real/studio-cookie-auth.js';
import {
  ORIGINMAN_REFERENCE_ENGINE,
  ORIGINMAN_REFERENCE_JOINTS,
  ORIGINMAN_REFERENCE_TASK,
  type OriginmanReferenceTrajectory,
} from '../../shared/originman-reference-training.js';
import { flushSim2RealAudit } from '../../server/sim2real/audit-log.js';
import legacyManifest from '../../plugins/rdk-robot-learning-platform/references/originman-reference-legacy-manifest.json' with { type: 'json' };
import { validateSim2RealManifest } from '../../shared/sim2real.js';

const mib = 1024 * 1024;
const referenceTransport = { 'X-RDK-Reference-Trajectory': '1' };

function sampledTrajectory(length: number): OriginmanReferenceTrajectory {
  const joint_pos = [];
  const joint_vel = [];
  for (let frame = 0; frame < length; frame++) {
    const position = [];
    const velocity = [];
    for (let joint = 0; joint < ORIGINMAN_REFERENCE_JOINTS.length; joint++) {
      const period = 100 + 4 * joint;
      const phase = (2 * Math.PI * frame) / period + 0.31 * joint;
      const amplitude = 0.15 + 0.012 * joint;
      position.push(joint < 2 ? 0 : amplitude * Math.sin(phase));
      velocity.push(joint < 2 ? 0 : (amplitude * Math.cos(phase) * 100 * Math.PI) / period);
    }
    joint_pos.push(position);
    joint_vel.push(velocity);
  }
  return {
    schemaVersion: 1,
    fps: 50,
    joint_names: ORIGINMAN_REFERENCE_JOINTS,
    joint_pos,
    joint_vel,
  };
}

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    );
  });
}

it('admits long reference uploads only through the bounded signed-account transport', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-reference-upload-'));
  vi.stubEnv('RDK_SIM2REAL_AUTH_MODE', 'studio-cookie');
  vi.stubEnv('RDK_SIM2REAL_DEPLOYMENT', 'local');
  vi.stubEnv('RDK_SIM2REAL_PUBLIC_BASE_PATH', '/robotics-learning');
  vi.stubEnv('RDK_SIM2REAL_PUBLIC_ORIGIN', 'https://workshop.example.test');
  vi.stubEnv('RDK_SIM2REAL_ALLOWED_ORIGINS', 'https://workshop.example.test');
  vi.stubEnv('RDK_SIM2REAL_STORAGE_DIR', path.join(root, 'ledger'));
  vi.stubEnv('RDK_DATA_DIR', path.join(root, 'data'));
  const secret = 'signed-cookie-fixture-'.repeat(3);
  vi.stubEnv('RDK_STUDIO_COOKIE_SECRET', secret);
  const cookie = (id: string, expiry = Date.now() + 60_000) =>
    STUDIO_WEB_CLOUD_SESSION_COOKIE +
    '=' +
    encodeStudioWebCloudCookie({ id, name: id, email: '', roles: ['owner'] }, expiry, undefined, {
      secret,
    });
  const alice = cookie('workshop-alice');
  const bob = cookie('workshop-bob');
  const screenRequests: Record<string, unknown>[] = [];
  const trainRequests: Record<string, unknown>[] = [];
  const worker = http.createServer((request, response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const value = JSON.parse(body.toString('utf8'));
      const account = request.headers['x-sim2real-account'];
      response.setHeader('content-type', 'application/json');
      if (request.url === '/originman-reference/screen') {
        const referenceSha256 = createHash('sha256').update(body).digest('hex');
        const trajectorySha256 = originmanReferenceDigest(value);
        const frames = value.joint_pos.length;
        screenRequests.push({ account, bytes: body.byteLength, trajectorySha256 });
        response.end(
          JSON.stringify({
            ok: true,
            referenceSha256,
            trajectorySha256,
            sceneSha256: '1'.repeat(64),
            calibrationSha256: '2'.repeat(64),
            gate: {
              completed: true,
              framesExpected: frames,
              framesEvaluated: frames,
              firstFailedFrame: null,
              maxTiltDeg: 1,
            },
          }),
        );
        return;
      }
      if (request.url === '/train') {
        trainRequests.push({
          account,
          bytes: body.byteLength,
          header: request.headers['x-rdk-reference-trajectory'],
          contract: {
            id: value.contract.id,
            observationSize: value.contract.observationSize,
            actionSize: value.contract.actionSize,
          },
          trajectorySha256: originmanReferenceDigest(value.training.originmanReference.trajectory),
        });
        response.writeHead(202).end(
          JSON.stringify({
            status: 'queued',
            runId: 'queued-' + trainRequests.length,
            mock: false,
          }),
        );
        return;
      }
      response.writeHead(404).end('{}');
    })().catch(() => response.writeHead(500).end('{}'));
  });
  let web: http.Server | undefined;
  try {
    const workerUrl = await listen(worker);
    const resource = await createSim2RealComputeResource(
      {
        name: 'Reference transport fixture',
        kind: 'local-gpu',
        source: 'server-runner',
        runnerUrl: workerUrl + '/train',
        status: 'online',
        engines: [ORIGINMAN_REFERENCE_ENGINE],
        mock: false,
        lastCheckedAt: new Date().toISOString(),
      },
      'workshop-alice',
    );
    const { createSim2RealWebApp } = await import('./server.js');
    web = http.createServer(createSim2RealWebApp());
    const url = await listen(web);
    const post = (
      route: string,
      body: unknown,
      session?: string,
      headers?: Record<string, string>,
    ) =>
      fetch(`${url}/api${route}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://workshop.example.test',
          ...(session && { cookie: session }),
          ...headers,
        },
        body: JSON.stringify(body),
      });
    const reference = '/v1/duck/originman-reference';
    const long = sampledTrajectory(8229);
    const short = sampledTrajectory(200);
    const longDigest = originmanReferenceDigest(long);
    const payloadBytes = Buffer.byteLength(JSON.stringify({ trajectory: long }));
    expect(payloadBytes).toBeGreaterThan(5 * mib);
    expect(payloadBytes).toBeLessThan(16 * mib);
    for (const [route, marker] of [
      [reference + '/validate', {}],
      [reference + '/screen', {}],
      ['/v1/duck/runs', referenceTransport],
    ] as const) {
      const denied = await post(
        route,
        { trajectory: long },
        cookie('workshop-alice', Date.now() - 60_000),
        marker,
      );
      expect(denied.status).toBe(401);
      expect(await denied.json()).toMatchObject({ error: 'SIM2REAL_AUTH_REQUIRED' });
    }

    for (const route of [reference, '/sim2real/originman-reference']) {
      const result = await post(route + '/validate', { trajectory: long }, alice);
      expect({ status: result.status, body: await result.json() }).toMatchObject({
        status: 200,
        body: {
          frames: 8229,
          durationSeconds: 164.58,
          trajectorySha256: longDigest,
        },
      });
    }
    const tooManyFrames = await post(
      reference + '/validate',
      { trajectory: sampledTrajectory(12001) },
      alice,
    );
    expect(tooManyFrames.status).toBe(400);
    expect(await tooManyFrames.json()).toMatchObject({ error: 'ORIGINMAN_REFERENCE_INVALID' });
    const aboveByteCap = await post(
      reference + '/validate',
      { padding: '0'.repeat(16 * mib) },
      alice,
    );
    expect(aboveByteCap.status).toBe(413);
    expect(await aboveByteCap.json()).toMatchObject({
      error: 'SIM2REAL_REQUEST_TOO_LARGE',
      message: expect.stringContaining('16 MiB'),
    });

    const selected = { computeResourceId: resource.id };
    expect((await post(reference + '/screen', { ...selected, trajectory: long }, bob)).status).toBe(
      409,
    );
    const reviewed = await post(reference + '/screen', { ...selected, trajectory: long }, alice);
    expect(reviewed.status).toBe(200);
    expect(await reviewed.json()).toMatchObject({
      result: { passed: true, trajectorySha256: longDigest },
    });
    expect(screenRequests).toEqual([
      { account: 'workshop-alice', bytes: expect.any(Number), trajectorySha256: longDigest },
    ]);
    expect(screenRequests[0].bytes).toBeGreaterThan(5 * mib);

    const model = await post(reference + '/model', selected, alice);
    expect(model.status).toBe(200);
    const { modelId } = await model.json();
    const trainingRequest = (trajectory: OriginmanReferenceTrajectory) => ({
      ...selected,
      modelId,
      backend: 'local',
      taskId: ORIGINMAN_REFERENCE_TASK,
      idempotencyKey: 'upload-' + trajectory.joint_pos.length,
      training: {
        profile: 'smoke',
        algorithm: 'ppo',
        engine: ORIGINMAN_REFERENCE_ENGINE,
        video: true,
        maxIterations: 2,
        numEnvs: 1,
        originmanReference: { trajectory, trainingSteps: 8192, seed: 7 },
      },
    });
    const runs = '/v1/duck/runs';
    for (const [route, headers] of [
      [runs, {}],
      ['/v1/duck/models', referenceTransport],
    ] as const) {
      expect((await post(route, trainingRequest(long), alice, headers)).status).toBe(413);
    }
    expect(
      (await post(runs, { ...trainingRequest(long), taskId: 'walk' }, alice, referenceTransport))
        .status,
    ).toBe(400);
    const crossAccount = await post(runs, trainingRequest(long), bob, referenceTransport);
    expect({ status: crossAccount.status, body: await crossAccount.json() }).toMatchObject({
      status: 404,
      body: { error: 'SIM2REAL_MODEL_NOT_FOUND' },
    });
    expect(trainRequests).toEqual([]);

    const accepted = await post(runs, trainingRequest(long), alice, referenceTransport);
    expect(accepted.status).toBe(201);
    expect(await accepted.json()).toMatchObject({
      run: {
        externalRunId: 'queued-1',
        training: { originmanReferenceSummary: { frames: 8229, trajectorySha256: longDigest } },
      },
    });
    expect(trainRequests[0]).toMatchObject({
      account: 'workshop-alice',
      header: '1',
      contract: {
        id: 'custom-policy-originman-reference-v2',
        observationSize: 78,
        actionSize: 18,
      },
      trajectorySha256: longDigest,
    });
    expect(trainRequests[0].bytes).toBeGreaterThan(5 * mib);

    const legacy = await post(runs, trainingRequest(short), alice);
    expect(legacy.status).toBe(201);
    expect(trainRequests[1]).toMatchObject({
      account: 'workshop-alice',
      trajectorySha256: originmanReferenceDigest(short),
    });

    const v1Manifest = validateSim2RealManifest(legacyManifest).manifest;
    expect(v1Manifest).toBeDefined();
    const v1Model = await createSim2RealModel(v1Manifest!, 'workshop-alice');
    const prior = await post(
      runs,
      { ...trainingRequest(short), modelId: v1Model.id, idempotencyKey: 'existing-v1-plan' },
      alice,
    );
    expect(prior.status).toBe(201);
    expect(trainRequests[2].contract).toEqual({
      id: 'custom-policy-originman-reference-v1',
      observationSize: 96,
      actionSize: 18,
    });
  } finally {
    await Promise.all(
      [web, worker]
        .filter((server) => server?.listening)
        .map((server) => new Promise<void>((resolve) => server!.close(() => resolve()))),
    );
    await flushSim2RealAudit();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 30_000);
