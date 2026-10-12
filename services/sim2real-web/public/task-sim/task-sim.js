import { FORMAT, clamp, normalizedAction, policyBinding, policyStepLimit, recordingAppendBudget, recordingHeader, recordingLineBytes, recordingSample, replaySnapshot, sameOriginPath } from './task-sim-core.mjs';
import { createRenderer } from './task-renderer.mjs';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const taskId = params.get('taskId') || '';
let apiBase, renderer, current = null, task = null, contract = null;
let running = false, recording = false, replaying = false, disposed = false, busy = false, mutating = false, active = true;
let epoch = 0, sessionId = '', timer = null, policy = null, policyLoading = false, policyAttempt = 0, rows = [], header = null;
let actionRows = [], queue = Promise.resolve(), ortPromise = null, policyRequest = null;
let pendingTransition = null, pendingRecordingNotice = null, mutationOwner = 0, recordingBytes = 0;
let appearancePhase = 'loading';
let appearanceName = 'MicroDuck';
const controllers = new Set();
const post = (type, data) => { if (window.parent !== window) window.parent.postMessage({ type, taskId, ...data }, location.origin); };
const status = (message, error = false) => { $('status').textContent = message; $('status').classList.toggle('is-error', error); };
const taskStatus = (phase, message) => post('rdk-simulator-task-state', { phase, message, controlHz: contract ? 1 / contract.controlPeriodSeconds : undefined, contract });
const policyStatus = (phase, message, trialId) => { status(message, phase === 'failed'); post('rdk-policy-status', { phase, message, trialId }); };
const copy = (value) => structuredClone(value);

function appearanceNote(appearance) {
  if (appearance?.phase) appearancePhase = appearance.phase;
  if (appearance?.modelName) appearanceName = appearance.modelName;
  const note = $('evidence-note');
  note.dataset.appearance = appearancePhase;
  note.textContent = appearancePhase === 'ready'
    ? `${appearanceName} 本体外观 · 训练代理动力学。基座跟随物理状态，姿态通道映射外观关节；手动动作不代表训练策略表现。`
    : appearancePhase === 'fallback'
      ? 'MicroDuck 简模外观 · 官方模型资源未挂载。训练代理动力学与真实任务状态保持可用。'
      : '正在加载 MicroDuck 官方外观；训练代理动力学与真实任务状态保持可用。';
}

