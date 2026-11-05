/** Stateless intake: only user-facing preparation information, never authority to move. */
export const INTAKE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mode: { type: 'string', enum: ['offline', 'read-only', 'physical', 'unknown'] },
    robotLabel: { type: 'string', minLength: 1, maxLength: 80 },
    connection: { type: 'string', enum: ['connected', 'not-connected', 'unknown'] },
    policyStatus: { type: 'string', enum: ['existing', 'not-selected', 'unknown'] },
    nextFocus: {
      type: 'string',
      enum: ['review-materials', 'choose-model', 'view-demo', 'unknown'],
    },
  },
};
const questions = {
  nextFocus: {
    field: 'nextFocus',
    title: '下一步你想先做哪一项？',
    options: [
      { value: 'review-materials', label: '核对已有资料' },
      { value: 'choose-model', label: '选择要用的模型' },
      { value: 'view-demo', label: '只看课堂演示' },
      { value: 'unknown', label: '不清楚，先保留待定' },
    ],
  },
  mode: {
    field: 'mode',
    title: '这次先做到哪一步？',
    options: [
      { value: 'offline', label: '离线准备（推荐）' },
      { value: 'read-only', label: '只读检查' },
      { value: 'physical', label: '准备实体测试' },
      { value: 'unknown', label: '不清楚，先离线准备' },
    ],
  },
  robotLabel: {
    field: 'robotLabel',
    title: '这台机器人怎么称呼？例如“课堂1号”；还没命名也可以直接说。',
    freeText: true,
  },
  connection: {
    field: 'connection',
    title: '这台机器人目前在插件中是什么连接状态？',
    options: [
      { value: 'connected', label: '已有连接' },
      { value: 'not-connected', label: '还没连接' },
      { value: 'unknown', label: '不清楚' },
    ],
  },
  policyStatus: {
    field: 'policyStatus',
    title: '模型准备到哪一步了？',
    options: [
      { value: 'existing', label: '有模型文件（待核对）' },
      { value: 'not-selected', label: '还没选择' },
      { value: 'unknown', label: '不清楚' },
    ],
  },
};
export function guidedInput(answers = {}) {
  if (
    !answers ||
    typeof answers !== 'object' ||
    Array.isArray(answers) ||
    Object.keys(answers).some((k) => !Object.hasOwn(INTAKE_SCHEMA.properties, k))
  )
    throw Error('引导输入格式不正确，请仅传已知的准备信息；不需要密码或摘要。');
  const known = {};
  for (const [key, value] of Object.entries(answers)) {
    const spec = INTAKE_SCHEMA.properties[key];
    if (
      typeof value !== 'string' ||
      !value.trim() ||
      value.length > (spec.maxLength ?? 80) ||
      (spec.enum && !spec.enum.includes(value.trim()))
    )
      throw Error(
        `准备信息“${questions[key].title}”的值不正确，请使用给出的选项；未知可明确回复不清楚。`,
      );
    known[key] = value.trim();
  }
  const fields = [
    'mode',
    'robotLabel',
    ...(['read-only', 'physical'].includes(known.mode) ? ['connection'] : []),
    'policyStatus',
    'nextFocus',
  ];
  const missing = fields.filter((k) => !Object.hasOwn(known, k));
  const nextQuestion = missing.length ? questions[missing[0]] : null;
  return {
    answers: known,
    needsInput: Boolean(nextQuestion),
    nextQuestion,
    pendingInputs: missing.map((k) => ({ field: k, label: questions[k].title })),
    limitations:
      '称呼仅用于课堂区分，不是已核实的设备身份；选择实体测试也不授权运动。不保存输入，不索取密码。',
  };
}
export function questionText(question) {
  return question
    ? question.title +
        (question.options
          ? '\n' + question.options.map((o, i) => `${i + 1}. ${o.label}`).join('\n')
          : '')
    : '';
}
