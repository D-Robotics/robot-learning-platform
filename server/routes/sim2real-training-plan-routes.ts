import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Request, Response, Router } from 'express';
import { normalizeTrainingSpec } from '../../shared/sim2real.js';
import { resolveDataDir } from '../sim2real/standalone-adapters.js';
import { sendApiError, wrapAsync } from '../sim2real/http-helpers.js';

const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/;
const planIdPattern = /^[a-f0-9-]{36}$/;
type Bag = Record<string, unknown>;
type Plan = { id: string; name: string; revision: number; updatedAt: string; config: Bag };

class PlanError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'TRAINING_PLAN_INVALID',
  ) {
    super(message);
  }
}

function object(input: unknown, allowed: string[]): Bag {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new PlanError('请提供有效的方案参数。');
  const value = input as Bag;
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new PlanError('方案包含不支持的字段。');
  return value;
}

function numericOptions(input: unknown, fields: Record<string, [number, number]>) {
  const result = object(input, Object.keys(fields));
  for (const [key, raw] of Object.entries(result)) {
    const [min, max] = fields[key];
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < min || raw > max)
      throw new PlanError('高级训练参数超出有效范围。');
  }
  return result;
}

function configFor(input: unknown): Bag {
  const refs = [
    'productId',
    'projectId',
    'taskId',
    'modelId',
    'computeResourceId',
    'demonstrationRunId',
  ];
  const config = object(input, [...refs, 'training', 'resumeFrom']);
  for (const key of refs) {
    const value = config[key];
    if (value !== undefined && (typeof value !== 'string' || !idPattern.test(value)))
      throw new PlanError('机器人、任务或资源标识无效。');
  }
  const keys = [
    'profile',
    'algorithm',
    'engine',
    'numEnvs',
    'maxIterations',
    'video',
    'originmanDance',
    'ppo',
    'taskTuning',
  ];
  const raw = object(config.training, keys);
  const { ppo, taskTuning, ...standard } = raw;
  if (
    ['profile', 'algorithm', 'engine'].some(
      (k) =>
        standard[k] !== undefined &&
        (typeof standard[k] !== 'string' || !idPattern.test(standard[k] as string)),
    ) ||
    ['numEnvs', 'maxIterations'].some(
      (k) => standard[k] !== undefined && !Number.isSafeInteger(standard[k]),
    )
  )
    throw new PlanError('训练档位、算法、引擎或训练规模无效。');
  const { spec, errors } = normalizeTrainingSpec(standard);
  if (!spec || errors.length) throw new PlanError(errors.join('；') || '训练参数无效。');
  const training: Bag = Object.fromEntries(
    Object.keys(standard).map((key) => [key, spec[key as keyof typeof spec]]),
  );
  if (ppo !== undefined)
    training.ppo = numericOptions(ppo, {
      learningRate: [1e-7, 0.01],
      entropyCoefficient: [0, 1],
      clipParameter: [0.01, 0.5],
    });
  if (taskTuning !== undefined)
    training.taskTuning = numericOptions(taskTuning, {
      trackLinearVelocityWeight: [0.1, 20],
      trackAngularVelocityWeight: [0, 20],
      headPoseTrackingWeight: [0, 10],
    });
  if (config.resumeFrom !== undefined) {
    const resume = object(config.resumeFrom, ['checkpointId', 'artifactRef']);
    if (
      typeof resume.checkpointId !== 'string' ||
      !idPattern.test(resume.checkpointId) ||
      typeof resume.artifactRef !== 'string' ||
      !/^artifact:\/\/[a-zA-Z0-9_./:-]{1,490}$/.test(resume.artifactRef)
    )
      throw new PlanError('续训需要有效的 checkpoint 与 artifact 引用。');
  }
  return { ...config, training };
}

