/**
 * Versioned cloud/edge observability contracts.
 *
 * The edge agent and the cloud observability center deliberately share only
 * these data contracts.  Transport, storage and device-specific collectors
 * remain replaceable on either side of the boundary.
 */

export const OBSERVABILITY_SCHEMA_VERSION = 'rdk.observability.v1' as const;
export const OBSERVABILITY_CONTEXT_SCHEMA_VERSION = 'rdk.observability.context.v1' as const;
export const OBSERVABILITY_EVENT_SCHEMA_VERSION = 'rdk.observability.event.v1' as const;
export const OBSERVABILITY_LOG_SCHEMA_VERSION = 'rdk.observability.log.v1' as const;
export const OBSERVABILITY_METRIC_SCHEMA_VERSION = 'rdk.observability.metric.v1' as const;
export const OBSERVABILITY_TELEMETRY_SCHEMA_VERSION = 'rdk.observability.telemetry.v1' as const;
export const OBSERVABILITY_EVIDENCE_SCHEMA_VERSION = 'rdk.observability.evidence.v1' as const;
export const OBSERVABILITY_COMMAND_SCHEMA_VERSION = 'rdk.observability.command.v1' as const;
export const OBSERVABILITY_POLICY_SCHEMA_VERSION = 'rdk.observability.policy.v1' as const;

export type ObservabilitySource =
  | 'edge-agent'
  | 'board-agent'
  | 'runner'
  | 'cloud'
  | 'browser'
  | 'import'
  | 'demo-fixture'
  | 'production-line';

export type ObservabilityFreshness =
  'fresh' | 'delayed' | 'offline' | 'replayed' | 'mock' | 'stale';

export interface ObservabilityContext {
  schemaVersion: typeof OBSERVABILITY_CONTEXT_SCHEMA_VERSION;
  tenantId?: string;
  projectId?: string;
  caseId?: string;
  runId?: string;
  deviceId?: string;
  bootId?: string;
  environmentId?: string;
  assetId?: string;
  artifactId?: string;
  requestId?: string;
  traceId?: string;
}

export interface ObservabilityEvent<T = unknown> {
  schemaVersion: typeof OBSERVABILITY_EVENT_SCHEMA_VERSION;
  eventId: string;
  eventType: string;
  eventVersion: string;
  occurredAt: string;
  producer: string;
  source: ObservabilitySource;
  context: ObservabilityContext;
  status?: string;
  payload: T;
  idempotencyKey: string;
}

export interface ObservabilityLog {
  schemaVersion: typeof OBSERVABILITY_LOG_SCHEMA_VERSION;
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  service: string;
  event?: string;
  message: string;
  source: ObservabilitySource;
  context: ObservabilityContext;
  error?: { code: string; retryable?: boolean };
  durationMs?: number;
  freshness?: ObservabilityFreshness;
}

export type ObservabilityMetricType = 'gauge' | 'counter' | 'histogram' | 'summary';

export interface ObservabilityMetric {
  schemaVersion: typeof OBSERVABILITY_METRIC_SCHEMA_VERSION;
  metric: string;
  type: ObservabilityMetricType;
  timestamp: string;
  value: number;
  unit: string;
  temporality?: 'delta' | 'cumulative';
  labels?: Record<string, string>;
  context: ObservabilityContext;
  source: ObservabilitySource;
}

export interface ObservabilitySignal {
  value: number;
  unit: string;
}

export interface ObservabilityTelemetrySample {
  sequence: number;
  sampleTime: string;
  sampleMonotonicNs: number;
  source: ObservabilitySource;
  bootId: string;
  signals: Record<string, ObservabilitySignal>;
  quality?: {
    fresh?: boolean;
    clockSynced?: boolean;
    droppedSincePrevious?: number;
  };
  context: ObservabilityContext;
}

export interface ObservabilityTelemetryChunk {
  schemaVersion: typeof OBSERVABILITY_TELEMETRY_SCHEMA_VERSION;
  chunkId: string;
  deviceId: string;
  bootId: string;
  sequenceStart: number;
  sequenceEnd: number;
  samples: ObservabilityTelemetrySample[];
  sha256: string;
  compressed?: boolean;
  createdAt: string;
  context: ObservabilityContext;
}

export interface EvidenceFileRef {
  role: string;
  uri: string;
  sha256: string;
  bytes: number;
}

export interface ObservabilityEvidenceManifest {
  schemaVersion: typeof OBSERVABILITY_EVIDENCE_SCHEMA_VERSION;
  evidenceId: string;
  kind: string;
  context: ObservabilityContext;
  source: { type: ObservabilitySource; deviceId?: string; bootId?: string };
  inputs?: Array<{ assetId?: string; artifactId?: string; environmentId?: string; sha256: string }>;
  files: EvidenceFileRef[];
  measurements?: Record<string, number | string | boolean>;
  createdAt: string;
  immutable: true;
}

export type EdgeCommandSideEffect = 'read-only' | 'diagnostic' | 'controlled-write';

