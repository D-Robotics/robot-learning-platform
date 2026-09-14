import { createHash } from 'node:crypto';
import { type Request, type Response, type Router } from 'express';

import type { Device } from '../../shared/types.js';
import {
  SIM2REAL_CONTRACT_LIMITS,
  type Sim2RealEvaluationSummary,
  type Sim2RealActionOutput,
  type Sim2RealTelemetryActionScale,
  type Sim2RealTelemetryBoardSessionEvent,
  type Sim2RealTelemetryBoardSessionEventKind,
  type Sim2RealTelemetryRecord,
  type Sim2RealTelemetrySample,
  type Sim2RealTelemetrySource,
  type Sim2RealTelemetryTwist,
} from '../../shared/sim2real.js';
import { sendApiError, wrapAsync } from '../sim2real/http-helpers.js';
import { setSim2RealAuditContext } from '../sim2real/audit-log.js';
import { requestOwnsDevice } from '../sim2real/standalone-adapters.js';
import { adviseRetraining } from '../sim2real/retraining-advisor.js';
import { buildBoardSessions } from '../sim2real/board-sessions.js';
import {
  appendSim2RealTelemetryWithResult,
  createSim2RealEvaluationWithResult,
  evaluateSim2RealRun,
  getSim2RealRun,
  getSim2RealModel,
  listSim2RealTelemetry,
  SIM2REAL_TELEMETRY_RECORD_CAP,
} from '../sim2real/sim2real-store.js';
import type { Sim2RealAuthPort } from '../sim2real/sim2real-auth.js';
import {
  readSim2RealBearerToken,
  verifySim2RealTelemetryAttestationTokenDetailed,
  type Sim2RealTelemetryAttestationClaims,
} from '../sim2real/telemetry-attestation.js';

type OwnedDevice = Device & { bridgeOwnerKey?: string };
type OwnerResolver = (request: Request, response: Response) => string | undefined | null;
type StorageError = (request: Request, response: Response, error: unknown, scope: string) => void;

export type Sim2RealTelemetryIdentity = {
  owner?: string;
  attested: boolean;
  claims?: Sim2RealTelemetryAttestationClaims;
};

export interface Sim2RealTelemetryIdentityContext {
  runId?: string;
  deviceId?: string;
}

/**
 * Optional deployment-owned identity hook.  A service embedding the router
 * can provide its own key-management/HSM verifier while retaining the same
 * route binding rules. Returning `undefined` delegates to the built-in HMAC
 * verifier; returning an identity makes the hook authoritative for this
 * Bearer request.
 */
export type Sim2RealTelemetryIdentityResolver = (
  request: Request,
  binding: Sim2RealTelemetryIdentityContext,
) =>
  | Sim2RealTelemetryIdentity
  | null
  | undefined
  | Promise<Sim2RealTelemetryIdentity | null | undefined>;

export interface Sim2RealTelemetryRouteDeps {
  auth: Sim2RealAuthPort;
  requestOwner: OwnerResolver;
  visibleDevices: (owner?: string) => Promise<readonly OwnedDevice[]>;
  /** Optional owner-scoped tunnel resolver for deployments with board agents. */
  resolveDeviceAgentUrl?: (deviceId: string, owner?: string) => string | null;
  storageError: StorageError;
  /** Optional external verifier; the local HMAC verifier remains the default. */
  resolveTelemetryIdentity?: Sim2RealTelemetryIdentityResolver;
}

export interface Sim2RealTelemetryRouteOptions {
  /** API prefix supplied by the owning Sim2Real router. */
  prefix?: string;
}

const DEFAULT_SIM2REAL_API_PREFIX = '/api/sim2real';

function normalizeTelemetryApiPrefix(value: string | undefined): string {
  const prefix = String(value ?? DEFAULT_SIM2REAL_API_PREFIX).trim();
  if (!/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(prefix)) {
    throw new Error(`Invalid Sim2Real telemetry API prefix: ${prefix}`);
  }
  return prefix;
}

/**
 * Validation failure raised from the atomic evaluation callback.  It is kept
 * distinct from storage/runner errors so the route can preserve its existing
 * deterministic 409 response without accidentally persisting a partial
 * evaluation.
 */
class Sim2RealEvaluationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Sim2RealEvaluationValidationError';
  }
}

const TELEMETRY_SAMPLE_CAP = 5_000;
// Keep transport validation aligned with the manifest contract limits.  The
// browser and board adapters may use small vectors today, but RDK Duck
// contracts are explicitly allowed to declare up to 4096 dimensions; a
// smaller transport cap would make those otherwise-valid contracts
// impossible to evaluate.
const TELEMETRY_VECTOR_CAP = Math.max(
  SIM2REAL_CONTRACT_LIMITS.maxObservationSize,
  SIM2REAL_CONTRACT_LIMITS.maxActionSize,
);
const TELEMETRY_BODY_CAP = 2_000_000;
const SAFE_TELEMETRY_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const SAFE_TELEMETRY_OWNER = /^[^\u0000-\u001f\u007f/]{1,160}$/;
const SAFE_IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,128}$/;
// These are the same conservative limits enforced by the OriginBot board
// runtime.  Telemetry is evidence, so accepting a value outside the actuator
// envelope would make replay/calibration disagree with the command path.
const TELEMETRY_CMD_VEL_LIMITS = Object.freeze({ linear: 0.3, angular: 1 });
const TELEMETRY_ACTION_SCALE_LIMITS = Object.freeze({ linear: 0.3, angular: 1 });
const TELEMETRY_CONTROL_HZ_LIMITS = Object.freeze({ min: 1, max: 50 });
const TELEMETRY_CONTROL_PERIOD_LIMITS = Object.freeze({ min: 0.02, max: 1 });
const TELEMETRY_ACTION_OUTPUTS = new Set<Sim2RealActionOutput>([
  'physical-twist',
  'normalized-twist',
]);
const TELEMETRY_EVENT_KINDS = new Set<Sim2RealTelemetryBoardSessionEventKind>([
  'session-started',
  'session-stopped',
]);
// The board runtime mints UUIDv4 session ids and truncates stop reasons to
// 120 characters; these caps mirror that producer contract.
const SAFE_SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/;
const SAFE_EVENT_ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const SAFE_EVENT_SHA256 = /^[a-f0-9]{64}$/;
// Control-data fields that must never ride on a lifecycle marker sample.
const EVENT_FORBIDDEN_SAMPLE_FIELDS = [
  'observation',
  'obs',
  'action',
  'reward',
  'done',
  'fall',
  'cmd_vel',
  'cmdVel',
] as const;

function noStore(response: Response): void {
  response.setHeader('Cache-Control', 'no-store');
}

function safeTelemetrySource(value: unknown): Sim2RealTelemetrySource | null {
  const source = String(value ?? '').trim();
  if (!['board-agent', 'browser', 'import', 'demo-fixture'].includes(source)) return null;
  return source as Sim2RealTelemetrySource;
}

