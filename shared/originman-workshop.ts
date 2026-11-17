import type { Sim2RealModelManifest } from './sim2real.js';

export interface OriginmanWorkshopConfig {
  phase: 'train' | 'evaluate';
  timesteps: number;
  seed: number;
  pushMaxForce: number;
  device?: 'cuda' | 'cpu';
  sourceRunId?: string;
  /** Resolved by the platform from an owner-visible completed Run. */
  sourceExternalRunId?: string;
  groupId?: string;
}

export const ORIGINMAN_WORKSHOP_CONTRACT = 'custom-policy-originman-recovery-v1';
export const ORIGINMAN_WORKSHOP_TASK = 'originman-recovery';
export const ORIGINMAN_WORKSHOP_ENGINE = 'originman-recovery';
export const ORIGINMAN_REFLECTION_ENGINE = 'originman-recovery-reflect';
export function isOriginmanWorkshopEngine(value: unknown): boolean {
  return value === ORIGINMAN_WORKSHOP_ENGINE || value === ORIGINMAN_REFLECTION_ENGINE;
}

/** Discovery schema; normalizeOriginmanWorkshop remains the runtime validator. */
export const ORIGINMAN_WORKSHOP_INPUT_SCHEMA = {
  type: 'object',
  description: 'OriginMan 原地受扰恢复的训练或评测配置；评测须引用本组已完成的训练 Run。',
  required: ['phase', 'timesteps', 'seed', 'pushMaxForce'],
  additionalProperties: false,
  properties: {
    phase: { type: 'string', enum: ['train', 'evaluate'] },
    timesteps: { type: 'integer' },
    seed: { type: 'integer' },
    pushMaxForce: { type: 'number' },
    device: { type: 'string', enum: ['cuda', 'cpu'] },
    groupId: { type: 'string' },
    sourceRunId: { type: 'string' },
  },
};

export function normalizeOriginmanWorkshop(value: unknown): OriginmanWorkshopConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Workshop 配置必填');
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some(
      (k) =>
        ![
          'phase',
          'timesteps',
          'seed',
          'pushMaxForce',
          'sourceRunId',
          'groupId',
          'device',
        ].includes(k),
    )
  )
    throw new Error('Workshop 配置包含不支持的字段');
  if (v.device !== undefined && !['cuda', 'cpu'].includes(String(v.device)))
    throw new Error('训练设备应为 cuda 或 cpu');
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
  if (
    v.groupId !== undefined &&
    (typeof v.groupId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,23}$/.test(v.groupId))
  )
    throw new Error('小组编号应为1至24位字母、数字、下划线或短横线');
  return {
    phase: v.phase as OriginmanWorkshopConfig['phase'],
    timesteps: v.timesteps,
    seed: v.seed,
    pushMaxForce: v.pushMaxForce,
    ...(typeof v.groupId === 'string' ? { groupId: v.groupId } : {}),
    ...(v.device ? { device: v.device as 'cuda' | 'cpu' } : {}),
    ...(v.phase === 'evaluate' ? { sourceRunId: v.sourceRunId as string } : {}),
  };
}

export interface OriginmanTrainingDevice {
  requestedDevice: 'cuda' | 'cpu';
  resolvedDevice: 'cuda' | 'cpu';
  parameterDevices: string[];
  torchVersion: string;
  cudaRuntime: string | null;
  gpuName?: string;
  physicsBackend: 'cpu-mujoco';
}

function validTrainingDevice(value: unknown): boolean {
  if (value === undefined || value === 'cpu' || value === 'cuda') return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const d = value as OriginmanTrainingDevice;
  return (
    ['cpu', 'cuda'].includes(d.requestedDevice) &&
    d.resolvedDevice === d.requestedDevice &&
    Array.isArray(d.parameterDevices) &&
    d.parameterDevices.length > 0 &&
    d.parameterDevices.length <= 8 &&
    d.parameterDevices.every(
      (p) =>
        typeof p === 'string' &&
        (d.resolvedDevice === 'cuda' ? /^cuda(?::[0-9]+)?$/.test(p) : p === 'cpu'),
    ) &&
    typeof d.torchVersion === 'string' &&
    d.torchVersion.length <= 80 &&
    (d.cudaRuntime === null || (typeof d.cudaRuntime === 'string' && d.cudaRuntime.length <= 80)) &&
    (d.gpuName === undefined || (typeof d.gpuName === 'string' && d.gpuName.length <= 160)) &&
    d.physicsBackend === 'cpu-mujoco'
  );
}

export interface OriginmanWorkshopResult {
  schemaVersion: 1;
  phase: 'train' | 'evaluate';
  seed: number;
  actorRecipe?: 'standard-mlp' | 'reflection-equivariant-mean-even-logstd-v1';
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
  groupId?: string;
  feedbackComparison?: OriginmanFeedbackComparison;
  trainingDevice?: 'cpu' | 'cuda' | OriginmanTrainingDevice;
  gradientUpdates?: number;
  physicsDevice?: 'cpu';
}

