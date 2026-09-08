import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { createSim2RealWebApp } from './server.js';

const originalEnv = { ...process.env };
const temporaryRoots: string[] = [];
const openServers: Array<ReturnType<ReturnType<typeof createSim2RealWebApp>['listen']>> = [];

afterEach(async () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{ baseUrl: string; microduckRoot: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-sim2real-health-'));
  temporaryRoots.push(root);
  const microduckRoot = path.join(root, 'microduck');
  process.env.RDK_SIM2REAL_DEPLOYMENT = 'local';
  process.env.RDK_SIM2REAL_STORAGE_DIR = path.join(root, 'ledger');
  delete process.env.RDK_SIM2REAL_AUTH_MODE;
  delete process.env.RDK_SIM2REAL_SSO_REQUIRED;
  delete process.env.SSO_REQUIRED;
  delete process.env.RDK_STUDIO_DEPLOYMENT_PROFILE;
  delete process.env.RDK_SIM2REAL_MICRODUCK_ROOT;
  delete process.env.RDK_SIM2REAL_MICRODUCK_URL;
  process.env.RDK_SIM2REAL_REQUIRE_MICRODUCK = '0';
  const app = createSim2RealWebApp();
  const server = app.listen(0, '127.0.0.1');
  openServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}`, microduckRoot };
}

async function json(url: string): Promise<{ response: Response; payload: any }> {
  const response = await fetch(url);
  return { response, payload: await response.json() };
}

describe('standalone Sim2Real health and optional simulator surface', () => {
  it('reports a usable control plane while an optional MicroDuck release is absent', async () => {
    const { baseUrl } = await fixture();
    const health = await json(`${baseUrl}/healthz`);
    const ready = await json(`${baseUrl}/readyz`);

    expect(health.response.status).toBe(200);
    expect(health.payload).toMatchObject({ ready: true, microduck: { state: 'missing' } });
    expect(health.payload.degraded).toContain('microduck-not-mounted');
    expect(ready.response.status).toBe(200);
  });

  it('serves the versioned Duck API alias from the same business router', async () => {
    const { baseUrl } = await fixture();
    const legacy = await json(`${baseUrl}/api/sim2real/overview`);
    const versioned = await json(`${baseUrl}/api/v1/duck/overview`);

    expect(legacy.response.status).toBe(200);
    expect(versioned.response.status).toBe(200);
    expect(versioned.payload).toMatchObject({
      ok: true,
      schemaVersion: legacy.payload.schemaVersion,
      selectedProductId: legacy.payload.selectedProductId,
    });
    expect(versioned.payload.productProfiles).toEqual(legacy.payload.productProfiles);
  });

  it('can make the browser release a hard readiness dependency', async () => {
    const { baseUrl } = await fixture();
    process.env.RDK_SIM2REAL_REQUIRE_MICRODUCK = '1';
    const ready = await json(`${baseUrl}/readyz`);

    expect(ready.response.status).toBe(503);
    expect(ready.payload).toMatchObject({ ready: false, microduckRequired: true });
    expect(ready.payload.degraded).toContain('microduck-not-mounted');
  });

  it('fails readiness closed when the existing JSON ledger is corrupt', async () => {
    const { baseUrl } = await fixture();
    const storageRoot = String(process.env.RDK_SIM2REAL_STORAGE_DIR);
    await fs.mkdir(storageRoot, { recursive: true });
    await fs.writeFile(path.join(storageRoot, 'sim2real.json'), '{"version":1,"runs":[', 'utf8');

    const health = await json(`${baseUrl}/healthz`);
    const ready = await json(`${baseUrl}/readyz`);
    expect(health.response.status).toBe(200);
    expect(health.payload).toMatchObject({ ready: false });
    expect(health.payload.degraded).toContain('storage-not-configured');
    expect(health.payload.storage).toMatchObject({
      writable: false,
      message: expect.stringContaining('台账文件不可读'),
    });
    expect(ready.response.status).toBe(503);
    expect(ready.payload).toMatchObject({ ready: false });
  });

  it('serves a release mounted after process start through the dynamic current symlink', async () => {
    const { baseUrl, microduckRoot } = await fixture();
    await fs.mkdir(microduckRoot, { recursive: true });
    await fs.writeFile(path.join(microduckRoot, 'index.html'), '<!doctype html><p>mounted</p>');
    process.env.RDK_SIM2REAL_MICRODUCK_ROOT = microduckRoot;

    const response = await fetch(`${baseUrl}/mujoco/microduck/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('mounted');
  });

  it('revalidates the HTML entry so versioned assets are picked up immediately', async () => {
    const { baseUrl } = await fixture();
    const response = await fetch(`${baseUrl}/index.html`);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(await response.text()).toContain('<!doctype html>');
  });

  it('keeps unknown API paths machine-readable and does not masquerade as the SPA', async () => {
    const { baseUrl } = await fixture();
    const response = await fetch(`${baseUrl}/api/does-not-exist`);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toMatch(/application\/json/);
    expect(response.headers.get('x-request-id')).toMatch(/^[\x21-\x7e]{1,128}$/);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: 'SIM2REAL_API_NOT_FOUND',
      requestId: response.headers.get('x-request-id'),
    });
  });

  it('preserves a bounded gateway request id for API tracing', async () => {
    const { baseUrl } = await fixture();
    const requestId = 'gateway-trace-42';
    const response = await fetch(`${baseUrl}/api/does-not-exist`, {
      headers: { 'X-Request-Id': requestId },
    });
    expect(response.headers.get('x-request-id')).toBe(requestId);
    expect((await response.json()).requestId).toBe(requestId);
  });

  it('shows an actionable fallback page when the optional MicroDuck bundle is absent', async () => {
    const { baseUrl } = await fixture();
    const response = await fetch(`${baseUrl}/mujoco/microduck/`);
    const html = await response.text();
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(html).toContain('MicroDuck 仿真资源尚未挂载');
    expect(html).toContain('href="../../#simulate"');
  });
});
