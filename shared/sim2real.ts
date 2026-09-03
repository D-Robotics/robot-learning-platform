import type {
  ModelArtifactDescriptor,
  ModelArtifactFormat,
  ModelArtifactKind,
  ModelArtifactRuntime,
  ModelArtifactWorkload,
  ModelCompatibilityResult,
} from './model-artifacts.js';
import type { RdkPlatform } from './board-types.js';
import type {
  Sim2RealEvaluationSummary,
  Sim2RealRunArtifactMetadata,
  Sim2RealRunMetrics,
} from './sim2real-telemetry.js';

export type {
  Sim2RealEvaluationSummary,
  Sim2RealReplaySummary,
  Sim2RealRunArtifactMetadata,
  Sim2RealRunMetrics,
  Sim2RealTelemetryRecord,
  Sim2RealTelemetrySample,
  Sim2RealTelemetrySource,
} from './sim2real-telemetry.js';

export const SIM2REAL_SCHEMA_VERSION = 1 as const;
export const MICRODUCK_SIM2REAL_CONTRACT_ID = 'microduck-policy-v1' as const;

export const MICRODUCK_OBSERVATION_LAYOUT = [
  { name: 'gyro', size: 3 },
  { name: 'projected_gravity', size: 3 },
  { name: 'joint_position_error', size: 14 },
  { name: 'joint_velocity', size: 14 },
  { name: 'last_action', size: 14 },
  { name: 'command', size: 13 },
] as const;

export const MICRODUCK_SIM2REAL_CONTRACT = Object.freeze({
  id: MICRODUCK_SIM2REAL_CONTRACT_ID,
  robotId: 'microduck',
  jointCount: 14,
  observationSize: 61,
  actionSize: 14,
  controlHz: 50,
  physicsTimestepSeconds: 0.005,
  decimation: 4,
  observationLayout: MICRODUCK_OBSERVATION_LAYOUT,
});

/** Product lines share a workflow, not a policy contract. */
export type Sim2RealRobotId = 'microduck' | 'rdk-duck';

export type Sim2RealProductContractMode = 'fixed' | 'manifest-defined';

export interface Sim2RealProductProfile {
  id: Sim2RealRobotId;
  displayName: string;
  contractMode: Sim2RealProductContractMode;
  contractId?: string;
  contractIdPrefix?: string;
  simulatorPath?: string;
  targetPlatforms: string[];
  accessories: string[];
}

export const SIM2REAL_PRODUCT_PROFILES: Readonly<Record<Sim2RealRobotId, Sim2RealProductProfile>> =
  Object.freeze({
    microduck: {
      id: 'microduck',
      displayName: 'MicroDuck',
      contractMode: 'fixed',
      contractId: MICRODUCK_SIM2REAL_CONTRACT_ID,
      simulatorPath: '/mujoco/microduck/',
      targetPlatforms: ['rdk-x5'],
      accessories: ['ball'],
    },
    'rdk-duck': {
      id: 'rdk-duck',
      displayName: 'RDK Duck',
      contractMode: 'manifest-defined',
      contractIdPrefix: 'rdk-duck-policy-',
      targetPlatforms: ['rdk-x5'],
      accessories: ['camera', 'imu', 'servo', 'ball'],
    },
  });

export type Sim2RealBackend = 'browser' | 'robogo' | 'local';
export type Sim2RealRunBackend = Sim2RealBackend | 'contract';
export type Sim2RealRobotVariant = 'legs' | 'rollers' | 'both' | (string & {});
export type Sim2RealArtifactRole = 'policy' | 'compiled-policy' | 'calibration';
export type Sim2RealTrainingProfile = 'smoke' | 'low-vram' | 'standard' | 'high-vram';

export interface Sim2RealPolicyBinding {
  id: string;
  label: string;
  artifactId: string;
  keys?: string[];
  description?: string;
}

export interface Sim2RealPolicyBundle {
  defaultPolicyId: string;
  policies: Sim2RealPolicyBinding[];
}

export interface Sim2RealTrainingSpec {
  profile: Sim2RealTrainingProfile;
  numEnvs: number;
  maxIterations: number;
  video: boolean;
  runName?: string;
}

