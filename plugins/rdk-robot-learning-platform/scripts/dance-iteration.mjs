import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  DANCE_REWARDS,
  danceCoaching,
  inspectDanceMetrics,
  rewardChangeText,
} from './dance-coaching.mjs';
import {
  DANCE_CONFIG_SCHEMA,
  canonicalDanceConfig,
  danceTrainingBatchSize,
} from './dance-training.mjs';
import { REWARD_TUNING_LIMITS } from './originman-dance-config.mjs';
import { bindTrainingGoal } from './submission-journal.mjs';

const runIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/;
const formalSteps = 500_000;
const maxSteps = 2_000_000;
const parallelEnvs = 64;

const stepBudgetSchema = { type: 'integer', maximum: maxSteps };
const { trainingSteps: _steps, ...goalChoreography } = DANCE_CONFIG_SCHEMA.properties;

export const DANCE_ITERATION_TOOL = {
  name: 'rdk_originman_dance_iterate',
  description:
    '一次授权后从零完成 OriginMan 舞蹈仿真训练：用户给出目标和总步数，先把目标整理为编舞，使用同一个 contextId、RTX 4090 Worker 和 64 并行。训练、独立评测、对比各节拍并自动调整一个奖励或预算后重训，达标或预算耗尽时交付。已有 Run 也可接续。有 nextArguments 时连续调用，按 studioNavigation 在右侧展示。仅仿真。',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['goal'],
    properties: {
      goal: { type: 'string', enum: ['dance-quality-gate', 'original-quality-gate'] },
      contextId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$' },
      computeResourceId: { type: 'string', minLength: 1, maxLength: 160 },
      modelId: { type: 'string', minLength: 1, maxLength: 160 },
      dance: { ...DANCE_CONFIG_SCHEMA, properties: goalChoreography },
      totalSteps: { ...stepBudgetSchema, minimum: 8192 },
      runId: { type: 'string', pattern: runIdPattern.source },
      additionalSteps: { ...stepBudgetSchema, minimum: 0 },
    },
    oneOf: [
      { required: ['contextId', 'computeResourceId', 'dance', 'totalSteps'] },
      { required: ['runId', 'additionalSteps'] },
    ],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
};

function chooseChange(run, remaining, batchSize) {
  const original = run.training.originmanDance;
  const available = Math.floor(remaining / batchSize) * batchSize;
  if (available < 8192)
    return { state: 'budget-exhausted', reason: '剩余步数不足一个最小训练预算。' };
  if (original.trainingSteps < formalSteps) {
    const trainingSteps = Math.min(formalSteps, available);
    if (trainingSteps <= run.metrics.trainingSteps)
      return { state: 'budget-exhausted', reason: '剩余步数不足以提高本轮已执行的训练预算。' };
    return {
      dance: { ...original, title: 'OriginMan 舞蹈 · 自动提高训练预算', trainingSteps },
      change: `训练预算 ${original.trainingSteps.toLocaleString('zh-CN')} → ${trainingSteps.toLocaleString('zh-CN')} 步`,
    };
  }
  if (available < Math.ceil(original.trainingSteps / batchSize) * batchSize)
    return {
      state: 'budget-exhausted',
      reason: '剩余步数不足以按同一训练预算重跑一轮单变量对照。',
    };
  const advice = danceCoaching(run, run.id);
  if (advice?.status !== 'reward-experiment')
    return {
      state: 'blocked',
      reason: advice?.text ?? '当前评测没有足够证据确定下一项参数。',
    };
  const { key, before, after } = advice.parameter;
  return {
    dance: {
      ...original,
      title: 'OriginMan 舞蹈 · 自动调整奖励',
      rewardTuning: { ...original.rewardTuning, [key]: after },
    },
    change: rewardChangeText(key, before, after),
  };
}

// A stable context for each round lets the existing journal replay the receipt after a reconnect.
function roundContext(account, baseUrl, args, index) {
  const inputs = args.runId
    ? [args.runId, args.additionalSteps]
    : [
        args.contextId,
        args.computeResourceId,
        args.modelId,
        canonicalDanceConfig(args.dance),
        args.totalSteps,
      ];
  return (
    'auto-' +
    createHash('sha256')
      .update(JSON.stringify([account, baseUrl, ...inputs, index]))
      .digest('hex')
      .slice(0, 19)
  );
}

const gpu4090 = (value) => typeof value === 'string' && /\bRTX\s+4090\b/i.test(value);
export const matchesDanceIterationGpu = (worker) => worker.cuda === true && gpu4090(worker.gpuName);

