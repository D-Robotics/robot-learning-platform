/**
 * Board latency rehearsal: the receipt contract and its fail-closed gate.
 *
 * ## Why this exists
 *
 * Every latency number the engine reports today is measured on the *training
 * host*: `measure_control_latency_ms` in `engines/starter-ppo/runner.py` times a
 * 32-sample median of a single-threaded **PyTorch** forward pass through the
 * `.pt` actor. That number is useful for comparing two checkpoints on one
 * machine, but it is not the control-loop budget of the board that will run the
 * exported ONNX graph: different artifact, different runtime, different CPU,
 * different scheduling. Reporting it as "control latency" makes a deployment
 * look budget-checked when nothing on the device was ever timed.
 *
 * A *rehearsal* is the missing measurement. `scripts/board-latency-rehearsal.py`
 * runs the real `board-policy-runtime.py` load path and its exact inference
 * call on the target board, many times, sampling the per-inference latency of
 * the deployment artifact, and writes a receipt. This module owns that
 * receipt's shape and the verdict.
 *
 * ## Guarantees
 *
 * - A deployment is only confirmed when a receipt measured **on the board**
 *   (`stage: "board-onnx"`) shows the budget was met, the receipt is fresh, and
 *   the receipt names the same artifact bytes.
 * - A host measurement can never masquerade as a board one: `stage` is
 *   required, and anything other than `board-onnx` is refused for release.
 * - Every rule fails closed. Missing fields, unproven axes, a stale receipt, or
 *   a receipt for a different artifact all produce errors, never a pass.
 */

/** Receipt schema version this module validates. */
export const BOARD_REHEARSAL_SCHEMA_VERSION = 1;

/** Minimum samples for a rehearsal to carry any statistical weight. */
export const BOARD_REHEARSAL_MIN_SAMPLES = 100;

/** A rehearsal older than this cannot certify a deployment. */
export const BOARD_REHEARSAL_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** Upper bound for any latency figure, in ms. */
export const BOARD_REHEARSAL_MAX_LATENCY_MS = 60_000;

/**
 * Where a latency figure came from. Consumers must not compare figures across
 * stages, and only `board-onnx` may support a deployment claim.
 */
export type LatencyMeasurementStage =
  /** PyTorch forward pass on the training host (starter-ppo today). */
  | 'host-torch'
  /** ONNX Runtime forward pass on the training host. */
  | 'host-onnx'
  /** JAX/MJX forward pass on the training host (the MJX adapter). */
  | 'host-jax'
  /** ONNX Runtime forward pass on the target board (what a rehearsal proves). */
  | 'board-onnx'
  /** Latency added by a simulated step, e.g. a CPU MuJoCo physics tick. */
  | 'sim-step'
  /** Stage the producer did not declare. Never treated as board evidence. */
  | 'unknown';

const MEASUREMENT_STAGES: readonly LatencyMeasurementStage[] = [
  'host-torch',
  'host-onnx',
  'host-jax',
  'board-onnx',
  'sim-step',
  'unknown',
];

/** True when `value` is a latency stage this platform understands. */
export function isLatencyMeasurementStage(value: unknown): value is LatencyMeasurementStage {
  return typeof value === 'string' && (MEASUREMENT_STAGES as readonly string[]).includes(value);
}

/**
 * Normalizes an untrusted stage value. An absent stage is `unknown` rather
 * than a guess: a producer that did not say where a number came from has not
 * earned the benefit of the doubt.
 */
export function normalizeLatencyMeasurementStage(value: unknown): LatencyMeasurementStage {
  return isLatencyMeasurementStage(value) ? value : 'unknown';
}

/** Human-readable label for a stage, for UI and error text. */
export function describeLatencyMeasurementStage(stage: LatencyMeasurementStage): string {
  switch (stage) {
    case 'host-torch':
      return '训练主机 PyTorch 前向';
    case 'host-onnx':
      return '训练主机 ONNX 前向';
    case 'host-jax':
      return '训练主机 JAX 前向';
    case 'board-onnx':
      return '板端 ONNX 前向';
    case 'sim-step':
      return '仿真步进耗时';
    default:
      return '未声明的测量阶段';
  }
}

/** One measured distribution of per-step latencies on one target. */
export interface BoardLatencyReceiptMetric {
  /** Name of the measurement, e.g. "inference" or "control-step". */
  name: string;
  /** Sample count actually recorded. */
  samples: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
  /** Fraction of samples at or above the budget, in [0, 1]. */
  overBudgetRatio: number;
  /** Budget this metric was judged against, in ms. */
  budgetMs: number;
}

