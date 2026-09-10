import type {
  Sim2RealTaskEvaluationEnvelope,
  Sim2RealTaskEvaluationEvidence,
} from './sim2real-telemetry.js';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const SAFE_ENVELOPE = /^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown, maxLength: number): string {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength)
    : '';
}

function boundedNumber(value: unknown, min: number, max: number): number | undefined {
  const parsed = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : undefined;
}

function boundedInteger(value: unknown, min: number, max: number): number | undefined {
  const parsed = typeof value === 'number' ? value : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : undefined;
}

function envelope(value: unknown): Sim2RealTaskEvaluationEnvelope | undefined {
  const source = record(value);
  if (!Object.keys(source).length) return undefined;
  const successRate = boundedNumber(source.successRate, 0, 1);
  const collisionRate = boundedNumber(source.collisionRate, 0, 1);
  const successRateCiLow = boundedNumber(source.successRateCiLow, 0, 1);
  const successRateCiHigh = boundedNumber(source.successRateCiHigh, 0, 1);
  const collisionRateCiLow = boundedNumber(source.collisionRateCiLow, 0, 1);
  const collisionRateCiHigh = boundedNumber(source.collisionRateCiHigh, 0, 1);
  const episodes = boundedInteger(source.episodes, 1, 100_000);
  const meanReward = boundedNumber(source.meanReward, -1_000_000, 1_000_000);
  const normalized: Sim2RealTaskEvaluationEnvelope = {
    ...(successRate === undefined ? {} : { successRate }),
    ...(collisionRate === undefined ? {} : { collisionRate }),
    ...(successRateCiLow === undefined ? {} : { successRateCiLow }),
    ...(successRateCiHigh === undefined ? {} : { successRateCiHigh }),
    ...(collisionRateCiLow === undefined ? {} : { collisionRateCiLow }),
    ...(collisionRateCiHigh === undefined ? {} : { collisionRateCiHigh }),
    ...(episodes === undefined ? {} : { episodes }),
    ...(meanReward === undefined ? {} : { meanReward }),
  };
  return Object.keys(normalized).length ? normalized : undefined;
}

function evaluationBlock(
  value: unknown,
): Sim2RealTaskEvaluationEvidence['trained'] | undefined {
  const source = record(value);
  if (!Object.keys(source).length) return undefined;
  const rawEnvelopes = record(source.envelopes);
  const entries = Object.entries(rawEnvelopes).slice(0, 8);
  const envelopes = Object.fromEntries(
    entries.flatMap(([name, metrics]) => {
      const safeName = text(name, 32);
      const normalized = envelope(metrics);
      return SAFE_ENVELOPE.test(safeName) && normalized ? [[safeName, normalized]] : [];
    }),
  );
  const meanReward = boundedNumber(source.meanReward, -1_000_000, 1_000_000);
  const episodesPerEnvelope = boundedInteger(source.episodesPerEnvelope, 1, 100_000);
  const confidenceLevel = boundedNumber(source.confidenceLevel, 0.5, 0.9999);
  const normalized = {
    ...(Object.keys(envelopes).length ? { envelopes } : {}),
    ...(meanReward === undefined ? {} : { meanReward }),
    ...(episodesPerEnvelope === undefined ? {} : { episodesPerEnvelope }),
    ...(confidenceLevel === undefined ? {} : { confidenceLevel }),
  };
  return Object.keys(normalized).length ? normalized : undefined;
}

/**
 * Treat runner output as an untrusted boundary. Unknown keys are discarded,
 * strings and arrays are capped, and invalid numeric values never reach the
 * ledger or release gate.
 */
export function normalizeTaskEvaluationEvidence(
  value: unknown,
): Sim2RealTaskEvaluationEvidence | undefined {
  const source = record(value);
  const taskId = text(source.taskId, 80);
  if (!SAFE_ID.test(taskId)) return undefined;
  const adapterId = text(source.adapterId, 80);
  const observationAdapterId = text(source.observationAdapterId, 80);
  const trained = evaluationBlock(source.trained);
  const baseline = evaluationBlock(source.baseline);
  const rawGate = record(source.qualityGate);
  const rawCriteria = record(rawGate.criteria);
  const minSuccessRate = boundedNumber(rawCriteria.minSuccessRate, 0, 1);
  const maxCollisionRate = boundedNumber(rawCriteria.maxCollisionRate, 0, 1);
  const gateOn: 'point' | 'ciLowerBound' | undefined =
    rawCriteria.gateOn === 'point' || rawCriteria.gateOn === 'ciLowerBound'
      ? rawCriteria.gateOn
      : undefined;
  const gateErrors = Array.isArray(rawGate.errors)
    ? rawGate.errors.slice(0, 32).map((item) => text(item, 240)).filter(Boolean)
    : undefined;
  const qualityGate = Object.keys(rawGate).length
    ? {
        ...(typeof rawGate.passed === 'boolean' ? { passed: rawGate.passed } : {}),
        ...(gateErrors?.length ? { errors: gateErrors } : {}),
        criteria: {
          ...(minSuccessRate === undefined ? {} : { minSuccessRate }),
          ...(maxCollisionRate === undefined ? {} : { maxCollisionRate }),
          ...(gateOn === undefined ? {} : { gateOn }),
        },
      }
    : undefined;
  const schemaVersion = boundedInteger(source.schemaVersion, 1, 100);
  const controlLatencyMs = boundedNumber(source.controlLatencyMs, 0, 60_000);
  const seed = boundedInteger(source.seed, 0, 2_147_483_647);
  const reportSha256 = text(source.reportSha256, 64).toLowerCase();
  return {
    taskId,
    ...(schemaVersion === undefined ? {} : { schemaVersion }),
    ...(SAFE_ID.test(adapterId) ? { adapterId } : {}),
    ...(SAFE_ID.test(observationAdapterId) ? { observationAdapterId } : {}),
    ...(trained ? { trained } : {}),
    ...(baseline ? { baseline } : {}),
    ...(qualityGate ? { qualityGate } : {}),
    ...(controlLatencyMs === undefined ? {} : { controlLatencyMs }),
    ...(seed === undefined ? {} : { seed }),
    ...(/^[a-f0-9]{64}$/.test(reportSha256) ? { reportSha256 } : {}),
  };
}
