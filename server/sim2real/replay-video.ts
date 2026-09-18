import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { Sim2RealTelemetrySample } from '../../shared/sim2real-telemetry.js';
import { resolveDataDir } from './standalone-adapters.js';

/**
 * Replay video pipeline: turns a run's aligned camera frames (raw rgb8/bgr8/
 * mono8 pixels carried in attested board telemetry) into a shareable MP4
 * artifact whose frame timeline is the telemetry timeline.
 *
 * The video is a rendering of accepted evidence, not new evidence: it is
 * produced only from frames the ingest path already validated (shape, byte
 * length, base64) and only for single-source board runs. Its digest is
 * recorded at creation and re-verified on every serve, mirroring how the
 * ONNX artifact gate works for policy bytes.
 */
export const REPLAY_VIDEO_MAX_FRAMES = 6000;
const REPLAY_VIDEO_MAX_FRAMES_BYTES = 12 * 1024 * 1024;
const REPLAY_VIDEO_MAX_INPUT_BYTES = 2 * 1024 * 1024 * 1024;
const FFMPEG_TIMEOUT_MS = 180_000;

export type ReplayVideoPlan =
  | {
      ok: true;
      frames: {
        t: number;
        width: number;
        height: number;
        encoding: string;
        bytes: number;
        data: string;
      }[];
      fps: number;
      geometry: { width: number; height: number; encoding: string };
      durationSeconds: number;
    }
  | { ok: false; code: string; message: string };

