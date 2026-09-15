import type {
  ModelArtifactFormat,
  ModelArtifactKind,
  ModelArtifactRuntime,
  ModelArtifactWorkload,
} from './model-artifacts.js';

/** Metadata emitted by a training backend when it materializes a checkpoint. */
export interface Sim2RealRunArtifactMetadata {
  artifactId: string;
  artifactRef: string;
  kind: ModelArtifactKind;
  format: ModelArtifactFormat;
  runtime?: ModelArtifactRuntime;
  workload?: ModelArtifactWorkload;
  threads?: number;
  sha256?: string;
  sizeBytes?: number;
  /** Mock/protocol workers must never imply that the bytes are deployable. */
  deployable: boolean;
}

export interface Sim2RealRunMetrics {
  contractValid: boolean;
  observationSize: number;
  actionSize: number;
  reward?: number;
  successRate?: number;
  fallRate?: number;
  episodeLength?: number;
  controlLatencyMs?: number;
  iterations?: number;
  /**
   * Physics backend the engine actually trained on (e.g. "mjx" for real
   * MuJoCo contact dynamics via MJX, "starter-kinematic" for the starter
   * GoalNavEnv fallback). Honest engine self-labeling; absent means the
   * backend did not report it.
   */
  physicsBackend?: string;
  /** Engine id that produced the run (e.g. "mjx-ppo", "mjlab-rsl-rl"). */
  engine?: string;
  /**
   * True only when the training backend actually ran on CUDA. A requested but
   * unavailable GPU falls back to CPU and must stay false; an absent value
   * means the backend did not report it (never assume GPU).
   */
  cuda?: boolean;
}

/** Bounded metrics captured for one pinned Task-Pack evaluation envelope. */
export interface Sim2RealTaskEvaluationEnvelope {
  successRate?: number;
  collisionRate?: number;
  successRateCiLow?: number;
  successRateCiHigh?: number;
  collisionRateCiLow?: number;
  collisionRateCiHigh?: number;
  episodes?: number;
  meanReward?: number;
}

/**
 * Sanitized eval-report.json evidence returned by a training runner.
 *
 * The platform stores the measurements, not only the engine's PASS boolean,
 * so the release boundary can independently recompute the verdict.
 */
export interface Sim2RealTaskEvaluationEvidence {
  schemaVersion?: number;
  taskId: string;
  adapterId?: string;
  observationAdapterId?: string;
  trained?: {
    envelopes?: Record<string, Sim2RealTaskEvaluationEnvelope>;
    meanReward?: number;
    episodesPerEnvelope?: number;
    confidenceLevel?: number;
  };
  baseline?: {
    envelopes?: Record<string, Sim2RealTaskEvaluationEnvelope>;
    meanReward?: number;
    episodesPerEnvelope?: number;
    confidenceLevel?: number;
  };
  qualityGate?: {
    passed?: boolean;
    errors?: string[];
    criteria?: {
      minSuccessRate?: number;
      maxCollisionRate?: number;
      gateOn?: 'point' | 'ciLowerBound';
    };
  };
  controlLatencyMs?: number;
  seed?: number;
  /** SHA-256 of the normalized runner report, retained for audit correlation. */
  reportSha256?: string;
}

/**
 * Where a telemetry record came from.  `demo-fixture` is intentionally a
 * first-class value so a canned presentation trace stays marked as synthetic
 * after it is uploaded and the page is refreshed; it must never be treated as
 * real simulator or X5 evidence by release gates.
 */
export type Sim2RealTelemetrySource = 'board-agent' | 'browser' | 'import' | 'demo-fixture';

/** Units declared by a policy head that is projected to a differential-drive twist. */
export type Sim2RealActionOutput = 'physical-twist' | 'normalized-twist';

/** A bounded physical differential-drive command in metres/second and radians/second. */
export interface Sim2RealTelemetryTwist {
  linear: number;
  angular: number;
}

/** Safety scale applied when a policy emits a normalized twist. */
export interface Sim2RealTelemetryActionScale {
  linear: number;
  angular: number;
  units?: 'm/s,rad/s';
}

/** Lifecycle event kinds emitted by the board policy runtime into the spool. */
export type Sim2RealTelemetryBoardSessionEventKind = 'session-started' | 'session-stopped';

/**
 * A board policy-session lifecycle event. Event samples are markers, not
 * control data: they carry no observation/action vectors, they are excluded
 * from replay statistics (sample counts, rates, MAE/RMSE inputs), and they
 * are aggregated by `/runs/:id/board-sessions` instead. The `mock` flag is
 * the board runtime's own honest marker; release gating still relies solely
 * on server-side chunk attestation, never on this field.
 */
