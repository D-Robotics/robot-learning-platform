import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { startWorkshop } from './public/workshop-page.mjs';
const html = await fs.readFile(new URL('./public/workshop.html', import.meta.url), 'utf8');
const settle = () => new Promise((r) => setTimeout(r, 25));
function fixture({
  lost = false,
  lostAfterAccept = false,
  failedSwitch = false,
  offline = false,
  diskFull = false,
  comparison = false,
} = {}) {
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
  if (comparison)
    Object.assign(state, {
      stage: 'results',
      recipe: { timesteps: 16384, seed: 11, pushMaxForce: 7.5 },
      training: { runId: 'train', status: 'completed' },
      evaluation: { runId: 'eval', status: 'completed' },
    });
  const original = structuredClone(state);
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
    if (comparison && p.endsWith('/comparison')) {
      const selected = new URL(url).searchParams.get('with');
      if (selected !== 'ws-older,ws-middle') throw Error('unexpected comparison selection');
      return {
        ok: true,
        json: async () => ({
          ok: true,
          comparison: {
            comparable: true,
            sameTrainingSetup: true,
            rounds: [
              ['ws-older', 8192, 1, 1],
              ['ws-middle', 16384, 2, 3],
              ['ws-test', 500000, 27, 25],
            ].map(([contextId, timesteps, publicCount, additionalCount]) => ({
              contextId,
              recipe: { timesteps, seed: 7, pushMaxForce: 8.1 },
              clearGain: timesteps === 500000,
              actualTimesteps: timesteps === 500000 ? 500224 : timesteps,
              suites: [publicCount, additionalCount].map((recovered, i) => ({
                recovered,
                original: 13,
                tuned: i ? 17 : 13,
                total: 31,
              })),
            })),
          },
        }),
      };
    }
    if (comparison && p === 'workshop-sessions' && b)
      Object.assign(state, {
        contextId: 'ws-comparison',
        stage: 'ready',
        recipe: null,
        training: null,
        evaluation: null,
        reference: b.comparisonBaseId ? 'skipped' : 'pending',
        comparisonBase: b.comparisonBaseId
          ? { contextId: original.contextId, recipe: original.recipe }
          : undefined,
      });
    if (p.endsWith('/reference')) state.reference = b.reference;
    if (p.endsWith('/pause')) state.autoContinue = false;
    if (p.endsWith('/continue')) state.autoContinue = true;
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
        if (lostAfterAccept) throw Error('lost response after accepting training');
      } else {
        state.evaluation = { runId: 'eval', status: diskFull ? 'failed' : 'running' };
        state.stage = diskFull ? 'blocked' : 'evaluating';
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
    if (p === 'runs/eval/logs' && diskFull)
      return {
        ok: true,
        json: async () => ({
          ok: true,
          runId: 'eval',
          lines: [{ stream: 'stderr', text: 'RuntimeError: 可用磁盘空间不足，保留记录' }],
        }),
      };
    return {
      ok: true,
      json: async () => ({
        ok: true,
        session: structuredClone(state),
        sessions: [
          { contextId: 'other', createdAt: '2026-11-05T10:00:00Z', timesteps: 8192 },
          ...(comparison
            ? ['ws-older', 'ws-middle'].map((contextId, i) => ({
                contextId,
                timesteps: 8192 * (i + 1),
                createdAt: '2026-11-05T10:00:00Z',
                evaluationRecorded: true,
              }))
            : []),
        ],
        experiments: [],
      }),
    };
  };
  return {
    dom,
    state,
    original,
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
    assert.equal(d.getElementById('workshop-step-reference').getAttribute('aria-current'), 'step');
    const primary = d.getElementById('workshop-primary');
    assert.equal(primary.textContent, '看参考或跳过');
    primary.click();
    assert.equal(d.activeElement.id, 'reference-section');
    assert.equal(
      f.calls.some((x) => x.p === 'runs'),
      false,
    );
    d.getElementById('reference-video').dispatchEvent(new f.dom.window.Event('ended'));
    await settle();
    assert.equal(d.getElementById('budget-section').hidden, false);
    assert.equal(primary.textContent, '选择训练预算');
    primary.click();
    assert.equal(d.activeElement.id, 'budget-section');
    assert.equal(d.getElementById('reference-section').hidden, true);
    assert.equal(d.getElementById('workshop-step-budget').getAttribute('aria-current'), 'step');
    assert.equal(d.activeElement.id, 'budget-section');
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
    assert.equal(d.getElementById('workshop-step-result').getAttribute('aria-current'), 'step');
    d.getElementById('go-results').click();
    assert.equal(d.activeElement.id, 'result-section');
    d.getElementById('workshop-step-reference').click();
    assert.equal(d.getElementById('reference-section').hidden, false);
    d.getElementById('reference-video').dispatchEvent(new f.dom.window.Event('ended'));
    await settle();
    assert.equal(f.calls.filter((x) => x.p.endsWith('/reference')).length, 1);
    assert.equal(f.calls.filter((x) => x.p === 'runs').length, 2);
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

test('a reference write in flight cannot be duplicated or carried into a new experiment', async () => {
  const f = fixture(),
    d = f.dom.window.document;
  let finishReference;
  const pending = new Promise((resolve) => {
    finishReference = resolve;
  });
  const c = await startWorkshop({
    document: d,
    location: f.dom.window.location,
    fetchImpl: async (url, options) => {
      if (url.pathname.endsWith('/reference')) await pending;
      return f.fetchImpl(url, options);
    },
    setTimer: f.setTimer,
    clearTimer: f.clearTimer,
  });
  try {
    d.getElementById('skip-reference').click();
    d.getElementById('skip-reference').click();
    d.getElementById('reference-video').dispatchEvent(new f.dom.window.Event('ended'));
    d.getElementById('new-experiment').click();
    await settle();
    assert.equal(f.calls.filter((x) => x.p === 'workshop-sessions' && x.b).length, 0);
    finishReference();
    await settle();
    const writes = f.calls.filter((x) => x.p.endsWith('/reference'));
    assert.deepEqual(writes, [
      {
        p: 'workshop-sessions/ws-test/reference',
        b: { reference: 'skipped' },
      },
    ]);
    assert.equal(d.getElementById('budget-section').hidden, false);
    assert.equal(d.activeElement.id, 'budget-section');
  } finally {
    c.dispose();
    finishReference();
    f.dom.window.close();
  }
});

test('reopening after a lost acknowledgement evaluates the accepted training exactly once', async () => {
  const f = fixture({ lostAfterAccept: true }),
    d = f.dom.window.document;
  const open = () =>
    startWorkshop({
      document: d,
      location: f.dom.window.location,
      fetchImpl: f.fetchImpl,
      setTimer: f.setTimer,
      clearTimer: f.clearTimer,
    });
  let c = await open();
  try {
    d.getElementById('skip-reference').click();
    await settle();
    d.getElementById('start-quick').click();
    await settle();
    assert.equal(f.state.training.runId, 'train');
    assert.equal(d.getElementById('workshop-error').hidden, true);
    assert.equal(f.calls.filter((x) => x.p === 'runs').length, 1);
    c.dispose();
    c = await open();
    await f.tick();
    await c.refresh();
    const writes = f.calls.filter((x) => x.p === 'runs');
    assert.equal(writes.length, 2);
    assert.equal(writes[1].b.training.originmanWorkshop.sourceRunId, 'train');
    assert.equal(f.state.stage, 'results');
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
    assert.match(d.getElementById('recipe-confirm-text').textContent, /500,000/);
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

test('a disk failure in evaluation explains the block and preserves the trained policy', async () => {
  const f = fixture({ diskFull: true }),
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
    assert.match(d.getElementById('execution-status').textContent, /磁盘空间不足.*本次训练已保留/);
    assert.equal(d.getElementById('workshop-recovery').hidden, false);
    assert.match(d.getElementById('workshop-recovery-status').textContent, /eval.*已保留/);
    assert.equal(d.getElementById('workshop-recovery-new').hidden, true);
    assert.match(d.getElementById('go-results').textContent, /查看保留的训练结果/);
    d.getElementById('refresh-original-workshop').click();
    await settle();
    assert.equal(f.state.training.runId, 'train');
    assert.equal(f.calls.filter((x) => x.p === 'runs').length, 2);
    assert.equal(d.getElementById('result-section').hidden, false);
  } finally {
    c.dispose();
    f.dom.window.close();
  }
});

test('pause survives page reopen; explicit continue evaluates the original training once', async () => {
  const f = fixture(),
    d = f.dom.window.document;
  const open = () =>
    startWorkshop({
      document: d,
      location: f.dom.window.location,
      fetchImpl: f.fetchImpl,
      setTimer: f.setTimer,
      clearTimer: f.clearTimer,
    });
  let c = await open();
  try {
    d.getElementById('skip-reference').click();
    await settle();
    d.getElementById('start-quick').click();
    await settle();
    d.getElementById('pause-workshop').click();
    await settle();
    await c.refresh();
    assert.equal(f.state.stage, 'ready-evaluate');
    assert.equal(f.calls.filter((x) => x.p === 'runs').length, 1);
    c.dispose();
    c = await open();
    assert.equal(f.calls.filter((x) => x.p === 'runs').length, 1);
    assert.equal(d.getElementById('continue-evaluation').hidden, false);
    d.getElementById('continue-evaluation').click();
    await settle();
    const writes = f.calls.filter((x) => x.p === 'runs');
    assert.equal(writes.length, 2);
    assert.equal(writes[1].b.training.originmanWorkshop.sourceRunId, 'train');
  } finally {
    c.dispose();
    f.dom.window.close();
  }
});

test('interactive simulator stays reachable after results and opens inside the host tab', async () => {
  const f = fixture();
  f.state.stage = 'results';
  f.state.training = { runId: 'train', status: 'completed' };
  f.state.evaluation = { runId: 'eval', status: 'completed' };
  const d = f.dom.window.document;
  const c = await startWorkshop({
    document: d,
    location: f.dom.window.location,
    fetchImpl: f.fetchImpl,
    setTimer: f.setTimer,
    clearTimer: f.clearTimer,
  });
  try {
    assert.equal(d.getElementById('reference-section').hidden, true);
    const entry = d.getElementById('open-interactive-simulation');
    assert.ok(entry, 'a permanent simulator entry is required outside the reference step');
    assert.equal(entry.closest('[hidden]'), null);
    assert.equal(entry.target, '');
    assert.equal(entry.href, 'https://platform.test/course/?robot=originman#simulate');
    assert.equal(
      f.calls.some((x) => x.p === 'runs'),
      false,
    );
    const referenceEntry = d.getElementById('open-simulation');
    assert.equal(referenceEntry.target, '');
    assert.equal(referenceEntry.href, entry.href);
  } finally {
    c.dispose();
    f.dom.window.close();
  }
});

test('completed experiment starts an independent parameter draft with the prior recipe', async (t) => {
  const f = fixture({ comparison: true });
  const d = f.dom.window.document;
  const $ = (id) => d.getElementById(id);
  const c = await startWorkshop({
    document: d,
    location: f.dom.window.location,
    fetchImpl: f.fetchImpl,
    setTimer: f.setTimer,
    clearTimer: f.clearTimer,
  });
  t.after(() => {
    c.dispose();
    f.dom.window.close();
  });
  assert.equal($('compare-parameters').hidden, false);
  assert.match($('go-recovery-counts').href, /context=ws-test#comparison-heading$/);
  assert.match($('go-replay').href, /context=ws-test#replay-heading$/);
  assert.equal($('workshop-primary').textContent, '查看本轮结果');
  assert.equal($('execution-section').hidden, true);
  $('workshop-step-execution').click();
  assert.equal($('execution-section').hidden, false);
  $('workshop-step-result').click();
  assert.equal($('execution-section').hidden, true);
  $('workshop-primary').click();
  assert.equal(d.activeElement.id, 'result-section');
  $('compare-parameters').click();
  await settle();
  assert.equal($('budget-section').hidden, false);
  assert.equal($('custom-recipe').open, true);
  assert.equal($('workshop-primary').textContent, '选择要改的参数');
  $('workshop-primary').click();
  assert.equal(d.activeElement.id, 'budget-section');
  assert.equal($('budget-presets').hidden, true);
  assert.equal($('comparison-presets').hidden, false);
  assert.deepEqual(
    ['custom-timesteps', 'custom-seed', 'custom-push'].map((id) => $(id).value),
    ['16384', '11', '7.5'],
  );
  assert.match($('comparison-base-link').href, /experiment.html\?context=ws-test$/);
  assert.equal(
    f.calls.some(({ p }) => p.includes('/claim/') || p === 'runs'),
    false,
  );
  $('compare-formal-budget').click();
  assert.match(
    $('recipe-confirm-text').textContent,
    /训练步数 16,384 → 500,000.*随机种子 11.*7.5 N/,
  );
  $('cancel-recipe').click();
  $('compare-double-steps').click();
  assert.match(
    $('recipe-confirm-text').textContent,
    /训练步数 16,384 → 32,768.*随机种子 11.*7.5 N/,
  );
  assert.equal(d.activeElement.id, 'recipe-confirm');
  assert.equal(
    f.calls.some(({ p }) => p.includes('/claim/')),
    false,
  );
  $('confirm-recipe').click();
  await settle();
  assert.deepEqual(
    f.calls.find(({ p }) => p === 'workshop-sessions/ws-comparison/claim/train')?.b,
    { timesteps: 32768, seed: 11, pushMaxForce: 7.5, reference: 'skipped' },
  );
  assert.equal(f.original.recipe.timesteps, 16384);
});

test('selecting two historical rounds shows parameter changes and signed deltas', async (t) => {
  const f = fixture({ comparison: true });
  const d = f.dom.window.document;
  const $ = (id) => d.getElementById(id);
  const c = await startWorkshop({
    document: d,
    location: f.dom.window.location,
    fetchImpl: f.fetchImpl,
    setTimer: f.setTimer,
    clearTimer: f.clearTimer,
  });
  t.after(() => {
    c.dispose();
    f.dom.window.close();
  });
  $('choose-rounds').click();
  await settle();
  $('round-one').value = 'ws-older';
  $('round-two').value = 'ws-middle';
  $('apply-rounds').click();
  await settle();
  assert.equal($('round-comparison-table').hidden, false);
  assert.equal(
    $('round-comparison-summary').textContent,
    '本轮比上一轮：公开组 多恢复 25 次，补充组 多恢复 22 次。',
  );
  assert.match(
    $('round-comparison-rows').textContent,
    /16,384 → 500,000.*27\/31（\+25）.*25\/31（\+22）/,
  );
  assert.equal(
    f.calls.some(({ p }) => p.includes('/claim/') || p === 'runs'),
    false,
  );
});

test('expired login gives one sign-in action and restores the same experiment without submitting training', async (t) => {
  const f = fixture();
  const d = f.dom.window.document;
  const $ = (id) => d.getElementById(id);
  let signedIn = false;
  const c = await startWorkshop({
    document: d,
    location: f.dom.window.location,
    fetchImpl: (url, options) =>
      signedIn ? f.fetchImpl(url, options) : Promise.resolve({ status: 401, ok: false }),
    setTimer: f.setTimer,
    clearTimer: f.clearTimer,
  });
  t.after(() => {
    c.dispose();
    f.dom.window.close();
  });
  assert.equal($('workshop-primary').textContent, '去登录');
  assert.equal($('workshop-login').hidden, false);
  assert.equal($('workshop-retry').textContent, '登录后接续原实验');
  signedIn = true;
  $('workshop-retry').click();
  await settle();
  assert.equal($('workshop-error').hidden, true);
  assert.equal($('workshop-primary').textContent, '看参考或跳过');
  assert.ok(f.calls.some(({ p }) => p === 'workshop-sessions/ws-test/select'));
  assert.ok(f.calls.every(({ p }) => !p.includes('/claim/') && p !== 'runs'));
});

test('network recovery reads the same experiment without submitting again', async (t) => {
  const f = fixture();
  const d = f.dom.window.document;
  let connected = false;
  const c = await startWorkshop({
    document: d,
    location: f.dom.window.location,
    fetchImpl: (url, options) =>
      connected ? f.fetchImpl(url, options) : Promise.reject(new TypeError('offline')),
    setTimer: f.setTimer,
    clearTimer: f.clearTimer,
  });
  t.after(() => {
    c.dispose();
    f.dom.window.close();
  });
  assert.equal(d.getElementById('workshop-current-title').textContent, '连接暂时中断');
  connected = true;
  f.dom.window.dispatchEvent(new f.dom.window.Event('online'));
  await settle();
  assert.equal(d.getElementById('workshop-error').hidden, true);
  assert.ok(f.calls.some(({ p }) => p === 'workshop-sessions/ws-test'));
  assert.ok(f.calls.every(({ p }) => !p.includes('/claim/') && p !== 'runs'));
});

test('preview stays offline until Start and login opens in the same tab', async (t) => {
  const dom = new JSDOM(html, { url: 'https://platform.test/course/workshop.html?start=1' });
  const calls = [];
  const controller = await startWorkshop({
    document: dom.window.document,
    location: dom.window.location,
    fetchImpl: async (url) => {
      calls.push(new URL(url).pathname);
      return { status: 401 };
    },
  });
  t.after(() => {
    controller.dispose();
    dom.window.close();
  });
  const $ = (id) => dom.window.document.getElementById(id);
  assert.equal($('workshop-primary').textContent, '开始实操');
  assert.equal($('workshop-step-execution').dataset.state, 'waiting');
  assert.equal($('reference-section').hidden, false);
  assert.equal($('open-run-details').target, '_blank');
  assert.match($('open-run-details').rel, /noopener/);
  assert.deepEqual(calls, []);
  $('workshop-primary').click();
  await settle();
  assert.equal($('workshop-primary').textContent, '登录学习平台');
  assert.equal($('workshop-login').href, 'https://platform.test/course/login?workshop=start');
  assert.equal($('workshop-login').target, '');
});

for (const outcome of ['ready', 'blocked', 'unverified', 'mismatched', 'offline']) {
  test(`worker setup ${outcome} keeps explicit selection and the observed reference`, async (t) => {
    const dom = new JSDOM(html, {
      url: 'https://platform.test/course/workshop.html?start=1&setup=1',
    });
    dom.window.sessionStorage.setItem('rdk-workshop:preview-observed', '1');
    const calls = [];
    const session = {
      contextId: 'ws-new',
      modelId: 'model',
      computeResourceId: 'worker',
      stage: 'ready',
      training: null,
      evaluation: null,
      reference: 'pending',
    };
    const controller = await startWorkshop({
      document: dom.window.document,
      location: dom.window.location,
      historyImpl: dom.window.history,
      fetchImpl: async (url, options) => {
        const route = new URL(url).pathname.split('/api/v1/duck/')[1];
        const body = options.body ? JSON.parse(options.body) : undefined;
        calls.push({ route, body });
        const ok = (data) => ({ ok: true, json: async () => ({ ok: true, ...data }) });
        if (route === 'workshop-sessions/setup' && !body)
          return ok({
            accountId: 'learner',
            resources: [{ id: 'worker', name: 'Course GPU', status: 'online' }],
          });
        if (route === 'compute-resources/worker/test')
          return ok({
            connected: outcome !== 'offline',
            computeResource: { status: outcome === 'offline' ? 'offline' : 'online' },
          });
        if (route === 'training/preflight') {
          assert.deepEqual(body, {
            computeResourceId: 'worker',
            taskId: 'originman-recovery',
            engine: 'originman-recovery',
          });
          if (outcome === 'unverified')
            return {
              status: 404,
              ok: false,
              json: async () => {
                throw Error('no endpoint');
              },
            };
          return ok({
            computeResourceId: outcome === 'mismatched' ? 'another-worker' : 'worker',
            report: {
              schemaVersion: 1,
              taskId: 'originman-recovery',
              engine: 'originman-recovery',
              trainingPerformed: false,
              readyForSmokeTraining: outcome === 'ready',
              checks: [
                {
                  id: 'training-device',
                  status: outcome === 'ready' ? 'passed' : 'blocked',
                  detail: '{"resolvedDevice":"cuda"}',
                },
              ],
            },
          });
        }
        if (route === 'workshop-sessions/setup' && body) {
          assert.deepEqual(body, { accountId: 'learner', computeResourceId: 'worker' });
          return ok({ session });
        }
        if (route.endsWith('/select')) return ok({ session });
        if (route.endsWith('/reference')) {
          assert.equal(body.reference, 'observed');
          return ok({ session: { ...session, reference: body.reference } });
        }
        throw Error('Unexpected call ' + route);
      },
    });
    t.after(() => {
      controller.dispose();
      dom.window.close();
    });
    const $ = (id) => dom.window.document.getElementById(id);
    assert.equal($('workshop-setup').hidden, false);
    assert.equal($('workshop-compute').value, '');
    assert.equal($('workshop-setup-confirm').disabled, true);
    $('workshop-compute').value = 'worker';
    $('workshop-compute').dispatchEvent(new dom.window.Event('change'));
    $('workshop-setup-confirm').click();
    await settle();
    const blockedMessage = {
      blocked: /CUDA 检查未通过/,
      mismatched: /无法与本次选机对应/,
      offline: /暂时连不上/,
    }[outcome];
    if (blockedMessage) {
      assert.match($('workshop-compute-check').textContent, blockedMessage);
      assert.equal($('workshop-setup').hidden, false);
      assert.equal($('workshop-compute').value, 'worker');
      assert.equal($('workshop-setup-confirm').textContent, '检查这台算力机并继续');
      assert.deepEqual(
        calls.map(({ route }) => route),
        [
          'workshop-sessions/setup',
          'compute-resources/worker/test',
          ...(outcome === 'offline' ? [] : ['training/preflight']),
        ],
      );
      return;
    }
    if (outcome === 'unverified') {
      assert.match($('workshop-compute-check').textContent, /无法核对课程环境/);
      assert.equal(calls.length, 3);
      $('workshop-setup-confirm').click();
      await settle();
    }
    assert.equal($('budget-section').hidden, false);
    assert.equal($('workshop-setup').hidden, true);
    assert.match(
      $('budget-readiness').textContent,
      outcome === 'ready' ? /检查通过/ : /课程环境未验证/,
    );
    assert.equal(dom.window.location.search, '?context=ws-new');
    assert.deepEqual(
      calls.map(({ route }) => route),
      [
        'workshop-sessions/setup',
        'compute-resources/worker/test',
        'training/preflight',
        'workshop-sessions/setup',
        'workshop-sessions/ws-new/select',
        'workshop-sessions/ws-new/reference',
      ],
    );
  });
}
