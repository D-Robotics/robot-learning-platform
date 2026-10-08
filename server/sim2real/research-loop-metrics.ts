/**
 * Research feedback-loop metrics (derived aggregates only).
 *
 * Operationalizes the questions the 2026 RSI analysis raises for any automated
 * R&D platform (Hinton et al., "What if automating AI R&D triggers an
 * intelligence explosion?"): how fast does one experiment→evidence→next
 * experiment cycle turn, how much of the chain runs without a human gate, are
 * successive experiments still buying improvement, and where is the queue
 * actually blocked.  Each question maps onto data the ledger already records;
 * nothing here is a new source of truth.
 *
 * Module contract: pure functions over caller-shaped records.  No I/O, no
 * store imports, no raw record passthrough — the HTTP layer owns owner
 * scoping and stays the only reader of the ledger.  All outputs are
 * aggregate statistics; no run content is echoed back.
 */

export interface ResearchLoopRunInput {
  id?: string;
  backend?: string;
  status?: string;
  mock?: boolean;
  createdAt?: string;
  finishedAt?: string;
  experimentId?: string;
  requestedVia?: string;
  metrics?: { meanReturn?: number; successRate?: number };
  evaluation?: { evaluatedAt?: string; actionMae?: number };
}

export interface ResearchLoopAgentRunInput {
  intent?: string;
  status?: string;
  createdAt?: string;
  steps?: Array<{ status?: string; requiresApproval?: boolean }>;
}

export interface ResearchLoopResourceInput {
  status?: string;
  healthFresh?: boolean;
}

export interface ResearchLoopMetricsInput {
  runs: ResearchLoopRunInput[];
  agentRuns: ResearchLoopAgentRunInput[];
  resources: ResearchLoopResourceInput[];
  nowMs: number;
  /** Look-back window for run-scoped statistics; walls use current state. */
  windowDays: number;
}

export interface ResearchLoopLatencyStats {
  sampleCount: number;
  p50Ms: number | null;
  p90Ms: number | null;
}

export interface ResearchLoopBackendLatency extends ResearchLoopLatencyStats {
  backend: string;
}

export interface ResearchLoopExperimentReturns {
  experimentId: string;
  runCount: number;
  /** Which recorded figure the series is built on; homogeneous per group. */
  metric: 'metrics.meanReturn' | 'metrics.successRate' | 'evaluation.actionMae';
  direction: 'maximize' | 'minimize';
  firstValue: number;
  lastValue: number;
  /** last - first in metric units (not direction-adjusted). */
  netDelta: number;
  deltaCount: number;
  /** Mean delta in the good direction, first vs second half of the series. */
  earlierMeanDelta: number | null;
  recentMeanDelta: number | null;
  trend: 'improving' | 'diminishing' | 'flat' | 'undetermined';
}

export interface ResearchLoopSummary {
  generatedAt: string;
  window: { days: number; sinceIso: string };
  runs: {
    total: number;
    completed: number;
    byRequestedVia: { agent: number; workbench: number; unattributed: number };
    /** Agent share among runs carrying an explicit origin marker; null when
     * none do.  Unattributed (pre-marker) rows are deliberately kept out of
     * the denominator — folding them in would silently dilute the figure the
     * same way an undefined metric definition would. */
    agentShareOfAttributedPct: number | null;
  };
  loopLatency: {
    /** createdAt→finishedAt on completed local/RoboGo training runs.  Mock
     * protocol runs and instant contract checks are excluded: they do not
     * measure a real feedback cycle. */
    training: ResearchLoopLatencyStats;
    byBackend: ResearchLoopBackendLatency[];
    /** createdAt→evaluation.evaluatedAt across completed non-mock runs. */
    toEvaluation: ResearchLoopLatencyStats;
  };
  autonomy: {
    agentRunCount: number;
    agentRunsByStatus: Record<string, number>;
    agentRunsByIntent: Record<string, number>;
    stepTotal: number;
    approvalGatedSteps: number;
    completedApprovalGatedSteps: number;
    completedApprovalFreeSteps: number;
    failedOrBlockedSteps: number;
    /** Longest run of consecutive completed steps with no approval gate. */
    longestApprovalFreeChainSteps: number;
  };
  marginalReturns: ResearchLoopExperimentReturns[];
  experimentCount: number;
  walls: {
    queued: number;
    running: number;
    blocked: number;
    failed: number;
    oldestQueuedWaitMs: number | null;
    computeResources: {
      total: number;
      onlineFresh: number;
      onlineStale: number;
      offline: number;
      other: number;
    };
  };
}

