const CONTRACT_ID = 'microduck-policy-v1';
const SIMULATOR_PATH = '/mujoco/microduck/';
const BASE_PATH = window.location.pathname.startsWith('/sim2real') ? '/sim2real' : '';

function appRelativePath(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.startsWith('//') || /^https?:\/\//i.test(raw)) return raw;
  if (BASE_PATH && raw.startsWith('/mujoco/')) return BASE_PATH + raw;
  return raw;
}
const PRODUCT_PROFILES = Object.freeze({
  microduck: {
    id: 'microduck',
    displayName: 'MicroDuck',
    projectName: 'MicroDuck · X5 Starter',
    kitName: 'RDK X5 Starter Kit',
    contractId: CONTRACT_ID,
    simulatorPath: SIMULATOR_PATH,
  },
  'rdk-duck': {
    id: 'rdk-duck',
    displayName: 'RDK Duck',
    projectName: 'RDK Duck · X5 Product',
    kitName: 'RDK X5 + 配件套件',
    contractId: 'rdk-duck-policy-v1',
    simulatorPath: '',
  },
});

// Keep the MicroDuck template aligned with the upstream physical-key map and
// the overlay. These are runtime/UI bindings, not claims that every action
// has a separate ONNX artifact.
const MICRODUCK_CONTROLS = Object.freeze([
  { id: 'move', label: '移动', keys: ['W', 'A', 'S', 'D', '↑', '↓', '←', '→'], description: 'W/A/S/D 或方向键：前进、后退、左转、右转。', source: 'keyboard' },
  { id: 'kick-left', label: '左脚踢球', keys: ['Q'], description: '触发左脚踢球动作。', source: 'keyboard' },
  { id: 'kick-right', label: '右脚踢球', keys: ['E'], description: '触发右脚踢球动作。', source: 'keyboard' },
  { id: 'alternate-kick', label: '换脚踢球', keys: ['F'], description: '由仿真引擎自动选择下一只脚。', source: 'keyboard' },
  { id: 'sit-toggle', label: '坐下 / 站起', keys: ['R'], description: '切换坐下与站立状态。', source: 'keyboard' },
  { id: 'ground-pick', label: '拾取', keys: ['G'], description: '触发喙朝地面的拾取动作。', source: 'keyboard' },
  { id: 'chase-camera', label: '跟随视角', keys: ['C'], description: '切换跟随镜头，不是相机硬件控制。', source: 'keyboard' },
  { id: 'locomotion-mode', label: '移动模式', keys: ['M'], description: '在双足与滚轮模式之间切换。', source: 'keyboard' },
  { id: 'quack', label: '叫一声', keys: ['B'], description: '平台覆盖层快捷键（上游桌面键盘未绑定）；移动端按钮和手柄也可触发。', source: 'ui' },
  { id: 'reset', label: '重置仿真', keys: ['Space'], description: '重新开始当前仿真。', source: 'keyboard' },
  { id: 'spawn-ball', label: '生成球', description: '通过移动端完整控制面板或仿真 API 触发。', source: 'ui' },
]);

const ACTION_TASKS = Object.freeze({
  walk: { label: '行走', hint: '稳定步态与速度控制' },
  turn: { label: '转向', hint: '左右转向与姿态保持' },
  sit: { label: '坐下 / 站起', hint: '动作切换与自恢复' },
  recover: { label: '自恢复', hint: '跌倒检测与起身策略' },
  kick: { label: '踢球', hint: '目标交互与动作衔接' },
  custom: { label: '自定义动作', hint: '使用自己的策略包' },
});

function readTaskPreference() {
  try {
    // The one-command demo must open on the same, familiar action every time.
    // Operators can still switch tasks after the page has loaded.
    if (new URLSearchParams(window.location.search).get('demo') === '1') return 'walk';
    const value = window.localStorage?.getItem('rdk-duck-lab-task');
    return value && ACTION_TASKS[value] ? value : 'walk';
  } catch {
    return 'walk';
  }
}

function readProductPreference() {
  try {
    if (new URLSearchParams(window.location.search).get('demo') === '1') return 'microduck';
    const value = window.localStorage?.getItem('rdk-duck-lab-product');
    return value && PRODUCT_PROFILES[value] ? value : 'microduck';
  } catch {
    return 'microduck';
  }
}

function readPresentationPreference() {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('presentation') === '0') return false;
    if (params.get('demo') === '1' || params.get('presentation') === '1') return true;
    return window.localStorage?.getItem('rdk-duck-lab-presentation') === '1';
  } catch {
    return false;
  }
}

function readNotifyPreference() {
  try {
    return window.localStorage?.getItem('rdk-duck-lab-notify') === '1';
  } catch {
    return false;
  }
}

const RUN_TERMINAL_STATUSES = Object.freeze(['completed', 'failed', 'blocked', 'cancelled']);
const ACTIVE_RUN_STATUSES = Object.freeze(['queued', 'running']);

function isTerminalRunStatus(status) {
  return RUN_TERMINAL_STATUSES.includes(String(status || '').toLowerCase());
}

function isActiveRunStatus(status) {
  return ACTIVE_RUN_STATUSES.includes(String(status || '').toLowerCase());
}

function notifyRunTerminal(run) {
  const title =
    String(run.status || '').toLowerCase() === 'completed' ? '训练任务完成' : '训练任务未完成';
  const runModel = (state.overview?.models || []).find((model) => model.id === run.modelId);
  const detail = [runModel ? modelLabel(runModel) : run.modelId, statusLabel(run.status)]
    .filter(Boolean)
    .join(' · ');
  showToast((title + '：' + detail).slice(0, 120), run.status === 'completed' ? 'success' : 'error');
  if (
    state.notifyEnabled &&
    typeof Notification !== 'undefined' &&
    Notification.permission === 'granted'
  ) {
    try {
      new Notification('RDK 工作台', { body: (title + '：' + detail).slice(0, 140) });
    } catch {
      // Some browsers restrict Notification construction; the toast already
      // informed the user, so a failure here is silent.
    }
  }
}

function syncNotifyToggle() {
  const button = $('notify-toggle');
  if (!button) return;
  const granted =
    state.notifyEnabled && typeof Notification !== 'undefined' && Notification.permission === 'granted';
  button.textContent = state.notifyEnabled ? '通知开' : '通知关';
  button.setAttribute('aria-pressed', state.notifyEnabled ? 'true' : 'false');
  button.classList.toggle('is-active', granted);
}

async function toggleNotifyPreference() {
  if (!state.notifyEnabled) {
    if (typeof Notification === 'undefined') {
      showToast('当前浏览器不支持系统通知，仍会在页面内提示。', 'normal');
    } else if (Notification.permission === 'denied') {
      showToast('系统通知已被浏览器拒绝；可在站点权限设置中重新允许。', 'error');
    } else if (Notification.permission !== 'granted') {
      try {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
          showToast('未获得系统通知权限；仍会保存偏好并在页面内提示。', 'normal');
          return;
        }
      } catch {
        showToast('无法请求系统通知权限；仍会保存偏好并在页面内提示。', 'normal');
        return;
      }
    }
  }
  state.notifyEnabled = !state.notifyEnabled;
  try {
    window.localStorage?.setItem('rdk-duck-lab-notify', state.notifyEnabled ? '1' : '0');
  } catch {
    // Preference persistence is best-effort; the in-session toggle still works.
  }
  syncNotifyToggle();
}

function renderContextLive() {
  const wrap = $('context-live');
  if (!wrap) return;
  const model = selectedModel();
  const device = selectedDevice();
  const activeRuns = runsForCurrentModel().filter((run) => isActiveRunStatus(run.status));
  const robogo = state.overview?.integrations?.robogo || {};
  const localRunner = state.overview?.integrations?.simulator?.local || {};
  let backendLabel = '检查中';
  if (state.authRequired) backendLabel = '需要登录';
  else if (state.serviceError) backendLabel = '服务不可用';
  else if (robogo.state === 'ready') backendLabel = 'RoboGo 就绪';
  else if (localRunner.available === true && localRunner.healthy === true) backendLabel = '本地就绪';
  else if (localRunner.available === true) backendLabel = '本地已配置';
  setText(
    'context-live-model',
    model ? modelLabel(model) : (state.overview?.models?.length ? '未选择' : '暂无模型'),
  );
  setText(
    'context-live-device',
    device ? device.name || device.id : (state.overview?.devices?.length ? '未选择' : '暂无板卡'),
  );
  if (activeRuns.length === 1) {
    setText('context-live-runs', '1 个任务 · ' + statusLabel(activeRuns[0].status));
  } else if (activeRuns.length > 1) {
    setText('context-live-runs', activeRuns.length + ' 个任务进行中');
  } else {
    setText('context-live-runs', '空闲');
  }
  setText('context-live-backend', backendLabel);
}

const state = {
  overview: null,
  productProfiles: null,
  model: null,
  compatibility: [],
  validation: null,
  selectedModelId: '',
  selectedDeviceId: '',
  activeDeployment: null,
  loading: false,
  serviceError: false,
  authRequired: false,
  authNoticeShown: false,
  productId: readProductPreference(),
  taskId: readTaskPreference(),
  notifyEnabled: readNotifyPreference(),
  notifiedRunIds: new Set(),
  confirmRunResolve: null,
  recordsTab: 'all',
  recordsQuery: '',
  selectedRecord: null,
  telemetry: null,
  publishingTelemetry: false,
  runSubmitting: false,
  deploymentSubmitting: false,
  // The assistant is a thin, account-scoped UI layer. It never invents run
  // state; it only derives suggestions from the overview already loaded by
  // the workspace and from explicit read-only board health probes.
  agent: {
    boardHealth: null,
    checkingBoard: false,
    collapsed: false,
  },
  station: {
    ready: false,
    mock: false,
    device: null,
    statusReader: null,
    streamAbort: null,
    streamReconnectAttempts: 0,
    streamReconnectTimer: null,
    cameraOn: false,
    log: [],
  },
};

let overviewPollTimer = null;
const runStatusFailures = new Map();
let runStatusBackoffUntil = 0;
let runStatusNoticeAt = 0;

const $ = (id) => document.getElementById(id);

function apiPath(path) {
  return BASE_PATH + '/api' + path;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatTelemetrySeconds(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(2) + 's' : '—';
}

function formatTelemetryRate(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return '—';
  const rounded = Math.round(numeric * 10) / 10;
  return rounded + 'Hz';
}

function setText(id, value) {
  const node = $(id);
  if (node) node.textContent = String(value ?? '');
}

function showToast(message, tone = 'normal') {
  const region = $('toast-region');
  if (!region) return;
  const toast = document.createElement('div');
  toast.className =
    'toast' + (tone === 'error' ? ' toast-error' : tone === 'success' ? ' toast-success' : '');
  toast.textContent = message;
  region.append(toast);
  window.setTimeout(() => toast.remove(), 4800);
}

function safeLoginUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '/rdkstudio/';
  try {
    const parsed = new URL(raw, window.location.origin);
    const sameOrigin = parsed.origin === window.location.origin;
    if (parsed.username || parsed.password || (!sameOrigin && parsed.protocol !== 'https:')) {
      return '/rdkstudio/';
    }
    return sameOrigin
      ? parsed.pathname + parsed.search + parsed.hash
      : parsed.toString();
  } catch {
    return '/rdkstudio/';
  }
}

/* SSO 登录后回到本工作台：把 IdP URL 里的 returnTo 指回当前页面，
   而不是落在主站根让用户再手动找回来。仅改同源回跳参数，其它参数原样保留。 */
function withLocalReturnTo(loginUrl) {
  try {
    const parsed = new URL(loginUrl, window.location.origin);
    if (parsed.origin === window.location.origin) return loginUrl;
    const returnHere = window.location.origin + BASE_PATH + '/';
    const redirectRaw = parsed.searchParams.get('redirectUrl');
    if (redirectRaw) {
      const redirect = new URL(redirectRaw, window.location.origin);
      const returnTo = redirect.searchParams.get('returnTo');
      if (returnTo && new URL(returnTo, window.location.origin).origin === window.location.origin) {
        redirect.searchParams.set('returnTo', returnHere);
        parsed.searchParams.set('redirectUrl', redirect.toString());
        return parsed.toString();
      }
    }
    return loginUrl;
  } catch {
    return loginUrl;
  }
}

function safeLaunchUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.startsWith('//')) return null;
  try {
    const parsed = new URL(raw, window.location.origin);
    if (parsed.username || parsed.password || parsed.protocol === 'javascript:') return null;
    const sameOrigin = parsed.origin === window.location.origin;
    if (!sameOrigin && parsed.protocol !== 'https:') return null;
    // Keep launch targets free of opaque fragments/queries supplied by a
    // runner. Same-origin paths are returned normalized; the caller decides
    // whether the built-in default needs a reverse-proxy prefix.
    if (parsed.search || parsed.hash) return null;
    // An operator may expose an external MicroDuck service at a same-origin
    // path such as /mujoco/microduck/. That path is already routed by Nginx;
    // a configured entry is therefore used verbatim. Only the built-in
    // default is prefixed by appRelativePath().
    return sameOrigin ? parsed.pathname : parsed.toString();
  } catch {
    return null;
  }
}

/* 登录门：优先展示本地 SSO 登录表单（POST /api/sso/login 由服务端转发
   Studio 账号中心并代管会话 Cookie）；「改用 RDK Studio 登录页」保留为兜底外链。 */
const AUTH_METHOD_FIELDS = {
  account: ['userName', 'password'],
  sms: ['mobile', 'code'],
  email: ['email', 'code'],
};
let authMethod = 'account';
let authSubmitting = false;

function authFieldInput(name) {
  const field = document.querySelector('[data-auth-field="' + name + '"]');
  return field ? field.querySelector('input') : null;
}

function setAuthMethod(method) {
  if (!AUTH_METHOD_FIELDS[method]) return;
  authMethod = method;
  document.querySelectorAll('.auth-login-tab').forEach((tab) => {
    tab.classList.toggle('is-active', tab.dataset.authMethod === method);
  });
  const visible = new Set(AUTH_METHOD_FIELDS[method]);
  document.querySelectorAll('[data-auth-field]').forEach((field) => {
    field.hidden = !visible.has(field.dataset.authField);
  });
  setAuthLoginError('');
  syncAuthLoginSubmit();
}

function syncAuthLoginSubmit() {
  const submit = $('auth-login-submit');
  if (!submit) return;
  const required = AUTH_METHOD_FIELDS[authMethod] || [];
  const filled = required.every((name) => String(authFieldInput(name)?.value || '').trim());
  submit.disabled = authSubmitting || !filled;
}

function setAuthLoginError(message) {
  const node = $('auth-login-error');
  if (!node) return;
  node.textContent = String(message || '');
  node.hidden = !message;
}

function setAuthGate(payload) {
  state.authRequired = true;
  const loginUrl = withLocalReturnTo(safeLoginUrl(
    payload && typeof payload === 'object' && typeof payload.ssoLoginUrl === 'string'
      ? payload.ssoLoginUrl
      : '/rdkstudio/',
  ));
  const gate = $('auth-gate');
  const loginButton = $('auth-login-button');
  const loginLink = $('login-link');
  if (gate) gate.hidden = false;
  for (const node of [loginButton, loginLink]) {
    if (!node) continue;
    node.setAttribute('href', loginUrl);
    node.hidden = false;
  }
  setText('service-status', '需要登录');
  syncServicePill();
  renderEvaluationNext();
  if (!state.authNoticeShown) {
    state.authNoticeShown = true;
    showToast('请先登录 RDK 账号，再加载你的 Sim2Real 工作区。', 'error');
  }
}

async function submitAuthLogin() {
  if (authSubmitting) return;
  const method = authMethod;
  const body = { method };
  for (const name of AUTH_METHOD_FIELDS[method] || []) {
    const value = String(authFieldInput(name)?.value || '').trim();
    if (!value) return;
    body[name] = value;
  }
  authSubmitting = true;
  syncAuthLoginSubmit();
  setAuthLoginError('');
  const submit = $('auth-login-submit');
  if (submit) submit.textContent = '登录中…';
  try {
    await request('/sso/login', { method: 'POST', body: JSON.stringify(body) });
    clearAuthGate();
    showToast('登录成功，正在加载工作区…', 'success');
    await loadOverview();
  } catch (error) {
    const message =
      error instanceof ApiError && error.payload && error.payload.message
        ? String(error.payload.message)
        : error instanceof Error
          ? error.message
          : '登录失败，请稍后重试';
    setAuthLoginError(message);
  } finally {
    authSubmitting = false;
    if (submit) submit.textContent = '登录';
    syncAuthLoginSubmit();
  }
}

async function logoutAccount() {
  try {
    await request('/sso/logout', { method: 'POST', body: '{}' });
  } catch {
    // Even if the logout call fails, drop back to the login gate locally.
  }
  state.overview = null;
  setAuthGate(null);
  renderAll();
  showToast('已退出登录。', 'success');
}

function clearAuthGate() {
  state.authRequired = false;
  state.authNoticeShown = false;
  $('auth-gate')?.setAttribute('hidden', '');
  $('login-link')?.setAttribute('hidden', '');
  setAuthLoginError('');
  syncServicePill();
}

function syncServicePill() {
  const servicePill = $('service-pill');
  if (!servicePill) return;
  const error = state.authRequired || state.serviceError;
  const loading = !error && (state.loading || !state.overview);
  servicePill.classList.toggle('is-ready', !error && !loading && Boolean(state.overview));
  servicePill.classList.toggle('is-loading', loading);
  servicePill.classList.toggle('is-error', error);
}

class ApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

async function request(path, options = {}) {
  const headers = Object.assign(
    options.body ? { 'content-type': 'application/json' } : {},
    options.headers || {},
  );
  let response;
  try {
    response = await fetch(
      apiPath(path),
      Object.assign({}, options, {
        credentials: 'same-origin',
        headers,
      }),
    );
  } catch (error) {
    throw new ApiError(error instanceof Error ? error.message : '网络连接失败', 0, null);
  }
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await response.json().catch(() => null)
    : await response.text().catch(() => '');
  if (!response.ok) {
    const message =
      (payload && typeof payload === 'object' && (payload.message || payload.error)) ||
      (typeof payload === 'string' && payload) ||
      '请求失败（HTTP ' + response.status + '）';
    if (response.status === 401) {
      setAuthGate(payload);
    }
    throw new ApiError(String(message), response.status, payload);
  }
  return payload;
}

function setLoading(value) {
  state.loading = value;
  document.body.classList.toggle('is-loading', value);
  $('main-content')?.setAttribute('aria-busy', value ? 'true' : 'false');
  $('refresh-button')?.toggleAttribute('disabled', value);
  syncServicePill();
}

const WORKFLOW_VIEWS = [
  'overview',
  'contract',
  'simulate',
  'train',
  'evaluate',
  'deploy',
  'records',
  'station',
];

function setView(view, { updateHash = true, scroll = true } = {}) {
  const wanted = WORKFLOW_VIEWS.includes(view) ? view : 'overview';
  document.body.dataset.activeView = wanted;
  document.querySelectorAll('[data-view-section]').forEach((section) => {
    section.hidden = section.dataset.viewSection !== wanted;
  });
  document.querySelectorAll('[data-view-target]').forEach((control) => {
    const active = control.dataset.viewTarget === wanted;
    const isNavigationControl =
      control.classList.contains('nav-item') ||
      control.classList.contains('module-item');
    control.classList.toggle('is-active', active && isNavigationControl);
    // Keep one canonical current-page announcement for screen readers. The
    // module cards and workflow strip still receive the visual active class,
    // but they are alternate entry points rather than additional pages.
    if (control.classList.contains('nav-item')) {
      if (active) control.setAttribute('aria-current', 'page');
      else control.removeAttribute('aria-current');
    } else {
      control.removeAttribute('aria-current');
    }
  });
  if (updateHash && window.location.hash !== '#' + wanted) {
    window.history.replaceState(
      null,
      '',
      window.location.pathname + window.location.search + '#' + wanted,
    );
  }
  // Each workflow surface is a presentation frame. Reset the scroll position
  // when switching frames so a sticky header or a previous deep scroll cannot
  // hide the section title and its primary action during a live demo.
  if (scroll) window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  // 评估页的真机对照快照只在视图内轮询，离开即停，避免后台空转。
  if (wanted === 'evaluate') originbotCompareStart();
  else originbotCompareStop();
}

function setPresentationMode(enabled, { persist = true } = {}) {
  const active = Boolean(enabled);
  document.body.classList.toggle('presentation-mode', active);
  const toggle = $('presentation-toggle');
  if (toggle) {
    toggle.setAttribute('aria-pressed', active ? 'true' : 'false');
    toggle.classList.toggle('is-active', active);
    toggle.textContent = active ? '退出演示' : '演示视图';
    toggle.title = active ? '退出适合投屏的演示视图' : '切换适合投屏的演示视图';
  }
  if (persist) {
    try {
      window.localStorage?.setItem('rdk-duck-lab-presentation', active ? '1' : '0');
    } catch {
      // Preference persistence is optional in file:// and privacy contexts.
    }
  }
}

function modelLabel(model) {
  const name = model?.manifest?.displayName || model?.manifest?.modelId || '未命名模型';
  const version = model?.manifest?.version ? ' · ' + model.manifest.version : '';
  return name + version;
}

