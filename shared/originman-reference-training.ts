import originmanReferenceCalibration from '../plugins/rdk-robot-learning-platform/references/originman-reference-calibration.json' with { type: 'json' };
export { originmanReferenceCalibration };

export const ORIGINMAN_REFERENCE_TASK = 'originman-reference-track';
export const ORIGINMAN_REFERENCE_ENGINE = 'originman-reference-ppo';
export const ORIGINMAN_REFERENCE_CONTRACT = 'custom-policy-originman-reference-v2';
export const ORIGINMAN_REFERENCE_JOINTS = originmanReferenceCalibration.robot.jointOrder;
const { fps, maxAbsRad, maxSpeedRadPerS } = originmanReferenceCalibration.trajectory;
const ROUNDING_TOLERANCE = 1e-4;
export const ORIGINMAN_REFERENCE_MAX_FRAMES = 12_000;
export const ORIGINMAN_REFERENCE_MIN_MOTION_FRAMES = 2;
export const ORIGINMAN_REFERENCE_MAX_COMPOSITION_BLOCKS = 128;
export const ORIGINMAN_REFERENCE_MAX_BLOCK_REPEATS = 8;
export const ORIGINMAN_REFERENCE_MAX_COMPOSITION_SECTIONS =
  ORIGINMAN_REFERENCE_MAX_COMPOSITION_BLOCKS * ORIGINMAN_REFERENCE_MAX_BLOCK_REPEATS;
export const ORIGINMAN_SOURCE_STANCE = 'source-neutral-v1';

export interface OriginmanReferenceTrajectory {
  schemaVersion: 1;
  fps: 50;
  joint_names: string[];
  joint_pos: number[][];
  joint_vel: number[][];
}

export interface OriginmanMotionProvenance {
  source: string;
  displayName: string;
  blocks: { id: string; repeats: number; sha256: string }[];
  ranges: { id: string; from: number; to: number }[];
  transitionSeconds?: number;
  referenceAssetSha256?: string;
  referenceMode?: 'source-exact' | 'timing-preserved';
  stanceProfile?: typeof ORIGINMAN_SOURCE_STANCE;
  sourceSha256?: string;
  bpm: number;
  trajectorySha256: string;
  trajectoryDigestVersion?: 'originman-reference-f64be-v1';
}

