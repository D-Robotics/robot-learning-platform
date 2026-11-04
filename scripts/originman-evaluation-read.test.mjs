import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readOriginmanEvaluation } from '../plugins/rdk-robot-learning-platform/scripts/workflow-inspection.mjs';
const sha = 'a'.repeat(64);
const run = {
  runId: 'eval1',
  modelId: 'model1',
  taskId: 'originman-recovery',
  status: 'completed',
  mock: false,
  training: { originmanWorkshop: { phase: 'evaluate', sourceRunId: 'train1' } },
  metrics: {
    originmanWorkshop: {
      phase: 'evaluate',
      sourceRunId: 'train1',
      policySha256: sha,
      hardwareEligible: false,
      feedbackComparison: {
        clearGain: false,
        suites: [
          {
            id: 'historical',
            cases: Array(31).fill({}),
            originalRecovered: 13,
            tunedRecovered: 13,
            rlRecovered: 6,
          },
        ],
      },
    },
  },
};
const parent = {
  runId: 'train1',
  modelId: 'model1',
  taskId: 'originman-recovery',
  status: 'completed',
  mock: false,
  artifact: { sha256: sha },
  training: { originmanWorkshop: { phase: 'train' } },
  metrics: { originmanWorkshop: { phase: 'train', policySha256: sha } },
};
test('read-only result verifies the specific source and digest', async () => {
  const calls = [];
  const r = await readOriginmanEvaluation({ runId: 'eval1' }, async (n, a) => {
    calls.push([n, a]);
    return a.runId === 'eval1' ? run : parent;
  });
  assert.deepEqual(calls, [
    ['rdk_training_status', { runId: 'eval1' }],
    ['rdk_training_status', { runId: 'train1' }],
  ]);
  assert.equal(r.sourceVerified, true);
  assert.equal(r.suites[0].caseCount, 31);
  assert.equal(r.suites[0].rlRecovered, 6);
  assert.equal(r.clearGain, false);
});
test('wrong run or phase is rejected', async () => {
  for (const candidate of [
    { ...run, runId: 'other' },
    { ...run, taskId: 'walk' },
    { ...run, training: { originmanWorkshop: { phase: 'train' } } },
  ])
    await assert.rejects(readOriginmanEvaluation({ runId: 'eval1' }, async () => candidate));
});
test('mismatched parent or evaluation digest is never reported as verified', async () => {
  for (const changed of [
    { ...parent, mock: true },
    { ...parent, modelId: 'other' },
    { ...parent, artifact: { sha256: 'b'.repeat(64) } },
    { ...parent, runId: 'other' },
  ]) {
    const r = await readOriginmanEvaluation({ runId: 'eval1' }, async (_n, a) =>
      a.runId === 'eval1' ? run : changed,
    );
    assert.equal(r.sourceVerified, false);
  }
});
test('conflicting evaluation source is never reported as verified', async () => {
  const broken = structuredClone(run);
  broken.metrics.originmanWorkshop.sourceRunId = 'other';
  const r = await readOriginmanEvaluation({ runId: 'eval1' }, async (_n, a) =>
    a.runId === 'eval1' ? broken : parent,
  );
  assert.equal(r.sourceVerified, false);
});

test('missing model identities do not verify', async () => {
  const evaluation = { ...run, modelId: undefined };
  const source = { ...parent, modelId: undefined };
  const result = await readOriginmanEvaluation({ runId: 'eval1' }, async (_n, a) =>
    a.runId === 'eval1' ? evaluation : source,
  );
  assert.equal(result.sourceVerified, false);
});
test('unverified provenance never promotes an apparent gain to a conclusion', async () => {
  const evaluation = structuredClone(run);
  evaluation.metrics.originmanWorkshop.feedbackComparison.clearGain = true;
  const result = await readOriginmanEvaluation({ runId: 'eval1' }, async (_n, a) =>
    a.runId === 'eval1' ? evaluation : { ...parent, mock: true },
  );
  assert.equal(result.sourceVerified, false);
  assert.equal(result.clearGain, null);
  assert.equal(result.suites[0].rlRecovered, 6);
});

test('compact retained-core status is completed with full same-Run lineage before claiming provenance', async () => {
  const calls = [];
  const result = await readOriginmanEvaluation({ runId: 'eval1' }, async (name, args) => {
    calls.push([name, args]);
    const full = args.runId === 'eval1' ? run : parent;
    if (name === 'rdk_training_status')
      return {
        runId: args.runId,
        status: full.status,
        modelId: full.modelId,
        training: full.training,
        metrics: full.metrics,
      };
    assert.equal(name, 'rdk_lineage_get');
    return { lineage: { run: { ...full, id: args.runId } } };
  });
  assert.equal(result.sourceVerified, true);
  assert.equal(result.suites[0].rlRecovered, 6);
  assert.equal(calls.length, 4);
});
