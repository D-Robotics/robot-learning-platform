import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
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
import { bindTrainingGoal, openTrainingGoalJournal } from './submission-journal.mjs';

const runIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/;
const formalSteps = 500_000;
const maxSteps = 2_000_000;
const parallelEnvs = 64;

const stepBudgetSchema = { type: 'integer', maximum: maxSteps };
const { trainingSteps: _steps, ...goalChoreography } = DANCE_CONFIG_SCHEMA.properties;

export const DANCE_ITERATION_TOOL = {
  name: 'rdk_originman_dance_iterate',
  description:
    'OriginMan 舞蹈自动迭代的首选入口。用户给目标和总预算、未达标自动调奖励或达标/预算用完停止时直接调用。首次只需 totalSteps 和 dance（bpm、sections，每段 type/beats/intensity），插件选择 RTX 4090、64 并行并保存实验。平台后台回执收到后立即在右侧打开原实验，页面自动更新每轮改动、评测、回放和 ONNX。遇到旧版续查回执原样接续 nextArguments。请勿改用普通训练。仅仿真。',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      goal: { type: 'string', enum: ['dance-quality-gate', 'original-quality-gate'] },
      contextId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$' },
      resumeContextId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$' },
      pollAfter: { type: 'integer', minimum: 0 },
      computeResourceId: { type: 'string', minLength: 1, maxLength: 160 },
      modelId: { type: 'string', minLength: 1, maxLength: 160 },
      dance: {
        ...DANCE_CONFIG_SCHEMA,
        required: ['bpm', 'sections'],
        properties: goalChoreography,
      },
      totalSteps: { ...stepBudgetSchema, minimum: 8192 },
      runId: { type: 'string', pattern: runIdPattern.source },
      additionalSteps: { ...stepBudgetSchema, minimum: 0 },
    },
    oneOf: [
      { required: ['dance', 'totalSteps'] },
      { required: ['goal', 'runId', 'additionalSteps'] },
      { required: ['resumeContextId'] },
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
  const total = args.additionalSteps ?? args.totalSteps;
  const body = { ...result, additionalSteps: total, remainingSteps: total - result.spentSteps };
  const url = new URL('./dance-iterations.html', baseUrl.replace(/\/+$/, '') + '/');
  url.hash = new URLSearchParams({ iteration: JSON.stringify(body) }).toString();
  return {
    ...(result.state !== 'waiting' && { stopWorkflow: true }),
    ...(result.state === 'waiting' && {
      nextTool: DANCE_ITERATION_TOOL.name,
      nextArguments: args,
    }),
    iteration: body,
    ...(result.rounds.length && {
      links: { iteration: url.href },
      studioNavigation: { tool: 'studio_open_url', arguments: { url: url.href } },
    }),
    studentReply: result.reason,
    delivery:
      '立即原样接续 nextArguments。训练完成但评测仍在生成时，只续查同一条 Run。遇到停止回执就按 studioNavigation 打开右侧，严禁改走普通训练或新建实验。',
  };
}

const planKey = (dance) =>
  JSON.stringify([dance.trainingSteps, Object.entries(dance.rewardTuning ?? {}).sort()]);