export interface EdgeCommandRequest {
  schemaVersion: typeof OBSERVABILITY_COMMAND_SCHEMA_VERSION;
  commandId: string;
  capabilityId: string;
  deviceId: string;
  projectId: string;
  requestedBy: string;
  issuedAt: string;
  expiresAt: string;
  sideEffect: EdgeCommandSideEffect;
  approvalRef?: string;
  parameters: Record<string, unknown>;
  signature?: string;
}

export interface EdgeObservationPolicy {
  schemaVersion: typeof OBSERVABILITY_POLICY_SCHEMA_VERSION;
  policyId: string;
  version: number;
  deviceId?: string;
  projectId: string;
  expiresAt: string;
  streams: Record<
    string,
    { sampleHz?: number; retentionHours?: number; mode?: 'always' | 'on-demand' | 'disabled' }
  >;
  triggers?: Array<{
    metric: string;
    operator: '>' | '>=' | '<' | '<=' | '==';
    value: number;
    action: string;
  }>;
  signature: string;
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null;
}

function isNonEmptyString(value: unknown, maxLength = 256): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function validateContext(
  input: unknown,
  errors: string[],
  required: string[] = [],
): input is ObservabilityContext {
  const value = asObject(input);
  if (!value) {
    errors.push('context must be an object');
    return false;
  }
  if (value.schemaVersion !== OBSERVABILITY_CONTEXT_SCHEMA_VERSION)
    errors.push(`context.schemaVersion must be ${OBSERVABILITY_CONTEXT_SCHEMA_VERSION}`);
  for (const key of required) {
    if (!isNonEmptyString(value[key])) errors.push(`context.${key} is required`);
  }
  const contextKeys = [
    'tenantId',
    'projectId',
    'caseId',
    'runId',
    'deviceId',
    'bootId',
    'environmentId',
    'assetId',
    'artifactId',
    'requestId',
    'traceId',
  ];
  for (const key of contextKeys) {
    if (value[key] !== undefined && !isNonEmptyString(value[key]))
      errors.push(`context.${key} must be a non-empty string`);
  }
  return errors.length === 0;
}

export function validateObservabilityContext(input: unknown): {
  valid: boolean;
  errors: string[];
  context?: ObservabilityContext;
} {
  const errors: string[] = [];
  if (validateContext(input, errors))
    return { valid: true, errors, context: input as ObservabilityContext };
  return { valid: false, errors };
}

export function validateObservabilityEvent(input: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const value = asObject(input);
  if (!value) return { valid: false, errors: ['event must be an object'] };
  if (value.schemaVersion !== OBSERVABILITY_EVENT_SCHEMA_VERSION)
    errors.push(`schemaVersion must be ${OBSERVABILITY_EVENT_SCHEMA_VERSION}`);
  for (const key of ['eventId', 'eventType', 'eventVersion', 'producer', 'idempotencyKey'])
    if (!isNonEmptyString(value[key])) errors.push(`${key} is required`);
  if (!isIsoDate(value.occurredAt)) errors.push('occurredAt must be an ISO timestamp');
  if (
    !isNonEmptyString(value.source) ||
    ![
      'edge-agent',
      'board-agent',
      'runner',
      'cloud',
      'browser',
      'import',
      'demo-fixture',
      'production-line',
    ].includes(String(value.source))
  )
    errors.push('source is invalid');
  validateContext(value.context, errors);
  if (value.payload === undefined) errors.push('payload is required');
  return { valid: errors.length === 0, errors };
}

export function validateObservabilityMetric(input: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const value = asObject(input);
  if (!value) return { valid: false, errors: ['metric must be an object'] };
  if (value.schemaVersion !== OBSERVABILITY_METRIC_SCHEMA_VERSION)
    errors.push(`schemaVersion must be ${OBSERVABILITY_METRIC_SCHEMA_VERSION}`);
  if (!isNonEmptyString(value.metric, 128)) errors.push('metric is required');
  if (!['gauge', 'counter', 'histogram', 'summary'].includes(String(value.type)))
    errors.push('type is invalid');
  if (!isIsoDate(value.timestamp)) errors.push('timestamp must be an ISO timestamp');
  if (typeof value.value !== 'number' || !Number.isFinite(value.value))
    errors.push('value must be finite');
  if (!isNonEmptyString(value.unit, 32)) errors.push('unit is required');
  validateContext(value.context, errors);
  return { valid: errors.length === 0, errors };
}