function selectedModel() {
  return (
    state.overview?.models?.find(
      (model) =>
        model.id === state.selectedModelId && model.manifest?.robot?.id === state.productId,
    ) || (state.model?.manifest?.robot?.id === state.productId ? state.model : null)
  );
}

function selectedProductProfile() {
  const fallback = PRODUCT_PROFILES[state.productId] || PRODUCT_PROFILES.microduck;
  const remote = state.productProfiles?.find((profile) => profile.id === state.productId);
  return remote ? Object.assign({}, fallback, remote) : fallback;
}

function selectedTask() {
  return ACTION_TASKS[state.taskId] || ACTION_TASKS.walk;
}

function selectedDevice() {
  return state.overview?.devices?.find((device) => device.id === state.selectedDeviceId) || null;
}

function stateClass(status) {
  const normalized = String(status || '').toLowerCase();
  if (['ready', 'completed', 'success'].includes(normalized)) return 'state-success';
  if (['blocked', 'queued', 'partial', 'running', 'planned'].includes(normalized)) return 'state-partial';
  if (['failed', 'error'].includes(normalized)) return 'state-error';
  return 'state-neutral';
}

function statusLabel(status) {
  return (
    {
      queued: '排队中',
      running: '运行中',
      completed: '已完成',
      ready: '可运行',
      planned: '已计划',
      blocked: '已阻断',
      failed: '失败',
      cancelled: '已取消',
      registered: '已登记',
      demo: '演示样例',
    }[String(status || '').toLowerCase()] || String(status || '未知')
  );
}

function renderSelects() {
  const allModels = state.overview?.models || [];
  const models = allModels.filter((model) => model.manifest?.robot?.id === state.productId);
  const devices = state.overview?.devices || [];
  const taskSelect = $('task-select');
  const productSelect = $('product-select');
  const modelSelect = $('model-select');
  const deviceSelect = $('device-select');
  if (!PRODUCT_PROFILES[state.productId]) state.productId = 'microduck';
  if (productSelect) productSelect.value = state.productId;
  if (taskSelect) taskSelect.value = state.taskId;
  if (modelSelect) {
    modelSelect.replaceChildren();
    if (!models.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent =
        state.productId === 'rdk-duck' ? '暂无 RDK Duck 模型 · 请导入 manifest' : '暂无模型';
      modelSelect.append(option);
    }
    for (const model of models) {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = modelLabel(model);
      modelSelect.append(option);
    }
    if (!models.some((model) => model.id === state.selectedModelId)) {
      state.selectedModelId = models[0]?.id || '';
    }
    modelSelect.value = state.selectedModelId;
  }
  if (deviceSelect) {
    deviceSelect.replaceChildren();
    if (!devices.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '没有已登记的板卡';
      deviceSelect.append(option);
      state.selectedDeviceId = '';
    } else {
      for (const device of devices) {
        const option = document.createElement('option');
        option.value = device.id;
        option.textContent = device.name || device.id;
        deviceSelect.append(option);
      }
      if (!devices.some((device) => device.id === state.selectedDeviceId)) {
        state.selectedDeviceId = devices[0]?.id || '';
      }
      deviceSelect.value = state.selectedDeviceId;
    }
  }
  setText('model-count', models.length + ' 个 ' + selectedProductProfile().displayName + ' 模型');
  setText('device-count', devices.length + ' 块板卡');
}

function renderIntegrations() {
  const integrations = state.overview?.integrations || {};
  const identity = state.overview?.identity || null;
  const robogo = integrations.robogo || {};
  const local = integrations.simulator?.local || {};
  const storage = integrations.storage || {};
  const simulator = integrations.simulator || {};
  const boardAgent = simulator.boardAgent || {};
  const profile = selectedProductProfile();
  const model = selectedModel();
  const device = selectedDevice();
  const targetDeployment =
    state.activeDeployment ||
    deploymentsForCurrentModel().find(
      (item) => item.modelId === model?.id && item.deviceId === device?.id,
    );
  const targetReady = Boolean(
    targetDeployment && ['ready', 'completed'].includes(String(targetDeployment.status || '')),
  );
  const latest = latestRun();
  const currentEvidence = currentTelemetry();
  const latestRealEvidence = hasReleaseGradeEvidence(currentEvidence, latest);
  const localConfigured = local.available === true;
  const localReachable = local.reachable === true;
  const localHealthy = local.healthy === true;
  const localReady = localConfigured && localReachable && localHealthy;
  const overviewReady = Boolean(state.overview);
  // Only advertise a browser simulator after the account-scoped overview has
  // confirmed its surface. A missing/disabled server surface stays gated.
  const browserAvailable =
    overviewReady && Boolean(profile.simulatorPath) && simulator.browser?.available !== false;
  setText(
    'service-status',
    state.authRequired
      ? '需要登录'
      : state.serviceError
        ? '服务不可用'
        : overviewReady
          ? '独立服务在线'
          : '检查中',
  );
  syncServicePill();
  const accountStatus = $('account-status');
  const accountDivider = $('account-divider');
  if (accountStatus && accountDivider) {
    const accountLabel = identity?.displayName || identity?.accountId || '';
    accountStatus.hidden = !accountLabel;
    accountDivider.hidden = !accountLabel;
    accountStatus.textContent = accountLabel ? '账号 · ' + accountLabel : '';
    accountStatus.title = identity?.email || identity?.accountId || '';
  }
  const accountLogout = $('account-pill-logout');
  if (accountLogout) {
    const accountLabel = identity?.displayName || identity?.accountId || '';
    accountLogout.hidden = !accountLabel;
    accountLogout.title = accountLabel ? '退出当前 RDK 账号' : '';
  }
  setText('current-project-name', profile.projectName);
  setText('sidebar-product-name', profile.displayName);
  setText('sidebar-kit-name', profile.kitName);
  setText('kit-card-title', profile.displayName + ' 套件');
  const microduckProduct = profile.id === 'microduck';
  const kitStatusLabel = $('kit-status-label');
  const kitStatus = kitStatusLabel?.closest('.kit-status');
  if (kitStatusLabel) {
    kitStatusLabel.textContent = model ? (model.builtin ? '参考契约' : '已登记') : '待配置';
  }
  kitStatus?.classList.toggle('kit-status-ready', Boolean(model));
  kitStatus?.classList.toggle('kit-status-waiting', !model);
  setText('hero-updated', '更新于 ' + formatDate(new Date().toISOString()));
  setText(
    'status-simulator',
    browserAvailable ? '浏览器 MicroDuck' : profile.displayName + ' 仿真适配器',
  );
  setText(
    'status-simulator-detail',
    browserAvailable
      ? '固定官方参考策略'
      : microduckProduct
        ? '等待挂载经过审核的静态 bundle'
        : '当前产品线等待仿真适配器',
  );
  const robogoRunnerAvailable = simulator.robogo?.available === true;
  const robogoAccountReady = robogo.state === 'ready';
  const robogoLoginRequired = robogo.state === 'login_required';
  const robogoReady = robogoRunnerAvailable && robogoAccountReady;
  const browserRunnable = browserAvailable && model?.builtin === true;
  const hasModel = Boolean(model);
  const hasRunnablePath = browserRunnable || localReady || robogoReady;
  const storageKnown = typeof storage.writable === 'boolean';
  const storageReady = storage.writable === true;
  const softwareDemoReady = hasModel && storageReady && hasRunnablePath;
  const fullSoftwareDemoReady =
    hasModel &&
    storageReady &&
    browserRunnable &&
    (localReady || robogoReady) &&
    targetReady &&
    latestRealEvidence;
  const readiness = fullSoftwareDemoReady
    ? {
        state: 'ready',
        label: '预检已通过',
        title: '仿真、训练入口、台账和只读板端预检均已就绪；Canary / Live 仍需批准',
      }
    : softwareDemoReady
      ? {
          state: 'demo',
          label: '软件演示就绪',
          title: browserRunnable
            ? targetReady && !latestRealEvidence
              ? '软件流程可演示；当前 Run 仍缺少真实评测证据'
              : '软件流程可演示；X5 只读预检尚未通过'
            : 'Mock、台账和合成证据可演示；真实 MicroDuck 场景仍需挂载 bundle',
        }
      : {
          state: 'waiting',
          label: hasModel ? '待配置' : '待选择',
          title: hasModel ? '请配置可用的仿真或训练后端' : '请先选择或登记模型契约',
        };
  const readinessNode = $('workspace-readiness');
  if (readinessNode) {
    readinessNode.textContent = readiness.label;
    readinessNode.dataset.state = readiness.state;
    readinessNode.title = readiness.title;
    readinessNode.classList.toggle('is-ready', readiness.state === 'ready');
    readinessNode.classList.toggle('is-partial', readiness.state === 'partial');
    readinessNode.classList.toggle('is-demo', readiness.state === 'demo');
    readinessNode.classList.toggle('is-waiting', readiness.state === 'waiting');
  }
  setText(
    'robogo-run-button',
    robogoRunnerAvailable
      ? robogoAccountReady
        ? '发起 RoboGo 训练'
        : robogoLoginRequired
          ? '检查 RoboGo 连接'
          : '尝试发起 RoboGo 训练'
      : '登记 RoboGo 训练',
  );
  setText(
    'local-run-button',
    local.available ? (local.mock ? '运行 Mock 协议演示' : '发起本地训练') : '登记本地训练',
  );
  const localRunButton = $('local-run-button');
  if (localRunButton) {
    localRunButton.title = local.mock
      ? '仅验证训练协议和运行台账，不生成可部署模型'
      : local.available
        ? '向已配置的本地训练 worker 提交任务'
        : '当前没有可用的本地训练 worker';
  }
  setText(
    'status-robogo',
    localReady
      ? local.mock
        ? '本地 Mock 已连接'
        : '本地训练已连接'
      : localConfigured && localReachable
        ? '本地 worker 检查失败'
        : localConfigured
          ? '本地 worker 不可达'
          : robogo.state === 'ready'
            ? 'RoboGo 已连接'
            : robogo.state === 'login_required'
              ? '登录后连接 RoboGo'
              : '本地 / RoboGo 未配置',
  );
  setText(
    'status-robogo-detail',
    localConfigured
      ? local.message || local.reason || '本地 worker 状态未知'
      : robogo.message || local.reason || '只读读取训练资源',
  );
  const storageLabel = !storageKnown ? '检查中' : storage.writable ? '台账可写' : '需要共享存储';
  setText('status-storage', storageLabel);
  setText('status-storage-card', storageLabel);
  setText('status-storage-detail', storageKnown ? storage.message || '状态按账号隔离' : '正在读取台账状态');
  const contextHealth = $('context-health');
  const contextState = !overviewReady || !storageKnown ? 'waiting' : storageReady ? 'ready' : 'blocked';
  contextHealth?.classList.toggle('is-ready', contextState === 'ready');
  contextHealth?.classList.toggle('is-blocked', contextState === 'blocked');
  contextHealth?.classList.toggle('is-waiting', contextState === 'waiting');
  $('browser-run-button')?.toggleAttribute('disabled', state.runSubmitting || !model || !browserAvailable);
  $('browser-run-button')?.setAttribute(
    'title',
    !browserAvailable
      ? '当前产品线尚未配置浏览器仿真适配器'
      : !model
        ? '请先选择模型'
        : !model.builtin
          ? '浏览器仿真只运行官方参考策略；登记模型请使用本地 worker 或 RoboGo'
          : '',
  );
  const detectButton = $('detect-button');
  if (detectButton) {
    const canDetect = Boolean(selectedDevice()) && boardAgent.available === true;
    detectButton.disabled = !canDetect;
    detectButton.title = canDetect
      ? '通过受控 BoardAgent 读取板型'
      : boardAgent.reason || '当前部署未接入 BoardAgent';
  }
  const preflightButton = $('preflight-button');
  if (preflightButton) {
    preflightButton.disabled =
      state.deploymentSubmitting || !targetDeployment || boardAgent.available !== true;
    preflightButton.title =
      boardAgent.reason || '先生成预检计划，并在部署环境接入 BoardAgent';
  }
  for (const id of ['contract-run-button', 'local-run-button', 'robogo-run-button']) {
    $(id)?.toggleAttribute('disabled', state.runSubmitting || !model);
  }
  const simulatorFrame = $('simulator-frame');
  const simulatorTitle = $('simulator-title');
  const simulatorLiveLabel = $('simulator-live-label');
  const simulatorLiveText = $('simulator-live-text');
  const simulatorRuntimeLabel = $('simulator-runtime-label');
  if (simulatorTitle) simulatorTitle.textContent = microduckProduct ? 'MicroDuck 仿真场' : 'RDK Duck 仿真适配器';
  if (simulatorFrame) simulatorFrame.title = microduckProduct ? 'MicroDuck 浏览器仿真' : 'RDK Duck 仿真适配器状态';
  if (simulatorLiveText) {
    simulatorLiveText.textContent = browserAvailable
      ? '参考策略可用'
      : microduckProduct
        ? '资源待挂载'
        : '适配器待配置';
  }
  simulatorLiveLabel?.classList.toggle('is-ready', browserAvailable);
  simulatorLiveLabel?.classList.toggle('is-waiting', !browserAvailable);
  if (simulatorRuntimeLabel) {
    simulatorRuntimeLabel.textContent = browserAvailable
      ? 'MuJoCo WASM · 50Hz'
      : microduckProduct
        ? '资源状态 · 需挂载'
        : '无浏览器适配器';
  }
  const simulatorFallback = document.querySelector('.simulator-fallback');
  const simulatorProductGate = $('simulator-product-gate');
  const simulatorGateTitle = $('simulator-gate-title');
  const simulatorGateCopy = $('simulator-gate-copy');
  const simulatorGateTrain = $('simulator-gate-train');
  const simulatorGateInstall = $('simulator-gate-install');
  const configuredBrowserEntry = safeLaunchUrl(simulator.browser?.entryUrl);
  const browserEntry = simulator.browser?.entryUrl
    ? configuredBrowserEntry || appRelativePath(SIMULATOR_PATH)
    : appRelativePath(SIMULATOR_PATH);
  const microduckMissing = profile.id === 'microduck' && simulator.browser?.state === 'missing';
  if (simulatorFrame && simulatorFrame.getAttribute('src') !== browserEntry) {
    simulatorFrame.setAttribute('src', browserEntry);
  }
  const browserEntryLink = document.querySelector('.simulator-fallback a');
  if (browserEntryLink && browserEntryLink.getAttribute('href') !== browserEntry) {
    browserEntryLink.setAttribute('href', browserEntry);
  }
  for (const id of ['microduck-entry-link', 'microduck-footer-link']) {
    const link = $(id);
    if (!link) continue;
    link.hidden = !microduckProduct;
    if (microduckProduct && link.getAttribute('href') !== browserEntry) {
      link.setAttribute('href', browserEntry);
    }
  }
  $('microduck-footer-item')?.toggleAttribute('hidden', !microduckProduct);
  if (simulatorGateTitle) {
    simulatorGateTitle.textContent = microduckMissing
      ? 'MicroDuck 仿真资源尚未挂载'
      : 'RDK Duck 仿真适配器待配置';
  }
  if (simulatorGateCopy) {
    simulatorGateCopy.textContent = microduckMissing
      ? '当前源码不内置上游静态包；请先按部署说明挂载经过审核的 release，再回到这里开始录制。'
      : '当前产品线不会复用 MicroDuck 的浏览器场景。请先导入真实契约 manifest，或使用本地 headless 仿真 worker。';
  }
  if (simulatorGateTrain) simulatorGateTrain.hidden = microduckMissing;
  if (simulatorGateInstall) {
    simulatorGateInstall.hidden = !microduckMissing;
    simulatorGateInstall.setAttribute('href', browserEntry);
  }
  if (simulatorFrame) simulatorFrame.hidden = !browserAvailable;
  if (simulatorFallback) simulatorFallback.hidden = !browserAvailable || microduckMissing;
  if (simulatorProductGate) simulatorProductGate.hidden = browserAvailable;
  setText(
    'simulator-run-status',
    browserAvailable
      ? '参考策略可用'
      : microduckProduct
        ? '资源待挂载'
        : '适配器待配置',
  );
  setText('status-board', device ? device.boardPlatform || '待探测板型' : '尚未选择板卡');
  setText('status-board-detail', device ? device.status || '设备状态未知' : '连接后进行板端预检');
  const boardIcon = $('status-board-icon');
  if (boardIcon) {
    boardIcon.classList.remove('status-icon-green', 'status-icon-blue', 'status-icon-orange');
    boardIcon.classList.add(
      targetReady
        ? 'status-icon-green'
        : device?.boardPlatform
          ? 'status-icon-blue'
          : 'status-icon-orange',
    );
    boardIcon.title = targetReady
      ? '只读板端预检已通过'
      : device?.boardPlatform
        ? '板型已探测，等待只读预检'
        : '尚未探测板型';
  }

  const robogoBadge = $('robogo-state-badge');
  if (robogoBadge) {
    robogoBadge.className = 'state-badge ' + stateClass(robogo.state);
    robogoBadge.textContent =
      robogo.state === 'ready'
        ? 'READY'
        : robogo.state === 'login_required'
          ? 'LOGIN'
          : 'UNAVAILABLE';
  }
  setText(
    'robogo-message',
    localConfigured
      ? [
          local.message || local.reason || '本地 worker 状态未知',
          Number.isInteger(local.maxConcurrentJobs)
            ? `并发 ${local.activeJobs ?? 0}/${local.maxConcurrentJobs}`
            : '',
          Number.isInteger(local.queuedJobs) ? `排队 ${local.queuedJobs}` : '',
        ]
          .filter(Boolean)
          .join(' · ')
      : robogo.message || '本地 / RoboGo 训练后端不可用',
  );
  setText('robogo-board-label', localConfigured ? '运行中任务' : '可见算力资源');
  setText('robogo-machine-label', localConfigured ? '排队任务' : '开发机');
  setText('robogo-board-count', localConfigured ? local.activeJobs ?? '—' : robogo.availableBoardCount ?? '—');
  setText('robogo-machine-count', localConfigured ? local.queuedJobs ?? '—' : robogo.developmentMachineCount ?? '—');
}

function renderModel() {
  const model = selectedModel();
  const summary = $('model-summary');
  const artifacts = $('artifact-list');
  const compatibility = $('compatibility-list');
  if (!model) {
    state.model = null;
    if (summary) summary.innerHTML = '<div class="empty-inline">没有可显示的模型</div>';
    if (artifacts) artifacts.replaceChildren();
    if (compatibility) compatibility.replaceChildren();
    return;
  }
  state.model = model;
  const manifest = model.manifest || {};
  if (summary) {
    const note = model.builtin
      ? '官方参考模型：浏览器仿真入口已固定。'
      : manifest.metadata?.notes || '用户登记模型，等待契约与制品检查。';
    const bundle = manifest.simulator?.policyBundle;
    const bundleText =
      Array.isArray(bundle?.policies) && bundle.policies.length
        ? '<div class="policy-bundle"><span class="bundle-label">策略包</span>' +
          bundle.policies
            .map(
              (policy) =>
                '<span class="policy-chip">' +
                escapeHtml(policy.label || policy.id) +
                (Array.isArray(policy.keys) && policy.keys.length
                  ? ' · ' + escapeHtml(policy.keys.join(' / '))
                  : '') +
                '</span>',
            )
            .join('') +
          '</div>'
        : '';
    summary.innerHTML =
      '<div class="summary-title"><strong>' +
      escapeHtml(manifest.displayName || manifest.modelId) +
      '</strong><span class="summary-version">' +
      escapeHtml(manifest.version || '') +
      '</span></div><p class="summary-description">' +
      escapeHtml(note) +
      '</p>' +
      bundleText;
  }
  if (artifacts) {
    artifacts.replaceChildren();
    for (const artifact of manifest.artifacts || []) {
      const row = document.createElement('div');
      row.className = 'artifact-row';
      const runtimeLabel =
        artifact.runtime === 'cpu-onnx'
          ? 'CPU ONNX · 单线程'
          : artifact.runtime === 'bpu'
            ? 'BPU'
            : '运行时待声明';
      const workloadLabel =
        artifact.workload === 'locomotion'
          ? '运控'
          : artifact.workload === 'perception'
            ? '感知'
            : artifact.workload || '通用';
      row.innerHTML =
        '<span class="artifact-name">' +
        escapeHtml(artifact.name || artifact.id) +
        '</span><span class="artifact-meta">' +
        escapeHtml(artifact.role || '') +
        ' · ' +
        escapeHtml(artifact.format || '') +
        ' · ' +
        escapeHtml(workloadLabel) +
        ' · ' +
        escapeHtml(runtimeLabel) +
        '</span>';
      artifacts.append(row);
    }
  }
  if (compatibility) {
    compatibility.replaceChildren();
    for (const item of state.compatibility || []) {
      const row = document.createElement('div');
      row.className = 'compatibility-row';
      const deployable = item.deployable === true;
      const failed = item.status === 'incompatible';
      row.innerHTML =
        '<span class="compatibility-platform">' +
        escapeHtml(item.platformId) +
        '</span><span class="compatibility-state ' +
        (deployable
          ? 'compatibility-state-ready'
          : failed
            ? 'compatibility-state-error'
            : 'compatibility-state-blocked') +
        '">' +
        escapeHtml(deployable ? '可上板' : item.status || '待检查') +
        '</span>';
      if (item.reason) row.title = item.reason;
      compatibility.append(row);
    }
  }
}

