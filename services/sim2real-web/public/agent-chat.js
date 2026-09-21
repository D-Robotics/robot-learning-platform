(function () {
const $ = (id) => document.getElementById(id);
const messages = $('agent-chat-messages');
const planCard = $('agent-plan-card');
const evidence = $('agent-evidence');
const eventLog = $('agent-event-log');
const form = $('agent-chat-form');
const input = $('agent-chat-input');
const submitButton = form?.querySelector('button[type="submit"]');
const stopButton = form?.querySelector('[data-agent-stop]');
const runtimeStatus = document.querySelector('.agent-chat-runtime');
let runtimeLabel = '可规划 · 真机操作需确认';
const HISTORY_KEY = 'rdk-sim2real-agent-history-v1';
const SESSIONS_KEY = 'rdk-sim2real-agent-sessions-v1';
const SESSIONS_CAP = 12;
const SESSION_MESSAGES_CAP = 24;
const SESSION_TITLES = { pending: '待执行', running: '执行中', completed: '已完成', partial: '部分完成', failed: '失败', blocked: '已阻断' };
const SIMULATOR_ALLOWED_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd', 'q', 'e', 'f', 'r', 'g', 'c', 'm', 'b', ' ']);
const simulatorBridge = { frame: null, ready: false, recording: false, events: [], connectedAt: null, startedAt: 0, downloadUrl: '', downloadName: '', videoUrl: '', videoName: '', recorder: null, videoError: '' };
let activeTaskController = null;
let activeTypingNode = null;
let activeDshSessionId = '';

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
  if (stopButton) stopButton.hidden = !busy;
  if (input) input.disabled = busy;
  if (runtimeStatus) {
    runtimeStatus.classList.toggle('is-busy', busy);
    runtimeStatus.textContent = busy ? (label || '任务执行中…') : runtimeLabel;
  }
}

// The authoritative capability list is rendered once from the server catalog,
// so the agent's prose never has to enumerate every tool to stay complete.
let capabilityCatalogRendered = false;

function renderCapabilityCatalog(capabilities) {
  if (capabilityCatalogRendered) return;
  const catalog = capabilities?.dsh?.capabilities;
  if (!Array.isArray(catalog)) return;
  const panel = document.getElementById('agent-catalog');
  const list = document.getElementById('agent-catalog-list');
  if (!panel || !list) return;
  const bound = catalog.filter((item) => item && item.bound);
  if (!bound.length) return;
  list.textContent = '';
  for (const item of bound) {
    const row = document.createElement('li');
    row.className = `agent-catalog-item${item.readOnly ? '' : ' is-gated'}`;
    const badge = document.createElement('span');
    badge.className = 'agent-catalog-badge';
    badge.textContent = item.readOnly ? '只读' : '⚠️ 门控';
    const desc = document.createElement('span');
    desc.className = 'agent-catalog-desc';
    desc.textContent = `${item.description}（${item.id}）`;
    row.append(badge, desc);
    list.append(row);
  }
  const count = document.getElementById('agent-catalog-count');
  if (count) count.textContent = `（${bound.length}）`;
  panel.hidden = false;
  capabilityCatalogRendered = true;
}

async function refreshRuntimeStatus() {
  try {
    const capabilities = await api('/sim2real/agent/capabilities');
    renderCapabilityCatalog(capabilities);
    if (capabilities?.runtime === 'dsh' && capabilities?.dsh?.initialized) {
      runtimeLabel = '实时 Agent · 真机操作需确认';
    } else if (capabilities?.runtime === 'dsh-configured') {
      runtimeLabel = 'Agent 正在初始化 · 真机操作需确认';
    } else {
      runtimeLabel = '计划器可用 · 真机操作需确认';
    }
    if (runtimeStatus && !runtimeStatus.classList.contains('is-busy')) {
      runtimeStatus.textContent = runtimeLabel;
    }
  } catch {
    // The status badge is advisory; the submit path still surfaces the
    // authoritative DSH/legacy result and error message.
  }
}

function removeTypingIndicator() {
  activeTypingNode?.remove();
  activeTypingNode = null;
}

function showTypingIndicator(label = '正在思考…') {
  removeTypingIndicator();
  if (!messages) return;
  const node = document.createElement('div');
  node.className = 'agent-chat-typing';
  node.setAttribute('role', 'status');
  const text = document.createElement('span');
  text.textContent = label;
  const dots = document.createElement('i');
  dots.setAttribute('aria-hidden', 'true');
  dots.textContent = '•••';
  node.append(text, dots);
  messages.append(node);
  followMessagesBottom();
  activeTypingNode = node;
}

function renderAgentError(error, retryable = true, lastMessage = '', turnId = '') {
  const message = error instanceof Error ? error.message : String(error || '未知错误');
  const node = addMessage('agent', `任务未完成：${message}${retryable ? ' 可以重试。' : ''}`);
  // Recovery must be one click: the user's instruction was already consumed
  // by the failed submit, so the error message carries it back as a retry
  // action instead of forcing a retype.
  if (retryable && lastMessage && node && input) {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'button button-ghost button-small agent-retry';
    retry.textContent = '重试这条指令';
    retry.addEventListener('click', () => {
      retry.remove();
      input.value = lastMessage;
      if (turnId) input.dataset.agentRetryTurnId = turnId;
      input.focus();
      if (form) form.requestSubmit();
    });
    node.append(retry);
  }
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
  appendCurrentSessionMessage(role, text);
}

// ---- Multi-session persistence (Amershi G12: remember recent context) ----
// Sessions are browser-local records of this drawer's conversations: the
// message log plus the terminal task-card snapshot, so reopening a session
// restores both the chat and the structured evidence. No server round-trip,
// bounded counts, all rendering via createElement/textContent.

let activeSessionId = null;

function readSessions() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SESSIONS_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item) =>
        item &&
        typeof item === 'object' &&
        typeof item.id === 'string' &&
        Array.isArray(item.messages) &&
        item.messages.every(
          (message) => message && typeof message === 'object' && typeof message.role === 'string',
        ),
    );
  } catch {
    return [];
  }
}

