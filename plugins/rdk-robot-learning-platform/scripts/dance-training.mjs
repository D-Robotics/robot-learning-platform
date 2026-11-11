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
    modelId: { type: 'string', minLength: 1, maxLength: 160 },
    computeResourceId: { type: 'string', minLength: 1, maxLength: 160 },
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
      '把学员自定义的有界舞段提交为OriginMan PPO仿真训练Run，默认50万训练步、8个并行环境；8192步只适合明确要求的链路快检。入参{contextId,computeResourceId?,modelId?,dance:{schemaVersion:1,title,bpm,sections:[{type,beats,intensity}],seed?,trainingSteps?}}，不要使用timesteps或moves。先从rdk_experience_guide取得contextId；modelId可省略以按专用契约匹配或登记，优先从已报告支持originman-dance-ppo的算力机中让学员按名称选择。提交前仍须重新验证资源连接和Worker引擎能力；同contextId只提交一次，随后用rdk_training_wait查询同一Run。仅仿真，不部署真机。',
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
      (key) => !['contextId', 'modelId', 'computeResourceId', 'dance'].includes(key),
    ) ||
    typeof args.contextId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$/.test(args.contextId)
  )
    throw new Error('请先从rdk_experience_guide取得本轮contextId，并提供舞蹈编排。');
  const dance = resolveOriginmanDanceConfig(args.dance);
  return {
    contextId: args.contextId,
    ...(args.modelId ? { modelId: args.modelId } : {}),
    ...(args.computeResourceId ? { computeResourceId: args.computeResourceId } : {}),
    dance: {
      schemaVersion: 1,
      title: dance.title,
      bpm: dance.bpm,
      sections: dance.sections,
      seed: dance.seed,
      trainingSteps: dance.trainingSteps,
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
        numEnvs: 8,
        maxIterations: Math.ceil(steps / (8 * 256)),
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
