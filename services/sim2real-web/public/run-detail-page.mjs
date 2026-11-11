const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const STATUS_LABELS = Object.freeze({
  ready: '已准备',
  queued: '排队中',
  running: '运行中',
  completed: '已完成',
  blocked: '已阻断',
  failed: '失败',
  cancelled: '已取消',
  canceled: '已取消',
});
const SECTION_LABELS = Object.freeze({
  'alternating-arms': '交替摆臂',
  'weight-shift': '左右换重心',
  'squat-rise': '下蹲起身',
  'open-pose': '展开定格',
});

const text = (document, id, value) => {
  const element = document.getElementById(id);
  if (element) element.textContent = value == null || value === '' ? '—' : String(value);
};

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function danceConfigFor(run) {
  return run.training?.originmanDance ?? run.originmanDance ?? run.metrics?.danceConfig ?? run.metrics?.originmanDance?.config ?? null;
}

function danceEvidenceFor(run) {
  return run.metrics?.originmanDance ?? null;
}

function metricRows(evidence) {
  if (Array.isArray(evidence?.evaluations)) {
    return evidence.evaluations.flatMap(({ bpm, sections }) =>
      (Array.isArray(sections) ? sections : []).map(({ type, passed, clean, stylePassed, measurements }, index) => {
        const statuses = [];
        if (typeof clean === 'boolean') statuses.push(clean ? '完整完成' : '未完整完成');
        if (typeof stylePassed === 'boolean') statuses.push(stylePassed ? '风格达标' : '风格未达标');
        if (!statuses.length) statuses.push(passed === true ? '达标' : passed === false ? '未达标' : '待核对');
        const values = Object.entries(measurements ?? {})
          .filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
          .map(([key, value]) => `${key}：${Number(value.toFixed(4))}`);
        return [
          `${typeof bpm === 'number' ? Number(bpm.toFixed(2)) : bpm} BPM · ${index + 1}. ${SECTION_LABELS[type] ?? type}`,
          [...statuses, ...values].join(' · '),
        ];
      }),
    );
  }
  const rows = evidence?.sections ?? evidence?.sectionMetrics ?? evidence?.segments;
  if (!Array.isArray(rows)) return [];
  return rows.map((row, index) => {
    const name = row?.title ?? row?.label ?? row?.type ?? row?.name ?? `第 ${index + 1} 段`;
    const values = Object.entries(row ?? {})
      .filter(([key, value]) => !['title', 'label', 'type', 'name', 'index'].includes(key) &&
        ['string', 'number', 'boolean'].includes(typeof value))
      .map(([key, value]) => `${key}：${typeof value === 'number' ? Number(value.toFixed(4)) : String(value)}`);
    return [String(name), values.join(' · ') || '平台未提供分段测量'];
  });
}

function drawCurve(document, run) {
  const svg = document.getElementById('reward-chart');
  const empty = document.getElementById('curve-empty');
  if (!svg || !empty) return;
  svg.replaceChildren();
  const raw = Array.isArray(run.progress) ? run.progress : [];
  const points = raw.map((point, index) => ({
    x: Number(point.iteration ?? point.step ?? point.trainingStep ?? index + 1),
    y: Number(point.meanReward ?? point.reward ?? point.mean_reward),
  })).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (!points.length) {
    svg.setAttribute('hidden', '');
    empty.hidden = false;
    text(document, 'curve-caption', '本次 Run 未返回曲线采样');
    return;
  }
  const namespace = 'http://www.w3.org/2000/svg';
  const xMin = Math.min(...points.map((point) => point.x));
  const xMax = Math.max(...points.map((point) => point.x));
  const yMin = Math.min(...points.map((point) => point.y));
  const yMax = Math.max(...points.map((point) => point.y));
  const xRange = xMax - xMin || 1;
  const yRange = yMax - yMin || 1;
  const coordinates = points.map((point) => {
    const x = 56 + ((point.x - xMin) / xRange) * 630;
    const y = 204 - ((point.y - yMin) / yRange) * 168;
    return `${x},${y}`;
  }).join(' ');
  const axis = document.createElementNS(namespace, 'path');
  axis.setAttribute('d', 'M56 24V204H686');
  axis.setAttribute('class', 'reward-axis');
  const line = document.createElementNS(namespace, 'polyline');
  line.setAttribute('points', coordinates);
  line.setAttribute('class', 'reward-line');
  const label = document.createElementNS(namespace, 'text');
  label.setAttribute('x', '60');
  label.setAttribute('y', '18');
  label.setAttribute('class', 'reward-label');
  label.textContent = `${points.length} 个本次采样点 · ${yMin.toFixed(3)} 至 ${yMax.toFixed(3)}`;
  svg.append(axis, line, label);
  svg.removeAttribute('hidden');
  empty.hidden = true;
  text(document, 'curve-caption', '仅显示本次 Run 上报的数据');
}

