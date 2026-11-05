/** Durable, owner-scoped experiment references. Runs remain the source of truth. */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export type ExperimentRun = {
  id: string;
  modelId: string;
  status: string;
  training?: unknown;
  metrics?: unknown;
  summary?: string;
  mock?: boolean;
};
export type ExperimentInput = {
  contextId: string;
  runId: string;
  evaluationRunId?: string;
};
type Reference = ExperimentInput & { schemaVersion: 1; createdAt: string };
export type ExperimentView = {
  contextId: string;
  training: { runId: string; status: string };
  evaluation: { runId: string; status: string } | null;
  stage: 'training' | 'evaluation' | 'results' | 'blocked';
  associationVerified: boolean;
  policySha256: string | null;
  clearGain: boolean | null;
  videoRecorded: boolean;
  evidence: 'real-worker' | 'fixture' | 'unverified';
  hardwareVerified: false;
  nextAction: string;
};
type Event = { id: number; at: string; view: ExperimentView };
type Journal = { reference: Reference; revision: number; events: Event[] };
export class ExperimentError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 409,
  ) {
    super(message);
  }
}
const safeId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(value);
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const queues = new Map<string, Promise<unknown>>();
const failed = (status: string) => ['failed', 'blocked', 'cancelled', 'canceled'].includes(status);
const evidence = (run: ExperimentRun) => object(object(run.metrics).originmanWorkshop);
const request = (run: ExperimentRun) => object(object(run.training).originmanWorkshop);

export function experimentView(
  reference: ExperimentInput,
  training: ExperimentRun,
  evaluation: ExperimentRun | null,
): ExperimentView {
  if (training.id !== reference.runId || !training.modelId || !training.status)
    throw new ExperimentError('EXPERIMENT_RUN_MISMATCH', '训练记录身份不一致。');
  if ([evidence(training).phase, request(training).phase].includes('evaluate'))
    throw new ExperimentError('EXPERIMENT_TRAINING_REQUIRED', '不能将评测当作训练。');
  const trainSha = evidence(training).policySha256;
  let verified = false;
  if (evaluation) {
    const sources = [evidence(evaluation).sourceRunId, request(evaluation).sourceRunId].filter(
      (v) => v != null,
    );
    const phases = [evidence(evaluation).phase, request(evaluation).phase].filter((v) => v != null);
    if (
      evaluation.id !== reference.evaluationRunId ||
      evaluation.modelId !== training.modelId ||
      !sources.length ||
      sources.some((v) => v !== training.id) ||
      phases.some((v) => v !== 'evaluate')
    )
      throw new ExperimentError('EXPERIMENT_PARENT_MISMATCH', '评测与本次训练来源不一致。');
    const evalSha = evidence(evaluation).policySha256;
    if (
      (trainSha || evalSha) &&
      (typeof trainSha !== 'string' ||
        !/^[a-f0-9]{64}$/.test(trainSha) ||
        ((evalSha || evaluation.status === 'completed') && evalSha !== trainSha))
    )
      throw new ExperimentError('EXPERIMENT_POLICY_MISMATCH', '评测权重摘要与本次训练不一致。');
    verified =
      training.status === 'completed' &&
      evaluation.status === 'completed' &&
      typeof trainSha === 'string' &&
      trainSha === evalSha;
  }
  const e = evaluation ? evidence(evaluation) : {};
  const video = object(e.video);
  const realWorker = verified && training.mock === false && evaluation?.mock === false;
  const comparison = object(e.feedbackComparison);
  const clearGain = typeof comparison.clearGain === 'boolean' ? comparison.clearGain : e.clearGain;
  const missingEvidence = evaluation?.status === 'completed' && !verified;
  const blocked =
    failed(training.status) || Boolean(evaluation && failed(evaluation.status)) || missingEvidence;
  const stage = blocked
    ? 'blocked'
    : verified
      ? 'results'
      : training.status !== 'completed'
        ? 'training'
        : 'evaluation';
  return {
    contextId: reference.contextId,
    training: { runId: training.id, status: training.status },
    evaluation: evaluation ? { runId: evaluation.id, status: evaluation.status } : null,
    stage,
    associationVerified: verified,
    policySha256: typeof trainSha === 'string' && /^[a-f0-9]{64}$/.test(trainSha) ? trainSha : null,
    clearGain: realWorker && typeof clearGain === 'boolean' ? clearGain : null,
    videoRecorded:
      realWorker &&
      !e.videoError &&
      typeof video.sha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(video.sha256) &&
      Number.isSafeInteger(video.bytes) &&
      Number(video.bytes) > 0,
    hardwareVerified: false,
    evidence: realWorker
      ? 'real-worker'
      : training.mock === true || evaluation?.mock === true
        ? 'fixture'
        : 'unverified',
    nextAction: missingEvidence
      ? '评测已完成，来源与权重证据待核对；保留原任务。'
      : blocked
        ? '查看原任务失败原因，保留本次实验。'
        : stage === 'training'
          ? '等待本次训练。'
          : stage === 'results'
            ? '查看同源对比与回放。'
            : evaluation
              ? '等待本次评测。'
              : '使用本次训练权重做同条件评测。',
  };
}

