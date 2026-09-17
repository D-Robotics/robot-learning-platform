import type {
  ModelArtifactDescriptor,
  ModelArtifactKind,
  ModelArtifactFormat,
  ModelArtifactRuntime,
  ModelArtifactWorkload,
  ModelCompatibilityResult,
} from './model-artifacts.js';
import type { RdkPlatform } from './board-types.js';
import type {
  Sim2RealEvaluationSummary,
  Sim2RealRunArtifactMetadata,
  Sim2RealRunMetrics,
  Sim2RealRunProgressPoint,
  Sim2RealTaskEvaluationEvidence,
} from './sim2real-telemetry.js';

export type {
  Sim2RealEvaluationSummary,
  Sim2RealReplaySummary,
  Sim2RealRunArtifactMetadata,
  Sim2RealRunMetrics,
  Sim2RealRunProgressPoint,
  Sim2RealTaskEvaluationEnvelope,
  Sim2RealTaskEvaluationEvidence,
  Sim2RealActionOutput,
  Sim2RealTelemetryActionScale,
  Sim2RealTelemetryBoardSessionEvent,
  Sim2RealTelemetryBoardSessionEventKind,
  Sim2RealBoardSessionSummary,
  Sim2RealTelemetryRecord,
  Sim2RealTelemetrySample,
  Sim2RealTelemetrySource,
  Sim2RealTelemetryTwist,
} from './sim2real-telemetry.js';

export const SIM2REAL_SCHEMA_VERSION = 1 as const;
export const MICRODUCK_SIM2REAL_CONTRACT_ID = 'microduck-policy-v1' as const;

/**
 * The 61D MicroDuck observation contract, in slot order.
 *
 * Frozen at runtime, not just `as const`: `as const` is a compile-time promise,
 * and this object is the contract every policy in the family is hot-swappable
 * against. A runtime mutation (a test helper editing slots, a migration writing
 * through the export) would silently rebind every consumer to a different
 * layout — the exact failure mode the reference training repository guards by
 * declaring that a slot is never deleted, only zero-padded.
 */
export const MICRODUCK_OBSERVATION_LAYOUT: readonly Sim2RealObservationLayoutItem[] = Object.freeze(
  [
    { name: 'gyro', size: 3 },
    { name: 'projected_gravity', size: 3 },
    { name: 'joint_position_error', size: 14 },
    { name: 'joint_velocity', size: 14 },
    { name: 'last_action', size: 14 },
    { name: 'command', size: 13 },
  ].map((item) => Object.freeze(item)),
);

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

/**
 * Safety bounds for manifest-defined contracts.  The MicroDuck contract is
 * fixed above; these limits apply to the extensible RDK Duck contract so a
 * syntactically valid manifest cannot make a worker allocate unbounded
 * tensors or enter an impractical control loop.
 */
export const SIM2REAL_CONTRACT_LIMITS = Object.freeze({
  maxJointCount: 256,
  maxObservationSize: 4096,
  maxActionSize: 4096,
  maxControlHz: 1_000,
  minPhysicsTimestepSeconds: 0.000001,
  maxPhysicsTimestepSeconds: 1,
  maxDecimation: 256,
  maxObservationLayoutEntries: 16,
  maxObservationLayoutItemSize: 4096,
  // Image slots are declared by shape rather than by raw length. These bounds
  // keep a syntactically valid manifest from asking a board runtime to
  // allocate an unbounded frame buffer.
  maxObservationImageChannels: 4,
  maxObservationImageHeight: 1_080,
  maxObservationImageWidth: 1_920,
  // Image elements are budgeted separately from the 4096-element flat vector
  // budget: no realistic camera frame fits in 4096, so sharing one number would
  // mean either rejecting every real frame or raising a safety cap designed for
  // flat vectors. A full-HD RGBA frame is the largest accepted single frame.
  maxObservationImageElements: 4 * 1_080 * 1_920,
});

