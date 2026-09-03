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
}

export type Sim2RealTelemetrySource = 'board-agent' | 'browser' | 'import';

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