export interface Sim2RealCheckpointRef {
  checkpointId: string;
  artifactRef: string;
  iteration?: number;
}

export interface Sim2RealContract {
  id: string;
  robotId: Sim2RealRobotId;
  jointCount: number;
  observationSize: number;
  actionSize: number;
  controlHz: number;
  physicsTimestepSeconds: number;
  decimation: number;
  observationLayout: Array<{ name: string; size: number }>;
}

export interface Sim2RealArtifact extends ModelArtifactDescriptor {
  id: string;
  role: Sim2RealArtifactRole;
  /** Opaque logical reference; the server never fetches an arbitrary URL from it. */
  ref: string;
  sha256?: string;
  sizeBytes?: number;
}

export interface Sim2RealModelManifest {
  schemaVersion: typeof SIM2REAL_SCHEMA_VERSION;
  modelId: string;
  displayName: string;
  version: string;
  robot: {
    id: Sim2RealRobotId;
    variant: Sim2RealRobotVariant;
  };
  contract: Sim2RealContract;
  simulator: {
    backends: Sim2RealBackend[];
    policyArtifactId: string;
    policyBundle?: Sim2RealPolicyBundle;
    entryUrl?: string;
  };
  artifacts: Sim2RealArtifact[];
  metadata?: {
    source?: string;
    notes?: string;
  };
}

export interface Sim2RealValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  manifest?: Sim2RealModelManifest;
}

export interface Sim2RealCompatibilityView {
  platformId: string;
  status: ModelCompatibilityResult['status'];
  artifactId?: string;
  result: ModelCompatibilityResult;
  deployable: boolean;
  reason: string;
  artifactRuntime?: ModelArtifactRuntime;
  artifactWorkload?: ModelArtifactWorkload;
}

export type Sim2RealRunStatus = 'ready' | 'queued' | 'running' | 'completed' | 'blocked' | 'failed';

export interface Sim2RealRunRecord {
  id: string;
  modelId: string;
  /** Stable action-task id (walk/turn/sit/recover/kick/custom). */
  taskId?: string;
  backend: Sim2RealRunBackend;
  status: Sim2RealRunStatus;
  summary: string;
  launchUrl?: string;
  externalRunId?: string;
  /** True when a protocol-only worker, rather than a real trainer, answered. */
  mock?: boolean;
  training?: Sim2RealTrainingSpec;
  resumeFrom?: Sim2RealCheckpointRef;
  checkpoint?: Sim2RealCheckpointRef;
  artifact?: Sim2RealRunArtifactMetadata;
  metrics?: Sim2RealRunMetrics;
  /** Latest platform-side telemetry evaluation; raw samples stay in the ledger. */
  evaluation?: Sim2RealEvaluationSummary;
  createdAt: string;
  finishedAt?: string;
}

export type Sim2RealDeploymentMode = 'preflight' | 'canary' | 'live';
export type Sim2RealDeploymentStatus =
  | 'planned'
  | 'running'
  | 'ready'
  | 'blocked'
  | 'failed'
  | 'completed';
export type Sim2RealStepStatus = 'pending' | 'running' | 'completed' | 'blocked' | 'failed';

export interface Sim2RealDeploymentStep {
  id: string;
  label: string;
  status: Sim2RealStepStatus;
  detail?: string;
}

export interface Sim2RealDeploymentRecord {
  id: string;
  modelId: string;
  deviceId: string;
  targetPlatform: string;
  mode: Sim2RealDeploymentMode;
  status: Sim2RealDeploymentStatus;
  summary: string;
  compatibility: Sim2RealCompatibilityView;
  steps: Sim2RealDeploymentStep[];
  createdAt: string;
  updatedAt: string;
  executedAt?: string;
}

export interface Sim2RealDeviceSummary {
  id: string;
  name: string;
  status: string;
  boardPlatform?: string | null;
  boardModel?: string | null;
  connectionMode?: string;
  sshReachability?: string;
}

export interface Sim2RealRobogoIntegration {
  state: 'ready' | 'login_required' | 'unavailable';
  clusterQueried: boolean;
  devMachineQueried: boolean;
  availableBoardCount?: number;
  developmentMachineCount?: number;
  message: string;
}

