import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { startWorkshop } from './public/workshop-page.mjs';
const html = await fs.readFile(new URL('./public/workshop.html', import.meta.url), 'utf8');
const settle = () => new Promise((r) => setTimeout(r, 25));
function fixture({ lost = false, failedSwitch = false, offline = false } = {}) {
  const dom = new JSDOM(html, {
    url: 'https://platform.test/course/workshop.html?context=ws-test',
  });
  const state = {
    contextId: 'ws-test',
    modelId: 'm',
    computeResourceId: 'r',
    stage: 'ready',
    nextAction: '先看参考',
    training: null,
    evaluation: null,
    autoContinue: false,
    reference: 'pending',
  };
  const calls = [];
  let timer;
  const fetchImpl = async (url, options = {}) => {
    const p = new URL(url).pathname.split('/api/v1/duck/')[1],
      b = options.body ? JSON.parse(options.body) : null;
    calls.push({ p, b });
    if (p === 'compute-resources/r/test')
      return {
        ok: true,
        json: async () => ({
          ok: true,
          connected: !offline,
          computeResource: { status: offline ? 'offline' : 'online' },
        }),
      };
    if (failedSwitch && p.endsWith('/other/select'))
      return { ok: false, json: async () => ({ ok: false, message: '目标实验不可用。' }) };
    if (p === 'runs' && lost) throw Error('lost response');
    if (p.endsWith('/reference')) state.reference = b.reference;
    if (p.endsWith('/claim/train')) {
      state.stage = 'unknown';
      state.autoContinue = true;
      return {
        ok: true,
        json: async () => ({
          ok: true,
          submission: {
            idempotencyKey: 'ws-test-train',
            training: { originmanWorkshop: { phase: 'train', timesteps: b.timesteps } },
          },
        }),
      };
    }
    if (p.endsWith('/claim/evaluate'))
      return {
        ok: true,
        json: async () => ({
          ok: true,
          submission: {
            idempotencyKey: 'ws-test-evaluate',
            training: { originmanWorkshop: { phase: 'evaluate', sourceRunId: 'train' } },
          },
        }),
      };
    if (p === 'runs') {
      if (b.training.originmanWorkshop.phase === 'train') {
        state.training = { runId: 'train', status: 'running' };
        state.stage = 'training';
      } else {
        state.evaluation = { runId: 'eval', status: 'running' };
        state.stage = 'evaluating';
      }
    }
    if (p === 'runs/train') {
      state.training.status = 'completed';
      state.stage = 'ready-evaluate';
    }
    if (p === 'runs/eval') {
      state.evaluation.status = 'completed';
      state.stage = 'results';
    }
    return {
      ok: true,
      json: async () => ({
        ok: true,
        session: structuredClone(state),
        sessions: [{ contextId: 'other', createdAt: '2026-11-05T10:00:00Z', timesteps: 8192 }],
        experiments: [],
      }),
    };
  };
  return {
    dom,
    state,
    calls,
    fetchImpl,
    setTimer(fn) {
      timer = fn;
      return 1;
    },
    clearTimer() {
      timer = null;
    },
    async tick() {
      assert.ok(timer);
      await timer();
      await settle();
    },
  };
}
test('one prompt opens ready state; reference and explicit quick button drive one train and one evaluation', async () => {
  const f = fixture(),
    d = f.dom.window.document;
  const c = await startWorkshop({
    document: d,
    location: f.dom.window.location,
    fetchImpl: f.fetchImpl,
    setTimer: f.setTimer,
    clearTimer: f.clearTimer,
  });
  try {
    assert.equal(
      f.calls.some((x) => x.p === 'runs'),
      false,
    );
    assert.equal(d.getElementById('budget-section').hidden, true);
    d.getElementById('reference-video').dispatchEvent(new f.dom.window.Event('ended'));
    await settle();
    assert.equal(d.getElementById('budget-section').hidden, false);
    d.getElementById('start-quick').click();
    d.getElementById('start-quick').click();
    await settle();
    assert.equal(f.calls.filter((x) => x.p === 'runs').length, 1);
    d.getElementById('reference-video').dispatchEvent(new f.dom.window.Event('ended'));
    await settle();
    assert.equal(f.calls.filter((x) => x.p.endsWith('/reference')).length, 1);
    await f.tick();
    await f.tick();
    const writes = f.calls.filter((x) => x.p === 'runs');
    assert.equal(writes.length, 2);
    for (const phase of ['train', 'evaluate']) {
      const claim = f.calls.findIndex((x) => x.p.endsWith('/claim/' + phase));
      assert.equal(f.calls[claim - 1].p, 'compute-resources/r/test');
    }
    assert.equal(writes[0].b.training.originmanWorkshop.timesteps, 8192);
    assert.equal(writes[1].b.training.originmanWorkshop.sourceRunId, 'train');
    assert.equal(
      d.getElementById('result-frame').getAttribute('src'),
      'https://platform.test/course/experiment.html?context=ws-test',
    );
    assert.match(d.getElementById('execution-status').textContent, /已完成/);
  } finally {
    c.dispose();
    f.dom.window.close();
  }
});
test('lost submit response only reads original state; no retry or budget expansion', async () => {
  const f = fixture({ lost: true }),
    d = f.dom.window.document;
  const c = await startWorkshop({
    document: d,
    location: f.dom.window.location,
    fetchImpl: f.fetchImpl,
    setTimer: f.setTimer,
    clearTimer: f.clearTimer,
  });
  try {
    d.getElementById('skip-reference').click();
    await settle();
    d.getElementById('start-quick').click();
    await settle();
    await c.refresh();
    await c.refresh();
    assert.equal(f.calls.filter((x) => x.p === 'runs').length, 1);
    assert.match(d.getElementById('execution-status').textContent, /不明确|待核对/);
    assert.equal(d.getElementById('connection-status').textContent, '需要处理');
  } finally {
    c.dispose();
    f.dom.window.close();
  }
});
test('formal budget requires a visible recipe confirmation; custom inputs and history remain available', async () => {
  const f = fixture(),
    d = f.dom.window.document;
  const c = await startWorkshop({
    document: d,
    location: f.dom.window.location,
    fetchImpl: f.fetchImpl,
    setTimer: f.setTimer,
    clearTimer: f.clearTimer,
  });
  try {
    d.getElementById('skip-reference').click();
    await settle();
    d.getElementById('start-formal').click();
    assert.match(d.getElementById('recipe-confirm-text').textContent, /500000/);
    assert.equal(f.calls.filter((x) => x.p === 'runs').length, 0);
    d.getElementById('cancel-recipe').click();
    assert.equal(d.getElementById('recipe-confirm').hidden, true);
    assert.ok(d.getElementById('custom-seed'));
    assert.ok(d.getElementById('history-toggle'));
  } finally {
    c.dispose();
    f.dom.window.close();
  }
});