/** Product lines share a workflow, not a policy contract. */
export type Sim2RealRobotId = 'microduck' | 'rdk-duck' | 'originbot';

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
    originbot: {
      id: 'originbot',
      displayName: 'OriginBot',
      contractMode: 'manifest-defined',
      contractIdPrefix: 'originbot-policy-',
      targetPlatforms: ['rdk-x5'],
      accessories: ['imu', 'odom', 'battery', 'camera'],
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

/**
 * User-facing simulator controls are intentionally separate from policy
 * artifacts.  A key can trigger a runtime/UI action (for example quack or
 * reset) even when no ONNX policy is involved.  Keeping this map in the
 * manifest gives the browser, training workspace and future clients one
 * canonical source for the controls actually exposed by a release.
 */
export interface Sim2RealControlBinding {
  id: string;
  label: string;
  keys?: string[];
  description?: string;
  source?: 'keyboard' | 'touch' | 'gamepad' | 'ui';
}

/**
 * On-policy vs off-policy learner for the local starter engine. The spec is
 * an allowlist, not a free string: a typo degrades to a 400 at submission
 * time instead of silently training with PPO.
 */
export type Sim2RealTrainingAlgorithm = 'ppo' | 'sac';

/**
 * Worker-side engine routing. 'starter-ppo' is the CPU-friendly kinematic
 * pipeline; 'mjx-ppo' runs the MuJoCo MJX contact-dynamics engine;
 * 'microduck-rl' routes to the upstream `pollen-robotics/microduck_rl` stack
 * (mjlab + MuJoCo Warp + rsl-rl PPO) on a CUDA worker. Task packs may
 * recommend an engine, an explicit submission always wins, and a worker that
 * has not registered the engine fails closed instead of silently training
 * with a different physics backend.
 */
export type Sim2RealTrainingEngine = 'starter-ppo' | 'mjx-ppo' | 'microduck-rl';

export interface Sim2RealTrainingSpec {
  profile: Sim2RealTrainingProfile;
  numEnvs: number;
  maxIterations: number;
  video: boolean;
  runName?: string;
  /** Learner class; engines default to 'ppo' when omitted. */
  algorithm?: Sim2RealTrainingAlgorithm;
  /** Engine the worker must route to; omitted keeps the platform default. */
  engine?: Sim2RealTrainingEngine;
}

export interface Sim2RealCheckpointRef {
  checkpointId: string;
  artifactRef: string;
  iteration?: number;
}

/**
 * One declared observation slot.
 *
 * `size` is always the flat element count of the slot: for a vector slot that
 * is its width, and for an image slot it is `channels * height * width`, with
 * the shape carried alongside for consumers that need to reshape the frame.
 *
 * Budgeting: `observationSize` is the policy's flat VECTOR input width, so only
 * vector slots are summed against it (see the invariant in
 * `validateSim2RealManifest`). An image slot is bounded by its declared shape
 * instead, because a single realistic camera frame is already several times the
 * 4096-element flat budget. A vector slot is therefore still exactly
 * `{ name, size }` and every pre-existing contract keeps its exact meaning.
 */
export type Sim2RealObservationLayoutItem =
  | { name: string; size: number }
  | {
      name: string;
      size: number;
      modality: 'image';
      channels: number;
      height: number;
      width: number;
    };

/**
 * ONNX graph tensor names for the logical policy inputs this contract declares.
 *
 * Opt-in: when absent, the historical rank-based binding applies. Declaring
 * names turns "the observation is whichever rank-2 input comes first" into a
 * statement that can be checked against the exported graph, so a model whose
 * input order changed is refused by the gate instead of being fed the wrong
 * tensor. Roles a contract does not use stay undeclared.
 */
export interface Sim2RealPolicyInputs {
  /** Rank-2 `[batch, observationSize]` vector input. */
  observation?: string;
  /** Rank-4 vision input, bound by name *and* layout (`channels-last`). */
  image?: string;
  /**
   * Rank-3 recurrent state inputs in feed order, paired 1:1 with `outputs`.
   * Named `stateInputs`/`stateOutputs` to match the policy contract already used
   * by the `microduck-eval` harness (`Policy.state_input_names`), so one naming
   * scheme covers the trainer, the evaluator and the board.
   */
  stateInputs?: string[];
  /** Rank-3 recurrent state outputs, paired 1:1 with `stateInputs`. */
  stateOutputs?: string[];
}

/**
 * Recurrent state contract.
 *
 * An undeclared state block means feed-forward, and a graph that exposes state
 * tensors is then a mismatch: silently running such a policy with zeroed history
 * on every step produces plausible-looking but wrong actions, which is worse
 * than refusing to load it.
 */
export interface Sim2RealPolicyState {
  kind: 'lstm' | 'gru';
  layers: number;
  hiddenSize: number;
  /**
   * When the carried state must be zeroed. `on-activation` mirrors the released
   * MicroDuck recurrent contract (zero on activation, policy switch and
   * recovery/reset boundaries; retain across ordinary command changes).
   */
  reset: 'on-activation';
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
  observationLayout: Sim2RealObservationLayoutItem[];
  inputs?: Sim2RealPolicyInputs;
  state?: Sim2RealPolicyState;
  /** Explicit adapter identities keep simulator, trainer and board wiring aligned. */
  observationAdapterId?: string;
  actionAdapterId?: string;
  actionOutput?: 'physical-twist' | 'normalized-twist';
  actionScale?: { linear: number; angular: number; units?: 'm/s,rad/s' };
  calibrationId?: string;
  schemaHash?: string;
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
    controls?: Sim2RealControlBinding[];
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
  computeResourceId?: string;
  /** Optional project context for experiment history and comparison. */
  projectId?: string;
  /** Dataset snapshots consumed by this run (immutable ids). */
  datasetIds?: string[];
  /** First-class registry artifact ids produced or selected by this run. */
  artifactIds?: string[];
  /** Latest first-class evaluation associated with this run. */
  evaluationId?: string;
  /** Content identity of the telemetry snapshot used by the latest evaluation. */
  telemetryRevision?: string;
  /** Stable user-defined experiment group used to compare runs. */
  experimentId?: string;
  label?: string;
  /**
   * Denormalized API identity.  Older ledger rows may omit these fields; the
   * HTTP layer derives them from the referenced model manifest before
   * returning a response.  Keeping the fields optional preserves ledger
   * compatibility while making product/contract provenance explicit to new
   * clients.
   */
  productId?: Sim2RealRobotId;
  contractId?: string;
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
  /** Live curve points reported while the run was executing (worker-parsed). */
  progress?: Sim2RealRunProgressPoint[];
  /** Sanitized Task-Pack eval report used by the server-side release gate. */
  taskEvaluation?: Sim2RealTaskEvaluationEvidence;
  /** Latest platform-side telemetry evaluation; raw samples stay in the ledger. */
  evaluation?: Sim2RealEvaluationSummary;
  createdAt: string;
  finishedAt?: string;
}

export interface Sim2RealDatasetRecord {
  id: string;
  name: string;
  /** Immutable logical version supplied by the collector or exporter. */
  version?: string;
  description?: string;
  uri?: string;
  format?: string;
  /** Digest of the dataset payload when it is stored outside the ledger. */
  sha256?: string;
  /** Contract and run lineage make training/evaluation reproducible. */
  contractId?: string;
  sourceRunId?: string;
  sampleCount?: number;
  sizeBytes?: number;
  tags?: string[];
  /** Lifecycle state; legacy rows without this field are treated as ready. */
  status?: Sim2RealDatasetStatus;
  createdAt: string;
  updatedAt: string;
}

export type Sim2RealDatasetStatus = 'registered' | 'ready' | 'revoked';

/**
 * A durable artifact registry row.  Model-manifest artifacts remain useful
 * for compatibility, while this record is the immutable release unit that a
 * deployment can point at.  Once published, metadata is append-only; only a
 * revocation marker may be added.
 */
export type Sim2RealArtifactLifecycleStatus = 'draft' | 'validated' | 'published' | 'revoked';

export interface Sim2RealArtifactRecord {
  id: string;
  /** Stable logical artifact name, e.g. `originbot-goal-policy`. */
  artifactId: string;
  /** Immutable producer version; `latest` is intentionally disallowed. */
  version: string;
  name: string;
  role: Sim2RealArtifactRole;
  kind: ModelArtifactKind;
  format: ModelArtifactFormat;
  runtime?: ModelArtifactRuntime;
  workload?: ModelArtifactWorkload;
  threads?: number;
  targetPlatforms?: string[];
  toolchainTarget?: string;
  acceleratorArchitecture?: string;
  runtimePackage?: string;
  /** Opaque managed-store handle; local paths and URLs are rejected. */
  ref: string;
  /** Published artifacts must always carry a content digest. */
  sha256: string;
  sizeBytes?: number;
  modelId?: string;
  runId?: string;
  datasetIds: string[];
  evaluationIds: string[];
  contractId?: string;
  status: Sim2RealArtifactLifecycleStatus;
  metadata?: Record<string, string | number | boolean | null>;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  revokedAt?: string;
  revocationReason?: string;
}

export type Sim2RealEvaluationStatus = 'pending' | 'running' | 'passed' | 'failed' | 'invalid';

/** First-class evaluation evidence linked to a run and optional artifact. */
export interface Sim2RealEvaluationRecord {
  id: string;
  runId: string;
  modelId: string;
  artifactId?: string;
  datasetIds: string[];
  projectId?: string;
  taskId?: string;
  status: Sim2RealEvaluationStatus;
  summary: string;
  report?: Sim2RealEvaluationSummary;
  taskEvaluation?: Sim2RealTaskEvaluationEvidence;
  source: 'platform' | 'runner' | 'import';
  /** Server-derived attestation marker; client supplied values are ignored. */
  attested?: boolean;
  /** Content identity of the telemetry snapshot used to compute this result. */
  telemetryRevision?: string;
  /** Set by the ingest boundary when newer telemetry supersedes this result. */
  stale?: boolean;
  staleAt?: string;
  staleReason?: string;
  deviceId?: string;
  contractId?: string;
  seed?: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface Sim2RealProjectRecord {
  id: string;
  name: string;
  slug: string;
  description?: string;
  modelIds: string[];
  datasetIds: string[];
  createdAt: string;
  updatedAt: string;
}

export type Sim2RealDeploymentMode = 'preflight' | 'canary' | 'live';
export type Sim2RealDeploymentStatus =
  'planned' | 'running' | 'ready' | 'blocked' | 'failed' | 'completed' | 'cancelled';
export type Sim2RealStepStatus = 'pending' | 'running' | 'completed' | 'blocked' | 'failed';

export interface Sim2RealDeploymentStep {
  id: string;
  label: string;
  status: Sim2RealStepStatus;
  detail?: string;
}

export type Sim2RealDeploymentEventType =
  | 'created'
  | 'status_changed'
  | 'preflight'
  | 'cancelled'
  | 'version_switched'
  | 'approval_approved'
  | 'approval_rejected'
  | 'updated';

export type Sim2RealDeploymentApprovalStatus = 'pending' | 'approved' | 'rejected';

/** Human authorization recorded before a canary/live executor may act. */
export interface Sim2RealDeploymentApproval {
  status: Sim2RealDeploymentApprovalStatus;
  requestedAt: string;
  requestedBy?: string;
  decidedAt?: string;
  decidedBy?: string;
  note?: string;
}

/** Append-only lifecycle evidence kept with a deployment plan. */
export interface Sim2RealDeploymentHistoryEvent {
  id: string;
  type: Sim2RealDeploymentEventType;
  status: Sim2RealDeploymentStatus;
  summary: string;
  createdAt: string;
}

export interface Sim2RealDeploymentVerification {
  passed: boolean;
  checkedAt: string;
  checks?: Record<string, string | number | null>;
  /** True when a protocol-only mock answered; never counts as hardware evidence. */
  mock?: boolean;
}

export interface Sim2RealDeploymentRecord {
  id: string;
  modelId: string;
  /** Training run whose artifact and measurements authorize canary/live planning. */
  runId?: string;
  /** Immutable registry artifact authorized by the release gate. */
  artifactId?: string;
  /** First-class evaluation evidence used for canary/live planning. */
  evaluationId?: string;
  deviceId: string;
  targetPlatform: string;
  mode: Sim2RealDeploymentMode;
  status: Sim2RealDeploymentStatus;
  summary: string;
  compatibility: Sim2RealCompatibilityView;
  steps: Sim2RealDeploymentStep[];
  history?: Sim2RealDeploymentHistoryEvent[];
  /** Explicit human gate for canary/live execution. */
  approval?: Sim2RealDeploymentApproval;
  verification?: Sim2RealDeploymentVerification;
  releaseGate?: {
    passed: boolean;
    checkedAt: string;
    runId?: string;
    taskId?: string;
    errors: string[];
    checks: Record<string, boolean | string | number | null>;
  };
  /** Set when this plan was created to switch from another model version. */
  versionSwitchFrom?: string;
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

/**
 * Runtime health for the administrator-owned local training worker.
 *
 * `available` means configured; `reachable` and `healthy` come from the
 * worker's bounded health probe.  Queue counters are deliberately aggregate
 * only and never include request payloads, paths, or credentials.
 */
export interface Sim2RealLocalWorkerIntegration {
  available: boolean;
  reachable: boolean;
  healthy: boolean;
  configured?: boolean;
  mock?: boolean;
  maxConcurrentJobs?: number;
  activeJobs?: number;
  queuedJobs?: number;
  responseMs?: number;
  /**
   * Engine ids the worker registered (healthz `engines`), e.g.
   * ['default', 'mjx-ppo']. Absent when the worker did not report them; the
   * 'default' entry maps to the base RDK_SIM2REAL_TRAIN_EXECUTABLE engine.
   */
  engines?: string[];
  /** Legacy/configuration detail retained for clients that predate health probes. */
  reason?: string;
  message: string;
}

/** A user-owned training endpoint registered in the workspace. */
export interface Sim2RealComputeResource {
  id: string;
  name: string;
  kind: 'local-gpu';
  runnerUrl: string;
  tokenConfigured: boolean;
  status: 'online' | 'offline' | 'unknown';
  gpuName?: string;
  cuda?: boolean;
  vramMb?: number;
  maxConcurrentJobs?: number;
  message?: string;
  lastCheckedAt?: string;
  createdAt: string;
  updatedAt: string;
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
  /**
   * Every contract currently visible to this account, grouped by product.
   * Unlike the legacy `contract` field below, this list never substitutes the
   * fixed MicroDuck dimensions for an RDK Duck manifest-defined contract.
   */
  availableContracts: Sim2RealAvailableContract[];
  contracts: Record<Sim2RealRobotId, Sim2RealAvailableContract[]>;
  /** Legacy MicroDuck default retained for old clients; use selectedContract or
   * availableContracts for product-aware integrations. */
  contract: Sim2RealContract;
  models: Array<Sim2RealModelRecord>;
  runs: Sim2RealRunRecord[];
  deployments: Sim2RealDeploymentRecord[];
  /**
   * First-class registry artifacts feeding the promotion-flow view
   * (candidate → validated → published). Capped at 100 newest.
   */
  artifacts: Sim2RealArtifactRecord[];
  /** First-class evaluation evidence records (passed gate ⇒ promotable). */
  evaluations: Sim2RealEvaluationRecord[];
  devices: Sim2RealDeviceSummary[];
  integrations: {
    simulator: {
      browser: {
        available: boolean;
        entryUrl: string;
        state?: 'mounted' | 'redirect' | 'missing';
        reason?: string;
      };
      boardAgent: { available: boolean; reason: string };
      robogo: { available: boolean; reason: string };
      local: Sim2RealLocalWorkerIntegration;
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
  /** See Sim2RealRunRecord.productId/contractId; derived for API responses. */
  productId?: Sim2RealRobotId;
  contractId?: string;
  builtin?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Sim2RealAvailableContract {
  productId: Sim2RealRobotId;
  contractId: string;
  contract: Sim2RealContract;
  /** Model record ids that currently expose this contract to the account. */
  modelIds: string[];
  source: 'builtin' | 'manifest';
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
const ALLOWED_ROBOT_IDS = new Set<Sim2RealRobotId>(['microduck', 'rdk-duck', 'originbot']);
const ALLOWED_TRAINING_PROFILES = new Set<Sim2RealTrainingProfile>([
  'smoke',
  'low-vram',
  'standard',
  'high-vram',
]);
const ALLOWED_TRAINING_ENGINES = new Set<Sim2RealTrainingEngine>([
  'starter-ppo',
  'mjx-ppo',
  'microduck-rl',
]);
const SAFE_ID = /^[a-z][a-z0-9-]{1,63}$/;
const SHA256 = /^[a-f0-9]{64}$/i;
const SENSITIVE_REF = /(?:password|passwd|secret|token|api[_-]?key|private[_-]?key)/i;
/** Opaque artifact handles only; workers resolve them through a managed store. */
export const SAFE_ARTIFACT_REF =
  /^artifact:\/\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}){0,8}$/;

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

function normalizeControlBindings(
  value: unknown,
  errors: string[],
): Sim2RealControlBinding[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value)) {
    errors.push('simulator.controls must be an array');
    return undefined;
  }
  if (value.length > 32) errors.push('simulator.controls must contain at most 32 entries');
  const ids = new Set<string>();
  const controls: Sim2RealControlBinding[] = [];
  for (const [index, item] of value.slice(0, 32).entries()) {
    const source = record(item);
    const id = safeText(source.id, 64).toLowerCase();
    const label = safeText(source.label, 120);
    const keys = Array.isArray(source.keys)
      ? source.keys.slice(0, 12).map(safeKey).filter(Boolean)
      : [];
    const rawSource = safeText(source.source, 16).toLowerCase();
    const controlSource = ['keyboard', 'touch', 'gamepad', 'ui'].includes(rawSource)
      ? (rawSource as Sim2RealControlBinding['source'])
      : undefined;
    if (!SAFE_ID.test(id)) errors.push(`simulator.controls[${index}].id is invalid`);
    if (!label) errors.push(`simulator.controls[${index}].label is required`);
    if (ids.has(id)) errors.push('simulator.controls ids must be unique');
    ids.add(id);
    if (rawSource && !controlSource) {
      errors.push(`simulator.controls[${index}].source is invalid`);
    }
    if (id && label) {
      controls.push({
        id,
        label,
        ...(keys.length ? { keys } : {}),
        ...(safeText(source.description, 180)
          ? { description: safeText(source.description, 180) }
          : {}),
        ...(controlSource ? { source: controlSource } : {}),
      });
    }
  }
  return controls.length ? controls : undefined;
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
  const algorithm = safeText(source.algorithm, 12);
  if (algorithm && algorithm !== 'ppo' && algorithm !== 'sac') {
    errors.push('training.algorithm must be ppo or sac');
  }
  // Same allowlist rationale as algorithm: a typo must 400 at submission
  // time instead of falling through to whichever engine the worker default.
  const engine = safeText(source.engine, 32);
  if (engine && !ALLOWED_TRAINING_ENGINES.has(engine as Sim2RealTrainingEngine)) {
    errors.push('training.engine must be starter-ppo, mjx-ppo or microduck-rl');
  }
  if (errors.length) return { errors };
  return {
    errors,
    spec: {
      profile: selected,
      numEnvs,
      maxIterations,
      video: rawVideo as boolean,
      ...(runName ? { runName } : {}),
      ...(algorithm ? { algorithm: algorithm as Sim2RealTrainingAlgorithm } : {}),
      ...(engine ? { engine: engine as Sim2RealTrainingEngine } : {}),
    },
  };
}

/**
 * Apply a task pack's engine recommendation to a spec that chose none.
 *
 * Only the non-default recommendation is injected: 'starter-ppo' is the
 * platform-wide default, so injecting it would add a field that breaks
 * single-engine workers registered under a custom engine id. Kinematic
 * task packs therefore simply omit the field.
 */
export function applyTaskEngineRecommendation(
  spec: Sim2RealTrainingSpec,
  recommendedEngine?: string | null,
): Sim2RealTrainingSpec {
  if (spec.engine) return spec;
  if (recommendedEngine === 'mjx-ppo') return { ...spec, engine: 'mjx-ppo' };
  return spec;
}

function exactNumber(value: unknown, expected: number, label: string, errors: string[]): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed !== expected) {
    errors.push(`${label} must be exactly ${expected}`);
    return expected;
  }
  return parsed;
}

function positiveNumber(
  value: unknown,
  label: string,
  errors: string[],
  bounds: { min?: number; max?: number } = {},
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    errors.push(`${label} must be a positive number`);
    return 1;
  }
  if (bounds.min !== undefined && parsed < bounds.min) {
    errors.push(`${label} must be at least ${bounds.min}`);
  }
  if (bounds.max !== undefined && parsed > bounds.max) {
    errors.push(`${label} must be at most ${bounds.max}`);
  }
  return parsed;
}

