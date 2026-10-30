(function (root) {
  'use strict';
  const ENGINE = 'originman-recovery';
  if (new URLSearchParams(root.location?.search || '').get('robot') === 'originman') {
    const panel = root.document?.getElementById('originman-workshop');
    if (panel) panel.open = true;
  }
  const active = (r) => r && ['queued', 'running'].includes(r.status);
  const labels = { reference: '参考站姿', 'imu-feedback': '基础反馈', untrained: '未训练', rl: '训练后 RL' };

  function chart(canvas, series, title) {
    if (!canvas || !series.length) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const style = getComputedStyle(document.documentElement);
    const color = (name) => style.getPropertyValue(name).trim();
    const palette = ['--muted', '--orange', '--violet', '--cyan'].map(color);
    const points = series.flatMap((s) => s.points);
    if (!points.length) return;
    const xmax = Math.max(1, ...points.map((p) => p[0]));
    const ymin = Math.min(0, ...points.map((p) => p[1]));
    const ymax = Math.max(ymin + 0.01, ...points.map((p) => p[1]));
    const measured = Math.round(canvas.getBoundingClientRect().width);
    if (measured > 0 && canvas.width !== measured) canvas.width = measured;
    const w = canvas.width, h = canvas.height;
    const columns = w < 760 ? 2 : 4;
    const plotTop = 55 + Math.ceil(series.length / columns) * 18;
    ctx.lineWidth = 1.5;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = color('--text');
    ctx.font = '16px sans-serif';
    ctx.fillText(title, 18, 24);
    ctx.font = '13px sans-serif';
    ctx.fillText(ymax.toFixed(2), 6, plotTop + 2);
    ctx.fillText(ymin.toFixed(2), 6, h - 26);
    ctx.fillText('0', 58, h - 6);
    ctx.fillText(xmax.toFixed(xmax > 100 ? 0 : 2), w - 70, h - 6);
    series.forEach((s, i) => {
      ctx.strokeStyle = palette[i % palette.length];
      ctx.fillStyle = palette[i % palette.length];
      ctx.fillText(s.name, 65 + (i % columns) * ((w - 80) / columns), 47 + Math.floor(i / columns) * 18);
      ctx.beginPath();
      s.points.forEach((p, j) => {
        const x = 65 + p[0] / xmax * (w - 95);
        const y = h - 30 - (p[1] - ymin) / (ymax - ymin) * (h - plotTop - 30);
        if (j) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      });
      ctx.stroke();
    });
  }

  function mount({ request, apiPath, getOverview }) {
    const $ = (id) => document.getElementById(id);
    const panel = $('originman-workshop');
    if (!panel) return;
    const form = $('originman-workshop-form');
    let catalog, runs = [], busy = false, loading = false, pending = null;
    let selected = '', selectedEvaluation = '', logRun = '', logAfter = 0, logLines = [];
    let resourceChosen = false;
    $('originman-resource').addEventListener('change', () => { resourceChosen = true; });
    const text = (id, value) => { $(id).textContent = value; };
    const selectedRun = () => runs.find((r) => r.id === selected);
    const evaluations = () => runs.filter((r) => r.training?.originmanWorkshop?.phase === 'evaluate' && r.training.originmanWorkshop.sourceRunId === selected);
    const status = (value) => text('originman-status', value);

    function options(select, choices, current, empty) {
      const values = choices.length ? choices : [{ value: '', label: empty }];
      if (select.options.length !== values.length || values.some((v, i) => select.options[i].value !== v.value || select.options[i].textContent !== v.label)) {
        select.replaceChildren(...values.map((v) => {
          const option = document.createElement('option'); option.value = v.value; option.textContent = v.label; return option;
        }));
      }
      select.value = current || values[0].value;
    }

    function render() {
      const reference = catalog?.reference;
      const referenceVideo = $('originman-reference-video');
      const referenceSrc = reference?.available === true && reference.source === 'instructor-reference' && reference.isUserTraining === false
        ? apiPath('/sim2real/workshops/originman/reference-video') : '';
      if (referenceVideo.getAttribute('src') !== referenceSrc) {
        if (referenceSrc) referenceVideo.src = referenceSrc; else referenceVideo.removeAttribute('src');
      }
      referenceVideo.hidden = !referenceSrc;
      text('originman-reference-note', referenceSrc
        ? `课前参考，非本组训练：${reference.title}。${reference.note}`
        : '课前参考材料未配置或未通过校验，请讲师补齐；不能用本组训练冒充参考结果。');
      const training = runs.filter((r) => r.training?.originmanWorkshop?.phase === 'train');
      if (!training.some((r) => r.id === selected)) selected = training[0]?.id || '';
      options($('originman-run'), training.map((r) => ({ value: r.id, label: `${r.label || r.id} · ${r.status}` })), selected, '尚无训练');
      const evaluated = evaluations();
      if (!evaluated.some((r) => r.id === selectedEvaluation)) selectedEvaluation = evaluated[0]?.id || '';
      options($('originman-evaluation'), evaluated.map((r) => ({ value: r.id, label: `${r.id} · ${r.status}` })), selectedEvaluation, '尚无评测');
      const run = selectedRun();
      const isActive = runs.some(active);
      $('originman-train').disabled = busy || isActive || (pending && pending.phase !== 'train');
      $('originman-train').textContent = pending?.phase === 'train' ? '重试同一训练提交' : '1. 创建本组训练';
      $('originman-evaluate').disabled = busy || isActive || run?.status !== 'completed' || (pending && pending.phase !== 'evaluate');
      $('originman-evaluate').textContent = pending?.phase === 'evaluate' ? '重试同一评测提交' : '2. 评测所选权重';
      for (const id of ['originman-steps', 'originman-seed', 'originman-force', 'originman-device', 'originman-resource', 'originman-run', 'originman-evaluation']) $(id).disabled = busy || Boolean(pending);
      const progress = run?.progress || [];
      $('originman-progress').hidden = !progress.length;
      if (progress.length) chart($('originman-progress-chart'), [{ name: '本组训练奖励', points: progress.map((p) => [p.iteration, p.meanReward]) }], '奖励 / 累计控制步');
      if (run) {
        const cfg = run.training.originmanWorkshop;
        const last = progress[progress.length - 1];
        text('originman-provenance', `训练 Run：${run.id} · ${run.status} · 请求 ${cfg.timesteps} 步${run.metrics?.originmanWorkshop ? ` / 实际 ${run.metrics.originmanWorkshop.actualTimesteps} 步 · 策略 ${run.metrics.originmanWorkshop.policySha256.slice(0, 12)}` : ''} · 训练设备 ${cfg.device || 'cpu（历史记录）'} ${run.metrics?.originmanWorkshop?.trainingDevice ? ` / 实际 ${run.metrics.originmanWorkshop.trainingDevice.parameterDevices.join(',')} · 梯度更新 ${run.metrics.originmanWorkshop.gradientUpdates}` : ''} · seed=${cfg.seed} · 训练侧推上限 ${cfg.pushMaxForce}N${last ? ` · 最近开发检查恢复 ${Math.round(last.recentSuccess * 9)}/9` : ''}。评测只读取所选 Run 的权重。`);
      }
      const assessment = evaluated.find((r) => r.id === selectedEvaluation);
      const result = assessment?.metrics?.originmanWorkshop;
      $('originman-comparison').hidden = !result?.cases;
      if (result?.cases) {
        text('originman-verdict', `基础 ${result.baselineRecovered}/31 → RL ${result.rlRecovered}/31；${result.clearGain ? '达到明显收益判据' : '本次未达明显收益判据，保留结果并分析'}。`);
        const improved = result.cases.filter((c) => !c.baseline && c.rl).map((c) => c.index);
        const regressed = result.cases.filter((c) => c.baseline && !c.rl).map((c) => c.index);
        const condition = result.cases[result.selectedCase];
        text('originman-comparison-note', `改善：${improved.join('、') || '无'}；退化：${regressed.join('、') || '无'}。曲线与回放为条件 ${condition.index}：${condition.force}N，${condition.start}s 开始、持续0.2s。优先选第一个改善条件，没有改善则展示条件3；全部31条件如下。恢复要求最后1秒稳定，不只是未倒。`);
        chart($('originman-tilt-chart'), result.traces.map((t) => ({ name: labels[t.controller], points: t.frames.map((f) => [f[0], f[1]]) })), '身体倾角（度）/ 仿真时间（秒）');
        const rl = result.traces.find((t) => t.controller === 'rl');
        chart($('originman-correction-chart'), [{ name: '实际额外踝目标', points: rl.frames.map((f) => [f[0], f[2]]) }, { name: '实际额外髋目标', points: rl.frames.map((f) => [f[0], f[3]]) }], 'RL 额外目标（rad）/ 时间（秒），不是实测角度');
        $('originman-cases').replaceChildren(...result.cases.map((c) => {
          const tr = document.createElement('tr');
          for (const value of [c.index, `${c.force}N / ${c.start}s`, c.baseline ? '恢复' : '未恢复', c.initial ? '恢复' : '未恢复', c.rl ? '恢复' : c.fallen ? '跌倒' : '未稳定', c.frozen ? '恢复' : '未恢复', c.rl && !c.baseline ? '改善' : c.baseline && !c.rl ? '退化' : '—']) {
            const td = document.createElement('td'); td.textContent = String(value); tr.append(td);
          } return tr;
        }));
        const video = $('originman-video');
        const src = result.video ? apiPath(`/sim2real/runs/${encodeURIComponent(assessment.id)}/workshop-video`) : '';
        if (video.getAttribute('src') !== src) { if (src) video.src = src; else video.removeAttribute('src'); }
        video.hidden = !src;
        text('originman-video-note', src ? '本次评测原始物理轨迹的四组回放；失败后保持实际终止姿态。仅仿真，无硬件部署资格。' : result.videoError || '本次尚无物理回放。');
      }
    }

    async function refresh() {
      if (loading) return;
      loading = true;
      try {
        if (!catalog) catalog = await request('/sim2real/workshops/originman');
        const snapshot = await request('/sim2real/runs');
        runs = (snapshot.runs || []).filter((r) => r.training?.engine === ENGINE);
        for (const run of runs.filter(active)) {
          const latest = await request(`/sim2real/runs/${encodeURIComponent(run.id)}`);
          const i = runs.findIndex((r) => r.id === run.id); if (i >= 0) runs[i] = latest.run;
        }
        const resources = (getOverview()?.computeResources || []).filter((r) => r.source !== 'local-agent' && (!Array.isArray(r.engines) || !r.engines.length || r.engines.includes(ENGINE)));
        const verifiedGpu = resources.filter((r) => r.status === 'online' && r.mock === false && r.engines?.includes(ENGINE) && (r.kind === 'local-gpu' || r.cuda === true));
        const currentResource = $('originman-resource').value;
        const preferredResource = !resourceChosen && !currentResource && verifiedGpu.length === 1 ? verifiedGpu[0].id : currentResource;
        options($('originman-resource'), [{ value: '', label: '服务端默认本地 Worker（需支持所选设备）' }, ...resources.map((r) => ({ value: r.id, label: r.name || r.id }))], preferredResource, '默认本地 Worker');
        render();
        const latest = evaluations().find(active) || selectedRun();
        if (latest && !pending) status(`${latest.training.originmanWorkshop.phase === 'evaluate' ? '评测' : '训练'}：${latest.status}${latest.summary ? ` · ${latest.summary}` : ''}`);
        else if (!latest && !pending) status('可以创建本组训练。模型由已配置的 Worker 提供；未配置时平台会明确拒绝。');
        if (latest?.externalRunId) {
          try { await logs(latest.id); }
          catch (error) { text('originman-logs', `日志暂时不可读：${error.message}。已有运行记录仍保留，可刷新重试。`); }
        } else if (latest) text('originman-logs', latest.summary || 'Worker尚未受理，请查看运行状态。');
      } catch (error) { status(`读取失败：${error.message}。已显示的数据保留，可刷新重试。`); }
      finally { loading = false; }
    }

    async function logs(id) {
      if (logRun !== id) { logRun = id; logAfter = 0; logLines = []; }
      const payload = await request(`/sim2real/runs/${encodeURIComponent(id)}/logs?after=${logAfter}`);
      if (logRun !== id) return;
      logLines.push(...payload.lines.map((l) => `[${l.stream}] ${l.text}`));
      logLines = logLines.slice(-150); logAfter = payload.total;
      text('originman-logs', logLines.join('\n') || '任务尚未输出日志');
    }

    async function submit(phase) {
      if (busy || runs.some(active)) return;
      if (phase === 'train' && !pending && !form.reportValidity()) return;
      busy = true; render();
      try {
        if (!pending) {
          if (!catalog) catalog = await request('/sim2real/workshops/originman');
          const models = await request('/sim2real/models');
          let model = models.models.find((m) => m.manifest.modelId === catalog.manifest.modelId && m.manifest.contract.id === catalog.manifest.contract.id);
          if (!model) model = (await request('/sim2real/models', { method: 'POST', body: JSON.stringify({ manifest: catalog.manifest }) })).model;
          const parent = selectedRun();
          if (phase === 'evaluate' && parent?.status !== 'completed') throw new Error('请先选择已完成的本组训练');
          const cfg = phase === 'train' ? { phase, timesteps: Number($('originman-steps').value), seed: Number($('originman-seed').value), pushMaxForce: Number($('originman-force').value), device: $('originman-device').value } : { phase, timesteps: parent.training.originmanWorkshop.timesteps, seed: parent.training.originmanWorkshop.seed, pushMaxForce: parent.training.originmanWorkshop.pushMaxForce, device: parent.training.originmanWorkshop.device || 'cpu', sourceRunId: parent.id };
          const resource = phase === 'train' ? $('originman-resource').value : parent.computeResourceId;
          pending = { phase, key: `originman-${crypto.randomUUID()}`, body: { backend: 'local', taskId: 'originman-recovery', modelId: model.id, label: phase === 'train' ? `OriginMan SAC · seed ${cfg.seed} · ${cfg.timesteps}步` : `OriginMan 31条件评测 · ${parent.id}`, ...(resource ? { computeResourceId: resource } : {}), training: { profile: 'standard', engine: ENGINE, algorithm: 'sac', numEnvs: 4, maxIterations: Math.ceil(cfg.timesteps / 256), video: phase === 'evaluate', originmanWorkshop: cfg } } };
        }
        render();
        status(`正在提交${phase === 'train' ? '训练' : '评测'}；请保留页面，避免重复创建。`);
        const accepted = await request('/sim2real/runs', { method: 'POST', headers: { 'Idempotency-Key': pending.key }, body: JSON.stringify(pending.body) });
        if (phase === 'train') { selected = accepted.run.id; selectedEvaluation = ''; }
        else selectedEvaluation = accepted.run.id;
        pending = null;
        await refresh();
      } catch (error) {
        // A transport failure may follow acceptance. Keep the identical key/body for retry.
        if (error.status >= 400 && error.status < 500 && error.status !== 408) pending = null;
        status(`提交未完成：${error.message}${pending ? '。重试将沿用同一幂等键和配置。' : ''}`);
      } finally { busy = false; render(); }
    }

    form.addEventListener('submit', (event) => { event.preventDefault(); void submit('train'); });
    $('originman-evaluate').addEventListener('click', () => void submit('evaluate'));
    $('originman-refresh').addEventListener('click', () => void refresh());
    $('originman-run').addEventListener('change', () => { selected = $('originman-run').value; selectedEvaluation = ''; render(); void refresh(); });
    $('originman-evaluation').addEventListener('change', () => { selectedEvaluation = $('originman-evaluation').value; render(); });
    $('originman-video').addEventListener('error', () => text('originman-video-note', '本次回放暂时无法读取，数值对照已保留。可刷新重试。'));
    $('originman-download').addEventListener('click', () => {
      const evaluation = runs.find((r) => r.id === selectedEvaluation);
      if (!evaluation?.metrics?.originmanWorkshop) return;
      const blob = new Blob([JSON.stringify({ run: evaluation, source: selectedRun() }, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = `originman-${evaluation.id}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    panel.addEventListener('toggle', () => { if (panel.open) void refresh(); });
    const timer = setInterval(() => { if (panel.open && !document.hidden) void refresh(); }, 3000);
    window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
    if (new URLSearchParams(location.search).get('workshop') === 'originman') panel.open = true;
    if (panel.open) void refresh();
    return { refresh };
  }
  root.OriginmanWorkshop = { mount, chart };
})(globalThis);
