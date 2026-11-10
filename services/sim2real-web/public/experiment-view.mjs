/** Shared native/web experiment surface. Only explicit, owner-authorized Run IDs are read. */
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/;
const statusLabels = { queued: '排队中', running: '进行中', completed: '已完成', failed: '失败', blocked: '受阻', cancelled: '已取消' };
export function rewardPoints(run) {
  return (Array.isArray(run?.progress) ? run.progress : []).filter(p =>
    Number.isFinite(p.iteration) && Number.isFinite(p.meanReward)).slice(-1000);
}
export function comparisonRows(run) {
  const suites = run?.metrics?.originmanWorkshop?.feedbackComparison?.suites;
  if (!Array.isArray(suites)) return [];
  return suites.slice(0, 10).flatMap(s => {
    if (!Array.isArray(s.cases) || !s.cases.length || s.cases.some(c =>
      !Number.isFinite(c.force) || !['original', 'tuned', 'rl'].every(k => typeof c[k] === 'boolean'))) return [];
    const pushed = s.cases.filter(c => c.force !== 0);
    const standing = s.cases.filter(c => c.force === 0);
    const counts = cases => ['original', 'tuned', 'rl'].map(k => cases.filter(c => c[k]).length);
    if (!pushed.length) return [];
    return [{ label: s.id === 'historical' ? '公开条件组' : s.id === 'additional' ? '补充条件组' : '评测条件组',
      count: pushed.length, values: counts(pushed), standing: { count: standing.length, values: counts(standing) } }];
  });
}

export function experimentFilename(contextId, extension) {
  if (!idPattern.test(contextId ?? '') || !['json', 'webm', 'mp4'].includes(extension)) throw Error('实验文件标识无效');
  return `OriginMan-${contextId}-evaluation.${extension}`;
}

