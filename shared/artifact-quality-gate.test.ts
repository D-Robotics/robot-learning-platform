import { describe, expect, it } from 'vitest';
import { validateArtifactForDeployment } from './artifact-quality-gate.js';

/** A deployable artifact now additionally needs on-board timing evidence. */
const boardReceipt = {
  schemaVersion: 1,
  measuredAt: new Date().toISOString(),
  tool: 'board-latency-rehearsal/1',
  stage: 'board-onnx',
  device: { host: 'x5-01', machine: 'aarch64', boardModel: 'RDK X5' },
  artifactSha256: 'c'.repeat(64),
  decisionHz: 50,
  provider: 'CPUExecutionProvider',
  metrics: [
    {
      name: 'control-step',
      samples: 300,
      medianMs: 2,
      p95Ms: 3,
      maxMs: 4,
      overBudgetRatio: 0,
      budgetMs: 20,
    },
  ],
  budgetMet: true,
};

describe('artifact quality gate', () => {
  it('passes a matching deployable artifact that carries board evidence', () =>
    expect(
      validateArtifactForDeployment(
        {
          observationSize: 8,
          actionSize: 2,
          manifestObservationSize: 8,
          manifestActionSize: 2,
          hasArtifactRef: true,
          deployable: true,
          maxAbsAction: 0.9,
        },
        { boardRehearsal: boardReceipt },
      ).passed,
    ).toBe(true));
  it('refuses to confirm a deployable artifact on dimensions alone', () =>
    expect(
      validateArtifactForDeployment({
        observationSize: 8,
        actionSize: 2,
        manifestObservationSize: 8,
        manifestActionSize: 2,
        hasArtifactRef: true,
        deployable: true,
        maxAbsAction: 0.9,
      }).errors,
    ).toEqual([
      'no board latency rehearsal receipt: deployable artifacts require an on-board measurement',
    ]));
  it('blocks unsafe artifact', () =>
    expect(
      validateArtifactForDeployment({
        observationSize: 8,
        actionSize: 3,
        manifestObservationSize: 8,
        manifestActionSize: 2,
        hasArtifactRef: false,
        deployable: false,
        maxAbsAction: 2,
      }).errors.length,
    ).toBe(4));
});