/** A single service writer serializes each reference; atomic rename protects readers. */
export function createExperimentSessions(options: {
  root: () => string;
  getRun: (id: string, owner?: string) => Promise<ExperimentRun | null>;
}) {
  const location = (owner: string | undefined, contextId: string) => {
    if (!safeId(contextId))
      throw new ExperimentError('EXPERIMENT_INVALID_ID', '实验标识无效。', 400);
    const root = options.root();
    if (!root) throw new ExperimentError('EXPERIMENT_STORAGE_REQUIRED', '实验存储未配置。', 503);
    return path.join(
      root,
      'experiment-sessions',
      digest(owner ?? 'local-development'),
      contextId + '.json',
    );
  };
  const read = async (file: string): Promise<Journal | null> => {
    try {
      for (const directory of [path.dirname(path.dirname(file)), path.dirname(file)]) {
        const info = await fs.lstat(directory);
        if (
          !info.isDirectory() ||
          info.isSymbolicLink() ||
          (process.platform !== 'win32' &&
            (info.mode & 0o077 || (process.getuid && info.uid !== process.getuid())))
        )
          throw new ExperimentError(
            'EXPERIMENT_STORAGE_INVALID',
            '实验目录必须是服务账号的私有目录。',
            503,
          );
      }
      const stat = await fs.lstat(file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 256 * 1024 ||
        (process.platform !== 'win32' &&
          (stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid())))
      )
        throw new ExperimentError('EXPERIMENT_STORAGE_INVALID', '实验记录格式不受支持。', 503);
      const value = JSON.parse(await fs.readFile(file, 'utf8')) as Journal;
      if (
        value.reference?.schemaVersion !== 1 ||
        !safeId(value.reference.contextId) ||
        !safeId(value.reference.runId) ||
        (value.reference.evaluationRunId !== undefined &&
          !safeId(value.reference.evaluationRunId)) ||
        !Number.isSafeInteger(value.revision) ||
        value.revision < 0 ||
        !Array.isArray(value.events) ||
        value.events.length > 128
      )
        throw new ExperimentError('EXPERIMENT_STORAGE_INVALID', '实验记录格式不受支持。', 503);
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };
  const snapshot = async (reference: Reference, owner?: string) => {
    const training = await options.getRun(reference.runId, owner);
    const evaluation = reference.evaluationRunId
      ? await options.getRun(reference.evaluationRunId, owner)
      : null;
    if (!training || (reference.evaluationRunId && !evaluation))
      throw new ExperimentError(
        'EXPERIMENT_RUN_NOT_FOUND',
        '原任务不存在或当前账号无权读取。',
        404,
      );
    return experimentView(reference, training, evaluation);
  };
  const transact = async (
    owner: string | undefined,
    contextId: string,
    input?: ExperimentInput,
  ) => {
    const file = location(owner, contextId);
    const previous = queues.get(file) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        const old = await read(file);
        if (!old && !input)
          throw new ExperimentError('EXPERIMENT_NOT_FOUND', '未找到此实验，请选择明确实验。', 404);
        if (
          input &&
          ((old?.reference.runId && old.reference.runId !== input.runId) ||
            (old?.reference.evaluationRunId &&
              input.evaluationRunId &&
              old.reference.evaluationRunId !== input.evaluationRunId))
        )
          throw new ExperimentError(
            'EXPERIMENT_ALREADY_BOUND',
            '实验已绑定其他任务；新训练请使用新实验。',
          );
        const reference: Reference = {
          ...old?.reference,
          ...input,
          contextId,
          schemaVersion: 1,
          createdAt: old?.reference.createdAt ?? new Date().toISOString(),
          runId: old?.reference.runId ?? input!.runId,
        };
        const view = await snapshot(reference, owner);
        const last = old?.events.at(-1);
        if (last && JSON.stringify(last.view) === JSON.stringify(view)) return { ...old!, view };
        const revision = (old?.revision ?? 0) + 1;
        const journal: Journal = {
          reference,
          revision,
          events: [
            ...(old?.events ?? []),
            {
              id: revision,
              at: new Date().toISOString(),
              view,
            },
          ].slice(-128),
        };
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        // Recheck both private directories after mkdir; a symlink must not redirect writes.
        await read(file);
        const temporary = file + '.' + randomUUID() + '.tmp';
        try {
          const handle = await fs.open(temporary, 'wx', 0o600);
          try {
            await handle.writeFile(JSON.stringify(journal));
            await handle.sync();
          } finally {
            await handle.close();
          }
          await fs.rename(temporary, file);
        } finally {
          await fs.rm(temporary, { force: true });
        }
        return { ...journal, view };
      });
    queues.set(file, operation);
    try {
      return await operation;
    } finally {
      if (queues.get(file) === operation) queues.delete(file);
    }
  };
  return {
    async list(owner?: string) {
      const dir = path.dirname(location(owner, 'inventory'));
      let names: string[];
      try {
        names = await fs.readdir(dir);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw e;
      }
      const items = [];
      for (const name of names.filter((n) => n.endsWith('.json')).slice(-24)) {
        if (!safeId(name.slice(0, -5))) continue;
        const record = await read(path.join(dir, name));
        if (record) {
          let view: ExperimentView | null = null;
          try {
            view = await snapshot(record.reference, owner);
          } catch (e) {
            if (!(e instanceof ExperimentError) || ![404, 409].includes(e.status)) throw e;
          }
          items.push({
            contextId: record.reference.contextId,
            createdAt: record.reference.createdAt,
            view,
          });
        }
      }
      return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async remember(input: ExperimentInput, owner?: string) {
      if (
        !input ||
        Object.keys(input).some((k) => !['contextId', 'runId', 'evaluationRunId'].includes(k)) ||
        !safeId(input.runId) ||
        (input.evaluationRunId !== undefined && !safeId(input.evaluationRunId))
      )
        throw new ExperimentError('EXPERIMENT_INVALID_INPUT', '仅接受明确实验与任务引用。', 400);
      return transact(owner, input.contextId, input);
    },
    async resume(contextId: string, owner?: string) {
      return transact(owner, contextId);
    },
    async events(contextId: string, after: number, owner?: string) {
      if (!Number.isSafeInteger(after) || after < 0)
        throw new ExperimentError('EXPERIMENT_CURSOR_INVALID', '事件游标无效。', 400);
      const state = await transact(owner, contextId);
      if (after > state.revision)
        throw new ExperimentError('EXPERIMENT_CURSOR_INVALID', '事件游标超出当前实验。', 400);
      const reset = after > 0 && after < (state.events[0]?.id ?? 0) - 1;
      return {
        revision: state.revision,
        reset,
        events: reset ? [state.events.at(-1)!] : state.events.filter((e) => e.id > after),
        view: state.view,
      };
    },
  };
}