/** Backends whose completed runs measure a real training feedback cycle. */
const TRAINING_LOOP_BACKENDS = new Set(['local', 'robogo']);

/** Group entries kept in the response; the rest are summarized by count. */
const MAX_EXPERIMENT_GROUPS = 20;

const TREND_EPSILON = 1e-9;

function parseMs(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Nearest-rank percentile over an ascending-sorted sample. */
function percentile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index];
}

function latencyStats(samples: number[]): ResearchLoopLatencyStats {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    sampleCount: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p90Ms: percentile(sorted, 0.9),
  };
}

function bucketRecord(record: Record<string, number>, key: unknown): void {
  const name = typeof key === 'string' && key.trim() ? key.trim().slice(0, 40) : 'unknown';
  record[name] = (record[name] ?? 0) + 1;
}

function pickReturnsMetric(
  run: ResearchLoopRunInput,
): Pick<ResearchLoopExperimentReturns, 'metric' | 'direction' | 'firstValue'> | null {
  const meanReturn = finiteNumber(run.metrics?.meanReturn);
  if (meanReturn !== null) {
    return { metric: 'metrics.meanReturn', direction: 'maximize', firstValue: meanReturn };
  }
  const successRate = finiteNumber(run.metrics?.successRate);
  if (successRate !== null) {
    return { metric: 'metrics.successRate', direction: 'maximize', firstValue: successRate };
  }
  const actionMae = finiteNumber(run.evaluation?.actionMae);
  if (actionMae !== null) {
    return { metric: 'evaluation.actionMae', direction: 'minimize', firstValue: actionMae };
  }
  return null;
}

function metricValue(
  run: ResearchLoopRunInput,
  metric: ResearchLoopExperimentReturns['metric'],
): number | null {
  if (metric === 'metrics.meanReturn') return finiteNumber(run.metrics?.meanReturn);
  if (metric === 'metrics.successRate') return finiteNumber(run.metrics?.successRate);
  return finiteNumber(run.evaluation?.actionMae);
}

function classifyTrend(
  deltas: number[],
  direction: ResearchLoopExperimentReturns['direction'],
): {
  trend: ResearchLoopExperimentReturns['trend'];
  earlierMeanDelta: number | null;
  recentMeanDelta: number | null;
} {
  // A trend label needs at least three step-to-step deltas: one delta is a
  // single measurement, two cannot distinguish deceleration from noise.
  if (deltas.length < 3) {
    return { trend: 'undetermined', earlierMeanDelta: null, recentMeanDelta: null };
  }
  const goodDirection = (delta: number) => (direction === 'minimize' ? -delta : delta);
  const signed = deltas.map(goodDirection);
  const split = Math.floor(signed.length / 2);
  const earlier = signed.slice(0, split);
  const recent = signed.slice(split);
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const earlierMeanDelta = mean(earlier);
  const recentMeanDelta = mean(recent);
  let trend: ResearchLoopExperimentReturns['trend'] = 'flat';
  if (recentMeanDelta > earlierMeanDelta + TREND_EPSILON) trend = 'improving';
  else if (recentMeanDelta < earlierMeanDelta - TREND_EPSILON) trend = 'diminishing';
  return { trend, earlierMeanDelta, recentMeanDelta };
}

