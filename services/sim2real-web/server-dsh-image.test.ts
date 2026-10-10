import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Request } from 'express';
import { createServer } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syntheticPng } from '../../tests/fixtures/dsh-images.js';
import { createSim2RealWebApp } from './server.js';
import { askDsh } from '../../server/agent-runtime/dsh-runtime.js';
import { flushSim2RealAudit, listSim2RealAuditEvents } from '../../server/sim2real/audit-log.js';

vi.mock('../../server/agent-runtime/dsh-runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../server/agent-runtime/dsh-runtime.js')>()),
  askDsh: vi.fn(async (_ctx, _prompt, options) => ({
    sessionId: options.sessionId,
    text: '已查看图片。',
    reasoning: '',
    toolTrail: [],
    events: [],
    ...(options.image
      ? { imageAccepted: { mediaType: 'image/png', width: 8, height: 4, bytes: 80 } }
      : {}),
  })),
}));

// The production identity port remains the boundary; this fixture provides
// verified principals, without making arbitrary headers a production identity.
vi.mock('./studio-sso-auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./studio-sso-auth.js')>()),
  studioSsoAuth: {
    isMultiUserDeployment: () => true,
    resolvePrincipal: (request: Request) =>
      request.headers['x-test-owner']
        ? { accountId: String(request.headers['x-test-owner']), roles: ['operator'] }
        : null,
    resolveAccessToken: () => null,
  },
}));

const originalEnv = { ...process.env };
const roots: string[] = [];
const servers: ReturnType<ReturnType<typeof createSim2RealWebApp>['listen']>[] = [];
const runtimes: Context[] = [];

beforeEach(() => {
  vi.mocked(askDsh).mockClear();
  vi.mocked(askDsh).mockImplementation(async (_ctx, _prompt, options) => ({
    sessionId: options!.sessionId!,
    text: '已查看图片。',
    reasoning: '',
    toolTrail: [],
    events: [],
    ...(options!.image
      ? { imageAccepted: { mediaType: 'image/png' as const, width: 8, height: 4, bytes: 80 } }
      : {}),
  }));
  delete process.env.RDK_SIM2REAL_DSH_VISION_MODELS;
  process.env.RDK_SIM2REAL_DSH_MODEL = 'configured-vision-model';
});