function positiveInteger(
  value: unknown,
  label: string,
  errors: string[],
  max = Number.MAX_SAFE_INTEGER,
): number {
  const parsed = positiveNumber(value, label, errors, { max });
  if (!Number.isSafeInteger(parsed)) {
    errors.push(`${label} must be a positive integer`);
    return Math.max(1, Math.floor(parsed));
  }
  return parsed;
}

function nonNegativeInteger(
  value: unknown,
  label: string,
  errors: string[],
  max = Number.MAX_SAFE_INTEGER,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isSafeInteger(parsed)) {
    errors.push(`${label} must be a non-negative integer`);
    return 0;
  }
  if (parsed > max) errors.push(`${label} must be at most ${max}`);
  return parsed;
}

/** A tensor name must be a plausible ONNX identifier, not arbitrary text. */
const POLICY_TENSOR_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

function tensorName(value: unknown, label: string, errors: string[]): string | undefined {
  if (value === undefined || value === null) return undefined;
  const name = safeText(value, 64);
  if (!POLICY_TENSOR_NAME.test(name)) {
    errors.push(`${label} must be a tensor name matching ${POLICY_TENSOR_NAME}`);
    return undefined;
  }
  return name;
}

function tensorNameList(value: unknown, label: string, errors: string[]): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array of tensor names`);
    return undefined;
  }
  if (value.length > 8) {
    errors.push(`${label} must contain at most 8 names`);
    return undefined;
  }
  const names = value.map((item) => tensorName(item, `${label} entry`, errors));
  if (names.some((name) => name === undefined)) return undefined;
  const resolved = names as string[];
  if (new Set(resolved).size !== resolved.length) {
    errors.push(`${label} must not repeat a tensor name`);
    return undefined;
  }
  return resolved;
}

function normalizeContractInputs(
  value: unknown,
  errors: string[],
): Sim2RealPolicyInputs | undefined {
  if (value === undefined || value === null) return undefined;
  const source = record(value);
  const observation = tensorName(source.observation, 'contract.inputs.observation', errors);
  const image = tensorName(source.image, 'contract.inputs.image', errors);
  const stateInputs = tensorNameList(source.stateInputs, 'contract.inputs.stateInputs', errors);
  const stateOutputs = tensorNameList(source.stateOutputs, 'contract.inputs.stateOutputs', errors);
  if (stateInputs && stateOutputs && stateInputs.length !== stateOutputs.length) {
    errors.push('contract.inputs.stateInputs and stateOutputs must pair 1:1');
  }
  if ((stateInputs && !stateOutputs) || (stateOutputs && !stateInputs)) {
    errors.push('contract.inputs.stateInputs and stateOutputs must be declared together');
  }
  for (const key of Object.keys(source)) {
    if (!['observation', 'image', 'stateInputs', 'stateOutputs'].includes(key)) {
      errors.push(`contract.inputs has unknown field ${JSON.stringify(key)}`);
    }
  }
  const normalized: Sim2RealPolicyInputs = {
    ...(observation === undefined ? {} : { observation }),
    ...(image === undefined ? {} : { image }),
    ...(stateInputs === undefined ? {} : { stateInputs }),
    ...(stateOutputs === undefined ? {} : { stateOutputs }),
  };
  return Object.keys(normalized).length ? normalized : undefined;
}

function normalizeContractState(value: unknown, errors: string[]): Sim2RealPolicyState | undefined {
  if (value === undefined || value === null) return undefined;
  const source = record(value);
  const kind = source.kind;
  if (kind !== 'lstm' && kind !== 'gru') {
    errors.push('contract.state.kind must be "lstm" or "gru"');
    return undefined;
  }
  const layers = positiveFinite(source.layers);
  if (layers === null || Math.floor(layers) !== layers || layers < 1 || layers > 8) {
    errors.push('contract.state.layers must be an integer between 1 and 8');
    return undefined;
  }
  const hiddenSize = positiveFinite(source.hiddenSize);
  if (
    hiddenSize === null ||
    Math.floor(hiddenSize) !== hiddenSize ||
    hiddenSize < 1 ||
    hiddenSize > 4096
  ) {
    errors.push('contract.state.hiddenSize must be an integer between 1 and 4096');
    return undefined;
  }
  // Only one reset policy is defined today. Accepting a free-form string would
  // let a contract promise semantics no runtime implements.
  if (source.reset !== 'on-activation') {
    errors.push('contract.state.reset must be "on-activation"');
    return undefined;
  }
  return {
    kind,
    layers: Math.floor(layers),
    hiddenSize: Math.floor(hiddenSize),
    reset: 'on-activation',
  };
}

function normalizeLayout(
  value: unknown,
  errors: string[],
  expected?: readonly Sim2RealObservationLayoutItem[],
): Sim2RealObservationLayoutItem[] {
  if (!Array.isArray(value)) {
    errors.push('contract.observationLayout is required');
    return expected?.map((item) => ({ ...item })) || [];
  }
  if (value.length > SIM2REAL_CONTRACT_LIMITS.maxObservationLayoutEntries) {
    errors.push(
      `contract.observationLayout must contain at most ${SIM2REAL_CONTRACT_LIMITS.maxObservationLayoutEntries} entries`,
    );
  }
  const layout = value
    .slice(0, SIM2REAL_CONTRACT_LIMITS.maxObservationLayoutEntries)
    .map((item): Sim2RealObservationLayoutItem => {
      const source = record(item);
      const name = safeText(source.name, 64);
      const size = positiveFinite(source.size);
      if (!name) errors.push('contract.observationLayout item name is required');

      // Modality is opt-in. An absent modality is the original vector slot, so
      // every pre-existing contract keeps its exact meaning; anything other
      // than an explicit `image` is rejected rather than quietly treated as a
      // vector, because a mis-declared modality is a contract bug that would
      // otherwise surface as a shape error deep inside a training engine.
      if (source.modality !== undefined && source.modality !== 'image') {
        errors.push(
          `contract.observationLayout item modality must be "image" when present (got ${JSON.stringify(source.modality)})`,
        );
        return { name, size: size ? Math.floor(size) : 0 };
      }

      if (source.modality === 'image') {
        const rawChannels = positiveFinite(source.channels);
        const rawHeight = positiveFinite(source.height);
        const rawWidth = positiveFinite(source.width);
        const channels = rawChannels === null ? 0 : Math.floor(rawChannels);
        const height = rawHeight === null ? 0 : Math.floor(rawHeight);
        const width = rawWidth === null ? 0 : Math.floor(rawWidth);
        const shapeOk =
          channels >= 1 &&
          height >= 1 &&
          width >= 1 &&
          channels <= SIM2REAL_CONTRACT_LIMITS.maxObservationImageChannels &&
          height <= SIM2REAL_CONTRACT_LIMITS.maxObservationImageHeight &&
          width <= SIM2REAL_CONTRACT_LIMITS.maxObservationImageWidth;
        if (!shapeOk) {
          errors.push(
            `contract.observationLayout image item shape must be positive integers within ` +
              `${SIM2REAL_CONTRACT_LIMITS.maxObservationImageChannels}x` +
              `${SIM2REAL_CONTRACT_LIMITS.maxObservationImageHeight}x` +
              `${SIM2REAL_CONTRACT_LIMITS.maxObservationImageWidth}`,
          );
          return { name, size: size ? Math.floor(size) : 0 };
        }
        const flat = channels * height * width;
        // `size` is derived from the declared shape rather than trusted, so a
        // disagreement is a hard error instead of a silent preference for one
        // of the two numbers.
        if (Math.floor(size ?? 0) !== flat) {
          errors.push(
            `contract.observationLayout image item "${name}" size must equal channels*height*width (${flat})`,
          );
        }
        // Image elements are budgeted separately from flat vector slots: the
        // vector budget is 4096 elements, which no real frame fits inside, while
        // `maxObservationLayoutItemSize` exists to bound a single flat vector
        // slot. Exceeding this one means the declared shape is implausible (a
        // full-HD RGBA frame is the largest thing this platform will accept).
        if (flat > SIM2REAL_CONTRACT_LIMITS.maxObservationImageElements) {
          errors.push(
            `contract.observationLayout image item "${name}" exceeds ${SIM2REAL_CONTRACT_LIMITS.maxObservationImageElements} elements`,
          );
        }
        return {
          name,
          size: flat,
          modality: 'image',
          channels,
          height,
          width,
        };
      }

      if (
        source.channels !== undefined ||
        source.height !== undefined ||
        source.width !== undefined
      ) {
        errors.push(
          `contract.observationLayout item "${name}" declares an image shape without modality "image"`,
        );
      }
      if (
        !size ||
        !Number.isSafeInteger(size) ||
        size > SIM2REAL_CONTRACT_LIMITS.maxObservationLayoutItemSize
      ) {
        errors.push(
          `contract.observationLayout item size must be a positive integer at most ${SIM2REAL_CONTRACT_LIMITS.maxObservationLayoutItemSize}`,
        );
      }
      return { name, size: size ? Math.floor(size) : 0 };
    });
  if (expected) {
    if (
      layout.length !== expected.length ||
      layout.some((item, index) => {
        const reference = expected[index];
        return (
          !reference ||
          item.name !== reference.name ||
          item.size !== reference.size ||
          ('modality' in item ? item.modality : undefined) !==
            (reference && 'modality' in reference ? reference.modality : undefined)
        );
      })
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
      !SAFE_ARTIFACT_REF.test(ref))
  ) {
    errors.push(
      `artifacts[${index}].ref must be an opaque artifact:// reference (no local path or URL)`,
    );
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
    errors.push('robot.id must be microduck, rdk-duck, or originbot');
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
      : productId === 'originbot'
        ? nonNegativeInteger(
            contract.jointCount,
            'contract.jointCount',
            errors,
            SIM2REAL_CONTRACT_LIMITS.maxJointCount,
          )
        : positiveInteger(
            contract.jointCount,
            'contract.jointCount',
            errors,
            SIM2REAL_CONTRACT_LIMITS.maxJointCount,
          ),
    observationSize: isFixedMicroDuck
      ? exactNumber(contract.observationSize, 61, 'contract.observationSize', errors)
      : positiveInteger(
          contract.observationSize,
          'contract.observationSize',
          errors,
          SIM2REAL_CONTRACT_LIMITS.maxObservationSize,
        ),
    actionSize: isFixedMicroDuck
      ? exactNumber(contract.actionSize, 14, 'contract.actionSize', errors)
      : positiveInteger(
          contract.actionSize,
          'contract.actionSize',
          errors,
          SIM2REAL_CONTRACT_LIMITS.maxActionSize,
        ),
    controlHz: isFixedMicroDuck
      ? exactNumber(contract.controlHz, 50, 'contract.controlHz', errors)
      : positiveInteger(
          contract.controlHz,
          'contract.controlHz',
          errors,
          SIM2REAL_CONTRACT_LIMITS.maxControlHz,
        ),
    physicsTimestepSeconds: isFixedMicroDuck
      ? exactNumber(
          contract.physicsTimestepSeconds,
          0.005,
          'contract.physicsTimestepSeconds',
          errors,
        )
      : positiveNumber(contract.physicsTimestepSeconds, 'contract.physicsTimestepSeconds', errors, {
          min: SIM2REAL_CONTRACT_LIMITS.minPhysicsTimestepSeconds,
          max: SIM2REAL_CONTRACT_LIMITS.maxPhysicsTimestepSeconds,
        }),
    decimation: isFixedMicroDuck
      ? exactNumber(contract.decimation, 4, 'contract.decimation', errors)
      : positiveInteger(
          contract.decimation,
          'contract.decimation',
          errors,
          SIM2REAL_CONTRACT_LIMITS.maxDecimation,
        ),
    observationLayout: normalizeLayout(
      contract.observationLayout,
      errors,
      isFixedMicroDuck ? MICRODUCK_OBSERVATION_LAYOUT : undefined,
    ),
  };
  // Named inputs and recurrent state are cross-checked against each other: a
  // state block without named state tensors (or vice versa) leaves the runtime
  // unable to bind them, which must be a contract error rather than a guess.
  const policyInputs = normalizeContractInputs(contract.inputs, errors);
  const policyState = normalizeContractState(contract.state, errors);
  const namedStateInputs = policyInputs?.stateInputs?.length ?? 0;
  if (policyState && namedStateInputs === 0) {
    errors.push(
      'contract.state declares recurrent state but contract.inputs.stateInputs names no state tensor',
    );
  }
  if (!policyState && namedStateInputs > 0) {
    errors.push(
      'contract.inputs.stateInputs names state tensors but contract.state is missing; declare the state contract or remove the names',
    );
  }
  // An LSTM carries two tensors per layer (h and c); a GRU carries one. A
  // mismatch here is a contract that cannot describe the graph it names.
  if (policyState && namedStateInputs > 0) {
    const perLayer = policyState.kind === 'lstm' ? 2 : 1;
    const expected = perLayer * policyState.layers;
    if (namedStateInputs !== expected) {
      errors.push(
        `contract.inputs.stateInputs names ${namedStateInputs} tensor(s) but ${policyState.kind} with ${policyState.layers} layer(s) needs ${expected}`,
      );
    }
  }
  if (policyInputs) normalizedContract.inputs = policyInputs;
  if (policyState) normalizedContract.state = policyState;
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
    // `observationSize` is the policy's flat VECTOR input width, so image slots
    // are deliberately excluded from this sum.
    //
    // Counting an image here was the first attempt and it does not survive
    // contact with the platform: the flat per-frame budget is 4096 elements
    // (`SIM2REAL_CONTRACT_LIMITS.maxObservationSize`, duplicated in the
    // adapter/profile validators, the RoboGo runner, the mock worker and the
    // board runtime) while a single 3x64x64 camera frame is already 12288. Tying
    // the two together would mean either no realistic camera can ever be
    // declared, or a safety cap designed for flat vectors has to be raised for
    // everyone. Neither is acceptable, so images are budgeted by their declared
    // shape (bounded by the per-axis limits in `normalizeLayout`) and the sum
    // check keeps applying to exactly what it applied to before.
    //
    // Backward compatibility is total: every pre-existing contract is
    // vector-only, so for those this reduces to the original
    // `sum(all slots) === observationSize`.
    const vectorTotal = normalizedContract.observationLayout.reduce(
      (sum, item) => sum + ('modality' in item ? 0 : item.size),
      0,
    );
    if (vectorTotal !== normalizedContract.observationSize) {
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
  const controls = normalizeControlBindings(simulator.controls, errors);
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
      ...(controls ? { controls } : {}),
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
            keys: ['W', 'A', 'S', 'D', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'],
            description: 'W/A/S/D 或方向键控制前进、后退和转向。',
          },
          {
            id: 'sit-stand',
            label: '坐下 / 站起',
            artifactId: 'official-sitstand-policy',
            keys: ['R'],
            description: 'R 在双足模式切换坐下与站立。',
          },
          {
            id: 'kick-left',
            label: '左脚踢球',
            artifactId: 'official-kick-left-policy',
            keys: ['Q'],
            description: 'Q（部分 AZERTY 键盘显示 A）触发左脚踢球。',
          },
          {
            id: 'kick-right',
            label: '右脚踢球',
            artifactId: 'official-kick-right-policy',
            keys: ['E'],
            description: 'E 触发右脚踢球。',
          },
          {
            id: 'ground-pick',
            label: '拾取',
            artifactId: 'official-ground-pick-policy',
            keys: ['G'],
            description: 'G 触发喙朝地面的拾取动作。',
          },
          {
            id: 'stand-recover',
            label: '自恢复',
            artifactId: 'official-stand-policy',
            description: '跌倒检测后由运行时自动调用，无固定键位。',
          },
          {
            id: 'roller-drive',
            label: '滚轮移动',
            artifactId: 'official-roller-drive-policy',
            keys: ['M'],
            description: 'M 切换到滚轮模式后使用滚轮策略。',
          },
          {
            id: 'roller-crouch',
            label: '滚轮蹲伏',
            artifactId: 'official-roller-crouch-policy',
            keys: ['R'],
            description: '滚轮模式下 R 触发蹲伏滑行。',
          },
        ],
      },
      controls: [
        {
          id: 'move',
          label: '移动',
          keys: ['W', 'A', 'S', 'D', '↑', '↓', '←', '→'],
          description: 'W/A/S/D 或方向键：前进、后退、左转、右转。',
          source: 'keyboard',
        },
        {
          id: 'kick-left',
          label: '左脚踢球',
          keys: ['Q'],
          description: '触发左脚踢球动作。',
          source: 'keyboard',
        },
        {
          id: 'kick-right',
          label: '右脚踢球',
          keys: ['E'],
          description: '触发右脚踢球动作。',
          source: 'keyboard',
        },
        {
          id: 'alternate-kick',
          label: '换脚踢球',
          keys: ['F'],
          description: '由仿真引擎自动选择下一只脚。',
          source: 'keyboard',
        },
        {
          id: 'sit-toggle',
          label: '坐下 / 站起',
          keys: ['R'],
          description: '切换坐下与站立状态。',
          source: 'keyboard',
        },
        {
          id: 'ground-pick',
          label: '拾取',
          keys: ['G'],
          description: '触发喙朝地面的拾取动作。',
          source: 'keyboard',
        },
        {
          id: 'chase-camera',
          label: '跟随视角',
          keys: ['C'],
          description: '切换跟随镜头，不是相机硬件控制。',
          source: 'keyboard',
        },
        {
          id: 'locomotion-mode',
          label: '移动模式',
          keys: ['M'],
          description: '在双足与滚轮模式之间切换。',
          source: 'keyboard',
        },
        {
          id: 'quack',
          label: '叫一声',
          keys: ['B'],
          description: '平台覆盖层快捷键（上游桌面键盘未绑定）；移动端按钮和手柄也可触发。',
          source: 'ui',
        },
        {
          id: 'reset',
          label: '重置仿真',
          keys: ['Space'],
          description: '重新开始当前仿真。',
          source: 'keyboard',
        },
        {
          id: 'spawn-ball',
          label: '生成球',
          description: '通过移动端完整控制面板或仿真 API 触发。',
          source: 'ui',
        },
      ],
      entryUrl: '/mujoco/microduck/',
    },
    artifacts: [
      {
        id: 'official-walking-policy',
        role: 'policy',
        name: 'BEST_alpha_walking.onnx',
        kind: 'source',
        format: 'onnx',
        // The browser path is carried by `simulator.entryUrl`; artifact refs
        // sent to a worker must remain opaque and never be local filesystem or
        // arbitrary URL values.
        ref: 'artifact://builtin/microduck-official/upstream-browser/policy.onnx',
      },
      {
        id: 'official-sitstand-policy',
        role: 'policy',
        name: 'BEST_alpha_sitstand.onnx',
        kind: 'source',
        format: 'onnx',
        ref: 'artifact://builtin/microduck-official/upstream-browser/BEST_alpha_sitstand.onnx',
      },
      {
        id: 'official-kick-left-policy',
        role: 'policy',
        name: 'ball_kick_left.onnx',
        kind: 'source',
        format: 'onnx',
        ref: 'artifact://builtin/microduck-official/upstream-browser/ball_kick_left.onnx',
      },
      {
        id: 'official-kick-right-policy',
        role: 'policy',
        name: 'ball_kick_right.onnx',
        kind: 'source',
        format: 'onnx',
        ref: 'artifact://builtin/microduck-official/upstream-browser/ball_kick_right.onnx',
      },
      {
        id: 'official-ground-pick-policy',
        role: 'policy',
        name: 'alpha_ground_pick.onnx',
        kind: 'source',
        format: 'onnx',
        ref: 'artifact://builtin/microduck-official/upstream-browser/alpha_ground_pick.onnx',
      },
      {
        id: 'official-stand-policy',
        role: 'policy',
        name: 'BEST_alpha_stand.onnx',
        kind: 'source',
        format: 'onnx',
        ref: 'artifact://builtin/microduck-official/upstream-browser/BEST_alpha_stand.onnx',
      },
      {
        id: 'official-roller-drive-policy',
        role: 'policy',
        name: 'BEST_roller.onnx',
        kind: 'source',
        format: 'onnx',
        ref: 'artifact://builtin/microduck-official/upstream-browser/BEST_roller.onnx',
      },
      {
        id: 'official-roller-crouch-policy',
        role: 'policy',
        name: 'BEST_roller_crouch.onnx',
        kind: 'source',
        format: 'onnx',
        ref: 'artifact://builtin/microduck-official/upstream-browser/BEST_roller_crouch.onnx',
      },
    ],
    metadata: {
      source: 'Pollen Robotics MicroDuck public simulator',
      notes:
        'Built-in reference only; user policy switching is gated by the manifest and artifact checks.',
    },
  },
};

