import type {
  Sim2RealEvaluationSummary,
  Sim2RealRunRecord,
  Sim2RealTelemetryRecord,
} from '../../shared/sim2real.js';
import type { Sim2RealTelemetrySample } from '../../shared/sim2real-telemetry.js';

/**
 * Retraining advisor: the read-only half of the telemetry flywheel.
 *
 * The loop is deliberately one-directional in agency: board telemetry flows
 * back as *evidence* (release gate) and now as *analysis* (this module),
 * but nothing here ever submits a training run. The output is a verdict
 * plus a ready-to-use training request the operator can POST /runs with —
 * starting retraining stays a human decision, mirroring the "canary/live
 * needs a bound run" stance.
 *
 * Honesty rules:
 *  - every signal states its own evidence size; below the minimum sample
 *    floor the verdict is "insufficient-evidence", never a silent pass;
 *  - thresholds are advisory (a recommendation to retrain), not release
 *    gates; the release gate stays in release-evidence.ts;
 *  - a replay with source other than "board-agent" is never counted as
 *    real-robot drift evidence.
 */

export interface Sim2RealRetrainingSignal {
  id: string;
  label: string;
  value: number | null;
  threshold: number;
  /** true = value crossed the advisory threshold (retrain recommended). */
  breached: boolean;
  evidence: string;
}

export interface Sim2RealRetrainingAdvice {
  verdict: 'retrain-recommended' | 'healthy' | 'insufficient-evidence';
  checkedAt: string;
  runId: string;
  taskId?: string;
  boardSamples: number;
  signals: Sim2RealRetrainingSignal[];
  summary: string;
  /** Training request the operator may submit to start the recommended run. */
  suggestedTraining?: {
    taskId?: string;
    backend: 'local';
    training: { profile: string; algorithm?: string };
  };
  note: string;
}

/** Minimum board samples before any signal is trustworthy. */
const MIN_BOARD_SAMPLES = 120;
/** Advisory action-MAE level at which retraining is recommended. */
const ACTION_MAE_THRESHOLD = 0.25;
/** Share of telemetry-window time with stale/absent observations. */
const STALE_RATIO_THRESHOLD = 0.3;
/** Share of done-flagged samples (falls/goal-ends/aborts) in the window. */
const DONE_RATIO_THRESHOLD = 0.5;

export function adviseRetraining(input: {
  run: Sim2RealRunRecord;
  evaluation?: Sim2RealEvaluationSummary | null;
  telemetry?: readonly Sim2RealTelemetryRecord[];
  checkedAt?: string;
}): Sim2RealRetrainingAdvice {
  const { run } = input;
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const note =
    '建议为只读分析：绝不自动发起重训；suggestedTraining 只是填好的请求体，' +
    '由操作员显式提交（与 canary/live 必须绑定 run 的立场一致）。';

  const boardSamples =
    input.evaluation?.replay?.source === 'board-agent' ? input.evaluation.replay.sampleCount : 0;

  const signals: Sim2RealRetrainingSignal[] = [];

  // Signal 1 — action error vs the evaluation's reference trajectory.
  const actionMae = input.evaluation?.actionMae ?? null;
  signals.push({
    id: 'action-mae',
    label: '板端动作 MAE（对参考轨迹）',
    value: actionMae,
    threshold: ACTION_MAE_THRESHOLD,
    breached: actionMae != null && actionMae > ACTION_MAE_THRESHOLD,
    evidence:
      actionMae != null
        ? `评测计算于 ${input.evaluation?.evaluatedAt ?? '?'}，参考样本 ${input.evaluation?.referenceSampleCount ?? 0} 条`
        : '没有 reference 轨迹可比（未传 referenceSamples 或未评测）',
  });

  // Signal 2 — telemetry window health: how much of the recorded window the
  // robot reported done/fall (termination-heavy windows suggest the policy
  // is failing on the real floor, not just drifting).
  const samples = (input.telemetry ?? []).flatMap((record) => record.samples);
  const doneRatio = samples.length
    ? samples.filter((sample: Sim2RealTelemetrySample) => sample.done === true).length / samples.length
    : null;
  signals.push({
    id: 'done-ratio',
    label: '板端终止占比（done/fall）',
    value: doneRatio,
    threshold: DONE_RATIO_THRESHOLD,
    breached: doneRatio != null && doneRatio > DONE_RATIO_THRESHOLD,
    evidence: samples.length
      ? `${samples.length} 条遥测样本，${samples.filter((s) => s.done === true).length} 条标记终止`
      : '没有遥测样本可分析',
  });

  // Signal 3 — observation staleness: the runtime publishes a zero frame
  // whenever the telemetry snapshot is stale; a replayed observation vector
  // that is exactly zeroed in a large share of the window is the software
  // footprint of that stalling.
  const staleRatio = samples.length
    ? samples.filter(
        (sample: Sim2RealTelemetrySample) =>
          Array.isArray(sample.observation) && sample.observation.every((v) => v === 0),
      ).length / samples.length
    : null;
  signals.push({
    id: 'stale-observation-ratio',
    label: '全零观测占比（陈旧快照足迹）',
    value: staleRatio,
    threshold: STALE_RATIO_THRESHOLD,
    breached: staleRatio != null && staleRatio > STALE_RATIO_THRESHOLD,
    evidence: samples.length
      ? `${samples.length} 条样本中 ${Math.round((staleRatio ?? 0) * 100)}% 观测为全零`
      : '没有遥测样本可分析',
  });

  // Evidence floor: without board-agent replay samples nothing is trustworthy.
  if (boardSamples < MIN_BOARD_SAMPLES) {
    return {
      verdict: 'insufficient-evidence',
      checkedAt,
      runId: run.id,
      ...(run.taskId ? { taskId: run.taskId } : {}),
      boardSamples,
      signals,
      summary:
        `板端证据不足（${boardSamples}/${MIN_BOARD_SAMPLES} 条 board-agent 回放样本）。` +
        '先在板上跑一次策略会话并回传遥测，再谈重训。',
      note,
    };
  }

  const breached = signals.filter((signal) => signal.breached);
  const verdict = breached.length ? 'retrain-recommended' : 'healthy';
  const summary = breached.length
    ? `建议重训：${breached.map((signal) => signal.label).join('、')} 超过建议阈值。`
    : '板端行为健康：全部信号在建议阈值内（阈值是建议性的，不是发布门）。';

  return {
    verdict,
    checkedAt,
    runId: run.id,
    ...(run.taskId ? { taskId: run.taskId } : {}),
    boardSamples,
    signals,
    summary,
    ...(verdict === 'retrain-recommended'
      ? {
          suggestedTraining: {
            ...(run.taskId ? { taskId: run.taskId } : {}),
            backend: 'local' as const,
            training: {
              profile: 'standard',
              ...(run.training?.algorithm ? { algorithm: run.training.algorithm } : {}),
            },
          },
        }
      : {}),
    note,
  };
}
