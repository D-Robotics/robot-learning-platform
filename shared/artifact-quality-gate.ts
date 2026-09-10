export interface ArtifactCheckInput { observationSize:number; actionSize:number; manifestObservationSize:number; manifestActionSize:number; hasArtifactRef:boolean; deployable?:boolean; maxAbsAction?:number; }
export function validateArtifactForDeployment(v:ArtifactCheckInput): {passed:boolean; errors:string[]} { const e:string[]=[]; if(v.observationSize!==v.manifestObservationSize)e.push('observation dimension mismatch'); if(v.actionSize!==v.manifestActionSize)e.push('action dimension mismatch'); if(!v.hasArtifactRef)e.push('missing artifact reference'); if(v.deployable===false)e.push('artifact is marked non-deployable'); if(v.maxAbsAction!==undefined&&v.maxAbsAction>1)e.push('action exceeds normalized limit'); return {passed:e.length===0,errors:e}; }

export interface TaskPackEvalReport {
  /** eval-report.json from a goal-navigation training run. */
  taskId: string;
  qualityGate?: { passed?: unknown; errors?: unknown; criteria?: { minSuccessRate?: unknown; maxCollisionRate?: unknown; gateOn?: unknown } };
  trained?: { envelopes?: Record<string, EnvelopeMetrics>; meanReward?: unknown; episodesPerEnvelope?: unknown };
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
export function wilsonBounds(successes: number, total: number, confidence = 0.95): { low: number; high: number } | null {
  if (!Number.isFinite(successes) || !Number.isFinite(total) || total <= 0) return null;
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
export function validateTaskPackEvalForRelease(v: TaskPackGateInput): {passed:boolean; errors:string[]; successRate:number|null; collisionRate:number|null; successRateCiLow:number|null; collisionRateCiHigh:number|null; gateOn:'point'|'ciLowerBound'} {
  const errors: string[] = [];
  const report = v.report;
  if (!report || typeof report !== 'object') {
    errors.push(v.requireReport ? 'eval report is missing (required for release)' : 'eval report is missing');
    return { passed: false, errors, successRate: null, collisionRate: null, successRateCiLow: null, collisionRateCiHigh: null, gateOn: 'point' };
  }
  if (report.taskId !== v.taskId) errors.push(`eval report task mismatch: expected ${v.taskId}, got ${report.taskId}`);
  const criteria = report.qualityGate?.criteria ?? {};
  const gateOnRaw = typeof (criteria as { gateOn?: unknown }).gateOn === 'string' ? (criteria as { gateOn: string }).gateOn : 'point';
  if (gateOnRaw !== 'point' && gateOnRaw !== 'ciLowerBound') errors.push(`unknown gateOn ${gateOnRaw}`);
  const gateOn: 'point'|'ciLowerBound' = gateOnRaw === 'ciLowerBound' ? 'ciLowerBound' : 'point';
  const minSuccessRate = typeof criteria.minSuccessRate === 'number' ? criteria.minSuccessRate : null;
  const maxCollisionRate = typeof criteria.maxCollisionRate === 'number' ? criteria.maxCollisionRate : null;
  const nominal = report.trained?.envelopes?.nominal ?? null;
  const successRate = typeof nominal?.successRate === 'number' ? nominal.successRate : null;
  const collisionRate = typeof nominal?.collisionRate === 'number' ? nominal.collisionRate : null;
  let successRateCiLow = typeof nominal?.successRateCiLow === 'number' ? nominal.successRateCiLow : null;
  let collisionRateCiHigh = typeof nominal?.collisionRateCiHigh === 'number' ? nominal.collisionRateCiHigh : null;
  const episodes = typeof nominal?.episodes === 'number' ? nominal.episodes : null;
  if (gateOn === 'ciLowerBound') {
    if (successRateCiLow === null || collisionRateCiHigh === null) {
      errors.push('nominal envelope confidence bounds missing from eval report (gateOn=ciLowerBound)');
    } else if (episodes !== null && successRate !== null) {
      // Re-derive the bounds from raw counts and cross-check the engine's
      // numbers: a corrupted or hand-edited report cannot pass silently.
      const successes = Math.round(successRate * episodes);
      const collisions = collisionRate === null ? null : Math.round(collisionRate * episodes);
      const successBounds = wilsonBounds(successes, episodes, 0.95);
      if (successBounds && Math.abs(successBounds.low - successRateCiLow) > 0.01) {
        errors.push(`successRate CI low mismatch: recomputed ${successBounds.low.toFixed(4)} vs reported ${successRateCiLow.toFixed(4)}`);
      }
      if (collisions !== null) {
        const collisionBounds = wilsonBounds(collisions, episodes, 0.95);
        if (collisionBounds && Math.abs(collisionBounds.high - collisionRateCiHigh) > 0.01) {
          errors.push(`collisionRate CI high mismatch: recomputed ${collisionBounds.high.toFixed(4)} vs reported ${collisionRateCiHigh.toFixed(4)}`);
        }
      }
    }
  }
  if (successRate === null || collisionRate === null) errors.push('nominal envelope metrics missing from eval report');
  if (minSuccessRate !== null) {
    const judge = gateOn === 'ciLowerBound' ? successRateCiLow : successRate;
    if (judge === null) errors.push(`successRate ${gateOn === 'ciLowerBound' ? 'CI low' : ''} missing for gate`.trim());
    else if (judge < minSuccessRate) errors.push(`successRate${gateOn === 'ciLowerBound' ? ' CI low' : ''} ${judge.toFixed(2)} below gate ${minSuccessRate.toFixed(2)}`);
  }
  if (maxCollisionRate !== null) {
    const judge = gateOn === 'ciLowerBound' ? collisionRateCiHigh : collisionRate;
    if (judge === null) errors.push(`collisionRate ${gateOn === 'ciLowerBound' ? 'CI high' : ''} missing for gate`.trim());
    else if (judge > maxCollisionRate) errors.push(`collisionRate${gateOn === 'ciLowerBound' ? ' CI high' : ''} ${judge.toFixed(2)} above gate ${maxCollisionRate.toFixed(2)}`);
  }
  return { passed: errors.length === 0, errors, successRate, collisionRate, successRateCiLow, collisionRateCiHigh, gateOn };
}
