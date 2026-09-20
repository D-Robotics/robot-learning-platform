import type { LatencyMeasurementStage } from './board-rehearsal.js';
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
  /** MuJoCo post-training evaluation episode count and mean return. */
  evaluationEpisodes?: number;
  meanReturn?: number;
  fallRate?: number;
  episodeLength?: number;
  /** Latency figure; interpret only with {@link measurementStage}. */
  controlLatencyMs?: number;
  /**
   * Where {@link controlLatencyMs} was measured. The starter engine measures a
   * PyTorch forward pass on the training host, so it reports `host-torch`; a
   * board rehearsal reports `board-onnx`. Never inferred.
   */
  measurementStage?: LatencyMeasurementStage;
  /**
   * Commit of the training code that produced this artifact. A package version
   * such as `starter-ppo-0.1.0` cannot answer "which reward/observation code
   * trained this policy?" once the tree has moved on. Absent means the engine
   * could not determine it (no `.git`, e.g. a packaged board install) — never
   * filled in with a guess.
   */
  sourceCommit?: string;
  /**
   * Versions of the libraries that actually produced the artifact, as installed
   * (`{torch: "2.8.0", ...}`). A commit names the code but not the numerics:
   * `torch.onnx.export` output changes between releases, so both halves are
   * needed to reproduce a run. Absent means the engine did not report them.
   */
  dependencyVersions?: Record<string, string>;
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
  /**
   * Server-rendered MP4 of the run's camera frames (a rendering of accepted
   * evidence, not new evidence). Present only after POST /runs/:id/replay-video
   * rendered successfully; the sha256 is re-verified on every serve.
   */
  replayVideo?: {
    sha256: string;
    sizeBytes: number;
    frameCount: number;
    fps: number;
    durationSeconds: number;
    renderedAt: string;
  };
}

/**
 * One live training-curve sample parsed from engine stdout while the run is
 * still executing. The worker bounds the array (≤512 strictly-advancing
 * points), so persisting it on the run record is cheap and replay-safe.
 */
export interface Sim2RealRunProgressPoint {
  iteration: number;
  totalIterations: number;
  meanReward: number;
  recentSuccess: number;
  elapsedSeconds?: number;
  at?: string;
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
  /** Falls are tracked apart from 1 - successRate: a policy can fail a task
   * while standing still, or fall after completing it. */
  fallRate?: number;
  fallRateCiLow?: number;
  fallRateCiHigh?: number;
  meanEpisodeLength?: number;
  /**
   * Task-specific measurements in physical units (metres, m/s, radians …),
   * e.g. MicroDuck's `ballTravelM` / `ballPeakSpeedMps`. Numbers only, and they
   * are evidence for a human reader — never folded into the release verdict,
   * which reads `successRate` / `collisionRate` alone.
   */
  measurements?: Record<string, number>;
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
  /**
   * A latency figure whose meaning depends on {@link measurementStage}. Read it
   * only together with that stage: figures from different stages (training-host
   * torch, training-host ONNX, board ONNX, simulated step) are not comparable.
   */
  controlLatencyMs?: number;
  /**
   * Where {@link controlLatencyMs} was measured. Absent means the producer did
   * not declare it, which normalizes to "unknown" — never to a board claim.
   * Only `board-onnx` may support a deployment verdict.
   */
  measurementStage?: LatencyMeasurementStage;
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
  /** Session goal in odom absolute coordinates (goalnav contracts). */
  goalX?: number;
  goalY?: number;
  /** Model fingerprint of the artifact that was active during the session. */
  model?: {
    sha256?: string;
    provider?: string;
    inputDim?: number;
    outputDim?: number;
    bytes?: number;
  };
}

/** Encodings accepted for an aligned camera frame. */
export type Sim2RealCameraFrameEncoding = 'rgb8' | 'bgr8' | 'mono8';

/**
 * The camera frame a vision policy actually observed at this sample.
 *
 * Carried only by attested board-agent telemetry: a frame is evidence of what
 * the policy saw, so an arbitrary imported frame would let synthetic pixels sit
 * next to real control data. `data` is standard base64 of
 * `channels * width * height` raw bytes in `encoding` order, which keeps the
 * frame compact enough to ride the telemetry chunk instead of needing a second
 * upload path, and lets the transport verify the payload is exactly the size its
 * declared shape claims.
 */
export interface Sim2RealTelemetryCameraFrame {
  encoding: Sim2RealCameraFrameEncoding;
  width: number;
  height: number;
  channels: 1 | 3;
  /** Base64 of channels*width*height bytes. */
  data: string;
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
  /** Aligned camera frame for a vision policy; absent for vector-only runs. */
  cameraFrame?: Sim2RealTelemetryCameraFrame;
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
  /** Session goal in odom absolute coordinates (goalnav contracts). */
  goalX?: number;
  /** Session goal in odom absolute coordinates (goalnav contracts). */
  goalY?: number;
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
  /**
   * Distinct board policy sessions observed in lifecycle markers, when any.
   * Duration and rate are summed per session because the board clock resets
   * at every session-started marker.
   */
  sessionCount?: number;
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