function renderActionLibrary() {
  const root = $('sim-action-list');
  const empty = $('sim-action-empty');
  if (!root || !empty) return;
  const simulator = state.model?.manifest?.simulator || {};
  // Runtime/UI controls are separate from policy artifacts: reset, quack and
  // camera actions do not necessarily have an ONNX artifact behind them.
  // Older manifests only have policyBundle, so retain that as a fallback.
  const controls = Array.isArray(simulator.controls) ? simulator.controls : [];
  const policies = Array.isArray(simulator.policyBundle?.policies)
    ? simulator.policyBundle.policies
    : [];
  const entries = controls.length ? controls : policies;
  root.replaceChildren();
  empty.hidden = entries.length > 0;
  for (const policy of entries) {
    const item = document.createElement('div');
    item.className = 'sim-action-item';
    const keys =
      Array.isArray(policy.keys) && policy.keys.length ? policy.keys.join(' / ') : '按模型默认';
    const description = String(policy.description || '').trim();
    if (description) item.title = description;
    item.setAttribute('aria-label', `${policy.label || policy.id}：${keys}${description ? `。${description}` : ''}`);
    item.innerHTML =
      '<strong>' +
      escapeHtml(policy.label || policy.id) +
      '</strong><span>' +
      escapeHtml(keys) +
      '</span>';
    root.append(item);
  }
}

function renderBoard() {
  const device = selectedDevice();
  const summary = $('board-summary');
  if (!summary) return;
  if (!device) {
    summary.innerHTML = '<div class="empty-inline">没有可用板卡；先在设备管理中登记</div>';
    return;
  }
  const platform = device.boardPlatform || '待探测';
  const reachable = device.sshReachability || device.status || 'unknown';
  const deployment =
    state.activeDeployment ||
    deploymentsForCurrentModel().find(
      (item) => item.modelId === selectedModel()?.id && item.deviceId === device.id,
    );
  const preflightReady = Boolean(
    deployment && ['ready', 'completed'].includes(String(deployment.status || '')),
  );
  const boardStateClass = preflightReady
    ? 'is-ready'
    : device.boardPlatform
      ? 'is-detected'
      : 'is-waiting';
  summary.innerHTML =
    '<div class="board-summary-row"><strong>' +
    escapeHtml(device.name || device.id) +
    '</strong><span class="board-chip ' +
    boardStateClass +
    '">' +
    escapeHtml(platform) +
    '</span></div><div class="board-details"><span>状态：' +
    escapeHtml(device.status || 'unknown') +
    '</span><span>连接：' +
    escapeHtml(device.connectionMode || 'ssh') +
    '</span><span>可达性：' +
    escapeHtml(reachable) +
    '</span></div>';
}

function renderHistory() {
  const root = $('history-list');
  if (!root) return;
  const query = state.recordsQuery.trim().toLowerCase();
  const records = recordCollection()
    .filter((record) => state.recordsTab === 'all' || record.recordType === state.recordsTab)
    .filter((record) => {
      if (!query) return true;
      return [
        record.kind,
        record.status,
        record.summary,
        record.modelId,
        record.backend,
        record.mode,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query));
    })
    .slice(0, 30);
  setText('records-count', records.length + ' 条记录');
  root.replaceChildren();
  if (!records.length) {
    root.innerHTML = query
      ? '<div class="empty-state">没有匹配的记录，试试模型名、状态或后端。</div>'
      : '<div class="empty-state">还没有运行记录。先校验契约或打开浏览器仿真。</div>';
    return;
  }
  for (const record of records) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'history-row history-row-button';
    row.dataset.recordId = record.id;
    row.dataset.recordType = record.recordType;
    const status = String(record.status || 'unknown');
    const mockRun = record.recordType === 'run' && record.mock === true;
    const syntheticRun =
      record.recordType === 'run' && record.evaluation?.replay?.source === 'demo-fixture';
    const demoTelemetry = record.recordType === 'telemetry' && record.source === 'demo-fixture';
    row.innerHTML =
      '<span class="history-time">' +
      escapeHtml(formatDate(record.createdAt)) +
      '</span><span class="history-kind">' +
      escapeHtml(
        demoTelemetry ? 'telemetry · demo fixture' : record.kind,
      ) +
      '</span><span class="history-summary">' +
      escapeHtml(record.summary || record.modelId || '') +
      '</span><span class="history-status history-status-' +
      escapeHtml(status) +
      '">' +
      escapeHtml(
        mockRun ? '协议演示' : syntheticRun || demoTelemetry ? '演示样例' : statusLabel(status),
      ) +
      '</span>';
    row.querySelector('.history-status')?.classList.toggle(
      'history-status-demo',
      mockRun || syntheticRun || demoTelemetry,
    );
    row.addEventListener('click', () => openRecordDetails(record));
    root.append(row);
  }
}

// Human-readable metric cards for the run detail dialog. Every known metric
// field gets a labeled card; anything the schema gains later still shows up in
// the raw JSON block below instead of silently disappearing.
const RUN_METRIC_CARDS = [
  ['contractValid', '契约状态', (value) => (value === true ? '通过' : value === false ? '失败' : '—')],
  ['successRate', '成功率', (value) => formatMetricPercent(value)],
  ['fallRate', '跌倒率', (value) => formatMetricPercent(value)],
  ['reward', '平均奖励', (value) => formatMetricNumber(value, 3)],
  ['episodeLength', '平均步数', (value) => formatMetricNumber(value, 1)],
  ['controlLatencyMs', '控制延迟', (value) =>
    typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) + 'ms' : '—'],
  ['iterations', '迭代数', (value) => formatMetricNumber(value, 0)],
  [
    'cuda',
    '训练设备',
    (value) => (value === true ? 'GPU (CUDA)' : value === false ? 'CPU' : '—'),
  ],
  ['observationSize', '观测维度', (value) => formatMetricNumber(value, 0)],
  ['actionSize', '动作维度', (value) => formatMetricNumber(value, 0)],
];

function formatMetricPercent(value) {
  const percent = metricPercent(value);
  return percent === null ? '—' : percent + '%';
}

function formatMetricNumber(value, digits) {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toFixed(digits)
    : '—';
}

function renderRunMetricCards(record) {
  const metrics = record.metrics || {};
  const cards = RUN_METRIC_CARDS.filter(([key]) => metrics[key] != null).map(
    ([key, label, format]) =>
      '<div class="run-metric-card' +
      (key === 'fallRate' && Number(metrics.fallRate) > 0.2 ? ' is-warn' : '') +
      (key === 'contractValid' ? (metrics[key] === true ? ' is-ok' : ' is-error') : '') +
      '"><span>' +
      escapeHtml(label) +
      '</span><strong>' +
      escapeHtml(format(metrics[key])) +
      '</strong></div>',
  );
  if (!cards.length) return '';
  return (
    '<div><strong class="run-detail-block-title">指标</strong><div class="run-metric-grid">' +
    cards.join('') +
    '</div></div>'
  );
}

function renderRunMetricsRaw(record) {
  const known = new Set(RUN_METRIC_CARDS.map(([key]) => key));
  const extras = Object.entries(record.metrics || {}).filter(([key]) => !known.has(key));
  if (!extras.length) return '';
  return (
    '<details class="run-metrics-raw"><summary>其他指标字段（' +
    extras.length +
    '）</summary><pre class="run-detail-code">' +
    escapeHtml(JSON.stringify(Object.fromEntries(extras), null, 2)) +
    '</pre></details>'
  );
}

function openRecordDetails(record) {
  const dialog = $('run-detail-dialog');
  const body = $('run-detail-body');
  if (!dialog || !body) return;
  const isRun = record.recordType === 'run';
  const isArtifact = record.recordType === 'artifact';
  const isTelemetry = record.recordType === 'telemetry';
  const mockRun = isRun && record.mock === true;
  const syntheticRun = isRun && record.evaluation?.replay?.source === 'demo-fixture';
  const demoTelemetry = isTelemetry && record.source === 'demo-fixture';
  const fields = [
    [
      '记录类型',
      isRun
        ? '训练 / 仿真 Run'
        : isArtifact
          ? '模型制品'
          : isTelemetry
            ? '遥测证据'
            : '设备发布计划',
    ],
    [
      '状态',
      mockRun
        ? '协议演示（非真实 RL）'
        : syntheticRun || demoTelemetry
          ? '演示样例（非真实遥测）'
          : statusLabel(record.status),
    ],
    [
      '后端 / 模式',
      isRun
        ? record.backend || '—'
        : isArtifact
          ? record.runtime || '—'
          : isTelemetry
            ? record.source || 'import'
            : record.mode || '—',
    ],
    ...(isRun && record.taskId
      ? [['动作任务', ACTION_TASKS[record.taskId]?.label || record.taskId]]
      : []),
    ['模型', record.modelId || '—'],
    ['创建时间', formatDate(record.createdAt)],
    ...(isRun && record.training?.profile ? [['训练档位', record.training.profile]] : []),
    ...(isRun && record.training?.numEnvs ? [['并行环境', record.training.numEnvs]] : []),
    ...(isRun && record.training?.maxIterations
      ? [['最大迭代', record.training.maxIterations]]
      : []),
    ...(isArtifact && record.role ? [['制品角色', record.role]] : []),
    ...(isArtifact && record.format ? [['格式', record.format]] : []),
    ...(isTelemetry && record.telemetrySummary?.sampleCount != null
      ? [['样本数', record.telemetrySummary.sampleCount]]
      : []),
    ...(isTelemetry && record.telemetrySummary?.durationSeconds != null
      ? [['时长', formatTelemetrySeconds(record.telemetrySummary.durationSeconds)]]
      : []),
    ...(!isRun && !isArtifact && record.deviceId ? [['目标设备', record.deviceId]] : []),
  ];
  setText(
    'run-detail-title',
    isRun ? '运行详情' : isArtifact ? '制品详情' : isTelemetry ? '遥测证据详情' : '发布计划详情',
  );
  body.innerHTML =
    '<div class="run-detail-grid">' +
    fields
      .map(
        ([label, value]) =>
          '<div class="run-detail-field"><span>' +
          escapeHtml(label) +
          '</span><strong>' +
          escapeHtml(value) +
          '</strong></div>',
      )
      .join('') +
    '</div><div class="run-detail-summary">' +
    escapeHtml(record.summary || '没有附加说明。') +
    '</div>' +
    (isRun && record.metrics && !syntheticRun
      ? renderRunMetricCards(record) + renderRunMetricsRaw(record)
      : '') +
    (isRun && record.checkpoint
      ? '<div><strong class="run-detail-block-title">Checkpoint</strong><pre class="run-detail-code">' +
        escapeHtml(JSON.stringify(record.checkpoint, null, 2)) +
        '</pre></div>'
      : '') +
    (isArtifact
      ? '<div><strong class="run-detail-block-title">制品元数据</strong><pre class="run-detail-code">' +
        escapeHtml(
          JSON.stringify(
            {
              ref: record.ref,
              sha256: record.sha256,
              sizeBytes: record.sizeBytes,
              workload: record.workload,
              threads: record.threads,
            },
            null,
            2,
          ),
        ) +
        '</pre></div>'
      : '') +
    (isTelemetry
      ? '<div><strong class="run-detail-block-title">遥测摘要</strong><pre class="run-detail-code">' +
        escapeHtml(JSON.stringify(record.telemetrySummary || {}, null, 2)) +
        '</pre></div>'
      : '') +
    (mockRun
      ? '<div class="run-progress-warning">Mock 仅验证协议与台账，不能部署到真实设备。</div>'
      : syntheticRun || demoTelemetry
        ? '<div class="run-progress-warning">合成样例仅验证导入与回放流程，不能作为真实 X5 评测或发布依据。</div>'
      : '');
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function metricPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const percent = value >= 0 && value <= 1 ? value * 100 : value;
  return percent >= 0 && percent <= 100 ? Math.round(percent) : null;
}

function finiteNumber(value) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function booleanValue(value) {
  if (value === true || value === false) return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return ['1', 'true', 'yes', 'y'].includes(value.toLowerCase());
  return false;
}

// Keep browser import capacity aligned with SIM2REAL_CONTRACT_LIMITS on the
// server. RDK Duck manifests may legitimately declare vectors larger than
// MicroDuck's 61/14 contract; truncating them here would make valid telemetry
// impossible to publish.
const MAX_TELEMETRY_VECTOR_VALUES = 4096;

function normalizeTelemetrySample(value) {
  if (!value || typeof value !== 'object') return null;
  const raw = value;
  const timestamp = finiteNumber(raw.t ?? raw.time ?? raw.timestamp);
  if (timestamp === null) return null;
  return {
    t: timestamp,
    ...(Array.isArray(raw.observation)
      ? { observation: raw.observation.slice(0, MAX_TELEMETRY_VECTOR_VALUES) }
      : {}),
    ...(Array.isArray(raw.action)
      ? { action: raw.action.slice(0, MAX_TELEMETRY_VECTOR_VALUES) }
      : {}),
    ...(finiteNumber(raw.reward) !== null ? { reward: finiteNumber(raw.reward) } : {}),
    ...(raw.done != null ? { done: booleanValue(raw.done) } : {}),
    ...(raw.fall != null ? { fall: booleanValue(raw.fall) } : {}),
  };
}

const MAX_TELEMETRY_IMPORT_SAMPLES = 100_000;

function parseTelemetryText(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) throw new Error('遥测文件为空');
  const values = [];
  let skipped = 0;
  let header = null;
  const appendValues = (items) => {
    if (values.length + items.length > MAX_TELEMETRY_IMPORT_SAMPLES) {
      throw new Error(`遥测文件超过 ${MAX_TELEMETRY_IMPORT_SAMPLES} 帧上限，请先分段导入`);
    }
    values.push(...items);
  };
  for (const line of lines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    if (Array.isArray(parsed)) {
      appendValues(parsed);
      continue;
    }
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.samples)) {
      appendValues(parsed.samples);
      header = parsed;
      continue;
    }
    if (parsed?.type === 'header') {
      header = parsed;
      continue;
    }
    appendValues([parsed]);
  }
  const samples = values.map(normalizeTelemetrySample).filter(Boolean);
  if (!samples.length) throw new Error('没有找到带 t/time 时间戳的有效遥测样本');
  const firstTimestamp = samples[0].t;
  const lastTimestamp = samples[samples.length - 1].t;
  const durationSeconds = Math.max(0, lastTimestamp - firstTimestamp);
  const rewardValues = samples.map((sample) => sample.reward).filter((value) => value != null);
  return {
    fileName: '',
    source: header?.source || 'import',
    contractId: header?.contractId || '',
    samples,
    skipped,
    summary: {
      sampleCount: samples.length,
      durationSeconds,
      sampleRateHz:
        durationSeconds > 0 ? Math.round(((samples.length - 1) / durationSeconds) * 10) / 10 : null,
      firstTimestamp,
      lastTimestamp,
      rewardMean: rewardValues.length
        ? Math.round(
            (rewardValues.reduce((sum, value) => sum + value, 0) / rewardValues.length) * 1000,
          ) / 1000
        : null,
      doneCount: samples.filter((sample) => sample.done).length,
      fallCount: samples.filter((sample) => sample.fall).length,
    },
  };
}

function currentModelIds() {
  const selected = selectedModel();
  if (selected?.id) return new Set([selected.id]);
  return new Set(
    (state.overview?.models || [])
      .filter((model) => model.manifest?.robot?.id === state.productId)
      .map((model) => model.id),
  );
}

function runsForCurrentModel() {
  const ids = currentModelIds();
  return (state.overview?.runs || []).filter((run) => ids.has(run.modelId));
}

function deploymentsForCurrentModel() {
  const ids = currentModelIds();
  return (state.overview?.deployments || []).filter((deployment) => ids.has(deployment.modelId));
}

function currentTelemetry() {
  const evidence = state.telemetry;
  if (!evidence) return null;
  return evidence.modelId && !currentModelIds().has(evidence.modelId) ? null : evidence;
}

function latestRun() {
  return [...runsForCurrentModel()].sort((a, b) =>
    String(b.createdAt || '').localeCompare(String(a.createdAt || '')),
  )[0] || null;
}

function isSyntheticEvidence(evidence, run) {
  return (
    evidence?.source === 'demo-fixture' ||
    run?.evaluation?.replay?.source === 'demo-fixture'
  );
}

function hasPersistedEvaluation(run) {
  return Boolean(
    run?.evaluation?.replay &&
      Number(run.evaluation.replay.sampleCount) > 0,
  );
}

// A raw browser import is useful for the local review step, but it is not a
// release-grade evaluation. Keep this broader predicate for review/navigation
// so ordinary replay remains visible after refresh; release decisions use the
// stricter helper below. Mock and demo-fixture evidence remain gated.
function hasRealEvaluation(evidence, run) {
  if (run?.mock === true || isSyntheticEvidence(evidence, run)) return false;
  return Boolean(
    hasPersistedEvaluation(run) ||
      (run?.metrics && typeof run.metrics.successRate === 'number') ||
      (evidence?.publishedRunId === run?.id && evidence?.summary?.sampleCount > 0),
  );
}

// A release may advance only on metrics returned by a real worker or on an
// explicitly attested replay. `source: "board-agent"` is an uploader's claim,
// so it remains useful for review/replay but cannot prove that an X5 produced
// the samples. The optional attested flag is intentionally read-only here;
// trusted adapters may add it without changing the existing API shape.
function hasReleaseGradeEvidence(evidence, run) {
  if (run?.mock === true || isSyntheticEvidence(evidence, run)) return false;
  const metrics = run?.metrics;
  const workerMetrics = Boolean(
    run &&
      ['local', 'robogo'].includes(String(run.backend || '').toLowerCase()) &&
      metrics?.contractValid === true &&
      typeof metrics.successRate === 'number',
  );
  const replay = run?.evaluation?.replay;
  const attestedReplay = Boolean(
    replay?.attested === true && Number(replay.sampleCount) > 0,
  );
  return workerMetrics || attestedReplay;
}

// --- Telemetry visuals ------------------------------------------------------
// Reward timeline + observation/action heatmaps, drawn on fixed-resolution
// canvases that CSS scales to the panel width. Zero dependencies, fully
// synchronous, and driven only by locally imported raw samples — a persisted
// replay summary alone never fabricates a curve.

const TELEMETRY_REWARD_CANVAS_W = 720;
const TELEMETRY_REWARD_CANVAS_H = 200;
const TELEMETRY_HEATMAP_CANVAS_W = 720;
const TELEMETRY_HEATMAP_CANVAS_H = 240;
const HEATMAP_MAX_COLUMNS = 360;
const HEATMAP_MAX_ROWS = 48;

const CANVAS_TEXT_STYLE = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
const CANVAS_TEXT_COLOR = 'rgba(85, 86, 79, 0.95)';

function clearCanvas(canvas, width, height) {
  if (!canvas || typeof canvas.getContext !== 'function') return null;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.clearRect(0, 0, width, height);
  return ctx;
}

function drawCanvasPlaceholder(ctx, width, height, message) {
  ctx.fillStyle = CANVAS_TEXT_COLOR;
  ctx.font = CANVAS_TEXT_STYLE;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(message, width / 2, height / 2);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

// Diverging scale for the heatmaps: blue (negative) → canvas-light (zero) →
// red (positive), so sign and magnitude stay readable on the light theme.
function telemetryDivergingColor(value) {
  const stops = [
    [-1, 37, 99, 235],
    [-0.25, 189, 214, 252],
    [0, 251, 251, 249],
    [0.25, 252, 216, 200],
    [1, 220, 38, 38],
  ];
  const v = Math.max(-1, Math.min(1, value));
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) {
      const [p0, r0, g0, b0] = stops[i - 1];
      const [p1, r1, g1, b1] = stops[i];
      const f = (v - p0) / (p1 - p0 || 1);
      return (
        'rgb(' +
        Math.round(r0 + (r1 - r0) * f) +
        ', ' +
        Math.round(g0 + (g1 - g0) * f) +
        ', ' +
        Math.round(b0 + (b1 - b0) * f) +
        ')'
      );
    }
  }
  return 'rgb(255, 144, 152)';
}

