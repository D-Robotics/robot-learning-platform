import test from 'node:test';
import assert from 'node:assert/strict';
import { trainingChoice } from '../plugins/rdk-robot-learning-platform/scripts/workshop-course.mjs';

test('ambiguous workshop asks one Chinese budget question without choosing or submitting', () => {
  const r = trainingChoice();
  assert.equal(r.needsInput, true);
  assert.equal(r.selection, null);
  assert.equal(r.trainTool, null);
  assert.match(r.studentReply, /8192.*50万/s);
  assert.equal((r.studentReply.match(/？/g) ?? []).length, 1);
  assert.ok(r.studentReply.length < 150);
});
test('known quick and formal choices are preserved, not asked again', () => {
  const quick = trainingChoice({ choice: 'quick' });
  assert.equal(quick.timesteps, 8192);
  assert.equal(quick.trainTool, 'rdk_originman_short_train');
  assert.equal(quick.needsInput, false);
  assert.equal(quick.qualityClaimAllowed, false);
  const formal = trainingChoice({ choice: 'formal' });
  assert.equal(formal.timesteps, 500000);
  assert.equal(formal.trainTool, 'rdk_originman_train');
  assert.equal(formal.evaluateTool, 'rdk_originman_evaluate');
  assert.equal(formal.needsInput, false);
  assert.equal(formal.qualityClaimAllowed, false);
  assert.match(formal.studentReply, /评测/);
});
test('unknown stays deferred; invalid choices never fall back to quick', () => {
  const r = trainingChoice({ choice: 'unknown' });
  assert.equal(r.trainTool, null);
  assert.equal(r.timesteps, null);
  assert.equal(r.state, 'deferred');
  assert.equal(r.needsInput, false);
  for (const args of [{ choice: '50000' }, { choice: 8192 }, { budget: 500000 }, null])
    assert.throws(() => trainingChoice(args));
});

test('execution completion never substitutes for quality or provenance', async () => {
  const { trainingVerdict } =
    await import('../plugins/rdk-robot-learning-platform/scripts/workshop-course.mjs');
  const suites = [0, 1].map(() => ({
    caseCount: 31,
    originalRecovered: 13,
    tunedRecovered: 17,
    rlRecovered: 25,
  }));
  assert.equal(
    trainingVerdict({ status: 'completed', sourceVerified: true, clearGain: null, suites }).quality,
    'pending',
  );
  assert.equal(
    trainingVerdict({ status: 'completed', sourceVerified: true, clearGain: false, suites })
      .quality,
    'not-met',
  );
  assert.equal(
    trainingVerdict({ status: 'completed', sourceVerified: false, clearGain: true, suites })
      .quality,
    'pending',
  );
  assert.equal(
    trainingVerdict({ status: 'completed', sourceVerified: true, clearGain: true, suites }).quality,
    'met',
  );
  assert.equal(
    trainingVerdict({
      status: 'completed',
      sourceVerified: true,
      clearGain: true,
      suites: suites.slice(1),
    }).quality,
    'pending',
  );
  assert.equal(
    trainingVerdict({
      status: 'completed',
      sourceVerified: true,
      clearGain: true,
      suites: [...suites.slice(1), { ...suites[0], rlRecovered: 1 }],
    }).quality,
    'pending',
  );
  assert.equal(
    trainingVerdict({ status: 'completed', sourceVerified: true, clearGain: true, suites })
      .hardware,
    'unverified',
  );
});

test('budget guide works through MCP without login or any upstream request', async () => {
  const { experienceProxy } =
    await import('../plugins/rdk-robot-learning-platform/scripts/experience-mcp.mjs');
  let calls = 0;
  const handle = experienceProxy({
    request: async () => {
      calls++;
      throw Error('must stay local');
    },
  });
  for (const args of [{}, { choice: 'quick' }, { choice: 'formal' }, { choice: 'unknown' }]) {
    const r = await handle('tools/call', {
      name: 'rdk_originman_training_choice',
      arguments: args,
    });
    assert.equal(r.structuredContent.state, trainingChoice(args).state);
    assert.equal(r.structuredContent.trainTool, trainingChoice(args).trainTool);
    assert.notEqual(r.isError, true);
  }
  assert.equal(calls, 0);
});

test('course brief stays two sentences and local, without historical scores or invented multipliers', async () => {
  const { courseBrief } =
    await import('../plugins/rdk-robot-learning-platform/scripts/workshop-course.mjs');
  const { experienceProxy } =
    await import('../plugins/rdk-robot-learning-platform/scripts/experience-mcp.mjs');
  const r = courseBrief();
  assert.equal((r.studentReply.match(/。/g) ?? []).length, 2);
  assert.ok(r.studentReply.length < 130);
  assert.match(r.studentReply, /8192.*50万/);
  assert.match(r.studentReply, /回放待验/);
  assert.doesNotMatch(r.studentReply, /倍|27\/31|25\/31/);
  let calls = 0;
  const handle = experienceProxy({
    request: async () => {
      calls++;
      throw Error('unexpected upstream');
    },
  });
  const result = await handle('tools/call', { name: 'rdk_originman_course_brief', arguments: {} });
  assert.equal(result.content[0].text, r.studentReply);
  assert.equal(calls, 0);
  assert.throws(() => courseBrief({ contextId: 'not-a-result-reader' }));
});
