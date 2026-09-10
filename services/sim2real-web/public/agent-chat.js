(function () {
const $ = (id) => document.getElementById(id);
const messages = $('agent-chat-messages');
const planCard = $('agent-plan-card');
const evidence = $('agent-evidence');
const eventLog = $('agent-event-log');
const form = $('agent-chat-form');
const input = $('agent-chat-input');
const submitButton = form?.querySelector('button[type="submit"]');
const runtimeStatus = document.querySelector('.agent-chat-runtime');
const HISTORY_KEY = 'rdk-sim2real-agent-history-v1';
// 部署时页面挂在网关的 /sim2real/ 前缀下（nginx 转发时剥掉该前缀），
// 绝对 /api 路径必须带上同样的前缀，否则网关会返回 404。
const API_MOUNT_PREFIX = window.location.pathname.startsWith('/sim2real') ? '/sim2real' : '';
const SIMULATOR_ALLOWED_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd', 'q', 'e', 'f', 'r', 'g', 'c', 'm', 'b', ' ']);
const simulatorBridge = { frame: null, ready: false, recording: false, events: [], connectedAt: null, startedAt: 0, downloadUrl: '', downloadName: '', videoUrl: '', videoName: '', recorder: null, videoError: '' };

function bridgeStatus() {
  if (!evidence) return;
  evidence.querySelectorAll('[data-agent-bridge], [data-agent-recording]').forEach((node) => node.remove());
  const row = document.createElement('span');
  row.dataset.agentBridge = '1';
  row.className = 'agent-bridge-status';
  row.textContent = simulatorBridge.ready
    ? `仿真控制桥：同源已连接${simulatorBridge.recording ? ` · 录制中 · ${simulatorBridge.events.length} 个事件` : ''}`
    : '仿真控制桥：等待仿真器就绪…';
  evidence.append(row);
  if (simulatorBridge.downloadUrl) {
    const link = document.createElement('a');
    link.href = simulatorBridge.downloadUrl;
    link.download = simulatorBridge.downloadName;
    link.textContent = `下载 Agent 轨迹（${simulatorBridge.events.length} 条）`;
    link.className = 'agent-recording-download';
    link.dataset.agentRecording = '1';
    evidence.append(link);
  }
  if (simulatorBridge.videoUrl) {
    const link = document.createElement('a');
    link.href = simulatorBridge.videoUrl;
    link.download = simulatorBridge.videoName;
    link.textContent = '下载仿真视频（WebM）';
    link.dataset.agentRecording = '1';
    evidence.append(link);
  } else if (simulatorBridge.videoError) {
    const note = document.createElement('span');
    note.dataset.agentRecording = '1';
    note.textContent = `视频录制：${simulatorBridge.videoError}`;
    evidence.append(note);
  }
}

function setAgentBusy(busy, label = '') {
  if (!form) return;
  form.setAttribute('aria-busy', busy ? 'true' : 'false');
  if (submitButton) {
    submitButton.disabled = busy;
    submitButton.setAttribute('aria-busy', busy ? 'true' : 'false');
    submitButton.dataset.defaultLabel ||= submitButton.textContent.trim();
    submitButton.textContent = busy ? (label || '执行中…') : submitButton.dataset.defaultLabel;
  }
  if (input) input.disabled = busy;
  if (runtimeStatus) {
    runtimeStatus.classList.toggle('is-busy', busy);
    runtimeStatus.textContent = busy ? (label || '任务执行中…') : '工具链已连接';
  }
}

function renderAgentError(error, retryable = true) {
  const message = error instanceof Error ? error.message : String(error || '未知错误');
  addMessage('agent', `任务未完成：${message}${retryable ? ' 可以检查连接后重试。' : ''}`);
  if (eventLog) {
    const row = document.createElement('div');
    row.className = 'agent-event agent-event-error';
    const time = document.createElement('time');
    time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const text = document.createElement('span');
    text.textContent = message;
    row.append(time, text);
    eventLog.append(row);
    eventLog.scrollTop = eventLog.scrollHeight;
  }
}

function recordSimulatorEvent(type, key) {
  if (!simulatorBridge.recording) return;
  simulatorBridge.events.push({
    t: Number(((performance.now() - simulatorBridge.startedAt) / 1000).toFixed(3)),
    type,
    key,
    source: 'rdk-studio-agent',
  });
  bridgeStatus();
}

function dispatchSimulatorKey(key, durationMs = 500) {
  if (!simulatorBridge.ready || !SIMULATOR_ALLOWED_KEYS.has(key)) return false;
  const target = simulatorBridge.frame.contentWindow;
  target.focus();
  const code = key === ' ' ? 'Space' : key.length === 1 ? `Key${key.toUpperCase()}` : key;
  target.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true }));
  recordSimulatorEvent('keydown', key);
  window.setTimeout(() => {
    target.dispatchEvent(new KeyboardEvent('keyup', { key, code, bubbles: true, cancelable: true }));
    recordSimulatorEvent('keyup', key);
  }, durationMs);
  return true;
}

