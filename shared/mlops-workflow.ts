/**
 * Provider-neutral MLOps workflow contract.
 *
 * The current application can execute a workflow through a local worker, while
 * production deployments may map the same plan to Temporal, Argo or another
 * orchestrator.  Keeping the graph, parameter snapshot and resource request
 * here prevents each runner from inventing a different state machine.
 */

export const MLOPS_WORKFLOW_SCHEMA_VERSION = 1 as const;

export type MLOpsWorkflowTrigger = 'manual' | 'schedule' | 'event';
export type MLOpsWorkflowStepKind = 'data-preflight' | 'train' | 'evaluate' | 'package' | 'deploy';
export type MLOpsWorkflowStepStatus =
  'pending' | 'ready' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'skipped';

export interface MLOpsResourceRequest {
  /** Queue name maps to a Volcano queue or an equivalent scheduler pool. */
  queue: string;
  cpuMillis: number;
  memoryMiB: number;
  gpuCount: number;
  gpuType?: string;
  /** Higher values run first within the project quota. */
  priority: number;
  timeoutSeconds: number;
}

export interface MLOpsParameterSnapshot {
  schemaVersion: typeof MLOPS_WORKFLOW_SCHEMA_VERSION;
  training: Record<string, unknown>;
  evaluation: Record<string, unknown>;
  runtime: Record<string, unknown>;
  source?: {
    gitSha?: string;
    imageDigest?: string;
    createdBy?: string;
  };
}

export interface MLOpsWorkflowStep {
  key: string;
  kind: MLOpsWorkflowStepKind;
  dependsOn: string[];
  status: MLOpsWorkflowStepStatus;
  attempt: number;
  maxAttempts: number;
  resourceRequest: MLOpsResourceRequest;
  inputRefs: Record<string, string>;
  outputRefs: Record<string, string>;
  error?: { code: string; message: string; retryable: boolean };
}

export interface MLOpsWorkflowSpec {
  schemaVersion: typeof MLOPS_WORKFLOW_SCHEMA_VERSION;
  workflowId: string;
  idempotencyKey: string;
  projectId: string;
  robotId: string;
  modelId: string;
  datasetId: string;
  trigger: MLOpsWorkflowTrigger;
  includeDeploy: boolean;
  parameterSnapshot: MLOpsParameterSnapshot;
  resourceRequest: MLOpsResourceRequest;
  steps: MLOpsWorkflowStep[];
}

export interface MLOpsWorkflowProgress {
  total: number;
  succeeded: number;
  running: number;
  failed: number;
  blocked: number;
  percent: number;
}

export const MLOPS_RESOURCE_LIMITS = Object.freeze({
  maxCpuMillis: 1_000_000,
  minMemoryMiB: 128,
  maxMemoryMiB: 1_048_576,
  maxGpuCount: 32,
  maxPriority: 1_000,
  minTimeoutSeconds: 30,
  maxTimeoutSeconds: 7 * 24 * 60 * 60,
});

const STEP_ORDER: readonly [MLOpsWorkflowStepKind, MLOpsWorkflowStepKind][] = [
  ['data-preflight', 'train'],
  ['train', 'evaluate'],
  ['evaluate', 'package'],
  ['package', 'deploy'],
];

const TRANSITIONS: Readonly<Record<MLOpsWorkflowStepStatus, readonly MLOpsWorkflowStepStatus[]>> =
  Object.freeze({
    pending: ['ready', 'cancelled'],
    ready: ['running', 'skipped', 'cancelled'],
    running: ['succeeded', 'failed', 'cancelled'],
    succeeded: [],
    failed: ['ready', 'cancelled'],
    cancelled: [],
    skipped: [],
  });

function fail(message: string): never {
  throw new Error(`mlops_workflow_${message}`);
}

function nonEmpty(value: unknown, name: string): string {
  const result = String(value ?? '').trim();
  if (!result || result.length > 256) fail(`${name}_invalid`);
  return result;
}

function finiteInteger(value: unknown, name: string, min: number, max: number): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) fail(`${name}_invalid`);
  return result;
}