export interface Sim2RealOverview {
  schemaVersion: typeof SIM2REAL_SCHEMA_VERSION;
  /** The authenticated account that owns the returned resources; null only in local-dev mode. */
  identity: { accountId: string; displayName?: string; email?: string } | null;
  /** Product registry is the handshake for clients that support both Duck contracts. */
  productProfiles: Sim2RealProductProfile[];
  /** Product selected by the caller; kept separate from the legacy default contract field. */
  selectedProductId: Sim2RealRobotId;
  /** Null means the selected product still requires a real manifest-defined contract. */
  selectedContract: Sim2RealContract | null;
  contract: Sim2RealContract;
  models: Array<Sim2RealModelRecord>;
  runs: Sim2RealRunRecord[];
  deployments: Sim2RealDeploymentRecord[];
  devices: Sim2RealDeviceSummary[];
  integrations: {
    simulator: {
      browser: { available: true; entryUrl: string };
      robogo: { available: boolean; reason: string };
      local: { available: boolean; reason: string; mock?: boolean };
    };
    robogo: Sim2RealRobogoIntegration;
    storage: {
      mode: 'local-server' | 'external-required';
      writable: boolean;
      message: string;
    };
  };
  supportedPlatforms: RdkPlatform[];
}

export interface Sim2RealModelRecord {
  id: string;
  manifest: Sim2RealModelManifest;
  builtin?: boolean;
  createdAt: string;
  updatedAt: string;
}

const ALLOWED_FORMATS = new Set<ModelArtifactFormat>([
  'pytorch',
  'onnx',
  'bin',
  'hbm',
  'gguf',
  'unknown',
]);
const ALLOWED_RUNTIMES = new Set<ModelArtifactRuntime>(['cpu-onnx', 'bpu']);
const ALLOWED_WORKLOADS = new Set<ModelArtifactWorkload>([
  'locomotion',
  'perception',
  'navigation',
  'speech',
  'multimodal',
]);
const ALLOWED_ROLES = new Set<Sim2RealArtifactRole>(['policy', 'compiled-policy', 'calibration']);
const ALLOWED_BACKENDS = new Set<Sim2RealBackend>(['browser', 'robogo', 'local']);
const ALLOWED_VARIANTS = new Set<Sim2RealRobotVariant>(['legs', 'rollers', 'both']);
const ALLOWED_ROBOT_IDS = new Set<Sim2RealRobotId>(['microduck', 'rdk-duck']);
const ALLOWED_TRAINING_PROFILES = new Set<Sim2RealTrainingProfile>([
  'smoke',
  'low-vram',
  'standard',
  'high-vram',
]);
const SAFE_ID = /^[a-z][a-z0-9-]{1,63}$/;
const SHA256 = /^[a-f0-9]{64}$/i;
const SENSITIVE_REF = /(?:password|passwd|secret|token|api[_-]?key|private[_-]?key)/i;

export const MICRODUCK_TRAINING_PROFILES: Readonly<
  Record<Sim2RealTrainingProfile, Sim2RealTrainingSpec>
> = Object.freeze({
  smoke: { profile: 'smoke', numEnvs: 64, maxIterations: 5, video: false },
  'low-vram': { profile: 'low-vram', numEnvs: 64, maxIterations: 100_000, video: false },
  standard: { profile: 'standard', numEnvs: 1024, maxIterations: 100_000, video: false },
  'high-vram': { profile: 'high-vram', numEnvs: 4096, maxIterations: 100_000, video: false },
});

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function safeText(value: unknown, maxLength: number): string {
  return typeof value === 'string'
    ? value
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .trim()
        .slice(0, maxLength)
    : '';
}

function positiveFinite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function safeKey(value: unknown): string {
  return typeof value === 'string'
    ? value
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .trim()
        .slice(0, 24)
    : '';
}

