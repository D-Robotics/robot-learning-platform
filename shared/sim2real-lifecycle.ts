/**
 * Canonical lifecycle rules for the Sim2Real resources.  Routes may expose
 * different operations, but every writer should consult this table before
 * changing a status.  Keeping the rules as pure data makes them easy to use
 * from the API, worker adapters and UI contract tests without importing the
 * JSON ledger.
 */

import type {
  Sim2RealArtifactLifecycleStatus,
  Sim2RealDatasetStatus,
  Sim2RealDeploymentStatus,
  Sim2RealEvaluationStatus,
  Sim2RealRunStatus,
} from './sim2real.js';

export type Sim2RealLifecycleKind = 'run' | 'deployment' | 'artifact' | 'dataset' | 'evaluation';

export type Sim2RealLifecycleStatus =
  | Sim2RealRunStatus
  | Sim2RealDeploymentStatus
  | Sim2RealArtifactLifecycleStatus
  | Sim2RealDatasetStatus
  | Sim2RealEvaluationStatus;

type TransitionTable = Readonly<Record<string, readonly string[]>>;

const TABLES: Record<Sim2RealLifecycleKind, TransitionTable> = {
  run: {
    ready: [],
    queued: ['running', 'completed', 'blocked', 'failed'],
    running: ['completed', 'blocked', 'failed'],
    completed: [],
    blocked: [],
    failed: [],
  },
  deployment: {
    planned: ['running', 'ready', 'blocked', 'failed', 'cancelled'],
    running: ['ready', 'completed', 'blocked', 'failed', 'cancelled'],
    ready: ['running', 'completed', 'blocked', 'failed', 'cancelled'],
    blocked: ['planned', 'running', 'failed', 'cancelled'],
    failed: ['planned', 'cancelled'],
    completed: [],
    cancelled: [],
  },
  artifact: {
    draft: ['validated', 'revoked'],
    validated: ['published', 'revoked'],
    published: ['revoked'],
    revoked: [],
  },
  dataset: {
    registered: ['ready', 'revoked'],
    ready: ['revoked'],
    revoked: [],
  },
  evaluation: {
    pending: ['running', 'invalid', 'failed'],
    running: ['passed', 'failed', 'invalid'],
    passed: [],
    failed: ['pending', 'running'],
    invalid: ['pending'],
  },
};

export function lifecycleTransitions(kind: Sim2RealLifecycleKind): TransitionTable {
  return TABLES[kind];
}

/** Same-status writes are idempotent and always allowed. */
export function canTransition(kind: Sim2RealLifecycleKind, from: string, to: string): boolean {
  const source = String(from ?? '').trim();
  const target = String(to ?? '').trim();
  return source === target || Boolean(TABLES[kind][source]?.includes(target));
}

export function assertLifecycleTransition(
  kind: Sim2RealLifecycleKind,
  from: string,
  to: string,
): void {
  if (canTransition(kind, from, to)) return;
  const error = new Error(`sim2real_${kind}_transition_invalid`);
  Object.assign(error, { code: `sim2real_${kind}_transition_invalid`, from, to });
  throw error;
}

export function isTerminalLifecycleStatus(kind: Sim2RealLifecycleKind, status: string): boolean {
  const normalized = String(status ?? '').trim();
  return (TABLES[kind][normalized] ?? []).length === 0;
}

export type Sim2RealLifecycleMeta = {
  status: string;
  terminal: boolean;
  tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
  label: string;
};

const LABELS: Record<string, string> = {
  ready: '就绪',
  queued: '排队中',
  running: '运行中',
  completed: '已完成',
  blocked: '已阻断',
  failed: '失败',
  planned: '已计划',
  cancelled: '已取消',
  draft: '草稿',
  validated: '已验证',
  published: '已发布',
  revoked: '已撤销',
  registered: '已登记',
  pending: '待处理',
  passed: '通过',
  invalid: '无效',
};

export function lifecycleMeta(kind: Sim2RealLifecycleKind, status: string): Sim2RealLifecycleMeta {
  const normalized = String(status ?? '').trim();
  const tone: Sim2RealLifecycleMeta['tone'] = [
    'completed',
    'ready',
    'passed',
    'published',
  ].includes(normalized)
    ? 'success'
    : ['failed', 'invalid', 'revoked'].includes(normalized)
      ? 'danger'
      : ['blocked', 'cancelled'].includes(normalized)
        ? 'warning'
        : ['running', 'queued', 'pending', 'validated'].includes(normalized)
          ? 'info'
          : 'neutral';
  return {
    status: normalized,
    terminal: isTerminalLifecycleStatus(kind, normalized),
    tone,
    label: LABELS[normalized] ?? (normalized || '未知'),
  };
}

export function lifecycleTableForTests(): Record<Sim2RealLifecycleKind, TransitionTable> {
  return TABLES;
}
