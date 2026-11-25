import { renderDanceReferenceLinks } from './dance-reference-links.mjs';

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/;
const REFERENCE_TASK = 'originman-reference-track';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const STATUS_LABELS = Object.freeze({
  ready: '已准备',
  queued: '排队中',
  running: '运行中',
  cancelling: '正在取消',
  completed: '已完成',
  blocked: '已阻断',
  failed: '失败',
  cancelled: '已取消',
  canceled: '已取消',
});
const workshopEvidenceMessages = new Map([
  ['binding-missing', '原训练缺少可用于恢复的 Worker 或策略绑定。请由课程管理员核对原训练的记录。'],
  [
    'worker-unavailable',
    '暂时连不上原训练的 Worker。请恢复同一算力资源的连接，再继续原实验的评测。',
  ],
  ['job-missing', '原 Worker 查不到这条任务。请核对 Worker 的数据目录是否仍包含原训练记录。'],
  ['receipt-missing', '原 Worker 尚未返回可用的评测回执。请核对是否保留了原训练的结果文件。'],
  [
    'receipt-mismatch',
    '原 Worker 返回的任务、训练参数或策略校验值与原记录不一致。请核对原始结果文件。',
  ],
]);

export function workshopEvidenceMessage(issue) {
  return workshopEvidenceMessages.get(issue);
}