function matchesIterationRun(run, baseline, plan, reservation, profile) {
  if (
    run?.taskId !== 'originman-dance' ||
    run.mock !== false ||
    run.training?.engine !== 'originman-dance-ppo' ||
    run.training?.numEnvs !== profile.numEnvs ||
    !run.computeResourceId ||
    !run.modelId ||
    !Number.isSafeInteger(run.training?.originmanDance?.trainingSteps) ||
    !profile.matchesDevice(run.metrics) ||
    !Number.isSafeInteger(run.metrics.trainingSteps) ||
    run.metrics.trainingSteps <= 0
  )
    return false;
  if (!plan) return true;
  const { title: _actualTitle, ...actual } = run.training.originmanDance;
  const { title: _plannedTitle, ...expected } = plan;
  return (
    (!baseline ||
      (run.modelId === baseline.modelId &&
        run.computeResourceId === baseline.computeResourceId &&
        run.contractId === baseline.contractId &&
        run.metrics.originmanDance.sceneProvenance.sceneSha256 ===
          baseline.metrics.originmanDance.sceneProvenance.sceneSha256)) &&
    isDeepStrictEqual(actual, expected) &&
    run.metrics.trainingSteps <= reservation
  );
}

function renderIteration(result, args, baseUrl) {
  const body = { ...result, additionalSteps: args.additionalSteps ?? args.totalSteps };
  const url = new URL('./dance-iterations.html', baseUrl.replace(/\/+$/, '') + '/');
  url.hash = new URLSearchParams({ iteration: JSON.stringify(body) }).toString();
  return {
    iteration: body,
    links: { iteration: url.href },
    studioNavigation: { tool: 'studio_open_url', arguments: { url: url.href } },
    ...(result.state === 'waiting' && {
      nextTool: DANCE_ITERATION_TOOL.name,
      nextArguments: args,
    }),
    studentReply: result.reason,
    delivery:
      '首次按 studioNavigation 在右侧打开逐轮结果，后续回执更新同一个结果页面。如有 nextArguments，自动接续本组目标和预算。终态汇报逐轮改动和结果。',
  };
}

const planKey = (dance) =>
  JSON.stringify([dance.trainingSteps, Object.entries(dance.rewardTuning ?? {}).sort()]);

function assessRun(run) {
  const dance = run.training.originmanDance;
  const evaluations = run.metrics.originmanDance?.evaluations;
  const bpms = [
    ...new Set([Math.max(80, dance.bpm * 0.95), dance.bpm, Math.min(140, dance.bpm * 1.05)]),
  ];
  if (evaluations?.length !== bpms.length) return null;
  const deficits = new Map();
  let unstable = 0;
  let passed = 0;
  let gap = 0;
  for (const bpm of bpms) {
    const row = evaluations.find((entry) => Math.abs(entry.bpm - bpm) < 0.001);
    if (row?.sections?.length !== dance.sections.length) return null;
    for (const [index, section] of row.sections.entries()) {
      if (
        section.type !== dance.sections[index].type ||
        typeof section.clean !== 'boolean' ||
        typeof section.passed !== 'boolean'
      )
        return null;
      unstable += Number(!section.clean);
      passed += Number(section.passed);
      const checks = inspectDanceMetrics(section);
      for (const { operator, threshold, value, met, reward } of checks) {
        if (value === undefined && section.clean) return null;
        if (value === undefined || met) continue;
        const deficit = Math.max(
          0,
          (operator === '<' ? value - threshold : threshold - value) / threshold,
        );
        gap += deficit;
        if (reward) deficits.set(reward, (deficits.get(reward) ?? 0) + deficit);
      }
    }
  }
  return { run, unstable, passed, gap, deficits };
}

function compareTrials(left, right) {
  return left.unstable - right.unstable || right.passed - left.passed || left.gap - right.gap;
}

