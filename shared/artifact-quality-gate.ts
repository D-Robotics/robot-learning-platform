import type { Sim2RealObservationLayoutItem } from './sim2real.js';

export interface ArtifactCheckInput {
  observationSize: number;
  actionSize: number;
  manifestObservationSize: number;
  manifestActionSize: number;
  hasArtifactRef: boolean;
  deployable?: boolean;
  maxAbsAction?: number;
}
export function validateArtifactForDeployment(v: ArtifactCheckInput): {
  passed: boolean;
  errors: string[];
} {
  const e: string[] = [];
  if (v.observationSize !== v.manifestObservationSize) e.push('observation dimension mismatch');
  if (v.actionSize !== v.manifestActionSize) e.push('action dimension mismatch');
  if (!v.hasArtifactRef) e.push('missing artifact reference');
  if (v.deployable === false) e.push('artifact is marked non-deployable');
  if (v.maxAbsAction !== undefined && v.maxAbsAction > 1) e.push('action exceeds normalized limit');
  return { passed: e.length === 0, errors: e };
}

/** One model input as reported by onnxruntime (`Session.get_inputs()`). */
export interface ModelInputSignature {
  name: string;
  /** Declared shape; symbolic or dynamic entries are non-numeric. */
  shape: readonly unknown[];
}

