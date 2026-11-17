(function (root) {
  'use strict';
  const ENGINES = ['originman-recovery', 'originman-recovery-reflect'];
  const engineLabel = engine => engine === 'originman-recovery-reflect' ? '对称约束 SAC' : '标准 MLP SAC';
  const active = (r) => r && ['queued', 'running'].includes(r.status);
  function currentRunStatus(run) {
    const phase = run.training?.originmanWorkshop?.phase === 'evaluate' ? '评测' : '训练';
    let summary = run.summary;
    // Only exact host-generated lifecycle copy is projected to the current status.
    // Preserve arbitrary worker details and all failed/blocked explanations verbatim.
    const host = /^本地服务器(训练|评测)已(排队|启动|完成)；\1进程由受控 worker 管理。$/.test(summary || '');
    const word = { queued: '排队', running: '启动', completed: '完成' }[run.status];
    if (run.backend === 'local' && host && word) summary = `本地服务器${phase}已${word}；${phase}进程由受控 worker 管理。`;
    const position = run.queuePosition;
    const queue = run.status === 'queued'
      ? Number.isSafeInteger(position) && position > 0 && position <= 1000000
        ? ` · 当前资源等待队列第 ${position} 位（不含运行中任务）；等待时长取决于前序任务。`
        : ' · 队列位置暂不可用；保留本次 Run，刷新查询。'
      : '';
    return `${phase}：${run.status}${summary ? ` · ${summary}` : ''}${queue}`;
  }
  const labels = { reference: '参考站姿', 'imu-feedback': '基础反馈', untrained: '未训练', rl: '训练后 RL', 'tuned-feedback': '调参后髋踝反馈', 'rl-frozen-correction': '冻结RL输出' };

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

  function supportedEngines(resources, resourceId, defaults) {
    const advertised = resourceId
      ? resources.find(resource => resource.id === resourceId)?.engines
      : defaults;
    return Array.isArray(advertised) ? ENGINES.filter(engine => advertised.includes(engine)) : [];
  }

  async function submitPreparedRun(request, pending, expectedIdentity, onAttempt) {
    const identityHeaders = expectedIdentity ? { 'X-Rdk-Expected-Identity': encodeURIComponent(expectedIdentity) } : {};
    const resourceId = pending.body.computeResourceId;
    if (resourceId && !pending.attempted) {
      const checked = await request(`/sim2real/compute-resources/${encodeURIComponent(resourceId)}/test`, { method: 'POST', headers: identityHeaders });
      if (checked.connected !== true || checked.computeResource?.status !== 'online') { const error = new Error('训练资源未通过连接检查，请检查执行资源后重试'); error.status = 409; throw error; }
      if (!checked.computeResource.engines?.includes(pending.body.training.engine)) { const error = new Error('所选资源未注册本次训练引擎，请重新选择执行资源'); error.status = 409; throw error; }
    }
    onAttempt?.();
    return await request('/sim2real/runs', { method: 'POST', headers: { ...identityHeaders, 'Idempotency-Key': pending.key }, body: JSON.stringify(pending.body) });
  }

  function mount({ request, apiPath, onConfigure, onSubmitted, onPreview }) {
    const $ = (id) => document.getElementById(id);
    const panel = $('originman-workshop');
    if (!panel) return;
    const courseMode = new URLSearchParams(location.search).get('workshop') === 'originman';
    const form = $('originman-workshop-form');
    const saved = key => { try { return JSON.parse(sessionStorage.getItem(key)); } catch { return null; } };
    const save = (key,value) => { try { if(value===null)sessionStorage.removeItem(key);else sessionStorage.setItem(key,JSON.stringify(value)); } catch { /* storage unavailable: retain this page state */ } };
    const bookmarkGroup = new URL(location.href).searchParams.get('originmanGroup');
    const validGroup = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,23}$/.test(value);
    if (validGroup(bookmarkGroup)) $('originman-group').value = bookmarkGroup;
    let catalog, runs = [], busy = false, loading = false, refreshRequested = false, pending = null;
    let owner = null, ownerGeneration = 0, identityPreconditionAvailable = false, ownerResources = [];
    const query = new URLSearchParams(location.search);
    const safeId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(value);
    let link = query.has('sourceRunId') || query.has('intent') ? {
      id: query.get('sourceRunId'), intent: query.get('intent') || 'inspect',
      error: ['sourceRunId', 'contextId', 'intent'].some(name => query.getAll(name).length > 1)
        || !safeId(query.get('sourceRunId')) || !['inspect', 'tune'].includes(query.get('intent') || 'inspect')
        || (query.has('contextId') && !safeId(query.get('contextId'))) ? '来源链接无效，请从明确的训练记录重新打开。' : '',
    } : null;
    let handoff = null, handoffError = link?.error || '', handoffLoadedOwner = null;
    let handoffEpoch = 0;
    const editedDraftFields = new Set();
    const storageKey = (name, id = owner) => `originman-${name}:${encodeURIComponent(apiPath('/sim2real'))}:${encodeURIComponent(id)}`;
    const fieldDefaults = Object.fromEntries(['engine', 'device', 'steps', 'seed', 'force', 'resource'].map(name => [name, $('originman-' + name).value]));
    const draftFields = ['engine', 'device', 'steps', 'seed', 'force', 'resource', 'group'];
    const draftKey = (ref = link, id = owner) => ref?.intent === 'tune' && safeId(ref.id) && id ? storageKey('draft-v1', id) + ':' + encodeURIComponent(ref.id) + ':tune' : null;
    const sourceSignature = run => JSON.stringify([run.id, run.modelId, run.training.engine, run.computeResourceId || '', run.training.originmanWorkshop, run.metrics?.originmanWorkshop?.policySha256 || null]);
    function validDraftParams(params, source) {
      if (!params || Object.keys(params).length !== draftFields.length || draftFields.some(name => typeof params[name] !== 'string' || params[name].length > 96)) return false;
      const steps = Number(params.steps), seed = Number(params.seed), force = Number(params.force);
      return Number.isSafeInteger(steps) && steps >= 4096 && steps <= 1000000 && Number.isSafeInteger(seed) && seed >= 0 && seed <= 1000000 && Number.isFinite(force) && force >= 6.4 && force <= 9 && validGroup(params.group) && ['', 'cpu', 'cuda'].includes(params.device) && params.engine === source.training.engine && params.resource === (source.computeResourceId || '');
    }
    function restoredDraft(source, ref, id) {
      const key = draftKey(ref, id), value = key && saved(key);
      return value?.version === 1 && value.owner === id && value.apiPrefix === apiPath('/sim2real') && value.sourceRunId === source.id && value.intent === ref.intent && value.sourceSignature === sourceSignature(source) && validDraftParams(value.params, source) ? value.params : null;
    }
    function persistDraft() {
      if (pending || busy || !handoff || handoff.intent !== 'tune' || handoff.run.id !== link?.id || handoffLoadedOwner !== owner) return;
      const key = draftKey();
      const params = Object.fromEntries(draftFields.map(name => [name, $('originman-' + name).value]));
      if (key && validDraftParams(params, handoff.run)) save(key, { version: 1, owner, apiPrefix: apiPath('/sim2real'), sourceRunId: link.id, intent: link.intent, sourceSignature: sourceSignature(handoff.run), params });
    }
    function clearAcceptedDraft(id, sourceId) {
      const key = draftKey({ id: sourceId, intent: 'tune' }, id), value = key && saved(key);
      if (value?.version === 1 && value.owner === id && value.sourceRunId === sourceId && value.intent === 'tune') save(key, null);
    }
    async function currentOwner() {
      const overview = await request('/sim2real/overview?productId=originman', { cache: 'no-store' });
      identityPreconditionAvailable = overview?.identityPrecondition === true;
      ownerResources = Array.isArray(overview?.computeResources) ? overview.computeResources : [];
      const id = overview?.identity?.accountId;
      if (typeof id === 'string' && id.trim()) return 'account:' + id;
      return overview?.identityScope === 'local' ? 'local' : null;
    }
    function adoptOwner(next) {
      if (next === owner) return;
      ownerGeneration += 1; handoffEpoch += 1; editedDraftFields.clear();
      const first = owner === null;
      owner = next; roundComparison?.adoptOwner(next); pending = null; selected = ''; selectedEvaluation = ''; referenceMode = false;
      handoff = null; handoffLoadedOwner = null; handoffError = link?.error || '';
      $('originman-confirm-parameters').checked = false;
      runs = []; catalog = null; logRun = ''; logAfter = 0; logLines = [];
      text('originman-logs', '');
      text('originman-status', '正在读取当前账号的运行状态…');
      text('originman-experiment-guide', '正在读取当前账号的实验参数…');
      for (const [name, value] of Object.entries(fieldDefaults)) $('originman-' + name).value = value;
      const group = next ? saved(storageKey('group')) : null;
      $('originman-group').value = first && validGroup(bookmarkGroup) ? bookmarkGroup : validGroup(group) ? group : 'group-01';
      const restored = next && saved(storageKey('pending'));
      if (restored?.owner === next && ['train', 'evaluate'].includes(restored.phase) && typeof restored.key === 'string' && ENGINES.includes(restored.body?.training?.engine)) {
        pending = restored;
        $('originman-group').value = restored.body.training.originmanWorkshop.groupId || 'group-01';
        selected = restored.body.training.originmanWorkshop.sourceRunId || '';
        const cfg = restored.body.training.originmanWorkshop;
        for (const [name, value] of Object.entries({ steps: cfg.timesteps, seed: cfg.seed, force: cfg.pushMaxForce, device: cfg.device || '', engine: restored.body.training.engine })) $('originman-' + name).value = String(value);
      }
    }
    let referenceMode = false;
    let selected = pending?.body?.training?.originmanWorkshop?.sourceRunId || '', selectedEvaluation = '', logRun = '', logAfter = 0, logLines = [];
    const text = (id, value) => { $(id).textContent = value; };
    const groupId = () => $('originman-group').value || 'group-01';
    const groupRuns = () => runs.filter(r => (r.training.originmanWorkshop.groupId || 'group-01') === groupId());
    const selectedRun = () => runs.find((r) => r.id === (referenceMode ? $('originman-reference').value : selected));
    const references = () => runs.filter(r => r.training?.originmanWorkshop?.phase === 'train' && r.status === 'completed' && r.training.originmanWorkshop.timesteps >= 500000 && runs.some(e => e.training?.originmanWorkshop?.sourceRunId === r.id && e.status === 'completed' && e.metrics?.originmanWorkshop?.feedbackComparison?.clearGain));
    const evaluations = () => runs.filter((r) => r.training?.originmanWorkshop?.phase === 'evaluate' && r.training.originmanWorkshop.sourceRunId === selectedRun()?.id);
    const status = (value) => text('originman-status', value);

    function reviewParameters() {
      $('originman-handoff').hidden = !link && !handoff;
      $('originman-copy-parameters').hidden = !handoff || handoff.intent === 'tune';
      $('originman-copy-parameters').disabled = busy || Boolean(pending) || handoff?.executionAvailable === false;
      $('originman-close-handoff').disabled = busy || Boolean(pending);
      $('originman-confirm-parameters').disabled = busy || Boolean(pending);
      $('originman-confirm-label').hidden = !handoff || handoff.intent !== 'tune';
      text('originman-handoff-note', handoffError || (handoff
        ? `来源训练：${handoff.run.id}。${handoff.intent === 'inspect' ? '仅查看原实验；复制参数后可调优。' : '保留原实验；本次在新分组从零训练，不接续原权重。模型、资源与策略结构沿用来源。'}${handoff.executionAvailable === false ? '来源模型或执行资源已不可用，保留历史只读结果；重新执行前需恢复原资源。' : ''}`
        : link ? '正在验证来源训练与当前账号…' : ''));
      const tbody = $('originman-parameter-diff');
      tbody.replaceChildren();
      explainExperiment();
      if (!handoff) return;
      const source = handoff.run.training.originmanWorkshop;
      const rows = [
        ['实验分组', source.groupId || 'group-01', groupId()],
        ['训练控制步数', source.timesteps, $('originman-steps').value],
        ['训练轮数（每轮256步）', Math.ceil(source.timesteps / 256), Math.ceil(Number($('originman-steps').value) / 256)],
        ['随机种子', source.seed, $('originman-seed').value],
        ['训练侧推上限（N）', source.pushMaxForce, $('originman-force').value],
        ['训练设备', source.device || '沿用资源配置', $('originman-device').value || '沿用资源配置'],
        ['策略结构', engineLabel(handoff.run.training.engine), engineLabel($('originman-engine').value)],
      ];
      for (const values of rows) {
        const row = document.createElement('tr');
        for (const [index, value] of values.entries()) { const cell = document.createElement('td'); cell.textContent = String(value); if (index === 2 && String(value) !== String(values[1])) cell.className = 'is-diff'; row.append(cell); }
        tbody.append(row);
      }
    }

    function explainExperiment() {
      const frozen = '评测仍用固定62条件；学习率、PD、奖励与动作映射保持冻结。';
      if (!handoff) { text('originman-experiment-guide', '先选择一个已完成训练并复制参数，再建立单变量实验：只改训练步数或侧推上限，保留原实验。' + frozen); return; }
      const source = handoff.run.training.originmanWorkshop;
      const steps = Number($('originman-steps').value), force = Number($('originman-force').value);
      if (!Number.isSafeInteger(steps) || steps < 4096 || steps > 1000000 || !Number.isFinite(force) || force < 6.4 || force > 9) { text('originman-experiment-guide', '请先填写允许范围内的训练步数和侧推上限，再建立单变量实验。' + frozen); return; }
      const stepsChanged = steps !== source.timesteps, forceChanged = force !== source.pushMaxForce;
      const confounded = Number($('originman-seed').value) !== source.seed || ($('originman-device').value || '') !== (source.device || '') || $('originman-engine').value !== handoff.run.training.engine;
      let note;
      if (stepsChanged && forceChanged) note = '同时改变训练步数和侧推上限，结果难以归因；建议恢复一项后再训练。';
      else if (stepsChanged) note = `训练控制步数：${source.timesteps} → ${steps}。更多控制步增加训练预算，也增加等待与资源占用；减少步数可检查流程，但短训练不代表最终效果。不保证提升。`;
      else if (forceChanged) note = `训练侧推上限：${source.pushMaxForce}N → ${force}N。提高上限增加扰动覆盖与训练难度，可能退化；降低上限更容易训练，但强扰动覆盖减少。不保证提升。`;
      else note = source.timesteps < 1000000
        ? `可先只把训练控制步数从 ${source.timesteps} 改为 ${Math.min(1000000, source.timesteps * 2)}，保持侧推上限 ${source.pushMaxForce}N 和种子 ${source.seed}；更多控制步增加预算，不保证提升。`
        : `原训练已达100万步；可只在允许范围内小幅调整侧推上限（原值 ${source.pushMaxForce}N），记录覆盖与难度的取舍，不保证提升。`;
      if (confounded) note += ' 种子、设备或策略结构也有变化；若要控制变量，请恢复来源设置。';
      text('originman-experiment-guide', note + ' 新组从零训练后，显式选择原/本轮评测再比较改善和退化；seed相同也不保证相同结果。' + frozen);
    }

    async function loadHandoff(nextRuns, expectedOwner) {
      if (!link || link.error || pending) return;
      const ref = link, epoch = ++handoffEpoch, generation = ownerGeneration;
      const current = () => link === ref && owner === expectedOwner && ownerGeneration === generation && handoffEpoch === epoch && !pending;
      const preserveDraft = handoffLoadedOwner === expectedOwner && handoff?.run.id === ref.id && handoff.intent === ref.intent;
      const headers = { 'X-Rdk-Expected-Identity': encodeURIComponent(expectedOwner) };
      try {
        if (!identityPreconditionAvailable) throw new Error('平台缺少身份预检能力');
        const source = (await request(`/sim2real/runs/${encodeURIComponent(ref.id)}`, { headers, cache: 'no-store' })).run;
        const cfg = source?.training?.originmanWorkshop;
        if (source?.id !== ref.id || source.backend !== 'local' || cfg?.phase !== 'train' || !ENGINES.includes(source.training.engine)
          || source.training.algorithm !== 'sac' || source.training.numEnvs !== 4 || !safeId(source.modelId)) throw new Error('来源不是可恢复参数的 OriginMan 训练记录');
        let sourceModel;
        try { sourceModel = (await request(`/sim2real/models/${encodeURIComponent(source.modelId)}`, { headers, cache: 'no-store' })).model; }
        catch (error) { if (ref.intent === 'tune') throw error; }
        const modelAvailable = sourceModel?.id === source.modelId && sourceModel.manifest?.contract?.id === catalog.manifest.contract.id;
        if (!modelAvailable && ref.intent === 'tune') throw new Error('来源模型不存在或模型契约不匹配');
        const engines = supportedEngines(ownerResources, source.computeResourceId || '', catalog.capabilities?.engines);
        const executionAvailable = modelAvailable && engines.includes(source.training.engine);
        if (!engines.includes(source.training.engine) && ref.intent === 'tune') throw new Error('来源执行资源不存在或不再支持原策略结构，请恢复资源后重试');
        if (!Number.isSafeInteger(cfg.timesteps) || cfg.timesteps < 4096 || cfg.timesteps > 1000000
          || !Number.isSafeInteger(cfg.seed) || cfg.seed < 0 || cfg.seed > 1000000
          || !Number.isFinite(cfg.pushMaxForce) || cfg.pushMaxForce < 6.4 || cfg.pushMaxForce > 9
          || (cfg.device !== undefined && !['cpu', 'cuda'].includes(cfg.device)) || (cfg.groupId && !validGroup(cfg.groupId))) throw new Error('来源训练参数无效，不能自动恢复');
        if (await currentOwner() !== expectedOwner) throw new Error('账号已切换，请重新读取来源训练');
        if (!current()) return;
        if (!nextRuns.some(run => run.id === source.id)) nextRuns.push(source);
        if (preserveDraft) { if (sourceSignature(handoff.run) !== sourceSignature(source)) $('originman-confirm-parameters').checked = false; handoff.run = source; handoff.executionAvailable = executionAvailable; persistDraft(); return; }
        handoffLoadedOwner = expectedOwner;
        handoff = { run: source, intent: ref.intent, executionAvailable }; handoffError = '';
        if (ref.intent === 'tune') roundComparison?.begin(source.id);
        const values = restoredDraft(source, ref, expectedOwner) || { steps: cfg.timesteps, seed: cfg.seed, force: cfg.pushMaxForce, device: cfg.device || '', engine: source.training.engine, resource: source.computeResourceId || '', group: ref.intent === 'tune' ? `tune-${crypto.randomUUID().slice(0, 8)}` : cfg.groupId || 'group-01' };
        for (const [name, value] of Object.entries(values)) if (name === 'engine' || name === 'resource' || !editedDraftFields.has(name)) $('originman-' + name).value = String(value);
        selected = ref.intent === 'inspect' ? source.id : '';
        $('originman-confirm-parameters').checked = false;
        if (ref.intent === 'tune') { persistDraft(); onConfigure?.(); }
      } catch (error) {
        if (!current()) return;
        handoff = null; selected = ''; selectedEvaluation = '';
        handoffError = `无法恢复指定训练：${error.message || '记录不存在或不属于当前账号'}。不会选择其他实验。`;
      }
    }

    function options(select, choices, current, empty) {
      const values = choices.length ? choices : [{ value: '', label: empty }];
      if (select.options.length !== values.length || values.some((v, i) => select.options[i].value !== v.value || select.options[i].textContent !== v.label)) {
        select.replaceChildren(...values.map((v) => {
          const option = document.createElement('option'); option.value = v.value; option.textContent = v.label; return option;
        }));
      }
      select.value = values.some(v => v.value === current) ? current : values[0].value;
    }

    function updateEngineOptions() {
      const supported = supportedEngines(ownerResources, $('originman-resource').value, catalog?.capabilities?.engines);
      const select = $('originman-engine');
      for (const option of select.options) {
        option.disabled = !supported.includes(option.value);
        option.textContent = option.textContent.replace(' · 本资源未注册', '') + (option.disabled ? ' · 本资源未注册' : '');
      }
      if (!handoff && !pending && !supported.includes(select.value)) select.value = supported[0] || '';
    }

    function render() {
      updateEngineOptions();
      reviewParameters();
      roundComparison?.update({ runs, busy: busy || Boolean(pending), referenceMode });
      const training = (link && !handoff && !pending ? [] : groupRuns()).filter((r) => r.training?.originmanWorkshop?.phase === 'train');
      const refs = references();
      options($('originman-reference'), refs.map(r => ({value:r.id,label:`课前完整制品 · ${r.label || r.id}`})), $('originman-reference').value, '尚无合格课前记录');
      if (!refs.length) referenceMode = false;
      $('originman-use-reference').disabled = busy || Boolean(pending) || !refs.length;
      $('originman-return-student').hidden = !referenceMode;
      text('originman-reference-note', referenceMode ? '正在查看课前已验收结果，非本组训练成绩；本组任务与日志继续保留。' : '当前显示本组记录。无合格课前制品时不能冒充已验收结果。');
      if (!training.some((r) => r.id === selected)) selected = link && !handoff ? '' : training[0]?.id || '';
      options($('originman-run'), training.map((r) => ({ value: r.id, label: `${r.label || r.id} · ${r.status}` })), selected, '尚无训练');
      const evaluated = evaluations();
      if (!evaluated.some((r) => r.id === selectedEvaluation)) selectedEvaluation = evaluated[0]?.id || '';
      options($('originman-evaluation'), evaluated.map((r) => ({ value: r.id, label: `${r.id} · ${r.status}` })), selectedEvaluation, '尚无评测');
      const run = selectedRun();
      simulatorUI?.setSources(training, selected);
      if ($('originman-preview-selected')) $('originman-preview-selected').disabled = run?.status !== 'completed';
      $('originman-tune-selected').disabled = busy || Boolean(pending) || !run || run.training?.originmanWorkshop?.phase !== 'train' || handoff?.executionAvailable === false;
      const isActive = groupRuns().some(active);
      const reviewRequired = Boolean(link || handoff) && (!handoff || handoffError || handoff.intent !== 'tune' || !$('originman-confirm-parameters').checked || groupId() === (handoff.run.training.originmanWorkshop.groupId || 'group-01'));
      $('originman-train').disabled = !owner || !identityPreconditionAvailable || busy || (!pending && reviewRequired) || (isActive && !pending) || (pending && pending.phase !== 'train');
      $('originman-train').textContent = pending?.phase === 'train' ? '重试同一训练提交' : '1. 创建本组训练';
      $('originman-evaluate').disabled = !owner || !identityPreconditionAvailable || referenceMode || busy || (isActive && !pending) || (!pending && (run?.status !== 'completed' || handoff?.executionAvailable === false)) || (pending && pending.phase !== 'evaluate');
      $('originman-evaluate').textContent = pending?.phase === 'evaluate' ? '重试同一评测提交' : '2. 评测所选权重';
      for (const id of ['originman-engine', 'originman-device', 'originman-group', 'originman-steps', 'originman-seed', 'originman-force', 'originman-resource', 'originman-run', 'originman-evaluation']) $(id).disabled = busy || Boolean(pending);
      if (handoff) {
        $('originman-engine').disabled = true; $('originman-resource').disabled = true;
        if (handoff.intent === 'inspect') for (const name of ['device', 'group', 'steps', 'seed', 'force']) $('originman-' + name).disabled = true;
      }
      const progress = run?.progress || [];
      $('originman-progress').hidden = !progress.length;
      if (progress.length) chart($('originman-progress-chart'), [{ name: '本组训练奖励', points: progress.map((p) => [p.iteration, p.meanReward]) }], '奖励 / 累计控制步');
      if (run) {
        const cfg = run.training.originmanWorkshop;
        const last = progress[progress.length - 1];
        const device = run.metrics?.originmanWorkshop?.trainingDevice;
        const deviceLabel = device && typeof device === 'object' ? device.requestedDevice + ' / 实际 ' + device.parameterDevices.join('、') : device || '未记录';
        text('originman-provenance', `${referenceMode ? '课前制品（非本组成绩）' : '本组训练'} Run：${run.id} · ${run.status} · ${engineLabel(run.training.engine)} · 请求 ${cfg.timesteps} 步${run.metrics?.originmanWorkshop ? ` / 实际 ${run.metrics.originmanWorkshop.actualTimesteps} 步 · 训练设备 ${deviceLabel} / 仿真 CPU · 策略 ${run.metrics.originmanWorkshop.policySha256.slice(0, 12)}` : ''} · seed=${cfg.seed} · 训练侧推上限 ${cfg.pushMaxForce}N${last ? ` · 最近开发检查恢复 ${Math.round(last.recentSuccess * 9)}/9` : ''}。评测只读取所选 Run 的权重。`);
      } else text('originman-provenance', '当前小组尚无训练记录；切换小组不会改动其他组的实验。');
      const assessment = evaluated.find((r) => r.id === selectedEvaluation);
      const result = assessment?.metrics?.originmanWorkshop;
      $('originman-comparison').hidden = !result?.cases;
      $('originman-verdict').hidden = !result?.cases;
      if (result?.cases) {
        const feedback = result.feedbackComparison;
        text('originman-baseline-column', feedback ? '相对调参反馈' : '相对原 PD');
        const suite = feedback?.suites.find(s => s.id === $('originman-suite').value) || feedback?.suites[0];
        $('originman-suite').disabled = !feedback;
        text('originman-verdict', (function recoveryVerdict(cases, referenceMode, clearGain, tunedAvailable) {
  const prefix = referenceMode ? '课前结果，非本组成绩。' : '';
  if (!Array.isArray(cases) || !cases.length || cases.some(c => !Number.isFinite(c.force) ||
      !['original', 'tuned', 'rl'].every(k => typeof c[k] === 'boolean')))
    return prefix + '受扰恢复尚未验证：逐条条件记录不完整，不能用整体通过数代替。';
  const pushed = cases.filter(c => c.force !== 0), standing = cases.filter(c => c.force === 0);
  const counts = rows => ['original', 'tuned', 'rl'].map(k => rows.filter(c => c[k]).length);
  const p = counts(pushed), s = counts(standing);
  return prefix + `受扰恢复：原 PD ${p[0]}/${pushed.length}，` +
    (tunedAvailable ? `调参反馈 ${p[1]}/${pushed.length}，` : '尚无调参反馈对照，') +
    `RL ${p[2]}/${pushed.length}。无扰站立：原 PD ${s[0]}/${standing.length}，` +
    (tunedAvailable ? `调参反馈 ${s[1]}/${standing.length}，` : '') +
    `RL ${s[2]}/${standing.length}（不计入受扰恢复）。` +
    (clearGain === true ? '本条件集达到改善判据。' : clearGain === false ? '本条件集未达到改善判据，保留并分析。' : '效果判据尚未核对。') +
    '全部条件仍保留；仅仿真，不代表真机成功率。';
})(suite ? suite.cases : result.cases.map(c => ({...c, original:c.baseline, tuned:c.baseline})), referenceMode, suite ? suite.clearGain : result.clearGain, Boolean(suite)));
        const cases = suite ? suite.cases : result.cases.map(c => ({...c, tuned:c.baseline, original:c.baseline}));
        const improved = cases.filter(c => !c.tuned && c.rl).map(c=>c.index);
        const regressed = cases.filter(c => c.tuned && !c.rl).map(c=>c.index);
        const condition = cases[suite ? suite.selectedCase : result.selectedCase];
        text('originman-comparison-note', `相对${suite ? '冻结调参反馈' : '原PD'}改善：${improved.join('、') || '无'}；退化：${regressed.join('、') || '无'}。曲线为本条件集 ${condition.index}：${condition.force}N，${condition.start}s 开始，持续0.2s。新版按第一个结果不一致条件选例，无差异则展示条件3；全部31项保留。不是未见测试或真机成功率。`);
        const traces = suite ? suite.traces : result.traces;
        chart($('originman-tilt-chart'), traces.map(t=>({name:labels[t.controller],points:t.frames.map(f=>[f[0],f[1]])})), '身体倾角（度）/ 仿真时间（秒）');
        const rl = traces.find(t=>t.controller==='rl');
        chart($('originman-correction-chart'), [{name:'实际额外踝目标',points:rl.frames.map(f=>[f[0],f[2]])},{name:'实际额外髋目标',points:rl.frames.map(f=>[f[0],f[3]])}], 'RL额外目标（rad），不是实测角度');
        $('originman-cases').replaceChildren(...cases.map(c=>{
          const tr=document.createElement('tr');
          for (const value of [c.index,`${c.force}N / ${c.start}s`,c.original?'恢复':'未恢复',suite?(c.tuned?'恢复':'未恢复'):'旧记录未测',c.rl?'恢复':c.fallen?'跌倒':'未稳定',c.frozen?'恢复':'未恢复',c.rl&&!c.tuned?'改善':c.tuned&&!c.rl?'退化':'—']) {
            const td=document.createElement('td');td.textContent=String(value);tr.append(td);
          } return tr;
        }));
        const video = $('originman-video');
        const src = result.video ? apiPath(`/sim2real/runs/${encodeURIComponent(assessment.id)}/workshop-video${catalog?.capabilities?.videoFormats?.includes('webm') ? '?format=webm' : ''}`) : '';
        if (video.getAttribute('src') !== src) { if (src) video.src = src; else video.removeAttribute('src'); }
        video.hidden = !src;
        text('originman-video-note', src ? `${referenceMode ? '课前制品回放，非本组实时结果。' : ''}视频固定展示原公开条件集${feedback ? `条件${feedback.suites[0].selectedCase}的原PD、调参反馈、冻结输出与RL` : '的旧版四组对照'}，切换条件集不改变视频。失败保持终止姿态。仅仿真。` : result.videoError || '本次尚无物理回放。');
      } else {
        $('originman-video').hidden = true;
        $('originman-video').removeAttribute('src');
        text('originman-video-note', run ? '完成所选训练的评测后，这里会显示该策略的物理回放。' : '先在训练页面创建本组训练，再评测所选权重，即可查看物理回放。');
      }
    }

    async function refresh() {
      if (loading) { refreshRequested = true; return; }
      loading = true;
      try {
        const refreshOwner = await currentOwner();
        adoptOwner(refreshOwner);
        if (!refreshOwner) { render(); throw new Error('请先登录当前账号'); }
        if (!catalog) { catalog = await request('/sim2real/workshops/originman'); if(catalog.defaults?.device) $('originman-device').value=catalog.defaults.device; }
        if ($('originman-model-info')) text('originman-model-info', catalog.modelPreviewUrl ? `OriginMan · ${catalog.manifest.contract.jointCount} 关节 · MuJoCo 仿真结构；训练策略由本组任务生成。` : 'OriginMan 模型结构预览尚未配置，请先为服务接入场景资源。训练可使用已配置的课程 Worker。');
        simulatorUI?.setPreview(catalog.modelPreviewUrl ? apiPath(catalog.modelPreviewUrl) : '');
        if (catalog.modelPreviewUrl && $('originman-model-preview')) { const image = $('originman-model-preview'); if (!image.getAttribute('src')) image.src = apiPath(catalog.modelPreviewUrl); image.hidden = false; }
        text('originman-evaluation-scope', '50 万步为主实验；短训练仅检查流程。原公开31 + 补充固定31，共2个固定公开条件集、62项条件；两轮逐项比较同一条件，不是未见测试或真机成功率。' + (catalog.capabilities?.conditionCount && catalog.capabilities.conditionCount !== 62 ? ` 平台当前声明${catalog.capabilities.conditionCount}项，与课程协议不一致，需核对资源能力；已有结果以实际回执为准。` : ''));
        const reference = catalog.reference;
        if ($('originman-prepared-reference')) {
          $('originman-prepared-reference').hidden = !reference?.available;
          if (reference?.available) {
            text('originman-prepared-reference-note', '课前参考，非本组训练。' + reference.note);
            const src = apiPath(reference.videoPath) + (catalog.capabilities?.videoFormats?.includes('webm') ? '?format=webm' : '');
            if ($('originman-reference-video').getAttribute('src') !== src) $('originman-reference-video').src = src;
          }
        }
        const snapshot = await request('/sim2real/runs');
        const nextRuns = (snapshot.runs || []).filter((r) => ENGINES.includes(r.training?.engine));
        for (const run of nextRuns.filter(active)) {
          const latest = await request(`/sim2real/runs/${encodeURIComponent(run.id)}`, { headers: { 'X-Rdk-Expected-Identity': encodeURIComponent(refreshOwner) }, cache: 'no-store' });
          const i = nextRuns.findIndex((r) => r.id === run.id); if (i >= 0) nextRuns[i] = latest.run;
        }
        const resources = ownerResources;
        options($('originman-resource'), [{ value: '', label: '服务端配置的课程 Worker' }, ...resources.filter((r) => r.source !== 'local-agent').map((r) => ({ value: r.id, label: r.name || r.id }))], pending?.body?.computeResourceId || $('originman-resource').value, '课程 Worker');
        await loadHandoff(nextRuns, refreshOwner);
        const latestOwner = await currentOwner();
        if (latestOwner !== refreshOwner) { adoptOwner(latestOwner); render(); throw new Error('账号已切换，请重新读取来源训练'); }
        runs = nextRuns;
        render();
        await roundComparison?.refresh(refreshOwner);
        if (owner !== refreshOwner) return;
        const latest = evaluations().find(active) || evaluations().find(r => r.id === selectedEvaluation) || selectedRun();
        if (pending) status('本账号有结果待确认的提交；重试会沿用原配置和同一幂等键。');
        else if (handoffError) status(handoffError);
        else if (!identityPreconditionAvailable) status('平台缺少身份预检能力，当前仅可查看；请升级平台后提交训练。');
        else if (latest && (active(latest) || latest.training.originmanWorkshop.phase === 'evaluate') && !pending) status(currentRunStatus(latest));
        else if (handoff && !pending) status(handoff.intent === 'inspect' ? '已定位指定训练；可查看结果，或复制参数开始调优。' : '请核对原值与本次参数，确认新实验分组后创建训练。');
        else if (referenceMode && !pending) status('课前已验收结果回看，未创建新任务。本组后台任务和真实成绩保留。');
        else if (latest && !pending) status(currentRunStatus(latest));
        else if (!latest && !pending) status('可以创建本组训练。模型由已配置的 Worker 提供；未配置时平台会明确拒绝。');
        if (latest?.externalRunId) {
          try { await logs(latest.id); }
          catch (error) { text('originman-logs', `日志暂时不可读：${error.message}。已有运行记录仍保留，可刷新重试。`); }
        } else if (latest) text('originman-logs', latest.summary || 'Worker尚未受理，请查看运行状态。');
      } catch (error) { roundComparison?.unavailable(); status(`读取失败：${error.message}。已显示的数据保留，可刷新重试。`); }
      finally { loading = false; if (refreshRequested) { refreshRequested = false; void refresh(); } }
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
      if (busy || (!pending && groupRuns().some(active))) return;
      if (phase === 'train' && !pending && (link || handoff) && (!handoff || handoffError || handoff.intent !== 'tune' || !$('originman-confirm-parameters').checked || groupId() === (handoff.run.training.originmanWorkshop.groupId || 'group-01'))) { status('请先确认来源、参数差异和新的实验分组'); return; }
      if (phase === 'train' && !pending && !form.reportValidity()) return;
      busy = true; render();
      let submissionOwner = null;
      const submissionGeneration = ownerGeneration;
      let submissionPending = pending;
      const submissionDraftSource = handoff?.intent === 'tune' ? handoff.run.id : link?.intent === 'tune' ? link.id : undefined;
      const currentSubmission = () => ownerGeneration === submissionGeneration && owner === submissionOwner && pending === submissionPending;
      const clearSubmittedSlot = () => {
        if (!submissionPending || !submissionOwner) return;
        const key = storageKey('pending', submissionOwner);
        const stored = saved(key);
        if (stored?.owner === submissionOwner && stored.key === submissionPending.key) save(key, null);
      };
      try {
        const activeOwner = await currentOwner();
        if (!activeOwner || !identityPreconditionAvailable) throw new Error('无法确认账号或平台缺少身份预检能力，请重新登录或升级平台');
        if (activeOwner !== owner) { adoptOwner(activeOwner); throw new Error('账号已切换，请重新检查本组配置'); }
        submissionOwner = activeOwner;
        if (!currentSubmission()) throw new Error('账号已切换，请重新检查本组配置');
        if (!pending) {
          if (!catalog) { catalog = await request('/sim2real/workshops/originman'); if(catalog.defaults?.device) $('originman-device').value=catalog.defaults.device; }
          const parent = selectedRun();
          if (phase === 'evaluate' && parent?.status !== 'completed') throw new Error('请先选择已完成的本组训练');
          const models = await request('/sim2real/models');
          if (!currentSubmission()) throw new Error('账号已切换，请重新检查本组配置');
          const boundModelId = phase === 'evaluate' ? parent.modelId : handoff?.run.modelId;
          let model = boundModelId ? models.models.find(m => m.id === boundModelId) : models.models.find((m) => m.manifest.modelId === catalog.manifest.modelId && m.manifest.contract.id === catalog.manifest.contract.id);
          if (boundModelId && !model) throw new Error('来源模型已不可用，请恢复模型后重新检查');
          if (!model) model = (await request('/sim2real/models', { method: 'POST', headers: { 'X-Rdk-Expected-Identity': encodeURIComponent(submissionOwner) }, body: JSON.stringify({ manifest: catalog.manifest }) })).model;
          if (!currentSubmission()) throw new Error('账号已切换，请重新检查本组配置');
          const cfg = phase === 'train' ? { phase, groupId: groupId(), timesteps: Number($('originman-steps').value), seed: Number($('originman-seed').value), pushMaxForce: Number($('originman-force').value) } : { phase, ...(parent.training.originmanWorkshop.groupId ? { groupId: parent.training.originmanWorkshop.groupId } : {}), timesteps: parent.training.originmanWorkshop.timesteps, seed: parent.training.originmanWorkshop.seed, pushMaxForce: parent.training.originmanWorkshop.pushMaxForce, sourceRunId: parent.id };
          if (phase === 'train' && $('originman-device').value) cfg.device = $('originman-device').value;
          if (phase === 'evaluate' && parent.training.originmanWorkshop.device) cfg.device = parent.training.originmanWorkshop.device;
          const engine = phase === 'train' ? handoff?.run.training.engine || $('originman-engine').value : parent.training.engine;
          if (!ENGINES.includes(engine)) throw new Error('未知策略结构，请刷新页面');
          const resource = phase === 'train' ? handoff?.run.computeResourceId || $('originman-resource').value : parent.computeResourceId;
          pending = { phase, key: `originman-${crypto.randomUUID()}`, body: { backend: 'local', taskId: 'originman-recovery', modelId: model.id, label: phase === 'train' ? `OriginMan ${groupId()} SAC · seed ${cfg.seed} · ${cfg.timesteps}步` : `OriginMan ${catalog.capabilities?.conditionCount || 62}条件评测 · ${parent.id}`, ...(resource ? { computeResourceId: resource } : {}), training: { profile: 'standard', engine, algorithm: 'sac', numEnvs: 4, maxIterations: Math.ceil(cfg.timesteps / 256), video: phase === 'evaluate', originmanWorkshop: cfg } } };
          if (phase === 'train') {
            const baselineId = handoff?.intent === 'tune' ? handoff.run.id : roundComparison?.sourceForSubmission();
            if (baselineId) {
              if (handoff?.intent === 'tune') roundComparison?.begin(baselineId, true);
              pending.comparisonSourceRunId = baselineId;
              pending.comparisonContextId = roundComparison?.contextId();
            }
          }
          submissionPending = pending;
        }
        pending.owner = submissionOwner;
        save(storageKey('pending', submissionOwner),pending);
        render();
        status(`正在提交${phase === 'train' ? '训练' : '评测'}；请保留页面，避免重复创建。`);
        const preSubmitOwner = await currentOwner();
        if (preSubmitOwner !== submissionOwner || !identityPreconditionAvailable || !currentSubmission()) { if (currentSubmission()) { adoptOwner(preSubmitOwner); status('账号已切换，请重新检查本组配置；原账号的待确认提交已保留。'); } throw new Error('账号已切换，请重新检查本组配置'); }
        const accepted = await submitPreparedRun(request, submissionPending, submissionOwner, () => {
          if (!currentSubmission()) throw new Error('账号已切换，请重新检查本组配置');
          submissionPending.attempted = true;
          save(storageKey('pending', submissionOwner), submissionPending);
        });
        if (phase === 'train') clearAcceptedDraft(submissionOwner, submissionPending.comparisonSourceRunId || submissionDraftSource);
        // Persist the accepted association to the submitting account before any late identity check.
        // This writes only its isolated reference slot; it cannot display it in the new account.
        const associationSaved = phase !== 'train' || !submissionPending.comparisonSourceRunId || roundComparison?.recordAcceptedForOwner(accepted.run.id, submissionPending.comparisonSourceRunId, submissionPending.comparisonContextId, submissionOwner);
        const latestOwner = await currentOwner();
        if (associationSaved) clearSubmittedSlot();
        if (!currentSubmission() || latestOwner !== submissionOwner) { adoptOwner(latestOwner); await refresh(); return; }
        if (phase === 'train') { referenceMode = false; selected = accepted.run.id; selectedEvaluation = ''; }
        else selectedEvaluation = accepted.run.id;
        pending = null;
        if (phase === 'train') {
          roundComparison?.accepted(accepted.run.id, submissionPending.comparisonSourceRunId, submissionPending.comparisonContextId);
          const submittedGroup = submissionPending.body.training.originmanWorkshop.groupId || 'group-01';
          $('originman-group').value = submittedGroup;
          save(storageKey('group', submissionOwner), submittedGroup);
          link = null; handoff = null; handoffError = ''; handoffLoadedOwner = null;
          const url = new URL(location.href); for (const name of ['sourceRunId', 'contextId', 'intent']) url.searchParams.delete(name); url.searchParams.set('originmanGroup', submittedGroup); history.replaceState(null, '', url);
        }
        await refresh();
        onSubmitted?.(phase);
      } catch (error) {
        if (submissionOwner && !currentSubmission()) return;
        // A transport failure may follow acceptance. Keep the identical key/body for retry.
        const identityChanged = (error.payload?.code || error.payload?.error) === 'SIM2REAL_IDENTITY_CHANGED';
        if (identityChanged) pending = null;
        else if (error.status >= 400 && error.status < 500 && error.status !== 408) {clearSubmittedSlot();pending = null;}
        status(`提交未完成：${error.message}${pending ? '。重试将沿用同一幂等键和配置。' : ''}`);
      } finally { busy = false; render(); }
    }

    form.addEventListener('submit', (event) => { event.preventDefault(); void submit('train'); });
    const editParameters = event => { if (draftFields.some(name => event.target?.id === 'originman-' + name)) { editedDraftFields.add(event.target.id.slice('originman-'.length)); $('originman-confirm-parameters').checked = false; persistDraft(); } render(); };
    form.addEventListener('input', editParameters);
    form.addEventListener('change', editParameters);
    $('originman-confirm-parameters').addEventListener('change', render);
    async function openTuning(runId) {
      if (busy || pending || !runId) return;
      handoffEpoch += 1; editedDraftFields.clear();
      link = { id: runId, intent: 'tune', error: '' }; handoff = null; handoffError = ''; handoffLoadedOwner = null;
      const url = new URL(location.href); url.searchParams.set('sourceRunId', runId); url.searchParams.set('intent', 'tune'); history.replaceState(null, '', url);
      panel.open = true; onConfigure?.(); render(); await refresh();
    }
    $('originman-copy-parameters').addEventListener('click', () => void openTuning(handoff?.run.id));
    $('originman-tune-selected').addEventListener('click', () => void openTuning(selectedRun()?.id));
    $('originman-close-handoff').addEventListener('click', () => {
      if (busy || pending) return;
      handoffEpoch += 1; editedDraftFields.clear();
      link = null; handoff = null; handoffError = ''; handoffLoadedOwner = null;
      $('originman-confirm-parameters').checked = false;
      const url = new URL(location.href); for (const name of ['sourceRunId', 'contextId', 'intent']) url.searchParams.delete(name); history.replaceState(null, '', url);
      render();
    });
    let committedGroup = groupId();
    const commitGroup = () => {
      if (groupId() === committedGroup || !$('originman-group').reportValidity()) return;
      committedGroup = groupId();
      $('originman-confirm-parameters').checked = false;
      if (owner) save(storageKey('group'), groupId());
      const url = new URL(location.href); url.searchParams.set('originmanGroup', groupId()); history.replaceState(null, '', url);
      selected = ''; selectedEvaluation = ''; referenceMode = false; render(); void refresh();
    };
    $('originman-group').addEventListener('change', commitGroup);
    $('originman-group').addEventListener('blur', commitGroup);
    $('originman-group').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); commitGroup(); } });
    $('originman-resource').addEventListener('change', render);
    $('originman-suite').addEventListener('change', render);
    $('originman-use-reference').addEventListener('click', () => { referenceMode = true; selectedEvaluation = ''; render(); void refresh(); });
    $('originman-return-student').addEventListener('click', () => { referenceMode = false; selectedEvaluation = ''; render(); void refresh(); });
    $('originman-reference').addEventListener('change', () => { selectedEvaluation=''; render(); });
    $('originman-evaluate').addEventListener('click', () => void submit('evaluate'));
    $('originman-preview-selected')?.addEventListener('click', () => onPreview?.(selectedRun()?.id));
    $('originman-refresh').addEventListener('click', () => void refresh());
    $('originman-run').addEventListener('change', () => { referenceMode = false; selected = $('originman-run').value; selectedEvaluation = ''; render(); void refresh(); });
    $('originman-evaluation').addEventListener('change', () => { selectedEvaluation = $('originman-evaluation').value; render(); });
    $('originman-video').addEventListener('error', () => text('originman-video-note', '本次回放暂时无法读取，数值对照已保留。可刷新重试。'));
    $('originman-download').addEventListener('click', () => {
      const evaluation = runs.find((r) => r.id === selectedEvaluation);
      if (!evaluation?.metrics?.originmanWorkshop) return;
      const blob = new Blob([JSON.stringify({ viewRole: referenceMode ? 'course-reference' : 'learner', run: evaluation, source: selectedRun() }, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = `originman-${evaluation.id}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    $('originman-offline').addEventListener('click', async () => {
      const evaluation = runs.find(r=>r.id===selectedEvaluation), result=evaluation?.metrics?.originmanWorkshop;
      if (!result) return;
      const button=$('originman-offline');button.disabled=true;
      try {
        const page=document.implementation.createHTMLDocument('OriginMan 离线实验记录');
        page.documentElement.lang='zh-CN';
        const charset=page.createElement('meta');charset.setAttribute('charset','utf-8');page.head.append(charset);
        const meta=page.createElement('meta');meta.name='viewport';meta.content='width=device-width,initial-scale=1';page.head.append(meta);
        page.body.style.fontFamily='system-ui';page.body.style.lineHeight='1.7';page.body.style.margin='24px';
        const add=(tag,value)=>{const el=page.createElement(tag);el.textContent=value;page.body.append(el);return el;};
        add('h1','OriginMan 离线实验记录');
        add('p',`${referenceMode?'课前已验收制品，非本组成绩':'本组真实结果'}。训练Run：${selectedRun().id}；评测Run：${evaluation.id}；策略SHA256：${result.policySha256}。本页为已保存的仿真回看，不是实时训练或真机证据。`);
        add('p',$('originman-provenance').textContent);
        add('p',$('originman-verdict').textContent);
        add('p',$('originman-comparison-note').textContent);
        add('pre',JSON.stringify({training:selectedRun().training,baseline:result.feedbackComparison?.baselineId,baselineSha256:result.feedbackComparison?.baselineSha256},null,2));
        for (const id of ['originman-tilt-chart','originman-correction-chart']) {
          const img=page.createElement('img');img.alt=$(id).getAttribute('aria-label');img.src=$(id).toDataURL('image/png');img.style.maxWidth='100%';page.body.append(img);
        }
        for (const suite of result.feedbackComparison?.suites || []) {
          add('h2',suite.id==='historical'?'原公开31条件':'补充固定31条件');
          const table=page.createElement('table');
          for (const values of [['条件','推力','开始','原PD','调参反馈','RL','冻结输出'],...suite.cases.map(c=>[c.index,c.force,c.start,c.original,c.tuned,c.rl,c.frozen])]) {
            const tr=page.createElement('tr');for(const value of values){const td=page.createElement('td');td.textContent=typeof value==='boolean'?(value?'恢复':'未恢复'):String(value);td.style.padding='6px';tr.append(td);}table.append(tr);
          }page.body.append(table);
        }
        if (!result.feedbackComparison && result.cases) {
          add('h2','原公开31条件（历史契约）');
          const table=page.createElement('table');
          for(const values of [['条件','推力','开始','基础反馈','未训练','RL','冻结输出'],...result.cases.map(c=>[c.index,c.force,c.start,c.baseline,c.initial,c.rl,c.frozen])]) {
            const tr=page.createElement('tr'); for(const value of values){const td=page.createElement('td');td.textContent=typeof value==='boolean'?(value?'恢复':'未恢复'):String(value);td.style.padding='6px';tr.append(td);} table.append(tr);
          } page.body.append(table);
        }
        let included=false;
        try {
          if(result.video){
            const webm = catalog?.capabilities?.videoFormats?.includes('webm');
            const response=await fetch(apiPath(`/sim2real/runs/${encodeURIComponent(evaluation.id)}/workshop-video${webm ? '?format=webm' : ''}`),{credentials:'same-origin'});
            if(!response.ok)throw new Error('回放不可读');
            const bytes=await response.arrayBuffer();if(!bytes.byteLength||bytes.byteLength>20000000||!webm&&bytes.byteLength!==result.video.bytes)throw new Error('回放大小不符');
            const sha=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
            if(webm ? response.headers.get('X-Source-Artifact-Sha256')!==result.video.sha256 || response.headers.get('X-Artifact-Sha256')!==sha : sha!==result.video.sha256)throw new Error('回放摘要不符');
            const reader=new FileReader();const src=await new Promise((resolve,reject)=>{reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(new Blob([bytes],{type:webm?'video/webm':'video/mp4'}));});
            add('p',$('originman-video-note').textContent);
            const video=page.createElement('video');video.controls=true;video.src=String(src);video.style.maxWidth='100%';page.body.append(video);included=true;
          }
        }catch{add('p','本次未能导出回放；数值与图文已保留，缺失视频不算通过证据。');}
        add('p','离线文件来源固定；不删除失败，不把课前结果记为本组训练。');
        // Standalone exports own their layout; the workbench CSS is not loaded.
        const offlineLayout=page.createElement('style');
        offlineLayout.textContent=`
          body { min-width: 0; }
          p { overflow-wrap: anywhere; }
          pre { max-width: 100%; white-space: pre-wrap; overflow-wrap: anywhere; }
          .offline-report-table { min-width: 0; max-width: 100%; overflow-x: auto; }
          .offline-report-table table { width: max-content; min-width: 100%; table-layout: auto; border-collapse: collapse; }
          .offline-report-table th, .offline-report-table td { white-space: nowrap; word-break: normal; overflow-wrap: normal; }
          .offline-report-table:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
        `;
        page.head.append(offlineLayout);
        for (const [index,table] of [...page.querySelectorAll('table')].entries()) {
          const region=page.createElement('div');
          region.className='offline-report-table';
          region.tabIndex=0;
          region.setAttribute('role','region');
          region.setAttribute('aria-label',`条件结果表格 ${index+1}，可左右滚动`);
          table.before(region);region.append(table);
        }
        const blob=new Blob(['<!doctype html>\n'+page.documentElement.outerHTML],{type:'text/html;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`originman-${evaluation.id}-offline.html`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
        text('originman-reference-note',`已导出离线图文${included?'和嵌入回放':'，无回放'}；无需连接工作台即可回看。`);
      }catch(error){text('originman-reference-note',`导出失败：${error.message}；已有评测保留，可下载JSON或重试。`);}
      finally{button.disabled=false;}
    });
    const roundComparison = root.OriginmanRoundComparison?.mount({ request, apiPath, readOwner: currentOwner, onIdentityChanged: next => { adoptOwner(next); render(); } });
    const simulatorUI = root.OriginmanSimulator?.mount({ request, getSource: selectedRun });
    panel.addEventListener('toggle', () => { if (panel.open) void refresh(); });
    const timer = setInterval(() => { if (panel.open && !panel.hidden && !panel.closest('[data-view-section][hidden]') && !document.hidden) void refresh(); }, 3000);
    window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
    render();
    if (courseMode) panel.open = true;
    if (panel.open) void refresh();
    return { refresh, preview: async (runId) => {
      if (!runs.some(run => run.id === runId)) await refresh();
      const run = runs.find(item => item.id === runId);
      if (!run || run.status !== 'completed' || run.training?.originmanWorkshop?.phase !== 'train') {
        status('所选记录没有可装载的已完成训练权重，请选择本组训练。'); return false;
      }
      selected = runId; referenceMode = false; render();
      $('originman-sim-controller').value = 'trained';
      if (!simulatorUI) { status('交互仿真模块未加载，请刷新工作台。'); return false; }
      return await simulatorUI.connect();
    } };
  }
  function setProductScope(originmanActive) {
    for (const element of document.querySelectorAll('[data-view-section="evaluate"] > .evaluation-banner, [data-view-section="evaluate"] > .evaluation-next, .train-onboarding')) {
      element.hidden = originmanActive;
    }
    const tools = document.getElementById('generic-run-tools');
    if (tools) {
      if (tools.dataset.originmanScope !== String(originmanActive)) tools.open = !originmanActive;
      tools.dataset.originmanScope = String(originmanActive);
      tools.classList.toggle('advanced-settings', originmanActive);
      tools.querySelector('summary').hidden = !originmanActive;
      document.getElementById('generic-run-tools-note').hidden = !originmanActive;
    }
  }
  root.OriginmanWorkshop = { mount, chart, supportedEngines, submitPreparedRun, setProductScope };
})(globalThis);