export interface BoardLatencyReceipt {
  schemaVersion: number;
  /** ISO-8601 instant the rehearsal ran. */
  measuredAt: string;
  tool: string;
  /** Device identity, so a receipt can be tied to the board it describes. */
  device: { host?: string; machine?: string; boardModel?: string };
  /** SHA-256 of the rehearsed artifact; must match the deployed bytes. */
  artifactSha256: string;
  artifactBytes?: number;
  /** Declared control rate of the contract under test. */
  decisionHz: number;
  /** Execution provider actually used by the session. */
  provider: string;
  metrics: BoardLatencyReceiptMetric[];
  /** The producer's own verdict; re-derived by the gate, never trusted. */
  budgetMet: boolean;
  notes?: string[];
}

export interface BoardRehearsalGateOptions {
  /** The deployment is claimed to be deployable; a receipt becomes mandatory. */
  deployable?: boolean;
  /**
   * Bytes the receipt must describe. When omitted the artifact identity is not
   * cross-checked, which is only acceptable for a producer-side self-check.
   */
  artifactSha256?: string;
  /** Instant the gate runs, for freshness. Defaults to now. */
  now?: number;
}

export interface BoardRehearsalGateResult {
  passed: boolean;
  errors: string[];
  /** Stage of the receipt, or null when there is no usable receipt. */
  stage: LatencyMeasurementStage | null;
  /** Age of the receipt in ms, when it carried a usable timestamp. */
  ageMs: number | null;
  /** The metric the verdict was taken from, when one was chosen. */
  judgedMetric: string | null;
}

const SHA256 = /^[a-f0-9]{64}$/;

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function boundedRate(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed >= 0 && parsed <= 1 ? parsed : null;
}

function metricName(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value) ? value : null;
}

/**
 * Chooses the metric a release verdict is taken from. `control-step` is the
 * honest whole-step figure when a producer records it, because it includes the
 * work around inference; `inference` is the fallback.
 */
function selectJudgedMetric(
  metrics: readonly BoardLatencyReceiptMetric[],
): BoardLatencyReceiptMetric | null {
  return (
    metrics.find((metric) => metric.name === 'control-step') ??
    metrics.find((metric) => metric.name === 'inference') ??
    metrics[0] ??
    null
  );
}

function validateMetric(value: unknown, errors: string[]): BoardLatencyReceiptMetric | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push('metric entry must be an object');
    return null;
  }
  const source = value as Record<string, unknown>;
  const name = metricName(source.name);
  if (!name) {
    errors.push('metric name must be a lowercase identifier');
    return null;
  }
  let broken = false;
  const samples = finiteNumber(source.samples);
  if (samples === null || !Number.isSafeInteger(samples) || samples < 1) {
    errors.push(`metric ${name}: samples must be a positive safe integer`);
    broken = true;
  }
  const medianMs = finiteNumber(source.medianMs);
  const p95Ms = finiteNumber(source.p95Ms);
  const maxMs = finiteNumber(source.maxMs);
  for (const [label, parsed] of [
    ['medianMs', medianMs],
    ['p95Ms', p95Ms],
    ['maxMs', maxMs],
  ] as const) {
    if (parsed === null || parsed < 0 || parsed > BOARD_REHEARSAL_MAX_LATENCY_MS) {
      errors.push(
        `metric ${name}: ${label} must be a finite latency between 0 and ${BOARD_REHEARSAL_MAX_LATENCY_MS} ms`,
      );
      broken = true;
    }
  }
  const budgetMs = finiteNumber(source.budgetMs);
  if (budgetMs === null || budgetMs <= 0 || budgetMs > BOARD_REHEARSAL_MAX_LATENCY_MS) {
    errors.push(`metric ${name}: budgetMs must be a finite positive budget`);
    broken = true;
  }
  const overBudgetRatio = boundedRate(source.overBudgetRatio);
  if (overBudgetRatio === null) {
    errors.push(`metric ${name}: overBudgetRatio must be a rate between 0 and 1`);
    broken = true;
  }
  // Percentiles must be ordered, or the distribution is not a distribution.
  if (medianMs !== null && p95Ms !== null && maxMs !== null && (medianMs > p95Ms || p95Ms > maxMs))
    errors.push(`metric ${name}: percentiles must satisfy median <= p95 <= max`);
  if (samples !== null && samples < BOARD_REHEARSAL_MIN_SAMPLES)
    errors.push(
      `metric ${name}: ${samples} samples is below the ${BOARD_REHEARSAL_MIN_SAMPLES}-sample minimum`,
    );
  // Self-consistency: maxMs is by definition an over-budget sample when it
  // exceeds the budget, and cannot be one when it does not.
  if (maxMs !== null && budgetMs !== null && overBudgetRatio !== null) {
    if (maxMs > budgetMs && overBudgetRatio === 0)
      errors.push(`metric ${name}: maxMs exceeds the budget but overBudgetRatio is 0`);
    if (maxMs <= budgetMs && overBudgetRatio > 0)
      errors.push(`metric ${name}: maxMs is within budget but overBudgetRatio is non-zero`);
  }
  if (
    broken ||
    samples === null ||
    medianMs === null ||
    p95Ms === null ||
    maxMs === null ||
    budgetMs === null ||
    overBudgetRatio === null
  )
    return null;
  return { name, samples, medianMs, p95Ms, maxMs, overBudgetRatio, budgetMs };
}