function positiveInt(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/**
 * Checks that a loaded model's inputs can actually carry the image branch its
 * contract declares.
 *
 * Context: an image slot is declared by shape and flattened into
 * `observationSize`, which means every dimension-only check in the platform
 * still passes for a vision contract — `observationSize === sum(layout sizes)`
 * holds whether or not the model really accepts an image. The mismatch would
 * otherwise surface only at inference time, on the board, after the policy was
 * already staged. This gate moves that failure to the earliest point where the
 * export's inputs are known.
 *
 * Rules (each fails closed rather than guessing):
 * - a contract with no image slot needs no image input and is exempt;
 * - a vision contract is matched to the single rank-4 input by channel count
 *   and minimum spatial extent;
 * - symbolic (batch) axes are tolerated, but a dynamic channel axis is not,
 *   because it cannot be proven to match the declared channel count.
 */
export function validateVisionObservationAgainstModelInputs(v: {
  layout: readonly Sim2RealObservationLayoutItem[];
  inputs: readonly ModelInputSignature[];
}): { passed: boolean; errors: string[] } {
  const errors: string[] = [];
  const imageSlots = v.layout.filter(
    (item): item is Extract<Sim2RealObservationLayoutItem, { modality: 'image' }> =>
      'modality' in item && item.modality === 'image',
  );
  if (imageSlots.length > 1) {
    errors.push(
      `contract declares ${imageSlots.length} image slots; this gate only certifies a single image branch`,
    );
  }
  if (imageSlots.length === 1) {
    const slot = imageSlots[0]!;
    const rank4 = v.inputs.filter((input) => input.shape.length === 4);
    if (rank4.length !== 1) {
      errors.push(
        `vision contract declares image slot "${slot.name}" but the model exposes ${rank4.length} rank-4 inputs (expected exactly 1)`,
      );
    } else {
      const input = rank4[0]!;
      // NHWC: [batch, height, width, channels].
      const channels = positiveInt(input.shape[3]);
      if (channels === 0) {
        errors.push(
          `model input "${input.name}" channel axis is dynamic; a vision contract requires a fixed channel count (${slot.channels})`,
        );
      } else if (channels !== slot.channels) {
        errors.push(
          `model input "${input.name}" has ${channels} channels but contract image slot "${slot.name}" declares ${slot.channels}`,
        );
      }
      const height = positiveInt(input.shape[1]);
      const width = positiveInt(input.shape[2]);
      if (height !== 0 && height < slot.height) {
        errors.push(
          `model input "${input.name}" height ${height} is smaller than the declared image height ${slot.height}`,
        );
      }
      if (width !== 0 && width < slot.width) {
        errors.push(
          `model input "${input.name}" width ${width} is smaller than the declared image width ${slot.width}`,
        );
      }
    }
  }
  return { passed: errors.length === 0, errors };
}

export interface TaskPackEvalReport {
  /** eval-report.json from a goal-navigation training run. */
  taskId: string;
  qualityGate?: {
    passed?: unknown;
    errors?: unknown;
    criteria?: { minSuccessRate?: unknown; maxCollisionRate?: unknown; gateOn?: unknown };
  };
  trained?: {
    envelopes?: Record<string, EnvelopeMetrics>;
    meanReward?: unknown;
    episodesPerEnvelope?: unknown;
    /** Confidence used by the engine when it computed CI bounds. */
    confidenceLevel?: unknown;
  };
  seed?: number;
}

export interface EnvelopeMetrics {
  successRate?: unknown;
  collisionRate?: unknown;
  successRateCiLow?: unknown;
  successRateCiHigh?: unknown;
  collisionRateCiLow?: unknown;
  collisionRateCiHigh?: unknown;
  episodes?: unknown;
  meanReward?: unknown;
}

export interface TaskPackGateInput {
  report: TaskPackEvalReport | null | undefined;
  taskId: string;
  /** When true the gate hard-fails if no eval report exists at all. */
  requireReport?: boolean;
}

const WILSON_Z: Record<number, number> = { 0.9: 1.644854, 0.95: 1.959964, 0.99: 2.575829 };

/**
 * Wilson score interval for a binomial proportion, or null when the
 * evidence is empty. Mirrors the engine-side implementation so the TS
 * re-computation can cross-check the engine's reported bounds.
 */
export function wilsonBounds(
  successes: number,
  total: number,
  confidence = 0.95,
): { low: number; high: number } | null {
  if (
    !Number.isFinite(successes) ||
    !Number.isFinite(total) ||
    !Number.isSafeInteger(successes) ||
    !Number.isSafeInteger(total) ||
    total <= 0 ||
    successes < 0 ||
    successes > total
  )
    return null;
  const z = WILSON_Z[Math.round(confidence * 100) / 100];
  if (!z) return null;
  const p = successes / total;
  const denom = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denom;
  const spread = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denom;
  return { low: center - spread, high: center + spread };
}

/**
 * Consume the engine's eval-report.json quality-gate verdict on the TS side.
 * Mirrors the engine's fail-closed semantics: a missing or malformed report
 * never passes; the verdict is recomputed from the raw metrics instead of
 * trusting the engine's boolean, so a corrupted report cannot greenlight a
 * deployment.
 *
 * When the report's criteria carry gateOn "ciLowerBound", success is judged
 * on the Wilson CI lower bound and collision on the CI upper bound — a
 * 6-episode 6/6 point rate no longer hides a 54% floor. The bounds
 * themselves are re-derived from the raw episode counts where possible and
 * cross-checked against the engine's values; a mismatch is an error, not a
 * pass. When gateOn is "point" (legacy reports) the point rates gate.
 */
export function validateTaskPackEvalForRelease(v: TaskPackGateInput): {
  passed: boolean;
  errors: string[];
  successRate: number | null;
  collisionRate: number | null;
  successRateCiLow: number | null;
  collisionRateCiHigh: number | null;
  gateOn: 'point' | 'ciLowerBound';
} {
  const errors: string[] = [];
  const boundedRate = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
  const validEpisodes = (value: unknown): number | null =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : null;
  const report = v.report;
  if (!report || typeof report !== 'object') {
    errors.push(
      v.requireReport ? 'eval report is missing (required for release)' : 'eval report is missing',
    );
    return {
      passed: false,
      errors,
      successRate: null,
      collisionRate: null,
      successRateCiLow: null,
      collisionRateCiHigh: null,
      gateOn: 'point',
    };
  }
  if (report.taskId !== v.taskId)
    errors.push(`eval report task mismatch: expected ${v.taskId}, got ${report.taskId}`);
  const criteria = report.qualityGate?.criteria ?? {};
  const gateOnRaw =
    typeof (criteria as { gateOn?: unknown }).gateOn === 'string'
      ? (criteria as { gateOn: string }).gateOn
      : 'point';
  if (gateOnRaw !== 'point' && gateOnRaw !== 'ciLowerBound')
    errors.push(`unknown gateOn ${gateOnRaw}`);
  const gateOn: 'point' | 'ciLowerBound' = gateOnRaw === 'ciLowerBound' ? 'ciLowerBound' : 'point';
  // The engine records the confidence level alongside its bounds.  Older
  // reports predate that field and are interpreted as the historical 95%
  // default; a present but unsupported value fails closed rather than being
  // silently recomputed at a different confidence level.
  const confidenceRaw = report.trained?.confidenceLevel;
  const confidence = confidenceRaw === undefined ? 0.95 : Number(confidenceRaw);
  const supportedConfidence = [0.9, 0.95, 0.99].includes(confidence);
  if (confidenceRaw !== undefined && !supportedConfidence)
    errors.push('confidenceLevel must be 0.9, 0.95, or 0.99');
  const minSuccessRate = boundedRate(criteria.minSuccessRate);
  const maxCollisionRate = boundedRate(criteria.maxCollisionRate);
  if (criteria.minSuccessRate !== undefined && minSuccessRate === null)
    errors.push('minSuccessRate must be a finite rate between 0 and 1');
  if (criteria.maxCollisionRate !== undefined && maxCollisionRate === null)
    errors.push('maxCollisionRate must be a finite rate between 0 and 1');
  const nominal = report.trained?.envelopes?.nominal ?? null;
  const successRate = boundedRate(nominal?.successRate);
  const collisionRate = boundedRate(nominal?.collisionRate);
  const successRateCiLow = boundedRate(nominal?.successRateCiLow);
  const collisionRateCiHigh = boundedRate(nominal?.collisionRateCiHigh);
  const episodes = validEpisodes(nominal?.episodes);
  for (const [label, raw, normalized] of [
    ['successRate', nominal?.successRate, successRate],
    ['collisionRate', nominal?.collisionRate, collisionRate],
    ['successRateCiLow', nominal?.successRateCiLow, successRateCiLow],
    ['collisionRateCiHigh', nominal?.collisionRateCiHigh, collisionRateCiHigh],
  ] as const) {
    if (raw !== undefined && normalized === null)
      errors.push(`${label} must be a finite rate between 0 and 1`);
  }
  if (nominal?.episodes !== undefined && episodes === null)
    errors.push('nominal episodes must be a positive safe integer');
  if (gateOn === 'ciLowerBound') {
    if (successRateCiLow === null || collisionRateCiHigh === null) {
      errors.push(
        'nominal envelope confidence bounds missing from eval report (gateOn=ciLowerBound)',
      );
    } else if (episodes !== null && successRate !== null) {
      // Re-derive the bounds from raw counts and cross-check the engine's
      // numbers: a corrupted or hand-edited report cannot pass silently.
      const successes = Math.round(successRate * episodes);
      const collisions = collisionRate === null ? null : Math.round(collisionRate * episodes);
      const successBounds = supportedConfidence
        ? wilsonBounds(successes, episodes, confidence)
        : null;
      if (successBounds && Math.abs(successBounds.low - successRateCiLow) > 0.01) {
        errors.push(
          `successRate CI low mismatch: recomputed ${successBounds.low.toFixed(4)} vs reported ${successRateCiLow.toFixed(4)}`,
        );
      }
      if (collisions !== null) {
        const collisionBounds = supportedConfidence
          ? wilsonBounds(collisions, episodes, confidence)
          : null;
        if (collisionBounds && Math.abs(collisionBounds.high - collisionRateCiHigh) > 0.01) {
          errors.push(
            `collisionRate CI high mismatch: recomputed ${collisionBounds.high.toFixed(4)} vs reported ${collisionRateCiHigh.toFixed(4)}`,
          );
        }
      }
    }
  }
  if (successRate === null || collisionRate === null)
    errors.push('nominal envelope metrics missing from eval report');
  if (minSuccessRate !== null) {
    const judge = gateOn === 'ciLowerBound' ? successRateCiLow : successRate;
    if (judge === null)
      errors.push(
        `successRate ${gateOn === 'ciLowerBound' ? 'CI low' : ''} missing for gate`.trim(),
      );
    else if (judge < minSuccessRate)
      errors.push(
        `successRate${gateOn === 'ciLowerBound' ? ' CI low' : ''} ${judge.toFixed(2)} below gate ${minSuccessRate.toFixed(2)}`,
      );
  }
  if (maxCollisionRate !== null) {
    const judge = gateOn === 'ciLowerBound' ? collisionRateCiHigh : collisionRate;
    if (judge === null)
      errors.push(
        `collisionRate ${gateOn === 'ciLowerBound' ? 'CI high' : ''} missing for gate`.trim(),
      );
    else if (judge > maxCollisionRate)
      errors.push(
        `collisionRate${gateOn === 'ciLowerBound' ? ' CI high' : ''} ${judge.toFixed(2)} above gate ${maxCollisionRate.toFixed(2)}`,
      );
  }
  return {
    passed: errors.length === 0,
    errors,
    successRate,
    collisionRate,
    successRateCiLow,
    collisionRateCiHigh,
    gateOn,
  };
}
