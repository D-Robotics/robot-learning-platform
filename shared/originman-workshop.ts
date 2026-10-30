import type { Sim2RealModelManifest } from './sim2real.js';

export interface OriginmanWorkshopConfig {
  phase: 'train' | 'evaluate';
  timesteps: number;
  seed: number;
  pushMaxForce: number;
  sourceRunId?: string;
  /** Resolved by the platform from an owner-visible completed Run. */
  sourceExternalRunId?: string;
}

export const ORIGINMAN_WORKSHOP_CONTRACT = 'custom-policy-originman-recovery-v1';
export const ORIGINMAN_WORKSHOP_TASK = 'originman-recovery';
export const ORIGINMAN_WORKSHOP_ENGINE = 'originman-recovery';

export function normalizeOriginmanWorkshop(value: unknown): OriginmanWorkshopConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Workshop 配置必填');
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some(
      (k) => !['phase', 'timesteps', 'seed', 'pushMaxForce', 'sourceRunId'].includes(k),
    )
  )
    throw new Error('Workshop 配置包含不支持的字段');
  if (!['train', 'evaluate'].includes(String(v.phase))) throw new Error('Workshop 阶段无效');
  if (
    typeof v.timesteps !== 'number' ||
    !Number.isSafeInteger(v.timesteps) ||
    v.timesteps < 4096 ||
    v.timesteps > 1000000
  )
    throw new Error('训练步数应为4096至1000000的整数');
  if (typeof v.seed !== 'number' || !Number.isSafeInteger(v.seed) || v.seed < 0 || v.seed > 1000000)
    throw new Error('随机种子应为0至1000000的整数');
  if (
    typeof v.pushMaxForce !== 'number' ||
    !Number.isFinite(v.pushMaxForce) ||
    v.pushMaxForce < 6.4 ||
    v.pushMaxForce > 9
  )
    throw new Error('训练侧推上限应为6.4至9N');
  if (
    v.phase === 'evaluate' &&
    (typeof v.sourceRunId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(v.sourceRunId))
  )
    throw new Error('评测必须选择已完成的本组训练');
  if (v.phase === 'train' && v.sourceRunId !== undefined) throw new Error('从零训练不接受父权重');
  return {
    phase: v.phase as OriginmanWorkshopConfig['phase'],
    timesteps: v.timesteps,
    seed: v.seed,
    pushMaxForce: v.pushMaxForce,
    ...(v.phase === 'evaluate' ? { sourceRunId: v.sourceRunId as string } : {}),
  };
}

export interface OriginmanWorkshopResult {
  schemaVersion: 1;
  phase: 'train' | 'evaluate';
  seed: number;
  requestedTimesteps: number;
  actualTimesteps: number;
  pushMaxForce: number;
  policySha256: string;
  hardwareEligible: false;
  sourceRunId?: string;
  baselineRecovered?: number;
  rlRecovered?: number;
  clearGain?: boolean;
  normalStanding?: boolean;
  cases?: {
    index: number;
    force: number;
    start: number;
    baseline: boolean;
    initial: boolean;
    rl: boolean;
    frozen: boolean;
    fallen: boolean;
  }[];
  selectedCase?: number;
  traces?: { controller: string; frames: number[][] }[];
  video?: { sha256: string; bytes: number };
  videoError?: string;
}