async function connectSimulatorBridge() {
  const frame = $('simulator-frame');
  if (!frame) return false;
  simulatorBridge.frame = frame;
  simulatorBridge.ready = false;
  bridgeStatus();
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const doc = frame.contentDocument;
      if (doc && doc.location.origin === window.location.origin && doc.body && !/SYSTEM HALTED|MUJOCO WASM.*FAILED/i.test(doc.body.innerText)) {
        // The upstream landing screen requires an explicit, safe start action
        // before keyboard commands reach the simulation loop.
        const enter = [...doc.querySelectorAll('button')].find((button) => /WADDLE IN/i.test(button.textContent || ''));
        if (enter) {
          enter.click();
          await new Promise((resolve) => window.setTimeout(resolve, 300));
        }
        // A document or loading canvas alone is not a usable control target.
        // Wait for the simulator's live telemetry before sending commands.
        if (!/ODO|CTRL\s*50\s*HZ/i.test(doc.body.innerText)) {
          await new Promise((resolve) => window.setTimeout(resolve, 500));
          continue;
        }
        simulatorBridge.ready = true;
        simulatorBridge.connectedAt = new Date().toISOString();
        bridgeStatus();
        return true;
      }
    } catch { /* cross-origin or transitional iframe state */ }
    await new Promise((resolve) => window.setTimeout(resolve, 500));
  }
  bridgeStatus();
  return false;
}

function startSimulatorRecording() {
  if (simulatorBridge.downloadUrl) URL.revokeObjectURL(simulatorBridge.downloadUrl);
  simulatorBridge.downloadUrl = '';
  simulatorBridge.downloadName = '';
  if (simulatorBridge.videoUrl) URL.revokeObjectURL(simulatorBridge.videoUrl);
  simulatorBridge.videoUrl = '';
  simulatorBridge.videoError = '';
  simulatorBridge.startedAt = performance.now();
  simulatorBridge.events = [{ t: 0, type: 'recording.start', source: 'rdk-studio-agent', schema: 'simulator-command-v1' }];
  simulatorBridge.recording = true;
  try {
    const canvas = simulatorBridge.frame.contentDocument.querySelector('canvas');
    if (!canvas?.captureStream || typeof MediaRecorder === 'undefined') throw new Error('当前浏览器不支持画面录制；轨迹仍可下载');
    const stream = canvas.captureStream(30);
    const chunks = [];
    const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      if (chunks.length) {
        simulatorBridge.videoUrl = URL.createObjectURL(new Blob(chunks, { type: recorder.mimeType || 'video/webm' }));
        simulatorBridge.videoName = `simulator-agent-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`;
      } else simulatorBridge.videoError = '未收到画面帧；请重试';
      bridgeStatus();
    };
    recorder.start(200);
    simulatorBridge.recorder = recorder;
  } catch (error) {
    simulatorBridge.videoError = error.message;
  }
  bridgeStatus();
}