/**
 * Validates the receipt's own shape. Split from the verdict so the parse can be
 * reused by producers and tests without a deployment claim attached.
 */
export function parseBoardLatencyReceipt(value: unknown): {
  receipt: BoardLatencyReceipt | null;
  stage: LatencyMeasurementStage;
  errors: string[];
} {
  const errors: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { receipt: null, stage: 'unknown', errors: ['receipt must be a JSON object'] };
  const source = value as Record<string, unknown>;
  const schemaVersion = finiteNumber(source.schemaVersion);
  if (schemaVersion !== BOARD_REHEARSAL_SCHEMA_VERSION)
    errors.push(
      `unsupported receipt schemaVersion: expected ${BOARD_REHEARSAL_SCHEMA_VERSION}, got ${String(source.schemaVersion)}`,
    );
  const measuredAt = typeof source.measuredAt === 'string' ? source.measuredAt : '';
  const measuredAtMs = Date.parse(measuredAt);
  if (!measuredAt || !Number.isFinite(measuredAtMs))
    errors.push('measuredAt must be an ISO-8601 timestamp');
  const tool = typeof source.tool === 'string' ? source.tool.trim().slice(0, 64) : '';
  if (!tool) errors.push('tool must name the producing tool');
  const artifactSha256 =
    typeof source.artifactSha256 === 'string' ? source.artifactSha256.toLowerCase() : '';
  if (!SHA256.test(artifactSha256))
    errors.push('artifactSha256 must be a lowercase 64-character SHA-256');
  const decisionHz = finiteNumber(source.decisionHz);
  if (decisionHz === null || decisionHz <= 0 || decisionHz > 1_000)
    errors.push('decisionHz must be a finite positive control rate');
  const provider = typeof source.provider === 'string' ? source.provider.trim().slice(0, 64) : '';
  if (!provider) errors.push('provider must name the execution provider');
  // The stage is deliberately *not* a receipt field the producer may omit: a
  // missing stage normalizes to "unknown", which the gate refuses for release.
  const stage = normalizeLatencyMeasurementStage(source.stage);
  if (source.stage !== undefined && !isLatencyMeasurementStage(source.stage))
    errors.push(`unknown measurement stage: ${String(source.stage)}`);
  const rawMetrics = Array.isArray(source.metrics) ? source.metrics.slice(0, 8) : [];
  if (!rawMetrics.length) errors.push('metrics must contain at least one measurement');
  const metrics = rawMetrics
    .map((entry) => validateMetric(entry, errors))
    .filter((entry): entry is BoardLatencyReceiptMetric => entry !== null);
  if (typeof source.budgetMet !== 'boolean') errors.push('budgetMet must be a boolean');
  const device =
    source.device && typeof source.device === 'object' && !Array.isArray(source.device)
      ? (source.device as BoardLatencyReceipt['device'])
      : {};
  const notes = Array.isArray(source.notes)
    ? source.notes
        .slice(0, 8)
        .map((note) => (typeof note === 'string' ? note.trim().slice(0, 240) : ''))
        .filter(Boolean)
    : undefined;
  const artifactBytes = finiteNumber(source.artifactBytes);
  if (errors.length) return { receipt: null, stage, errors };
  return {
    receipt: {
      schemaVersion: BOARD_REHEARSAL_SCHEMA_VERSION,
      measuredAt,
      tool,
      device,
      artifactSha256,
      ...(artifactBytes === null ? {} : { artifactBytes }),
      decisionHz: decisionHz!,
      provider,
      metrics,
      budgetMet: source.budgetMet as boolean,
      ...(notes?.length ? { notes } : {}),
    },
    stage,
    errors,
  };
}