export function validateTelemetryChunk(input: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const value = asObject(input);
  if (!value) return { valid: false, errors: ['telemetry chunk must be an object'] };
  if (value.schemaVersion !== OBSERVABILITY_TELEMETRY_SCHEMA_VERSION)
    errors.push(`schemaVersion must be ${OBSERVABILITY_TELEMETRY_SCHEMA_VERSION}`);
  for (const key of ['chunkId', 'deviceId', 'bootId', 'sha256'])
    if (!isNonEmptyString(value[key])) errors.push(`${key} is required`);
  if (!isSha256(value.sha256)) errors.push('sha256 must be a 64-character hexadecimal digest');
  if (!Number.isInteger(value.sequenceStart) || Number(value.sequenceStart) < 0)
    errors.push('sequenceStart must be a non-negative integer');
  if (!Number.isInteger(value.sequenceEnd) || Number(value.sequenceEnd) < 0)
    errors.push('sequenceEnd must be a non-negative integer');
  const samples = Array.isArray(value.samples) ? value.samples : [];
  if (!Array.isArray(value.samples) || samples.length === 0)
    errors.push('samples must be non-empty');
  let previous = -1;
  for (const [index, rawSample] of samples.entries()) {
    const sample = asObject(rawSample);
    if (!sample) {
      errors.push(`samples[${index}] must be an object`);
      continue;
    }
    if (!Number.isInteger(sample.sequence) || Number(sample.sequence) < 0)
      errors.push(`samples[${index}].sequence must be a non-negative integer`);
    if (Number(sample.sequence) <= previous)
      errors.push(`samples[${index}].sequence must be increasing`);
    previous = Number(sample.sequence);
    if (!isIsoDate(sample.sampleTime))
      errors.push(`samples[${index}].sampleTime must be an ISO timestamp`);
    if (
      typeof sample.sampleMonotonicNs !== 'number' ||
      !Number.isSafeInteger(sample.sampleMonotonicNs) ||
      sample.sampleMonotonicNs < 0
    )
      errors.push(`samples[${index}].sampleMonotonicNs must be a non-negative safe integer`);
    if (!isNonEmptyString(sample.bootId)) errors.push(`samples[${index}].bootId is required`);
    const signals = asObject(sample.signals);
    if (!signals || Object.keys(signals).length === 0)
      errors.push(`samples[${index}].signals must be non-empty`);
  }
  if (Number(value.sequenceStart) > Number(value.sequenceEnd))
    errors.push('sequenceStart cannot exceed sequenceEnd');
  if (
    samples.length &&
    (Number(samples[0]?.sequence) !== Number(value.sequenceStart) ||
      Number(samples.at(-1)?.sequence) !== Number(value.sequenceEnd))
  )
    errors.push('sequence range must match first and last sample');
  validateContext(value.context, errors, ['deviceId', 'bootId']);
  return { valid: errors.length === 0, errors };
}

export function validateEvidenceManifest(input: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const value = asObject(input);
  if (!value) return { valid: false, errors: ['evidence manifest must be an object'] };
  if (value.schemaVersion !== OBSERVABILITY_EVIDENCE_SCHEMA_VERSION)
    errors.push(`schemaVersion must be ${OBSERVABILITY_EVIDENCE_SCHEMA_VERSION}`);
  for (const key of ['evidenceId', 'kind'])
    if (!isNonEmptyString(value[key])) errors.push(`${key} is required`);
  if (!isIsoDate(value.createdAt)) errors.push('createdAt must be an ISO timestamp');
  if (value.immutable !== true) errors.push('immutable must be true');
  validateContext(value.context, errors);
  const files = Array.isArray(value.files) ? value.files : [];
  if (!Array.isArray(value.files) || files.length === 0) errors.push('files must be non-empty');
  for (const [index, rawFile] of files.entries()) {
    const file = asObject(rawFile);
    if (!file) {
      errors.push(`files[${index}] must be an object`);
      continue;
    }
    if (!isNonEmptyString(file.role)) errors.push(`files[${index}].role is required`);
    if (!isNonEmptyString(file.uri, 2048)) errors.push(`files[${index}].uri is required`);
    if (!isSha256(file.sha256)) errors.push(`files[${index}].sha256 is invalid`);
    if (!Number.isSafeInteger(file.bytes) || Number(file.bytes) < 0)
      errors.push(`files[${index}].bytes is invalid`);
  }
  return { valid: errors.length === 0, errors };
}

export function validateEdgeCommandRequest(
  input: unknown,
  now = Date.now(),
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const value = asObject(input);
  if (!value) return { valid: false, errors: ['command request must be an object'] };
  if (value.schemaVersion !== OBSERVABILITY_COMMAND_SCHEMA_VERSION)
    errors.push(`schemaVersion must be ${OBSERVABILITY_COMMAND_SCHEMA_VERSION}`);
  for (const key of ['commandId', 'capabilityId', 'deviceId', 'projectId', 'requestedBy'])
    if (!isNonEmptyString(value[key])) errors.push(`${key} is required`);
  if (!isIsoDate(value.issuedAt)) errors.push('issuedAt must be an ISO timestamp');
  if (!isIsoDate(value.expiresAt)) errors.push('expiresAt must be an ISO timestamp');
  if (isIsoDate(value.expiresAt) && Date.parse(String(value.expiresAt)) <= now)
    errors.push('expiresAt must be in the future');
  if (!['read-only', 'diagnostic', 'controlled-write'].includes(String(value.sideEffect)))
    errors.push('sideEffect is invalid');
  if (value.sideEffect === 'controlled-write' && !isNonEmptyString(value.approvalRef))
    errors.push('controlled-write requires approvalRef');
  if (!asObject(value.parameters)) errors.push('parameters must be an object');
  return { valid: errors.length === 0, errors };
}
