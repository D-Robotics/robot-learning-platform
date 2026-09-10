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

/** A bounded, normalized time-series sample accepted by the ingest endpoint. */
export interface Sim2RealTelemetrySample {
  /** Monotonic timestamp in seconds relative to the run. */
  t: number;
  observation?: number[];
  action?: number[];
  reward?: number;
  done?: boolean;
  fall?: boolean;
}

export interface Sim2RealTelemetryRecord {
  id: string;
  runId: string;
  modelId: string;
  deviceId?: string;
  source: Sim2RealTelemetrySource;
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