function renderDance(document, run) {
  const config = danceConfigFor(run);
  const evidence = danceEvidenceFor(run);
  const section = document.getElementById('dance-section');
  const isDance = run.taskId === 'originman-dance' || Boolean(config || evidence);
  if (!section) return;
  section.hidden = !isDance;
  if (!isDance) return;
  const danceTitle = config?.title ?? run.label ?? 'OriginMan · 强化学习舞蹈';
  text(document, 'dance-title', danceTitle);
  text(document, 'dance-meta', config
    ? `${config.bpm} BPM · ${config.sections?.reduce((sum, item) => sum + Number(item.beats || 0), 0) ?? 0} 拍 · ${config.sections?.length ?? 0} 段`
    : '本次舞蹈配置未随运行记录返回。');
  const body = document.getElementById('dance-sections');
  if (body) {
    body.replaceChildren();
    for (const [index, item] of (config?.sections ?? []).entries()) {
      const row = document.createElement('tr');
      for (const value of [
        String(index + 1),
        SECTION_LABELS[item.type] ?? item.type,
        `${item.beats ?? '—'} 拍`,
        item.intensity == null ? '—' : Number(item.intensity).toFixed(2),
      ]) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(cell);
      }
      body.append(row);
    }
  }
  text(document, 'run-kind', 'OriginMan · PPO 舞蹈仿真');
}

function renderQuality(document, run) {
  const evidence = danceEvidenceFor(run);
  const gate = evidence?.qualityGate;
  const passed = typeof evidence?.qualityGatePassed === 'boolean'
    ? evidence.qualityGatePassed
    : typeof gate?.passed === 'boolean'
      ? gate.passed
      : null;
  const isDance = run.taskId === 'originman-dance' || Boolean(evidence);
  text(document, 'quality-status', passed === true ? '风格门通过' : passed === false ? '风格门未通过' : '待核验');
  text(document, 'quality-summary', !isDance
    ? '该运行没有舞蹈专用质量门字段。'
    : passed === true
      ? '本次 Run 返回的舞蹈质量门已通过。'
      : passed === false
        ? '本次 Run 返回的舞蹈质量门未通过；训练完成不等于舞蹈达标。'
        : run.status === 'completed'
          ? '运行已结束，但没有可核验的舞蹈质量门结果。'
          : '运行终态后再读取本次舞蹈质量门结果。');
  const rows = metricRows(evidence);
  const table = document.getElementById('quality-table');
  const body = document.getElementById('quality-body');
  if (table && body) {
    body.replaceChildren();
    table.hidden = rows.length === 0;
    for (const [name, value] of rows) {
      const row = document.createElement('tr');
      const nameCell = document.createElement('td');
      const valueCell = document.createElement('td');
      nameCell.textContent = name;
      valueCell.textContent = value;
      row.append(nameCell, valueCell);
      body.append(row);
    }
  }
  text(document, 'run-step-quality', passed === true ? '质量门已通过' : passed === false ? '质量门未通过' : '质量证据待核验');
}

function verifiedDanceVideo(run) {
  const evidence = danceEvidenceFor(run);
  const video = evidence?.video;
  const policySha = run.artifact?.sha256;
  const replaySha = evidence?.replay?.sha256;
  return run.status === 'completed' && video?.file === 'dance-replay.mp4' &&
    SHA256_PATTERN.test(video.sha256 ?? '') && SHA256_PATTERN.test(policySha ?? '') &&
    video.policySha256 === policySha && SHA256_PATTERN.test(replaySha ?? '') &&
    video.sourceReplaySha256 === replaySha;
}

function danceVideoUrl(location, run, runId) {
  const candidate = run.links?.danceVideo ?? danceEvidenceFor(run)?.video?.url ??
    new URLSearchParams(location.search).get('videoUrl');
  if (typeof candidate !== 'string' || candidate.length > 2048) return null;
  try {
    const href = new URL(candidate, location.href);
    const expectedSuffix = `/api/v1/duck/runs/${encodeURIComponent(runId)}/dance-video`;
    if (
      !['http:', 'https:'].includes(href.protocol) ||
      href.origin !== location.origin ||
      href.username ||
      href.password ||
      href.search ||
      href.hash ||
      href.pathname !== new URL(`.${expectedSuffix}`, location.href).pathname
    ) return null;
    return href;
  } catch {
    return null;
  }
}