function finiteVector(value: unknown, label: string): { value?: number[]; error?: string } {
  if (value == null) return {};
  if (!Array.isArray(value) || value.length > TELEMETRY_VECTOR_CAP) {
    return { error: `${label} must be an array with at most ${TELEMETRY_VECTOR_CAP} values` };
  }
  const values = value.map(Number);
  if (values.some((item) => !Number.isFinite(item) || Math.abs(item) > 1_000_000)) {
    return { error: `${label} contains a non-finite or out-of-range value` };
  }
  return { value: values };
}

function boundedTelemetryNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  integer = false,
): { value?: number; error?: string } {
  // Metadata is emitted as JSON numbers by the board runtime.  Reject strings,
  // booleans and coercible garbage here instead of silently changing the
  // physical units during an audit/replay.
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (integer && !Number.isSafeInteger(value)) ||
    value < minimum ||
    value > maximum
  ) {
    const kind = integer ? 'an integer' : 'a finite number';
    return { error: `${label} must be ${kind} between ${minimum} and ${maximum}` };
  }
  return { value };
}

function normalizeTelemetryTwist(
  value: unknown,
  label: string,
): { value?: Sim2RealTelemetryTwist; error?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: `${label} must be an object with linear and angular values` };
  }
  const source = value as Record<string, unknown>;
  const linear = boundedTelemetryNumber(
    source.linear,
    `${label}.linear`,
    -TELEMETRY_CMD_VEL_LIMITS.linear,
    TELEMETRY_CMD_VEL_LIMITS.linear,
  );
  const angular = boundedTelemetryNumber(
    source.angular,
    `${label}.angular`,
    -TELEMETRY_CMD_VEL_LIMITS.angular,
    TELEMETRY_CMD_VEL_LIMITS.angular,
  );
  if (linear.error) return { error: linear.error };
  if (angular.error) return { error: angular.error };
  return { value: { linear: linear.value!, angular: angular.value! } };
}

function normalizeTelemetryActionScale(
  value: unknown,
  label: string,
): { value?: Sim2RealTelemetryActionScale; error?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: `${label} must be an object with linear and angular values` };
  }
  const source = value as Record<string, unknown>;
  const linear = boundedTelemetryNumber(
    source.linear,
    `${label}.linear`,
    Number.EPSILON,
    TELEMETRY_ACTION_SCALE_LIMITS.linear,
  );
  const angular = boundedTelemetryNumber(
    source.angular,
    `${label}.angular`,
    Number.EPSILON,
    TELEMETRY_ACTION_SCALE_LIMITS.angular,
  );
  if (linear.error) return { error: linear.error };
  if (angular.error) return { error: angular.error };
  if (source.units != null && source.units !== 'm/s,rad/s') {
    return { error: `${label}.units must be m/s,rad/s` };
  }
  return {
    value: {
      linear: linear.value!,
      angular: angular.value!,
      ...(source.units != null ? { units: 'm/s,rad/s' } : {}),
    },
  };
}

function boundedEventNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  integer = true,
): { value?: number; error?: string } {
  return boundedTelemetryNumber(value, label, minimum, maximum, integer);
}

function boundedEventString(
  value: unknown,
  label: string,
  maxLength: number,
  pattern?: RegExp,
): { value?: string; error?: string } {
  const text = String(value ?? '').trim();
  if (!text) return {};
  if (text.length > maxLength) {
    return { error: `${label} must be at most ${maxLength} characters` };
  }
  if (pattern && !pattern.test(text)) {
    return { error: `${label} format is invalid` };
  }
  return { value: text };
}

function normalizeTelemetryBoardSessionEvent(
  value: unknown,
  index: number,
): { event?: Sim2RealTelemetryBoardSessionEvent; error?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: `samples[${index}].event must be an object` };
  }
  const source = value as Record<string, unknown>;
  const kind = String(source.kind ?? '').trim() as Sim2RealTelemetryBoardSessionEventKind;
  if (!TELEMETRY_EVENT_KINDS.has(kind)) {
    return {
      error: `samples[${index}].event.kind must be session-started or session-stopped`,
    };
  }
  const event: Sim2RealTelemetryBoardSessionEvent = { kind };
  const sessionId = boundedEventString(
    source.sessionId,
    `samples[${index}].event.sessionId`,
    64,
    SAFE_SESSION_ID,
  );
  if (sessionId.error) return { error: sessionId.error };
  if (sessionId.value) event.sessionId = sessionId.value;
  for (const field of ['startedAt', 'stoppedAt', 'lastInferenceAt'] as const) {
    if (source[field] == null) continue;
    const stamp = boundedEventString(
      source[field],
      `samples[${index}].event.${field}`,
      32,
      SAFE_EVENT_ISO_TIMESTAMP,
    );
    if (stamp.error) return { error: stamp.error };
    if (stamp.value) event[field] = stamp.value;
  }
  const stopReason = boundedEventString(
    source.stopReason,
    `samples[${index}].event.stopReason`,
    120,
  );
  if (stopReason.error) return { error: stopReason.error };
  if (stopReason.value) event.stopReason = stopReason.value;
  const adapterId = boundedEventString(source.adapterId, `samples[${index}].event.adapterId`, 80);
  if (adapterId.error) return { error: adapterId.error };
  if (adapterId.value) event.adapterId = adapterId.value;
  for (const field of ['inferenceCount', 'published'] as const) {
    if (source[field] == null) continue;
    const number = boundedEventNumber(
      source[field],
      `samples[${index}].event.${field}`,
      0,
      2_000_000_000,
    );
    if (number.error) return { error: number.error };
    event[field] = number.value;
  }
  for (const field of ['durationSec'] as const) {
    if (source[field] == null) continue;
    const number = boundedEventNumber(
      source[field],
      `samples[${index}].event.${field}`,
      0,
      86_400,
      false,
    );
    if (number.error) return { error: number.error };
    event[field] = number.value;
  }
  if (source.inferMs != null) {
    const inferMs = boundedEventNumber(
      source.inferMs,
      `samples[${index}].event.inferMs`,
      0,
      10_000,
      false,
    );
    if (inferMs.error) return { error: inferMs.error };
    event.inferMs = inferMs.value;
  }
  if (source.controlHz != null) {
    const controlHz = boundedEventNumber(
      source.controlHz,
      `samples[${index}].event.controlHz`,
      TELEMETRY_CONTROL_HZ_LIMITS.min,
      TELEMETRY_CONTROL_HZ_LIMITS.max,
    );
    if (controlHz.error) return { error: controlHz.error };
    event.controlHz = controlHz.value;
  }
  if (source.mock != null) {
    if (typeof source.mock !== 'boolean') {
      return { error: `samples[${index}].event.mock must be boolean` };
    }
    event.mock = source.mock;
  }
  if (source.model != null) {
    if (!source.model || typeof source.model !== 'object' || Array.isArray(source.model)) {
      return { error: `samples[${index}].event.model must be an object` };
    }
    const modelSource = source.model as Record<string, unknown>;
    const model: NonNullable<Sim2RealTelemetryBoardSessionEvent['model']> = {};
    const sha256 = boundedEventString(
      modelSource.sha256,
      `samples[${index}].event.model.sha256`,
      64,
      SAFE_EVENT_SHA256,
    );
    if (sha256.error) return { error: sha256.error };
    if (sha256.value) model.sha256 = sha256.value;
    const provider = boundedEventString(
      modelSource.provider,
      `samples[${index}].event.model.provider`,
      64,
    );
    if (provider.error) return { error: provider.error };
    if (provider.value) model.provider = provider.value;
    for (const field of ['inputDim', 'outputDim'] as const) {
      if (modelSource[field] == null) continue;
      const dimension = boundedEventNumber(
        modelSource[field],
        `samples[${index}].event.model.${field}`,
        1,
        SIM2REAL_CONTRACT_LIMITS.maxObservationSize,
      );
      if (dimension.error) return { error: dimension.error };
      model[field] = dimension.value;
    }
    if (modelSource.bytes != null) {
      const bytes = boundedEventNumber(
        modelSource.bytes,
        `samples[${index}].event.model.bytes`,
        0,
        2_000_000_000,
      );
      if (bytes.error) return { error: bytes.error };
      model.bytes = bytes.value;
    }
    if (Object.keys(model).length) event.model = model;
  }
  // A session marker without a sessionId cannot be correlated to a board
  // session; refusing it here keeps the aggregate honest instead of silently
  // dropping telemetry in the board-sessions endpoint.
  if (!event.sessionId) {
    return { error: `samples[${index}].event.sessionId is required for a lifecycle marker` };
  }
  return { event };
}