test('an unavailable history selection clears the previous experiment instead of keeping its result', async () => {
  const f = fixture({ failedSwitch: true }),
    d = f.dom.window.document;
  const c = await startWorkshop({
    document: d,
    location: f.dom.window.location,
    fetchImpl: f.fetchImpl,
    setTimer: f.setTimer,
    clearTimer: f.clearTimer,
  });
  try {
    d.getElementById('skip-reference').click();
    await settle();
    d.getElementById('start-quick').click();
    await settle();
    await f.tick();
    await f.tick();
    assert.equal(d.getElementById('result-section').hidden, false);
    d.getElementById('history-toggle').click();
    await settle();
    d.querySelector('#history-list button').click();
    await settle();
    assert.equal(d.getElementById('result-section').hidden, true);
    assert.equal(d.getElementById('result-frame').getAttribute('src'), 'about:blank');
    assert.match(d.getElementById('workshop-error').textContent, /不可用/);
  } finally {
    c.dispose();
    f.dom.window.close();
  }
});

test('double-clicking new experiment only creates one draft and never submits training', async () => {
  const f = fixture(),
    d = f.dom.window.document;
  const c = await startWorkshop({
    document: d,
    location: f.dom.window.location,
    fetchImpl: f.fetchImpl,
    setTimer: f.setTimer,
    clearTimer: f.clearTimer,
  });
  try {
    d.getElementById('new-experiment').click();
    d.getElementById('new-experiment').click();
    await settle();
    assert.equal(f.calls.filter((x) => x.p === 'workshop-sessions' && x.b).length, 1);
    assert.equal(
      f.calls.some((x) => x.p === 'runs'),
      false,
    );
  } finally {
    c.dispose();
    f.dom.window.close();
  }
});
test('offline resource stops before consuming a claim or submitting a run', async () => {
  const f = fixture({ offline: true }),
    d = f.dom.window.document;
  const c = await startWorkshop({
    document: d,
    location: f.dom.window.location,
    fetchImpl: f.fetchImpl,
    setTimer: f.setTimer,
    clearTimer: f.clearTimer,
  });
  try {
    d.getElementById('skip-reference').click();
    await settle();
    d.getElementById('start-quick').click();
    await settle();
    assert.equal(
      f.calls.some((x) => x.p.includes('/claim/') || x.p === 'runs'),
      false,
    );
    assert.match(d.getElementById('workshop-error').textContent, /训练资源暂不可用/);
  } finally {
    c.dispose();
    f.dom.window.close();
  }
});