export async function startExperimentView({ document, location, fetchImpl = fetch, EventSourceImpl = globalThis.EventSource, onExport, openPlayback } = {}) {
  const $ = id => document.getElementById(id);
  const playButton = $('play-experiment-video');
  const contextId = new URL(location.href).searchParams.get('context');
  const base = new URL('./api/v1/duck/', location.href);
  const back = $('return-workshop');
  if (back && idPattern.test(contextId ?? '')) back.href = new URL('workshop.html?context=' + encodeURIComponent(contextId), location.href).href;
  let view = null, stream = null, active = false, pending = false, disposed = false, generation = 0, refreshTimer = null;
  let trainingId = null, evaluationId = null, latestRecord = null, curvePoints = [], curveUnit = '训练步';
  const terminal = () => view && (['failed', 'blocked', 'cancelled', 'canceled'].includes(view.training?.status) ||
    view.training?.status === 'completed' && ['completed', 'failed', 'blocked', 'cancelled', 'canceled'].includes(view.evaluation?.status));
  const listeners = [];
  const listen = (id, type, callback) => { $(id).addEventListener(type, callback); listeners.push(() => $(id).removeEventListener(type, callback)); };
  const clearResults = () => {
    $('reward-chart').replaceChildren(); $('reward-chart').setAttribute('hidden', ''); $('curve-empty').hidden = false;
    $('curve-reading').hidden = true;
    $('comparison-body').replaceChildren(); $('comparison-table').hidden = true; $('comparison-empty').hidden = false;
    $('recovery-summary').replaceChildren();
    $('recovery-summary').hidden = true;
    $('comparison-details').hidden = true;
    $('comparison-details').open = false;
    $('replay-shortcut').hidden = true;
    $('experiment-video').hidden = true; $('experiment-video').removeAttribute('src');
    if (playButton) {
      playButton.hidden = true;
      playButton.textContent = '播放本次回放';
    }
    $('download-video').hidden = true; $('export-experiment').disabled = true;
    $('open-playback-page').hidden = true;
    $('video-empty').hidden = false; $('playback-status').textContent = '尚未播放';
    $('curve-caption').textContent = '等待真实训练数据'; latestRecord = null;curvePoints=[];$('curve-inspector').hidden=true;
  };
  const fail = error => {
    clearResults();
    $('experiment-error').hidden = false; $('experiment-error').textContent = error.message;
    $('connection-status').textContent = '连接需处理';
    $('login-platform').hidden = error.status !== 401;
    $('association-status').textContent = '待验证';
    $('training-status').textContent = '待验证'; $('evaluation-status').textContent = '待验证';
    $('quality-status').textContent = '效果尚未验证';
  };
  const json = async suffix => {
    const response = await fetchImpl(new URL(suffix, base), { credentials: 'same-origin', headers: { accept: 'application/json' }, redirect: 'error' });
    if (!response.ok) throw Object.assign(Error(response.status === 401 ? '请先在学习平台登录同一账号，再恢复本次实验。' : response.status === 404 ? '当前账号下未找到此实验，保留原任务，不自动选择其他实验。' : '本次实验暂不可读，请稍后刷新原实验。'), { status: response.status });
    return response.json();
  };
  const applyView = candidate => {
    if (!candidate || candidate.contextId !== contextId || !idPattern.test(candidate.training?.runId ?? '') ||
      candidate.evaluation && !idPattern.test(candidate.evaluation.runId ?? '') ||
      trainingId && trainingId !== candidate.training.runId ||
      evaluationId && evaluationId !== candidate.evaluation?.runId)
      throw Error('实验来源发生变化；已停止显示，不自动切换任务。');
    trainingId = candidate.training.runId; evaluationId = candidate.evaluation?.runId ?? null; view = candidate;
    $('evidence-scope').textContent = view.evidence === 'fixture' ? '本地测试数据 · 不代表训练结果' :
      view.evidence === 'real-worker' ? '本次实验 · 仅仿真' : '仅仿真 · 执行来源待验证';
    $('training-status').textContent = statusLabels[view.training.status] ?? '待验证';
    $('evaluation-status').textContent = view.evaluation ? statusLabels[view.evaluation.status] ?? '待验证' : '尚未开始';
    $('association-status').textContent = view.associationVerified ? '已核对' : '待验证';
    $('next-action').textContent = view.nextAction;
    for (const phase of ['training', 'evaluation', 'results']) {
      if (phase === view.stage) $('step-' + phase).setAttribute('aria-current', 'step');
      else $('step-' + phase).removeAttribute('aria-current');
    }
    $('experiment-diagnostics').textContent = JSON.stringify(view, null, 2);
  };
  const inspectCurve = () => {const point=curvePoints[Number($('curve-sample').value)];if(point)$('curve-value').textContent=`${point.iteration} ${curveUnit} · 平均奖励 ${point.meanReward.toFixed(3)}`;};
  listen('curve-sample','input',inspectCurve);
  const drawCurve = run => {
    const points = rewardPoints(run); const chart = $('reward-chart'); chart.replaceChildren();
    chart.toggleAttribute('hidden', points.length === 0); $('curve-empty').hidden = points.length !== 0;
    $('curve-inspector').hidden=!points.length;curvePoints=points;curveUnit=run?.training?.originmanWorkshop||run?.metrics?.originmanWorkshop?'训练步':'记录步';$('curve-sample').max=String(Math.max(0,points.length-1));$('curve-sample').value=String(Math.max(0,points.length-1));inspectCurve();
    const reading = $('curve-reading');
    reading.hidden = !points.length;
    if (!points.length) {
      $('curve-caption').textContent = '等待真实训练数据';
      return;
    }
    const rewards = points.map(p => p.meanReward); const low = Math.min(...rewards), high = Math.max(...rewards);
    const left = 64, right = 696, top = 16, bottom = 208;
    const max = Math.max(1, ...points.map(p => p.iteration));
    const x = v => left + v / max * (right - left);
    const y = v => bottom - (v - low) / Math.max(1, high - low) * (bottom - top);
    const svg = (tag, attributes, text) => { const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const [k, v] of Object.entries(attributes)) e.setAttribute(k, String(v));
      if (text !== undefined) e.textContent = text; chart.append(e); return e; };
    svg('path', { class: 'reward-axis', d: `M${left} ${top}V${bottom}H${right}`, fill: 'none' });
    svg('polyline', { class: 'reward-line', points: points.map(p => `${x(p.iteration)},${y(p.meanReward)}`).join(' ') });
    svg('text', { class: 'reward-label', x: 8, y: 20 }, high.toFixed(1));
    svg('text', { class: 'reward-label', x: 8, y: bottom }, low.toFixed(1));
    svg('text', { class: 'reward-label', x: left, y: 232 }, '0');
    svg('text', { class: 'reward-label', x: right, y: 232, 'text-anchor': 'end' }, max + ' ' + curveUnit);
    const latest = points.at(-1);
    const previous = points.at(-2);
    const summary = previous
      ? `最后一个采样点在 ${latest.iteration} ${curveUnit}，平均奖励从上一点的 ${previous.meanReward.toFixed(3)} 变为 ${latest.meanReward.toFixed(3)}。本轮已显示的峰值是 ${high.toFixed(3)}。`
      : `目前只采到一笔，平均奖励是 ${latest.meanReward.toFixed(3)}。`;
    reading.textContent = summary + (points.length <= 5 ? ' 采样较少，先别据此判断趋势。' : '') +
      ' 奖励反映训练过程。遇到侧推能恢复几次，要看上方同条件评测。';
    $('curve-caption').textContent = (view.evidence === 'fixture' ? '测试数据 · ' : '引擎记录 · ') + points.length + ' 个采样点';
  };
  const drawComparison = run => {
    const rows = view.associationVerified ? comparisonRows(run) : [];
    $('comparison-body').replaceChildren(); $('comparison-table').hidden = !rows.length; $('comparison-empty').hidden = Boolean(rows.length);
    $('recovery-summary').replaceChildren();
    $('recovery-summary').hidden = !rows.length;
    $('comparison-details').hidden = !rows.length;
    $('quality-status').textContent =
      !rows.length || view.clearGain == null ? '效果尚未验证' :
        view.clearGain ? '本轮达到改善标准' : '本轮未达到改善标准';
    const describeDifference = (name, difference) =>
      difference === 0 ? `与${name}持平` :
        `比${name}${difference > 0 ? '多' : '少'}恢复 ${Math.abs(difference)} 次`;
    for (const row of rows) {
      const [original, tuned, recovered] = row.values;
      const item = document.createElement('li');
      const headline = document.createElement('strong');
      headline.textContent = `${row.label}受扰恢复 ${recovered} / ${row.count} 次`;
      item.append(
        headline,
        `，${row.count - recovered} 个条件未恢复。` +
          `${describeDifference('原 PD', recovered - original)}，` +
          `${describeDifference('调参反馈', recovered - tuned)}。`,
      );
      if (row.standing.count) item.append(` 无扰站立：原 PD ${row.standing.values[0]}、调参反馈 ${row.standing.values[1]}、本次 RL ${row.standing.values[2]} / ${row.standing.count}（不计入受扰恢复）。`);
      $('recovery-summary').append(item);
      const tr = document.createElement('tr');
      for (const value of [row.label, ...row.values.map(v => `${v} / ${row.count}`)]) {
        const td = document.createElement('td'); td.textContent = value; tr.append(td);
      }
      $('comparison-body').append(tr);
    }
  };
  const refresh = async () => {
    if (disposed || !idPattern.test(contextId ?? '')) return;
    if (active) { pending = true; return; }
    clearTimeout(refreshTimer);
    active = true; const current = ++generation;
    try {
      const state = await json('experiments/' + encodeURIComponent(contextId));
      if (disposed || current !== generation) return;
      applyView(state.view);
      // Exact Run reads also let existing platform adapters refresh their worker status.
      const training = (await json('runs/' + encodeURIComponent(view.training.runId))).run;
      const evaluation = view.evaluation ? (await json('runs/' + encodeURIComponent(view.evaluation.runId))).run : null;
      if (disposed || current !== generation) return;
      if (training?.id !== view.training.runId || evaluation && evaluation.id !== view.evaluation?.runId)
        throw Error('平台返回的任务与本次实验不一致。');
      if (view.associationVerified && (training.metrics?.originmanWorkshop?.policySha256 !== view.policySha256 ||
        evaluation?.metrics?.originmanWorkshop?.policySha256 !== view.policySha256 ||
        evaluation?.metrics?.originmanWorkshop?.sourceRunId !== training.id))
        throw Error('本次对比的父任务或权重摘要不一致，停止显示结果。');
      drawCurve(training); drawComparison(evaluation);
      $('open-playback-page').hidden = true;
      if (view.videoRecorded && view.associationVerified && evaluation?.id && openPlayback) {
        $('experiment-video').hidden = true; $('experiment-video').removeAttribute('src');
        $('video-empty').hidden = false; $('video-empty').textContent = '在学习平台播放器播放本次回放。';
        $('open-playback-page').hidden = false; $('download-video').hidden = true;
      } else if (view.videoRecorded && view.associationVerified && evaluation?.id) {
        const url = new URL('runs/' + encodeURIComponent(evaluation.id) + '/workshop-video?format=webm', base).href;
        if ($('experiment-video').getAttribute('src') !== url) $('experiment-video').setAttribute('src', url);
        $('experiment-video').hidden = false; $('video-empty').hidden = true;
        $('download-video').href = url; $('download-video').download = experimentFilename(contextId, 'webm'); $('download-video').hidden = false;
      } else { $('experiment-video').hidden = true; $('experiment-video').removeAttribute('src'); $('download-video').hidden = true; $('video-empty').hidden = false; }
      latestRecord = { schemaVersion: 1, observedAt: new Date().toISOString(), experiment: view, training, evaluation, comparison: comparisonRows(evaluation) };
      if (playButton) playButton.hidden = $('experiment-video').hidden;
      $('replay-shortcut').hidden = $('experiment-video').hidden && $('open-playback-page').hidden;
      $('export-experiment').disabled = false;
      $('experiment-error').hidden = true; $('login-platform').hidden = true;
      $('connection-status').textContent = '已连接本次实验';
      if (terminal()) { stream?.close(); stream = null; }
      // Worker adapters currently refresh on exact Run reads. Keep this in the view,
      // rather than spending a model turn narrating each poll. Terminal views stop.
      if (['queued', 'running'].includes(view.training.status) || ['queued', 'running'].includes(view.evaluation?.status))
        refreshTimer = setTimeout(() => { void refresh(); }, 5000);
    } catch (error) { if (!disposed) fail(error); }
    finally { active = false; if (pending && !disposed) { pending = false; void refresh(); } }
  };
  if (playButton) listen('play-experiment-video', 'click', () => {
    const video = $('experiment-video');
    if (video.hidden || !video.getAttribute('src')) return;
    if (!video.paused) {
      video.pause();
      return;
    }
    void video.play().catch(() => { $('playback-status').textContent = '回放暂不可用，可稍后再试'; });
  });
  listen('experiment-video', 'playing', () => {
    $('playback-status').textContent = '正在播放本次回放';
    if (playButton) playButton.textContent = '暂停回放';
  });
  listen('experiment-video', 'ended', () => {
    $('playback-status').textContent = '本次回放已结束';
    if (playButton) playButton.textContent = '重新播放';
  });
  listen('experiment-video', 'pause', () => {
    const video = $('experiment-video');
    if (!video.ended && video.currentTime > 0) {
      $('playback-status').textContent = '已暂停回放';
      if (playButton) playButton.textContent = '继续播放';
    }
  });
  listen('experiment-video', 'error', () => { $('playback-status').textContent = '回放暂不可用；保留原评测'; });
  listen('refresh-experiment', 'click', refresh);
  listen('open-playback-page', 'click', () => { if (openPlayback) void openPlayback(); });
  listen('export-experiment', 'click', () => {
    if (!latestRecord) return;
    if (onExport) { onExport(latestRecord); return; }
    const url = URL.createObjectURL(new Blob([JSON.stringify(latestRecord, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = experimentFilename(contextId, 'json'); a.click(); URL.revokeObjectURL(url);
  });
  if (!idPattern.test(contextId ?? '')) fail(Error('需要通过插件打开明确实验，不会自动选择最近任务。'));
  else {
    await refresh();
    if (view && EventSourceImpl && !terminal()) {
      stream = new EventSourceImpl(new URL('experiments/' + encodeURIComponent(contextId) + '/events', base));
      for (const type of ['snapshot', 'reset']) stream.addEventListener(type, () => { void refresh(); });
      stream.addEventListener('open', () => { if (!disposed && view && !terminal()) $('connection-status').textContent = '已连接本次实验'; });
      stream.addEventListener('unavailable', () => { if (!disposed && !terminal()) $('connection-status').textContent = '连接中断，正在接续原实验'; });
      stream.addEventListener('error', () => { if (!disposed && !terminal()) $('connection-status').textContent = '正在重连原实验'; });
    }
  }
  return { refresh, dispose() {
    disposed = true; generation++; clearTimeout(refreshTimer); stream?.close();
    for (const remove of listeners.splice(0)) remove();
    clearResults(); $('training-status').textContent = '待连接'; $('evaluation-status').textContent = '待连接';
    $('association-status').textContent = '待验证'; $('quality-status').textContent = '效果尚未验证';
    $('experiment-diagnostics').textContent = '尚未取得明确实验。';
  } };
}
