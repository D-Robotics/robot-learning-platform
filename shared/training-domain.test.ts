import { describe, expect, it } from 'vitest';
import {
  normalizeTrainingProgress,
  normalizeTrainingStatus,
  trainingNextAction,
  trainingProgressPercent,
} from './training-domain.js';

describe('training domain', () => {
  it('fails closed on unknown runner statuses', () =>
    expect(normalizeTrainingStatus('done')).toBe('unknown'));
  it('clamps progress and computes a user-facing percentage', () => {
    const progress = normalizeTrainingProgress({
      iteration: 12,
      totalIterations: 10,
      meanReward: 1.2,
    });
    expect(progress?.iteration).toBe(10);
    expect(trainingProgressPercent(progress)).toBe(100);
  });
  it('maps terminal states to the shortest next action', () => {
    expect(trainingNextAction({ status: 'completed', artifactRef: 'artifact://x' })).toBe(
      'evaluate',
    );
    expect(trainingNextAction({ status: 'failed' })).toBe('retry');
    expect(trainingNextAction({ status: 'cancelled' })).toBe('resume');
  });
});
