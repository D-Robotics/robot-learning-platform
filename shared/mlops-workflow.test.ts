import { describe, expect, it } from 'vitest';

import {
  MLOPS_WORKFLOW_SCHEMA_VERSION,
  buildMLOpsWorkflowPlan,
  canonicalizeParameters,
  readyWorkflowSteps,
  transitionWorkflowStep,
  validateWorkflowSpec,
  workflowProgress,
} from './mlops-workflow.js';

const base = () => ({
  workflowId: 'wf-1',
  idempotencyKey: 'request-1',
  projectId: 'project-1',
  robotId: 'rdk-duck',
  modelId: 'model-1',
  datasetId: 'dataset-1',
  trigger: 'manual' as const,
  includeDeploy: true,
  parameterSnapshot: {
    schemaVersion: MLOPS_WORKFLOW_SCHEMA_VERSION,
    training: { algorithm: 'ppo', seed: 7 },
    evaluation: { episodes: 50 },
    runtime: { controlHz: 50 },
  },
  resourceRequest: {
    queue: 'robot-training',
    cpuMillis: 4000,
    memoryMiB: 8192,
    gpuCount: 1,
    gpuType: 'nvidia.com/gpu',
    priority: 100,
    timeoutSeconds: 3600,
  },
});

describe('MLOps workflow contract', () => {
  it('builds a deterministic five-step train/evaluate/package/deploy plan', () => {
    const plan = buildMLOpsWorkflowPlan(base());
    expect(plan.steps.map((step) => step.kind)).toEqual([
      'data-preflight',
      'train',
      'evaluate',
      'package',
      'deploy',
    ]);
    expect(readyWorkflowSteps(plan)).toEqual(['data-preflight']);
    expect(workflowProgress(plan)).toMatchObject({ total: 5, percent: 0, blocked: 4 });
  });

  it('supports a four-step plan when deployment is intentionally gated elsewhere', () => {
    const plan = buildMLOpsWorkflowPlan({ ...base(), includeDeploy: false });
    expect(plan.steps).toHaveLength(4);
    expect(plan.steps.at(-1)?.kind).toBe('package');
  });

  it('canonicalizes object keys for stable parameter diffs', () => {
    expect(canonicalizeParameters({ b: 2, a: [true, null] })).toBe('{"a":[true,null],"b":2}');
    expect(() => canonicalizeParameters({ value: Number.NaN })).toThrow('parameter_number_invalid');
  });

  it('rejects cycles and unsafe resource requests before a runner sees them', () => {
    const plan = buildMLOpsWorkflowPlan(base());
    const cyclic = {
      ...plan,
      steps: plan.steps.map((step) =>
        step.key === 'data-preflight' ? { ...step, dependsOn: ['deploy'] } : step,
      ),
    };
    expect(() => validateWorkflowSpec(cyclic)).toThrow('workflow_cycle');
    expect(() =>
      buildMLOpsWorkflowPlan({
        ...base(),
        resourceRequest: { ...base().resourceRequest, gpuCount: 99 },
      }),
    ).toThrow('workflow_gpu_invalid');
  });

  it('enforces retryable step transitions and increments attempts only on start', () => {
    const plan = buildMLOpsWorkflowPlan(base());
    const first = plan.steps[0];
    const running = transitionWorkflowStep(first, 'running');
    expect(running.attempt).toBe(1);
    const failed = transitionWorkflowStep(running, 'failed');
    expect(transitionWorkflowStep(failed, 'ready').status).toBe('ready');
    expect(() => transitionWorkflowStep(first, 'succeeded')).toThrow('workflow_transition_invalid');
  });
});
