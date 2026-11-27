const motionId = { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,63}$' };
export const motionProperties = {
  presetId: motionId,
  blocks: {
    type: 'array',
    minItems: 1,
    maxItems: 128,
    items: {
      type: 'object',
      required: ['id'],
      additionalProperties: false,
      properties: { id: motionId, repeats: { type: 'integer', minimum: 1, maximum: 8 } },
    },
  },
  bpm: { type: 'number', minimum: 80, maximum: 140 },
  transitionSeconds: { type: 'number', minimum: 0, maximum: 2 },
};

const referenceEnvs = [1, 2, 4, 8, 16, 32, 64];
export const referenceBudget = {
  type: 'integer',
  minimum: 8192,
  maximum: 2_000_000,
  multipleOf: 4096,
};
const resourceId = { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,160}$' };
const referenceSettings = {
  computeResourceId: resourceId,
  numEnvs: { type: 'integer', enum: referenceEnvs },
  referenceTrainingSteps: referenceBudget,
};
const digest = /^[a-f0-9]{64}$/;
const workerId = new RegExp(resourceId.pattern);

export const ORIGINMAN_MOTION_TOOLS = [
  {
    name: 'rdk_originman_motion_library',
    description:
      '只读查询平台的 OriginMan 参考动作库和预置舞蹈，返回可用 ID、时长、分类与限幅状态，也会列出暂不可训练的素材和原因。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'rdk_originman_motion_preview',
    description:
      '只读校验预置舞蹈或动作组，返回轨迹预览和本轮提交参数。已选 Worker 时带 computeResourceId，可同时指定步数和并行环境数。用户明确要求开始后，在同一对话按 nextArguments 提交。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { ...motionProperties, ...referenceSettings },
      oneOf: [
        {
          required: ['presetId'],
          not: {
            anyOf: ['blocks', 'bpm', 'transitionSeconds'].map((key) => ({ required: [key] })),
          },
        },
        { required: ['blocks'], not: { required: ['presetId'] } },
      ],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
];

const id = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export function isReferenceDance(dance) {
  return !!dance && (Object.hasOwn(dance, 'presetId') || Object.hasOwn(dance, 'blocks'));
}

export function validateReferenceDance(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !Object.hasOwn(motionProperties, key)) ||
    Object.hasOwn(input, 'presetId') === Object.hasOwn(input, 'blocks')
  )
    throw Error('请选择一支预置舞蹈，或提供动作组列表。');
  if (Object.hasOwn(input, 'presetId')) {
    if (
      typeof input.presetId !== 'string' ||
      !id.test(input.presetId) ||
      Object.keys(input).length !== 1
    )
      throw Error('请选择有效的预置 ID，使用预置自带的节奏和过渡。');
    return input;
  }
  if (
    !Array.isArray(input.blocks) ||
    input.blocks.length < 1 ||
    input.blocks.length > 128 ||
    input.blocks.some(
      (block) =>
        !block ||
        typeof block !== 'object' ||
        Array.isArray(block) ||
        Object.keys(block).some((key) => !['id', 'repeats'].includes(key)) ||
        typeof block.id !== 'string' ||
        !id.test(block.id) ||
        (block.repeats !== undefined &&
          (!Number.isInteger(block.repeats) || block.repeats < 1 || block.repeats > 8)),
    )
  )
    throw Error('请提供 1–128 个有效动作 ID，每项重复次数为 1–8。');
  for (const [key, minimum, maximum] of [
    ['bpm', 80, 140],
    ['transitionSeconds', 0, 2],
  ]) {
    if (
      input[key] !== undefined &&
      (!Number.isFinite(input[key]) || input[key] < minimum || input[key] > maximum)
    )
      throw Error('请检查节奏（80–140 BPM）和过渡时间（0–2 秒）。');
  }
  return input;
}

function validateReferenceSettings({ computeResourceId, numEnvs, referenceTrainingSteps }) {
  if (
    (computeResourceId !== undefined &&
      (typeof computeResourceId !== 'string' || !workerId.test(computeResourceId))) ||
    !referenceEnvs.includes(numEnvs) ||
    !Number.isInteger(referenceTrainingSteps) ||
    referenceTrainingSteps < referenceBudget.minimum ||
    referenceTrainingSteps > referenceBudget.maximum ||
    referenceTrainingSteps % referenceBudget.multipleOf !== 0
  )
    throw Error('请提供有效的 Worker、并行环境数和 4,096 的倍数预算。');
}

