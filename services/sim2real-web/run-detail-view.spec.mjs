import { showWorkshopEntry } from './public/workshop-entry-page.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { ORIGINMAN_DANCE_SECTION_TYPES } from '../../shared/originman-dance-training.ts';
import { startRunDetail } from './public/run-detail-page.mjs';

const markup = fs.readFileSync(new URL('./public/run-detail.html', import.meta.url), 'utf8');
const digest = (char) => char.repeat(64);

function fixture(url = 'https://platform.test/robotics-learning/run-detail.html?runId=run_42') {
  const dom = new JSDOM(markup, { url });
  dom.window.HTMLMediaElement.prototype.pause = () => {};
  dom.window.HTMLMediaElement.prototype.load = () => {};
  return {
    dom,
    document: dom.window.document,
    location: dom.window.location,
    close: () => dom.window.close(),
  };
}

test('dance Run detail selects the exact account-scoped record and visualizes its own evidence', async (t) => {
  const f = fixture();
  t.after(f.close);
  const policy = digest('a');
  const replay = digest('b');
  const requests = [];
  let independentSaved = false;
  const run = {
    id: 'run_42',
    modelId: 'dance-model',
    taskId: 'originman-dance',
    status: 'completed',
    mock: false,
    backend: 'local',
    externalRunId: 'worker-run_42',
    summary: '欢快四段舞',
    createdAt: '2026-11-09T08:00:00.000Z',
    finishedAt: '2026-11-09T08:10:00.000Z',
    training: {
      algorithm: 'ppo',
      engine: 'originman-dance-ppo',
      numEnvs: 8,
      maxIterations: 245,
      originmanDance: {
        title: '欢快版',
        bpm: 128,
        sections: [
          { type: 'alternating-arms', beats: 8, intensity: 0.85 },
          { type: 'weight-shift', beats: 8, intensity: 0.85 },
        ],
      },
    },
    progress: [
      { iteration: 1, meanReward: -1.5 },
      { iteration: 2, meanReward: 0.75 },
    ],
    metrics: {
      originmanDance: {
        qualityGatePassed: false,
        policySelection: 'ppo',
        referenceGuided: true,
        evaluations: [
          {
            bpm: 128,
            sections: [
              { type: 'alternating-arms', passed: false, clean: true, stylePassed: false },
              {
                type: 'weight-shift',
                passed: true,
                measurements: { lateralTrackingFraction: 0.63 },
              },
              {
                type: 'side-tap',
                passed: false,
                measurements: { squatDescentM: 0.031, squatAscentM: 0.01653 },
              },
            ],
          },
        ],
        replay: { sha256: replay },
        video: {
          file: 'dance-replay.mp4',
          sha256: digest('c'),
          policySha256: policy,
          sourceReplaySha256: replay,
        },
      },
    },
    links: {
      danceVideo: 'https://platform.test/robotics-learning/api/v1/duck/runs/run_42/dance-video',
    },
    artifact: { sha256: policy, format: 'onnx', deployable: false },
  };
  const page = await startRunDetail({
    document: f.document,
    location: f.location,
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      if (String(url).endsWith('/dance-evaluation')) {
        if (options.method === 'GET' && !independentSaved)
          return Response.json({ ok: false, code: 'DANCE_EVIDENCE_INCOMPLETE' }, { status: 404 });
        independentSaved = options.method === 'POST' || independentSaved;
        return Response.json({
          ok: true,
          evaluation: {
            source: { runId: run.id, policySha256: policy, sceneSha256: digest('d') },
            qualityGatePassed: false,
            evaluations: [{ bpm: 128, sections: [{ passed: false }, { passed: true }] }],
            replay: { videoSha256: digest('e') },
          },
        });
      }
      return Response.json({ ok: true, run });
    },
  });

  assert.equal(page.runId, 'run_42');
  assert.match(f.document.getElementById('quality-body').textContent, /参考动作控制器加 PPO 修正/);
  assert.deepEqual(
    Array.from(f.document.querySelectorAll('#dance-reference-links a'), (link) => [
      link.getAttribute('href'),
      link.textContent,
    ]),
    [
      ['./originman-dance-references/index.html#alternating-arms', '交替摆臂'],
      ['./originman-dance-references/index.html#side-tap', '侧点步收回'],
    ],
  );
  assert.match(requests[0].url, /\/api\/v1\/duck\/runs\/run_42$/);
  assert.equal(requests[0].options.credentials, 'same-origin');
  const reviewRequests = () =>
    requests.filter(({ url }) => url.endsWith('/runs/run_42/dance-evaluation'));
  assert.deepEqual(
    reviewRequests().map(({ options }) => options.method),
    ['GET'],
  );
  await new Promise(setImmediate);
  const reviewStatus = f.document.getElementById('independent-review-status');
  assert.match(reviewStatus.textContent, /验收证据待补齐/);
  f.document.getElementById('independent-review-start').click();
  await new Promise(setImmediate);
  assert.deepEqual(
    reviewRequests().map(({ options }) => options.method),
    ['GET', 'POST'],
  );
  assert.match(reviewStatus.textContent, /独立评测未达标，标称节拍 1\/2 段达标/);
  assert.equal(f.document.getElementById('independent-review-video').hidden, false);
  assert.equal(f.document.getElementById('run-title').textContent, 'OriginMan · 本次舞蹈训练');
  assert.equal(f.document.getElementById('run-status').textContent, '已完成');
  const download = f.document.getElementById('run-policy-download');
  assert.equal(download.hidden, false);
  assert.equal(
    download.href,
    'https://platform.test/robotics-learning/api/sim2real/runs/run_42/artifact',
  );
  assert.equal(f.document.getElementById('dance-title').textContent, '欢快版');
  assert.match(f.document.getElementById('dance-meta').textContent, /128 BPM · 16 拍 · 2 段/);
  assert.equal(f.document.querySelectorAll('#dance-sections tr').length, 2);
  assert.equal(f.document.getElementById('quality-status').textContent, '风格门未通过');
  const qualityRows = f.document.querySelectorAll('#quality-body tr');
  assert.match(qualityRows[0].textContent, /完整完成 · 风格未达标/);
  assert.match(qualityRows[1].textContent, /达标.*换重心方向命中率：63%/);
  assert.match(qualityRows[2].textContent, /下蹲行程：31 mm.*起身行程：16.53 mm/);
  assert.equal(f.document.getElementById('reward-chart').hasAttribute('hidden'), false);
  assert.equal(f.document.getElementById('run-video').hidden, false);
  assert.match(
    f.document.getElementById('run-next-action').textContent,
    /可以播放已核验的本次仿真回放/,
  );
  assert.match(
    f.document.getElementById('run-video').getAttribute('src'),
    /\/api\/v1\/duck\/runs\/run_42\/dance-video$/,
  );
  assert.equal(f.document.getElementById('run-video').hasAttribute('autoplay'), false);
  const video = f.document.getElementById('run-video');
  let sourceWrites = 0;
  const sourceChanges = new f.dom.window.MutationObserver((records) => {
    sourceWrites += records.length;
  });
  sourceChanges.observe(video, { attributes: true, attributeFilter: ['src'] });
  t.after(() => sourceChanges.disconnect());
  Object.defineProperty(video, 'paused', { value: false });
  video.dispatchEvent(new f.dom.window.Event('playing'));
  assert.equal(f.document.getElementById('replay-status').textContent, '正在播放本次仿真回放');
  Object.defineProperty(video, 'ended', { value: true });
  video.dispatchEvent(new f.dom.window.Event('ended'));
  f.document.getElementById('refresh-run').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.filter(({ url }) => url.endsWith('/runs/run_42')).length, 2);
  assert.deepEqual(
    reviewRequests().map(({ options }) => options.method),
    ['GET', 'POST', 'GET'],
  );
  assert.equal(sourceWrites + sourceChanges.takeRecords().length, 0);
  assert.equal(f.document.getElementById('replay-status').textContent, '本次仿真回放已播完');
  Object.defineProperty(video, 'error', { value: { code: 4 } });
  video.dispatchEvent(new f.dom.window.Event('error'));
  assert.match(
    f.document.getElementById('replay-status').textContent,
    /暂时无法加载回放.*检查原训练资源/,
  );
  page.dispose();
});

