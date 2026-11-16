const runIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/;
const shaPattern = /^[a-f0-9]{64}$/;
const states = {
  passed: '已达标',
  waiting: '进行中',
  blocked: '已暂停',
  'budget-exhausted': '剩余预算不足',
};
const measures = {
  armAsymmetryRangeM: ['摆臂左右差幅', 0.09, 1000, ' mm'],
  alternatingArmFraction: ['左右交替命中率', 0.65, 100, '%'],
  armBeatCorrelation: ['摆臂与节拍相关性', 0.2, 1, ''],
  lateralTrackingFraction: ['换重心命中率', 0.62, 100, '%'],
  lateralRangeM: ['身体横移范围', 0.035, 1000, ' mm'],
  riseAndDipCorrelation: ['下蹲起身节拍相关性', 0.55, 1, ''],
  squatDescentM: ['下蹲深度', 0.024, 1000, ' mm'],
  squatAscentM: ['起身高度', 0.024, 1000, ' mm'],
  armSweepM: ['手臂前后范围', 0.06, 1000, ' mm'],
  holdStillFraction: ['定格稳定比例', 0.83, 100, '%'],
  meanHoldHandSpanM: ['定格平均手间距', 0.32, 1000, ' mm'],
};
const format = (value) => value.toLocaleString('zh-CN', { maximumFractionDigits: 4 });

function parseIteration(hash) {
  const raw = new URLSearchParams(hash.slice(1)).get('iteration');
  if (!raw || raw.length > 10000) throw Error('请从 Studio 对话打开本组迭代结果。');
  return validateIteration(JSON.parse(raw));
}

function validateIteration(value) {
  if (
    !Object.hasOwn(states, value.state) ||
    !Number.isSafeInteger(value.spentSteps) ||
    !Number.isSafeInteger(value.additionalSteps) ||
    value.spentSteps < 0 ||
    value.spentSteps > value.additionalSteps ||
    (value.remainingSteps !== undefined &&
      value.remainingSteps !== value.additionalSteps - value.spentSteps) ||
    !Array.isArray(value.rounds) ||
    (value.rounds.length === 0 && !['waiting', 'blocked'].includes(value.state)) ||
    value.rounds.length > 6 ||
    new Set(value.rounds.map((round) => round.runId)).size !== value.rounds.length ||
    value.rounds.some((round) => !runIdPattern.test(round.runId))
  )
    throw Error('本组迭代记录格式无效。');
  return value;
}

function add(parent, tag, value) {
  const element = parent.ownerDocument.createElement(tag);
  if (value) element.textContent = value;
  parent.append(element);
  return element;
}

function link(parent, label, url) {
  add(parent, 'a', label).href = url.href;
}

function showFailedMeasures(turn, evidence) {
  const list = add(turn, 'ul');
  for (const evaluation of evidence.evaluations ?? []) {
    for (const [index, section] of evaluation.sections.entries()) {
      if (section.passed !== false) continue;
      const row = add(list, 'li', `${evaluation.bpm} BPM · 第 ${index + 1} 段未通过`);
      const failed = Object.entries(section.measurements ?? {}).flatMap(([key, value]) => {
        if (key === 'holdPeakTiltDeg' && Number.isFinite(value) && value >= 9)
          return [`定格最大倾角 ${format(value)}°（门槛 < 9°）`];
        if (!Object.hasOwn(measures, key) || !Number.isFinite(value)) return [];
        const [label, limit, scale, unit] = measures[key];
        return value < limit
          ? [`${label} ${format(value * scale)}${unit}（门槛 ≥ ${format(limit * scale)}${unit}）`]
          : [];
      });
      if (failed.length) add(row, 'p', failed.join('、'));
    }
  }
}

