/** Training domain contract. UI and runners consume this without importing each other. */
export type TrainingRunStatus =
  'draft' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';

export interface TrainingProgress {
  iteration: number;
  totalIterations: number;
  meanReward?: number;
  recentSuccess?: number;
  elapsedSeconds?: number;
}

export interface TrainingRunSummary {
  id: string;
  status: TrainingRunStatus;
  backend: 'local' | 'robogo' | 'mock';
  modelId: string;
  taskId?: string;
  progress?: TrainingProgress;
  artifactRef?: string;
  error?: string;
  updatedAt?: string;
}

export function normalizeTrainingStatus(value: unknown): TrainingRunStatus {
  const status = String(value || 'unknown');
  return ['draft', 'queued', 'running', 'completed', 'failed', 'cancelled', 'unknown'].includes(
    status,
  )
    ? (status as TrainingRunStatus)
    : 'unknown';
}

export function normalizeTrainingProgress(value: unknown): TrainingProgress | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  const iteration = Number(input.iteration);
  const totalIterations = Number(input.totalIterations);
  if (
    !Number.isSafeInteger(iteration) ||
    iteration < 0 ||
    !Number.isSafeInteger(totalIterations) ||
    totalIterations < 1
  )
    return undefined;
  return {
    iteration: Math.min(iteration, totalIterations),
    totalIterations,
    ...(Number.isFinite(Number(input.meanReward)) ? { meanReward: Number(input.meanReward) } : {}),
    ...(Number.isFinite(Number(input.recentSuccess))
      ? { recentSuccess: Number(input.recentSuccess) }
      : {}),
    ...(Number.isFinite(Number(input.elapsedSeconds))
      ? { elapsedSeconds: Number(input.elapsedSeconds) }
      : {}),
  };
}

export function trainingProgressPercent(progress?: TrainingProgress): number {
  if (!progress) return 0;
  return Math.round((progress.iteration / progress.totalIterations) * 100);
}

export function trainingStatusIsTerminal(status: TrainingRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

export function trainingNextAction(
  run: Pick<TrainingRunSummary, 'status' | 'artifactRef'>,
): 'wait' | 'evaluate' | 'retry' | 'resume' | 'inspect' {
  if (run.status === 'completed' && run.artifactRef) return 'evaluate';
  if (run.status === 'failed') return 'retry';
  if (run.status === 'unknown') return 'inspect';
  if (run.status === 'cancelled') return 'resume';
  return 'wait';
}