export interface OriginmanReferenceTraining {
  trajectory: OriginmanReferenceTrajectory;
  trainingSteps: number;
  seed: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function validateOriginmanReferenceTrajectory(
  value: unknown,
  purpose: 'training' | 'motion-block' = 'training',
): OriginmanReferenceTrajectory {
  const minimumFrames = purpose === 'motion-block' ? ORIGINMAN_REFERENCE_MIN_MOTION_FRAMES : fps;
  if (!isRecord(value) || value.schemaVersion !== 1 || value.fps !== fps)
    throw Error('参考轨迹须使用 schemaVersion 1，采样频率为 50 Hz。');
  const names = value.joint_names;
  if (
    !Array.isArray(names) ||
    names.length !== ORIGINMAN_REFERENCE_JOINTS.length ||
    ORIGINMAN_REFERENCE_JOINTS.some((name, index) => names[index] !== name)
  )
    throw Error('joint_names 须按示例顺序列出 OriginMan 的 20 个关节。');
  const poses = value.joint_pos;
  const velocities = value.joint_vel;
  if (
    !Array.isArray(poses) ||
    poses.length < minimumFrames ||
    poses.length > ORIGINMAN_REFERENCE_MAX_FRAMES ||
    !Array.isArray(velocities) ||
    velocities.length !== poses.length
  )
    throw Error(
      purpose === 'motion-block'
        ? '动作块的 joint_pos 和 joint_vel 须同长，至少包含两帧。'
        : 'joint_pos 和 joint_vel 须同长，包含 50–12,000 帧（1–240 秒）。',
    );
  function verifyRows(rows: unknown[], limit: number, field: string): number[][] {
    return rows.map((frame, index) => {
      if (!Array.isArray(frame) || frame.length !== ORIGINMAN_REFERENCE_JOINTS.length)
        throw Error(`${field} 第 ${index + 1} 帧须包含 20 个数。`);
      const invalid = frame.findIndex(
        (n) => typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > limit,
      );
      if (invalid >= 0)
        throw Error(
          `${field} 第 ${index + 1} 帧的 ${ORIGINMAN_REFERENCE_JOINTS[invalid]} 须为有限数，绝对值不超过 ${limit}。`,
        );
      if (frame[0] !== 0 || frame[1] !== 0)
        throw Error(`${field} 第 ${index + 1} 帧的两个头部通道须为 0。`);
      return frame;
    });
  }
  const joint_pos = verifyRows(poses, maxAbsRad, 'joint_pos（相对站姿的弧度）');
  const joint_vel = verifyRows(velocities, maxSpeedRadPerS, 'joint_vel（弧度/秒）');
  for (let i = 1; i < joint_pos.length; i++) {
    const joint = joint_pos[i].findIndex(
      (p, j) => Math.abs(p - joint_pos[i - 1][j]) * fps > maxSpeedRadPerS + ROUNDING_TOLERANCE,
    );
    if (joint >= 0)
      throw Error(
        `joint_pos 第 ${i + 1} 帧的 ${ORIGINMAN_REFERENCE_JOINTS[joint]} 与上一帧之间超过每秒 ${maxSpeedRadPerS} 弧度。`,
      );
  }
  if (
    purpose === 'training' &&
    !joint_pos.some((frame) =>
      frame.some((position, joint) => Math.abs(position - joint_pos[0][joint]) >= 0.05),
    )
  )
    throw Error('参考轨迹需至少有一个关节相对首帧移动 0.05 弧度。');
  return {
    schemaVersion: 1,
    fps: 50,
    joint_names: [...ORIGINMAN_REFERENCE_JOINTS],
    joint_pos,
    joint_vel,
  };
}

export function validateOriginmanReferenceTraining(value: unknown): OriginmanReferenceTraining {
  if (!isRecord(value)) throw Error('请提供参考轨迹、训练步数和随机种子。');
  const { trainingSteps, seed } = value;
  if (
    typeof trainingSteps !== 'number' ||
    !Number.isSafeInteger(trainingSteps) ||
    trainingSteps < 8192 ||
    trainingSteps > 2_000_000 ||
    trainingSteps % 4096 !== 0
  )
    throw Error('训练步数须是 4,096 的倍数，且在 8,192 到 2,000,000 步之间。');
  if (typeof seed !== 'number' || !Number.isSafeInteger(seed) || seed < 0 || seed > 2_147_483_647)
    throw Error('随机种子须为 0 到 2147483647 的整数。');
  return {
    trajectory: validateOriginmanReferenceTrajectory(value.trajectory),
    trainingSteps,
    seed,
  };
}

export function originmanReferenceExample(): OriginmanReferenceTrajectory {
  const home = ORIGINMAN_REFERENCE_JOINTS.map(() => 0);
  const joint_pos = [];
  const joint_vel = [];
  for (let i = 0; i < 200; i++) {
    const phase = (2 * Math.PI * i) / 100;
    const q = [...home];
    const dq = home.map(() => 0);
    q[12] = Number((0.14 * (1 - Math.cos(phase))).toFixed(6));
    dq[12] = Number((0.14 * Math.PI * Math.sin(phase)).toFixed(6));
    q[16] = -q[12];
    dq[16] = -dq[12];
    joint_pos.push(q);
    joint_vel.push(dq);
  }
  return {
    schemaVersion: 1,
    fps: 50,
    joint_names: [...ORIGINMAN_REFERENCE_JOINTS],
    joint_pos,
    joint_vel,
  };
}
