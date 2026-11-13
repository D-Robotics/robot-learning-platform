const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/;
const digest = /^[a-f0-9]{64}$/;
const gateId = 'originman-dance-squat-descent-ascent-v1';
const movements = {
  'weight-shift': '左右换重心',
  'squat-rise': '下蹲起身',
  'alternating-arms': '交替摆臂',
  'open-pose': '展开定格',
};

const currentSquat = [
  ['squatDescentM', '下蹲深度', 0.024, 'mm'],
  ['squatAscentM', '起身高度', 0.024, 'mm'],
];
const gates = {
  'weight-shift': [
    ['lateralRangeM', '横向位移跨度', 0.035, 'mm'],
    ['lateralTrackingFraction', '横向跟踪帧占比', 0.62, '%'],
  ],
  'squat-rise': [
    ['riseAndDipCorrelation', '躯干高度与参考曲线相关性', 0.55, ''],
    ['armSweepM', '双手前后跨度', 0.06, 'mm'],
  ],
  'alternating-arms': [
    ['armAsymmetryRangeM', '左右手前后差峰谷跨度', 0.09, 'mm'],
    ['alternatingArmFraction', '交替摆臂达标帧占比', 0.65, '%'],
    ['armBeatCorrelation', '摆臂速度与节拍相关性', 0.20, ''],
  ],
  'open-pose': [
    ['holdStillFraction', '定格静止帧占比', 0.83, '%'],
    ['meanHoldHandSpanM', '双手平均横向间距', 0.32, 'mm'],
    ['holdPeakTiltDeg', '定格最大倾角', 9, '°', '<'],
  ],
};

function format(value, unit) {
  if (!Number.isFinite(value)) return '未记录';
  if (unit === 'mm') return `${+(value * 1000).toFixed(2)} mm`;
  if (unit === '%') return `${+(value * 100).toFixed(2)}%`;
  return `${+value.toFixed(4)}${unit}`;
}

function gateRows(type, values, current) {
  if (type === 'squat-rise') {
    const legacy = !current && Number.isFinite(values?.heightRangeM) &&
      !Object.hasOwn(values, 'squatDescentM') && !Object.hasOwn(values, 'squatAscentM');
    return { legacy, rows: [...(legacy ? [['heightRangeM', '躯干高度峰谷差', 0.024, 'mm']] : currentSquat),
      ...gates[type], ...(!legacy ? [['heightRangeM', '躯干高度峰谷差（诊断）', null, 'mm']] : [])] };
  }
  return { legacy: false, rows: gates[type] ?? [] };
}

function verifiedOriginalVideo(run, base) {
  const evidence = run.metrics?.originmanDance;
  const video = evidence?.video;
  if (!digest.test(video?.sha256 ?? '') || !digest.test(run.artifact?.sha256 ?? '') ||
      !digest.test(evidence?.replay?.sha256 ?? '') || video.policySha256 !== run.artifact.sha256 ||
      video.sourceReplaySha256 !== evidence.replay.sha256) return null;
  return new URL(`./api/v1/duck/runs/${encodeURIComponent(run.id)}/dance-video`, base);
}