function normalizeTelemetrySample(
  value: unknown,
  index: number,
): { sample?: Sim2RealTelemetrySample; error?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: `samples[${index}] must be an object` };
  }
  const source = value as Record<string, unknown>;
  // `time` is emitted by a few simulator/exporter versions; keep the
  // canonical stored field as `t` while accepting the timestamp aliases at
  // the HTTP boundary for backwards compatibility.
  const t = Number(source.t ?? source.time ?? source.timestamp);
  if (!Number.isFinite(t) || t < 0 || t > 86_400) {
    return { error: `samples[${index}].t must be between 0 and 86400 seconds` };
  }
  if (source.event != null) {
    // Lifecycle markers are pure events: control data on the same sample
    // would blur the boundary between "what the robot did" (counted by
    // replay statistics) and "what happened to the session" (aggregated by
    // /runs/:id/board-sessions). Reject the mix instead of guessing.
    for (const field of EVENT_FORBIDDEN_SAMPLE_FIELDS) {
      if (source[field] != null) {
        return {
          error: `samples[${index}].event 样本不能同时携带 ${field} 控制数据`,
        };
      }
    }
    const normalizedEvent = normalizeTelemetryBoardSessionEvent(source.event, index);
    if (normalizedEvent.error || !normalizedEvent.event) {
      return { error: normalizedEvent.error };
    }
    return { sample: { t, event: normalizedEvent.event } };
  }
  const observation = finiteVector(
    source.observation ?? source.obs,
    `samples[${index}].observation`,
  );
  const action = finiteVector(source.action, `samples[${index}].action`);
  if (observation.error) return { error: observation.error };
  if (action.error) return { error: action.error };
  const sample: Sim2RealTelemetrySample = {
    t,
    ...(observation.value ? { observation: observation.value } : {}),
    ...(action.value ? { action: action.value } : {}),
  };
  if (source.reward != null) {
    const reward = Number(source.reward);
    if (!Number.isFinite(reward) || Math.abs(reward) > 1_000_000) {
      return { error: `samples[${index}].reward must be finite and in range` };
    }
    sample.reward = reward;
  }
  for (const name of ['done', 'fall'] as const) {
    if (source[name] != null) {
      if (typeof source[name] !== 'boolean')
        return { error: `samples[${index}].${name} must be boolean` };
      sample[name] = source[name] as boolean;
    }
  }
  // `cmd_vel` is the canonical spool key.  `cmdVel` is accepted only as a
  // compatibility alias for older browser exports and is normalized away.
  const rawCmdVel = source.cmd_vel ?? source.cmdVel;
  if (rawCmdVel != null) {
    const cmdVel = normalizeTelemetryTwist(rawCmdVel, `samples[${index}].cmd_vel`);
    if (cmdVel.error) return { error: cmdVel.error };
    sample.cmd_vel = cmdVel.value;
  }
  if (source.actionOutput != null) {
    if (typeof source.actionOutput !== 'string') {
      return { error: `samples[${index}].actionOutput must be physical-twist or normalized-twist` };
    }
    const actionOutput = source.actionOutput.trim().toLowerCase() as Sim2RealActionOutput;
    if (!TELEMETRY_ACTION_OUTPUTS.has(actionOutput)) {
      return { error: `samples[${index}].actionOutput must be physical-twist or normalized-twist` };
    }
    sample.actionOutput = actionOutput;
  }
  if (source.actionScale != null) {
    const actionScale = normalizeTelemetryActionScale(
      source.actionScale,
      `samples[${index}].actionScale`,
    );
    if (actionScale.error) return { error: actionScale.error };
    sample.actionScale = actionScale.value;
  }
  if (source.controlHz != null) {
    const controlHz = boundedTelemetryNumber(
      source.controlHz,
      `samples[${index}].controlHz`,
      TELEMETRY_CONTROL_HZ_LIMITS.min,
      TELEMETRY_CONTROL_HZ_LIMITS.max,
      true,
    );
    if (controlHz.error) return { error: controlHz.error };
    sample.controlHz = controlHz.value;
  }
  if (source.controlPeriodSeconds != null) {
    const controlPeriodSeconds = boundedTelemetryNumber(
      source.controlPeriodSeconds,
      `samples[${index}].controlPeriodSeconds`,
      TELEMETRY_CONTROL_PERIOD_LIMITS.min,
      TELEMETRY_CONTROL_PERIOD_LIMITS.max,
    );
    if (controlPeriodSeconds.error) return { error: controlPeriodSeconds.error };
    sample.controlPeriodSeconds = controlPeriodSeconds.value;
  }
  return { sample };
}

