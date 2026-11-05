import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { startExperimentView, rewardPoints } from './public/experiment-view.mjs';

const markup = fs.readFileSync(new URL('./public/experiment.html', import.meta.url), 'utf8');
async function fixture(t, { context = 'lesson', failed = false, pagePlayback = false } = {}) {
  const dom = new JSDOM(markup, {
    url: 'https://platform.test/learning/experiment.html' + (context ? '?context=' + context : ''),
  });
  const sha = 'a'.repeat(64);
  const state = {
    view: {
      contextId: 'lesson',
      training: { runId: 'train', status: 'completed' },
      evaluation: { runId: 'eval', status: 'completed' },
      associationVerified: true,
      policySha256: sha,
      videoRecorded: true,
      stage: 'results',
      clearGain: false,
      nextAction: '查看同源对比与回放。',
    },
  };
  const training = {
    id: 'train',
    metrics: { originmanWorkshop: { policySha256: sha } },
    progress: [
      { iteration: 1, meanReward: -2 },
      { iteration: 2, meanReward: 4 },
    ],
  };
  const evaluation = {
    id: 'eval',
    metrics: {
      originmanWorkshop: {
        sourceRunId: 'train',
        policySha256: sha,
        feedbackComparison: {
          suites: [
            {
              id: 'historical',
              cases: [{}, {}, {}],
              originalRecovered: 2,
              tunedRecovered: 2,
              rlRecovered: 1,
            },
          ],
        },
      },
    },
  };
  const calls = [],
    exports = [];
  const opened = [];
  let unauthorized = failed;
  const instance = await startExperimentView({
    document: dom.window.document,
    location: dom.window.location,
    EventSourceImpl: null,
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (unauthorized) return Response.json({}, { status: 401 });
      const pathname = new URL(url).pathname;
      return Response.json(
        pathname.endsWith('/experiments/lesson')
          ? state
          : { run: pathname.endsWith('/runs/train') ? training : evaluation },
      );
    },
    onExport: (value) => exports.push(value),
    ...(pagePlayback ? { openPlayback: async () => opened.push('same-experiment') } : {}),
  });
  t.after(() => {
    instance.dispose();
    dom.window.close();
  });
  return {
    dom,
    state,
    training,
    evaluation,
    calls,
    exports,
    opened,
    instance,
    $: (id) => dom.window.document.getElementById(id),
    failAuth: () => {
      unauthorized = true;
    },
  };
}
test('explicit experiment displays real curve, comparison and media under the same proxy mount', async (t) => {
  const f = await fixture(t);
  assert.equal(f.$('reward-chart').hasAttribute('hidden'), false);
  assert.equal(f.$('comparison-table').hidden, false);
  assert.match(f.$('comparison-body').textContent, /2 \/ 3.*2 \/ 3.*1 \/ 3/);
  assert.equal(f.$('quality-status').textContent, '本次未达到收益判据');
  assert.equal(
    f.$('experiment-video').getAttribute('src'),
    'https://platform.test/learning/api/v1/duck/runs/eval/workshop-video?format=webm',
  );
  assert.equal(f.$('playback-status').textContent, '尚未播放');
  f.$('experiment-video').dispatchEvent(new f.dom.window.Event('playing'));
  assert.equal(f.$('playback-status').textContent, '正在播放本次回放');
  assert.ok(f.calls.every((url) => url.startsWith('https://platform.test/learning/api/v1/duck/')));
  f.$('export-experiment').click();
  assert.equal(f.exports[0].experiment.training.runId, 'train');
});
test('missing experiment never fetches or selects recent/global history', async (t) => {
  const f = await fixture(t, { context: '' });
  assert.deepEqual(f.calls, []);
  assert.match(f.$('experiment-error').textContent, /明确实验/);
  assert.equal(f.$('experiment-video').hidden, true);
});
test('another Run or policy in a later reply clears stale results and cannot be played/exported', async (t) => {
  const f = await fixture(t);
  f.evaluation.metrics.originmanWorkshop.sourceRunId = 'foreign';
  await f.instance.refresh();
  assert.match(f.$('experiment-error').textContent, /父任务或权重摘要/);
  assert.equal(f.$('comparison-table').hidden, true);
  assert.equal(f.$('experiment-video').hasAttribute('src'), false);
  assert.equal(f.$('export-experiment').disabled, true);
  assert.equal(f.$('playback-status').textContent, '尚未播放');
});
test('expired authentication removes the previous success and offers the platform login entry', async (t) => {
  const f = await fixture(t);
  f.failAuth();
  await f.instance.refresh();
  assert.equal(f.$('login-platform').hidden, false);
  assert.equal(f.$('training-status').textContent, '待验证');
  assert.equal(f.$('comparison-table').hidden, true);
  assert.equal(f.$('experiment-video').hidden, true);
});
test('missing engine data remains empty and malformed curve points are discarded', async (t) => {
  const f = await fixture(t);
  f.training.progress = [];
  f.evaluation.metrics.originmanWorkshop.feedbackComparison.suites = [];
  await f.instance.refresh();
  assert.equal(f.$('curve-empty').hidden, false);
  assert.equal(f.$('comparison-empty').hidden, false);
  assert.deepEqual(
    rewardPoints({
      progress: [
        { iteration: 1, meanReward: NaN },
        { iteration: 2, meanReward: 'fake' },
      ],
    }),
    [],
  );
});

test('sandboxed App playback opens the same experiment page and never navigates raw media', async (t) => {
  const f = await fixture(t, { pagePlayback: true });
  assert.equal(f.$('experiment-video').hasAttribute('src'), false);
  assert.equal(f.$('open-playback-page').hidden, false);
  f.$('open-playback-page').click();
  assert.deepEqual(f.opened, ['same-experiment']);
  assert.ok(f.calls.every((url) => !url.includes('workshop-video')));
  f.instance.dispose();
  f.$('open-playback-page').click();
  assert.deepEqual(f.opened, ['same-experiment']);
});