export function validateResourceRequest(request: MLOpsResourceRequest): MLOpsResourceRequest {
  const queue = nonEmpty(request?.queue, 'queue');
  const cpuMillis = finiteInteger(request?.cpuMillis, 'cpu', 1, MLOPS_RESOURCE_LIMITS.maxCpuMillis);
  const memoryMiB = finiteInteger(
    request?.memoryMiB,
    'memory',
    MLOPS_RESOURCE_LIMITS.minMemoryMiB,
    MLOPS_RESOURCE_LIMITS.maxMemoryMiB,
  );
  const gpuCount = finiteInteger(request?.gpuCount, 'gpu', 0, MLOPS_RESOURCE_LIMITS.maxGpuCount);
  const priority = finiteInteger(
    request?.priority,
    'priority',
    0,
    MLOPS_RESOURCE_LIMITS.maxPriority,
  );
  const timeoutSeconds = finiteInteger(
    request?.timeoutSeconds,
    'timeout',
    MLOPS_RESOURCE_LIMITS.minTimeoutSeconds,
    MLOPS_RESOURCE_LIMITS.maxTimeoutSeconds,
  );
  const gpuType =
    request?.gpuType === undefined ? undefined : nonEmpty(request.gpuType, 'gpu_type');
  return {
    queue,
    cpuMillis,
    memoryMiB,
    gpuCount,
    priority,
    timeoutSeconds,
    ...(gpuType ? { gpuType } : {}),
  };
}

/** Deterministic JSON representation used for parameter diffs and cache keys. */
export function canonicalizeParameters(value: unknown): string {
  const seen = new Set<object>();
  function visit(input: unknown): string {
    if (input === null) return 'null';
    if (typeof input === 'string') return JSON.stringify(input);
    if (typeof input === 'boolean') return input ? 'true' : 'false';
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) fail('parameter_number_invalid');
      return JSON.stringify(input);
    }
    if (typeof input !== 'object') fail('parameter_value_invalid');
    const object = input as object;
    if (seen.has(object)) fail('parameter_cycle');
    seen.add(object);
    let result: string;
    if (Array.isArray(input)) result = `[${input.map(visit).join(',')}]`;
    else {
      const record = input as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      if (keys.some((key) => key === '__proto__' || key === 'constructor' || key === 'prototype')) {
        fail('parameter_key_invalid');
      }
      result = `{${keys.map((key) => `${JSON.stringify(key)}:${visit(record[key])}`).join(',')}}`;
    }
    seen.delete(object);
    return result;
  }
  return visit(value);
}

export function validateParameterSnapshot(
  snapshot: MLOpsParameterSnapshot,
): MLOpsParameterSnapshot {
  if (snapshot?.schemaVersion !== MLOPS_WORKFLOW_SCHEMA_VERSION) fail('parameter_schema_invalid');
  for (const key of ['training', 'evaluation', 'runtime'] as const) {
    if (!snapshot[key] || typeof snapshot[key] !== 'object' || Array.isArray(snapshot[key])) {
      fail(`parameter_${key}_invalid`);
    }
    canonicalizeParameters(snapshot[key]);
  }
  if (snapshot.source) canonicalizeParameters(snapshot.source);
  return snapshot;
}