function nextGoalTrial(history, remaining, batchSize) {
  const available = Math.floor(remaining / batchSize) * batchSize;
  if (available < 8192) return { state: 'budget-exhausted', reason: '剩余预算不足一次训练。' };
  const last = history.at(-1).run;
  const incumbent = [...history].sort(compareTrials)[0];
  if (last.training.originmanDance.trainingSteps < formalSteps)
    return {
      ...chooseChange(last, available, batchSize),
      parentRunId: last.id,
      bestRunId: incumbent.run.id,
    };
  const original = incumbent.run.training.originmanDance;
  const trainingSteps = Math.max(formalSteps, original.trainingSteps);
  if (available < Math.ceil(trainingSteps / batchSize) * batchSize)
    return {
      state: 'budget-exhausted',
      reason: '剩余预算不足一轮同等训练量的参数对照。',
      bestRunId: incumbent.run.id,
    };
  const strengths = [...incumbent.deficits.entries()].sort((a, b) => b[1] - a[1]);
  const keys = strengths.map(([key]) => key);
  if (incumbent.unstable) keys.unshift('tiltPenalty');
  const defaults = Object.fromEntries(
    Object.entries(DANCE_REWARDS).map(([key, rule]) => [key, rule.defaultValue]),
  );
  const visited = new Set(history.map(({ run }) => planKey(run.training.originmanDance)));
  for (const direction of [1, -1]) {
    for (const key of keys) {
      const rule = DANCE_REWARDS[key];
      const limits = REWARD_TUNING_LIMITS[key];
      const before = original.rewardTuning?.[key] ?? defaults[key];
      const after = Math.min(
        limits.max,
        Math.max(limits.min, Number((before + direction * rule.increment).toFixed(3))),
      );
      if (before === after) continue;
      const dance = {
        ...original,
        title: 'OriginMan 舞蹈 · 自动搜索',
        trainingSteps,
        rewardTuning: { ...original.rewardTuning, [key]: after },
      };
      if (visited.has(planKey(dance))) continue;
      return {
        dance,
        change: rewardChangeText(key, before, after),
        parentRunId: incumbent.run.id,
        bestRunId: incumbent.run.id,
      };
    }
  }
  return {
    state: 'blocked',
    reason: '现有证据支持的单参数候选均已试过或到达范围边界。',
    bestRunId: incumbent.run.id,
  };
}

function firstGoalTrial(args, batchSize) {
  const available = Math.floor(args.totalSteps / batchSize) * batchSize;
  const reserve = Math.ceil(formalSteps / batchSize) * batchSize;
  const trainingSteps = available >= reserve + 8192 ? 8192 : Math.min(formalSteps, available);
  return {
    dance: canonicalDanceConfig({ ...args.dance, trainingSteps }),
    change: `首次训练 · ${trainingSteps.toLocaleString('zh-CN')} 步`,
  };
}

function checkArgs(args) {
  const fromGoal = args.goal === 'dance-quality-gate';
  const allowed = fromGoal
    ? ['goal', 'contextId', 'computeResourceId', 'modelId', 'dance', 'totalSteps']
    : ['goal', 'runId', 'additionalSteps'];
  const budget = fromGoal ? args.totalSteps : args.additionalSteps;
  if (
    !Number.isSafeInteger(budget) ||
    budget < (fromGoal ? 8192 : 0) ||
    budget > maxSteps ||
    Object.keys(args).some((key) => !allowed.includes(key)) ||
    (fromGoal
      ? typeof args.contextId !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$/.test(args.contextId) ||
        typeof args.computeResourceId !== 'string' ||
        !args.computeResourceId ||
        args.computeResourceId.length > 160 ||
        (args.modelId !== undefined &&
          (typeof args.modelId !== 'string' || !args.modelId || args.modelId.length > 160)) ||
        !args.dance ||
        args.dance.trainingSteps !== undefined
      : args.goal !== 'original-quality-gate' ||
        typeof args.runId !== 'string' ||
        !runIdPattern.test(args.runId))
  )
    throw Error('请提供受支持的原仿真质量目标、算力与编舞（或原 Run），以及授权训练预算。');
  return fromGoal;
}

const studioProfile = {
  numEnvs: parallelEnvs,
  label: 'RTX 4090',
  matchesDevice: (metrics) =>
    metrics?.trainingDevice === 'cuda' && gpu4090(metrics.trainingDeviceName),
};

