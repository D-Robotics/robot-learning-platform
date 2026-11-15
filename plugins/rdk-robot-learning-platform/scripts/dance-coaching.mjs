import { REWARD_TUNING_LIMITS, resolveOriginmanDanceConfig } from './originman-dance-config.mjs';

// OriginMan dance simulation reward defaults and quality thresholds from dance_env.py and train.py.
// Override values from the original run take precedence. The engine contract is checked in tests.
const rewards = {
  armSwingWeight: { label: '摆臂跟踪权重', defaultValue: 4, increment: 0.5 },
  armSpeedWeight: { label: '摆臂速度跟拍权重', defaultValue: 1.5, increment: 0.2 },
  weightShiftWeight: { label: '换重心跟踪权重', defaultValue: 3.4, increment: 0.4 },
  squatWeight: { label: '下蹲起身高度跟踪权重', defaultValue: 3.5, increment: 0.4 },
  settleStillnessWeight: { label: '定格静止权重', defaultValue: 2.6, increment: 0.3 },
  settleArmsWeight: { label: '定格展臂权重', defaultValue: 2.5, increment: 0.3 },
};

// Within each section, address stability or timing before increasing movement amplitude.
const sections = {
  'alternating-arms': [
    ['alternatingArmFraction', '左右交替方向命中率', 0.65, '%'],
    ['armBeatCorrelation', '摆臂速度与节拍相关性', 0.2, '', 'armSpeedWeight'],
    ['armAsymmetryRangeM', '双手前后差变化范围', 0.09, 'm', 'armSwingWeight'],
  ],
  'weight-shift': [
    ['lateralTrackingFraction', '换重心方向跟踪率', 0.62, '%', 'weightShiftWeight'],
    ['lateralRangeM', '身体横移范围', 0.035, 'm', 'weightShiftWeight'],
  ],
  'squat-rise': [
    ['riseAndDipCorrelation', '身体高度与下蹲起身节奏相关性', 0.55, '', 'squatWeight'],
    ['squatDescentM', '下蹲位移', 0.024, 'm', 'squatWeight'],
    ['squatAscentM', '起身位移', 0.024, 'm', 'squatWeight'],
    ['armSweepM', '摆臂前后范围', 0.06, 'm'],
  ],
  'open-pose': [
    ['holdPeakTiltDeg', '定格峰值倾角', 9, '°', null, '<'],
    ['holdStillFraction', '定格静止比例', 0.83, '%', 'settleStillnessWeight'],
    ['meanHoldHandSpanM', '定格平均展臂宽度', 0.32, 'm', 'settleArmsWeight'],
  ],
};

export function rewardChangeText(key, before, after) {
  const reward = rewards[key];
  const previous = before ?? (reward ? `引擎默认 ${reward.defaultValue}` : '默认');
  return `${reward?.label ?? key} ${previous} → ${after}`;
}

function metricText(value, unit) {
  const scale = unit === '%' ? 100 : unit === 'm' ? 100 : 1;
  const formatted = Number((value * scale).toFixed(unit ? 2 : 3));
  return `${formatted}${unit === 'm' ? ' cm' : unit}`;
}

function inspectMetrics(section) {
  return sections[section.type].map(([key, label, threshold, unit, reward, operator = '≥']) => {
    const value = section.measurements?.[key];
    const present = Number.isFinite(value);
    const met = present && (operator === '<' ? value < threshold : value >= threshold);
    return { key, label, threshold, unit, operator, reward, ...(present && { value, met }) };
  });
}

