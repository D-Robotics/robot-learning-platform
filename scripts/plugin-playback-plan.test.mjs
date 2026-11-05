import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createPlaybackPlan } from '../plugins/rdk-robot-learning-platform/scripts/playback-plan.mjs';
const record = {
  contextId: 'course-1',
  training: { runId: 'train1' },
  evaluation: { runId: 'eval1', status: 'completed' },
  association: { executionVerified: true },
  playback: { state: 'recorded' },
  links: { experiment: 'https://platform.example/learning/experiment.html?context=course-1' },
};
function page(changes = {}) {
  let playCalls = 0;
  const video = {
    currentSrc:
      'https://platform.example/learning/api/v1/duck/runs/eval1/workshop-video?format=webm',
    currentTime: 0,
    duration: 6,
    paused: true,
    ended: false,
    muted: false,
    readyState: 0,
    error: null,
    play: async () => {
      playCalls++;
      video.paused = false;
    },
    ...changes.video,
  };
  const diag = {
    contextId: 'course-1',
    training: { runId: 'train1' },
    evaluation: { runId: 'eval1' },
    associationVerified: true,
    ...changes.diag,
  };
  const location = new URL(changes.url ?? record.links.experiment);
  const document = {
    visibilityState: changes.visibility ?? 'visible',
    getElementById: (id) =>
      id === 'experiment-video'
        ? video
        : id === 'experiment-diagnostics'
          ? { textContent: JSON.stringify(diag) }
          : null,
  };
  return {
    sandbox: { document, location, URL, setTimeout, clearTimeout },
    video,
    calls: () => playCalls,
  };
}
const run = (script, p) => vm.runInNewContext('(' + script + ')()', p.sandbox);
test('recorded verified result gets in-app route, guarded start and observation scripts', async () => {
  const plan = createPlaybackPlan(record);
  assert.equal(plan.available, true);
  assert.equal(plan.surface, 'qoder-in-app');
  assert.equal(plan.verifiedInPlayer, false);
  assert.equal(plan.requiredToolNames.includes('evaluate_script'), true);
  const p = page();
  const start = await run(plan.startScript, p);
  assert.equal(p.calls(), 1);
  assert.equal(p.video.muted, true);
  assert.equal(start.paused, false);
  p.video.currentTime = 2;
  assert.equal((await run(plan.probeScript, p)).currentTime, 2);
  p.video.currentTime = 6;
  p.video.ended = true;
  assert.equal((await run(plan.probeScript, p)).ended, true);
});
test('wrong tab, context, run, source and unverified association never play', async () => {
  const plan = createPlaybackPlan(record);
  for (const changes of [
    { url: 'https://other.example/learning/experiment.html?context=course-1' },
    { url: 'https://platform.example/learning/experiment.html?context=other' },
    { diag: { evaluation: { runId: 'other' } } },
    { diag: { training: { runId: 'other' } } },
    { diag: { associationVerified: false } },
    {
      video: {
        currentSrc: 'https://platform.example/learning/api/v1/duck/runs/other/workshop-video',
      },
    },
  ]) {
    const p = page(changes);
    await assert.rejects(run(plan.startScript, p));
    assert.equal(p.calls(), 0);
    assert.equal(p.video.muted, false);
  }
});
test('missing recording, failed evaluation and incomplete provenance stay blocked', () => {
  for (const r of [
    { ...record, playback: { state: 'missing' } },
    { ...record, association: { executionVerified: false } },
    { ...record, evaluation: { runId: 'eval1', status: 'failed' } },
    {
      ...record,
      links: { experiment: 'https://platform.example/learning/experiment.html?context=other' },
    },
  ]) {
    const p = createPlaybackPlan(r);
    assert.equal(p.available, false);
    assert.equal(p.startScript, undefined);
    assert.equal(p.verifiedInPlayer, false);
  }
});
test('repeated request on a playing or ended video does not restart or fake progress', async () => {
  const plan = createPlaybackPlan(record);
  for (const state of [
    { currentTime: 2, paused: false },
    { currentTime: 6, paused: true, ended: true },
  ]) {
    const p = page({ video: state });
    await run(plan.startScript, p);
    assert.equal(p.calls(), 0);
    assert.equal(p.video.currentTime, state.currentTime);
  }
});

test('media rejection remains a failure and does not forge playing or ended state', async () => {
  const plan = createPlaybackPlan(record);
  const p = page({
    video: {
      play: async () => {
        throw Error('NotAllowedError');
      },
    },
  });
  await assert.rejects(run(plan.startScript, p), /NotAllowedError/);
  assert.equal(p.video.currentTime, 0);
  assert.equal(p.video.ended, false);
  assert.equal(p.video.paused, true);
});

test('text-only MCP recovery preserves the executable plan instead of discarding routing', async () => {
  const { experimentModelResult } =
    await import('../plugins/rdk-robot-learning-platform/scripts/experience-mcp.mjs');
  const plan = createPlaybackPlan(record);
  const model = experimentModelResult({ ...record, playbackPlan: plan });
  assert.deepEqual(model.playbackPlan, plan);
  assert.equal(model.playback.verifiedInPlayer, false);
});

test('cold media uses its declared source and may start before duration metadata exists', async () => {
  const plan = createPlaybackPlan(record);
  const p = page({
    video: {
      currentSrc: '',
      duration: Number.NaN,
      readyState: 0,
      getAttribute: () =>
        'https://platform.example/learning/api/v1/duck/runs/eval1/workshop-video?format=webm',
    },
  });
  const result = await run(plan.startScript, p);
  assert.equal(p.calls(), 1);
  assert.equal(result.duration, null);
  assert.equal(result.paused, false);
  assert.equal(result.ended, false);
});

test('hidden host panel is observable but cannot attempt playback before being brought to front', async () => {
  const plan = createPlaybackPlan(record);
  const p = page({ visibility: 'hidden' });
  assert.equal((await run(plan.probeScript, p)).visibility, 'hidden');
  await assert.rejects(run(plan.startScript, p), /前台|可见/);
  assert.equal(p.calls(), 0);
  assert.equal(p.video.muted, false);
});