/**
 * The release verdict for a board rehearsal.
 *
 * A receipt is required whenever the artifact claims to be deployable. When the
 * receipt is absent and no deployment is claimed, the gate stays quiet: not
 * every artifact in the ledger is headed for a robot.
 */
export function validateBoardRehearsalReceipt(
  value: unknown,
  options: BoardRehearsalGateOptions = {},
): BoardRehearsalGateResult {
  const now = options.now ?? Date.now();
  const required = options.deployable !== false;
  const empty: BoardRehearsalGateResult = {
    passed: false,
    errors: [],
    stage: null,
    ageMs: null,
    judgedMetric: null,
  };
  if (value === undefined || value === null) {
    return required
      ? {
          ...empty,
          errors: [
            'no board latency rehearsal receipt: deployable artifacts require an on-board measurement',
          ],
        }
      : empty;
  }
  const parsed = parseBoardLatencyReceipt(value);
  if (!parsed.receipt) return { ...empty, stage: parsed.stage, errors: parsed.errors };
  const { receipt, stage } = parsed;
  const errors: string[] = [];
  const measuredAtMs = Date.parse(receipt.measuredAt);
  const ageMs = now - measuredAtMs;
  if (ageMs < 0) errors.push('receipt measuredAt is in the future');
  else if (ageMs > BOARD_REHEARSAL_MAX_AGE_MS)
    errors.push(
      `receipt is ${Math.round(ageMs / 86_400_000)} days old; a rehearsal older than ${Math.round(
        BOARD_REHEARSAL_MAX_AGE_MS / 86_400_000,
      )} days cannot certify a deployment`,
    );
  if (stage !== 'board-onnx')
    errors.push(
      `receipt stage is "${stage}" (${describeLatencyMeasurementStage(stage)}); only a board-onnx measurement can certify a deployment`,
    );
  if (options.artifactSha256 && receipt.artifactSha256 !== options.artifactSha256.toLowerCase())
    errors.push(
      `receipt describes artifact ${receipt.artifactSha256} but the deployment artifact is ${options.artifactSha256.toLowerCase()}`,
    );
  const judged = selectJudgedMetric(receipt.metrics);
  if (!judged) errors.push('receipt carries no usable latency metric');
  else if (judged.medianMs > judged.budgetMs)
    errors.push(
      `metric ${judged.name}: median ${judged.medianMs.toFixed(3)} ms exceeds the ${judged.budgetMs.toFixed(3)} ms budget`,
    );
  // The producer's boolean is re-derived: a hand-edited `budgetMet: true` on an
  // over-budget distribution must not survive.
  const derivedBudgetMet = receipt.metrics.every(
    (metric) => metric.medianMs <= metric.budgetMs && metric.overBudgetRatio === 0,
  );
  if (receipt.budgetMet !== derivedBudgetMet)
    errors.push(
      `receipt budgetMet=${receipt.budgetMet} disagrees with its own metrics (derived ${derivedBudgetMet})`,
    );
  if (!receipt.budgetMet)
    errors.push('receipt reports the control budget was not met on the board');
  return {
    passed: errors.length === 0,
    errors,
    stage,
    ageMs: Number.isFinite(ageMs) ? ageMs : null,
    judgedMetric: judged?.name ?? null,
  };
}

/**
 * Parses an untrusted receipt for *display*, without a deployment claim. The
 * station view uses this so a rehearsed-but-not-releasable artifact can still
 * show its numbers with the right caveat attached.
 */
export function summarizeBoardRehearsal(value: unknown): {
  stage: LatencyMeasurementStage;
  summary: string;
  errors: string[];
} {
  const parsed = parseBoardLatencyReceipt(value);
  if (!parsed.receipt)
    return { stage: parsed.stage, summary: '无可用的板端 rehearsal 收据', errors: parsed.errors };
  const judged = selectJudgedMetric(parsed.receipt.metrics);
  const stage = parsed.stage;
  const summary = judged
    ? `${describeLatencyMeasurementStage(stage)}：${judged.name} p50 ${judged.medianMs.toFixed(
        3,
      )} ms / p95 ${judged.p95Ms.toFixed(3)} ms，预算 ${judged.budgetMs.toFixed(3)} ms`
    : `${describeLatencyMeasurementStage(stage)}：收据没有可用指标`;
  return { stage, summary, errors: parsed.errors };
}
