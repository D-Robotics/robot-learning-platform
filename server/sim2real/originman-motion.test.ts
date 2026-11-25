import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { originmanReferenceExample } from '../../shared/originman-reference-training.js';
import {
  listOriginmanMotion,
  prepareOriginmanMotion,
  summarizeOriginmanMotion,
} from './originman-motion.js';

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function library() {
  const directory = await mkdtemp(path.join(tmpdir(), 'originman-motion-test-'));
  directories.push(directory);
  vi.stubEnv('RDK_ORIGINMAN_MOTION_DIR', directory);
  const trajectory = originmanReferenceExample();
  trajectory.joint_pos = trajectory.joint_pos.slice(0, 100);
  trajectory.joint_vel = trajectory.joint_vel.slice(0, 100);
  const data = JSON.stringify(trajectory);
  await writeFile(path.join(directory, 'arms.json'), data);
  const sha256 = createHash('sha256').update(data).digest('hex');
  await writeFile(
    path.join(directory, 'catalog.json'),
    JSON.stringify({
      schemaVersion: 1,
      motions: [{ id: 'arms', displayName: '摆臂', category: '测试', frames: 100, sha256 }],
      presets: [
        {
          id: 'full-dance',
          displayName: '26 段',
          bpm: 100,
          transitionSeconds: 0.4,
          blocks: Array.from({ length: 26 }, () => ({ id: 'arms' })),
        },
      ],
    }),
  );
  return directory;
}

describe('OriginMan reference choreography', () => {
  it('compiles 26 blocks with stable frame ranges, metadata and bounded preview curves', async () => {
    await library();
    const catalog = await listOriginmanMotion();
    expect(catalog.presets[0]).toMatchObject({ id: 'full-dance', blocks: 26, seconds: 61.5 });
    const prepared = await prepareOriginmanMotion({ presetId: 'full-dance' });
    expect(prepared.provenance.ranges).toHaveLength(26);
    expect(prepared.provenance.ranges.at(-1)).toEqual({ id: 'arms', from: 2975, to: 3075 });
    const preview = summarizeOriginmanMotion(prepared);
    expect(preview).toMatchObject({ frames: 3075, seconds: 61.5 });
    expect(preview.joints).toHaveLength(20);
    expect(preview.joints.every(({ values }) => values.length === 48)).toBe(true);
    expect((await prepareOriginmanMotion({ presetId: 'full-dance' })).provenance).toEqual(
      prepared.provenance,
    );
  });

  it('rejects mutually exclusive inputs, unknown IDs, excessive duration and altered files', async () => {
    const directory = await library();
    await expect(
      prepareOriginmanMotion({ presetId: 'full-dance', blocks: [{ id: 'arms' }] }),
    ).rejects.toThrow('请选择');
    await expect(prepareOriginmanMotion({ blocks: [{ id: 'missing' }] })).rejects.toThrow(
      '不在当前动作库',
    );
    await expect(prepareOriginmanMotion({ blocks: [{ id: 'arms', repeats: 9 }] })).rejects.toThrow(
      '1–8',
    );
    await expect(
      prepareOriginmanMotion({
        blocks: Array.from({ length: 6 }, () => ({ id: 'arms', repeats: 8 })),
      }),
    ).rejects.toThrow('90 秒');
    await writeFile(path.join(directory, 'arms.json'), '{}');
    await expect(prepareOriginmanMotion({ presetId: 'full-dance' })).rejects.toThrow('摘要');
  });
});