export function createDanceIteration({
  baseUrl,
  account,
  accept,
  recover,
  submit,
  contextDirectory,
  profile = studioProfile,
}) {
  const batchSize = danceTrainingBatchSize(profile.numEnvs);
  const completed = new Map();
  return async (args, signal) => {
    const fromGoal = checkArgs(args);
    const owner = await account();
    if (!owner) throw Error('请先核对 Studio 当前学习平台账号。');
    if (fromGoal) {
      const { title, ...dance } = canonicalDanceConfig(args.dance);
      const goalDigest = createHash('sha256')
        .update(
          JSON.stringify([args.computeResourceId, args.modelId, title, dance, args.totalSteps]),
        )
        .digest('hex');
      bindTrainingGoal({
        account: owner,
        audience: baseUrl,
        contextId: args.contextId,
        goalDigest,
        directory: contextDirectory,
      });
    }
    const rounds = [];
    const history = [];
    let spentSteps = 0;
    let runId = args.runId;
    let baseline;
    let bestRunId;
    let plan = fromGoal ? firstGoalTrial(args, batchSize) : { change: '原 Run' };
    let reservation = 0;
    const finish = (state, reason) =>
      renderIteration(
        {
          state,
          reason,
          rounds,
          spentSteps,
          bestRunId,
          accelerator: profile.label,
          numEnvs: profile.numEnvs,
        },
        args,
        baseUrl,
      );
    const enqueue = async (index) => {
      reservation = Math.ceil(plan.dance.trainingSteps / batchSize) * batchSize;
      const contextId = roundContext(owner, baseUrl, args, index);
      try {
        const receipt = await recover(contextId);
        if ((await account()) !== owner)
          return finish('blocked', '平台账号已改变，请回原账号继续。');
        const next =
          receipt ??
          (await submit(
            {
              contextId,
              previousRunId: plan.parentRunId ?? runId,
              modelId: baseline?.modelId ?? args.modelId,
              computeResourceId: baseline?.computeResourceId ?? args.computeResourceId,
              numEnvs: profile.numEnvs,
              dance: plan.dance,
            },
            signal,
          ));
        const nextRun = next.submission?.runId;
        if (!runIdPattern.test(nextRun ?? '') || rounds.some((round) => round.runId === nextRun))
          return finish('blocked', '提交回执没有返回新的 Run，保留原记录。');
        spentSteps += reservation;
        runId = nextRun;
        if (!receipt && !next.alreadySubmitted) {
          rounds.push({
            runId,
            change: plan.change,
            state: 'waiting',
            reservedSteps: reservation,
            parentRunId: plan.parentRunId,
          });
          return finish('waiting', '已提交本轮，等待训练和仿真评测。');
        }
      } catch (error) {
        signal?.throwIfAborted();
        return finish('blocked', error.message);
      }
    };
    if (fromGoal) {
      const first = await enqueue(0);
      if (first) return first;
    }

    for (let index = 0; ; index++) {
      signal?.throwIfAborted();
      const key = JSON.stringify([owner, runId]);
      let accepted = completed.get(key);
      if (!accepted) {
        accepted = await accept(runId, signal);
        if (['passed', 'failed'].includes(accepted.simulationAcceptance?.state)) {
          completed.set(key, accepted);
          if (completed.size > 24) completed.delete(completed.keys().next().value);
        }
      }
      const { run, simulationAcceptance, runDelivery } = accepted;
      const state = simulationAcceptance?.state;
      rounds.push({
        runId,
        change: plan.change,
        parentRunId: plan.parentRunId,
        state,
        steps: run?.metrics?.trainingSteps,
        replay: runDelivery?.replay === 'simulation',
        policy: runDelivery?.policy === 'available',
      });
      if (state === 'waiting') return finish('waiting', '正在等待本轮训练和仿真评测。');
      if (!['passed', 'failed'].includes(state))
        return finish('blocked', simulationAcceptance?.reason ?? '本轮未取得可核验的仿真评测。');
      if (fromGoal && simulationAcceptance.allTemposVerified !== true) {
        rounds.at(-1).state = 'unverified';
        return finish('blocked', '独立评测尚未核对全部节拍。');
      }
      if (
        run?.id !== runId ||
        !matchesIterationRun(run, baseline, plan.dance, reservation, profile) ||
        (fromGoal && run.computeResourceId !== args.computeResourceId) ||
        (fromGoal && args.modelId && run.modelId !== args.modelId)
      ) {
        rounds.at(-1).state = 'unverified';
        return finish('blocked', '本轮配置、4090、64 并行或实际步数与授权不一致。');
      }
      baseline ??= run;
      if (state === 'passed') {
        bestRunId = runId;
        return finish('passed', '已通过原仿真质量门，自动迭代结束。');
      }

      if (fromGoal) {
        const trial = assessRun(run);
        if (!trial) return finish('blocked', '各节拍的分项评测不完整，无法比较调参效果。');
        history.push(trial);
        plan = nextGoalTrial(history, args.totalSteps - spentSteps, batchSize);
        bestRunId = plan.bestRunId;
      } else {
        plan = chooseChange(run, args.additionalSteps - spentSteps, batchSize);
      }
      if (!plan.dance) return finish(plan.state, plan.reason);
      const pending = await enqueue(index + 1);
      if (pending) return pending;
    }
  };
}