export async function prepareReferenceDance(input, contextId, upstream, signal) {
  if (!upstream.previewOriginmanMotion) throw Error('请先连接机器人学习平台。');
  const {
    computeResourceId,
    numEnvs = 64,
    referenceTrainingSteps = 503808,
    ...composition
  } = input;
  const settings = { computeResourceId, numEnvs, referenceTrainingSteps };
  validateReferenceSettings(settings);
  const { workspaceAccountId, ...previewResult } = await upstream.previewOriginmanMotion(
    validateReferenceDance(composition),
    { signal },
  );
  const { preview } = previewResult;
  if (typeof preview?.trajectorySha256 !== 'string' || !digest.test(preview.trajectorySha256))
    throw Error('平台未返回可验证的参考轨迹摘要。');
  const nextArguments = {
    contextId,
    dance: structuredClone(composition),
    ...(computeResourceId !== undefined && { computeResourceId }),
    numEnvs,
    referenceTrainingSteps,
    expectedTrajectorySha256: preview.trajectorySha256,
    ...(preview.stanceProfile && { expectedStanceProfile: preview.stanceProfile }),
  };
  const workerSelectionRequired = computeResourceId === undefined;
  return {
    plan: { arguments: nextArguments, workspaceAccountId },
    response: {
      ...previewResult,
      contextId,
      trainingSubmitted: false,
      workerSelectionRequired,
      nextTool: 'rdk_originman_dance_train',
      nextArguments,
      ...(workerSelectionRequired && {
        workerLookup: {
          tool: 'rdk_development_targets',
          arguments: { action: 'list-compute', engine: 'originman-reference-ppo' },
        },
      }),
      studentReply: workerSelectionRequired
        ? '参考舞蹈已预览。请选择一个支持跟跳的 Worker。'
        : '参考舞蹈和训练配置已准备好。',
      delivery:
        '先展示轨迹和训练配置。在同一对话里，等用户明确要求开始后再提交 nextArguments。' +
        (workerSelectionRequired
          ? '从 workerLookup 取得当前账号的算力，使用用户选定的准确 computeResourceId 补齐参数。'
          : ''),
    },
  };
}

export async function trainReferenceDance(args, upstream, signal, plan) {
  if (!upstream.previewOriginmanMotion || !upstream.submitOriginmanMotion)
    throw Error('请连接机器人学习平台后提交参考舞蹈训练。');
  const {
    dance,
    contextId,
    computeResourceId,
    numEnvs = 64,
    referenceTrainingSteps = 503808,
    expectedTrajectorySha256,
    expectedStanceProfile,
    ...extra
  } = args;
  validateReferenceSettings({ computeResourceId, numEnvs, referenceTrainingSteps });
  if (
    Object.keys(extra).length ||
    typeof contextId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$/.test(contextId) ||
    computeResourceId === undefined
  )
    throw Error('请沿用预览的实验标识，并选定一个支持跟跳的 Worker。');
  const composition = validateReferenceDance(dance);
  const expectedAccountId = plan?.workspaceAccountId;
  const { preview } = await upstream.previewOriginmanMotion(composition, {
    signal,
    expectedAccountId,
  });
  const sha256 = preview?.trajectorySha256;
  if (typeof sha256 !== 'string' || !digest.test(sha256))
    throw Error('平台未返回可验证的参考轨迹摘要。');
  const expectedDigest = plan?.arguments.expectedTrajectorySha256 ?? expectedTrajectorySha256;
  if (expectedDigest !== undefined && expectedDigest !== sha256)
    throw Error('编排内容已变更。请重新预览并确认后再提交。');
  const stanceProfile = preview.stanceProfile;
  const expectedStance = plan ? plan.arguments.expectedStanceProfile : expectedStanceProfile;
  if ((plan || expectedStance !== undefined) && expectedStance !== stanceProfile)
    throw Error('参考站姿已变更。请重新预览并确认后再提交。');
  return upstream.submitOriginmanMotion(
    {
      contextId,
      computeResourceId,
      numEnvs,
      composition,
      trainingSteps: referenceTrainingSteps,
      expectedTrajectorySha256: sha256,
      ...(stanceProfile && { expectedStanceProfile: stanceProfile }),
    },
    { signal, expectedAccountId },
  );
}
