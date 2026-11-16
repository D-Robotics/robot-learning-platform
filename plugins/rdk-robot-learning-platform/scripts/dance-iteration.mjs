import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { danceCoaching, rewardChangeText } from './dance-coaching.mjs';
import { danceTrainingBatchSize } from './dance-training.mjs';

const runIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/;
const formalSteps = 500_000;
const maxSteps = 2_000_000;
const parallelEnvs = 64;
const batchSize = danceTrainingBatchSize(parallelEnvs);

export const DANCE_ITERATION_TOOL = {
  name: 'rdk_originman_dance_iterate',
  description:
    '用户明确要求自动迭代并确认新增训练总步数后使用。沿指定 OriginMan 4090／64 并行 Run 达成原质量门；同预算和 Run ID 可继续。快检先只补步数，正式训练后按未通过项只调一个奖励。每轮记实际采样批次；达标、预算不足或证据阻塞时停下。按 studioNavigation 打开逐轮面板；有 nextArguments 自动接续。仅仿真。',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['runId', 'goal', 'additionalSteps'],
    properties: {
      runId: { type: 'string', pattern: runIdPattern.source },
      goal: { type: 'string', const: 'original-quality-gate' },
      additionalSteps: {
        type: 'integer',
        minimum: 0,
        maximum: maxSteps,
        description: '从这条原 Run 出发，用户授权的新增训练总步数，含采样批次取整。',
      },
    },
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
};

function chooseChange(run, remaining) {
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
  return (
    'auto-' +
    createHash('sha256')
      .update(JSON.stringify([account, baseUrl, args.runId, args.additionalSteps, index]))
      .digest('hex')
      .slice(0, 19)
  );
}

const gpu4090 = (value) => typeof value === 'string' && /\bRTX\s+4090\b/i.test(value);
export const matchesDanceIterationGpu = (worker) => worker.cuda === true && gpu4090(worker.gpuName);

function matchesIterationRun(run, baseline, plan, reservation) {
  if (
    run?.taskId !== 'originman-dance' ||
    run.mock !== false ||
    run.training?.engine !== 'originman-dance-ppo' ||
    run.training?.numEnvs !== parallelEnvs ||
    !run.computeResourceId ||
    !run.modelId ||
    !Number.isSafeInteger(run.training?.originmanDance?.trainingSteps) ||
    run.metrics?.trainingDevice !== 'cuda' ||
    !gpu4090(run.metrics.trainingDeviceName) ||
    !Number.isSafeInteger(run.metrics.trainingSteps) ||
    run.metrics.trainingSteps <= 0
  )
    return false;
  if (!baseline) return true;
  const { title: _actualTitle, ...actual } = run.training.originmanDance;
  const { title: _plannedTitle, ...expected } = plan;
  return (
    run.modelId === baseline.modelId &&
    run.computeResourceId === baseline.computeResourceId &&
    run.contractId === baseline.contractId &&
    run.metrics.originmanDance.sceneProvenance.sceneSha256 ===
      baseline.metrics.originmanDance.sceneProvenance.sceneSha256 &&
    isDeepStrictEqual(actual, expected) &&
    run.metrics.trainingSteps <= reservation
  );
}

function renderIteration(result, args, baseUrl) {
  const body = { ...result, additionalSteps: args.additionalSteps };
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
      '首次按 studioNavigation 在右侧打开逐轮结果，后续回执更新同一个结果页面。如有 nextArguments，自动接续原 Run 与原预算。终态汇报逐轮改动和结果。',
  };
}

export function createDanceIteration({ baseUrl, account, accept, recover, submit }) {
  const completed = new Map();
  return async (args, signal) => {
    if (
      typeof args.runId !== 'string' ||
      !runIdPattern.test(args.runId) ||
      args.goal !== 'original-quality-gate' ||
      !Number.isSafeInteger(args.additionalSteps) ||
      args.additionalSteps < 0 ||
      args.additionalSteps > maxSteps ||
      Object.keys(args).some((key) => !['runId', 'goal', 'additionalSteps'].includes(key))
    )
      throw Error('请提供原 Run ID、通过原质量门的目标和 0 至 200 万的新增训练总步数。');
    const owner = await account();
    if (!owner) throw Error('请先核对 Studio 当前学习平台账号。');
    const rounds = [];
    let spentSteps = 0;
    let runId = args.runId;
    let baseline;
    let change = '原 Run';
    let reservation = 0;
    let expectedDance;
    const finish = (state, reason) =>
      renderIteration({ state, reason, rounds, spentSteps }, args, baseUrl);

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
      const round = {
        runId,
        change,
        state,
        steps: run?.metrics?.trainingSteps,
        replay: runDelivery?.replay === 'simulation',
        policy: runDelivery?.policy === 'available',
      };
      rounds.push(round);
      if (state === 'waiting') return finish('waiting', '正在等待本轮训练和仿真评测。');
      if (!['passed', 'failed'].includes(state))
        return finish('blocked', simulationAcceptance?.reason ?? '本轮未取得可核验的仿真评测。');
      if (!matchesIterationRun(run, baseline, expectedDance, reservation))
        return finish('blocked', '本轮 4090、64 并行、模型、算力或采样步数与授权配置不一致。');
      baseline ??= run;
      if (state === 'passed') return finish('passed', '已通过原仿真质量门，自动迭代结束。');

      const plan = chooseChange(run, args.additionalSteps - spentSteps);
      if (!plan.dance) return finish(plan.state, plan.reason);
      reservation = Math.ceil(plan.dance.trainingSteps / batchSize) * batchSize;
      const contextId = roundContext(owner, baseUrl, args, index + 1);
      let receipt;
      let next;
      try {
        receipt = await recover(contextId);
        if ((await account()) !== owner)
          return finish('blocked', '平台账号已改变，请回原账号继续。');
        next =
          receipt ??
          (await submit(
            {
              contextId,
              previousRunId: runId,
              modelId: baseline.modelId,
              computeResourceId: baseline.computeResourceId,
              numEnvs: parallelEnvs,
              dance: plan.dance,
            },
            signal,
          ));
      } catch (error) {
        signal?.throwIfAborted();
        return finish('blocked', error.message);
      }
      const nextRun = next.submission?.runId;
      if (!runIdPattern.test(nextRun ?? '') || rounds.some((round) => round.runId === nextRun))
        return finish('blocked', '提交回执没有返回新的 Run，保留原记录。');
      spentSteps += reservation;
      expectedDance = plan.dance;
      change = plan.change;
      runId = nextRun;
      if (!receipt && !next.alreadySubmitted) {
        rounds.push({ runId, change, state: 'waiting', reservedSteps: reservation });
        return finish('waiting', '已提交本轮，等待训练和仿真评测。');
      }
    }
  };
}
