import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createDeviceConnection,
  listDeviceConnections,
  markConnectionCheck,
} from './board-tunnel-manager.js';

const previousStorage = process.env.RDK_SIM2REAL_STORAGE_DIR;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  if (previousStorage === undefined) delete process.env.RDK_SIM2REAL_STORAGE_DIR;
  else process.env.RDK_SIM2REAL_STORAGE_DIR = previousStorage;
});

async function fixture(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-tunnel-owner-'));
  roots.push(root);
  process.env.RDK_SIM2REAL_STORAGE_DIR = root;
}

describe('device connection tenant quotas', () => {
  it('scopes duplicate detection and the 50-record cap to each owner', async () => {
    await fixture();

    const alice = await createDeviceConnection(
      { host: 'shared.example.test', username: 'robot' },
      'alice',
    );
    expect(alice).not.toMatchObject({ error: expect.anything() });

    // The same SSH coordinates are valid for a different tenant and do not
    // reveal Alice's record through a cross-tenant duplicate response.
    const bob = await createDeviceConnection(
      { host: 'shared.example.test', username: 'robot' },
      'bob',
    );
    expect(bob).not.toMatchObject({ error: expect.anything() });
    expect(listDeviceConnections('alice')).toHaveLength(1);
    expect(listDeviceConnections('bob')).toHaveLength(1);

    for (let index = 0; index < 49; index += 1) {
      const created = await createDeviceConnection(
        { host: `alice-${index}.example.test`, username: 'robot' },
        'alice',
      );
      expect(created).not.toMatchObject({ error: expect.anything() });
    }
    expect(listDeviceConnections('alice')).toHaveLength(50);

    const aliceOverflow = await createDeviceConnection(
      { host: 'alice-overflow.example.test', username: 'robot' },
      'alice',
    );
    expect(aliceOverflow).toEqual({ error: 'QUOTA_EXCEEDED' });

    const bobSecond = await createDeviceConnection(
      { host: 'bob-second.example.test', username: 'robot' },
      'bob',
    );
    expect(bobSecond).not.toMatchObject({ error: expect.anything() });
    expect(listDeviceConnections('bob')).toHaveLength(2);
  });
});