test('unverified dance video is never attached to the player', async (t) => {
  const f = fixture();
  t.after(f.close);
  const run = {
    id: 'run_42',
    modelId: 'dance-model',
    taskId: 'originman-dance',
    status: 'completed',
    training: { originmanDance: { title: '单段摆臂', bpm: 100, sections: [] } },
    metrics: {
      originmanDance: {
        qualityGatePassed: false,
        replay: { sha256: digest('b') },
        video: { file: 'dance-replay.mp4', sha256: digest('c') },
      },
    },
    artifact: { sha256: digest('a') },
  };
  const page = await startRunDetail({
    document: f.document,
    location: f.location,
    fetchImpl: async () => Response.json({ run }),
  });
  const video = f.document.getElementById('run-video');
  assert.equal(video.hidden, true);
  assert.equal(video.hasAttribute('src'), false);
  assert.match(f.document.getElementById('replay-empty').textContent, /策略或轨迹摘要不匹配/);
  page.dispose();
});

test('a verified video digest without a platform media URL does not create a request path', async (t) => {
  const f = fixture();
  t.after(f.close);
  const policy = digest('a');
  const replay = digest('b');
  const run = {
    id: 'run_42',
    modelId: 'dance-model',
    taskId: 'originman-dance',
    status: 'completed',
    training: { originmanDance: { title: '单段摆臂', bpm: 100, sections: [] } },
    metrics: {
      originmanDance: {
        qualityGatePassed: false,
        replay: { sha256: replay },
        video: {
          file: 'dance-replay.mp4',
          sha256: digest('c'),
          policySha256: policy,
          sourceReplaySha256: replay,
        },
      },
    },
    artifact: { sha256: policy },
  };
  const page = await startRunDetail({
    document: f.document,
    location: f.location,
    fetchImpl: async () => Response.json({ run }),
  });
  const video = f.document.getElementById('run-video');
  assert.equal(video.hidden, true);
  assert.equal(video.hasAttribute('src'), false);
  assert.match(f.document.getElementById('replay-status').textContent, /未提供本次视频链接/);
  assert.match(f.document.getElementById('run-next-action').textContent, /没有提供可核验且可播放/);
  page.dispose();
});