/** Contract-complete OriginBot starter so the mobile workflow is usable before
 * a user imports a custom policy. The artifact is deliberately a reference
 * placeholder: it enables simulation, recording, training and evaluation, but
 * never implies a deployable real-robot policy. */
export const BUILTIN_ORIGINBOT_MODEL: Sim2RealModelRecord = {
  id: 'builtin-originbot-goal-navigation',
  builtin: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  manifest: {
    schemaVersion: SIM2REAL_SCHEMA_VERSION,
    modelId: 'originbot-policy-v1',
    displayName: 'OriginBot 目标导航起始策略',
    version: 'starter-v1',
    robot: { id: 'originbot', variant: 'differential-drive' },
    contract: {
      id: 'originbot-policy-v1',
      robotId: 'originbot',
      jointCount: 0,
      observationSize: 8,
      actionSize: 2,
      controlHz: 10,
      physicsTimestepSeconds: 0.1,
      decimation: 1,
      observationLayout: [
        { name: 'x', size: 1 },
        { name: 'y', size: 1 },
        { name: 'sin_yaw', size: 1 },
        { name: 'cos_yaw', size: 1 },
        { name: 'goal_dx', size: 1 },
        { name: 'goal_dy', size: 1 },
        { name: 'linear_velocity', size: 1 },
        { name: 'angular_velocity', size: 1 },
      ],
    },
    simulator: {
      backends: ['browser', 'local'],
      policyArtifactId: 'originbot-starter-policy',
      policyBundle: {
        defaultPolicyId: 'goal-navigation',
        policies: [
          {
            id: 'goal-navigation',
            label: '目标导航',
            artifactId: 'originbot-starter-policy',
            description: 'OriginBot 8D 观测 / 2D 差速动作起始策略。',
          },
        ],
      },
      entryUrl: '/originbot-sim/',
    },
    artifacts: [
      {
        id: 'originbot-starter-policy',
        role: 'policy',
        name: 'originbot-policy.onnx',
        kind: 'source',
        format: 'onnx',
        runtime: 'cpu-onnx',
        workload: 'locomotion',
        threads: 1,
        ref: 'artifact://originbot/starter-policy',
      },
    ],
    metadata: {
      source: 'RDK OriginBot built-in starter contract',
      notes: '可直接仿真、录制、训练和评测；真机部署前必须替换为真实训练制品并完成遥测与预检。',
    },
  },
};