function parseTelemetryBody(body: unknown): {
  samples?: Sim2RealTelemetrySample[];
  error?: string;
} {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'telemetry payload must be a JSON object' };
  }
  const source = body as Record<string, unknown>;
  let rawSamples: unknown[];
  if (Array.isArray(source.samples)) rawSamples = source.samples;
  else if (typeof source.jsonl === 'string') {
    if (source.jsonl.length > TELEMETRY_BODY_CAP) return { error: 'jsonl payload is too large' };
    const lines = source.jsonl.split(/\r?\n/).filter((line) => line.trim());
    if (lines.length > TELEMETRY_SAMPLE_CAP)
      return { error: `at most ${TELEMETRY_SAMPLE_CAP} samples are accepted per chunk` };
    rawSamples = [];
    for (const [index, line] of lines.entries()) {
      try {
        rawSamples.push(JSON.parse(line));
      } catch {
        return { error: `jsonl line ${index + 1} is not valid JSON` };
      }
    }
  } else return { error: 'samples[] or jsonl is required' };
  if (rawSamples.length === 0) return { error: 'at least one telemetry sample is required' };
  if (rawSamples.length > TELEMETRY_SAMPLE_CAP)
    return { error: `at most ${TELEMETRY_SAMPLE_CAP} samples are accepted per chunk` };
  const samples: Sim2RealTelemetrySample[] = [];
  let previousT = -Infinity;
  for (const [index, item] of rawSamples.entries()) {
    const normalized = normalizeTelemetrySample(item, index);
    if (normalized.error || !normalized.sample) return { error: normalized.error };
    if (normalized.sample.t < previousT)
      return { error: 'samples must be ordered by non-decreasing t' };
    previousT = normalized.sample.t;
    samples.push(normalized.sample);
  }
  return { samples };
}

function safeNonNegativeInteger(value: unknown, label: string): { value?: number; error?: string } {
  if (value == null || value === '') return {};
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 2_000_000_000) {
    return { error: `${label} must be an integer between 0 and 2000000000` };
  }
  return { value: parsed };
}

function requestIdempotencyKey(
  request: Request,
  body: Record<string, unknown>,
): { value?: string; error?: string } {
  const rawHeader = request.headers['idempotency-key'];
  const header = Array.isArray(rawHeader)
    ? rawHeader.join(',').trim()
    : String(rawHeader ?? '').trim();
  const bodyValue = body.idempotencyKey == null ? '' : String(body.idempotencyKey).trim();
  if (header && !SAFE_IDEMPOTENCY_KEY.test(header)) {
    return { error: 'Idempotency-Key 请求头格式无效' };
  }
  if (bodyValue && !SAFE_IDEMPOTENCY_KEY.test(bodyValue)) {
    return { error: 'idempotencyKey 格式无效' };
  }
  if (header && bodyValue && header !== bodyValue) {
    return { error: 'Idempotency-Key 请求头与 body.idempotencyKey 不一致' };
  }
  return { value: header || bodyValue || undefined };
}

function validateContractDimensions(
  samples: readonly Sim2RealTelemetrySample[],
  contract: { observationSize: number; actionSize: number },
): string | undefined {
  for (const [index, sample] of samples.entries()) {
    if (sample.observation && sample.observation.length !== contract.observationSize) {
      return `samples[${index}].observation must contain exactly ${contract.observationSize} values`;
    }
    if (sample.action && sample.action.length !== contract.actionSize) {
      return `samples[${index}].action must contain exactly ${contract.actionSize} values`;
    }
  }
  return undefined;
}

function telemetryFingerprint(input: {
  runId: string;
  modelId: string;
  source: Sim2RealTelemetrySource;
  deviceId?: string;
  contractId?: string;
  sequence?: number;
  droppedCount?: number;
  attested?: boolean;
  samples: readonly Sim2RealTelemetrySample[];
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        runId: input.runId,
        modelId: input.modelId,
        source: input.source,
        deviceId: input.deviceId || null,
        contractId: input.contractId || null,
        sequence: input.sequence ?? null,
        droppedCount: input.droppedCount ?? null,
        attested: input.attested === true,
        samples: input.samples,
      }),
    )
    .digest('hex');
}

function vectorErrors(
  actual: readonly Sim2RealTelemetrySample[],
  reference: readonly Sim2RealTelemetrySample[],
  field: 'action' | 'observation',
): { mae?: number; rmse?: number } {
  let count = 0;
  let absolute = 0;
  let square = 0;
  const pairCount = Math.min(actual.length, reference.length);
  for (let index = 0; index < pairCount; index += 1) {
    const left = actual[index]?.[field];
    const right = reference[index]?.[field];
    if (!left || !right) continue;
    // Contract dimensions are validated before evaluation. Keep this guard as
    // a second line of defence for legacy ledger records so a malformed pair
    // never produces a deceptively small MAE/RMSE.
    if (left.length !== right.length) continue;
    const dimensions = left.length;
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      const error = Number(left[dimension]) - Number(right[dimension]);
      absolute += Math.abs(error);
      square += error * error;
      count += 1;
    }
  }
  return count ? { mae: absolute / count, rmse: Math.sqrt(square / count) } : {};
}