test('invalid, missing, and inaccessible Run IDs do not fall back to another record', async (t) => {
  const invalid = fixture(
    'https://platform.test/robotics-learning/run-detail.html?runId=../latest',
  );
  t.after(invalid.close);
  let calls = 0;
  const rejected = await startRunDetail({
    document: invalid.document,
    location: invalid.location,
    fetchImpl: async () => {
      calls++;
      throw new Error('must not fetch');
    },
  });
  assert.equal(calls, 0);
  assert.match(invalid.document.getElementById('run-error').textContent, /有效的 Run ID/);
  rejected.dispose();

  const inaccessible = fixture();
  t.after(inaccessible.close);
  const page = await startRunDetail({
    document: inaccessible.document,
    location: inaccessible.location,
    fetchImpl: async () => new Response('{}', { status: 404 }),
  });
  assert.match(inaccessible.document.getElementById('run-error').textContent, /当前账号无权查看/);
  assert.equal(inaccessible.document.getElementById('run-title').textContent, '本次运行');
  page.dispose();
});

test('copying a dance Run prepares its exact parameters without submitting or saving', async (t) => {
  const runId = '693b5e1a-dfb4-41c1-b3f6-327c0e60caa0';
  const page = fixture('https://platform.test/robotics-learning/run-detail.html?runId=' + runId);
  t.after(page.close);
  const training = {
    profile: 'standard',
    algorithm: 'ppo',
    engine: 'originman-dance-ppo',
    numEnvs: 4,
    originmanDance: {
      schemaVersion: 1,
      title: '本轮舞蹈',
      bpm: 120,
      trainingSteps: 8192,
      seed: 7,
      sections: [{ type: 'side-tap', beats: 8, intensity: 0.25 }],
    },
  };
  const run = {
    id: runId,
    modelId: 'dance-model',
    taskId: 'originman-dance',
    status: 'completed',
    training,
  };
  await startRunDetail({
    document: page.document,
    location: page.location,
    fetchImpl: async () => new Response(JSON.stringify({ run })),
  });
  const link = page.document.getElementById('run-copy-config');
  assert.equal(link.hidden, false);
  assert.equal(new URL(link.href).searchParams.get('fromRun'), runId);
  assert.match(page.document.getElementById('run-hardware-readiness').textContent, /可部署制品/);
  const workspace = new JSDOM(
    fs.readFileSync(new URL('./public/index.html', import.meta.url), 'utf8'),
    { url: link.href, runScripts: 'outside-only' },
  );
  t.after(() => workspace.window.close());
  workspace.window.eval(
    fs.readFileSync(new URL('./public/training-plans.js', import.meta.url), 'utf8'),
  );
  const requests = [];
  const planner = workspace.window.TrainingPlans.mount({
    request: async (route, options) => {
      requests.push([route, options]);
      return { run };
    },
    readContext: () => ({ productId: 'originman' }),
    applyContext: (config) => assert.equal(config.modelId, run.modelId),
    refreshControls() {},
    onDraftChange() {},
    hasDanceContract: () => true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests, [['/sim2real/runs/' + runId, undefined]]);
  const actionSelect = workspace.window.document.querySelector('[data-dance-type]');
  assert.deepEqual(
    Array.from(actionSelect.options, (option) => option.value),
    ['', ...ORIGINMAN_DANCE_SECTION_TYPES],
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(planner.dance().sections)),
    training.originmanDance.sections,
  );
  assert.equal(planner.dance().bpm, 120);
  assert.equal(planner.dance().compositionMode, 'custom');
  assert.equal(planner.danceNumEnvs(), 4);
  assert.equal(
    workspace.window.document.getElementById('training-plan-save').textContent,
    '保存为新方案',
  );
});