export const ORIGINMAN_FEEDBACK_SHA256 =
  'b36cd82c7dda8a4e88adc1de232994c9954d14b7358607602f2254151d196588';
export interface OriginmanFeedbackSuite {
  id: 'historical' | 'additional';
  originalRecovered: number;
  tunedRecovered: number;
  rlRecovered: number;
  normalStanding: boolean;
  clearGain: boolean;
  selectedCase: number;
  cases: {
    index: number;
    force: number;
    start: number;
    duration?: number;
    original: boolean;
    tuned: boolean;
    rl: boolean;
    frozen: boolean;
    fallen: boolean;
  }[];
  traces: { controller: string; frames: number[][] }[];
}
export interface OriginmanEvaluationProtocol {
  schemaVersion: 1;
  durationSeconds: number;
  modelSha256: string;
  evaluatorSha256: string;
  runtimeSha256: string;
  physicalConfigSha256: string;
  conditionsSha256: string;
  controllerSha256: string;
}
export interface OriginmanFeedbackComparison {
  /** Actual finished evaluation captures; absent on historical results. */
  protocol?: OriginmanEvaluationProtocol;
  schemaVersion: 1;
  baselineId: 'originman-joint-feedback-v1';
  baselineSha256: string;
  clearGain: boolean;
  suites: OriginmanFeedbackSuite[];
}

function normalizeFeedback(
  value: OriginmanFeedbackComparison,
): OriginmanFeedbackComparison | undefined {
  if (
    value.schemaVersion !== 1 ||
    value.baselineId !== 'originman-joint-feedback-v1' ||
    value.baselineSha256 !== ORIGINMAN_FEEDBACK_SHA256 ||
    !Array.isArray(value.suites) ||
    value.suites.length !== 2
  )
    return undefined;
  const protocolKeys = [
    'modelSha256',
    'evaluatorSha256',
    'runtimeSha256',
    'physicalConfigSha256',
    'conditionsSha256',
    'controllerSha256',
  ] as const;
  const protocol = value.protocol;
  if (
    protocol !== undefined &&
    (!protocol ||
      protocol.schemaVersion !== 1 ||
      !Number.isFinite(protocol.durationSeconds) ||
      protocol.durationSeconds < 0.02 ||
      protocol.durationSeconds > 0.5 ||
      protocolKeys.some(
        (key) => typeof protocol[key] !== 'string' || !/^[a-f0-9]{64}$/.test(protocol[key]),
      ) ||
      protocol.controllerSha256 !== value.baselineSha256)
  )
    return undefined;
  const suites: OriginmanFeedbackSuite[] = [];
  for (const [index, s] of value.suites.entries()) {
    if (
      s.id !== ['historical', 'additional'][index] ||
      !Array.isArray(s.cases) ||
      s.cases.length !== 31 ||
      !Array.isArray(s.traces) ||
      s.traces.length !== 4
    )
      return undefined;
    const forces =
      index === 0
        ? [-7.9, -7.55, -7.3, -7.05, -6.8, 6.8, 7.05, 7.3, 7.55, 7.9]
        : [-6.55, -6.95, -7.4, -7.75, -8, 6.55, 6.95, 7.4, 7.75, 8];
    const starts = index === 0 ? [1.55, 2.75, 3.95] : [1.83, 2.47, 3.37];
    for (const [i, c] of s.cases.entries()) {
      if (
        c.index !== i ||
        (protocol && c.duration !== protocol.durationSeconds) ||
        (c.duration !== undefined &&
          (!Number.isFinite(c.duration) || c.duration < 0.02 || c.duration > 0.5)) ||
        c.force !== (i === 30 ? 0 : forces[Math.floor(i / 3)]) ||
        c.start !== (i === 30 ? (index === 0 ? 2.75 : 2.47) : starts[i % 3]) ||
        !['original', 'tuned', 'rl', 'frozen', 'fallen'].every(
          (k) => typeof c[k as keyof typeof c] === 'boolean',
        ) ||
        (c.rl && c.fallen)
      )
        return undefined;
    }
    const rl = s.cases.filter((c) => c.rl).length,
      tuned = s.cases.filter((c) => c.tuned).length;
    const clear =
      rl - tuned >= 6 && s.cases[30].rl && s.cases.filter((c) => c.rl && !c.frozen).length >= 3;
    const firstDifference = s.cases.findIndex((c) => c.rl !== c.tuned);
    if (s.selectedCase !== (firstDifference < 0 ? 3 : firstDifference)) return undefined;
    if (
      s.originalRecovered !== s.cases.filter((c) => c.original).length ||
      s.tunedRecovered !== tuned ||
      s.rlRecovered !== rl ||
      s.normalStanding !== s.cases[30].rl ||
      s.clearGain !== clear ||
      !Number.isSafeInteger(s.selectedCase) ||
      s.selectedCase < 0 ||
      s.selectedCase > 30
    )
      return undefined;
    for (const [i, t] of s.traces.entries()) {
      if (
        t.controller !== ['imu-feedback', 'tuned-feedback', 'rl-frozen-correction', 'rl'][i] ||
        !Array.isArray(t.frames) ||
        t.frames.length < 1 ||
        t.frames.length > 152 ||
        t.frames.some(
          (f, j) =>
            !Array.isArray(f) ||
            f.length !== 4 ||
            f.some((n) => typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 10000) ||
            f[0] <= 0 ||
            f[0] > 6.000001 ||
            (j > 0 && f[0] <= t.frames[j - 1][0]),
        )
      )
        return undefined;
    }
    suites.push({
      id: s.id,
      originalRecovered: s.originalRecovered,
      tunedRecovered: tuned,
      rlRecovered: rl,
      normalStanding: s.normalStanding,
      clearGain: clear,
      selectedCase: s.selectedCase,
      cases: s.cases.map((c) => ({
        index: c.index,
        force: c.force,
        start: c.start,
        ...(c.duration !== undefined ? { duration: c.duration } : {}),
        original: c.original,
        tuned: c.tuned,
        rl: c.rl,
        frozen: c.frozen,
        fallen: c.fallen,
      })),
      traces: s.traces.map((t) => ({
        controller: t.controller,
        frames: t.frames.map((f) => [...f]),
      })),
    });
  }
  if (value.clearGain !== suites.every((s) => s.clearGain)) return undefined;
  return {
    schemaVersion: 1,
    ...(protocol
      ? {
          protocol: {
            schemaVersion: 1 as const,
            durationSeconds: protocol.durationSeconds,
            ...Object.fromEntries(protocolKeys.map((key) => [key, protocol[key]])),
          } as OriginmanEvaluationProtocol,
        }
      : {}),
    baselineId: value.baselineId,
    baselineSha256: value.baselineSha256,
    clearGain: value.clearGain,
    suites,
  };
}