async function renderRound(turn, snapshot, parent, location, fetchImpl) {
  const id = encodeURIComponent(snapshot.runId);
  add(turn, 'h2', typeof snapshot.change === 'string' ? snapshot.change.slice(0, 240) : '查看本轮');
  if (parent >= 0) add(turn, 'p', `以第 ${parent + 1} 轮为基线`);
  const status = add(turn, 'p', '正在核对本轮 Run');
  const endpoint = new URL(`./api/v1/duck/runs/${id}`, location.href);
  const detail = new URL('./run-detail.html', location.href);
  detail.searchParams.set('runId', snapshot.runId);
  try {
    const response = await fetchImpl(endpoint.href, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!response.ok) throw Error('当前登录无法读取本轮记录。');
    const { run } = await response.json();
    if (run?.id !== snapshot.runId || run.taskId !== 'originman-dance')
      throw Error('平台返回了另一条 Run。');
    const evidence = run.metrics?.originmanDance;
    const passed = snapshot.state === 'passed' ? true : snapshot.state === 'failed' ? false : null;
    const verified =
      run.status === 'completed' && passed !== null && passed === evidence?.qualityGatePassed;
    status.textContent = verified
      ? passed
        ? '仿真验收达标'
        : '仿真验收未达标'
      : run.status === 'failed'
        ? '训练执行失败'
        : run.status === 'running'
          ? '训练中'
          : run.status === 'queued'
            ? '等待算力'
            : '正在独立评测';
    if (Number.isSafeInteger(run.metrics?.trainingSteps))
      add(turn, 'p', `实际训练 ${format(run.metrics.trainingSteps)} 步`);
    else if (run.status === 'running') {
      const iteration = run.progress?.at(-1)?.iteration ?? run.checkpoint?.iteration;
      if (Number.isInteger(iteration) && Number.isInteger(run.training?.maxIterations)) {
        const progress = add(turn, 'progress');
        progress.setAttribute('aria-label', '本轮训练进度');
        progress.max = run.training.maxIterations;
        progress.value = iteration;
        add(turn, 'p', `训练迭代 ${iteration} / ${progress.max}`);
      }
    }
    if (passed === false && evidence?.qualityGatePassed === false)
      showFailedMeasures(turn, evidence);
    const actions = add(turn, 'p');
    if (
      snapshot.replay &&
      evidence?.video?.policySha256 === run.artifact?.sha256 &&
      shaPattern.test(evidence?.video?.sha256 ?? '') &&
      evidence.video.sourceReplaySha256 === evidence.replay?.sha256
    ) {
      const video = new URL(endpoint.href + '/dance-video');
      detail.searchParams.set('videoUrl', video.href);
      const playback = new URL(detail.href);
      playback.hash = 'replay-heading';
      link(actions, '查看本轮回放', playback);
      add(actions, 'span', ' · ');
    }
    if (
      snapshot.policy &&
      run.artifact?.format === 'onnx' &&
      shaPattern.test(run.artifact.sha256)
    ) {
      link(actions, '下载策略（ONNX）', new URL(endpoint.href + '/artifact'));
      add(actions, 'span', ' · ');
    }
    link(actions, '查看本轮详情', detail);
    return verified ? passed : null;
  } catch (error) {
    status.textContent = error.message;
    link(turn, '打开本轮详情核对', detail);
  }
}