const locks = new Map<string, Promise<unknown>>();
async function serial<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const pending = (locks.get(file) ?? Promise.resolve()).catch(() => {}).then(fn);
  locks.set(file, pending);
  try {
    return await pending;
  } finally {
    if (locks.get(file) === pending) locks.delete(file);
  }
}

async function readPlans(file: string): Promise<Plan[]> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > 1_048_576) throw Error('Invalid plan storage');
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!Array.isArray(value)) throw Error('Invalid plan storage');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function writePlans(file: string, plans: Plan[]) {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    const handle = await fs.open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(plans));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

export function registerSim2RealTrainingPlanRoutes(
  router: Router,
  requestOwner: (request: Request, response: Response) => string | undefined | null,
  prefix: string,
  root = resolveDataDir,
) {
  const api = prefix + '/training-plans';
  const handle = (fn: (request: Request, file: string) => Promise<object>) =>
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response);
      if (owner === null) return;
      response.setHeader('Cache-Control', 'no-store');
      const scope = createHash('sha256')
        .update(owner === undefined ? 'local:' : 'account:' + owner)
        .digest('hex');
      try {
        response.json({
          ok: true,
          schemaVersion: 1,
          ...(await fn(request, path.join(root(), 'training-plans', scope + '.json'))),
        });
      } catch (error) {
        if (error instanceof PlanError)
          sendApiError(response, error.status, error.code, error.message);
        else
          sendApiError(
            response,
            503,
            'TRAINING_PLAN_STORAGE_UNAVAILABLE',
            '训练方案暂时无法读取或保存。',
          );
      }
    });
  function find(plans: Plan[], id: unknown) {
    const plan =
      typeof id === 'string' && planIdPattern.test(id) && plans.find((item) => item.id === id);
    if (!plan) throw new PlanError('找不到这套训练方案。', 404, 'TRAINING_PLAN_NOT_FOUND');
    return plan;
  }
  router.get(
    api,
    handle(async (_request, file) => ({
      plans: (await readPlans(file)).map(({ config, ...plan }) => ({
        ...plan,
        productId: config.productId,
        taskId: config.taskId,
      })),
    })),
  );
  router.get(
    api + '/:id',
    handle(async (request, file) => ({
      plan: find(await readPlans(file), request.params.id),
    })),
  );
  const save = (update: boolean) =>
    handle(async (request, file) =>
      serial(file, async () => {
        const body = object(
          request.body,
          update ? ['name', 'config', 'revision'] : ['name', 'config'],
        );
        const name = typeof body.name === 'string' ? body.name.trim().normalize('NFC') : '';
        const hasControlCharacters = Array.from(name).some((character) => {
          const code = character.charCodeAt(0);
          return code < 32 || code === 127;
        });
        if (!name || name.length > 64 || hasControlCharacters)
          throw new PlanError('请输入 1–64 个字符的方案名称。');
        const config = configFor(body.config);
        const plans = await readPlans(file);
        const original = update ? find(plans, request.params.id) : null;
        if (original && body.revision !== original.revision)
          throw new PlanError(
            '方案已在其他窗口更新，请重新加载或另存为。',
            409,
            'TRAINING_PLAN_CHANGED',
          );
        if (
          plans.some(
            (plan) => plan.id !== original?.id && plan.name.toLowerCase() === name.toLowerCase(),
          )
        )
          throw new PlanError('已有同名方案，请换个名称。', 409, 'TRAINING_PLAN_NAME_TAKEN');
        if (!original && plans.length >= 100)
          throw new PlanError('已达到 100 套方案的存储上限。', 409, 'TRAINING_PLAN_LIMIT');
        const plan = {
          id: original?.id ?? randomUUID(),
          name,
          config,
          revision: (original?.revision ?? 0) + 1,
          updatedAt: new Date().toISOString(),
        };
        await writePlans(file, [plan, ...plans.filter((item) => item.id !== plan.id)]);
        return { plan, trainingSubmitted: false };
      }),
    );
  router.post(api, save(false));
  router.put(api + '/:id', save(true));
}
