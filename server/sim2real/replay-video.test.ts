import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Sim2RealTelemetrySample } from '../../shared/sim2real-telemetry.js';
import {
  planReplayVideo,
  readReplayVideo,
  replayVideoPath,
  renderReplayVideo,
} from './replay-video.js';

const roots: string[] = [];
const previousStorage = process.env.RDK_SIM2REAL_STORAGE_DIR;
const previousFfmpeg = process.env.RDK_SIM2REAL_FFMPEG_PATH;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  if (previousStorage === undefined) delete process.env.RDK_SIM2REAL_STORAGE_DIR;
  else process.env.RDK_SIM2REAL_STORAGE_DIR = previousStorage;
  if (previousFfmpeg === undefined) delete process.env.RDK_SIM2REAL_FFMPEG_PATH;
  else process.env.RDK_SIM2REAL_FFMPEG_PATH = previousFfmpeg;
  vi.useRealTimers();
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

  it('refuses nonfinite, repeated and decreasing camera timestamps', () => {
    for (const times of [
      [0, NaN],
      [1, 1],
      [2, 1],
    ]) {
      expect(planReplayVideo(times.map((t) => flatFrame(10, t)))).toMatchObject({
        ok: false,
        code: 'replay_video_frame_time',
      });
    }
  });

  it('rejects malformed channel counts and declared frame bytes', () => {
    const frame = flatFrame(10, 0);
    frame.cameraFrame!.channels = 1;
    expect(planReplayVideo([frame])).toMatchObject({
      ok: false,
      code: 'replay_video_frame_geometry',
    });
    frame.cameraFrame!.channels = 3;
    frame.cameraFrame!.data = Buffer.alloc(3).toString('base64');
    expect(planReplayVideo([frame])).toMatchObject({ ok: false, code: 'replay_video_frame_bytes' });
  });

  it('bounds frame count, frame size and recorded duration', () => {
    expect(planReplayVideo(Array.from({ length: 6001 }, (_, t) => flatFrame(10, t)))).toMatchObject(
      { ok: false, code: 'replay_video_too_many_frames' },
    );
    expect(planReplayVideo([flatFrame(10, 0), flatFrame(10, 21601)])).toMatchObject({
      ok: false,
      code: 'replay_video_duration_limit',
    });
    const frame = flatFrame(10, 0);
    frame.cameraFrame!.width = 10000000;
    expect(planReplayVideo([frame])).toMatchObject({
      ok: false,
      code: 'replay_video_frame_geometry',
    });
  });
});

describe('renderReplayVideo + readReplayVideo round trip', () => {
  it('cleans private frames after encoder failure and retains a previous valid output', async () => {
    const root = await useTempStorage();
    const binary = path.join(root, 'fake-ffmpeg');
    await fs.writeFile(binary, '#!/bin/sh\nprintf encoder-failed >&2\nexit 2\n', { mode: 0o700 });
    process.env.RDK_SIM2REAL_FFMPEG_PATH = binary;
    const plan = planReplayVideo([flatFrame(10, 0)]);
    if (!plan.ok) throw new Error(plan.message);
    const target = replayVideoPath('retain-output')!;
    await fs.mkdir(path.dirname(target));
    await fs.writeFile(target, 'previous-output');
    expect(await renderReplayVideo(plan, target)).toMatchObject({
      ok: false,
      code: 'replay_video_encode_failed',
    });
    expect(await fs.readFile(target, 'utf8')).toBe('previous-output');
    expect(await fs.readdir(path.dirname(target))).toEqual(['retain-output.mp4']);
    process.env.RDK_SIM2REAL_FFMPEG_PATH = path.join(root, 'absent-binary');
    expect(await renderReplayVideo(plan, target)).toMatchObject({
      ok: false,
      code: 'replay_video_encode_failed',
    });
    expect(await fs.readdir(path.dirname(target))).toEqual(['retain-output.mp4']);
  });

  it('terminates a timed-out encoder and cleans its scratch directory', async () => {
    const root = await useTempStorage();
    const binary = path.join(root, 'slow-ffmpeg');
    await fs.writeFile(binary, '#!/bin/sh\nprintf started > started\nexec /bin/sleep 60\n', {
      mode: 0o700,
    });
    process.env.RDK_SIM2REAL_FFMPEG_PATH = binary;
    const plan = planReplayVideo([flatFrame(10, 0)]);
    if (!plan.ok) throw new Error(plan.message);
    const physicalDelay = setTimeout;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const target = replayVideoPath('timeout')!;
    const rendered = renderReplayVideo(plan, target);
    let started = false;
    for (let attempt = 0; attempt < 100 && !started; attempt += 1) {
      await new Promise<void>((resolve) => physicalDelay(resolve, 5));
      const files = await fs.readdir(path.dirname(target)).catch(() => [] as string[]);
      const scratch = files.find((name) => name.startsWith('.replay-frames-'));
      if (scratch)
        started = await fs.stat(path.join(path.dirname(target), scratch, 'started')).then(
          () => true,
          () => false,
        );
    }
    await vi.advanceTimersByTimeAsync(180000);
    expect(await rendered).toMatchObject({ ok: false, code: 'replay_video_timeout' });
    expect(started).toBe(true);
    expect(await fs.readdir(path.dirname(target))).toEqual([]);
  });

  it('rejects tampered plans before starting an encoder', async () => {
    await useTempStorage();
    const plan = planReplayVideo([flatFrame(10, 0)]);
    if (!plan.ok) throw new Error(plan.message);
    plan.frames[0].bytes = 3;
    expect(await renderReplayVideo(plan, replayVideoPath('bad-plan')!)).toMatchObject({
      ok: false,
      code: 'replay_video_frame_bytes',
    });
  });
  it.skipIf(!ffmpegAvailable() || spawnSync('ffprobe', ['-version']).status !== 0)(
    'preserves irregular recorded presentation times in the actual MP4',
    async () => {
      await useTempStorage();
      const plan = planReplayVideo([
        flatFrame(40, 100),
        flatFrame(120, 100.125),
        flatFrame(200, 103.75),
      ]);
      if (!plan.ok) throw new Error(plan.message);
      const target = replayVideoPath('irregular-time')!;
      const rendered = await renderReplayVideo(plan, target);
      expect(rendered.ok).toBe(true);
      const probe = spawnSync(
        'ffprobe',
        [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-show_entries',
          'frame=best_effort_timestamp_time',
          '-of',
          'json',
          target,
        ],
        { encoding: 'utf8' },
      );
      expect(probe.status).toBe(0);
      const times = JSON.parse(probe.stdout).frames.map(
        (frame: { best_effort_timestamp_time: string }) => Number(frame.best_effort_timestamp_time),
      );
      expect(times).toHaveLength(3);
      expect(times[0]).toBeCloseTo(0, 3);
      expect(times[1]).toBeCloseTo(0.125, 3);
      expect(times[2]).toBeCloseTo(3.75, 3);
      expect(await fs.readdir(path.dirname(target))).toEqual(['irregular-time.mp4']);
    },
  );
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
