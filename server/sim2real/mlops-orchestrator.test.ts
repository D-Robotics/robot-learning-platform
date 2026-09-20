import { describe, expect, it } from 'vitest';

import { buildMLOpsWorkflowPlan } from '../../shared/mlops-workflow.js';
import { InMemoryMLOpsOrchestrator } from './mlops-orchestrator.js';

function plan() {
  return buildMLOpsWorkflowPlan({
    workflowId: 'wf-1',
    idempotencyKey: 'request-1',
    projectId: 'project-1',
    robotId: 'rdk-duck',
    modelId: 'model-1',
    datasetId: 'dataset-1',
    trigger: 'manual',
    includeDeploy: true,
    parameterSnapshot: {
      schemaVersion: 1,
      training: { seed: 1 },
      evaluation: { episodes: 10 },
      runtime: { controlHz: 50 },
    },
    resourceRequest: {
      queue: 'robot-training',
      cpuMillis: 2000,
      memoryMiB: 4096,
      gpuCount: 1,
      priority: 10,
      timeoutSeconds: 600,
    },
  });
}

describe('InMemoryMLOpsOrchestrator', () => {
  it('deduplicates the same idempotency key and rejects a conflicting retry', () => {
    const orchestrator = new InMemoryMLOpsOrchestrator();
    const first = orchestrator.submit(plan(), '2026-09-18T00:00:00.000Z');
    const replay = orchestrator.submit(plan(), '2026-09-18T00:01:00.000Z');
    expect(replay.createdAt).toBe(first.createdAt);
    expect(() =>
      orchestrator.submit(
        { ...plan(), parameterSnapshot: { ...plan().parameterSnapshot, training: { seed: 2 } } },
        '2026-09-18T00:02:00.000Z',
      ),
    ).toThrow('mlops_workflow_idempotency_conflict');
  });

  it('only starts a dependent step after its predecessor succeeds', () => {
    const orchestrator = new InMemoryMLOpsOrchestrator();
    orchestrator.submit(plan());
    orchestrator.reconcile('wf-1');
    expect(() => orchestrator.transitionStep('wf-1', 'train', 'running')).toThrow(
      'mlops_workflow_dependencies_pending',
    );
    orchestrator.transitionStep('wf-1', 'data-preflight', 'running');
    orchestrator.transitionStep('wf-1', 'data-preflight', 'succeeded');
    expect(orchestrator.reconcile('wf-1').spec.steps[1].status).toBe('ready');
  });

  it('cancels active work without rewriting completed evidence', () => {
    const orchestrator = new InMemoryMLOpsOrchestrator();
    orchestrator.submit(plan());
    orchestrator.transitionStep('wf-1', 'data-preflight', 'running');
    const cancelled = orchestrator.cancel('wf-1');
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.spec.steps[0].status).toBe('cancelled');
    expect(cancelled.spec.steps.slice(1).every((step) => step.status === 'cancelled')).toBe(true);
  });
});
