import { validateBoardRehearsalReceipt } from './board-rehearsal.js';
import type {
  Sim2RealObservationLayoutItem,
  Sim2RealPolicyInputs,
  Sim2RealPolicyState,
} from './sim2real.js';

export interface ArtifactCheckInput {
  observationSize: number;
  actionSize: number;
  manifestObservationSize: number;
  manifestActionSize: number;
  hasArtifactRef: boolean;
  deployable?: boolean;
  maxAbsAction?: number;
}

export interface ArtifactCheckOptions {
  /**
   * Board latency rehearsal receipt for the *deployment* artifact. Required
   * whenever `deployable` is not explicitly false: a policy that claims to be
   * deployable must show it was timed on the board that will run it, not on
   * the training host.
   */
  boardRehearsal?: unknown;
  /**
   * SHA-256 of the bytes being deployed. When present the receipt must describe
   * the same artifact, so a rehearsal for a superseded export cannot certify a
   * newer one.
   */
  artifactSha256?: string;
  /** Instant the gate runs, for receipt freshness. Defaults to now. */
  now?: number;
}

export function validateArtifactForDeployment(
  v: ArtifactCheckInput,
  options: ArtifactCheckOptions = {},
): {
  passed: boolean;
  errors: string[];
} {
  const e: string[] = [];
  if (v.observationSize !== v.manifestObservationSize) e.push('observation dimension mismatch');
  if (v.actionSize !== v.manifestActionSize) e.push('action dimension mismatch');
  if (!v.hasArtifactRef) e.push('missing artifact reference');
  if (v.deployable === false) e.push('artifact is marked non-deployable');
  if (v.maxAbsAction !== undefined && v.maxAbsAction > 1) e.push('action exceeds normalized limit');
  // Dimension checks cannot see timing. An artifact that is otherwise
  // release-shaped still needs on-board evidence before it reaches a motor.
  const rehearsal = validateBoardRehearsalReceipt(options.boardRehearsal, {
    deployable: v.deployable,
    artifactSha256: options.artifactSha256,
    now: options.now,
  });
  e.push(...rehearsal.errors);
  return { passed: e.length === 0, errors: e };
}

/** One model input as reported by onnxruntime (`Session.get_inputs()`). */
export interface ModelInputSignature {
  name: string;
  /** Declared shape; symbolic or dynamic entries are non-numeric. */
  shape: readonly unknown[];
}

/** One model output as reported by onnxruntime (`Session.get_outputs()`). */
export interface ModelOutputSignature {
  name: string;
  shape: readonly unknown[];
}

