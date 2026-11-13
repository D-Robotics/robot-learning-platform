import './run-progress-chart.js';

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

const DANCE_MEASUREMENTS = Object.freeze({
  armAsymmetryRangeM: ['双臂前后差幅度', 1000, ' mm'],
  alternatingArmFraction: ['摆臂交替命中率', 100, '%'],
  armBeatCorrelation: ['摆臂节奏相关性', 1, ''],
  lateralRangeM: ['横向移动幅度', 1000, ' mm'],
  lateralTrackingFraction: ['换重心方向命中率', 100, '%'],
  heightRangeM: ['高度变化幅度', 1000, ' mm'],
  riseAndDipCorrelation: ['下蹲起身节奏相关性', 1, ''],
  squatDescentM: ['下蹲行程', 1000, ' mm'],
  squatAscentM: ['起身行程', 1000, ' mm'],
  armSweepM: ['双臂前摆幅度', 1000, ' mm'],
  holdStillFraction: ['定格静止比例', 100, '%'],
  meanHoldHandSpanM: ['定格平均手间距', 1000, ' mm'],
  holdPeakTiltDeg: ['定格最大倾角', 1, '°'],
});

function formatDanceMeasurement(key, value) {
  if (!Object.hasOwn(DANCE_MEASUREMENTS, key)) return `${key}：${Number(value.toFixed(4))}`;
  const [name, multiplier, unit] = DANCE_MEASUREMENTS[key];
  return `${name}：${Number((value * multiplier).toFixed(2))}${unit}`;
}

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
          .map(([key, value]) => formatDanceMeasurement(key, value));
        return [
          `${typeof bpm === 'number' ? Number(bpm.toFixed(2)) : bpm} BPM · ${index + 1}. ${SECTION_LABELS[type] ?? type}`,
          [...statuses, ...values].join(' · '),
          { bpm, index, section: { type, passed } },
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

function renderTrainingProgress(document, location, run) {
  const progress = document.getElementById('run-training-progress');
  const point = [...(run.progress ?? [])].reverse().find(({ iteration, totalIterations }) =>
    Number.isInteger(iteration) && iteration >= 0 && Number.isInteger(totalIterations) && totalIterations > 0);
  const active = ['queued', 'running', 'cancelling'].includes(run.status);
  if (progress) {
    progress.hidden = !active && !point;
    if (point) {
      progress.max = point.totalIterations;
      progress.value = point.iteration;
    } else progress.removeAttribute('value');
  }
  const isDance = run.taskId === 'originman-dance';
  const rate = isDance && Number.isFinite(point?.recentSuccess)
    ? ` · 近期回合完成率 ${Math.round(100 * point.recentSuccess)}%`
    : '';
  text(document, 'run-training-progress-note', point
    ? `第 ${point.iteration} / ${point.totalIterations} 轮${Number.isFinite(point.meanReward) ? ` · 平均奖励 ${point.meanReward.toFixed(3)}` : ''}${rate}`
    : run.status === 'queued' ? '排队中 · 等待算力机接单'
      : active ? '等待 Worker 上报首条训练进度' : '');
  const row = document.getElementById('run-dance-next');
  const link = document.getElementById('run-dance-next-link');
  if (!row || !link) return;
  let draft;
  try { draft = JSON.parse(document.defaultView.sessionStorage.getItem('rdk-dance-stage:' + run.id) ??
    document.defaultView.localStorage.getItem('rdk-dance-stage:' + run.id)); } catch { /* Missing or unreadable draft. */ }
  row.hidden = !isDance || run.status !== 'completed' ||
    danceEvidenceFor(run)?.qualityGatePassed !== true || !Number.isInteger(draft?.count) || !Array.isArray(draft.full?.sections) ||
    draft.count >= draft.full.sections.length;
  const notice = document.getElementById('run-dance-next-note');
  if (notice) {
    notice.hidden = !isDance || run.status !== 'completed' || danceEvidenceFor(run)?.qualityGatePassed !== true || !row.hidden || !!draft;
  }
  if (!row.hidden) {
    const url = new URL('./?robot=originman#train/configure', location.href);
    url.searchParams.set('fromRun', run.id);
    url.searchParams.set('danceNext', '1');
    link.href = url.href;
  }
}

function drawCurve(document, run) {
  const canvas = document.getElementById('reward-chart');
  const empty = document.getElementById('curve-empty');
  if (!canvas || !empty) return;
  const points = globalThis.RunProgressChart.points(run);
  const hasRate = points.some((point) => point.recentSuccess != null && Number.isFinite(Number(point.recentSuccess)));
  canvas.hidden = !points.length;
  empty.hidden = Boolean(points.length);
  document.getElementById('run-chart-legend').hidden = !points.length;
  document.getElementById('run-chart-rate-legend').hidden = !hasRate;
  const rateLabel = run.taskId === 'originman-dance' ? '近期回合完成率' : '近期成功率';
  text(document, 'run-chart-rate-label', rateLabel);
  canvas.setAttribute('aria-label', hasRate ? `平均奖励与${rateLabel}曲线` : '平均奖励曲线');
  text(document, 'curve-caption', points.length ? `${points.length} 个实测采样点` : '等待本轮采样数据');
  if (points.length) globalThis.RunProgressChart.draw(canvas, points);
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

function renderQuality(document, location, run) {
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
  const guide = document.getElementById('dance-quality-guide');
  if (guide) guide.hidden = !isDance;
  const rows = metricRows(evidence);
  const config = danceConfigFor(run);
  const failedLinks = document.getElementById('run-failed-sections');
  failedLinks?.replaceChildren();
  const table = document.getElementById('quality-table');
  const body = document.getElementById('quality-body');
  if (table && body) {
    body.replaceChildren();
    table.hidden = rows.length === 0;
    for (const [name, value, timing] of rows) {
      const row = document.createElement('tr');
      const nameCell = document.createElement('td');
      const valueCell = document.createElement('td');
      nameCell.textContent = name;
      valueCell.textContent = value;
      if (timing && timing.bpm === config?.bpm &&
          config.sections?.[timing.index]?.type === timing.section.type) {
        row.id = `dance-section-${timing.index + 1}`;
        row.tabIndex = -1;
        if (timing.section.passed === false) {
          const link = document.createElement('a');
          if (document.getElementById('run-evidence')) {
            const url = new URL(location.href);
            url.searchParams.set('trainingRun', run.id);
            url.searchParams.set('runSection', row.id);
            url.hash = 'train/submit';
            link.href = url.href;
          } else link.href = `#${row.id}`;
          link.textContent = `第 ${timing.index + 1} 段 · ${SECTION_LABELS[timing.section.type] ?? '舞段'}`;
          const item = document.createElement('li');
          item.append(link);
          failedLinks?.append(item);
        }
        const replayWindow = danceReplayWindow(run, timing.index);
        if (replayWindow && danceVideoUrl(location, run, run.id)) {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = `播放第 ${timing.index + 1} 段回放`;
          button.setAttribute('aria-controls', 'run-video');
          button.addEventListener('click', () => playDanceSection(document, timing.index + 1, replayWindow));
          valueCell.append(document.createElement('br'), button);
        }
      }
      row.append(nameCell, valueCell);
      body.append(row);
    }
  }
  if (failedLinks) failedLinks.hidden = !failedLinks.children.length;
  text(document, 'run-step-quality', passed === true ? '质量门已通过' : passed === false ? '质量门未通过' : '质量证据待核验');
}

// The original dance trace is captured at nominal BPM, beginning at beat zero.
export function danceReplayWindow(run, index) {
  const config = danceConfigFor(run);
  const duration = danceEvidenceFor(run)?.video?.durationSeconds;
  if (!verifiedDanceVideo(run) || !Number.isFinite(duration) || duration <= 0 ||
      !Number.isFinite(config?.bpm) || config.bpm <= 0 ||
      !Array.isArray(config.sections) || !config.sections[index] ||
      !config.sections.every(({ beats }) => Number.isInteger(beats) && beats > 0)) return null;
  const secondsPerBeat = 60 / config.bpm;
  const start = config.sections.slice(0, index).reduce((sum, { beats }) => sum + beats, 0) * secondsPerBeat;
  const end = Math.min(duration, start + config.sections[index].beats * secondsPerBeat);
  return end > start ? { start, end } : null;
}

const sectionPlayback = new WeakMap();

function playDanceSection(document, number, { start, end }) {
  const video = document.getElementById('run-video');
  if (!video || video.hidden || !video.getAttribute('src')) return;
  sectionPlayback.get(video)?.abort();
  const playback = new document.defaultView.AbortController();
  const options = { signal: playback.signal };
  sectionPlayback.set(video, playback);
  const setStatus = (message) => text(document, 'replay-section-status', message);
  const stop = () => {
    if (video.currentTime < Math.min(end, video.duration) && !video.ended) return;
    video.pause();
    playback.abort();
    setStatus(`第 ${number} 段回放已播完`);
  };
  const startPlayback = () => {
    video.addEventListener('timeupdate', stop, options);
    video.addEventListener('ended', stop, options);
    video.play().catch(() => {
      if (!playback.signal.aborted) setStatus(`第 ${number} 段已定位，请使用播放器的播放按钮`);
    });
  };
  const seek = () => {
    if (!Number.isFinite(video.duration) || start >= video.duration) {
      playback.abort();
      video.pause();
      setStatus(`原回放没有录到第 ${number} 段`);
      return;
    }
    setStatus(`第 ${number} 段回放`);
    if (Math.abs(video.currentTime - start) < 0.001 && !video.seeking) {
      startPlayback();
    } else {
      video.addEventListener('seeked', startPlayback, { ...options, once: true });
      video.currentTime = start;
    }
  };
  video.pause();
  video.scrollIntoView?.({ block: 'nearest' });
  video.focus();
  if (video.readyState >= 1) seek();
  else {
    video.addEventListener('loadedmetadata', seek, { ...options, once: true });
    video.load();
  }
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
    ? '暂时无法加载回放。可刷新重试，持续失败请联系管理员检查原训练资源。'
    : video.ended
      ? '本次仿真回放已播完'
      : video.paused
        ? '本次视频摘要已核对 · 点击播放'
        : '正在播放本次仿真回放';
  text(document, document.getElementById('run-evidence') ? 'run-video-status' : 'replay-status', message);
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
    text(document, document.getElementById('run-evidence') ? 'run-video-status' : 'replay-status', '提交时关闭了视频生成');
    text(document, 'replay-empty', '本次 Run 未生成视频。仍可查看训练曲线和分段评测。');
    return;
  }
  const metadataValid = valid;
  text(document, document.getElementById('run-evidence') ? 'run-video-status' : 'replay-status', !evidence?.video
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

function renderRun(document, location, run, runId, { embedded = false } = {}) {
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
  const download = document.getElementById('run-policy-download');
  const canDownload = run.status === 'completed' && run.backend === 'local' && !run.mock &&
    run.externalRunId && run.artifact?.format?.toLowerCase() === 'onnx' &&
    SHA256_PATTERN.test(run.artifact.sha256 ?? '');
  if (canDownload) {
    download.href = new URL(`./api/sim2real/runs/${encodeURIComponent(runId)}/artifact`, location.href).href;
  } else {
    download.removeAttribute('href');
  }
  download.hidden = !canDownload;
  text(document, 'run-summary', run.summary ?? '平台未提供本次运行摘要。');
  const hardware = document.getElementById('run-hardware-readiness');
  if (hardware) {
    hardware.hidden = !isDance || run.status !== 'completed';
    hardware.textContent = run.artifact?.deployable === true
      ? '真机迁移需核对同源评测、已发布制品、目标设备和部署预检。'
      : '当前策略用于仿真。真机迁移还需板端契约、关节标定和可部署制品。';
  }
  const copyConfig = document.getElementById('run-copy-config');
  if (copyConfig) {
    copyConfig.hidden = run.taskId !== 'originman-dance' || !run.training?.originmanDance ||
      !['completed', 'failed', 'blocked', 'cancelled', 'canceled'].includes(run.status);
    if (copyConfig.hidden) copyConfig.removeAttribute('href');
    else {
      const href = new URL('./?robot=originman#train/configure', location.href);
      href.searchParams.set('fromRun', runId);
      copyConfig.href = href.toString();
    }
  }
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
    ['计划采样轮数', config.maxIterations],
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
  renderQuality(document, location, run);
  renderTrainingProgress(document, location, run);
  if (!embedded) drawCurve(document, run);
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
  const login = document?.getElementById('run-login');
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
      if (login) login.hidden = true;
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
        if (response.status === 401) {
          if (login) {
            const current = new URL(location.href);
            const destination = new URL('./login', current);
            destination.searchParams.set('returnTo', current.pathname + current.search + current.hash);
            login.href = destination.href;
            login.hidden = false;
          }
          throw new Error('当前工作台尚未登录。登录后将继续查看本次运行。');
        }
        if (response.status === 404) throw new Error('当前账号无权查看这条 Run，或该记录不存在。链接不会切换账号，也不会改看其他实验。');
        throw new Error('平台暂时无法读取这条 Run。请保留原链接，稍后刷新本页。');
      }
      const run = payload?.run;
      if (!run || run.id !== runId) throw new Error('平台返回的运行记录与链接中的 Run ID 不一致。');
      loaded = true;
      active = ['queued', 'running', 'ready', 'cancelling'].includes(run.status);
      if (error) error.hidden = true;
      if (login) login.hidden = true;
      renderRun(document, location, run, runId);
      if (!quiet && /^#dance-section-[1-9]$/.test(location.hash ?? '')) {
        const target = document.getElementById(location.hash.slice(1));
        target?.focus();
        target?.scrollIntoView?.({ block: 'center' });
      }
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

export function legacyRunDestination(location) {
  const current = new URL(location.href);
  const runId = current.searchParams.get('runId') ?? '';
  if (!RUN_ID_PATTERN.test(runId)) return null;
  const destination = new URL('./', current);
  destination.searchParams.set('trainingRun', runId);
  for (const key of ['robot', 'deviceId', 'videoUrl']) {
    if (current.searchParams.has(key)) destination.searchParams.set(key, current.searchParams.get(key));
  }
  const anchor = current.hash.slice(1);
  if (isRunSection(anchor)) destination.searchParams.set('runSection', anchor);
  destination.hash = 'train/submit';
  return destination;
}

function isRunSection(anchor) {
  return /^(?:dance-section(?:-[1-9]\d*)?|curve-heading|quality-heading|replay-heading|resimulated-heading|run-overview-heading|run-handoff)$/.test(anchor);
}

export function mountRunEvidence(document, location) {
  const panel = document.getElementById('run-evidence');
  const win = document.defaultView;
  const video = document.getElementById('run-video');
  let lastRecord = '';
  let lastAnchor = '';
  for (const event of ['playing', 'pause', 'ended', 'error'])
    video?.addEventListener(event, () => { if (!panel.hidden) showPlaybackStatus(document, video); });

  function showAnchor(runId, anchor) {
    if (!isRunSection(anchor) || win.location.hash !== '#train/submit') return;
    const id = {
      'curve-heading': 'run-progress-card',
      'run-overview-heading': 'run-technical-evidence',
    }[anchor] ?? anchor;
    const target = document.getElementById(id);
    if (!target || target.hidden || target.closest('[hidden]')) return;
    if (target.matches('details')) target.open = true;
    if (target.closest('#run-technical-evidence')) document.getElementById('run-technical-evidence').open = true;
    lastAnchor = runId + ':' + anchor;
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
    target.scrollIntoView?.({ block: 'start' });
  }

  panel.addEventListener('click', (event) => {
    const link = event.target.closest('#run-failed-sections a');
    if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const url = new URL(location.href);
    url.searchParams.set('trainingRun', panel.dataset.runId);
    const anchor = new URL(link.href).searchParams.get('runSection');
    url.searchParams.set('runSection', anchor);
    win.history.replaceState(win.history.state, '', url);
    if (win.location.hash !== '#train/submit') {
      win.location.assign(link.href);
      return;
    }
    showAnchor(panel.dataset.runId, anchor);
  });

  function update(run) {
    const finished = run && ['completed', 'failed', 'blocked', 'cancelled', 'canceled'].includes(run.status);
    const record = finished ? [run.id, run.status, run.finishedAt].join(':') : '';
    if (record !== lastRecord) {
      lastRecord = record;
      document.getElementById('run-technical-evidence').open = false;
      sectionPlayback.get(video)?.abort();
      if (video?.hasAttribute('src')) {
        video.pause();
        video.removeAttribute('src');
        video.load();
      }
      text(document, 'replay-section-status', '');
      panel.hidden = !finished;
      panel.dataset.runId = finished ? run.id : '';
      if (finished) {
        const dance = run.taskId === 'originman-dance' || Boolean(danceConfigFor(run) || danceEvidenceFor(run));
        document.getElementById('run-dance-results').hidden = !dance;
        renderRun(document, location, run, run.id, { embedded: true });
      }
    }
    const params = new URL(location.href).searchParams;
    const anchor = params.get('runSection') ?? '';
    if (!run || params.get('trainingRun') !== run.id) lastAnchor = '';
    else if (lastAnchor !== run.id + ':' + anchor) showAnchor(run.id, anchor);
  }
  win.addEventListener('rdk-run-selected', (event) => update(event.detail));
  win.dispatchEvent(new win.Event('rdk-run-evidence-ready'));
}

const start = () => {
  if (document.getElementById('run-evidence')) {
    mountRunEvidence(document, window.location);
    return;
  }
  if (window.location.pathname.endsWith('/run-detail.html')) {
    const destination = legacyRunDestination(window.location);
    if (destination) {
      window.location.replace(destination.href);
      return;
    }
  }
  void startRunDetail({ document, location: window.location });
};
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
