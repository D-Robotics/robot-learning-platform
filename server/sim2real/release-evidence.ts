import { validateTaskPackEvalForRelease } from '../../shared/artifact-quality-gate.js';
import type {
  Sim2RealDeploymentMode,
  Sim2RealRunRecord,
} from '../../shared/sim2real.js';

export interface Sim2RealReleaseEvidenceVerdict {
  passed: boolean;
  checkedAt: string;
  runId?: string;
  taskId?: string;
  errors: string[];
  checks: Record<string, boolean | string | number | null>;
}

const DEFAULT_MIN_SUCCESS_RATE = 0.7;
const DEFAULT_MAX_FALL_RATE = 0.15;

/**
 * Server-side release evidence gate for canary/live planning.
 *
 * Preflight is deliberately excluded: it is read-only and useful before a
 * training run exists. Any request that can advance toward artifact staging
 * must bind one completed, non-mock runner result to the same model. Task-Pack
 * reports are independently recomputed instead of trusting their PASS flag.
 */
export function validateRunForDeployment(input: {
  mode: Sim2RealDeploymentMode;
  modelId: string;
  run?: Sim2RealRunRecord | null;
  checkedAt?: string;
}): Sim2RealReleaseEvidenceVerdict {
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  if (input.mode === 'preflight') {
    return {
      passed: true,
      checkedAt,
      errors: [],
      checks: { preflightOnly: true },
    };
  }

  const run = input.run;
  if (!run) {
    return {
      passed: false,
      checkedAt,
      errors: ['a completed training run is required for canary/live deployment'],
      checks: { runFound: false },
    };
  }

  const sameModel = run.modelId === input.modelId;
  const completed = run.status === 'completed';
  const realRunner = run.backend === 'local' || run.backend === 'robogo';
  const nonMock = run.mock !== true;
  const contractValid = run.metrics?.contractValid === true;
  const deployableArtifact = run.artifact?.deployable === true;
  const artifactRefPresent = Boolean(run.artifact?.artifactRef);
  const artifactDigestPresent = Boolean(run.artifact?.sha256);
  const errors: string[] = [];

  if (!sameModel) errors.push('training run belongs to a different model');
  if (!completed) errors.push('training run is not completed');
  if (!realRunner) errors.push('training run did not come from a real local/RoboGo runner');
  if (!nonMock) errors.push('mock training evidence cannot authorize deployment');
  if (!contractValid) errors.push('training run did not prove a valid model contract');
  if (!artifactRefPresent) errors.push('training run is missing an artifact reference');
  if (!deployableArtifact) errors.push('training artifact is not marked deployable');
  if (!artifactDigestPresent) errors.push('training artifact is missing a SHA-256 digest');

  const checks: Record<string, boolean | string | number | null> = {
    runFound: true,
    sameModel,
    completed,
    realRunner,
    nonMock,
    contractValid,
    artifactRefPresent,
    deployableArtifact,
    artifactDigestPresent,
  };

  if (run.taskEvaluation || run.taskId?.endsWith('-goal-navigation')) {
    if (!run.taskId) {
      errors.push('Task-Pack evaluation exists without a run taskId');
    } else {
      const criteria = run.taskEvaluation?.qualityGate?.criteria;
      const nominal = run.taskEvaluation?.trained?.envelopes?.nominal;
      const hard = run.taskEvaluation?.trained?.envelopes?.hard;
      const baselineNominal = run.taskEvaluation?.baseline?.envelopes?.nominal;
      const taskGate = validateTaskPackEvalForRelease({
        taskId: run.taskId,
        report: run.taskEvaluation ?? null,
        requireReport: true,
      });
      checks.taskGatePassed = taskGate.passed;
      checks.taskGateMode = taskGate.gateOn;
      checks.taskSuccessRate = taskGate.successRate;
      checks.taskSuccessRateCiLow = taskGate.successRateCiLow;
      checks.taskCollisionRate = taskGate.collisionRate;
      checks.taskCollisionRateCiHigh = taskGate.collisionRateCiHigh;
      checks.taskEvaluationEpisodes = nominal?.episodes ?? null;
      checks.taskHardEnvelopePresent = Boolean(hard);
      checks.taskBaselineSuccessRate = baselineNominal?.successRate ?? null;
      errors.push(...taskGate.errors.map((error) => `task evaluation: ${error}`));
      if (
        typeof criteria?.minSuccessRate !== 'number' ||
        typeof criteria?.maxCollisionRate !== 'number'
      ) {
        errors.push('task evaluation: release criteria are incomplete');
      }
      if (criteria?.gateOn !== 'ciLowerBound') {
        errors.push('task evaluation: release gate must use a confidence-interval bound');
      }
      if (typeof nominal?.episodes !== 'number' || nominal.episodes < 30) {
        errors.push('task evaluation: nominal envelope requires at least 30 episodes');
      }
      if (typeof hard?.episodes !== 'number' || hard.episodes < 30) {
        errors.push('task evaluation: hard envelope requires at least 30 episodes');
      }
      if (
        typeof baselineNominal?.successRate !== 'number' ||
        typeof nominal?.successRate !== 'number'
      ) {
        errors.push('task evaluation: trained-versus-baseline evidence is missing');
      } else if (nominal.successRate <= baselineNominal.successRate) {
        errors.push('task evaluation: trained policy did not outperform the seeded baseline');
      }
    }
  } else {
    // Legacy/non-Task-Pack runs still need a measurable learning outcome.
    // These conservative defaults match the shipped Task-Pack gate and keep
    // an arbitrary "completed" flag from authorizing a canary.
    const successRate = run.metrics?.successRate;
    const fallRate = run.metrics?.fallRate;
    checks.successRate = successRate ?? null;
    checks.fallRate = fallRate ?? null;
    if (typeof successRate !== 'number') {
      errors.push('training successRate is missing');
    } else if (successRate < DEFAULT_MIN_SUCCESS_RATE) {
      errors.push(
        `training successRate ${successRate.toFixed(2)} is below ${DEFAULT_MIN_SUCCESS_RATE.toFixed(2)}`,
      );
    }
    if (typeof fallRate === 'number' && fallRate > DEFAULT_MAX_FALL_RATE) {
      errors.push(
        `training fallRate ${fallRate.toFixed(2)} is above ${DEFAULT_MAX_FALL_RATE.toFixed(2)}`,
      );
    }
  }

  return {
    passed: errors.length === 0,
    checkedAt,
    runId: run.id,
    ...(run.taskId ? { taskId: run.taskId } : {}),
    errors,
    checks,
  };
}