function buildEvaluation(
  records: readonly Sim2RealTelemetryRecord[],
  reference: readonly Sim2RealTelemetrySample[] | undefined,
): Sim2RealEvaluationSummary {
  const orderedRecords = [...records].sort(
    (left, right) =>
      (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER) ||
      left.receivedAt.localeCompare(right.receivedAt),
  );
  // Lifecycle event markers ride the same chunks but are not control data:
  // replay statistics (counts, rates, terminations, error metrics) describe
  // what the robot did, while session markers are aggregated separately by
  // /runs/:id/board-sessions.
  const samples = orderedRecords
    .flatMap((record) => record.samples)
    .filter((sample) => !sample.event);
  const first = samples[0]?.t;
  const last = samples.at(-1)?.t;
  const duration = first != null && last != null ? Math.max(0, last - first) : 0;
  // A run can receive more than one chunk, and older clients did not enforce
  // a single provenance value across those chunks.  If any chunk is the
  // built-in presentation fixture, classify the complete replay as synthetic
  // so a page refresh cannot turn a mixed run into apparently real evidence.
  const sources = [...new Set(orderedRecords.map((record) => record.source))];
  const boardRecords = orderedRecords.filter((record) => record.source === 'board-agent');
  const boardDeviceIds = [
    ...new Set(boardRecords.map((record) => String(record.deviceId ?? '').trim()).filter(Boolean)),
  ];
  const boardRunIds = [...new Set(boardRecords.map((record) => record.runId))];
  const boardModelIds = [...new Set(boardRecords.map((record) => record.modelId))];
  const boardContractIds = [
    ...new Set(
      boardRecords.map((record) => String(record.contractId ?? '').trim()).filter(Boolean),
    ),
  ];
  const replaySource = sources.includes('demo-fixture')
    ? 'demo-fixture'
    : sources.length === 1
      ? sources[0]
      : 'import';
  const replayAttested =
    sources.length === 1 &&
    sources[0] === 'board-agent' &&
    boardRecords.length > 0 &&
    boardDeviceIds.length === 1 &&
    boardRunIds.length === 1 &&
    boardModelIds.length === 1 &&
    boardContractIds.length <= 1 &&
    orderedRecords.length > 0 &&
    orderedRecords.every((record) => record.attested === true);
  const rewardValues = samples
    .map((sample) => sample.reward)
    .filter((value): value is number => value != null);
  const replay = {
    sampleCount: samples.length,
    durationSeconds: duration,
    ...(duration > 0 && samples.length > 1
      ? { sampleRateHz: (samples.length - 1) / duration }
      : {}),
    ...(first == null ? {} : { firstTimestamp: first }),
    ...(last == null ? {} : { lastTimestamp: last }),
    source: replaySource,
    attested: replayAttested,
    ...(replayAttested ? { deviceId: boardDeviceIds[0] } : {}),
    chunkCount: orderedRecords.length,
    droppedCount: orderedRecords.reduce((sum, record) => sum + (record.droppedCount ?? 0), 0),
    ...(rewardValues.length
      ? { rewardMean: rewardValues.reduce((sum, value) => sum + value, 0) / rewardValues.length }
      : {}),
    doneCount: samples.filter((sample) => sample.done === true).length,
    fallCount: samples.filter((sample) => sample.fall === true).length,
  };
  const warnings: string[] = [];
  if (!samples.length) warnings.push('no telemetry samples were available');
  if (!samples.some((sample) => sample.action))
    warnings.push('action vectors are missing; action error was not calculated');
  if (reference && reference.length !== samples.length)
    warnings.push('reference and telemetry sample counts differ; paired prefix was evaluated');
  if (replay.droppedCount > 0)
    warnings.push(`${replay.droppedCount} source samples were reported as dropped`);
  const declaredControlHz = [
    ...new Set(
      samples.map((sample) => sample.controlHz).filter((value): value is number => value != null),
    ),
  ];
  const declaredPeriods = [
    ...new Set(
      samples
        .map((sample) => sample.controlPeriodSeconds)
        .filter((value): value is number => value != null),
    ),
  ];
  const actionOutputs = [
    ...new Set(
      samples
        .map((sample) => sample.actionOutput)
        .filter((value): value is Sim2RealActionOutput => value != null),
    ),
  ];
  const scaleKeys = [
    ...new Set(
      samples
        .map((sample) => {
          const scale = sample.actionScale;
          return scale ? `${scale.linear}:${scale.angular}:${scale.units ?? ''}` : null;
        })
        .filter((value): value is string => value != null),
    ),
  ];
  if (declaredControlHz.length > 1 || declaredPeriods.length > 1)
    warnings.push(
      'telemetry samples declare mixed control rates/periods; replay timing is review-only',
    );
  if (actionOutputs.length > 1 || scaleKeys.length > 1)
    warnings.push(
      'telemetry samples declare mixed action units/scales; calibration must be reviewed before deployment',
    );
  if (declaredControlHz.length === 1 && duration > 0 && samples.length > 1) {
    const observedRate = (samples.length - 1) / duration;
    if (Math.abs(observedRate - declaredControlHz[0]) > Math.max(1, declaredControlHz[0] * 0.15))
      warnings.push(
        `observed sample rate ${observedRate.toFixed(2)}Hz differs from declared ${declaredControlHz[0]}Hz`,
      );
  }
  if (sources.length > 1) {
    warnings.push(
      `telemetry chunks contain mixed sources (${sources.join(', ')}); replay provenance is classified conservatively as ${replaySource}`,
    );
  }
  if (sources.length === 1 && sources[0] === 'board-agent' && boardDeviceIds.length !== 1) {
    warnings.push(
      'board-agent chunks are missing a single consistent deviceId; replay is review-only',
    );
  }
  if (sources.includes('board-agent') && !replayAttested) {
    warnings.push('board-agent replay is not server-attested; it is review-only evidence');
  }
  const action = reference ? vectorErrors(samples, reference, 'action') : {};
  const observation = reference ? vectorErrors(samples, reference, 'observation') : {};
  return {
    evaluatedAt: new Date().toISOString(),
    sampleCount: samples.length,
    ...(reference ? { referenceSampleCount: reference.length } : {}),
    ...(action.mae == null ? {} : { actionMae: action.mae }),
    ...(action.rmse == null ? {} : { actionRmse: action.rmse }),
    ...(observation.mae == null ? {} : { observationMae: observation.mae }),
    ...(observation.rmse == null ? {} : { observationRmse: observation.rmse }),
    replay,
    warnings,
  };
}

function findVisibleDevice(devices: readonly OwnedDevice[], id: string): OwnedDevice | null {
  return devices.find((device) => device.id === id.trim()) ?? null;
}

/**
 * Resolve the upload identity at the telemetry boundary.
 *
 * Cookie/SSO ownership remains the default path for existing clients.  A
 * board agent may instead send a short-lived HMAC Bearer token; in that case
 * the owner comes from verified claims and no cookie is required.  If both
 * credentials are present they must identify the same account, otherwise a
 * copied token must not be usable from another logged-in tenant.
 */
async function resolveTelemetryIdentity(
  request: Request,
  response: Response,
  deps: Sim2RealTelemetryRouteDeps,
  binding: Sim2RealTelemetryIdentityContext = {},
): Promise<Sim2RealTelemetryIdentity | null> {
  const bearer = readSim2RealBearerToken(request);
  if (bearer.present) {
    noStore(response);
    if (bearer.malformed || !bearer.token) {
      sendApiError(
        response,
        401,
        'SIM2REAL_TELEMETRY_ATTESTATION_INVALID',
        '遥测 Bearer attestation 格式无效。',
        { retryable: false },
      );
      return null;
    }
    if (deps.resolveTelemetryIdentity) {
      try {
        const delegated = await deps.resolveTelemetryIdentity(request, binding);
        if (delegated !== undefined) {
          if (
            !delegated ||
            delegated.attested !== true ||
            !delegated.owner ||
            !SAFE_TELEMETRY_OWNER.test(delegated.owner)
          ) {
            sendApiError(
              response,
              401,
              'SIM2REAL_TELEMETRY_ATTESTATION_INVALID',
              '遥测 Bearer attestation 无效或已过期。',
              { retryable: false },
            );
            return null;
          }
          const principal = deps.auth.resolvePrincipal(request);
          if (principal && String(principal.accountId ?? '').trim() !== delegated.owner) {
            sendApiError(
              response,
              403,
              'SIM2REAL_TELEMETRY_ATTESTATION_OWNER_MISMATCH',
              '遥测 attestation 与当前登录账号不匹配。',
              { retryable: false },
            );
            return null;
          }
          const claims = delegated.claims;
          if (
            !claims ||
            claims.owner !== delegated.owner ||
            !SAFE_TELEMETRY_OWNER.test(claims.owner) ||
            !SAFE_TELEMETRY_ID.test(claims.runId) ||
            !SAFE_TELEMETRY_ID.test(claims.deviceId) ||
            (binding.runId !== undefined && claims.runId !== binding.runId) ||
            (binding.deviceId !== undefined && claims.deviceId !== binding.deviceId)
          ) {
            sendApiError(
              response,
              401,
              'SIM2REAL_TELEMETRY_ATTESTATION_INVALID',
              '遥测 Bearer attestation 绑定无效。',
              { retryable: false },
            );
            return null;
          }
          return delegated;
        }
      } catch {
        sendApiError(
          response,
          401,
          'SIM2REAL_TELEMETRY_ATTESTATION_INVALID',
          '遥测 Bearer attestation 无效或已过期。',
          { retryable: false },
        );
        return null;
      }
    }
    const verified = verifySim2RealTelemetryAttestationTokenDetailed(bearer.token);
    if (!verified.valid) {
      // Keep the wire response intentionally generic.  Detailed reasons stay
      // in the verifier for metrics/logging hooks and should not help an
      // attacker distinguish an expired key from a bad signature.
      sendApiError(
        response,
        401,
        'SIM2REAL_TELEMETRY_ATTESTATION_INVALID',
        '遥测 Bearer attestation 无效或已过期。',
        { retryable: false },
      );
      return null;
    }
    const principal = deps.auth.resolvePrincipal(request);
    if (principal) {
      const principalOwner = String(principal.accountId ?? '').trim();
      if (!principalOwner || principalOwner !== verified.claims.owner) {
        sendApiError(
          response,
          403,
          'SIM2REAL_TELEMETRY_ATTESTATION_OWNER_MISMATCH',
          '遥测 attestation 与当前登录账号不匹配。',
          { retryable: false },
        );
        return null;
      }
    }
    return { owner: verified.claims.owner, attested: true, claims: verified.claims };
  }

  const owner = deps.requestOwner(request, response);
  if (owner === null) return null;
  return { owner, attested: false };
}

