export const DANCE_REWARD_LIMITS = {
  weightShiftTargetM: [0.02, 0.06],
  weightShiftToleranceM: [0.008, 0.04],
  squatDepthM: [0.02, 0.07],
  squatToleranceM: [0.008, 0.04],
  settleStillnessWeight: [1, 4],
  workPenalty: [0.2, 1.5],
  squatWorkPenalty: [0.05, 1],
  tiltPenalty: [1, 6],
  armSwingWeight: [1, 8],
  armSpeedWeight: [0.2, 4],
  weightShiftWeight: [1, 8],
  squatWeight: [1, 8],
  settleArmsWeight: [0.2, 6],
} as const;

const sectionTypes = ['alternating-arms', 'weight-shift', 'squat-rise', 'open-pose'] as const;
type SectionType = (typeof sectionTypes)[number];
export interface OriginmanDanceTraining {
  schemaVersion: 1;
  title: string;
  bpm: number;
  sections: { type: SectionType; beats: 4 | 8 | 16; intensity: number }[];
  seed: number;
  trainingSteps: number;
  rewardTuning?: Partial<Record<keyof typeof DANCE_REWARD_LIMITS, number>>;
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const within = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

export function normalizeOriginmanDanceTraining(value: unknown): OriginmanDanceTraining | null {
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    Object.keys(value).some(
      (key) =>
        ![
          'schemaVersion',
          'title',
          'bpm',
          'sections',
          'seed',
          'trainingSteps',
          'rewardTuning',
        ].includes(key),
    ) ||
    typeof value.title !== 'string' ||
    !value.title.trim() ||
    value.title.length > 80 ||
    !within(value.bpm, 80, 140) ||
    !Array.isArray(value.sections) ||
    value.sections.length < 1 ||
    value.sections.length > 8
  )
    return null;
  const seed = value.seed === undefined ? 7 : value.seed;
  const trainingSteps = value.trainingSteps === undefined ? 500_000 : value.trainingSteps;
  if (
    !within(seed, 0, 2_147_483_647) ||
    !Number.isSafeInteger(seed) ||
    !within(trainingSteps, 8192, 2_000_000) ||
    !Number.isSafeInteger(trainingSteps)
  )
    return null;
  const sections: OriginmanDanceTraining['sections'] = [];
  for (const section of value.sections) {
    if (
      !object(section) ||
      Object.keys(section).some((key) => !['type', 'beats', 'intensity'].includes(key)) ||
      !sectionTypes.includes(section.type as SectionType) ||
      (section.beats !== 4 && section.beats !== 8 && section.beats !== 16) ||
      !within(section.intensity, 0.25, 1)
    )
      return null;
    sections.push({
      type: section.type as SectionType,
      beats: section.beats,
      intensity: section.intensity,
    });
  }
  const rewardTuning: NonNullable<OriginmanDanceTraining['rewardTuning']> = {};
  if (value.rewardTuning !== undefined) {
    if (!object(value.rewardTuning)) return null;
    for (const [key, entry] of Object.entries(value.rewardTuning)) {
      if (!Object.hasOwn(DANCE_REWARD_LIMITS, key)) return null;
      const name = key as keyof typeof DANCE_REWARD_LIMITS;
      const [min, max] = DANCE_REWARD_LIMITS[name];
      if (!within(entry, min, max)) return null;
      rewardTuning[name] = entry;
    }
  }
  return {
    schemaVersion: 1,
    title: value.title.trim(),
    bpm: value.bpm,
    sections,
    seed,
    trainingSteps,
    ...(Object.keys(rewardTuning).length ? { rewardTuning } : {}),
  };
}