export interface Sim2RealTelemetryBoardSessionEvent {
  kind: Sim2RealTelemetryBoardSessionEventKind;
  sessionId?: string;
  /** ISO-8601 UTC timestamp of the session start. */
  startedAt?: string;
  /** ISO-8601 UTC timestamp of the session stop. */
  stoppedAt?: string;
  /** Why the session ended (`operator-stop`, `fault:…`, `sigterm`, …). */
  stopReason?: string;
  inferenceCount?: number;
  lastInferenceAt?: string;
  durationSec?: number;
  /** Runtime's EWMA inference latency, reported at stop time. */
  inferMs?: number;
  published?: number;
  mock?: boolean;
  adapterId?: string;
  controlHz?: number;
  /** Model fingerprint of the artifact that was active during the session. */
  model?: {
    sha256?: string;
    provider?: string;
    inputDim?: number;
    outputDim?: number;
    bytes?: number;
  };
}

/** A bounded, normalized time-series sample accepted by the ingest endpoint. */
export interface Sim2RealTelemetrySample {
  /** Monotonic timestamp in seconds relative to the run. */
  t: number;
  observation?: number[];
  action?: number[];
  reward?: number;
  done?: boolean;
  fall?: boolean;
  /** Physical command actually published to the robot's cmd_vel channel. */
  cmd_vel?: Sim2RealTelemetryTwist;
  /** Whether `action` is already physical or still normalized policy output. */
  actionOutput?: Sim2RealActionOutput;
  /** Per-axis safety scale used by the action projection. */
  actionScale?: Sim2RealTelemetryActionScale;
  /** Effective policy/control loop rate in Hz. */
  controlHz?: number;
  /** Effective period corresponding to controlHz, in seconds. */
  controlPeriodSeconds?: number;
  /** Lifecycle event marker; event samples never carry observation/action. */
  event?: Sim2RealTelemetryBoardSessionEvent;
}

/**
 * One board policy session reconstructed from telemetry lifecycle events.
 * `attested` is true only when every contributing chunk was server-attested;
 * an open session (stop event missing, e.g. after a process kill) keeps
 * `stoppedAt` undefined so the UI can report the interruption honestly.
 */
export interface Sim2RealBoardSessionSummary {
  sessionId: string;
  startedAt?: string;
  stoppedAt?: string;
  stopReason?: string;
  lastInferenceAt?: string;
  inferenceCount?: number;
  published?: number;
  inferMs?: number;
  durationSec?: number;
  mock?: boolean;
  adapterId?: string;
  controlHz?: number;
  model?: Sim2RealTelemetryBoardSessionEvent['model'];
  deviceId?: string;
  /** True only when every contributing chunk was server-attested. */
  attested: boolean;
  /** Distinct telemetry chunks that carried events for this session. */
  chunks: number;
  /** Number of lifecycle events observed for this session. */
  events: number;
}

export interface Sim2RealTelemetryRecord {
  id: string;
  runId: string;
  modelId: string;
  deviceId?: string;
  source: Sim2RealTelemetrySource;
  /**
   * Set only by the server after validating a board-agent attestation token.
   * Clients may not promote an unverified upload by sending this field.
   */
  attested?: boolean;
  contractId?: string;
  sequence?: number;
  samples: Sim2RealTelemetrySample[];
  receivedAt: string;
  /** Number of source samples intentionally omitted by the sender. */
  droppedCount?: number;
  idempotencyKey?: string;
}

export interface Sim2RealReplaySummary {
  sampleCount: number;
  durationSeconds: number;
  sampleRateHz?: number;
  firstTimestamp?: number;
  lastTimestamp?: number;
  source: Sim2RealTelemetrySource;
  /** True only when the replay was produced by a trusted/attested worker. */
  attested?: boolean;
  /** The one physical device represented by an attested replay. */
  deviceId?: string;
  chunkCount: number;
  droppedCount: number;
  rewardMean?: number;
  doneCount: number;
  fallCount: number;
}

export interface Sim2RealEvaluationSummary {
  evaluatedAt: string;
  sampleCount: number;
  referenceSampleCount?: number;
  actionMae?: number;
  actionRmse?: number;
  observationMae?: number;
  observationRmse?: number;
  replay: Sim2RealReplaySummary;
  warnings: string[];
}
