import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
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
  const run = {
    id: 'run_42',
    modelId: 'dance-model',
    taskId: 'originman-dance',
    status: 'completed',
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
                type: 'squat-rise',
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
      return Response.json({ ok: true, run });
    },
  });

  assert.equal(page.runId, 'run_42');
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/api\/v1\/duck\/runs\/run_42$/);
  assert.equal(requests[0].options.credentials, 'same-origin');
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
  assert.equal(requests.length, 2);
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