function showPlaybackStatus(document, video) {
  if (video.hidden) return;
  const message = video.error
    ? '视频加载失败，请确认平台登录后刷新'
    : video.ended
      ? '本次仿真回放已播完'
      : video.paused
        ? '本次视频摘要已核对 · 点击播放'
        : '正在播放本次仿真回放';
  text(document, 'replay-status', message);
}

function renderVideo(document, location, run, runId) {
  const video = document.getElementById('run-video');
  const empty = document.getElementById('replay-empty');
  const valid = verifiedDanceVideo(run);
  if (!video || !empty) return;
  const href = danceVideoUrl(location, run, runId);
  if (valid && href) {
    if (video.getAttribute('src') !== href.href) video.src = href.href;
    else if (video.error) video.load();
    video.hidden = false;
    empty.hidden = true;
    showPlaybackStatus(document, video);
    text(document, 'run-step-replay', '播放本次仿真回放');
    return;
  }
  video.hidden = true;
  if (video.hasAttribute('src')) {
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
  empty.hidden = false;
  const evidence = danceEvidenceFor(run);
  if (!evidence?.video && run.status === 'completed' && run.training?.video === false) {
    text(document, 'replay-status', '提交时关闭了视频生成');
    text(document, 'replay-empty', '本次 Run 未生成视频。仍可查看训练曲线和分段评测。');
    return;
  }
  const metadataValid = valid;
  text(document, 'replay-status', !evidence?.video
    ? '尚无可核验视频'
    : metadataValid
      ? '视频摘要已核验 · 平台未提供本次视频链接'
      : '视频摘要未通过核验');
  text(document, 'replay-empty', metadataValid
    ? '本次策略和轨迹摘要匹配；平台未返回同源的本次 Run 视频链接，因此暂不播放。'
    : evidence?.video
      ? '视频与本次策略或轨迹摘要不匹配，未展示该媒体。'
      : '回放生成后会校验策略与轨迹摘要，再显示本次视频。');
}

function renderRun(document, location, run, runId) {
  const isDance = run.taskId === 'originman-dance' || Boolean(danceConfigFor(run) || danceEvidenceFor(run));
  const status = STATUS_LABELS[run.status] ?? '状态待核对';
  text(document, 'run-title', isDance ? 'OriginMan · 本次舞蹈训练' : '本次训练运行');
  text(document, 'run-status', status);
  text(document, 'run-task', isDance ? 'OriginMan · 强化学习舞蹈' : run.taskId ?? run.productId ?? '—');
  text(document, 'run-engine', run.training?.engine ?? run.training?.algorithm ?? '—');
  text(document, 'run-id-label', `Run ${runId}`);
  text(document, 'run-id-detail', runId);
  text(document, 'run-model-id', run.modelId);
  text(document, 'run-policy-sha', run.artifact?.sha256 ?? '尚未生成策略摘要');
  text(document, 'run-summary', run.summary ?? '平台未提供本次运行摘要。');
  const replayUrl = isDance ? danceVideoUrl(location, run, runId) : null;
  const replayVerified = isDance && verifiedDanceVideo(run);
  text(document, 'run-next-action', run.status === 'queued'
    ? '本次训练正在排队；页面会继续查询同一 Run。'
    : run.status === 'running'
      ? '本次训练正在运行；曲线只显示该 Run 实际上报的采样点。'
      : run.status === 'completed' && isDance && replayVerified && replayUrl
        ? '本次舞蹈训练已结束；风格门结果已显示，可以播放已核验的本次仿真回放。'
        : run.status === 'completed' && isDance
          ? '本次舞蹈训练已结束；风格门结果已显示。当前平台没有提供可核验且可播放的本次回放，请查看下方说明。'
          : run.status === 'completed'
            ? '本次训练已结束；请查看本次运行结果。'
            : '已打开本次 Run 的只读详情。');
  const config = run.training ?? {};
  const table = document.getElementById('run-config-table');
  const body = document.getElementById('run-config-body');
  const configRows = [
    ['算法', config.algorithm],
    ['训练预算', danceConfigFor(run)?.trainingSteps ?? config.timesteps ?? config.trainingSteps ?? config.totalTimesteps],
    ['实际训练步数', run.metrics?.trainingSteps],
    ['实际训练设备', run.metrics?.trainingDeviceName ?? run.metrics?.trainingDevice],
    ['并行环境', config.numEnvs],
    ['计划轮数', config.maxIterations],
    ['算力资源', run.computeResourceId],
    ['开始时间', formatDate(run.createdAt)],
    ['结束时间', formatDate(run.finishedAt)],
    ['更新时间', formatDate(run.finishedAt ?? run.createdAt)],
  ].filter(([, value]) => value != null && value !== '');
  if (body && table) {
    body.replaceChildren();
    table.hidden = configRows.length === 0;
    for (const [name, value] of configRows) {
      const row = document.createElement('tr');
      const nameCell = document.createElement('td');
      const valueCell = document.createElement('td');
      nameCell.textContent = name;
      valueCell.textContent = String(value);
      row.append(nameCell, valueCell);
      body.append(row);
    }
  }
  renderDance(document, run);
  renderQuality(document, run);
  drawCurve(document, run);
  renderVideo(document, location, run, runId);
  text(document, 'run-connection-status', '已连接并定位到本次 Run');
}

export async function startRunDetail({
  document,
  location,
  fetchImpl = fetch,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  const runId = new URLSearchParams(location?.search ?? '').get('runId') ?? '';
  const error = document?.getElementById('run-error');
  let timer = null;
  let disposed = false;
  let loaded = false;
  let active = false;
  const fail = (message) => {
    if (error) {
      error.textContent = message;
      error.hidden = false;
    }
    text(document, 'run-connection-status', '无法读取本次运行');
    text(document, 'run-next-action', '检查当前平台登录状态和链接中的 Run ID。');
  };
  if (!document || !location || !RUN_ID_PATTERN.test(runId)) {
    fail('运行链接缺少有效的 Run ID。请回到训练回复，打开本次运行链接。');
    return { runId: '', dispose() {} };
  }
  text(document, 'run-id-label', `Run ${runId}`);
  text(document, 'run-id-detail', runId);
  const video = document.getElementById('run-video');
  const playbackEvents = ['playing', 'pause', 'ended', 'error'];
  const onPlayback = () => showPlaybackStatus(document, video);
  for (const event of playbackEvents) video?.addEventListener(event, onPlayback);
  const requestUrl = new URL(`./api/v1/duck/runs/${encodeURIComponent(runId)}`, location.href).toString();
  const schedule = () => {
    if (disposed || !active || timer !== null || document.visibilityState === 'hidden') return;
    timer = setTimeoutImpl(() => {
      timer = null;
      void loadRun(true);
    }, 10000);
  };
  const loadRun = async (quiet = false) => {
    if (disposed) return;
    if (!quiet) {
      if (error) error.hidden = true;
      text(document, 'run-connection-status', '正在读取本次运行');
    }
    try {
      const response = await fetchImpl(requestUrl, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { accept: 'application/json' },
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 401) throw new Error('当前浏览器尚未登录学习平台。请先登录，再回到此页点“刷新本次运行”。');
        if (response.status === 404) throw new Error('当前账号无权查看这条 Run，或该记录不存在。链接不会切换账号，也不会改看其他实验。');
        throw new Error('平台暂时无法读取这条 Run。请保留原链接，稍后刷新本页。');
      }
      const run = payload?.run;
      if (!run || run.id !== runId) throw new Error('平台返回的运行记录与链接中的 Run ID 不一致。');
      loaded = true;
      active = ['queued', 'running', 'ready'].includes(run.status);
      if (error) error.hidden = true;
      renderRun(document, location, run, runId);
      schedule();
    } catch (cause) {
      if (!quiet || !loaded) fail(cause instanceof Error ? cause.message : '运行读取失败。');
      else text(document, 'run-connection-status', '状态刷新失败 · 显示最近一次已读取结果');
    }
  };
  document.getElementById('refresh-run')?.addEventListener('click', () => {
    if (timer !== null) clearTimeoutImpl(timer);
    timer = null;
    void loadRun();
  });
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      if (timer !== null) clearTimeoutImpl(timer);
      timer = null;
    } else if (loaded) schedule();
  };
  document.addEventListener('visibilitychange', onVisibility);
  await loadRun();
  return {
    runId,
    requestUrl,
    dispose() {
      disposed = true;
      if (timer !== null) clearTimeoutImpl(timer);
      timer = null;
      document.removeEventListener('visibilitychange', onVisibility);
      for (const event of playbackEvents) video?.removeEventListener(event, onPlayback);
    },
  };
}

const start = () => { void startRunDetail({ document, location: window.location }); };
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
