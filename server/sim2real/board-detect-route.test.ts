import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createDeviceBoardDetectRouter, readDevices } from './standalone-adapters.js';

const roots: string[] = [];
const previousStorage = process.env.RDK_SIM2REAL_STORAGE_DIR;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  if (previousStorage === undefined) delete process.env.RDK_SIM2REAL_STORAGE_DIR;
  else process.env.RDK_SIM2REAL_STORAGE_DIR = previousStorage;
});

function routeHandler(router: ReturnType<typeof createDeviceBoardDetectRouter>) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === '/api/devices/:id/board/detect' && entry.route.methods.post,
  );
  const handler = layer?.route?.stack[0]?.handle;
  if (!handler) throw new Error('board detect route missing');
  return handler;
}

async function invoke(router: ReturnType<typeof createDeviceBoardDetectRouter>, persist = false) {
  return new Promise<{ statusCode: number; body?: unknown }>((resolve, reject) => {
    const response = {
      statusCode: 200,
      status(code: number) {
        response.statusCode = code;
        return response;
      },
      json(body: unknown) {
        resolve({ statusCode: response.statusCode, body });
        return response;
      },
    } as any;
    const request = {
      params: { id: 'x5-local' },
      query: persist ? { persist: 'true' } : {},
      headers: {},
      method: 'POST',
      path: '/api/devices/x5-local/board/detect',
    } as any;
    routeHandler(router)(request, response, (error?: unknown) => {
      if (error) reject(error);
    });
  });
}

describe('standalone BoardAgent board-detect route', () => {
  it('runs the fixed read-only probe and persists only passport metadata', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-board-detect-'));
    roots.push(root);
    process.env.RDK_SIM2REAL_STORAGE_DIR = root;
    await fs.writeFile(
      path.join(root, 'devices.json'),
      JSON.stringify([
        {
          id: 'x5-local',
          host: '127.0.0.1',
          username: 'sim2real',
          status: 'connected',
          lastCheckedAt: new Date().toISOString(),
        },
      ]),
      'utf8',
    );
    const output = [
      '__STUDIO_SIM2REAL_PREFLIGHT_BEGIN__',
      'arch=aarch64',
      'kernel=6.1.0-rdk',
      'python3=/usr/bin/python3',
      'tros=present',
      `disk_bytes=${2 * 1024 ** 3}`,
      '__STUDIO_SIM2REAL_PREFLIGHT_END__',
    ].join('\n');
    let command = '';
    const router = createDeviceBoardDetectRouter(async (_request, _response, _id, commands) => {
      command = commands[0] || '';
      return {
        device: { id: 'x5-local', boardPlatform: 'rdk-x5', boardModel: 'RDK X5' },
        output,
        exitCode: 0,
        mock: true,
        actuatorControl: false,
      };
    });
    const response = await invoke(router, true);
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      platform: 'rdk-x5',
      mock: true,
      persisted: true,
      actuatorControl: false,
    });
    expect(command).toContain('__STUDIO_SIM2REAL_PREFLIGHT_BEGIN__');
    expect((await readDevices())[0]).toMatchObject({ boardPlatform: 'rdk-x5', boardModel: 'RDK X5' });
  });

  it('fails closed when no BoardAgent result is available', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-board-detect-'));
    roots.push(root);
    process.env.RDK_SIM2REAL_STORAGE_DIR = root;
    await fs.writeFile(
      path.join(root, 'devices.json'),
      JSON.stringify([
        {
          id: 'x5-local',
          host: '127.0.0.1',
          username: 'sim2real',
          status: 'connected',
          lastCheckedAt: new Date().toISOString(),
        },
      ]),
      'utf8',
    );
    const response = await invoke(createDeviceBoardDetectRouter(async () => null));
    expect(response.statusCode).toBe(503);
    expect(response.body).toMatchObject({ error: 'SIM2REAL_BOARD_AGENT_UNAVAILABLE' });
  });

  it('rejects a partial passport instead of reporting a detected board', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-board-detect-'));
    roots.push(root);
    process.env.RDK_SIM2REAL_STORAGE_DIR = root;
    await fs.writeFile(
      path.join(root, 'devices.json'),
      JSON.stringify([
        {
          id: 'x5-local',
          host: '127.0.0.1',
          username: 'sim2real',
          status: 'connected',
          lastCheckedAt: new Date().toISOString(),
        },
      ]),
      'utf8',
    );
    const response = await invoke(
      createDeviceBoardDetectRouter(async () => ({
        device: { id: 'x5-local' },
        output: '__STUDIO_SIM2REAL_PREFLIGHT_BEGIN__\narch=aarch64\n__STUDIO_SIM2REAL_PREFLIGHT_END__',
        exitCode: 0,
      })),
    );
    expect(response.statusCode).toBe(502);
    expect(response.body).toMatchObject({ error: 'SIM2REAL_BOARD_PASSPORT_INVALID' });
  });
});
