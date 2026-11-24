import test from 'node:test';
import { canonicalDanceConfig } from '../plugins/rdk-robot-learning-platform/scripts/dance-training.mjs';
import assert from 'node:assert/strict';
import {
  resolveOriginmanDanceConfig,
  REWARD_TUNING_LIMITS,
  DANCE_SECTION_LABELS,
  DANCE_SECTION_TYPES,
} from '../plugins/rdk-robot-learning-platform/scripts/originman-dance-config.mjs';
import {
  learningGuide,
  ORIGINMAN_DANCE_DRAFT_TOOL,
  originmanDanceDraft,
} from '../plugins/rdk-robot-learning-platform/scripts/workshop-course.mjs';
import { experienceProxy } from '../plugins/rdk-robot-learning-platform/scripts/experience-mcp.mjs';

const base = {
  schemaVersion: 1,
  title: 'probe',
  bpm: 100,
  sections: [{ type: 'weight-shift', beats: 8, intensity: 0.5 }],
};

test('dance retries preserve the selected composition mode', () => {
  for (const compositionMode of ['preset', 'custom']) {
    const draft = canonicalDanceConfig({ ...base, compositionMode });
    assert.equal(resolveOriginmanDanceConfig(draft).compositionMode, compositionMode);
  }
});

test('dance config omits rewardTuning when the learner provides none', () => {
  const resolved = resolveOriginmanDanceConfig({ ...base });
  assert.equal(resolved.rewardTuning, undefined);
});

test('dance config keeps provided reward overrides only', () => {
  const resolved = resolveOriginmanDanceConfig({
    ...base,
    rewardTuning: { squatDepthM: 0.05, tiltPenalty: 4 },
  });
  assert.deepEqual(resolved.rewardTuning, { squatDepthM: 0.05, tiltPenalty: 4 });
});

test('dance config rejects unknown reward keys', () => {
  assert.throws(
    () => resolveOriginmanDanceConfig({ ...base, rewardTuning: { armSwing: 1 } }),
    /unknown field armSwing/,
  );
});

test('dance config rejects out-of-range reward values', () => {
  assert.throws(
    () => resolveOriginmanDanceConfig({ ...base, rewardTuning: { workPenalty: 9.9 } }),
    /rewardTuning.workPenalty/,
  );
});

test('every reward knob is bounded', () => {
  for (const bounds of Object.values(REWARD_TUNING_LIMITS)) {
    assert.ok(bounds.min < bounds.max);
  }
});

test('dance training tool exposes a bounded numEnvs argument', async () => {
  const { DANCE_TRAINING_TOOLS } =
    await import('../plugins/rdk-robot-learning-platform/scripts/dance-training.mjs');
  const tool = DANCE_TRAINING_TOOLS.find((t) => t.name === 'rdk_originman_dance_train');
  const numEnvs = tool.inputSchema.properties.numEnvs;
  assert.equal(numEnvs.type, 'integer');
  assert.equal(numEnvs.minimum, 1);
  assert.equal(numEnvs.maximum, 64);
  assert.equal(numEnvs.default, 64);
  assert.match(tool.description, /64 个并行环境/);
});

test('dance draft and submission expose the same ten actions', async () => {
  const { ORIGINMAN_DANCE_DRAFT_TOOL } =
    await import('../plugins/rdk-robot-learning-platform/scripts/workshop-course.mjs');
  const { DANCE_TRAINING_TOOLS } =
    await import('../plugins/rdk-robot-learning-platform/scripts/dance-training.mjs');
  const submit = DANCE_TRAINING_TOOLS.find((tool) => tool.name === 'rdk_originman_dance_train');
  const allowed = (schema) => schema.properties.sections.items.properties.type.enum;
  assert.equal(DANCE_SECTION_TYPES.length, 10);
  assert.deepEqual(allowed(ORIGINMAN_DANCE_DRAFT_TOOL.inputSchema), DANCE_SECTION_TYPES);
  assert.deepEqual(allowed(submit.inputSchema.properties.dance), DANCE_SECTION_TYPES);
  for (const type of DANCE_SECTION_TYPES) {
    const section = { type, beats: 4, intensity: 0.6 };
    assert.deepEqual(resolveOriginmanDanceConfig({ ...base, sections: [section] }).sections, [
      section,
    ]);
  }
});

test('the action list and preview preserve supported moves, order, beats and budget', () => {
  const catalog = learningGuide({ task: 'dance' });
  assert.equal(catalog.stage, 'movement');
  assert.deepEqual(
    catalog.availableActions,
    DANCE_SECTION_TYPES.map((type) => ({ type, label: DANCE_SECTION_LABELS[type] })),
  );

  const sections = [
    { type: 'single-arm-wave', beats: 8, intensity: 0.5 },
    { type: 'alternating-knee-lift', beats: 4, intensity: 0.75 },
    { type: 'side-tap', beats: 4, intensity: 0.5 },
  ];
  const preview = originmanDanceDraft({ ...base, sections, trainingSteps: 8192 });
  assert.equal(preview.trainingSubmitted, false);
  assert.equal(preview.motionAuthorized, false);
  assert.deepEqual(preview.draft.sections, sections);
  assert.equal(preview.draft.totalBeats, 16);
  assert.match(
    preview.studentReply,
    /单臂挥手.*交替抬膝.*侧点步收回.*16 拍.*8,192 步.*尚未提交训练/,
  );
  assert.throws(
    () => originmanDanceDraft({ ...base, sections: [{ ...sections[0], type: 'backflip' }] }),
    /type/,
  );
});

test('the read-only dance preview fills an omitted schema version on its first MCP call', async () => {
  const input = {
    title: '动作配方验收',
    bpm: 108,
    sections: [
      { type: 'single-arm-wave', beats: 8, intensity: 0.5 },
      { type: 'alternating-knee-lift', beats: 4, intensity: 0.6 },
      { type: 'side-tap', beats: 4, intensity: 0.5 },
    ],
    trainingSteps: 8192,
  };
  const dispatch = experienceProxy({
    request() {
      assert.fail('A dance preview must not call an upstream tool');
    },
  });
  const result = await dispatch('tools/call', {
    name: ORIGINMAN_DANCE_DRAFT_TOOL.name,
    arguments: input,
  });
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  const preview = result.structuredContent;
  assert.equal(preview.draft.schemaVersion, 1);
  assert.equal(preview.draft.totalBeats, 16);
  assert.deepEqual(preview.draft.sections, input.sections);
  assert.equal(preview.draft.trainingSteps, 8192);
  assert.equal(preview.trainingSubmitted, false);
  assert.equal(preview.motionAuthorized, false);
  assert.equal(ORIGINMAN_DANCE_DRAFT_TOOL.inputSchema.properties.schemaVersion.default, 1);
  assert.equal(ORIGINMAN_DANCE_DRAFT_TOOL.inputSchema.required.includes('schemaVersion'), false);
  assert.deepEqual(originmanDanceDraft({ ...input, schemaVersion: 1 }).draft, preview.draft);
  assert.throws(() => originmanDanceDraft({ ...input, schemaVersion: 2 }), /schemaVersion/);
  assert.throws(() => originmanDanceDraft({ ...input, schemaVersion: null }), /schemaVersion/);
  assert.throws(() => originmanDanceDraft([input]), /expected an object/);
  assert.throws(() => resolveOriginmanDanceConfig(input), /schemaVersion/);
});
