/** Submit one learner-configured OriginMan dance run through the authenticated platform API. */
import fs from 'node:fs';
import { selectCourseAssets, registerCourseModel } from './course-setup.mjs';
import { submitOnce, recoverSubmission } from './submission-journal.mjs';
import { resolveOriginmanDanceConfig } from './originman-dance-config.mjs';

const manifest = JSON.parse(
  fs.readFileSync(new URL('../references/originman-dance-manifest.json', import.meta.url), 'utf8'),
);
const schema = {
  type: 'object',
  properties: {
    contextId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$' },
    previousRunId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$' },
    modelId: { type: 'string', minLength: 1, maxLength: 160 },
    computeResourceId: { type: 'string', minLength: 1, maxLength: 160 },
    numEnvs: {
      type: 'integer',
      minimum: 1,
      maximum: 16,
      default: 8,
      description: '并行仿真环境数。影响采样批大小与训练耗时；实际步数按完整采样批次取整',
    },
    dance: {
      type: 'object',
      required: ['schemaVersion', 'title', 'bpm', 'sections'],
      additionalProperties: false,
      properties: {
        schemaVersion: { type: 'integer', const: 1 },
        title: { type: 'string', minLength: 1, maxLength: 80 },
        bpm: { type: 'number', minimum: 80, maximum: 140 },
        sections: {
          type: 'array',
          minItems: 1,
          maxItems: 8,
          items: {
            type: 'object',
            required: ['type', 'beats', 'intensity'],
            additionalProperties: false,
            properties: {
              type: {
                type: 'string',
                enum: ['alternating-arms', 'weight-shift', 'squat-rise', 'open-pose'],
              },
              beats: { type: 'integer', enum: [4, 8, 16] },
              intensity: { type: 'number', minimum: 0.25, maximum: 1 },
            },
          },
        },
        seed: { type: 'integer', minimum: 0, maximum: 2147483647 },
        trainingSteps: { type: 'integer', minimum: 8192, maximum: 2000000, default: 500000 },
        rewardTuning: {
          type: 'object',
          additionalProperties: false,
          description: '可选奖励权重覆盖；缺省用引擎内置已验证权重，只覆盖给出的键',
          properties: {
            weightShiftTargetM: { type: 'number', minimum: 0.02, maximum: 0.06 },
            weightShiftToleranceM: { type: 'number', minimum: 0.008, maximum: 0.04 },
            squatDepthM: { type: 'number', minimum: 0.02, maximum: 0.07 },
            squatToleranceM: { type: 'number', minimum: 0.008, maximum: 0.04 },
            settleStillnessWeight: { type: 'number', minimum: 1, maximum: 4 },
            workPenalty: { type: 'number', minimum: 0.2, maximum: 1.5 },
            squatWorkPenalty: { type: 'number', minimum: 0.05, maximum: 1 },
            tiltPenalty: { type: 'number', minimum: 1, maximum: 6 },
            armSwingWeight: { type: 'number', minimum: 1, maximum: 8 },
            armSpeedWeight: { type: 'number', minimum: 0.2, maximum: 4 },
            weightShiftWeight: { type: 'number', minimum: 1, maximum: 8 },
            squatWeight: { type: 'number', minimum: 1, maximum: 8 },
            settleArmsWeight: { type: 'number', minimum: 0.2, maximum: 6 },
          },
        },
      },
    },
  },
  required: ['contextId', 'dance'],
  additionalProperties: false,
};