function normalizePolicyBundle(
  value: unknown,
  artifacts: readonly Sim2RealArtifact[],
  errors: string[],
): Sim2RealPolicyBundle | undefined {
  if (value == null) return undefined;
  const source = record(value);
  const defaultPolicyId = safeText(source.defaultPolicyId, 64).toLowerCase();
  const rawPolicies = Array.isArray(source.policies) ? source.policies.slice(0, 32) : [];
  if (!defaultPolicyId || rawPolicies.length === 0) {
    errors.push('simulator.policyBundle must include defaultPolicyId and at least one policy');
    return undefined;
  }
  const artifactIds = new Set(
    artifacts.filter((item) => item.role === 'policy').map((item) => item.id),
  );
  const ids = new Set<string>();
  const policies: Sim2RealPolicyBinding[] = [];
  for (const [index, item] of rawPolicies.entries()) {
    const policy = record(item);
    const id = safeText(policy.id, 64).toLowerCase();
    const label = safeText(policy.label, 120);
    const artifactId = safeText(policy.artifactId, 64);
    const keys = Array.isArray(policy.keys)
      ? policy.keys.slice(0, 8).map(safeKey).filter(Boolean)
      : [];
    if (!SAFE_ID.test(id)) errors.push(`simulator.policyBundle.policies[${index}].id is invalid`);
    if (!label) errors.push(`simulator.policyBundle.policies[${index}].label is required`);
    if (!artifactIds.has(artifactId)) {
      errors.push(
        `simulator.policyBundle.policies[${index}].artifactId must point to a policy artifact`,
      );
    }
    if (ids.has(id)) errors.push('simulator.policyBundle policy ids must be unique');
    ids.add(id);
    if (id && label && artifactId && artifactIds.has(artifactId)) {
      policies.push({
        id,
        label,
        artifactId,
        ...(keys.length ? { keys } : {}),
        ...(safeText(policy.description, 180)
          ? { description: safeText(policy.description, 180) }
          : {}),
      });
    }
  }
  if (!ids.has(defaultPolicyId))
    errors.push('simulator.policyBundle.defaultPolicyId must match a policy id');
  return policies.length ? { defaultPolicyId, policies } : undefined;
}

export function trainingSpecForProfile(profile: Sim2RealTrainingProfile): Sim2RealTrainingSpec {
  return { ...MICRODUCK_TRAINING_PROFILES[profile] };
}

export function normalizeTrainingSpec(value: unknown): {
  spec?: Sim2RealTrainingSpec;
  errors: string[];
} {
  const errors: string[] = [];
  if (value != null && (typeof value !== 'object' || Array.isArray(value))) {
    return { errors: ['training must be an object'] };
  }
  const source = record(value);
  const profile = safeText(source.profile, 24) as Sim2RealTrainingProfile;
  const selected = ALLOWED_TRAINING_PROFILES.has(profile) ? profile : 'standard';
  if (value != null && profile && !ALLOWED_TRAINING_PROFILES.has(profile)) {
    errors.push('training.profile must be smoke, low-vram, standard, or high-vram');
  }
  const defaults = trainingSpecForProfile(selected);
  const numEnvs = source.numEnvs == null ? defaults.numEnvs : Number(source.numEnvs);
  const maxIterations =
    source.maxIterations == null ? defaults.maxIterations : Number(source.maxIterations);
  const rawVideo = source.video == null ? defaults.video : source.video;
  if (!Number.isSafeInteger(numEnvs) || numEnvs < 1 || numEnvs > 16_384)
    errors.push('training.numEnvs must be an integer between 1 and 16384');
  if (!Number.isSafeInteger(maxIterations) || maxIterations < 1 || maxIterations > 2_000_000)
    errors.push('training.maxIterations must be an integer between 1 and 2000000');
  if (typeof rawVideo !== 'boolean') errors.push('training.video must be boolean');
  const runName = safeText(source.runName, 80);
  if (runName && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(runName))
    errors.push('training.runName contains unsupported characters');
  if (errors.length) return { errors };
  return {
    errors,
    spec: {
      profile: selected,
      numEnvs,
      maxIterations,
      video: rawVideo as boolean,
      ...(runName ? { runName } : {}),
    },
  };
}

function exactNumber(value: unknown, expected: number, label: string, errors: string[]): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed !== expected) {
    errors.push(`${label} must be exactly ${expected}`);
    return expected;
  }
  return parsed;
}

function positiveNumber(value: unknown, label: string, errors: string[]): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    errors.push(`${label} must be a positive number`);
    return 1;
  }
  return parsed;
}