/** Bounded worker evidence; malformed outcomes never become a successful learning claim. */
export function normalizeOriginmanWorkshopResult(
  value: unknown,
): OriginmanWorkshopResult | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const v = value as OriginmanWorkshopResult;
    if (
      !validTrainingDevice(v.trainingDevice) ||
      (v.gradientUpdates !== undefined &&
        (!Number.isSafeInteger(v.gradientUpdates) || v.gradientUpdates < 0)) ||
      (v.actorRecipe !== undefined &&
        !['standard-mlp', 'reflection-equivariant-mean-even-logstd-v1'].includes(v.actorRecipe)) ||
      (v.physicsDevice !== undefined && v.physicsDevice !== 'cpu')
    )
      return undefined;
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
      ...(v.groupId !== undefined ? { groupId: v.groupId } : {}),
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
    const feedback =
      v.feedbackComparison === undefined ? undefined : normalizeFeedback(v.feedbackComparison);
    if (v.feedbackComparison !== undefined && (!feedback || v.phase !== 'evaluate'))
      return undefined;
    if (
      feedback &&
      feedback.suites[0].cases.some(
        (c, i) =>
          c.original !== v.cases![i].baseline ||
          c.rl !== v.cases![i].rl ||
          c.frozen !== v.cases![i].frozen,
      )
    )
      return undefined;
    // Clone only declared fields, never arbitrary worker markup or file paths.
    return {
      schemaVersion: 1,
      phase: v.phase,
      seed: v.seed,
      requestedTimesteps: v.requestedTimesteps,
      ...(v.actorRecipe ? { actorRecipe: v.actorRecipe } : {}),
      actualTimesteps: v.actualTimesteps,
      pushMaxForce: v.pushMaxForce,
      policySha256: v.policySha256,
      hardwareEligible: false,
      ...(v.trainingDevice ? { trainingDevice: v.trainingDevice } : {}),
      ...(v.gradientUpdates !== undefined ? { gradientUpdates: v.gradientUpdates } : {}),
      ...(v.physicsDevice ? { physicsDevice: v.physicsDevice } : {}),
      ...(v.groupId !== undefined ? { groupId: v.groupId } : {}),
      ...(feedback ? { feedbackComparison: feedback } : {}),
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
  robot: { id: 'custom', variant: 'legs' },
  contract: {
    id: ORIGINMAN_WORKSHOP_CONTRACT,
    robotId: 'custom',
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
        'jointCount',
        'observationSize',
        'actionSize',
        'controlHz',
        'physicsTimestepSeconds',
        'decimation',
      ] as const
    ).every((key) => contract[key] === expected[key]) &&
    ['custom', 'originman'].includes(contract.robotId) &&
    JSON.stringify(contract.observationLayout) === JSON.stringify(expected.observationLayout)
  );
}
