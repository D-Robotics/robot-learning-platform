const SECTION_TYPES = new Set(['alternating-arms', 'weight-shift', 'squat-rise', 'open-pose']);
const MIN_BPM = 80;
const MAX_BPM = 140;
const MAX_SECTIONS = 8;
export const REWARD_TUNING_LIMITS = {
  weightShiftTargetM: { min: 0.02, max: 0.06 },
  weightShiftToleranceM: { min: 0.008, max: 0.04 },
  squatDepthM: { min: 0.02, max: 0.07 },
  squatToleranceM: { min: 0.008, max: 0.04 },
  settleStillnessWeight: { min: 1.0, max: 4.0 },
  workPenalty: { min: 0.2, max: 1.5 },
  squatWorkPenalty: { min: 0.05, max: 1.0 },
  tiltPenalty: { min: 1.0, max: 6.0 },
  armSwingWeight: { min: 1.0, max: 8.0 },
  armSpeedWeight: { min: 0.2, max: 4.0 },
  weightShiftWeight: { min: 1.0, max: 8.0 },
  squatWeight: { min: 1.0, max: 8.0 },
  settleArmsWeight: { min: 0.2, max: 6.0 },
};

function fail(message) {
  const error = new Error(`OriginMan dance config: ${message}`);
  error.code = 'ORIGINMAN_DANCE_CONFIG_INVALID';
  error.details = {
    configurationExample: {
      schemaVersion: 1,
      title: '简单摆臂',
      bpm: 100,
      sections: [{ type: 'alternating-arms', beats: 8, intensity: 0.25 }],
      seed: 7,
      trainingSteps: 500000,
    },
    sectionTypes: [...SECTION_TYPES],
    nextAction:
      '按此字段结构修正参数，保留用户自己的数值。预算字段是trainingSteps，舞段字段是sections；draft直接接收此对象，train将其放在dance内并附原contextId。配置校验失败尚未提交训练。',
  };
  throw error;
}

function finite(value, label, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    fail(`${label} must be a finite number in [${min}, ${max}]`);
  return value;
}

/**
 * Validate the learner-authored, bounded choreography draft.
 * This creates configuration only; it does not claim a compatible model or submit a Run.
 */
export function resolveOriginmanDanceConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('expected an object');
  const allowed = new Set([
    'schemaVersion',
    'title',
    'bpm',
    'sections',
    'seed',
    'trainingSteps',
    'rewardTuning',
  ]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) fail(`unknown field ${key}`);
  if (input.schemaVersion !== 1) fail('schemaVersion must be 1');
  if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 80)
    fail('title must contain 1–80 characters');
  const bpm = finite(input.bpm, 'bpm', MIN_BPM, MAX_BPM);
  if (
    !Array.isArray(input.sections) ||
    input.sections.length < 1 ||
    input.sections.length > MAX_SECTIONS
  )
    fail(`sections must contain 1–${MAX_SECTIONS} entries`);
  const sections = input.sections.map((section, index) => {
    if (!section || typeof section !== 'object' || Array.isArray(section))
      fail(`sections[${index}] must be an object`);
    for (const key of Object.keys(section))
      if (!['type', 'beats', 'intensity'].includes(key))
        fail(`sections[${index}] has unknown field ${key}`);
    if (!SECTION_TYPES.has(section.type)) fail(`sections[${index}].type is unsupported`);
    if (![4, 8, 16].includes(section.beats)) fail(`sections[${index}].beats must be 4, 8, or 16`);
    const intensity = finite(section.intensity, `sections[${index}].intensity`, 0.25, 1);
    return { type: section.type, beats: section.beats, intensity };
  });
  const seed = input.seed ?? 7;
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 2 ** 31 - 1)
    fail('seed must be an integer in [0, 2147483647]');
  // A full user-authored choreography needs repeated episodes across sections;
  // 8192 is only a wiring smoke and is not a useful default learning budget.
  const trainingSteps = input.trainingSteps ?? 500_000;
  if (!Number.isSafeInteger(trainingSteps) || trainingSteps < 8192 || trainingSteps > 2_000_000)
    fail('trainingSteps must be an integer in [8192, 2000000]');
  const rewardTuning = {};
  if (input.rewardTuning !== undefined) {
    if (
      !input.rewardTuning ||
      typeof input.rewardTuning !== 'object' ||
      Array.isArray(input.rewardTuning)
    )
      fail('rewardTuning must be an object of reward overrides');
    for (const [key, value] of Object.entries(input.rewardTuning)) {
      const bounds = REWARD_TUNING_LIMITS[key];
      if (!bounds) fail(`rewardTuning has unknown field ${key}`);
      rewardTuning[key] = finite(value, `rewardTuning.${key}`, bounds.min, bounds.max);
    }
  }
  return {
    schemaVersion: 1,
    kind: 'originman-dance-draft',
    title: input.title.trim(),
    bpm,
    totalBeats: sections.reduce((sum, section) => sum + section.beats, 0),
    sections,
    seed,
    trainingSteps,
    ...(Object.keys(rewardTuning).length ? { rewardTuning } : {}),
    scope: 'configuration-only; no training run, quality claim, or hardware authorization',
  };
}
