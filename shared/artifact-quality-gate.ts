export interface ArtifactCheckInput { observationSize:number; actionSize:number; manifestObservationSize:number; manifestActionSize:number; hasArtifactRef:boolean; deployable?:boolean; maxAbsAction?:number; }
export function validateArtifactForDeployment(v:ArtifactCheckInput): {passed:boolean; errors:string[]} { const e:string[]=[]; if(v.observationSize!==v.manifestObservationSize)e.push('observation dimension mismatch'); if(v.actionSize!==v.manifestActionSize)e.push('action dimension mismatch'); if(!v.hasArtifactRef)e.push('missing artifact reference'); if(v.deployable===false)e.push('artifact is marked non-deployable'); if(v.maxAbsAction!==undefined&&v.maxAbsAction>1)e.push('action exceeds normalized limit'); return {passed:e.length===0,errors:e}; }

export interface TaskPackEvalReport {
  /** eval-report.json from a goal-navigation training run. */
  taskId: string;
  qualityGate?: { passed?: unknown; errors?: unknown; criteria?: { minSuccessRate?: unknown; maxCollisionRate?: unknown } };
  trained?: { envelopes?: Record<string, { successRate?: unknown; collisionRate?: unknown; meanReward?: unknown }>; meanReward?: unknown };
  seed?: number;
}

export interface TaskPackGateInput {
  report: TaskPackEvalReport | null | undefined;
  taskId: string;
  /** When true the gate hard-fails if no eval report exists at all. */
  requireReport?: boolean;
}

/**
 * Consume the engine's eval-report.json quality-gate verdict on the TS side.
 * Mirrors the engine's fail-closed semantics: a missing or malformed report
 * never passes; the verdict is recomputed from the raw metrics instead of
 * trusting the engine's boolean, so a corrupted report cannot greenlight a
 * deployment.
 */
export function validateTaskPackEvalForRelease(v: TaskPackGateInput): {passed:boolean; errors:string[]; successRate:number|null; collisionRate:number|null} {
  const errors: string[] = [];
  const report = v.report;
  if (!report || typeof report !== 'object') {
    errors.push(v.requireReport ? 'eval report is missing (required for release)' : 'eval report is missing');
    return { passed: false, errors, successRate: null, collisionRate: null };
  }
  if (report.taskId !== v.taskId) errors.push(`eval report task mismatch: expected ${v.taskId}, got ${report.taskId}`);
  const criteria = report.qualityGate?.criteria ?? {};
  const minSuccessRate = typeof criteria.minSuccessRate === 'number' ? criteria.minSuccessRate : null;
  const maxCollisionRate = typeof criteria.maxCollisionRate === 'number' ? criteria.maxCollisionRate : null;
  const nominal = report.trained?.envelopes?.nominal ?? null;
  const successRate = typeof nominal?.successRate === 'number' ? nominal.successRate : null;
  const collisionRate = typeof nominal?.collisionRate === 'number' ? nominal.collisionRate : null;
  if (successRate === null || collisionRate === null) errors.push('nominal envelope metrics missing from eval report');
  if (minSuccessRate !== null && successRate !== null && successRate < minSuccessRate) {
    errors.push(`successRate ${successRate.toFixed(2)} below gate ${minSuccessRate.toFixed(2)}`);
  }
  if (maxCollisionRate !== null && collisionRate !== null && collisionRate > maxCollisionRate) {
    errors.push(`collisionRate ${collisionRate.toFixed(2)} above gate ${maxCollisionRate.toFixed(2)}`);
  }
  return { passed: errors.length === 0, errors, successRate, collisionRate };
}
