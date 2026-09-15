export type EvaluationStatus = 'pending' | 'running' | 'passed' | 'failed' | 'blocked';
export interface EvaluationSummary {
  id: string;
  status: EvaluationStatus;
  successRate?: number;
  collisionRate?: number;
  episodes?: number;
  error?: string;
}
export function evaluationStatus(value: unknown): EvaluationStatus {
  const v = String(value || 'blocked');
  return ['pending', 'running', 'passed', 'failed', 'blocked'].includes(v)
    ? (v as EvaluationStatus)
    : 'blocked';
}
export function evaluationIsReleaseReady(
  e: Pick<EvaluationSummary, 'status' | 'successRate' | 'collisionRate'>,
): boolean {
  return e.status === 'passed' && (e.successRate ?? 0) >= 0.7 && (e.collisionRate ?? 1) <= 0.15;
}
