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

export const ORIGINMAN_MOTION_TOOLS = [
  {
    name: 'rdk_originman_motion_library',
    description:
      '只读查询平台的 OriginMan 参考动作库和预置舞蹈，返回可用 ID、时长、分类与限幅状态。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'rdk_originman_motion_preview',
    description:
      '只读校验和预览预置舞蹈或自定义动作组，返回总时长、预计拍数、关节范围、曲线与轨迹 SHA。不会提交训练。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: motionProperties,
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

export async function trainReferenceDance(args, upstream, signal) {
  if (!upstream.previewOriginmanMotion || !upstream.submitOriginmanMotion)
    throw Error('请连接机器人学习平台后提交参考舞蹈训练。');
  const {
    dance,
    contextId,
    computeResourceId,
    numEnvs = 64,
    referenceTrainingSteps = 503808,
    expectedTrajectorySha256,
    ...extra
  } = args;
  if (
    Object.keys(extra).length ||
    typeof contextId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$/.test(contextId) ||
    typeof computeResourceId !== 'string' ||
    !/^[A-Za-z0-9_.-]{1,160}$/.test(computeResourceId) ||
    ![1, 2, 4, 8, 16, 32, 64].includes(numEnvs) ||
    !Number.isInteger(referenceTrainingSteps) ||
    referenceTrainingSteps < 8192 ||
    referenceTrainingSteps > 2_000_000 ||
    referenceTrainingSteps % 4096 !== 0
  )
    throw Error('请提供本轮实验标识、支持跟跳的 Worker、有效并行环境数和 4,096 的倍数预算。');
  const composition = validateReferenceDance(dance);
  const { preview } = await upstream.previewOriginmanMotion(composition, { signal });
  const sha256 = preview?.trajectorySha256;
  if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256))
    throw Error('平台未返回可验证的参考轨迹摘要。');
  if (expectedTrajectorySha256 !== undefined && expectedTrajectorySha256 !== sha256)
    throw Error('编排内容已变更。请重新预览并确认后再提交。');
  return upstream.submitOriginmanMotion(
    {
      contextId,
      computeResourceId,
      numEnvs,
      composition,
      trainingSteps: referenceTrainingSteps,
      expectedTrajectorySha256: sha256,
    },
    { signal },
  );
}
