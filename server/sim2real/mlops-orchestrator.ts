import {
  canonicalizeParameters,
  readyWorkflowSteps,
  transitionWorkflowStep,
  validateWorkflowSpec,
  workflowProgress,
  type MLOpsWorkflowSpec,
  type MLOpsWorkflowStepStatus,
} from '../../shared/mlops-workflow.js';

export type MLOpsWorkflowRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface MLOpsWorkflowRecord {
  spec: MLOpsWorkflowSpec;
  status: MLOpsWorkflowRunStatus;
  createdAt: string;
  updatedAt: string;
}

export interface MLOpsOrchestratorPort {
  submit(spec: MLOpsWorkflowSpec, now?: string): MLOpsWorkflowRecord;
  get(workflowId: string): MLOpsWorkflowRecord | undefined;
  reconcile(workflowId: string, now?: string): MLOpsWorkflowRecord;
  transitionStep(
    workflowId: string,
    stepKey: string,
    next: MLOpsWorkflowStepStatus,
    now?: string,
  ): MLOpsWorkflowRecord;
  cancel(workflowId: string, now?: string): MLOpsWorkflowRecord;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function workflowStatus(spec: MLOpsWorkflowSpec): MLOpsWorkflowRunStatus {
  const progress = workflowProgress(spec);
  if (progress.failed > 0) return 'failed';
  if (spec.steps.every((step) => ['succeeded', 'skipped'].includes(step.status))) {
    return 'succeeded';
  }
  if (progress.running > 0) return 'running';
  return 'queued';
}

/**
 * Small deterministic orchestrator used by local adapters and contract tests.
 * A Temporal adapter can persist the same records and call these pure rules at
 * activity boundaries; business routes do not need to know which orchestrator
 * is installed.
 */
export class InMemoryMLOpsOrchestrator implements MLOpsOrchestratorPort {
  private readonly records = new Map<string, MLOpsWorkflowRecord>();
  private readonly idempotency = new Map<string, string>();

  submit(spec: MLOpsWorkflowSpec, now = new Date().toISOString()): MLOpsWorkflowRecord {
    const validated = validateWorkflowSpec(spec);
    const ownerKey = `${validated.projectId}\u0000${validated.idempotencyKey}`;
    const existingId = this.idempotency.get(ownerKey);
    if (existingId) {
      const existing = this.records.get(existingId);
      if (!existing) throw new Error('mlops_workflow_index_corrupt');
      if (canonicalizeParameters(existing.spec) !== canonicalizeParameters(validated)) {
        throw new Error('mlops_workflow_idempotency_conflict');
      }
      return clone(existing);
    }
    if (this.records.has(validated.workflowId)) throw new Error('mlops_workflow_duplicate');
    const record: MLOpsWorkflowRecord = {
      spec: clone(validated),
      status: workflowStatus(validated),
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(validated.workflowId, record);
    this.idempotency.set(ownerKey, validated.workflowId);
    return clone(record);
  }

  get(workflowId: string): MLOpsWorkflowRecord | undefined {
    const record = this.records.get(workflowId);
    return record ? clone(record) : undefined;
  }

  reconcile(workflowId: string, now = new Date().toISOString()): MLOpsWorkflowRecord {
    const record = this.require(workflowId);
    const ready = new Set(readyWorkflowSteps(record.spec));
    record.spec.steps = record.spec.steps.map((step) =>
      ready.has(step.key) && step.status === 'pending' ? { ...step, status: 'ready' } : step,
    );
    record.status = workflowStatus(record.spec);
    record.updatedAt = now;
    return clone(record);
  }

  transitionStep(
    workflowId: string,
    stepKey: string,
    next: MLOpsWorkflowStepStatus,
    now = new Date().toISOString(),
  ): MLOpsWorkflowRecord {
    const record = this.require(workflowId);
    const index = record.spec.steps.findIndex((step) => step.key === stepKey);
    if (index < 0) throw new Error('mlops_workflow_step_not_found');
    const current = record.spec.steps[index];
    const dependenciesDone = current.dependsOn.every(
      (dependency) =>
        record.spec.steps.find((step) => step.key === dependency)?.status === 'succeeded',
    );
    if ((next === 'ready' || next === 'running') && !dependenciesDone) {
      throw new Error('mlops_workflow_dependencies_pending');
    }
    record.spec.steps[index] = transitionWorkflowStep(current, next);
    record.status = workflowStatus(record.spec);
    record.updatedAt = now;
    return clone(record);
  }

  cancel(workflowId: string, now = new Date().toISOString()): MLOpsWorkflowRecord {
    const record = this.require(workflowId);
    record.spec.steps = record.spec.steps.map((step) => {
      if (['pending', 'ready', 'running', 'failed'].includes(step.status)) {
        return transitionWorkflowStep(step, 'cancelled');
      }
      return step;
    });
    record.status = 'cancelled';
    record.updatedAt = now;
    return clone(record);
  }

  private require(workflowId: string): MLOpsWorkflowRecord {
    const record = this.records.get(workflowId);
    if (!record) throw new Error('mlops_workflow_not_found');
    return record;
  }
}
