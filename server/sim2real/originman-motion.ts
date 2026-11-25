import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ORIGINMAN_REFERENCE_JOINTS,
  originmanReferenceCalibration,
  originmanReferenceExample,
  validateOriginmanReferenceTrajectory,
  type OriginmanReferenceTrajectory,
  type OriginmanMotionProvenance,
} from '../../shared/originman-reference-training.js';

const FPS = 50;
const MAX_FRAMES = FPS * 90;
const MAX_BLOCKS = 128;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const demo = originmanReferenceExample();
const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

export class OriginmanMotionError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

type Motion = {
  id: string;
  displayName: string;
  category: string;
  frames: number;
  sha256: string;
  clipped: boolean;
};
type Block = { id: string; repeats: number };
type Preset = {
  id: string;
  displayName: string;
  bpm: number;
  blocks: Block[];
  transitionSeconds: number;
};
type Catalog = { motions: Motion[]; presets: Preset[]; directory?: string };

const builtIn: Catalog = {
  motions: [
    {
      id: 'example-arms',
      displayName: '交替摆臂示例',
      category: '教学示例',
      frames: demo.joint_pos.length,
      sha256: digest(JSON.stringify(demo)),
      clipped: false,
    },
  ],
  presets: [
    {
      id: 'example-arms-preset',
      displayName: '交替摆臂示例',
      bpm: 100,
      blocks: [{ id: 'example-arms', repeats: 1 }],
      transitionSeconds: 0.4,
    },
  ],
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new OriginmanMotionError('请提供有效的编排配置。');
  return value as Record<string, unknown>;
}

function label(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= 80;
}

function blocks(value: unknown, motions: Motion[]): Block[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_BLOCKS)
    throw new OriginmanMotionError('请选择 1–128 个动作块。');
  const ids = new Set(motions.map((motion) => motion.id));
  return value.map((entry) => {
    const { id, repeats = 1, ...extra } = record(entry);
    if (typeof id !== 'string' || !ids.has(id))
      throw new OriginmanMotionError('有动作 ID 不在当前动作库，请刷新动作列表。');
    if (
      typeof repeats !== 'number' ||
      !Number.isInteger(repeats) ||
      repeats < 1 ||
      repeats > 8 ||
      Object.keys(extra).length
    )
      throw new OriginmanMotionError('每个动作的重复次数须为 1–8。');
    return { id, repeats };
  });
}

function transition(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 2)
    throw new OriginmanMotionError('过渡时间须在 0–2 秒之间。');
  return Math.round(value * FPS) / FPS;
}

async function readBounded(file: string, maxBytes: number) {
  const info = await lstat(file);
  if (!info.isFile() || info.size > maxBytes) throw Error('Invalid motion catalog file');
  const buffer = await readFile(file);
  if (buffer.length > maxBytes) throw Error('Invalid motion catalog file size');
  return buffer;
}

async function loadCatalog(): Promise<Catalog> {
  const directory = process.env.RDK_ORIGINMAN_MOTION_DIR?.trim();
  if (!directory) return builtIn;
  try {
    if (!path.isAbsolute(directory)) throw Error('Motion directory must be absolute');
    const { schemaVersion, motions, presets } = record(
      JSON.parse((await readBounded(path.join(directory, 'catalog.json'), 256 * 1024)).toString()),
    );
    if (
      schemaVersion !== 1 ||
      !Array.isArray(motions) ||
      motions.length > 512 ||
      !Array.isArray(presets) ||
      presets.length > 128
    )
      throw Error('Invalid catalog schema');
    const safeMotions = motions.map((entry): Motion => {
      const { id, displayName, category, frames, sha256, clipped = false } = record(entry);
      if (
        typeof id !== 'string' ||
        !ID.test(id) ||
        !label(displayName) ||
        !label(category) ||
        typeof frames !== 'number' ||
        !Number.isInteger(frames) ||
        frames < 50 ||
        frames > MAX_FRAMES ||
        typeof sha256 !== 'string' ||
        !SHA256.test(sha256) ||
        typeof clipped !== 'boolean'
      )
        throw Error('Invalid motion metadata');
      return {
        id,
        displayName: displayName.trim(),
        category: category.trim(),
        frames,
        sha256,
        clipped,
      };
    });
    const safePresets = presets.map((entry): Preset => {
      const { id, displayName, bpm, blocks: sequence, transitionSeconds = 0.4 } = record(entry);
      if (
        typeof id !== 'string' ||
        !ID.test(id) ||
        !label(displayName) ||
        typeof bpm !== 'number' ||
        !Number.isFinite(bpm) ||
        bpm < 80 ||
        bpm > 140
      )
        throw Error('Invalid preset metadata');
      return {
        id,
        displayName: displayName.trim(),
        bpm,
        blocks: blocks(sequence, safeMotions),
        transitionSeconds: transition(transitionSeconds),
      };
    });
    if (
      new Set(safeMotions.map(({ id }) => id)).size !== safeMotions.length ||
      new Set(safePresets.map(({ id }) => id)).size !== safePresets.length
    )
      throw Error('Duplicate catalog identifier');
    return { motions: safeMotions, presets: safePresets, directory };
  } catch {
    throw new OriginmanMotionError('动作库配置不可用，请联系管理员检查素材目录。', 503);
  }
}