export function danceCoaching(run, runId, requestedSection) {
  const metrics = run?.metrics;
  const dance = metrics?.originmanDance;
  const engine = run?.training?.engine ?? run?.engine ?? metrics?.engine;
  if ((!dance && engine !== 'originman-dance-ppo') || (run.id ?? run.runId) !== runId) return null;
  const reply = (status, text, details = {}) => ({ runId, status, text, ...details });
  if (run.status !== 'completed')
    return reply(
      'wait',
      ['failed', 'blocked', 'cancelled', 'canceled'].includes(run.status)
        ? '先查看原 Run 的日志和算力状态，确认中断原因后再决定是否调整奖励。'
        : '等本轮逐段评测完成后，再根据动作结果决定要调哪一项。',
    );
  const missing = reply(
    'insufficient-evidence',
    '逐段评测证据不足。先在原 Run 核对回放和评测记录。',
  );
  if (run.mock !== false || engine !== 'originman-dance-ppo' || !Array.isArray(dance?.evaluations))
    return missing;

  const rawConfig = run.training?.originmanDance ?? metrics.danceConfig;
  let config;
  try {
    config = resolveOriginmanDanceConfig(rawConfig);
  } catch {
    return missing;
  }
  const nominal = dance.evaluations.filter((row) => row?.bpm === config.bpm);
  const matches = (row) =>
    Array.isArray(row.sections) &&
    row.sections.length === config.sections.length &&
    row.sections.every((section, index) => {
      const expected = config.sections[index];
      return (
        section?.type === expected.type &&
        section.beats === expected.beats &&
        typeof section.clean === 'boolean' &&
        typeof section.stylePassed === 'boolean' &&
        section.passed === (section.clean && section.stylePassed)
      );
    });
  if (nominal.length !== 1 || !nominal.every(matches)) return missing;
  const [row] = nominal;
  const failedSections = row.sections.flatMap((section, index) =>
    section.passed ? [] : [index + 1],
  );
  const data = { bpm: row.bpm, failedSections };
  if (row.failed === true || row.completed === false || row.sections.some(({ clean }) => !clean))
    return reply(
      'stability-first',
      '标称节拍的评测出现失稳或未完整跑完。先回看首个异常段，找出触地或中断前的动作。',
      { ...data, section: row.sections.findIndex(({ clean }) => !clean) + 1 || undefined },
    );
  if (row.failed !== false || row.completed !== true) return missing;
  if (requestedSection !== undefined && !row.sections[requestedSection - 1])
    return reply('section-unavailable', '这轮 Run 没有这个段号。请从原 Run 的舞段列表选择。', data);
  const sectionNumber = requestedSection ?? failedSections[0];
  if (sectionNumber && row.sections[sectionNumber - 1].passed)
    return reply('keep-baseline', `标称节拍下第 ${sectionNumber} 段已达标，保留该段作为对照。`, {
      ...data,
      section: sectionNumber,
    });
  if (!failedSections.length) {
    if (dance.qualityGatePassed === true)
      return reply('keep-baseline', '本轮已通过仿真评测，保留这份 Run 作为后续对照。', data);
    const otherBpms = dance.evaluations
      .filter((item) => item?.bpm !== row.bpm && Number.isFinite(item?.bpm) && matches(item))
      .filter(
        (item) => item.failed || !item.completed || item.sections.some(({ passed }) => !passed),
      )
      .map((item) => Number(item.bpm.toFixed(2)));
    return reply(
      'check-other-tempo',
      otherBpms.length
        ? `标称节拍各段已达标。先回看 ${otherBpms.join('、')} BPM 下的未达标舞段，再决定是否调整奖励。`
        : '标称节拍各段已达标。先核对原 Run 的其他评测节拍和整体质量门禁。',
      { ...data, otherBpms },
    );
  }
  if (dance.qualityGatePassed !== false) return missing;
  const section = row.sections[sectionNumber - 1];
  const checks = inspectMetrics(section);
  const failed = checks.filter(({ met }) => met === false);
  const missingChecks = checks.filter(({ met }) => met === undefined).map(({ label }) => label);
  const details = {
    ...data,
    section: sectionNumber,
    movement: section.type,
    checks,
    missingChecks,
  };
  const evidence = failed
    .map(
      ({ label, value, operator, threshold, unit }) =>
        `${label} ${metricText(value, unit)}（门槛 ${operator} ${metricText(threshold, unit)}）`,
    )
    .join('、');
  const prefix = `${row.bpm} BPM 第 ${sectionNumber} 段${evidence ? `，${evidence}` : ''}。`;
  if (missingChecks.length || !failed.length)
    return reply(
      'insufficient-evidence',
      `${prefix}${missingChecks.length ? `原评测缺少${missingChecks.join('、')}。` : ''}先核对回放和完整分项指标，再选奖励参数。`,
      details,
    );

  const rewardKey = failed[0].reward;
  if (!rewardKey)
    return reply(
      'inspect-replay',
      `${prefix}先回看这一段的动作时序和姿态，再决定如何调整。`,
      details,
    );
  const numEnvs = run.training?.numEnvs;
  if (
    !run.computeResourceId ||
    !run.modelId ||
    !Number.isInteger(numEnvs) ||
    numEnvs < 1 ||
    numEnvs > 16 ||
    !Number.isInteger(rawConfig.seed) ||
    !Number.isInteger(rawConfig.trainingSteps)
  )
    return reply(
      'insufficient-config',
      `${prefix}先核对原 Run 的模型、算力、种子、步数和并行环境，再预览对照实验。`,
      details,
    );

  const reward = rewards[rewardKey];
  const override = config.rewardTuning?.[rewardKey];
  const before = override ?? reward.defaultValue;
  const after = Math.min(
    REWARD_TUNING_LIMITS[rewardKey].max,
    Number((before + reward.increment).toFixed(3)),
  );
  if (after <= before)
    return reply(
      'at-limit',
      `${prefix}${reward.label}已到当前上限。先复查这段回放和奖励配置。`,
      details,
    );
  const comparison =
    '保持原编舞、模型、算力、种子、步数和并行环境，复测同一节拍。对照该段指标，同时检查其他舞段是否退步。';
  return reply(
    'reward-experiment',
    `${prefix}建议先做一轮单变量对照，${rewardChangeText(rewardKey, override, after)}。用下一轮评测检验这项调整是否有效。${comparison}`,
    {
      ...details,
      parameter: {
        key: rewardKey,
        label: reward.label,
        before,
        after,
        baseline: override === undefined ? 'engine-default' : 'run-override',
      },
      comparison,
      previewArguments: {
        intent: 'retry',
        task: 'dance',
        runId,
        changes: { rewardTuning: { [rewardKey]: after } },
      },
    },
  );
}