function writeSessions(sessions) {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions.slice(0, SESSIONS_CAP)));
  } catch { /* storage full or unavailable: keep working in-memory */ }
}

function sanitizeSessionMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((item) => item && typeof item === 'object' && typeof item.text === 'string')
    .slice(-SESSION_MESSAGES_CAP)
    .map((item) => ({ role: item.role === 'user' ? 'user' : 'agent', text: String(item.text).slice(0, 2_000) }));
}

function ensureSession(summary) {
  const sessions = readSessions();
  let record = sessions.find((item) => item.id === activeSessionId);
  if (!record) {
    record = {
      id: 'sess-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      createdAt: new Date().toISOString(),
      messages: [],
      title: '',
      task: null,
      dshSessionId: '',
    };
    writeSessions([record, ...sessions]);
  }
  activeSessionId = record.id;
  if (summary !== undefined) {
    record.task = sanitizeTaskCard(summary);
    record.updatedAt = new Date().toISOString();
    persistSession(record);
  }
  return record;
}

function persistActiveDshSession(sessionId) {
  const value = String(sessionId || '').trim().slice(0, 160);
  activeDshSessionId = value;
  if (!activeSessionId || !value) return;
  const sessions = readSessions();
  const record = sessions.find((item) => item.id === activeSessionId);
  if (!record) return;
  record.dshSessionId = value;
  record.updatedAt = new Date().toISOString();
  persistSession(record);
}

function persistSession(record) {
  const sessions = readSessions();
  const index = sessions.findIndex((item) => item.id === record.id);
  if (index === -1) {
    sessions.unshift(record);
    writeSessions(sessions);
    return;
  }
  sessions[index] = record;
  // Newest activity floats a session to the top, capped to SESSIONS_CAP.
  writeSessions([record, ...sessions.slice(0, index), ...sessions.slice(index + 1)]);
}

function sanitizeTaskCard(run) {
  if (!run || typeof run !== 'object') return null;
  return {
    goal: String(run.goal || run.intent || '').slice(0, 200) || 'Agent 任务',
    status: String(run.status || 'pending'),
    steps: (Array.isArray(run.steps) ? run.steps : []).slice(0, 20).map((item) => ({
      id: String(item?.id || 'step'),
      label: String(item?.label || item?.tool || '执行步骤').slice(0, 120),
      status: String(item?.status || 'pending'),
      detail: item?.detail ? String(item.detail).slice(0, 300) : '',
    })),
    evidence: (Array.isArray(run.evidence) ? run.evidence : []).slice(0, 10).map((item) => ({
      label: String(item?.label || '证据').slice(0, 80),
      value: String(item?.value || '—').slice(0, 200),
      href: safeAgentHref(item?.href),
    })),
  };
}

function appendCurrentSessionMessage(role, text) {
  if (!activeSessionId) return;
  const sessions = readSessions();
  const record = sessions.find((item) => item.id === activeSessionId);
  if (!record) return;
  record.messages = sanitizeSessionMessages([
    ...record.messages,
    { role, text: String(text).slice(0, 2_000) },
  ]);
  if (!record.title && role === 'user') record.title = String(text).slice(0, 20);
  record.updatedAt = new Date().toISOString();
  persistSession(record);
}

function renderRestoredTaskCard(task) {
  if (!messages) return;
  const card = document.createElement('div');
  card.className = 'agent-task-card agent-task-card-restored';
  const head = document.createElement('div');
  head.className = 'agent-task-head';
  const goal = document.createElement('strong');
  goal.textContent = String(task.goal || 'Agent 任务');
  const badge = document.createElement('span');
  badge.className = 'agent-task-badge agent-task-badge-' + (task.status || 'pending');
  badge.textContent = SESSION_TITLES[task.status] || task.status || '待执行';
  head.append(goal, badge);
  card.append(head);
  const note = document.createElement('div');
  note.className = 'agent-task-restored-note';
  note.textContent = '历史任务卡（只读回放，不能续跑）';
  card.append(note);
  const list = document.createElement('ol');
  list.className = 'agent-task-steps';
  for (const item of task.steps || []) {
    const row = document.createElement('li');
    row.dataset.stepStatus = String(item.status || 'pending');
    const label = document.createElement('span');
    label.textContent = String(item.label || '执行步骤');
    const state = document.createElement('em');
    state.textContent = item.detail || SESSION_TITLES[item.status] || item.status || '待执行';
    row.append(label, state);
    list.append(row);
  }
  card.append(list);
  if (Array.isArray(task.evidence) && task.evidence.length) {
    const box = document.createElement('div');
    box.className = 'agent-task-evidence';
    for (const item of task.evidence) {
      const row = document.createElement(item.href ? 'a' : 'span');
      row.textContent = `${String(item.label || '证据')}：${String(item.value || '—')}${item.href ? ' ↗' : ''}`;
      if (item.href) row.href = item.href;
      box.append(row);
    }
    card.append(box);
  }
  messages.append(card);
}