function stopSimulatorRecording() {
  if (!simulatorBridge.recording) return;
  simulatorBridge.recording = false;
  simulatorBridge.events.push({ t: Number(((performance.now() - simulatorBridge.startedAt) / 1000).toFixed(3)), type: 'recording.stop', source: 'rdk-studio-agent' });
  if (simulatorBridge.recorder?.state === 'recording') simulatorBridge.recorder.stop();
  simulatorBridge.recorder = null;
  bridgeStatus();
  const blob = new Blob([simulatorBridge.events.map((item) => JSON.stringify(item)).join('\n') + '\n'], { type: 'application/jsonl' });
  simulatorBridge.downloadUrl = URL.createObjectURL(blob);
  simulatorBridge.downloadName = `simulator-agent-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
  bridgeStatus();
}

async function runSimulatorDemo(message) {
  const connected = await connectSimulatorBridge();
  if (!connected) return;
  const shouldRecord = /录制|动作|走|前进|控制|演示/i.test(message);
  if (shouldRecord) startSimulatorRecording();
  // Keep the demo deterministic and short: forward, turn, release.
  dispatchSimulatorKey('ArrowUp', 2_000);
  await new Promise((resolve) => window.setTimeout(resolve, 2_250));
  dispatchSimulatorKey('ArrowRight', 1_000);
  await new Promise((resolve) => window.setTimeout(resolve, 1_250));
  await new Promise((resolve) => window.setTimeout(resolve, 1_000));
  if (shouldRecord) stopSimulatorRecording();
}

function saveMessage(role, text) {
  try {
    const history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    history.push({ role, text: String(text).slice(0, 2_000) });
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-24)));
  } catch { /* local history is best effort */ }
}

function addMessage(role, text, persist = true) {
  if (!messages) return;
  const node = document.createElement('div');
  node.className = `agent-chat-message agent-chat-message-${role}`;
  node.innerHTML = `<strong>${role === 'user' ? '你' : 'Agent'}</strong><p></p>`;
  node.querySelector('p').textContent = text;
  messages.appendChild(node);
  messages.scrollTop = messages.scrollHeight;
  if (persist) saveMessage(role, text);
}

// Conversation-native task card: instead of narrating progress through
// separate chat bubbles, one card per task carries the goal, live checklist,
// progress bar, and result evidence. The chat stays a chat; the task lives
// in a bounded, glanceable artifact.
const STATUS_LABELS = { pending: '待执行', running: '执行中', completed: '完成', failed: '失败', blocked: '已阻断' };

function renderTaskCard(run) {
  const card = document.createElement('div');
  card.className = 'agent-task-card';
  card.dataset.runStatus = String(run.status || 'pending');
  const steps = Array.isArray(run.steps) ? run.steps : [];
  const done = steps.filter((item) => item.status === 'completed').length;
  const percent = steps.length ? Math.round((done / steps.length) * 100) : 0;

  const head = document.createElement('div');
  head.className = 'agent-task-head';
  const goal = document.createElement('strong');
  goal.textContent = String(run.goal || run.intent || 'Agent 任务');
  const badge = document.createElement('span');
  badge.className = `agent-task-badge agent-task-badge-${run.status || 'pending'}`;
  badge.textContent = ({ queued: '排队中', running: `${done}/${steps.length} 步`, completed: '已完成', failed: '失败', blocked: '已阻断' }[run.status] || run.status || '排队中');
  head.append(goal, badge);

  const bar = document.createElement('div');
  bar.className = 'agent-task-progress';
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  bar.setAttribute('aria-valuenow', String(percent));
  const fill = document.createElement('i');
  fill.style.width = `${percent}%`;
  bar.append(fill);

  const list = document.createElement('ol');
  list.className = 'agent-task-steps';
  for (const item of steps) {
    const row = document.createElement('li');
    row.dataset.stepId = String(item.id || 'step');
    row.dataset.stepStatus = String(item.status || 'pending');
    const marker = document.createElement('span');
    marker.className = 'agent-step-dot';
    marker.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = String(item.label || item.tool || '执行步骤');
    const state = document.createElement('em');
    state.textContent = item.detail || STATUS_LABELS[item.status] || item.status || STATUS_LABELS.pending;
    row.append(marker, label, state);
    list.append(row);
  }
  card.append(head, bar, list);

  if (Array.isArray(run.evidence) && run.evidence.length) {
    const box = document.createElement('div');
    box.className = 'agent-task-evidence';
    for (const item of run.evidence) {
      const href = safeAgentHref(item.href);
      const row = document.createElement(href ? 'a' : 'span');
      row.textContent = `${String(item.label || '证据')}：${String(item.value || '—')}${href ? ' ↗' : ''}`;
      if (href) row.href = href;
      box.append(row);
    }
    card.append(box);
  }

  messages?.appendChild(card);
  if (messages) messages.scrollTop = messages.scrollHeight;
  return card;
}

function updateTaskCard(card, run) {
  if (!card) return;
  card.dataset.runStatus = String(run.status || 'pending');
  const steps = Array.isArray(run.steps) ? run.steps : [];
  const done = steps.filter((item) => item.status === 'completed').length;
  const percent = steps.length ? Math.round((done / steps.length) * 100) : 0;
  const badge = card.querySelector('.agent-task-badge');
  if (badge) badge.textContent = ({ queued: '排队中', running: `${done}/${steps.length} 步`, completed: '已完成', failed: '失败', blocked: '已阻断' }[run.status] || run.status || '排队中');
  const bar = card.querySelector('.agent-task-progress');
  if (bar) {
    bar.setAttribute('aria-valuenow', String(percent));
    const fill = bar.querySelector('i');
    if (fill) fill.style.width = `${percent}%`;
  }
  for (const item of steps) {
    const row = card.querySelector(`.agent-task-steps [data-step-id="${CSS.escape(String(item.id))}"]`);
    if (!row) continue;
    row.dataset.stepStatus = String(item.status || 'pending');
    const state = row.querySelector('em');
    if (state) state.textContent = item.detail || STATUS_LABELS[item.status] || item.status || STATUS_LABELS.pending;
  }
  const evidenceBox = card.querySelector('.agent-task-evidence');
  if (Array.isArray(run.evidence) && run.evidence.length) {
    if (!evidenceBox) {
      const box = document.createElement('div');
      box.className = 'agent-task-evidence';
      card.append(box);
    }
    const box = card.querySelector('.agent-task-evidence');
    box.replaceChildren();
    for (const item of run.evidence) {
      const href = safeAgentHref(item.href);
      const row = document.createElement(href ? 'a' : 'span');
      row.textContent = `${String(item.label || '证据')}：${String(item.value || '—')}${href ? ' ↗' : ''}`;
      if (href) row.href = href;
      box.append(row);
    }
  }
}

function restoreMessages() {
  try {
    const history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    if (!Array.isArray(history) || !history.length) return;
    messages.replaceChildren();
    history.forEach((item) => addMessage(item.role === 'user' ? 'user' : 'agent', item.text, false));
  } catch { /* ignore corrupt browser-only history */ }
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(API_MOUNT_PREFIX + path, { credentials: 'include', ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || payload.error || `请求失败（${response.status}）`);
  return payload;
}

function renderPlan(plan) {
  planCard.replaceChildren();
  const title = document.createElement('div');
  title.className = 'agent-plan-title';
  const goal = document.createElement('strong');
  goal.textContent = String(plan.goal || '待执行任务');
  const safety = document.createElement('span');
  safety.className = 'state-badge state-neutral';
  safety.textContent = String(plan.safety || 'read-only');
  title.append(goal, safety);
  const list = document.createElement('ol');
  for (const item of Array.isArray(plan.steps) ? plan.steps : []) {
    const row = document.createElement('li');
    row.dataset.stepId = String(item.id || 'step');
    const dot = document.createElement('span');
    dot.className = 'agent-step-dot';
    const label = document.createElement('span');
    label.textContent = String(item.label || item.tool || '执行步骤');
    const status = document.createElement('em');
    status.textContent = item.status === 'pending' ? '待执行' : String(item.status || '待执行');
    row.append(dot, label, status);
    list.append(row);
  }
  const rationale = document.createElement('p');
  rationale.className = 'agent-rationale';
  rationale.innerHTML = '<b>执行摘要：</b>';
  rationale.append(document.createTextNode(String(plan.rationale || '按任务依赖顺序执行受控工具。')));
  planCard.append(title, rationale, list);
}

function safeAgentHref(value) {
  const raw = String(value || '').trim();
  if (/^#(?:[A-Za-z0-9_./-]+)?$/.test(raw)) return raw;
  if (/^\/(?:mujoco|sim2real)(?:[/?#]|$)/.test(raw)) return raw;
  return '';
}

function renderRun(run) {
  renderPlan(run);
  run.steps.forEach((item) => {
    const row = planCard.querySelector(`[data-step-id="${CSS.escape(item.id)}"]`);
    if (!row) return;
    row.classList.toggle('is-done', item.status === 'completed');
    row.classList.toggle('is-running', item.status === 'running');
    row.classList.toggle('is-failed', item.status === 'failed');
    const state = row.querySelector('em');
    state.textContent = item.detail || ({ pending: '待执行', running: '执行中', completed: '完成', failed: '失败', blocked: '已阻断' }[item.status] || item.status);
  });
  evidence.replaceChildren();
  if (!run.evidence.length) {
    const empty = document.createElement('span');
    empty.className = 'empty-inline';
    empty.textContent = '工具执行后显示证据…';
    evidence.append(empty);
  } else {
    const heading = document.createElement('strong');
    heading.textContent = '执行证据';
    evidence.append(heading);
    for (const item of run.evidence) {
      const href = safeAgentHref(item.href);
      const row = document.createElement(href ? 'a' : 'span');
      row.textContent = `${String(item.label || '证据')}：${String(item.value || '—')}${href ? ' ↗' : ''}`;
      if (href) row.href = href;
      evidence.append(row);
    }
  }
  eventLog.replaceChildren();
  if (!run.events?.length) {
    const empty = document.createElement('span');
    empty.className = 'empty-inline';
    empty.textContent = '工具事件会实时显示在这里';
    eventLog.append(empty);
    return;
  }
  const recent = run.events.slice(-4);
  const hidden = run.events.length - recent.length;
  const eventHeading = document.createElement('strong');
  eventHeading.textContent = '工具调用时间线';
  eventLog.append(eventHeading);
  for (const item of recent) {
    const row = document.createElement('div');
    row.className = `agent-event agent-event-${item.type}`;
    const time = document.createElement('time');
    time.textContent = new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const text = document.createElement('span');
    text.textContent = String(item.text || '');
    row.append(time, text);
    eventLog.append(row);
  }
  if (hidden > 0) {
    const more = document.createElement('details');
    more.className = 'agent-event-more';
    more.innerHTML = `<summary>展开全部 ${run.events.length} 条</summary>`;
    for (const item of run.events.slice(0, -4)) {
      const row = document.createElement('div');
      row.className = `agent-event agent-event-${item.type}`;
      const time = document.createElement('time');
      time.textContent = new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const text = document.createElement('span');
      text.textContent = String(item.text || '');
      row.append(time, text);
      more.append(row);
    }
    eventLog.append(more);
  }
  bridgeStatus();
}

async function runTask(message) {
  const modelId = $('model-select')?.value || undefined;
  const deviceId = $('device-select')?.value || undefined;
  const computeResourceId = $('compute-resource-select')?.value || undefined;
  const response = await api('/api/sim2real/agent/plan', { method: 'POST', body: JSON.stringify({ message, context: { modelId, deviceId, computeResourceId } }) });
  const plan = response?.plan;
  if (!plan || !Array.isArray(plan.steps) || !plan.steps.length || plan.steps.some((item) => !item || typeof item !== 'object')) throw new Error('服务没有返回有效的可执行计划');
  if (plan.steps.some((item) => item.tool === 'simulator.open')) {
    document.querySelector('[data-view-target="simulate"]')?.click();
    $('simulator-frame')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  renderPlan(plan);
  addMessage('agent', `收到，按 ${plan.steps.length} 步执行：${plan.steps.map((item) => item.label).join(' → ')}。`);
  const execution = await api('/api/sim2real/agent/execute', { method: 'POST', body: JSON.stringify({ plan, approved: true }) });
  const run = execution?.run;
  if (!run?.id || !Array.isArray(run.steps) || run.steps.some((item) => !item || typeof item !== 'object')) throw new Error('服务没有返回有效的运行记录');
  renderRun(run);
  const taskCard = renderTaskCard(run);
  if (plan.steps.some((item) => item.tool === 'simulator.open')) {
    void runSimulatorDemo(message).catch((error) => renderAgentError(error, true));
  }
  const terminal = new Set(['completed', 'failed', 'blocked', 'cancelled', 'timed_out']);
  let transientFailures = 0;
  let lastStepLabel = '';
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, attempt ? 700 : 250));
    let result;
    try {
      result = await api(`/api/sim2real/agent/runs/${encodeURIComponent(run.id)}`);
      transientFailures = 0;
    } catch (error) {
      transientFailures += 1;
      if (transientFailures >= 4) throw new Error(`运行状态获取失败：${error.message}`);
      if (runtimeStatus) runtimeStatus.textContent = `等待运行状态…（重试 ${transientFailures}/3）`;
      continue;
    }
    if (!result?.run || !Array.isArray(result.run.steps) || result.run.steps.some((item) => !item || typeof item !== 'object')) throw new Error('运行状态响应无效');
    renderRun(result.run);
    updateTaskCard(taskCard, result.run);
    const runningStep = result.run.steps.find((item) => item.status === 'running');
    if (runningStep && runningStep.label !== lastStepLabel) {
      lastStepLabel = runningStep.label;
      if (runtimeStatus) runtimeStatus.textContent = `正在执行：${runningStep.label}…`;
    }
    if (terminal.has(result.run.status)) {
      if (result.run.status === 'completed') {
        const links = (result.run.evidence || []).filter((item) => item.href).length;
        addMessage('agent', links ? '任务完成，证据卡片里可直接跳转运行记录。' : '任务完成。');
      } else addMessage('agent', `任务结束：${STATUS_LABELS[result.run.status] || result.run.status}`);
      return;
    }
  }
  throw new Error('任务执行超过 2 分钟，已停止等待；可到运行记录查看后台状态');
}

form?.addEventListener('submit', (event) => {
  event.preventDefault();
  const message = input.value.trim();
  if (!message) return;
  input.value = '';
  addMessage('user', message);
  setAgentBusy(true, '正在生成计划…');
  void runTask(message)
    .catch((error) => renderAgentError(error, true))
    .finally(() => setAgentBusy(false));
});

// The conversation lives in a drawer so it remains available without taking
// over the workflow canvas. The launcher can be repositioned for demos and
// its position is kept locally on this browser only.
const launcher = $('agent-floating-toggle');
const panel = $('agent-chat-panel');
const backdrop = $('agent-chat-backdrop');
const closeButton = $('agent-chat-close');
const AGENT_POSITION_KEY = 'rdk-duck-lab-agent-position-v1';
let dragged = false;

function setAgentDrawer(open) {
  if (!panel) return;
  const restoreFocus = arguments.length < 2 || arguments[1] !== false;
  document.body.classList.toggle('agent-chat-open', open);
  panel.setAttribute('aria-hidden', open ? 'false' : 'true');
  launcher?.setAttribute('aria-expanded', open ? 'true' : 'false');
  launcher?.setAttribute('aria-label', open ? '关闭 Agent 对话' : '打开 Agent 对话');
  if (backdrop) backdrop.hidden = !open;
  if (open) window.setTimeout(() => input?.focus(), 80);
  else if (restoreFocus) window.setTimeout(() => launcher?.focus(), 0);
}

launcher?.addEventListener('click', () => {
  if (dragged) return;
  setAgentDrawer(!document.body.classList.contains('agent-chat-open'));
});
closeButton?.addEventListener('click', () => setAgentDrawer(false));
backdrop?.addEventListener('click', () => setAgentDrawer(false));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.body.classList.contains('agent-chat-open')) setAgentDrawer(false);
});

// Preserve the old entry card affordance, but open the same drawer instead of
// scrolling the page to a large inline panel.
$('agent-entry-button')?.addEventListener('click', () => {
  setAgentDrawer(true);
  input?.focus();
});

// The sidebar entry and any [data-agent-open] control share the drawer; the
// canonical opener is exposed so app.js can delegate without a load-order
// contract between the two classic scripts.
window.setAgentDrawerOpen = (open) => {
  setAgentDrawer(open);
  if (open) input?.focus();
};

// Example prompts lower the blank-composer barrier: a first-time user sees
// what the agent can actually do instead of an empty input.
const EXAMPLE_PROMPTS = [
  '跑一轮 GPU 冒烟训练并跟踪结果',
  '检查 X5 板卡状态和磁盘用量',
  '帮我生成只读部署预检计划',
  '汇总最近一次训练的评测证据',
];
const composer = $('agent-chat-form');
if (composer) {
  const chips = document.createElement('div');
  chips.className = 'agent-prompt-chips';
  chips.setAttribute('aria-label', '示例任务');
  for (const prompt of EXAMPLE_PROMPTS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'agent-prompt-chip';
    chip.textContent = prompt;
    chip.title = '点击直接发送';
    chip.addEventListener('click', () => {
      if (!input || input.disabled || !form) return;
      input.value = prompt;
      form.requestSubmit();
    });
    chips.append(chip);
  }
  composer.before(chips);
}

try {
  const saved = JSON.parse(window.localStorage?.getItem(AGENT_POSITION_KEY) || 'null');
  if (saved && Number.isFinite(saved.right) && Number.isFinite(saved.bottom)) {
    launcher.style.right = `${Math.max(10, saved.right)}px`;
    launcher.style.bottom = `${Math.max(10, saved.bottom)}px`;
  }
} catch { /* private browsing or malformed preference */ }

launcher?.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  const startX = event.clientX;
  const startY = event.clientY;
  const startRight = Number.parseFloat(getComputedStyle(launcher).right) || 26;
  const startBottom = Number.parseFloat(getComputedStyle(launcher).bottom) || 26;
  dragged = false;
  launcher.setPointerCapture?.(event.pointerId);
  const move = (moveEvent) => {
    const dx = moveEvent.clientX - startX;
    const dy = moveEvent.clientY - startY;
    if (Math.abs(dx) + Math.abs(dy) > 5) dragged = true;
    if (!dragged) return;
    const right = Math.min(Math.max(10, startRight - dx), Math.max(10, window.innerWidth - launcher.offsetWidth - 10));
    const bottom = Math.min(Math.max(10, startBottom - dy), Math.max(10, window.innerHeight - launcher.offsetHeight - 10));
    launcher.style.right = `${right}px`;
    launcher.style.bottom = `${bottom}px`;
  };
  const end = () => {
    launcher.removeEventListener('pointermove', move);
    launcher.removeEventListener('pointerup', end);
    launcher.removeEventListener('pointercancel', end);
    if (dragged) {
      try { window.localStorage?.setItem(AGENT_POSITION_KEY, JSON.stringify({ right: parseFloat(launcher.style.right), bottom: parseFloat(launcher.style.bottom) })); } catch { /* ignore */ }
      window.setTimeout(() => { dragged = false; }, 0);
    }
  };
  launcher.addEventListener('pointermove', move);
  launcher.addEventListener('pointerup', end);
  launcher.addEventListener('pointercancel', end);
});

setAgentDrawer(false, false);

restoreMessages();
})();
