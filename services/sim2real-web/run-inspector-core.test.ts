import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

let core: any;
beforeAll(async () => {
  await import(
    pathToFileURL(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'public/run-inspector-core.js'),
    ).href
  );
  core = (globalThis as any).RdkRunInspectorCore;
});

describe('Run inspection preserves recorded time and data identity', () => {
  it('sorts irregular timestamps, rejects missing time, and keeps zero', () => {
    const result = core.prepareFrames([
      { t: 8 },
      { t: 0 },
      { t: 0.15 },
      {},
      { t: null },
      { t: '' },
      { t: true },
    ]);
    expect(result.frames.map((frame: any) => frame.t)).toEqual([0, 0.15, 8]);
    expect(result.dropped).toBe(4);
  });

  it('selects the recorded sample at or before elapsed time, never a future sample', () => {
    const frames = core.prepareFrames([
      { t: 10, reward: 1 },
      { t: 10.25, reward: 2 },
      { t: 13, reward: 3 },
    ]).frames;
    expect(core.sampleAtElapsed(frames, 0.2).sample.reward).toBe(1);
    expect(core.sampleAtElapsed(frames, 0.25).sample.reward).toBe(2);
    expect(core.sampleAtElapsed(frames, 3.01).sample).toBeNull();
    expect(core.sampleAtElapsed(frames, 3.01).ended).toBe(true);
  });

  it('aligns two runs by elapsed time despite different starts, sampling, and durations', () => {
    const left = core.prepareFrames([{ t: 100 }, { t: 100.5 }, { t: 105 }]).frames;
    const right = core.prepareFrames([{ t: 7 }, { t: 8 }, { t: 9 }]).frames;
    expect(core.sampleAtElapsed(left, 1.5).sample.t).toBe(100.5);
    expect(core.sampleAtElapsed(right, 1.5).sample.t).toBe(8);
    expect(core.sampleAtElapsed(right, 3).sample).toBeNull();
  });

  it('never displays a camera image from the future', () => {
    const cameraFrame = { width: 1, height: 1, channels: 3, encoding: 'rgb8', data: 'AAAA' };
    const frames = core.prepareFrames([{ t: 0 }, { t: 2, cameraFrame }, { t: 4 }]).frames;
    expect(core.cameraAtElapsed(frames, 1)).toBeNull();
    expect(core.cameraAtElapsed(frames, 3)).toMatchObject({ frame: { t: 2 }, age: 1 });
  });
});

describe('Run inspection uses declared semantics without inventing values', () => {
  it('expands vector layouts but does not count the separate image input', () => {
    const contract = {
      observationLayout: [
        { name: 'camera', modality: 'image', size: 64 },
        { name: 'gyro', size: 2, unit: 'rad/s' },
        { name: 'command', size: 1 },
      ],
    };
    expect(core.dimensions(contract, 'observation', 4)).toEqual([
      { name: 'gyro[0]', unit: 'rad/s', index: 0 },
      { name: 'gyro[1]', unit: 'rad/s', index: 1 },
      { name: 'command', unit: null, index: 2 },
      { name: 'observation[3]', unit: null, index: 3 },
    ]);
  });

  it('does not infer joint names or units from action width', () => {
    expect(core.dimensions({}, 'action', 2)).toEqual([
      { name: 'action[0]', unit: null, index: 0 },
      { name: 'action[1]', unit: null, index: 1 },
    ]);
  });

  it('shows reward parts only when the source contains numeric contributions', () => {
    expect(core.rewardParts({ reward: 8 })).toEqual([]);
    expect(
      core.rewardParts({ rewardComponents: { tracking: 0, fall: -2, missing: null, weight: '3' } }),
    ).toEqual([
      { name: 'tracking', value: 0 },
      { name: 'fall', value: -2 },
    ]);
  });

  it('extracts actual fall/done/session events with their recorded time', () => {
    const frames = core.prepareFrames([
      { t: 10 },
      { t: 11, fall: true },
      { t: 12, event: { kind: 'session-stopped', stopReason: 'operator-stop' } },
    ]).frames;
    expect(core.events(frames)).toEqual([
      { elapsed: 1, t: 11, label: '跌倒', kind: 'fall' },
      { elapsed: 2, t: 12, label: 'session-stopped · operator-stop', kind: 'session-stopped' },
    ]);
  });

  it('converts BGR and mono frames correctly and rejects geometry mismatch', () => {
    expect(
      Array.from(
        core.cameraRgba(
          { width: 1, height: 1, channels: 3, encoding: 'bgr8' },
          new Uint8Array([2, 4, 8]),
        ),
      ),
    ).toEqual([8, 4, 2, 255]);
    expect(
      Array.from(
        core.cameraRgba(
          { width: 1, height: 1, channels: 1, encoding: 'mono8' },
          new Uint8Array([7]),
        ),
      ),
    ).toEqual([7, 7, 7, 255]);
    expect(
      core.cameraRgba(
        { width: 2, height: 1, channels: 3, encoding: 'rgb8' },
        new Uint8Array([2, 4, 8]),
      ),
    ).toBeNull();
    expect(
      core.cameraRgba(
        { width: 1, height: 1, channels: 3, encoding: 'unknown' },
        new Uint8Array([2, 4, 8]),
      ),
    ).toBeNull();
  });
});