function positiveInt(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function dimOf(shape: readonly unknown[]): number {
  return shape.length ? positiveInt(shape[shape.length - 1]) : 0;
}

function describeSignature(items: readonly { name: string; shape: readonly unknown[] }[]): string {
  return items.map((item) => `${item.name}${JSON.stringify(item.shape)}`).join(', ') || '(none)';
}

/**
 * Checks a contract's *named* policy inputs against the exported graph.
 *
 * Why this exists: without declared names the only thing a gate can do is match
 * by rank — "some rank-2 input is the observation". That passes for a model whose
 * input order changed, for a model that grew a second rank-2 input, and worst of
 * all for a recurrent export whose state inputs are silently ignored and
 * defaulted to zero on every step. The policy then runs and produces
 * plausible-looking but wrong actions.
 *
 * This gate refuses instead, on the same fail-closed principle as
 * `classify_graph` in the `microduck-eval` harness: every ambiguity is an error,
 * never a guess.
 *
 * Rules:
 * - a declared name must exist in the graph and carry the expected rank;
 * - the observation must be the declared width, and the image the declared
 *   channel count — bound by name *and* layout, not by position;
 * - recurrent state inputs must pair 1:1 with same-shaped outputs, or the
 *   carried history cannot be closed;
 * - a state declaration without state tensors, or state tensors without a state
 *   declaration, is a mismatch;
 * - the action output is matched by declared width and must be unambiguous.
 *
 * A contract that declares no `inputs` at all is checked only for unhandled
 * rank-3 inputs (see {@link unhandledStateInputs}), so feed-forward exports keep
 * their historical rank-based behaviour.
 */
export function validatePolicyInputBindingsAgainstModelGraph(v: {
  inputs: readonly ModelInputSignature[];
  outputs: readonly ModelOutputSignature[];
  observationSize: number;
  actionSize: number;
  /** Channels of the contract's single image slot, when it declares one. */
  imageChannels?: number;
  /** The contract's `inputs` block, when it declares one. */
  declared?: Sim2RealPolicyInputs;
  /** The contract's `state` block, when it declares one. */
  state?: Sim2RealPolicyState;
}): { passed: boolean; errors: string[] } {
  const errors: string[] = [];
  const byName = new Map(v.inputs.map((input) => [input.name, input]));
  const outputsByName = new Map(v.outputs.map((output) => [output.name, output]));
  const declared = v.declared;
  const stateInputNames = declared?.stateInputs ?? [];
  const stateOutputNames = declared?.stateOutputs ?? [];

  if (declared) {
    if (!declared.observation) {
      errors.push(
        'contract.inputs declares names but omits "observation"; the vector input cannot be bound',
      );
    } else {
      const input = byName.get(declared.observation);
      if (!input) {
        errors.push(
          `contract.inputs.observation names "${declared.observation}" but the graph has no such input (graph: ${describeSignature(v.inputs)})`,
        );
      } else if (input.shape.length !== 2) {
        errors.push(
          `contract.inputs.observation "${declared.observation}" must be rank 2, got shape ${JSON.stringify(input.shape)}`,
        );
      } else if (dimOf(input.shape) !== v.observationSize) {
        errors.push(
          `contract.inputs.observation "${declared.observation}" has width ${dimOf(input.shape)} but the contract declares observationSize ${v.observationSize}`,
        );
      }
    }
    if (declared.image) {
      const input = byName.get(declared.image);
      if (!input) {
        errors.push(
          `contract.inputs.image names "${declared.image}" but the graph has no such input (graph: ${describeSignature(v.inputs)})`,
        );
      } else if (input.shape.length !== 4) {
        errors.push(
          `contract.inputs.image "${declared.image}" must be rank 4, got shape ${JSON.stringify(input.shape)}`,
        );
      } else {
        const channels = positiveInt(input.shape[3]);
        if (channels === 0) {
          errors.push(
            `contract.inputs.image "${declared.image}" channel axis is dynamic; a vision contract requires a fixed channel count`,
          );
        } else if (v.imageChannels !== undefined && channels !== v.imageChannels) {
          errors.push(
            `contract.inputs.image "${declared.image}" has ${channels} channels but the contract image slot declares ${v.imageChannels}`,
          );
        }
      }
    }
  }

  // Recurrent wiring. Checked when the contract talks about state at all; an
  // undeclared contract keeps the legacy path and is reported by
  // `unhandledStateInputs` instead.
  if (v.state || stateInputNames.length || stateOutputNames.length) {
    if (!v.state) {
      errors.push('contract names state tensors without declaring contract.state');
    }
    if (v.state && !stateInputNames.length) {
      errors.push('contract.state declares recurrent state but names no state input tensor');
    }
    for (const name of stateInputNames) {
      const input = byName.get(name);
      if (!input) {
        errors.push(
          `contract.inputs.stateInputs names "${name}" but the graph has no such input (graph: ${describeSignature(v.inputs)})`,
        );
        continue;
      }
      if (input.shape.length !== 3) {
        errors.push(
          `state input "${name}" must be rank 3 (layers, batch, hidden), got shape ${JSON.stringify(input.shape)}`,
        );
        continue;
      }
      const hidden = dimOf(input.shape);
      if (hidden === 0) {
        errors.push(`state input "${name}" hidden axis is dynamic; it cannot be allocated`);
      } else if (v.state && hidden !== v.state.hiddenSize) {
        errors.push(
          `state input "${name}" hidden size ${hidden} does not match contract.state.hiddenSize ${v.state.hiddenSize}`,
        );
      }
    }
    stateOutputNames.forEach((name, index) => {
      const output = outputsByName.get(name);
      if (!output) {
        errors.push(
          `contract.inputs.stateOutputs names "${name}" but the graph has no such output (graph: ${describeSignature(v.outputs)})`,
        );
        return;
      }
      const pairedInput = stateInputNames[index];
      const input = pairedInput ? byName.get(pairedInput) : undefined;
      if (input && JSON.stringify(input.shape) !== JSON.stringify(output.shape)) {
        errors.push(
          `state output "${name}" shape ${JSON.stringify(output.shape)} does not match its input "${pairedInput}" shape ${JSON.stringify(input.shape)}; the carried history cannot be closed`,
        );
      }
    });
  }

  // The action width has to be readable from the graph. Vision exports may list
  // the image after the vector, and recurrent exports add state outputs, so the
  // action is matched by declared width rather than by output position.
  const actionCandidates = v.outputs.filter(
    (output) =>
      output.shape.length === 2 &&
      dimOf(output.shape) === v.actionSize &&
      !stateOutputNames.includes(output.name),
  );
  if (actionCandidates.length === 0) {
    errors.push(
      `no rank-2 output of width ${v.actionSize} in the graph (outputs: ${describeSignature(v.outputs)})`,
    );
  } else if (actionCandidates.length > 1) {
    errors.push(
      `ambiguous action output: ${actionCandidates.length} rank-2 outputs of width ${v.actionSize} (${describeSignature(actionCandidates)})`,
    );
  }
  return { passed: errors.length === 0, errors };
}

/**
 * Rank-3 inputs nothing binds.
 *
 * The board runtime's vector path feeds only the observation, so any other graph
 * input is defaulted by ONNX Runtime — for a recurrent export that means zeroed
 * history on every step. Detecting this lets a gate refuse the load instead of
 * letting a policy run on state it never carried.
 */
export function unhandledStateInputs(v: {
  inputs: readonly ModelInputSignature[];
  declared?: Sim2RealPolicyInputs;
}): string[] {
  const bound = new Set(
    [v.declared?.observation, v.declared?.image, ...(v.declared?.stateInputs ?? [])].filter(
      (name): name is string => typeof name === 'string',
    ),
  );
  return v.inputs
    .filter((input) => input.shape.length === 3 && !bound.has(input.name))
    .map((input) => input.name);
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
    criteria?: {
      minSuccessRate?: unknown;
      maxCollisionRate?: unknown;
      gateOn?: unknown;
      /** Smoothness ceiling, mirrored from the engine gate. */
      maxActionChangeRms?: unknown;
      /** Ablation requirement, mirrored from the engine gate. */
      ablation?: { requireBaseline?: unknown; minSuccessRateDelta?: unknown };
    };
  };
  trained?: {
    envelopes?: Record<string, EnvelopeMetrics>;
    meanReward?: unknown;
    episodesPerEnvelope?: unknown;
    /** Confidence used by the engine when it computed CI bounds. */
    confidenceLevel?: unknown;
  };
  /**
   * Untrained-baseline evaluation. The ablation criterion compares against it,
   * so its absence is a reportable gap rather than an implicit pass.
   */
  baseline?: { envelopes?: Record<string, EnvelopeMetrics> };
  seed?: number;
}

