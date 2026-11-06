/** Durable learner intent; actual submissions still pass through the normal /runs API. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ExperimentError, type ExperimentRun, type ExperimentView } from './experiment-sessions.js';
type Run = ExperimentRun & { computeResourceId?: string; taskId?: string; training?: unknown };
type Recipe = {
  timesteps: number;
  seed: number;
  pushMaxForce: number;
  reference: 'observed' | 'skipped';
};
type Session = {
  schemaVersion: 1;
  contextId: string;
  modelId: string;
  computeResourceId: string;
  createdAt: string;
  recipe: Recipe | null;
  reference: 'pending' | 'observed' | 'skipped';
  autoContinue: boolean;
  training: string | null;
  evaluation: string | null;
  claims: { train?: string; evaluate?: string };
};
type Dependencies = {
  readExperiment?: (id: string, owner?: string) => Promise<ExperimentView>;
  root: () => string;
  getRun: (id: string, owner?: string) => Promise<Run | null>;
  findRun: (key: string, owner?: string) => Promise<Run | null>;
  remember: (
    input: { contextId: string; runId: string; evaluationRunId?: string },
    owner?: string,
  ) => Promise<unknown>;
};
const object = (x: unknown): Record<string, unknown> =>
  x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
const id = (x: unknown): x is string =>
  typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(x);
const locks = new Map<string, Promise<unknown>>();
const reject = (message: string, code = 'WORKSHOP_ACTION_BLOCKED', status = 409): never => {
  throw new ExperimentError(code, message, status);
};
export function createWorkshopSessions(deps: Dependencies) {
  const directory = (owner?: string) => {
    const root = deps.root();
    if (!root) reject('课程存储未配置。', 'WORKSHOP_STORAGE_REQUIRED', 503);
    return path.join(
      root,
      'workshop-sessions',
      createHash('sha256')
        .update(owner ?? 'local-development')
        .digest('hex'),
    );
  };
  const file = (contextId: string, owner?: string) => {
    if (!id(contextId)) reject('课程标识无效。');
    return path.join(directory(owner), contextId + '.json');
  };
  const privateDir = async (dir: string) => {
    for (const p of [path.dirname(dir), dir]) {
      const s = await fs.lstat(p);
      if (
        !s.isDirectory() ||
        s.isSymbolicLink() ||
        (process.platform !== 'win32' &&
          (s.mode & 0o077 || (process.getuid && s.uid !== process.getuid())))
      )
        reject('课程目录必须为服务账号私有目录。', 'WORKSHOP_STORAGE_INVALID', 503);
    }
  };
  const load = async <T>(name: string): Promise<T | null> => {
    try {
      await privateDir(path.dirname(name));
      const s = await fs.lstat(name);
      if (
        !s.isFile() ||
        s.isSymbolicLink() ||
        s.size > 65536 ||
        (process.platform !== 'win32' &&
          (s.mode & 0o077 || (process.getuid && s.uid !== process.getuid())))
      )
        reject('课程记录不可读。', 'WORKSHOP_STORAGE_INVALID', 503);
      return JSON.parse(await fs.readFile(name, 'utf8')) as T;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  };
  const save = async (name: string, value: unknown) => {
    await fs.mkdir(path.dirname(name), { recursive: true, mode: 0o700 });
    await privateDir(path.dirname(name));
    await load(name);
    const tmp = name + '.' + randomUUID() + '.tmp';
    try {
      const h = await fs.open(tmp, 'wx', 0o600);
      try {
        await h.writeFile(JSON.stringify(value));
        await h.sync();
      } finally {
        await h.close();
      }
      await fs.rename(tmp, name);
      if (process.platform !== 'win32') {
        const directoryHandle = await fs.open(path.dirname(name), 'r');
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
      }
    } finally {
      await fs.rm(tmp, { force: true });
    }
  };
  const serial = async <T>(key: string, fn: () => Promise<T>) => {
    const old = locks.get(key) ?? Promise.resolve();
    const p = old.catch(() => {}).then(fn);
    locks.set(key, p);
    try {
      return await p;
    } finally {
      if (locks.get(key) === p) locks.delete(key);
    }
  };
  const session = async (contextId: string, owner?: string) => {
    const s = await load<Session>(file(contextId, owner));
    if (
      !s ||
      s.schemaVersion !== 1 ||
      s.contextId !== contextId ||
      !id(s.modelId) ||
      !id(s.computeResourceId) ||
      !s.claims
    )
      reject('未找到此课程实验。', 'WORKSHOP_NOT_FOUND', 404);
    return s!;
  };
  const sync = async (s: Session, owner?: string) => {
    for (const phase of ['train', 'evaluate'] as const) {
      if (!s.claims[phase]) continue;
      const found = await deps.findRun(s.contextId + '-' + phase, owner);
      if (!found) continue;
      const t = object(found.training),
        w = object(t.originmanWorkshop);
      if (
        found.modelId !== s.modelId ||
        found.computeResourceId !== s.computeResourceId ||
        found.taskId !== 'originman-recovery' ||
        w.phase !== phase ||
        w.groupId !== s.contextId ||
        w.timesteps !== s.recipe?.timesteps ||
        w.seed !== s.recipe?.seed ||
        w.pushMaxForce !== s.recipe?.pushMaxForce ||
        (phase === 'evaluate' && w.sourceRunId !== s.training)
      )
        reject('课程任务与冻结参数不一致，保留原记录。', 'WORKSHOP_SOURCE_MISMATCH');
      const field = phase === 'train' ? 'training' : 'evaluation';
      if (s[field] && s[field] !== found.id) reject('课程已绑定其他任务。');
      s[field] = found.id;
    }
    if (s.training)
      await deps.remember(
        {
          contextId: s.contextId,
          runId: s.training,
          ...(s.evaluation ? { evaluationRunId: s.evaluation } : {}),
        },
        owner,
      );
    await save(file(s.contextId, owner), s);
    return s;
  };
  const view = async (s: Session, owner?: string) => {
    const training = s.training ? await deps.getRun(s.training!, owner) : null;
    const evaluation = s.evaluation ? await deps.getRun(s.evaluation, owner) : null;
    if ((s.training && !training) || (s.evaluation && !evaluation))
      reject('原任务不存在或无权读取。', 'WORKSHOP_RUN_NOT_FOUND', 404);
    const failed = [training, evaluation].some(
      (r) => r && ['failed', 'blocked', 'cancelled', 'canceled'].includes(r.status),
    );
    const recoveryPhase =
      s.claims.train && !s.training
        ? 'train'
        : s.claims.evaluate && !s.evaluation
          ? 'evaluate'
          : null;
    const stage = failed
      ? 'blocked'
      : recoveryPhase
        ? 'unknown'
        : evaluation?.status === 'completed'
          ? 'results'
          : evaluation
            ? 'evaluating'
            : training?.status === 'completed'
              ? 'ready-evaluate'
              : training
                ? 'training'
                : 'ready';
    return {
      ...s,
      training: training ? { runId: training.id, status: training.status } : null,
      evaluation: evaluation ? { runId: evaluation.id, status: evaluation.status } : null,
      stage,
      recoveryPhase: stage === 'unknown' ? recoveryPhase : null,
      nextAction:
        stage === 'unknown'
          ? '原请求尚未登记。可继续原请求，沿用已确认的预算与参数。'
          : stage === 'blocked'
            ? '原任务未成功，查看原因；不自动重训。'
            : stage === 'results'
              ? '查看本次对比与回放。'
              : stage === 'ready-evaluate'
                ? '评测同一策略。'
                : stage === 'ready'
                  ? '先看参考，再选择一次训练预算。'
                  : '正在等待原任务。',
    };
  };
  const legacy = async (contextId: string, owner?: string) => {
    if (!id(contextId) || !deps.readExperiment) reject('未找到此实验。', 'WORKSHOP_NOT_FOUND', 404);
    const v = await deps.readExperiment!(contextId, owner),
      r = await deps.getRun(v.training.runId, owner);
    if (!r?.computeResourceId) reject('原训练未包含可核对的课程资源。');
    return {
      schemaVersion: 1 as const,
      contextId,
      modelId: r!.modelId,
      computeResourceId: r!.computeResourceId!,
      createdAt: '',
      recipe: null,
      reference: 'pending' as const,
      autoContinue: false,
      claims: {},
      training: v.training,
      evaluation: v.evaluation,
      stage:
        v.stage === 'training' ? 'training' : v.stage === 'evaluation' ? 'evaluating' : v.stage,
      nextAction: v.nextAction,
      legacy: true,
    };
  };
  const read = async (contextId: string, owner?: string) =>
    /^ws-[a-f0-9]{20}$/.test(contextId)
      ? serial(file(contextId, owner), async () =>
          view(await sync(await session(contextId, owner), owner), owner),
        )
      : legacy(contextId, owner);
  const select = async (contextId: string, owner?: string) => {
    await read(contextId, owner);
    await serial(directory(owner), () =>
      save(path.join(directory(owner), 'current.json'), { contextId }),
    );
  };
  return {
    async create(input: { modelId: string; computeResourceId: string }, owner?: string) {
      if (
        !input ||
        Object.keys(input).some((k) => !['modelId', 'computeResourceId'].includes(k)) ||
        !id(input.modelId) ||
        !id(input.computeResourceId)
      )
        reject('需要当前账号的明确课程模型和资源。', 'WORKSHOP_INPUT_INVALID', 400);
      const s: Session = {
        schemaVersion: 1,
        contextId: 'ws-' + randomUUID().replaceAll('-', '').slice(0, 20),
        ...input,
        createdAt: new Date().toISOString(),
        recipe: null,
        reference: 'pending' as const,
        autoContinue: false,
        training: null,
        evaluation: null,
        claims: {},
      };
      await save(file(s.contextId, owner), s);
      await select(s.contextId, owner);
      return view(s, owner);
    },
    read,
    select,
    async current(owner?: string) {
      const pointer = await load<{ contextId: string }>(
        path.join(directory(owner), 'current.json'),
      );
      return pointer ? read(pointer.contextId, owner) : null;
    },
    async list(owner?: string) {
      let names: string[];
      try {
        await privateDir(directory(owner));
        names = await fs.readdir(directory(owner));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw e;
      }
      const records = [];
      for (const name of names.filter((n) => /^ws-[a-f0-9]{20}\.json$/.test(n)).slice(-24)) {
        const s = await session(name.slice(0, -5), owner);
        records.push({
          contextId: s.contextId,
          createdAt: s.createdAt,
          timesteps: s.recipe?.timesteps ?? null,
          started: Boolean(s.claims.train),
        });
      }
      return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async reference(contextId: string, value: unknown, owner?: string) {
      return serial(file(contextId, owner), async () => {
        const s = await session(contextId, owner);
        if (s.claims.train || !['observed', 'skipped'].includes(String(value)))
          reject('参考步骤不可变更。');
        s.reference = value as 'observed' | 'skipped';
        await save(file(contextId, owner), s);
        return view(s, owner);
      });
    },
    async continue(contextId: string, owner?: string) {
      return serial(file(contextId, owner), async () => {
        const s = await session(contextId, owner);
        if (!s.training || s.claims.evaluate) reject('没有可接续的评测步骤。');
        const r = await deps.getRun(s.training!, owner);
        if (r?.status !== 'completed') reject('原训练尚未完成。');
        s.autoContinue = true;
        await save(file(contextId, owner), s);
        return view(s, owner);
      });
    },
    async pause(contextId: string, owner?: string) {
      return serial(file(contextId, owner), async () => {
        const s = await session(contextId, owner);
        s.autoContinue = false;
        await save(file(contextId, owner), s);
        return view(s, owner);
      });
    },
    async claim(contextId: string, phase: 'train' | 'evaluate', input: unknown, owner?: string) {
      return serial(file(contextId, owner), async () => {
        const s = await sync(await session(contextId, owner), owner);
        const args = object(input);
        if (phase !== 'train' && phase !== 'evaluate') reject('课程步骤无效。');
        const recovering = args.recover === true && Object.keys(args).length === 1;
        if (recovering) {
          const boundRun = phase === 'train' ? s.training : s.evaluation;
          if (!s.claims[phase] || !s.recipe || boundRun)
            reject('没有待接续的请求，请刷新查看原任务。');
        } else if (s.claims[phase]) {
          reject('此步骤已发起，请刷新查看原任务。');
        }
        if (phase === 'train' && !recovering) {
          if (
            s.training ||
            Object.keys(args).some(
              (k) => !['timesteps', 'seed', 'pushMaxForce', 'reference'].includes(k),
            ) ||
            !Number.isInteger(args.timesteps) ||
            Number(args.timesteps) < 4096 ||
            Number(args.timesteps) > 1000000 ||
            !Number.isInteger(args.seed) ||
            Number(args.seed) < 0 ||
            Number(args.seed) > 1000000 ||
            typeof args.pushMaxForce !== 'number' ||
            !Number.isFinite(args.pushMaxForce) ||
            args.pushMaxForce < 6.4 ||
            args.pushMaxForce > 9 ||
            !['observed', 'skipped'].includes(String(args.reference))
          )
            reject('请先明确选择预算和参考观察方式。', 'WORKSHOP_RECIPE_REQUIRED', 400);
          s.recipe = args as unknown as Recipe;
          s.reference = s.recipe.reference;
          s.autoContinue = true;
        } else if (phase === 'evaluate') {
          if (
            (!recovering && (Object.keys(args).length || !s.autoContinue)) ||
            !s.training ||
            !s.recipe
          )
            reject('课程已暂停或训练尚未绑定。');
          const r = await deps.getRun(s.training!, owner);
          const m = object(object(r?.metrics).originmanWorkshop),
            t = object(r?.training),
            w = object(t.originmanWorkshop);
          if (
            r?.status !== 'completed' ||
            r.mock !== false ||
            m.phase !== 'train' ||
            !/^([a-f0-9]{64})$/.test(String(m.policySha256 ?? '')) ||
            t.engine !== 'originman-recovery-reflect' ||
            t.algorithm !== 'sac' ||
            t.numEnvs !== 4 ||
            w.timesteps !== s.recipe!.timesteps
          )
            reject('训练未完成或真实策略证据不足，不提交评测。');
        }
        if (!recovering) {
          s.claims[phase] = new Date().toISOString();
          await save(file(contextId, owner), s);
        }
        const recipe = s.recipe!;
        return {
          contextId,
          phase,
          submission: {
            modelId: s.modelId,
            computeResourceId: s.computeResourceId,
            taskId: 'originman-recovery',
            backend: 'local',
            requestedVia: 'workbench',
            label: contextId + ' ' + phase,
            experimentId: contextId,
            idempotencyKey: contextId + '-' + phase,
            training: {
              profile: 'standard',
              engine: 'originman-recovery-reflect',
              algorithm: 'sac',
              numEnvs: 4,
              maxIterations: Math.ceil(recipe.timesteps / 256),
              video: phase === 'evaluate',
              originmanWorkshop: {
                phase,
                timesteps: recipe.timesteps,
                seed: recipe.seed,
                pushMaxForce: recipe.pushMaxForce,
                groupId: contextId,
                device: 'cuda',
                ...(phase === 'evaluate' ? { sourceRunId: s.training } : {}),
              },
            },
          },
        };
      });
    },
  };
}