/** Bounded worker evidence; malformed outcomes never become a successful learning claim. */
export function normalizeOriginmanWorkshopResult(
  value: unknown,
): OriginmanWorkshopResult | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const v = value as OriginmanWorkshopResult;
    if (
      JSON.stringify(v).length > 300000 ||
      v.schemaVersion !== 1 ||
      v.hardwareEligible !== false ||
      !/^[a-f0-9]{64}$/.test(v.policySha256)
    )
      return undefined;
    normalizeOriginmanWorkshop({
      phase: v.phase,
      timesteps: v.requestedTimesteps,
      seed: v.seed,
      pushMaxForce: v.pushMaxForce,
      ...(v.phase === 'evaluate' ? { sourceRunId: v.sourceRunId } : {}),
    });
    if (
      !Number.isSafeInteger(v.actualTimesteps) ||
      v.actualTimesteps < v.requestedTimesteps ||
      v.actualTimesteps > v.requestedTimesteps + 255
    )
      return undefined;
    if (v.phase === 'evaluate') {
      if (
        !Array.isArray(v.cases) ||
        v.cases.length !== 31 ||
        !Array.isArray(v.traces) ||
        v.traces.length !== 4
      )
        return undefined;
      const forces = [-7.9, -7.55, -7.3, -7.05, -6.8, 6.8, 7.05, 7.3, 7.55, 7.9];
      for (const [i, c] of v.cases.entries()) {
        if (
          c.index !== i ||
          c.force !== (i === 30 ? 0 : forces[Math.floor(i / 3)]) ||
          c.start !== (i === 30 ? 2.75 : [1.55, 2.75, 3.95][i % 3]) ||
          !['baseline', 'initial', 'rl', 'frozen', 'fallen'].every(
            (k) => typeof c[k as keyof typeof c] === 'boolean',
          ) ||
          c.initial !== c.baseline
        )
          return undefined;
      }
      const baseline = v.cases.filter((c) => c.baseline).length;
      const learned = v.cases.filter((c) => c.rl).length;
      const dynamic = v.cases.filter((c) => c.rl && !c.frozen).length;
      if (
        v.baselineRecovered !== baseline ||
        v.rlRecovered !== learned ||
        v.normalStanding !== v.cases[30].rl ||
        v.clearGain !== (learned - baseline >= 6 && v.cases[30].rl && dynamic >= 3)
      )
        return undefined;
      if (!Number.isSafeInteger(v.selectedCase) || v.selectedCase! < 0 || v.selectedCase! > 30)
        return undefined;
      for (const [i, trace] of v.traces.entries()) {
        if (
          trace.controller !== ['reference', 'imu-feedback', 'untrained', 'rl'][i] ||
          !Array.isArray(trace.frames) ||
          trace.frames.length < 1 ||
          trace.frames.length > 152 ||
          trace.frames.some(
            (f) =>
              !Array.isArray(f) ||
              f.length !== 4 ||
              f.some((n) => typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 10000),
          )
        )
          return undefined;
      }
    }
    if (
      v.video &&
      (!/^[a-f0-9]{64}$/.test(v.video.sha256) ||
        !Number.isSafeInteger(v.video.bytes) ||
        v.video.bytes < 1 ||
        v.video.bytes > 20000000)
    )
      return undefined;
    // Clone only declared fields, never arbitrary worker markup or file paths.
    return {
      schemaVersion: 1,
      phase: v.phase,
      seed: v.seed,
      requestedTimesteps: v.requestedTimesteps,
      actualTimesteps: v.actualTimesteps,
      pushMaxForce: v.pushMaxForce,
      policySha256: v.policySha256,
      hardwareEligible: false,
      ...(v.phase === 'evaluate'
        ? {
            sourceRunId: v.sourceRunId,
            baselineRecovered: v.baselineRecovered,
            rlRecovered: v.rlRecovered,
            normalStanding: v.normalStanding,
            clearGain: v.clearGain,
            cases: v.cases!.map((c) => ({
              index: c.index,
              force: c.force,
              start: c.start,
              baseline: c.baseline,
              initial: c.initial,
              rl: c.rl,
              frozen: c.frozen,
              fallen: c.fallen,
            })),
            selectedCase: v.selectedCase,
            traces: v.traces!.map((t) => ({
              controller: t.controller,
              frames: t.frames.map((f) => [...f]),
            })),
          }
        : {}),
      ...(v.video ? { video: { sha256: v.video.sha256, bytes: v.video.bytes } } : {}),
      ...(typeof v.videoError === 'string' ? { videoError: v.videoError.slice(0, 180) } : {}),
    };
  } catch {
    return undefined;
  }
}

export const ORIGINMAN_WORKSHOP_MANIFEST: Sim2RealModelManifest = {
  schemaVersion: 1,
  modelId: 'originman-recovery-workshop',
  displayName: 'OriginMan · 受扰恢复 Workshop',
  version: 'residual-v1',
  robot: { id: 'originman', variant: 'legs' },
  contract: {
    id: ORIGINMAN_WORKSHOP_CONTRACT,
    robotId: 'originman',
    jointCount: 20,
    observationSize: 14,
    actionSize: 2,
    controlHz: 50,
    physicsTimestepSeconds: 0.001,
    decimation: 20,
    observationLayout: [
      { name: 'roll_pitch_rates', size: 4 },
      { name: 'hip_ankle_offsets', size: 4 },
      { name: 'hip_ankle_velocities', size: 4 },
      { name: 'previous_correction', size: 2 },
    ],
  },
  simulator: { backends: ['local'], policyArtifactId: 'originman-simulation-contract' },
  artifacts: [
    {
      id: 'originman-simulation-contract',
      role: 'policy',
      ref: 'artifact://originman-recovery/contract',
      kind: 'source',
      format: 'onnx',
      name: 'contract-placeholder.onnx',
    },
  ],
  metadata: {
    source: 'OriginMan residual SAC workshop',
    notes:
      '契约占位不含策略；训练后生成本组权重。仅仿真，固定PD加两个连续髋踝修正，不具备硬件部署资格。',
  },
};

export function matchesOriginmanWorkshopContract(
  contract: Sim2RealModelManifest['contract'],
): boolean {
  const expected = ORIGINMAN_WORKSHOP_MANIFEST.contract;
  return (
    (
      [
        'id',
        'robotId',
        'jointCount',
        'observationSize',
        'actionSize',
        'controlHz',
        'physicsTimestepSeconds',
        'decimation',
      ] as const
    ).every((key) => contract[key] === expected[key]) &&
    JSON.stringify(contract.observationLayout) === JSON.stringify(expected.observationLayout)
  );
}