export const DANCE_TRAINING_TOOLS = [
  {
    name: 'rdk_originman_dance_train',
    description:
      '提交已确认的 OriginMan 舞蹈 PPO 仿真配方。可选算力、模型、并行环境数（1–16），可改舞段、节拍、拍数、幅度、seed、训练预算及参数表列出的奖励项。默认 50 万步和 8 个并行环境；8192 步只用于流程快检。新手或改参重训优先调用 rdk_learning_guide，按其 nextArguments 提交；同一 contextId 用于重试或查原 Run。提交前重新检查指定 Worker。舞蹈仅仿真',
    inputSchema: schema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
];

function requireInput(args) {
  if (
    !args ||
    typeof args !== 'object' ||
    Array.isArray(args) ||
    Object.keys(args).some(
      (key) =>
        ![
          'contextId',
          'modelId',
          'computeResourceId',
          'numEnvs',
          'dance',
          'previousRunId',
        ].includes(key),
    ) ||
    typeof args.contextId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$/.test(args.contextId)
  )
    throw new Error('请先从rdk_experience_guide取得本轮contextId，并提供舞蹈编排。');
  if (
    args.previousRunId !== undefined &&
    (typeof args.previousRunId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(args.previousRunId))
  )
    throw new Error('用于对比的原 Run 标识无效。');
  const dance = resolveOriginmanDanceConfig(args.dance);
  const numEnvs = args.numEnvs ?? 8;
  if (!Number.isSafeInteger(numEnvs) || numEnvs < 1 || numEnvs > 16)
    throw new Error('numEnvs 必须是 1 到 16 的整数；缺省 8。');
  return {
    contextId: args.contextId,
    numEnvs,
    ...(args.modelId ? { modelId: args.modelId } : {}),
    ...(args.computeResourceId ? { computeResourceId: args.computeResourceId } : {}),
    dance: {
      schemaVersion: 1,
      title: dance.title,
      bpm: dance.bpm,
      sections: dance.sections,
      seed: dance.seed,
      trainingSteps: dance.trainingSteps,
      ...(dance.rewardTuning ? { rewardTuning: dance.rewardTuning } : {}),
    },
  };
}

export async function trainOriginmanDance(
  args,
  call,
  { directory, defaultResourceId, readModels, toolNames },
) {
  const input = requireInput(args);
  const existing = await recoverSubmission({
    scope: 'originman-dance-workshop',
    contextId: input.contextId,
    phase: 'train',
    directory,
    remember: async (runId) => ({ runId }),
  });
  if (existing)
    return {
      stage: 'training',
      ...existing,
      studentReply: '这个实验已提交。下面是原 Run。如果要改参重训，请以原 Run 开始新一轮。',
      nextAction: '用rdk_training_wait沿该runId查询，不重新提交。',
    };
  if (
    toolNames &&
    ![
      'rdk_model_validate',
      'rdk_models_list',
      'rdk_model_register',
      'rdk_compute_resources_list',
      'rdk_compute_resource_test',
      'rdk_training_submit',
    ].every((name) => toolNames.includes(name))
  )
    throw new Error('当前平台工具缺少舞蹈训练所需接口；未登记模型或提交任务。');
  const validation = await call('rdk_model_validate', { manifest });
  if (validation.valid !== true)
    throw new Error('OriginMan舞蹈模型契约未通过平台校验：' + JSON.stringify(validation.errors));
  const selected = await selectCourseAssets(
    {
      manifest,
      modelId: input.modelId,
      computeResourceId: input.computeResourceId ?? defaultResourceId,
      requiredEngine: 'originman-dance-ppo',
      readModels,
    },
    call,
  );
  const tested = await call('rdk_compute_resource_test', {
    computeResourceId: selected.resource.id,
  });
  if (
    tested.id !== selected.resource.id ||
    tested.connected !== true ||
    tested.mock !== false ||
    tested.browserRelay === true
  )
    throw Object.assign(new Error('指定算力资源未通过真实连接检查；未提交舞蹈训练。'), {
      platformCode: 'ORIGINMAN_DANCE_RESOURCE_NOT_READY',
      details: { tested, trainingSubmitted: false },
    });
  const engines = tested.engines ?? tested.health?.engines;
  if (!Array.isArray(engines) || !engines.includes('originman-dance-ppo'))
    throw Object.assign(new Error('指定Worker未证明已注册originman-dance-ppo；未提交舞蹈训练。'), {
      platformCode: 'ORIGINMAN_DANCE_ENGINE_NOT_REGISTERED',
      details: { tested, trainingSubmitted: false },
    });
  const model = selected.model ?? (await registerCourseModel(manifest, call));
  const steps = input.dance.trainingSteps;
  const submission = await submitOnce({
    scope: 'originman-dance-workshop',
    contextId: input.contextId,
    phase: 'train',
    directory,
    remember: async (runId) => ({ runId }),
    submit: () =>
      call('rdk_training_submit', {
        modelId: model.id,
        computeResourceId: selected.resource.id,
        backend: 'local',
        taskId: 'originman-dance',
        profile: 'standard',
        engine: 'originman-dance-ppo',
        algorithm: 'ppo',
        numEnvs: input.numEnvs,
        maxIterations: Math.ceil(steps / (input.numEnvs * 256)),
        video: true,
        originmanDance: input.dance,
        idempotencyKey: input.contextId + '-train',
        label: input.dance.title,
        runName: input.contextId,
        experimentId: input.contextId,
      }),
  });
  return {
    stage: 'training',
    submission: submission.submission,
    alreadySubmitted: submission.alreadySubmitted === true,
    modelId: model.id,
    computeResourceId: selected.resource.id,
    dance: input.dance,
    qualityClaimAllowed: false,
    hardwareEligible: false,
    nextAction:
      '对返回的runId调用rdk_training_wait直到终态，再用rdk_training_status检查质量门、各段测量、制品与来源。出现links.danceVideo时打开本次仿真视频；播放是否成功以宿主实际观察为准。没有视频链接时如实说明未生成，不重新训练；completed本身不代表质量达标。',
  };
}
