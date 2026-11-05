/** Bounded course orchestration over the same authenticated platform tools. No runtime or policy bypass. */
import fs from 'node:fs';
import { prepareTraining } from './workflow-inspection.mjs';
import { experimentContext } from './experiment-context.mjs';
import { selectCourseAssets, registerCourseModel } from './course-setup.mjs';
import { submitOnce, recoverSubmission } from './submission-journal.mjs';
const schema = {
  type: 'object',
  properties: {
    contextId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$' },
  },
  required: ['contextId'],
  additionalProperties: false,
};
const trainSchema = {
  ...schema,
  properties: {
    ...schema.properties,
    modelId: {
      type: 'string',
      minLength: 1,
      maxLength: 160,
      description:
        '通常省略，工具自动匹配当前账号登记模型；只接受用户明确选择的登记项id，不能填manifest.modelId课程标识。',
    },
    computeResourceId: {
      type: 'string',
      minLength: 1,
      maxLength: 160,
      description: '通常省略并沿用宿主课程配置；没有课程配置且需选择时才传登记资源id。',
    },
  },
};
const formalSchema = {
  ...trainSchema,
  properties: {
    ...trainSchema.properties,
    timesteps: {
      type: 'integer',
      minimum: 4096,
      maximum: 1000000,
      description: '用户明确选择的预算；不自动扩训。',
    },
    pushMaxForce: { type: 'number', minimum: 6.4, maximum: 9, default: 8.1 },
    seed: { type: 'integer', minimum: 0, maximum: 1000000, default: 7 },
  },
  required: ['contextId', 'timesteps'],
};
export const SHORT_TRAINING_TOOLS = [
  {
    name: 'rdk_originman_train',
    description:
      'OriginMan课程可选预算训练。用户明确选择训练预算后使用，支持正式500000步和单变量新实验；自动冻结SAC、4环境、CUDA、模型与课程资源。相同contextId只提交一次，改变预算或侧推须新实验；不承诺质量改善。',
    inputSchema: formalSchema,
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'rdk_originman_evaluate',
    description:
      '对已保存的OriginMan课程训练做同源评测，包括正式50万步训练。沿用原训练预算、seed、侧推和实际group默认值，读取既有权重，不重新训练；相同contextId只提交一次。',
    inputSchema: schema,
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'rdk_originman_short_train',
    description:
      '学员要求OriginMan短训练时使用；完整Workshop先按experience_guide实际观察基础PD参考，再调用此训练步骤。自动核对完整manifest、当前账号的课程模型和明确资源；首次会在资源就绪后登记课程模型，固定8192步SAC+CUDA配方并提交一次，保存实验引用。相同contextId复用幂等键；拒绝/失败不改参数不换资源重试。仅仿真。',
    inputSchema: trainSchema,
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'rdk_originman_short_evaluate',
    description:
      '对本实验已完成的真实短训练提交一次同参数评测，冻结sourceRunId与groupId，生成视频并保存关联。未完成、失败、Mock或摘要缺失时拒绝；同contextId不重复评测。',
    inputSchema: schema,
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
];
function validInput(args, name) {
  const allowed = ['rdk_originman_short_train', 'rdk_originman_train'].includes(name)
    ? [
        'contextId',
        'modelId',
        'computeResourceId',
        ...(name === 'rdk_originman_train' ? ['timesteps', 'pushMaxForce', 'seed'] : []),
      ]
    : ['contextId'];
  if (
    !args ||
    Array.isArray(args) ||
    Object.keys(args).some((k) => !allowed.includes(k)) ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$/.test(args.contextId ?? '')
  )
    throw Error('需要唯一的1至24字符contextId；同实验不可改标识重试。');
  if (
    name === 'rdk_originman_train' &&
    (!Number.isInteger(args.timesteps) ||
      args.timesteps < 4096 ||
      args.timesteps > 1000000 ||
      (args.seed !== undefined &&
        (!Number.isInteger(args.seed) || args.seed < 0 || args.seed > 1000000)) ||
      (args.pushMaxForce !== undefined &&
        (typeof args.pushMaxForce !== 'number' ||
          !Number.isFinite(args.pushMaxForce) ||
          args.pushMaxForce < 6.4 ||
          args.pushMaxForce > 9)))
  )
    throw Error('需要用户明确选择的有效训练预算、seed和侧推范围。');
  for (const key of ['modelId', 'computeResourceId'])
    if (
      args[key] !== undefined &&
      (typeof args[key] !== 'string' || !args[key].trim() || args[key].length > 160)
    )
      throw Error('模型和资源必须是平台返回的明确标识。');
}
async function identity(call) {
  const s = await call('rdk_platform_status', {});
  if (
    s.ok !== true ||
    s.health?.ready !== true ||
    s.session?.authenticated !== true ||
    !s.session.accountId
  )
    throw Error('平台未就绪或未认证。');
  return [s.baseUrl, s.session.accountId].join('|');
}
async function sameIdentity(call, start) {
  if ((await identity(call)) !== start) throw Error('平台或账号已变化，停止提交。');
}
function fullRun(value) {
  return value?.lineage?.run;
}
function sha(run) {
  return run?.metrics?.originmanWorkshop?.policySha256;
}
export async function shortTraining(
  name,
  args,
  call,
  {
    directory,
    toolNames = [],
    readModels,
    defaultResourceId,
    courseReadiness,
    submitSchema,
    remote,
  } = {},
) {
  validInput(args, name);
  if (defaultResourceId && args.computeResourceId && args.computeResourceId !== defaultResourceId)
    throw Object.assign(new Error('本轮已由课程配置固定执行资源；尚未提交，不允许自动换机。'), {
      platformCode: 'WORKSHOP_RESOURCE_LOCKED',
      stopWorkflow: true,
      nextAction:
        '保留本实验，不换资源或实验标识；如需调整课堂资源，请由课程维护者在安装配置中处理。',
    });
  const contextId = args.contextId;
  const formal = name === 'rdk_originman_train' || name === 'rdk_originman_evaluate';
  const isEvaluation = name.endsWith('_evaluate');
  const budget = formal ? args.timesteps : 8192;
  const supportsGroup =
    !submitSchema || Boolean(submitSchema.properties?.originmanWorkshop?.properties?.groupId);
  const workshopFields = (value) => {
    const fields = { ...value };
    if (!supportsGroup) {
      if (fields.groupId && fields.groupId !== 'group-01' && isEvaluation)
        throw Error('当前提交契约不能表达原训练groupId；保留原训练，不改写来源或重交。');
      delete fields.groupId;
    }
    return fields;
  };
  const scope = await identity(call);
  const resume = () => experimentContext('resume', { contextId }, call, { directory, remote });
  const remember = (runId, evaluationRunId) =>
    experimentContext(
      'remember',
      { contextId, runId, ...(evaluationRunId ? { evaluationRunId } : {}) },
      call,
      { directory, remote },
    );
  if (isEvaluation) {
    const saved = await resume();
    if (saved.evaluation) return { stage: 'evaluation', alreadySubmitted: true, experiment: saved };
    const recovered = await recoverSubmission({
      scope,
      contextId,
      phase: 'evaluate',
      directory,
      remember: (runId) => remember(saved.training.runId, runId),
    });
    if (recovered) return { stage: 'evaluation', ...recovered };
    const run = fullRun(await call('rdk_lineage_get', { runId: saved.training.runId }));
    if (
      !run ||
      run.id !== saved.training.runId ||
      run.status !== 'completed' ||
      run.mock !== false ||
      run.taskId !== 'originman-recovery' ||
      run.training?.originmanWorkshop?.phase !== 'train' ||
      (!formal &&
        (run.training?.originmanWorkshop?.groupId ?? 'group-01') !==
          (supportsGroup ? contextId : 'group-01')) ||
      !/^([a-f0-9]{64})$/.test(sha(run) ?? '') ||
      run.artifact?.sha256 !== sha(run)
    )
      throw Error('本实验训练未完成、非真实执行或策略来源未核对，不提交评测。');
    const t = run.training;
    if (
      t.engine !== 'originman-recovery-reflect' ||
      t.algorithm !== 'sac' ||
      t.numEnvs !== 4 ||
      (!formal && t.originmanWorkshop.timesteps !== 8192) ||
      !Number.isInteger(t.originmanWorkshop.timesteps) ||
      t.originmanWorkshop.timesteps < 4096 ||
      t.originmanWorkshop.timesteps > 1000000
    )
      throw Error('原训练不是本课程兼容配方，不改写其他实验。');
    const prepared = await prepareTraining(
      {
        productId: 'originman',
        taskId: 'originman-recovery',
        computeResourceId: run.computeResourceId,
      },
      call,
      toolNames,
      { courseReadiness },
    );
    requireConnected(prepared);
    await sameIdentity(call, scope);
    return {
      stage: 'evaluation',
      ...(await submitOnce({
        scope,
        contextId,
        phase: 'evaluate',
        directory,
        remember: (runId) => remember(run.id, runId),
        submit: () =>
          call('rdk_training_submit', {
            modelId: run.modelId,
            computeResourceId: run.computeResourceId,
            backend: 'local',
            taskId: 'originman-recovery',
            profile: 'standard',
            engine: t.engine,
            algorithm: t.algorithm,
            numEnvs: t.numEnvs,
            maxIterations: Math.ceil(t.originmanWorkshop.timesteps / 256),
            video: true,
            originmanWorkshop: workshopFields({
              ...t.originmanWorkshop,
              phase: 'evaluate',
              sourceRunId: run.id,
            }),
            idempotencyKey: contextId + '-eval',
            label: contextId + ' evaluate',
            runName: contextId,
            experimentId: contextId,
          }),
      })),
    };
  }
  if (!['rdk_originman_short_train', 'rdk_originman_train'].includes(name))
    throw Error('Unknown short training operation');
  // Repeated operation reads the durable reference instead of generating another Run.
  try {
    const saved = await resume();
    if (formal) {
      const original = fullRun(await call('rdk_lineage_get', { runId: saved.training.runId }));
      const recipe = original?.training?.originmanWorkshop;
      if (
        original?.id !== saved.training.runId ||
        !recipe ||
        recipe.timesteps !== budget ||
        recipe.seed !== (args.seed ?? 7) ||
        recipe.pushMaxForce !== (args.pushMaxForce ?? 8.1)
      )
        throw Error('已有实验的冻结参数不同；保留原Run，新参数须明确创建新实验。');
    }
    let resource = saved.training.computeResourceId;
    if (args.computeResourceId && !resource) {
      const original = fullRun(await call('rdk_lineage_get', { runId: saved.training.runId }));
      if (original?.id !== saved.training.runId) throw Error('无法核对原Run的资源，不重交。');
      resource = original.computeResourceId;
    }
    if (
      (args.modelId && args.modelId !== saved.training.modelId) ||
      (args.computeResourceId && args.computeResourceId !== resource)
    )
      throw Error('已有实验不能改绑模型或资源；请显式创建新实验。');
    return { stage: 'training', alreadySubmitted: true, experiment: saved };
  } catch (error) {
    if (!error.message.includes('未保存此实验')) throw error;
  }
  const recovered = await recoverSubmission({
    scope,
    contextId,
    phase: 'train',
    directory,
    remember: (runId) => remember(runId),
  });
  if (recovered) return { stage: 'training', ...recovered };
  const manifest = JSON.parse(
    fs.readFileSync(new URL('../references/originman-manifest.json', import.meta.url), 'utf8'),
  );
  const validation = await call('rdk_model_validate', { manifest });
  if (validation.valid !== true)
    throw Error('完整OriginMan参考manifest未通过平台校验：' + JSON.stringify(validation.errors));
  const selected = await selectCourseAssets(
    {
      manifest,
      modelId: args.modelId,
      computeResourceId: args.computeResourceId ?? defaultResourceId,
      readModels,
    },
    call,
  );
  const prepared = await prepareTraining(
    {
      productId: 'originman',
      taskId: 'originman-recovery',
      computeResourceId: selected.resource.id,
    },
    call,
    toolNames,
    { courseReadiness },
  );
  requireConnected(prepared);
  await sameIdentity(call, scope);
  const model = selected.model ?? (await registerCourseModel(manifest, call));
  await sameIdentity(call, scope);
  const submitted = await submitOnce({
    scope,
    contextId,
    phase: 'train',
    directory,
    remember: (runId) => remember(runId),
    submit: () =>
      call('rdk_training_submit', {
        modelId: model.id,
        computeResourceId: selected.resource.id,
        backend: 'local',
        taskId: 'originman-recovery',
        profile: 'standard',
        engine: 'originman-recovery-reflect',
        algorithm: 'sac',
        numEnvs: 4,
        maxIterations: Math.ceil(budget / 256),
        video: false,
        originmanWorkshop: workshopFields({
          phase: 'train',
          timesteps: budget,
          seed: args.seed ?? 7,
          pushMaxForce: args.pushMaxForce ?? 8.1,
          groupId: contextId,
          device: 'cuda',
        }),
        idempotencyKey: contextId + '-train',
        label: contextId + ' train',
        runName: contextId,
        experimentId: contextId,
      }),
  });
  return {
    stage: 'training',
    validation,
    preparation: prepared,
    recipeSource: {
      modelId: model.id,
      computeResourceId: selected.resource.id,
      newModelRegistered: !selected.model,
      note: '按当前账号课程manifest选取模型与资源，不依赖历史训练。',
    },
    ...submitted,
  };
}
function requireConnected(p) {
  if (p.status === 'waiting' && p.platformCode === 'SIM2REAL_ENGINE_PREFLIGHT_BUSY')
    throw Object.assign(new Error(p.reason), {
      platformCode: p.platformCode,
      httpStatus: 429,
      nextAction: p.nextAction,
      details: {
        computeResourceId: p.computeResourceId,
        trainingSubmitted: false,
      },
    });
  if (p.resource?.cuda === false)
    throw Error('所选资源不支持本轮GPU短训练；尚未提交，不自动降级CPU。');
  if (
    p.resource?.connected !== true ||
    p.resource?.status !== 'online' ||
    p.status === 'blocked' ||
    (p.taskEnvironmentVerified !== true &&
      !(
        p.status === 'incomplete' &&
        p.unsupportedTools?.length === 1 &&
        p.unsupportedTools[0] === 'rdk_training_preflight'
      ))
  )
    throw Error('资源/环境准备被拒或无法确认，停止：' + JSON.stringify(p));
}