const SECTION_LABELS = Object.freeze({
  'alternating-arms': '交替摆臂',
  'weight-shift': '左右换重心',
  'squat-rise': '下蹲起身',
  'open-pose': '展开定格',
  'single-arm-wave': '单臂挥手',
  'arms-overhead': '双臂上举',
  'cross-and-open': '胸前交叉展开',
  'side-lean': '左右侧身',
  'alternating-knee-lift': '交替抬膝',
  'side-tap': '侧点步收回',
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

function replayEvidenceFor(run) {
  return run.taskId === REFERENCE_TASK ? run.metrics?.originmanReference : danceEvidenceFor(run);
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

function drawCurve(document, run, completion = false) {
  const svg = document.getElementById(completion ? 'completion-chart' : 'reward-chart');
  const empty = document.getElementById(completion ? 'completion-empty' : 'curve-empty');
  if (!svg || !empty) return;
  svg.replaceChildren();
  const raw = Array.isArray(run.progress) ? run.progress : [];
  const points = raw.map((point, index) => ({
    x: Number(point.iteration ?? point.step ?? point.trainingStep ?? index + 1),
    y: completion
      ? point.episodeSamples > 0 && point.recentSuccess >= 0 && point.recentSuccess <= 1
        ? point.recentSuccess * 100 : NaN
      : Number(point.meanReward ?? point.reward ?? point.mean_reward),
  })).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (!points.length) {
    svg.setAttribute('hidden', '');
    empty.hidden = false;
    if (!completion) text(document, 'curve-caption', '本次 Run 未返回曲线采样');
    return;
  }
  const namespace = 'http://www.w3.org/2000/svg';
  const xMin = Math.min(...points.map((point) => point.x));
  const xMax = Math.max(...points.map((point) => point.x));
  const low = Math.min(...points.map((point) => point.y));
  const high = Math.max(...points.map((point) => point.y));
  const yMin = completion ? 0 : low;
  const yMax = completion ? 100 : high;
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
  axis.setAttribute('fill', 'none');
  const line = document.createElementNS(namespace, 'polyline');
  line.setAttribute('points', coordinates);
  line.setAttribute('class', 'reward-line');
  const label = document.createElementNS(namespace, 'text');
  label.setAttribute('x', '60');
  label.setAttribute('y', '18');
  label.setAttribute('class', 'reward-label');
  label.textContent = completion
    ? `${points.length} 个采样点 · ${low.toFixed(1)}% 至 ${high.toFixed(1)}%`
    : `${points.length} 个本次采样点 · ${low.toFixed(3)} 至 ${high.toFixed(3)}`;
  svg.append(axis, line, label);
  svg.removeAttribute('hidden');
  empty.hidden = true;
  if (!completion) text(document, 'curve-caption', '仅显示本次 Run 上报的数据');
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
  const mode = config?.compositionMode === 'preset' ? '预置舞蹈 · '
    : config?.compositionMode === 'custom' ? '动作组自由编排 · ' : '';
  text(document, 'dance-meta', config
    ? `${mode}${config.bpm} BPM · ${config.sections?.reduce((sum, item) => sum + Number(item.beats || 0), 0) ?? 0} 拍 · ${config.sections?.length ?? 0} 段`
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

function referenceQualityRows(evidence, composition) {
  if (!evidence) return [];
  const rows = [
    ['轨迹完成度', `${evidence.framesEvaluated} / ${evidence.framesExpected} 帧`],
    ['平均关节跟踪误差', `${evidence.trackingMaeRad.toFixed(4)} rad`],
    ['峰值倾角（通过标准 < 32°）', `${evidence.maxTiltDeg.toFixed(2)}°`],
    ['末尾偏航（通过标准绝对值 < 5°）', `${evidence.finalYawDeg.toFixed(2)}°`],

  ];
  if (Number.isFinite(evidence.trackingRmseRad))
    rows.push(['关节跟踪 RMSE', evidence.trackingRmseRad.toFixed(4) + ' rad']);
  if (Number.isFinite(evidence.zeroResidualRmseRad)) {
    const evaluated = evidence.zeroResidualFramesEvaluated;
    const rounds = ` · ${evaluated}/${evidence.framesExpected} 帧`;
    rows.push(['纯参考关节跟踪 RMSE', evidence.zeroResidualRmseRad.toFixed(4) + ' rad' + rounds]);
    if (evaluated === evidence.framesExpected && evidence.framesEvaluated === evaluated &&
        Number.isFinite(evidence.trackingRmseRad) && evidence.zeroResidualRmseRad > 0) {
      const difference = 100 * (evidence.trackingRmseRad / evidence.zeroResidualRmseRad - 1);
      rows.push(['PPO 相对纯参考的 RMSE 变化', (difference > 0 ? '+' : '') + difference.toFixed(1) + '%']);
    }
  }
  if (Number.isFinite(evidence.onnxMaxAbsError))
    rows.push(['ONNX 最大推理差异', evidence.onnxMaxAbsError.toExponential(2)]);
  const sections = evidence.sections;
  if (composition && Array.isArray(sections) && sections.length === composition.ranges?.length &&
      sections.every((section, index) => section.id === composition.ranges[index].id &&
        section.framesExpected === composition.ranges[index].to - composition.ranges[index].from)) {
    sections.forEach((section, index) => {
      const metrics = [section.completed ? '完成' : '未完成', section.framesEvaluated + '/' + section.framesExpected + ' 帧'];
      if (Number.isFinite(section.trackingRmseRad)) metrics.push('RMSE ' + section.trackingRmseRad.toFixed(4) + ' rad');
      if (Number.isFinite(section.squatDescentM)) metrics.push('下降 ' + (section.squatDescentM * 1000).toFixed(1) + ' mm');
      rows.push(['第 ' + (index + 1) + ' 段 · ' + section.id, metrics.join(' · ')]);
    });
  }
  return rows;
}

function renderQuality(document, run) {
  const evidence = danceEvidenceFor(run);
  const tracking = run.taskId === REFERENCE_TASK;
  const reference = tracking ? run.metrics?.originmanReference : null;
  const gate = evidence?.qualityGate;
  const passed = tracking ? reference?.qualityGatePassed : typeof evidence?.qualityGatePassed === 'boolean'
    ? evidence.qualityGatePassed
    : typeof gate?.passed === 'boolean'
      ? gate.passed
      : null;
  const isDance = run.taskId === 'originman-dance' || Boolean(evidence);
  const gateLabel = tracking ? '跟跳评测' : '风格门';
  text(document, 'quality-status', passed === true ? gateLabel + '通过' : passed === false ? gateLabel + '未通过' : '待核验');
  text(document, 'quality-summary', tracking
    ? reference
      ? '评测使用本次导出的 ONNX 和同一份参考轨迹。完整度、倾角和偏航同时达标才通过。'
      : run.status === 'failed'
        ? '训练或训练前物理筛查失败，请查看本轮日志。'
        : '同一轨迹的 ONNX 仿真评测将在训练完成后显示。'
    : !isDance
    ? '该运行没有舞蹈专用质量门字段。'
    : passed === true
      ? '本次 Run 返回的舞蹈质量门已通过。'
      : passed === false
        ? '本次 Run 返回的舞蹈质量门未通过；训练完成不等于舞蹈达标。'
        : run.status === 'completed'
          ? '运行已结束，但没有可核验的舞蹈质量门结果。'
          : '运行终态后再读取本次舞蹈质量门结果。');
  const config = danceConfigFor(run);
  const nominal = Array.isArray(evidence?.evaluations)
    ? evidence.evaluations.find((row) => row?.bpm === config?.bpm)?.sections : null;
  if (Number.isFinite(config?.bpm) && Array.isArray(config.sections) && Array.isArray(nominal) &&
      nominal.length > 0 && nominal.length === config.sections.length &&
      nominal.every((section, index) => section?.type === config.sections[index]?.type && typeof section.passed === 'boolean')) {
    const missed = nominal.flatMap((section, index) =>
      section.passed ? [] : [`第 ${index + 1} 段 ${SECTION_LABELS[section.type] || '舞段'}`]);
    const summary = `${config.bpm} BPM 下，${nominal.length - missed.length}/${nominal.length} 段达标。`;
    const next = missed.length
      ? `先看${missed.slice(0, 2).join('、')}的分段指标，可带着本轮参数准备下一轮。`
      : passed === false ? '此节拍各段通过，请在下方核对其他节拍及整套舞蹈指标。' : '';
    const label = document.getElementById('quality-summary');
    if (label) label.textContent += summary + next;
  }
  const rows = tracking ? referenceQualityRows(reference, run.training?.originmanReferenceComposition) : metricRows(evidence);
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

function referenceDigestMismatch(run) {
  const expected = run.training?.originmanReferenceSummary?.trajectorySha256;
  const reported = run.metrics?.originmanReference?.trajectorySha256;
  return run.taskId === REFERENCE_TASK && expected && reported && expected !== reported;
}

function verifiedDanceVideo(run) {
  const evidence = replayEvidenceFor(run);
  const video = evidence?.video;
  const policySha = run.artifact?.sha256;
  const replaySha = evidence?.replay?.sha256;
  return !referenceDigestMismatch(run) && run.status === 'completed' && video?.file === 'dance-replay.mp4' &&
    SHA256_PATTERN.test(video.sha256 ?? '') && SHA256_PATTERN.test(policySha ?? '') &&
    video.policySha256 === policySha && SHA256_PATTERN.test(replaySha ?? '') &&
    video.sourceReplaySha256 === replaySha;
}

function danceVideoUrl(location, run, runId) {
  const candidate = run.links?.danceVideo ?? replayEvidenceFor(run)?.video?.url ??
    new URLSearchParams(location.search).get('videoUrl') ??
    (run.taskId === REFERENCE_TASK ? `./api/v1/duck/runs/${encodeURIComponent(runId)}/dance-video` : null);
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
  text(document, 'replay-status', message);
}

function renderReferenceSegments(document, run, video, available) {
  const controls = document.getElementById('replay-segment-controls');
  if (!controls) return;
  const select = document.getElementById('replay-segment');
  const seek = document.getElementById('replay-segment-seek');
  const notice = document.getElementById('replay-segment-status');
  const evidence = run.metrics?.originmanReference;
  const ranges = run.training?.originmanReferenceComposition?.ranges ?? [];
  const fps = evidence?.video?.fps;
  const options = [];
  if (available && run.taskId === REFERENCE_TASK && fps === 50 && Array.isArray(ranges)) {
    for (const [index, range] of ranges.entries()) {
      if (!range || !Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to) ||
          range.from < 0 || range.from >= range.to || range.to > evidence.framesExpected ||
          range.from >= evidence.framesEvaluated || typeof range.id !== 'string') continue;
      const time = range.from / fps;
      const option = document.createElement('option');
      option.value = String(time);
      option.textContent = `第 ${index + 1} 段 · ${range.id} · ${time.toFixed(2)} 秒`;
      options.push(option);
    }
  }
  controls.hidden = !options.length;
  if (!options.length) {
    select.replaceChildren();
    seek.onclick = null;
    notice.textContent = '';
    return;
  }
  const selected = select.value;
  if (options.map(({ textContent }) => textContent).join('|') !==
      Array.from(select.options, ({ textContent }) => textContent).join('|')) {
    select.replaceChildren(...options);
    if (options.some(({ value }) => value === selected)) select.value = selected;
  }
  seek.onclick = () => {
    const seconds = Number(select.value);
    if (video.error) {
      notice.textContent = '回放暂不可用，请刷新后重试。';
      return;
    }
    video.currentTime = seconds;
    notice.textContent = `已跳到 ${seconds.toFixed(2)} 秒。`;
  };
}

function renderVideo(document, location, run, runId) {
  const video = document.getElementById('run-video');
  const empty = document.getElementById('replay-empty');
  const valid = verifiedDanceVideo(run);
  if (!video || !empty) return;
  const href = danceVideoUrl(location, run, runId);
  renderReferenceSegments(document, run, video, valid && href);
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
  const evidence = replayEvidenceFor(run);
  if (referenceDigestMismatch(run)) {
    text(document, 'replay-status', '训练轨迹摘要不一致');
    text(document, 'replay-empty', 'Worker 与平台记录的训练轨迹摘要不同，当前回放未通过核验。');
    return;
  }
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

function renderRun(document, location, run, runId, evidenceIssue) {
  const tracking = run.taskId === REFERENCE_TASK;
  const recovery = run.taskId === 'originman-recovery';
  const evidenceMessage = recovery && run.status === 'completed' ? workshopEvidenceMessage(evidenceIssue) : '';
  const isDance = run.taskId === 'originman-dance' || Boolean(danceConfigFor(run) || danceEvidenceFor(run));
  const reference = run.metrics?.originmanReference;
  const expectedTrajectory = run.training?.originmanReferenceSummary?.trajectorySha256;
  text(document, 'run-trajectory-sha', expectedTrajectory
    ? expectedTrajectory + (reference?.trajectorySha256 === expectedTrajectory ? ' · 与 Worker 一致' :
      referenceDigestMismatch(run) ? ' · 与 Worker 不一致' : '')
    : '—');
  text(document, 'run-reference-file-sha', reference?.referenceSha256 ?? '—');
  const status = STATUS_LABELS[run.status] ?? '状态待核对';
  text(document, 'run-title', tracking ? 'OriginMan · 参考轨迹跟跳' : isDance ? 'OriginMan · 本次舞蹈训练' : recovery ? 'OriginMan · 受扰恢复' : '本次训练运行');
  text(document, 'run-status', status);
  text(document, 'run-task', tracking ? 'OriginMan · 参考轨迹跟跳' : isDance ? 'OriginMan · 强化学习舞蹈' : run.taskId ?? run.productId ?? '—');
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
  const logs = document.getElementById('run-logs');
  if (logs) logs.hidden = !(tracking || recovery || isDance) || run.backend !== 'local' || run.mock === true || !run.externalRunId;
  const hardware = document.getElementById('run-hardware-readiness');
  if (hardware) {
    hardware.hidden = !(isDance || tracking) || run.status !== 'completed';
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
  const replayUrl = (isDance || tracking) ? danceVideoUrl(location, run, runId) : null;
  const replayVerified = (isDance || tracking) && verifiedDanceVideo(run);
  text(document, 'run-next-action', evidenceMessage || (run.status === 'queued'
    ? '本次训练正在排队；页面会继续查询同一 Run。'
    : run.status === 'running'
      ? '本次训练正在运行；曲线只显示该 Run 实际上报的采样点。'
      : run.status === 'completed' && tracking
        ? '本次跟跳训练已结束。请查看同源评测、回放和 ONNX 下载。'
      : run.status === 'completed' && isDance && replayVerified && replayUrl
        ? '本次舞蹈训练已结束；风格门结果已显示，可以播放已核验的本次仿真回放。'
        : run.status === 'completed' && isDance
          ? '本次舞蹈训练已结束；风格门结果已显示。当前平台没有提供可核验且可播放的本次回放，请查看下方说明。'
          : run.status === 'completed'
            ? '本次训练已结束；请查看本次运行结果。'
            : run.status === 'cancelling'
              ? '正在等待 Worker 确认停止。'
              : '已打开本次 Run 的只读详情。'));
  const config = run.training ?? {};
  const table = document.getElementById('run-config-table');
  const body = document.getElementById('run-config-body');
  const configRows = [
    ['算法', config.algorithm],
    ['参考来源', config.originmanReferenceComposition?.displayName],
    ['参考配方', config.originmanReferenceComposition?.source],
    ['轨迹编排', config.originmanReferenceComposition?.referenceMode === 'timing-preserved'
      ? '保留交付节奏的仿真适配（50 Hz）'
      : config.originmanReferenceComposition?.referenceAssetSha256 ? '交付原版（50 Hz）' : undefined],
    ['原版源文件 SHA-256', config.originmanReferenceComposition?.sourceSha256],
    ['仿真初始站姿', run.metrics?.originmanReference?.stanceProfile === 'source-neutral-v1' ? '交付原版站姿' : undefined],
    ['动作顺序', config.originmanReferenceComposition?.blocks?.map(({ id, repeats }) => id + ' × ' + repeats).join(' → ')],
    ['参考帧数', config.originmanReferenceSummary?.frames],
    ['训练预算', config.originmanReferenceSummary?.trainingSteps ?? config.originmanReference?.trainingSteps ?? danceConfigFor(run)?.trainingSteps ?? config.timesteps ?? config.trainingSteps ?? config.totalTimesteps],
    ['实际训练步数', run.metrics?.trainingSteps],
    ['已评测 checkpoint', run.metrics?.originmanReference?.checkpointEvaluations],
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
  renderDanceReferenceLinks(document, run, SECTION_LABELS);
  if (tracking) text(document, 'run-kind', 'OriginMan · 参考轨迹仿真');
  drawCurve(document, run);
  if (tracking) drawCurve(document, run, true);
  renderVideo(document, location, run, runId);
  text(document, 'run-connection-status', '已连接并定位到本次 Run');
}

async function showResimulatedReplay(document, location, fetchImpl, run) {
  const panel = document.getElementById('resimulated-replay');
  const video = document.getElementById('resimulated-video');
  if (!panel || !video || run.status !== 'completed' || run.mock !== false ||
      run.taskId !== 'originman-dance' || !danceEvidenceFor(run)?.replay) return;
  const url = new URL(`./api/v1/duck/runs/${encodeURIComponent(run.id)}/resimulated-dance-video`, location.href);
  const response = await fetchImpl(url.toString(), {
    method: 'HEAD', credentials: 'same-origin', cache: 'no-store',
  }).catch(() => null);
  if (!response?.ok || response.headers.get('x-replay-source') !== 'resimulated-onnx') return;
  if (video.getAttribute('src') !== url.toString()) video.src = url.toString();
  panel.hidden = false;
  if (!run.links?.danceVideo) {
    text(document, 'run-next-action', '可观看下方重新仿真回放。原 Run 的训练与评测结果仍可在本页查看。');
  }
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
  const logsButton = document.getElementById('run-logs-load');
  const loadLogs = async () => {
    logsButton.disabled = true;
    text(document, 'run-logs-output', '正在读取本轮日志…');
    try {
      const url = new URL(`./api/sim2real/runs/${encodeURIComponent(runId)}/logs`, location.href);
      const response = await fetchImpl(url.href, { credentials: 'same-origin', cache: 'no-store' });
      const result = await response.json();
      if (!response.ok || result.runId !== runId || !Array.isArray(result.lines)) {
        throw Error(result.message || '暂时无法读取本轮日志。');
      }
      const lines = result.lines.map((line) => line.text).join('\n');
      const retained = [result.stdoutTail, result.stderrTail].filter((item) => typeof item === 'string').join('\n');
      text(document, 'run-logs-output', lines || retained || '暂时没有可读取的日志。');
    } catch (cause) {
      text(document, 'run-logs-output', cause.message || '暂时无法读取本轮日志。');
    } finally {
      logsButton.disabled = false;
    }
  };
  logsButton?.addEventListener('click', loadLogs);
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
      active = ['queued', 'running', 'cancelling', 'ready'].includes(run.status);
      if (error) error.hidden = true;
      renderRun(document, location, run, runId, payload.workshopEvidenceIssue);
      void showResimulatedReplay(document, location, fetchImpl, run);
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
      logsButton?.removeEventListener('click', loadLogs);
      for (const event of playbackEvents) video?.removeEventListener(event, onPlayback);
    },
  };
}

const start = () => { void startRunDetail({ document, location: window.location }); };
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