test('preset and custom compositions keep independent drafts and can reorder all selected actions', (t) => {
  const workspace = new JSDOM(
    fs.readFileSync(new URL('./public/index.html', import.meta.url), 'utf8'),
    {
      url: 'https://platform.test/robotics-learning/?robot=originman#train/configure',
      runScripts: 'outside-only',
    },
  );
  t.after(() => workspace.window.close());
  workspace.window.eval(
    fs.readFileSync(new URL('./public/training-plans.js', import.meta.url), 'utf8'),
  );
  const planner = workspace.window.TrainingPlans.mount({
    request: async () => ({ plans: [] }),
    readContext: () => ({ productId: 'originman' }),
    refreshControls() {},
    onDraftChange() {},
  });
  const { document, Event } = workspace.window;
  const input = (element, value) => {
    element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const mode = document.getElementById('originman-training-goal');
  const preset = document.getElementById('originman-dance-preset');
  const title = document.getElementById('originman-dance-title');
  const add = document.getElementById('originman-dance-add');
  const rows = document.getElementById('originman-dance-sections');
  input(preset, 'rhythm-and-pose');
  assert.equal(planner.dance().compositionMode, 'preset');
  assert.equal(planner.dance().sections.length, 4);
  input(mode, 'originman-dance-custom');
  assert.equal(title.value, '');
  assert.equal(rows.childElementCount, 0);
  assert.equal(planner.dance(), null);
  input(title, '自编开场');
  add.click();
  assert.equal(planner.dance(), null);
  input(rows.lastElementChild.querySelector('[data-dance-type]'), 'single-arm-wave');
  add.click();
  input(rows.lastElementChild.querySelector('[data-dance-type]'), 'side-tap');
  rows.lastElementChild.querySelector('[data-dance-up]').click();
  assert.deepEqual(
    Array.from(planner.dance().sections, ({ type }) => type),
    ['side-tap', 'single-arm-wave'],
  );
  input(mode, 'originman-dance');
  assert.equal(planner.dance().sections.length, 4);
  input(mode, 'originman-dance-custom');
  assert.equal(planner.dance().title, '自编开场');
  assert.equal(planner.dance().compositionMode, 'custom');
  for (const row of Array.from(rows.children)) row.querySelector('[data-dance-remove]').click();
  assert.equal(planner.dance(), null);
});

test('dance reference page and replay assets cover every supported action', (t) => {
  const directory = new URL('./public/originman-dance-references/', import.meta.url);
  const catalog = JSON.parse(fs.readFileSync(new URL('catalog.json', directory), 'utf8'));
  assert.equal(catalog.simulationOnly, true);
  assert.deepEqual(
    catalog.references.map(({ type }) => type),
    ORIGINMAN_DANCE_SECTION_TYPES,
  );

  const pageUrl = 'https://platform.test/learning/originman-dance-references/index.html';
  const referencePage = new JSDOM(fs.readFileSync(new URL('index.html', directory), 'utf8'), {
    url: pageUrl,
  });
  t.after(() => referencePage.window.close());
  const document = referencePage.window.document;
  showWorkshopEntry(document, pageUrl + '?computeResourceId=worker-1');
  assert.match(document.querySelector('h1').textContent, /教学动作回放/);
  assert.deepEqual(
    [...document.querySelectorAll('[data-workshop-resource]')].map((link) => {
      const url = new URL(link.href);
      return [
        url.pathname,
        url.searchParams.get('mode'),
        url.searchParams.get('computeResourceId'),
      ];
    }),
    [
      ['/learning/workshop.html', null, 'worker-1'],
      ['/learning/originman-reference.html', 'preset', 'worker-1'],
      ['/learning/originman-reference.html', 'blocks', 'worker-1'],
    ],
  );
  for (const reference of catalog.references) {
    const section = referencePage.window.document.getElementById(reference.type);
    assert.equal(section.querySelector('video').getAttribute('src'), reference.video);
    assert.deepEqual(
      Array.from(section.querySelectorAll('a'), (link) => link.getAttribute('href')),
      [reference.policy, reference.verification],
    );
    for (const [file, sha256] of [
      [reference.policy, reference.policySha256],
      [reference.video, reference.videoSha256],
    ]) {
      const actual = createHash('sha256')
        .update(fs.readFileSync(new URL(file, directory)))
        .digest('hex');
      assert.equal(actual, sha256, file);
    }
    assert.doesNotThrow(() =>
      JSON.parse(fs.readFileSync(new URL(reference.verification, directory), 'utf8')),
    );
  }
});

test('dance Workshop links fill the requested draft without submitting or saving', async (t) => {
  for (const [preset, steps] of [
    ['quick', 8192],
    ['formal', 500000],
  ]) {
    const workspace = new JSDOM(
      fs.readFileSync(new URL('./public/index.html', import.meta.url), 'utf8'),
      {
        url: `https://platform.test/robotics-learning/?robot=originman&danceBudget=${preset}&computeResourceId=course-worker#train/configure`,
        runScripts: 'outside-only',
      },
    );
    t.after(() => workspace.window.close());
    workspace.window.eval(
      fs.readFileSync(new URL('./public/training-plans.js', import.meta.url), 'utf8'),
    );
    const selected = [];
    const planner = workspace.window.TrainingPlans.mount({
      request: async (route, options) => {
        assert.equal(options, undefined, 'opening a draft must only read');
        assert.equal(route, '/v1/duck/training-plans');
        return { plans: [] };
      },
      readContext: () => ({ productId: 'originman' }),
      applyContext() {},
      refreshControls() {},
      onDraftChange() {},
      selectWorkshopResource: (id) => {
        selected.push(id);
      },
      hasDanceContract: () => true,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(planner.dance().trainingSteps, steps);
    assert.equal(planner.danceNumEnvs(), 64);
    assert.equal(
      workspace.window.TrainingPlans.danceIterations(steps, 64),
      preset === 'quick' ? 2 : 123,
    );
    assert.deepEqual(selected, ['course-worker']);
  }
});

test('auto iteration confirms a claimed pass only after reading the exact final Run', async (t) => {
  const { showDanceIterations } = await import('./public/dance-iterations.mjs');
  const snapshot = {
    state: 'passed',
    reason: '已达到目标',
    spentSteps: 503808,
    additionalSteps: 503808,
    rounds: [{ runId: 'run-final', state: 'passed', change: '提高训练预算', policy: true }],
  };
  const url = new URL('https://platform.test/learning/dance-iterations.html');
  url.hash = new URLSearchParams({ iteration: JSON.stringify(snapshot) }).toString();
  const html = fs.readFileSync(new URL('./public/dance-iterations.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: url.href });
  t.after(() => dom.window.close());
  const { document, location } = dom.window;
  const load = (runId) =>
    showDanceIterations({
      document,
      location,
      fetchImpl: async (endpoint) => {
        assert.equal(endpoint, 'https://platform.test/learning/api/v1/duck/runs/run-final');
        return new Response(
          JSON.stringify({
            run: {
              id: runId,
              taskId: 'originman-dance',
              status: 'completed',
              artifact: { format: 'onnx', sha256: digest('a') },
              metrics: { trainingSteps: 503808, originmanDance: { qualityGatePassed: true } },
            },
          }),
        );
      },
    });
  await load('another-run');
  assert.match(document.querySelector('#iteration-status').textContent, /待核对/);
  assert.equal(document.querySelector('#iteration-rounds a[href$="/artifact"]'), null);
  await load('run-final');
  assert.match(document.querySelector('#iteration-status').textContent, /已达标/);
  assert.match(document.querySelector('#iteration-rounds').textContent, /提高训练预算.*503,808/s);
  assert.equal(
    document.querySelector('#iteration-rounds a[href$="/artifact"]').href,
    'https://platform.test/learning/api/v1/duck/runs/run-final/artifact',
  );
});

test('completed recovery Run shows the same receipt diagnosis as the plugin and retains log tails', async (t) => {
  const f = fixture();
  t.after(f.close);
  const run = {
    id: 'run_42',
    taskId: 'originman-recovery',
    status: 'completed',
    backend: 'local',
    mock: false,
    externalRunId: 'worker-run',
  };
  const page = await startRunDetail({
    document: f.document,
    location: f.location,
    fetchImpl: async (url) =>
      String(url).endsWith('/logs')
        ? Response.json({
            runId: run.id,
            lines: [],
            source: 'retained-tail',
            stdoutTail: 'original training finished',
          })
        : Response.json({ run, workshopEvidenceIssue: 'worker-unavailable' }),
  });
  t.after(() => page.dispose());
  const { workshopEvidenceMessage } =
    await import('../../plugins/rdk-robot-learning-platform/scripts/plugin-errors.mjs');
  assert.equal(f.document.getElementById('run-status').textContent, '已完成');
  assert.equal(
    f.document.getElementById('run-next-action').textContent,
    workshopEvidenceMessage('worker-unavailable'),
  );
  assert.equal(f.document.getElementById('run-logs').hidden, false);
  f.document.getElementById('run-logs-load').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    f.document.getElementById('run-logs-output').textContent,
    'original training finished',
  );
});

test('changing a Worker inside the dance editor preserves the selection until change is handled', async (t) => {
  const f = new JSDOM(fs.readFileSync(new URL('./public/index.html', import.meta.url), 'utf8'), {
    url: 'https://platform.test/learning/?robot=originman#train/configure',
    runScripts: 'outside-only',
  });
  t.after(() => f.window.close());
  f.window.eval(fs.readFileSync(new URL('./public/training-plans.js', import.meta.url), 'utf8'));
  const resource = f.window.document.getElementById('compute-resource-select');
  f.window.document.getElementById('originman-dance-resource').append(resource);
  resource.add(new f.window.Option('课堂共享 GPU', 'gpu'));
  let selected = '';
  resource.addEventListener('change', () => {
    selected = resource.value;
  });
  f.window.TrainingPlans.mount({
    request: async () => ({ plans: [] }),
    readContext: () => ({ productId: 'originman' }),
    applyContext() {},
    refreshControls() {},
    hasDanceContract: () => true,
    onDraftChange() {
      resource.value = selected;
    },
  });
  resource.value = 'gpu';
  resource.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  resource.dispatchEvent(new f.window.Event('change', { bubbles: true }));
  assert.equal(selected, 'gpu');
});

test('queued reference Run displays Worker evidence and offers a read-only check of compatible capacity', async (t) => {
  const template = fs.readFileSync(
    new URL('./public/originman-reference-run.html', import.meta.url),
    'utf8',
  );
  const dom = new JSDOM(template, {
    url: 'https://platform.test/robotics-learning/originman-reference-run.html?runId=run_waiting',
    pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const { document, location } = dom.window;
  dom.window.HTMLMediaElement.prototype.pause = () => {};
  dom.window.HTMLMediaElement.prototype.load = () => {};
  const now = Date.parse('2026-11-25T12:00:00Z');
  const original = {
    id: 'run_waiting',
    taskId: 'originman-reference-track',
    status: 'queued',
    computeResourceId: 'original-worker',
    backend: 'local',
    externalRunId: 'worker-job',
    createdAt: new Date(now - 180000).toISOString(),
  };
  const free = {
    id: 'free-worker',
    name: '课堂 GPU 2',
    source: 'server-runner',
    classroomShared: true,
    status: 'online',
    mock: false,
    engines: ['originman-reference-ppo'],
    lastCheckedAt: new Date(now).toISOString(),
    cuda: null,
    activeJobs: 1,
    maxConcurrentJobs: 2,
    queuedJobs: 0,
  };
  let poll;
  let attempts = 0;
  const requests = [];
  const page = await startRunDetail({
    document,
    location,
    now: () => now,
    setTimeoutImpl: (callback) => {
      poll = callback;
      return 1;
    },
    clearTimeoutImpl: () => {
      poll = undefined;
    },
    fetchImpl: async (url, init) => {
      const path = new URL(url).pathname;
      requests.push([path, init.method ?? 'GET']);
      if (path.endsWith('/compute-resources')) {
        return Response.json({
          ok: true,
          computeResources: [
            { ...free, id: 'original-worker', cuda: true },
            { ...free, id: 'backlogged-worker', cuda: true, queuedJobs: 1 },
            { ...free, id: 'incompatible-worker', cuda: true, engines: ['another-engine'] },
            { ...free, id: 'stale-worker', cuda: true, lastCheckedAt: original.createdAt },
            { ...free, id: 'cpu-worker', cuda: false, activeJobs: 0 },
            { ...free, id: 'unknown-private-worker', classroomShared: undefined, activeJobs: 0 },
            free,
          ],
        });
      }
      attempts += 1;
      if (attempts === 1)
        return Response.json({
          run: original,
          queue: {
            position: 2,
            queuedAt: new Date(now - 120000).toISOString(),
          },
        });
      if (attempts === 2) return Response.json({}, { status: 503 });
      return Response.json({ run: { ...original, status: 'running' } });
    },
  });
  t.after(() => page.dispose());

  const queue = document.getElementById('run-queue-panel');
  const status = document.getElementById('run-queue-status');
  const alternative = document.getElementById('run-queue-alternative');
  assert.equal(queue.hidden, false);
  assert.equal(status.textContent, '当前队列第 2 位 · 已等待 2 分钟');
  document.getElementById('run-queue-check-workers').click();
  await new Promise(setImmediate);
  assert.equal(alternative.hidden, false);
  assert.equal(new URL(alternative.href).searchParams.get('computeResourceId'), free.id);
  assert.equal(
    new URL(document.getElementById('run-workshop-home').href).searchParams.get(
      'computeResourceId',
    ),
    original.computeResourceId,
  );
  assert.match(document.getElementById('run-queue-worker-status').textContent, /确认已取消原 Run/);

  const nextPoll = async () => {
    assert.equal(typeof poll, 'function');
    const callback = poll;
    poll = undefined;
    callback();
    await new Promise(setImmediate);
  };
  await nextPoll();
  assert.equal(status.textContent, '暂未取得队列位置 · 提交至今 3 分钟');
  await nextPoll();
  assert.equal(queue.hidden, true);
  assert.equal(alternative.hasAttribute('href'), false);
  assert.deepEqual(requests, [
    ['/robotics-learning/api/v1/duck/runs/run_waiting', 'GET'],
    ['/robotics-learning/api/v1/duck/compute-resources', 'GET'],
    ['/robotics-learning/api/v1/duck/runs/run_waiting', 'GET'],
    ['/robotics-learning/api/v1/duck/runs/run_waiting', 'GET'],
  ]);
});

test('reference playback seeks only to evaluated sections and handles old and mismatched digests', async (t) => {
  const template = fs.readFileSync(
    new URL('./public/originman-reference-run.html', import.meta.url),
    'utf8',
  );
  const dom = new JSDOM(template, {
    url: 'https://platform.test/robotics-learning/originman-reference-run.html?runId=run_ref',
  });
  t.after(() => dom.window.close());
  dom.window.HTMLMediaElement.prototype.pause = () => {};
  dom.window.HTMLMediaElement.prototype.load = () => {};
  const { document, location } = dom.window;
  const source = 'originmanReference';
  const run = {
    id: 'run_ref',
    taskId: 'originman-reference-track',
    computeResourceId: 'workshop-worker',
    status: 'completed',
    backend: 'local',
    mock: false,
    externalRunId: 'worker-ref',
    training: {
      originmanReferenceSummary: { trajectorySha256: digest('d') },
      originmanReferenceComposition: {
        ranges: [
          { id: 'intro', from: 0, to: 50 },
          { id: 'arms', from: 60, to: 110 },
          { id: 'skipped', from: 120, to: 170 },
        ],
      },
    },
    artifact: { sha256: digest('a'), format: 'onnx' },
    metrics: {
      [source]: {
        qualityGatePassed: true,
        selectedCheckpointSteps: 32768,
        trainingFramesObserved: 162,
        framesExpected: 170,
        framesEvaluated: 105,
        trackingMaeRad: 0.02,
        trackingRmseRad: 0.03,
        zeroResidualRmseRad: 0.03,
        zeroResidualFramesEvaluated: 170,
        maxTiltDeg: 12,
        finalYawDeg: 2,
        referenceSha256: digest('e'),
        trajectorySha256: digest('d'),
        replay: { sha256: digest('b') },
        video: {
          file: 'dance-replay.mp4',
          sha256: digest('c'),
          policySha256: digest('a'),
          sourceReplaySha256: digest('b'),
          fps: 50,
        },
      },
    },
  };
  const open = () =>
    startRunDetail({
      document,
      location,
      fetchImpl: async () => Response.json({ ok: true, run }),
    });
  const initial = await open();
  const workshop = new URL(document.getElementById('run-workshop-home').href);
  assert.equal(workshop.pathname, '/robotics-learning/workshop.html');
  assert.equal(workshop.searchParams.get('computeResourceId'), 'workshop-worker');
  assert.match(document.getElementById('run-config-body').textContent, /回放与策略对应步数32,?768/);
  assert.equal(document.getElementById('completion-heading').textContent, '训练采样覆盖');
  assert.match(document.getElementById('completion-empty').textContent, /162 \/ 170 帧/);
  assert.equal(document.getElementById('completion-method').hidden, true);
  assert.equal(document.getElementById('completion-chart').hasAttribute('hidden'), true);
  const control = document.getElementById('replay-segment-controls');
  const select = document.getElementById('replay-segment');
  assert.equal(control.hidden, false);
  assert.equal(document.getElementById('run-policy-download').hidden, false);
  assert.equal(select.options.length, 2);
  select.value = '1.2';
  document.getElementById('replay-segment-seek').click();
  assert.equal(document.getElementById('run-video').currentTime, 1.2);
  assert.match(document.getElementById('run-trajectory-sha').textContent, /与 Worker 一致/);
  assert.match(document.getElementById('quality-body').textContent, /纯参考关节跟踪 RMSE/);
  assert.doesNotMatch(
    document.getElementById('quality-body').textContent,
    /相对纯参考的 RMSE 变化/,
  );
  initial.dispose();

  run.metrics[source].trajectorySha256 = digest('f');
  const mismatched = await open();
  assert.equal(control.hidden, true);
  assert.match(document.getElementById('replay-status').textContent, /摘要不一致/);
  assert.equal(document.getElementById('quality-status').textContent, '评测来源不一致');
  assert.equal(document.getElementById('quality-table').hidden, true);
  assert.equal(document.getElementById('reference-replay-retry').hidden, true);
  assert.equal(document.getElementById('run-policy-download').hidden, true);
  mismatched.dispose();

  delete run.metrics[source].trajectorySha256;
  delete run.training.originmanReferenceSummary.trajectorySha256;
  const historical = await open();
  assert.equal(document.getElementById('run-video').hidden, false);
  assert.equal(document.getElementById('run-reference-file-sha').textContent, digest('e'));
  historical.dispose();
});

test('reference Run discloses the delivered baseline and compares the evaluated PPO candidate', async (t) => {
  const template = fs.readFileSync(
    new URL('./public/originman-reference-run.html', import.meta.url),
    'utf8',
  );
  const dom = new JSDOM(template, {
    url: 'https://platform.test/robotics-learning/originman-reference-run.html?runId=run_ref',
  });
  t.after(() => dom.window.close());
  const { document, location } = dom.window;
  const run = {
    id: 'run_ref',
    taskId: 'originman-reference-track',
    status: 'completed',
    backend: 'local',
    mock: false,
    externalRunId: 'worker-ref',
    artifact: { format: 'onnx', sha256: digest('a') },
    training: { originmanReferenceSummary: { trajectorySha256: digest('d') } },
    metrics: {
      originmanReference: {
        policySelection: 'reference-baseline',
        qualityGatePassed: true,
        trackingRmseRad: 0.0145938,
        zeroResidualFramesEvaluated: 200,
        zeroResidualRmseRad: 0.0145938,
        ppoFramesEvaluated: 200,
        ppoTrackingRmseRad: 0.01478,
        ppoStabilityPassed: true,
        framesExpected: 200,
        framesEvaluated: 200,
        trajectorySha256: digest('d'),
        maxTiltDeg: 0.13,
      },
    },
  };
  const open = () =>
    startRunDetail({
      document,
      location,
      fetchImpl: async () => Response.json({ ok: true, run }),
    });
  const detail = await open();
  t.after(() => detail.dispose());
  const byId = (id) => document.getElementById(id);
  assert.equal(byId('quality-status').textContent, '交付策略通过');
  assert.match(byId('quality-summary').textContent, /纯参考基线/);
  assert.equal(byId('run-policy-download').textContent, '下载纯参考基线 ONNX');
  assert.match(byId('quality-body').textContent, /本轮 PPO 候选 RMSE0\.0148 rad · 200\/200 帧/);
  assert.match(byId('quality-body').textContent, /PPO 相对纯参考的 RMSE 变化\+1\.28%/);
  assert.doesNotMatch(byId('quality-body').textContent, /undefined|NaN/);
  assert.doesNotMatch(byId('run-next-action').textContent, /播放/);
  assert.equal(byId('run-error').hidden, true);
  detail.dispose();

  const evidence = run.metrics.originmanReference;
  evidence.referenceLeadFrames = 2;
  evidence.uncompensatedRmseRad = 0.0334;
  const compensated = await open();
  t.after(() => compensated.dispose());
  assert.equal(byId('run-policy-download').textContent, '下载参考基线（含延迟补偿） ONNX');
  assert.match(byId('quality-body').textContent, /提前 40 ms 发出参考指令/);
  assert.match(byId('quality-body').textContent, /补偿前的零残差 RMSE0\.0334 rad/);
  assert.match(byId('quality-body').textContent, /PPO 相对补偿后基线的 RMSE 变化\+1\.28%/);
});
