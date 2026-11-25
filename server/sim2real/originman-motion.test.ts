import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { originmanReferenceExample } from '../../shared/originman-reference-training.js';
import {
  listOriginmanMotion,
  prepareOriginmanMotion,
  preparePinnedOriginmanMotion,
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

  it('keeps original keyframes and extends only a seam that exceeds the joint speed', async () => {
    const directory = await library();
    const hold = originmanReferenceExample();
    hold.joint_pos = Array.from({ length: 32 }, () =>
      hold.joint_pos[0].map((q, index) => (index === 12 ? 1.5 : q || 0)),
    );
    hold.joint_vel = Array.from({ length: 32 }, () => hold.joint_pos[0].map(() => 0));
    const data = JSON.stringify(hold);
    await writeFile(path.join(directory, 'hold.json'), data);
    const catalogPath = path.join(directory, 'catalog.json');
    const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
    catalog.motions.push({
      id: 'hold',
      displayName: '抬手定格',
      category: '定格',
      frames: 32,
      sha256: createHash('sha256').update(data).digest('hex'),
      poseOnly: true,
    });
    await writeFile(catalogPath, JSON.stringify(catalog));
    expect((await listOriginmanMotion()).motions.at(-1)).toMatchObject({ poseOnly: true });
    await expect(prepareOriginmanMotion({ blocks: [{ id: 'hold', repeats: 2 }] })).rejects.toThrow(
      '动态动作',
    );

    const result = await prepareOriginmanMotion({
      blocks: [{ id: 'arms' }, { id: 'hold', repeats: 2 }],
      transitionSeconds: 0.2,
    });
    const preview = summarizeOriginmanMotion(result);
    expect(preview.adjustedTransitions).toEqual([{ afterBlock: 1, seconds: 0.38 }]);
    expect(preview.extraTransitionSeconds).toBe(0.18);
    const [first, second, third] = result.provenance.ranges;
    expect(first.to).toBe(100);
    expect(second).toEqual({ id: 'hold', from: 118, to: 150 });
    expect(third.from - second.to).toBe(9);
    expect(result.trajectory.joint_pos.slice(second.from, second.to)).toEqual(hold.joint_pos);
    const samples = result.trajectory.joint_pos;
    const speed = samples.slice(1).map((row, index) => Math.abs(row[12] - samples[index][12]) * 50);
    expect(Math.max(...speed)).toBeLessThanOrEqual(6.0001);
  });

  it('keeps every sample, original duration and asset identity for an exact preset', async () => {
    const directory = await library();
    const trajectory = JSON.parse(JSON.stringify(originmanReferenceExample()));
    trajectory.joint_pos = trajectory.joint_pos.slice(0, 143);
    trajectory.joint_vel = trajectory.joint_vel.slice(0, 143);
    trajectory.joint_vel[0][12] = 0.012345678901;
    const data = JSON.stringify(trajectory);
    const file = 'recorded-dance.json';
    const sha256 = createHash('sha256').update(data).digest('hex');
    const sourceSha256 = 'a'.repeat(64);
    const catalogPath = path.join(directory, 'catalog.json');
    await writeFile(path.join(directory, file), data);
    const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
    const exact = {
      id: 'recorded',
      displayName: '原版舞蹈',
      bpm: 90,
      blocks: [{ id: 'arms', repeats: 2 }],
      reference: { file, frames: 143, sha256, sourceSha256, stanceProfile: 'source-neutral-v1' },
    };
    catalog.presets.push(exact);
    await writeFile(catalogPath, JSON.stringify(catalog));
    const selection = { presetId: 'recorded' };
    const listed = (await listOriginmanMotion()).presets.at(-1);
    expect(listed).toMatchObject({
      id: 'recorded',
      referenceMode: 'source-exact',
      stanceProfile: 'source-neutral-v1',
      seconds: 2.86,
      blocks: 2,
    });
    expect(listed).not.toHaveProperty('reference');
    const prepared = await prepareOriginmanMotion(selection);
    expect(prepared.trajectory).toEqual(trajectory);
    expect(prepared.provenance).toMatchObject({
      source: 'preset:recorded',
      ranges: [],
      referenceMode: 'source-exact',
      stanceProfile: 'source-neutral-v1',
      referenceAssetSha256: sha256,
      sourceSha256,
      blocks: [{ id: 'arms', repeats: 2 }],
    });
    expect(prepared.provenance).not.toHaveProperty('transitionSeconds');
    expect(summarizeOriginmanMotion(prepared)).toMatchObject({
      referenceMode: 'source-exact',
      stanceProfile: 'source-neutral-v1',
      seconds: 2.86,
      frames: 143,
      adjustedTransitions: [],
      extraTransitionSeconds: 0,
    });
    const referenceDigest = prepared.provenance.trajectorySha256;
    await expect(preparePinnedOriginmanMotion(selection, referenceDigest)).resolves.toEqual(
      prepared,
    );

    trajectory.joint_vel[0][12] = 0.02;
    const updated = JSON.stringify(trajectory);
    await writeFile(path.join(directory, file), updated);
    await expect(prepareOriginmanMotion(selection)).rejects.toMatchObject({ status: 422 });
    exact.reference.sha256 = createHash('sha256').update(updated).digest('hex');
    await writeFile(catalogPath, JSON.stringify(catalog));
    await expect(preparePinnedOriginmanMotion(selection, referenceDigest)).rejects.toMatchObject({
      status: 409,
    });

    Object.assign(exact.reference, { adapted: true });
    await writeFile(catalogPath, JSON.stringify(catalog));
    expect((await listOriginmanMotion()).presets.at(-1)).toMatchObject({
      referenceMode: 'timing-preserved',
      seconds: 2.86,
    });
    const adapted = await prepareOriginmanMotion(selection);
    expect(adapted.provenance).toMatchObject({
      referenceMode: 'timing-preserved',
      sourceSha256,
      stanceProfile: 'source-neutral-v1',
      ranges: [],
    });
    expect(summarizeOriginmanMotion(adapted)).toMatchObject({
      referenceMode: 'timing-preserved',
      seconds: 2.86,
      frames: 143,
    });
  });

  it('rejects exact source files with invalid bounds, metadata or filesystem references', async () => {
    const directory = await library();
    const file = 'recorded-dance.json';
    const filename = path.join(directory, file);
    const trajectory = JSON.parse(JSON.stringify(originmanReferenceExample()));
    const writeTrajectory = async () => {
      const data = JSON.stringify(trajectory);
      await writeFile(filename, data);
      return createHash('sha256').update(data).digest('hex');
    };
    const catalogPath = path.join(directory, 'catalog.json');
    const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
    const preset = {
      id: 'recorded',
      displayName: '原版舞蹈',
      bpm: 90,
      reference: { file, frames: 200, sha256: await writeTrajectory() },
    };
    catalog.presets.push(preset);
    const saveCatalog = async () => writeFile(catalogPath, JSON.stringify(catalog));
    const selection = { presetId: 'recorded' };
    await saveCatalog();
    expect((await prepareOriginmanMotion(selection)).provenance.blocks).toEqual([]);
    preset.reference.frames = 201;
    await saveCatalog();
    await expect(prepareOriginmanMotion(selection)).rejects.toMatchObject({ status: 422 });
    preset.reference.frames = 200;
    trajectory.joint_vel[0][12] = 6.01;
    preset.reference.sha256 = await writeTrajectory();
    await saveCatalog();
    await expect(prepareOriginmanMotion(selection)).rejects.toMatchObject({ status: 422 });
    preset.reference.frames = 4_501;
    await saveCatalog();
    await expect(listOriginmanMotion()).rejects.toMatchObject({ status: 503 });
    preset.reference.frames = 200;
    Object.assign(preset.reference, { stanceProfile: 'untrusted-profile' });
    await saveCatalog();
    await expect(listOriginmanMotion()).rejects.toMatchObject({ status: 503 });
    Object.assign(preset.reference, { stanceProfile: 'source-neutral-v1' });
    preset.reference.file = '../recorded-dance.json';
    await saveCatalog();
    await expect(listOriginmanMotion()).rejects.toMatchObject({ status: 503 });
    preset.reference.file = 'source-link.json';
    await symlink(filename, path.join(directory, 'source-link.json'));
    await saveCatalog();
    await expect(prepareOriginmanMotion(selection)).rejects.toMatchObject({ status: 422 });
  });

  it('lists unavailable motions without including them in custom or preset choreography', async () => {
    const directory = await library();
    const catalogPath = path.join(directory, 'catalog.json');
    const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
    const saveCatalog = async () => writeFile(catalogPath, JSON.stringify(catalog));
    expect(await listOriginmanMotion()).not.toHaveProperty('unavailableMotions');
    catalog.unavailableMotions = [
      { id: 'floor', displayName: '  下地 ', reason: 'joint-limit', sha256: 'private-field' },
      { id: 'shoot', displayName: '侧身', reason: 'stability' },
    ];
    await saveCatalog();

    const result = await listOriginmanMotion();
    expect(result.motions.map(({ id }) => id)).toEqual(['arms']);
    expect(result.unavailableMotions).toEqual([
      { id: 'floor', displayName: '下地', reason: 'joint-limit' },
      { id: 'shoot', displayName: '侧身', reason: 'stability' },
    ]);
    await expect(prepareOriginmanMotion({ blocks: [{ id: 'floor' }] })).rejects.toMatchObject({
      status: 400,
    });

    catalog.presets[0].blocks = [{ id: 'floor' }];
    await saveCatalog();
    await expect(prepareOriginmanMotion({ presetId: 'full-dance' })).rejects.toMatchObject({
      status: 503,
    });
  });

  it.each([
    ['an unknown reason', [{ id: 'floor', displayName: '下地', reason: 'unknown' }]],
    ['an invalid label', [{ id: 'floor', displayName: ' ', reason: 'joint-limit' }]],
    ['an invalid ID', [{ id: '../floor', displayName: '下地', reason: 'joint-limit' }]],
    ['an active-motion collision', [{ id: 'arms', displayName: '摆臂', reason: 'joint-limit' }]],
    [
      'an unavailable-motion duplicate',
      [
        { id: 'floor', displayName: '下地', reason: 'joint-limit' },
        { id: 'floor', displayName: '下地', reason: 'stability' },
      ],
    ],
    [
      'too many entries',
      Array.from({ length: 513 }, (_, i) => ({
        id: `blocked-${i}`,
        displayName: '未通过',
        reason: 'stability',
      })),
    ],
  ])('rejects an unavailable list with %s', async (_reason, unavailableMotions) => {
    const directory = await library();
    const catalogPath = path.join(directory, 'catalog.json');
    const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
    await writeFile(catalogPath, JSON.stringify({ ...catalog, unavailableMotions }));
    await expect(listOriginmanMotion()).rejects.toMatchObject({ status: 503 });
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

it('hashes the same ordered samples after serialization and rejects stale previews', async () => {
  const { originmanReferenceDigest } = await import('./originman-reference-digest.js');
  const value = originmanReferenceExample();
  const expected = originmanReferenceDigest(value);
  const roundTrip = JSON.parse(JSON.stringify(value));
  roundTrip.joint_vel[0][0] = -0;
  expect(originmanReferenceDigest(roundTrip)).toBe(expected);
  roundTrip.joint_pos[0][2] += 1e-7;
  expect(originmanReferenceDigest(roundTrip)).not.toBe(expected);
  const recipe = { presetId: 'example-arms-preset' };
  await expect(preparePinnedOriginmanMotion(recipe, 'a'.repeat(64))).rejects.toMatchObject({
    status: 409,
  });
  const prepared = await prepareOriginmanMotion(recipe);
  expect(prepared.provenance.trajectoryDigestVersion).toBe('originman-reference-f64be-v1');
  expect(await preparePinnedOriginmanMotion(recipe, prepared.provenance.trajectorySha256)).toEqual(
    prepared,
  );
});
