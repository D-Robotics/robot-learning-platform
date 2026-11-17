(function (root) {
  'use strict';
  const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(value);
  const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  const metrics = run => run?.metrics?.originmanWorkshop;
  const cfg = run => run?.training?.originmanWorkshop;
  const protocolKeys = ['modelSha256', 'evaluatorSha256', 'runtimeSha256', 'physicalConfigSha256', 'conditionsSha256', 'controllerSha256'];

  /** Compare owner-validated records, never infer identity from names, group or latest status. */
  function compare({ source, current, sourceEvaluation, currentEvaluation, sourceModel, currentModel }) {
    const no = reason => ({ comparable: false, reason, rows: [] });
    if (!source || !current || source.id === current.id) return no('请先在新分组完成另一轮训练；原实验仍保留。');
    for (const [run, evaluation, model] of [[source, sourceEvaluation, sourceModel], [current, currentEvaluation, currentModel]]) {
      if (run.status !== 'completed' || cfg(run)?.phase !== 'train' || run.mock === true) return no('两轮训练都需真实完成；请等待或检查失败原因。');
      if (!evaluation) return no('请明确选择原训练和本轮训练各自的评测，不会自动使用最新评测。');
      if (evaluation.status !== 'completed' || evaluation.mock === true || cfg(evaluation)?.phase !== 'evaluate') return no('所选评测尚未真实完成；保留记录，待完成后刷新。');
      if (evaluation.modelId !== run.modelId || cfg(evaluation).sourceRunId !== run.id || metrics(evaluation)?.sourceRunId !== run.id) return no('评测与训练来源不一致，不能比较。');
      if (metrics(run)?.phase !== 'train' || metrics(evaluation)?.phase !== 'evaluate' || !sha(metrics(run)?.policySha256) || metrics(run).policySha256 !== metrics(evaluation)?.policySha256) return no('训练与评测策略摘要缺失或不匹配；请对该训练权重重新评测。');
      if (model?.id !== run.modelId || !['originman', 'custom'].includes(model.manifest?.robot?.id) || model.manifest?.contract?.id !== 'custom-policy-originman-recovery-v1') return no('来源模型或完整契约不可核对，不能比较。');
    }
    if (canonical(sourceModel.manifest.contract) !== canonical(currentModel.manifest.contract)) return no('两轮完整模型契约不同，不能作同条件比较。');
    const left = metrics(sourceEvaluation).feedbackComparison, right = metrics(currentEvaluation).feedbackComparison;
    if (!left?.protocol || !right?.protocol) return no('历史评测缺少执行环境与完整条件摘要。请使用已升级的同一 Worker，对两轮原权重各重新评测；不会重新训练。');
    if (left.protocol.schemaVersion !== 1 || right.protocol.schemaVersion !== 1 || !Number.isFinite(left.protocol.durationSeconds) || left.protocol.durationSeconds < 0.02 || left.protocol.durationSeconds > 0.5 || left.protocol.durationSeconds !== right.protocol.durationSeconds || !protocolKeys.every(key => sha(left.protocol[key]) && left.protocol[key] === right.protocol[key]) || !sha(left.baselineSha256) || left.baselineSha256 !== right.baselineSha256 || left.protocol.controllerSha256 !== left.baselineSha256 || left.baselineId !== 'originman-joint-feedback-v1' || left.baselineId !== right.baselineId) return no('模型、动力学、评测代码/运行时、冻结控制器或完整条件摘要不同；请在同一评测环境复评。');
    const rows = [];
    if (!Array.isArray(left.suites) || !Array.isArray(right.suites) || left.suites.length !== 2 || right.suites.length !== 2) return no('缺少两组完整评测条件。');
    for (const suiteId of ['historical', 'additional']) {
      const a = left.suites.filter(s => s.id === suiteId), b = right.suites.filter(s => s.id === suiteId);
      if (a.length !== 1 || b.length !== 1 || a[0].cases?.length !== 31 || b[0].cases?.length !== 31) return no('条件集缺失或重复，不能比较。');
      for (let index = 0; index < 31; index++) {
        const x = a[0].cases[index], y = b[0].cases[index];
        if (x.index !== index || y.index !== index || !Number.isFinite(x.force) || !Number.isFinite(x.start) || x.force !== y.force || x.start !== y.start || x.duration !== left.protocol.durationSeconds || y.duration !== right.protocol.durationSeconds || ![x.rl, y.rl, x.fallen, y.fallen, x.original, y.original, x.tuned, y.tuned].every(v => typeof v === 'boolean') || (x.rl && x.fallen) || (y.rl && y.fallen) || x.original !== y.original || x.tuned !== y.tuned) return no('逐项条件或冻结对照结果不一致；同名条件编号不能证明可比。');
        rows.push({ suite: suiteId, index, force: x.force, start: x.start, duration: x.duration, source: x.rl, current: y.rl, change: x.rl === y.rl ? '持平' : y.rl ? '改善' : '退化' });
      }
    }
    return { comparable: true, rows, sourceRecovered: rows.filter(r => r.source).length, currentRecovered: rows.filter(r => r.current).length, improved: rows.filter(r => r.change === '改善').length, regressed: rows.filter(r => r.change === '退化').length };
  }

  function mount({ request, apiPath, readOwner, onIdentityChanged }) {
    const $ = name => document.getElementById('originman-round-' + name);
    if (!$('comparison')) return;
    let owner = null, generation = 0, state = null, data = {}, knownRuns = [], busy = false, loading = false, reference = false, error = '';
    const key = who => `originman-round-comparison:${encodeURIComponent(apiPath('/sim2real'))}:${encodeURIComponent(who)}`;
    const save = () => { if (owner) try { sessionStorage.setItem(key(owner), JSON.stringify({ ...state, owner, version: 1 })); } catch { /* current page still works */ } };
    const empty = () => { data = {}; error = ''; };
    function adoptOwner(next) {
      if (owner === next) return;
      owner = next; generation++; loading = false; state = null; knownRuns = []; empty();
      if (next) try { const value = JSON.parse(sessionStorage.getItem(key(next))); if (value?.owner === next && value.version === 1 && id(value.comparisonSourceRunId) && [value.currentRunId, value.sourceEvaluationId, value.currentEvaluationId].every(v => !v || id(v))) state = value; } catch { /* absent private bookmark */ }
      render();
    }
    function begin(sourceId, restart = false) {
      if (!owner || !id(sourceId)) return;
      if (state?.comparisonSourceRunId === sourceId && !restart) return;
      generation++; state = { comparisonId: crypto.randomUUID(), comparisonSourceRunId: sourceId, currentRunId: '', sourceEvaluationId: state?.comparisonSourceRunId === sourceId ? state.sourceEvaluationId : '', currentEvaluationId: '' }; empty(); save(); render();
    }
    function accepted(runId, sourceId, contextId = state?.comparisonId) {
      if (!owner || !state || !id(runId) || !id(sourceId) || !id(contextId) || state.comparisonSourceRunId !== sourceId || state.comparisonId !== contextId) return;
      generation++; state = { ...state, currentRunId: runId, currentEvaluationId: '' }; empty(); save(); render();
    }
    /** Acceptance belongs to the original owner even when its response arrives in another account. */
    function recordAcceptedForOwner(runId, sourceId, contextId, sourceOwner) {
      if (!id(runId) || !id(sourceId) || !id(contextId) || !sourceOwner) return false;
      try {
        const value = JSON.parse(sessionStorage.getItem(key(sourceOwner)));
        if (value?.owner !== sourceOwner || value.version !== 1 || value.comparisonId !== contextId || value.comparisonSourceRunId !== sourceId || (value.currentRunId && value.currentRunId !== runId)) return false;
        sessionStorage.setItem(key(sourceOwner), JSON.stringify({ ...value, currentRunId: runId, currentEvaluationId: '' }));
        return true;
      } catch { return false; }
    }
    function choices(side, runId) {
      const select = $(side + '-evaluation');
      const selected = state?.[side + 'EvaluationId'] || '';
      const values = knownRuns.filter(r => cfg(r)?.phase === 'evaluate' && cfg(r).sourceRunId === runId);
      select.replaceChildren(new Option('请选择明确的评测记录', ''));
      for (const run of values) select.append(new Option(`${run.id} · ${run.status}`, run.id));
      if (selected && !values.some(r => r.id === selected)) select.append(new Option(`${selected} · 精确读取`, selected));
      select.value = selected; select.disabled = !runId || busy || loading || reference;
    }
    function describe(side, run, evaluation) {
      const expected = side === 'source' ? state.comparisonSourceRunId : state.currentRunId;
      const short = value => value && value.length > 12 ? value.slice(0, 12) + '…' : value;
      const stateLabel = value => ({ completed: '已完成', running: '运行中', queued: '排队中', failed: '失败', blocked: '受阻', cancelled: '已取消' })[value] || value || '待核对';
      const evaluationId = evaluation?.id || state[side + 'EvaluationId'];
      const policy = metrics(evaluation)?.policySha256 || metrics(run)?.policySha256;
      const steps = cfg(run)?.timesteps;
      $(side).textContent = `${Number.isSafeInteger(steps) ? steps + ' 步 · ' : ''}${stateLabel(run?.status)}；训练 ${short(expected) || '尚未创建'}；评测 ${short(evaluationId) || '未选择'}${evaluation ? ' · ' + stateLabel(evaluation.status) : ''}；策略 ${short(policy) || '未记录'}`;
      $(side).title = `训练 Run：${expected || '尚未创建'}；评测 Run：${evaluationId || '未选择'}；策略 SHA256：${policy || '未记录'}`;
      const link = $(side + '-link'); link.hidden = !run;
      if (run) { const url = new URL(location.href); for (const name of ['sourceRunId', 'contextId', 'intent', 'originmanGroup']) url.searchParams.delete(name); url.searchParams.set('workshop', 'originman'); url.searchParams.set('sourceRunId', run.id); url.searchParams.set('intent', 'inspect'); url.hash = 'classroom'; link.href = url.toString();
        link.onclick = event => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
          event.preventDefault();
          if (!window.openReplayDrawer) return;
          const evaluationId = $('source-evaluation') && side === 'source' ? $('source-evaluation').value
            : $('current-evaluation') && side === 'current' ? $('current-evaluation').value
            : evaluation?.id;
          const sideTitle = side === 'source' ? '原训练' : '本轮训练';
          if (!evaluationId) {
            window.openReplayDrawer({ title: sideTitle + ' · 暂无回放', meta: $(side).textContent || '', note: '该轮还没有可播放的评测回放：先选择一条明确的评测记录，或进入课堂实验查看。', inspectUrl: url.toString() });
            return;
          }
          window.openReplayDrawer({ title: sideTitle + ' · 评测回放', meta: $(side).textContent || '', videoUrl: apiPath('/sim2real/runs/' + encodeURIComponent(evaluationId) + '/workshop-video'), inspectUrl: url.toString() });
        }; }
    }
    function render() {
      $('comparison').hidden = !state;
      if (!state) { $('rows').replaceChildren(); $('status').textContent = ''; $('source').textContent = ''; $('current').textContent = ''; $('source').title = ''; $('current').title = ''; $('proof').textContent = ''; for (const side of ['source', 'current']) { $(side + '-link').removeAttribute('href'); $(side + '-link').hidden = true; $(side + '-evaluation').replaceChildren(); } return; }
      describe('source', data.source, data.sourceEvaluation); describe('current', data.current, data.currentEvaluation);
      choices('source', state.comparisonSourceRunId); choices('current', state.currentRunId);
      $('refresh').disabled = busy || loading;
      $('proof').textContent = JSON.stringify({ original: { trainingRunId: state.comparisonSourceRunId, evaluationRunId: state.sourceEvaluationId || null, evaluationSourceRunId: metrics(data.sourceEvaluation)?.sourceRunId || null, policySha256: metrics(data.sourceEvaluation)?.policySha256 || metrics(data.source)?.policySha256 || null, trainingPolicySha256: metrics(data.source)?.policySha256 || null, modelId: data.sourceModel?.id || null, contract: data.sourceModel?.manifest?.contract || null, protocol: metrics(data.sourceEvaluation)?.feedbackComparison?.protocol || null }, current: { trainingRunId: state.currentRunId || null, evaluationRunId: state.currentEvaluationId || null, evaluationSourceRunId: metrics(data.currentEvaluation)?.sourceRunId || null, policySha256: metrics(data.currentEvaluation)?.policySha256 || metrics(data.current)?.policySha256 || null, trainingPolicySha256: metrics(data.current)?.policySha256 || null, modelId: data.currentModel?.id || null, contract: data.currentModel?.manifest?.contract || null, protocol: metrics(data.currentEvaluation)?.feedbackComparison?.protocol || null } }, null, 2);
      const result = reference ? { comparable: false, reason: '正在查看课前参考；本组两轮比较上下文保留，返回本组实验后继续。' } : compare(data);
      $('rows').replaceChildren();
      $('status').textContent = loading ? '正在按当前账号核对两轮原始记录…' : error || (result.comparable ? `原训练恢复 ${result.sourceRecovered}/62 → 本轮 ${result.currentRecovered}/62；改善 ${result.improved}，退化 ${result.regressed}，其余持平。已核对完整模型契约、执行环境、控制器、条件摘要及各自策略来源；仅为固定公开仿真条件。` : `暂不可比较：${result.reason}`);
      if (loading || error || !result.comparable) return;
      for (const row of result.rows) { const tr = document.createElement('tr'); for (const value of [row.suite === 'historical' ? '原公开' : '补充固定', row.index, `${row.force}N / ${row.start}s / ${row.duration}s`, row.source ? '恢复' : '未恢复', row.current ? '恢复' : '未恢复', row.change]) { const td = document.createElement('td'); td.textContent = String(value); tr.append(td); } $('rows').append(tr); }
    }
    async function refresh(expectedOwner = owner) {
      if (!state || !expectedOwner || owner !== expectedOwner) return;
      const mine = ++generation, selected = { ...state }; loading = true; empty(); render();
      const current = () => generation === mine && owner === expectedOwner;
      const headers = { 'X-Rdk-Expected-Identity': encodeURIComponent(expectedOwner) };
      const read = async (kind, identity) => { if (!identity) return undefined; const payload = await request(`/sim2real/${kind}/${encodeURIComponent(identity)}`, { headers, cache: 'no-store' }); const value = payload[kind === 'runs' ? 'run' : 'model']; if (value?.id !== identity) throw Error('记录不存在或不属于当前账号'); return value; };
      try {
        const source = await read('runs', selected.comparisonSourceRunId), round = await read('runs', selected.currentRunId);
        const sourceEvaluation = await read('runs', selected.sourceEvaluationId), currentEvaluation = await read('runs', selected.currentEvaluationId);
        const sourceModel = await read('models', source?.modelId), currentModel = round?.modelId === source?.modelId ? sourceModel : await read('models', round?.modelId);
        const latestOwner = await readOwner();
        if (!current()) return;
        if (latestOwner !== expectedOwner) { adoptOwner(latestOwner); onIdentityChanged?.(latestOwner); return; }
        data = { source, current: round, sourceEvaluation, currentEvaluation, sourceModel, currentModel };
      } catch (failure) {
        if (current()) {
          try { const next = await readOwner(); if (current() && next !== expectedOwner) { adoptOwner(next); onIdentityChanged?.(next); return; } } catch { /* unknown identity: clear all loaded evidence */ }
          if (current()) { empty(); error = '暂不可比较：指定原始记录不可读或身份已变化；请核对当前账号和明确的 Run ID，不会替换成其他实验。'; }
        }
      } finally { if (current()) { loading = false; render(); } }
    }
    for (const side of ['source', 'current']) $(side + '-evaluation').addEventListener('change', () => { if (!owner || !state || busy || loading) return; state = { ...state, [side + 'EvaluationId']: $(side + '-evaluation').value }; save(); void refresh(); });
    $('refresh').addEventListener('click', () => void refresh());
    return { adoptOwner, begin, accepted, recordAcceptedForOwner, contextId: () => state?.comparisonId, refresh, unavailable: () => { generation++; loading = false; empty(); error = '暂不可比较：尚未重新核对当前账号与原始记录，请刷新重试。'; render(); }, sourceForSubmission: () => state && !state.currentRunId ? state.comparisonSourceRunId : undefined, update: input => { knownRuns = input.runs; busy = input.busy; reference = input.referenceMode; render(); } };
  }
  root.OriginmanRoundComparison = { compare, mount };
})(globalThis);