async function renderIterationPage({ document, location, fetchImpl, value }) {
  const status = document.getElementById('iteration-status');
  const rounds = document.getElementById('iteration-rounds');
  const compute = document.getElementById('iteration-compute');
  if (value.accelerator && Number.isInteger(value.numEnvs))
    compute.textContent =
      String(value.accelerator).slice(0, 80) + ' · ' + value.numEnvs + ' 并行环境';
  document.getElementById('iteration-budget').textContent =
    `已计入 ${format(value.spentSteps)} 步 · 剩余 ${format(value.additionalSteps - value.spentSteps)} 步 · 总预算 ${format(value.additionalSteps)} 步`;
  const goal = document.getElementById('iteration-goal');
  if (goal && typeof value.goal?.title === 'string')
    goal.textContent = value.goal.title.slice(0, 80) + ' · ' + value.goal.bpm + ' BPM';
  const batch = document.createDocumentFragment();
  const verified = await Promise.all(
    value.rounds.map((snapshot) =>
      renderRound(
        add(batch, 'li'),
        snapshot,
        value.rounds.findIndex((round) => round.runId === snapshot.parentRunId),
        location,
        fetchImpl,
      ),
    ),
  );
  // Keep existing controls and keyboard focus while a poll returns the same round snapshot.
  const signature = JSON.stringify([value.rounds, batch.textContent]);
  if (rounds.dataset.snapshot !== signature) {
    rounds.replaceChildren(batch);
    rounds.dataset.snapshot = signature;
  }
  const statusText =
    value.state === 'passed' && verified.at(-1) !== true
      ? '待核对最终 Run 的评测记录。'
      : value.state === 'budget-exhausted'
        ? String(value.reason ?? states[value.state]).slice(0, 340)
        : states[value.state] + '。' + String(value.reason ?? '').slice(0, 340);
  if (status.textContent !== statusText) status.textContent = statusText;
  const best = document.getElementById('iteration-best');
  const bestIndex = value.rounds.findIndex((round) => round.runId === value.bestRunId);
  if (typeof verified[bestIndex] === 'boolean' && best.dataset.runId !== value.bestRunId) {
    const detail = new URL('./run-detail.html', location.href);
    detail.searchParams.set('runId', value.bestRunId);
    best.replaceChildren();
    best.dataset.runId = value.bestRunId;
    link(best, '打开当前最佳 Run', detail);
  }
}

async function liveIteration(location, fetchImpl) {
  const id = new URL(location.href).searchParams.get('goal');
  if (id && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$/.test(id))
    throw Error('实验标识无效。');
  const endpoint = new URL('./api/v1/duck/dance-goals' + (id ? '/' + encodeURIComponent(id) : ''), location.href);
  const response = await fetchImpl(endpoint.href, { credentials: 'same-origin', cache: 'no-store' });
  if (response.status === 401 || response.status === 403) throw Error('请用发起该实验的账号登录。');
  if (!response.ok) throw Error('暂时无法读取原实验，正在重连。');
  const payload = await response.json();
  const value = id ? payload.goal : payload.goals?.find((goal) => goal.state === 'waiting') ?? payload.goals?.[0];
  if (!value) throw Error('当前账号还没有后台仿真实验。');
  if (id && value.id !== id) throw Error('平台未确认原实验。');
  return validateIteration(value);
}

export async function showDanceIterations({ document, location, fetchImpl = fetch }) {
  const status = document.getElementById('iteration-status');
  status.textContent = '正在读取本组 Run';
  try {
    const live = !new URLSearchParams(location.hash.slice(1)).has('iteration');
    const value = live ? await liveIteration(location, fetchImpl) : parseIteration(location.hash);
    await renderIterationPage({ document, location, fetchImpl, value });
    return live && value.state === 'waiting';
  } catch (error) {
    status.textContent = error.message;
    return /正在重连|Failed to fetch/.test(error.message);
  }
}

if (typeof window !== 'undefined') {
  document.querySelector('.skip-link').addEventListener('click', (event) => {
    event.preventDefault();
    document.getElementById('iteration-main').focus();
  });
  let generation = 0;
  let timer;
  const start = () => {
    const generationAtStart = ++generation;
    clearTimeout(timer);
    const poll = async (initial = false) => {
      if (generationAtStart !== generation) return;
      let retry;
      if (initial) retry = await showDanceIterations({ document, location });
      else {
        try {
          const value = await liveIteration(location, fetch);
          if (generationAtStart !== generation) return;
          await renderIterationPage({ document, location, fetchImpl: fetch, value });
          retry = value.state === 'waiting';
        } catch (error) {
          document.getElementById('iteration-status').textContent = error.message;
          retry = /正在重连|Failed to fetch/.test(error.message);
        }
      }
      if (retry && generationAtStart === generation) timer = setTimeout(poll, 2500);
    };
    void poll(true);
  };
  window.addEventListener('hashchange', start);
  window.addEventListener('pagehide', () => { ++generation; clearTimeout(timer); });
  start();
}
