const FPS = 50;
const MAX_FRAMES = 12_000;
const TRANSITION_FRAMES = 20;
export const MAX_REFERENCE_CLIPS = 8;

export function composeOriginmanReference(clips, speed, jointNames, limits) {
  if (!clips.length || clips.length > MAX_REFERENCE_CLIPS || ![1, 0.75, 0.5].includes(speed)) {
    throw Error('请选择 1–8 个片段和有效的轨迹速度。');
  }
  const interpolate = (from, to, fraction) => from.map((q, joint) => q + (to[joint] - q) * fraction);
  const positions = [];
  const validFrame = (row, limit) => Array.isArray(row) && row.length === jointNames.length &&
    row[0] === 0 && row[1] === 0 && row.every((q) => Number.isFinite(q) && Math.abs(q) <= limit);
  for (const { label, value } of clips) {
    if (value?.schemaVersion !== 1 || value.fps !== FPS ||
        !Array.isArray(value.joint_names) || value.joint_names.length !== jointNames.length ||
        value.joint_names.some((name, index) => name !== jointNames[index])) {
      throw Error(label + '的关节顺序或采样频率与 OriginMan 参考格式不一致。');
    }
    const { joint_pos: poses, joint_vel: velocities } = value;
    if (!Array.isArray(poses) || poses.length < 50 || poses.length > MAX_FRAMES ||
        !Array.isArray(velocities) || velocities.length !== poses.length ||
        !poses.every((row) => validFrame(row, limits.maxAbsRad)) ||
        !velocities.every((row) => validFrame(row, limits.maxSpeedRadPerS))) {
      throw Error(label + '的关节角度、速度或帧数超出参考格式范围。');
    }
    const transition = positions.length ? TRANSITION_FRAMES - 1 : 0;
    if (Math.ceil((positions.length + transition + poses.length - 1) / speed) + 1 > MAX_FRAMES) {
      throw Error('拼接和慢放后的轨迹不能超过 240 秒。请减少片段或提高播放速度。');
    }
    if (transition) {
      const from = positions.at(-1);
      for (let i = 1; i <= transition; i++) {
        const t = i / TRANSITION_FRAMES;
        positions.push(interpolate(from, poses[0], t * t * (3 - 2 * t)));
      }
    }
    positions.push(...poses);
  }
  if (clips.length === 1 && speed === 1) return clips[0].value;

  const count = Math.ceil((positions.length - 1) / speed) + 1;
  const joint_pos = Array.from({ length: count }, (_, index) => {
    const sample = Math.min(index * speed, positions.length - 1);
    const from = Math.floor(sample);
    return interpolate(positions[from], positions[Math.ceil(sample)], sample - from)
      .map((q) => Number(q.toFixed(8)));
  });
  const joint_vel = joint_pos.map((frame, index) => {
    const before = Math.max(index - 1, 0);
    const after = Math.min(index + 1, count - 1);
    return frame.map((_, joint) => Number((
      (joint_pos[after][joint] - joint_pos[before][joint]) * FPS / (after - before)
    ).toFixed(8)));
  });
  return { schemaVersion: 1, fps: FPS, joint_names: [...jointNames], joint_pos, joint_vel };
}
