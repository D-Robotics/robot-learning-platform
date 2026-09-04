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
    const value = window.localStorage?.getItem('rdk-duck-lab-task');
    return value && ACTION_TASKS[value] ? value : 'walk';
  } catch {
    return 'walk';
  }
}

function readProductPreference() {
  try {
    const value = window.localStorage?.getItem('rdk-duck-lab-product');
    return value && PRODUCT_PROFILES[value] ? value : 'microduck';
  } catch {
    return 'microduck';
  }
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
  authRequired: false,
  authNoticeShown: false,
  productId: readProductPreference(),
  taskId: readTaskPreference(),
  recordsTab: 'all',
  recordsQuery: '',
  selectedRecord: null,
  telemetry: null,
  publishingTelemetry: false,
  runSubmitting: false,
  deploymentSubmitting: false,
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

function setAuthGate(payload) {
  state.authRequired = true;
  const loginUrl = safeLoginUrl(
    payload && typeof payload === 'object' && typeof payload.ssoLoginUrl === 'string'
      ? payload.ssoLoginUrl
      : '/rdkstudio/',
  );
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
  if (!state.authNoticeShown) {
    state.authNoticeShown = true;
    showToast('请先登录 RDK Studio，再加载你的 Sim2Real 工作区。', 'error');
  }
}

function clearAuthGate() {
  state.authRequired = false;
  state.authNoticeShown = false;
  $('auth-gate')?.setAttribute('hidden', '');
  $('login-link')?.setAttribute('hidden', '');
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
  $('refresh-button')?.toggleAttribute('disabled', value);
}

const WORKFLOW_VIEWS = [
  'overview',
  'contract',
  'simulate',
  'train',
  'evaluate',
  'deploy',
  'records',
];

function setView(view, { updateHash = true } = {}) {
  const wanted = WORKFLOW_VIEWS.includes(view) ? view : 'overview';
  document.querySelectorAll('[data-view-section]').forEach((section) => {
    section.hidden = section.dataset.viewSection !== wanted;
  });
  document.querySelectorAll('[data-view-target]').forEach((control) => {
    const active = control.dataset.viewTarget === wanted;
    const isNavigationControl =
      control.classList.contains('nav-item') ||
      control.classList.contains('module-item') ||
      control.classList.contains('workflow-node');
    control.classList.toggle('is-active', active && isNavigationControl);
    if (
      control.classList.contains('nav-item') ||
      control.classList.contains('module-item') ||
      control.classList.contains('workflow-node')
    ) {
      if (active) control.setAttribute('aria-current', 'page');
      else control.removeAttribute('aria-current');
    }
  });
  if (updateHash && window.location.hash !== '#' + wanted) {
    window.history.replaceState(
      null,
      '',
      window.location.pathname + window.location.search + '#' + wanted,
    );
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
  if (['ready', 'completed', 'planned', 'success'].includes(normalized)) return 'state-success';
  if (['blocked', 'queued', 'partial', 'running'].includes(normalized)) return 'state-partial';
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
  setText('model-count', models.length + ' 个' + selectedProductProfile().displayName + '模型');
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
  // MicroDuck's entry is a bundled read-only asset, so keep it visible while
  // the account-scoped overview is loading. A server-side `available: false`
  // still wins; RDK Duck has no path and therefore remains gated.
  const browserAvailable = Boolean(profile.simulatorPath) && simulator.browser?.available !== false;
  setText('service-status', '独立服务在线');
  const accountStatus = $('account-status');
  const accountDivider = $('account-divider');
  if (accountStatus && accountDivider) {
    const accountLabel = identity?.displayName || identity?.accountId || '';
    accountStatus.hidden = !accountLabel;
    accountDivider.hidden = !accountLabel;
    accountStatus.textContent = accountLabel ? '账号 · ' + accountLabel : '';
    accountStatus.title = identity?.email || identity?.accountId || '';
  }
  setText('current-project-name', profile.projectName);
  setText('sidebar-product-name', profile.displayName);
  setText('sidebar-kit-name', profile.kitName);
  setText(
    'hero-contract-id',
    model?.manifest?.contract?.id || profile.contractId || '等待 manifest',
  );
  setText('hero-updated', '最后刷新 ' + formatDate(new Date().toISOString()));
  setText(
    'status-simulator',
    browserAvailable ? '浏览器 MicroDuck' : profile.displayName + '仿真适配器',
  );
  setText(
    'status-simulator-detail',
    browserAvailable ? '固定官方参考策略' : '当前产品线等待仿真适配器',
  );
  const robogoRunnerAvailable = simulator.robogo?.available === true;
  const robogoAccountReady = robogo.state === 'ready';
  const robogoLoginRequired = robogo.state === 'login_required';
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
    local.available ? (local.mock ? '运行 Mock 流程' : '发起本地训练') : '登记本地训练',
  );
  setText(
    'status-robogo',
    local.available
      ? local.mock
        ? '本地 Mock 已连接'
        : '本地训练已连接'
      : robogo.state === 'ready'
        ? 'RoboGo 已连接'
        : robogo.state === 'login_required'
          ? '登录后连接 RoboGo'
          : '本地 / RoboGo 未配置',
  );
  setText(
    'status-robogo-detail',
    local.available ? local.reason : robogo.message || local.reason || '只读读取训练资源',
  );
  setText('status-storage', storage.writable ? '台账可写' : '需要共享存储');
  setText('status-storage-card', storage.writable ? '台账可写' : '需要共享存储');
  setText('status-storage-detail', storage.message || '状态按账号隔离');
  $('browser-run-button')?.toggleAttribute('disabled', state.runSubmitting || !model || !browserAvailable);
  $('browser-run-button')?.setAttribute(
    'title',
    !browserAvailable ? '当前产品线尚未配置浏览器仿真适配器' : model ? '' : '请先选择模型',
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
      state.deploymentSubmitting || !state.activeDeployment || boardAgent.available !== true;
    preflightButton.title =
      boardAgent.reason || '先生成预检计划，并在部署环境接入 BoardAgent';
  }
  for (const id of ['contract-run-button', 'local-run-button', 'robogo-run-button']) {
    $(id)?.toggleAttribute('disabled', state.runSubmitting || !model);
  }
  const simulatorFrame = $('simulator-frame');
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
    if (link && link.getAttribute('href') !== browserEntry) link.setAttribute('href', browserEntry);
  }
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
  if (simulatorFallback) simulatorFallback.hidden = !browserAvailable;
  if (simulatorProductGate) simulatorProductGate.hidden = browserAvailable;
  setText(
    'simulator-run-status',
    browserAvailable ? '参考策略可用' : profile.displayName + '浏览器仿真适配器待配置',
  );
  const device = selectedDevice();
  setText('status-board', device ? device.boardPlatform || '待探测板型' : '尚未选择板卡');
  setText('status-board-detail', device ? device.status || '设备状态未知' : '连接后进行板端预检');

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
  setText('robogo-board-count', robogo.availableBoardCount ?? '—');
  setText('robogo-machine-count', robogo.developmentMachineCount ?? '—');
  setText(
    'robogo-message',
    local.available ? local.reason : robogo.message || '本地 / RoboGo 训练后端不可用',
  );
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
  summary.innerHTML =
    '<div class="board-summary-row"><strong>' +
    escapeHtml(device.name || device.id) +
    '</strong><span class="board-chip">' +
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
    row.innerHTML =
      '<span class="history-time">' +
      escapeHtml(formatDate(record.createdAt)) +
      '</span><span class="history-kind">' +
      escapeHtml(record.kind) +
      '</span><span class="history-summary">' +
      escapeHtml(record.summary || record.modelId || '') +
      '</span><span class="history-status history-status-' +
      escapeHtml(status) +
      '">' +
      escapeHtml(statusLabel(status)) +
      '</span>';
    row.addEventListener('click', () => openRecordDetails(record));
    root.append(row);
  }
}