function plannedFrames(sequence: Block[], transitionSeconds: number, catalog: Catalog) {
  const framesById = new Map(catalog.motions.map(({ id, frames }) => [id, frames]));
  const count = sequence.reduce((sum, item) => sum + item.repeats, 0);
  const frames = sequence.reduce((sum, item) => sum + framesById.get(item.id)! * item.repeats, 0);
  return frames + (count - 1) * Math.max(0, Math.round(transitionSeconds * FPS) - 1);
}

export async function listOriginmanMotion() {
  const catalog = await loadCatalog();
  return {
    catalogSource: catalog.directory ? 'configured-library' : 'built-in-example',
    motions: catalog.motions.map(({ sha256: _sha, ...motion }) => ({
      ...motion,
      seconds: motion.frames / FPS,
    })),
    presets: catalog.presets.map((preset) => ({
      id: preset.id,
      displayName: preset.displayName,
      bpm: preset.bpm,
      seconds: plannedFrames(preset.blocks, preset.transitionSeconds, catalog) / FPS,
      blocks: preset.blocks.reduce((sum, block) => sum + block.repeats, 0),
    })),
    limits: { maxBlocks: MAX_BLOCKS, maxSeconds: MAX_FRAMES / FPS, maxRepeats: 8 },
  };
}

async function readMotion(catalog: Catalog, motion: Motion) {
  if (!catalog.directory) return demo;
  try {
    const bytes = await readBounded(
      path.join(catalog.directory, motion.id + '.json'),
      5 * 1024 * 1024,
    );
    if (digest(bytes) !== motion.sha256) throw Error('Motion hash mismatch');
    const trajectory = validateOriginmanReferenceTrajectory(JSON.parse(bytes.toString()));
    if (trajectory.joint_pos.length !== motion.frames) throw Error('Motion frame count mismatch');
    return trajectory;
  } catch {
    throw new OriginmanMotionError(
      `动作「${motion.displayName}」文件、摘要或轨迹格式未通过校验。`,
      422,
    );
  }
}