function positiveInteger(value: unknown, label: string, errors: string[]): number {
  const parsed = positiveNumber(value, label, errors);
  if (!Number.isSafeInteger(parsed)) {
    errors.push(`${label} must be a positive integer`);
    return Math.max(1, Math.floor(parsed));
  }
  return parsed;
}

function normalizeLayout(
  value: unknown,
  errors: string[],
  expected?: readonly { name: string; size: number }[],
): Array<{ name: string; size: number }> {
  if (!Array.isArray(value)) {
    errors.push('contract.observationLayout is required');
    return expected?.map((item) => ({ ...item })) || [];
  }
  const layout = value.slice(0, 16).map((item) => {
    const source = record(item);
    const name = safeText(source.name, 64);
    const size = positiveFinite(source.size);
    if (!name) errors.push('contract.observationLayout item name is required');
    if (!size || !Number.isSafeInteger(size)) {
      errors.push('contract.observationLayout item size must be a positive integer');
    }
    return { name, size: size ? Math.floor(size) : 0 };
  });
  if (expected) {
    if (
      layout.length !== expected.length ||
      layout.some(
        (item, index) => item.name !== expected[index]?.name || item.size !== expected[index]?.size,
      )
    ) {
      errors.push('contract.observationLayout does not match the MicroDuck policy contract');
    }
  }
  return layout;
}

function normalizeArtifact(
  value: unknown,
  index: number,
  errors: string[],
  warnings: string[],
): Sim2RealArtifact | null {
  const source = record(value);
  const id = safeText(source.id, 64);
  const name = safeText(source.name, 180);
  const ref = safeText(source.ref, 500);
  const role = safeText(source.role, 32) as Sim2RealArtifactRole;
  const format = safeText(source.format, 16) as ModelArtifactFormat;
  const kind = source.kind === 'source' || source.kind === 'compiled' ? source.kind : '';
  const runtime = safeText(source.runtime, 24) as ModelArtifactRuntime;
  const workload = safeText(source.workload, 24) as ModelArtifactWorkload;
  if (!id || !/^[a-z][a-z0-9._-]{1,63}$/i.test(id))
    errors.push(`artifacts[${index}].id is invalid`);
  if (!name) errors.push(`artifacts[${index}].name is required`);
  if (!ref) errors.push(`artifacts[${index}].ref is required`);
  if (
    ref &&
    (ref.includes('..') ||
      /[\u0000\r\n]/.test(ref) ||
      SENSITIVE_REF.test(ref) ||
      /^(?:javascript|data|file):/i.test(ref))
  ) {
    errors.push(`artifacts[${index}].ref contains a forbidden path or credential pattern`);
  }
  if (!ALLOWED_ROLES.has(role)) errors.push(`artifacts[${index}].role is invalid`);
  if (!ALLOWED_FORMATS.has(format)) errors.push(`artifacts[${index}].format is invalid`);
  if (runtime && !ALLOWED_RUNTIMES.has(runtime))
    errors.push(`artifacts[${index}].runtime is invalid`);
  if (workload && !ALLOWED_WORKLOADS.has(workload))
    errors.push(`artifacts[${index}].workload is invalid`);
  if (!kind) errors.push(`artifacts[${index}].kind must be source or compiled`);
  if (role === 'policy' && format !== 'onnx') {
    errors.push(`artifacts[${index}] policy artifacts must use ONNX`);
  }
  if (role === 'compiled-policy' && kind !== 'compiled') {
    errors.push(`artifacts[${index}] compiled-policy must be a compiled artifact`);
  }
  if (runtime === 'cpu-onnx') {
    if (format !== 'onnx') errors.push(`artifacts[${index}] cpu-onnx runtime requires ONNX`);
    if (workload !== 'locomotion') {
      errors.push(`artifacts[${index}] cpu-onnx runtime is only enabled for locomotion policies`);
    }
  }
  const targetPlatforms = Array.isArray(source.targetPlatforms)
    ? source.targetPlatforms
        .slice(0, 12)
        .map((item) => safeText(item, 80))
        .filter(Boolean)
    : [];
  const sha256 = safeText(source.sha256, 64).toLowerCase();
  if (sha256 && !SHA256.test(sha256)) errors.push(`artifacts[${index}].sha256 is invalid`);
  const rawSize = source.sizeBytes;
  const sizeBytes = rawSize == null ? undefined : positiveFinite(rawSize);
  if (rawSize != null && (sizeBytes === null || !Number.isSafeInteger(sizeBytes))) {
    errors.push(`artifacts[${index}].sizeBytes is invalid`);
  }
  const rawThreads = source.threads;
  const threads = rawThreads == null ? undefined : positiveFinite(rawThreads);
  if (
    rawThreads != null &&
    (typeof threads !== 'number' || !Number.isSafeInteger(threads) || threads > 128)
  ) {
    errors.push(`artifacts[${index}].threads is invalid`);
  }
  if (runtime === 'cpu-onnx' && threads !== 1) {
    errors.push(`artifacts[${index}] cpu-onnx locomotion must set threads to 1`);
  }
  if (role === 'compiled-policy' && targetPlatforms.length === 0) {
    const artifactLabel = id || `artifacts[${index}]`;
    warnings.push(`${artifactLabel} has no exact board target; deployment will require validation`);
  }
  if (!id || !name || !ref || !kind) return null;
  return {
    id,
    role,
    name,
    kind,
    format,
    ref,
    ...(targetPlatforms.length ? { targetPlatforms } : {}),
    ...(safeText(source.acceleratorArchitecture, 80)
      ? { acceleratorArchitecture: safeText(source.acceleratorArchitecture, 80) }
      : {}),
    ...(safeText(source.toolchainTarget, 120)
      ? { toolchainTarget: safeText(source.toolchainTarget, 120) }
      : {}),
    ...(safeText(source.runtimePackage, 160)
      ? { runtimePackage: safeText(source.runtimePackage, 160) }
      : {}),
    ...(runtime && ALLOWED_RUNTIMES.has(runtime) ? { runtime } : {}),
    ...(workload && ALLOWED_WORKLOADS.has(workload) ? { workload } : {}),
    ...(typeof threads === 'number' ? { threads: Math.floor(threads) } : {}),
    ...(sha256 ? { sha256 } : {}),
    ...(typeof sizeBytes === 'number' ? { sizeBytes: Math.floor(sizeBytes) } : {}),
  };
}