describe('device connection registry integrity', () => {
  it('fails closed on a corrupt registry instead of replacing it', async () => {
    await fixture();
    const file = path.join(process.env.RDK_SIM2REAL_STORAGE_DIR!, 'device-connections.json');
    const corrupt = '{"records": [this is not a registry]}';
    await fs.writeFile(file, corrupt, { mode: 0o600 });

    expect(() => listDeviceConnections()).toThrowError('sim2real_storage_unavailable');
    await expect(createDeviceConnection({ host: 'board.example.test' })).rejects.toThrow(
      'sim2real_storage_unavailable',
    );
    await expect(fs.readFile(file, 'utf8')).resolves.toBe(corrupt);
  });

  it('rejects a symlinked registry without touching its target', async () => {
    await fixture();
    const root = process.env.RDK_SIM2REAL_STORAGE_DIR!;
    const file = path.join(root, 'device-connections.json');
    const target = path.join(root, 'outside.json');
    await fs.writeFile(target, '[]\n', { mode: 0o600 });
    await fs.symlink(target, file);

    expect(() => listDeviceConnections()).toThrowError('sim2real_storage_unavailable');
    await expect(createDeviceConnection({ host: 'board.example.test' })).rejects.toThrow(
      'sim2real_storage_unavailable',
    );
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('[]\n');
  });

  it('rejects a registry whose group/world mode exposes SSH coordinates', async () => {
    await fixture();
    const created = await createDeviceConnection({ host: 'board.example.test' });
    expect(created).not.toMatchObject({ error: expect.anything() });
    const file = path.join(process.env.RDK_SIM2REAL_STORAGE_DIR!, 'device-connections.json');
    await fs.chmod(file, 0o644);
    const before = await fs.readFile(file, 'utf8');

    expect(() => listDeviceConnections()).toThrowError('sim2real_storage_unavailable');
    await expect(createDeviceConnection({ host: 'another.example.test' })).rejects.toThrow(
      'sim2real_storage_unavailable',
    );
    await expect(fs.readFile(file, 'utf8')).resolves.toBe(before);
  });

  it('rejects duplicate ids instead of making tunnel ownership ambiguous', async () => {
    await fixture();
    const file = path.join(process.env.RDK_SIM2REAL_STORAGE_DIR!, 'device-connections.json');
    const record = {
      id: 'board-duplicate',
      label: 'Board',
      host: 'board.example.test',
      port: 22,
      username: 'root',
      agentPort: 19_100,
      localPort: 0,
      createdAt: new Date(0).toISOString(),
      lastCheckedAt: null,
      lastCheckOk: null,
      lastCheckMessage: '尚未测试连接。',
      profile: 'custom',
      transport: 'ssh',
    };
    const raw = JSON.stringify([record, { ...record, host: 'other.example.test' }], null, 2);
    await fs.writeFile(file, raw, { mode: 0o600 });

    expect(() => listDeviceConnections()).toThrowError('sim2real_storage_unavailable');
    await expect(createDeviceConnection({ host: 'new.example.test' })).rejects.toThrow(
      'sim2real_storage_unavailable',
    );
    await expect(fs.readFile(file, 'utf8')).resolves.toBe(raw);
  });

  it('enforces the global record cap before writing a third tenant cohort', async () => {
    await fixture();
    const file = path.join(process.env.RDK_SIM2REAL_STORAGE_DIR!, 'device-connections.json');
    const records = Array.from({ length: 500 }, (_, index) => ({
      id: `board-${String(index).padStart(4, '0')}`,
      label: `Board ${index}`,
      host: `board-${index}.example.test`,
      port: 22,
      username: 'root',
      agentPort: 19_100,
      localPort: 0,
      createdAt: new Date(0).toISOString(),
      lastCheckedAt: null,
      lastCheckOk: null,
      lastCheckMessage: '尚未测试连接。',
      profile: 'custom',
      transport: 'ssh',
      ownerKey: `sso:owner-${index % 3}:web`,
    }));
    const raw = JSON.stringify(records, null, 2);
    await fs.writeFile(file, raw, { mode: 0o600 });

    await expect(
      createDeviceConnection({ host: 'new.example.test' }, 'new-owner'),
    ).resolves.toEqual({ error: 'QUOTA_EXCEEDED' });
    await expect(fs.readFile(file, 'utf8')).resolves.toBe(raw);
  });

  it('serializes the complete read-modify-write sequence for concurrent creates', async () => {
    await fixture();
    const created = await Promise.all([
      createDeviceConnection({ host: 'first.example.test', username: 'root' }),
      createDeviceConnection({ host: 'second.example.test', username: 'root' }),
    ]);
    expect(created.every((item) => !('error' in item))).toBe(true);
    expect(listDeviceConnections()).toHaveLength(2);
  });

  it('does not lose a sibling status update when checks finish together', async () => {
    await fixture();
    const [first, second] = await Promise.all([
      createDeviceConnection({ host: 'first.example.test', username: 'root' }),
      createDeviceConnection({ host: 'second.example.test', username: 'root' }),
    ]);
    expect(first).not.toMatchObject({ error: expect.anything() });
    expect(second).not.toMatchObject({ error: expect.anything() });
    if ('error' in first || 'error' in second) return;

    await Promise.all([
      markConnectionCheck(first.id, true, 'first ok'),
      markConnectionCheck(second.id, false, 'second failed'),
    ]);
    expect(listDeviceConnections()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.id, lastCheckOk: true, lastCheckMessage: 'first ok' }),
        expect.objectContaining({
          id: second.id,
          lastCheckOk: false,
          lastCheckMessage: 'second failed',
        }),
      ]),
    );
  });
});