// Model replies from bilingual gateways often start with an English preamble
// before the real answer ("I'll read the workspace overview." + 中文正文); in
// tool-using turns there is one such sentence per step. The server strips the
// whole leading ASCII run; this is the client-side fallback for responses that
// arrive without server processing (mocked dev responses, older servers).
// Same conservative boundaries: stop at the first non-ASCII line, structural
// Markdown, or an over-long English line; keep the original if everything was
// English prose.
function stripEnglishPreamble(text) {
  const source = String(text ?? '');
  const lines = source.split(/\r?\n/);
  const limit = Math.min(lines.length, 6);
  let index = 0;
  let stripChars = 0;
  while (index < limit) {
    const line = lines[index];
    if (!line.trim()) {
      stripChars += line.length + 1;
      index += 1;
      continue;
    }
    if (!/^[\x20-\x7e]*$/.test(line)) break;
    if (line.length > 240) break;
    if (/^(#{1,6}\s|[-*]\s|\||```|>\s|\d+\.\s)/.test(line)) break;
    stripChars += line.length + 1;
    index += 1;
  }
  if (index >= lines.length) return source;
  if (index >= limit && limit < lines.length) return source;
  const rest = source.slice(stripChars).replace(/^(?:\r?\n)+/, '');
  return rest.trim() ? rest : source;
}

// Multi-step turns concatenate per-step narrations inline on one line ahead of
// the answer ("I'll read the overview.Workspace read.## 工作区总览…"). Strip a
// leading ASCII run within the first line, ending at the first CJK character;
// past four inline sentences the English is treated as content.
function stripInlineEnglishPreamble(text) {
  const source = String(text ?? '');
  const firstBreak = source.search(/\r?\n/);
  const firstLine = firstBreak === -1 ? source : source.slice(0, firstBreak);
  if (firstLine.length > 400) return source;
  let boundary = -1;
  for (let index = 0; index < firstLine.length; index += 1) {
    const code = firstLine.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) { boundary = index; break; }
  }
  if (boundary === -1) return source;
  const inline = firstLine.slice(0, boundary);
  if (!inline.trim()) return source;
  const sentenceEnds = (inline.match(/[.!?:](?:\s|$)/g) || []).length;
  if (sentenceEnds > 4) return source;
  while (boundary > 0 && firstLine.charCodeAt(boundary - 1) === 0x23) boundary -= 1;
  const remainder = firstLine.slice(boundary);
  const rebuilt = `${remainder}${firstBreak === -1 ? '' : source.slice(firstBreak)}`;
  return rebuilt.trim() ? rebuilt : source;
}

function stripDshPreamble(text) {
  return stripInlineEnglishPreamble(stripEnglishPreamble(text));
}

const DSH_TOOL_LABELS = {
  rdk_workspace_overview: '读取工作区总览',
  rdk_device_discover: '发现设备',
  rdk_device_connect: '连接设备',
  rdk_board_health: '读取板端健康',
  rdk_training_submit: '提交训练',
  rdk_training_status: '查询训练状态',
  rdk_simulator_open: '打开仿真',
  rdk_evaluation_summarize: '汇总评测',
  rdk_deployment_preflight: '部署预检',
  rdk_board_stop: '停止板端',
};

// A compact tool timeline for DSH replies: what the model called and whether
// each call succeeded, without any arguments or payloads (the server projects
// the same names-out-only shape). It makes a tool-using reply auditable at a
// glance instead of a wall of prose.
function renderDshToolTrail(trail) {
  const items = (Array.isArray(trail) ? trail : []).filter(
    (item) => item && typeof item.name === 'string' && typeof item.ok === 'boolean',
  );
  if (!items.length) return null;
  const box = document.createElement('details');
  box.className = 'agent-dsh-trail';
  const summary = document.createElement('summary');
  const failed = items.filter((item) => !item.ok).length;
  summary.textContent = `工具调用 ${items.length} 次${failed ? ` · ${failed} 次失败` : ''}`;
  box.append(summary);
  for (const item of items) {
    const row = document.createElement('span');
    row.className = `agent-dsh-trail-item${item.ok ? '' : ' is-failed'}`;
    row.textContent = `${item.ok ? '✓' : '✕'} ${DSH_TOOL_LABELS[item.name] || item.name}`;
    box.append(row);
  }
  return box;
}

// The reasoning trace ships separately from the reply text so it can be
// disclosed on demand: a default-collapsed details block keeps the drawer
// calm while keeping the "how did it think" surface one click away.
function renderDshReasoning(reasoning) {
  const text = String(reasoning ?? '').trim();
  if (!text) return null;
  const box = document.createElement('details');
  box.className = 'agent-dsh-reasoning';
  const summary = document.createElement('summary');
  summary.textContent = '思考过程';
  const body = document.createElement('p');
  body.textContent = text.slice(0, 8_000);
  box.append(summary, body);
  return box;
}

function renderDshReply(dsh) {
  const node = addMessage('agent', stripDshPreamble(dsh.text));
  const provenance = document.createElement('small');
  provenance.className = 'agent-message-provenance';
  const usage = Number(dsh.usage?.totalTokens);
  const usageLabel = Number.isFinite(usage) && usage > 0 ? ` · 本轮约 ${usage} tokens` : '';
  // The workspace-evidence hint only fits turns where tools actually ran; a
  // plain prose reply (self-introduction, capability tour) has no evidence to
  // check and the boilerplate only adds noise.
  provenance.textContent = dsh.toolTrail?.length
    ? `Agent 生成 · 依据见工具调用与执行证据${usageLabel}`
    : `Agent 生成${usageLabel}`;
  node?.append(provenance);
  const trail = renderDshToolTrail(dsh.toolTrail);
  if (trail) node?.append(trail);
  const reasoning = renderDshReasoning(dsh.reasoning);
  if (reasoning) node?.append(reasoning);
  return node;
}

const visibleDshApprovals = new Set();

function renderDshApproval(approval) {
  const id = String(approval?.id || '');
  if (!id || visibleDshApprovals.has(id) || !messages) return;
  visibleDshApprovals.add(id);
  const node = addMessage(
    'agent',
    `需要确认：Agent 请求执行「${DSH_TOOL_LABELS[approval.toolName] || approval.toolName || '受控操作'}」。${approval.reason || '该操作可能改变训练、设备或部署状态。'}`,
  );
  if (!node) return;
  node.classList.add('agent-dsh-approval');
  const actions = document.createElement('div');
  actions.className = 'agent-approval-actions';
  const approve = document.createElement('button');
  approve.type = 'button';
  approve.className = 'button button-primary button-small';
  approve.textContent = '批准一次';
  const reject = document.createElement('button');
  reject.type = 'button';
  reject.className = 'button button-ghost button-small';
  reject.textContent = '拒绝';
  const finish = async (decision) => {
    approve.disabled = true;
    reject.disabled = true;
    try {
      await api(`/sim2real/dsh/approvals/${encodeURIComponent(id)}`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      });
      const paragraph = node.querySelector('p');
      if (paragraph) paragraph.textContent = decision === 'approve' ? '已批准，Agent 将继续执行。' : '已拒绝，Agent 将停止该操作。';
      actions.remove();
    } catch (error) {
      approve.disabled = false;
      reject.disabled = false;
      renderAgentError(error, true);
    }
  };
  approve.addEventListener('click', () => void finish('approve'));
  reject.addEventListener('click', () => void finish('reject'));
  actions.append(approve, reject);
  node.append(actions);
}

