import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { startExperimentView, rewardPoints } from './public/experiment-view.mjs';

const markup = fs.readFileSync(new URL('./public/experiment.html', import.meta.url), 'utf8');
async function fixture(
  t,
  {
    context = 'lesson',
    failed = false,
    pagePlayback = false,
    eventSource = null,
    pendingEvaluation = false,
  } = {},
) {
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
  if (pendingEvaluation) {
    state.view.evaluation.status = 'running';
    state.view.videoRecorded = false;
  }
  const calls = [],
    exports = [];
  const opened = [];
  let unauthorized = failed;
  const instance = await startExperimentView({
    document: dom.window.document,
    location: dom.window.location,
    EventSourceImpl: eventSource,
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
  assert.match(f.$('curve-reading').textContent, /-2\.000.*4\.000.*采样较少/);
  assert.match(f.$('comparison-reading').textContent, /恢复 1 \/ 3 次.*比调参反馈少恢复 1 次/);
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
  assert.equal(f.$('curve-reading').hidden, true);
  assert.equal(f.$('comparison-reading').hidden, true);
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

test('terminal views stop streaming; active views clear reconnect labels after open and close at completion', async (t) => {
  const streams = [];
  class Stream {
    handlers = {};
    closed = false;
    constructor() {
      streams.push(this);
    }
    addEventListener(name, fn) {
      this.handlers[name] = fn;
    }
    close() {
      this.closed = true;
    }
  }
  await fixture(t, { eventSource: Stream });
  assert.equal(streams.length, 0, 'completed result must not keep reconnecting');
  const f = await fixture(t, { eventSource: Stream, pendingEvaluation: true });
  assert.equal(streams.length, 1);
  streams[0].handlers.error();
  assert.match(f.$('connection-status').textContent, /重连/);
  streams[0].handlers.open();
  assert.equal(f.$('connection-status').textContent, '已连接本次实验');
  f.state.view.evaluation.status = 'completed';
  await f.instance.refresh();
  assert.equal(streams[0].closed, true);
  streams[0].handlers.error();
  assert.equal(f.$('connection-status').textContent, '已连接本次实验');
});

test('curve inspector reads actual samples with keyboard-accessible range and training-step unit', async (t) => {
  const f = await fixture(t);
  const d = f.dom.window.document;
  const input = d.getElementById('curve-sample');
  assert.equal(input.max, '1');
  input.value = '0';
  input.dispatchEvent(new f.dom.window.Event('input'));
  assert.match(d.getElementById('curve-value').textContent, /1 训练步.*-2\.000/);
  input.value = '1';
  input.dispatchEvent(new f.dom.window.Event('input'));
  assert.match(d.getElementById('curve-value').textContent, /2 训练步.*4\.000/);
});

test('manual pause is reported as paused rather than continuing to claim playback', async (t) => {
  const f = await fixture(t),
    video = f.dom.window.document.getElementById('experiment-video');
  video.currentTime = 2;
  video.dispatchEvent(new f.dom.window.Event('playing'));
  video.dispatchEvent(new f.dom.window.Event('pause'));
  assert.equal(f.dom.window.document.getElementById('playback-status').textContent, '已暂停回放');
});
