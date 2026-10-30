'use strict';
const $ = (id) => document.getElementById(id);
let current = null,
  runData = null,
  frames = [],
  selectedFrame = 0,
  timer = null,
  busy = false;
let validationRecords = [],
  lastTraceKey = '',
  editorRun = null,
  selectedTab = 'overview';
const colors = ['#176e67', '#6b5caa', '#c56f2b', '#3f87ad', '#a64466', '#617386'];
const cn = {
  preparing: '准备模型',
  training: '训练中',
  evaluating: '最终配对评测中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已停止',
  'legacy-completed': '历史运行',
};
const rewardNames = {
  alive: '存活',
  velocity_tracking: '速度跟踪',
  upright: '直立',
  heading_penalty: '航向惩罚',
  lateral_penalty: '侧偏惩罚',
  forward_progress: '前进收益',
  residual_penalty: '残差惩罚',
  action_rate_penalty: '变化率惩罚',
  fall_penalty: '跌倒惩罚',
};
function element(tag, text, cls) {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}
function error(message) {
  $('error').hidden = !message;
  $('error').textContent = message || '';
}
async function api(path, body) {
  const r = await fetch(
    path,
    body
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-OriginMan-Request': 'dashboard' },
          body: JSON.stringify(body),
        }
      : { cache: 'no-store' },
  );
  const d = await r.json();
  if (!r.ok) throw Error(d.error || r.statusText);
  return d;
}
function chooseTab(name) {
  selectedTab = name;
  document.querySelectorAll('.tab').forEach((e) => (e.hidden = e.id !== name));
  document
    .querySelectorAll('nav button')
    .forEach((e) => e.classList.toggle('active', e.dataset.tab === name));
  if (name === 'inspect') drawFrame();
  else if (name === 'overview') drawOverview();
}
function metricCards(container, items) {
  container.replaceChildren();
  for (const [label, value] of items) {
    const d = element('div');
    d.append(element('span', label), element('strong', value));
    container.append(d);
  }
}
function setupCanvas(id) {
  const c = $(id),
    w = c.clientWidth || 500,
    h = c.clientHeight || 220,
    ratio = devicePixelRatio || 1;
  c.width = w * ratio;
  c.height = h * ratio;
  const ctx = c.getContext('2d');
  ctx.scale(ratio, ratio);
  ctx.clearRect(0, 0, w, h);
  ctx.font = '11px sans-serif';
  return { c, ctx, w, h };
}
function plot(id, series, xlabel = '训练迭代') {
  const { ctx, w, h } = setupCanvas(id);
  const good = series.filter((s) => s.points.length);
  if (!good.length) {
    ctx.fillStyle = '#62748a';
    ctx.fillText('暂无相应记录；旧日志不会补造数据', 20, h / 2);
    return;
  }
  const pts = good
    .flatMap((s) => s.points)
    .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (!pts.length) return;
  let x0 = Math.min(...pts.map((p) => p[0])),
    x1 = Math.max(...pts.map((p) => p[0])),
    y0 = Math.min(...pts.map((p) => p[1])),
    y1 = Math.max(...pts.map((p) => p[1]));
  if (x1 === x0) x1 = x0 + 1;
  const padding = (y1 - y0) * 0.15 || 0.1;
  y0 -= padding;
  y1 += padding;
  const px = (x) => 48 + ((w - 64) * (x - x0)) / (x1 - x0),
    py = (y) => h - 33 - ((h - 62) * (y - y0)) / (y1 - y0);
  ctx.strokeStyle = '#e0e7ee';
  ctx.fillStyle = '#62748a';
  for (let i = 0; i < 4; i++) {
    const y = y0 + ((y1 - y0) * i) / 3;
    ctx.beginPath();
    ctx.moveTo(45, py(y));
    ctx.lineTo(w - 12, py(y));
    ctx.stroke();
    ctx.fillText(y.toFixed(Math.abs(y1) < 0.1 ? 4 : 2), 0, py(y) + 4);
  }
  ctx.fillText(String(x0), 46, h - 17);
  ctx.fillText(String(x1), w - 40, h - 17);
  ctx.fillText(xlabel, Math.max(80, w / 2 - 25), h - 2);
  good.forEach((s, i) => {
    ctx.strokeStyle = s.color || colors[i % colors.length];
    ctx.lineWidth = 1.7;
    ctx.beginPath();
    s.points.forEach((p, j) => {
      if (j === 0) ctx.moveTo(px(p[0]), py(p[1]));
      else ctx.lineTo(px(p[0]), py(p[1]));
    });
    ctx.stroke();
    if (s.points.length === 1) {
      ctx.beginPath();
      ctx.arc(px(s.points[0][0]), py(s.points[0][1]), 3, 0, Math.PI * 2);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fill();
    }
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fillText(s.name, 50 + (i * (w - 55)) / Math.max(good.length, 1), 12);
  });
}
function drawOverview() {
  if (!runData) return;
  const curve = runData.curve || [];
  const vals = (key, sub) =>
    curve
      .filter((r) => Number.isFinite(sub ? r[sub]?.[key] : r[key]))
      .map((r) => [r.iteration, sub ? r[sub][key] : r[key]]);
  plot('reward', [{ name: '每控制步平均奖励', points: vals('meanReward') }]);
  plot('diagnostic', [
    { name: $('metric').selectedOptions[0].textContent, points: vals($('metric').value) },
  ]);
  plot(
    'parts',
    ['heading_penalty', 'lateral_penalty', 'residual_penalty'].map((k) => ({
      name: rewardNames[k],
      points: vals(k, 'rewardTerms'),
    })),
  );
  plot('physical', [
    {
      name: $('physical-metric').selectedOptions[0].textContent,
      points: vals($('physical-metric').value, 'dynamics'),
    },
  ]);
  const valseries = (key) =>
    ['reference', 'rl'].map((mode) => ({
      name: mode === 'rl' ? 'RL 修正' : '参考步态',
      points: validationRecords.map((r) => [r.iteration, r[mode][key]]),
    }));
  plot('validation-error', valseries('meanLateralAbsMeters'));
  plot('validation-distance', valseries('meanForwardMeters'));
  const ev = runData.evaluation;
  if (ev) {
    const b = ev.aggregate.reference,
      r = ev.aggregate.rl;
    $('evaluation').textContent =
      `最终 ${ev.episodesPerMode} 组配对评测：平均侧偏 ${(b.lateralAbsMeters * 100).toFixed(2)} → ${(r.lateralAbsMeters * 100).toFixed(2)} cm；前进 ${(b.forwardMeters * 100).toFixed(2)} → ${(r.forwardMeters * 100).toFixed(2)} cm。保持进度的纠偏改善：${ev.demonstratesCorrectionWithoutSlowing ? '通过探索性检查' : '尚未证明'}。`;
  } else
    $('evaluation').textContent =
      '最终配对评测尚未生成。上面的固定案例仅用于开发验证，不能当作最终测试结果。';
}
async function updateValidation() {
  validationRecords = (runData?.events || []).filter((e) => e.event === 'validation');
}
async function refreshRuns() {
  const runs = await api('/api/runs');
  $('runs').replaceChildren();
  for (const r of runs) {
    const b = element(
      'button',
      `${r.id}\n${cn[r.state] || r.state}${r.legacy ? ' · 缺少过程快照' : ''}`,
    );
    b.classList.toggle('selected', r.id === current);
    b.onclick = () => selectRun(r.id);
    $('runs').append(b);
  }
  if (!current && runs.length) await selectRun(runs[0].id);
}
function refreshOptions(select, values, labels) {
  if (
    JSON.stringify(Array.from(select.options).map((o) => [o.value, o.textContent])) ===
    JSON.stringify(values.map((v, i) => [v, labels ? labels[i] : v]))
  )
    return;
  const old = select.value;
  select.replaceChildren();
  for (let i = 0; i < values.length; i++) {
    const o = element('option', labels ? labels[i] : values[i]);
    o.value = values[i];
    select.append(o);
  }
  if (values.includes(old)) select.value = old;
  else if (values.length) select.value = values[values.length - 1];
}
async function selectRun(id) {
  current = id;
  frames = [];
  validationRecords = [];
  lastTraceKey = '';
  editorRun = null;
  stopPlayback();
  error('');
  await refreshData();
  await refreshRuns();
}
async function refreshData() {
  if (!current || busy) return;
  busy = true;
  try {
    const id = current,
      d = await api('/api/run/' + encodeURIComponent(current));
    if (id !== current) return;
    runData = d;
    $('run-title').textContent = id;
    const state =
      d.pipeline?.state || d.status?.state || (d.identity ? 'preparing' : 'legacy-completed');
    $('state').textContent = cn[state] || state;
    const it = d.status.iteration || d.curve.at(-1)?.iteration || 0,
      total = d.status.totalIterations || d.experiment.training.iterations;
    $('progress').value = (100 * it) / Math.max(total, 1);
    $('progress-label').textContent =
      `${it} / ${total} 轮 · 每 ${d.experiment.training.trace_every || 20} 轮保留训练片段`;
    $('stop').disabled = !['training', 'preparing', 'evaluating'].includes(state);
    const last = d.curve.at(-1) || {};
    metricCards($('summary'), [
      ['迭代', `${it} / ${total}`],
      ['平均奖励', last.meanReward?.toFixed(3) || '—'],
      ['累计回合', last.completedEpisodes ?? '—'],
      ['累计跌倒', last.falls ?? '—'],
      ['检查点', d.checkpoints.length],
    ]);
    if (editorRun !== id) {
      $('config').value = JSON.stringify(d.experiment, null, 2);
      editorRun = id;
      showDiff();
    }
    const warmValues = ['', ...d.checkpoints, ...(d.evaluation ? ['final'] : [])];
    refreshOptions($('warm-start'), warmValues, [
      '重新初始化权重',
      ...d.checkpoints,
      ...(d.evaluation ? ['最终权重'] : []),
    ]);
    if (!d.checkpoints.length) $('warm-start').value = '';
    const previousValidation = validationRecords.length;
    if (previousValidation !== d.validation.length) await updateValidation();
    renderEvents();
    renderIdentity();
    refreshTraceOptions();
    if (selectedTab === 'overview') drawOverview();
    if (selectedTab === 'inspect') await loadTrace(false);
    if (d.failure)
      error(
        '本次运行中断，溯源记录已保留：' +
          (d.pipeline?.error || d.status.message || '查看 failure.json'),
      );
  } catch (e) {
    error(e.message);
  } finally {
    busy = false;
  }
}
function renderEvents() {
  const node = $('events');
  node.replaceChildren();
  for (const e of (runData.events || []).slice(-12).reverse()) {
    const div = element(
      'div',
      `${e.elapsedSeconds.toFixed(1)}s · ${e.event}${e.iteration ? ' · 第 ' + e.iteration + ' 轮' : ''}`,
      'event',
    );
    if (e.event === 'validation') {
      div.append(
        document.createTextNode(
          ` · 侧偏 ${e.rl.meanLateralAbsMeters.toFixed(4)}m · 前进 ${e.rl.meanForwardMeters.toFixed(4)}m`,
        ),
      );
      const b = element('button', '定位该轮验证');
      b.onclick = async () => {
        $('trace-mode').value = 'validation-rl';
        refreshTraceOptions();
        $('trace-iteration').value = 'iter-' + String(e.iteration).padStart(5, '0');
        chooseTab('inspect');
        await loadTrace(true);
      };
      div.append(b);
    }
    node.append(div);
  }
}
function refreshTraceOptions() {
  const mode = $('trace-mode').value;
  refreshOptions($('trace-iteration'), mode === 'training' ? runData.traces : runData.validation);
  $('case-label').hidden = mode === 'training';
}
async function loadTrace(force = true) {
  if (!runData) return;
  const mode = $('trace-mode').value,
    n = $('trace-iteration').value,
    ci = Number($('trace-case').value),
    key = [current, mode, n, ci].join(':');
  if (!n) {
    frames = [];
    $('trace-hint').textContent = '该运行没有这一类片段。历史缺项不会补造。';
    drawFrame();
    return;
  }
  if (!force && key === lastTraceKey) return;
  const id = current;
  const d = await api(
    `/api/run/${encodeURIComponent(id)}/${mode === 'training' ? 'traces' : 'validation'}/${n}`,
  );
  if (id !== current) return;
  if (!d) return;
  lastTraceKey = key;
  stopPlayback();
  if (mode === 'training') {
    frames = d.frames;
    $('trace-hint').textContent =
      `第 ${d.iteration} 轮 · 环境 0 的连续训练片段；可能跨越回合重置。不是评测成功率。`;
  } else {
    const row = d[mode === 'validation-rl' ? 'rl' : 'reference'].cases[ci];
    frames = row.frames;
    $('trace-hint').textContent =
      `第 ${d.iteration} 轮 · 固定开发案例 ${ci} · 左右增益差 ${row.asymmetry} · 初始偏航 ${row.initial_yaw} rad · ${row.fallen ? '跌倒' : '未跌倒'}。`;
  }
  $('frame').max = Math.max(frames.length - 1, 0);
  $('frame').value = 0;
  selectedFrame = 0;
  refreshOptions($('joint'), frames[0]?.jointNames || []);
  drawFrame();
}
function stopPlayback() {
  if (timer) clearInterval(timer);
  timer = null;
  $('play').textContent = '播放回放';
}
function drawSkeleton(frame) {
  const { ctx, w, h } = setupCanvas('skeleton');
  if (!frame?.bodyPositions) {
    ctx.fillStyle = '#62748a';
    ctx.fillText('选择已记录的训练或验证片段', 20, h / 2);
    return;
  }
  const poses = frame.bodyPositions,
    origin = poses.body_link;
  const to2 = (p) => [
    w / 2 + (p[0] - origin[0]) * 0.8 * 650 + (p[1] - origin[1]) * 0.7 * 650,
    h - 20 - p[2] * 650,
  ];
  ctx.strokeStyle = '#dce4ec';
  ctx.beginPath();
  ctx.moveTo(10, h - 20);
  ctx.lineTo(w - 10, h - 20);
  ctx.stroke();
  for (const [si, s] of ['l', 'r'].entries()) {
    const chain = [
      'body_link',
      ...['hip_roll', 'hip_pitch', 'knee', 'ank_pitch', 'ank_roll'].map(
        (n) => s + '_' + n + '_link',
      ),
    ];
    ctx.strokeStyle = colors[si];
    ctx.fillStyle = colors[si];
    ctx.lineWidth = 5;
    ctx.beginPath();
    chain.forEach((n, i) => {
      const [x, y] = to2(poses[n]);
      if (!i) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    for (const n of chain) {
      const [x, y] = to2(poses[n]);
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.fillStyle = '#62748a';
  ctx.fillText('骨架由本帧 bodyPositions 绘制，无合成运动', 10, 14);
}
function drawTrajectory() {
  const { ctx, w, h } = setupCanvas('trajectory');
  if (!frames.length) return;
  const xs = frames.map((f) => f.x),
    ys = frames.map((f) => f.y),
    xmin = Math.min(0, ...xs),
    xmax = Math.max(0.1, ...xs),
    ymin = Math.min(-0.04, ...ys),
    ymax = Math.max(0.04, ...ys),
    scale = Math.min((w - 60) / (xmax - xmin), (h - 50) / (ymax - ymin));
  const p = (x, y) => [30 + (x - xmin) * scale, h / 2 - y * scale];
  ctx.strokeStyle = '#b9c8d5';
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(...p(xmin, 0));
  ctx.lineTo(...p(xmax, 0));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = colors[0];
  ctx.lineWidth = 2;
  ctx.beginPath();
  frames.forEach((f, i) => {
    const pos = p(f.x, f.y);
    if (i === 0 || f.episodeIndex !== frames[i - 1].episodeIndex) ctx.moveTo(...pos);
    else ctx.lineTo(...pos);
  });
  ctx.stroke();
  const f = frames[selectedFrame];
  ctx.fillStyle = colors[1];
  ctx.beginPath();
  ctx.arc(...p(f.x, f.y), 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#62748a';
  ctx.fillText(`前进 x；比例尺：10 cm = ${(scale * 0.1).toFixed(0)} px`, 15, 15);
}
function drawFrame() {
  const f = frames[selectedFrame];
  drawSkeleton(f);
  drawTrajectory();
  if (!f) {
    metricCards($('frame-values'), []);
    plot('tracking', []);
    return;
  }
  metricCards($('frame-values'), [
    ['回合时间', f.time.toFixed(2) + ' s'],
    ['前进', f.x.toFixed(3) + ' m'],
    ['侧向位置', f.y.toFixed(3) + ' m'],
    ['航向', ((f.yaw * 180) / Math.PI).toFixed(2) + '°'],
    ['足底接触', `${f.footContacts[0] ? '左' : '—'} / ${f.footContacts[1] ? '右' : '—'}`],
  ]);
  const j = (f.jointNames || []).indexOf($('joint').value);
  plot(
    'tracking',
    [
      { name: '目标 rad', points: frames.map((r, i) => [i, r.jointTarget[j]]) },
      { name: '实际 rad', points: frames.map((r, i) => [i, r.jointPosition[j]]) },
    ],
    '片段帧序号',
  );
  const node = $('frame-rewards');
  node.replaceChildren();
  for (const [k, v] of Object.entries(f.rewardTerms || {}))
    node.append(element('span', `${rewardNames[k] || k} ${v.toFixed(5)}`));
}
function showDiff() {
  try {
    const edited = JSON.parse($('config').value),
      changes = [];
    function compare(a, b, path = '') {
      for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
        const x = a?.[k],
          y = b?.[k],
          p = path ? path + '.' + k : k;
        if (x && y && typeof x === 'object' && typeof y === 'object') compare(x, y, p);
        else if (JSON.stringify(x) !== JSON.stringify(y)) changes.push([p, x, y]);
      }
    }
    compare(runData?.experiment || {}, edited);
    $('diff').replaceChildren();
    if (!changes.length)
      $('diff').append(
        element('p', '尚无配置变化。新运行仍会拥有独立编号、随机过程和证据。', 'subtle'),
      );
    for (const [k, a, b] of changes) {
      const d = element('div');
      d.append(element('code', k), element('span', JSON.stringify(a) + ' → ' + JSON.stringify(b)));
      $('diff').append(d);
    }
    $('create').disabled = false;
  } catch (e) {
    $('diff').textContent = 'JSON 格式错误：' + e.message;
    $('create').disabled = true;
  }
}
function renderIdentity() {
  const id = runData.identity,
    node = $('identity');
  node.replaceChildren();
  if (!id) {
    node.append(element('p', '历史运行没有起始时的完整源码快照，不能事后补成完整溯源。'));
    $('source-files').replaceChildren();
    return;
  }
  for (const [label, value] of [
    ['运行编号', id.runId],
    ['父运行', id.parent || '无'],
    ['配置 SHA256', id.experimentSha256],
    ['场景 SHA256', id.sceneSha256],
    ['原模型包 SHA256', id.sourceModelSha256 || '未记录'],
    ['初始化权重 SHA256', id.warmStartSha256 || '重新初始化'],
    ['模型网格', Object.keys(id.meshSha256).length + ' 个文件已记录指纹'],
    ['源码快照', Object.keys(id.sourceSha256).length + ' 个文件'],
    ['限制', '仅仿真；未完成硬件标定'],
  ]) {
    node.append(
      element('span', label),
      element('code', typeof value === 'string' ? value : JSON.stringify(value)),
    );
  }
  refreshOptions($('source-files'), Object.keys(id.sourceSha256));
}
async function source(file, line) {
  chooseTab('provenance');
  const d = await api(`/api/run/${encodeURIComponent(current)}/source/${encodeURIComponent(file)}`);
  const pre = $('source');
  pre.replaceChildren();
  d.text.split('\n').forEach((text, i) => {
    const row = element('span', null, 'line' + (i + 1 === line ? ' highlight' : ''));
    row.append(element('span', i + 1, 'number'), document.createTextNode(text));
    pre.append(row);
  });
  if (line) pre.scrollTop = Math.max(0, (line - 5) * 19);
}
$('refresh').onclick = () => refreshRuns().catch((e) => error(e.message));
document
  .querySelectorAll('nav button')
  .forEach((b) => (b.onclick = () => chooseTab(b.dataset.tab)));
$('metric').onchange = drawOverview;
$('physical-metric').onchange = drawOverview;
$('trace-mode').onchange = () => {
  refreshTraceOptions();
  loadTrace().catch((e) => error(e.message));
};
$('trace-iteration').onchange = $('trace-case').onchange = () =>
  loadTrace().catch((e) => error(e.message));
$('frame').oninput = () => {
  selectedFrame = Number($('frame').value);
  drawFrame();
};
$('joint').onchange = drawFrame;
$('play').onclick = () => {
  if (timer) {
    stopPlayback();
    return;
  }
  if (!frames.length) return;
  $('play').textContent = '暂停回放';
  timer = setInterval(
    () => {
      selectedFrame = (selectedFrame + 1) % frames.length;
      $('frame').value = selectedFrame;
      drawFrame();
    },
    $('trace-mode').value === 'training' ? 20 : 100,
  );
};
$('config').oninput = showDiff;
$('export').onclick = () => {
  try {
    const d = JSON.stringify(JSON.parse($('config').value), null, 2);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([d], { type: 'application/json' }));
    a.download = 'originman-experiment.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (e) {
    error(e.message);
  }
};
$('create').onclick = async () => {
  try {
    $('create').disabled = true;
    error('');
    const body = {
      parent: current,
      experiment: JSON.parse($('config').value),
      checkpoint: $('warm-start').value || null,
    };
    const result = await api('/api/fork', body);
    await selectRun(result.id);
    chooseTab('overview');
  } catch (e) {
    error(e.message);
  } finally {
    $('create').disabled = false;
  }
};
$('stop').onclick = async () => {
  try {
    await api('/api/stop', { id: current });
    await refreshData();
  } catch (e) {
    error(e.message);
  }
};
$('verify').onclick = async () => {
  try {
    $('verify').disabled = true;
    const d = await api('/api/run/' + encodeURIComponent(current) + '/verify');
    $('verification').textContent = d.verified
      ? `本地完整性校验通过，已核对 ${d.checked} 个文件。不是独立签证或真机放行。`
      : `未通过：${d.reason || d.mismatches?.join(', ')}；已检查 ${d.checked} 个文件。`;
  } catch (e) {
    error(e.message);
  } finally {
    $('verify').disabled = false;
  }
};
$('view-source').onclick = () => source($('source-files').value).catch((e) => error(e.message));
$('reward-source').onclick = () => {
  const loc = runData?.identity?.sourceLocations?.reward;
  if (loc) source(loc.file, loc.line).catch((e) => error(e.message));
  else error('历史运行没有奖励源码定位信息。');
};
window.addEventListener('resize', () => {
  if (selectedTab === 'overview') drawOverview();
  if (selectedTab === 'inspect') drawFrame();
});
refreshRuns().catch((e) => error(e.message));
setInterval(() => {
  if (!document.hidden) refreshData();
}, 2000);