afterEach(async () => {
  await flushSim2RealAudit();
  await Promise.all(runtimes.splice(0).map((ctx) => ctx.fiber.dispose()));
  vi.restoreAllMocks();
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(runtime?: Context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-dsh-image-route-'));
  roots.push(root);
  process.env.RDK_SIM2REAL_STORAGE_DIR = path.join(root, 'ledger');
  process.env.RDK_SIM2REAL_DEPLOYMENT = 'local';
  process.env.RDK_SIM2REAL_REQUIRE_MICRODUCK = '0';
  const app = createSim2RealWebApp();
  app.locals.dshRuntime = runtime ?? { __stub: 'route-boundary' };
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const post = (body: unknown, owner = 'account-a') =>
    fetch(`${base}/api/sim2real/dsh/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(owner ? { 'x-test-owner': owner } : {}) },
      body: JSON.stringify(body),
    });
  return { base, post, root };
}

describe('DSH image HTTP admission and owner isolation', () => {
  it('advertises disabled image input by default and refuses rather than dropping pixels', async () => {
    const { base, post } = await fixture();
    const catalog = await (await fetch(`${base}/api/sim2real/agent/capabilities`)).json();
    expect(catalog.dsh.imageInput).toMatchObject({ enabled: false, models: [] });
    const response = await post({
      message: '看这张图',
      image: { mediaType: 'image/png', base64: syntheticPng() },
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: 'DSH_VISION_MODEL_REQUIRED' });
    expect(askDsh).not.toHaveBeenCalled();
  });

  it('rejects URL, array, arbitrary attachment references and noncanonical image bytes', async () => {
    process.env.RDK_SIM2REAL_DSH_VISION_MODELS = 'configured-vision-model';
    const { post } = await fixture();
    for (const image of [
      { mediaType: 'image/png', url: 'https://private.invalid/picture' },
      [{ mediaType: 'image/png', base64: syntheticPng() }],
      { mediaType: 'image/png', base64: syntheticPng(), attachmentId: 'foreign-session-image' },
      { mediaType: 'image/png', base64: 'data:image/png;base64,' + syntheticPng() },
      { mediaType: 'image/webp', base64: syntheticPng() },
      { mediaType: 'image/png', base64: 'not base64' },
      { mediaType: ['image/png'], base64: syntheticPng() },
    ]) {
      const response = await post({ message: '看这张图', image });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'DSH_IMAGE_INVALID' });
    }
    expect(askDsh).not.toHaveBeenCalled();
  });

  it('keeps image bytes out of parser-error logs and ordinary audit events', async () => {
    const logs = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { base, post } = await fixture();
    const marker = 'IMAGE_PIXELS_MUST_NEVER_APPEAR_IN_LOGS';
    const malformed = await fetch(`${base}/api/sim2real/dsh/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-owner': 'account-a' },
      body: marker + '{"image":',
    });
    expect(malformed.status).toBe(400);
    await post({ message: '看图', image: { mediaType: 'image/png', base64: syntheticPng() } });
    await flushSim2RealAudit();
    const audit = JSON.stringify(await listSim2RealAuditEvents());
    expect(logs.mock.calls.flat().map(String).join(' ')).not.toContain(marker);
    expect(audit).not.toContain(syntheticPng());
    expect(audit).not.toContain('mediaType');
    expect(audit).not.toContain('base64');
  });

  it('runs authenticated HTTP uploads through the real SDK without sharing image history between owners', async () => {
    const original = await vi.importActual<
      typeof import('../../server/agent-runtime/dsh-runtime.js')
    >('../../server/agent-runtime/dsh-runtime.js');
    vi.mocked(askDsh).mockImplementation(original.askDsh);
    const requests: Record<string, unknown>[] = [];
    const gateway = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => {
        raw += String(chunk);
      });
      request.on('end', () => {
        if (!request.url?.includes('/chat/completions')) {
          response.writeHead(404).end();
          return;
        }
        requests.push(JSON.parse(raw));
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(
          'data: ' +
            JSON.stringify({ choices: [{ index: 0, delta: { content: '收到。' } }] }) +
            '\n\ndata: [DONE]\n\n',
        );
      });
    });
    servers.push(gateway);
    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    process.env.RDK_SIM2REAL_DSH_BASE_URL = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
    process.env.RDK_SIM2REAL_DSH_API_KEY = 'test-only-image-key';
    process.env.RDK_SIM2REAL_DSH_VISION_MODELS = 'configured-vision-model';
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-dsh-owner-attachments-'));
    roots.push(home);
    const runtime = await original.createDshRuntime({ persistenceRoot: home });
    runtimes.push(runtime);
    const { post } = await fixture(runtime);
    const first = await post(
      {
        message: '描述图片',
        sessionId: 'sim2real-same-public-id',
        image: { mediaType: 'image/png', base64: syntheticPng() },
      },
      'account-a',
    );
    expect(first.status).toBe(200);
    const payload = await first.json();
    expect(payload.imageAccepted).toMatchObject({ width: 8, height: 4 });
    expect(JSON.stringify(payload)).not.toContain('attachmentId');
    expect(JSON.stringify(payload)).not.toContain(syntheticPng());
    expect(JSON.stringify(payload)).not.toContain(home);
    const second = await post(
      { message: '继续对话', sessionId: 'sim2real-same-public-id' },
      'account-b',
    );
    expect(second.status).toBe(200);
    expect(JSON.stringify(requests[0])).toContain('image_url');
    expect(JSON.stringify(requests[1])).not.toContain('image_url');
    for (const image of [
      { mediaType: 'image/jpeg', base64: syntheticPng() },
      { mediaType: 'image/png', base64: syntheticPng(4097, 1) },
    ]) {
      const rejected = await post({ message: '描述图片', image }, 'account-a');
      expect(rejected.status).toBe(422);
      expect(await rejected.json()).toMatchObject({ error: 'DSH_IMAGE_INVALID' });
    }
    expect(requests).toHaveLength(2);
  }, 60_000);

  it('bounds decoded bytes and JSON transport while keeping other route limits unchanged', async () => {
    process.env.RDK_SIM2REAL_DSH_VISION_MODELS = 'configured-vision-model';
    const { post } = await fixture();
    const tooLarge = await post({
      message: '看图',
      image: {
        mediaType: 'image/png',
        base64: Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64'),
      },
    });
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toMatchObject({ error: 'DSH_IMAGE_TOO_LARGE' });
    const oversizedBody = await post({
      message: '看图',
      image: { mediaType: 'image/png', base64: 'A'.repeat(6 * 1024 * 1024) },
    });
    expect(oversizedBody.status).toBe(413);
    expect(askDsh).not.toHaveBeenCalled();
  });

  it('forwards a single upload to the SDK and isolates same public session ids across accounts', async () => {
    process.env.RDK_SIM2REAL_DSH_VISION_MODELS = 'configured-vision-model';
    const { post } = await fixture();
    const body = {
      message: '看图',
      sessionId: 'sim2real-shared-browser-id',
      image: { mediaType: 'image/png' as const, base64: syntheticPng() },
    };
    const first = await post(body, 'account-a');
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      imageAccepted: { mediaType: 'image/png', width: 8, height: 4 },
    });
    const second = await post(body, 'account-b');
    expect(second.status).toBe(200);
    expect(vi.mocked(askDsh).mock.calls[0][2]?.image).toEqual(body.image);
    const idA = vi.mocked(askDsh).mock.calls[0][2]?.sessionId;
    const idB = vi.mocked(askDsh).mock.calls[1][2]?.sessionId;
    expect(idA).not.toBe(idB);
    expect(idA).not.toBe(body.sessionId);
    const anonymous = await post(body, '');
    expect(anonymous.status).toBe(401);
    expect(askDsh).toHaveBeenCalledTimes(2);
  });
});