function computeMarginalReturns(runs: ResearchLoopRunInput[]): {
  groups: ResearchLoopExperimentReturns[];
  experimentCount: number;
} {
  const byExperiment = new Map<string, ResearchLoopRunInput[]>();
  for (const run of runs) {
    const experimentId = typeof run.experimentId === 'string' ? run.experimentId.trim() : '';
    if (!experimentId || run.status !== 'completed' || run.mock === true) continue;
    if (!pickReturnsMetric(run)) continue;
    const bucket = byExperiment.get(experimentId) ?? [];
    bucket.push(run);
    byExperiment.set(experimentId, bucket);
  }

  const groups: ResearchLoopExperimentReturns[] = [];
  for (const [experimentId, members] of byExperiment) {
    if (members.length < 2) continue;
    members.sort((a, b) => (parseMs(a.createdAt) ?? 0) - (parseMs(b.createdAt) ?? 0));
    const head = pickReturnsMetric(members[0]);
    if (!head) continue;
    // Keep the series homogeneous: runs that did not record the group's
    // leading metric would silently mix incompatible quality figures.
    const series = members
      .map((run) => ({ run, value: metricValue(run, head.metric) }))
      .filter((item): item is { run: ResearchLoopRunInput; value: number } => item.value !== null);
    if (series.length < 2) continue;
    const deltas: number[] = [];
    for (let index = 1; index < series.length; index += 1) {
      deltas.push(series[index].value - series[index - 1].value);
    }
    const firstValue = series[0].value;
    const lastValue = series[series.length - 1].value;
    const { trend, earlierMeanDelta, recentMeanDelta } = classifyTrend(deltas, head.direction);
    groups.push({
      experimentId,
      runCount: series.length,
      metric: head.metric,
      direction: head.direction,
      firstValue,
      lastValue,
      netDelta: lastValue - firstValue,
      deltaCount: deltas.length,
      earlierMeanDelta,
      recentMeanDelta,
      trend,
    });
  }

  groups.sort((a, b) => b.runCount - a.runCount || a.experimentId.localeCompare(b.experimentId));
  return { groups: groups.slice(0, MAX_EXPERIMENT_GROUPS), experimentCount: groups.length };
}