export interface EnvelopeMetrics {
  successRate?: unknown;
  /** RMS of per-step action change; the non-success figure a task can gate on. */
  actionChangeRms?: unknown;
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
  /** Smoothness figures are bounded below by zero but are not proportions. */
  const boundedNonNegative = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000
      ? value
      : null;
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
  // Smoothness and ablation are judged here too, for the same reason the rates
  // are: a declared criterion the release gate ignores is a criterion that only
  // exists in the engine's own report. Both refuse when their evidence is
  // absent, so "unmeasured" can never be read as "satisfied".
  const maxActionChangeRms =
    typeof criteria.maxActionChangeRms === 'number' && Number.isFinite(criteria.maxActionChangeRms)
      ? criteria.maxActionChangeRms
      : null;
  if (criteria.maxActionChangeRms !== undefined && maxActionChangeRms === null)
    errors.push('maxActionChangeRms must be a finite number');
  const actionChangeRms = boundedNonNegative(nominal?.actionChangeRms);
  if (maxActionChangeRms !== null) {
    if (actionChangeRms === null) errors.push('nominal actionChangeRms missing from eval report');
    else if (actionChangeRms > maxActionChangeRms)
      errors.push(
        `actionChangeRms ${actionChangeRms.toFixed(4)} above gate ${maxActionChangeRms.toFixed(4)}`,
      );
  }
  const ablation =
    criteria.ablation && typeof criteria.ablation === 'object' && !Array.isArray(criteria.ablation)
      ? (criteria.ablation as { requireBaseline?: unknown; minSuccessRateDelta?: unknown })
      : null;
  const minDelta =
    typeof ablation?.minSuccessRateDelta === 'number' &&
    Number.isFinite(ablation.minSuccessRateDelta)
      ? ablation.minSuccessRateDelta
      : null;
  if (ablation && ablation.minSuccessRateDelta !== undefined && minDelta === null)
    errors.push('ablation.minSuccessRateDelta must be a finite number');
  if (ablation) {
    const baseline = report.baseline?.envelopes?.nominal ?? null;
    const baselineSuccessRate = boundedRate(baseline?.successRate);
    if (ablation.requireBaseline === true && !baseline)
      errors.push('ablation requires a baseline report, but the eval report carries none');
    else if (minDelta !== null) {
      if (successRate === null)
        errors.push('nominal successRate missing for the ablation comparison');
      else if (baselineSuccessRate === null)
        errors.push('baseline successRate missing for the ablation comparison');
      else if (successRate - baselineSuccessRate < minDelta)
        errors.push(
          `ablation: trained successRate ${successRate.toFixed(4)} minus baseline ${baselineSuccessRate.toFixed(4)} is below the required delta ${minDelta.toFixed(4)}`,
        );
    }
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
