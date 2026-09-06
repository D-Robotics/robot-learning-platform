import { createHash } from 'node:crypto';
import { type Request, type Response, type Router } from 'express';

import type { Device } from '../../shared/types.js';
import {
  SIM2REAL_CONTRACT_LIMITS,
  type Sim2RealEvaluationSummary,
  type Sim2RealTelemetryRecord,
  type Sim2RealTelemetrySample,
  type Sim2RealTelemetrySource,
} from '../../shared/sim2real.js';
import { sendApiError, wrapAsync } from '../sim2real/http-helpers.js';
import { requestOwnsDevice } from '../sim2real/standalone-adapters.js';
import {
  appendSim2RealTelemetryWithResult,
  evaluateSim2RealRun,
  getSim2RealRun,
  getSim2RealModel,
  listSim2RealTelemetry,
  SIM2REAL_TELEMETRY_RECORD_CAP,
} from '../sim2real/sim2real-store.js';
import type { Sim2RealAuthPort } from '../sim2real/sim2real-auth.js';

type OwnedDevice = Device & { bridgeOwnerKey?: string };
type OwnerResolver = (request: Request, response: Response) => string | undefined | null;
type StorageError = (request: Request, response: Response, error: unknown, scope: string) => void;

export interface Sim2RealTelemetryRouteDeps {
  auth: Sim2RealAuthPort;
  requestOwner: OwnerResolver;
  visibleDevices: (owner?: string) => Promise<readonly OwnedDevice[]>;
  storageError: StorageError;
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
const SAFE_IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,128}$/;

function noStore(response: Response): void {
  response.setHeader('Cache-Control', 'no-store');
}

function safeTelemetrySource(value: unknown): Sim2RealTelemetrySource | null {
  const source = String(value ?? '').trim();
  return source === 'board-agent' || source === 'browser' || source === 'import' ? source : null;
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
  const samples = orderedRecords.flatMap((record) => record.samples);
  const first = samples[0]?.t;
  const last = samples.at(-1)?.t;
  const duration = first != null && last != null ? Math.max(0, last - first) : 0;
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
    source: orderedRecords[0]?.source ?? 'import',
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
    const owner = deps.requestOwner(request, response);
    if (owner === null) return;
    noStore(response);
    const body =
      request.body && typeof request.body === 'object' && !Array.isArray(request.body)
        ? (request.body as Record<string, unknown>)
        : {};
    const runId = String(forcedRunId ?? body.runId ?? '').trim();
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
    const source = safeTelemetrySource(body.source ?? 'import');
    if (!source) {
      sendApiError(
        response,
        400,
        'SIM2REAL_INVALID_TELEMETRY',
        'source 必须为 board-agent、browser 或 import',
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
    const deviceId = String(body.deviceId ?? '').trim();
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
    };
    try {
      const appended = await appendSim2RealTelemetryWithResult(
        {
          ...normalizedTelemetry,
          ...(idempotencyKey ? { idempotencyKey } : {}),
          ...(idempotencyKey
            ? { _requestFingerprint: telemetryFingerprint(normalizedTelemetry) }
            : {}),
        },
        owner,
      );
      if (idempotencyKey) response.setHeader('Idempotency-Key', idempotencyKey);
      response.status(appended.duplicate ? 200 : 201).json({
        ok: true,
        telemetry: appended.telemetry,
        ...(appended.duplicate ? { duplicate: true } : { acceptedSamples: appended.telemetry.samples.length }),
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
      const telemetry = await listSim2RealTelemetry(
        runId,
        owner,
        SIM2REAL_TELEMETRY_RECORD_CAP,
      );
      const evaluation = run.evaluation ?? buildEvaluation(telemetry, undefined);
      response.json({ ok: true, runId, replay: evaluation.replay, evaluation });
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
        response.json({ ok: true, run: evaluated.run, evaluation: evaluated.evaluation });
      } catch (error) {
        if (error instanceof Sim2RealEvaluationValidationError) {
          sendApiError(
            response,
            409,
            'SIM2REAL_TELEMETRY_DIMENSION_MISMATCH',
            error.message,
            { retryable: false },
          );
          return;
        }
        deps.storageError(request, response, error, 'sim2real-run-evaluate');
      }
    }),
  );
}