export function computeResearchLoopMetrics(input: ResearchLoopMetricsInput): ResearchLoopSummary {
  const windowDays =
    Number.isFinite(input.windowDays) && input.windowDays > 0
      ? Math.min(365, Math.floor(input.windowDays))
      : 30;
  const sinceMs = input.nowMs - windowDays * 24 * 60 * 60 * 1000;
  const inWindow = (run: ResearchLoopRunInput) => {
    const createdAt = parseMs(run.createdAt);
    return createdAt !== null && createdAt >= sinceMs;
  };

  const windowRuns = input.runs.filter(inWindow);

  const byRequestedVia = { agent: 0, workbench: 0, unattributed: 0 };
  let completedCount = 0;
  for (const run of windowRuns) {
    if (run.status === 'completed') completedCount += 1;
    if (run.requestedVia === 'agent') byRequestedVia.agent += 1;
    else if (run.requestedVia === 'workbench') byRequestedVia.workbench += 1;
    else byRequestedVia.unattributed += 1;
  }
  const attributed = byRequestedVia.agent + byRequestedVia.workbench;

  const trainingSamples: number[] = [];
  const trainingByBackend = new Map<string, number[]>();
  const evaluationSamples: number[] = [];
  for (const run of windowRuns) {
    if (run.status !== 'completed' || run.mock === true) continue;
    const createdAt = parseMs(run.createdAt);
    if (createdAt === null) continue;
    const finishedAt = parseMs(run.finishedAt);
    if (
      finishedAt !== null &&
      finishedAt >= createdAt &&
      TRAINING_LOOP_BACKENDS.has(String(run.backend ?? ''))
    ) {
      const duration = finishedAt - createdAt;
      trainingSamples.push(duration);
      const backend = String(run.backend);
      const bucket = trainingByBackend.get(backend) ?? [];
      bucket.push(duration);
      trainingByBackend.set(backend, bucket);
    }
    const evaluatedAt = parseMs(run.evaluation?.evaluatedAt);
    if (evaluatedAt !== null && evaluatedAt >= createdAt) {
      evaluationSamples.push(evaluatedAt - createdAt);
    }
  }

  const agentRunsByStatus: Record<string, number> = {};
  const agentRunsByIntent: Record<string, number> = {};
  let stepTotal = 0;
  let approvalGatedSteps = 0;
  let completedApprovalGatedSteps = 0;
  let completedApprovalFreeSteps = 0;
  let failedOrBlockedSteps = 0;
  let longestApprovalFreeChainSteps = 0;
  for (const agentRun of input.agentRuns) {
    bucketRecord(agentRunsByStatus, agentRun.status);
    bucketRecord(agentRunsByIntent, agentRun.intent);
    let chain = 0;
    for (const step of agentRun.steps ?? []) {
      stepTotal += 1;
      const status = String(step.status ?? '');
      if (step.requiresApproval === true) {
        approvalGatedSteps += 1;
        if (status === 'completed') completedApprovalGatedSteps += 1;
      } else if (status === 'completed') {
        completedApprovalFreeSteps += 1;
      }
      if (status === 'failed' || status === 'blocked') failedOrBlockedSteps += 1;
      chain = status === 'completed' && step.requiresApproval !== true ? chain + 1 : 0;
      if (chain > longestApprovalFreeChainSteps) longestApprovalFreeChainSteps = chain;
    }
  }

  const byStatus = { queued: 0, running: 0, blocked: 0, failed: 0 };
  let oldestQueuedWaitMs: number | null = null;
  // Walls deliberately ignore the look-back window: a run queued before the
  // window is still occupying the queue right now, and hiding it would make
  // the wall look shorter than it is.
  for (const run of input.runs) {
    if (
      run.status === 'queued' ||
      run.status === 'running' ||
      run.status === 'blocked' ||
      run.status === 'failed'
    ) {
      byStatus[run.status] += 1;
    }
    if (run.status === 'queued') {
      const createdAt = parseMs(run.createdAt);
      if (createdAt !== null && createdAt <= input.nowMs) {
        const wait = input.nowMs - createdAt;
        if (oldestQueuedWaitMs === null || wait > oldestQueuedWaitMs) oldestQueuedWaitMs = wait;
      }
    }
  }

  const computeResources = { total: 0, onlineFresh: 0, onlineStale: 0, offline: 0, other: 0 };
  for (const resource of input.resources) {
    computeResources.total += 1;
    const status = String(resource.status ?? '');
    if (status === 'online') {
      if (resource.healthFresh === true) computeResources.onlineFresh += 1;
      else computeResources.onlineStale += 1;
    } else if (status === 'offline') {
      computeResources.offline += 1;
    } else {
      computeResources.other += 1;
    }
  }

  const { groups, experimentCount } = computeMarginalReturns(windowRuns);

  return {
    generatedAt: new Date(input.nowMs).toISOString(),
    window: { days: windowDays, sinceIso: new Date(sinceMs).toISOString() },
    runs: {
      total: windowRuns.length,
      completed: completedCount,
      byRequestedVia,
      agentShareOfAttributedPct:
        attributed > 0 ? Math.round((byRequestedVia.agent / attributed) * 1000) / 10 : null,
    },
    loopLatency: {
      training: latencyStats(trainingSamples),
      byBackend: [...trainingByBackend.entries()]
        .map(([backend, samples]) => ({ backend, ...latencyStats(samples) }))
        .sort((a, b) => a.backend.localeCompare(b.backend)),
      toEvaluation: latencyStats(evaluationSamples),
    },
    autonomy: {
      agentRunCount: input.agentRuns.length,
      agentRunsByStatus,
      agentRunsByIntent,
      stepTotal,
      approvalGatedSteps,
      completedApprovalGatedSteps,
      completedApprovalFreeSteps,
      failedOrBlockedSteps,
      longestApprovalFreeChainSteps,
    },
    marginalReturns: groups,
    experimentCount,
    walls: {
      queued: byStatus.queued,
      running: byStatus.running,
      blocked: byStatus.blocked,
      failed: byStatus.failed,
      oldestQueuedWaitMs,
      computeResources,
    },
  };
}