export async function prepareOriginmanMotion(input: unknown) {
  const catalog = await loadCatalog();
  const args = record(input);
  const { presetId, blocks: custom, transitionSeconds = 0.4, bpm = 100, ...extra } = args;
  if (Object.keys(extra).length || (presetId === undefined) === (custom === undefined))
    throw new OriginmanMotionError('请选择一个预置舞蹈，或提供一组自定义动作。');
  const preset = presetId === undefined ? null : catalog.presets.find(({ id }) => id === presetId);
  if (presetId !== undefined && !preset)
    throw new OriginmanMotionError('预置舞蹈 ID 不在当前动作库，请刷新预置列表。');
  if (preset && (Object.hasOwn(args, 'transitionSeconds') || Object.hasOwn(args, 'bpm')))
    throw new OriginmanMotionError('预置使用原有节奏和过渡设置。');
  const selected = preset?.blocks ?? blocks(custom, catalog.motions);
  const seconds = preset?.transitionSeconds ?? transition(transitionSeconds);
  const tempo = preset?.bpm ?? bpm;
  if (typeof tempo !== 'number' || !Number.isFinite(tempo) || tempo < 80 || tempo > 140)
    throw new OriginmanMotionError('节奏须在 80–140 BPM 之间。');
  if (plannedFrames(selected, seconds, catalog) > MAX_FRAMES)
    throw new OriginmanMotionError('编排总时长不能超过 90 秒，请减少动作或重复次数。');

  const motions = new Map(catalog.motions.map((motion) => [motion.id, motion]));
  const positions: number[][] = [];
  const ranges: { id: string; from: number; to: number }[] = [];
  const cache = new Map<string, OriginmanReferenceTrajectory>();
  const transitionFrames = Math.round(seconds * FPS);
  for (const item of selected) {
    const metadata = motions.get(item.id)!;
    let clip = cache.get(item.id);
    if (!clip) {
      clip = await readMotion(catalog, metadata);
      cache.set(item.id, clip);
    }
    for (let repetition = 0; repetition < item.repeats; repetition++) {
      const last = positions.at(-1);
      if (last) {
        const first = clip.joint_pos[0];
        for (let index = 1; index < transitionFrames; index++) {
          const t = index / transitionFrames;
          const weight = t * t * (3 - 2 * t);
          positions.push(
            last.map((q, joint) => Number((q + (first[joint] - q) * weight).toFixed(8))),
          );
        }
      }
      const from = positions.length;
      positions.push(...clip.joint_pos);
      ranges.push({ id: item.id, from, to: positions.length });
    }
  }
  const velocities = positions.map((row, index) => {
    const before = Math.max(0, index - 1);
    const after = Math.min(positions.length - 1, index + 1);
    return row.map((_, joint) =>
      Number(
        (((positions[after][joint] - positions[before][joint]) * FPS) / (after - before)).toFixed(
          8,
        ),
      ),
    );
  });
  let trajectory;
  try {
    trajectory = validateOriginmanReferenceTrajectory({
      schemaVersion: 1,
      fps: FPS,
      joint_names: ORIGINMAN_REFERENCE_JOINTS,
      joint_pos: positions,
      joint_vel: velocities,
    });
  } catch (error) {
    throw new OriginmanMotionError(error instanceof Error ? error.message : '编排轨迹无效。', 422);
  }
  const trajectorySha256 = digest(JSON.stringify(trajectory));
  const provenance: OriginmanMotionProvenance = {
    source: preset ? `preset:${preset.id}` : 'blocks',
    displayName: preset?.displayName ?? '动作组自由编排',
    blocks: selected.map((item) => ({ ...item, sha256: motions.get(item.id)!.sha256 })),
    ranges,
    transitionSeconds: seconds,
    bpm: tempo,
    trajectorySha256,
  };
  return { trajectory, provenance };
}

export function summarizeOriginmanMotion(
  prepared: Awaited<ReturnType<typeof prepareOriginmanMotion>>,
) {
  const { trajectory, provenance } = prepared;
  const frames = trajectory.joint_pos.length;
  const sampleCount = Math.min(frames, 48);
  const sampleFrames = Array.from({ length: sampleCount }, (_, i) =>
    Math.round((i * (frames - 1)) / (sampleCount - 1)),
  );
  const joints = trajectory.joint_names.map((name, joint) => {
    const values = trajectory.joint_pos.map((row) => row[joint]);
    return {
      name,
      min: Math.min(...values),
      max: Math.max(...values),
      values: sampleFrames.map((frame) => values[frame]),
    };
  });
  return {
    frames,
    seconds: frames / trajectory.fps,
    bpm: provenance.bpm,
    beats: ((frames / trajectory.fps) * provenance.bpm) / 60,
    trajectorySha256: provenance.trajectorySha256,
    frameIndices: sampleFrames,
    joints,
    maxJointRad: originmanReferenceCalibration.trajectory.maxAbsRad,
  };
}