async function api(path, options = {}) {
  const controller = new AbortController(); controllers.add(controller);
  try {
    const response = await fetch(`${apiBase}/${path}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal, ...options, headers: { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers } });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.message || payload?.error || (typeof payload?.detail === 'string' ? payload.detail : '') || `引擎请求失败（HTTP ${response.status}）`);
    if (!payload) throw new Error('引擎返回了空响应。');
    return payload;
  } finally { controllers.delete(controller); }
}
function serial(operation) { const next = queue.catch(() => {}).then(operation); queue = next.catch(() => {}); return next; }
function setOverlay(title, message, retry = false) { $('loading-card').hidden = false; $('loading-title').textContent = title; $('loading-message').textContent = message; $('retry').hidden = !retry; }
function updateControls() {
  const ready = Boolean(sessionId && current && !disposed && active);
  $('run').disabled = !ready || Boolean(policy) || policyLoading || mutating; $('run').textContent = running ? '暂停' : replaying ? '恢复仿真' : current?.done ? '已结束' : '开始仿真';
  $('step').disabled = !ready || running || Boolean(policy) || policyLoading || busy || mutating || replaying || current?.done;
  $('reset').disabled = !ready || mutating;
  $('zero').disabled = !ready || Boolean(policy) || policyLoading;
  $('record').disabled = !ready || replaying || policyLoading || mutating || current?.done || (busy && !recording);
  $('record').textContent = recording ? '停止录制' : '开始录制'; $('record').classList.toggle('is-recording', recording);
  $('export').disabled = rows.length === 0;
  const duration = rows.length ? rows.at(-1).t - (rows[0].t - contract.controlPeriodSeconds) : 0;
  $('record-count').textContent = `${rows.length} 帧 · ${Math.max(0, duration).toFixed(2)} s`;
  for (const input of $('actions').querySelectorAll('input')) input.disabled = !ready || Boolean(policy) || policyLoading || replaying || input.dataset.inactive === 'true';
}
function publishRecording() {
  if (!rows.length || !header) return;
  post('rdk-task-recording-ready', { format: FORMAT, taskName: task.name, sampleCount: rows.length, durationSeconds: rows.at(-1).t - (rows[0].t - contract.controlPeriodSeconds), contractId: header.contractId, observationSize: contract.observationDim, actionSize: contract.actionDim, numAgents: contract.numAgents || 1 });
}
function stopRecording(message, notify = true) {
  if (!recording) { if (!notify) pendingRecordingNotice = null; return; }
  recording = false;
  if (notify && pendingTransition?.recorded && pendingTransition.accepted && pendingTransition.rows === rows) pendingRecordingNotice = rows;
  else if (notify) publishRecording();
  if (message) status(message); updateControls();
}
const recordingText = () => header ? [header, ...rows].map((row) => JSON.stringify(row)).join('\n') + '\n' : '';
window.__rdkTaskRecorder = Object.freeze({ get recording() { return recording; }, getText: recordingText, getMetadata: () => ({ taskId, sampleCount: rows.length, format: FORMAT, recording }), stop: (options = {}) => { stopRecording('轨迹已保存。', options.notify !== false); return recordingText(); } });

const metricLabels = { reward: '奖励', height: '高度（m）', baseHeight: '本体高度（m）', upright: '直立程度', balance: '平衡', tilt: '倾斜角（rad）', swingAngle: '摆动角（rad）', rolledAway: '球已滚离支点', slipped: '已滑落', wrapped: '摆动超出范围', ballX: '球 X（m）', ballY: '球 Y（m）', distance: '目标距离', ballDistance: '距球距离', goalDistance: '距球门距离', score: '得分', scored: '进球', steps: '步数', success: '成功', fall: '跌倒', fallen: '跌倒', ballHeight: '球高度', hoopDistance: '距篮筐距离', elapsed: '运行时间', controlHz: '控制频率' };
function renderState(next, resetCamera = false) {
  if (next.taskId !== taskId) throw new Error('引擎返回了其他任务的状态，已停止。');
  if (!next.scene?.geoms?.length || !next.contract) throw new Error('引擎场景或动作契约缺失。');
  current = next; contract = next.contract;
  renderer.setScene(next.scene, { resetCamera });
  $('clock').textContent = `${Number(next.time).toFixed(2)} s · ${next.stepCount} 步`;
  const metrics = { reward: next.reward, ...next.metrics };
  $('metrics').replaceChildren();
  for (const [name, value] of Object.entries(metrics).slice(0, 12)) {
    const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = metricLabels[name] || name;
    dd.textContent = typeof value === 'number' ? value.toFixed(3) : typeof value === 'boolean' ? (value ? '是' : '否') : Array.isArray(value) ? value.map((n) => typeof n === 'number' ? n.toFixed(2) : String(n)).join(' / ') : String(value);
    $('metrics').append(dt, dd);
  }
  if (next.done && running) { running = false; stopRecording('本回合已结束，轨迹已保存。请重置后继续。'); status('本回合已结束。请重置后继续。'); if (policy) { const trialId = policy.trialId; releasePolicy(policy); policy = null; policyStatus('finished', '策略试跑完成：任务回合已结束。', trialId); } }
  updateControls();
}

function buildActions() {
  const agents = contract.numAgents || 1;
  actionRows = Array.from({ length: agents }, () => Array(contract.actionDim).fill(0));
  $('actions').replaceChildren();
  for (let agent = 0; agent < agents; agent++) {
    if (agents > 1) { const label = document.createElement('div'); label.className = 'agent-label'; label.textContent = `智能体 ${agent + 1}`; $('actions').append(label); }
    for (let index = 0; index < contract.actionDim; index++) {
      const row = document.createElement('div'); row.className = 'action-row';
      const label = document.createElement('label'), input = document.createElement('input'), value = document.createElement('output');
      const id = `action-${agent}-${index}`; label.htmlFor = id; label.textContent = contract.actionDim === 4 ? ['前后移动', '横向移动', '转向（预留）', '踢球'][index] : `姿态 ${index + 1}`; label.title = contract.actionLabels?.[index] || label.textContent;
      input.id = id; input.type = 'range'; input.min = '-1'; input.max = '1'; input.step = '.01'; input.value = '0'; value.value = '0.00'; input.dataset.inactive = String(contract.inactiveActionIndices?.includes(index) || false);
      input.addEventListener('input', () => { actionRows[agent][index] = clamp(input.value); value.value = actionRows[agent][index].toFixed(2); });
      row.append(label, input, value); $('actions').append(row);
    }
  }
  $('action-contract').textContent = `${contract.actionDim}D${agents > 1 ? ` × ${agents}` : ''}`;
  $('action-help').textContent = contract.actionDim === 4 ? '动作范围 −1 到 1。聚焦场景后 W/S 前后、A/D 横移、空格踢球（智能体 1）。转向为引擎预留维度。' : '14 个姿态目标增量，范围 −1 到 1。零动作保持引擎默认姿态目标。';
}
function setAction(agent, index, value) { actionRows[agent][index] = clamp(value); const input = $(`action-${agent}-${index}`); if (input) { input.value = String(value); input.nextElementSibling.value = clamp(value).toFixed(2); } }
function zeroActions() { for (let agent = 0; agent < actionRows.length; agent++) for (let i = 0; i < actionRows[agent].length; i++) setAction(agent, i, 0); }
function manualAction() { return normalizedAction(copy(contract.numAgents > 1 ? actionRows : actionRows[0]), contract); }

function releasePolicy(active) { if (!active?.session || active.released) return; active.released = true; void Promise.resolve(active.inference).catch(() => {}).then(() => active.session.release()).catch(() => {}); }
function stopPolicy(message = '策略试跑已停止。') { if (!policy && !policyLoading) return; const trialId = (policy || policyRequest)?.trialId; releasePolicy(policy); policy = null; policyRequest = null; policyLoading = false; policyAttempt++; running = false; policyStatus('stopped', message, trialId); updateControls(); }
async function advance() {
  if (!sessionId || busy || !current || current.done || replaying || disposed || !active) return;
  busy = true; const token = epoch, before = copy(current), activePolicy = policy;
  let transition = null;
  try {
    const action = activePolicy ? await infer(activePolicy, before) : manualAction();
    if (disposed || token !== epoch || !active || (activePolicy && policy !== activePolicy)) return;
    transition = { rows, recorded: recording, accepted: false, sessionId }; pendingTransition = transition;
    const next = await serial(() => {
      if (disposed || token !== epoch || !active || (activePolicy && policy !== activePolicy)) return null;
      transition.accepted = true;
      return api(`task-sessions/${encodeURIComponent(transition.sessionId)}/step`, { method: 'POST', body: JSON.stringify({ action, steps: 1 }) });
    });
    if (!next) return;
    // A step already accepted by the backend remains a real recorded transition
    // even if the workbench was hidden while its response was in flight.
    if (transition.recorded && transition.rows === rows) {
      const sample = recordingSample(before, next, action), budget = recordingAppendBudget(sample, recordingBytes);
      if (budget.accepted) { rows.push(sample); recordingBytes = budget.bytes; }
      if (!budget.accepted || rows.length >= 30000) stopRecording(!budget.accepted ? '已达到 30 MiB 录制上限，已保存此前完整帧。' : '已达到 30,000 帧录制上限，轨迹已保存。');
    }
    if (disposed || token !== epoch) return;
    if (!active) return;
    renderState(next);
    if (activePolicy && policy === activePolicy) { activePolicy.steps++; if (activePolicy.steps >= activePolicy.maxSteps) { releasePolicy(policy); policy = null; running = false; stopRecording('策略试跑达到步数上限，录制已保存。'); policyStatus('finished', `策略试跑结束：${activePolicy.steps} 步。`, activePolicy.trialId); } }
  } catch (error) {
    if (disposed || token !== epoch) return;
    running = false; stopRecording(); if (policy) { const trialId = policy.trialId; releasePolicy(policy); policy = null; policyStatus('failed', error.message, trialId); } else { status(error.message, true); setOverlay('仿真连接中断', error.message, true); taskStatus('failed', error.message); }
  } finally {
    if (pendingTransition === transition) pendingTransition = null;
    if (pendingRecordingNotice === rows) { pendingRecordingNotice = null; publishRecording(); }
    busy = false; updateControls();
  }
}
async function loop() {
  if (disposed) return;
  const started = performance.now(); if (running && !replaying && active) await advance();
  timer = setTimeout(loop, Math.max(5, (contract?.controlPeriodSeconds || .02) * 1000 - (performance.now() - started)));
}

async function initialize() {
  const token = ++epoch; running = false; replaying = false; stopPolicy(); stopRecording();
  setOverlay('连接仿真引擎…', '正在创建与当前任务对应的独立场景。'); taskStatus('loading', '正在加载任务场景。');
  try {
    if (!taskId) throw new Error('没有指定任务。请从工作台选择一个任务。');
    apiBase = sameOriginPath(params.get('mujocoBase'), location.origin, '/mujoco') + '/api';
    if (!renderer) renderer = createRenderer($('viewport'), { duckAssetBase: params.get('duckAssetBase') || new URL('../mujoco/microduck/robot/mjlab/', location.href).href, onAppearance: appearanceNote });
    if (sessionId) { const old = sessionId; sessionId = ''; await serial(() => api(`task-sessions/${encodeURIComponent(old)}`, { method: 'DELETE' })).catch(() => {}); }
    const catalog = await api('task-scenes');
    if (token !== epoch || disposed) return;
    task = catalog.scenes?.find((entry) => entry.taskId === taskId);
    if (!task) throw new Error(`该任务没有可用的训练引擎场景：${taskId}`);
    if (task.available === false) throw new Error(task.unavailableReason || '该任务的训练引擎尚未安装。');
    $('task-name').textContent = task.name; $('engine-name').textContent = `${task.engine} · 引擎场景`; $('description').textContent = task.description || '';
    const next = await serial(() => api('task-sessions', { method: 'POST', body: JSON.stringify({ taskId }) }));
    if (token !== epoch || disposed) { if (next.sessionId) void api(`task-sessions/${encodeURIComponent(next.sessionId)}`, { method: 'DELETE' }).catch(() => {}); return; }
    sessionId = next.sessionId; renderState(next, true); buildActions(); $('loading-card').hidden = true;
    $('scene-badge').textContent = `${task.name} · ${(1 / contract.controlPeriodSeconds).toFixed(1)} Hz`;
    appearanceNote();
    status('场景已就绪。可运行、单步或录制真实任务轨迹。'); taskStatus('ready', '任务场景已就绪。'); updateControls();
  } catch (error) {
    if (token !== epoch || disposed) return;
    setOverlay('场景加载失败', error.message, true); status(error.message, true); taskStatus('failed', error.message); updateControls();
  }
}

async function reset() {
  if (!sessionId || mutating) return;
  stopPolicy(); running = false; replaying = false; stopRecording('录制已停止，已有轨迹可导出。'); const token = ++epoch, owner = ++mutationOwner; mutating = true; updateControls();
  try { const next = await serial(() => api(`task-sessions/${encodeURIComponent(sessionId)}/reset`, { method: 'POST', body: '{}' })); if (token !== epoch || disposed) return; zeroActions(); renderState(next, true); status('场景已重置。'); }
  catch (error) { if (token === epoch) status(error.message, true); }
  finally { if (owner === mutationOwner) mutating = false; updateControls(); }
}

function loadOrt() {
  if (!ortPromise) ortPromise = new Promise((resolve, reject) => {
    if (window.ort) { resolve(window.ort); return; }
    const script = document.createElement('script'); script.src = new URL('../vendor/onnxruntime-web/dist/ort.min.js', document.baseURI).href;
    script.onload = () => window.ort ? resolve(window.ort) : reject(new Error('ONNX 运行时没有正确初始化。'));
    script.onerror = () => reject(new Error('ONNX 运行时加载失败，请检查平台运行时资源。')); document.head.append(script);
  }).then((ort) => { ort.env.wasm.wasmPaths = new URL('../vendor/onnxruntime-web/dist/', document.baseURI).href; ort.env.wasm.numThreads = 1; return ort; }).catch((error) => { ortPromise = null; throw error; });
  return ortPromise;
}
async function startPolicy(options) {
  if (!sessionId || current?.done || mutating || !active) { policyStatus('failed', '请等待场景就绪，激活仿真视图，并重置已结束的回合。', options.trialId); return; }
  stopPolicy(); stopRecording(); running = false; replaying = false;
  const token = ++epoch, attempt = ++policyAttempt; policyRequest = { trialId: options.trialId }; policyLoading = true; updateControls();
  let loadedSession = null;
  try {
    if (options.taskId !== taskId) throw new Error('策略任务与当前仿真任务不一致。');
    if (options.backend === 'board') throw new Error('当前任务场景尚未提供板端已加载策略的任务/维度证明，无法安全试跑。请使用该任务的 ONNX 制品。');
    if (!options.runId) throw new Error('缺少策略运行 ID。');
    const maxSteps = policyStepLimit(options.maxSteps);
    const state = await serial(() => api(`task-sessions/${encodeURIComponent(sessionId)}/state`));
    if (token !== epoch || attempt !== policyAttempt || disposed) return;
    renderState(state);
    if (state.done) throw new Error('当前任务回合已结束，请先重置再试跑策略。');
    const base = sameOriginPath(options.apiRoot, location.origin, '/api/sim2real');
    policyStatus('loading', '正在校验任务并加载 ONNX 策略…', options.trialId);
    const runResponse = await fetch(`${base}/runs/${encodeURIComponent(options.runId)}`, { credentials: 'same-origin', cache: 'no-store' });
    const runPayload = await runResponse.json();
    if (!runResponse.ok) throw new Error(runPayload.message || '策略运行不可访问。');
    const run = runPayload.run || runPayload;
    if (run.taskId !== taskId) throw new Error('ONNX 制品所属任务与当前场景不一致。');
    const ort = await loadOrt();
    const response = await fetch(`${base}/runs/${encodeURIComponent(options.runId)}/policy.onnx`, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) { const details = await response.json().catch(() => null); throw new Error(details?.message || `策略制品加载失败（HTTP ${response.status}）`); }
    const session = await ort.InferenceSession.create(await response.arrayBuffer(), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }); loadedSession = session;
    if (token !== epoch || attempt !== policyAttempt || disposed) { await session.release(); return; }
    const binding = policyBinding(session, contract);
    const hidden = {};
    for (const [name, actual] of Object.entries(binding.hiddenShapes)) {
      hidden[name] = new ort.Tensor('float32', new Float32Array(actual.reduce((a, b) => a * b, 1)), actual);
    }
    policyRequest = null; policyLoading = false; policy = { ort, session, ...binding, hidden, steps: 0, maxSteps, trialId: options.trialId };
    running = true; policyStatus('running', `策略正在当前任务场景中试跑（${Object.keys(hidden).length ? '循环状态持续传递' : '浏览器 ONNX 推理'}）。`, options.trialId); updateControls();
  } catch (error) { if (loadedSession) void loadedSession.release().catch(() => {}); if (token === epoch && attempt === policyAttempt && !disposed) { policy = null; policyRequest = null; policyLoading = false; running = false; policyStatus('failed', error.message, options.trialId); updateControls(); } }
}
async function infer(active, state) {
  const agents = contract.numAgents || 1;
  const observations = agents > 1 ? state.observation : [state.observation];
  if (observations.length !== agents || observations.some((row) => row.length !== contract.observationDim || row.some((n) => !Number.isFinite(n)))) throw new Error('引擎观测与策略契约不一致。');
  const feeds = { [active.inputName]: new active.ort.Tensor('float32', Float32Array.from(observations.flat()), [agents, contract.observationDim]), ...active.hidden };
  active.inference = active.session.run(feeds);
  const results = await active.inference;
  const output = results[active.outputName];
  if (!output || output.data.length !== agents * contract.actionDim) throw new Error(`模型动作输出不符合 ${contract.actionDim}D × ${agents} 契约，试跑已停止。`);
  for (const name of Object.keys(active.hidden)) { const next = results[name.replace('_in', '_out')]; if (!next) throw new Error('模型缺少循环状态输出。'); active.hidden[name] = next; }
  const action = Array.from({ length: agents }, (_, agent) => Array.from(output.data.slice(agent * contract.actionDim, (agent + 1) * contract.actionDim)));
  return normalizedAction(agents > 1 ? action : action[0], contract);
}

async function applyReplay(data) {
  const index = Number(data.index || 0);
  if (!sessionId) { const message = '场景正在加载，请稍后重新选择回放帧。'; status(message, true); post('rdk-replay-status', { phase: 'loading', index, message }); return; }
  let snapshot;
  try { snapshot = replaySnapshot({ ...data.frame, taskId: data.frame?.taskId || data.taskId }, taskId); }
  catch (error) { status(error.message, true); post('rdk-replay-status', { phase: 'failed', index, message: error.message }); return; }
  stopPolicy(); running = false; replaying = true; stopRecording(); const token = ++epoch, owner = ++mutationOwner; mutating = true; updateControls();
  try { const next = await serial(() => token === epoch ? api(`task-sessions/${encodeURIComponent(sessionId)}/replay`, { method: 'POST', body: JSON.stringify(snapshot) }) : null); if (token !== epoch || disposed || !next) return; renderState(next); const message = `回放帧 ${index + 1} · ${Number(next.time).toFixed(2)} s`; status(message); post('rdk-replay-status', { phase: 'applied', index, message }); }
  catch (error) { if (token === epoch) { status(error.message, true); post('rdk-replay-status', { phase: 'failed', index, message: error.message }); } }
  finally { if (owner === mutationOwner) mutating = false; updateControls(); }
}
window.addEventListener('message', (event) => {
  if (event.origin !== location.origin || event.source !== window.parent || !event.data || typeof event.data !== 'object') return;
  const data = event.data;
  if (data.type === 'rdk-replay-frame') void applyReplay(data);
  if (data.type === 'rdk-replay-stop' || data.type === 'rdk-replay-clear') { replaying = false; epoch++; status('回放已停止。当前姿态保留，可重置或继续仿真。'); updateControls(); }
  if (data.type === 'rdk-policy-run') void startPolicy(data);
  if (data.type === 'rdk-policy-stop') stopPolicy();
  if (data.type === 'rdk-simulator-active') {
    const next = data.active === true;
    if (next !== active) {
      active = next;
      if (!active) { if (sessionId) epoch++; running = false; stopPolicy('当前仿真视图已暂停。'); stopRecording('当前仿真视图已暂停，轨迹已保存。'); }
      else if (sessionId && !replaying) {
        const token = epoch, owner = ++mutationOwner; mutating = true;
        // Reconcile the last accepted step before enabling another command.
        void serial(() => api(`task-sessions/${encodeURIComponent(sessionId)}/state`)).then((nextState) => { if (active && token === epoch && !disposed) renderState(nextState); }).catch((error) => { if (token === epoch) status(error.message, true); }).finally(() => { if (owner === mutationOwner) mutating = false; updateControls(); });
      }
    }
    updateControls();
  }
});

$('run').addEventListener('click', () => { if (current?.done) return; replaying = false; running = !running; if (!running) stopRecording('仿真已暂停，录制已保存。'); status(running ? '手动动作驱动训练引擎场景。' : '仿真已暂停。'); updateControls(); });
$('step').addEventListener('click', () => { void advance(); }); $('reset').addEventListener('click', () => { void reset(); }); $('retry').addEventListener('click', () => { void initialize(); }); $('zero').addEventListener('click', zeroActions);
$('record').addEventListener('click', () => { if (recording) stopRecording('轨迹已保存，可导出或在工作台回放。'); else { rows = []; header = recordingHeader(task, contract); recordingBytes = recordingLineBytes(header); recording = true; running = true; replaying = false; status('正在录制真实引擎观测和动作。'); updateControls(); } });
$('export').addEventListener('click', () => { if (recording) stopRecording('录制已停止，正在导出轨迹。'); const url = URL.createObjectURL(new Blob([window.__rdkTaskRecorder.getText()], { type: 'application/x-ndjson' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${taskId}-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); });
const keyActions = { KeyW: [0, 1], KeyS: [0, -1], KeyA: [1, 1], KeyD: [1, -1], Space: [3, 1] };
window.addEventListener('keydown', (event) => { if (document.activeElement !== $('viewport') || contract?.actionDim !== 4 || !keyActions[event.code] || policy || replaying) return; event.preventDefault(); const [index, value] = keyActions[event.code]; setAction(0, index, value); });
window.addEventListener('keyup', (event) => { if (contract?.actionDim !== 4 || !keyActions[event.code]) return; const [index] = keyActions[event.code]; setAction(0, index, 0); });
window.addEventListener('blur', () => { if (contract?.actionDim === 4) zeroActions(); });
window.addEventListener('pagehide', () => { disposed = true; running = false; epoch++; clearTimeout(timer); releasePolicy(policy); renderer?.destroy(); for (const controller of controllers) controller.abort(); if (sessionId && apiBase) void fetch(`${apiBase}/task-sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE', credentials: 'same-origin', keepalive: true }).catch(() => {}); });
$('viewport').addEventListener('webglcontextlost', (event) => { event.preventDefault(); running = false; stopRecording(); stopPolicy(); status('WebGL 上下文已丢失，请重新加载仿真场景。', true); setOverlay('显示连接中断', '浏览器图形上下文已丢失，请刷新此页面。'); });
void initialize(); void loop();
