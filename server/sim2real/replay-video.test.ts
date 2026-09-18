import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Sim2RealTelemetrySample } from '../../shared/sim2real-telemetry.js';
import {
  planReplayVideo,
  readReplayVideo,
  replayVideoPath,
  renderReplayVideo,
} from './replay-video.js';

const roots: string[] = [];
const previousStorage = process.env.RDK_SIM2REAL_STORAGE_DIR;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  if (previousStorage === undefined) delete process.env.RDK_SIM2REAL_STORAGE_DIR;
  else process.env.RDK_SIM2REAL_STORAGE_DIR = previousStorage;
});

async function useTempStorage(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-replay-video-'));
  roots.push(root);
  process.env.RDK_SIM2REAL_STORAGE_DIR = root;
  return root;
}

function ffmpegAvailable(): boolean {
  return spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0;
}

/** 6x4 rgb8 frame filled with one flat color (72 bytes; even dimensions so
 *  yuv420p needs no padding path in this test). */
function flatFrame(color: number, t: number): Sim2RealTelemetrySample {
  return {
    t,
    observation: [0, 0, 0],
    action: [0, 0],
    cameraFrame: {
      encoding: 'rgb8',
      width: 6,
      height: 4,
      channels: 3,
      data: Buffer.alloc(72, color).toString('base64'),
    },
  } as Sim2RealTelemetrySample;
}

describe('planReplayVideo', () => {
  it('refuses a run with no camera frames', () => {
    const plan = planReplayVideo([
      { t: 0, observation: [0], action: [0] },
    ] as Sim2RealTelemetrySample[]);
    expect(plan).toMatchObject({ ok: false, code: 'replay_video_no_frames' });
  });

  it('refuses mixed frame geometries within one run', () => {
    const mixed: Sim2RealTelemetrySample[] = [flatFrame(10, 0)];
    mixed.push({
      t: 1,
      observation: [0],
      action: [0],
      cameraFrame: {
        encoding: 'rgb8',
        width: 8,
        height: 3,
        channels: 3,
        data: Buffer.alloc(72, 10).toString('base64'),
      },
    } as Sim2RealTelemetrySample);
    const plan = planReplayVideo(mixed);
    expect(plan).toMatchObject({ ok: false, code: 'replay_video_geometry_mismatch' });
  });

  it('computes fps and duration from frame timestamps', () => {
    const samples = [flatFrame(10, 0), flatFrame(20, 1), flatFrame(30, 2), flatFrame(40, 3)];
    const plan = planReplayVideo(samples);
    expect(plan).toMatchObject({ ok: true });
    if (!plan.ok) return;
    expect(plan.frames).toHaveLength(4);
    expect(plan.geometry).toEqual({ width: 6, height: 4, encoding: 'rgb8' });
    expect(plan.durationSeconds).toBe(3);
    expect(plan.fps).toBeCloseTo(4 / 3, 5);
  });
});

describe('renderReplayVideo + readReplayVideo round trip', () => {
  it.skipIf(!ffmpegAvailable())(
    'renders frames to an MP4 and serves them back with digest verification',
    async () => {
      const root = await useTempStorage();
      const runId = 'run-video-ok';
      const plan = planReplayVideo([flatFrame(40, 0), flatFrame(120, 1), flatFrame(200, 2)]);
      expect(plan.ok).toBe(true);
      if (!plan.ok) return;
      const target = replayVideoPath(runId);
      expect(target).toBeTruthy();
      const rendered = await renderReplayVideo(plan, target!);
      expect(rendered.ok).toBe(true);
      if (!rendered.ok) return;
      expect(rendered.frameCount).toBe(3);
      expect(rendered.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(rendered.sizeBytes).toBeGreaterThan(0);

      // The file lands at the path the route serves from.
      expect(replayVideoPath(runId)).toBe(path.join(root, 'replay-video', `${runId}.mp4`));

      // Reading through the digest gate returns the same bytes.
      const served = await readReplayVideo(runId, rendered.sha256);
      expect(served).not.toBeNull();
      expect(served?.sizeBytes).toBe(rendered.sizeBytes);
      // MP4 box signature: the container really is an MP4, not a raw dump.
      expect(served?.bytes.subarray(4, 8).toString('ascii')).toBe('ftyp');

      // A tampered file must fail the digest re-check.
      await fs.writeFile(path.join(root, 'replay-video', `${runId}.mp4`), Buffer.from('swapped'));
      expect(await readReplayVideo(runId, rendered.sha256)).toBeNull();
    },
  );

  it('refuses to serve when no digest was recorded', async () => {
    await useTempStorage();
    expect(await readReplayVideo('run-no-video', 'a'.repeat(64))).toBeNull();
    expect(await readReplayVideo('run-no-video', 'not-a-digest')).toBeNull();
  });

  it('rejects a run id that is not a safe filename', () => {
    expect(replayVideoPath('../escape')).toBeNull();
    expect(replayVideoPath('')).toBeNull();
  });
});