function openRecordDetails(record) {
  const dialog = $('run-detail-dialog');
  const body = $('run-detail-body');
  if (!dialog || !body) return;
  const isRun = record.recordType === 'run';
  const isArtifact = record.recordType === 'artifact';
  const isTelemetry = record.recordType === 'telemetry';
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
    ['状态', statusLabel(record.status)],
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
      ? [['时长', record.telemetrySummary.durationSeconds.toFixed(2) + 's']]
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
    (isRun && record.checkpoint
      ? '<div><span class="card-kicker">CHECKPOINT</span><pre class="run-detail-code">' +
        escapeHtml(JSON.stringify(record.checkpoint, null, 2)) +
        '</pre></div>'
      : '') +
    (isRun && record.metrics
      ? '<div><span class="card-kicker">METRICS</span><pre class="run-detail-code">' +
        escapeHtml(JSON.stringify(record.metrics, null, 2)) +
        '</pre></div>'
      : '') +
    (isArtifact
      ? '<div><span class="card-kicker">ARTIFACT METADATA</span><pre class="run-detail-code">' +
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
      ? '<div><span class="card-kicker">TELEMETRY SUMMARY</span><pre class="run-detail-code">' +
        escapeHtml(JSON.stringify(record.telemetrySummary || {}, null, 2)) +
        '</pre></div>'
      : '') +
    (isRun && record.mock === true
      ? '<div class="run-progress-warning">Mock 仅验证协议与台账，不能部署到真实设备。</div>'
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

function renderTelemetryEvidence() {
  const root = $('telemetry-summary');
  const stateBadge = $('telemetry-state');
  const timeline = $('telemetry-timeline');
  const clear = $('telemetry-clear-button');
  const publish = $('telemetry-publish-button');
  if (!root || !stateBadge || !timeline || !clear) return;
  const evidence = currentTelemetry();
  if (!evidence) {
    stateBadge.className = 'state-badge state-neutral';
    stateBadge.textContent = '尚未导入';
    root.innerHTML =
      '<div class="empty-inline">等待导入遥测；训练完成后可用它做仿真 / 真机对照。</div>';
    timeline.hidden = true;
    clear.disabled = true;
    if (publish) publish.disabled = true;
    return;
  }
  const summary = evidence.summary;
  const latest = latestRun();
  const evaluation =
    latest?.evaluation && evidence.publishedRunId === latest.id ? latest.evaluation : null;
  stateBadge.className = 'state-badge ' + (evidence.skipped ? 'state-partial' : 'state-success');
  stateBadge.textContent = evaluation
    ? '已上传 · 已评测'
    : evidence.skipped
      ? '已导入 · 有跳过'
      : '已导入';
  const stats = [
    ['样本数', summary.sampleCount],
    ['时长', summary.durationSeconds.toFixed(2) + 's'],
    ['采样率', summary.sampleRateHz ? summary.sampleRateHz + 'Hz' : '—'],
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
  timeline.hidden = false;
  setText('telemetry-timeline-start', summary.firstTimestamp.toFixed(2) + 's');
  setText('telemetry-timeline-end', summary.lastTimestamp.toFixed(2) + 's');
  clear.disabled = false;
  if (publish) {
    publish.disabled = state.publishingTelemetry || !latestRun();
    publish.textContent = state.publishingTelemetry ? '上传中…' : '上传到当前 Run 并评测';
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
    const basePayload = {
      source: 'import',
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
    const detail = evaluation?.replay?.sampleCount
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
  const statusLabel =
    status === 'completed'
      ? '评测已完成'
      : status === 'running'
        ? '评测进行中'
        : status === 'failed'
          ? '评测失败'
          : latest
            ? '等待评测结果'
            : evidence
              ? '已导入遥测证据'
              : '尚未产生评测结果';
  setText('eval-run-status', statusLabel);
  setText(
    'eval-run-name',
    latest
      ? (latest.summary || latest.modelId || '最新运行') + ' · ' + (latest.backend || 'unknown')
      : evidence
        ? evidence.fileName + ' · 本地聚合，可继续绑定到正式 Run'
        : '训练完成后，这里会显示最新一次运行的仿真/真机指标。',
  );
  setText(
    'eval-contract',
    metrics.contractValid === true ? '通过' : metrics.contractValid === false ? '失败' : '—',
  );
  const success = metricPercent(metrics.successRate);
  const fall = metricPercent(metrics.fallRate);
  setText('eval-success', success === null ? '—' : success + '%');
  setText('eval-fall', fall === null ? '—' : fall + '%');
  setText(
    'eval-latency',
    typeof metrics.controlLatencyMs === 'number' ? metrics.controlLatencyMs + 'ms' : '—',
  );

  const simPercent = latest?.backend === 'browser' ? success : null;
  const realPercent = latest && latest.backend !== 'browser' ? success : null;
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
    mark.textContent =
      status === 'completed' ? '✓' : status === 'failed' ? '!' : evidence ? '↗' : '○';
    mark.className =
      'evaluation-status-mark ' +
      (status === 'completed' || evidence
        ? 'is-success'
        : status === 'failed'
          ? 'is-error'
          : '');
  }
}

function renderNextAction() {
  const evidence = currentTelemetry();
  const model = selectedModel();
  const runs = [...runsForCurrentModel()].sort((a, b) =>
    String(b.createdAt || '').localeCompare(String(a.createdAt || '')),
  );
  const latest = runs[0] || null;
  const hasEvaluation = Boolean(latest?.metrics && typeof latest.metrics.successRate === 'number');
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
    view = 'evaluate';
    title = '训练完成，先看评测证据';
    copy = '确认契约、成功率、跌倒率和控制延迟，再决定是否生成 X5 预检计划。';
    label = '进入评测中心 →';
  } else if (evidence && !hasEvaluation) {
    view = 'evaluate';
    title = '遥测已导入，检查虚实差异';
    copy = '当前是浏览器本地聚合证据；先确认采样率和跌倒事件，再绑定到一次正式运行或继续训练。';
    label = '查看遥测证据 →';
  } else if (hasEvaluation && !deployments.length) {
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
  setText('next-action-copy', copy);
  const button = $('next-action-button');
  if (button) {
    button.dataset.viewTarget = view;
    button.textContent = label;
  }
}

function renderEvaluationNext() {
  const title = $('evaluation-next-title');
  const copy = $('evaluation-next-copy');
  const button = $('evaluation-next-button');
  const line = $('evaluation-next-line');
  if (!title || !copy || !button || !line) return;
  const evidence = currentTelemetry();
  const latest = [...runsForCurrentModel()].sort((a, b) =>
    String(b.createdAt || '').localeCompare(String(a.createdAt || '')),
  )[0];
  const hasMetrics = Boolean(latest?.metrics && typeof latest.metrics.successRate === 'number');
  if (!selectedModel()) {
    title.textContent = '下一步：先登记模型契约';
    copy.textContent = '没有模型和契约，平台不会接受遥测或生成 X5 预检计划。';
    button.textContent = '去登记契约 →';
    button.dataset.viewTarget = 'contract';
    delete button.dataset.action;
    line.style.background = 'var(--orange)';
    return;
  }
  if (latest && ['queued', 'running'].includes(String(latest.status))) {
    title.textContent = '下一步：等待训练完成';
    copy.textContent = '训练任务仍在运行，平台会自动刷新状态；完成后再导入或查看评测证据。';
    button.textContent = '查看训练任务 →';
    button.dataset.viewTarget = 'train';
    delete button.dataset.action;
    line.style.background = 'var(--cyan)';
    return;
  }
  if (latest?.status === 'failed') {
    title.textContent = '下一步：处理失败任务';
    copy.textContent = latest.summary || '修复契约或训练后端后再重试，失败任务不会自动重试。';
    button.textContent = '回到训练中心 →';
    button.dataset.viewTarget = 'train';
    delete button.dataset.action;
    line.style.background = 'var(--red)';
    return;
  }
  if (hasMetrics || evidence) {
    title.textContent = '下一步：生成 X5 只读预检计划';
    copy.textContent = evidence
      ? '遥测已在浏览器本地聚合；正式发布仍需要绑定 Run、选择板卡并执行只读预检。'
      : '评测指标已回写；选择目标 X5 后先执行只读预检，Canary 和 Live 仍需板端 Agent。';
    button.textContent = '去做设备预检 →';
    button.dataset.viewTarget = 'deploy';
    delete button.dataset.action;
    line.style.background = 'var(--green)';
    return;
  }
  title.textContent = '下一步：导入一段遥测证据';
  copy.textContent =
    '支持 MicroDuck 浏览器录制或 X5 Board Agent JSONL；数据只在本地聚合，不会伪造评测指标。';
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
  const evidenceReady = Boolean(
    currentTelemetry() || (latest?.metrics && typeof latest.metrics.successRate === 'number'),
  );
  const preflightReady = Boolean(deployment && ['ready', 'completed'].includes(deployment.status));
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
    preflightReady ? 'ready' : evidenceReady ? 'current' : 'blocked',
    preflightReady
      ? '预检已通过'
      : evidenceReady
        ? '选择板卡并生成只读计划'
        : '需要评测指标或遥测证据',
  );
  update('canary', 'blocked', '需要 X5 Board Agent；网页不会直接开电机');
  update('live', 'locked', '人工批准后开放');
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
  state.selectedRecord = latest;
  setText('run-progress-title', latest.summary || latest.modelId || '最新运行');
  const status = $('run-progress-status');
  if (status) {
    status.className = 'state-badge ' + stateClass(latest.status);
    status.textContent = statusLabel(latest.status);
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
  const telemetry = evidence
    ? [
        {
          id: 'telemetry:' + evidence.fileName,
          recordType: 'telemetry',
          kind: 'telemetry · import',
          status: 'registered',
          summary: evidence.fileName || '本地遥测证据',
          source: evidence.source,
          createdAt: new Date().toISOString(),
          telemetrySummary: evidence.summary,
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
  renderModel();
  renderActionLibrary();
  renderBoard();
  renderEvaluation();
  renderHistory();
  renderRunProgress();
  renderNextAction();
  renderEvaluationNext();
  renderReleaseGate();
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
  state.overview = {
    ...state.overview,
    runs: state.overview.runs.map((run) => byId.get(run.id) || run),
  };
}

async function loadOverview({ quiet = false } = {}) {
  if (state.loading) return;
  setLoading(true);
  try {
    const payload = await request(
      '/sim2real/overview?productId=' + encodeURIComponent(state.productId),
    );
    state.overview = payload;
    state.productProfiles = Array.isArray(payload.productProfiles) ? payload.productProfiles : null;
    clearAuthGate();
    await refreshActiveRuns();
    renderAll();
    await loadModelDetails();
    setText('hero-updated', '最后刷新 ' + formatDate(new Date().toISOString()));
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401) && !quiet) {
      showToast(error instanceof Error ? error.message : '工作台加载失败', 'error');
    }
    setText(
      'service-status',
      error instanceof ApiError && error.status === 401 ? '需要登录' : '服务不可用',
    );
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

function loadManifestTemplate() {
  const profile = selectedProductProfile();
  if (profile.id === 'rdk-duck') {
    const template = {
      schemaVersion: 1,
      modelId: 'my-rdk-duck-policy',
      displayName: '我的 RDK Duck 策略',
      version: '0.1.0',
      robot: { id: 'rdk-duck', variant: 'x5-kit' },
      contract: {
        id: 'rdk-duck-policy-v1',
        robotId: 'rdk-duck',
        jointCount: 0,
        observationSize: 0,
        actionSize: 0,
        controlHz: 0,
        physicsTimestepSeconds: 0,
        decimation: 0,
        observationLayout: [],
      },
      simulator: {
        backends: ['local'],
        policyArtifactId: 'policy-onnx',
        policyBundle: {
          defaultPolicyId: 'walking',
          policies: [{ id: 'walking', label: '行走', artifactId: 'policy-onnx' }],
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
        notes: '请替换 contract 中的真实观测/动作定义、频率和 layout；平台不会猜测 RDK Duck 契约。',
      },
    };
    $('manifest-editor').value = JSON.stringify(template, null, 2);
    showToast('已载入 RDK Duck manifest 模板；请填入真实契约后校验');
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
  showToast('已载入 manifest 模板');
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

function wireEvents() {
  document.querySelectorAll('[data-view-target]').forEach((control) => {
    control.addEventListener('click', () => setView(control.dataset.viewTarget));
  });
  window.addEventListener('hashchange', () =>
    setView(window.location.hash.slice(1), { updateHash: false }),
  );
  $('refresh-button')?.addEventListener('click', () => loadOverview());
  $('robogo-refresh-button')?.addEventListener('click', () => loadOverview());
  $('auth-retry-button')?.addEventListener('click', () => loadOverview());
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
        tab.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      renderHistory();
    });
  });
  $('record-search')?.addEventListener('input', (event) => {
    state.recordsQuery = String(event.target.value || '');
    renderHistory();
  });
  $('telemetry-file-input')?.addEventListener('change', importTelemetryFile);
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
    runModel('robogo');
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
}

wireEvents();
setView(window.location.hash.slice(1) || 'overview', { updateHash: false });
// Render the product boundary immediately, even while the account-scoped
// overview request is still loading (important when RDK Duck was selected in
// a previous session).
renderAll();
loadManifestTemplate();
loadOverview();