function assessRun(run, evaluations = run.metrics.originmanDance?.evaluations) {
  const dance = run.training.originmanDance;
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

function rewardTrial(incumbent, history, trainingSteps) {
  const original = incumbent.run.training.originmanDance;
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
  return null;
}

function nextGoalTrial(history, remaining, batchSize) {
  const available = Math.floor(remaining / batchSize) * batchSize;
  if (available < 8192) return { state: 'budget-exhausted', reason: '剩余预算不足一次训练。' };
  const incumbent = [...history].sort(compareTrials)[0];
  const last = history.at(-1).run;
  const lastBudget = last.training.originmanDance.trainingSteps;
  if (lastBudget < formalSteps) {
    const formalReservation = Math.ceil(formalSteps / batchSize) * batchSize;
    if (history.length === 1 && lastBudget === 8192 && available >= formalReservation + 8192) {
      const calibration = rewardTrial(incumbent, history, lastBudget);
      if (calibration) return calibration;
    }
    return {
      ...chooseChange(incumbent.run, available, batchSize),
      parentRunId: incumbent.run.id,
      bestRunId: incumbent.run.id,
    };
  }
  const original = incumbent.run.training.originmanDance;
  const trainingSteps = Math.max(formalSteps, original.trainingSteps);
  if (available < Math.ceil(trainingSteps / batchSize) * batchSize)
    return {
      state: 'budget-exhausted',
      reason: '剩余预算不足一轮同等训练量的参数对照。',
      bestRunId: incumbent.run.id,
    };
  return (
    rewardTrial(incumbent, history, trainingSteps) ?? {
      state: 'blocked',
      reason: '现有证据支持的单参数候选均已试过或到达范围边界。',
      bestRunId: incumbent.run.id,
    }
  );
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
      if (state === 'waiting')
        return finish('waiting', simulationAcceptance.reason ?? '正在等待本轮训练和仿真评测。');
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
        const trial = assessRun(run, simulationAcceptance.evaluations);
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

/** Host calls only register/read progress. Training and independent evaluation run separately. */
export function createDanceGoalContinuation({
  baseUrl,
  account,
  contextDirectory,
  iterate,
  pollMs = 6000,
  pauseMs = 2500,
}) {
  const flights = new Map();
  const initialStatus = (reason = '正在准备首轮训练。') => ({
    state: 'waiting',
    reason,
    rounds: [],
    spentSteps: 0,
    accelerator: 'RTX 4090',
    numEnvs: 64,
  });
  const drive = async (journal, args, owner) => {
    let transientErrors = 0;
    for (;;) {
      let current;
      try {
        if ((await account()) !== owner) throw Error('平台账号已改变，已停在本轮记录。');
        const step = await iterate(args, AbortSignal.timeout(85000));
        if (
          step.iteration.state === 'blocked' &&
          /上次提交结果尚待确认/.test(step.iteration.reason) &&
          transientErrors < 4
        ) {
          transientErrors++;
          await delay(pauseMs);
          continue;
        }
        current = step.iteration;
      } catch (error) {
        if (['TimeoutError', 'AbortError'].includes(error?.name) && transientErrors < 4) {
          transientErrors++;
          await delay(pauseMs);
          continue;
        }
        current = {
          ...(journal.progress() ?? initialStatus()),
          state: 'blocked',
          reason: error.message,
        };
      }
      transientErrors = 0;
      const saved = journal.save(current);
      if (saved.state !== 'waiting') return;
      await delay(pauseMs);
    }
  };
  return async (input, signal) => {
    const resume = Object.hasOwn(input, 'resumeContextId');
    if (!resume && input.goal !== 'dance-quality-gate') return iterate(input, signal);
    if (
      resume &&
      (typeof input.resumeContextId !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$/.test(input.resumeContextId) ||
        Object.keys(input).some((key) => !['resumeContextId', 'pollAfter'].includes(key)))
    )
      throw Error('请用原实验的续跑标识继续。');
    if (!resume) {
      checkArgs(input);
      canonicalDanceConfig(input.dance);
    }
    const owner = await account();
    if (!owner) throw Error('请先核对 Studio 当前学习平台账号。');
    const contextId = resume ? input.resumeContextId : input.contextId;
    const journal = openTrainingGoalJournal({
      account: owner,
      audience: baseUrl,
      contextId,
      directory: contextDirectory,
    });
    const args = resume ? journal.plan() : journal.register(input);
    if (!args) throw Error('当前账号未找到该组训练目标。');
    if (!resume && !isDeepStrictEqual(args, input))
      throw Error('本组训练已绑定原目标及预算，请使用续跑标识。');
    const key = JSON.stringify([owner, contextId]);
    const previous = journal.progress() ?? initialStatus();
    if (previous.state === 'waiting') {
      let running = flights.get(key);
      if (!running) {
        running = drive(journal, args, owner).finally(() => flights.delete(key));
        flights.set(key, running);
        // The caller may disconnect while the work is still in progress.
        running.catch(() => {});
      }
      await Promise.race([running, delay(pollMs, undefined, { signal })]);
    }
    const result = renderIteration(journal.progress() ?? previous, args, baseUrl);
    if (result.nextArguments)
      result.nextArguments = { resumeContextId: contextId, pollAfter: Date.now() };
    return result;
  };
}