export async function loadDanceResults({ document, location, fetchImpl = fetch }) {
  const status = document.getElementById('dance-results-status');
  const login = document.getElementById('dance-results-login');
  const url = new URL(location.href);
  const ids = url.searchParams.getAll('run');
  const independent = url.searchParams.get('mode') === 'independent';
  const comparison = ids.length === 2;
  const focus = Number(url.searchParams.get('section')) || 3;
  document.getElementById('dance-results-title').textContent =
    comparison ? '两轮舞蹈对比' : '独立舞蹈评测';
  const make = (tag, text) => {
    const element = document.createElement(tag);
    if (text != null) element.textContent = text;
    return element;
  };
  const link = (href, title) => Object.assign(make('a', title), { href });
  const api = (id, suffix = '') => new URL(`./api/v1/duck/runs/${encodeURIComponent(id)}${suffix}`, url);
  async function read(href) {
    const reply = await fetchImpl(href, { credentials: 'same-origin', cache: 'no-store' });
    if (!reply.ok) {
      const error = new Error('当前账号无法读取全部指定记录或独立评测。');
      error.status = reply.status;
      throw error;
    }
    return reply.json();
  }

  if (ids.length < 1 || ids.length > 2 || new Set(ids).size !== ids.length ||
      ids.some(id => !idPattern.test(id)) || (!comparison && !independent)) {
    status.textContent = '链接需要一条独立评测来源，或两条不同的舞蹈训练记录。';
    return;
  }
  let data;
  try {
    data = await Promise.all(ids.map(async (id) => {
      const { run } = await read(api(id));
      const dance = run?.training?.originmanDance;
      if (run?.id !== id || run.status !== 'completed' || run.mock !== false ||
          run.taskId !== 'originman-dance' || !Array.isArray(dance?.sections))
        throw new Error('平台未返回链接指定的已完成舞蹈训练。');
      const report = independent ? (await read(api(id, '/dance-evaluation'))).evaluation :
        run.metrics?.originmanDance;
      if (!Array.isArray(report?.evaluations) || (independent &&
          (report.source?.runId !== id || report.source?.policySha256 !== run.artifact?.sha256 ||
           report.source?.gate !== gateId)))
        throw new Error('评测来源无法核对。');
      const nominal = report.evaluations.find(row => row.bpm === dance.bpm);
      if (!nominal || nominal.sections?.length !== dance.sections.length ||
          nominal.sections.some((row, index) => row.type !== dance.sections[index].type))
        throw new Error('标称节拍评测与本轮舞段不一致。');
      const replay = independent && digest.test(report.replay?.videoSha256 ?? '') ?
        api(id, '/dance-evaluation/replay') : independent ? null : verifiedOriginalVideo(run, url);
      return { id, run, dance, report, nominal, replay,
      };
    }));
  } catch (error) {
    status.textContent = error.status === 401 ? '请登录后读取评测。' : error.message;
    if (error.status === 401) {
      const target = new URL('./login', url);
      target.searchParams.set('returnTo', url.pathname + url.search + url.hash);
      login.href = target.href;
      login.hidden = false;
    }
    return;
  }

  const summary = document.getElementById('dance-results-summary');
  const sections = document.getElementById('dance-results-sections');
  const replays = document.getElementById('dance-results-replays');
  status.textContent = independent ? '独立仿真使用原训练的 ONNX（策略文件）和编舞。以下实测值取自标称节拍。' :
    '以下实测值取自各原训练记录的标称节拍。原评测门槛和回放随各自的训练记录展示。';
  summary.append(make('p', '每段还须覆盖至少 95% 的预期采样帧，且无跌倒接触。'));
  if (comparison) {
    const same = data.every(({ dance }) => dance.bpm === data[0].dance.bpm &&
      JSON.stringify(dance.sections) === JSON.stringify(data[0].dance.sections));
    if (!same) summary.append(make('p', '两轮编舞或标称节拍不同。表中仍按各自原舞段显示，请按实际动作和门槛解读。'));
  }

  const label = ({ run, dance }, index) =>
    `${comparison ? (index ? '第二轮' : '第一轮') : '原训练'} · ${run.training.numEnvs ?? '—'} 环境 · ${dance.bpm} BPM（每分钟拍数）`;
  const players = [];
  data.forEach((item, index) => {
    const itemSummary = make('section');
    itemSummary.append(make('h2', label(item, index)));
    const training = item.run.metrics?.trainingSeconds;
    const elapsed = (Date.parse(item.run.finishedAt) - Date.parse(item.run.createdAt)) / 1000;
    const verdict = item.report.qualityGatePassed === true ? '达标' :
      item.report.qualityGatePassed === false ? '未达标' : '待核验';
    itemSummary.append(make('p',
      `种子 ${item.dance.seed ?? '—'} · 训练预算 ${item.dance.trainingSteps ?? '—'} 步 · 训练耗时 ${Number.isFinite(training) ? training.toFixed(1) + ' 秒' : '未记录'} · 总耗时 ${Number.isFinite(elapsed) && elapsed >= 0 ? elapsed.toFixed(1) + ' 秒' : '未记录'} · 整套评测 ${verdict}`));
    const source = new URL('./', url);
    source.searchParams.set('robot', 'originman');
    source.searchParams.set('trainingRun', item.id);
    source.hash = 'train/submit';
    itemSummary.append(link(source, '打开原训练的「Run 与进度」'));
    if (independent) {
      const technical = make('details');
      technical.append(make('summary', '策略与评测来源'), make('p', `策略 SHA-256（文件校验值） ${item.report.source.policySha256}`),
        make('p', `评测节拍 ${item.report.evaluations.map(row => +row.bpm.toFixed(2)).join(' / ')} BPM`));
      itemSummary.append(technical);
    }
    summary.append(itemSummary);
    const panel = make('section');
    panel.append(make('h2', `${label(item, index)}回放`));
    const note = make('p', item.replay ? '选择上方舞段可跳转到对应时间。' : '该轮暂无可核验的回放。');
    note.setAttribute('role', 'status');
    panel.append(note);
    const video = make('video');
    if (item.replay) {
      video.src = item.replay.href;
      video.controls = true;
      video.preload = 'none';
      video.playsInline = true;
      video.setAttribute('aria-label', `${label(item, index)}仿真回放`);
      panel.append(video);
    }
    replays.append(panel);
    let stopAt = 0;
    let pendingSeek;
    video.addEventListener('timeupdate', () => {
      if (stopAt && video.currentTime >= stopAt) {
        video.pause();
        stopAt = 0;
      }
    });
    const stop = () => { pendingSeek?.abort(); video.pause(); stopAt = 0; };
    const play = (number) => {
      const start = item.dance.sections.slice(0, number - 1).reduce((sum, row) => sum + row.beats, 0) * 60 / item.dance.bpm;
      const end = start + item.dance.sections[number - 1].beats * 60 / item.dance.bpm;
      players.forEach(player => { if (player.video !== video) player.stop(); });
      video.pause();
      pendingSeek?.abort();
      pendingSeek = new AbortController();
      const seek = () => {
        if (!Number.isFinite(video.duration) || start >= video.duration) {
          note.textContent = `回放未录到第 ${number} 段。`;
          return;
        }
        video.currentTime = start;
        stopAt = Math.min(end, video.duration);
        note.textContent = `第 ${number} 段 · ${start.toFixed(2)} 秒起`;
        void video.play().catch(() => { note.textContent += '，请点击播放。'; });
      };
      if (video.readyState >= 1) seek();
      else {
        video.addEventListener('loadedmetadata', seek, { once: true, signal: pendingSeek.signal });
        video.load();
      }
      video.scrollIntoView({ block: 'nearest' });
      video.focus({ preventScroll: true });
    };
    players.push({ video, stop, play });
  });
  const count = Math.max(...data.map(({ dance }) => dance.sections.length));
  for (let index = 0; index < count; index++) {
    const section = make('section');
    section.id = 'dance-section-' + (index + 1);
    section.append(make('h2', `第 ${index + 1} 段`));
    const table = make('table');
    const header = make('tr');
    for (const name of ['运行 / 动作', '判定', '实测值与达标门槛', '回放']) {
      const th = make('th', name);
      th.scope = 'col';
      header.append(th);
    }
    const head = make('thead');
    head.append(header);
    const body = make('tbody');
    table.append(head, body);
    const scroll = make('div');
    scroll.className = 'comparison-scroll';
    scroll.append(table);
    section.append(scroll);
    data.forEach((item, runIndex) => {
      const measured = item.nominal.sections[index];
      if (!measured) return;
      const row = make('tr');
      const type = movements[measured.type] ?? '未知动作';
      const verdict = measured.passed === true ? '达标' : measured.passed === false ? '未达标' : '待核验';
      const { rows, legacy } = gateRows(measured.type, measured.measurements, independent);
      const measures = make('td');
      const list = make('ul');
      for (const [key, name, threshold, unit, operator = '≥'] of rows) {
        list.append(make('li', `${name} ${format(measured.measurements?.[key], unit)}` +
          (threshold == null ? '' : `，门槛 ${operator}${format(threshold, unit)}`)));
      }
      measures.append(list);
      if (legacy) measures.append(make('p', '原评测使用高度峰谷差及旧版节拍参考曲线。'));
      const replay = make('td', item.replay ? null : '暂无可核验回放');
      if (item.replay) {
        const button = make('button', `播放第 ${index + 1} 段`);
        button.type = 'button';
        button.setAttribute('aria-label', `播放${label(item, runIndex)}第 ${index + 1} 段`);
        button.addEventListener('click', () => players[runIndex].play(index + 1));
        replay.append(button);
      }
      row.append(make('td', `${label(item, runIndex)} · ${type}`),
        make('td', `${verdict}${measured.clean === true ? ' · 完整完成' : measured.clean === false ? ' · 完整性检查未通过' : ''}`),
        measures, replay);
      body.append(row);
    });
    sections.append(section);
  }
  const focused = document.getElementById('dance-section-' + focus);
  if (focused) {
    focused.tabIndex = -1;
    focused.focus();
  }
}

if (typeof document !== 'undefined')
  void loadDanceResults({ document, location: window.location });