function attestationBindingError(
  response: Response,
  field: 'runId' | 'deviceId' | 'sequence',
): void {
  sendApiError(
    response,
    403,
    'SIM2REAL_TELEMETRY_ATTESTATION_BINDING_MISMATCH',
    `遥测 attestation 的 ${field} 与请求不匹配。`,
    { retryable: false },
  );
}

export function registerSim2RealTelemetryRoutes(
  router: Router,
  deps: Sim2RealTelemetryRouteDeps,
  options: Sim2RealTelemetryRouteOptions = {},
): void {
  const prefix = normalizeTelemetryApiPrefix(options.prefix);
  const api = (suffix: string): string => `${prefix}${suffix}`;
  const ingestTelemetry = async (
    request: Request,
    response: Response,
    forcedRunId?: string,
  ): Promise<void> => {
    const body =
      request.body && typeof request.body === 'object' && !Array.isArray(request.body)
        ? (request.body as Record<string, unknown>)
        : {};
    const identity = await resolveTelemetryIdentity(request, response, deps, {
      runId: String(forcedRunId ?? body.runId ?? '').trim() || undefined,
      deviceId: String(body.deviceId ?? '').trim() || undefined,
    });
    if (!identity) return;
    const owner = identity.owner;
    // Preserve the verified upload identity for the generic audit middleware.
    // This is necessary for cookie-less board agents; only bounded identifiers
    // are attached and no bearer token or payload is retained.
    setSim2RealAuditContext(request, {
      ...(owner ? { owner } : {}),
      ...(identity.attested ? { attested: true } : {}),
      ...(identity.claims?.runId || forcedRunId || body.runId
        ? { runId: String(identity.claims?.runId ?? forcedRunId ?? body.runId).trim() }
        : {}),
      ...(identity.claims?.deviceId || body.deviceId
        ? { deviceId: String(identity.claims?.deviceId ?? body.deviceId).trim() }
        : {}),
    });
    noStore(response);
    const claimedRunId = identity.claims?.runId;
    const suppliedRunId = String(body.runId ?? '').trim();
    const pathRunId = String(forcedRunId ?? '').trim();
    if (claimedRunId && suppliedRunId && suppliedRunId !== claimedRunId) {
      attestationBindingError(response, 'runId');
      return;
    }
    if (claimedRunId && pathRunId && pathRunId !== claimedRunId) {
      attestationBindingError(response, 'runId');
      return;
    }
    const runId = claimedRunId || pathRunId || suppliedRunId;
    if (!runId || !SAFE_TELEMETRY_ID.test(runId)) {
      sendApiError(response, 400, 'SIM2REAL_INVALID_TELEMETRY', 'runId 格式无效', {
        retryable: false,
      });
      return;
    }
    const run = await getSim2RealRun(runId, owner);
    if (!run) {
      response.status(404).json({
        ok: false,
        error: 'SIM2REAL_RUN_NOT_FOUND',
        message: '运行记录不存在，或不属于当前账号。',
      });
      return;
    }
    const parsed = parseTelemetryBody(body);
    if (parsed.error || !parsed.samples) {
      sendApiError(response, 400, 'SIM2REAL_INVALID_TELEMETRY', parsed.error || '遥测数据无效', {
        retryable: false,
      });
      return;
    }
    // A token without an explicit source is the board-agent convenience form;
    // legacy no-token requests keep their historical `import` default.  An
    // explicit non-board source cannot be promoted to attested evidence.
    const source = safeTelemetrySource(
      body.source == null && identity.attested ? 'board-agent' : (body.source ?? 'import'),
    );
    if (!source) {
      sendApiError(
        response,
        400,
        'SIM2REAL_INVALID_TELEMETRY',
        'source 必须为 board-agent、browser、import 或 demo-fixture',
        { retryable: false },
      );
      return;
    }
    if (identity.attested && source !== 'board-agent') {
      sendApiError(
        response,
        403,
        'SIM2REAL_TELEMETRY_ATTESTATION_SOURCE_MISMATCH',
        'attestation token 只能用于 board-agent 遥测。',
        { retryable: false },
      );
      return;
    }
    const modelId = String(body.modelId ?? '').trim();
    if (modelId && modelId !== run.modelId) {
      response.status(409).json({
        ok: false,
        error: 'SIM2REAL_RUN_MODEL_MISMATCH',
        message: '遥测 modelId 与 run 不匹配。',
      });
      return;
    }
    const claimedDeviceId = identity.claims?.deviceId;
    const suppliedDeviceId = String(body.deviceId ?? '').trim();
    if (claimedDeviceId && suppliedDeviceId && suppliedDeviceId !== claimedDeviceId) {
      attestationBindingError(response, 'deviceId');
      return;
    }
    const deviceId = claimedDeviceId || suppliedDeviceId;
    if (deviceId && !SAFE_TELEMETRY_ID.test(deviceId)) {
      sendApiError(response, 400, 'SIM2REAL_INVALID_TELEMETRY', 'deviceId 格式无效', {
        retryable: false,
      });
      return;
    }
    if (source === 'board-agent' && !deviceId) {
      sendApiError(
        response,
        400,
        'SIM2REAL_INVALID_TELEMETRY',
        'board-agent 数据必须携带 deviceId',
        { retryable: false },
      );
      return;
    }
    if (source === 'board-agent' && deviceId) {
      const device = findVisibleDevice(await deps.visibleDevices(owner), deviceId);
      if (
        !device ||
        !requestOwnsDevice(
          request,
          device,
          owner ? `sso:${owner}:web` : null,
          deps.auth.isMultiUserDeployment(),
        )
      ) {
        response.status(404).json({
          ok: false,
          error: 'SIM2REAL_DEVICE_NOT_FOUND',
          message: '设备不存在，或不属于当前账号。',
        });
        return;
      }
    }
    const contractId = String(body.contractId ?? '').trim();
    if (contractId && !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(contractId)) {
      sendApiError(response, 400, 'SIM2REAL_INVALID_TELEMETRY', 'contractId 格式无效', {
        retryable: false,
      });
      return;
    }
    const model = await getSim2RealModel(run.modelId, owner);
    if (contractId) {
      if (model && contractId !== model.manifest.contract.id) {
        response.status(409).json({
          ok: false,
          error: 'SIM2REAL_CONTRACT_MISMATCH',
          message: '遥测 contractId 与训练模型契约不匹配。',
        });
        return;
      }
    }
    if (model) {
      const dimensionError = validateContractDimensions(parsed.samples, model.manifest.contract);
      if (dimensionError) {
        sendApiError(response, 400, 'SIM2REAL_CONTRACT_DIMENSION_MISMATCH', dimensionError, {
          retryable: false,
        });
        return;
      }
    }
    const sequence = safeNonNegativeInteger(body.sequence, 'sequence');
    if (sequence.error) {
      sendApiError(response, 400, 'SIM2REAL_INVALID_TELEMETRY', sequence.error, {
        retryable: false,
      });
      return;
    }
    if (identity.attested && sequence.value === undefined) {
      sendApiError(
        response,
        400,
        'SIM2REAL_TELEMETRY_SEQUENCE_REQUIRED',
        '受信 board-agent 遥测必须携带单调 sequence；缺少序号的数据只能作为 review-only 导入。',
        { retryable: false },
      );
      return;
    }
    if (identity.claims?.sequence !== undefined && sequence.value !== identity.claims.sequence) {
      attestationBindingError(response, 'sequence');
      return;
    }
    const droppedCount = safeNonNegativeInteger(body.droppedCount, 'droppedCount');
    if (droppedCount.error) {
      sendApiError(response, 400, 'SIM2REAL_INVALID_TELEMETRY', droppedCount.error, {
        retryable: false,
      });
      return;
    }
    const idempotency = requestIdempotencyKey(request, body);
    if (idempotency.error) {
      sendApiError(response, 400, 'SIM2REAL_INVALID_TELEMETRY', idempotency.error, {
        retryable: false,
      });
      return;
    }
    const idempotencyKey = idempotency.value;
    const normalizedTelemetry = {
      runId,
      modelId: run.modelId,
      source,
      ...(deviceId ? { deviceId } : {}),
      ...(contractId ? { contractId } : {}),
      ...(sequence.value == null ? {} : { sequence: sequence.value }),
      samples: parsed.samples,
      ...(droppedCount.value == null ? {} : { droppedCount: droppedCount.value }),
      // Never copy a client-supplied attested bit.  This value exists only
      // when the server has successfully verified the HMAC token above.
      ...(identity.attested ? { attested: true } : {}),
    };
    try {
      const appended = await appendSim2RealTelemetryWithResult(
        {
          ...normalizedTelemetry,
          ...(idempotencyKey ? { idempotencyKey } : {}),
          // Keep a private digest even when the caller omitted an HTTP
          // idempotency key. Attested board chunks use it for durable content
          // deduplication, so a retry cannot inflate release evidence by
          // choosing a fresh key or sequence number.
          _requestFingerprint: telemetryFingerprint({
            ...normalizedTelemetry,
            attested: identity.attested,
          }),
        },
        owner,
      );
      if (idempotencyKey) response.setHeader('Idempotency-Key', idempotencyKey);
      response.status(appended.duplicate ? 200 : 201).json({
        ok: true,
        telemetry: appended.telemetry,
        ...(appended.duplicate
          ? { duplicate: true }
          : { acceptedSamples: appended.telemetry.samples.length }),
      });
    } catch (error) {
      deps.storageError(request, response, error, 'sim2real-telemetry-ingest');
    }
  };

  router.post(
    api('/telemetry'),
    wrapAsync(async (request, response) => ingestTelemetry(request, response)),
  );
  router.post(
    api('/runs/:id/telemetry'),
    wrapAsync(async (request, response) =>
      ingestTelemetry(request, response, String(request.params.id || '').trim()),
    ),
  );
  router.get(
    api('/runs/:id/telemetry'),
    wrapAsync(async (request, response) => {
      const owner = deps.requestOwner(request, response);
      if (owner === null) return;
      noStore(response);
      const runId = String(request.params.id || '').trim();
      if (!(await getSim2RealRun(runId, owner))) {
        response.status(404).json({
          ok: false,
          error: 'SIM2REAL_RUN_NOT_FOUND',
          message: '运行记录不存在，或不属于当前账号。',
        });
        return;
      }
      const rawLimit = request.query.limit;
      const limit = Array.isArray(rawLimit) ? rawLimit[0] : rawLimit;
      const telemetry = await listSim2RealTelemetry(runId, owner, Number(limit) || 200);
      response.json({ ok: true, runId, telemetry, count: telemetry.length });
    }),
  );
  router.get(
    api('/runs/:id/replay'),
    wrapAsync(async (request, response) => {
      const owner = deps.requestOwner(request, response);
      if (owner === null) return;
      noStore(response);
      const runId = String(request.params.id || '').trim();
      const run = await getSim2RealRun(runId, owner);
      if (!run) {
        response.status(404).json({
          ok: false,
          error: 'SIM2REAL_RUN_NOT_FOUND',
          message: '运行记录不存在，或不属于当前账号。',
        });
        return;
      }
      // Evaluation/replay must consume every accepted chunk. The store's
      // record cap is an explicit rejection guard, never a silent truncation.
      const telemetry = await listSim2RealTelemetry(runId, owner, SIM2REAL_TELEMETRY_RECORD_CAP);
      const evaluation = run.evaluation ?? buildEvaluation(telemetry, undefined);
      // Expose the accepted raw samples alongside the aggregate summary so a
      // client can implement deterministic frame seeking without guessing at
      // shard storage. The endpoint is owner-scoped and bounded by the same
      // record cap used for evaluation. Lifecycle event samples are metadata,
      // not frames: a client seeking control frames must never receive them.
      const frames = telemetry
        .flatMap((chunk) => chunk.samples || [])
        .filter((sample) => !sample.event);
      response.json({ ok: true, runId, replay: evaluation.replay, evaluation, frames });
    }),
  );
  router.get(
    api('/runs/:id/retraining-advice'),
    wrapAsync(async (request, response) => {
      const owner = deps.requestOwner(request, response);
      if (owner === null) return;
      noStore(response);
      const runId = String(request.params.id || '').trim();
      const run = await getSim2RealRun(runId, owner);
      if (!run) {
        response.status(404).json({
          ok: false,
          error: 'SIM2REAL_RUN_NOT_FOUND',
          message: '运行记录不存在，或不属于当前账号。',
        });
        return;
      }
      const telemetry = await listSim2RealTelemetry(runId, owner, SIM2REAL_TELEMETRY_RECORD_CAP);
      const advice = adviseRetraining({ run, evaluation: run.evaluation, telemetry });
      response.json({ ok: true, advice });
    }),
  );
  router.get(
    api('/runs/:id/board-sessions'),
    wrapAsync(async (request, response) => {
      const owner = deps.requestOwner(request, response);
      if (owner === null) return;
      noStore(response);
      const runId = String(request.params.id || '').trim();
      const run = await getSim2RealRun(runId, owner);
      if (!run) {
        response.status(404).json({
          ok: false,
          error: 'SIM2REAL_RUN_NOT_FOUND',
          message: '运行记录不存在，或不属于当前账号。',
        });
        return;
      }
      // Session aggregation consumes every accepted chunk, matching the
      // replay/evaluation read path; the record cap is a rejection guard,
      // never a silent truncation.
      const telemetry = await listSim2RealTelemetry(runId, owner, SIM2REAL_TELEMETRY_RECORD_CAP);
      const sessions = buildBoardSessions(telemetry);
      response.json({ ok: true, runId, sessions, count: sessions.length });
    }),
  );
  router.post(
    api('/runs/:id/evaluate'),
    wrapAsync(async (request, response) => {
      const owner = deps.requestOwner(request, response);
      if (owner === null) return;
      noStore(response);
      const runId = String(request.params.id || '').trim();
      const run = await getSim2RealRun(runId, owner);
      if (!run) {
        response.status(404).json({
          ok: false,
          error: 'SIM2REAL_RUN_NOT_FOUND',
          message: '运行记录不存在，或不属于当前账号。',
        });
        return;
      }
      const body =
        request.body && typeof request.body === 'object' && !Array.isArray(request.body)
          ? (request.body as Record<string, unknown>)
          : {};
      const evaluationIdempotency = requestIdempotencyKey(request, body);
      if (evaluationIdempotency.error) {
        sendApiError(response, 400, 'SIM2REAL_INVALID_EVALUATION', evaluationIdempotency.error, {
          retryable: false,
        });
        return;
      }
      let reference: Sim2RealTelemetrySample[] | undefined;
      if (Object.prototype.hasOwnProperty.call(body, 'referenceSamples')) {
        const parsed = parseTelemetryBody({ samples: body.referenceSamples });
        if (parsed.error || !parsed.samples) {
          sendApiError(
            response,
            400,
            'SIM2REAL_INVALID_REFERENCE',
            parsed.error || '参考轨迹无效',
            { retryable: false },
          );
          return;
        }
        reference = parsed.samples;
      } else if (typeof body.referenceJsonl === 'string') {
        const parsed = parseTelemetryBody({ jsonl: body.referenceJsonl });
        if (parsed.error || !parsed.samples) {
          sendApiError(
            response,
            400,
            'SIM2REAL_INVALID_REFERENCE',
            parsed.error || '参考轨迹无效',
            { retryable: false },
          );
          return;
        }
        reference = parsed.samples;
      }
      const model = await getSim2RealModel(run.modelId, owner);
      if (!model) {
        response.status(409).json({
          ok: false,
          error: 'SIM2REAL_MODEL_NOT_FOUND',
          message: '该运行关联的模型制品已不可用，无法进行契约评测。',
        });
        return;
      }
      if (reference) {
        const referenceDimensionError = validateContractDimensions(
          reference,
          model.manifest.contract,
        );
        if (referenceDimensionError) {
          sendApiError(
            response,
            400,
            'SIM2REAL_REFERENCE_DIMENSION_MISMATCH',
            referenceDimensionError,
            { retryable: false },
          );
          return;
        }
      }
      try {
        // Read, compute, and persist inside the store's serialized write
        // chain.  If telemetry arrives concurrently, either it is observed
        // by this callback or it runs afterwards and clears the freshly
        // written evaluation; an older summary can never overwrite newer
        // samples.
        const evaluated = await evaluateSim2RealRun(runId, owner, ({ telemetry }) => {
          const telemetryDimensionError = validateContractDimensions(
            telemetry.flatMap((record) => record.samples),
            model.manifest.contract,
          );
          if (telemetryDimensionError) {
            throw new Sim2RealEvaluationValidationError(telemetryDimensionError);
          }
          return buildEvaluation(telemetry, reference);
        });
        if (!evaluated) {
          response.status(404).json({
            ok: false,
            error: 'SIM2REAL_RUN_NOT_FOUND',
            message: '运行记录不存在，或不属于当前账号。',
          });
          return;
        }
        // Keep the summary embedded on the run for backwards compatibility,
        // while also materializing a first-class evaluation row so lineage can
        // be queried independently and deployments can pin exact evidence.
        let evaluationRecord;
        try {
          // Keep repeated evaluate calls idempotent for the same telemetry
          // snapshot.  A caller-provided key remains authoritative; the
          // derived key excludes the volatile evaluatedAt timestamp so a
          // retry does not create another first-class row.
          const evaluationFingerprint = JSON.stringify({
            runId,
            telemetryRevision: evaluated.telemetryRevision,
            reference: reference ?? null,
            report: { ...evaluated.evaluation, evaluatedAt: undefined },
            attested: evaluated.evaluation.replay.attested === true,
          });
          const derivedEvaluationKey = `telemetry-eval-${createHash('sha256')
            .update(evaluationFingerprint)
            .digest('hex')
            .slice(0, 48)}`;
          const evaluationKey = evaluationIdempotency.value || derivedEvaluationKey;
          const createdEvaluation = await createSim2RealEvaluationWithResult(
            {
              runId,
              modelId: evaluated.run.modelId,
              datasetIds: evaluated.run.datasetIds ?? [],
              ...(evaluated.run.projectId ? { projectId: evaluated.run.projectId } : {}),
              ...(evaluated.run.taskId ? { taskId: evaluated.run.taskId } : {}),
              contractId: model.manifest.contract.id,
              status: evaluated.evaluation.sampleCount > 0 ? 'passed' : 'invalid',
              summary:
                evaluated.evaluation.sampleCount > 0
                  ? '平台遥测评测已完成。'
                  : '平台遥测评测未发现有效样本。',
              report: evaluated.evaluation,
              taskEvaluation: evaluated.run.taskEvaluation,
              source: 'platform',
              attested: evaluated.evaluation.replay.attested === true,
              telemetryRevision: evaluated.telemetryRevision,
            },
            owner,
            {
              allowInitialTerminal: true,
              idempotencyKey: evaluationKey,
              requestFingerprint: evaluationFingerprint,
            },
          );
          evaluationRecord = createdEvaluation.evaluation;
          response.setHeader('Idempotency-Key', evaluationKey);
        } catch (evaluationError) {
          deps.storageError(request, response, evaluationError, 'sim2real-evaluation-materialize');
          return;
        }
        response.json({
          ok: true,
          run: evaluated.run,
          evaluation: evaluated.evaluation,
          evaluationRecord,
        });
      } catch (error) {
        if (error instanceof Sim2RealEvaluationValidationError) {
          sendApiError(response, 409, 'SIM2REAL_TELEMETRY_DIMENSION_MISMATCH', error.message, {
            retryable: false,
          });
          return;
        }
        deps.storageError(request, response, error, 'sim2real-run-evaluate');
      }
    }),
  );
}
