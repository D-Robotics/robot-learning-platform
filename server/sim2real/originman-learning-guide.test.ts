import { describe, it, expect } from 'vitest';
import { ORIGINMAN_WORKSHOP_MANIFEST } from '../../shared/originman-workshop.js';
import type { Sim2RealModelRecord, Sim2RealComputeResource } from '../../shared/sim2real.js';
import { buildOriginmanLearningGuide } from './originman-learning-guide.js';

const model = { id: 'origin-model', manifest: ORIGINMAN_WORKSHOP_MANIFEST } as Sim2RealModelRecord;
const resource = {
  id: 'gpu',
  name: 'OriginMan GPU',
  source: 'server-runner',
  status: 'online',
  mock: false,
  engines: ['originman-recovery'],
} as Sim2RealComputeResource;
const input = { model, runs: [], computeResources: [resource] };

describe('OriginMan guidance remains separate from legacy base navigation', () => {
  it('allows preparing from zero without a reference weight or an existing trained artifact', () => {
    const result = buildOriginmanLearningGuide(input, () => true);
    expect(result.training.canSubmitRealTraining).toBe(true);
    expect(result.training.existingArtifactRequiredForTraining).toBe(false);
    expect(result.training.preview?.arguments).toMatchObject({
      algorithm: 'sac',
      engine: 'originman-recovery',
      originmanWorkshop: { device: 'cuda' },
    });
    expect(result.nextAction.tool).toBe('rdk_training_preflight');
    expect(result.hardwareEligible).toBe(false);
    expect(result.readiness.find((r) => r.stage === 'deployment')?.status).toBe('blocked');
  });
  it('does not treat another robot engine, stale health or Mock as ready', () => {
    expect(buildOriginmanLearningGuide(input, () => false).training.canSubmitRealTraining).toBe(
      false,
    );
    for (const change of [{ engines: ['microduck-rl'] }, { mock: true }]) {
      const r = buildOriginmanLearningGuide(
        {
          ...input,
          computeResourceId: resource.id,
          computeResources: [{ ...resource, ...change }],
        },
        () => true,
      );
      expect(r.training.canSubmitRealTraining).toBe(false);
    }
  });
  it('does not replace a missing explicit resource, mismatched contract or unsupported task', () => {
    expect(
      buildOriginmanLearningGuide({ ...input, computeResourceId: 'missing' }, () => true).training
        .canSubmitRealTraining,
    ).toBe(false);
    expect(
      buildOriginmanLearningGuide({ ...input, taskId: 'walk' }, () => true).training
        .canSubmitRealTraining,
    ).toBe(false);
    const wrong = {
      ...model,
      manifest: {
        ...model.manifest,
        contract: { ...model.manifest.contract, observationSize: 41 },
      },
    };
    expect(
      buildOriginmanLearningGuide({ ...input, model: wrong }, () => true).training
        .canSubmitRealTraining,
    ).toBe(false);
  });
  it('does not guess between multiple compatible resources', () => {
    const r = buildOriginmanLearningGuide(
      { ...input, computeResources: [resource, { ...resource, id: 'other' }] },
      () => true,
    );
    expect(r.training.canSubmitRealTraining).toBe(false);
    expect(r.training.selectedResource).toBeNull();
  });
});