function ensureAcyclic(steps: readonly MLOpsWorkflowStep[]): void {
  const byKey = new Map(steps.map((step) => [step.key, step]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(key: string): void {
    if (visited.has(key)) return;
    if (visiting.has(key)) fail('cycle');
    const step = byKey.get(key);
    if (!step) fail('dependency_missing');
    visiting.add(key);
    step.dependsOn.forEach(visit);
    visiting.delete(key);
    visited.add(key);
  }
  steps.forEach((step) => visit(step.key));
}

export function validateWorkflowSpec(spec: MLOpsWorkflowSpec): MLOpsWorkflowSpec {
  if (spec?.schemaVersion !== MLOPS_WORKFLOW_SCHEMA_VERSION) fail('schema_invalid');
  nonEmpty(spec.workflowId, 'workflow_id');
  nonEmpty(spec.idempotencyKey, 'idempotency_key');
  nonEmpty(spec.projectId, 'project_id');
  nonEmpty(spec.robotId, 'robot_id');
  nonEmpty(spec.modelId, 'model_id');
  nonEmpty(spec.datasetId, 'dataset_id');
  if (!['manual', 'schedule', 'event'].includes(spec.trigger)) fail('trigger_invalid');
  validateResourceRequest(spec.resourceRequest);
  validateParameterSnapshot(spec.parameterSnapshot);
  if (!Array.isArray(spec.steps) || spec.steps.length < 4 || spec.steps.length > 5)
    fail('steps_invalid');
  const keys = new Set<string>();
  for (const step of spec.steps) {
    const key = nonEmpty(step.key, 'step_key');
    if (keys.has(key)) fail('step_duplicate');
    keys.add(key);
    if (!['data-preflight', 'train', 'evaluate', 'package', 'deploy'].includes(step.kind))
      fail('step_kind_invalid');
    if (!TRANSITIONS[step.status]) fail('step_status_invalid');
    finiteInteger(step.attempt, 'attempt', 0, 10_000);
    finiteInteger(step.maxAttempts, 'max_attempts', 1, 10_000);
    if (step.attempt > step.maxAttempts) fail('attempt_exceeds_max');
    validateResourceRequest(step.resourceRequest);
    if (!Array.isArray(step.dependsOn) || step.dependsOn.some((dep) => dep === key))
      fail('dependency_invalid');
  }
  if (!spec.includeDeploy && spec.steps.some((step) => step.kind === 'deploy'))
    fail('deploy_step_unexpected');
  if (spec.includeDeploy && !spec.steps.some((step) => step.kind === 'deploy'))
    fail('deploy_step_missing');
  ensureAcyclic(spec.steps);
  return spec;
}

function step(
  key: string,
  kind: MLOpsWorkflowStepKind,
  dependsOn: string[],
  resourceRequest: MLOpsResourceRequest,
  maxAttempts: number,
): MLOpsWorkflowStep {
  return {
    key,
    kind,
    dependsOn,
    status: dependsOn.length ? 'pending' : 'ready',
    attempt: 0,
    maxAttempts,
    resourceRequest: validateResourceRequest(resourceRequest),
    inputRefs: {},
    outputRefs: {},
  };
}

export function buildMLOpsWorkflowPlan(
  input: Omit<MLOpsWorkflowSpec, 'steps' | 'schemaVersion'>,
): MLOpsWorkflowSpec {
  const base = validateResourceRequest(input.resourceRequest);
  const steps: MLOpsWorkflowStep[] = [
    step('data-preflight', 'data-preflight', [], base, 2),
    step('train', 'train', ['data-preflight'], base, 2),
    step('evaluate', 'evaluate', ['train'], base, 2),
    step('package', 'package', ['evaluate'], base, 2),
  ];
  if (input.includeDeploy) steps.push(step('deploy', 'deploy', ['package'], base, 1));
  return validateWorkflowSpec({ ...input, schemaVersion: MLOPS_WORKFLOW_SCHEMA_VERSION, steps });
}

export function canTransitionWorkflowStep(
  from: MLOpsWorkflowStepStatus,
  to: MLOpsWorkflowStepStatus,
): boolean {
  return from === to || TRANSITIONS[from]?.includes(to) === true;
}

export function transitionWorkflowStep(
  current: MLOpsWorkflowStep,
  next: MLOpsWorkflowStepStatus,
): MLOpsWorkflowStep {
  if (!canTransitionWorkflowStep(current.status, next)) fail('transition_invalid');
  return {
    ...current,
    status: next,
    ...(next === 'running' ? { attempt: current.attempt + 1 } : {}),
  };
}

export function readyWorkflowSteps(spec: MLOpsWorkflowSpec): string[] {
  validateWorkflowSpec(spec);
  const byKey = new Map(spec.steps.map((step) => [step.key, step]));
  return spec.steps
    .filter(
      (step) =>
        (step.status === 'ready' || step.status === 'pending') &&
        step.dependsOn.every((dependency) => byKey.get(dependency)?.status === 'succeeded'),
    )
    .map((step) => step.key);
}

export function workflowProgress(spec: MLOpsWorkflowSpec): MLOpsWorkflowProgress {
  validateWorkflowSpec(spec);
  const total = spec.steps.length;
  const succeeded = spec.steps.filter((step) => step.status === 'succeeded').length;
  const running = spec.steps.filter((step) => step.status === 'running').length;
  const failed = spec.steps.filter((step) => step.status === 'failed').length;
  const blocked = spec.steps.filter((step) =>
    ['pending', 'cancelled'].includes(step.status),
  ).length;
  return {
    total,
    succeeded,
    running,
    failed,
    blocked,
    percent: Math.round((succeeded / total) * 100),
  };
}

export function workflowStepKinds(): readonly MLOpsWorkflowStepKind[] {
  return [...new Set(STEP_ORDER.flat())];
}