function drawTelemetryRewardTimeline(samples) {
  const ctx = clearCanvas(
    $('telemetry-reward-canvas'),
    TELEMETRY_REWARD_CANVAS_W,
    TELEMETRY_REWARD_CANVAS_H,
  );
  if (!ctx) return;
  const width = TELEMETRY_REWARD_CANVAS_W;
  const height = TELEMETRY_REWARD_CANVAS_H;
  const plotLeft = 38;
  const plotRight = width - 10;
  const plotTop = 12;
  const plotBottom = height - 20;
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - plotTop;
  const tFirst = samples[0].t;
  const tLast = samples[samples.length - 1].t;
  const tSpan = tLast - tFirst || 1;
  const rewarded = samples.filter((sample) => typeof sample.reward === 'number');
  if (!rewarded.length) {
    drawCanvasPlaceholder(ctx, width, height, '该遥测不含 reward 字段，无法绘制奖励曲线');
    setText('telemetry-reward-note', '当前样本没有 reward 数值，仅能绘制观测 / 动作热力图。');
    return;
  }
  setText(
    'telemetry-reward-note',
    '奖励为逐帧原始值；跌倒 / 完成标记取自样本 done / fall 字段。',
  );
  // Bucket-average down to at most one point per pixel column.
  const maxPoints = Math.max(2, Math.floor(plotWidth / 2));
  const points = [];
  if (rewarded.length <= maxPoints) {
    for (const sample of rewarded) points.push([sample.t, sample.reward]);
  } else {
    for (let i = 0; i < maxPoints; i++) {
      const start = Math.floor((i * rewarded.length) / maxPoints);
      const end = Math.max(start + 1, Math.floor(((i + 1) * rewarded.length) / maxPoints));
      let sum = 0;
      let tSum = 0;
      let count = 0;
      for (let j = start; j < end && j < rewarded.length; j++) {
        sum += rewarded[j].reward;
        tSum += rewarded[j].t;
        count += 1;
      }
      if (count) points.push([tSum / count, sum / count]);
    }
  }
  let rewardMin = Math.min(0, ...points.map(([, reward]) => reward));
  let rewardMax = Math.max(0, ...points.map(([, reward]) => reward));
  if (rewardMin === rewardMax) {
    rewardMax = rewardMin + 1;
  } else {
    const padding = (rewardMax - rewardMin) * 0.08;
    rewardMin -= padding;
    rewardMax += padding;
  }
  const xOf = (t) => plotLeft + ((t - tFirst) / tSpan) * plotWidth;
  const yOf = (reward) =>
    plotBottom - ((reward - rewardMin) / (rewardMax - rewardMin)) * plotHeight;
  ctx.strokeStyle = 'rgba(28, 28, 26, 0.12)';
  ctx.lineWidth = 1;
  ctx.font = CANVAS_TEXT_STYLE;
  ctx.fillStyle = CANVAS_TEXT_COLOR;
  for (const reward of [rewardMin, 0, rewardMax]) {
    if (reward <= rewardMin || reward >= rewardMax) continue;
    const y = Math.round(yOf(reward)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(plotLeft, y);
    ctx.lineTo(plotRight, y);
    ctx.stroke();
    ctx.fillText(reward.toFixed(2), 4, y + 3);
  }
  ctx.fillText(rewardMin.toFixed(2), 4, plotBottom + 3);
  ctx.fillText(rewardMax.toFixed(2), 4, plotTop + 3);
  // done / fall event markers along the bottom edge.
  for (const sample of samples) {
    const x = xOf(sample.t);
    if (sample.fall) {
      ctx.fillStyle = 'rgba(220, 38, 38, 0.85)';
      ctx.fillRect(x - 1, plotBottom - 7, 2, 7);
    } else if (sample.done) {
      ctx.fillStyle = 'rgba(70, 160, 98, 0.35)';
      ctx.fillRect(x - 1, plotTop, 1, plotHeight);
    }
  }
  ctx.beginPath();
  points.forEach(([t, reward], index) => {
    const x = xOf(t);
    const y = yOf(reward);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  const gradient = ctx.createLinearGradient(0, plotTop, 0, plotBottom);
  gradient.addColorStop(0, 'rgba(240, 90, 26, 0.16)');
  gradient.addColorStop(1, 'rgba(240, 90, 26, 0)');
  ctx.lineTo(xOf(points[points.length - 1][0]), plotBottom);
  ctx.lineTo(xOf(points[0][0]), plotBottom);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.beginPath();
  points.forEach(([t, reward], index) => {
    const x = xOf(t);
    const y = yOf(reward);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = 'rgba(240, 90, 26, 0.95)';
  ctx.lineWidth = 1.6;
  ctx.stroke();
  ctx.fillStyle = CANVAS_TEXT_COLOR;
  ctx.textAlign = 'center';
  ctx.fillText(formatTelemetrySeconds(tFirst), plotLeft + 16, height - 6);
  ctx.fillText(formatTelemetrySeconds(tLast), plotRight - 16, height - 6);
  ctx.textAlign = 'left';
}

function drawTelemetryHeatmap(samples, key, canvasId, captionId) {
  const ctx = clearCanvas(
    $(canvasId),
    TELEMETRY_HEATMAP_CANVAS_W,
    TELEMETRY_HEATMAP_CANVAS_H,
  );
  if (!ctx) return null;
  const width = TELEMETRY_HEATMAP_CANVAS_W;
  const height = TELEMETRY_HEATMAP_CANVAS_H;
  const vectors = samples.map((sample) => (Array.isArray(sample[key]) ? sample[key] : null));
  const withVectors = vectors.filter(Boolean);
  if (!withVectors.length) {
    drawCanvasPlaceholder(ctx, width, height, '该遥测不含 ' + key + ' 字段');
    setText(captionId, '—');
    return null;
  }
  const fullDims = withVectors.reduce((max, v) => Math.max(max, v.length), 0);
  const dims = Math.min(fullDims, HEATMAP_MAX_ROWS);
  const columns = Math.min(samples.length, HEATMAP_MAX_COLUMNS);
  const plotLeft = 30;
  const plotTop = 8;
  const plotRight = width - 8;
  const plotBottom = height - 16;
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - plotTop;
  const cellWidth = plotWidth / columns;
  const cellHeight = plotHeight / dims;
  let absMax = 0;
  for (let col = 0; col < columns; col++) {
    const vector = vectors[Math.min(samples.length - 1, Math.floor((col * samples.length) / columns))];
    if (!vector) continue;
    for (let dim = 0; dim < dims; dim++) {
      const value = Number(vector[dim]);
      if (Number.isFinite(value)) absMax = Math.max(absMax, Math.abs(value));
    }
  }
  if (absMax === 0) absMax = 1;
  for (let col = 0; col < columns; col++) {
    const vector = vectors[Math.min(samples.length - 1, Math.floor((col * samples.length) / columns))];
    if (!vector) continue;
    for (let dim = 0; dim < dims; dim++) {
      const value = Number(vector[dim]);
      if (!Number.isFinite(value)) continue;
      ctx.fillStyle = telemetryDivergingColor(value / absMax);
      ctx.fillRect(
        plotLeft + col * cellWidth,
        plotTop + dim * cellHeight,
        Math.max(1, cellWidth),
        Math.max(1, cellHeight),
      );
    }
  }
  ctx.font = CANVAS_TEXT_STYLE;
  ctx.fillStyle = CANVAS_TEXT_COLOR;
  const labelStep = dims > 16 ? 6 : 3;
  for (let dim = 0; dim < dims; dim += labelStep) {
    ctx.fillText(String(dim), 6, plotTop + dim * cellHeight + cellHeight);
  }
  const tFirst = samples[0].t;
  const tLast = samples[samples.length - 1].t;
  ctx.textAlign = 'center';
  ctx.fillText(formatTelemetrySeconds(tFirst), plotLeft + 18, height - 4);
  ctx.fillText(formatTelemetrySeconds(tLast), plotRight - 18, height - 4);
  ctx.textAlign = 'left';
  const dimsLabel = (fullDims > HEATMAP_MAX_ROWS ? '前 ' + HEATMAP_MAX_ROWS + ' 维' : fullDims + ' 维') + ' × ' + samples.length + ' 帧';
  setText(captionId, dimsLabel);
  return { absMax, truncated: fullDims > HEATMAP_MAX_ROWS };
}

function renderTelemetryVisuals() {
  const visuals = $('telemetry-visuals');
  if (!visuals) return;
  const evidence = currentTelemetry();
  const samples = Array.isArray(evidence?.samples) ? evidence.samples : null;
  if (!samples || !samples.length) {
    // No locally imported raw samples → no charts. A persisted replay summary
    // is aggregate-only and must never be redrawn into a fake curve.
    visuals.hidden = true;
    return;
  }
  visuals.hidden = false;
  drawTelemetryRewardTimeline(samples);
  const obsInfo = drawTelemetryHeatmap(
    samples,
    'observation',
    'telemetry-obs-heatmap',
    'telemetry-obs-caption',
  );
  const actionInfo = drawTelemetryHeatmap(
    samples,
    'action',
    'telemetry-action-heatmap',
    'telemetry-action-caption',
  );
  const ranges = [];
  if (obsInfo) ranges.push('观测 ±' + obsInfo.absMax.toFixed(2));
  if (actionInfo) ranges.push('动作 ±' + actionInfo.absMax.toFixed(2));
  setText('telemetry-heatmap-range', ranges.length ? ranges.join(' · ') : '—');
}

function renderTelemetryEvidence() {
  const root = $('telemetry-summary');
  const stateBadge = $('telemetry-state');
  const timeline = $('telemetry-timeline');
  const clear = $('telemetry-clear-button');
  const publish = $('telemetry-publish-button');
  const demoButton = $('telemetry-demo-button');
  if (demoButton) demoButton.hidden = state.productId !== 'microduck';
  if (!root || !stateBadge || !timeline || !clear) return;
  const evidence = currentTelemetry();
  const latest = latestRun();
  // Raw chunks intentionally stay in the server ledger and are not restored
  // into browser memory on a refresh. Keep a persisted replay summary visible
  // so the evidence card, CTA, and release gate tell the same story without
  // implying that the original JSONL is still locally available.
  const persistedEvaluation =
    latest?.evaluation?.replay && Number(latest.evaluation.replay.sampleCount) > 0
      ? latest.evaluation
      : null;
  const renderStats = (summary, evaluation) => {
    const stats = [
      ['样本数', summary.sampleCount],
      ['时长', formatTelemetrySeconds(summary.durationSeconds)],
      ['采样率', formatTelemetryRate(summary.sampleRateHz)],
      ['完成事件', summary.doneCount],
      ['跌倒事件', summary.fallCount],
      ['平均奖励', summary.rewardMean == null ? '—' : summary.rewardMean],
      ...(evaluation?.actionMae != null ? [['动作 MAE', evaluation.actionMae.toFixed(4)]] : []),
      ...(evaluation?.observationMae != null
        ? [['观测 MAE', evaluation.observationMae.toFixed(4)]]
        : []),
      ...(evaluation?.replay?.droppedCount > 0
        ? [['丢弃样本', evaluation.replay.droppedCount]]
        : []),
    ];
    root.innerHTML = stats
      .map(
        ([label, value]) =>
          '<div class="telemetry-stat"><span>' +
          escapeHtml(label) +
          '</span><strong class="' +
          (label === '跌倒事件' && Number(value) > 0 ? 'is-warn' : '') +
          '">' +
          escapeHtml(value) +
          '</strong></div>',
      )
      .join('');
  };
  const renderTimeline = (summary) => {
    timeline.hidden = false;
    setText('telemetry-timeline-start', formatTelemetrySeconds(summary.firstTimestamp));
    setText('telemetry-timeline-end', formatTelemetrySeconds(summary.lastTimestamp));
  };
  if (!evidence && persistedEvaluation) {
    const replay = persistedEvaluation.replay;
    const demoEvidence = replay.source === 'demo-fixture';
    const attestedReplay = replay.attested === true;
    stateBadge.className =
      'state-badge ' + (demoEvidence ? 'state-demo' : attestedReplay ? 'state-success' : 'state-partial');
    stateBadge.textContent = demoEvidence
      ? '演示样例 · 已评测'
      : attestedReplay
        ? '已评测 · 摘要已保存 · 来源已验证'
        : '已评测 · 摘要已保存 · 来源未验证';
    renderStats(replay, persistedEvaluation);
    renderTimeline(replay);
    renderTelemetryVisuals();
    clear.disabled = true;
    clear.title = '当前只恢复服务端评测摘要，没有本地原始证据可清除';
    if (publish) {
      publish.disabled = true;
      publish.textContent = '已绑定当前 Run · 导入原始 JSONL 后可重评';
      publish.title = '刷新后仅恢复评测摘要；如需重新评测，请重新导入原始 JSONL';
    }
    setText(
      'telemetry-source-note',
      demoEvidence
        ? '已恢复演示 Run 的评测摘要；原始 JSONL 未载入，不代表真实 X5 遥测。'
        : attestedReplay
          ? '已恢复受信评测摘要；原始 JSONL 未载入。导入文件可重新检查时序。'
          : '已恢复当前 Run 的评测摘要；原始 JSONL 未载入，上传方 source 未验证，不能证明真实 X5 遥测。',
    );
    return;
  }
  if (!evidence) {
    stateBadge.className = 'state-badge state-neutral';
    stateBadge.textContent = '尚未导入';
    root.innerHTML =
      '<div class="empty-inline">等待导入遥测；训练完成后可用它做仿真 / 真机对照。</div>';
    timeline.hidden = true;
    renderTelemetryVisuals();
    clear.disabled = true;
    if (publish) {
      publish.disabled = true;
      publish.textContent = '上传到当前 Run 并评测';
      publish.title = '先导入遥测证据';
    }
    clear.title = '当前没有本地遥测证据';
    setText('telemetry-source-note', '只显示聚合统计，不替代正式评测报告。');
    return;
  }
  const summary = evidence.summary;
  const evaluation =
    latest?.evaluation && evidence.publishedRunId === latest.id ? latest.evaluation : null;
  const demoEvidence = isSyntheticEvidence(evidence, latest);
  const releaseGradeEvidence = hasReleaseGradeEvidence(evidence, latest);
  const unverifiedEvidence = !demoEvidence && !releaseGradeEvidence;
  stateBadge.className =
    'state-badge ' +
    (demoEvidence
      ? 'state-demo'
      : unverifiedEvidence || evidence.skipped
        ? 'state-partial'
        : 'state-success');
  stateBadge.textContent = evaluation
    ? demoEvidence
      ? '演示样例 · 已评测'
      : unverifiedEvidence
        ? '已上传 · 来源未验证'
      : '已上传 · 已评测'
    : demoEvidence
      ? '演示样例'
      : unverifiedEvidence
        ? '已导入 · 来源未验证'
      : evidence.skipped
        ? '已导入 · 有跳过'
        : '已导入';
  setText(
    'telemetry-source-note',
    demoEvidence
      ? '这是合成演示证据，仅用于验证上传与评测流程，不代表真实 X5 遥测。'
      : unverifiedEvidence
        ? 'source 由上传方声明，当前来源未验证；证据可回放和复核，但不能证明真实 X5 遥测或推进发布。'
      : '只显示聚合统计，不替代正式评测报告。',
  );
  renderStats(summary, evaluation);
  renderTimeline(summary);
  renderTelemetryVisuals();
  clear.disabled = false;
  clear.title = '清除当前页面的本地遥测证据';
  if (publish) {
    publish.disabled = state.publishingTelemetry || !latestRun();
    publish.textContent = state.publishingTelemetry
      ? '上传中…'
      : demoEvidence
        ? '上传演示样例并评测（不解锁发布）'
        : '上传到当前 Run 并评测';
    publish.title = demoEvidence
      ? '演示样例可以写入回放，但始终不会解锁真实评测或发布'
      : unverifiedEvidence
        ? '将当前遥测分块写入最新 Run，并生成可回放摘要；来源仍需受信适配器验证'
        : '将当前遥测分块写入最新 Run，并生成回放评测摘要';
  }
}

async function importTelemetryFile(event) {
  const input = event.target;
  const file = input?.files?.[0];
  if (!file) return;
  try {
    const evidence = parseTelemetryText(await file.text());
    evidence.fileName = file.name;
    state.telemetry = evidence;
    renderAll();
    const skippedHint = evidence.skipped ? `，跳过 ${evidence.skipped} 条无效行` : '';
    showToast(
      '已导入 ' + evidence.summary.sampleCount + ' 帧遥测' + skippedHint + '，可用于本地回放检查',
      'success',
    );
  } catch (error) {
    showToast(error instanceof Error ? error.message : '遥测文件无法解析', 'error');
  } finally {
    input.value = '';
  }
}

async function loadDemoTelemetry() {
  if (state.productId !== 'microduck') {
    showToast('合成演示证据对应 MicroDuck，请先切换产品线', 'error');
    return;
  }
  try {
    const response = await fetch('./demo/microduck-telemetry-sample.jsonl', {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!response.ok) throw new Error('演示证据文件不可用（HTTP ' + response.status + '）');
    const evidence = parseTelemetryText(await response.text());
    evidence.fileName = 'microduck-telemetry-sample.jsonl';
    evidence.source = 'demo-fixture';
    state.telemetry = evidence;
    renderAll();
    showToast('已载入合成演示证据；它不会代表真实 X5 遥测', 'normal');
  } catch (error) {
    showToast(error instanceof Error ? error.message : '演示证据加载失败', 'error');
  }
}

async function publishTelemetry() {
  const evidence = currentTelemetry();
  if (!evidence) {
    showToast('请先导入一段遥测 JSONL', 'error');
    return;
  }
  const run = latestRun();
  if (!run) {
    showToast('请先发起一次训练或仿真运行，再绑定遥测', 'error');
    return;
  }
  const model = state.overview?.models?.find((item) => item.id === run.modelId);
  const contract = model?.manifest?.contract;
  if (!contract) {
    showToast('当前 Run 的模型契约不可用，无法安全绑定遥测', 'error');
    return;
  }
  if (evidence.contractId && evidence.contractId !== contract.id) {
    showToast('遥测契约与当前 Run 不一致，请切换产品或选择对应 Run', 'error');
    return;
  }
  for (const [index, sample] of (evidence.samples || []).entries()) {
    if (sample.observation && sample.observation.length !== contract.observationSize) {
      showToast(`第 ${index + 1} 帧 observation 维度不匹配（应为 ${contract.observationSize}）`, 'error');
      return;
    }
    if (sample.action && sample.action.length !== contract.actionSize) {
      showToast(`第 ${index + 1} 帧 action 维度不匹配（应为 ${contract.actionSize}）`, 'error');
      return;
    }
  }
  state.publishingTelemetry = true;
  renderTelemetryEvidence();
  try {
    const samples = evidence.samples || [];
    // Keep a generous margin below Express/nginx's 2 MiB limit. A legal
    // MicroDuck frame is large (61D observation + 14D action), so a fixed
    // 5,000-frame chunk would exceed the gateway before reaching the route.
    const maxChunkBytes = 900_000;
    const maxChunkSamples = 5_000;
    const requestId =
      evidence.uploadKey ||
      globalThis.crypto?.randomUUID?.() ||
      `telemetry-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    evidence.uploadKey = requestId;
    evidence.modelId = run.modelId;
    const acceptedSources = new Set(['board-agent', 'browser', 'import', 'demo-fixture']);
    const telemetrySource = acceptedSources.has(evidence.source) ? evidence.source : 'import';
    const basePayload = {
      // Preserve the source in the ledger so a refresh cannot turn synthetic
      // presentation data into apparently real evidence. The source is
      // provenance metadata, not a hardware attestation; release gates still
      // require a real worker/BoardAgent result.
      source: telemetrySource,
      modelId: run.modelId,
      contractId: evidence.contractId || contract.id,
    };
    const baseBytes = new TextEncoder().encode(JSON.stringify({ ...basePayload, sequence: 0, idempotencyKey: requestId + '-0', samples: [] })).length;
    const chunks = [];
    let chunk = [];
    let chunkBytes = baseBytes - 2;
    for (const sample of samples) {
      const sampleBytes = new TextEncoder().encode(JSON.stringify(sample)).length;
      const extra = sampleBytes + (chunk.length ? 1 : 0);
      if (
        chunk.length &&
        (chunk.length >= maxChunkSamples || chunkBytes + extra > maxChunkBytes)
      ) {
        chunks.push(chunk);
        chunk = [];
        chunkBytes = baseBytes - 2;
      }
      if (!chunk.length && chunkBytes + sampleBytes > maxChunkBytes) {
        throw new Error('单帧遥测过大，无法放入安全请求分片');
      }
      chunk.push(sample);
      chunkBytes += sampleBytes + (chunk.length > 1 ? 1 : 0);
    }
    if (chunk.length) chunks.push(chunk);
    for (const [sequence, chunk] of chunks.entries()) {
      await request('/sim2real/runs/' + encodeURIComponent(run.id) + '/telemetry', {
        method: 'POST',
        body: JSON.stringify({
          ...basePayload,
          sequence,
          idempotencyKey: requestId + '-' + sequence,
          samples: chunk,
        }),
      });
    }
    const evaluated = await request('/sim2real/runs/' + encodeURIComponent(run.id) + '/evaluate', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    evidence.publishedRunId = run.id;
    await loadOverview({ quiet: true });
    const evaluation = evaluated?.evaluation;
    const detail = evidence.source === 'demo-fixture'
      ? evaluation?.replay?.sampleCount
        ? `已上传 ${evaluation.replay.sampleCount} 帧演示样例并完成协议评测；不代表真实指标`
        : '已上传演示样例并完成协议评测；不代表真实指标'
      : evaluation?.replay?.sampleCount
        ? `已上传 ${evaluation.replay.sampleCount} 帧并完成评测`
        : '已上传遥测并完成评测';
    showToast(detail, 'success');
  } catch (error) {
    showToast(error instanceof Error ? error.message : '遥测上传或评测失败', 'error');
  } finally {
    state.publishingTelemetry = false;
    renderAll();
  }
}

function clearTelemetry() {
  state.telemetry = null;
  renderAll();
  showToast('已清除本地遥测证据');
}

function renderEvaluation() {
  renderTelemetryEvidence();
  const evidence = currentTelemetry();
  const runs = [...runsForCurrentModel()].sort((a, b) =>
    String(b.createdAt || '').localeCompare(String(a.createdAt || '')),
  );
  const latest = runs[0] || null;
  const metrics = latest?.metrics || {};
  const status = String(latest?.status || '').toLowerCase();
  const mockRun = latest?.mock === true;
  const demoEvidence = isSyntheticEvidence(evidence, latest);
  const evaluationExists = hasRealEvaluation(evidence, latest);
  const releaseGradeEvidence = hasReleaseGradeEvidence(evidence, latest);
  const unverifiedEvidence = evaluationExists && !releaseGradeEvidence;
  let statusLabel = '尚未产生评测结果';
  if (mockRun && ['completed', 'ready'].includes(status)) statusLabel = '协议演示完成';
  else if (demoEvidence && status === 'completed') statusLabel = '演示评测完成';
  else if (unverifiedEvidence) statusLabel = '评测已保存 · 来源未验证';
  else if (status === 'completed') statusLabel = '评测已完成';
  else if (status === 'running') statusLabel = '评测进行中';
  else if (status === 'failed') statusLabel = '评测失败';
  else if (latest) statusLabel = '等待评测结果';
  else if (evidence) statusLabel = demoEvidence ? '已载入合成演示证据' : '已载入遥测证据';
  setText('eval-run-status', statusLabel);
  setText(
    'eval-run-name',
    latest
      ? (latest.summary || latest.modelId || '最新运行') + ' · ' + (latest.backend || 'unknown')
      : evidence
        ? evidence.fileName + ' · 本地聚合，可继续绑定到正式 Run'
        : '训练完成后，这里会显示最新一次运行的仿真/真机指标。',
  );
  const quality = $('eval-run-quality');
  if (quality) {
    const showQuality = mockRun || demoEvidence || unverifiedEvidence;
    quality.hidden = !showQuality;
    quality.className =
      'state-badge ' + (unverifiedEvidence && !mockRun && !demoEvidence ? 'state-partial' : 'state-demo') + ' evaluation-quality';
    quality.textContent = mockRun
      ? 'Mock 协议演示 · 非真实 RL'
      : demoEvidence
        ? '合成证据 · 非真实遥测'
        : '来源未验证 · 不能证明 X5';
    quality.title = mockRun
      ? '该运行只验证训练协议和台账，不生成可部署模型或真实 RL 指标。'
      : demoEvidence
        ? '该遥测由页面内置合成样例生成，不代表真实 X5。'
        : '该回放的 source 由上传方声明，尚未经过受信适配器验证，不能作为 X5 真实性证明。';
  }
  setText(
    'eval-metrics-note',
    mockRun
      ? 'Mock 只回写契约状态；性能指标留空，避免把协议回执误读成真实 PPO 或 X5 实测结果。'
      : demoEvidence
      ? '以下遥测来自页面内置合成样例；即使完成协议评测，也不代表真实仿真成功率或 X5 实测结果。'
      : unverifiedEvidence
        ? '评测摘要可以查看和回放，但 source 由上传方声明、当前未验证；需要真实 worker 指标或显式 attested replay 才能推进发布。'
      : '真实成功率、跌倒率和延迟需要训练 worker 或 X5 Agent 回写指标；平台不会用默认值冒充评测结果。',
  );
  setText(
    'eval-contract',
    metrics.contractValid === true ? '通过' : metrics.contractValid === false ? '失败' : '—',
  );
  const performanceMetrics = demoEvidence || mockRun ? {} : metrics;
  const success = metricPercent(performanceMetrics.successRate);
  const fall = metricPercent(performanceMetrics.fallRate);
  setText('eval-success', success === null ? '—' : success + '%');
  setText('eval-fall', fall === null ? '—' : fall + '%');
  setText(
    'eval-latency',
    typeof performanceMetrics.controlLatencyMs === 'number'
      ? performanceMetrics.controlLatencyMs + 'ms'
      : '—',
  );

  // A local Mock run is a protocol receipt, not a simulator or X5 sample.
  // Keep it out of the two-column Sim → Real comparison so a fixed 72% cannot
  // be mistaken for a physical-device result.
  const simPercent =
    latest && !mockRun && !demoEvidence && latest.backend === 'browser' ? success : null;
  const realPercent =
    latest && releaseGradeEvidence && latest.backend !== 'browser' ? success : null;
  for (const [barId, labelId, value] of [
    ['eval-sim-bar', 'eval-sim-label', simPercent],
    ['eval-real-bar', 'eval-real-label', realPercent],
  ]) {
    const bar = $(barId);
    if (bar) bar.style.width = value === null ? '0%' : value + '%';
    setText(labelId, value === null ? '—' : value + '%');
  }
  const mark = $('eval-status-mark');
  if (mark) {
    mark.textContent = mockRun || demoEvidence
      ? '◇'
      : unverifiedEvidence
        ? '?'
      : status === 'completed'
        ? '✓'
        : status === 'failed'
          ? '!'
          : evidence
            ? '↗'
            : '○';
    mark.className =
      'evaluation-status-mark ' +
      ((mockRun || demoEvidence)
        ? 'is-demo'
        : unverifiedEvidence
          ? 'is-partial'
        : status === 'completed' || evidence
          ? 'is-success'
          : status === 'failed'
            ? 'is-error'
            : '');
  }
}

// ---- 真机实时对照（评估页，OriginBot 只读遥测 2s 快照） -------------------
// 与效果对比图并排显示当下真机侧写：电压、IMU 航向、里程计。数据缺失时
// 如实显示「无数据」，绝不合成。轮询只在 evaluate 视图内进行。

let originbotCompareTimer = null;

async function originbotCompareRefresh() {
  try {
    const payload = await request('/sim2real/board-station/status');
    const status = payload?.status || {};
    // The board agent exposes the adapter telemetry under both `originbot`
    // (legacy clients) and `telemetry` (generic clients). Prefer the generic
    // field so this panel keeps working for custom hardware profiles.
    const ob = status.telemetry || status.originbot;
    const panel = $('originbot-compare-panel');
    if (panel) panel.dataset.live = ob ? 'on' : 'off';
    const caption = panel?.querySelector('.panel-caption');
    if (caption) {
      const profileName = status.profile?.displayName || status.board?.model || status.adapterId;
      caption.textContent = profileName ? `${profileName} · 只读遥测` : '当前适配包 · 只读遥测';
    }
    if (ob && typeof ob === 'object') {
      const v = Number(ob.batteryVoltage ?? ob.battery?.voltage ?? status.power?.voltage);
      setText('ob-compare-voltage', Number.isFinite(v) ? v.toFixed(2) + ' V' : '—');
      const quat = stationImuQuaternion(ob);
      const z = quat?.z;
      const w = quat?.w;
      setText(
        'ob-compare-heading',
        Number.isFinite(z) && Number.isFinite(w)
          ? (2 * Math.atan2(z, w) * (180 / Math.PI)).toFixed(1) + '°'
          : '—',
      );
      const odom = ob.odom || {};
      const px = Number(odom.positionX);
      const lx = Number(odom.linearX);
      setText(
        'ob-compare-odom',
        Number.isFinite(px) || Number.isFinite(lx)
          ? `${Number.isFinite(px) ? px.toFixed(2) + ' m' : '—'} / ${Number.isFinite(lx) ? lx.toFixed(2) + ' m/s' : '—'}`
          : '—',
      );
      setText('ob-compare-source', '板端 agent · ros2 topic echo（只读）');
    } else {
      setText('ob-compare-voltage', '无数据');
      setText('ob-compare-heading', '无数据');
      setText('ob-compare-odom', '无数据');
      setText('ob-compare-source', 'bringup 未运行');
    }
  } catch {
    // 板端不可达时保持上一帧数值并把来源标灰，不弹错误横幅打断评测页。
    setText('ob-compare-source', '板端不可达');
  }
}

function originbotCompareStart() {
  if (originbotCompareTimer) return;
  void originbotCompareRefresh();
  originbotCompareTimer = setInterval(originbotCompareRefresh, 2000);
}

function originbotCompareStop() {
  if (originbotCompareTimer) {
    clearInterval(originbotCompareTimer);
    originbotCompareTimer = null;
  }
}

function renderNextAction() {
  const evidence = currentTelemetry();
  const model = selectedModel();
  const runs = [...runsForCurrentModel()].sort((a, b) =>
    String(b.createdAt || '').localeCompare(String(a.createdAt || '')),
  );
  const latest = runs[0] || null;
  const mockRun = latest?.mock === true;
  const demoEvidence = isSyntheticEvidence(evidence, latest);
  // Keep review/navigation separate from the release-grade predicate: a
  // replay can be inspected, but an uploader-declared source cannot unlock a
  // CTA that implies a deployable policy.
  const hasEvaluation = hasRealEvaluation(evidence, latest);
  const releaseGradeEvidence = hasReleaseGradeEvidence(evidence, latest);
  const deployments = deploymentsForCurrentModel();
  let view = 'simulate';
  let title = '先在仿真里验证「' + selectedTask().label + '」';
  let copy = selectedTask().hint + '。先录一段可回放轨迹，再决定使用本地服务器还是 RoboGo 训练。';
  let label = '进入仿真与录制 →';
  if (!model) {
    view = 'contract';
    title = '先登记一个模型契约';
    copy = '选择产品线并导入 manifest，平台会先检查观测、动作、运行时和制品引用。';
    label = '打开套件与契约 →';
  } else if (latest && ['queued', 'running'].includes(String(latest.status))) {
    view = 'train';
    title = '训练任务正在运行';
    copy = '先查看运行详情和 checkpoint；任务完成后再进入评测，不需要重复提交。';
    label = '查看训练任务 →';
  } else if (latest && ['completed', 'ready'].includes(String(latest.status)) && !hasEvaluation) {
    if (mockRun) {
      view = 'deploy';
      title = '协议演示完成，继续查看安全闸门';
      copy = 'Mock 已验证训练协议和台账，但没有可部署模型；打开预检页查看真实发布前仍会阻断的边界。';
      label = '查看安全闸门 →';
    } else if (demoEvidence) {
      view = 'deploy';
      title = '下一步：查看演示安全闸门';
      copy =
        '这是页面内置的合成证据，只用于演示导入、聚合和阻断流程；它不会让真实 X5 预检通过或解锁发布策略。';
      label = '查看演示安全闸门 →';
    } else {
      view = 'evaluate';
      title = '训练完成，先看评测证据';
      copy = '确认契约、成功率、跌倒率和控制延迟，再决定是否生成 X5 预检计划。';
      label = '进入评测中心 →';
    }
  } else if (demoEvidence) {
    view = 'deploy';
    title = '下一步：查看演示安全闸门';
    copy =
      '这是页面内置的合成证据，只用于演示导入、聚合和阻断流程；它不会让真实 X5 预检通过或解锁发布策略。';
    label = '查看演示安全闸门 →';
  } else if (evidence && !hasEvaluation) {
    view = 'evaluate';
    title = '遥测已导入，检查虚实差异';
    copy = '当前是浏览器本地聚合证据；先确认采样率和跌倒事件，再绑定到一次正式运行或继续训练。';
    label = '查看遥测证据 →';
  } else if (hasEvaluation && !releaseGradeEvidence && !deployments.length) {
    view = 'deploy';
    title = '评测已保存，来源仍未验证';
    copy = '回放和摘要可以继续查看，但 source 只是上传方声明；需要真实 worker 指标或受信 attested replay 才能推进发布。';
    label = '查看安全闸门 →';
  } else if (releaseGradeEvidence && !deployments.length) {
    view = 'deploy';
    title = '评测完成，可以生成预检计划';
    copy = '选择目标 X5，先完成只读板端预检；Canary 和 Live 仍由受控 Board Agent 接管。';
    label = '生成设备预检 →';
  } else if (latest && latest.status === 'failed') {
    view = 'train';
    title = '上一次任务失败，需要处理';
    copy = latest.summary || '查看失败原因，修复契约或训练后端后再重试。';
    label = '查看失败详情 →';
  } else if (latest && ['blocked', 'cancelled'].includes(String(latest.status))) {
    view = 'train';
    title = latest.status === 'cancelled' ? '训练任务已取消' : '训练尚未启动';
    copy = latest.summary || '检查训练后端和模型契约后，再重新提交任务。';
    label = '处理训练阻断 →';
  } else if (deployments.length) {
    view = 'records';
    title = '继续查看这次迭代的证据';
    copy = '运行、预检和发布计划都保存在记录中，可以打开详情或开始下一轮动作。';
    label = '打开记录与版本 →';
  }
  setText('next-action-title', title);
  const button = $('next-action-button');
  if (button) {
    button.dataset.viewTarget = view;
    button.textContent = label;
  }
}

function renderEvaluationNext() {
  const title = $('evaluation-next-title');
  const button = $('evaluation-next-button');
  const line = $('evaluation-next-line');
  if (!title || !button || !line) return;
  // Keep the CTA inert until the account-scoped overview has arrived.  The
  // initial paint runs before loadOverview(), so enabling this button here
  // would let a presenter click through a half-rendered workspace (and would
  // contradict the disabled loading state in the markup).
  if (!state.overview || state.authRequired || state.serviceError) {
    button.disabled = true;
    button.setAttribute('aria-disabled', 'true');
    button.textContent = '等待服务状态…';
    button.dataset.viewTarget = 'overview';
    delete button.dataset.action;
    title.textContent = state.authRequired ? '下一步：登录工作区' : '下一步：等待工作区加载';
    line.style.background = 'var(--orange)';
    return;
  }
  button.disabled = false;
  button.setAttribute('aria-disabled', 'false');
  const evidence = currentTelemetry();
  const latest = [...runsForCurrentModel()].sort((a, b) =>
    String(b.createdAt || '').localeCompare(String(a.createdAt || '')),
  )[0];
  const mockRun = latest?.mock === true;
  const demoEvidence = isSyntheticEvidence(evidence, latest);
  const hasEvaluation = hasRealEvaluation(evidence, latest);
  const releaseGradeEvidence = hasReleaseGradeEvidence(evidence, latest);
  if (!selectedModel()) {
    title.textContent = '下一步：先登记模型契约';
    button.textContent = '去登记契约 →';
    button.dataset.viewTarget = 'contract';
    delete button.dataset.action;
    line.style.background = 'var(--orange)';
    return;
  }
  if (latest && ['queued', 'running'].includes(String(latest.status))) {
    title.textContent = '下一步：等待训练完成';
    button.textContent = '查看训练任务 →';
    button.dataset.viewTarget = 'train';
    delete button.dataset.action;
    line.style.background = 'var(--cyan)';
    return;
  }
  if (latest?.status === 'failed') {
    title.textContent = '下一步：处理失败任务';
    button.textContent = '回到训练中心 →';
    button.dataset.viewTarget = 'train';
    delete button.dataset.action;
    line.style.background = 'var(--red)';
    return;
  }
  if (mockRun && ['completed', 'ready'].includes(String(latest.status))) {
    title.textContent = '下一步：查看安全闸门（Mock）';
    button.textContent = '查看安全闸门 →';
    button.dataset.viewTarget = 'deploy';
    delete button.dataset.action;
    line.style.background = 'var(--violet)';
    return;
  }
  if (demoEvidence) {
    title.textContent = '下一步：查看演示安全闸门';
    button.textContent = '查看演示安全闸门 →';
    button.dataset.viewTarget = 'deploy';
    delete button.dataset.action;
    line.style.background = 'var(--violet)';
    return;
  }
  if (releaseGradeEvidence) {
    title.textContent = '下一步：生成 X5 只读预检计划';
    button.textContent = '去做设备预检 →';
    button.dataset.viewTarget = 'deploy';
    delete button.dataset.action;
    line.style.background = 'var(--green)';
    return;
  }
  if (hasEvaluation || evidence) {
    title.textContent = '下一步：查看安全闸门（来源未验证）';
    button.textContent = '查看安全闸门 →';
    button.dataset.viewTarget = 'deploy';
    delete button.dataset.action;
    line.style.background = 'var(--orange)';
    return;
  }
  title.textContent = '下一步：导入一段遥测证据';
  button.textContent = '导入遥测文件 →';
  button.dataset.viewTarget = 'evaluate';
  button.dataset.action = 'import-telemetry';
  line.style.background = 'var(--orange)';
}

function renderReleaseGate() {
  const model = selectedModel();
  const latest = [...runsForCurrentModel()].sort((a, b) =>
    String(b.createdAt || '').localeCompare(String(a.createdAt || '')),
  )[0];
  const mockRun = latest?.mock === true;
  const evidence = currentTelemetry();
  const demoEvidence = isSyntheticEvidence(evidence, latest);
  const deployment =
    state.activeDeployment ||
    deploymentsForCurrentModel().find(
      (item) => item.modelId === model?.id && item.deviceId === state.selectedDeviceId,
    );
  const contractReady = Boolean(
    model &&
    (model.builtin ||
      state.validation?.valid ||
      state.compatibility?.some((item) => item.deployable)),
  );
  const evaluationExists = hasRealEvaluation(evidence, latest);
  const evidenceReady = hasReleaseGradeEvidence(evidence, latest);
  const preflightReady = Boolean(
    !mockRun &&
      !demoEvidence &&
      deployment &&
      ['ready', 'completed'].includes(deployment.status),
  );
  const releaseReady = preflightReady && evidenceReady;
  const update = (key, stateName, detail) => {
    const node = document.querySelector('[data-release-step="' + key + '"]');
    if (!node) return;
    node.classList.remove('is-ready', 'is-current', 'is-blocked', 'is-failed', 'is-locked');
    node.classList.add('is-' + stateName);
    const index = node.querySelector('.release-step-index');
    if (index)
      index.textContent =
        stateName === 'ready'
          ? '✓'
          : stateName === 'failed'
            ? '!'
            : key === 'contract'
              ? '01'
              : key === 'evaluation'
                ? '02'
                : key === 'canary'
                  ? '03'
                  : '04';
    const small = node.querySelector('small');
    if (small && detail) small.textContent = detail;
  };
  update(
    'contract',
    contractReady ? 'ready' : 'blocked',
    contractReady ? '观测、动作、频率一致' : '先选择并校验模型契约',
  );
  update(
    'evaluation',
    releaseReady
      ? 'ready'
      : mockRun
        ? 'blocked'
          : demoEvidence
            ? 'blocked'
            : evidenceReady
              ? 'current'
              : 'blocked',
    releaseReady
      ? '预检已通过'
      : mockRun
        ? 'Mock 不可部署；需要真实评测'
          : demoEvidence
            ? '合成证据仅用于演示；需要真实评测'
          : evidenceReady
            ? '选择板卡并生成只读计划'
            : evaluationExists
              ? '来源未验证；需要真实 worker 指标或受信 attested replay'
            : '需要评测指标或遥测证据',
  );
  update('canary', 'blocked', '需要 X5 Board Agent；网页不会直接开电机');
  update('live', 'locked', '人工批准后开放');
}

function renderWorkflowProgress() {
  // The workflow state used to be mirrored into a vertical pipeline on the
  // overview and a horizontal strip above every view. Both were removed in the
  // declutter pass; readiness now surfaces only through the next-action card,
  // the status grid, and each step view itself.
  return;
}

function renderRunProgress() {
  const card = $('run-progress-card');
  if (!card) return;
  const runs = [...runsForCurrentModel()].sort((a, b) =>
    String(b.createdAt || '').localeCompare(String(a.createdAt || '')),
  );
  const latest = runs[0];
  if (!latest) {
    card.hidden = true;
    state.selectedRecord = null;
    return;
  }
  card.hidden = false;
  state.selectedRecord = Object.assign({}, latest, { recordType: 'run' });
  setText('run-progress-title', latest.summary || latest.modelId || '最新运行');
  const status = $('run-progress-status');
  if (status) {
    status.className =
      'state-badge ' + (latest.mock === true ? 'state-demo' : stateClass(latest.status));
    status.textContent = latest.mock === true ? '协议演示' : statusLabel(latest.status);
  }
  const meta = $('run-progress-meta');
  if (meta) {
    const chips = [
      latest.taskId && ACTION_TASKS[latest.taskId]
        ? '动作 · ' + ACTION_TASKS[latest.taskId].label
        : '',
      latest.backend ? '后端 · ' + latest.backend : '',
      latest.training?.profile ? '档位 · ' + latest.training.profile : '',
      latest.training?.numEnvs ? '环境 · ' + latest.training.numEnvs : '',
      latest.checkpoint?.iteration != null ? 'checkpoint · ' + latest.checkpoint.iteration : '',
      latest.createdAt ? '创建 · ' + formatDate(latest.createdAt) : '',
    ].filter(Boolean);
    meta.innerHTML = chips.map((chip) => '<span>' + escapeHtml(chip) + '</span>').join('');
  }
  $('run-progress-warning')?.toggleAttribute('hidden', latest.mock !== true);
}

function recordCollection() {
  const runs = runsForCurrentModel().map((item) =>
    Object.assign({}, item, { kind: 'run · ' + item.backend, recordType: 'run' }),
  );
  const deployments = deploymentsForCurrentModel().map((item) =>
    Object.assign({}, item, { kind: 'deploy · ' + item.mode, recordType: 'deploy' }),
  );
  const artifacts = (state.overview?.models || [])
    .filter((model) => currentModelIds().has(model.id))
    .flatMap((model) =>
    (model.manifest?.artifacts || []).map((artifact) =>
      Object.assign({}, artifact, {
        id: model.id + ':' + artifact.id,
        modelId: model.id,
        kind: 'artifact · ' + (artifact.role || artifact.format || 'model'),
        recordType: 'artifact',
        status: 'registered',
        summary: artifact.name || artifact.id,
        createdAt: model.updatedAt || model.createdAt,
      }),
      ),
    );
  const evidence = currentTelemetry();
  const latest = latestRun();
  const persistedReplay = !evidence && hasPersistedEvaluation(latest)
    ? latest.evaluation.replay
    : null;
  const telemetry = evidence
    ? [
        {
          id: 'telemetry:' + evidence.fileName,
          recordType: 'telemetry',
          kind: evidence.source === 'demo-fixture' ? 'telemetry · demo fixture' : 'telemetry · import',
          status: evidence.source === 'demo-fixture' ? 'demo' : 'registered',
          summary: evidence.fileName || '本地遥测证据',
          source: evidence.source,
          createdAt: new Date().toISOString(),
          telemetrySummary: evidence.summary,
        },
      ]
    : persistedReplay
      ? [
          {
            id: 'telemetry:replay:' + latest.id,
            recordType: 'telemetry',
            kind: persistedReplay.source === 'demo-fixture'
              ? 'telemetry · demo fixture'
              : 'telemetry · saved replay',
            status: persistedReplay.source === 'demo-fixture' ? 'demo' : 'registered',
            summary:
              '已保存回放 · ' +
              persistedReplay.sampleCount +
              ' 帧 · ' +
              formatTelemetrySeconds(persistedReplay.durationSeconds),
            source: persistedReplay.source || 'import',
            createdAt: latest.createdAt,
            telemetrySummary: persistedReplay,
          },
        ]
      : [];
  return [...runs, ...deployments, ...artifacts, ...telemetry].sort((a, b) =>
    String(b.createdAt || '').localeCompare(String(a.createdAt || '')),
  );
}

function renderAll() {
  renderSelects();
  renderIntegrations();
  renderContextLive();
  renderModel();
  renderActionLibrary();
  renderBoard();
  renderEvaluation();
  renderHistory();
  renderRunProgress();
  renderNextAction();
  renderEvaluationNext();
  renderReleaseGate();
  renderWorkflowProgress();
  renderAgentPanel();
}

async function loadModelDetails(modelId = state.selectedModelId) {
  if (!modelId) return;
  try {
    const payload = await request('/sim2real/models/' + encodeURIComponent(modelId));
    state.model = payload.model || null;
    state.compatibility = payload.compatibility || [];
    if (state.model) {
      renderModel();
      renderActionLibrary();
      renderNextAction();
      renderEvaluationNext();
      renderReleaseGate();
    }
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401)) {
      showToast(error instanceof Error ? error.message : '模型详情加载失败', 'error');
    }
  }
}

async function refreshActiveRuns() {
  const overview = state.overview;
  if (!overview?.runs?.length) return;
  const active = runsForCurrentModel().filter((run) =>
    ['queued', 'running'].includes(String(run.status || '').toLowerCase()),
  );
  if (!active.length) return;
  const updates = await Promise.all(
    active.slice(0, 8).map(async (run) => {
      try {
        const payload = await request('/sim2real/runs/' + encodeURIComponent(run.id));
        runStatusFailures.delete(run.id);
        return payload.run || null;
      } catch (error) {
        // The API keeps the last known state and returns a retryable 503 when
        // the external runner is unavailable. Back off after repeated errors
        // so a dead runner cannot create a tight polling loop.
        if (!(error instanceof ApiError && error.status === 401)) {
          const failures = (runStatusFailures.get(run.id) || 0) + 1;
          runStatusFailures.set(run.id, failures);
          if (failures >= 3) {
            runStatusBackoffUntil = Math.max(runStatusBackoffUntil, Date.now() + 30_000);
            if (Date.now() - runStatusNoticeAt > 30_000) {
              runStatusNoticeAt = Date.now();
              showToast('训练 runner 暂时无法返回状态，已降低轮询频率；任务未被伪造为完成', 'error');
            }
          }
        }
        return null;
      }
    }),
  );
  const byId = new Map(updates.filter(Boolean).map((run) => [run.id, run]));
  if (!byId.size || !state.overview) return;
  const previousRuns = state.overview.runs;
  state.overview = {
    ...state.overview,
    runs: state.overview.runs.map((run) => byId.get(run.id) || run),
  };
  // Studio-style channel notification: fire exactly once per run when an
  // active task reaches a terminal state, even if this is a background tab.
  for (const previous of previousRuns) {
    const next = byId.get(previous.id);
    if (!next) continue;
    if (
      isActiveRunStatus(previous.status) &&
      isTerminalRunStatus(next.status) &&
      !state.notifiedRunIds.has(next.id)
    ) {
      state.notifiedRunIds.add(next.id);
      notifyRunTerminal(next);
    }
  }
}

async function loadOverview({ quiet = false } = {}) {
  if (state.loading) return;
  setLoading(true);
  try {
    const payload = await request(
      '/sim2real/overview?productId=' + encodeURIComponent(state.productId),
    );
    state.overview = payload;
    state.serviceError = false;
    state.productProfiles = Array.isArray(payload.productProfiles) ? payload.productProfiles : null;
    clearAuthGate();
    await refreshActiveRuns();
    renderAll();
    await loadModelDetails();
    setText('hero-updated', '更新于 ' + formatDate(new Date().toISOString()));
  } catch (error) {
    state.serviceError = !(error instanceof ApiError && error.status === 401);
    if (!(error instanceof ApiError && error.status === 401) && !quiet) {
      showToast(error instanceof Error ? error.message : '工作台加载失败', 'error');
    }
    setText(
      'service-status',
      error instanceof ApiError && error.status === 401 ? '需要登录' : '服务不可用',
    );
    syncServicePill();
    renderEvaluationNext();
  } finally {
    setLoading(false);
    scheduleOverviewPolling();
  }
}

function scheduleOverviewPolling() {
  if (overviewPollTimer !== null) window.clearTimeout(overviewPollTimer);
  const hasActiveRun = runsForCurrentModel().some((run) =>
    ['queued', 'running'].includes(String(run.status || '').toLowerCase()),
  );
  const backoffActive = runStatusBackoffUntil > Date.now();
  const activeDelay = backoffActive
    ? Math.max(30_000, runStatusBackoffUntil - Date.now())
    : 5_000;
  overviewPollTimer = window.setTimeout(
    () => {
      overviewPollTimer = null;
      void loadOverview({ quiet: true });
    },
    hasActiveRun ? activeDelay : 30_000,
  );
}

function readEditorManifest() {
  try {
    return JSON.parse($('manifest-editor').value);
  } catch (error) {
    throw new Error('JSON 格式错误：' + (error instanceof Error ? error.message : '无法解析'));
  }
}

function showValidation(payload) {
  state.validation = payload.validation || null;
  const result = $('validation-result');
  if (!result) return;
  result.className = 'validation-result ' + (payload.validation?.valid ? 'is-ok' : 'is-error');
  if (payload.validation?.valid) {
    const warnings = payload.validation.warnings?.length
      ? '；' + payload.validation.warnings.length + ' 个提示'
      : '';
    result.textContent = '契约校验通过' + warnings + '。可登记元数据。';
  } else {
    const first = payload.validation?.errors?.[0] || '清单不合法';
    result.textContent = '校验未通过：' + first;
  }
}

async function validateEditor() {
  try {
    const manifest = readEditorManifest();
    const platforms = state.overview?.supportedPlatforms || [];
    const payload = await request('/sim2real/models/validate', {
      method: 'POST',
      body: JSON.stringify({ manifest, platforms }),
    });
    showValidation(payload);
    if (payload.validation?.valid) showToast('模型契约校验通过', 'success');
  } catch (error) {
    const result = $('validation-result');
    if (result) {
      result.className = 'validation-result is-error';
      result.textContent = error instanceof Error ? error.message : '校验失败';
    }
    if (!(error instanceof ApiError && error.status === 401))
      showToast(error instanceof Error ? error.message : '校验失败', 'error');
  }
}

async function registerEditor() {
  try {
    const manifest = readEditorManifest();
    const payload = await request('/sim2real/models', {
      method: 'POST',
      body: JSON.stringify({ manifest }),
    });
    showToast('模型版本已登记', 'success');
    $('manifest-editor').value = JSON.stringify(payload.model?.manifest || manifest, null, 2);
    await loadOverview({ quiet: true });
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401))
      showToast(error instanceof Error ? error.message : '模型登记失败', 'error');
  }
}

function settleConfirmRun(approved) {
  const dialog = $('confirm-run-dialog');
  if (dialog instanceof HTMLDialogElement && dialog.open) dialog.close();
  const resolve = state.confirmRunResolve;
  state.confirmRunResolve = null;
  if (resolve) resolve(approved);
}

// Studio-style explicit confirmation before a billable action: the caller
// gets the operator's decision, and the dialog never submits by itself.
function confirmRobogoRun() {
  const dialog = $('confirm-run-dialog');
  const model = selectedModel();
  const task = selectedTask();
  const profileValue = $('training-profile')?.value || 'standard';
  const profileLabel =
    $('training-profile')?.querySelector('option[value="' + profileValue + '"]')?.textContent ||
    profileValue;
  const checkpointId = $('resume-checkpoint-id')?.value.trim() || '';
  const artifactRef = $('resume-artifact-ref')?.value.trim() || '';
  if (state.confirmRunResolve) state.confirmRunResolve(false);
  state.confirmRunResolve = null;
  if (!(dialog instanceof HTMLDialogElement)) return Promise.resolve(true);
  setText('confirm-run-model', model ? modelLabel(model) : '未选择模型');
  setText('confirm-run-task', task.label || '—');
  setText('confirm-run-profile', profileLabel || '—');
  setText(
    'confirm-run-resume',
    checkpointId && artifactRef ? checkpointId : '不续训',
  );
  return new Promise((resolve) => {
    state.confirmRunResolve = resolve;
    dialog.showModal();
  });
}

async function runModel(backend) {
  if (state.runSubmitting) return;
  if (backend === 'browser' && !selectedProductProfile().simulatorPath) {
    showToast('RDK Duck 尚未配置浏览器仿真适配器，请使用本地仿真或先登记 manifest', 'error');
    return;
  }
  const model = selectedModel();
  if (!model) {
    showToast('请先选择模型', 'error');
    return;
  }
  state.runSubmitting = true;
  renderIntegrations();
  try {
    const requestKey =
      globalThis.crypto?.randomUUID?.() ||
      `run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const body = { modelId: model.id, backend, taskId: state.taskId, idempotencyKey: requestKey };
    const profile = $('training-profile')?.value;
    if ((backend === 'robogo' || backend === 'local') && profile) body.training = { profile };
    const checkpointId = $('resume-checkpoint-id')?.value.trim() || '';
    const artifactRef = $('resume-artifact-ref')?.value.trim() || '';
    if (checkpointId || artifactRef) {
      if (!checkpointId || !artifactRef) {
        showToast('续训需要同时填写 checkpoint ID 和 artifact:// 引用', 'error');
        return;
      }
      body.resumeFrom = { checkpointId, artifactRef };
    }
    const payload = await request('/sim2real/runs', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const run = payload.run || {};
    showToast(
      run.summary || '运行请求已记录',
      run.status === 'completed' || run.status === 'ready' ? 'success' : 'normal',
    );
    if (backend === 'browser') {
      const launchUrl = safeLaunchUrl(run.launchUrl);
      if (launchUrl) window.open(launchUrl, '_blank', 'noopener,noreferrer');
    }
    await loadOverview({ quiet: true });
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401))
      showToast(error instanceof Error ? error.message : '运行请求失败', 'error');
  } finally {
    state.runSubmitting = false;
    renderIntegrations();
  }
}

async function detectBoard() {
  const device = selectedDevice();
  if (!device) {
    showToast('请先选择板卡', 'error');
    return;
  }
  try {
    const payload = await request(
      '/devices/' + encodeURIComponent(device.id) + '/board/detect?persist=true',
      { method: 'POST' },
    );
    showToast(
      payload.platform ? '板型探测完成：' + payload.platform : '板型暂未识别',
      payload.platform ? 'success' : 'normal',
    );
    await loadOverview({ quiet: true });
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401))
      showToast(error instanceof Error ? error.message : '板型探测失败', 'error');
  }
}

async function createPlan() {
  if (state.deploymentSubmitting) return;
  const model = selectedModel();
  const device = selectedDevice();
  if (!model || !device) {
    showToast('请先选择模型和板卡', 'error');
    return;
  }
  state.deploymentSubmitting = true;
  renderIntegrations();
  try {
    const requestKey =
      globalThis.crypto?.randomUUID?.() ||
      `deployment-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const payload = await request('/sim2real/deployments', {
      method: 'POST',
      headers: { 'Idempotency-Key': requestKey },
      body: JSON.stringify({ modelId: model.id, deviceId: device.id, mode: 'preflight' }),
    });
    state.activeDeployment = payload.deployment || null;
    showToast(state.activeDeployment?.summary || '只读预检计划已生成', 'success');
    await loadOverview({ quiet: true });
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401))
      showToast(error instanceof Error ? error.message : '计划生成失败', 'error');
  } finally {
    state.deploymentSubmitting = false;
    renderIntegrations();
  }
}

async function executePreflight() {
  const model = selectedModel();
  const device = selectedDevice();
  const deployment =
    state.activeDeployment ||
    state.overview?.deployments?.find(
      (item) => item.modelId === model?.id && item.deviceId === device?.id,
    );
  if (
    !deployment ||
    !model ||
    !device ||
    deployment.modelId !== model.id ||
    deployment.deviceId !== device.id
  ) {
    state.activeDeployment = null;
    showToast('请先生成预检计划', 'error');
    return;
  }
  try {
    const payload = await request(
      '/sim2real/deployments/' + encodeURIComponent(deployment.id) + '/preflight',
      { method: 'POST' },
    );
    state.activeDeployment = payload.deployment || deployment;
    showToast(
      state.activeDeployment.summary || '只读预检完成',
      payload.preflight?.passed ? 'success' : 'normal',
    );
    await loadOverview({ quiet: true });
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401))
      showToast(error instanceof Error ? error.message : '预检失败', 'error');
  }
}

function loadManifestTemplate({ notify = true } = {}) {
  const profile = selectedProductProfile();
  if (profile.id === 'rdk-duck') {
    // Contract-complete template: 42D/12D matches the starter-ppo engine
    // (engines/starter-ppo/runner.py), so a new user can register, validate,
    // and launch a real training run without inventing dimensions. Replace
    // the layout with your own robot's contract for real hardware training.
    const template = {
      schemaVersion: 1,
      modelId: 'my-rdk-duck-policy',
      displayName: '我的 RDK Duck 策略',
      version: '0.1.0',
      robot: { id: 'rdk-duck', variant: 'starter-kit' },
      contract: {
        id: 'rdk-duck-policy-starter-v1',
        robotId: 'rdk-duck',
        jointCount: 12,
        observationSize: 42,
        actionSize: 12,
        controlHz: 50,
        physicsTimestepSeconds: 0.002,
        decimation: 10,
        observationLayout: [
          { name: 'joint_cos', size: 12 },
          { name: 'joint_sin', size: 12 },
          { name: 'joint_velocity', size: 12 },
          { name: 'command', size: 6 },
        ],
      },
      simulator: {
        backends: ['local'],
        policyArtifactId: 'policy-onnx',
        policyBundle: {
          defaultPolicyId: 'balance',
          policies: [{ id: 'balance', label: '平衡', artifactId: 'policy-onnx' }],
        },
      },
      artifacts: [
        {
          id: 'policy-onnx',
          role: 'policy',
          name: 'policy.onnx',
          kind: 'source',
          format: 'onnx',
          runtime: 'cpu-onnx',
          workload: 'locomotion',
          threads: 1,
          ref: 'artifact://replace-with-managed-artifact',
        },
      ],
      metadata: {
        source: 'RDK Duck local or RoboGo export',
        notes: '默认契约与 starter-ppo 引擎一致（42D/12D/50Hz）；换机器人请同步修改 layout 与引擎。',
      },
    };
    $('manifest-editor').value = JSON.stringify(template, null, 2);
    if (notify) showToast('已载入 RDK Duck manifest 模板（与 starter-ppo 引擎契约一致）；可直接校验');
    return;
  }
  const contract = state.overview?.selectedContract ||
    state.overview?.contract || {
      id: CONTRACT_ID,
      robotId: 'microduck',
      jointCount: 14,
      observationSize: 61,
      actionSize: 14,
      controlHz: 50,
      physicsTimestepSeconds: 0.005,
      decimation: 4,
      observationLayout: [
        { name: 'gyro', size: 3 },
        { name: 'projected_gravity', size: 3 },
        { name: 'joint_position_error', size: 14 },
        { name: 'joint_velocity', size: 14 },
        { name: 'last_action', size: 14 },
        { name: 'command', size: 13 },
      ],
    };
  const template = {
    schemaVersion: 1,
    modelId: 'my-microduck-policy',
    displayName: 'My MicroDuck Policy',
    version: '0.1.0',
    robot: { id: 'microduck', variant: 'legs' },
    contract,
    simulator: {
      backends: ['browser', 'local'],
      policyArtifactId: 'policy-onnx',
      policyBundle: {
        defaultPolicyId: 'walking',
        policies: [
          {
            id: 'walking',
            label: '行走',
            artifactId: 'policy-onnx',
            keys: ['W', 'A', 'S', 'D', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'],
            description: 'W/A/S/D 或方向键控制前进、后退和转向。',
          },
        ],
      },
      controls: MICRODUCK_CONTROLS,
      entryUrl: SIMULATOR_PATH,
    },
    artifacts: [
      {
        id: 'policy-onnx',
        role: 'policy',
        name: 'policy.onnx',
        kind: 'source',
        format: 'onnx',
        runtime: 'cpu-onnx',
        workload: 'locomotion',
        threads: 1,
        ref: 'artifact://replace-with-managed-artifact',
      },
    ],
    metadata: {
      source: 'Local or RoboGo export',
      notes:
        'Replace the opaque artifact reference after the managed artifact store is configured.',
    },
  };
  $('manifest-editor').value = JSON.stringify(template, null, 2);
  if (notify) showToast('已载入 manifest 模板');
}

async function importManifestFile(event) {
  const input = event.target;
  const file = input?.files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    $('manifest-editor').value = JSON.stringify(parsed, null, 2);
    showToast('已导入本地 manifest；请先校验再登记', 'success');
  } catch (error) {
    showToast(
      'manifest 文件无法解析：' + (error instanceof Error ? error.message : 'JSON 格式错误'),
      'error',
    );
  } finally {
    input.value = '';
  }
}

/* ------------------------------------------------------------------ */
/* 上位机（host station）——板端实时状态、相机流与白名单只读命令。      */
/* 浏览器不直接连 BoardAgent：所有请求走 /api/sim2real/board-station   */
/* 代理；命令白名单与只读语义由服务端再校验一次。                      */
/* ------------------------------------------------------------------ */
const STATION_LOG_LIMIT = 60;

function stationLog(message, kind = 'info') {
  const entry = {
    time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    message: String(message).slice(0, 200),
    kind,
  };
  state.station.log.push(entry);
  while (state.station.log.length > STATION_LOG_LIMIT) state.station.log.shift();
  const list = $('station-log-list');
  if (list) {
    const item = document.createElement('li');
    item.className =
      'station-log-entry' + (kind === 'error' ? ' is-error' : kind === 'ok' ? ' is-ok' : '');
    const time = document.createElement('span');
    time.className = 'station-log-time';
    time.textContent = entry.time;
    item.appendChild(time);
    item.appendChild(document.createTextNode(entry.message));
    list.appendChild(item);
    while (list.childElementCount > STATION_LOG_LIMIT) list.removeChild(list.firstElementChild);
    list.scrollTop = list.scrollHeight;
  }
}

function stationStopStatusStream() {
  if (state.station.statusReader) {
    try {
      state.station.statusReader.cancel().catch(() => undefined);
    } catch {
      /* reader already closed */
    }
    state.station.statusReader = null;
  }
}

function stationFormatUptime(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// ---- station 可视化辅助 -------------------------------------------------
// 指标进度条：按阈值分色（青 → 黄 → 红），值非法时整条隐藏。
const STATION_SPARK_POINTS = 60;
const stationSparkSeries = { rx: [], tx: [] };

function stationSetBar(id, ratio, warn, danger, invert = false) {
  const bar = $(id);
  if (!bar) return;
  const value = Number(ratio);
  if (!Number.isFinite(value)) {
    bar.style.width = '0%';
    bar.className = '';
    return;
  }
  const pct = Math.max(0, Math.min(100, value * 100));
  bar.style.width = `${pct}%`;
  const card = bar.closest('.station-metric-card');
  // Most gauges treat higher values as risk (CPU, memory, disk). Battery
  // voltage is the opposite: a lower ratio is the dangerous direction. Keep
  // the direction explicit at the call site so a healthy battery is never
  // painted red while a depleted one looks normal.
  const isDanger = invert ? value <= danger : value >= danger;
  const isWarn = invert ? value <= warn : value >= warn;
  bar.className = isDanger ? 'is-danger' : isWarn ? 'is-warn' : '';
  if (card) card.classList.toggle('is-danger', isDanger);
}

function stationPushSpark(rxBps, txBps) {
  const push = (series, v) => {
    series.push(Number.isFinite(v) ? v : 0);
    if (series.length > STATION_SPARK_POINTS) series.shift();
  };
  push(stationSparkSeries.rx, rxBps);
  push(stationSparkSeries.tx, txBps);
  const line = $('station-network-spark-line');
  if (!line) return;
  const all = stationSparkSeries.rx.concat(stationSparkSeries.tx);
  const max = Math.max(1, ...all);
  const toPoints = (series) =>
    series
      .map((v, i) => {
        const x = (i / Math.max(1, STATION_SPARK_POINTS - 1)) * 100;
        const y = 24 - Math.min(1, v / max) * 20;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  const rxPoints = toPoints(stationSparkSeries.rx);
  const txPoints = toPoints(stationSparkSeries.tx);
  // rx 折线走主色，tx 用低透明度参考线（points 属性拼两条 polyline）。
  const rxEl = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  line.setAttribute('points', rxPoints || '0,24 100,24');
  const svg = line.closest('svg');
  if (svg) {
    let txLine = svg.querySelector('.station-spark-tx');
    if (!txLine) {
      txLine = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      txLine.setAttribute('class', 'station-spark-tx');
      svg.appendChild(txLine);
    }
    txLine.setAttribute('points', txPoints || '0,24 100,24');
  }
}

/**
 * IMU 快照有两种形状：平铺 {x,y,z,w}（旧遥测节点）与嵌套
 * {quaternion:{...}, gyro:{...}}（新版遥测节点）。统一在这里解析，
 * 两条数据路径（罗盘、顶部航向）都用它，避免升级遥测节点后罗盘停转。
 */
function stationImuQuaternion(originbot) {
  const imu = (originbot && originbot.imu) || {};
  const q = imu.quaternion && typeof imu.quaternion === 'object' ? imu.quaternion : imu;
  const x = Number(q.x);
  const y = Number(q.y);
  const z = Number(q.z);
  const w = Number(q.w);
  if (![x, y, z, w].every(Number.isFinite)) return null;
  return { x, y, z, w };
}

function stationRenderRobotTelemetry(status) {
  const wrap = $('station-robot-tele');
  if (!wrap) return;
  const originbot = status.originbot || status.telemetry || {};
  const hasData =
    originbot && typeof originbot === 'object' && Object.keys(originbot).length > 0;
  wrap.hidden = !hasData;
  if (!hasData) return;
  const setText = (id, value) => {
    const node = $(id);
    if (node) node.textContent = value;
  };
  const quat = stationImuQuaternion(originbot);
  const z = quat ? quat.z : NaN;
  const w = quat ? quat.w : NaN;
  if (Number.isFinite(z) && Number.isFinite(w)) {
    const yawDeg = (2 * Math.atan2(z, w) * (180 / Math.PI) + 360) % 360;
    setText('station-tele-heading', `${yawDeg.toFixed(1)}°`);
    const needle = $('station-compass-needle');
    if (needle) needle.style.transform = `rotate(${yawDeg.toFixed(2)}deg)`;
    setText('station-tele-heading-sub', `四元数 yaw · ${(Math.atan2(z, w) * (180 / Math.PI)).toFixed(1)}° 原始`);
  } else {
    setText('station-tele-heading', '--');
  }
  const voltage = Number(originbot.batteryVoltage ?? originbot.battery?.voltage);
  const BATTERY_MIN = 3.3;
  const BATTERY_MAX = 5.4;
  if (Number.isFinite(voltage)) {
    setText('station-tele-battery', `${voltage.toFixed(2)}V`);
    const ratio = Math.max(0, Math.min(1, (voltage - BATTERY_MIN) / (BATTERY_MAX - BATTERY_MIN)));
    const cells = $('station-tele-battery-cells');
    if (cells) {
      const lit = Math.ceil(ratio * cells.children.length);
      [...cells.children].forEach((cell, i) => {
        cell.className = i < lit ? (ratio < 0.2 ? 'is-danger' : i < lit ? 'is-on' : '') : '';
      });
    }
    setText(
      'station-tele-battery-sub',
      ratio < 0.2 ? '低电压 · 建议尽快充电' : `电量估计 ${Math.round(ratio * 100)}%（3.3–5.4V 参考区间）`,
    );
  } else {
    setText('station-tele-battery', '--');
    setText('station-tele-battery-sub', '无电池遥测');
  }
  const odom = originbot.odom || {};
  const px = Number(odom.positionX);
  const py = Number(odom.positionY);
  if (Number.isFinite(px) && Number.isFinite(py)) {
    setText('station-tele-odom', `x ${px.toFixed(2)} · y ${py.toFixed(2)} m`);
  } else {
    setText('station-tele-odom', '--');
  }
  const vx = Number(odom.linearX);
  const wz = Number(odom.angularZ);
  if (Number.isFinite(vx) || Number.isFinite(wz)) {
    setText(
      'station-tele-vel',
      `${Number.isFinite(vx) ? vx.toFixed(2) : '--'} m/s · ${Number.isFinite(wz) ? wz.toFixed(2) : '--'} rad/s`,
    );
  } else {
    setText('station-tele-vel', '--');
  }
  const liveBadge = $('station-tele-live');
  if (liveBadge) liveBadge.hidden = false;
}

function stationRenderStatus(status) {
  if (!status || typeof status !== 'object') return;
  const freshness = $('station-freshness');
  if (freshness) {
    freshness.textContent = `最后更新 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
    freshness.classList.remove('is-stale');
  }
  const cpu = status.cpu || {};
  const memory = status.memory || {};
  const disk = status.disk || {};
  const network = status.network || {};
  const power = status.power || {};
  const setText = (id, value) => {
    const node = $(id);
    if (node) node.textContent = value;
  };
  setText('station-cpu', Number.isFinite(cpu.percent) ? `${cpu.percent.toFixed(1)}%` : '--');
  setText(
    'station-cpu-temp',
    Number.isFinite(cpu.temperatureC) ? `温度 ${cpu.temperatureC.toFixed(1)}°C` : '--',
  );
  const usedMB = Number(memory.usedMB);
  const totalMB = Number(memory.totalMB);
  setText(
    'station-memory',
    Number.isFinite(usedMB) && totalMB ? `${(usedMB / 1024).toFixed(1)}G` : '--',
  );
  setText(
    'station-memory-sub',
    Number.isFinite(usedMB) && totalMB
      ? `${Math.round((usedMB / totalMB) * 100)}% / ${(totalMB / 1024).toFixed(0)}G`
      : '--',
  );
  setText(
    'station-network',
    `${Number.isFinite(network.rxKbPerSec) ? network.rxKbPerSec : '--'}/${Number.isFinite(network.txKbPerSec) ? network.txKbPerSec : '--'} KB/s`,
  );
  setText('station-network-sub', '以太网');
  // 可视化层：进度条 + 网络 sparkline（1Hz 流驱动，60 点滚动窗口）。
  stationSetBar('station-cpu-bar', Number(cpu.percent) / 100, 0.6, 0.85);
  stationSetBar(
    'station-memory-bar',
    Number.isFinite(usedMB) && totalMB ? usedMB / totalMB : NaN,
    0.7,
    0.9,
  );
  stationPushSpark(
    Number(network.rxKbPerSec),
    Number(network.txKbPerSec),
  );
  // OriginBot telemetry is reported honestly by the agent: present only when
  // the bringup stack is running, never synthesized here.
  const originbot = status.originbot || status.telemetry || {};
  const obVoltage = Number(originbot.batteryVoltage ?? originbot.battery?.voltage);
  setText(
    'station-power',
    Number.isFinite(obVoltage)
      ? `${obVoltage.toFixed(2)}V`
      : Number.isFinite(power.voltage)
        ? `${power.voltage.toFixed(1)}V`
        : '--',
  );
  const obQuat = stationImuQuaternion(originbot);
  const imuZ = obQuat ? obQuat.z : NaN;
  const imuW = obQuat ? obQuat.w : NaN;
  setText(
    'station-power-sub',
    Number.isFinite(obVoltage)
      ? `${status.profile?.displayName || status.adapterId || '设备'} 电池`
      : Number.isFinite(power.current)
        ? `电流 ${power.current.toFixed(1)}A`
        : '无电源监控',
  );
  setText(
    'station-uptime',
    Number.isFinite(imuZ) && Number.isFinite(imuW)
      ? `航向 ${(2 * Math.atan2(imuZ, imuW) * (180 / Math.PI)).toFixed(1)}°`
      : stationFormatUptime(status.uptimeSec),
  );
  setText(
    'station-uptime-sub',
    Number.isFinite(imuZ) && Number.isFinite(imuW)
      ? `${status.profile?.displayName || status.adapterId || '设备'} IMU · ${stationFormatUptime(status.uptimeSec)}`
      : '自 agent 启动',
  );
  const diskUsedMB = Number(disk.usedMB);
  const diskTotalMB = Number(disk.totalMB);
  setText(
    'station-disk',
    Number.isFinite(diskUsedMB) && diskTotalMB ? `${(diskUsedMB / 1024).toFixed(1)}G / ${(diskTotalMB / 1024).toFixed(0)}G` : '--',
  );
  setText(
    'station-disk-sub',
    Number.isFinite(diskUsedMB) && diskTotalMB
      ? `已用 ${Math.round((diskUsedMB / diskTotalMB) * 100)}%`
      : '--',
  );
  // Drive canary state comes straight from the agent snapshot (1 Hz stream);
  // absent means the agent predates the drive surface and stays "空闲".
  const drive = status.drive;
  const driveState = $('station-drive-state');
  if (driveState) {
    if (drive && drive.active) {
      const remaining = Number.isFinite(Number(drive.remainingMs)) ? drive.remainingMs : 0;
      driveState.textContent =
        `运动中 ${Number(drive.linear).toFixed(2)} m/s · ${Number(drive.angular).toFixed(2)} rad/s · 剩余 ${(remaining / 1000).toFixed(1)}s`;
    } else {
      const reason = drive && drive.lastStopReason ? String(drive.lastStopReason) : '空闲';
      driveState.textContent = `空闲（${reason}）`;
    }
  }
  stationUpdateFloatStop(drive);
  // 可视化层：磁盘进度条 + 机体遥测卡（罗盘/电池/odom）。
  stationSetBar(
    'station-disk-bar',
    Number.isFinite(diskUsedMB) && diskTotalMB ? diskUsedMB / diskTotalMB : NaN,
    0.75,
    0.9,
  );
  const powerRatio =
    Number.isFinite(obVoltage) ? Math.max(0, Math.min(1, (obVoltage - 3.3) / (5.4 - 3.3))) : NaN;
  stationSetBar('station-power-bar', powerRatio, 0.35, 0.2, true);
  const profileTitle = $('station-robot-tele-title');
  if (profileTitle) {
    const profileName = status.profile?.displayName || status.board?.model || status.adapterId || '当前适配包';
    profileTitle.textContent = `机体遥测 · ${profileName}`;
  }
  const liveBadge = $('station-live-badge');
  if (liveBadge && status.timestamp) {
    const age = Math.max(0, (Date.now() - Date.parse(status.timestamp)) / 1000);
    liveBadge.textContent = age <= 3 ? `LIVE · ${age.toFixed(1)}s` : age <= 10 ? `陈旧 · ${age.toFixed(1)}s` : '已断开';
    liveBadge.classList.toggle('is-stale', age > 3);
    liveBadge.title = `最后采样 ${age.toFixed(1)} 秒前`;
  }
  stationRenderRobotTelemetry(status);
  // 策略运行时状态直接来自 agent 1Hz 快照（policy 字段），如实渲染。
  stationRenderPolicy(status.policy);
  const topicList = $('station-topic-list');
  if (topicList) {
    const topics = Array.isArray(status.topics) ? status.topics.slice(0, 12) : [];
    topicList.replaceChildren();
    if (!topics.length) {
      const empty = document.createElement('span');
      empty.className = 'station-topic-empty';
      empty.textContent = '无话题数据';
      topicList.appendChild(empty);
    } else {
      // 话题按角色分色：驱动 / 传感器 / TF·系统，一眼可辨。
      const topicKind = (name) => {
        const n = String(name ?? '');
        if (n === '/cmd_vel') return 'drive';
        if (n === '/imu' || n === '/odom' || n.includes('status')) return 'sensor';
        if (n.startsWith('/tf')) return 'tf';
        return 'sys';
      };
      topics.forEach((topic) => {
        const chip = document.createElement('span');
        chip.className = `station-topic-chip station-topic-${topicKind(topic?.name)}`;
        chip.textContent = `${String(topic?.name ?? '?')} · ${Number.isFinite(Number(topic?.hz)) ? Math.round(Number(topic.hz)) : '?'}Hz`;
        topicList.appendChild(chip);
      });
    }
  }
}

function stationClearStreamReconnect() {
  if (state.station.streamReconnectTimer) {
    clearTimeout(state.station.streamReconnectTimer);
    state.station.streamReconnectTimer = null;
  }
}

function stationScheduleStreamReconnect() {
  // 一次网络抖动或 agent 重启不应让上位机永久显示 "--"：指数退避重连，
  // 上限 30 秒；视图切走（teardown）时清除定时器。
  if (!state.station.ready || state.station.statusReader) return;
  stationClearStreamReconnect();
  const attempts = Math.min(state.station.streamReconnectAttempts + 1, 5);
  state.station.streamReconnectAttempts = attempts;
  const delayMs = Math.min(1000 * 2 ** (attempts - 1), 30000);
  state.station.streamReconnectTimer = setTimeout(() => {
    state.station.streamReconnectTimer = null;
    stationStartStatusStream();
  }, delayMs);
}

function stationStartStatusStream() {
  if (state.station.statusReader) return;
  stationClearStreamReconnect();
  const badge = $('station-live-badge');
  fetch(apiPath('/sim2real/board-station/status/stream'), {
    credentials: 'same-origin',
    headers: { accept: 'application/x-ndjson' },
  })
    .then(async (response) => {
      if (!response.ok || !response.body) throw new Error('HTTP ' + response.status);
      if (badge) badge.hidden = false;
      // 流真正建立后重置退避计数，短暂中断不会累积到长间隔。
      state.station.streamReconnectAttempts = 0;
      const reader = response.body.getReader();
      state.station.statusReader = reader;
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const newline = buffer.indexOf('\n');
          if (newline < 0) break;
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          try {
            stationRenderStatus(JSON.parse(line));
          } catch {
            /* skip malformed heartbeat line */
          }
        }
      }
    })
    .catch(() => {
      if (badge) badge.hidden = true;
      const freshness = $('station-freshness');
      if (freshness) {
        freshness.textContent = '数据流已断开';
        freshness.classList.add('is-stale');
      }
      stationLog('状态流已断开或不可用', 'error');
    })
    .finally(() => {
      state.station.statusReader = null;
      if (badge) badge.hidden = true;
      // 流结束（正常关闭或错误）后自动重连；页面隐藏/视图切走时由
      // teardown 清理定时器，不产生孤儿重连。
      stationScheduleStreamReconnect();
    });
}

// ---- motion canary (constrained drive) ---------------------------------
// The panel appears only when BOTH switches report enabled: the platform's
// (GET drive -> platformEnabled) and the agent's (drive.enabled). Motion is
// sent one command at a time behind an explicit confirm; 急停 (stop) bypasses
// every gate and is always clickable.

async function stationProbeDrive() {
  try {
    const payload = await request('/sim2real/board-station/drive');
    const enabled = payload?.platformEnabled === true && payload?.drive?.enabled === true;
    const controls = $('station-drive-controls');
    const note = $('station-drive-note');
    if (controls) controls.hidden = !enabled;
    if (note) {
      note.textContent = enabled
        ? '受限驱动已开启：速度钳制 0.3 m/s / 1.0 rad/s，单次窗口 ≤ 2s，500ms 无命令底盘自动停车。'
        : payload?.platformEnabled === true
          ? '平台已开启，但板端 agent 未开启 RDK_SIM2REAL_BOARD_AGENT_ENABLE_DRIVE。'
          : '未启用。受限驱动需要平台与板端两个开关同时开启（RDK_SIM2REAL_STATION_DRIVE_ENABLED / RDK_SIM2REAL_BOARD_AGENT_ENABLE_DRIVE）；急停始终可用。';
    }
  } catch {
    // Drive surface absent (older agent) keeps the panel hidden — the
    // read-only contract must render honestly, never fail loudly here.
    const controls = $('station-drive-controls');
    if (controls) controls.hidden = true;
  }
}

function stationReadDriveInputs() {
  const speed = Number($('station-drive-speed')?.value);
  const omega = Number($('station-drive-omega')?.value);
  const duration = Number($('station-drive-duration')?.value);
  return {
    linear: Number.isFinite(speed) ? speed : 0,
    angular: Number.isFinite(omega) ? omega : 0,
    durationSec: Number.isFinite(duration) ? duration : 1,
  };
}

async function stationSendDrive() {
  const { linear, angular, durationSec } = stationReadDriveInputs();
  const acknowledged = window.confirm(
    `即将让 OriginBot 以 ${linear.toFixed(2)} m/s（转向 ${angular.toFixed(2)} rad/s）运动 ${durationSec.toFixed(1)} 秒。\n` +
      '请确认机器人周围无障碍物、桌面/场地已清空。\n' +
      '急停按钮随时可用；底盘 500ms 看门狗兜底。',
  );
  if (!acknowledged) return;
  try {
    const payload = await request('/sim2real/board-station/drive', {
      method: 'POST',
      body: JSON.stringify({ linear, angular, durationSec }),
    });
    if (payload?.drive?.active) {
      stationLog(`运动命令已接受：${linear.toFixed(2)} m/s / ${angular.toFixed(2)} rad/s / ${durationSec.toFixed(1)}s`, 'ok');
    } else {
      stationLog('板端未进入运动状态（可能已被窗口过期或急停覆盖）', 'info');
    }
  } catch (error) {
    stationLog(`运动命令被拒绝：${error instanceof Error ? error.message : '未知错误'}`, 'error');
  }
}

async function stationEmergencyStop() {
  try {
    await request('/sim2real/board-station/drive/stop', { method: 'POST', body: '{}' });
    stationLog('急停已下发：零速帧发布，底盘看门狗兜底停车', 'ok');
    const driveState = $('station-drive-state');
    if (driveState) driveState.textContent = '急停（operator-emergency-stop）';
  } catch (error) {
    stationLog(`急停下发失败（底盘看门狗仍兜底）：${error instanceof Error ? error.message : '未知错误'}`, 'error');
  }
}

// 浮动急停：驱动窗口激活时在视口角落常驻一枚红色停止按钮，任何页面可见。
// 只依赖 1Hz 状态流里的 drive.active；流断开时按钮 2s 后自动隐藏，宁可
// 多显示不可在运动中消失。急停端点本身永远可用，与按钮显隐无关。
let stationFloatStopTimer = null;

function stationUpdateFloatStop(drive) {
  const button = $('station-float-stop');
  if (!button) return;
  const active = Boolean(drive && drive.active);
  if (active) {
    button.hidden = false;
    if (stationFloatStopTimer) clearTimeout(stationFloatStopTimer);
    stationFloatStopTimer = setTimeout(() => {
      button.hidden = true;
      stationFloatStopTimer = null;
    }, 2000);
  } else if (stationFloatStopTimer) {
    clearTimeout(stationFloatStopTimer);
    stationFloatStopTimer = null;
    button.hidden = true;
  }
}

function wireStationFloatStop() {
  const button = $('station-float-stop');
  if (!button || button.dataset.wired === '1') return;
  button.dataset.wired = '1';
  button.addEventListener('click', () => {
    void stationEmergencyStop();
  });
}

// ---- policy runtime (trained ONNX → bounded /cmd_vel) ---------------------
// 与运动 Canary 同一条受限通道：速度钳制 / 500ms 底盘看门狗 / 急停常开。
// 面板只在平台策略开关开启时展开控制区；停止（策略归零）永远可点。

async function stationProbePolicy() {
  try {
    const payload = await request('/sim2real/board-station/policy');
    const platform = payload?.platformEnabled === true;
    const drivePlatform = payload?.drivePlatformEnabled === true;
    const agent = payload?.policy;
    const agentPolicy = agent?.enabled === true;
    const agentDrive = agent?.driveEnabled === true;
    const agentReady = agentPolicy && agentDrive;
    const controls = $('station-policy-controls');
    const note = $('station-policy-note');
    if (controls) controls.hidden = !platform;
    if (note) {
      // 逐个开关如实点名，缺哪个说哪个——演示时这就是现场核对清单。
      const missing = [];
      if (!platform) missing.push('平台 RDK_SIM2REAL_STATION_POLICY_ENABLED');
      if (!drivePlatform) missing.push('平台 RDK_SIM2REAL_STATION_DRIVE_ENABLED');
      if (!agentPolicy) missing.push('板端 RDK_SIM2REAL_BOARD_AGENT_ENABLE_POLICY');
      if (!agentDrive) missing.push('板端 RDK_SIM2REAL_BOARD_AGENT_ENABLE_DRIVE');
      if (!missing.length) {
        note.textContent =
          '策略运动通道已开启：输出钳制 0.3 m/s / 1.0 rad/s，500ms 无命令底盘自动停车，急停始终可用。';
      } else if (platform) {
        note.textContent = `平台策略开关已开启，尚未开启：${missing.join('、')}。`;
      } else {
        note.textContent =
          `未启用。策略运动需要四个开关全部开启，尚未开启：${missing.join('、')}；策略停止始终可用。`;
      }
    }
    if (agent) stationRenderPolicy(agent);
  } catch {
    const controls = $('station-policy-controls');
    if (controls) controls.hidden = true;
  }
}

/** 1Hz 流渲染：state/model/infer/published/obsSlots 全部如实显示。 */
function stationRenderPolicy(policy) {
  if (!policy || typeof policy !== 'object') return;
  const stateText = String(policy.state ?? 'idle');
  const stateNode = $('station-policy-state');
  if (stateNode) {
    stateNode.textContent = stateText;
    stateNode.dataset.state = stateText;
  }
  const infer = Number(policy.inferMs);
  setText('station-policy-infer', Number.isFinite(infer) && infer > 0 ? `${infer.toFixed(1)} ms` : '-- ms');
  setText('station-policy-published', Number.isFinite(Number(policy.published)) ? String(Math.round(Number(policy.published))) : '0');
  const cmd = Number(policy.command);
  setText('station-policy-command', Number.isFinite(cmd) ? cmd.toFixed(1) : '0.0');
  const model = policy.model;
  const meta = $('station-policy-model-meta');
  if (meta) {
    if (model && typeof model === 'object') {
      const kb = Number(model.bytes);
      meta.textContent =
        `${String(model.path ?? '?').split('/').pop()} · ${Number.isFinite(kb) ? `${Math.round(kb / 1024)}KB` : '?'} · ` +
        `${Number(model.inputDim)}→${Number(model.outputDim)}`;
    } else {
      meta.textContent = '未加载模型';
    }
  }
  const slots = policy.obsSlots;
  const slotsNode = $('station-policy-obsslots');
  if (slotsNode) {
    // obsSlots 混有字符串条目（槽位说明）与数字条目（契约统计）——只把字符串
    // 说明渲染成真/零行；统计类键（slots_real 等）拼进标题，一行看懂契约。
    const entries = Object.entries(slots ?? {}).filter(
      ([, desc]) => typeof desc === 'string',
    );
    const slotsReal = Number(slots?.slots_real);
    const slotsAdapter = Number(slots?.slots_adapter);
    const contract = typeof slots?.contract === 'string' ? slots.contract : '';
    if (entries.length) {
      slotsNode.replaceChildren();
      const title = document.createElement('div');
      title.className = 'station-policy-obsslots-title';
      title.textContent =
        `观测槽位如实标注${contract ? ` · 契约 ${contract}` : ''}` +
        (Number.isFinite(slotsReal) && Number.isFinite(slotsAdapter)
          ? ` · 真实槽 ${slotsReal} / 适配槽 ${slotsAdapter}`
          : '（哪些是真数据，哪些是适配零填充）');
      slotsNode.appendChild(title);
      entries.forEach(([slot, desc]) => {
        const row = document.createElement('div');
        row.className = 'station-policy-obsslots-row';
        const real = String(desc).startsWith('real');
        const kind = document.createElement('span');
        kind.className = `station-policy-obsslots-kind ${real ? 'is-real' : 'is-zero'}`;
        kind.textContent = real ? '真' : '零';
        const name = document.createElement('span');
        name.className = 'station-policy-obsslots-name';
        name.textContent = slot;
        const descNode = document.createElement('span');
        descNode.className = 'station-policy-obsslots-desc';
        descNode.textContent = String(desc);
        row.append(kind, name, descNode);
        slotsNode.appendChild(row);
      });
      slotsNode.hidden = false;
    } else {
      slotsNode.hidden = true;
    }
  }
  const lastError = policy.lastError;
  const errNode = $('station-policy-lasterr');
  if (errNode) {
    if (lastError) {
      errNode.textContent = `最近故障：${String(lastError)}`;
      errNode.hidden = false;
    } else {
      errNode.hidden = true;
    }
  }
  stationUpdateFloatStop(policy.state === 'running' ? { active: true } : null);
}

async function stationPolicyLoad() {
  const name = String($('station-policy-model-name')?.value ?? '').trim();
  if (!/^[\w.-]+\.onnx$/.test(name)) {
    stationLog('模型名无效：仅接受板端 policies/ 目录内的 .onnx 文件名', 'error');
    return;
  }
  try {
    const payload = await request('/sim2real/board-station/policy/load', {
      method: 'POST',
      body: JSON.stringify({ path: name }),
    });
    if (payload?.ok) {
      stationLog(`模型已加载：${name}（板端 onnxruntime 会话就绪）`, 'ok');
    } else {
      stationLog(`模型加载失败：${payload?.error ?? payload?.reason ?? '未知原因'}`, 'error');
    }
    if (payload?.policy) stationRenderPolicy(payload.policy);
  } catch (error) {
    stationLog(`模型加载失败：${error instanceof Error ? error.message : '未知错误'}`, 'error');
  }
}

async function stationPolicyStart() {
  const direction = Number($('station-policy-direction')?.value ?? 0);
  const acknowledged = window.confirm(
    `即将让 OriginBot 由策略网络驱动运动（方向指令 ${direction.toFixed(1)}）。\n` +
    '策略输出将被钳制在 0.3 m/s / 1.0 rad/s 内，500ms 无命令底盘自动停车。\n' +
    '请确认机器人周围无障碍物、场地已清空，急停按钮随时可用。',
  );
  if (!acknowledged) return;
  try {
    const payload = await request('/sim2real/board-station/policy/start', {
      method: 'POST',
      body: JSON.stringify({ direction }),
    });
    if (payload?.ok) {
      stationLog('策略已启动：板端实时推理中（观测→动作→/cmd_vel）', 'ok');
    } else {
      stationLog(`策略启动被拒绝：${payload?.error ?? payload?.reason ?? '未知原因'}`, 'error');
    }
    if (payload?.policy) stationRenderPolicy(payload.policy);
  } catch (error) {
    stationLog(`策略启动被拒绝：${error instanceof Error ? error.message : '未知错误'}`, 'error');
  }
}

async function stationPolicyStop() {
  try {
    await request('/sim2real/board-station/policy/stop', { method: 'POST', body: '{}' });
    stationLog('策略已停止：输出归零，底盘看门狗兜底', 'ok');
  } catch (error) {
    stationLog(`策略停止失败（底盘看门狗仍兜底）：${error instanceof Error ? error.message : '未知错误'}`, 'error');
  }
}

async function stationPolicyReset() {
  try {
    await request('/sim2real/board-station/policy/reset', { method: 'POST', body: '{}' });
    stationLog('故障已清除，策略运行时回到可用状态', 'ok');
  } catch (error) {
    stationLog(`故障清除失败：${error instanceof Error ? error.message : '未知错误'}`, 'error');
  }
}

function stationSetCamera(enabled) {
  const img = $('station-camera-img');
  const placeholder = $('station-camera-placeholder');
  const cameraState = $('station-camera-state');
  const toggle = $('station-camera-toggle');
  if (!img) return;
  state.station.cameraOn = Boolean(enabled);
  if (state.station.cameraOn) {
    img.src = apiPath('/sim2real/board-station/camera.mjpeg');
    img.hidden = false;
    if (placeholder) placeholder.hidden = true;
    if (cameraState) cameraState.textContent = '已连接（MJPEG）';
    if (toggle) toggle.textContent = '关闭相机流';
    stationLog('相机流已开启', 'ok');
  } else {
    img.removeAttribute('src');
    img.hidden = true;
    if (placeholder) {
      placeholder.hidden = false;
      placeholder.textContent = '相机流未启动';
    }
    if (cameraState) cameraState.textContent = '未连接';
    if (toggle) toggle.textContent = '开启相机流';
    stationLog('相机流已关闭');
  }
}

// A real board may answer 503 CAMERA_UNAVAILABLE (no camera connected). The
// <img> element only surfaces that through onerror, so fall back to the
// honest placeholder instead of leaving a blank frame.
function wireStationCameraError() {
  const img = $('station-camera-img');
  if (!img || img.dataset.cameraErrorWired === '1') return;
  img.dataset.cameraErrorWired = '1';
  img.addEventListener('error', () => {
    if (!state.station.cameraOn) return;
    stationSetCamera(false);
    stationLog('板端没有可用相机（agent 如实返回不可用），不会伪造画面', 'error');
  });
}

async function stationRunCommand(id) {
  const output = $('station-command-output');
  const buttons = document.querySelectorAll('[data-station-command]');
  buttons.forEach((button) => {
    if (button.dataset.stationCommand === id) button.disabled = true;
  });
  stationLog(`执行只读命令：${id}`);
  try {
    const payload = await request('/sim2real/board-station/commands', {
      method: 'POST',
      body: JSON.stringify({ id }),
    });
    if (output) {
      output.hidden = false;
      output.textContent = String(payload?.output ?? '(空输出)');
    }
    stationLog(`命令完成：${id}`, 'ok');
  } catch (error) {
    if (output) {
      output.hidden = false;
      output.textContent = error instanceof Error ? error.message : '命令执行失败';
    }
    stationLog(`命令失败：${id}`, 'error');
  } finally {
    buttons.forEach((button) => {
      if (button.dataset.stationCommand === id) button.disabled = false;
    });
  }
}

async function stationInit() {
  const notice = $('station-notice');
  const honestyNote = $('station-honesty-note');
  try {
    const health = await request('/sim2real/board-station/health');
    state.station.ready = true;
    state.station.mock = health?.agent?.mock === true;
    state.station.device = health?.device ?? null;
    if (notice) notice.hidden = true;
    if (honestyNote) honestyNote.hidden = health?.agent?.mock !== true;
    const deviceName = $('station-device-name');
    if (deviceName) {
      deviceName.textContent = health?.device?.name
        ? `${health.device.name}（${health.device.id}）`
        : '（未选择）';
    }
    stationLog(
      health?.agent?.mock === true
        ? '已连接本地参考 BoardAgent（模拟数据）'
        : '已连接板端 agent',
      'ok',
    );
    stationStartStatusStream();
    // 探测受限驱动双开关状态；面板是否可见由真实状态决定，默认隐藏。
    stationProbeDrive();
    // 同样探测策略运行时开关（独立的面板、独立的第三重开关）。
    stationProbePolicy();
  } catch (error) {
    state.station.ready = false;
    if (notice) {
      notice.hidden = false;
      notice.textContent =
        '上位机未就绪：' +
        (error instanceof Error ? error.message : '板端 agent 或板卡设备不可用') +
        '。请先运行 npm run dev:board-agent 并在部署页注册板卡。';
    }
    stationLog('上位机初始化失败', 'error');
  }
}

function stationTeardown() {
  stationStopStatusStream();
  stationClearStreamReconnect();
  state.station.streamReconnectAttempts = 0;
  stationSetCamera(false);
}

function wireStationEvents() {
  wireStationCameraError();
  document.querySelectorAll('[data-station-command]').forEach((button) => {
    button.addEventListener('click', () => stationRunCommand(button.dataset.stationCommand));
  });
  $('station-camera-toggle')?.addEventListener('click', () => {
    stationSetCamera(!state.station.cameraOn);
  });
  // 运动滑条的实时读数；急停不设任何前置条件。
  $('station-drive-speed')?.addEventListener('input', (event) => {
    setText('station-drive-speed-out', `${Number(event.target.value).toFixed(2)} m/s`);
  });
  $('station-drive-omega')?.addEventListener('input', (event) => {
    setText('station-drive-omega-out', `${Number(event.target.value).toFixed(1)} rad/s`);
  });
  $('station-drive-duration')?.addEventListener('input', (event) => {
    setText('station-drive-duration-out', `${Number(event.target.value).toFixed(1)} s`);
  });
  $('station-drive-go')?.addEventListener('click', () => {
    void stationSendDrive();
  });
  $('station-drive-stop')?.addEventListener('click', () => {
    void stationEmergencyStop();
  });
  // 策略面板：加载/启动（含确认）/停止/清故障；停止同样无任何前置条件。
  $('station-policy-load')?.addEventListener('click', () => {
    void stationPolicyLoad();
  });
  $('station-policy-start')?.addEventListener('click', () => {
    void stationPolicyStart();
  });
  $('station-policy-stop')?.addEventListener('click', () => {
    void stationPolicyStop();
  });
  $('station-policy-reset')?.addEventListener('click', () => {
    void stationPolicyReset();
  });
  $('station-policy-direction')?.addEventListener('input', (event) => {
    const value = Number(event.target.value);
    setText('station-policy-direction-out', `${value >= 0 ? '+' : ''}${value.toFixed(1)}`);
  });
  wireStationFloatStop();
  // 空格键 = 急停（focus 不在输入控件时）。不限制在 station 页：机器人在动时，
  // 操作者在任何页面（评测页看遥测对照时也一样）都必须能一按就停。
  document.addEventListener('keydown', (event) => {
    const target = event.target;
    const inControl =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement;
    if (event.code === 'Space' && !inControl) {
      event.preventDefault();
      void stationEmergencyStop();
    }
  });
  $('station-log-clear')?.addEventListener('click', () => {
    state.station.log = [];
    $('station-log-list')?.replaceChildren();
  });
  window.addEventListener('pagehide', stationTeardown);
  document.addEventListener('visibilitychange', () => {
    // 切走标签页时停止流与重连；切回时立即重连，避免后台空转和恢复延迟。
    if (document.visibilityState === 'hidden') {
      stationTeardown();
    } else if (state.station.ready) {
      stationStartStatusStream();
    }
  });
}

function wireEvents() {
  document.querySelectorAll('[data-view-target]').forEach((control) => {
    control.addEventListener('click', () => setView(control.dataset.viewTarget));
  });
  window.addEventListener('hashchange', () =>
    setView(window.location.hash.slice(1), { updateHash: false }),
  );
  $('refresh-button')?.addEventListener('click', () => loadOverview());
  $('presentation-toggle')?.addEventListener('click', () => {
    setPresentationMode(!document.body.classList.contains('presentation-mode'));
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && document.body.classList.contains('presentation-mode')) {
      setPresentationMode(false);
    }
  });
  $('robogo-refresh-button')?.addEventListener('click', () => loadOverview());
  $('auth-retry-button')?.addEventListener('click', () => loadOverview());
  document.querySelectorAll('.auth-login-tab').forEach((tab) => {
    tab.addEventListener('click', () => setAuthMethod(tab.dataset.authMethod || 'account'));
  });
  document.querySelectorAll('[data-auth-field] input').forEach((input) => {
    input.addEventListener('input', syncAuthLoginSubmit);
  });
  $('auth-login-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitAuthLogin();
  });
  $('account-pill-logout')?.addEventListener('click', () => {
    void logoutAccount();
  });
  $('task-select')?.addEventListener('change', (event) => {
    const next = event.target.value;
    if (!ACTION_TASKS[next]) return;
    state.taskId = next;
    try {
      window.localStorage?.setItem('rdk-duck-lab-task', next);
    } catch {
      // Preference persistence is optional in file:// and privacy contexts.
    }
    renderAll();
    showToast('当前动作任务：' + ACTION_TASKS[next].label, 'success');
  });
  document.querySelectorAll('[data-record-tab]').forEach((control) => {
    control.addEventListener('click', () => {
      state.recordsTab = control.dataset.recordTab || 'all';
      document.querySelectorAll('[data-record-tab]').forEach((tab) => {
        const active = tab === control;
        tab.classList.toggle('is-active', active);
        tab.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
      renderHistory();
    });
  });
  $('record-search')?.addEventListener('input', (event) => {
    state.recordsQuery = String(event.target.value || '');
    renderHistory();
  });
  $('telemetry-file-input')?.addEventListener('change', importTelemetryFile);
  $('telemetry-demo-button')?.addEventListener('click', () => loadDemoTelemetry());
  $('telemetry-clear-button')?.addEventListener('click', clearTelemetry);
  $('telemetry-publish-button')?.addEventListener('click', () => publishTelemetry());
  $('evaluation-next-button')?.addEventListener('click', (event) => {
    if (event.currentTarget?.dataset.action === 'import-telemetry') {
      event.preventDefault();
      $('telemetry-file-input')?.click();
    }
  });
  $('run-progress-detail')?.addEventListener('click', () => {
    if (state.selectedRecord) openRecordDetails(state.selectedRecord);
  });
  $('run-detail-close')?.addEventListener('click', () => {
    const dialog = $('run-detail-dialog');
    if (dialog?.open && typeof dialog.close === 'function') dialog.close();
    else dialog?.removeAttribute('open');
  });
  $('product-select')?.addEventListener('change', async (event) => {
    const next = event.target.value;
    if (!PRODUCT_PROFILES[next]) return;
    state.productId = next;
    state.selectedModelId = '';
    state.model = null;
    state.compatibility = [];
    state.activeDeployment = null;
    state.telemetry = null;
    try {
      window.localStorage?.setItem('rdk-duck-lab-product', next);
    } catch {
      // Preference persistence is optional in file:// and privacy contexts.
    }
    renderAll();
    await loadOverview({ quiet: true });
    loadManifestTemplate();
    showToast(
      next === 'rdk-duck'
        ? '已切换到 RDK Duck；请导入或填写真实契约 manifest'
        : '已切换到 MicroDuck 官方参考',
      'success',
    );
  });
  $('model-select')?.addEventListener('change', async (event) => {
    state.selectedModelId = event.target.value;
    state.activeDeployment = null;
    state.telemetry = state.telemetry?.modelId === state.selectedModelId ? state.telemetry : null;
    renderAll();
    await loadModelDetails();
  });
  $('device-select')?.addEventListener('change', (event) => {
    state.selectedDeviceId = event.target.value;
    state.activeDeployment = null;
    renderAll();
  });
  $('template-button')?.addEventListener('click', loadManifestTemplate);
  $('manifest-file-input')?.addEventListener('change', importManifestFile);
  $('validate-button')?.addEventListener('click', validateEditor);
  $('register-button')?.addEventListener('click', registerEditor);
  $('contract-run-button')?.addEventListener('click', () => runModel('contract'));
  $('browser-run-button')?.addEventListener('click', () => {
    setView('simulate');
    runModel('browser');
  });
  $('local-run-button')?.addEventListener('click', () => {
    setView('train');
    runModel('local');
  });
  $('robogo-run-button')?.addEventListener('click', () => {
    setView('train');
    const integrations = state.overview?.integrations || {};
    const runnerAvailable = integrations.simulator?.robogo?.available === true;
    const accountReady = integrations.robogo?.state === 'ready';
    const loginRequired = integrations.robogo?.state === 'login_required';
    if (!runnerAvailable) {
      showToast('RoboGo runner 尚未配置；可以先使用本地 Mock 或本地 worker。', 'error');
      return;
    }
    // Aggregate RoboGo resource probes are advisory. In a trusted-proxy
    // deployment the gateway may reserve the short-lived runner token for the
    // explicit POST only, or a read-only inventory endpoint may be degraded
    // while the training runner is healthy. Do not turn that probe result
    // into a client-side hard block: the server re-checks the current account
    // and token immediately before any billable request, and records a
    // blocked run when authorization is absent.
    if (loginRequired) {
      showToast('请先在 RoboGo 完成登录或连接，再发起云端训练。', 'normal');
      window.open('https://robogo.d-robotics.cc', '_blank', 'noopener,noreferrer');
      return;
    }
    if (!accountReady) {
      showToast('RoboGo 资源探测暂不可用，将由服务端再次校验当前账号授权后提交。', 'normal');
    }
    void confirmRobogoRun().then((approved) => {
      if (approved) runModel('robogo');
    });
  });
  $('notify-toggle')?.addEventListener('click', () => {
    void toggleNotifyPreference();
  });
  $('confirm-run-cancel')?.addEventListener('click', () => settleConfirmRun(false));
  $('confirm-run-approve')?.addEventListener('click', () => settleConfirmRun(true));
  const confirmRunDialog = $('confirm-run-dialog');
  confirmRunDialog?.addEventListener('cancel', (event) => {
    event.preventDefault();
    settleConfirmRun(false);
  });
  confirmRunDialog?.addEventListener('close', () => {
    // Guard against a settleConfirmRun no-op path leaving a dangling promise
    // (e.g. a programmatic close from elsewhere in the page).
    if (state.confirmRunResolve) settleConfirmRun(false);
  });
  $('detect-button')?.addEventListener('click', () => {
    setView('deploy');
    detectBoard();
  });
  $('plan-button')?.addEventListener('click', () => {
    setView('deploy');
    createPlan();
  });
  $('preflight-button')?.addEventListener('click', () => {
    setView('deploy');
    executePreflight();
  });
  wireStationEvents();
}

wireEvents();
setPresentationMode(readPresentationPreference(), { persist: false });
syncNotifyToggle();
setView(window.location.hash.slice(1) || 'overview', { updateHash: false });
// Render the product boundary immediately, even while the account-scoped
// overview request is still loading (important when RDK Duck was selected in
// a previous session).
renderAll();
// Seed the editor silently on first paint; a toast here obscures the first
// presentation frame before the operator has taken an action.
loadManifestTemplate({ notify: false });
loadOverview();
// 上位机视图懒初始化：首次切到 station 视图时再探测板端 agent，
// 避免无板卡环境下的多余请求与误导性错误横幅。
const stationViewObserver = new MutationObserver(() => {
  stationMaybeInit();
});
stationViewObserver.observe(document.body, {
  attributes: true,
  attributeFilter: ['data-active-view'],
  subtree: false,
});
// 直接以 #station 打开（刷新或书签）时 setView 在 observer 注册之前就已执行，
// 不会产生属性变更事件，这里必须补一次同步检查，否则上位机永不初始化。
stationMaybeInit();

function stationMaybeInit() {
  const section = document.querySelector('[data-view-section="station"]');
  if (section && !section.hidden && !state.station.initialized) {
    state.station.initialized = true;
    stationInit();
  }
}