/** Validate and normalize a package manifest in any runtime. */
export function validateSim2RealManifest(input: unknown): Sim2RealValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const source = record(input);
  const schemaVersion = Number(source.schemaVersion);
  if (schemaVersion !== SIM2REAL_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${SIM2REAL_SCHEMA_VERSION}`);
  }
  const modelId = safeText(source.modelId, 64).toLowerCase();
  const displayName = safeText(source.displayName, 120);
  const version = safeText(source.version, 64);
  if (!SAFE_ID.test(modelId)) errors.push('modelId must be a lowercase slug (2–64 characters)');
  if (!displayName) errors.push('displayName is required');
  if (!version) errors.push('version is required');

  const robot = record(source.robot);
  const robotId = safeText(robot.id, 40);
  const variant = safeText(robot.variant, 16) as Sim2RealRobotVariant;
  if (!ALLOWED_ROBOT_IDS.has(robotId as Sim2RealRobotId)) {
    errors.push('robot.id must be microduck or rdk-duck');
  }
  if (robotId === 'microduck' && !ALLOWED_VARIANTS.has(variant)) {
    errors.push('robot.variant must be legs, rollers, or both for microduck');
  }
  if (robotId === 'rdk-duck' && !SAFE_ID.test(variant)) {
    errors.push('robot.variant must be a lowercase slug for rdk-duck');
  }

  const contract = record(source.contract);
  const productId = ALLOWED_ROBOT_IDS.has(robotId as Sim2RealRobotId)
    ? (robotId as Sim2RealRobotId)
    : 'microduck';
  const profile = SIM2REAL_PRODUCT_PROFILES[productId];
  const contractId = safeText(contract.id, 80) || profile.contractId || `${productId}-policy-v1`;
  const contractRobotId = safeText(contract.robotId, 40);
  const isFixedMicroDuck = productId === 'microduck';
  const normalizedContract: Sim2RealContract = {
    id: contractId,
    robotId: productId,
    jointCount: isFixedMicroDuck
      ? exactNumber(contract.jointCount, 14, 'contract.jointCount', errors)
      : positiveInteger(contract.jointCount, 'contract.jointCount', errors),
    observationSize: isFixedMicroDuck
      ? exactNumber(contract.observationSize, 61, 'contract.observationSize', errors)
      : positiveInteger(contract.observationSize, 'contract.observationSize', errors),
    actionSize: isFixedMicroDuck
      ? exactNumber(contract.actionSize, 14, 'contract.actionSize', errors)
      : positiveInteger(contract.actionSize, 'contract.actionSize', errors),
    controlHz: isFixedMicroDuck
      ? exactNumber(contract.controlHz, 50, 'contract.controlHz', errors)
      : positiveInteger(contract.controlHz, 'contract.controlHz', errors),
    physicsTimestepSeconds: isFixedMicroDuck
      ? exactNumber(
          contract.physicsTimestepSeconds,
          0.005,
          'contract.physicsTimestepSeconds',
          errors,
        )
      : positiveNumber(contract.physicsTimestepSeconds, 'contract.physicsTimestepSeconds', errors),
    decimation: isFixedMicroDuck
      ? exactNumber(contract.decimation, 4, 'contract.decimation', errors)
      : positiveInteger(contract.decimation, 'contract.decimation', errors),
    observationLayout: normalizeLayout(
      contract.observationLayout,
      errors,
      isFixedMicroDuck ? MICRODUCK_OBSERVATION_LAYOUT : undefined,
    ),
  };
  if (isFixedMicroDuck && normalizedContract.id !== MICRODUCK_SIM2REAL_CONTRACT_ID) {
    errors.push(`contract.id must be ${MICRODUCK_SIM2REAL_CONTRACT_ID}`);
  }
  if (contractRobotId !== productId) {
    errors.push(`contract.robotId must match robot.id (${productId})`);
  }
  if (!isFixedMicroDuck && !contractId.startsWith(profile.contractIdPrefix || '')) {
    errors.push(`contract.id must start with ${profile.contractIdPrefix}`);
  }
  if (!isFixedMicroDuck) {
    const layoutTotal = normalizedContract.observationLayout.reduce(
      (sum, item) => sum + item.size,
      0,
    );
    if (layoutTotal !== normalizedContract.observationSize) {
      errors.push('contract.observationLayout sizes must add up to contract.observationSize');
    }
  }

  const simulator = record(source.simulator);
  const rawBackends = Array.isArray(simulator.backends)
    ? simulator.backends.slice(0, 8).map((item) => safeText(item, 16))
    : [];
  const backends = rawBackends.filter((item): item is Sim2RealBackend =>
    ALLOWED_BACKENDS.has(item as Sim2RealBackend),
  );
  if (rawBackends.some((item) => !ALLOWED_BACKENDS.has(item as Sim2RealBackend))) {
    errors.push('simulator.backends contains an unsupported backend');
  }
  if (backends.length === 0)
    errors.push('simulator.backends must include browser, local, or robogo');
  const policyArtifactId = safeText(simulator.policyArtifactId, 64);
  if (!policyArtifactId) errors.push('simulator.policyArtifactId is required');
  const artifacts: Sim2RealArtifact[] = [];
  if (!Array.isArray(source.artifacts) || source.artifacts.length === 0) {
    errors.push('artifacts must contain at least one policy artifact');
  } else {
    if (source.artifacts.length > 32) errors.push('artifacts must contain at most 32 entries');
    for (const [index, item] of source.artifacts.slice(0, 32).entries()) {
      const normalized = normalizeArtifact(item, index, errors, warnings);
      if (normalized) artifacts.push(normalized);
    }
  }
  if (new Set(artifacts.map((item) => item.id)).size !== artifacts.length) {
    errors.push('artifact ids must be unique');
  }
  const policy = artifacts.find((item) => item.id === policyArtifactId);
  if (!policy || policy.role !== 'policy' || policy.format !== 'onnx') {
    errors.push('simulator.policyArtifactId must point to an ONNX policy artifact');
  }
  const policyBundle = normalizePolicyBundle(simulator.policyBundle, artifacts, errors);
  const cpuOnnxLocomotion =
    policy?.runtime === 'cpu-onnx' && policy.workload === 'locomotion' && policy.threads === 1;
  if (!artifacts.some((item) => item.role === 'compiled-policy')) {
    warnings.push(
      cpuOnnxLocomotion
        ? 'no compiled-policy artifact is registered; locomotion can use CPU ONNX single-thread, while perception still needs a BPU artifact'
        : 'no compiled-policy artifact is registered; board deployment will require conversion',
    );
  }
  if (!backends.includes('browser')) {
    warnings.push('browser simulation is not enabled for this manifest');
  }

  const sourceMetadata = record(source.metadata);
  const entryUrl = safeText(simulator.entryUrl, 300);
  if (entryUrl && (!entryUrl.startsWith('/') || entryUrl.startsWith('//'))) {
    errors.push('simulator.entryUrl must be a same-origin absolute path');
  }
  const normalized: Sim2RealModelManifest = {
    schemaVersion: SIM2REAL_SCHEMA_VERSION,
    modelId,
    displayName,
    version,
    robot: {
      id: productId,
      variant: variant || (productId === 'microduck' ? 'legs' : 'x5-kit'),
    },
    contract: normalizedContract,
    simulator: {
      backends,
      policyArtifactId,
      ...(policyBundle ? { policyBundle } : {}),
      ...(entryUrl && entryUrl.startsWith('/') && !entryUrl.startsWith('//') ? { entryUrl } : {}),
    },
    artifacts,
    ...(safeText(sourceMetadata.source, 300) || safeText(sourceMetadata.notes, 500)
      ? {
          metadata: {
            ...(safeText(sourceMetadata.source, 300)
              ? { source: safeText(sourceMetadata.source, 300) }
              : {}),
            ...(safeText(sourceMetadata.notes, 500)
              ? { notes: safeText(sourceMetadata.notes, 500) }
              : {}),
          },
        }
      : {}),
  };
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    ...(errors.length === 0 ? { manifest: normalized } : {}),
  };
}

export const BUILTIN_MICRODUCK_MODEL: Sim2RealModelRecord = {
  id: 'builtin-microduck-official',
  builtin: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  manifest: {
    schemaVersion: SIM2REAL_SCHEMA_VERSION,
    modelId: 'microduck-official',
    displayName: 'MicroDuck 官方步行策略',
    version: 'upstream-browser',
    robot: { id: 'microduck', variant: 'legs' },
    contract: {
      id: MICRODUCK_SIM2REAL_CONTRACT_ID,
      robotId: 'microduck',
      jointCount: 14,
      observationSize: 61,
      actionSize: 14,
      controlHz: 50,
      physicsTimestepSeconds: 0.005,
      decimation: 4,
      observationLayout: MICRODUCK_OBSERVATION_LAYOUT.map((item) => ({ ...item })),
    },
    simulator: {
      // The bundled policy can be used as the starting contract for a local
      // training run.  RoboGo remains opt-in through an explicitly registered
      // manifest rather than being enabled for the built-in reference.
      backends: ['browser', 'local'],
      policyArtifactId: 'official-walking-policy',
      policyBundle: {
        defaultPolicyId: 'walking',
        policies: [
          {
            id: 'walking',
            label: '行走',
            artifactId: 'official-walking-policy',
            keys: ['ArrowUp', 'ArrowDown', 'A', 'E', 'Space'],
            description: '方向键前进/后退，A/E 左右转，Space 清零指令',
          },
        ],
      },
      entryUrl: '/mujoco/microduck/',
    },
    artifacts: [
      {
        id: 'official-walking-policy',
        role: 'policy',
        name: 'BEST_alpha_walking.onnx',
        kind: 'source',
        format: 'onnx',
        ref: '/mujoco/microduck/policies/BEST_alpha_walking.onnx',
      },
    ],
    metadata: {
      source: 'Pollen Robotics MicroDuck public simulator',
      notes:
        'Built-in reference only; user policy switching is gated by the manifest and artifact checks.',
    },
  },
};