function startDshApprovalPolling(signal) {
  let stopped = false;
  let timer = null;
  const poll = async () => {
    if (stopped || signal?.aborted) return;
    try {
      const result = await api('/sim2real/dsh/approvals', { signal });
      for (const approval of Array.isArray(result?.approvals) ? result.approvals : []) {
        renderDshApproval(approval);
      }
    } catch {
      // The chat request remains authoritative; approval discovery is advisory.
    }
    if (!stopped && !signal?.aborted) timer = window.setTimeout(poll, 800);
  };
  void poll();
  return () => {
    stopped = true;
    if (timer) window.clearTimeout(timer);
  };
}

// 用户往上翻历史时不要把视口强行拽回底部:只有本来就贴着底部才自动跟随。
function messagesNearBottom() {
  if (!messages) return true;
  return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 140;
}

function followMessagesBottom() {
  if (messages && messagesNearBottom()) messages.scrollTop = messages.scrollHeight;
}

// 渲染 Agent 回复使用的 Markdown 子集:##/### 标题、-/* 与 1. 列表、**加粗**、
// `行内代码`。先整体转义再逐行解析,行内替换只作用于已转义文本,模型无法注入标签。
function renderAgentMarkup(source) {
  const escaped = String(source ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const inline = (text) => text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  let html = '';
  let listTag = null;
  const closeList = () => {
    if (listTag) { html += `</${listTag}>`; listTag = null; }
  };
  for (const rawLine of escaped.split('\n')) {
    const line = rawLine.trim();
    const heading = line.match(/^#{2,4}\s+(.+)$/);
    const bullet = line.match(/^[-*]\s+(.+)$/);
    const ordered = line.match(/^(\d+)[.、)]\s+(.+)$/);
    if (heading) {
      closeList();
      html += `<strong class="agent-msg-heading">${inline(heading[1])}</strong>`;
    } else if (bullet) {
      if (listTag !== 'ul') { closeList(); html += '<ul>'; listTag = 'ul'; }
      html += `<li>${inline(bullet[1])}</li>`;
    } else if (ordered) {
      if (listTag !== 'ol') { closeList(); html += '<ol>'; listTag = 'ol'; }
      html += `<li>${inline(ordered[2])}</li>`;
    } else if (line) {
      closeList();
      html += `${inline(line)}<br>`;
    }
  }
  closeList();
  return html.replace(/(<br)>$/, '$1>');
}

function addMessage(role, text, persist = true) {
  if (!messages) return null;
  const node = document.createElement('div');
  node.className = `agent-chat-message agent-chat-message-${role}`;
  node.innerHTML = `<strong>${role === 'user' ? '你' : 'Agent'}</strong><p></p>`;
  const paragraph = node.querySelector('p');
  const source = String(text ?? '');
  paragraph.innerHTML = renderAgentMarkup(source);  if (role === 'agent') {
    const actions = document.createElement('div');
    actions.className = 'agent-message-actions';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'agent-message-copy';
    copy.textContent = '复制';
    copy.setAttribute('aria-label', '复制 Agent 回复');
    copy.addEventListener('click', async () => {
      try {
        if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
        await navigator.clipboard.writeText(source);
        copy.textContent = '已复制';
        window.setTimeout(() => { copy.textContent = '复制'; }, 1_500);
      } catch {
        copy.textContent = '无法复制';
        window.setTimeout(() => { copy.textContent = '复制'; }, 1_500);
      }
    });
    actions.append(copy);
    node.append(actions);
  }
  const stick = messagesNearBottom();
  messages.appendChild(node);
  // Agent replies stay lightweight. Feedback is available on explicit result
  // surfaces (evaluation and run details), rather than interrupting every
  // conversational turn with an accuracy prompt.
  if (stick || role === 'user') messages.scrollTop = messages.scrollHeight;
  if (persist) saveMessage(role, text);
  return node;
}

// Conversation-native task card: instead of narrating progress through
// separate chat bubbles, one card per task carries the goal, live checklist,
// progress bar, and result evidence. The chat stays a chat; the task lives
// in a bounded, glanceable artifact.
const STATUS_LABELS = { pending: '待执行', running: '执行中', completed: '完成', partial: '部分完成 · 需处理', failed: '失败', blocked: '已阻断' };

function renderTaskCard(run) {
  const card = document.createElement('div');
  card.className = 'agent-task-card';
  const steps = Array.isArray(run.steps) ? run.steps : [];
  const done = steps.filter((item) => item.status === 'completed').length;
  const displayStatus = run.status === 'failed' && done > 0 ? 'partial' : run.status;
  card.dataset.runStatus = String(displayStatus || 'pending');
  const percent = steps.length ? Math.round((done / steps.length) * 100) : 0;

  const head = document.createElement('div');
  head.className = 'agent-task-head';
  const goal = document.createElement('strong');
  goal.textContent = String(run.goal || run.intent || 'Agent 任务');
  const badge = document.createElement('span');
  badge.className = `agent-task-badge agent-task-badge-${displayStatus || 'pending'}`;
  badge.textContent = ({ queued: '排队中', running: `${done}/${steps.length} 步`, completed: '已完成', partial: '部分完成 · 需处理', failed: '失败', blocked: '已阻断' }[displayStatus] || displayStatus || '排队中');
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
  followMessagesBottom();
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

function renderSessionTranscript(record) {
  messages?.replaceChildren();
  if (record.messages?.length) {
    record.messages.forEach((item) =>
      addMessage(item.role === 'user' ? 'user' : 'agent', String(item.text || ''), false),
    );
  } else {
    addMessage('agent', '这个会话还没有消息。', false);
  }
  if (record.task && record.task.status) renderRestoredTaskCard(record.task);
}

function startFreshSession(list) {
  activeSessionId = null;
  activeDshSessionId = '';
  localStorage.removeItem(HISTORY_KEY);
  // Enforce the storage cap on every rail operation, so an over-cap seed
  // (older format or manual editing) is trimmed, not just on next persist.
  writeSessions(readSessions());
  messages?.replaceChildren();
  addMessage('agent', '新的对话已开始。告诉我你要完成什么？', false);
  renderSessionRail(list);
}

function openSession(session, list) {
  if (activeTaskController) return;
  activeSessionId = session.id;
  activeDshSessionId = typeof session.dshSessionId === 'string' ? session.dshSessionId : '';
  localStorage.removeItem(HISTORY_KEY);
  renderSessionTranscript(session);
  renderSessionRail(list);
}

function exportActiveSession() {
  const record = readSessions().find((item) => item.id === activeSessionId);
  if (!record) {
    addMessage('agent', '当前还没有可导出的对话。');
    return;
  }
  const payload = JSON.stringify({
    exportedAt: new Date().toISOString(),
    title: record.title || 'Agent 对话',
    messages: record.messages,
    task: record.task,
  }, null, 2);
  const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `rdk-agent-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function renderSessionRail(list) {
  if (!list) return;
  const sessions = readSessions();
  const current = list.querySelector('.agent-session-item[data-static-current]');
  list.replaceChildren();
  if (current) list.append(current);
  for (const session of sessions) {
    if (session.id === activeSessionId) continue;
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'agent-session-item';
    item.textContent = String(session.title || '未命名对话');
    item.title = '打开本地历史会话（含任务卡回放）';
    item.addEventListener('click', () => openSession(session, list));
    list.append(item);
  }
  const currentLabel = list.querySelector('.agent-session-item[data-static-current]');
  if (currentLabel) {
    const active = list.querySelector('.is-active');
    if (active && active !== currentLabel) currentLabel.classList.remove('is-active');
    if (!active) currentLabel.classList.add('is-active');
  }
}

function initSessionRail() {
  const list = $('agent-session-list');
  const fresh = $('agent-new-session');
  if (!list) return;
  const sessions = readSessions();
  if (sessions.length) {
    // The session store is authoritative once it exists (it also carries the
    // task cards); the legacy single-history key is only a pre-multisession
    // fallback, so it is never allowed to duplicate a stored session.
    activeSessionId = sessions[0].id;
    activeDshSessionId = typeof sessions[0].dshSessionId === 'string' ? sessions[0].dshSessionId : '';
    renderSessionTranscript(sessions[0]);
  } else {
    // Adopt any pre-multisession history (messages only) as a session on
    // first load so existing users keep their last conversation in the rail.
    const legacyHistory = (() => {
      try {
        const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
        return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item?.text === 'string') : [];
      } catch { return []; }
    })();
    if (legacyHistory.length) {
      const record = {
        id: 'sess-legacy-' + Math.random().toString(36).slice(2, 8),
        createdAt: new Date().toISOString(),
        adoptedLegacy: true,
        title: legacyHistory.find((entry) => entry.role === 'user')?.text?.slice(0, 20) || '最近一次对话',
        messages: sanitizeSessionMessages(legacyHistory),
        task: null,
        dshSessionId: '',
      };
      writeSessions([record]);
      activeSessionId = record.id;
      restoreMessages();
    }
  }
  renderSessionRail(list);
  fresh?.addEventListener('click', () => {
    if (activeTaskController) return;
    startFreshSession(list);
  });
  $('agent-export-session')?.addEventListener('click', exportActiveSession);
}

class AgentApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = 'AgentApiError';
    this.status = status;
    this.payload = payload;
  }
}

// Same-page classic script: app.js's request() already owns the canonical URL
// prefix, credentials, JSON parsing and the auth gate. Reuse it and keep only
// the agent surface's error type so UI branches stay on a stable class.
async function api(path, options = {}) {
  try {
    return await request(path, options);
  } catch (error) {
    if (error instanceof ApiError) {
      throw new AgentApiError(error.message, error.status, error.payload);
    }
    throw error;
  }
}

function waitWithSignal(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('The operation was aborted', 'AbortError'));
      return;
    }
    const timer = window.setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      window.clearTimeout(timer);
      reject(new DOMException('The operation was aborted', 'AbortError'));
    }, { once: true });
  });
}

// Plan choice (Bakusevych 2026 #2): the planner returns 2–3 deterministic
// re-scopings of the same goal. This renders a one-shot picker as an agent
// message and resolves with the chosen (or default) plan. It never auto-
// executes anything: resolution only happens on an explicit click, and the
// cancel path rejects so runTask reports "已取消" instead of firing.
function choosePlanVariant(variants, fallbackPlan) {
  return new Promise((resolve) => {
    const node = document.createElement('div');
    node.className = 'agent-plan-picker';
    const intro = document.createElement('div');
    intro.className = 'agent-plan-picker-intro';
    intro.textContent = '同一目标有几种执行方式，选一种开始（默认完整执行）：';
    node.append(intro);
    const list = document.createElement('div');
    list.className = 'agent-plan-picker-list';
    let settled = false;
    const finish = (plan, cancelled) => {
      if (settled) return;
      settled = true;
      node.querySelectorAll('button').forEach((button) => { button.disabled = true; });
      if (cancelled) node.replaceChildren(intro), (intro.textContent = '已取消：未执行任何步骤。');
      node.classList.add('is-answered');
      resolve(plan);
    };
    for (const variant of variants) {
      if (!variant || typeof variant !== 'object' || !variant.plan) continue;
      const option = document.createElement('button');
      option.type = 'button';
      option.className =
        'agent-plan-option' + (variant.key === 'thorough' ? ' is-default' : '');
      const label = document.createElement('strong');
      label.textContent = String(variant.label || variant.key || '备选计划');
      const meta = document.createElement('small');
      meta.textContent = `${(variant.plan.steps || []).length} 步 · ${String(variant.plan.safety || 'read-only')}`;
      const why = document.createElement('span');
      why.textContent = String(variant.rationale || '');
      option.append(label, meta, why);
      option.addEventListener('click', () => finish(variant.plan, false));
      list.append(option);
    }
    if (!list.children.length) { resolve(fallbackPlan); return; }
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'button button-ghost button-small agent-plan-cancel';
    cancel.textContent = '先不执行';
    cancel.addEventListener('click', () => finish(null, true));
    node.append(list, cancel);
    messages?.appendChild(node);
    followMessagesBottom();
    // The pick must not strand the chat if the user navigates away: resolve
    // with no plan so runTask stops before any execute call.
    window.setTimeout(() => { if (!settled) finish(null, true); }, 120_000);
  });
}

const APPROVAL_TOOLS = new Set(['training.gpu', 'evaluation.summarize', 'deployment.preflight']);

function chooseExecutionApproval(plan, signal) {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  const protectedSteps = steps.filter((step) => step?.requiresApproval || APPROVAL_TOOLS.has(step?.tool));
  if (!protectedSteps.length) return Promise.resolve(true);
  return new Promise((resolve) => {
    const node = document.createElement('div');
    node.className = 'agent-approval-card';
    node.setAttribute('role', 'alertdialog');
    const title = document.createElement('strong');
    title.textContent = '执行前需要你的明确批准';
    const detail = document.createElement('p');
    detail.textContent = `这项计划包含 ${protectedSteps.length} 个会产生资源或证据影响的步骤：${protectedSteps.map((step) => String(step.label || step.tool || '受控操作')).join('、')}。`;
    const actions = document.createElement('div');
    actions.className = 'agent-approval-actions';
    const approve = document.createElement('button');
    approve.type = 'button';
    approve.className = 'button button-primary button-small';
    approve.textContent = '批准并执行';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'button button-ghost button-small';
    cancel.textContent = '暂不执行';
    let settled = false;
    const finish = (approved) => {
      if (settled) return;
      settled = true;
      approve.disabled = true;
      cancel.disabled = true;
      node.classList.add(approved ? 'is-approved' : 'is-cancelled');
      if (!approved) detail.textContent = '已取消：没有提交受控执行请求。';
      resolve(approved);
    };
    approve.addEventListener('click', () => finish(true));
    cancel.addEventListener('click', () => finish(false));
    signal?.addEventListener('abort', () => finish(false), { once: true });
    actions.append(approve, cancel);
    node.append(title, detail, actions);
    messages?.append(node);
    followMessagesBottom();
  });
}

function renderPlan(plan) {  planCard.replaceChildren();
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

function createAgentTurnId() {
  try {
    if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID().replace(/-/g, '');
  } catch { /* older browsers or restricted crypto */ }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

async function runTask(message, signal, turnId) {
  const modelId = $('model-select')?.value || undefined;
  const deviceId = $('device-select')?.value || undefined;
  const computeResourceId = $('compute-resource-select')?.value || undefined;
  // Everything goes to the official DSH runtime when it is enabled — the
  // model decides when to call the rdk_* tools (training, board, deployment
  // …), and every tool call rides the authenticated domain routes. Only a
  // disabled runtime (503) falls back to the guarded legacy planner.
  let stopApprovalPolling = () => {};
  try {
    setAgentBusy(true, '模型思考与工具执行中…');
    stopApprovalPolling = startDshApprovalPolling(signal);
    const dsh = await api('/sim2real/dsh/chat', {
      method: 'POST',
      signal,
      body: JSON.stringify({
        message,
        turnId,
        ...(activeDshSessionId ? { sessionId: activeDshSessionId } : {}),
        context: { modelId, deviceId, computeResourceId },
      }),
    });
    if (dsh?.ok && dsh.text) {
      if (typeof dsh.sessionId === 'string') persistActiveDshSession(dsh.sessionId);
      removeTypingIndicator();
      renderDshReply(dsh);
      return;
    }
  } catch (error) {
    if (!(error && error.status === 503)) throw error;
  } finally {
    stopApprovalPolling();
  }
  const response = await api('/sim2real/agent/plan', { method: 'POST', signal, body: JSON.stringify({ message, context: { modelId, deviceId, computeResourceId } }) });
  removeTypingIndicator();
  let plan = response?.plan;
  const variants = Array.isArray(response?.variants) ? response.variants : [];
  if (!plan && variants.length) plan = variants.find((item) => item?.key === 'thorough')?.plan;
  if (!plan || !Array.isArray(plan.steps) || !plan.steps.length || plan.steps.some((item) => !item || typeof item !== 'object')) throw new Error('服务没有返回有效的可执行计划');
  // Plan diversity (Bakusevych #2): when the server offers alternative ways to
  // reach the same goal, the operator picks one instead of accepting the
  // first plan as final. The pause is client-side only — execute stays a
  // separate, operator-visible action either way.
  if (variants.length > 1) plan = await choosePlanVariant(variants, plan);
  if (!plan) {
    addMessage('agent', '已取消：未提交执行请求，可随时重新发起。');
    return;
  }
  if (plan.steps.some((item) => item.tool === 'simulator.open')) {
    document.querySelector('[data-view-target="simulate"]')?.click();
    $('simulator-frame')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  renderPlan(plan);
  addMessage('agent', `收到，按 ${plan.steps.length} 步执行：${plan.steps.map((item) => item.label).join(' → ')}。`);
  const approved = await chooseExecutionApproval(plan, signal);
  if (!approved) {
    addMessage('agent', signal?.aborted ? '已停止等待，未提交执行请求。' : '已取消：未提交执行请求，可随时重新发起。');
    return;
  }
  const execution = await api('/sim2real/agent/execute', { method: 'POST', signal, body: JSON.stringify({ plan, approved: true }) });
  const run = execution?.run;
  if (!run?.id || !Array.isArray(run.steps) || run.steps.some((item) => !item || typeof item !== 'object')) throw new Error('服务没有返回有效的运行记录');
  renderRun(run);
  const taskCard = renderTaskCard(run);
  // A live task belongs to the session in flight: snapshot it so reopening
  // this session later replays the terminal card read-only.
  const sessionRecord = ensureSession(sanitizeTaskCard(run));
  activeSessionId = sessionRecord.id;
  if (plan.steps.some((item) => item.tool === 'simulator.open')) {
    void runSimulatorDemo(message).catch((error) => renderAgentError(error, true, message));
  }
  const terminal = new Set(['completed', 'partial', 'failed', 'blocked', 'cancelled', 'timed_out']);
  let transientFailures = 0;
  let lastStepLabel = '';
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await waitWithSignal(attempt ? 700 : 250, signal);
    let result;
    try {
      result = await api(`/sim2real/agent/runs/${encodeURIComponent(run.id)}`, { signal });
      transientFailures = 0;
    } catch (error) {
      transientFailures += 1;
      // The message is surfaced to the operator, so the cause is kept instead of
      // flattened away: this is the terminal failure after four attempts, and
      // the original request/HTTP error is what makes it diagnosable.
      if (transientFailures >= 4) throw new Error(`运行状态获取失败：${error.message}`, { cause: error });
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
      if (activeSessionId) {
        const sessions = readSessions();
        const record = sessions.find((item) => item.id === activeSessionId);
        if (record) {
          record.task = sanitizeTaskCard(result.run);
          record.updatedAt = new Date().toISOString();
          persistSession(record);
        }
      }
      if (result.run.status === 'completed') {
        const links = (result.run.evidence || []).filter((item) => item.href).length;
        addMessage('agent', links ? '任务完成，证据卡片里可直接跳转运行记录。' : '任务完成。');
      } else {
        const completed = (result.run.steps || []).filter((item) => item.status === 'completed').length;
        addMessage('agent', completed > 0 ? '任务部分完成：已完成的证据已保留，请按任务卡中的失败步骤处理后再重试。' : `任务结束：${STATUS_LABELS[result.run.status] || result.run.status}`);
      }
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
  const turnId = input.dataset.agentRetryTurnId || createAgentTurnId();
  delete input.dataset.agentRetryTurnId;
  // The session record is created with the first user message, so the
  // transcript lands in one place even if planning fails before any task
  // card exists.
  if (!activeSessionId) ensureSession();
  addMessage('user', message);
  const controller = new AbortController();
  activeTaskController = controller;
  setAgentBusy(true, '正在生成计划…');
  void runTask(message, controller.signal, turnId)
    .catch((error) => {
      if (error?.name === 'AbortError') {
        addMessage('agent', '已停止等待。若任务已经提交到后台，它仍可能继续运行，请到运行记录查看状态。');
        return;
      }
      renderAgentError(error, true, message, turnId);
    })
    .finally(() => {
      removeTypingIndicator();
      if (activeTaskController === controller) {
        activeTaskController = null;
        setAgentBusy(false);
      }
    });
  showTypingIndicator();
});

stopButton?.addEventListener('click', () => {
  if (!activeTaskController) return;
  activeTaskController.abort();
  stopButton.disabled = true;
  if (runtimeStatus) runtimeStatus.textContent = '正在停止等待…';
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
let drawerRestoreFocus = null;

function drawerFocusableElements() {
  if (!panel) return [];
  return [...panel.querySelectorAll(
    'a[href], area[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((element) => !element.closest('[hidden]') && element.getAttribute('aria-hidden') !== 'true');
}

function setAgentDrawer(open) {
  if (!panel) return;
  const restoreFocus = arguments.length < 2 || arguments[1] !== false;
  const wasOpen = document.body.classList.contains('agent-chat-open');
  if (open && !wasOpen) {
    const active = document.activeElement;
    drawerRestoreFocus =
      active instanceof HTMLElement &&
      active !== document.body &&
      active !== document.documentElement &&
      !active.closest('[hidden]') &&
      !active.hasAttribute('disabled')
        ? active
        : launcher;
  }
  document.body.classList.toggle('agent-chat-open', open);
  panel.setAttribute('aria-hidden', open ? 'false' : 'true');
  panel.tabIndex = -1;
  launcher?.setAttribute('aria-expanded', open ? 'true' : 'false');
  launcher?.setAttribute('aria-label', open ? '关闭 Agent 对话' : '打开 Agent 对话');
  if (backdrop) backdrop.hidden = !open;
  if (open) {
    window.setTimeout(() => {
      if (!document.body.classList.contains('agent-chat-open')) return;
      const target = input && !input.disabled ? input : drawerFocusableElements()[0] || panel;
      target.focus();
    }, 80);
  } else if (wasOpen && restoreFocus) {
    const target = drawerRestoreFocus;
    drawerRestoreFocus = null;
    window.setTimeout(() => {
      if (
        target?.isConnected &&
        !target.closest?.('[hidden]') &&
        !target.hasAttribute?.('disabled') &&
        typeof target.focus === 'function'
      )
        target.focus();
      else launcher?.focus();
    }, 0);
  } else if (!open) {
    drawerRestoreFocus = null;
  }
}

launcher?.addEventListener('click', () => {
  if (dragged) return;
  setAgentDrawer(!document.body.classList.contains('agent-chat-open'));
});
closeButton?.addEventListener('click', () => setAgentDrawer(false));
backdrop?.addEventListener('click', () => setAgentDrawer(false));
document.addEventListener('keydown', (event) => {
  if (!document.body.classList.contains('agent-chat-open')) return;
  if (event.key === 'Escape') {
    setAgentDrawer(false);
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = drawerFocusableElements();
  if (!focusable.length) {
    event.preventDefault();
    panel?.focus();
    return;
  }
  const active = document.activeElement;
  if (event.shiftKey) {
    if (active === focusable[0] || !panel?.contains(active)) {
      event.preventDefault();
      focusable[focusable.length - 1].focus();
    }
  } else if (active === focusable[focusable.length - 1] || !panel?.contains(active)) {
    event.preventDefault();
    focusable[0].focus();
  }
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

// Example prompts lower the blank-composer barrier: each one names the
// capability it demonstrates (the agent's four core actions) plus a concrete
// task, so the drawer reads as a controlled operator console — not a chat toy.
const EXAMPLE_PROMPTS = [
  { capability: '解释状态', prompt: '检查 X5 板卡状态和磁盘用量' },
  { capability: '生成计划', prompt: '帮我生成只读部署预检计划' },
  { capability: '执行操作', prompt: '跑一轮 GPU 冒烟训练并跟踪结果' },
  { capability: '留存证据', prompt: '汇总最近一次训练的评测证据' },
];
const composer = $('agent-chat-form');
if (composer) {
  const chips = document.createElement('div');
  chips.className = 'agent-prompt-chips';
  chips.setAttribute('aria-label', 'Agent 能力与示例任务');
  for (const { capability, prompt } of EXAMPLE_PROMPTS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'agent-prompt-chip';
    chip.title = '点击直接发送';
    const cap = document.createElement('strong');
    cap.textContent = capability;
    const task = document.createElement('span');
    task.textContent = prompt;
    chip.append(cap, task);
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

initSessionRail();
void refreshRuntimeStatus();
})();