function ffmpegBinary(): string | null {
  const override = String(process.env.RDK_SIM2REAL_FFMPEG_PATH ?? '').trim();
  if (override) return override;
  const paths = String(process.env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((entry) => path.join(entry, 'ffmpeg'));
  for (const candidate of paths) {
    try {
      fsSync.accessSync(candidate, fsSync.constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Extract the camera frames from replay samples and verify the whole run can
 * be rendered as one video: uniform geometry, uniform encoding, bounded frame
 * count. The board spools frames sparsely (one every stride), which the video
 * preserves by generating a constant frame-rate stream with `-vsync vfr`-style
 * timestamps taken from each frame's own `t`.
 */
export function planReplayVideo(samples: readonly Sim2RealTelemetrySample[]): ReplayVideoPlan {
  const frames: {
    t: number;
    width: number;
    height: number;
    encoding: string;
    bytes: number;
    data: string;
  }[] = [];
  let geometry: { width: number; height: number; encoding: string } | null = null;
  for (const sample of samples) {
    const camera = sample.cameraFrame;
    if (!camera) continue;
    if (camera.encoding !== 'rgb8' && camera.encoding !== 'bgr8' && camera.encoding !== 'mono8') {
      return {
        ok: false,
        code: 'replay_video_frame_encoding',
        message: `相机帧编码 ${camera.encoding} 不支持视频导出。`,
      };
    }
    const shape = { width: camera.width, height: camera.height, encoding: camera.encoding };
    if (
      geometry &&
      (geometry.width !== shape.width ||
        geometry.height !== shape.height ||
        geometry.encoding !== shape.encoding)
    ) {
      return {
        ok: false,
        code: 'replay_video_geometry_mismatch',
        message: `相机帧几何不一致（${geometry.width}×${geometry.height} ${geometry.encoding} vs ${shape.width}×${shape.height} ${shape.encoding}）；一个视频只能承载一种几何。`,
      };
    }
    geometry = shape;
    frames.push({
      t: Number(sample.t),
      width: camera.width,
      height: camera.height,
      encoding: camera.encoding,
      bytes: camera.width * camera.height * camera.channels,
      data: String(camera.data || ''),
    });
  }
  if (!frames.length || !geometry) {
    return {
      ok: false,
      code: 'replay_video_no_frames',
      message: '该运行没有对齐的相机帧，无视频可导出。',
    };
  }
  if (frames.length > REPLAY_VIDEO_MAX_FRAMES) {
    return {
      ok: false,
      code: 'replay_video_too_many_frames',
      message: `相机帧超过 ${REPLAY_VIDEO_MAX_FRAMES} 帧上限。`,
    };
  }
  let inputBytes = 0;
  for (const frame of frames) {
    inputBytes += frame.bytes;
    if (inputBytes > REPLAY_VIDEO_MAX_INPUT_BYTES) {
      return {
        ok: false,
        code: 'replay_video_too_large',
        message: '相机帧总字节数超过视频导出上限。',
      };
    }
  }
  const first = frames[0].t;
  const last = frames[frames.length - 1].t;
  const duration = Math.max(0, last - first);
  const fps = Number.isFinite(duration) && duration > 0 ? frames.length / duration : 0;
  return {
    ok: true,
    frames,
    fps,
    geometry,
    durationSeconds: duration,
  };
}

export type ReplayVideoResult =
  | {
      ok: true;
      file: string;
      sha256: string;
      sizeBytes: number;
      frameCount: number;
      fps: number;
      durationSeconds: number;
    }
  | { ok: false; code: string; message: string };

/** pixel format string for the declared encoding */
function pixelFormat(encoding: string): string {
  if (encoding === 'mono8') return 'gray';
  return 'rgb24';
}

/**
 * Encode the plan's frames into an MP4 at `targetFile` by piping raw frames
 * into ffmpeg. bgr8 is converted by swapping channels in Node (ffmpeg only
 * takes rgb24), keeping the pipe protocol uniform. yuv420p requires even
 * dimensions, so an odd-width/height frame is padded on the right/bottom with
 * a 1-pixel black edge and the video keeps the frame's own aspect otherwise.
 */
export async function renderReplayVideo(
  plan: Extract<ReplayVideoPlan, { ok: true }>,
  targetFile: string,
): Promise<ReplayVideoResult> {
  const binary = ffmpegBinary();
  if (!binary) {
    return {
      ok: false,
      code: 'replay_video_ffmpeg_missing',
      message: 'ffmpeg 不在 PATH 上（可设置 RDK_SIM2REAL_FFMPEG_PATH）；无视频可导出。',
    };
  }
  // The first render for a storage root must create replay-video/ itself; the
  // route hands us replayVideoPath() output without pre-creating the dir.
  await fs.mkdir(path.dirname(targetFile), { recursive: true });
  const { width, height, encoding } = plan.geometry;
  const videoWidth = width + (width % 2);
  const videoHeight = height + (height % 2);
  const args = [
    '-f',
    'rawvideo',
    '-pixel_format',
    pixelFormat(encoding),
    '-video_size',
    `${width}x${height}`,
    '-i',
    'pipe:0',
    '-vf',
    `pad=${videoWidth}:${videoHeight}:0:0:black`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-y',
    targetFile,
  ];
  const child = spawn(binary, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  const stderrChunks: Buffer[] = [];
  let stderrBytes = 0;
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderrBytes < 64 * 1024) {
      stderrChunks.push(chunk);
      stderrBytes += chunk.length;
    }
  });
  const timer = setTimeout(() => child.kill('SIGTERM'), FFMPEG_TIMEOUT_MS);
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  try {
    for (const frame of plan.frames) {
      const raw = Buffer.from(frame.data, 'base64');
      if (raw.length !== frame.bytes) {
        return {
          ok: false,
          code: 'replay_video_frame_bytes',
          message: '相机帧字节与声明几何不一致，拒绝导出。',
        };
      }
      const pixels = encoding === 'bgr8' ? swapBgr(raw) : raw;
      if (!child.stdin.write(pixels)) {
        await new Promise<void>((resolve) => child.stdin.once('drain', resolve));
      }
    }
    child.stdin.end();
  } catch {
    child.kill('SIGTERM');
    return { ok: false, code: 'replay_video_pipe_failed', message: '向 ffmpeg 写入原始帧失败。' };
  }
  const { code, signal } = await closed;
  clearTimeout(timer);
  if (code !== 0 || signal) {
    await fs.rm(targetFile, { force: true }).catch(() => undefined);
    const tail = Buffer.concat(stderrChunks).toString('utf8').split('\n').slice(-8).join('\n');
    return {
      ok: false,
      code: 'replay_video_encode_failed',
      message: `ffmpeg 编码失败${signal ? `（${signal}）` : ''}。${tail}`,
    };
  }
  const bytes = await fs.readFile(targetFile);
  if (!bytes.length) {
    return { ok: false, code: 'replay_video_empty', message: 'ffmpeg 产生了空视频文件。' };
  }
  return {
    ok: true,
    file: targetFile,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
    frameCount: plan.frames.length,
    fps: plan.fps,
    durationSeconds: plan.durationSeconds,
  };
}

/** rgb24 from bgr24 raw bytes (channel swap in triples). */
function swapBgr(raw: Buffer): Buffer {
  const out = Buffer.allocUnsafe(raw.length);
  for (let offset = 0; offset + 2 < raw.length; offset += 3) {
    out[offset] = raw[offset + 2];
    out[offset + 1] = raw[offset + 1];
    out[offset + 2] = raw[offset];
  }
  return out;
}

export function replayVideoPath(runId: string): string | null {
  if (!/^[\w-]{1,128}$/.test(runId)) return null;
  const root = String(process.env.RDK_SIM2REAL_STORAGE_DIR ?? '').trim() || resolveDataDir();
  return path.join(root, 'replay-video', `${runId}.mp4`);
}

/**
 * Read a previously rendered video and re-verify its digest: serving a video
 * whose bytes drifted since rendering would present unverified content as
 * evidence, so a mismatch fails closed.
 */
export async function readReplayVideo(
  runId: string,
  expectedSha256: string,
): Promise<{ bytes: Buffer; sizeBytes: number } | null> {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) return null;
  const file = replayVideoPath(runId);
  if (!file) return null;
  try {
    const bytes = await fs.readFile(file);
    if (bytes.length === 0 || bytes.length > REPLAY_VIDEO_MAX_FRAMES_BYTES) return null;
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== expectedSha256) return null;
    return { bytes, sizeBytes: bytes.length };
  } catch {
    return null;
  }
}
