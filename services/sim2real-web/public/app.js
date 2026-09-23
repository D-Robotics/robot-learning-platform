const CONTRACT_ID = 'microduck-policy-v1';
const SIMULATOR_PATH = '/mujoco/microduck/';
// Keep manifest imports aligned with the server's 2 MiB JSON body limit. The
// telemetry limit is owned by telemetry-core.js so the parser and file reader
// cannot drift apart.
const MAX_MANIFEST_IMPORT_BYTES = 2 * 1024 * 1024;
const BASE_PATH = (() => {
  const configured =
    typeof document !== 'undefined'
      ? document.querySelector('meta[name="rdk-sim2real-base-path"]')?.getAttribute('content')
      : '';
  if (configured && configured !== '__RDK_SIM2REAL_BASE_PATH__') {
    const normalized = String(configured).trim().replace(/\/+$/, '');
    if (/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(normalized)) return normalized;
    if (!normalized) return '';
  }
  // File:// demos and older cached HTML keep the historical heuristic as a
  // compatibility fallback.
  return window.location.pathname.startsWith('/sim2real') ? '/sim2real' : '';
})();

function appRelativePath(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.startsWith('//') || /^https?:\/\//i.test(raw)) return raw;
  if (BASE_PATH && (raw.startsWith('/mujoco/') || raw.startsWith('/originbot-sim/'))) return BASE_PATH + raw;
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
  originbot: {
    id: 'originbot',
    displayName: 'OriginBot',
    projectName: 'OriginBot · X5 Mobile',
    kitName: 'RDK X5 + OriginBot',
    contractId: 'originbot-policy-v1',
    simulatorPath: '/originbot-sim/',
  },
  'rdk-duck': {
    id: 'rdk-duck',
    displayName: 'RDK Duck',
    projectName: 'RDK Duck · X5 Product',
    kitName: 'RDK X5 + 配件套件',
    contractId: 'rdk-duck-policy-v1',
    simulatorPath: '',
  },
  custom: {
    id: 'custom',
    displayName: '通用 RDK 设备',
    projectName: '通用 RDK 设备 · 自定义契约',
    kitName: '任意 RDK 板卡 + 差速底盘/自定义执行器',
    contractId: 'custom-policy-v1',
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
  'balance-basketball': { label: '篮球平衡 · 循环策略', hint: '鸭子立于滚球，LSTM 从姿态历史推断球运动', scene: '滚球平衡' },
  'balance-stilts': { label: '高跷平衡 · 循环策略', hint: '固定枢轴双杆高跷，质量随高度联动', scene: '双杆高跷' },
  'football-single-goal-kick': { label: '足球：单鸭射门', hint: 'MuJoCo 单鸭追球并把球踢入球门', scene: '1 鸭 · 单球门' },
  'football-2v2': { label: '足球：2v2', hint: '双鸭协作、对手脚本与共享进球奖励', scene: '4 鸭 · 双方各 2 · 双球门' },
  'football-3v3': { label: '足球：3v3', hint: '三鸭协作、多智能体比赛与 GPU 并行训练', scene: '6 鸭 · 双方各 3 · 双球门 · GPU 并行' },
  custom: { label: '自定义动作', hint: '使用自己的策略包' },
  'goal-navigation': { label: '目标导航', hint: '基于 odom/IMU 的目标点导航' },
  'visual-twist': { label: '视觉跟随', hint: '相机观测到线速度/角速度' },
  'data-collection': { label: '数据采集', hint: '同步记录图像、状态和动作' },
});

const ORIGINBOT_TASK_IDS = Object.freeze(['goal-navigation', 'visual-twist', 'data-collection', 'custom']);

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

function readNotifyPreference() {
  try {
    return window.localStorage?.getItem('rdk-duck-lab-notify') === '1';
  } catch {
    return false;
  }
}

const WORKSPACE_PREF_KEY = 'rdk-duck-lab-workspace-context';

function readWorkspacePreference(field) {
  try {
    const raw = window.localStorage?.getItem(WORKSPACE_PREF_KEY);
    if (!raw) return '';
    const parsed = JSON.parse(raw);
    return typeof parsed?.[field] === 'string' ? parsed[field].trim() : '';
  } catch {
    return '';
  }
}

// Project selection is a workspace preference, while the project records
// themselves remain account-scoped on the server.  Keep only the opaque id in
// local storage so a renamed project or a different account cannot leak stale
// labels into the first paint; renderProjectContext() validates it against the
// freshly loaded project list before showing it as selected.
function readProjectPreference() {
  return readWorkspacePreference('projectId');
}

// The terminal/active status vocabularies live in telemetry-core.js; app.js
// only keeps the delegation seam so call sites stay unchanged.
function isTerminalRunStatus(status) {
  return SimTelemetryCore.isTerminalRunStatus(status);
}

function isActiveRunStatus(status) {
  return SimTelemetryCore.isActiveRunStatus(status);
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
  // role="menuitemcheckbox" 只认 aria-checked；aria-pressed 在这个 role 上是
  // 无效属性，会让读屏报出两种互相矛盾的开关状态。（HTML 里已去掉，这里也
  // 必须去掉，否则 JS 每次同步都会把它加回来。）
  button.setAttribute('aria-checked', state.notifyEnabled ? 'true' : 'false');
  button.classList.toggle('is-active', granted);
}

/* Theme toggle: theme-boot.js (first script in <head>, CSP-safe external)
   resolves the initial theme (stored → OS → dark) before first paint. This
   module owns the toggle button face, persistence, and live OS-preference
   tracking once the user has an explicit choice. The theme class lives on
   <html> only — every theme-dark CSS rule is scoped from there, so one
   flip retints the whole app. */
const THEME_STORAGE_KEY = 'rdk-lab-theme';

function currentTheme() {
  return document.documentElement.classList.contains('theme-dark') ? 'dark' : 'light';
}

function applyTheme(theme) {
  document.documentElement.classList.toggle('theme-dark', theme === 'dark');
}

function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try {
    window.localStorage?.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // Storage may be unavailable (private mode); the in-session toggle still works.
  }
  syncThemeToggle();
}

function syncThemeToggle() {
  const button = $('theme-toggle');
  if (!button) return;
  const dark = currentTheme() === 'dark';
  // 图标字形对读屏是噪音（按钮本身已有 aria-label）。用 aria-hidden 的
  // 子节点承载字形，而不是把字形写成按钮的 textContent。
  button.replaceChildren();
  const glyph = document.createElement('span');
  glyph.setAttribute('aria-hidden', 'true');
  glyph.textContent = dark ? '☀' : '☾';
  button.append(glyph);
  button.setAttribute('aria-pressed', dark ? 'true' : 'false');
  button.setAttribute('aria-label', dark ? '切换到浅色主题' : '切换到深色主题');
  button.title = dark ? '切换到浅色主题' : '切换到深色主题';
}

/* Follow OS theme changes only while the user has no stored preference, so
   an explicit choice is never overridden by a system settings flip. */
function wireThemeSystemTracking() {
  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  if (!media?.addEventListener) return;
  media.addEventListener('change', (event) => {
    let hasStored = false;
    try {
      hasStored = Boolean(window.localStorage?.getItem(THEME_STORAGE_KEY));
    } catch {
      hasStored = false;
    }
    if (hasStored) return;
    applyTheme(event.matches ? 'dark' : 'light');
    syncThemeToggle();
  });
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
  const project = selectedProject();
  let backendLabel = '检查中';
  if (state.authRequired) backendLabel = '游客模式（可直接仿真）';
  else if (state.serviceError) backendLabel = '服务不可用';
  else if (robogo.state === 'ready') backendLabel = 'RoboGo 就绪';
  else if (localRunner.available === true && localRunner.healthy === true) backendLabel = '本地就绪';
  else if (localRunner.available === true) backendLabel = '本地已配置';
  setText(
    'context-live-project',
    project
      ? projectDisplayName(project)
      : state.authRequired
        ? '游客模式'
        : state.projectsLoaded && state.projects?.length
          ? '全部项目'
          : '检查中',
  );
  const activeView = document.body.dataset.activeView || 'overview';
  const stageLabel = flowStageLabel(activeView);
  setText('context-live-stage', stageLabel);
  // 浏览器标签页标题跟随位置：11 个流程子项共用 8 个视图，若标题固定，
  // 多开标签页时无法分辨各自停在哪个节点。
  document.title = `${stageLabel} · RDK Robot Learning Platform`;
  setText(
    'context-live-model',
    model ? modelLabel(model) : (state.overview?.models?.length ? '未选择' : '暂无模型'),
  );
  setText(
    'context-live-task',
    selectedTask().label,
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
  // Guest fallback: the public healthz payload (simulator surface, login
  // mode) so logged-out visitors still learn whether the browser simulator
  // is playable before they decide to sign in.
  publicHealth: null,
  // Workspace notices (G18): the platform version seen at first paint; a
  // later fetch that disagrees upgrades the version notice into a reload
  // CTA instead of a forced refresh.
  noticeFirstVersion: null,
  workspaceSummary: null,
  // Server-derived RDK Golden Path read model. The UI may render a fallback
  // while older gateways are upgrading, but never invents a second persisted
  // workflow state when this payload is available.
  goldenPath: null,
  projects: [],
  projectsLoaded: false,
  projectsLoadError: false,
  datasets: [],
  datasetsLoaded: false,
  productProfiles: null,
  model: null,
  compatibility: [],
  validation: null,
  selectedModelId: readWorkspacePreference('modelId'),
  selectedDeviceId: readWorkspacePreference('deviceId'),
  selectedComputeResourceId: '',
  computeResourceEditingId: '',
  activeDeployment: null,
  loading: false,
  serviceError: false,
  authRequired: false,
  authNoticeShown: false,
  productId: readProductPreference(),
  taskId: readTaskPreference(),
  projectId: readProjectPreference(),
  notifyEnabled: readNotifyPreference(),
  notifiedRunIds: new Set(),
  // Engine log stream (run progress card): worker line ring cursor + the
  // lines already rendered. One run at a time — the run the card shows.
  runLogs: { runId: null, cursor: 0, lines: [], inFlight: false, terminalDone: null },
  confirmActionResolve: null,
  recordsTab: 'all',
  evalModule: 'run',
  deployModule: 'preflight',
  trainModule: (() => {
    try {
      const value = window.localStorage?.getItem('rdk-lab-train-module');
      return ['run', 'contract', 'config', 'resources'].includes(value) ? value : 'run';
    } catch {
      return 'run';
    }
  })(),
  // Explicit preference (Amershi G13): the last training profile the operator
  // actually used, restored on load and visibly labeled as pre-selected —
  // never applied silently, always one click to change.
  trainingProfile: (() => {
    const value = readWorkspacePreference('trainingProfile');
    return ['smoke', 'low-vram', 'standard', 'high-vram'].includes(value) ? value : '';
  })(),
  recordsQuery: '',
  selectedRecord: null,
  telemetry: null,
  replay: { runId: '', frames: [], index: 0, timer: null, speed: 1, loaded: false },
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
    offline: false,
    offlineReason: '',
    mock: false,
    device: null,
    statusReader: null,
    streamAbort: null,
    streamReconnectAttempts: 0,
    streamReconnectTimer: null,
    cameraOn: false,
    log: [],
    deviceManagerWired: false,
    switchWired: false,
  },
};

function saveWorkspaceContext() {
  try {
    window.localStorage?.setItem(
      WORKSPACE_PREF_KEY,
      JSON.stringify({
        productId: state.productId,
        taskId: state.taskId,
        projectId: state.projectId,
        modelId: state.selectedModelId,
        deviceId: state.selectedDeviceId,
        trainingProfile: state.trainingProfile,
        savedAt: new Date().toISOString(),
      }),
    );
  } catch {
    // Local persistence is best-effort in private browsing contexts.
  }
}

function workspaceSummaryData() {
  // The summary endpoint is account scoped, while the Studio workspace is
  // product scoped. Derive the visible totals from the already filtered
  // overview payload so switching MicroDuck / RDK Duck cannot surface a run
  // or deployment belonging to another robot.
  const modelIds = currentModelIds();
  const allRuns = state.overview?.runs || [];
  const allDeployments = state.overview?.deployments || [];
  const runs = allRuns.filter((run) => modelIds.has(run.modelId) && projectIncludesRecord(run));
  const deployments = allDeployments.filter(
    (deployment) => modelIds.has(deployment.modelId) && projectIncludesRecord(deployment),
  );
  const latestRun = runs.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0] || null;
  const latestDeployment = deployments.slice().sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))[0] || null;
  const productModels = (state.overview?.models || []).filter(
    (model) =>
      model.manifest?.robot?.id === state.productId &&
      (!projectModelIds() || projectModelIds().has(String(model.id))),
  );
  const linkedDatasetIds = projectDatasetIds();
  const datasets = (state.datasets || []).filter(
    (dataset) =>
      (!linkedDatasetIds || linkedDatasetIds.has(String(dataset.id))) &&
      (!dataset.modelId || modelIds.has(dataset.modelId)),
  );
  return {
    counts: {
      models: productModels.length,
      runs: runs.length,
      activeRuns: runs.filter((run) => isActiveRunStatus(run.status)).length,
      deployments: deployments.length,
      activeDeployments: deployments.filter((item) => ['planned', 'running'].includes(String(item.status || '').toLowerCase())).length,
      devices: state.overview?.devices?.length || 0,
      connectedDevices: (state.overview?.devices || []).filter((device) => device.status === 'connected').length,
    },
    latestRun,
    latestDeployment,
    datasets,
  };
}

function renderPlatformScorecard() {
  const grid = $('platform-scorecard-grid');
  const total = $('platform-score-total');
  if (!grid || !total) return;
  // Guests have no account-scoped evidence, so a numeric score would read as
  // "the platform is broken". Show an explicit sign-in placeholder instead.
  if (state.authRequired && !state.overview) {
    total.textContent = '未评估';
    grid.replaceChildren();
    const item = document.createElement('article');
    item.className = 'platform-score-item';
    item.dataset.state = 'guest';
    item.style.gridColumn = '1 / -1';
    const title = document.createElement('strong');
    title.textContent = '登录后评估';
    const copy = document.createElement('span');
    copy.textContent = '评分依据账号内的契约、训练、评测与发布证据；仿真试玩不受影响。';
    item.append(title, copy);
    grid.append(item);
    const guestNote = $('platform-scorecard-note');
    if (guestNote) guestNote.textContent = '登录后即可开始累计软件门槛评分。';
    return;
  }
  const model = selectedModel();
  const telemetry = currentTelemetry();
  const runs = runsForCurrentModel();
  const deployments = deploymentsForCurrentModel();
  const latestRun = runs.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];
  const latestDeployment = deployments.slice().sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))[0];
  const local = state.overview?.integrations?.simulator?.local || {};
  const robogo = state.overview?.integrations?.robogo || {};
  const hasContract = Boolean(model?.manifest?.contract?.id);
  const hasArtifact = Boolean(model?.manifest?.artifacts?.some((artifact) => artifact?.ref));
  const contractState = hasContract && hasArtifact ? 'ready' : model ? 'partial' : 'blocked';
  const trainingComplete = Boolean(
    latestRun && ['completed', 'ready'].includes(String(latestRun.status || '').toLowerCase()),
  );
  const trainingConfigured = Boolean(
    latestRun || local.available === true || robogo.state === 'ready',
  );
  const trainingState = trainingComplete ? 'ready' : trainingConfigured ? 'partial' : 'blocked';
  const evaluationExists = Boolean(
    telemetry?.summary || latestRun?.evaluation || latestRun?.taskEvaluation,
  );
  const evaluationState = hasReleaseGradeEvidence(telemetry, latestRun)
    ? 'ready'
    : evaluationExists
      ? 'partial'
      : 'blocked';
  const deploymentVerified = Boolean(
    latestDeployment?.verification || latestDeployment?.releaseGate,
  );
  const deploymentState = deploymentVerified
    ? 'ready'
    : latestDeployment
      ? 'partial'
      : 'blocked';
  const project = selectedProject();
  const traceabilityState = project
    ? (projectModelIds(project)?.size || projectDatasetIds(project)?.size || latestRun?.projectId === project.id)
      ? 'ready'
      : 'partial'
    : state.projects?.length || state.datasets?.length || latestRun?.projectId
      ? 'partial'
      : 'blocked';
  const checks = [
    ['契约与制品', contractState, contractState === 'ready' ? '输入输出和受管引用已登记' : model ? '契约或制品引用还不完整' : '先登记 manifest'],
    ['训练执行', trainingState, trainingComplete ? statusLabel(latestRun.status) : trainingConfigured ? '后端已配置，等待完成 Run' : '等待 runner'],
    ['Sim2Real 评测', evaluationState, evaluationState === 'ready' ? '受信证据可用于发布' : evaluationExists ? '证据已保存 · 来源未验证' : '导入遥测或轨迹'],
    ['设备发布', deploymentState, deploymentState === 'ready' ? statusLabel(latestDeployment.status) : latestDeployment ? '预检计划已生成，等待结果' : '先做只读预检'],
    ['项目可追溯', traceabilityState, traceabilityState === 'ready' ? '项目与数据已关联' : project ? '项目已创建，等待绑定资源' : '建立项目或数据集'],
  ];
  const points = checks.reduce((sum, item) => sum + (item[1] === 'ready' ? 2 : item[1] === 'partial' ? 1 : 0), 0);
  total.textContent = (points / 2).toFixed(1);
  grid.replaceChildren();
  for (const [label, stateName, detail] of checks) {
    const item = document.createElement('article');
    item.className = `platform-score-item is-${stateName}`;
    item.dataset.state = stateName;
    const title = document.createElement('strong');
    title.textContent = String(label);
    const copy = document.createElement('span');
    copy.textContent = String(detail);
    const bar = document.createElement('i');
    bar.style.setProperty('--score', stateName === 'ready' ? '100%' : stateName === 'partial' ? '58%' : '18%');
    item.append(title, copy, bar);
    grid.append(item);
  }
  const note = $('platform-scorecard-note');
  if (note) note.textContent = points === 10
    ? '软件闭环已具备完整证据；真实 X5 运动安全记录仍需现场验收。'
    : '完成上面的下一步即可提高软件门槛；真实 X5 运动安全记录和签名制品会单独计入现场验收。';
}

function renderProjectWorkspace() {
  const data = workspaceSummaryData();
  const counts = data.counts || {};
  const run = data.latestRun;
  const deployment = data.latestDeployment;
  const modelCount = Number(counts.models || 0);
  setText('workspace-asset-count', `${modelCount} 个模型`);
  setText('workspace-asset-meta', modelCount ? '含 manifest 与运行时契约' : '登记 manifest 后可追溯');
  if (run) {
    setText('workspace-latest-run', statusLabel(run.status));
    setText('workspace-latest-run-meta', `${run.summary || run.taskId || run.backend || '最近一次运行'} · ${formatDate(run.createdAt)}`);
  } else {
    setText('workspace-latest-run', '暂无运行');
    setText('workspace-latest-run-meta', '从仿真或训练开始');
  }
  const hasTelemetry = Boolean(currentTelemetry());
  const datasetCount = data.datasets.length;
  setText('workspace-dataset-count', hasTelemetry ? '已有遥测证据' : datasetCount ? `${datasetCount} 个数据集` : '等待遥测');
  setText('workspace-dataset-meta', hasTelemetry ? `${currentTelemetry()?.summary?.sampleCount || 0} 帧 · 可进入评测` : datasetCount ? '可在评测中复用' : '导入证据后生成摘要');
  if (deployment) {
    setText('workspace-deploy-status', statusLabel(deployment.status));
    setText('workspace-deploy-meta', `${deployment.targetPlatform || 'RDK X5'} · ${formatDate(deployment.updatedAt || deployment.createdAt)}`);
  } else {
    setText('workspace-deploy-status', '尚未部署');
    setText('workspace-deploy-meta', counts.devices ? '目标板卡已登记，等待预检' : '登记目标板卡后开始');
  }
  const recentRoot = $('workspace-recent-list');
  if (recentRoot) {
    const project = selectedProject();
    setText(
      'workspace-recent-caption',
      project ? `${projectDisplayName(project)} · 按项目筛选` : '按当前项目筛选',
    );
    const recent = [
      ...(runsForCurrentModel() || []).map((item) => Object.assign({ kindLabel: '运行' }, item)),
      ...(deploymentsForCurrentModel() || []).map((item) => Object.assign({ kindLabel: '部署' }, item)),
    ].sort((a, b) => String(b.createdAt || b.updatedAt || '').localeCompare(String(a.createdAt || a.updatedAt || ''))).slice(0, 3);
    recentRoot.replaceChildren();
    if (!recent.length) {
      recentRoot.innerHTML = project // escape-audit:allow both branches are fixed local literals
        ? '<div class="empty-state project-empty"><strong>项目还没有活动</strong><span>先在训练页绑定模型，再开始仿真、强化学习训练或只读预检。</span><button type="button" class="button button-primary button-small" data-workspace-view="train">去准备模型 →</button></div>'
        : '<span class="empty-inline">还没有活动。完成一次仿真、训练或预检后会显示在这里。</span>';
    } else {
      for (const item of recent) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'workspace-recent-item';
        row.dataset.workspaceView = item.kindLabel === '部署' ? 'deploy' : 'records';
        row.innerHTML = `<span class="workspace-recent-dot ${stateClass(item.status)}"></span><span class="workspace-recent-copy"><strong>${escapeHtml(item.kindLabel)} · ${escapeHtml(item.summary || item.taskId || item.backend || item.mode || '状态更新')}</strong><small>${escapeHtml(statusLabel(item.status))} · ${escapeHtml(formatDate(item.createdAt || item.updatedAt))}</small></span><span aria-hidden="true">→</span>`;
        recentRoot.append(row);
      }
    }
  }
  const saved = $('workspace-last-saved');
  if (saved) saved.textContent = `最近同步 ${formatDate(state.workspaceSummary?.generatedAt || new Date().toISOString())}`;
  renderDeploymentTimeline();
  renderPromotionFlow();
}

function renderDeploymentTimeline() {
  const root = $('deploy-timeline-list');
  if (!root) return;
  const model = selectedModel();
  const device = selectedDevice();
  const deployment = state.activeDeployment || deploymentsForCurrentModel().find((item) => item.modelId === model?.id && item.deviceId === device?.id);
  const latest = latestRun();
  const evidence = currentTelemetry();
  const releaseGradeEvidence = hasReleaseGradeEvidence(evidence, latest);
  const trainingState = releaseGradeEvidence
    ? 'done'
    : evidence || latest?.mock === true
      ? 'attention'
      : latest?.status === 'completed'
        ? 'done'
        : latest
          ? 'attention'
          : 'pending';
  const trainingDetail = releaseGradeEvidence
    ? '受信遥测已绑定当前工作区'
    : evidence
      ? '证据已导入 · 来源未验证'
      : latest?.mock === true
        ? '协议演示完成 · 不可作为真实评测'
        : latest
          ? statusLabel(latest.status)
          : '需要一次训练或评测 Run';
  const deviceState = device?.status === 'connected' || device?.status === 'ready' ? 'done' : device ? 'attention' : 'pending';
  const deviceDetail = device ? `${device.name || device.id} · ${device.status || '待连接'}${device.status === 'connected' ? ' · 仍需验证 BoardAgent 心跳' : ''}` : '尚未选择目标设备';
  const preflightState = deployment && ['ready', 'completed'].includes(String(deployment.status || '')) ? 'done' : deployment ? 'attention' : 'pending';
  const approvalState = deployment?.approval?.status || 'pending';
  const approvalDetail = deployment
    ? approvalState === 'approved'
      ? '人工审批已通过 · 等待受控 BoardAgent 执行'
      : approvalState === 'rejected'
        ? `人工审批已拒绝${deployment.approval?.note ? ' · ' + deployment.approval.note : ''}`
        : '等待 owner/admin 人工审批；网页不会直接启动执行器'
    : '需要先生成通过证据门的 Canary / Live 计划';
  const approvalTimelineState = !deployment
    ? 'pending'
    : approvalState === 'approved'
      ? 'done'
      : approvalState === 'rejected'
        ? 'attention'
        : 'pending';
  const entries = [
    { label: '模型契约', detail: model ? `${modelLabel(model)} 已选定` : '尚未选择模型', state: model ? 'done' : 'pending' },
    { label: '训练与评测', detail: trainingDetail, state: trainingState },
    { label: '目标设备', detail: deviceDetail, state: deviceState },
    { label: '只读预检', detail: deployment ? statusLabel(deployment.status) : '生成计划后执行；不会启动执行器', state: preflightState },
    { label: 'Canary / Live', detail: approvalDetail, state: approvalTimelineState },
  ];
  root.replaceChildren();
  for (const entry of entries) {
    const item = document.createElement('li');
    item.className = `deploy-timeline-item is-${entry.state}`;
    item.innerHTML = `<span class="deploy-timeline-marker" aria-hidden="true">${entry.state === 'done' ? '✓' : entry.state === 'attention' ? '!' : '·'}</span><span><strong>${escapeHtml(entry.label)}</strong><small>${escapeHtml(entry.detail)}</small></span>`;
    root.append(item);
  }
  const active = deployment ? statusLabel(deployment.status) : '等待预检';
  setText('deploy-timeline-status', active);
  setText('deploy-flow-caption', deployment ? `更新于 ${formatDate(deployment.updatedAt || deployment.createdAt)}` : '按证据推进');
  $('deploy-recovery-note')?.toggleAttribute('hidden', !deployment || !['failed', 'blocked'].includes(String(deployment.status || '').toLowerCase()));
}

// ---- 模型晋级流：训练产物 → 候选 → 验证 → 发布 -----------------------------
// The overview payload now carries first-class artifact and evaluation records.
// This view turns that evidence chain into a visible product: each run that
// produced a registry artifact renders as a chain link with its evaluation,
// artifact lifecycle, and deployment consumption. Nothing here invents
// evidence — every chip comes from a ledger record field.

const ARTIFACT_STATUS_LABELS = {
  draft: '候选',
  validated: '已验证',
  published: '已发布',
  revoked: '已撤销',
};

function promotionRecordsForCurrentModel() {
  const ids = currentModelIds();
  const artifacts = (state.overview?.artifacts || []).filter(
    (artifact) => ids.has(artifact.modelId) && projectIncludesRecord(artifact),
  );
  const evaluations = (state.overview?.evaluations || []).filter(
    (evaluation) =>
      ids.has(evaluation.modelId) &&
      (!evaluation.artifactId || artifacts.some((artifact) => artifact.id === evaluation.artifactId)) &&
      projectIncludesRecord(evaluation),
  );
  const deployments = deploymentsForCurrentModel().filter(
    (deployment) => deployment.artifactId || deployment.evaluationId,
  );
  return { artifacts, evaluations, deployments };
}

// Latest-first run ordering, then link records that belong to the same run so
// the chain reads top-down as one promotion story per training run.
function promotionChainLinks() {
  const { artifacts, evaluations, deployments } = promotionRecordsForCurrentModel();
  const runs = [...runsForCurrentModel()].sort((a, b) =>
    String(b.createdAt || '').localeCompare(String(a.createdAt || '')),
  );
  const links = [];
  const artifactByRun = new Map();
  for (const artifact of artifacts) {
    if (artifact.runId && !artifactByRun.has(artifact.runId)) artifactByRun.set(artifact.runId, artifact);
  }
  const evaluationByRun = new Map();
  const evaluationById = new Map(evaluations.map((evaluation) => [evaluation.id, evaluation]));
  for (const evaluation of evaluations) {
    if (evaluation.runId && !evaluationByRun.has(evaluation.runId)) evaluationByRun.set(evaluation.runId, evaluation);
  }
  const deploymentByArtifact = new Map();
  const deploymentByEvaluation = new Map();
  for (const deployment of deployments) {
    if (deployment.artifactId && !deploymentByArtifact.has(deployment.artifactId)) {
      deploymentByArtifact.set(deployment.artifactId, deployment);
    }
    if (deployment.evaluationId && !deploymentByEvaluation.has(deployment.evaluationId)) {
      deploymentByEvaluation.set(deployment.evaluationId, deployment);
    }
  }
  for (const run of runs) {
    const artifact = artifactByRun.get(run.id) || null;
    const evaluation =
      evaluationByRun.get(run.id) ||
      (artifact ? evaluationById.get(artifact.evaluationIds?.[0] || '') || null : null) ||
      (run.evaluationId ? evaluationById.get(run.evaluationId) || null : null);
    const deployment =
      (artifact ? deploymentByArtifact.get(artifact.id) || null : null) ||
      (evaluation ? deploymentByEvaluation.get(evaluation.id) || null : null);
    if (!artifact && !evaluation && !deployment) continue;
    links.push({ run, artifact, evaluation, deployment });
  }
  // Orphan records the run ledger cannot reach still deserve a visible slot.
  const linkedArtifactIds = new Set(links.map((link) => link.artifact?.id).filter(Boolean));
  for (const artifact of artifacts) {
    if (linkedArtifactIds.has(artifact.id)) continue;
    const evaluation = evaluationById.get(artifact.evaluationIds?.[0] || '') || null;
    links.push({
      run: null,
      artifact,
      evaluation,
      deployment: deploymentByArtifact.get(artifact.id) || null,
    });
  }
  return links.slice(0, 12);
}

function renderPromotionFlow() {
  const root = $('promotion-chain');
  if (!root) return;
  const links = promotionChainLinks();
  const { artifacts, evaluations, deployments } = promotionRecordsForCurrentModel();
  renderPromotionStages(artifacts, evaluations, deployments);
  root.replaceChildren();
  if (!links.length) {
    const empty = document.createElement('li');
    empty.className = 'promotion-chain-empty';
    empty.textContent =
      '当前模型还没有可展示的晋级链：完成一次真实训练并发布制品后，这里会按 产物 → 评测 → 制品 → 部署 展示证据。';
    root.append(empty);
    return;
  }
  for (const link of links) root.append(promotionLinkItem(link));
}

function renderPromotionStages(artifacts, evaluations, deployments) {
  const published = artifacts.filter((artifact) => artifact.status === 'published');
  const validated = artifacts.filter((artifact) => artifact.status === 'validated');
  const passed = evaluations.filter(
    (evaluation) => evaluation.status === 'passed' && !evaluation.stale,
  );
  const hasDraft = artifacts.some((artifact) => artifact.status === 'draft');
  const candidatesState = artifacts.length ? (hasDraft ? 'current' : 'ready') : 'locked';
  const validatedState = validated.length || published.length ? 'ready' : passed.length ? 'current' : artifacts.length ? 'blocked' : 'locked';
  const publishedState = published.length
    ? 'ready'
    : deployments.length
      ? 'current'
      : validated.length || passed.length
        ? 'blocked'
        : 'locked';
  const stages = [
    { key: 'candidates', state: candidatesState, detail: artifacts.length ? `${artifacts.length} 个制品候选` : '还没有注册制品' },
    { key: 'validated', state: validatedState, detail: passed.length ? `${passed.length} 条评测通过` : validated.length ? `${validated.length} 个已验证` : '等待评测通过' },
    { key: 'published', state: publishedState, detail: published.length ? `${published.length} 个已发布` : deployments.length ? '已有部署消费发布制品' : '等待发布' },
  ];
  for (const stage of stages) {
    const node = document.querySelector('[data-promotion-stage="' + stage.key + '"]');
    if (!node) continue;
    node.classList.remove('is-ready', 'is-current', 'is-blocked', 'is-locked');
    node.classList.add('is-' + stage.state);
    const small = node.querySelector('small');
    if (small) small.textContent = stage.detail;
    const title = node.querySelector('strong')?.textContent?.trim() || stage.key;
    node.setAttribute('aria-label', `${title}：${stage.detail}`);
  }
  const caption = $('promotion-flow-caption');
  if (caption) {
    caption.textContent = published.length
      ? `${published.length} 个制品已发布 · 链路可见`
      : artifacts.length
        ? `${artifacts.length} 个制品在晋级流中`
        : '训练产物 → 候选 → 验证 → 发布';
  }
}

function promotionLinkItem(link) {
  const { run, artifact, evaluation, deployment } = link;
  const item = document.createElement('li');
  item.className = 'promotion-item';
  const chips = [];
  const chip = (label, value) =>
    value === undefined || value === null || value === '' ? null : `<dt>${escapeHtml(label)}</dt><dd><b>${escapeHtml(String(value))}</b></dd>`;
  const parts = [];
  if (artifact) {
    item.classList.add('is-artifact', 'is-' + artifact.status);
    parts.push(
      '<span class="promotion-item-marker" aria-hidden="true">' + (artifact.status === 'published' ? '✓' : artifact.status === 'revoked' ? '×' : '◆') + '</span>' +
      '<div class="promotion-item-main">' +
      '<div class="promotion-item-title"><strong>' + escapeHtml(artifact.name || artifact.artifactId) + '</strong>' +
      '<span>' + escapeHtml(ARTIFACT_STATUS_LABELS[artifact.status] || artifact.status) + '</span></div>' +
      '<dl class="promotion-item-detail">' +
      [chip('版本', artifact.version), chip('格式', artifact.format?.toUpperCase()), chip('角色', artifact.role), chip('运行时', artifact.runtime)].filter(Boolean).join('') +
      '</dl></div>',
    );
    chips.push(['SHA-256', shortDigest(artifact.sha256)]);
    if (artifact.sizeBytes) chips.push(['体积', formatBytes(artifact.sizeBytes)]);
    if (artifact.publishedAt) chips.push(['发布于', formatDate(artifact.publishedAt)]);
    if (artifact.revokedAt) chips.push(['撤销于', formatDate(artifact.revokedAt)]);
  } else if (evaluation) {
    item.classList.add('is-evaluation', 'is-' + evaluation.status);
    parts.push(
      '<span class="promotion-item-marker" aria-hidden="true">' + (evaluation.status === 'passed' ? '✓' : evaluation.status === 'failed' ? '×' : '·') + '</span>' +
      '<div class="promotion-item-main">' +
      '<div class="promotion-item-title"><strong>评测证据</strong><span>' + escapeHtml(evaluation.status === 'passed' ? '通过' : evaluation.status === 'failed' ? '失败' : evaluation.status) + (evaluation.attested ? ' · attested' : '') + '</span></div>' +
      '</div>',
    );
  } else if (deployment) {
    item.classList.add('is-deployment');
    parts.push(
      '<span class="promotion-item-marker">⇗</span>' +
      '<div class="promotion-item-main"><div class="promotion-item-title"><strong>部署计划</strong><span>' + escapeHtml(deployment.mode) + ' · ' + escapeHtml(statusLabel(deployment.status)) + '</span></div></div>',
    );
  }
  // Run provenance: every link shows which training run produced the evidence.
  if (run) {
    chips.unshift(['训练 Run', run.id], ['状态', statusLabel(run.status)]);
    if (run.taskId) chips.splice(2, 0, ['任务', run.taskId]);
    if (run.metrics?.engine) chips.splice(3, 0, ['引擎', run.metrics.engine]);
  }
  if (evaluation) {
    chips.push(['评测', evaluation.id]);
    if (evaluation.taskId) chips.push(['评测任务', evaluation.taskId]);
    const gate = evaluation.taskEvaluation?.qualityGate;
    if (gate) {
      chips.push(['质量门', gate.passed === true ? '通过' : gate.passed === false ? '未通过' : '未报告']);
    }
    if (evaluation.stale) chips.push(['证据', '已被更新遥测取代']);
  }
  if (deployment) {
    chips.push(['部署', deployment.id], ['模式', deployment.mode]);
    if (deployment.releaseGate) {
      chips.push(['发布闸门', deployment.releaseGate.passed ? '通过' : '未通过']);
    }
  }
  const evidenceBlock = chips.length
    ? '<div class="promotion-item-evidence"><dl class="promotion-item-detail">' +
      chips
        .map(([label, value]) =>
          value === undefined || value === null || value === '' ? '' : `<dt>${escapeHtml(label)}</dt><dd><b>${escapeHtml(String(value))}</b></dd>`,
        )
        .join('') +
      '</dl></div>'
    : '';
  const errorNote =
    artifact?.status === 'revoked' && artifact.revocationReason
      ? '<p class="promotion-item-error">撤销原因：' + escapeHtml(artifact.revocationReason) + '</p>'
      : evaluation?.status === 'failed'
        ? '<p class="promotion-item-error">评测未通过：' + escapeHtml(evaluation.summary || '无详细说明') + '</p>'
        : '';
  const actions = promotionActionButtons(artifact);
  // escape-audit:allow every joined segment is literal HTML with escapeHtml() on record fields; actions markup is static.
  item.innerHTML = parts.join('') + evidenceBlock + errorNote + actions;
  // Detail dialog on the whole row mirrors the records-view behavior.
  item.addEventListener('click', () => openPromotionDetail(link));
  item.querySelectorAll('[data-promotion-action]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      handlePromotionAction(button.dataset.promotionAction, artifact, link);
    });
  });
  if (link.run || link.artifact) appendLineageToggle(item, link);
  return item;
}

// The lineage endpoint takes exactly one selector (runId / artifactId /
// evaluationId / projectId). A promotion link prefers its producing run so the
// graph covers every hop: datasets → run → artifacts → evaluations → deployments.
function appendLineageToggle(item, link) {
  const actions = item.querySelector('.promotion-item-actions');
  const host = actions || item.querySelector('.promotion-item-main');
  if (!host) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'button button-ghost button-small';
  button.dataset.lineageToggle = 'true';
  button.textContent = '血缘';
  if (actions) actions.append(button);
  else host.after(button);
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    void togglePromotionLineage(item, link, button);
  });
}

async function togglePromotionLineage(item, link, button) {
  let panel = item.querySelector('.promotion-lineage');
  if (panel && !panel.hidden) {
    panel.hidden = true;
    return;
  }
  if (!panel) {
    panel = document.createElement('div');
    panel.className = 'promotion-lineage';
    panel.hidden = true;
    item.append(panel);
  }
  if (!link.lineage) {
    panel.replaceChildren(promotionLineageNote('正在读取证据血缘…'));
    panel.hidden = false;
    button.disabled = true;
    try {
      const selector = link.run
        ? 'runId=' + encodeURIComponent(link.run.id)
        : 'artifactId=' + encodeURIComponent(link.artifact.id);
      const payload = await request('/sim2real/lineage?' + selector);
      link.lineage = payload?.lineage || null;
    } catch (error) {
      panel.replaceChildren(
        promotionLineageNote(
          '血缘读取失败：' +
            (error instanceof Error ? error.message : '服务暂不可用') +
            '（可重试）',
        ),
      );
      button.disabled = false;
      return;
    }
    button.disabled = false;
  }
  panel.replaceChildren(...promotionLineageNodes(link.lineage, link));
  panel.hidden = false;
}

function promotionLineageNote(text) {
  const note = document.createElement('p');
  note.className = 'promotion-chain-empty';
  note.textContent = text;
  return note;
}

// Renders the server's bidirectional evidence graph as compact text rows.
// Built entirely with createElement/textContent so record fields can never
// reach innerHTML.
function promotionLineageNodes(lineage, link) {
  if (!lineage) return [promotionLineageNote('该记录暂无可读血缘。')];
  const rows = [];
  const push = (label, text) => {
    const row = document.createElement('p');
    row.className = 'promotion-lineage-row';
    const tag = document.createElement('span');
    tag.textContent = label;
    const value = document.createElement('b');
    value.textContent = text;
    row.append(tag, value);
    rows.push(row);
  };
  const datasets = Array.isArray(lineage.datasets) ? lineage.datasets : [];
  for (const dataset of datasets.slice(0, 4)) {
    push('数据集', `${dataset.name || dataset.id}${dataset.version ? ' · ' + dataset.version : ''}`);
  }
  if (!datasets.length) push('数据集', '无');
  const runs = Array.isArray(lineage.runs) ? lineage.runs : lineage.run ? [lineage.run] : [];
  for (const run of runs.slice(0, 4)) {
    if (link.run && run.id === link.run.id) continue;
    push('关联 Run', `${run.id} · ${statusLabel(run.status)}`);
  }
  const artifacts = Array.isArray(lineage.artifacts) ? lineage.artifacts : [];
  for (const artifact of artifacts.slice(0, 4)) {
    push(
      '制品',
      `${artifact.name || artifact.artifactId} · ${ARTIFACT_STATUS_LABELS[artifact.status] || artifact.status}`,
    );
  }
  const evaluations = Array.isArray(lineage.evaluations) ? lineage.evaluations : [];
  for (const evaluation of evaluations.slice(0, 4)) {
    push(
      '评测',
      `${evaluation.id} · ${evaluation.status}${evaluation.attested ? ' · attested' : ''}`,
    );
  }
  const deployments = Array.isArray(lineage.deployments) ? lineage.deployments : [];
  for (const deployment of deployments.slice(0, 4)) {
    push(
      '部署',
      `${deployment.id} · ${deployment.mode} · ${statusLabel(deployment.status)}${
        deployment.releaseGate ? ' · 闸门' + (deployment.releaseGate.passed ? '通过' : '未通过') : ''
      }`,
    );
  }
  const heading = document.createElement('p');
  heading.className = 'promotion-lineage-heading';
  heading.textContent = link.run
    ? `证据血缘 · Run ${link.run.id}`
    : `证据血缘 · 制品 ${link.artifact.id}`;
  return [heading, ...rows];
}

function promotionActionButtons(artifact) {
  if (!artifact) return '';
  const actions = [];
  if (artifact.status === 'draft' || artifact.status === 'validated') {
    actions.push('<button class="button button-ghost button-small" type="button" data-promotion-action="validate">标记验证</button>');
  }
  if ((artifact.status === 'draft' || artifact.status === 'validated') && artifact.sha256) {
    actions.push('<button class="button button-primary button-small" type="button" data-promotion-action="publish">发布制品</button>');
  }
  if (artifact.status === 'validated' && !artifact.sha256) {
    actions.push('<span class="small-note">发布前需登记 sha256 内容摘要</span>');
  }
  if (artifact.status === 'published') {
    actions.push('<button class="button button-ghost button-small" type="button" data-promotion-action="revoke">撤销发布</button>');
  }
  if (!actions.length) return '';
  return '<div class="promotion-item-actions">' + actions.join('') + '</div>';
}

function shortDigest(value) {
  const text = String(value || '');
  if (!text) return null;
  return text.length > 12 ? text.slice(0, 12) + '…' : text;
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function openPromotionDetail(link) {
  const record = link.artifact
    ? Object.assign({}, link.artifact, {
        recordType: 'artifact',
        kind: 'artifact · ' + (link.artifact.role || link.artifact.format || 'model'),
        summary: link.artifact.name || link.artifact.artifactId,
        label: ARTIFACT_STATUS_LABELS[link.artifact.status] || link.artifact.status,
      })
    : link.evaluation
      ? Object.assign({}, link.evaluation, {
          recordType: 'evaluation',
          kind: 'evaluation · ' + link.evaluation.status,
          summary: link.evaluation.summary || link.evaluation.id,
        })
      : link.deployment;
  if (record) openRecordDetails(record);
}

async function handlePromotionAction(action, artifact, link) {
  if (!artifact || !action) return;
  const labels = { validate: '验证', publish: '发布', revoke: '撤销' };
  const label = labels[action] || action;
  if (action === 'publish') {
    const approved = await confirmAction({
      title: '确认发布制品',
      note: '发布后该制品可用于 Canary / Live 部署计划的发布闸门校验；发布记录会保留发布时间与操作者。',
      approveLabel: '确认发布',
      details: [
        { label: '制品', value: artifact.name || artifact.artifactId },
        { label: '版本', value: artifact.version },
        { label: 'SHA-256', value: artifact.sha256 ? shortDigest(artifact.sha256) : '未登记（发布会被拒绝）' },
      ],
    });
    if (!approved) return;
  } else if (action === 'revoke') {
    const approved = await confirmAction({
      title: '确认撤销制品',
      note: '撤销后该版本不再可用于新的部署计划；操作会写入审计记录。',
      approveLabel: '确认撤销',
      details: [
        { label: '制品', value: artifact.name || artifact.artifactId },
        { label: '版本', value: artifact.version },
      ],
    });
    if (!approved) return;
  }
  try {
    const payload = await request('/sim2real/artifacts/' + encodeURIComponent(artifact.id) + '/' + action, {
      method: 'POST',
      ...(action === 'revoke' ? { body: JSON.stringify({ reason: '操作员在晋级流面板撤销制品版本。' }) } : {}),
    });
    showToast(
      payload?.artifact
        ? `制品已${label}：${payload.artifact.name || payload.artifact.artifactId}（${ARTIFACT_STATUS_LABELS[payload.artifact.status] || payload.artifact.status}）`
        : `制品已${label}`,
      'success',
    );
    await loadOverview({ quiet: true });
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401))
      showToast(error instanceof Error ? error.message : `制品${label}失败`, 'error');
  }
}

// ---- Scoped polling: one mechanism for every periodic refresh -------------
// A poll declares its cadence (nextDelay), the views it may run in, and
// whether it fires immediately on view entry. The two global choke points —
// setView and the visibilitychange handler — drive every poll through this
// registry, so a new periodic refresh cannot re-implement (or forget) the
// guards again.
const scopedPolls = [];

function createScopedPoll({ name, nextDelay, views = null, immediate = false, resume = 'arm', tick }) {
  const poll = {
    name,
    views: views ? new Set(views) : null,
    immediate,
    resume,
    tick,
    nextDelayFn: typeof nextDelay === 'function' ? nextDelay : () => Number(nextDelay) || 0,
    wanted: false,
    timer: null,
    inFlight: false,
    enabled() {
      return !poll.views || poll.views.has(document.body.dataset.activeView);
    },
    run() {
      if (poll.inFlight) return;
      // A hidden tab cannot inform anyone; skip the work and hold the chain.
      // resumeScopedPolls re-arms it when the tab returns.
      if (document.visibilityState !== 'visible') return;
      poll.inFlight = true;
      Promise.resolve()
        .then(() => poll.tick())
        .catch(() => {})
        .finally(() => {
          poll.inFlight = false;
          poll.arm();
        });
    },
    arm() {
      if (poll.timer !== null || !poll.wanted) return;
      if (document.visibilityState !== 'visible') return;
      if (!poll.enabled()) return;
      poll.timer = window.setTimeout(() => {
        poll.timer = null;
        poll.run();
      }, poll.nextDelayFn());
    },
    refresh() {
      if (poll.inFlight) return;
      poll.run();
    },
    rearm() {
      poll.wanted = true;
      poll.stop();
      poll.arm();
    },
    enter() {
      poll.wanted = true;
      poll.stop();
      if (poll.immediate) poll.refresh();
      else poll.arm();
    },
    leave() {
      poll.wanted = false;
      poll.stop();
    },
    stop() {
      if (poll.timer !== null) {
        window.clearTimeout(poll.timer);
        poll.timer = null;
      }
    },
  };
  scopedPolls.push(poll);
  return poll;
}

// View-scoped polls start/stop as the operator walks views; always-on polls
// (no views scope) are managed by their owners via rearm().
function syncScopedPolls() {
  for (const poll of scopedPolls) {
    if (!poll.views) continue;
    if (poll.enabled()) poll.enter();
    else poll.leave();
  }
}

// Tab returned: held polls resume. resume:'refresh' polls tick immediately
// (a returning operator wants current data, not a stale cycle); the rest
// re-arm at their normal cadence.
function resumeScopedPolls() {
  for (const poll of scopedPolls) {
    if (!poll.wanted || poll.timer !== null) continue;
    if (poll.resume === 'refresh') poll.refresh();
    else poll.arm();
  }
}

const runStatusFailures = new Map();
let runStatusBackoffUntil = 0;
// 僵尸运行熔断：一个 run 连续拉取详情失败达到阈值后，暂停对该 run 的
// 单独轮询 5 分钟（期间界面保留最后一次已知状态），并只为它弹一次
// 降频通知。否则一个卡在 running 的死 run 会让控制台每 30 秒滚一条
// 503、每 30 秒弹一次 toast，永远不停。
const RUN_STATUS_DEAD_RETRY_MS = 300_000;
const runStatusDeadUntil = new Map();
const runStatusDeadNotified = new Set();

// 子界面分割（D-002）：多子项共享视图时，视图内同时只展示当前子项
// 自己的面板——评测（发起评测/结果对比）与部署（预检/运行反馈）与
// 训练的模块切换同构。无子项进入时落到默认模块，保证「完全分割」。
const SUBINTERFACE_PARTITIONS = {
  evaluate: {
    attribute: 'data-active-eval-module',
    modules: { run: 'eval-tab-run', comparison: 'eval-tab-comparison' },
    defaultModule: 'run',
  },
  deploy: {
    attribute: 'data-active-deploy-module',
    modules: { preflight: 'deploy-tab-preflight', feedback: 'deploy-tab-feedback' },
    defaultModule: 'preflight',
  },
};

function applySubinterfacePartition(view, child) {
  const partition = SUBINTERFACE_PARTITIONS[view];
  if (!partition) return;
  const section = document.querySelector(`[data-view-section="${view}"]`);
  if (!section) return;
  const module = partition.modules[child] ? child : partition.defaultModule;
  section.setAttribute(partition.attribute, module);
  for (const [moduleKey, tabId] of Object.entries(partition.modules)) {
    const tab = document.getElementById(tabId);
    if (!tab) continue;
    const active = moduleKey === module;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
    tab.tabIndex = active ? 0 : -1;
  }
}

// The workbench heartbeat: always wanted on every view, faster while a run is
// active, backed off after run-status failures, silent (no loading chrome),
// and refreshing once when the tab returns.
const overviewPoll = createScopedPoll({
  name: 'overview',
  resume: 'refresh',
  nextDelay: () => {
    const hasActiveRun = runsForCurrentModel().some((run) =>
      ['queued', 'running'].includes(String(run.status || '').toLowerCase()),
    );
    const backoffActive = runStatusBackoffUntil > Date.now();
    return hasActiveRun ? (backoffActive ? Math.max(30_000, runStatusBackoffUntil - Date.now()) : 5_000) : 30_000;
  },
  tick: () => loadOverview({ quiet: true, silent: true }),
});

// ── Event-driven refresh (SSE) ──────────────────────────────────────────────
// The server bridges its domain event bus (run/deployment/evaluation/telemetry
// mutations) to /api/v1/duck/events. Events trigger an immediate silent
// overview refresh instead of waiting for the next poll cycle; the poll
// chain stays armed as the fallback whenever the stream is unavailable.
// High-frequency run.updated frames during training are coalesced by a
// trailing-edge throttle so the UI refreshes at most every 2s.
const SSE_THROTTLE_MS = 2000;
const SSE_EVENT_NAMES = [
  'run.created',
  'run.updated',
  'deployment.created',
  'deployment.updated',
  'evaluation.created',
  'evaluation.updated',
  'telemetry.appended',
  'artifact.created',
  'model.created',
  'project.created',
  'project.updated',
];
let sseSource = null;
let sseRefreshQueued = false;
let sseRefreshTimer = null;

function sseThrottledRefresh() {
  if (sseRefreshQueued) return;
  sseRefreshQueued = true;
  sseRefreshTimer = window.setTimeout(() => {
    sseRefreshQueued = false;
    sseRefreshTimer = null;
    if (document.visibilityState !== 'visible') return;
    void loadOverview({ quiet: true, silent: true }).catch(() => {});
  }, SSE_THROTTLE_MS);
}

function connectEventStream() {
  if (!window.EventSource) return;
  try {
    const source = new EventSource(apiPath('/v1/duck/events'));
    sseSource = source;
    for (const name of SSE_EVENT_NAMES) {
      source.addEventListener(name, sseThrottledRefresh);
    }
    source.addEventListener('error', () => {
      // EventSource auto-reconnects; the poll chain remains the fallback
      // while disconnected, so no user-facing handling is needed here.
    });
  } catch {
    sseSource = null;
  }
}

const $ = (id) => document.getElementById(id);

function apiPath(path) {
  return BASE_PATH + '/api' + path;
}

function escapeHtml(value) {
  return SimTelemetryCore.escapeHtml(value);
}

function formatDate(value) {
  return SimTelemetryCore.formatDate(value);
}

function formatTelemetrySeconds(value) {
  return SimTelemetryCore.formatTelemetrySeconds(value);
}

function formatTelemetryRate(value) {
  return SimTelemetryCore.formatTelemetryRate(value);
}

function setText(id, value) {
  const node = $(id);
  if (node) node.textContent = String(value ?? '');
}

// The one way to populate a <select>: rebuild only when the option list or
// the intended value actually changed. Rebuilding a focused select mid-poll
// drops the caret/selection and makes an open dropdown pop closed.
// options: [{ value, textContent, title?, ai? }]
function syncSelect(select, options, value) {
  if (!select) return;
  const unchanged =
    select.options.length === options.length &&
    options.every((option, index) =>
      select.options[index]?.value === option.value &&
      select.options[index]?.textContent === option.textContent,
    ) &&
    select.value === value;
  if (unchanged) return;
  select.replaceChildren(...options.map((option) => {
    const el = document.createElement('option');
    el.value = option.value;
    el.textContent = option.textContent;
    if (option.title) el.title = option.title;
    if (option.ai) el.dataset.ai = 'true';
    return el;
  }));
  select.value = value;
}

function setStatusSurface(node, stateName, label) {
  if (!node) return;
  const allowed = ['ready', 'partial', 'blocked', 'error', 'waiting'];
  const normalized = allowed.includes(stateName) ? stateName : 'waiting';
  node.dataset.state = normalized;
  const actionLabel = node.dataset.workspaceView ? '；按 Enter 打开设备管理' : '';
  node.setAttribute('aria-label', `${label || node.getAttribute('aria-label') || '状态'}${actionLabel}`);
}

function setActionHint(id, stateName, message) {
  const node = $(id);
  if (!node) return;
  const normalized = ['ready', 'blocked', 'waiting', 'error'].includes(stateName)
    ? stateName
    : 'waiting';
  node.dataset.state = normalized;
  node.textContent = String(message || '');
}

// View names for the polite screen-reader announcement on view switch.
const VIEW_ANNOUNCEMENTS = {
  overview: '工作台',
  simulate: '仿真与录制',
  train: '强化学习训练',
  evaluate: 'Sim2Real 评测',
  deploy: '部署与反馈',
  records: '证据与记录',
  station: '设备控制台',
};

// One polite live region for view-switch announcements: nav buttons keep
// focus, so without this a screen reader never hears that the page changed.
function announce(text) {
  let node = document.getElementById('view-announcer');
  if (!node) {
    node = document.createElement('div');
    node.id = 'view-announcer';
    node.className = 'sr-only';
    node.setAttribute('role', 'status');
    node.setAttribute('aria-live', 'polite');
    document.body.append(node);
  }
  node.textContent = String(text || '');
}

let lastToastKey = ''; let lastToastAt = 0;
function showToast(message, tone = 'normal') {
  const region = $('toast-region');
  if (!region) return;
  const toast = document.createElement('div');
  toast.className =
    'toast' + (tone === 'error' ? ' toast-error' : tone === 'success' ? ' toast-success' : '');
  const raw = String(message ?? '');
  const toastKey = `${tone}:${raw}`;
  const now = Date.now();
  if (toastKey === lastToastKey && now - lastToastAt < 2500) return;
  lastToastKey = toastKey; lastToastAt = now;
  const translated = raw
    .replace(/API path does not exist\.?/gi, 'API 路径不存在。')
    .replace(/Request failed \((\d+)\)/gi, '请求失败（$1）。')
    .replace(/Failed to fetch/gi, window.location.protocol === 'file:' ? '当前页面是 file:// 预览，Agent 任务需要通过 npm run dev:sim2real 启动服务后访问。' : '网络连接失败，请检查服务是否在线。')
    .replace(/NetworkError/gi, '网络连接失败，请检查网络。')
    .replace(/Unauthorized|Authentication required/gi, '请先登录后再继续。')
    .replace(/Timeout|timed out/gi, '请求超时，请检查设备或服务连接。');
  toast.textContent = translated;
  region.append(toast);
  window.setTimeout(() => toast.remove(), 4800);
}

// 统一错误恢复路径：发生了什么 → 影响 → 下一步动作。原始工程报错进
// impact 行保留细节，恢复动作收口在按钮上，而不是让用户面对一句日志式文案。
function showRecoverableError(what, impact, actionLabel, onAction) {
  const region = $('toast-region');
  if (!region) return;
  const toast = document.createElement('div');
  toast.className = 'toast toast-error toast-recoverable';
  toast.setAttribute('role', 'alert');
  const title = document.createElement('strong');
  title.textContent = String(what || '操作失败');
  toast.append(title);
  const impactText = String(impact || '').trim();
  if (impactText) {
    const impact = document.createElement('span');
    impact.className = 'toast-impact';
    impact.textContent = impactText;
    toast.append(impact);
  }
  if (actionLabel && typeof onAction === 'function') {
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'button button-small';
    action.textContent = String(actionLabel);
    action.addEventListener('click', () => {
      toast.remove();
      onAction();
    });
    toast.append(action);
  }
  region.append(toast);
  window.setTimeout(() => toast.remove(), 9000);
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
    const active = tab.dataset.authMethod === method;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
    tab.setAttribute('tabindex', active ? '0' : '-1');
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

/* Guest fallback probe: /api/healthz is the one intentionally public surface.
   It tells a logged-out visitor whether the browser simulator is mounted and
   where SSO lives, so the "play first, sign in later" promise works without
   any account-scoped data. */
async function fetchPublicHealth() {
  if (state.publicHealth) return state.publicHealth;
  try {
    const response = await fetch(apiPath('/healthz'), { credentials: 'same-origin' });
    if (!response.ok) return null;
    const payload = await response.json();
    if (payload && typeof payload === 'object') {
      state.publicHealth = payload;
      renderIntegrations();
      // The auth gate usually renders before this probe resolves, so its
      // links initially carry the built-in default. Re-sync once the real
      // ssoLoginUrl is known.
      syncAuthGateLoginLinks();
    }
  } catch {
    // Offline or blocked: fall back to the built-in static entry, which the
    // server resolves (mounted/redirect/unavailable) per request anyway.
  }
  void refreshSessionMenu();
  return state.publicHealth;
}

/* 登录入口 href 回填：publicHealth 晚于首个 401 门到达时修正默认跳转。 */
function syncAuthGateLoginLinks() {
  if (!state.authRequired) return;
  const loginUrl = withLocalReturnTo(
    safeLoginUrl(state.publicHealth?.ssoLoginUrl || '/rdkstudio/'),
  );
  for (const node of [$('auth-login-button'), $('login-link'), $('auth-gate-banner-login')]) {
    node?.setAttribute('href', loginUrl);
  }
}

// 已登录用户在“更多”菜单里看到当前账号与退出登录入口；游客看不到（顶栏
// 已有登录按钮）。失败静默：会话接口不可达时菜单保持原样，不影响其他功能。
async function refreshSessionMenu() {
  const accountItem = $('account-menu-item');
  const accountName = $('account-name');
  const logoutLink = $('logout-link');
  if (!accountItem || !logoutLink) return;
  try {
    const session = await request('/sim2real/auth/session', {
      headers: { accept: 'application/json' },
    });
    if (!session?.authenticated || !session.logoutUrl) return;
    logoutLink.setAttribute('href', session.logoutUrl);
    if (accountName) {
      accountName.textContent = session.displayName || session.accountId || '';
      accountName.title = session.displayName || session.accountId || '';
    }
    accountItem.hidden = false;
    logoutLink.hidden = false;
  } catch {
    // 会话探测失败不阻塞工作台；菜单维持游客形态。
  }
}

function setAuthGate(payload) {
  state.authRequired = true;
  const loginUrl = withLocalReturnTo(safeLoginUrl(
    payload && typeof payload === 'object' && typeof payload.ssoLoginUrl === 'string'
      ? payload.ssoLoginUrl
      : state.publicHealth?.ssoLoginUrl || '/rdkstudio/',
  ));
  const gate = $('auth-gate');
  const loginButton = $('auth-login-button');
  const loginLink = $('login-link');
  const bannerLogin = $('auth-gate-banner-login');
  // The gate is a dismissible banner, not a wall: the simulator stays fully
  // playable while logged out, so first-contact visitors can try the product
  // before any account step. The full login form opens on demand.
  if (gate) gate.hidden = false;
  for (const node of [loginButton, loginLink, bannerLogin]) {
    if (!node) continue;
    node.setAttribute('href', loginUrl);
    node.hidden = false;
  }
  setText('service-status', '游客模式');
  syncServicePill();
  void fetchPublicHealth();
  renderNextAction();
  renderEvaluationNext();
  // Auth just flipped: the context strip and the scorecard hold guest-specific
  // branches, so they must re-render now (loadOverview's 401 path only
  // refreshes project context + integrations).
  renderContextLive();
  renderPlatformScorecard();
  if (!state.authNoticeShown) {
    state.authNoticeShown = true;
    // 区分「从未登录」与「登录已过期」：后者换个口径，提示重新登录即可恢复
    // 训练与部署，而不是把访客当成第一次来的游客。
    const hadIdentity = Boolean(state.overview?.identity?.accountId);
    showToast(
      hadIdentity
        ? '登录已过期：仿真可直接试玩；重新登录后可继续训练与真机部署。'
        : '当前为游客模式：仿真可直接试玩；训练记录与真机部署需要登录。',
      'normal',
    );
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
  const panel = $('auth-gate-panel');
  const toggle = $('auth-gate-toggle');
  if (panel) panel.hidden = true;
  if (toggle) {
    toggle.setAttribute('aria-expanded', 'false');
    toggle.textContent = '登录 / 展开表单';
  }
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

function setWorkspaceStatus(kind, title, message, { retry = false } = {}) {
  const banner = $('workspace-status-banner');
  if (!banner) return;
  const normalized = ['loading', 'error', 'warning', 'success'].includes(kind) ? kind : 'warning';
  banner.hidden = false;
  banner.dataset.state = normalized;
  banner.setAttribute('role', normalized === 'error' ? 'alert' : 'status');
  banner.classList.remove('is-loading', 'is-error', 'is-warning', 'is-success');
  banner.classList.add(`is-${normalized}`);
  setText('workspace-status-title', title || '工作区状态');
  setText('workspace-status-message', message || '');
  const button = $('workspace-status-retry');
  if (button) {
    button.hidden = !retry;
    button.disabled = state.loading;
  }
  const icon = $('workspace-status-icon');
  if (icon) icon.textContent = normalized === 'success' ? '✓' : normalized === 'loading' ? '…' : '!';
}

function clearWorkspaceStatus() {
  const banner = $('workspace-status-banner');
  if (!banner) return;
  banner.hidden = true;
  banner.removeAttribute('data-state');
  banner.setAttribute('role', 'status');
}

// ---- Workspace notices (Amershi G18: notify users about changes) -------
// The strip is passive and dismissible: version + degraded-state notices
// from GET /sim2real/notices. A version change since first paint upgrades
// the notice into a reload CTA — answering the "界面是旧的" FAQ without a
// forced refresh. All nodes are createElement/textContent, no innerHTML.
const WORKSPACE_NOTICES_DISMISS_KEY = 'sim2real.notice-dismissed.v1';
const WORKSPACE_NOTICES_REFETCH_MS = 60000;
let workspaceNoticesLastFetchMs = 0;

function readDismissedWorkspaceNotices() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(WORKSPACE_NOTICES_DISMISS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function dismissWorkspaceNotice(id) {
  try {
    const next = Array.from(new Set([...readDismissedWorkspaceNotices(), String(id)])).slice(-20);
    window.localStorage.setItem(WORKSPACE_NOTICES_DISMISS_KEY, JSON.stringify(next));
  } catch {
    // localStorage unavailable (private mode): the notice reappears next
    // load, which is acceptable for an informational strip.
  }
}

function workspaceNoticeVersion(id) {
  const match = /^platform-version:(.+)$/.exec(String(id));
  return match ? match[1] : null;
}

function renderWorkspaceNotices(items) {
  const strip = $('workspace-notices');
  if (!strip) return;
  const dismissed = new Set(readDismissedWorkspaceNotices());
  const fragment = document.createDocumentFragment();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id || '');
    if (!id || dismissed.has(id)) continue;
    const kind = item.kind === 'degraded' ? 'degraded' : 'info';
    const row = document.createElement('div');
    row.className = 'workspace-notice kind-' + kind;
    const icon = document.createElement('span');
    icon.className = 'workspace-notice-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = kind === 'degraded' ? '!' : 'i';
    const copy = document.createElement('div');
    copy.className = 'workspace-notice-copy';
    const title = document.createElement('strong');
    title.textContent = String(item.title || '平台通知');
    copy.append(title);
    if (item.detail) {
      const detail = document.createElement('span');
      detail.textContent = String(item.detail);
      copy.append(detail);
    }
    row.append(icon, copy);
    const version = workspaceNoticeVersion(id);
    if (version && state.noticeFirstVersion && state.noticeFirstVersion !== version) {
      row.classList.add('is-changed');
      title.textContent = '平台已更新到 ' + version;
      const reload = document.createElement('button');
      reload.type = 'button';
      reload.className = 'button button-ghost button-small workspace-notice-reload';
      reload.textContent = '刷新页面';
      reload.addEventListener('click', () => window.location.reload());
      row.append(reload);
    }
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'workspace-notice-dismiss';
    close.setAttribute('aria-label', '关闭这条通知');
    const closeGlyph = document.createElement('span');
    closeGlyph.setAttribute('aria-hidden', 'true');
    closeGlyph.textContent = '✕';
    close.append(closeGlyph);
    close.addEventListener('click', () => {
      dismissWorkspaceNotice(id);
      row.remove();
      strip.hidden = strip.childElementCount === 0;
    });
    row.append(close);
    fragment.append(row);
  }
  strip.replaceChildren(fragment);
  strip.hidden = strip.childElementCount === 0;
}

async function loadWorkspaceNotices({ force = false } = {}) {
  const strip = $('workspace-notices');
  if (!strip) return;
  const now = Date.now();
  if (!force && now - workspaceNoticesLastFetchMs < WORKSPACE_NOTICES_REFETCH_MS) return;
  workspaceNoticesLastFetchMs = now;
  try {
    const payload = await request('/sim2real/notices');
    const items = Array.isArray(payload?.notices) ? payload.notices : [];
    if (state.noticeFirstVersion === null) {
      for (const item of items) {
        const version = workspaceNoticeVersion(String(item?.id || ''));
        if (version) {
          state.noticeFirstVersion = version;
          break;
        }
      }
    }
    renderWorkspaceNotices(items);
  } catch {
    // Notices are informational; connection problems are already the
    // status banner's job, so a failed fetch leaves the strip as-is.
  }
}

class ApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}
function friendlyError(error, fallback = '操作失败') {
  const code = error?.payload?.error || error?.payload?.code;
  const map = {
    SIM2REAL_INVALID_MANIFEST: '模型清单不符合要求，请先点击“校验清单”查看具体问题。',
    SIM2REAL_MODEL_EXISTS: '这个模型版本已经登记过了。',
    SIM2REAL_PROJECT_EXISTS: '当前账号已有相同项目标识，请换一个项目标识。',
    SIM2REAL_INVALID_PROJECT: '项目名称或项目标识不符合要求，请检查后重试。',
    SIM2REAL_PROJECT_REFERENCE_INVALID: '项目引用的模型或数据集不可用，请刷新后重试。',
    SIM2REAL_AUTH_REQUIRED: '请先登录后再执行此操作。',
  };
  const raw = error instanceof Error ? error.message : fallback;
  if (map[code]) return map[code];
  return raw.replace(/contract\.jointCount must be a positive number/gi, '关节数量必须是大于 0 的数字').replace(/must be a positive number/gi, '必须是大于 0 的数字').replace(/is required/gi, '为必填项');
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
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(error instanceof Error ? error.message : '网络连接失败', 0, null);
  }
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await response.json().catch(() => null)
    : await response.text().catch(() => '');
  if (
    typeof payload === 'string' &&
    payload.includes('登录 · RDK Robot Learning Platform')
  ) {
    // An expired session can come back as a 200 that followed a redirect to
    // the login document. Surface it as a session-expired 401 (gate + toast)
    // instead of letting callers parse HTML and fail silently.
    setAuthGate(null);
    throw new ApiError('登录已过期，请重新登录。', 401, null);
  }
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
  // Idempotent: repeating the same state (e.g. the non-silent finally after a
  // silent poll never set loading) must not rewrite aria-busy/classList, which
  // fires attribute mutations for assistive tech and observers on every poll.
  if (state.loading === value && state.overview) return;
  state.loading = value;
  document.body.classList.toggle('is-loading', value);
  $('main-content')?.setAttribute('aria-busy', value ? 'true' : 'false');
  $('refresh-button')?.toggleAttribute('disabled', value);
  // `loadOverview()` renders the workspace while its request is still in
  // flight.  Keep the project CTA in sync when that request settles; without
  // this final transition it stays disabled after the initial loading paint
  // until another unrelated render happens.
  const projectCreate = $('project-create-button');
  if (projectCreate) projectCreate.disabled = value || state.authRequired;
  const retry = $('workspace-status-retry');
  if (retry) retry.disabled = value;
  syncServicePill();
}

const WORKFLOW_VIEWS = [
  'overview',
  'simulate',
  'train',
  'resources',
  'evaluate',
  'deploy',
  'records',
  'station',
];

// The persistent chrome only names the two decisions needed for orientation:
// which project is active and which stage is open. Model, device, run and
// backend details remain available in the environment drawer below it.
const VIEW_STAGE_LABELS = {
  overview: '工作台',
  simulate: '仿真与录制',
  train: '强化学习训练',
  resources: 'GPU 与算力',
  evaluate: 'Sim2Real 评测',
  deploy: '部署与反馈',
  records: '证据与记录',
  station: '设备控制台',
};

// Sidebar child entries are real workflow nodes. A node may share a top-level
// view with another node, but it always selects a distinct module, filter, or
// evidence panel so the destination is visible and bookmarkable.
const FLOW_CHILD_CONTEXTS = {
  simulate: { index: '01', kicker: '数据与仿真 / 01', title: '仿真与录制', description: '运行 MicroDuck 场景，录制可回放轨迹。', target: '仿真场' },
  replays: { index: '01', kicker: '数据与仿真 / 02', title: '轨迹与回放', description: '按 Run 筛选轨迹，并打开逐帧回放证据。', target: '记录 · Runs', view: 'records', recordTab: 'run', focus: '#history-list' },
  prepare: { index: '02', kicker: '训练与策略 / 01', title: '模型与契约', description: '登记 Manifest，校验观测、动作和设备兼容性。', target: '训练 · 模型契约', view: 'train', trainModule: 'contract', focus: '#contract-fold' },
  configure: { index: '02', kicker: '训练与策略 / 02', title: '训练配置', description: '选择算法、训练档位、GPU 资源和续训 checkpoint。', target: '训练 · 参数配置', view: 'train', trainModule: 'config', focus: '#train-module-config' },
  submit: { index: '02', kicker: '训练与策略 / 03', title: 'Run 与进度', description: '提交训练任务，查看实时曲线、状态和引擎日志。', target: '训练 · Run 工作台', view: 'train', trainModule: 'run', focus: '#train-module-run-model' },
  'evaluation-run': { index: '03', kicker: '评测与证据 / 01', title: '发起评测', description: '选择评测来源和目标，生成一份可追溯评测 Run。', target: '评测 · 评测运行', view: 'evaluate', evalModule: 'run', focus: '#evaluation-run-panel' },
  comparison: { index: '03', kicker: '评测与证据 / 02', title: '结果对比', description: '比较最近 Run 的成功率、奖励和跌倒率趋势。', target: '评测 · 结果对比', view: 'evaluate', evalModule: 'comparison', focus: '#evaluation-comparison-panel' },
  'evaluation-evidence': { index: '03', kicker: '评测与证据 / 03', title: '全部证据', description: '查看轨迹、训练、评测、制品和部署记录，保留完整证据链。', target: '记录 · 全部证据', view: 'records', recordTab: 'all', focus: '#history-list' },
  devices: { index: '04', kicker: '设备与发布 / 01', title: '设备管理', description: '登记设备、建立受控连接并查看设备能力。', target: '设备 · 设备连接', view: 'station', stationModule: 'devices', focus: '#station-device-manager' },
  preflight: { index: '04', kicker: '设备与发布 / 02', title: '预检与发布', description: '生成并执行只读预检，确认制品可以进入目标板卡。', target: '部署 · 只读预检', view: 'deploy', deployModule: 'preflight', focus: '#preflight-panel' },
  feedback: { index: '04', kicker: '设备与发布 / 03', title: '运行反馈与回滚', description: '查看上线闸门、部署时间线和可回滚版本。', target: '部署 · 运行反馈', view: 'deploy', deployModule: 'feedback', focus: '#feedback-panel' },
};

function parseHashLocation() {
  const raw = decodeURIComponent(window.location.hash.slice(1));
  const [view, child] = raw.split('/');
  return {
    view: WORKFLOW_VIEWS.includes(view) ? view : 'overview',
    child: child && FLOW_CHILD_CONTEXTS[child] ? child : '',
  };
}

function clearFlowChild() {
  document.body.removeAttribute('data-flow-child');
  $('flow-context')?.setAttribute('hidden', '');
  document.querySelectorAll('[data-flow-child]').forEach((control) => {
    control.classList.remove('is-active');
    control.removeAttribute('aria-current');
  });
}

// 顶栏“阶段”与标签页标题的文案：多个子项共用一个视图时带上子项名，
// 例如「强化学习训练 · 训练配置」；子项名与阶段名相同（仿真与录制）时不重复。
function flowStageLabel(view) {
  const stage = VIEW_STAGE_LABELS[view] || '工作台';
  const child = FLOW_CHILD_CONTEXTS[document.body.dataset.flowChild || ''];
  if (!child || (child.view || view) !== view || child.title === stage) return stage;
  return `${stage} · ${child.title}`;
}

// 对象链（项目→模型/策略→Run→评测证据→发布制品→设备）：把当前视图映射到
// 链上位置，回答"模型版本 / 策略包 / 运行记录 / 部署制品分别是什么、我现在
// 在哪一环"。链本身在 overview 标题下，可点击直达对应视图。
const OBJECT_CHAIN_VIEW_NODE = {
  overview: 'project',
  train: 'model',
  simulate: 'run',
  records: 'run',
  evaluate: 'evaluation',
  deploy: 'artifact',
  station: 'device',
};

function renderObjectChain() {
  const chain = $('object-chain');
  if (!chain) return;
  const here = OBJECT_CHAIN_VIEW_NODE[document.body.dataset.activeView || 'overview'];
  chain.querySelectorAll('[data-chain-node]').forEach((node) => {
    const active = node.dataset.chainNode === here;
    node.classList.toggle('is-here', active);
    if (active) node.setAttribute('aria-current', 'true');
    else node.removeAttribute('aria-current');
  });
}

function setView(view, { updateHash = true, scroll = true, focus = true } = {}) {
  const wanted = WORKFLOW_VIEWS.includes(view) ? view : 'overview';
  clearFlowChild();
  const changed = document.body.dataset.activeView !== wanted;
  document.body.dataset.activeView = wanted;
  // Keep the compact project / stage breadcrumb in sync even before the next
  // data refresh; changing views is itself a state change the user needs to see.
  renderContextLive();
  document.querySelectorAll('[data-view-section]').forEach((section) => {
    section.hidden = section.dataset.viewSection !== wanted;
  });
  // 子界面分割默认值：进入多模块视图而未指定子项时落到第一个模块，
  // 保证「一次只看到一个子项的内容」（D-002）。
  applySubinterfacePartition(wanted, document.body.dataset.flowChild || '');
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
  // Keep the tools group discoverable on the overview while reopening it when
  // navigation lands on resources, records, or the device console. A user can
  // still collapse it manually and that choice remains respected elsewhere.
  const toolsGroup = document.querySelector('[data-sidebar-group="tools"]');
  if (toolsGroup && ['resources', 'records', 'station'].includes(wanted)) toolsGroup.open = true;
  // Bare landings on evaluate/deploy show the sticky default module; a flow
  // child (sidebar subitem, in-view tab, hash) overrides it right after.
  if (wanted === 'evaluate') {
    document
      .querySelector('[data-view-section="evaluate"]')
      ?.setAttribute('data-active-eval-module', state.evalModule || 'run');
  }
  if (wanted === 'deploy') {
    document
      .querySelector('[data-view-section="deploy"]')
      ?.setAttribute('data-active-deploy-module', state.deployModule || 'preflight');
  }
  renderObjectChain();
  const locationState = parseHashLocation();
  const willPush = updateHash && locationState.view !== wanted;
  if (updateHash && locationState.child && !willPush) {
    // Same-view navigation keeps the current entry; strip its stale child
    // anchor (setFlowChild rewrites it right after). When a new entry will be
    // pushed instead, leave the old entry intact so Back restores its child.
    window.history.replaceState(
      { rdkView: wanted },
      '',
      window.location.pathname + window.location.search + '#' + wanted,
    );
  }
  if (willPush) {
    // Each in-app navigation becomes a real history entry so the browser Back
    // button steps between views instead of leaving the app entirely.
    // popstate (wired in wireEvents) drives the reverse direction; hashchange
    // from manual hash edits still re-syncs via updateHash=false. Sibling flow
    // children of the same view (configure → submit) replace the anchor via
    // setFlowChild instead of stacking junk #view entries here.
    window.history.pushState(
      { rdkView: wanted },
      '',
      window.location.pathname + window.location.search + '#' + wanted,
    );
  }
  // Reset the scroll position when switching views so a sticky header or a
  // previous deep scroll cannot hide the section title and its primary action.
  if (scroll) window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  // Keyboard and screen-reader users otherwise stay on the sidebar button
  // while the entire main content swaps beneath them. Move focus into the
  // view and announce the switch; skip when the change came from popstate
  // while focus already lives in the main content (e.g. deep link boot).
  if (changed && focus) {
    const main = $('main-content');
    if (main && !main.contains(document.activeElement)) main.focus({ preventScroll: true });
    announce(`已切换到：${VIEW_ANNOUNCEMENTS[wanted] || wanted}`);
  }
  // 视图内轮询统一由注册表收发：进入视图启动（评估页立即刷一帧），离开即停，
  // 避免后台空转。
  syncScopedPolls();
  // 窄屏下从抽屉里点了一个目的地就收起抽屉，否则正文仍被盖住。
  closeSidebarDrawer({ restoreFocus: false });
  // 视图切换会重排正文，截断情况随之改变（hidden 是属性变化，观察器里
  // 单独过滤了它，这里再主动排一次以免依赖时序）。
  scheduleTruncationTitles();
}

function setRecordsTab(tab) {
  const wanted = ['all', 'run', 'deploy', 'artifact', 'telemetry'].includes(tab) ? tab : 'all';
  state.recordsTab = wanted;
  document.querySelectorAll('[data-record-tab]').forEach((control) => {
    const active = control.dataset.recordTab === wanted;
    control.classList.toggle('is-active', active);
    control.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  renderHistory();
}

function focusFlowTarget(selector) {
  if (!selector) return;
  const target = document.querySelector(selector);
  if (!target) return;
  target.classList.remove('flow-focus-target');
  void target.offsetWidth;
  target.classList.add('flow-focus-target');
  window.setTimeout(() => target.classList.remove('flow-focus-target'), 1400);
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function applyFlowChildDestination(context) {
  if (!context) return;
  if (context.recordTab) setRecordsTab(context.recordTab);
  if (context.trainModule) setTrainModule(context.trainModule);
  if (context.stationModule) setStationModule(context.stationModule);
  if (context.evalModule) {
    state.evalModule = context.evalModule;
    document
      .querySelector('[data-view-section="evaluate"]')
      ?.setAttribute('data-active-eval-module', context.evalModule);
  }
  if (context.deployModule) {
    state.deployModule = context.deployModule;
    document
      .querySelector('[data-view-section="deploy"]')
      ?.setAttribute('data-active-deploy-module', context.deployModule);
  }
  // A focus target that is a <details> (e.g. the deploy feedback gate) shows
  // only its summary while collapsed — open it so the destination is panel
  // content, not a one-line fold. Train folds are handled inside setTrainModule.
  const target = context.focus ? $(context.focus.slice(1)) : null;
  if (target && target.tagName === 'DETAILS') target.setAttribute('open', '');
}

function setFlowChild(child, { updateHash = true, focus = true } = {}) {
  const wanted = String(child || '');
  const context = FLOW_CHILD_CONTEXTS[wanted];
  if (!context) {
    clearFlowChild();
    return;
  }
  document.body.dataset.flowChild = wanted;
  // body 自身也带 data-flow-child（全局状态标记），控制类匹配必须跳过它，
  // 否则 aria-current 会落到 body 上，父分组也找不到真正的侧边栏入口。
  document.querySelectorAll('[data-flow-child]').forEach((control) => {
    if (control === document.body) return;
    const active = control.dataset.flowChild === wanted;
    control.classList.toggle('is-active', active);
    // 视图内页签（role=tab）用 aria-selected 表达选中态；侧栏子项沿用
    // aria-current=page，两者语义不同，不能混用。
    if (control.getAttribute('role') === 'tab') {
      control.setAttribute('aria-selected', active ? 'true' : 'false');
    } else if (active) {
      control.setAttribute('aria-current', 'page');
    } else {
      control.removeAttribute('aria-current');
    }
  });
  // 子界面分割（D-002）：让视图只展示当前子项自己的面板。
  applySubinterfacePartition(document.body.dataset.activeView || 'overview', wanted);
  renderContextLive();
  const active = [...document.querySelectorAll('[data-flow-child]')].find(
    (control) => control !== document.body && control.dataset.flowChild === wanted,
  );
  active?.closest('.sidebar-nav-group')?.setAttribute('open', '');
  const banner = $('flow-context');
  banner?.removeAttribute('hidden');
  setText('flow-context-index', context.index);
  setText('flow-context-kicker', context.kicker);
  setText('flow-context-title', context.title);
  setText('flow-context-description', context.description);
  setText('flow-context-target', context.target);
  const view = document.body.dataset.activeView || context.view || 'overview';
  if (updateHash && window.location.hash !== `#${view}/${wanted}`) {
    window.history.replaceState({ rdkView: view, rdkFlowChild: wanted }, '', `${window.location.pathname}${window.location.search}#${view}/${wanted}`);
  }
  if (focus) window.setTimeout(() => focusFlowTarget(context.focus), 0);
}

function setTrainModule(module, { persist = true } = {}) {
  const wanted = ['run', 'contract', 'config', 'resources'].includes(module) ? module : 'run';
  const previous = state.trainModule;
  state.trainModule = wanted;
  const section = document.querySelector('[data-view-section="train"]');
  section?.setAttribute('data-active-train-module', wanted);
  section?.querySelector('.train-layout')?.setAttribute('data-train-active-module', wanted);
  // The contract and config tab panels are <details> folds shared with the run
  // view; a tab switch or hash deep link must land on them expanded, or the
  // tab renders as a single collapsed summary line.
  if (wanted === 'contract') section?.querySelector('#contract-fold')?.setAttribute('open', '');
  else if (previous === 'contract') section?.querySelector('#contract-fold')?.removeAttribute('open');
  if (wanted === 'config') section?.querySelector('#train-module-config')?.setAttribute('open', '');
  else if (previous === 'config') section?.querySelector('#train-module-config')?.removeAttribute('open');
  section?.querySelectorAll('[data-train-module-tab]').forEach((tab) => {
    const active = tab.dataset.trainModuleTab === wanted;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
    tab.tabIndex = active ? 0 : -1;
  });
  if (persist) {
    try { window.localStorage?.setItem('rdk-lab-train-module', wanted); } catch { /* optional */ }
  }
}

function setStationModule(module) {
  const wanted = ['devices', 'telemetry', 'control', 'policy', 'diagnostics'].includes(module)
    ? module
    : 'telemetry';
  const section = document.querySelector('[data-view-section="station"]');
  section?.setAttribute('data-active-station-module', wanted);
  section?.querySelector('.station-layout')?.setAttribute('data-active-station-module', wanted);
  document.querySelectorAll('[data-station-module-tab]').forEach((tab) => {
    const active = tab.dataset.stationModuleTab === wanted;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
    // roving tabindex：整组 tab 只占一个 Tab 停靠点，组内用方向键移动。
    tab.setAttribute('tabindex', active ? '0' : '-1');
  });
}

function modelLabel(model) {
  const name = model?.manifest?.displayName || model?.manifest?.modelId || '未命名模型';
  const version = model?.manifest?.version ? ' · ' + model.manifest.version : '';
  return name + version;
}

function selectedModel() {
  const linkedModelIds = projectModelIds();
  return (
    state.overview?.models?.find(
      (model) =>
        String(model.id) === String(state.selectedModelId) &&
        model.manifest?.robot?.id === state.productId &&
        (!linkedModelIds || linkedModelIds.has(String(model.id))),
    ) ||
    (state.model?.manifest?.robot?.id === state.productId &&
    (!linkedModelIds || linkedModelIds.has(String(state.model.id)))
      ? state.model
      : null)
  );
}

function selectedProductProfile() {
  const fallback = PRODUCT_PROFILES[state.productId] || PRODUCT_PROFILES.microduck;
  const remote = state.productProfiles?.find((profile) => profile.id === state.productId);
  return remote ? Object.assign({}, fallback, remote) : fallback;
}

function selectedProject() {
  const id = String(state.projectId || '');
  return id ? state.projects?.find((project) => String(project.id) === id) || null : null;
}

function projectModelIds(project = selectedProject()) {
  if (!project) return null;
  return new Set(
    (Array.isArray(project.modelIds) ? project.modelIds : [])
      .map((id) => String(id).trim())
      .filter(Boolean),
  );
}

function projectDatasetIds(project = selectedProject()) {
  if (!project) return null;
  return new Set(
    (Array.isArray(project.datasetIds) ? project.datasetIds : [])
      .map((id) => String(id).trim())
      .filter(Boolean),
  );
}

function projectIncludesRecord(record) {
  const project = selectedProject();
  if (!project) return true;
  // Legacy records may not carry projectId. Keep them visible only when their
  // model or dataset is explicitly linked to the selected project. An empty
  // project therefore has a truthful empty state instead of silently showing
  // account-wide runs that cannot be attributed to it.
  if (record?.projectId) return String(record.projectId) === String(project.id);
  const modelIds = projectModelIds(project);
  if (record?.modelId) return modelIds.has(String(record.modelId));
  const datasetIds = projectDatasetIds(project);
  if (record?.datasetId) return datasetIds.has(String(record.datasetId));
  return false;
}

function projectDisplayName(project) {
  return String(project?.name || project?.slug || '未命名项目').trim() || '未命名项目';
}

function projectLabelById(projectId) {
  const id = String(projectId || '').trim();
  if (!id) return '';
  const project = (state.projects || []).find((item) => String(item.id) === id);
  return project ? projectDisplayName(project) : id;
}

function stampTelemetryContext(evidence) {
  if (!evidence || typeof evidence !== 'object') return evidence;
  const model = selectedModel();
  if (!evidence.modelId && model?.id) evidence.modelId = model.id;
  if (!evidence.projectId && state.projectId) evidence.projectId = state.projectId;
  return evidence;
}

function renderProjectContext() {
  const select = $('project-select');
  const project = selectedProject();
  // A project can be removed or become invisible after an account switch. Do
  // not leave a stale local id selected; fall back to the account-wide view.
  if (state.projectsLoaded && state.projectId && !project) {
    state.projectId = '';
    saveWorkspaceContext();
  }
  if (select) {
    const current = state.projectId;
    syncSelect(
      select,
      [
        { value: '', textContent: '全部项目' },
        ...(state.projects || []).map((item) => ({
          value: String(item.id),
          textContent: projectDisplayName(item),
          title: item.description ? String(item.description) : '',
        })),
      ],
      current && (state.projects || []).some((item) => String(item.id) === current) ? current : '',
    );
  }
  const profile = selectedProductProfile();
  const header = project ? `${projectDisplayName(project)} · ${profile.displayName}` : profile.projectName;
  setText('current-project-name', header);
  const note = $('project-context-note');
  if (note) {
    if (state.projectsLoadError) note.textContent = '项目列表暂不可用 · 点击“重新连接”重试';
    else if (state.authRequired && !state.overview) note.textContent = '登录后可保存项目与训练记录';
    else if (!state.overview || !state.projectsLoaded) note.textContent = '项目列表加载中…';
    else if (project) {
      const modelCount = projectModelIds(project)?.size || 0;
      const datasetCount = projectDatasetIds(project)?.size || 0;
      note.textContent = `${modelCount} 个模型 · ${datasetCount} 个数据集已绑定`;
    } else {
      note.textContent = state.projects?.length ? `${state.projects.length} 个项目 · 显示全部资源` : '还没有项目 · 可先创建一个';
    }
  }
  const scope = $('project-dialog-scope');
  if (scope) {
    const model = selectedModel();
    scope.textContent = model
      ? `创建后会绑定当前模型“${modelLabel(model)}”；数据集可以在项目详情中继续关联。`
      : '当前还没有选中的模型；可以先创建空项目，再从训练页登记模型。';
  }
  const create = $('project-create-button');
  if (create) create.disabled = state.authRequired || state.serviceError || state.loading;
}

function projectSlugFromName(value) {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56);
  return slug || `project-${Date.now().toString(36)}`;
}

function setProjectDialogError(message) {
  const node = $('project-dialog-error');
  if (!node) return;
  node.textContent = String(message || '');
  node.hidden = !message;
}

function openProjectDialog() {
  const dialog = $('project-dialog');
  if (!(dialog instanceof HTMLDialogElement)) return;
  const name = $('project-name-input');
  const slug = $('project-slug-input');
  const description = $('project-description-input');
  if (name) name.value = '';
  if (slug) {
    slug.value = '';
    delete slug.dataset.touched;
  }
  if (description) description.value = '';
  setProjectDialogError('');
  renderProjectContext();
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  window.requestAnimationFrame(() => name?.focus());
}

let projectSubmitting = false;

async function submitProject(event) {
  event.preventDefault();
  if (projectSubmitting) return;
  const name = String($('project-name-input')?.value || '').trim();
  if (!name) {
    setProjectDialogError('请输入项目名称。');
    $('project-name-input')?.focus();
    return;
  }
  const slugInput = String($('project-slug-input')?.value || '').trim().toLowerCase();
  const slug = slugInput || projectSlugFromName(name);
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(slug)) {
    setProjectDialogError('项目标识需为 2–64 位小写字母、数字或短横线。');
    $('project-slug-input')?.focus();
    return;
  }
  projectSubmitting = true;
  const submit = $('project-dialog-submit');
  if (submit) {
    submit.disabled = true;
    submit.textContent = '创建中…';
  }
  setProjectDialogError('');
  const model = selectedModel();
  try {
    const payload = await request('/sim2real/projects', {
      method: 'POST',
      body: JSON.stringify({
        name,
        slug,
        description: String($('project-description-input')?.value || '').trim(),
        modelIds: model?.id ? [model.id] : [],
        datasetIds: [],
      }),
    });
    const project = payload?.project;
    if (!project?.id) throw new Error('项目创建成功但未返回项目 ID');
    state.projects = [project, ...(state.projects || []).filter((item) => String(item.id) !== String(project.id))];
    state.projectsLoaded = true;
    state.projectsLoadError = false;
    state.projectId = project.id;
    saveWorkspaceContext();
    const dialog = $('project-dialog');
    if (dialog instanceof HTMLDialogElement && dialog.open) dialog.close();
    else dialog?.removeAttribute('open');
    renderAll();
    showToast(`项目“${projectDisplayName(project)}”已创建`, 'success');
  } catch (error) {
    setProjectDialogError(friendlyError(error, '项目创建失败，请稍后重试。'));
  } finally {
    projectSubmitting = false;
    if (submit) {
      submit.disabled = false;
      submit.textContent = '创建项目';
    }
  }
}

async function attachModelToSelectedProject(modelId) {
  const project = selectedProject();
  const id = String(modelId || '').trim();
  if (!project || !id) return project;
  const modelIds = [...new Set([...(Array.isArray(project.modelIds) ? project.modelIds : []), id])];
  if (modelIds.length === (project.modelIds || []).length) return project;
  const payload = await request('/sim2real/projects/' + encodeURIComponent(project.id), {
    method: 'PATCH',
    body: JSON.stringify({ modelIds }),
  });
  const updated = payload?.project || { ...project, modelIds };
  state.projects = (state.projects || []).map((item) => String(item.id) === String(updated.id) ? updated : item);
  state.projectsLoaded = true;
  state.projectsLoadError = false;
  return updated;
}

function selectedTask() {
  return ACTION_TASKS[state.taskId] || ACTION_TASKS.walk;
}

// Engine-side scenes (multi-duck football, balance rigs) never appear in the
// single-duck browser sandbox; state that wherever the task is shown, or the
// task switch reads as a no-op to the operator.
function taskContextNote(task) {
  return task.scene
    ? `${task.hint}。训练在引擎侧场景（${task.scene}）中进行；浏览器沙盒保持单鸭，画面不随任务切换。`
    : `${task.hint}。切换后会同步仿真、训练和评测参数。`;
}

function selectedDevice() {
  return state.overview?.devices?.find((device) => device.id === state.selectedDeviceId) || null;
}

function stateClass(status) {
  return SimTelemetryCore.stateClass(status);
}

function statusLabel(status) {
  return SimTelemetryCore.statusLabel(status);
}

function renderSelects() {
  const allModels = state.overview?.models || [];
  const linkedModelIds = projectModelIds();
  const models = allModels.filter((model) =>
    model.manifest?.robot?.id === state.productId &&
    (!linkedModelIds || linkedModelIds.has(String(model.id))),
  );
  const devices = state.overview?.devices || [];
  const taskSelect = $('task-select');
  const productSelect = $('product-select');
  const modelSelect = $('model-select');
  const deviceSelect = $('device-select');
  const computeSelect = $('compute-resource-select');
  if (!PRODUCT_PROFILES[state.productId]) state.productId = 'microduck';
  if (productSelect) productSelect.value = state.productId;
  if (taskSelect) {
    const taskIds = state.productId === 'originbot' ? ORIGINBOT_TASK_IDS : Object.keys(ACTION_TASKS).filter((id) => !ORIGINBOT_TASK_IDS.includes(id));
    if (!taskIds.includes(state.taskId)) state.taskId = state.productId === 'originbot' ? 'goal-navigation' : 'walk';
    syncSelect(
      taskSelect,
      taskIds.map((id) => ({ value: id, textContent: ACTION_TASKS[id].label })),
      state.taskId,
    );
    // Keep the task context visibly in sync with the native select.  The
    // action library below describes the model's controls, while this note
    // describes the workflow task selected by the operator.  Previously the
    // select changed state but the neighbouring copy stayed static, making a
    // successful change look like a no-op.
    const taskNote = taskSelect.closest('.sim-context-panel')?.querySelector('.small-note');
    if (taskNote) {
      const task = selectedTask();
      taskNote.textContent = `${task.hint}。点击仿真器“开始录制”生成轨迹，录制后可在评测页回放。`;
    }
    document.querySelectorAll('[data-replay-task-link]').forEach((link) => {
      link.textContent = `查看「${selectedTask().label}」最近回放 ↗`;
    });
  }
  if (modelSelect) {
    if (!models.some((model) => model.id === state.selectedModelId)) {
      // Default to the newest user-registered model: a builtin reference
      // policy must not outrank the artifact the operator just trained.
      const byRecency = [...models].sort((a, b) =>
        String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')),
      );
      state.selectedModelId = (byRecency.find((model) => !model.builtin) || byRecency[0])?.id || '';
    }
    syncSelect(
      modelSelect,
      models.length
        ? models.map((model) => ({ value: model.id, textContent: modelLabel(model) }))
        : [{
            value: '',
            textContent:
              state.productId === 'rdk-duck' ? '暂无 RDK Duck 模型 · 请导入 manifest' : state.productId === 'originbot' ? '暂无 OriginBot 模型 · 请导入 manifest' : '暂无模型',
          }],
      state.selectedModelId,
    );
  }
  if (deviceSelect) {
    const selectedDevice = devices.find((device) => device.id === state.selectedDeviceId);
    const newestCheckedAt = devices
      .map((device) => String(device.lastCheckedAt ?? ''))
      .sort()
      .pop();
    // A persisted selection pointing at a board that is disconnected while a
    // more recently verified device exists is a stale registration the
    // operator replaced; it must not keep the default away from the live board.
    const selectionStale =
      selectedDevice?.status === 'disconnected' &&
      Boolean(newestCheckedAt) &&
      String(selectedDevice.lastCheckedAt ?? '') < String(newestCheckedAt);
    if (!devices.length) {
      state.selectedDeviceId = '';
    } else if (!selectedDevice || selectionStale) {
      // Default to the most recently verified board so a newly attached
      // device outranks a stale registration that was never reconnected.
      const byRecency = [...devices].sort((a, b) =>
        String(b.lastCheckedAt ?? b.boardDetectedAt ?? '').localeCompare(
          String(a.lastCheckedAt ?? a.boardDetectedAt ?? ''),
        ),
      );
      state.selectedDeviceId = byRecency[0]?.id || '';
    }
    syncSelect(
      deviceSelect,
      devices.length
        ? devices.map((device) => ({ value: device.id, textContent: device.name || device.id }))
        : [{ value: '', textContent: '没有已登记的板卡' }],
      state.selectedDeviceId,
    );
  }
  if (computeSelect) {
    const resources = state.overview?.computeResources || [];
    if (!resources.some((resource) => resource.id === state.selectedComputeResourceId)) state.selectedComputeResourceId = '';
    syncSelect(
      computeSelect,
      [
        { value: '', textContent: 'AI 自动选择（推荐）', ai: true },
        ...resources.map((resource) => ({
          value: resource.id,
          textContent: `${resource.name} · ${resource.status === 'online' ? '在线' : resource.status === 'offline' ? '离线' : '未测试'}`,
        })),
      ],
      state.selectedComputeResourceId,
    );
  }
  setText('model-count', models.length + ' 个 ' + selectedProductProfile().displayName + ' 模型');
  setText('device-count', devices.length + ' 块板卡');
  renderProjectContext();
}

function renderComputeResources() {
  const resources = state.overview?.computeResources || [];
  setText('compute-resource-count', resources.length + ' 个');
  const list = $('compute-resource-list');
  if (!list) return;
  list.replaceChildren();
  if (!resources.length) {
    const empty = document.createElement('p'); empty.className = 'empty-inline'; empty.textContent = '还没有接入 GPU。添加后可在上方训练资源中选择。'; list.append(empty); return;
  }
  for (const resource of resources) {
    const card = document.createElement('div'); card.className = 'compute-resource-card';
    const status = resource.status === 'online' ? '在线' : resource.status === 'offline' ? '离线' : '未测试';
    card.innerHTML = `<div class="compute-resource-card-main"><strong></strong><span class="state-badge state-${resource.status === 'online' ? 'ok' : resource.status === 'offline' ? 'error' : 'neutral'}">${status}</span><small></small></div><div class="compute-resource-card-meta"></div><div class="compute-resource-card-actions"><button type="button" class="button button-ghost button-small" data-resource-action="test">重新检查</button><button type="button" class="button button-ghost button-small" data-resource-action="edit">编辑</button><button type="button" class="button button-ghost button-small" data-resource-action="delete">删除</button></div>`; // escape-audit:allow status is a local literal ternary (在线/离线/未测试)
    card.querySelector('strong').textContent = resource.name;
    card.querySelector('small').textContent = resource.tokenConfigured ? '已配置访问令牌' : '未配置访问令牌';
    const sourceLabel = resource.source === 'local-agent' ? '用户本地 Agent' : resource.source === 'robogo' ? 'RoboGo 云端' : '服务器 Runner';
    card.querySelector('.compute-resource-card-meta').textContent = [sourceLabel, resource.gpuName, resource.cuda ? 'CUDA' : '', resource.runnerUrl, resource.message].filter(Boolean).join(' · ');
    card.querySelectorAll('[data-resource-action]').forEach((button) => button.addEventListener('click', () => handleComputeResourceAction(button.dataset.resourceAction, resource)));
    list.append(card);
  }
}

function resetComputeResourceForm() {
  state.computeResourceEditingId = '';
  document.querySelector('.compute-resource-add')?.removeAttribute('open');
  $('compute-resource-editing-id').value = '';
  $('compute-resource-name').value = '';
  $('compute-resource-url').value = '';
  $('compute-resource-token').value = '';
  $('compute-resource-concurrency').value = '1';
  $('compute-resource-save').textContent = '添加 GPU';
  $('compute-resource-cancel').hidden = true;
  setText('compute-resource-form-status', '');
}

async function handleComputeResourceAction(action, resource) {
  if (action === 'edit') {
    document.querySelector('.compute-resource-add')?.setAttribute('open', '');
    state.computeResourceEditingId = resource.id;
    $('compute-resource-editing-id').value = resource.id;
    $('compute-resource-name').value = resource.name || '';
    $('compute-resource-url').value = resource.runnerUrl || '';
    $('compute-resource-token').value = '';
    $('compute-resource-concurrency').value = String(resource.maxConcurrentJobs || 1);
    $('compute-resource-save').textContent = '保存修改'; $('compute-resource-cancel').hidden = false;
    $('compute-resource-name').focus(); return;
  }
  try {
    if (action === 'delete') {
      const approved = await confirmAction({
        title: '删除 GPU 资源',
        note: `确定删除“${resource.name}”？删除后引用它的训练提交会回到服务端默认 Worker。`,
        approveLabel: '删除',
      });
      if (!approved) return;
      await request('/sim2real/compute-resources/' + encodeURIComponent(resource.id), { method: 'DELETE' });
      if (state.selectedComputeResourceId === resource.id) state.selectedComputeResourceId = '';
      showToast('GPU 资源已删除', 'success');
    } else if (action === 'test') {
      setText('compute-resource-form-status', '正在测试连接…');
      let payload;
      if (resource.source === 'local-agent') {
        const health = await fetch('http://127.0.0.1:19190/proxy/healthz', { signal: AbortSignal.timeout(3000) });
        const healthBody = await health.json().catch(() => ({}));
        if (!health.ok || healthBody.ok !== true) throw new Error('本机 Agent 或 Worker 不可用');
        const device = healthBody.device || healthBody;
        const updated = await request('/sim2real/compute-resources/' + encodeURIComponent(resource.id), {
          method: 'PATCH',
          body: JSON.stringify({
            status: 'online',
            message: '浏览器已直连本机 Agent。',
            lastCheckedAt: new Date().toISOString(),
            ...(typeof device.gpuName === 'string' ? { gpuName: device.gpuName } : {}),
            ...(device.cuda === true || device.cuda === false ? { cuda: device.cuda } : {}),
            ...(Number.isFinite(Number(device.vramMb)) ? { vramMb: Number(device.vramMb) } : {}),
          }),
        });
        payload = { connected: true, computeResource: updated.computeResource };
      } else {
        payload = await request('/sim2real/compute-resources/' + encodeURIComponent(resource.id) + '/test', { method: 'POST' });
      }
      showToast(payload.connected ? resource.name + ' 已连接' : resource.name + ' 连接失败', payload.connected ? 'success' : 'error');
    }
    await loadOverview({ quiet: true });
  } catch (error) {
    showRecoverableError(
      'GPU 资源操作失败',
      error instanceof Error ? error.message : '',
      '查看 GPU 状态',
      () => setView('resources'),
    );
  }
}

async function saveComputeResource(event) {
  event.preventDefault();
  const id = $('compute-resource-editing-id').value.trim();
  const token = $('compute-resource-token').value.trim();
  const runnerUrl = $('compute-resource-url').value.trim();
  const localAgent = /^https?:\/\/127\.0\.0\.1:19190\/proxy(?:$|\/)/.test(runnerUrl) || /^https?:\/\/localhost:19190\/proxy(?:$|\/)/.test(runnerUrl);
  const body = { name: $('compute-resource-name').value.trim(), runnerUrl, source: localAgent ? 'local-agent' : 'server-runner', maxConcurrentJobs: Number($('compute-resource-concurrency').value || 1) };
  if (!id || token) body.runnerToken = token;
  try {
    setText('compute-resource-form-status', '保存中…');
    await request(id ? '/sim2real/compute-resources/' + encodeURIComponent(id) : '/sim2real/compute-resources', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(body) });
    resetComputeResourceForm(); showToast(id ? 'GPU 资源已更新' : 'GPU 资源已添加', 'success'); await loadOverview({ quiet: true });
  } catch (error) { setText('compute-resource-form-status', error instanceof Error ? error.message : '保存失败'); }
}

async function autoDetectLocalGpuAgent() {
  const status = $('compute-resource-form-status');
  setText('compute-resource-form-status', '正在查找本机 GPU Agent…');
  const candidates = ['http://127.0.0.1:19190', 'http://localhost:19190'];
  let agentBase = '';
  let payload = null;
  for (const base of candidates) {
    try {
      const response = await fetch(`${base}/healthz`, {
        mode: 'cors',
        cache: 'no-store',
        signal: AbortSignal.timeout(2500),
      });
      if (!response.ok) continue;
      const body = await response.json();
      if (body?.ok !== true || body?.agent !== 'rdk-local-gpu-agent') continue;
      agentBase = base;
      payload = body;
      break;
    } catch {
      // Embedded browsers can resolve localhost and 127.0.0.1 differently;
      // try the other loopback spelling before reporting a missing agent.
    }
  }
  if (!agentBase) {
    setText('compute-resource-form-status', '未发现 Agent。请确认终端中的 Agent 进程仍在运行，然后重试。');
    return;
  }
  // A freshly installed Agent has no resource card until it is configured.
  // Register the default local Worker endpoint so discovery works even before
  // the Worker process is started; the card will accurately remain offline.
  if (!payload?.resource) {
    try {
      const configured = await fetch(`${agentBase}/config`, {
        method: 'POST',
        mode: 'cors',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workerUrl: 'http://127.0.0.1:19091', name: '本机 GPU Agent' }),
        signal: AbortSignal.timeout(2500),
      });
      if (configured.ok) payload = await configured.json();
    } catch {
      // The health check is still enough to let the user add the resource.
    }
  }
  const resource = payload?.resource;
  $('compute-resource-name').value = resource?.name || '本机 GPU Agent';
  $('compute-resource-url').value = `${agentBase}/proxy/train`;
  if (resource) {
    setText('compute-resource-form-status', '已发现本机 Agent，点击“添加 GPU”完成接入。');
  } else {
    setText('compute-resource-form-status', '已发现 Agent，但本机 Worker 尚未连接；先启动 Local Worker，再点击“添加 GPU”。');
  }
}

async function showGpuAgentInstallCommand() {
  const commandNode = $('compute-resource-install-command');
  if (!commandNode) return;
  const scriptUrl = `${window.location.origin}${BASE_PATH}/agent/install.sh`;
  const command = `curl -fsSLo /tmp/rdk-gpu-agent-install.sh '${scriptUrl}' && sh /tmp/rdk-gpu-agent-install.sh`;
  commandNode.textContent = command;
  commandNode.hidden = false;
  try {
    await navigator.clipboard.writeText(command);
    setText('compute-resource-form-status', '安装命令已复制。请在用户电脑终端执行，完成后返回点击“自动发现本机 Agent”。');
  } catch {
    setText('compute-resource-form-status', '请复制下方安装命令，在用户电脑终端执行。');
  }
}

async function connectRemoteGpuThroughAgent() {
  setText('compute-resource-form-status', '正在让本机 Agent 建立 SSH 隧道…');
  try {
    const response = await fetch('http://127.0.0.1:19190/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'remote-ssh-gpu',
        name: $('compute-resource-ssh-name').value.trim() || '远程 GPU 服务器',
        host: $('compute-resource-ssh-host').value.trim(),
        user: $('compute-resource-ssh-user').value.trim() || 'root',
        sshPort: Number($('compute-resource-ssh-port').value || 22),
        remotePort: Number($('compute-resource-remote-port').value || 19091),
        localPort: 19092,
        workerToken: $('compute-resource-remote-token').value.trim(),
      }),
      signal: AbortSignal.timeout(5000),
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.message || payload.error || 'SSH 连接失败');
    $('compute-resource-name').value = payload.resource?.name || '远程 GPU 服务器';
    $('compute-resource-url').value = 'http://127.0.0.1:19190/proxy/train';
    $('compute-resource-token').value = '';
    setText('compute-resource-form-status', 'SSH 隧道已建立，点击“添加 GPU”保存该远程资源。');
  } catch (error) {
    setText('compute-resource-form-status', error instanceof Error ? error.message : 'SSH 连接失败');
  }
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
  const originbotProduct = profile.id === 'originbot';
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
  const computeResources = state.overview?.computeResources || [];
  const selectedComputeResource = computeResources.find(
    (resource) => String(resource.id) === String(state.selectedComputeResourceId),
  );
  const selectedResourceReady = selectedComputeResource?.status === 'online';
  // `configured` distinguishes an endpoint that exists but is blocked by a
  // missing production bearer from an endpoint that has not been registered;
  // both are unavailable for execution, but they need different operator
  // guidance in the workbench.
  const localConfigured = local.configured === true || local.available === true;
  const localAuthReady = local.available === true || selectedResourceReady;
  const localReachable = local.reachable === true;
  const localHealthy = local.healthy === true;
  const localReady = selectedResourceReady || (localAuthReady && localReachable && localHealthy);
  const overviewReady = Boolean(state.overview);
  // Logged-in users learn the simulator surface from the account-scoped
  // overview. A guest (401 on overview) instead reads the public healthz
  // probe, so the sandbox is playable without any account — the surface
  // gate itself (missing/redirect/mounted) is identical on both paths.
  const guestHealth = state.authRequired ? state.publicHealth : null;
  const guestSimulatorMounted = guestHealth
    ? guestHealth.microduck?.state !== 'missing'
    : false;
  const browserAvailable = Boolean(
    (overviewReady || guestSimulatorMounted) &&
      profile.simulatorPath &&
      (originbotProduct || simulator.browser?.available !== false),
  );
  setText(
    'service-status',
    state.authRequired
      ? '游客模式'
      : state.serviceError
        ? '服务不可用'
        : overviewReady
          ? '独立服务在线'
          : '检查中',
  );
  syncServicePill();
  const accountMenuWrap = $('account-menu-wrap');
  const accountDivider = $('account-divider');
  if (accountMenuWrap && accountDivider) {
    const accountLabel = identity?.displayName || identity?.accountId || '';
    accountMenuWrap.hidden = !accountLabel;
    accountDivider.hidden = !accountLabel;
    if (accountLabel) {
      setText('account-avatar-initial', accountLabel.trim().charAt(0).toUpperCase() || '·');
      setText('account-menu-name', accountLabel);
      setText('account-menu-id', identity?.email || identity?.accountId || '');
      const avatar = $('account-avatar');
      if (avatar) avatar.title = accountLabel;
      const menu = $('account-menu');
      if (menu) menu.hidden = true;
      const avatarButton = $('account-avatar');
      if (avatarButton) avatarButton.setAttribute('aria-expanded', 'false');
    }
  }
  // The header follows the selected project while retaining the robot profile
  // as a suffix, so operators can always tell which context a run belongs to.
  renderProjectContext();
  setText('sidebar-product-name', profile.displayName);
  // Keep device-facing screens aligned with the global target selector. A
  // fixed “RDK X5” title becomes misleading as soon as another board profile
  // is selected, which makes the deployment step look like a separate flow.
  setText('deploy-title', device?.name ? `部署到 ${device.name}` : '部署到目标设备');
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
  const simulatorLabels = SimTelemetryCore.simulatorStatusLabels(profile, browserAvailable);
  setText('status-simulator', simulatorLabels.title);
  setText('status-simulator-detail', simulatorLabels.detail);
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
  const guestWorkspace = state.authRequired && !state.overview;
  const readiness = guestWorkspace
    ? {
        state: 'waiting',
        label: '登录后可用',
        title: '游客模式可直接仿真；登录后可保存项目、模型与训练记录。',
      }
    : fullSoftwareDemoReady
    ? {
        state: 'ready',
        label: '预检已通过',
        title: '仿真、训练入口、台账和只读板端预检均已就绪；Canary / Live 仍需批准',
      }
    : softwareDemoReady
      ? {
          state: 'demo',
          label: '工作区可用',
          title: browserRunnable
            ? targetReady && !latestRealEvidence
              ? '可运行仿真、录制和训练流程；尚缺真实评测证据，不能视为真机就绪'
              : '可运行软件流程；设备只读预检尚未通过，不能视为真机就绪'
            : '模型、台账和软件流程可用；真实设备仍需通过 Local Bridge 和板端预检',
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
    selectedResourceReady
      ? '使用已连接 GPU 资源'
      : localAuthReady
      ? local.mock
        ? '运行 Mock 协议演示'
        : '发起本地强化学习训练'
      : localConfigured
        ? '修复本地训练 worker'
        : '登记本地训练 worker',
  );
  const localRunButton = $('local-run-button');
  if (localRunButton) {
    localRunButton.title = selectedResourceReady
      ? '向已测试的 GPU 训练资源提交 PPO / SAC 任务'
      : local.mock
      ? '仅验证训练协议和运行台账，不生成可部署模型'
      : localAuthReady
        ? '向已配置的本地强化学习 worker 提交 PPO / SAC 任务'
        : localConfigured
          ? '本地 worker 已登记，但认证配置未就绪；请补充至少 32 字节随机 bearer token'
          : '当前没有可用的本地强化学习 worker';
  }
  setText(
    'status-robogo',
    selectedResourceReady
      ? 'GPU 资源已连接'
      : localReady
      ? local.mock
        ? '本地 Mock 已连接'
        : '本地训练已连接'
      : localConfigured && localReachable
        ? '本地 worker 检查失败'
        : localConfigured && !localAuthReady
          ? '本地 worker 认证待修复'
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
    selectedResourceReady
      ? `${selectedComputeResource?.name || '所选 GPU'} 已通过连接测试。`
      : localConfigured
        ? local.message || local.reason || '本地 worker 状态未知'
      : robogo.message || local.reason || '只读读取训练资源',
  );
  const storageLabel = guestWorkspace
    ? '登录后可用'
    : !storageKnown
      ? '检查中'
      : storage.writable
        ? '台账可写'
        : '需要共享存储';
  setText('status-storage', storageLabel);
  setText('status-storage-card', storageLabel);
  setText(
    'status-storage-detail',
    guestWorkspace
      ? '游客模式不读取台账；登录后按账号隔离。'
      : storageKnown
        ? storage.message || '状态按账号隔离'
        : '正在读取台账状态',
  );
  const contextHealth = $('context-health');
  const contextState = !overviewReady || !storageKnown ? 'waiting' : storageReady ? 'ready' : 'blocked';
  contextHealth?.classList.toggle('is-ready', contextState === 'ready');
  contextHealth?.classList.toggle('is-blocked', contextState === 'blocked');
  contextHealth?.classList.toggle('is-waiting', contextState === 'waiting');
  const simulatorCard = $('status-simulator')?.closest('.status-card');
  const runnerCard = $('status-robogo')?.closest('.status-card');
  const boardCard = $('status-board')?.closest('.status-card');
  const storageCard = $('status-storage-card')?.closest('.status-card');
  setStatusSurface(
    simulatorCard,
    !overviewReady ? 'waiting' : browserAvailable ? 'ready' : 'blocked',
    simulatorLabels.detail,
  );
  setStatusSurface(
    runnerCard,
    !overviewReady
      ? 'waiting'
      : localReady || robogoReady
        ? 'ready'
        : localConfigured || selectedResourceReady
          ? 'error'
          : 'blocked',
    localReady || robogoReady ? '训练后端可用' : '训练后端待配置',
  );
  setStatusSurface(
    boardCard,
    !overviewReady ? 'waiting' : targetReady ? 'ready' : device ? 'partial' : 'blocked',
    device ? (targetReady ? '目标设备预检通过' : '目标设备待预检') : '尚未选择目标设备',
  );
  setStatusSurface(
    storageCard,
    !storageKnown ? 'waiting' : storageReady ? 'ready' : 'blocked',
    storageReady ? '台账可写' : '需要共享存储',
  );
  const actionHint = state.runSubmitting
    ? ['waiting', '正在提交运行请求…']
    : !overviewReady
      ? ['waiting', '正在读取模型、项目和训练后端状态…']
    : !model
      ? ['blocked', '请先在“模型契约”中载入并登记一个模型。']
      : !storageReady
        ? ['blocked', '台账不可写；训练和登记操作已阻断，请先配置共享存储。']
        : !hasRunnablePath
          ? ['blocked', '没有可用的训练后端；先接入本地 Worker、GPU 资源或 RoboGo。']
          : ['ready', '模型已就绪：可选择浏览器回放，或提交本地 / RoboGo 强化学习训练。'];
  setActionHint('run-action-hint', actionHint[0], actionHint[1]);
  const deployHint = !overviewReady
    ? '正在读取设备和 BoardAgent 状态…'
    : !model
    ? '先在训练页登记模型契约。'
    : !device
      ? '先到设备控制台登记并选择目标板卡。'
      : !targetDeployment
        ? '模型和板卡已选择；点击“生成预检计划”开始只读检查。'
        : boardAgent.available !== true
          ? `预检计划已生成，但当前 BoardAgent 不可用：${boardAgent.reason || '请在部署环境接入 agent'}`
          : targetReady
            ? '只读预检已通过；Canary / Live 仍需要人工批准和安全开关。'
            : '预检计划已生成；点击“执行只读预检”查看兼容性结果。';
  setActionHint(
    'deploy-action-hint',
    !overviewReady ? 'waiting' : targetReady ? 'ready' : !model || !device ? 'blocked' : 'waiting',
    deployHint,
  );
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
  if (simulatorTitle) simulatorTitle.textContent = microduckProduct ? 'MicroDuck 仿真场' : originbotProduct ? 'OriginBot 仿真适配器' : 'RDK Duck 仿真适配器';
  if (simulatorFrame) simulatorFrame.title = microduckProduct ? 'MicroDuck 浏览器仿真' : originbotProduct ? 'OriginBot 仿真适配器状态' : 'RDK Duck 仿真适配器状态';
  if (simulatorLiveText) {
    simulatorLiveText.textContent = browserAvailable
      ? '参考策略可用'
      : microduckProduct
        ? '资源待挂载'
        : originbotProduct ? '使用本地或外部 OriginBot 适配器' : '适配器待配置';
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
  const localMicroduckMounted = microduckProduct && simulator.browser?.state === 'mounted';
  const browserEntry = originbotProduct
    ? appRelativePath('/originbot-sim/')
    : localMicroduckMounted
      ? appRelativePath('/mujoco/microduck/')
      : simulator.browser?.entryUrl
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
      : originbotProduct
        ? 'OriginBot 浏览器仿真已就绪'
        : 'RDK Duck 仿真适配器待配置';
  }
  if (simulatorGateCopy) {
    simulatorGateCopy.textContent = microduckMissing
      ? '当前源码不内置上游静态包；请先按部署说明挂载经过审核的 release，再回到这里开始录制。'
      : originbotProduct
        ? '可直接在浏览器中生成 OriginBot 轨迹；真实设备连接、数据采集和部署预检在后续步骤完成。'
      : '当前产品线不会复用 MicroDuck 的浏览器场景。先准备真实契约 manifest 或本地 headless 仿真 worker；连接真机是部署前的后续步骤。';
  }
  if (simulatorGateTrain) simulatorGateTrain.hidden = microduckMissing;
  if (simulatorGateTrain && originbotProduct) {
    simulatorGateTrain.textContent = '使用默认模板开始 →';
    simulatorGateTrain.title = '进入训练页，直接使用内置 OriginBot starter manifest；也可在那里替换为自己的 manifest';
  } else if (simulatorGateTrain) {
    simulatorGateTrain.textContent = '去训练与模型 →';
    simulatorGateTrain.removeAttribute('title');
  }
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
        : originbotProduct
          ? 'OriginBot 浏览器仿真'
        : '适配器待配置',
  );
  const evidenceStatus = $('simulator-evidence-status');
  const browserEvidence = state.telemetry?.source === 'browser-microduck';
  evidenceStatus?.classList.toggle('is-ready', browserEvidence);
  if (evidenceStatus) {
    evidenceStatus.textContent = browserEvidence
      ? `已同步 ${state.telemetry.summary.sampleCount} 帧到评测证据`
      : '录制后自动同步到评测证据';
  }
  setText('status-board', device ? device.boardPlatform || '待探测板型' : '尚未选择板卡');
  setText('status-board-detail', device ? device.status || '设备状态未知' : '真机流程需要先连接设备');
  setText('status-board-action', device ? '打开设备管理 →' : '去连接设备 →');
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
          Array.isArray(local.engines) && local.engines.length
            ? `引擎 ${local.engines.join(' / ')}`
            : '',
        ]
          .filter(Boolean)
          .join(' · ')
      : robogo.message || '本地 / RoboGo 训练后端不可用',
  );
  // Engine selector honesty: a specific engine selection needs the worker to
  // actually route to that engine. Dim the option (and say why) when the
  // configured worker did not report it, instead of letting the submit fail
  // at the worker.
  const engineSelect = $('training-engine');
  if (engineSelect) {
    const reported = Array.isArray(local.engines) ? local.engines : null;
    const engineKnown = (id) => reported == null || reported.includes(id) || reported.includes('default');
    for (const option of engineSelect.querySelectorAll(
      'option[value="starter-ppo"], option[value="mjx-ppo"], option[value="microduck-rl"], ' +
        'option[value="microduck-recurrent"], ' +
        'option[value="microduck-football"], ' +
        'option[value="visual-ppo"], option[value="dm-control-ppo"], option[value="mjlab-rsl-rl"], ' +
        'option[value="act"], option[value="diffusion-policy"], option[value="smolvla"]',
    )) {
      const known = engineKnown(option.value);
      option.disabled = !known;
      option.textContent = known
        ? option.textContent.replace(' · worker 未注册', '')
        : option.textContent.includes(' · worker 未注册')
          ? option.textContent
          : `${option.textContent} · worker 未注册`;
    }
  }
  setText('robogo-board-label', localConfigured ? '运行中任务' : '可见算力资源');
  setText('robogo-machine-label', localConfigured ? '排队任务' : '开发机');
  setText('robogo-board-count', localConfigured ? local.activeJobs ?? '—' : robogo.availableBoardCount ?? '—');
  setText('robogo-machine-count', localConfigured ? local.queuedJobs ?? '—' : robogo.developmentMachineCount ?? '—');
}

// Engine capability map: what each selectable engine ACTUALLY is, said in the
// same honest terms the result physicsBackend will carry. The note renders
// under the engine selector so an operator sees the physics/observation
// trade-off before submitting, not after reading the run ledger.
const ENGINE_CAPABILITIES = Object.freeze({
  'starter-ppo': {
    name: 'starter-ppo',
    badges: ['运动学', 'CPU 友好', '部署链路同构'],
    desc: '解析运动学（单轮运动 + 执行器滞后/延迟域随机化），不模拟接触；训练快、门控与板载评测同构。',
  },
  'mjx-ppo': {
    name: 'MJX',
    badges: ['MuJoCo 接触动力学', '墙/障碍物理', '物理级域随机化'],
    desc: 'MuJoCo-MJX 真实接触动力学：墙面碰撞、mocap 球障碍、伺服力矩饱和与摩擦系数逐环境随机化。',
  },
  'visual-ppo': {
    name: 'visual-ppo',
    badges: ['像素观测', '顶置相机 48×48', 'CPU MuJoCo'],
    desc: '观测是 MuJoCo 渲染的真实顶置相机灰度图 + 4 维本体感觉；CNN 策略端到端从像素学导航（cpu-mujoco-vision）。',
  },
  'dm-control-ppo': {
    name: 'dm-control-ppo',
    badges: ['dm_env 生态', 'CPU MuJoCo', 'TimeStep 协议'],
    desc: 'DeepMind dm_control 环境协议（rl.control.Environment/Task 钩子）驱动共享 MuJoCo 场景；同一 8D 板载观测与质量门（dm-control-mujoco）。',
  },
  'microduck-rl': {
    name: 'microduck-rl',
    badges: ['mjlab 并行物理', 'CUDA', '万级环境'],
    desc: 'mjlab GPU 并行物理 + rsl-rl PPO，面向服务器级批量训练（需 CUDA worker 注册）。',
  },
  'microduck-recurrent': {
    name: 'microduck-recurrent',
    badges: ['循环 LSTM 256', '篮球/高跷平衡代理', 'h/c 状态导出'],
    desc: '循环网络训练器：存储状态 BPTT 的循环 PPO，导出 obs 61 + h/c -> 14 动作的循环 ONNX，直接通过 microduck-eval 的循环装载验收；评测侧已可给存活率结论，质量级训练走 GPU runner。',
  },
  'microduck-football': {
    name: 'microduck-football',
    badges: ['MuJoCo 足球', 'MicroDuck 61D→14D', '非对称 critic', 'CUDA 并行'],
    desc: '平台原生足球任务：单鸭射门、2v2、3v3 共享训练协议，MuJoCo 批量环境；支持非对称 actor-critic（critic 读取球真值，actor 接口不变，请求 training.asymmetric 开启）；高层任务状态机（搜索→绕球→对准→射门）见 engines/microduck-football/task_machine.py。',
  },
  'mjlab-rsl-rl': {
    name: 'mjlab-rsl-rl',
    badges: ['mjlab 物理', 'rsl-rl PPO', 'CUDA'],
    desc: 'mjlab 真物理 + rsl-rl 生产级 PPO；无 mjlab 时诚实回退 starter-kinematic 并如实标注（结果永不混淆）。',
  },
  act: {
    name: 'ACT',
    badges: ['模仿学习', 'k 步动作块', 'CPU 友好'],
    desc: '示教轨迹上的 ACT（Zhao et al. 2023）：Transformer 编解码 + CVAE 隐变量 + 时序集成，导出可验证的集成 ONNX；需要带 episode 边界的录制数据。',
  },
  'diffusion-policy': {
    name: 'Diffusion Policy',
    badges: ['模仿学习', '扩散动作分块', '多模态示教'],
    desc: '示教轨迹上的 Diffusion Policy（Chi et al. 2023，CNN 版式）：条件 1D UNet 去噪器 + DDPM 采样，整个反向去噪循环固化为一张 ONNX；两位示教者风格不同时不会被平均成谁都没做过的动作。',
  },
  smolvla: {
    name: 'SmolVLA',
    badges: ['VLA 参考', 'CPU 规划 / CUDA 全量', 'LeRobot 生态'],
    desc: 'SmolVLA（LeRobot 社区 VLA，450M）参考适配：CPU 栈上产出诚实标注的训练计划（dry-run），完整训练需注册 CUDA worker；本机缺训练栈时明确拒绝而不是假装训练。',
  },
});

function renderEngineCapability() {
  const note = $('engine-capability-note');
  const engineSelect = $('training-engine');
  if (!note || !engineSelect) return;
  const value = String(engineSelect.value || '');
  const capability = value ? ENGINE_CAPABILITIES[value] : null;
  if (!capability) {
    note.hidden = true;
    return;
  }
  note.hidden = false;
  setText('engine-capability-name', capability.name);
  const badges = $('engine-capability-badges');
  if (badges) {
    badges.innerHTML = '';
    for (const badge of capability.badges) {
      const tag = document.createElement('span');
      tag.className = 'engine-capability-badge';
      tag.textContent = badge;
      badges.appendChild(tag);
    }
  }
  setText('engine-capability-desc', capability.desc);
}

function renderModel() {
  const model = selectedModel();
  const product = selectedProductProfile();
  setText('train-onboarding-model-help', `载入 ${product.displayName} 默认模板并登记`);
  setText('train-onboarding-title', `${product.displayName} · 按 3 步完成一次强化学习训练`);
  setText('contract-panel-tip', `推荐：载入 ${product.displayName} 模板 → 校验 → 登记`);
  setText('template-button', `载入 ${product.displayName} 模板`);
  const summary = $('model-summary');
  const artifacts = $('artifact-list');
  const compatibility = $('compatibility-list');
  if (!model) {
    state.model = null;
    document.querySelector('#model-details-fold')?.setAttribute('open', '');
    updateTrainProgress(1);
    if (summary) summary.innerHTML = `<div class="model-empty-guide"><strong>还没有 ${escapeHtml(product.displayName)} 模型</strong><span>先展开上方“套件与契约”，载入模板并登记版本。</span><button class="button button-primary button-small" type="button" data-empty-model-action>载入 ${escapeHtml(product.displayName)} 模板 →</button></div>`;
    summary?.querySelector('[data-empty-model-action]')?.addEventListener('click', () => {
      document.querySelector('#contract-fold')?.setAttribute('open', '');
      document.querySelector('#template-button')?.click();
      document.querySelector('#manifest-editor')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    if (artifacts) artifacts.replaceChildren();
    if (compatibility) compatibility.replaceChildren();
    return;
  }
  state.model = model;
  // The built-in starter already satisfies step 1. Do not make users edit or
  // re-register JSON before they can reach replay and training.
  updateTrainProgress(2);
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
      const presentation = artifactPresentation(artifact);
      row.dataset.state = presentation.key;
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
        '<span class="artifact-row-main"><span class="artifact-name">' +
        escapeHtml(artifact.name || artifact.id) +
        '</span><span class="artifact-meta">' +
        escapeHtml(artifact.role || '') +
        ' · ' +
        escapeHtml(artifact.format || '') +
        ' · ' +
        escapeHtml(workloadLabel) +
        ' · ' +
        escapeHtml(runtimeLabel) +
        '</span></span><span class="artifact-state ' +
        stateClass(presentation.key === 'ready' ? 'ready' : presentation.key === 'blocked' ? 'failed' : 'partial') +
        '" title="' + escapeHtml(presentation.detail) + '">' +
        escapeHtml(presentation.label) +
        '</span>';
      artifacts.append(row);
    }
  }
  if (compatibility) {
    // 板卡兼容只保留两行语义：一行说"哪些板能上"，一行折叠说"其余为什么不能"。
    // 逐板平铺六行几乎相同的 reason 读起来像占位内容，而不是决策信息。
    compatibility.replaceChildren();
    const items = state.compatibility || [];
    const deployableBoards = items.filter((item) => item.deployable === true);
    const blockedBoards = items.filter((item) => item.deployable !== true);
    const summary = document.createElement('div');
    summary.className = 'compatibility-summary';
    if (deployableBoards.length) {
      const chips = deployableBoards
        .map(
          (item) =>
            '<span class="compatibility-chip is-ready">' +
            escapeHtml(item.platformId) +
            '</span>',
        )
        .join('');
      const blockedNote = blockedBoards.length
        ? `<span class="compatibility-note">其余 ${escapeHtml(String(blockedBoards.length))} 个板卡未登记兼容目标</span>`
        : '';
      summary.innerHTML = `<span class="compatibility-summary-label">可上板</span>${chips}${blockedNote}`; // escape-audit:allow chips/blockedNote are built only from escapeHtml-wrapped values and a fixed label
    } else {
      summary.innerHTML =
        '<span class="compatibility-summary-label">暂无可上板卡</span>' +
        '<span class="compatibility-note">当前模型未登记任何兼容的板端目标</span>';
    }
    compatibility.append(summary);

    const distinctReasons = [...new Set(blockedBoards.map((item) => item.reason || '').filter(Boolean))];
    if (distinctReasons.length) {
      const detail = document.createElement('details');
      detail.className = 'compatibility-detail';
      const reasonLines = distinctReasons
        .map((reason) => {
          const boards = blockedBoards
            .filter((item) => (item.reason || '') === reason)
            .map((item) => escapeHtml(item.platformId))
            .join(' / ');
          return '<li><span class="compatibility-platform">' + boards + '</span><span>' + escapeHtml(reason) + '</span></li>';
        })
        .join('');
      detail.innerHTML =
        `<summary>各板卡未兼容原因（${escapeHtml(String(distinctReasons.length))}）</summary><ul class="compatibility-reasons">` +
        reasonLines +
        '</ul>'; // escape-audit:allow reasonLines is built only from escapeHtml-wrapped values
      compatibility.append(detail);
    }
  }
}

function renderActionLibrary() {
  const root = $('sim-action-list');
  const empty = $('sim-action-empty');
  if (!root || !empty) return;
  const task = selectedTask();
  setText('task-context-note', taskContextNote(task));
  const heading = root.closest('.sim-action-library')?.querySelector('.sim-action-library-heading strong');
  if (heading) heading.textContent = `当前任务 · ${task.label}`;
  const taskStatus = $('sim-action-task-status');
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
  if (taskStatus) {
    const declared = policies.some((policy) => policy.id === state.taskId || policy.taskId === state.taskId);
    const needsPolicy = policies.length > 0 && state.taskId !== 'custom' && !declared;
    taskStatus.hidden = !needsPolicy;
    taskStatus.textContent = needsPolicy
      ? `当前模型策略包未声明“${task.label}”。可以先记录该任务，但开始训练前需要导入对应 manifest。`
      : `任务参数已切换为“${task.label}”：${task.hint}。`;
  }
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
      '</strong><kbd>' +
      escapeHtml(keys) +
      '</kbd>';
    root.append(item);
  }
}

function artifactPresentation(artifact) {
  const ref = String(artifact?.ref || '').trim();
  if (!ref) return { key: 'blocked', label: '缺少引用', detail: '需要受管 artifact:// 引用' };
  if (!/^artifact:\/\/[^\s]+$/i.test(ref)) {
    return { key: 'blocked', label: '引用无效', detail: '只接受受管 artifact:// 引用' };
  }
  if (artifact?.role === 'compiled-policy') {
    return artifact.sha256
      ? { key: 'ready', label: '可发布', detail: '已编译并带校验和' }
      : { key: 'partial', label: '待校验', detail: '已编译，尚未登记校验和' };
  }
  if (artifact?.role === 'policy' && artifact?.runtime === 'cpu-onnx') {
    return { key: 'partial', label: '可训练 · 待编译', detail: 'CPU ONNX 可运行；上板前需要目标制品' };
  }
  return { key: 'registered', label: '已登记', detail: '源制品已纳入模型版本' };
}

function renderBoard() {
  const device = selectedDevice();
  const summary = $('board-summary');
  if (!summary) return;
  if (!device) {
    summary.innerHTML =
      '<div class="empty-state board-empty"><strong>还没有目标板卡</strong><span>部署只会读取设备状态；先登记一块板卡，再生成只读预检计划。</span><button type="button" class="button button-ghost button-small" data-workspace-view="station">去设备管理登记 →</button></div>';
    return;
  }
  const platform = device.boardPlatform || '待探测';
  const reachable = device.sshReachability || device.status || 'unknown';
  const deployment =
    state.activeDeployment ||
    deploymentsForCurrentModel().find(
      (item) => item.modelId === selectedModel()?.id && item.deviceId === device.id,
    );
  // 预检状态的单一来源。以前 chip 只看 preflightReady 布尔值（status 是
  // ready/completed 吗），正文却直接打印 deployment.status，于是"预检失败"
  // 的设备会同时显示「待预检」和「当前预检状态：失败。」——同一张卡片上
  // 两句话互相矛盾。现在 chip、样式和正文都从这一份映射里取。
  const preflightState = (() => {
    if (!device.boardPlatform) return { key: 'undetected', label: '待探测', stateClass: 'is-waiting' };
    if (!deployment) return { key: 'unplanned', label: '待预检', stateClass: 'is-waiting' };
    const status = String(deployment.status || '').toLowerCase();
    if (['ready', 'completed'].includes(status)) return { key: 'passed', label: '预检通过', stateClass: 'is-ready' };
    if (status === 'failed') return { key: 'failed', label: '预检失败', stateClass: 'is-failed' };
    if (status === 'running') return { key: 'running', label: '预检中', stateClass: 'is-detected' };
    if (['planned', 'pending', 'queued'].includes(status)) return { key: 'planned', label: '待执行预检', stateClass: 'is-detected' };
    return { key: 'other', label: statusLabel(deployment.status), stateClass: 'is-detected' };
  })();
  const preflightReady = preflightState.key === 'passed';
  const boardStateClass = preflightState.stateClass;
  const deviceStatus = statusLabel(device.status || 'unknown');
  const preflightLabel = preflightState.label;
  const blockedReason = preflightReady
    ? '只读预检已通过；执行动作仍由受控 BoardAgent 和人工批准保护。'
    : preflightState.key === 'undetected'
      ? '先点击“探测板型”，确认目标设备与契约匹配。'
      : preflightState.key === 'unplanned'
        ? '先生成预检计划，再执行只读检查。'
        : preflightState.key === 'failed'
          ? `预检失败：${deployment?.lastError || deployment?.reason || '未通过兼容性检查'}。修正后重新执行只读预检。`
          : `当前预检状态：${preflightLabel}。`;
  summary.innerHTML =
    '<div class="board-summary-row"><strong>' +
    escapeHtml(device.name || device.id) +
    '</strong><span class="board-chip ' +
    boardStateClass +
    '">' +
    escapeHtml(platform + ' · ' + preflightLabel) +
    '</span></div><div class="board-details"><span>状态：' +
    escapeHtml(deviceStatus) +
    '</span><span>连接：' +
    escapeHtml(device.connectionMode || 'ssh') +
    '</span><span>可达性：' +
    escapeHtml(statusLabel(reachable)) +
    '</span></div><p class="board-block-reason" data-state="' +
    (preflightReady ? 'ready' : 'blocked') +
    '">' +
    escapeHtml(blockedReason) +
    '</p>';
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
        record.taskId,
        record.taskId && ACTION_TASKS[record.taskId]?.label,
        record.backend,
        record.mode,
        record.recordType === 'run' && record.metrics?.physicsBackend,
        record.recordType === 'run' && record.metrics?.engine,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query));
    })
    .slice(0, 30);
  setText(
    'records-count',
    records.length + ' 条记录 · 仅当前产品 ' + selectedProductProfile().displayName,
  );
  root.replaceChildren();
  if (!records.length) {
    const hasBrowserSimulator = Boolean(selectedProductProfile().simulatorPath);
    // 项目筛选会把未归属到本项目的账号级运行隐藏（projectIncludesRecord）。
    // 这种「被筛选造成的空」必须如实说明，否则用户会误以为账号里真的
    // 没有任何运行记录（D-002 同源的诚实性要求）。
    const project = selectedProject();
    const runsHiddenByProject = project
      ? (state.overview?.runs || []).filter((run) => currentModelIds().has(run.modelId)).length
      : 0;
    const emptyHint = runsHiddenByProject
      ? `当前项目「${projectDisplayName(project)}」下没有可归属的运行记录。该模型在账号内共有 ${runsHiddenByProject} 条运行，尚未关联到本项目；在项目设置里关联该模型后即可在此查看。`
      : hasBrowserSimulator
        ? '还没有运行记录。先校验契约或打开浏览器仿真。'
        : '还没有运行记录。先登记模型契约，再发起本地或 GPU 训练。';
    root.innerHTML = query
      ? '<div class="empty-state records-empty"><strong>没有匹配的记录</strong><span>试试模型名、状态或后端，或清空筛选查看全部。</span><button type="button" class="button button-ghost button-small" data-empty-action="clear-search">清空搜索</button></div>'
      : `<div class="empty-state records-empty"><strong>${escapeHtml(emptyHint)}</strong><span>每条记录都会关联当前任务、模型和时间，可从这里打开详情或进入下一步。</span><div class="records-empty-actions"><button type="button" class="button button-primary button-small" data-empty-action="simulate">打开仿真录制</button><button type="button" class="button button-ghost button-small" data-empty-action="train">去强化学习训练</button></div></div>`; // escape-audit:allow emptyHint has been escaped via escapeHtml above
    root.querySelectorAll('[data-empty-action]').forEach((button) => button.addEventListener('click', () => {
      const action = button.dataset.emptyAction;
      if (action === 'clear-search') { const input = $('record-search'); if (input) input.value = ''; state.recordsQuery = ''; renderHistory(); return; }
      setView(action === 'train' ? 'train' : 'simulate');
    }));
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
    // Rows compare runs at a glance, so the chip uses the compact label;
    // the full label stays in the detail dialog and metric cards.
    const physicsChip =
      record.recordType === 'run' && record.metrics?.physicsBackend
        ? PHYSICS_BACKEND_SHORT[record.metrics.physicsBackend] ||
          '物理 · ' + record.metrics.physicsBackend
        : '';
    const sceneChip =
      record.recordType === 'run' && ENGINE_SCENE_SHORT[record.taskId]
        ? ENGINE_SCENE_SHORT[record.taskId]
        : '';
    row.innerHTML =
      '<span class="history-time">' +
      escapeHtml(formatDate(record.createdAt)) +
      '</span><span class="history-kind">' +
      escapeHtml(
        demoTelemetry ? 'telemetry · demo fixture' : record.kind,
      ) +
      '</span><span class="history-summary">' +
      escapeHtml(record.summary || record.modelId || '') +
      (physicsChip
        ? '<span class="history-physics">' + escapeHtml(physicsChip) + '</span>'
        : '') +
      (sceneChip
        ? '<span class="history-physics">' + escapeHtml(sceneChip) + '</span>'
        : '') +
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

// Honest physics-backend labels: an engine self-reports which physics
// actually trained the policy; the label must never overstate it.
const PHYSICS_BACKEND_LABELS = {
  mjx: 'MuJoCo MJX（接触动力学）',
  'starter-kinematic': 'starter 运动学（无接触）',
  mujoco: 'MuJoCo CPU',
};

// Compact form for the history rows: rows compare runs at a glance, so
// the full label stays in the detail dialog and the metric cards.
const PHYSICS_BACKEND_SHORT = {
  mjx: '物理 · MJX',
  'starter-kinematic': '物理 · 运动学',
  mujoco: '物理 · MuJoCo',
};

// These tasks train in engine-side scenes the browser sandbox never renders;
// the row chip keeps that visible at a glance. Absent for tasks whose scene
// matches the sandbox (walk, kick, single-goal-kick, …).
const ENGINE_SCENE_SHORT = {
  'balance-basketball': '引擎场景 · 滚球',
  'balance-stilts': '引擎场景 · 高跷',
  'football-2v2': '引擎场景 · 4 鸭',
  'football-3v3': '引擎场景 · 6 鸭',
};

// A latency figure only means something with its measurement stage attached: a
// training-host forward pass and an on-board one differ by an order of
// magnitude, and only the latter describes a control-loop budget. Runs written
// before the stage was declared are labelled as undeclared rather than being
// shown as if they had been measured on the board.
const MEASUREMENT_STAGE_LABELS = {
  'host-torch': '训练主机 PyTorch 前向',
  'host-onnx': '训练主机 ONNX 前向',
  'board-onnx': '板端 ONNX 前向',
  'sim-step': '仿真步进耗时',
};

function controlLatencyLabel(metrics) {
  const stage = metrics && metrics.measurementStage;
  return '控制延迟（' + (MEASUREMENT_STAGE_LABELS[stage] || '测量阶段未声明') + '）';
}

// Human-readable metric cards for the run detail dialog. Every known metric
// field gets a labeled card; anything the schema gains later still shows up in
// the raw JSON block below instead of silently disappearing. A label may be a
// function of the whole metrics object when it depends on another field.
const RUN_METRIC_CARDS = [
  ['contractValid', '契约状态', (value) => (value === true ? '通过' : value === false ? '失败' : '—')],
  ['successRate', '成功率', (value) => formatRunPercent(value)],
  ['evaluationEpisodes', '自动评测局数', (value) => formatMetricNumber(value, 0)],
  ['meanReturn', '评测平均回报', (value) => formatMetricNumber(value, 3)],
  ['fallRate', '跌倒率', (value) => formatMetricPercent(value)],
  ['reward', '平均奖励', (value) => formatMetricNumber(value, 3)],
  ['episodeLength', '平均步数', (value) => formatMetricNumber(value, 1)],
  ['controlLatencyMs', controlLatencyLabel, (value) =>
    typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) + 'ms' : '—'],
  ['sourceCommit', '训练代码版本', (value) => (typeof value === 'string' ? value.slice(0, 10) : '—')],
  [
    'dependencyVersions',
    '依赖版本',
    (value) =>
      value && typeof value === 'object'
        ? Object.entries(value)
            .map(([name, version]) => name + ' ' + version)
            .join(' · ')
        : '—',
  ],
  ['iterations', '迭代数', (value) => formatMetricNumber(value, 0)],
  ['engine', '训练引擎', (value) => (typeof value === 'string' ? value : '—')],
  [
    'physicsBackend',
    '物理后端',
    (value) => (typeof value === 'string' ? PHYSICS_BACKEND_LABELS[value] || value : '—'),
  ],
  [
    'cuda',
    '训练设备',
    (value) => (value === true ? 'GPU (CUDA)' : value === false ? 'CPU' : '—'),
  ],
  ['observationSize', '观测维度', (value) => formatMetricNumber(value, 0)],
  ['actionSize', '动作维度', (value) => formatMetricNumber(value, 0)],
];

function formatMetricPercent(value) {
  return SimTelemetryCore.formatMetricPercent(value);
}

function formatRunPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const percent = value >= 0 && value <= 1 ? value * 100 : value;
  if (percent < 0 || percent > 100) return '—';
  return Number.isInteger(percent) ? `${percent}%` : `${percent.toFixed(1)}%`;
}

function formatMetricNumber(value, digits) {
  return SimTelemetryCore.formatMetricNumber(value, digits);
}

function renderRunMetricCards(record) {
  const metrics = record.metrics || {};
  const cards = RUN_METRIC_CARDS.filter(([key]) => metrics[key] != null).map(
    ([key, label, format]) =>
      '<div class="run-metric-card' +
      (key === 'fallRate' && Number(metrics.fallRate) > 0.2 ? ' is-warn' : '') +
      (key === 'contractValid' ? (metrics[key] === true ? ' is-ok' : ' is-error') : '') +
      '"><span>' +
      escapeHtml(typeof label === 'function' ? label(metrics) : label) +
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
  const isEvaluation = record.recordType === 'evaluation';
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
            : isEvaluation
              ? '评测证据'
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
            : isEvaluation
              ? record.source || 'platform'
              : record.mode || '—',
    ],
    ...(isRun && record.taskId
      ? [['动作任务', ACTION_TASKS[record.taskId]?.label || record.taskId]]
      : []),
    ...(record.projectId ? [['项目', projectLabelById(record.projectId)]] : []),
    ['模型', record.modelId || '—'],
    ['创建时间', formatDate(record.createdAt)],
    ...(isRun && record.training?.profile ? [['训练档位', record.training.profile]] : []),
    ...(isRun && record.training?.algorithm
      ? [['算法', record.training.algorithm.toUpperCase()]]
      : []),
    ...(isRun && record.training?.engine
      ? [['指定引擎', record.training.engine]]
      : []),
    ...(isRun && record.metrics?.engine ? [['训练引擎', record.metrics.engine]] : []),
    ...(isRun && record.metrics?.physicsBackend
      ? [['物理后端', PHYSICS_BACKEND_LABELS[record.metrics.physicsBackend] || record.metrics.physicsBackend]]
      : []),
    ...(isRun && record.training?.numEnvs ? [['并行环境', record.training.numEnvs]] : []),
    ...(isRun && record.training?.maxIterations
      ? [['最大迭代', record.training.maxIterations]]
      : []),
    ...(isArtifact && record.role ? [['制品角色', record.role]] : []),
    ...(isArtifact ? [['制品状态', record.label || artifactPresentation(record).label]] : []),
    ...(isArtifact && record.format ? [['格式', record.format]] : []),
    ...(isTelemetry && record.telemetrySummary?.sampleCount != null
      ? [['样本数', record.telemetrySummary.sampleCount]]
      : []),
    ...(isTelemetry && record.telemetrySummary?.durationSeconds != null
      ? [['时长', formatTelemetrySeconds(record.telemetrySummary.durationSeconds)]]
      : []),
    ...(isEvaluation && record.runId ? [['训练 Run', record.runId]] : []),
    ...(isEvaluation && record.attested === true ? [['服务器签证', 'attested']] : []),
    ...(isEvaluation && record.stale ? [['证据时效', '已被更新遥测取代']] : []),
    ...(!isRun && !isArtifact && record.deviceId ? [['目标设备', record.deviceId]] : []),
  ];
  setText(
    'run-detail-title',
    isRun
      ? '运行详情'
      : isArtifact
        ? '制品详情'
        : isTelemetry
          ? '遥测证据详情'
          : isEvaluation
            ? '评测证据详情'
            : '发布计划详情',
  );
  const detailStatus = $('run-detail-status');
  if (detailStatus) {
    const statusText = mockRun
      ? '协议演示'
      : syntheticRun || demoTelemetry
        ? '演示样例'
        : statusLabel(record.status);
    detailStatus.className =
      'state-badge ' +
      (mockRun || syntheticRun || demoTelemetry ? 'state-demo' : stateClass(record.status));
    detailStatus.textContent = statusText;
    detailStatus.title = mockRun || syntheticRun || demoTelemetry
      ? '该记录不能作为真实设备评测或发布依据。'
      : '当前记录状态';
  }
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
    (isRun && runProgressPoints(record).length
      ? '<div class="run-detail-live-chart"><strong class="run-detail-block-title">训练曲线（引擎回报）</strong>' +
        '<canvas id="run-detail-progress-canvas" width="720" height="200" aria-label="训练奖励与成功率曲线"></canvas>' +
        '<p class="small-note">绿线为每轮均值奖励（左轴），蓝线为近期成功率（右轴）。数据点由 worker 从引擎 stdout 解析，仅来自本次运行。</p></div>'
      : '') +
    (isRun && record.checkpoint
      ? '<div><strong class="run-detail-block-title">Checkpoint</strong><pre class="run-detail-code">' +
        escapeHtml(JSON.stringify(record.checkpoint, null, 2)) +
        '</pre></div>'
      : '') +
    (isRun && record.artifact
      ? '<div><strong class="run-detail-block-title">平台导出制品</strong>' +
        '<div class="run-artifact-summary"><span class="artifact-state is-ready">' +
        escapeHtml(String(record.artifact.format || 'model').toUpperCase()) +
        '</span><span>' +
        escapeHtml(record.artifact.artifactRef || 'artifact:// 未提供') +
        '</span>' +
        (record.artifact.sizeBytes != null
          ? '<span>' + escapeHtml(formatBytes(record.artifact.sizeBytes)) + '</span>'
          : '') +
        (record.artifact.sha256
          ? '<span>SHA-256 ' + escapeHtml(shortDigest(record.artifact.sha256)) + '</span>'
          : '') +
        '<a class="button button-ghost button-small" href="' +
        apiPath('/sim2real/runs/' + encodeURIComponent(record.id) + '/policy.onnx') +
        '" download="policy.onnx">下载 ONNX</a></div></div>'
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
    (isEvaluation
      ? '<div><strong class="run-detail-block-title">评测证据</strong><pre class="run-detail-code">' +
        escapeHtml(
          JSON.stringify(
            {
              id: record.id,
              runId: record.runId,
              artifactId: record.artifactId,
              status: record.status,
              attested: record.attested,
              stale: record.stale,
              summary: record.summary,
              report: record.report,
              taskEvaluation: record.taskEvaluation,
            },
            null,
            2,
          ),
        ) +
        '</pre></div>'
      : '') +
    (mockRun
      ? '<div class="run-progress-warning">Mock 仅验证协议与台账，不能部署到真实设备。</div>'
      : syntheticRun || demoTelemetry
        ? '<div class="run-progress-warning">合成样例仅验证导入与回放流程，不能作为真实 X5 评测或发布依据。</div>'
      : '') +
    (isRun && !mockRun && !syntheticRun
      ? '<div class="run-board-sessions" id="run-board-sessions" data-run-id="' +
        escapeHtml(record.id) +
        '"><div class="run-retrain-heading">' +
        '<strong class="run-detail-block-title">上板会话（板端运行证据）</strong>' +
        '<button class="button button-ghost button-small" type="button" id="run-board-sessions-load">' +
        '查看上板会话</button></div>' +
        '<p class="run-retrain-hint">会话事件（起止 / 推理统计 / 停止原因）来自板端遥测标记；' +
        '未 attested 的会话仅作审阅，不构成发布证据。</p>' +
        '<div class="run-retrain-body" id="run-board-sessions-body" role="status" aria-live="polite">' +
        '尚未读取。点击「查看上板会话」读取板端策略会话记录。</div></div>'
      : '') +
    (isRun && !mockRun && !syntheticRun && ['completed', 'ready'].includes(String(record.status))
      ? '<div class="run-retrain-card" id="run-retrain-card" data-run-id="' +
        escapeHtml(record.id) +
        '"><div class="run-retrain-heading">' +
        '<strong class="run-detail-block-title">重训建议（遥测飞轮 · 只读分析）</strong>' +
        '<button class="button button-ghost button-small" type="button" id="run-retrain-load">' +
        '查看重训建议</button></div>' +
        '<p class="run-retrain-hint">只读分析：平台不会自动发起训练，也不会改动任何运行状态；' +
        '阈值是建议性的重训参考，不是发布门。</p>' +
        '<div class="run-retrain-body" id="run-retrain-body" role="status" aria-live="polite">' +
        '尚未分析。点击「查看重训建议」读取板端遥测漂移信号。</div></div>'
      : '');
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  const detailCanvas = $('run-detail-progress-canvas');
  if (detailCanvas) drawRunProgressChart(detailCanvas, runProgressPoints(record));
  if ($('run-retrain-card')) wireRunRetrainingAdvice(record);
  if ($('run-board-sessions')) wireRunBoardSessions(record);
  wireRunRecordFeedback(record);
}

// The verdict table and the measure formatter are pure logic, so they live in
// telemetry-core.js (DOM-free, unit tested there). These wrappers keep the
// advice panel's call sites unchanged.
function retrainingVerdict(advice) {
  return SimTelemetryCore.retrainingVerdict(advice?.verdict);
}

// Build plain nodes: every server string reaches the DOM through textContent,
// never through an innerHTML template, so telemetry labels/evidence/summary
// cannot execute markup.
function retrainingElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

// A measured signal may legitimately be incomparable (no reference
// trajectory, no telemetry window). That is not zero and not "—": say it.
function formatRetrainingMeasure(value) {
  return SimTelemetryCore.formatRetrainingMeasure(value);
}

function renderRetrainingAdvice(body, advice, record) {
  const verdict = retrainingVerdict(advice);
  const boardSamples = Number(advice?.boardSamples);
  const signals = Array.isArray(advice?.signals) ? advice.signals : [];

  body.replaceChildren();

  const head = retrainingElement('div', 'run-retrain-status');
  head.append(retrainingElement('div', 'run-retrain-verdict ' + verdict.className, verdict.label));
  head.append(
    retrainingElement(
      'span',
      'run-retrain-meta',
      '板端样本 ' +
        (Number.isFinite(boardSamples) ? boardSamples : '未知') +
        ' 条' +
        (advice?.checkedAt ? ' · 分析于 ' + formatDate(advice.checkedAt) : ''),
    ),
  );
  body.append(head);

  if (!verdict.recognized) {
    // Defensive: an unknown verdict is reported as "insufficient-evidence"
    // rather than silently shown as healthy.
    body.append(
      retrainingElement('p', 'run-retrain-summary', '服务端返回了未知结论，已按“证据不足”呈现。'),
    );
  }

  body.append(
    retrainingElement('p', 'run-retrain-summary', String(advice?.summary ?? '服务端未提供摘要。')),
  );

  if (verdict.className === 'is-insufficient-evidence') {
    body.append(
      retrainingElement(
        'p',
        'run-retrain-advisory',
        '证据不足是诚实结论，不是错误：先在板上跑一次策略会话并回传遥测，再评估是否需要重训。',
      ),
    );
  }

  const list = retrainingElement('div', 'run-retrain-signals');
  if (!signals.length) {
    list.append(retrainingElement('div', 'run-retrain-signal', '服务端未返回任何漂移信号。'));
  }
  signals.forEach((signal) => {
    const breached = signal?.breached === true;
    const row = retrainingElement(
      'div',
      'run-retrain-signal' + (breached ? ' is-breached' : ''),
    );
    row.append(
      retrainingElement(
        'span',
        'run-retrain-signal-label',
        String(signal?.label ?? signal?.id ?? '未命名信号'),
      ),
    );
    const value = formatRetrainingMeasure(signal?.value);
    const threshold = formatRetrainingMeasure(signal?.threshold);
    row.append(
      retrainingElement(
        'strong',
        'run-retrain-signal-value',
        (value ?? '不可比/无数据') + ' / 阈值 ' + (threshold ?? '不可比/无数据'),
      ),
    );
    if (breached) {
      row.append(retrainingElement('span', 'run-retrain-signal-flag', '已越限（建议重训信号）'));
    }
    row.append(
      retrainingElement(
        'small',
        'run-retrain-signal-evidence',
        String(signal?.evidence ?? '无补充证据'),
      ),
    );
    list.append(row);
  });
  body.append(list);

  body.append(
    retrainingElement(
      'p',
      'run-retrain-advisory',
      '阈值是建议性的重训参考，不是发布门；发布判定仍由评测与发布证据独立决定。',
    ),
  );

  if (advice?.suggestedTraining && typeof advice.suggestedTraining === 'object') {
    const suggested = retrainingElement('div', 'run-retrain-suggested');
    suggested.append(
      retrainingElement('strong', 'run-detail-block-title', '建议的训练请求体（可调整档位）'),
    );
    suggested.append(
      retrainingElement(
        'p',
        'run-retrain-readonly-note',
        '需人工显式提交：平台不会自动发起训练。请求体按服务端建议预填；下方档位可改，提交前会再次确认。',
      ),
    );
    // Malleable advice (Bakusevych #29): the suggested profile is a starting
    // point, not a verdict. The operator can reshape it before the explicit
    // submit; the JSON preview below reflects the current pick.
    const profileRow = retrainingElement('div', 'run-retrain-profile-row');
    const profileLabel = retrainingElement('label', 'run-retrain-profile-label', '训练档位');
    profileLabel.setAttribute('for', 'run-retrain-profile');
    const profileSelect = document.createElement('select');
    profileSelect.id = 'run-retrain-profile';
    profileSelect.className = 'run-retrain-profile-select';
    profileSelect.setAttribute('aria-label', '选择重训档位');
    const suggestedProfile = String(advice.suggestedTraining.training?.profile || 'standard');
    const profileChoices = [
      ['smoke', '冒烟 · 64 环境 / 5 轮'],
      ['low-vram', '低显存 · 64 环境起步'],
      ['standard', '标准 · 1024 环境'],
      ['high-vram', '高显存 · 4096 环境'],
    ];
    for (const [value, text] of profileChoices) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      profileSelect.append(option);
    }
    profileSelect.value = profileChoices.some(([value]) => value === suggestedProfile)
      ? suggestedProfile
      : 'standard';
    const adjustNote = retrainingElement(
      'span',
      'run-retrain-profile-note',
      '已按建议预选；可改选更轻/更重的档位再提交。',
    );
    profileRow.append(profileLabel, profileSelect, adjustNote);
    suggested.append(profileRow);
    const preview = retrainingElement('pre', 'run-detail-code run-retrain-preview');
    const renderPreview = () => {
      let serialized = '';
      try {
        serialized =
          JSON.stringify(
            {
              ...advice.suggestedTraining,
              training: { ...advice.suggestedTraining.training, profile: profileSelect.value },
            },
            null,
            2,
          ) || '';
      } catch {
        serialized = '';
      }
      preview.textContent = serialized || '（无法序列化）';
    };
    profileSelect.addEventListener('change', renderPreview);
    renderPreview();
    suggested.append(preview);
    body.append(suggested);

    // The retrain action exists only for the affirmative verdict AND a usable
    // request body. Rendering it wires a click listener; it never fires on its
    // own, and every non-click path stays a GET.
    if (advice?.verdict === 'retrain-recommended') {
      const actions = retrainingElement('div', 'run-retrain-actions');
      const submit = retrainingElement(
        'button',
        'button button-primary button-small',
        '按当前档位发起重训',
      );
      submit.type = 'button';
      submit.id = 'run-retrain-submit';
      submit.addEventListener('click', () => {
        void submitRetrainingFromAdvice(record, advice);
      });
      actions.append(submit);
      const submitStatus = retrainingElement('span', 'run-retrain-submit-status', '');
      submitStatus.id = 'run-retrain-submit-status';
      submitStatus.setAttribute('role', 'status');
      submitStatus.setAttribute('aria-live', 'polite');
      actions.append(submitStatus);
      body.append(actions);
    }
  }

  body.append(
    retrainingElement('p', 'run-retrain-note', String(advice?.note ?? '服务端未附加说明。')),
  );

  const feedbackMount = retrainingElement('div', 'run-retrain-feedback');
  body.append(feedbackMount);
  wireFeedbackControl(feedbackMount, {
    surface: 'retraining-advice',
    runId: record?.id,
    contextLabel: '针对本次重训建议（阈值是建议性的，你的反馈会帮助校准它们）',
  });
}

function renderRetrainingAdviceError(body, error, record) {
  const payload = error instanceof ApiError ? error.payload : null;
  const notFound =
    (error instanceof ApiError && error.status === 404) ||
    (payload && typeof payload === 'object' && payload.error === 'SIM2REAL_RUN_NOT_FOUND');
  const box = retrainingElement('div', 'run-retrain-error' + (notFound ? ' is-not-found' : ''));
  box.append(retrainingElement('strong', null, notFound ? '运行记录不存在' : '暂时无法获取重训建议'));
  box.append(
    retrainingElement(
      'p',
      null,
      notFound
        ? String(
            (payload && typeof payload === 'object' && payload.message) ||
              '运行记录不存在，或不属于当前账号——可能已被清理，请刷新记录列表后重试。',
          )
        : (error instanceof Error ? error.message : '未知错误') +
            '。请稍后重试；本面板不会改动任何运行状态。',
    ),
  );
  const retry = retrainingElement('button', 'button button-ghost button-small', '重试');
  retry.type = 'button';
  retry.id = 'run-retrain-retry';
  retry.addEventListener('click', () => {
    void loadRunRetrainingAdvice(record);
  });
  box.append(retry);
  body.replaceChildren(box);
}

/**
 * Pull the read-only re-training analysis for one run. This is a plain
 * authenticated GET: opening the run detail or loading the advice never
 * submits anything. A training run may only be created by the explicit
 * operator action in submitRetrainingFromAdvice().
 */
async function loadRunRetrainingAdvice(record) {
  const card = $('run-retrain-card');
  if (!card || card.dataset.runId !== record.id) return;
  const body = card.querySelector('#run-retrain-body');
  const button = card.querySelector('#run-retrain-load');
  if (!body) return;
  if (button) button.disabled = true;
  body.replaceChildren(
    retrainingElement('p', 'run-retrain-summary', '分析中：正在拉取板端遥测漂移信号…'),
  );
  try {
    const payload = await request(
      '/sim2real/runs/' + encodeURIComponent(record.id) + '/retraining-advice',
    );
    if (card.dataset.runId !== record.id) return;
    const advice = payload?.advice;
    if (!advice || typeof advice !== 'object') {
      throw new ApiError('服务端返回缺少 advice 字段', 0, payload);
    }
    renderRetrainingAdvice(body, advice, record);
  } catch (error) {
    if (card.dataset.runId !== record.id) return;
    renderRetrainingAdviceError(body, error, record);
  } finally {
    if (button) button.disabled = false;
  }
}

// The request body shape is pure logic (telemetry-core.js); this wrapper only
// supplies the per-submission idempotency key, matching the run-creation flow.
function retrainingRequestBody(record, advice, modelId) {
  return SimTelemetryCore.retrainingRequest({
    record,
    advice,
    modelId,
    idempotencyKey:
      globalThis.crypto?.randomUUID?.() ||
      `retrain-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  });
}

/**
 * The operator-confirmed re-training action. This is the ONLY code path in the
 * advice panel that writes: it runs after an explicit click, shows an honest
 * confirmation, and aborts on cancel or on a missing model id. Nothing here is
 * reachable from rendering, loading, or opening the run detail.
 */
async function submitRetrainingFromAdvice(record, advice) {
  const suggested = advice?.suggestedTraining;
  if (!suggested || typeof suggested !== 'object') return;
  const button = $('run-retrain-submit');
  const status = $('run-retrain-submit-status');
  const setStatus = (message) => {
    if (status) status.textContent = message;
  };
  const modelId = record?.modelId || selectedModel()?.id;
  if (!modelId) {
    // Fail closed: never POST a body whose model is unknown.
    setStatus('无法发起重训：缺少模型 ID。已中止，未提交任何请求；请先在训练页选择模型。');
    return;
  }
  const taskId = suggested.taskId ?? record?.taskId;
  // The operator may have reshaped the suggestion (Bakusevych #29): the
  // profile select defaults to the server's suggestion but is editable, and
  // this submit honors whatever it currently says.
  const selectedProfile = String($('run-retrain-profile')?.value || '');
  const profile = selectedProfile || suggested.training?.profile || 'standard';
  const acknowledged = await confirmAction({
    title: '按建议发起重训',
    note:
      '即将提交一次新的本地训练（任务 ' +
      (taskId ?? '未指定') +
      '，档位 ' +
      profile +
      (selectedProfile && selectedProfile !== suggested.training?.profile
        ? '（你已调整，非原始建议）'
        : '') +
      '）。\n这是操作员的显式动作：会真实发起一次本地强化学习训练；分析本身不会自动发起任何训练。',
    approveLabel: '显式提交重训',
  });
  if (!acknowledged) {
    setStatus('已取消：未提交任何请求。');
    return;
  }
  const idleLabel = button ? button.textContent : '按当前档位发起重训';
  if (button) {
    button.disabled = true;
    button.textContent = '提交中…';
  }
  setStatus('正在提交重训请求…');
  try {
    const requestBody = retrainingRequestBody(record, advice, modelId);
    if (selectedProfile) requestBody.training = { ...requestBody.training, profile: selectedProfile };
    if (state.projectId) requestBody.projectId = state.projectId;
    const payload = await request('/sim2real/runs', {
      method: 'POST',
      body: JSON.stringify(requestBody),
    });
    const run = payload?.run || {};
    setStatus(
      '已提交：训练任务 ' +
        String(run.id ?? '（服务端未返回 id）') +
        ' 已创建，可在「记录与版本」中跟踪。',
    );
    showToast('重训请求已记录（操作员显式提交）', 'success');
    await loadOverview({ quiet: true });
  } catch (error) {
    setStatus(
      '提交失败：' +
        (error instanceof Error ? error.message : '未知错误') +
        '。可点击按钮重试；本面板不会自动重发。',
    );
    if (!(error instanceof ApiError && error.status === 401)) {
      showToast(error instanceof Error ? error.message : '重训提交失败', 'error');
    }
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = idleLabel || '按当前档位发起重训';
    }
  }
}

function wireRunRetrainingAdvice(record) {
  const card = $('run-retrain-card');
  if (!card) return;
  card.querySelector('#run-retrain-load')?.addEventListener('click', () => {
    void loadRunRetrainingAdvice(record);
  });
}

// ---- board sessions (structured board-run evidence) ------------------------
// The session list is a read-only GET like the retraining advice: opening the
// dialog never fires a POST, and every server string reaches the DOM through
// textContent (retrainingElement), never an innerHTML template.
function formatBoardSessionTimestamp(stamp) {
  if (!stamp) return '未知';
  const parsed = new Date(stamp);
  return Number.isNaN(parsed.getTime()) ? String(stamp) : formatDate(parsed.toISOString());
}

function boardSessionStopLabel(session) {
  if (!session.stoppedAt) return '中断（未见停止事件，如进程被杀）';
  const reason = String(session.stopReason || 'unknown');
  if (reason.startsWith('fault:')) return '故障：' + reason.slice('fault:'.length);
  if (reason === 'operator-stop') return '操作员停止';
  if (reason === 'sigterm') return '进程终止（sigterm）';
  if (reason === 'telemetry-stale') return '遥测陈旧保护停止';
  return reason;
}

function renderBoardSessions(body, sessions) {
  body.replaceChildren();
  const list = Array.isArray(sessions) ? sessions : [];
  if (!list.length) {
    body.append(
      retrainingElement(
        'p',
        'run-retrain-summary',
        '该 run 暂无上板会话记录：没有回传任何板端策略会话事件。先在 station 页完成一次策略 start→stop 并回传遥测。',
      ),
    );
    return;
  }
  const count = retrainingElement('p', 'run-retrain-meta', '共 ' + list.length + ' 个会话');
  body.append(count);
  list.forEach((session, index) => {
    const attested = session?.attested === true;
    const card = retrainingElement('div', 'run-board-session' + (attested ? '' : ' is-review-only'));
    const head = retrainingElement('div', 'run-board-session-head');
    head.append(retrainingElement('strong', null, '会话 #' + (index + 1)));
    head.append(
      retrainingElement(
        'span',
        'run-board-session-attest' + (attested ? ' is-attested' : ''),
        attested ? 'attested' : 'review-only',
      ),
    );
    if (session?.mock === true) {
      head.append(retrainingElement('span', 'run-board-session-attest is-mock', 'mock'));
    }
    card.append(head);
    const fields = [
      ['会话 ID', String(session?.sessionId ?? '未知')],
      ['开始', formatBoardSessionTimestamp(session?.startedAt)],
      ['结束', boardSessionStopLabel(session)],
      ['推理次数', session?.inferenceCount != null ? String(session.inferenceCount) : '未知'],
      [
        '平均推理延迟',
        session?.inferMs != null && Number.isFinite(Number(session.inferMs))
          ? Number(session.inferMs).toFixed(2) + ' ms'
          : '未知',
      ],
      [
        '发布命令数',
        session?.published != null ? String(session.published) : '未知',
      ],
      [
        '持续时长',
        session?.durationSec != null && Number.isFinite(Number(session.durationSec))
          ? session.durationSec.toFixed(1) + ' s'
          : '未知',
      ],
      [
        '控制频率',
        session?.controlHz != null ? String(session.controlHz) + ' Hz' : '未知',
      ],
      [
        '设备',
        String(session?.deviceId ?? '未知'),
      ],
    ];
    const grid = retrainingElement('div', 'run-detail-grid');
    fields.forEach(([label, value]) => {
      const field = retrainingElement('div', 'run-detail-field');
      field.append(retrainingElement('span', null, label));
      field.append(retrainingElement('strong', null, value));
      grid.append(field);
    });
    card.append(grid);
    const model = session?.model;
    if (model && typeof model === 'object') {
      const sha = String(model.sha256 ?? '');
      const modelLine = [
        model.provider ? String(model.provider) : null,
        model.inputDim != null && model.outputDim != null
          ? model.inputDim + '→' + model.outputDim
          : null,
        model.bytes != null ? Math.max(1, Math.round(Number(model.bytes) / 1024)) + 'KB' : null,
        sha ? sha.slice(0, 12) : null,
      ]
        .filter(Boolean)
        .join(' · ');
      card.append(
        retrainingElement(
          'p',
          'run-board-session-model',
          '模型指纹：' + (modelLine || '事件未携带模型信息'),
        ),
      );
    }
    body.append(card);
  });
  body.append(
    retrainingElement(
      'p',
      'run-retrain-advisory',
      '上板会话是只读证据回放：读取不触发任何板端动作；未 attested 的会话不满足发布闸门。',
    ),
  );
}

function renderBoardSessionsError(body, error) {
  const payload = error instanceof ApiError ? error.payload : null;
  const notFound =
    (error instanceof ApiError && error.status === 404) ||
    (payload && typeof payload === 'object' && payload.error === 'SIM2REAL_RUN_NOT_FOUND');
  const box = retrainingElement('div', 'run-retrain-error' + (notFound ? ' is-not-found' : ''));
  box.append(retrainingElement('strong', null, notFound ? '运行记录不存在' : '暂时无法读取上板会话'));
  box.append(
    retrainingElement(
      'p',
      null,
      notFound
        ? String(
            (payload && typeof payload === 'object' && payload.message) ||
              '运行记录不存在，或不属于当前账号——可能已被清理，请刷新记录列表后重试。',
          )
        : (error instanceof Error ? error.message : '未知错误') +
            '。请稍后重试；本面板不会改动任何运行状态。',
    ),
  );
  const retry = retrainingElement('button', 'button button-ghost button-small', '重试');
  retry.type = 'button';
  retry.id = 'run-board-sessions-retry';
  box.append(retry);
  body.replaceChildren(box);
}

async function loadRunBoardSessions(record) {
  const card = $('run-board-sessions');
  if (!card || card.dataset.runId !== record.id) return;
  const body = card.querySelector('#run-board-sessions-body');
  const button = card.querySelector('#run-board-sessions-load');
  if (!body) return;
  if (button) button.disabled = true;
  body.replaceChildren(
    retrainingElement('p', 'run-retrain-summary', '读取中：正在拉取板端策略会话事件…'),
  );
  try {
    const payload = await request(
      '/sim2real/runs/' + encodeURIComponent(record.id) + '/board-sessions',
    );
    if (card.dataset.runId !== record.id) return;
    const sessions = payload?.sessions;
    if (!Array.isArray(sessions)) {
      throw new ApiError('服务端返回缺少 sessions 数组', 0, payload);
    }
    renderBoardSessions(body, sessions);
  } catch (error) {
    if (card.dataset.runId !== record.id) return;
    renderBoardSessionsError(body, error);
    const retry = body.querySelector('#run-board-sessions-retry');
    if (retry) {
      retry.addEventListener('click', () => {
        void loadRunBoardSessions(record);
      });
    }
  } finally {
    if (button) button.disabled = false;
  }
}

function wireRunBoardSessions(record) {
  const card = $('run-board-sessions');
  if (!card) return;
  card.querySelector('#run-board-sessions-load')?.addEventListener('click', () => {
    void loadRunBoardSessions(record);
  });
}

// ---- granular feedback (Amershi G15) ----------------------------------------
// One shared control for every feedback surface: two closed verdicts plus an
// optional bounded note. It posts exactly once per explicit click and reports
// inline; feedback is operational telemetry and never unlocks or gates
// anything, so failures degrade to an inline retry hint, never a modal.
function feedbackElement(tag, className, text) {
  return retrainingElement(tag, className, text);
}

const FEEDBACK_NOTE_LIMIT = 600;

async function submitWorkspaceFeedback(surface, verdict, note, runId) {
  return request('/sim2real/feedback', {
    method: 'POST',
    body: JSON.stringify({
      surface,
      verdict,
      ...(note ? { note } : {}),
      ...(runId ? { runId } : {}),
    }),
  });
}

/**
 * Append a feedback control into `mount`. `surface` and `runId` follow the
 * server's closed contract; verdicts are fixed ('accurate' | 'inaccurate').
 * All nodes are built via createElement/textContent — no innerHTML — so
 * nothing the user types can execute markup.
 */
function wireFeedbackControl(mount, { surface, runId, contextLabel }) {
  if (!mount || mount.dataset.feedbackWired === '1') return;
  mount.dataset.feedbackWired = '1';

  const box = feedbackElement('div', 'feedback-control');
  box.append(feedbackElement('strong', 'feedback-control-title', '这条信息准确吗？'));
  if (contextLabel) {
    box.append(feedbackElement('small', 'feedback-control-context', String(contextLabel)));
  }

  const actions = feedbackElement('div', 'feedback-control-actions');
  const note = document.createElement('textarea');
  note.className = 'feedback-control-note';
  note.rows = 2;
  note.maxLength = FEEDBACK_NOTE_LIMIT;
  note.setAttribute('aria-label', '补充说明（可选）');
  note.placeholder = '可选：说明哪里不准确，最多 ' + FEEDBACK_NOTE_LIMIT + ' 字';
  const status = feedbackElement('span', 'feedback-control-status', '');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  const buttons = [
    { verdict: 'accurate', label: '准确', className: 'feedback-vote-accurate' },
    { verdict: 'inaccurate', label: '不准确', className: 'feedback-vote-inaccurate' },
  ].map(({ verdict, label, className }) => {
    const button = feedbackElement('button', 'button button-ghost button-small ' + className, label);
    button.type = 'button';
    button.addEventListener('click', () => {
      const trimmed = (note.value || '').trim();
      if (trimmed.length > FEEDBACK_NOTE_LIMIT) {
        status.textContent = '备注超过 ' + FEEDBACK_NOTE_LIMIT + ' 字上限，请精简后重试。';
        return;
      }
      for (const other of actions.querySelectorAll('button')) other.disabled = true;
      button.textContent = '提交中…';
      status.textContent = '';
      void (async () => {
        try {
          await submitWorkspaceFeedback(surface, verdict, trimmed, runId);
          status.textContent = verdict === 'accurate' ? '已记录：感谢确认。' : '已记录：感谢指出，会用于改进建议质量。';
          note.value = '';
          box.classList.add('is-submitted');
          showToast('反馈已记录', 'success');
        } catch (error) {
          status.textContent =
            '反馈暂未保存：' +
            (error instanceof Error ? error.message : '未知错误') +
            '。可再点一次重试。';
          showToast('反馈提交失败', 'error');
        } finally {
          for (const other of actions.querySelectorAll('button')) other.disabled = false;
          button.textContent = label;
        }
      })();
    });
    return button;
  });

  actions.append(...buttons, note, status);
  box.append(actions);
  mount.append(box);
}

/** Run-detail dialog: feedback anchored to this run record. */
function wireRunRecordFeedback(record) {
  const dialog = $('run-detail-dialog');
  if (!dialog) return;
  const body = $('run-detail-body');
  if (!body) return;
  let mount = document.getElementById('run-record-feedback');
  if (!mount) {
    mount = feedbackElement('div', 'run-record-feedback');
    mount.id = 'run-record-feedback';
    body.append(mount);
  } else {
    // Reopening a different record resets the wiring so the runId stays true.
    mount.replaceChildren();
    delete mount.dataset.feedbackWired;
  }
  wireFeedbackControl(mount, {
    surface: 'run-record',
    runId: record?.id,
    contextLabel: '针对当前打开的运行记录',
  });
}

// ---- feedback reliance summary (Bakusevych #38 / Amershi G17) ---------------
// Closes the feedback loop visibly: after a verdict is recorded the user can
// see what feedback added up to (counts + accuracy share per surface). The
// panel is passive and owner-scoped; failures degrade to a retry button,
// never to fabricated numbers.
const FEEDBACK_SUMMARY_SURFACE_LABELS = {
  'retraining-advice': '重训建议',
  'agent-reply': 'Agent 回复',
  'run-record': '运行记录',
};

function renderFeedbackSummary(mount, summary) {
  mount.replaceChildren();
  const total = Number(summary?.total) || 0;
  if (!total) {
    mount.append(
      feedbackElement(
        'p',
        'feedback-summary-empty',
        '还没有已记录的反馈。你在评测结果、运行记录和 Agent 回复下的「准确 / 不准确」会汇总到这里。',
      ),
    );
    return;
  }
  const accurate = Number(summary?.accurate) || 0;
  const share = Math.round((accurate / total) * 100);
  const head = feedbackElement('div', 'feedback-summary-head');
  head.append(
    feedbackElement(
      'strong',
      'feedback-summary-title',
      `近 ${String(summary?.windowDays || 30)} 天反馈汇总`,
    ),
    feedbackElement(
      'span',
      'feedback-summary-share' + (share >= 70 ? ' is-positive' : share <= 40 ? 'is-negative' : ''),
      `${total} 条 · 准确 ${share}%`,
    ),
  );
  mount.append(head);
  const list = feedbackElement('div', 'feedback-summary-rows');
  for (const row of Array.isArray(summary?.bySurface) ? summary.bySurface : []) {
    const item = feedbackElement('div', 'feedback-summary-row');
    const label =
      FEEDBACK_SUMMARY_SURFACE_LABELS[row?.surface] || String(row?.surface || '其他');
    item.append(feedbackElement('span', 'feedback-summary-row-label', label));
    const accurateCount = Number(row?.accurate) || 0;
    const totalCount = Number(row?.total) || 0;
    const bar = feedbackElement('div', 'feedback-summary-bar');
    const fill = document.createElement('i');
    fill.style.width = totalCount ? `${Math.round((accurateCount / totalCount) * 100)}%` : '0%';
    bar.append(fill);
    item.append(bar);
    item.append(
      feedbackElement(
        'span',
        'feedback-summary-row-value',
        `${accurateCount}/${totalCount} 准确`,
      ),
    );
    list.append(item);
  }
  mount.append(list);
  mount.append(
    feedbackElement(
      'p',
      'feedback-summary-note',
      '反馈仅用于改进建议质量（运营遥测），不参与发布或晋级闸门。',
    ),
  );
}

async function loadFeedbackSummary() {
  const mount = $('feedback-summary');
  if (!mount || mount.dataset.loading === '1') return;
  mount.dataset.loading = '1';
  try {
    const payload = await request('/sim2real/feedback/summary');
    renderFeedbackSummary(mount, payload?.summary);
  } catch (error) {
    mount.replaceChildren();
    const retry = feedbackElement('button', 'button button-ghost button-small', '重新加载');
    retry.type = 'button';
    retry.addEventListener('click', () => {
      delete mount.dataset.loading;
      void loadFeedbackSummary();
    });
    mount.append(
      feedbackElement(
        'p',
        'feedback-summary-error',
        '反馈汇总暂不可用：' + (error instanceof Error ? error.message : '未知错误') + '。',
      ),
      retry,
    );
  } finally {
    delete mount.dataset.loading;
  }
}

// Lazy load on first expand: the summary is only worth a request when the
// operator actually opens the panel; every later expand re-fetches so the
// counts stay current after new verdicts.
$('feedback-summary-panel')?.addEventListener('toggle', () => {
  if ($('feedback-summary-panel')?.open) void loadFeedbackSummary();
});

function metricPercent(value) {
  return SimTelemetryCore.metricPercent(value);
}

function finiteNumber(value) {
  return SimTelemetryCore.finiteNumber(value);
}

function booleanValue(value) {
  return SimTelemetryCore.booleanValue(value);
}

function normalizeTelemetrySample(value) {
  return SimTelemetryCore.normalizeTelemetrySample(value);
}

function parseTelemetryText(text) {
  return SimTelemetryCore.parseTelemetryText(text);
}

function importSizeError(label, maxBytes, guidance = '请先分段导入') {
  return new Error(`${label}超过 ${maxBytes} 字节上限，${guidance}`);
}

// File.size is a byte count, but keeping the bounded slice and a decoded-text
// check makes this safe for test doubles and unusual Blob implementations too.
// The slice prevents file.text() from materializing an unbounded payload before
// the parser has a chance to reject it.
async function readImportTextWithinLimit(
  file,
  maxBytes,
  label,
  guidance = '请先分段导入',
) {
  let declaredSize;
  try {
    declaredSize = Number(file?.size);
  } catch {
    declaredSize = NaN;
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error(`${label}导入上限配置无效`);
  }
  if (!Number.isSafeInteger(declaredSize) || declaredSize < 0) {
    throw new Error(`${label}大小无法确认，导入已停止`);
  }
  if (declaredSize > maxBytes) throw importSizeError(label, maxBytes, guidance);
  if (typeof file?.slice !== 'function') {
    throw new Error(`${label}无法安全读取，请使用支持文件分段读取的浏览器`);
  }
  const boundedFile = file.slice(0, maxBytes + 1);
  if (typeof boundedFile?.text !== 'function') {
    throw new Error(`${label}读取失败，请重试`);
  }
  const text = await boundedFile.text();
  if (SimTelemetryCore.exceedsUtf8ByteLimit(text, maxBytes)) {
    throw importSizeError(label, maxBytes, guidance);
  }
  return text;
}

function handleMicroduckRecordingReady(event) {
  const data = event?.data;
  if (!data || data.type !== 'rdk-microduck-recording-ready') return;
  if (data.format !== 'microduck-trajectory-v1') return;
  // Accept the same-origin mounted simulator (and `null` for local file://
  // previews), while ignoring unsolicited messages from other frames.
  if (event.origin && event.origin !== window.location.origin && event.origin !== 'null') return;
  if (state.productId !== 'microduck') {
    showToast('录制来自 MicroDuck，请先切换到 MicroDuck 产品线', 'error');
    return;
  }
  const frame = $('simulator-frame');
  if (frame?.contentWindow && event.source && event.source !== frame.contentWindow) return;
  // The iframe sends metadata only. Pulling the text through the recorder API
  // keeps large trajectories out of postMessage while still supporting a
  // standalone/cross-origin fallback when the child includes text itself.
  let text = typeof data.text === 'string' ? data.text : '';
  if (!text && event.source && typeof event.source.__microduckRecorder?.getText === 'function') {
    try { text = event.source.__microduckRecorder.getText(); } catch { /* ignore */ }
  }
  if (!text && frame?.contentWindow && typeof frame.contentWindow.__microduckRecorder?.getText === 'function') {
    try { text = frame.contentWindow.__microduckRecorder.getText(); } catch { /* ignore */ }
  }
  if (!text) {
    showToast('录制已停止，但无法读取轨迹；请在仿真面板点击“导出 JSONL”后导入', 'error');
    return;
  }
  try {
    const evidence = parseTelemetryText(text);
    evidence.fileName = 'microduck-browser-recording.jsonl';
    evidence.source = 'browser-microduck';
    evidence.contractId = data.contractId || evidence.contractId || CONTRACT_ID;
    evidence.recording = {
      sampleCount: Number(data.sampleCount) || evidence.summary.sampleCount,
      durationSeconds: Number(data.durationSeconds) || evidence.summary.durationSeconds,
    };
    state.telemetry = stampTelemetryContext(evidence);
    renderAll();
    const status = $('simulator-evidence-status');
    status?.classList.add('is-ready');
    if (status) status.textContent = `已同步 ${evidence.summary.sampleCount} 帧到评测证据`;
    showToast(`MicroDuck 动作录制已同步：${evidence.summary.sampleCount} 帧，可到“评测与效果”上传到当前 Run`, 'success');
  } catch (error) {
    showToast(error instanceof Error ? `录制解析失败：${error.message}` : '录制解析失败，请导出 JSONL 后重试', 'error');
  }
}

function currentModelIds() {
  const selected = selectedModel();
  const linkedModelIds = projectModelIds();
  if (selected?.id && (!linkedModelIds || linkedModelIds.has(String(selected.id)))) {
    return new Set([selected.id]);
  }
  return new Set(
    (state.overview?.models || [])
      .filter((model) =>
        model.manifest?.robot?.id === state.productId &&
        (!linkedModelIds || linkedModelIds.has(String(model.id))),
      )
      .map((model) => model.id),
  );
}

function runsForCurrentModel() {
  const ids = currentModelIds();
  return (state.overview?.runs || []).filter(
    (run) => ids.has(run.modelId) && projectIncludesRecord(run),
  );
}

function deploymentsForCurrentModel() {
  const ids = currentModelIds();
  return (state.overview?.deployments || []).filter(
    (deployment) => ids.has(deployment.modelId) && projectIncludesRecord(deployment),
  );
}

function currentTelemetry() {
  const evidence = state.telemetry;
  if (!evidence) return null;
  if (evidence.modelId && !currentModelIds().has(evidence.modelId)) return null;
  return projectIncludesRecord(evidence) ? evidence : null;
}

function latestRun() {
  return [...runsForCurrentModel()].sort((a, b) =>
    String(b.createdAt || '').localeCompare(String(a.createdAt || '')),
  )[0] || null;
}

function isSyntheticEvidence(evidence, run) {
  return SimTelemetryCore.isSyntheticEvidence(evidence, run);
}

function hasPersistedEvaluation(run) {
  return SimTelemetryCore.hasPersistedEvaluation(run);
}

function hasRealEvaluation(evidence, run) {
  return SimTelemetryCore.hasRealEvaluation(evidence, run);
}

// A release may advance only on metrics returned by a real worker or on an
// explicitly attested replay. `source: "board-agent"` is an uploader's claim,
// so it remains useful for review/replay but cannot prove that an X5 produced
// the samples. The predicate itself lives in telemetry-core.js so its truth
// table is unit-tested without a DOM.
function hasReleaseGradeEvidence(evidence, run) {
  return SimTelemetryCore.hasReleaseGradeEvidence(evidence, run);
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

// The diverging heatmap scale lives in telemetry-core.js.
function telemetryDivergingColor(value) {
  return SimTelemetryCore.telemetryDivergingColor(value);
}

function drawTelemetryRewardTimeline(samples, playheadIndex) {
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
  // Playhead from the unified scrub timeline: same x-scale as the curve.
  if (Number.isInteger(playheadIndex) && playheadIndex >= 0 && playheadIndex < samples.length) {
    const x = xOf(samples[playheadIndex].t);
    ctx.strokeStyle = 'rgba(96, 165, 250, 0.95)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, plotTop);
    ctx.lineTo(x, plotBottom);
    ctx.stroke();
    const reward = Number(samples[playheadIndex].reward);
    if (Number.isFinite(reward)) {
      ctx.fillStyle = 'rgba(96, 165, 250, 1)';
      ctx.beginPath();
      ctx.arc(x, yOf(reward), 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawTelemetryHeatmap(samples, key, canvasId, captionId, playheadIndex) {
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
  // Playhead from the unified scrub timeline: highlight the column that the
  // current sample maps to, in the same downsampling grid the cells use.
  if (Number.isInteger(playheadIndex) && playheadIndex >= 0 && playheadIndex < samples.length) {
    const column = Math.min(columns - 1, Math.floor((playheadIndex * columns) / samples.length));
    const x = plotLeft + column * cellWidth;
    ctx.strokeStyle = 'rgba(96, 165, 250, 0.95)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x + 0.5, plotTop + 0.5, Math.max(1.5, cellWidth), plotHeight);
  }
  const dimsLabel = (fullDims > HEATMAP_MAX_ROWS ? '前 ' + HEATMAP_MAX_ROWS + ' 维' : fullDims + ' 维') + ' × ' + samples.length + ' 帧';
  setText(captionId, dimsLabel);
  return { absMax, truncated: fullDims > HEATMAP_MAX_ROWS };
}

// --- Episode health check ---------------------------------------------------
// episode 长度分布 + 离群标记（对标 LeRobot visualize_dataset 的数据体检模式）。
// episode 以 done/fall 事件切分；没有边界标记的样本算作单个未闭合 episode，
// 如实标注而不是猜边界。离群 = |长度 - 中位数| > 3 × MAD（中位绝对偏差）。

const TELEMETRY_EPISODES_CANVAS_W = 720;
const TELEMETRY_EPISODES_CANVAS_H = 180;

function telemetryEpisodeLengths(samples) {
  if (!Array.isArray(samples) || !samples.length) return { episodes: [], closed: false };
  const episodes = [];
  let current = 0;
  let closed = false;
  for (const sample of samples) {
    current += 1;
    if (sample && (sample.done || sample.fall)) {
      episodes.push(current);
      current = 0;
      closed = true;
    }
  }
  if (current > 0) episodes.push(current);
  return { episodes, closed };
}

function episodeOutlierThresholds(lengths) {
  if (lengths.length < 3) return null;
  const sorted = [...lengths].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const deviations = sorted.map((value) => Math.abs(value - median)).sort((a, b) => a - b);
  const mad = deviations[Math.floor(deviations.length / 2)];
  // A degenerate MAD (identical episodes) means no outlier is detectable.
  if (!mad) return null;
  return { median, mad, low: median - 3 * mad, high: median + 3 * mad };
}

function drawTelemetryEpisodes(samples) {
  const block = $('telemetry-episodes-block');
  const canvas = $('telemetry-episodes-canvas');
  const ctx = block && canvas ? clearCanvas(canvas, TELEMETRY_EPISODES_CANVAS_W, TELEMETRY_EPISODES_CANVAS_H) : null;
  if (!ctx) return;
  const { episodes, closed } = telemetryEpisodeLengths(samples);
  const width = TELEMETRY_EPISODES_CANVAS_W;
  const height = TELEMETRY_EPISODES_CANVAS_H;
  if (episodes.length < 2) {
    block.hidden = true;
    return;
  }
  block.hidden = false;
  const plotLeft = 38;
  const plotRight = width - 10;
  const plotTop = 12;
  const plotBottom = height - 22;
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - plotTop;
  const lengthMax = Math.max(...episodes);
  const thresholds = episodeOutlierThresholds(episodes);
  // Histogram: episode lengths bucketed on the x axis, count on the y axis.
  const bins = Math.min(24, Math.max(6, Math.ceil(Math.sqrt(episodes.length))));
  const counts = new Array(bins).fill(0);
  let outliers = 0;
  for (const length of episodes) {
    const bin = Math.min(bins - 1, Math.floor((length / (lengthMax || 1)) * bins));
    counts[bin] += 1;
    if (thresholds && (length < thresholds.low || length > thresholds.high)) outliers += 1;
  }
  const countMax = Math.max(...counts, 1);
  const binWidth = plotWidth / bins;
  ctx.font = CANVAS_TEXT_STYLE;
  ctx.fillStyle = CANVAS_TEXT_COLOR;
  for (const [value, y] of [
    [countMax, plotTop],
    [Math.round(countMax / 2), plotTop + plotHeight / 2],
  ]) {
    ctx.fillText(String(value), 4, y + 3);
  }
  ctx.strokeStyle = 'rgba(28, 28, 26, 0.12)';
  ctx.lineWidth = 1;
  for (let bin = 0; bin < bins; bin += 1) {
    if (!counts[bin]) continue;
    const barHeight = (counts[bin] / countMax) * plotHeight;
    const x = plotLeft + bin * binWidth;
    ctx.fillStyle = 'rgba(85, 221, 176, 0.55)';
    ctx.fillRect(x + 1, plotBottom - barHeight, Math.max(1, binWidth - 2), barHeight);
  }
  // Outlier markers: each outlying episode plotted at its own length.
  if (thresholds) {
    ctx.fillStyle = 'rgba(220, 38, 38, 0.9)';
    for (const length of episodes) {
      if (length >= thresholds.low && length <= thresholds.high) continue;
      const x = plotLeft + (length / (lengthMax || 1)) * plotWidth;
      ctx.beginPath();
      ctx.arc(x, plotBottom - 4, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    if (thresholds.high < lengthMax) {
      const x = plotLeft + (thresholds.high / (lengthMax || 1)) * plotWidth;
      ctx.strokeStyle = 'rgba(220, 38, 38, 0.5)';
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x, plotTop);
      ctx.lineTo(x, plotBottom);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  ctx.fillStyle = CANVAS_TEXT_COLOR;
  ctx.textAlign = 'center';
  ctx.fillText('短', plotLeft + 8, height - 6);
  ctx.fillText('长', plotRight - 8, height - 6);
  ctx.textAlign = 'left';
  setText(
    'telemetry-episodes-caption',
    `episode 长度分布 · ${episodes.length} 段${closed ? '' : ' · 最后一段未闭合'}${outliers ? ` · ${outliers} 段离群` : ''}`,
  );
  setText(
    'telemetry-episodes-note',
    thresholds
      ? `episode 以 done/fall 事件切分；红点为离群 episode（与中位数 ${thresholds.median} 帧相差超过 3×MAD=${thresholds.mad} 帧）。`
      : 'episode 以 done/fall 事件切分；各段长度一致或样本过少，未做离群判定。',
  );
}

// --- Unified scrub timeline -------------------------------------------------
// 一条时间轴同步三个视图（reward 曲线 / 观测与动作热力图 / 相机帧与逐帧回放），
// 对标 Rerun / LeRobot visualize_dataset 的同步 scrub 模式。位置状态来自
// state.replay.index（与逐帧回放播放器共用同一位置源），这里只负责把三个
// 画布和文案同步到同一帧。

function telemetryScrubMax(samples) {
  return Math.max(0, samples.length - 1);
}

function renderTelemetryScrub() {
  const scrub = $('telemetry-scrub');
  const input = $('telemetry-scrub-input');
  if (!scrub || !input) return;
  const evidence = currentTelemetry();
  const samples = Array.isArray(evidence?.samples) ? evidence.samples : null;
  if (!samples || !samples.length) {
    scrub.hidden = true;
    input.disabled = true;
    return;
  }
  scrub.hidden = false;
  const max = telemetryScrubMax(samples);
  input.max = String(max);
  input.value = String(Math.min(state.replay.index, max));
  input.disabled = false;
  const frame = samples[Math.min(state.replay.index, max)];
  setText(
    'telemetry-scrub-position',
    `${formatTelemetrySeconds(frame ? frame.t : 0)} · 帧 ${Math.min(state.replay.index + 1, samples.length)} / ${samples.length}`,
  );
}

function syncTelemetryVisualsToReplayIndex() {
  const evidence = currentTelemetry();
  const samples = Array.isArray(evidence?.samples) ? evidence.samples : null;
  if (!samples || !samples.length) return;
  const playheadIndex = Math.min(state.replay.index, samples.length - 1);
  drawTelemetryRewardTimeline(samples, playheadIndex);
  drawTelemetryHeatmap(samples, 'observation', 'telemetry-obs-heatmap', 'telemetry-obs-caption', playheadIndex);
  drawTelemetryHeatmap(samples, 'action', 'telemetry-action-heatmap', 'telemetry-action-caption', playheadIndex);
  renderTelemetryScrub();
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
  const playheadIndex = samples.length ? Math.min(state.replay.index, samples.length - 1) : -1;
  drawTelemetryRewardTimeline(samples, playheadIndex);
  const obsInfo = drawTelemetryHeatmap(
    samples,
    'observation',
    'telemetry-obs-heatmap',
    'telemetry-obs-caption',
    playheadIndex,
  );
  const actionInfo = drawTelemetryHeatmap(
    samples,
    'action',
    'telemetry-action-heatmap',
    'telemetry-action-caption',
    playheadIndex,
  );
  const ranges = [];
  if (obsInfo) ranges.push('观测 ±' + obsInfo.absMax.toFixed(2));
  if (actionInfo) ranges.push('动作 ±' + actionInfo.absMax.toFixed(2));
  setText('telemetry-heatmap-range', ranges.length ? ranges.join(' · ') : '—');
  drawTelemetryEpisodes(samples);
  renderTelemetryScrub();
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
      [
        '平均奖励',
        Number.isFinite(Number(summary.rewardMean))
          ? formatMetricNumber(Number(summary.rewardMean), 3)
          : '—',
      ],
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
      '<div class="empty-state telemetry-empty"><strong>还没有评测证据</strong><span>导入 JSONL 或先运行仿真，系统会生成可回放的 Sim2Real 摘要。</span><div class="telemetry-empty-actions"><button type="button" class="button button-primary button-small" data-telemetry-empty-action="import">导入遥测 JSONL</button><button type="button" class="button button-ghost button-small" data-telemetry-empty-action="simulate">去仿真录制 →</button></div></div>';
    root.querySelector('[data-telemetry-empty-action="import"]')?.addEventListener('click', () => $('telemetry-file-input')?.click());
    root.querySelector('[data-telemetry-empty-action="simulate"]')?.addEventListener('click', () => setView('simulate'));
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

function replayRuns() {
  return [...runsForCurrentModel()].filter((run) => Number(run.evaluation?.replay?.sampleCount || 0) > 0 || run.status === 'completed').slice(0, 30);
}

function renderReplayPlayer() {
  const select = $('replay-run-select');
  const play = $('replay-play-button');
  const stop = $('replay-stop-button');
  const seek = $('replay-seek');
  if (!select || !play || !stop || !seek) return;
  const runs = replayRuns();
  const current = state.replay.runId || runs[0]?.id || '';
  syncSelect(
    select,
    runs.map((run) => ({ value: run.id, textContent: `${run.id.slice(0, 8)} · ${statusLabel(run.status)}` })),
    runs.some((run) => run.id === current) ? current : '',
  );
  const loaded = state.replay.loaded && state.replay.runId === select.value;
  seek.max = String(Math.max(0, state.replay.frames.length - 1));
  seek.value = String(Math.min(state.replay.index, Math.max(0, state.replay.frames.length - 1)));
  seek.disabled = !loaded || !state.replay.frames.length;
  play.disabled = !loaded || !state.replay.frames.length;
  stop.disabled = !loaded || !state.replay.frames.length;
  play.textContent = state.replay.timer ? '❚❚ 暂停' : '▶ 播放';
  const frame = state.replay.frames[state.replay.index];
  setText('replay-frame-label', `${state.replay.frames.length ? state.replay.index + 1 : 0} / ${state.replay.frames.length} 帧`);
  setText('replay-time-label', frame ? formatTelemetrySeconds(frame.t) : '0.00s');
  setText('replay-status', loaded ? `已加载 ${state.replay.frames.length} 帧` : (runs.length ? '选择运行并加载回放' : '暂无可回放运行'));
  setText('replay-frame-detail', frame ? `当前帧 ${state.replay.index + 1} · observation ${frame.observation?.length || 0}D · action ${frame.action?.length || 0}D` : '加载后可拖动时间轴；回放帧会同步发送到嵌入仿真器。');
  renderReplayCameraFrame(frame);
}

// Indices of the replay frames that actually carry a camera frame.
//
// The board spools frames sparsely (one every `RDK_SIM2REAL_FRAME_STRIDE`
// samples, ~1 Hz at the default) while samples arrive at control rate, so only a
// fraction of the timeline has a frame of its own. Showing nothing for the rest
// would make scrubbing look broken, so the nearest frame is shown instead - and
// said to be the nearest one. Memoised because the index would otherwise be
// rebuilt on every scrub tick.
//
// The run id is part of the key on purpose: `state.replay` is reset in place on a
// few paths, so a reload of the SAME run can leave the array identity comparison
// matching while the contents were emptied. Keying on the identity alone would
// then serve a stale index and show nothing.
let replayFrameIndex = { source: null, runId: '', indices: [] };
function replayFrameIndices(frames) {
  const runId = state.replay.runId;
  if (replayFrameIndex.source === frames && replayFrameIndex.runId === runId) {
    return replayFrameIndex.indices;
  }
  const indices = [];
  for (let index = 0; index < frames.length; index += 1) {
    if (frames[index]?.cameraFrame) indices.push(index);
  }
  replayFrameIndex = { source: frames, runId, indices };
  return indices;
}

/** Frames carry their own decoded timestamp; this is the scrub position. */
function replayFrameTime(frame, index) {
  const value = Number(frame?.t);
  return Number.isFinite(value) ? value : index;
}

/** Nearest frame carrying a camera frame: at-or-before, else the first after. */
function nearestCameraFrameIndex(frames, index) {
  const indices = replayFrameIndices(frames);
  if (!indices.length) return -1;
  const after = indices.findIndex((candidate) => candidate > index);
  if (after === -1) return indices[indices.length - 1];
  if (after === 0) return indices[0];
  const before = indices[after - 1];
  const next = indices[after];
  return index - before <= next - index ? before : next;
}

// Aligned camera frame for the current replay position.
//
// A frame is the only way to see what a vision policy actually observed, so it
// is rendered from the payload itself and never synthesised. Nothing is guessed
// about the layout either - the declared channels decide how the flat pixel list
// is read. When the displayed frame is not the sample under the playhead, the
// note says so and names the frame's own timestamp, because a nearby image read
// as the current one would be a quiet factual error about what the policy saw.
function renderReplayCameraFrame(frame) {
  const figure = $('replay-camera');
  const canvas = $('replay-camera-canvas');
  const note = $('replay-camera-note');
  if (!figure || !canvas || !note) return;
  const frames = state.replay.frames;
  const sourceIndex = frames.length ? nearestCameraFrameIndex(frames, state.replay.index) : -1;
  const camera = sourceIndex >= 0 ? frames[sourceIndex]?.cameraFrame : null;
  if (!camera) {
    figure.hidden = true;
    note.textContent = '该运行没有对齐的相机帧（向量观测回放）。';
    return;
  }
  figure.hidden = false;
  const { width, height, channels } = camera;
  canvas.width = width;
  canvas.height = height;
  canvas.style.aspectRatio = `${width} / ${height}`;
  const context = canvas.getContext('2d');
  if (!context) {
    note.textContent = '当前浏览器无法绘制相机帧。';
    return;
  }
  try {
    const binary = atob(String(camera.data || ''));
    if (binary.length !== width * height * channels) throw new Error('frame length');
    const image = context.createImageData(width, height);
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const source = pixel * channels;
      const target = pixel * 4;
      const red = binary.charCodeAt(source);
      const green = channels === 1 ? red : binary.charCodeAt(source + 1);
      const blue = channels === 1 ? red : binary.charCodeAt(source + 2);
      image.data[target] = red;
      image.data[target + 1] = green;
      image.data[target + 2] = blue;
      image.data[target + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    const shape = `${width}×${height} · ${channels === 1 ? 'mono8' : camera.encoding}`;
    if (sourceIndex === state.replay.index) {
      note.textContent = `相机帧 ${shape} · 第 ${sourceIndex + 1} 帧（本采样点）`;
    } else {
      const sourceTime = replayFrameTime(frames[sourceIndex], sourceIndex);
      const hereTime = replayFrameTime(frame, state.replay.index);
      const delta = Math.abs(hereTime - sourceTime);
      note.textContent = `相机帧 ${shape} · 最近帧 t=${formatTelemetrySeconds(sourceTime)}（与当前位置相差 ${delta.toFixed(2)}s，非本采样点）`;
    }
  } catch {
    // A frame that fails to decode is reported as unusable instead of leaving
    // the previous frame on screen as if it belonged to this sample.
    context.clearRect(0, 0, width, height);
    note.textContent = '相机帧数据无法解码，已隐藏以免误读。';
  }
}

function sendReplayFrame() {
  const frame = state.replay.frames[state.replay.index];
  if (!frame) return;
  const iframe = $('simulator-frame');
  try { iframe?.contentWindow?.postMessage({ type: 'rdk-replay-frame', frame, index: state.replay.index, runId: state.replay.runId }, '*'); } catch { /* cross-origin iframe may reject; controls still work */ }
  renderReplayPlayer();
  // Keep the unified telemetry canvases (reward curve / heatmaps) on the same
  // frame as the replay player; they only redraw when local samples exist.
  syncTelemetryVisualsToReplayIndex();
  syncReplayVideoToFrame();
}

// ---- replay MP4 video (server-rendered camera frame artifact) --------------
// The video is a rendering of already-accepted board frames. The block tracks
// the loaded run: mounting a run checks the run's metrics for a rendered
// video, the export button POSTs the render (server ffmpeg), and playback
// syncs to the unified timeline in one direction (scrub → video time). The
// video's own controls stay usable; scrubbing it does not move the timeline.
function mountReplayVideo(runId, runMetrics, runTaskId) {
  const block = $('replay-video-block');
  const video = $('replay-video-element');
  const caption = $('replay-video-caption');
  const renderButton = $('replay-video-render');
  const download = $('replay-video-download');
  const note = $('replay-video-note');
  if (!block || !video || !caption || !renderButton) return;
  replayVideo.runId = runId;
  replayVideo.durationSeconds = 0;
  replayVideo.available = false;
  download.hidden = true;
  download.removeAttribute('href');
  video.removeAttribute('src');
  const scenePrefix = ACTION_TASKS[runTaskId]?.scene
    ? `该任务的训练场景（${ACTION_TASKS[runTaskId].scene}）在训练引擎侧运行；`
    : '';
  const meta = runMetrics?.replayVideo;
  if (!runId) {
    block.hidden = true;
    return;
  }
  block.hidden = false;
  renderButton.disabled = false;
  renderButton.textContent = '导出视频（ffmpeg）';
  if (note) {
    note.textContent =
      scenePrefix +
      '回放画面来自已验收的板端相机帧，不是新证据；播放进度与统一时间轴联动。';
  }
  if (meta && typeof meta.sha256 === 'string' && /^[a-f0-9]{64}$/.test(meta.sha256)) {
    mountReplayVideoSource(runId, meta);
  } else {
    caption.textContent = '尚未导出';
    if (note) {
      note.textContent +=
        '满足条件后可在此导出 MP4（单来源且全部 attested 的运行）。';
    }
  }
}

function mountReplayVideoSource(runId, meta) {
  const video = $('replay-video-element');
  const caption = $('replay-video-caption');
  const download = $('replay-video-download');
  if (!video || !caption) return;
  const url = apiPath('/sim2real/runs/' + encodeURIComponent(runId) + '/replay-video');
  video.src = url;
  replayVideo.runId = runId;
  replayVideo.available = true;
  replayVideo.durationSeconds = Number(meta.durationSeconds) || 0;
  caption.textContent = `${Number(meta.frameCount) || 0} 帧 · ${formatMetricNumber(Number(meta.fps) || 0, 2)} fps · ${formatMetricNumber(replayVideo.durationSeconds, 2)}s`;
  if (download) {
    download.hidden = false;
    download.href = url;
    download.setAttribute('download', `replay-${String(runId).slice(0, 12)}.mp4`);
  }
  // The first playback needs the metadata to map timeline seconds onto the
  // video; until then the sync just does nothing.
  video.addEventListener('loadedmetadata', () => {
    if (!Number.isFinite(replayVideo.durationSeconds) || replayVideo.durationSeconds <= 0) {
      replayVideo.durationSeconds = Number.isFinite(video.duration) ? video.duration : 0;
    }
  }, { once: true });
}

const replayVideo = { runId: null, available: false, durationSeconds: 0 };

/** Map the replay timeline onto the video's own clock and seek it. */
function syncReplayVideoToFrame() {
  if (!replayVideo.available) return;
  const video = $('replay-video-element');
  if (!video || !video.src) return;
  const frames = state.replay.frames;
  if (!frames.length) return;
  const span = replayVideo.durationSeconds > 0 ? replayVideo.durationSeconds : Number(video.duration);
  if (!Number.isFinite(span) || span <= 0) return;
  const t = replayFrameTime(frames[state.replay.index], state.replay.index);
  const first = replayFrameTime(frames[0], 0);
  const relative = Math.max(0, Math.min(span, t - first));
  // Guard against seek feedback churn: only move when the delta is visible.
  if (Math.abs(video.currentTime - relative) > 0.05) {
    try { video.currentTime = relative; } catch { /* not seekable yet */ }
  }
}

async function renderReplayVideo() {
  const runId = state.replay.runId;
  if (!runId) {
    showToast('先加载一个带相机帧的运行', 'error');
    return;
  }
  const button = $('replay-video-render');
  if (button) { button.disabled = true; button.textContent = '编码中…'; }
  try {
    const payload = await request(
      '/sim2real/runs/' + encodeURIComponent(runId) + '/replay-video',
      { method: 'POST' },
    );
    if (payload?.video) {
      mountReplayVideoSource(runId, payload.video);
      showToast(`视频已导出：${payload.video.frameCount} 帧 · ${formatMetricNumber(Number(payload.video.fps) || 0, 2)} fps`, 'success');
    }
    const caption = $('replay-video-caption');
    if (caption) caption.textContent = '已导出';
  } catch (error) {
    showToast(error instanceof Error ? error.message : '视频导出失败', 'error');
    const caption = $('replay-video-caption');
    if (caption) caption.textContent = '导出失败（见提示）';
  } finally {
    if (button) { button.disabled = false; button.textContent = '导出视频（ffmpeg）'; }
  }
}

function stopReplay() {
  if (state.replay.timer) clearInterval(state.replay.timer);
  state.replay.timer = null;
  renderReplayPlayer();
}

function toggleReplay() {
  if (!state.replay.frames.length) return;
  if (state.replay.timer) { stopReplay(); return; }
  state.replay.timer = setInterval(() => {
    if (state.replay.index >= state.replay.frames.length - 1) { stopReplay(); return; }
    state.replay.index += 1; sendReplayFrame();
  }, Math.max(10, 20 / Number(state.replay.speed || 1)));
  sendReplayFrame();
}

async function loadRunReplay() {
  const select = $('replay-run-select');
  const runId = String(select?.value || '').trim();
  if (!runId) { showToast('请选择包含遥测的运行记录', 'error'); return; }
  await fetchAndMountReplay(runId, { interactive: true });
}

// Server-side completion already auto-attached the engine's evaluation
// telemetry; this retry exists because the attach and the next poll race:
// a 404/empty on the first attempt is expected and re-attempted a few times
// with backoff, not surfaced as an error.
async function autoLoadRunReplay(runId, { interactive = false } = {}) {
  if (state.replay.autoLoadedFor === runId) return;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const loaded = await fetchAndMountReplay(runId, { interactive });
    if (loaded) { state.replay.autoLoadedFor = runId; return; }
    await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
  }
}

async function fetchAndMountReplay(runId, { interactive = false } = {}) {
  try {
    const payload = await request('/sim2real/runs/' + encodeURIComponent(runId) + '/replay');
    const frames = (Array.isArray(payload?.frames) ? payload.frames : []).map((sample) => ({ ...sample, t: Number(sample.t ?? sample.time ?? 0) })).sort((a, b) => a.t - b.t);
    if (!frames.length) {
      if (interactive) showToast('该运行没有原始遥测帧', 'normal');
      return false;
    }
    stopReplay();
    state.replay = { ...state.replay, runId, frames, index: 0, loaded: true, timer: null, autoLoadedFor: runId };
    renderReplayPlayer();
    sendReplayFrame();
    // The replay payload carries frames, not run metrics; fetch the run row
    // for the replay-video record (a previously rendered MP4 mounts directly).
    void (async () => {
      try {
        const runPayload = await request('/sim2real/runs/' + encodeURIComponent(runId));
        mountReplayVideo(runId, runPayload?.run?.metrics, runPayload?.run?.taskId);
      } catch {
        mountReplayVideo(runId, null);
      }
    })();
    if (interactive) showToast(`已加载 ${frames.length} 帧，可开始回放`, 'success');
    else showToast(`评测回放已自动挂载：${frames.length} 帧（${runId.slice(0, 8)}）`, 'normal');
    return true;
  } catch (error) {
    if (interactive) showToast(error instanceof Error ? error.message : '回放加载失败', 'error');
    return false;
  }
}

// ---- browser ONNX policy trial (drives the embedded simulator) ----
// Mirrors the microduck pattern: the trained policy runs fully in-browser
// with ONNX Runtime Web (vendored under /vendor/onnxruntime-web, no CDN).
// postMessage cannot carry functions, so the iframe performs the inference
// itself; this side only sends the clonable runId/apiRoot and relays the
// status messages the simulator posts back.
const policyTrial = { runId: '', running: false };

function setPolicyTrialStatus(text) {
  const status = $('policy-trial-status');
  if (status) status.textContent = text;
  const button = $('policy-trial-button');
  const stopButton = $('policy-trial-stop');
  if (button) { button.disabled = policyTrial.running; button.textContent = policyTrial.running ? '试跑中…' : '🚀 策略试跑（浏览器推理）'; }
  if (stopButton) stopButton.disabled = !policyTrial.running;
}

window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object' || data.type !== 'rdk-policy-status') return;
  const message = String(data.message || '');
  if (data.phase === 'running') {
    policyTrial.running = true;
    setPolicyTrialStatus(message || '策略试跑进行中：浏览器 wasm 推理驱动仿真器。');
  } else if (data.phase === 'finished' || data.phase === 'failed' || data.phase === 'stopped') {
    policyTrial.running = false;
    setPolicyTrialStatus(message || '策略试跑已结束。');
    if (data.phase === 'failed') showToast(message || '策略试跑失败', 'error');
    else if (data.phase === 'finished') showToast(message || '策略试跑结束', 'normal');
  } else if (data.phase === 'loading') {
    setPolicyTrialStatus(message || '正在准备浏览器推理…');
  }
});

function startPolicyTrial() {
  if (policyTrial.running) return;
  const boardBackend = $('policy-trial-board')?.checked === true;
  const runId = state.replay.runId || String($('replay-run-select')?.value || '').trim();
  if (!boardBackend && !runId) { showToast('请先加载一个已完成运行的回放，再试跑策略（板端推理模式无需回放）', 'error'); return; }
  const iframe = $('simulator-frame');
  if (!iframe?.contentWindow) { showToast('嵌入仿真器不可用', 'error'); return; }
  policyTrial.runId = boardBackend ? 'board' : runId;
  policyTrial.running = true;
  setPolicyTrialStatus(boardBackend ? '正在启动板端推理…' : '正在启动浏览器推理…');
  try {
    iframe.contentWindow.postMessage(
      {
        type: 'rdk-policy-run',
        runId,
        apiRoot: apiPath('/sim2real'),
        maxSteps: 600,
        backend: boardBackend ? 'board' : 'wasm',
      },
      '*',
    );
  } catch (error) {
    policyTrial.running = false;
    const message = error instanceof Error ? error.message : '策略试跑启动失败';
    setPolicyTrialStatus('试跑失败：' + message);
    showToast(message, 'error');
  }
}

function stopPolicyTrial() {
  if (!policyTrial.running) return;
  const iframe = $('simulator-frame');
  try { iframe?.contentWindow?.postMessage({ type: 'rdk-policy-stop' }, '*'); } catch { /* cross-origin iframe may reject */ }
  setPolicyTrialStatus('正在停止策略试跑…');
}

async function importTelemetryFile(event) {
  const input = event.target;
  const file = input?.files?.[0];
  if (!file) return;
  try {
    const evidence = parseTelemetryText(
      await readImportTextWithinLimit(
        file,
        SimTelemetryCore.MAX_TELEMETRY_IMPORT_BYTES,
        '遥测文件',
      ),
    );
    evidence.fileName = file.name;
    state.telemetry = stampTelemetryContext(evidence);
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
    state.telemetry = stampTelemetryContext(evidence);
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
    showRecoverableError(
      '遥测无法绑定到该 Run',
      '当前 Run 的模型契约不可用，无法安全绑定遥测。',
      '查看运行详情',
      () => openRecordDetails(run),
    );
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
  renderReplayPlayer();
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
  const latestMetrics = latest?.metrics || {};
  const hasRunEvaluation = Boolean(
    latest &&
      latest.mock !== true &&
      (latest.evaluation ||
        latest.taskEvaluation ||
        latestMetrics.successRate != null ||
        latestMetrics.fallRate != null ||
        latestMetrics.controlLatencyMs != null ||
        latestMetrics.latencyMs != null),
  );
  const hasTelemetryEvidence = Boolean(
    evidence &&
      (evidence.summary ||
        evidence.samples?.length ||
        evidence.publishedRunId ||
        evidence.evaluation),
  );
  // 空态优先：没有真实 Run 评测或遥测证据时，六个空面板各自用不同的
  // 措辞说"没数据"（14 处空文案、9 个"—"、5/10 禁用按钮，一面 2000px 的
  // 空脚手架墙）。尤其是 Mock Run：它只能证明协议和台账通了，不能让
  // 页面重新显示一套没有指标的“结果”卡。收起全部空面板，换一张三步
  // 引导卡；一旦有真实证据立刻恢复完整仪表盘。banner 与底部"下一步"条
  // 保留——它们是状态提醒，不是空数据面板。
  const evaluateView = document.querySelector('[data-view-section="evaluate"]');
  const dashboardEmpty = !hasRunEvaluation && !hasTelemetryEvidence;
  if (evaluateView) evaluateView.dataset.empty = dashboardEmpty ? 'true' : 'false';
  const emptyGuide = $('evaluation-empty');
  if (emptyGuide) emptyGuide.hidden = !dashboardEmpty;
  if (dashboardEmpty) {
    const qualityBadge = $('eval-run-quality');
    if (qualityBadge) qualityBadge.hidden = true;
  }
  renderRunComparison(runs);
  const metrics = latestMetrics;
  const status = String(latest?.status || '').toLowerCase();
  const mockRun = latest?.mock === true;
  const demoEvidence = isSyntheticEvidence(evidence, latest);
  const evaluationExists = hasRealEvaluation(evidence, latest);
  const releaseGradeEvidence = hasReleaseGradeEvidence(evidence, latest);
  const unverifiedEvidence = evaluationExists && !releaseGradeEvidence;
  // 空态文案与引导卡保持一致（"等待第一次…"），不要回落到主分支的
  // "尚未产生评测结果"——两句话在引导卡旁边各说各的会互相打架。
  let statusLabel = dashboardEmpty
    ? '等待第一次训练或遥测'
    : '尚未产生评测结果';
  if (mockRun && ['completed', 'ready'].includes(status)) {
    statusLabel = dashboardEmpty ? '已有协议演示 · 等待真实评测' : '协议演示完成';
  }
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
        : dashboardEmpty
          ? '导入遥测或完成一次训练后，这里会展开完整评测面板。'
          : '训练完成后，这里会显示最新一次运行的仿真/真机指标。',
  );
  const quality = $('eval-run-quality');
  if (quality) {
    // The task-pack gate verdict is the only qualified/unqualified claim the
    // banner may make: it comes from the run's taskEvaluation.qualityGate
    // (server-side), so a false verdict is never invented client-side.
    const gate = !mockRun && !demoEvidence ? latest?.taskEvaluation?.qualityGate : null;
    const gateReported = Boolean(gate && (gate.passed === true || gate.passed === false));
    const gateFailed = gateReported && gate.passed === false;
    const showQuality = mockRun || demoEvidence || unverifiedEvidence || gateReported;
    quality.hidden = !showQuality;
    quality.className =
      'state-badge ' +
      (gateReported
        ? gate.passed
          ? 'state-success'
          : 'state-error'
        : unverifiedEvidence && !mockRun && !demoEvidence
          ? 'state-partial'
          : 'state-demo') +
      ' evaluation-quality';
    quality.textContent = gateReported
      ? gate.passed
        ? '质量门通过 · Qualified'
        : '质量门未通过 · Unqualified'
      : mockRun
        ? 'Mock 协议演示 · 非真实 RL'
        : demoEvidence
          ? '合成证据 · 非真实遥测'
          : '来源未验证 · 不能证明 X5';
    quality.title = gateReported
      ? gate.passed
        ? '任务包质量门（成功率/碰撞率等判据）判定通过，评测结论可用于发布证据链。'
        : '任务包质量门判定未通过：' +
          (Array.isArray(gate.errors) && gate.errors.length ? gate.errors.join('；') : '未返回具体原因。')
      : mockRun
        ? '该运行只验证训练协议和台账，不生成可部署模型或真实 RL 指标。'
        : demoEvidence
          ? '该遥测由页面内置合成样例生成，不代表真实 X5。'
          : '该回放的 source 由上传方声明，尚未经过受信适配器验证，不能作为 X5 真实性证明。';
    // An unqualified verdict is exactly the kind of "AI 出错时" moment the
    // banner must not flatten into "评测已完成" — downgrade the status label
    // so the operator sees the failure, not just the badge.
    if (gateFailed && (statusLabel === '评测已完成' || statusLabel === '等待评测结果')) {
      statusLabel = '评测完成 · 质量门未通过';
      setText('eval-run-status', statusLabel);
    }
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
  // The number is meaningless without its stage, so the caption travels with
  // it: a host-side figure must never read as an on-board control budget.
  setText(
    'eval-latency-label',
    typeof performanceMetrics.controlLatencyMs === 'number'
      ? controlLatencyLabel(performanceMetrics)
      : '控制延迟',
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

// A compact, honest comparison view for the last few Runs. It deliberately
// leaves missing metrics blank and marks protocol/demo runs, so operators can
// spot a trend without mistaking a receipt for real robot performance. The
// operator picks the metric and how many runs to compare; runs with live
// progress points are overlaid on one reward-curve canvas.
const RUN_COMPARE_METRICS = {
  successRate: { label: '成功率', format: (value) => { const v = metricPercent(value); return v == null ? '—' : `${v}%`; }, },
  reward: { label: '平均奖励', format: (value) => formatMetricNumber(value, 2) },
  fallRate: { label: '跌倒率', format: (value) => { const v = metricPercent(value); return v == null ? '—' : `${v}%`; } },
  episodeLength: { label: '平均步数', format: (value) => formatMetricNumber(value, 1) },
  iterations: { label: '迭代数', format: (value) => formatMetricNumber(value, 0) },
};
const RUN_COMPARE_COLORS = ['#55ddb0', '#60a5fa', '#f0b429', '#e879a6', '#a78bfa', '#34d399', '#7dd3fc', '#fca5a5'];
const RUN_COMPARE_CANVAS_W = 720;
const RUN_COMPARE_CANVAS_H = 260;

function runCompareState() {
  const metricKey = String($('run-compare-metric')?.value || 'successRate');
  const metric = RUN_COMPARE_METRICS[metricKey] ? metricKey : 'successRate';
  const countRaw = Number($('run-compare-count')?.value || 5);
  const count = [5, 10, 20].includes(countRaw) ? countRaw : 5;
  return { metric, count };
}

function drawRunCompareChart(runs) {
  const wrap = $('run-comparison-chart');
  const canvas = $('run-compare-canvas');
  if (!wrap || !canvas) return;
  const series = runs
    .map((run, index) => ({ run, points: runProgressPoints(run), color: RUN_COMPARE_COLORS[index % RUN_COMPARE_COLORS.length] }))
    .filter((entry) => entry.points.length > 1);
  wrap.hidden = !series.length;
  if (!series.length) return;
  const ctx = clearCanvas(canvas, RUN_COMPARE_CANVAS_W, RUN_COMPARE_CANVAS_H);
  if (!ctx) return;
  const width = RUN_COMPARE_CANVAS_W;
  const height = RUN_COMPARE_CANVAS_H;
  const plotLeft = 46;
  const plotRight = width - 10;
  const plotTop = 28;
  const plotBottom = height - 20;
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - plotTop;
  const iterationMax = Math.max(
    ...series.flatMap((entry) => entry.points.map((point) => point.iteration)),
  );
  const rewards = series.flatMap((entry) => entry.points.map((point) => point.meanReward));
  let rewardMin = Math.min(0, ...rewards);
  let rewardMax = Math.max(0, ...rewards);
  if (rewardMin === rewardMax) rewardMax = rewardMin + 1;
  const rewardPad = (rewardMax - rewardMin) * 0.08;
  rewardMin -= rewardPad;
  rewardMax += rewardPad;
  const xOf = (iteration) => plotLeft + (iteration / (iterationMax || 1)) * plotWidth;
  const yOf = (reward) => plotBottom - ((reward - rewardMin) / (rewardMax - rewardMin)) * plotHeight;
  ctx.font = CANVAS_TEXT_STYLE;
  ctx.strokeStyle = 'rgba(28, 28, 26, 0.12)';
  ctx.lineWidth = 1;
  ctx.fillStyle = CANVAS_TEXT_COLOR;
  ctx.textAlign = 'right';
  for (const reward of [rewardMax, (rewardMax + rewardMin) / 2, rewardMin]) {
    const y = Math.round(yOf(reward)) + 0.5;
    if (y <= plotTop || y >= plotBottom) continue;
    ctx.beginPath();
    ctx.moveTo(plotLeft, y);
    ctx.lineTo(plotRight, y);
    ctx.stroke();
    ctx.fillText(reward.toFixed(2), plotLeft - 4, y + 3);
  }
  ctx.fillText('iter 0', plotLeft, plotBottom + 12);
  ctx.fillText(String(iterationMax), plotRight, plotBottom + 12);
  // Series + inline legend swatches above the plot.
  ctx.textAlign = 'left';
  let legendX = plotLeft;
  series.forEach((entry) => {
    ctx.strokeStyle = entry.color;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    entry.points.forEach((point, index) => {
      const x = xOf(point.iteration);
      const y = yOf(point.meanReward);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.fillStyle = entry.color;
    const legend = `#${String(entry.run.indexLabel || '')}`;
    ctx.fillText(legend === '#' ? '' : legend, legendX, plotTop - 6);
    legendX += ctx.measureText(legend).width + 14;
  });
}

function renderRunComparison(runs) {
  const root = $('run-comparison');
  if (!root) return;
  const { metric, count } = runCompareState();
  const recent = (runs || []).slice(0, count);
  setText('run-comparison-caption', recent.length ? `最近 ${recent.length} 次` : '暂无数据');
  drawRunCompareChart(recent.map((run, index) => ({ ...run, indexLabel: index + 1 })));
  drawRunParCoords(recent.map((run, index) => ({ ...run, indexLabel: index + 1 })));
  renderRunParamDiff(recent);
  if (!recent.length) {
    root.innerHTML = '<div class="empty-inline">完成一次训练或评测后，这里会显示可比较的指标。</div>';
    return;
  }
  const metrics = [
    { key: metric, label: RUN_COMPARE_METRICS[metric].label, format: RUN_COMPARE_METRICS[metric].format },
    { key: 'successRate', label: '成功率', format: (value) => { const v = metricPercent(value); return v == null ? '—' : `${v}%`; } },
    { key: 'fallRate', label: '跌倒率', format: (value) => { const v = metricPercent(value); return v == null ? '—' : `${v}%`; } },
    { key: 'reward', label: '平均奖励', format: (value) => formatMetricNumber(value, 2) },
  ].filter((entry, index, all) => all.findIndex((other) => other.key === entry.key) === index);
  const values = Object.fromEntries(metrics.map((metric) => [metric.key, recent.map((run) => finiteNumber(run?.metrics?.[metric.key])).filter((value) => value !== null)]));
  root.innerHTML = recent.map((run, index) => {
    const metricsHtml = metrics.map((metric) => {
      const raw = finiteNumber(run?.metrics?.[metric.key]);
      const all = values[metric.key];
      let width = 0;
      if (raw !== null && all.length) {
        const min = Math.min(...all);
        const max = Math.max(...all);
        width = max === min ? 100 : ((raw - min) / (max - min)) * 100;
        width = Math.max(8, Math.min(100, width));
      }
      return `<div class="run-compare-metric"><span>${escapeHtml(metric.label)}</span><div class="run-compare-track"><i style="width:${width}%"></i></div><b>${escapeHtml(raw === null ? '—' : metric.format(raw))}</b></div>`; // escape-audit:allow width is a number clamped to [8,100]
    }).join('');
    const mock = run.mock === true || run.evaluation?.replay?.source === 'demo-fixture';
    const title = run.summary || run.taskId || run.backend || `Run ${index + 1}`; // escape-audit:allow index + 1 is a number
    const legendColor = RUN_COMPARE_COLORS[index % RUN_COMPARE_COLORS.length];
    return `<div class="run-compare-row"><div class="run-compare-name"><strong><i class="run-compare-swatch" style="background:${legendColor}"></i>${escapeHtml(title)}</strong><small>${escapeHtml(formatDate(run.createdAt))} · ${escapeHtml(statusLabel(run.status))}${mock ? ' · 演示' : ''}</small></div><div class="run-compare-metrics">${metricsHtml}</div></div>`; // escape-audit:allow metricsHtml is built above from escaped values only; legendColor is a fixed palette constant
  }).join('');
}

// --- Parallel coordinates + parameter diff ---------------------------------
// 对标 MLflow/Aim 的 run 对比模式：多指标平行坐标看整体形状，参数 diff 表
// 看每次改了什么。指标列逐列归一化；缺指标的运行整条不参与（不猜值）。

const RUN_PARCOORDS_CANVAS_W = 720;
const RUN_PARCOORDS_CANVAS_H = 220;
const RUN_PARCOORDS_METRICS = [
  { key: 'reward', label: '平均奖励', higherIsBetter: true },
  { key: 'successRate', label: '成功率', higherIsBetter: true },
  { key: 'fallRate', label: '跌倒率', higherIsBetter: false },
  { key: 'episodeLength', label: '平均步数', higherIsBetter: true },
];

function drawRunParCoords(runs) {
  const wrap = $('run-comparison-parcoords');
  const canvas = $('run-parcoords-canvas');
  if (!wrap || !canvas) return;
  // Only runs carrying every plotted metric can be drawn as a full polyline;
  // a run with a hole would need a guessed value, so it stays out.
  const series = runs.filter((run) =>
    RUN_PARCOORDS_METRICS.every((metric) => finiteNumber(run?.metrics?.[metric.key]) !== null),
  );
  wrap.hidden = series.length < 2;
  if (series.length < 2) return;
  const ctx = clearCanvas(canvas, RUN_PARCOORDS_CANVAS_W, RUN_PARCOORDS_CANVAS_H);
  if (!ctx) return;
  const width = RUN_PARCOORDS_CANVAS_W;
  const height = RUN_PARCOORDS_CANVAS_H;
  const plotTop = 24;
  const plotBottom = height - 18;
  const plotHeight = plotBottom - plotTop;
  const colCount = RUN_PARCOORDS_METRICS.length;
  const colWidth = (width - 20) / (colCount - 1);
  const xOf = (col) => 10 + col * colWidth;
  // Per-column min/max across the plotted runs; "worse" always maps to the
  // bottom so a higher line is uniformly better.
  const scales = RUN_PARCOORDS_METRICS.map((metric) => {
    const values = series.map((run) => Number(run.metrics[metric.key]));
    const min = Math.min(...values);
    const max = Math.max(...values);
    return { min, max: max === min ? min + 1 : max, invert: !metric.higherIsBetter };
  });
  const yOf = (value, scale) => {
    const normalized = (value - scale.min) / (scale.max - scale.min);
    return plotBottom - (scale.invert ? 1 - normalized : normalized) * plotHeight;
  };
  ctx.font = CANVAS_TEXT_STYLE;
  ctx.fillStyle = CANVAS_TEXT_COLOR;
  ctx.textAlign = 'center';
  RUN_PARCOORDS_METRICS.forEach((metric, col) => {
    const x = xOf(col);
    ctx.strokeStyle = 'rgba(28, 28, 26, 0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, plotTop);
    ctx.lineTo(x, plotBottom);
    ctx.stroke();
    ctx.fillText(metric.label, x, 12);
    const scale = scales[col];
    ctx.textAlign = x < width / 2 ? 'left' : 'right';
    ctx.fillText(formatMetricNumber(scale.invert ? scale.min : scale.max, 1), x + (x < width / 2 ? 4 : -4), plotTop + 3);
    ctx.fillText(formatMetricNumber(scale.invert ? scale.max : scale.min, 1), x + (x < width / 2 ? 4 : -4), plotBottom);
    ctx.textAlign = 'center';
  });
  series.forEach((run, index) => {
    const color = RUN_COMPARE_COLORS[(run.indexLabel - 1) % RUN_COMPARE_COLORS.length];
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    RUN_PARCOORDS_METRICS.forEach((metric, col) => {
      const x = xOf(col);
      const y = yOf(Number(run.metrics[metric.key]), scales[col]);
      if (col === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.fillText(`#${run.indexLabel}`, xOf(colCount - 1) + 6, yOf(Number(run.metrics[RUN_PARCOORDS_METRICS[colCount - 1].key]), scales[colCount - 1]) + 3);
  });
}

// Parameter diff table: one row per training-parameter key that actually
// differs across the compared runs, one column per run (recent first).
// Values come from run.training and run.metrics.engine — nothing is invented.
const RUN_DIFF_PARAMS = [
  { label: '引擎', pick: (run) => run?.metrics?.engine ?? run?.training?.engine ?? '' },
  { label: '算法', pick: (run) => run?.training?.algorithm ?? '' },
  { label: '档位', pick: (run) => run?.training?.profile ?? '' },
  { label: '环境数', pick: (run) => (run?.training?.numEnvs != null ? String(run.training.numEnvs) : '') },
  { label: '迭代上限', pick: (run) => (run?.training?.maxIterations != null ? String(run.training.maxIterations) : '') },
  { label: '后端', pick: (run) => run?.backend ?? '' },
  { label: '任务', pick: (run) => run?.taskId ?? '' },
];

function renderRunParamDiff(runs) {
  const wrap = $('run-comparison-diff');
  const body = $('run-diff-body');
  const header = $('run-diff-header');
  if (!wrap || !body || !header) return;
  if (!runs || runs.length < 2) {
    wrap.hidden = true;
    return;
  }
  // One column per run, recent first; #n matches the curve-chart legend and
  // the run list below, so three views share one numbering.
  header.innerHTML =
    '<th>参数</th>' +
    runs
      .map((run, index) => `<th>#${escapeHtml(String(index + 1))}${index === 0 ? ' · 最近' : ''}</th>`)
      .join('');
  const rows = RUN_DIFF_PARAMS.map((param) => {
    const values = runs.map((run) => String(param.pick(run) ?? ''));
    return { param, values };
  }).filter((row) => {
    const meaningful = row.values.filter(Boolean);
    return meaningful.length > 1 && new Set(meaningful).size > 1;
  });
  wrap.hidden = rows.length === 0;
  if (!rows.length) {
    body.innerHTML = '';
    setText('run-diff-note', '各次运行的训练参数全部一致，没有可对比的差异。');
    return;
  }
  setText('run-diff-note', '只列出各次运行之间实际不同的训练参数；#n 对应上方曲线图例与运行列表顺序。');
  body.innerHTML = rows
    .map((row) => {
      const cells = row.values
        .map((value) => `<td${value ? '' : ' class="is-empty"'}>${escapeHtml(value || '—')}</td>`)
        .join('');
      return `<tr><th scope="row">${escapeHtml(row.param.label)}</th>${cells}</tr>`; // escape-audit:allow cells is built only from escapeHtml-wrapped values
    })
    .join('');
}

// Comparison controls re-render on change; the chart redraws from the same
// overview data without another fetch.
function wireRunComparisonControls() {
  $('run-compare-metric')?.addEventListener('change', () => {
    renderRunComparison(runsForCurrentModelSortedForCompare());
  });
  $('run-compare-count')?.addEventListener('change', () => {
    renderRunComparison(runsForCurrentModelSortedForCompare());
  });
}

function runsForCurrentModelSortedForCompare() {
  return [...runsForCurrentModel()].sort((a, b) =>
    String(b.createdAt || '').localeCompare(String(a.createdAt || '')),
  );
}

// ---- 真机实时对照（评估页，OriginBot 只读遥测 2s 快照） -------------------
// 与效果对比图并排显示当下真机侧写：电压、IMU 航向、里程计。数据缺失时
// 如实显示「无数据」，绝不合成。轮询只在 evaluate 视图内进行。

async function originbotCompareRefresh() {
  try {
    const payload = await request('/sim2real/board-station/status');
    if (payload?.available === false || payload?.state === 'offline') {
      const panel = $('originbot-compare-panel');
      if (panel) panel.dataset.live = 'off';
      setText('ob-compare-voltage', '无数据');
      setText('ob-compare-heading', '无数据');
      setText('ob-compare-odom', '无数据');
      setText('ob-compare-source', `板卡离线 · ${String(payload.message || '等待实体板卡接入')}`);
      return;
    }
    const status = payload?.status || {};
    // The board agent exposes the adapter telemetry under both `originbot`
    // (legacy clients) and `telemetry` (generic clients). Prefer the generic
    // field so this panel keeps working for custom hardware profiles.
    const ob = stationTelemetrySnapshot(status);
    const panel = $('originbot-compare-panel');
    const hasTelemetry = telemetryHasData(ob);
    if (panel) panel.dataset.live = hasTelemetry ? 'on' : 'off';
    const caption = panel?.querySelector('.panel-caption');
    if (caption) {
      const profileName = status.profile?.displayName || status.board?.model || status.adapterId;
      caption.textContent = profileName ? `${profileName} · 只读遥测` : '当前适配包 · 只读遥测';
    }
    if (hasTelemetry) {
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

// 只在 evaluate 视图内轮询；进入视图立即刷一帧，离开即停。
const originbotComparePoll = createScopedPoll({
  name: 'originbot-compare',
  views: ['evaluate'],
  immediate: true,
  nextDelay: 2000,
  tick: originbotCompareRefresh,
});

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
  let copy = selectedTask().hint + '。回放用于验证策略，强化学习训练可直接选择本地 GPU 或 RoboGo 提交。';
  let label = '进入仿真与录制 →';
  // Zero-friction first contact: anonymous visitors get the playable simulator
  // as the primary CTA instead of an auth wall. Training history, evaluation
  // evidence and device deployment need an account; exploring the physics
  // sandbox does not.
  if (state.authRequired) {
    view = 'simulate';
    title = '不用登录，先玩一段仿真';
    copy = '内置 MicroDuck 物理仿真可以直接运行：选个任务、录一段轨迹、看看回放。要保存训练记录和连接真机时再登录也不迟。';
    label = '直接开始仿真 →';
  } else if (!model) {
    view = 'train';
    title = '先登记一个模型契约';
    copy = '选择产品线并导入 manifest，平台会先检查观测、动作、运行时和制品引用。';
    label = '去训练页登记契约 →';
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
  // Once the server exposes the Golden Path, its next action is authoritative
  // for the CTA. This keeps the UI aligned with API/CLI/RDK Studio clients.
  const goldenNext = state.goldenPath?.nextAction;
  if (goldenNext) {
    view = ({ task: 'simulate', dataset: 'train', train: 'train', evaluate: 'evaluate', deploy: 'deploy', feedback: 'records' }[goldenNext.stage] || view);
    title = '下一步：' + goldenNext.label;
    copy = goldenNext.reason;
    label = '继续' + goldenNext.label + ' →';
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
    button.dataset.viewTarget = 'train';
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
    node.dataset.state = stateName;
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
                : key === 'preflight'
                  ? '03'
                  : key === 'canary'
                    ? '04'
                    : '05';
    const small = node.querySelector('small');
    if (small && detail) small.textContent = detail;
    const title = node.querySelector('strong')?.textContent?.trim() || key;
    node.setAttribute('aria-label', `${title}：${detail || '状态未知'}`);
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
  update(
    'preflight',
    preflightReady ? 'ready' : deployment ? 'current' : 'locked',
    preflightReady
      ? '设备、工具链和制品预检通过'
      : deployment
        ? '计划已生成；执行只读检查查看结果'
        : '先生成只读预检计划',
  );
  const approvalStatus = deployment?.approval?.status;
  update(
    'canary',
    approvalStatus === 'approved' ? 'ready' : approvalStatus === 'rejected' ? 'failed' : 'blocked',
    approvalStatus === 'approved'
      ? '人工审批已通过；等待受控 BoardAgent 执行'
      : approvalStatus === 'rejected'
        ? '人工审批已拒绝；请修复证据或兼容性问题后重新建计划'
        : '需要目标设备 BoardAgent、owner/admin 人工审批和双开关；网页不会直接启动执行器',
  );
  update(
    'live',
    approvalStatus === 'approved' && deployment?.mode === 'live' ? 'ready' : 'locked',
    approvalStatus === 'approved' && deployment?.mode === 'live'
      ? '人工审批已通过；等待外部发布适配器执行'
      : '人工批准后开放',
  );
}

// 闭环四阶段的唯一状态来源。
// 顶栏管道和页面内进度条以前各自推导一遍，而且都写成
// `X ? 'complete' : 'current'`，于是"未完成的阶段"全是 current——
// 契约就绪时「契约·仿真」和「训练」会同时点亮。现在只有
// 「最靠后的、已解锁且未完成」的那一个阶段是 current，其余已解锁的
// 阶段标 ready（可进入但不是下一步），未解锁的标 blocked。
const LOOP_STAGES = ['simulate', 'train', 'evaluate', 'deploy'];
function deriveLoopStates() {
  const model = selectedModel();
  const latest = latestRun();
  const telemetry = currentTelemetry();
  const deployment = deploymentsForCurrentModel()
    .slice()
    .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))[0];
  const complete = {
    simulate: Boolean(telemetry?.summary || latest?.evaluation?.replay || latest?.taskEvaluation?.replay),
    train: Boolean(latest && ['completed', 'ready'].includes(String(latest.status || '').toLowerCase())),
    evaluate: Boolean(telemetry?.summary || latest?.evaluation || latest?.taskEvaluation),
    deploy: Boolean(deployment && ['ready', 'completed', 'planned', 'running'].includes(String(deployment.status || '').toLowerCase())),
  };
  const contractReady = Boolean(model?.manifest?.contract?.id && model?.manifest?.artifacts?.length);
  const unlocked = {
    simulate: true,
    train: contractReady,
    evaluate: complete.simulate || complete.train,
    deploy: complete.evaluate,
  };
  // 「下一步」= 最靠前的、已解锁且未完成的阶段；其余已解锁的阶段是 ready
  // （可以进入，但不是建议的下一步），未解锁的是 blocked。与概览首跑清单
  // 的 currentKey 取法一致，避免两处进度条各指一步。
  const actionable = LOOP_STAGES.filter((key) => !complete[key] && unlocked[key]);
  const current = actionable.length ? actionable[0] : null;
  const states = {};
  for (const key of LOOP_STAGES) {
    states[key] = complete[key] ? 'complete' : key === current ? 'current' : unlocked[key] ? 'ready' : 'blocked';
  }
  return { states, current };
}

function renderWorkflowProgress() {
  const rail = $('workflow-progress-strip');
  if (!rail) return;
  let { states, current } = deriveLoopStates();
  const goldenStages = Array.isArray(state.goldenPath?.stages) ? state.goldenPath.stages : [];
  if (goldenStages.length) {
    const byKey = new Map(goldenStages.map((item) => [item.key, item]));
    const mapping = { simulate: 'dataset', train: 'train', evaluate: 'evaluate', deploy: 'deploy' };
    states = {};
    for (const [view, stageKey] of Object.entries(mapping)) {
      const item = byKey.get(stageKey);
      states[view] = item?.state === 'succeeded' ? 'complete' : item?.state === 'blocked' || item?.state === 'failed' ? 'blocked' : item?.state === 'running' ? 'current' : 'ready';
    }
    const next = state.goldenPath.nextAction?.stage;
    current = next ? ({ task: 'simulate', dataset: 'simulate', train: 'train', evaluate: 'evaluate', deploy: 'deploy', feedback: 'records' }[next] || null) : null;
  }
  const summary = $('workflow-progress-summary');
  if (summary) summary.textContent = ({ simulate: '回放可选，用于验证策略', train: '模型已就绪，开始配置训练', evaluate: '打开评测查看回放', deploy: '评测完成，可生成预检计划' })[current] || '按步骤完成闭环';
  rail.querySelectorAll('[data-workflow-step]').forEach((item) => {
    const key = item.dataset.workflowStep;
    item.classList.toggle('is-current', key === current);
    item.classList.toggle('is-complete', states[key] === 'complete');
    item.classList.toggle('is-blocked', states[key] === 'blocked');
    const button = item.querySelector('button');
    if (button) {
      const blocked = states[key] === 'blocked';
      const label = button.textContent.trim();
      button.setAttribute('aria-label', blocked ? `${label}（尚未满足前置条件）` : label);
      button.title = blocked ? '完成前面的步骤后可进入' : `打开${button.querySelector('strong')?.textContent || ''}`;
    }
  });
  // Mirror the same loop states onto the sidebar nav so completed stages
  // carry a ✓ the same way the in-page progress strip does; the sidebar is
  // the persistent wayfinding surface across every view.
  document.querySelectorAll('.workflow-nav .nav-item[data-view-target]').forEach((item) => {
    const key = item.dataset.viewTarget;
    const stepState = Object.hasOwn(states, key) ? states[key] : null;
    item.classList.toggle('is-complete', stepState === 'complete');
    if (stepState === 'complete') {
      item.setAttribute('aria-label', `${item.textContent.trim()}（已完成）`);
    } else {
      item.removeAttribute('aria-label');
    }
  });
}

// 概览上手清单：同一份闭环状态落到四步清单上，每步的 meta 区域按状态
// 渲染“已完成 / 去做 → / 需登录”，游客在后两步看到登录引导而不是死链。
function renderOnboardChecklist() {
  const list = $('onboard-list');
  if (!list) return;
  const model = selectedModel();
  const latest = latestRun();
  const telemetry = currentTelemetry();
  const contractReady = Boolean(model?.manifest?.contract?.id && model?.manifest?.artifacts?.length);
  const replayReady = Boolean(telemetry?.summary || latest?.evaluation?.replay || latest?.taskEvaluation?.replay);
  const trainingReady = Boolean(latest && ['completed', 'ready'].includes(String(latest.status || '').toLowerCase()));
  const evaluationReady = Boolean(telemetry?.summary || latest?.evaluation || latest?.taskEvaluation);
  const deployReady = Boolean(deploymentsForCurrentModel().length);
  const guest = state.authRequired === true;
  const steps = [
    { key: 'simulate', done: replayReady, view: 'simulate', cta: '打开仿真 →', locked: false },
    { key: 'train', done: trainingReady, view: 'train', cta: '去发起训练 →', locked: guest && !contractReady },
    { key: 'evaluate', done: evaluationReady, view: 'evaluate', cta: '查看评测 →', locked: guest },
    { key: 'deploy', done: deployReady, view: 'deploy', cta: '生成预检 →', locked: guest },
  ];
  // 第一个未完成且未锁定的步骤是“当前步”。
  const currentKey = steps.find((step) => !step.done && !step.locked)?.key || null;
  const doneCount = steps.filter((step) => step.done).length;
  let foundCurrent = false;
  list.querySelectorAll('.onboard-item').forEach((item) => {
    const step = steps.find((entry) => entry.key === item.dataset.onboardStep);
    if (!step) return;
    const isCurrent = step.key === currentKey && !foundCurrent;
    if (isCurrent) foundCurrent = true;
    item.classList.toggle('is-complete', step.done);
    item.classList.toggle('is-current', isCurrent);
    item.classList.toggle('is-pending', !step.done && !isCurrent);
    const meta = item.querySelector('[data-onboard-meta]');
    if (meta) {
      meta.replaceChildren();
      if (step.done) {
        const done = document.createElement('span');
        done.className = 'onboard-done';
        done.textContent = '已完成 ✓';
        meta.append(done);
      } else if (step.locked) {
        const locked = document.createElement('span');
        locked.className = 'onboard-locked';
        locked.textContent = '需登录';
        meta.append(locked);
      } else {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'onboard-cta';
        button.textContent = step.cta;
        button.dataset.viewTarget = step.view;
        meta.append(button);
      }
    }
  });
  const fill = $('onboard-fill');
  if (fill) fill.style.width = `${Math.round((doneCount / steps.length) * 100)}%`;
  setText('onboard-count', `${doneCount} / ${steps.length}`);
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
      latest.training?.engine ? '引擎 · ' + latest.training.engine : '',
      latest.metrics?.physicsBackend
        ? '物理 · ' + (PHYSICS_BACKEND_LABELS[latest.metrics.physicsBackend] || latest.metrics.physicsBackend)
        : '',
      latest.training?.profile ? '档位 · ' + latest.training.profile : '',
      latest.training?.numEnvs ? '环境 · ' + latest.training.numEnvs : '',
      latest.checkpoint?.iteration != null ? 'checkpoint · ' + latest.checkpoint.iteration : '',
      latest.createdAt ? '创建 · ' + formatDate(latest.createdAt) : '',
    ].filter(Boolean);
    meta.innerHTML = chips.map((chip) => '<span>' + escapeHtml(chip) + '</span>').join('');
    // The physics chip is the engine's honest self-label; anchor it with the
    // stronger border. Chips share one span shape, so find it by its stable
    // "物理 · " prefix.
    const physicsChip = Array.from(meta.children).find((el) =>
      el.textContent?.startsWith('物理 · '),
    );
    physicsChip?.classList.add('physics-chip');
  }
  $('run-progress-warning')?.toggleAttribute('hidden', latest.mock !== true);
  renderRunProgressTrack(latest);
  renderRunProgressLiveChart(latest);
  renderRunProgressLogsPanel(latest);
}

// Engine log stream: the worker captures stdout/stderr line by line and the
// server proxies them with a cursor (GET /runs/:id/logs?after=N). The panel
// tracks the run shown in the card — switching runs resets the buffer; a
// transport failure keeps the lines already fetched and retries on the next
// poll instead of inventing content.
const RUN_LOG_MAX_RENDERED = 300;

function renderRunProgressLogsPanel(run) {
  const wrap = $('run-progress-logs');
  if (!wrap) return;
  const eligible = run.backend === 'local' && run.mock !== true;
  wrap.hidden = !eligible;
  if (!eligible) {
    state.runLogs.runId = null;
    return;
  }
  if (state.runLogs.runId !== run.id) {
    state.runLogs.runId = run.id;
    state.runLogs.cursor = 0;
    state.runLogs.lines = [];
    state.runLogs.terminalDone = null;
    const body = $('run-progress-logs-body');
    if (body) body.textContent = '';
    const caption = $('run-progress-logs-caption');
    if (caption) caption.textContent = '等待引擎日志…';
  }
  void pollRunLogs(run);
}

async function pollRunLogs(run) {
  if (state.runLogs.runId !== run.id) return;
  if (state.runLogs.inFlight) return;
  // A terminal run's log ring is frozen: one fetch is enough, and repeating
  // it every poll cycle would only re-print the same "unavailable" caption.
  const terminalStatus = ['completed', 'failed', 'blocked'].includes(
    String(run.status || '').toLowerCase(),
  );
  if (terminalStatus && state.runLogs.terminalDone === run.id) return;
  state.runLogs.inFlight = true;
  try {
    const payload = await request(
      '/sim2real/runs/' + encodeURIComponent(run.id) + '/logs?after=' + state.runLogs.cursor,
    );
    if (state.runLogs.runId !== run.id) return;
    if (terminalStatus) state.runLogs.terminalDone = run.id;
    const lines = Array.isArray(payload?.lines) ? payload.lines : [];
    if (payload?.truncated === true) {
      // The cursor fell outside the worker's retention window: resync to the
      // oldest retained line rather than silently skipping the gap.
      const retainedFrom = Number(payload.retainedFrom);
      state.runLogs.cursor = Number.isSafeInteger(retainedFrom) && retainedFrom > 1 ? retainedFrom - 1 : 0;
      state.runLogs.lines = [];
    }
    if (lines.length) {
      const merged = state.runLogs.lines.concat(
        lines
          .filter((line) => line && Number.isFinite(Number(line.n)))
          .map((line) => ({
            n: Number(line.n),
            stream: line.stream === 'stderr' ? 'stderr' : 'stdout',
            text: String(line.text || ''),
          })),
      );
      state.runLogs.lines = merged.slice(-RUN_LOG_MAX_RENDERED);
      const total = Number(payload.total);
      state.runLogs.cursor = Number.isSafeInteger(total)
        ? Math.max(state.runLogs.cursor, total)
        : state.runLogs.cursor + lines.length;
      renderRunLogsBody();
    }
    const caption = $('run-progress-logs-caption');
    if (caption) {
      const total = Number(payload?.total) || state.runLogs.lines.length;
      const status = String(run.status || '').toLowerCase();
      const stateLabel =
        status === 'running'
          ? '运行中'
          : status === 'queued'
            ? '排队中'
            : status === 'completed'
              ? '已完成'
              : status === 'failed'
                ? '已失败'
                : status;
      caption.textContent = `${stateLabel} · 已采集 ${total} 行`;
    }
  } catch (error) {
    // The log panel is a live view, not release evidence: a failed poll keeps
    // the already-fetched lines and lets the next cycle retry quietly. For a
    // terminal run the failure is usually "logs already archived with the
    // finished job", which deserves its own honest caption rather than a
    // generic worker-offline message.
    if (!(error instanceof ApiError && error.status === 401)) {
      const caption = $('run-progress-logs-caption');
      if (caption && state.runLogs.lines.length === 0) {
        caption.textContent = terminalStatus
          ? '该运行已结束；引擎日志仅由 worker 在任务期间保留，结束后不再可回看。'
          : '日志暂不可用（worker 未就绪或连接中断）';
      }
    }
  } finally {
    state.runLogs.inFlight = false;
  }
}

function renderRunLogsBody() {
  const body = $('run-progress-logs-body');
  if (!body) return;
  // textContent (never innerHTML): engine output is arbitrary text and must
  // not be parsed as markup.
  body.textContent = state.runLogs.lines
    .map((line) => {
      const n = String(line.n).padStart(4, ' ');
      const stream = line.stream === 'stderr' ? 'err' : 'out';
      return `[${n}] ${stream} ${line.text}`;
    })
    .join('\n');
  // Keep the tail visible while lines stream in.
  body.scrollTop = body.scrollHeight;
}

// Live training curve: worker-parsed stdout progress points, drawn on the
// same fixed-resolution canvas pattern as the telemetry visuals. Two lines —
// mean reward (left scale) and recent success rate (right scale, 0..1). The
// chart never invents points; an engine that reports nothing shows nothing.
const RUN_PROGRESS_CANVAS_W = 720;
const RUN_PROGRESS_CANVAS_H = 200;

function runProgressPoints(run) {
  if (!Array.isArray(run?.progress)) return [];
  return run.progress.filter(
    (point) =>
      point &&
      Number.isFinite(Number(point.iteration)) &&
      Number.isFinite(Number(point.meanReward)) &&
      Number.isFinite(Number(point.recentSuccess)),
  );
}

function drawRunProgressChart(canvas, points, { title = '' } = {}) {
  const ctx = clearCanvas(canvas, RUN_PROGRESS_CANVAS_W, RUN_PROGRESS_CANVAS_H);
  if (!ctx) return false;
  const width = RUN_PROGRESS_CANVAS_W;
  const height = RUN_PROGRESS_CANVAS_H;
  if (!points.length) {
    drawCanvasPlaceholder(ctx, width, height, '暂无训练曲线数据');
    return false;
  }
  const plotLeft = 46;
  const plotRight = width - 40;
  const plotTop = 16;
  const plotBottom = height - 20;
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - plotTop;
  const lastTotal = points[points.length - 1].totalIterations || points[points.length - 1].iteration;
  const iterationMax = Math.max(lastTotal, points[points.length - 1].iteration);
  const rewards = points.map((point) => point.meanReward);
  let rewardMin = Math.min(0, ...rewards);
  let rewardMax = Math.max(0, ...rewards);
  if (rewardMin === rewardMax) rewardMax = rewardMin + 1;
  const rewardPad = (rewardMax - rewardMin) * 0.08;
  rewardMin -= rewardPad;
  rewardMax += rewardPad;
  const xOf = (iteration) => plotLeft + (iteration / (iterationMax || 1)) * plotWidth;
  const yReward = (reward) => plotBottom - ((reward - rewardMin) / (rewardMax - rewardMin)) * plotHeight;
  const ySuccess = (rate) => plotTop + (1 - Math.max(0, Math.min(1, rate))) * plotHeight;
  ctx.font = CANVAS_TEXT_STYLE;
  ctx.strokeStyle = 'rgba(28, 28, 26, 0.12)';
  ctx.lineWidth = 1;
  // Grid: reward ticks on the left, success ticks (0/50/100%) on the right.
  ctx.fillStyle = CANVAS_TEXT_COLOR;
  ctx.textAlign = 'right';
  for (const reward of [rewardMax, (rewardMax + rewardMin) / 2, rewardMin]) {
    const y = Math.round(yReward(reward)) + 0.5;
    if (y <= plotTop || y >= plotBottom) continue;
    ctx.beginPath();
    ctx.moveTo(plotLeft, y);
    ctx.lineTo(plotRight, y);
    ctx.stroke();
    ctx.fillText(reward.toFixed(2), plotLeft - 4, y + 3);
  }
  ctx.textAlign = 'left';
  for (const [rate, label] of [[0, '0%'], [0.5, '50%'], [1, '100%']]) {
    const y = Math.round(ySuccess(rate)) + 0.5;
    ctx.fillText(label, plotRight + 4, y + 3);
  }
  ctx.textAlign = 'right';
  ctx.fillText('iter 0', plotLeft, plotBottom + 12);
  ctx.fillText(String(iterationMax), plotRight, plotBottom + 12);
  ctx.textAlign = 'left';
  if (title) {
    ctx.fillStyle = CANVAS_TEXT_COLOR;
    ctx.fillText(title, plotLeft, plotTop - 4);
  }
  // Success rate line first (secondary), then reward on top (primary).
  ctx.strokeStyle = 'rgba(96, 165, 250, 0.9)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  points.forEach((point, index) => {
    const x = xOf(point.iteration);
    const y = ySuccess(point.recentSuccess);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.strokeStyle = 'rgba(85, 221, 176, 0.95)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((point, index) => {
    const x = xOf(point.iteration);
    const y = yReward(point.meanReward);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  return true;
}

function renderRunProgressLiveChart(run) {
  const wrap = $('run-progress-live-chart');
  const canvas = $('run-progress-live-canvas');
  if (!wrap || !canvas) return;
  const points = runProgressPoints(run);
  const active = run.status === 'queued' || run.status === 'running';
  // Show while training (even with no points yet — "waiting for first point"
  // is honest state), and keep visible after completion when points exist.
  const show = (active && run.mock !== true) || points.length > 0;
  wrap.hidden = !show;
  if (!show) return;
  const caption = $('run-progress-live-caption');
  if (caption) {
    if (!points.length) {
      caption.textContent = '等待引擎回报首个数据点…';
    } else {
      const last = points[points.length - 1];
      const total = last.totalIterations || last.iteration;
      caption.textContent = `iter ${last.iteration}/${total} · 奖励 ${formatMetricNumber(last.meanReward, 3)} · 成功率 ${metricPercent(last.recentSuccess)}%`;
    }
  }
  drawRunProgressChart(canvas, points);
}

// Honest progress for long trainings: the server exposes no completion
// fraction, so the bar is driven by checkpoint iteration against the run's
// target. Without a target it degrades to an indeterminate "in flight" bar —
// never a fabricated percentage.
function renderRunProgressTrack(run) {
  const track = $('run-progress-track');
  const fill = $('run-progress-fill');
  const note = $('run-progress-track-note');
  if (!track || !fill) return;
  const active = run.status === 'queued' || run.status === 'running';
  if (!active || run.mock === true) {
    track.hidden = true;
    track.removeAttribute('aria-valuenow');
    return;
  }
  track.hidden = false;
  track.classList.toggle('is-indeterminate', !run.training?.targetIterations);
  const done = Number(run.checkpoint?.iteration) || 0;
  const target = Number(run.training?.targetIterations) || 0;
  if (target > 0) {
    const percent = Math.max(0, Math.min(100, Math.round((done / target) * 100)));
    fill.style.width = percent + '%';
    track.setAttribute('aria-valuenow', String(percent));
    if (note) note.textContent = `checkpoint ${done} / ${target} 轮`;
  } else {
    fill.style.width = '';
    track.removeAttribute('aria-valuenow');
    if (note) {
      const elapsed = run.createdAt ? Math.round((Date.now() - new Date(run.createdAt).getTime()) / 60000) : 0;
      note.textContent =
        done > 0
          ? `运行中 · 已到 checkpoint ${done} 轮${elapsed > 0 ? ` · 约 ${elapsed} 分钟` : ''}`
          : run.status === 'queued'
            ? '排队中 · 等待 runner 认领'
            : '运行中 · 尚无 checkpoint 回报';
    }
  }
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
        Object.assign({}, artifact, (() => {
          const presentation = artifactPresentation(artifact);
          return {
            ...presentation,
            id: model.id + ':' + artifact.id,
            modelId: model.id,
            kind: 'artifact · ' + (artifact.role || artifact.format || 'model'),
            recordType: 'artifact',
            status: presentation.key,
            summary: artifact.name || artifact.id,
            createdAt: model.updatedAt || model.createdAt,
          };
        })()),
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
          modelId: evidence.modelId,
          projectId: evidence.projectId,
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
            modelId: latest.modelId,
            projectId: latest.projectId,
            createdAt: latest.createdAt,
            telemetrySummary: persistedReplay,
          },
        ]
      : [];
  return [...runs, ...deployments, ...artifacts, ...telemetry].sort((a, b) =>
    String(b.createdAt || '').localeCompare(String(a.createdAt || '')),
  );
}

/* ------------------------------------------------------------------------- *
 * Sim2Real Agent 助手
 *
 * This is intentionally a presentation layer rather than a second workflow.
 * Suggestions are derived from the same account-scoped overview used by the
 * rest of the page, and the only network action exposed here is a read-only
 * BoardAgent health probe. Keeping the surface data-driven makes it easy to
 * add new skills later without coupling them to navigation or run submission.
 * ------------------------------------------------------------------------- */
const AGENT_COLLAPSED_KEY = 'rdk-duck-lab-agent-collapsed';

function ensureAgentPanelStyles() {
  if ($('agent-assistant-styles')) return;
  const style = document.createElement('style');
  style.id = 'agent-assistant-styles';
  style.textContent = `
    .agent-assistant { margin-top: 16px; padding: 18px 20px; border-color: color-mix(in srgb, var(--cyan, #56d4ff) 28%, var(--line, #27354a)); background: linear-gradient(135deg, color-mix(in srgb, var(--panel, #121b2c) 94%, var(--cyan, #56d4ff)), var(--panel, #121b2c)); }
    .agent-assistant-header, .agent-assistant-title-wrap, .agent-assistant-foot { display: flex; align-items: center; }
    .agent-assistant-header { justify-content: space-between; gap: 12px; }
    .agent-assistant-title-wrap { gap: 10px; min-width: 0; }
    .agent-assistant-title-wrap h2 { margin: 2px 0 0; font-size: 17px; }
    .agent-assistant-mark { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 9px; background: rgba(86,212,255,.13); color: var(--cyan, #56d4ff); font-size: 17px; }
    .agent-assistant-mode { margin-left: 4px; padding: 3px 7px; border: 1px solid var(--green-border); border-radius: 999px; color: var(--green-text); background: var(--green-soft); font-size: 12px; white-space: nowrap; }
    .agent-assistant-body { margin-top: 14px; }
    .agent-assistant[data-collapsed="true"] .agent-assistant-body { display: none; }
    .agent-assistant-lead strong { display: block; font-size: 15px; }
    .agent-assistant-lead p { max-width: 760px; margin: 5px 0 0; color: var(--muted, #91a4bd); font-size: 13px; line-height: 1.55; }
    .agent-assistant-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
    .agent-assistant-action { display: inline-flex; align-items: center; min-height: 32px; padding: 7px 11px; border: 1px solid rgba(86,212,255,.28); border-radius: 7px; background: rgba(86,212,255,.06); color: var(--text, #eef5ff); cursor: pointer; font: inherit; font-size: 12px; text-decoration: none; transition: border-color .16s ease, background .16s ease, transform .16s ease; }
    .agent-assistant-action:hover { border-color: var(--cyan, #56d4ff); background: rgba(86,212,255,.13); transform: translateY(-1px); }
    .agent-assistant-foot { justify-content: space-between; gap: 10px; margin-top: 15px; padding-top: 11px; border-top: 1px solid color-mix(in srgb, var(--line, #27354a) 80%, transparent); }
    .agent-assistant-health { color: var(--muted, #91a4bd); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .agent-assistant-health[data-state="ready"] { color: var(--green, #74e6b0); }
    .agent-assistant-health[data-state="error"] { color: var(--red, #ff9098); }
    @media (max-width: 600px) { .agent-assistant { padding: 15px; } .agent-assistant-mode { display: none; } .agent-assistant-foot { align-items: flex-start; } }
  `;
  document.head.append(style);
}

function ensureAgentPanel() {
  const overview = document.querySelector('[data-view-section="overview"]');
  if (!overview) return null;
  ensureAgentPanelStyles();
  let panel = $('agent-assistant');
  if (panel) return panel;
  panel = document.createElement('section');
  panel.id = 'agent-assistant';
  panel.className = 'agent-assistant panel';
  panel.setAttribute('aria-labelledby', 'agent-assistant-title');
  panel.innerHTML = `
    <div class="agent-assistant-header">
      <div class="agent-assistant-title-wrap">
        <span class="agent-assistant-mark" aria-hidden="true">✦</span>
        <div>
          <div class="panel-kicker">SIM2REAL AGENT</div>
          <h2 id="agent-assistant-title">下一步助手</h2>
        </div>
        <span class="agent-assistant-mode">只读建议</span>
      </div>
      <button class="button button-ghost button-small agent-assistant-toggle" id="agent-assistant-toggle" type="button" aria-expanded="true">收起</button>
    </div>
    <div class="agent-assistant-body" id="agent-assistant-body">
      <div class="agent-assistant-lead">
        <strong id="agent-assistant-headline">正在读取工作区…</strong>
        <p id="agent-assistant-summary">助手会根据当前模型、运行和板卡状态给出下一步建议。</p>
      </div>
      <div class="agent-assistant-actions" id="agent-assistant-actions" role="list" aria-label="助手快捷操作"></div>
      <div class="agent-assistant-foot">
        <span class="agent-assistant-health" id="agent-assistant-health" role="status" aria-live="polite">板端状态未检查</span>
        <button class="button button-ghost button-small" id="agent-assistant-check" type="button">检查板端</button>
      </div>
    </div>`;
  const workspace = overview.querySelector('#project-workspace');
  (workspace || overview.querySelector('.next-card'))?.after(panel);
  if (!state.agent.collapsed) {
    try {
      state.agent.collapsed = window.localStorage?.getItem(AGENT_COLLAPSED_KEY) === '1';
    } catch {
      state.agent.collapsed = false;
    }
  }
  panel.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-agent-view]') : null;
    if (target) {
      event.preventDefault();
      setView(target.dataset.agentView);
      return;
    }
    const action = event.target instanceof Element ? event.target.closest('[data-agent-action]') : null;
    if (action?.dataset.agentAction === 'refresh') {
      void loadOverview();
    }
  });
  $('agent-assistant-toggle')?.addEventListener('click', () => {
    state.agent.collapsed = !state.agent.collapsed;
    try {
      window.localStorage?.setItem(AGENT_COLLAPSED_KEY, state.agent.collapsed ? '1' : '0');
    } catch {
      // A private browsing context may not expose localStorage.
    }
    renderAgentPanel();
  });
  $('agent-assistant-check')?.addEventListener('click', () => {
    void agentCheckBoard();
  });
  return panel;
}

function agentSuggestionSet() {
  if (state.authRequired || !state.overview) {
    return {
      headline: '登录后开始你的 Sim2Real 迭代',
      summary: '助手会在工作区加载后，把模型、训练、评测和板卡状态串起来。',
      actions: [{ label: '登录工作区', view: null, href: state.publicHealth?.ssoLoginUrl || '/rdkstudio/' }],
    };
  }
  const model = selectedModel();
  const device = selectedDevice();
  const latest = latestRun();
  const evidence = currentTelemetry();
  const computeResources = state.overview?.computeResources || [];
  const hasOnlineComputeResource = computeResources.some((resource) => resource.status === 'online');
  if (!model) {
    return {
      headline: '先登记模型契约，再开始训练',
      summary: '把观测、动作、运行时和制品引用放进一个可追溯 manifest。',
      actions: [{ label: '去登记模型契约', view: 'train' }, { label: '查看训练入口', view: 'train' }],
    };
  }
  if (!computeResources.length && state.overview?.integrations?.simulator?.local?.available !== true) {
    return {
      headline: '先接入一台自己的 GPU',
      summary: '把 GPU Worker 地址和 Token 填入训练页，连接测试通过后，Agent 就能代你提交 smoke 训练并跟踪结果。',
      actions: [{ label: '接入 GPU 资源', view: 'train' }, { label: '查看 GPU 接入说明', view: 'train' }],
    };
  }
  if (computeResources.length && !hasOnlineComputeResource) {
    return {
      headline: '先测试 GPU Worker 连接',
      summary: '当前 GPU 资源还没有在线状态；测试通过后再发起训练，避免任务进入不可达队列。',
      actions: [{ label: '管理 GPU 资源', view: 'train' }, { label: '回到总览', view: 'overview' }],
    };
  }
  if (latest && isActiveRunStatus(latest.status)) {
    return {
      headline: '训练正在进行，先查看运行状态',
      summary: `${modelLabel(model)} · ${statusLabel(latest.status)}。完成后再进入评测，避免重复提交。`,
      actions: [{ label: '查看训练任务', view: 'train' }, { label: '打开运行记录', view: 'records' }],
    };
  }
  if (latest?.status === 'failed') {
    return {
      headline: '上一次训练需要处理',
      summary: latest.summary || '查看失败详情，修复契约或运行后端后再重试。',
      actions: [{ label: '查看失败详情', view: 'train' }, { label: '检查模型契约', view: 'train' }],
    };
  }
  if (!evidence && latest && ['completed', 'ready'].includes(String(latest.status))) {
    return {
      headline: '训练完成，下一步是评测证据',
      summary: '先确认成功率、跌倒率和控制延迟，再生成目标板卡的只读预检计划。',
      actions: [{ label: '进入评测中心', view: 'evaluate' }, { label: '查看训练结果', view: 'records' }],
    };
  }
  if (evidence && !hasReleaseGradeEvidence(evidence, latest)) {
    return {
      headline: '已有遥测，补齐真实评测来源',
      summary: '当前证据还不能推进发布；检查采样率和来源后再绑定正式运行。',
      actions: [{ label: '查看评测证据', view: 'evaluate' }, { label: '查看安全闸门', view: 'deploy' }],
    };
  }
  if (!device) {
    return {
      headline: '选择一块目标板卡，准备只读预检',
      summary: '发布前会检查设备连接、运行时和模型制品；网页不会直接开启电机。',
      actions: [{ label: '进入部署预检', view: 'deploy' }, { label: '打开上位机', view: 'station' }],
    };
  }
  return {
    headline: '可以开始下一轮 Sim2Real 验证',
    summary: `${modelLabel(model)} → ${device.name || device.id}。先做只读预检，再决定是否进入受控 Canary。`,
    actions: [{ label: '查看部署闸门', view: 'deploy' }, { label: '打开上位机', view: 'station' }, { label: '查看完整记录', view: 'records' }],
  };
}

function renderAgentPanel() {
  const panel = ensureAgentPanel();
  if (!panel) return;
  panel.dataset.collapsed = state.agent.collapsed ? 'true' : 'false';
  const toggle = $('agent-assistant-toggle');
  if (toggle) {
    toggle.textContent = state.agent.collapsed ? '展开' : '收起';
    toggle.setAttribute('aria-expanded', state.agent.collapsed ? 'false' : 'true');
  }
  const suggestion = agentSuggestionSet();
  setText('agent-assistant-headline', suggestion.headline);
  setText('agent-assistant-summary', suggestion.summary);
  const actions = $('agent-assistant-actions');
  if (actions) {
    actions.replaceChildren();
    for (const item of suggestion.actions) {
      const control = item.href ? document.createElement('a') : document.createElement('button');
      control.className = 'agent-assistant-action';
      control.textContent = item.label + '  →';
      if (item.href) {
        control.href = item.href;
        control.target = '_blank';
        control.rel = 'noreferrer';
      } else {
        control.type = 'button';
        control.dataset.agentView = item.view || 'overview';
      }
      actions.append(control);
    }
  }
  const health = $('agent-assistant-health');
  const boardHealth = state.agent.boardHealth;
  if (health) {
    if (state.agent.checkingBoard) {
      health.textContent = '正在检查板端…';
      health.dataset.state = 'loading';
    } else if (boardHealth?.ok) {
      const name = boardHealth.device?.name || selectedDevice()?.name || '目标板卡';
      health.textContent = `${name} · 板端在线`;
      health.dataset.state = 'ready';
    } else if (boardHealth?.error) {
      health.textContent = `板端暂不可用 · ${boardHealth.error}`;
      health.dataset.state = 'error';
    } else {
      health.textContent = '板端状态未检查';
      health.dataset.state = 'idle';
    }
  }
  const check = $('agent-assistant-check');
  if (check) check.disabled = state.agent.checkingBoard;
}

async function agentCheckBoard() {
  if (state.agent.checkingBoard) return;
  state.agent.checkingBoard = true;
  renderAgentPanel();
  try {
    const payload = await request('/sim2real/board-station/health');
    state.agent.boardHealth = Object.assign({ ok: true }, payload || {});
    showToast('板端健康检查完成。', 'success');
  } catch (error) {
    const message = error instanceof Error ? error.message : '板端暂不可用';
    state.agent.boardHealth = { ok: false, error: message.slice(0, 80) };
    if (!(error instanceof ApiError && error.status === 401)) {
      showRecoverableError('板端健康检查失败', message, '重新检查', agentCheckBoard);
    }
  } finally {
    state.agent.checkingBoard = false;
    renderAgentPanel();
  }
}

function renderAll() {
  renderSelects();
  renderComputeResources();
  renderIntegrations();
  renderContextLive();
  renderModel();
  renderActionLibrary();
  renderBoard();
  renderEvaluation();
  renderReplayPlayer();
  renderHistory();
  renderRunProgress();
  renderNextAction();
  renderEvaluationNext();
  renderReleaseGate();
  renderWorkflowProgress();
  renderOnboardChecklist();
  renderProjectWorkspace();
  renderPlatformScorecard();
  renderAgentPanel();
  renderPromotionFlow();
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
  const now = Date.now();
  for (const [deadRunId, deadUntil] of runStatusDeadUntil) {
    if (deadUntil <= now) {
      // 熔断窗口到期：允许再次探测，runner 可能已经恢复。
      runStatusDeadUntil.delete(deadRunId);
      runStatusFailures.delete(deadRunId);
    }
  }
  const active = runsForCurrentModel().filter((run) =>
    ['queued', 'running'].includes(String(run.status || '').toLowerCase()),
  ).filter((run) => !runStatusDeadUntil.has(run.id));
  if (!active.length) return;
  const updates = await Promise.all(
    active.slice(0, 8).map(async (run) => {
      try {
        const payload = await request('/sim2real/runs/' + encodeURIComponent(run.id));
        runStatusFailures.delete(run.id);
        runStatusDeadUntil.delete(run.id);
        runStatusDeadNotified.delete(run.id);
        return payload.run || null;      } catch (error) {
        // The API keeps the last known state and returns a retryable 503 when
        // the external runner is unavailable. Back off after repeated errors
        // so a dead runner cannot create a tight polling loop. After the
        // third failure the run itself is circuit-broken for five minutes —
        // a zombie run stuck in "running" for days must not emit a 503 and a
        // toast every 30 seconds forever.
        if (!(error instanceof ApiError && error.status === 401)) {
          const failures = (runStatusFailures.get(run.id) || 0) + 1;
          runStatusFailures.set(run.id, failures);
          if (failures >= 3) {
            // 连续三次失败：按 run 熔断 5 分钟，通知只弹一次。
            runStatusDeadUntil.set(run.id, Date.now() + RUN_STATUS_DEAD_RETRY_MS);
            runStatusFailures.delete(run.id);
            if (!runStatusDeadNotified.has(run.id)) {
              runStatusDeadNotified.add(run.id);
              showToast('训练 runner 暂时无法返回状态，该任务已暂停轮询并保留最后已知状态；任务未被伪造为完成', 'error');
            }
          } else {
            // 瞬态失败（1-2 次）：保留原有的全局降频。
            runStatusBackoffUntil = Math.max(runStatusBackoffUntil, Date.now() + 30_000);
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
      // Completed runs auto-mount their evaluation evidence: the server
      // attaches the engine's hard-envelope telemetry on the completion
      // transition, so the next poll's replay fetch has frames. Load it
      // without stealing focus so the operator sees the finished policy's
      // behavior immediately instead of hunting for the run in the select.
      if (String(next.status).toLowerCase() === 'completed') {
        void autoLoadRunReplay(next.id);
      }
    }
  }
}

async function loadOverview({ quiet = false, silent = false } = {}) {
  // A foreground load and a background poll must never overlap; whichever
  // got there first wins (this also keeps the poll's own chain serialized).
  if (state.loading) return;
  setLoading(!silent);
  if (!state.overview) {
    setWorkspaceStatus('loading', '正在连接工作区', '正在读取项目、模型和设备状态…');
  }
  try {
    const payload = await request(
      '/sim2real/overview?productId=' + encodeURIComponent(state.productId),
    );
    state.overview = payload;
    state.selectedComputeResourceId = state.selectedComputeResourceId || '';
    // The summary is intentionally lightweight and remains useful to future
    // dashboard surfaces. It is allowed to fail independently from the main
    // overview so the primary workflow still works on older gateways.
    // Silent polls (background refresh while a run is active) skip the three
    // slow-changing aux lists: they only churn requests and re-render churn,
    // while the operator's live interest is the run status itself.
    const [summaryResult, projectsResult, datasetsResult, goldenPathResult] = silent
      ? [{ status: 'fulfilled', value: undefined }, { status: 'fulfilled', value: undefined }, { status: 'fulfilled', value: undefined }, { status: 'fulfilled', value: undefined }]
      : await Promise.allSettled([
          request('/sim2real/workspace-summary'),
          request('/sim2real/projects'),
          request('/sim2real/datasets'),
          request('/sim2real/golden-path?' + new URLSearchParams({
            ...(state.projectId ? { projectId: state.projectId } : {}),
            ...(state.selectedModelId ? { modelId: state.selectedModelId } : {}),
            ...(state.taskId ? { taskId: state.taskId } : {}),
          }).toString()),
        ]);
    state.workspaceSummary = summaryResult.status === 'fulfilled' ? summaryResult.value : state.workspaceSummary;
    const projectsAvailable = projectsResult.status === 'fulfilled' && Array.isArray(projectsResult.value?.projects);
    const datasetsAvailable = datasetsResult.status === 'fulfilled' && Array.isArray(datasetsResult.value?.datasets);
    if (projectsAvailable) state.projects = projectsResult.value.projects;
    if (datasetsAvailable) state.datasets = datasetsResult.value.datasets;
    if (goldenPathResult.status === 'fulfilled' && goldenPathResult.value?.goldenPath) {
      state.goldenPath = goldenPathResult.value.goldenPath;
    }
    state.projectsLoaded = projectsAvailable || state.projectsLoaded;
    state.projectsLoadError = !projectsAvailable;
    state.datasetsLoaded = datasetsAvailable || state.datasetsLoaded;
    if (projectsAvailable && state.projectId && !state.projects.some((project) => String(project.id) === String(state.projectId))) {
      state.projectId = '';
      saveWorkspaceContext();
    }
    state.serviceError = false;
    state.productProfiles = Array.isArray(payload.productProfiles) ? payload.productProfiles : null;
    // Notices piggyback on the overview cycle (cooldown-guarded) so a server
    // restart mid-session surfaces the version change without a manual reload.
    void loadWorkspaceNotices();
    clearAuthGate();
    await refreshActiveRuns();
    renderAll();
    // Model details rarely change while a run is in flight; re-fetching them
    // every silent poll doubles request volume for zero operator value.
    if (!silent) await loadModelDetails();
    setText('hero-updated', '更新于 ' + formatDate(new Date().toISOString()));
    if (summaryResult.status === 'rejected' || projectsResult.status === 'rejected' || datasetsResult.status === 'rejected') {
      const failed = [summaryResult, projectsResult, datasetsResult].filter((result) => result.status === 'rejected').length;
      setWorkspaceStatus('warning', '工作区已连接，但部分数据暂不可用', `${failed} 个辅助数据源未响应；核心模型和运行状态仍可使用。下一步：点击“重新连接”再次检查。`, { retry: true });
    } else {
      clearWorkspaceStatus();
    }
  } catch (error) {
    state.serviceError = !(error instanceof ApiError && error.status === 401);
    setText(
      'service-status',
      error instanceof ApiError && error.status === 401 ? '游客模式' : '服务不可用',
    );
    syncServicePill();
    renderEvaluationNext();
    if (error instanceof ApiError && error.status === 401) {
      clearWorkspaceStatus();
    } else {
      const detail = friendlyError(error, '无法读取工作区状态').replace(/[。.!！?？\s]+$/u, '');
      setWorkspaceStatus('error', '工作区连接失败', `${detail}。下一步：检查服务是否运行，然后点击“重新连接”。`, { retry: true });
    }
  } finally {
    if (silent) {
      // Silent polls never touched the loading chrome (setLoading(false) is
      // safe to skip), but still reconcile the CTA states in case the poll
      // changed run/device availability.
      renderProjectContext();
      renderIntegrations();
    } else {
      setLoading(false);
      // The first render happens while the overview request is in flight, so
      // context actions are intentionally disabled there. Reconcile the
      // controls after loading ends; otherwise a successful request leaves the
      // project creator and run actions visually enabled but functionally inert.
      renderProjectContext();
      renderIntegrations();
    }
    scheduleOverviewPolling();
  }
}

// The poll chain schedules itself after each tick (loadOverview's finally).
// This entry point just restarts the chain — e.g. after the tab returns or a
// foreground refresh finished — at the current cadence.
function scheduleOverviewPolling() {
  overviewPoll.rearm();
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
    updateTrainProgress(2);
    const warnings = payload.validation.warnings?.length
      ? '；' + payload.validation.warnings.length + ' 个提示'
      : '';
    result.textContent = '契约校验通过' + warnings + '。可登记元数据。';
  } else {
    const first = payload.validation?.errors?.[0] || '清单不合法';
    result.textContent = '校验未通过：' + first;
  }
}

function updateTrainProgress(step) {
  document.querySelectorAll('.train-onboarding-step').forEach((node, index) => {
    node.classList.toggle('is-current', index === step - 1);
    node.classList.toggle('is-complete', index < step - 1);
  });
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
      result.textContent = friendlyError(error, '校验失败');
    }
    if (!(error instanceof ApiError && error.status === 401))
      showToast(friendlyError(error, '校验失败'), 'error');
  }
}

async function registerEditor() {
  try {
    const manifest = readEditorManifest();
    const payload = await request('/sim2real/models', {
      method: 'POST',
      body: JSON.stringify({ manifest }),
    });
    let projectBindingFailed = false;
    if (payload.model?.id && selectedProject()) {
      try {
        await attachModelToSelectedProject(payload.model.id);
      } catch {
        projectBindingFailed = true;
        state.projectId = '';
        saveWorkspaceContext();
      }
    }
    showToast(
      projectBindingFailed
        ? '模型已登记，但当前项目绑定失败；已切换到全部项目，请稍后重试绑定。'
        : '模型版本已登记' + (state.projectId ? '，已绑定当前项目' : ''),
      projectBindingFailed ? 'error' : 'success',
    );
    $('manifest-editor').value = JSON.stringify(payload.model?.manifest || manifest, null, 2);
    updateTrainProgress(2);
    const result = $('validation-result');
    if (result) { result.className = 'validation-result is-ok'; result.textContent = '模型版本已登记，可以直接配置并提交强化学习训练；回放为可选。'; }
    await loadOverview({ quiet: true });
  } catch (error) {
    const message = friendlyError(error, '模型登记失败');
    const result = $('validation-result');
    if (result) { result.className = 'validation-result is-error'; result.textContent = message; }
    if (!(error instanceof ApiError && error.status === 401)) showToast(message, 'error');
  }
}

// Product-styled replacement for window.confirm(): one dialog skin for every
// consequential action (motion, board switches, resource deletion, cloud
// training). Focus is trapped natively by <dialog>, Escape cancels, and the
// promise always settles. `details` renders the shared label/value grid for
// decisions that benefit from a structured summary (e.g. cloud training).
function confirmAction({ title, note, approveLabel = '确认执行', details = null } = {}) {
  const dialog = $('confirm-action-dialog');
  if (!(dialog instanceof HTMLDialogElement)) return Promise.resolve(window.confirm(note || title || ''));
  if (state.confirmActionResolve) state.confirmActionResolve(false);
  state.confirmActionResolve = null;
  setText('confirm-action-title', title || '确认操作');
  const noteNode = $('confirm-action-note');
  if (noteNode) noteNode.textContent = String(note || '');
  const grid = $('confirm-action-details');
  if (grid) {
    const entries = Array.isArray(details) ? details.filter((item) => item && item.label) : [];
    grid.replaceChildren(
      ...entries.map((item) => {
        const field = document.createElement('div');
        field.className = 'run-detail-field';
        const label = document.createElement('span');
        label.textContent = String(item.label);
        const value = document.createElement('strong');
        value.textContent = String(item.value ?? '—');
        field.append(label, value);
        return field;
      }),
    );
    grid.hidden = entries.length === 0;
  }
  setText('confirm-action-approve', approveLabel);
  return new Promise((resolve) => {
    state.confirmActionResolve = resolve;
    dialog.showModal();
  });
}

function settleConfirmAction(approved) {
  // Grab and clear the pending resolver BEFORE dialog.close(): the close
  // event can fire synchronously (JSDOM), and its listener must not see a
  // still-pending promise and settle it a second time with a different value.
  const resolve = state.confirmActionResolve;
  state.confirmActionResolve = null;
  const dialog = $('confirm-action-dialog');
  if (dialog instanceof HTMLDialogElement && dialog.open) dialog.close();
  if (resolve) resolve(approved);
}

// Studio-style explicit confirmation before a billable action: the caller
// gets the operator's decision, and the dialog never submits by itself.
function confirmRobogoRun() {
  const model = selectedModel();
  const task = selectedTask();
  const profileValue = $('training-profile')?.value || 'standard';
  const profileLabel =
    $('training-profile')?.querySelector('option[value="' + profileValue + '"]')?.textContent ||
    profileValue;
  const checkpointId = $('resume-checkpoint-id')?.value.trim() || '';
  const artifactRef = $('resume-artifact-ref')?.value.trim() || '';
  return confirmAction({
    title: '确认提交云端训练',
    note: '该请求会消耗 RoboGo 云端算力并占用一个任务名额；提交后由服务端校验当前账号授权，未授权时会明确标记为 blocked。',
    approveLabel: '确认提交',
    details: [
      { label: '模型', value: model ? modelLabel(model) : '未选择模型' },
      { label: '动作任务', value: task.label || '—' },
      { label: '训练档位', value: profileLabel || '—' },
      { label: '算法', value: $('training-algorithm')?.value?.toUpperCase() || 'PPO' },
      {
        label: '训练引擎',
        value:
          $('training-engine')?.selectedOptions?.[0]?.textContent?.trim() || 'worker 默认引擎',
      },
      { label: '续训', value: checkpointId && artifactRef ? checkpointId : '不续训' },
    ],
  });
}

async function relayTrainingRun(run, model, requestBody) {
  const agentUrl = String(run.relayAgentUrl || '').replace(/\/+$/, '');
  const manifest = model?.manifest;
  if (!agentUrl || !manifest) throw new Error('缺少本地 Agent 或模型契约，无法中继训练');
  const accountId = state.overview?.identity?.accountId || 'local-dev';
  const relayPayload = {
    accountId,
    schemaVersion: manifest.schemaVersion,
    contractId: manifest.contract.id,
    model: { modelId: manifest.modelId, displayName: manifest.displayName, version: manifest.version },
    robot: manifest.robot,
    contract: manifest.contract,
    simulator: manifest.simulator,
    artifacts: manifest.artifacts,
    ...(requestBody.taskId ? { taskId: requestBody.taskId } : {}),
    ...(requestBody.training ? { training: requestBody.training } : {}),
    ...(requestBody.resumeFrom ? { resumeFrom: requestBody.resumeFrom } : {}),
    idempotencyKey: requestBody.idempotencyKey,
  };
  const submitted = await fetch(agentUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sim2real-account': accountId, 'idempotency-key': requestBody.idempotencyKey },
    body: JSON.stringify(relayPayload),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await submitted.json().catch(() => ({}));
  if (!submitted.ok || !result.runId) throw new Error(result.message || result.error || '本机 Agent 未接受训练任务');
  await request(`/sim2real/runs/${encodeURIComponent(run.id)}/relay/claim`, { method: 'POST', body: JSON.stringify({ externalRunId: result.runId }) });
  const poll = async () => {
    try {
      const statusResponse = await fetch(`${agentUrl}/runs/${encodeURIComponent(result.runId)}`, { headers: { 'x-sim2real-account': accountId }, signal: AbortSignal.timeout(10_000) });
      const status = await statusResponse.json().catch(() => ({}));
      if (!statusResponse.ok) throw new Error(status.message || status.error || 'Agent 状态不可用');
      await request(`/sim2real/runs/${encodeURIComponent(run.id)}/relay/sync`, { method: 'POST', body: JSON.stringify(status) });
      if (status.status === 'completed' && status.artifact?.sha256) {
        const artifactResponse = await fetch(`${agentUrl}/runs/${encodeURIComponent(result.runId)}/artifact`, { headers: { 'x-sim2real-account': accountId }, signal: AbortSignal.timeout(60_000) });
        if (!artifactResponse.ok) throw new Error('训练完成但制品下载失败');
        const bytes = new Uint8Array(await artifactResponse.arrayBuffer());
        await fetch(apiPath(`/sim2real/runs/${encodeURIComponent(run.id)}/relay/artifact`), { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-artifact-sha256': status.artifact.sha256 }, body: bytes, credentials: 'same-origin' }).then(async (response) => { if (!response.ok) throw new Error('制品回传平台失败'); });
      }
      if (!['completed', 'failed'].includes(String(status.status))) window.setTimeout(poll, 5000);
      else await loadOverview({ quiet: true });
    } catch (error) {
      setText('simulator-run-status', error instanceof Error ? `本机 Agent 中继失败：${error.message}` : '本机 Agent 中继失败');
    }
  };
  void poll();
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
    const body = {
      modelId: model.id,
      backend,
      taskId: state.taskId,
      idempotencyKey: requestKey,
      ...(state.projectId ? { projectId: state.projectId } : {}),
    };
    if (backend === 'local') {
      // AI 模式会优先使用已测试在线且并发有余量的 GPU；没有可用资源时回退到服务端默认 Worker。
      if (state.selectedComputeResourceId) {
        body.computeResourceId = state.selectedComputeResourceId;
      } else {
        const resources = state.overview?.computeResources || [];
        const online = resources.find((resource) => resource.status === 'online' && (resource.activeJobs == null || resource.activeJobs < (resource.maxConcurrentJobs || 1)));
        if (online) body.computeResourceId = online.id;
      }
    }
    const profile = $('training-profile')?.value;
    const algorithm = $('training-algorithm')?.value;
    const engine = $('training-engine')?.value;
    if ((backend === 'robogo' || backend === 'local') && profile) {
      body.training = { profile, ...(algorithm ? { algorithm } : {}), ...(engine ? { engine } : {}) };
    }
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
    if (backend === 'local' && run.relayAgentUrl) {
      void relayTrainingRun(run, model, body).catch((error) => {
        setText('simulator-run-status', error instanceof Error ? `本机 Agent 训练提交失败：${error.message}` : '本机 Agent 训练提交失败');
      });
    }
    if (backend === 'browser' && ['completed', 'ready', 'queued', 'running'].includes(String(run.status || ''))) {
      updateTrainProgress(3);
    }
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
  if (profile.id === 'originbot') {
    const template = {
      schemaVersion: 1,
      modelId: 'my-originbot-policy', displayName: '我的 OriginBot 目标导航策略', version: '0.1.0',
      robot: { id: 'originbot', variant: 'differential-drive' },
      contract: { id: 'originbot-policy-v1', robotId: 'originbot', jointCount: 12, observationSize: 8, actionSize: 2, controlHz: 10, physicsTimestepSeconds: 0.1, decimation: 1,
        observationLayout: [{ name: 'x', size: 1 }, { name: 'y', size: 1 }, { name: 'sin_yaw', size: 1 }, { name: 'cos_yaw', size: 1 }, { name: 'goal_dx', size: 1 }, { name: 'goal_dy', size: 1 }, { name: 'linear_velocity', size: 1 }, { name: 'angular_velocity', size: 1 }] },
      simulator: { backends: ['browser', 'local'], policyArtifactId: 'policy-onnx', policyBundle: { defaultPolicyId: 'goal-navigation', policies: [{ id: 'goal-navigation', label: '目标导航', artifactId: 'policy-onnx' }] }, entryUrl: '/originbot-sim/' },
      artifacts: [{ id: 'policy-onnx', role: 'policy', name: 'originbot-policy.onnx', kind: 'source', format: 'onnx', runtime: 'cpu-onnx', workload: 'locomotion', threads: 1, ref: 'artifact://replace-with-managed-artifact' }],
      metadata: { source: 'OriginBot local or RoboGo export', notes: '8D 观测 / 2D 差速动作；可直接仿真、录制、训练和评测。' },
    };
    $('manifest-editor').value = JSON.stringify(template, null, 2);
    if (notify) showToast('已载入 OriginBot 默认 manifest 模板；可直接校验或按需修改');
    return;
  }
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
    const parsed = JSON.parse(
      await readImportTextWithinLimit(
        file,
        MAX_MANIFEST_IMPORT_BYTES,
        'manifest 文件',
        '请精简 JSON 后再导入',
      ),
    );
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

// Telemetry pure logic (snapshot normalization, IMU parsing, sample import)
// lives in telemetry-core.js; these delegations keep the original call sites
// and the ui-ia spec contract stable.
function stationImuQuaternion(originbot) {
  return SimTelemetryCore.stationImuQuaternion(originbot);
}

function stationTelemetrySnapshot(status) {
  return SimTelemetryCore.stationTelemetrySnapshot(status);
}

function telemetryHasData(snapshot) {
  return SimTelemetryCore.telemetryHasData(snapshot);
}

function stationRenderRobotTelemetry(status) {
  const wrap = $('station-robot-tele');
  if (!wrap) return;
  const originbot = stationTelemetrySnapshot(status);
  const hasData = telemetryHasData(originbot);
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
  if (status.available === false || status.state === 'offline') {
    const reason = String(status.message || status.reason || '实体板卡离线');
    if (freshness) {
      freshness.textContent = `板卡离线 · ${reason}`;
      freshness.classList.add('is-stale');
    }
    ['station-cpu', 'station-cpu-temp', 'station-memory', 'station-memory-sub',
      'station-network', 'station-disk', 'station-disk-sub', 'station-power',
      'station-power-sub', 'station-uptime', 'station-uptime-sub',
      'station-drive-state', 'station-tele-heading', 'station-tele-battery',
      'station-tele-odom', 'station-tele-vel'].forEach((id) => setText(id, '无数据'));
    setText('station-network-sub', '等待板卡接入');
    setText('station-tele-battery-sub', '无实体板卡遥测');
    setText('station-tele-heading-sub', '无实体板卡 IMU');
    stationSetBar('station-cpu-bar', NaN, 0.6, 0.85);
    stationSetBar('station-memory-bar', NaN, 0.7, 0.9);
    stationSetBar('station-disk-bar', NaN, 0.75, 0.9);
    stationSetBar('station-power-bar', NaN, 0.35, 0.2, true);
    stationUpdateFloatStop(null);
    const liveBadge = $('station-live-badge');
    if (liveBadge) {
      liveBadge.hidden = false;
      liveBadge.textContent = 'OFFLINE';
      liveBadge.classList.add('is-stale');
    }
    stationRenderPolicy({ state: 'offline', lastError: reason, available: false });
    return;
  }
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
  // the bringup stack is running, never synthesized here. Text and bar read
  // the same stationPowerView so they can never disagree.
  const powerView = SimTelemetryCore.stationPowerView(status);
  const originbot = powerView.telemetry;
  setText('station-power', powerView.powerText);
  const obQuat = stationImuQuaternion(originbot);
  const imuZ = obQuat ? obQuat.z : NaN;
  const imuW = obQuat ? obQuat.w : NaN;
  setText('station-power-sub', powerView.powerSubText);
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
    const feedback = drive?.feedback;
    const feedbackReady = feedback?.fresh === true && Number.isFinite(Number(feedback.linearX));
    const feedbackText = feedbackReady
      ? ` · 实测 ${Number(feedback.linearX).toFixed(2)} m/s · ${Number(feedback.angularZ || 0).toFixed(2)} rad/s`
      : feedback?.available === true
        ? ' · 实测遥测陈旧'
        : '';
    if (drive && drive.active) {
      const remaining = Number.isFinite(Number(drive.remainingMs)) ? drive.remainingMs : 0;
      driveState.textContent =
        `运动中 ${Number(drive.linear).toFixed(2)} m/s · ${Number(drive.angular).toFixed(2)} rad/s · 剩余 ${(remaining / 1000).toFixed(1)}s${feedbackText}`;
    } else {
      const reason = drive && drive.lastStopReason ? String(drive.lastStopReason) : '空闲';
      driveState.textContent = `空闲（${reason}）${feedbackText}`;
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
  const powerRatio = powerView.powerRatio;
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
  if (!state.station.ready || state.station.offline || state.station.statusReader) return;
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
            const snapshot = JSON.parse(line);
            if (snapshot?.available === false || snapshot?.state === 'offline') {
              state.station.offline = true;
              state.station.offlineReason = String(snapshot.message || '实体板卡离线');
            }
            stationRenderStatus(snapshot);
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
    if (payload?.available === false || payload?.state === 'offline') {
      const controls = $('station-drive-controls');
      const note = $('station-drive-note');
      if (controls) controls.hidden = true;
      if (note) note.textContent = `板卡离线：${String(payload.message || '接入实体板卡后才能读取驱动状态。')}`;
      return;
    }
    const enabled = payload?.platformEnabled === true && payload?.drive?.enabled === true;
    const policy = payload?.actuatorPolicy || {};
    const maxLinear = Number(policy.maxLinear);
    const maxAngular = Number(policy.maxAngular);
    const watchdogMs = Number(policy.watchdogMs);
    setText('station-control-limits', `${Number.isFinite(maxLinear) ? maxLinear.toFixed(2) : '0.30'} m/s · ${Number.isFinite(maxAngular) ? maxAngular.toFixed(2) : '1.00'} rad/s`);
    setText('station-control-watchdog', `${Number.isFinite(watchdogMs) ? Math.round(watchdogMs) : 500} ms 自动停车`);
    setText('station-control-path', policy.commandTopic ? `策略动作 → ${policy.commandTopic}` : '策略动作 → /cmd_vel');
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
  const acknowledged = await confirmAction({
    title: '确认底盘运动（受控 Canary）',
    note:
      `即将让 OriginBot 以 ${linear.toFixed(2)} m/s（转向 ${angular.toFixed(2)} rad/s）运动 ${durationSec.toFixed(1)} 秒。\n` +
      '请确认机器人周围无障碍物、桌面/场地已清空。\n' +
      '急停按钮随时可用；底盘 500ms 看门狗兜底。',
    approveLabel: '执行运动',
  });
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
    if (payload?.available === false || payload?.state === 'offline') {
      const controls = $('station-policy-controls');
      const note = $('station-policy-note');
      if (controls) controls.hidden = true;
      if (note) note.textContent = `板卡离线：${String(payload.message || '接入实体板卡后才能读取策略运行时。')}`;
      return;
    }
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
    // 平台策略开关开启时顺带拉一次板端制品列表（staging 面板随 controls 显示）。
    if (platform) void stationRenderPolicyFiles();
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
  const feedback = policy.feedback;
  const actualLinear = Number(feedback?.linearX);
  const actualAngular = Number(feedback?.angularZ);
  setText(
    'station-policy-actual',
    feedback?.fresh === true && Number.isFinite(actualLinear)
      ? `${actualLinear.toFixed(2)} m/s · ${Number.isFinite(actualAngular) ? actualAngular.toFixed(2) : '--'} rad/s`
      : feedback?.available === true
        ? '遥测陈旧'
        : '--',
  );
  const model = policy.model;
  const meta = $('station-policy-model-meta');
  if (meta) {
    if (model && typeof model === 'object') {
      const kb = Number(model.bytes);
      const provider = typeof model.provider === 'string' ? model.provider : 'CPU';
      const digest = typeof model.sha256 === 'string' && model.sha256.length >= 12
        ? ` · sha256 ${model.sha256.slice(0, 12)}…`
        : '';
      meta.textContent =
        `${String(model.path ?? '?').split('/').pop()} · ${Number.isFinite(kb) ? `${Math.round(kb / 1024)}KB` : '?'} · ` +
        `${Number(model.inputDim)}→${Number(model.outputDim)} · ${provider}` +
        (Array.isArray(policy.providersAvailable) && policy.providersAvailable.length
          ? `（板端可用：${policy.providersAvailable.join('、')}）`
          : '') + digest;
    } else {
      meta.textContent = '未加载模型';
    }
  }
  const sessionNode = $('station-policy-session');
  if (sessionNode) {
    const rawSession = policy.session && typeof policy.session === 'object'
      ? policy.session
      : (policy.sessionId ? {
          id: policy.sessionId,
          startedAt: policy.sessionStartedAt,
          stoppedAt: policy.sessionStoppedAt,
          stopReason: policy.sessionStopReason,
          inferenceCount: policy.inferenceCount,
          lastInferenceAt: policy.lastInferenceAt,
          mock: false,
        } : null);
    const session = rawSession || {};
    const sessionId = typeof session.id === 'string' && session.id ? session.id : '';
    const started = typeof session.startedAt === 'string' ? session.startedAt : '';
    const stopped = typeof session.stoppedAt === 'string' ? session.stoppedAt : '';
    const reason = typeof session.stopReason === 'string' && session.stopReason ? session.stopReason : '—';
    const count = Number(session.inferenceCount);
    const mock = session.mock === true;
    const stateLabel = !sessionId ? '尚未启动策略' : stopped ? `已停止 · ${reason}` : '运行中 · 未停止';
    const lifecycle = sessionId
      ? `会话 ${sessionId.slice(0, 12)}${sessionId.length > 12 ? '…' : ''} · ${started || '起始时间未知'}${stopped ? ` → ${stopped}` : ''}`
      : '等待下一次 start；停止和故障证据会保留到下一次会话。';
    const evidence = `${lifecycle} · 推理 ${Number.isFinite(count) ? Math.max(0, Math.round(count)) : 0} 次${mock ? ' · mock' : ' · mock:false'}`;
    setText('station-policy-session-state', stateLabel);
    setText('station-policy-session-meta', evidence);
    sessionNode.dataset.state = !sessionId ? 'waiting' : stopped ? 'stopped' : 'running';
  }
  const layoutNode = $('station-policy-layout');
  if (layoutNode) {
    const layout = typeof policy.observationLayout === 'string' ? policy.observationLayout : null;
    const actionOutput = typeof policy.actionOutput === 'string' ? policy.actionOutput : null;
    const controlHz = Number(policy.controlHz);
    const actionLabel = actionOutput ? ` · 动作单位：${actionOutput}` : '';
    const rateLabel = Number.isFinite(controlHz) && controlHz > 0 ? ` · 控制：${controlHz} Hz` : '';
    layoutNode.textContent = layout
      ? `观测布局：${layout}${layout === 'auto' ? '（按维度自动）' : '（adapter 声明）'}${actionLabel}${rateLabel}`
      : `观测布局：--${actionLabel}${rateLabel}`;
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

async function stationPolicyStage() {
  const runId = String($('station-policy-stage-run')?.value ?? '').trim();
  if (!/^[\w.-]{1,120}$/.test(runId)) {
    stationLog('runId 无效：仅接受训练记录的 runId（字母数字与 .-_）', 'error');
    return;
  }
  const button = $('station-policy-stage-btn');
  if (button) button.disabled = true;
  try {
    const payload = await request('/sim2real/board-station/policy/stage', {
      method: 'POST',
      body: JSON.stringify({ runId }),
    });
    if (payload?.ok) {
      const staged = payload?.staged ?? {};
      stationLog(
        `制品已下发：${staged.filename ?? '?'}（${Math.round(Number(staged.bytes ?? 0) / 1024)}KB，` +
        `SHA-256 ${String(staged.sha256 ?? '').slice(0, 12)}…）——只落盘，未加载未运动`,
        'ok',
      );
      // 下发成功后把文件名填进加载框：staging 与加载仍是两个显式动作，
      // 不代操作员点“加载”。
      const modelName = $('station-policy-model-name');
      if (modelName && typeof staged.filename === 'string') modelName.value = staged.filename;
      void stationRenderPolicyFiles();
    } else {
      stationLog(`下发被拒绝：${payload?.error ?? payload?.reason ?? '未知原因'}`, 'error');
    }
  } catch (error) {
    stationLog(`下发失败：${error instanceof Error ? error.message : '未知错误'}`, 'error');
  } finally {
    if (button) button.disabled = false;
  }
}

/** 板端 policies/ 目录如实列表（agents 端点 → 平台代理）；失败则隐藏，不伪造。 */
async function stationRenderPolicyFiles() {
  const node = $('station-policy-files');
  if (!node) return;
  try {
    const payload = await request('/sim2real/board-station/policy/files');
    const files = Array.isArray(payload?.files) ? payload.files : null;
    if (!files) {
      node.hidden = true;
      return;
    }
    node.replaceChildren();
    if (!files.length) {
      const empty = document.createElement('div');
      empty.className = 'station-policy-files-empty';
      empty.textContent = '板端 policies/ 目录为空（先下发一个训练产物）';
      node.appendChild(empty);
    } else {
      files.forEach((file) => {
        const row = document.createElement('div');
        row.className = 'station-policy-files-row';
        const name = document.createElement('span');
        name.className = 'station-policy-files-name';
        name.textContent = String(file?.name ?? '?');
        const bytes = document.createElement('span');
        bytes.className = 'station-policy-files-bytes';
        const kb = Number(file?.bytes);
        bytes.textContent = Number.isFinite(kb) && kb > 0 ? `${Math.round(kb / 1024)}KB` : '--';
        row.append(name, bytes);
        node.appendChild(row);
      });
    }
    node.hidden = false;
  } catch {
    node.hidden = true;
  }
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
  const goalXRaw = String($('station-policy-goal-x')?.value ?? '').trim();
  const goalYRaw = String($('station-policy-goal-y')?.value ?? '').trim();
  const goalX = goalXRaw === '' ? undefined : Number(goalXRaw);
  const goalY = goalYRaw === '' ? undefined : Number(goalYRaw);
  if ((goalX !== undefined && !Number.isFinite(goalX)) || (goalY !== undefined && !Number.isFinite(goalY))) {
    stationLog('目标点必须是数值（单位：米）', 'error');
    return;
  }
  const acknowledged = await confirmAction({
    title: '确认策略驱动运动',
    note:
      `即将让 OriginBot 由策略网络驱动运动（方向指令 ${direction.toFixed(1)}${goalX !== undefined && goalY !== undefined ? `，目标 ${goalX.toFixed(2)}, ${goalY.toFixed(2)} m` : ''}）。\n` +
      '策略输出将被钳制在 0.3 m/s / 1.0 rad/s 内，500ms 无命令底盘自动停车。\n' +
      '请确认机器人周围无障碍物、场地已清空，急停按钮随时可用。',
    approveLabel: '启动策略',
  });
  if (!acknowledged) return;
  try {
    const payload = await request('/sim2real/board-station/policy/start', {
      method: 'POST',
      body: JSON.stringify({
        direction,
        ...(goalX === undefined ? {} : { goalX }),
        ...(goalY === undefined ? {} : { goalY }),
      }),
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
    if (health?.available === false || health?.state === 'offline') {
      state.station.ready = false;
      state.station.offline = true;
      state.station.offlineReason = String(health.message || '当前没有可达的实体板卡');
      state.station.device = health?.device ?? null;
      const fallbackDevice = selectedDevice();
      const deviceName = $('station-device-name');
      const selectedOption = $('device-select')?.selectedOptions?.[0];
      if (deviceName) {
        deviceName.textContent = health?.device?.name
          ? `${health.device.name}（${health.device.id}）`
          : fallbackDevice?.name || fallbackDevice?.id || selectedOption?.textContent || '（未选择）';
      }
      if (notice) {
        notice.hidden = false;
        // 服务端给的 offlineReason 里可能已经带了"仍可使用"的说明，无脑追加
        // 会让横幅把同一件事说两遍（实测渲染出"仿真和训练工作流仍可使用…
        // 仿真、训练与数据分析仍可使用。"）。
        const offlineReason = String(state.station.offlineReason || '').trim();
        notice.textContent = `上位机离线：${offlineReason}${
          offlineReason.includes('仍可使用') ? '' : ' 仿真、训练与数据分析仍可使用。'
        }`;
      }
      if (honestyNote) honestyNote.hidden = false;
      stationLog(`上位机离线：${state.station.offlineReason}`, 'info');
      return;
    }
    state.station.ready = true;
    state.station.offline = false;
    state.station.offlineReason = '';
    state.station.mock = health?.agent?.mock === true;
    state.station.device = health?.device ?? null;
    if (notice) notice.hidden = true;
    if (honestyNote) honestyNote.hidden = health?.agent?.mock !== true;
    const deviceName = $('station-device-name');
    if (deviceName) {
      const selectedOption = $('device-select')?.selectedOptions?.[0];
      deviceName.textContent = health?.device?.name
        ? `${health.device.name}（${health.device.id}）`
        : selectedDevice()?.name || selectedDevice()?.id || selectedOption?.textContent || '（未选择）';
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
    const fallbackDevice = selectedDevice();
    const deviceName = $('station-device-name');
    const selectedOption = $('device-select')?.selectedOptions?.[0];
    if (deviceName) {
      deviceName.textContent = fallbackDevice?.name || fallbackDevice?.id || selectedOption?.textContent || '（未选择）';
    }
    if (notice) {
      const detail = error instanceof Error ? error.message : '板端 agent 或板卡设备不可用';
      notice.hidden = false;
      const cleanDetail = detail.replace(/[。.!！?？\s]+$/u, '');
      notice.textContent =
        '上位机未就绪：' +
        cleanDetail +
        '。请确认板卡上的 rdk-board-agent 已启动、19100 端口可达，并在设备列表中完成接入。';
    }
    stationLog('上位机初始化失败', 'error');
  }
  // 设备管理（网页添加真机）与运动开关面板：只读拉取，无需板端就绪。
  stationDeviceManagerLoad();
  stationSwitchProbe();
  wireDeviceManagerEvents();
  wireStationSwitchEvents();
}

// ---- 设备管理（RDK Studio Local Bridge 优先，SSH 仅作独立部署备用） -------
// 共享 Studio 部署通过浏览器已有会话走 Local Bridge；这里的 SSH 记录仅供
// 服务器与板卡确实网络可达的独立部署使用。

function stationDeviceRow(connection) {
  const live = connection.tunnelActive === true;
  const item = document.createElement('div');
  item.className = 'station-device-item';
  item.dataset.connectionId = connection.id;
  const lastCheck = connection.lastCheckedAt
    ? `${connection.lastCheckOk === true ? '✓' : '✗'} ${connection.lastCheckMessage}`
    : connection.lastCheckMessage || 'SSH 隧道尚未测试（实时遥测可独立在线）';
  item.innerHTML = `
    <div class="station-device-item-main">
      <span class="station-device-item-title"></span>
      <span class="station-device-item-meta"></span>
    </div>
    <span class="station-device-badge"></span>
    <div class="station-device-item-actions">
      <button class="button station-device-connect" type="button"></button>
      <button class="button button-quiet" type="button" data-action="remove">移除</button>
    </div>`;
  item.querySelector('.station-device-item-title').textContent =
    `${connection.label || connection.id} · ${connection.username}@${connection.host}`;
  item.querySelector('.station-device-item-meta').textContent =
    `SSH ${connection.port} · agent 端口 ${connection.agentPort} · ${lastCheck}`;
  const badge = item.querySelector('.station-device-badge');
  // The station telemetry stream and the SSH tunnel are independent paths:
  // a live board status must not be presented as an SSH connection, and an
  // untested SSH tunnel must not contradict a visible LIVE telemetry card.
  badge.textContent = live ? 'SSH 已连接' : 'SSH 未验证';
  badge.classList.add(live ? 'live' : 'down');
  const connectBtn = item.querySelector('.station-device-connect');
  connectBtn.textContent = live ? '断开' : '连接';
  connectBtn.dataset.action = live ? 'disconnect' : 'connect';
  return item;
}

function stationBridgeRow(bridge, device) {
  const item = document.createElement('div');
  item.className = 'station-device-item';
  item.dataset.bridgeDeviceId = device.bridgeDeviceId || device.id || '';
  item.dataset.bridgeId = bridge.bridgeId || '';
  const registered = (state.overview?.devices || []).find((candidate) => candidate.bridgeDeviceId && candidate.bridgeDeviceId === device.bridgeDeviceId);
  item.innerHTML = '<div class="station-device-item-main"><span class="station-device-item-title"></span><span class="station-device-item-meta"></span></div><span class="station-device-badge live">Bridge 在线</span><div class="station-device-item-actions"><button class="button station-device-connect" type="button" data-action="bridge-connect"></button></div>';
  item.querySelector('.station-device-item-title').textContent = device.name || device.host || '本地板卡';
  item.querySelector('.station-device-item-meta').textContent = `${device.username || 'root'}@${device.host || '本机网络'} · ${device.transport || 'ssh'} · ${device.probeOk === true ? 'SSH 已验证' : '等待验证'}`;
  const button = item.querySelector('.station-device-connect');
  if (registered) {
    button.textContent = '已接入 · 设为目标';
    button.dataset.action = 'bridge-select';
    button.dataset.deviceId = registered.id;
  } else {
    button.textContent = '接入平台';
  }
  return item;
}

async function stationDeviceManagerLoad() {
  const list = $('station-device-list');
  if (!list) return;
  let payload = null;
  let deviceConnectionsError = null;
  try { payload = await request('/sim2real/device-connections'); }
  catch (error) { deviceConnectionsError = error; }
  const connections = Array.isArray(payload?.connections) ? payload.connections : [];
  let bridgeStatus = null;
  try {
    bridgeStatus = await request('/sim2real/local-bridge/status');
  } catch (error) {
    if (!deviceConnectionsError) stationLog(`Local Bridge 状态暂不可用：${error instanceof Error ? error.message : '未知错误'}`, 'error');
  }
  list.replaceChildren();
  const bridges = Array.isArray(bridgeStatus?.bridges) ? bridgeStatus.bridges : [];
  const bridgeDevices = bridges.flatMap((bridge) => bridge.online !== false ? (bridge.devices || []).map((device) => ({ bridge, device })) : []);
  for (const entry of bridgeDevices) list.append(stationBridgeRow(entry.bridge, entry.device));
  if (!connections.length && !bridgeDevices.length) {
    const empty = document.createElement('span');
    empty.className = 'station-topic-empty';
    empty.id = 'station-device-list-empty';
    empty.textContent = deviceConnectionsError ? '暂时无法读取设备列表；Local Bridge 在线后会自动刷新。' : '尚未添加设备。';
    list.append(empty);
  }
  for (const connection of connections) list.append(stationDeviceRow(connection));
  if (bridgeDevices.length) stationLog(`已发现 ${bridgeDevices.length} 台本地 Bridge 设备，可直接连接`, 'ok');
  stationBridgePollResume();
  // The software workflow remains usable without a board. This manager is
  // only a hardware discovery surface, so an SSH failure must not block the
  // Bridge poll or the simulation/training paths.
  stationSwitchBoardProbe();
}

// The Bridge discovery poll only runs while the station view is visible:
// entering the view (via syncScopedPolls) or the device manager refresh
// re-arms it; leaving the view or hiding the tab clears the timer.
const stationBridgePoll = createScopedPoll({
  name: 'station-bridge',
  views: ['station'],
  nextDelay: 3000,
  tick: stationDeviceManagerLoad,
});

function stationBridgePollResume() {
  stationBridgePoll.rearm();
}

function wireDeviceManagerEvents() {
  if (state.station.deviceManagerWired) return;
  state.station.deviceManagerWired = true;
  $('station-device-add-btn')?.addEventListener('click', async () => {
    const host = String($('station-device-host')?.value || '').trim();
    const username = String($('station-device-user')?.value || 'root').trim();
    const password = String($('station-device-password')?.value || '');
    const port = Number($('station-device-port')?.value || 22);
    const label = String($('station-device-label')?.value || '').trim();
    const profile = String($('station-device-profile')?.value || 'custom');
    const transport = String($('station-device-transport')?.value || 'ssh');
    if (!host) {
      stationLog('请填写板卡 IP 或主机名（不带 http://）', 'error');
      return;
    }
    try {
      const created = await request('/sim2real/device-connections', {
        method: 'POST',
        body: JSON.stringify({ host, username, port, label, profile, transport }),
      });
      stationLog(`已添加 SSH 备用设备 ${created?.connection?.label || host}，仅在服务器可达板卡时使用`, 'ok');
      try { localStorage.setItem(`rdk-device-profile:${created?.connection?.id || host}`, JSON.stringify({ profile, transport })); } catch {}
      $('station-device-host').value = '';
      await stationDeviceManagerLoad();
    } catch (error) {
      stationLog(`添加失败：${error instanceof Error ? error.message : '未知错误'}`, 'error');
    }
  });
  $('station-device-script-btn')?.addEventListener('click', async () => {
    const host = String($('station-device-host')?.value || '').trim();
    const user = String($('station-device-user')?.value || 'root').trim() || 'root';
    const password = String($('station-device-password')?.value || '');
    const port = Number($('station-device-port')?.value || 22);
    if (!host) { showToast('请先填写板卡 IP 或主机名。', 'error'); return; }
    let script = '';
    try {
      // The Studio host exposes the shared Local Bridge protocol under its
      // mounted API path; the Sim2Real UI owns the flow and never redirects.
      const pairing = await request('/sim2real/local-bridge/pairing-code', { method: 'POST', body: JSON.stringify({ host, sshUser: user, sshPort: port, ...(password ? { sshPassword: password } : {}) }) });
      if (!pairing.command) throw new Error(pairing.message || '无法生成连接命令，请先登录。');
      script = pairing.oneliner || pairing.command;
    } catch (error) {
      showToast(error instanceof Error ? error.message : '无法生成连接命令，请先登录。', 'error');
      return;
    }
    const output = $('station-connect-script');
    const text = $('station-connect-script-text');
    if (text) text.value = script;
    output?.removeAttribute('hidden');
    try { await navigator.clipboard?.writeText(script); showToast('连接脚本已生成并复制。', 'success'); } catch { showToast('连接脚本已生成，请手动复制。', 'normal'); }
  });
  $('station-connect-script-copy')?.addEventListener('click', async () => {
    const text = $('station-connect-script-text');
    if (!text) return;
    try { await navigator.clipboard.writeText(text.value); showToast('脚本已复制。', 'success'); } catch { text.select(); document.execCommand('copy'); showToast('脚本已复制。', 'success'); }
  });
  $('station-device-list')?.addEventListener('click', async (event) => {
    const button = event.target instanceof Element ? event.target.closest('button') : null;
    if (!button) return;
    const item = button.closest('.station-device-item');
    const connectionId = item?.dataset?.connectionId;
    const action = button.dataset.action;
    if (action === 'bridge-connect') {
      button.disabled = true;
      button.textContent = '接入中…';
      showToast('正在把这块板卡接入 Sim2Real，请稍候…', 'normal');
      try {
        stationLog('正在把本地 Bridge 设备接入 Sim2Real…');
        const bridgeDeviceId = item?.dataset?.bridgeDeviceId;
        const bridgeId = item?.dataset?.bridgeId;
        const result = await request(`/sim2real/local-bridge/devices/${encodeURIComponent(bridgeDeviceId)}/connect`, { method: 'POST', body: JSON.stringify({ bridgeId }) });
        const payload = result || {};
        if (!result.ok) throw new Error(payload.message || 'Bridge 设备连接失败');
        stationLog('Bridge 设备已连接，目标设备列表已更新。', 'ok');
        showToast('设备已接入 Sim2Real，可以进行预检。', 'success');
        await loadOverview({ quiet: true });
        stationInit();
      } catch (error) { const message = error instanceof Error ? error.message : 'Bridge 设备连接失败'; stationLog(message, 'error'); showToast(message, 'error'); }
      finally { button.disabled = false; await stationDeviceManagerLoad(); }
      return;
    }
    if (action === 'bridge-select') {
      state.selectedDeviceId = button.dataset.deviceId || '';
      saveWorkspaceContext();
      renderAll();
      showToast('已选择目标设备；现在可继续做预检或部署。', 'success');
      button.disabled = false;
      return;
    }
    if (!connectionId || !action) return;
    button.disabled = true;
    try {
      if (action === 'connect') {
        stationLog('正在建立 SSH 隧道并探测板端 agent…');
        const result = await request(`/sim2real/device-connections/${encodeURIComponent(connectionId)}/connect`, {
          method: 'POST',
        });
        const probe = result?.probe;
        stationLog(
          probe?.ok === true
            ? `已连接${result?.probe?.agentInfo?.boardModel ? `（${probe.agentInfo.boardModel}）` : ''}：${probe.message || '连接正常'}`
            : `连接失败：${probe?.message || '未知错误'}`,
          probe?.ok === true ? 'ok' : 'error',
        );
        // 隧道改变 boardAgentUrl 的解析结果：重新初始化上位机全部数据面。
        stationInit();
      } else if (action === 'disconnect') {
        await request(`/sim2real/device-connections/${encodeURIComponent(connectionId)}/disconnect`, {
          method: 'POST',
        });
        stationLog('隧道已断开，恢复默认 agent 目标');
        stationInit();
      } else if (action === 'remove') {
        const approved = await confirmAction({
          title: '移除设备',
          note: `移除设备 ${item.querySelector('.station-device-item-title')?.textContent || connectionId}？隧道会一并断开。`,
          approveLabel: '移除设备',
        });
        if (!approved) {
          button.disabled = false;
          return;
        }
        await request(`/sim2real/device-connections/${encodeURIComponent(connectionId)}`, {
          method: 'DELETE',
        });
        stationLog('设备已移除');
        stationInit();
      }
    } catch (error) {
      stationLog(`操作失败：${error instanceof Error ? error.message : '未知错误'}`, 'error');
    } finally {
      button.disabled = false;
      await stationDeviceManagerLoad();
    }
  });
}

// ---- 运动开关（平台侧持久覆盖 + 板端 /v1/config 代理） -------------------

function setSwitchButton(button, enabled) {
  if (!button) return;
  button.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  // 板端按钮保留“驱动/策略”标签；平台按钮显示开关语义。
  if (!button.hasAttribute('data-board-switch')) button.textContent = enabled ? '已开启' : '开启';
}

async function stationSwitchProbe() {
  try {
    const payload = await request('/sim2real/board-station/switches');
    setSwitchButton($('station-switch-drive'), payload?.drive === true);
    setSwitchButton($('station-switch-policy'), payload?.policy === true);
  } catch {
    const stateLine = $('station-switch-state');
    if (stateLine) stateLine.textContent = '平台开关状态读取失败（不影响急停）';
  }
  // 板端开关行：有活跃隧道才显示。
  stationSwitchBoardProbe();
}

async function stationSwitchBoardProbe() {
  const row = $('station-switch-board-row');
  if (!row) return;
  // 找第一个隧道活跃的连接。
  let active = null;
  try {
    const payload = await request('/sim2real/device-connections');
    active = (payload?.connections || []).find((item) => item.tunnelActive === true) || null;
  } catch {
    active = null;
  }
  if (!active) {
    row.hidden = true;
    setSwitchButton($('station-switch-board-drive'), false);
    setSwitchButton($('station-switch-board-policy'), false);
    return;
  }
  row.hidden = false;
  $('station-switch-board-name')?.setAttribute(
    'data-connection-id',
    String(active.id || ''),
  );
  $('station-switch-board-sub').textContent =
    `${active.label || active.host} · 写板端 env 并重启 agent（约 2 秒生效）`;
  try {
    const config = await request(`/sim2real/device-connections/${encodeURIComponent(active.id)}/config`);
    const switches = config?.config?.switches || {};
    setSwitchButton(
      $('station-switch-board-drive'),
      switches.RDK_SIM2REAL_BOARD_AGENT_ENABLE_DRIVE === true,
    );
    setSwitchButton(
      $('station-switch-board-policy'),
      switches.RDK_SIM2REAL_BOARD_AGENT_ENABLE_POLICY === true,
    );
  } catch (error) {
    $('station-switch-board-sub').textContent = `板端开关状态不可达：${
      error instanceof Error ? error.message : 'agent 版本过旧（无 /v1/config）'
    }`;
  }
}

function wireStationSwitchEvents() {
  if (state.station.switchWired) return;
  state.station.switchWired = true;
  const stateLine = $('station-switch-state');
  const setLine = (text) => { if (stateLine) stateLine.textContent = text; };

  const platformToggle = async (name, next) => {
    if (next) {
      const confirmed = await confirmAction({
        title: '开启平台运动开关',
        note: '开启平台运动开关前请确认：操作者在机器人旁、场地已清空、急停随时可用。\n（板端开关仍需单独开启才会真正运动）',
        approveLabel: '开启开关',
      });
      if (!confirmed) return null;
    }
    await request('/sim2real/board-station/switches', {
      method: 'PUT',
      body: JSON.stringify(next ? { [name]: true, confirm: true } : { [name]: false }),
    });
    setLine(next ? `平台 ${name} 开关已开启（持久化保存）` : `平台 ${name} 开关已关闭`);
    stationSwitchProbe();
    stationProbeDrive();
    stationProbePolicy();
    return true;
  };

  $('station-switch-drive')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const next = button.getAttribute('aria-pressed') !== 'true';
    button.disabled = true;
    try { await platformToggle('drive', next); }
    catch (error) { setLine(`切换失败：${error instanceof Error ? error.message : '未知错误'}`); }
    finally { button.disabled = false; }
  });
  $('station-switch-policy')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const next = button.getAttribute('aria-pressed') !== 'true';
    button.disabled = true;
    try { await platformToggle('policy', next); }
    catch (error) { setLine(`切换失败：${error instanceof Error ? error.message : '未知错误'}`); }
    finally { button.disabled = false; }
  });

  const boardToggle = async (event) => {
    const button = event.currentTarget;
    const flag = button.dataset.boardSwitch;
    const next = button.getAttribute('aria-pressed') !== 'true';
    const connectionId = $('station-switch-board-name')?.getAttribute('data-connection-id');
    if (!connectionId || !flag) return;
    if (next) {
      const confirmed = await confirmAction({
        title: '修改板端运动开关',
        note: '即将修改板端运动开关并重启板端 agent（约 2 秒，期间遥测短暂中断）。\n请再次确认操作者在场、场地清空。',
        approveLabel: '写入并重启',
      });
      if (!confirmed) return;
    }
    button.disabled = true;
    setLine('正在写入板端配置并重启 agent…');
    try {
      await request(`/sim2real/device-connections/${encodeURIComponent(connectionId)}/config`, {
        method: 'POST',
        body: JSON.stringify({ switches: { [flag]: next } }),
      });
      // agent 重启需要几秒：延迟后重读真实状态。
      await new Promise((resolve) => setTimeout(resolve, 3000));
      setLine(next ? '板端开关已开启（agent 已重启）' : '板端开关已关闭（agent 已重启）');
      await stationSwitchBoardProbe();
      stationProbeDrive();
      stationProbePolicy();
      stationInit();
    } catch (error) {
      setLine(`板端开关修改失败：${error instanceof Error ? error.message : '未知错误'}`);
      await stationSwitchBoardProbe();
    } finally {
      button.disabled = false;
    }
  };
  $('station-switch-board-drive')?.addEventListener('click', boardToggle);
  $('station-switch-board-policy')?.addEventListener('click', boardToggle);
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
    const value = Number(event.target.value);
    setText('station-drive-speed-out', `${value >= 0 ? '+' : ''}${value.toFixed(2)} m/s`);
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
  // 策略面板：staging（产物→板端 policies/，只落盘不加载）→ 手动加载 → 启动（含确认）
  // /停止/清故障；停止同样无任何前置条件。staging 与加载是两个显式动作。
  $('station-policy-stage-btn')?.addEventListener('click', () => {
    void stationPolicyStage();
  });
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
  wireTopMenu();
  wireSidebarDrawer();
  wireTablists();
  // 轮询和视图切换都会重写正文，截断提示要跟着重算。
  if (typeof MutationObserver === 'function') {
    new MutationObserver(scheduleTruncationTitles).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['hidden'],
    });
  }
  window.addEventListener('resize', scheduleTruncationTitles, { passive: true });
  scheduleTruncationTitles();
  document.addEventListener('click', (event) => {
    const opener = event.target instanceof Element ? event.target.closest('[data-agent-open]') : null;
    if (opener && typeof window.setAgentDrawerOpen === 'function') {
      window.setAgentDrawerOpen(true);
    }
  });
  window.addEventListener('hashchange', () => {
    const locationState = parseHashLocation();
    setView(locationState.view, { updateHash: false });
    if (locationState.child) {
      applyFlowChildDestination(FLOW_CHILD_CONTEXTS[locationState.child]);
      setFlowChild(locationState.child, { updateHash: false });
    }
  });
  // Back/forward now walks the pushed view history instead of leaving the
  // app. updateHash=false keeps popstate from re-pushing an entry.
  window.addEventListener('popstate', () => {
    const locationState = parseHashLocation();
    setView(locationState.view, { updateHash: false });
    if (locationState.child) {
      applyFlowChildDestination(FLOW_CHILD_CONTEXTS[locationState.child]);
      setFlowChild(locationState.child, { updateHash: false });
    }
  });
  window.addEventListener('message', handleMicroduckRecordingReady);
  // Hidden tabs keep their data but stop paying for it: every scoped poll
  // holds its timer while hidden and is resumed here on return (the overview
  // poll refreshes immediately; view-scoped polls re-arm at cadence).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resumeScopedPolls();
  });
  $('refresh-button')?.addEventListener('click', () => loadOverview());
  $('workspace-status-retry')?.addEventListener('click', () => {
    if (!state.loading) void loadOverview();
  });
  wireCommandPalette();
  $('robogo-refresh-button')?.addEventListener('click', () => loadOverview());
  $('auth-retry-button')?.addEventListener('click', () => loadOverview());
  // Guest banner expand/collapse: the login form is opt-in, never forced.
  $('auth-gate-toggle')?.addEventListener('click', () => {
    const panel = $('auth-gate-panel');
    const toggle = $('auth-gate-toggle');
    const gate = $('auth-gate');
    if (!panel || !toggle) return;
    const expanding = panel.hidden;
    panel.hidden = !expanding;
    toggle.setAttribute('aria-expanded', expanding ? 'true' : 'false');
    toggle.textContent = expanding ? '收起表单' : '登录 / 展开表单';
    if (expanding) panel.querySelector('input')?.focus();
  });
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
  $('account-avatar')?.addEventListener('click', () => {
    const menu = $('account-menu');
    const avatar = $('account-avatar');
    if (!menu || !avatar) return;
    const open = menu.hidden;
    menu.hidden = !open;
    avatar.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest('#account-menu-wrap')) return;
    const menu = $('account-menu');
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    $('account-avatar')?.setAttribute('aria-expanded', 'false');
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const menu = $('account-menu');
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    $('account-avatar')?.setAttribute('aria-expanded', 'false');
  });
  wireRunComparisonControls();
  $('project-create-button')?.addEventListener('click', openProjectDialog);
  $('project-select')?.addEventListener('change', (event) => {
    const next = String(event.target?.value || '');
    state.projectId = (state.projects || []).some((project) => String(project.id) === next) ? next : '';
    // A project may intentionally contain no model yet. Keep the current
    // selection when it remains valid; otherwise renderSelects() chooses the
    // first model linked to the new project and exposes the empty state.
    if (state.projectId) {
      const ids = projectModelIds();
      if (ids && state.selectedModelId && !ids.has(String(state.selectedModelId))) state.selectedModelId = '';
    }
    state.activeDeployment = null;
    state.telemetry = null;
    saveWorkspaceContext();
    renderAll();
    showToast(state.projectId ? `已切换项目：${projectDisplayName(selectedProject())}` : '已切换到全部项目', 'success');
  });
  $('project-form')?.addEventListener('submit', (event) => {
    void submitProject(event);
  });
  $('project-dialog-close')?.addEventListener('click', () => {
    const dialog = $('project-dialog');
    if (dialog instanceof HTMLDialogElement && dialog.open) dialog.close();
    else dialog?.removeAttribute('open');
  });
  $('project-dialog-cancel')?.addEventListener('click', () => {
    const dialog = $('project-dialog');
    if (dialog instanceof HTMLDialogElement && dialog.open) dialog.close();
    else dialog?.removeAttribute('open');
  });
  $('project-name-input')?.addEventListener('input', (event) => {
    const slug = $('project-slug-input');
    if (!slug || slug.dataset.touched === '1') return;
    slug.value = projectSlugFromName(event.target?.value || '');
  });
  $('project-slug-input')?.addEventListener('input', (event) => {
    if (event.target) event.target.dataset.touched = '1';
  });
  $('project-dialog')?.addEventListener('cancel', (event) => {
    event.preventDefault();
    const dialog = $('project-dialog');
    if (dialog instanceof HTMLDialogElement && dialog.open) dialog.close();
  });
  const setSubmodule = (group, module) => {
    if (group === 'train') {
      setTrainModule(module);
    } else if (group === 'station') {
      setStationModule(module);
    }
  };
  document.querySelectorAll('[data-train-module-tab]').forEach((tab) => {
    tab.addEventListener('click', () => setSubmodule('train', tab.dataset.trainModuleTab || 'run'));
  });
  document.querySelectorAll('[data-station-module-tab]').forEach((tab) => {
    tab.addEventListener('click', () => setSubmodule('station', tab.dataset.stationModuleTab || 'telemetry'));
  });
  setSubmodule('train', state.trainModule);
  setSubmodule('station', 'devices');
  const openTrainStep = (step) => {
    if (step === 1) {
      setView('train');
      setSubmodule('train', 'contract');
      document.querySelector('#template-button')?.focus();
    } else if (step === 2) {
      // Replay is optional for RL. Step 2 opens training configuration directly.
      setView('train');
      setSubmodule('train', 'config');
      const controls = $('train-module-config');
      const panel = controls || $('training-profile') || $('local-run-button');
      panel?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      $('training-profile')?.focus();
    } else {
      setView('train');
      setSubmodule('train', 'run');
      const button = $('local-run-button');
      const panel = button?.closest('.train-panel') || button;
      panel?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (button && !button.disabled) button.focus();
      else {
        // The step remains actionable even when no runner is configured: guide the
        // operator to the training panel instead of making the card appear inert.
        button?.focus();
        showToast('请先在训练方式中登记或选择本地 / RoboGo worker。', 'normal');
      }
    }
  };
  document.querySelectorAll('[data-train-step]').forEach((step) => {
    const activate = () => {
      openTrainStep(Number(step.dataset.trainStep || 1));
      if (step.dataset.flowChild) setFlowChild(step.dataset.flowChild);
    };
    step.addEventListener('click', activate);
    step.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); }
    });
  });
  document.querySelectorAll('[data-flow-child]:not([data-train-step])').forEach((child) => {
    const activate = () => {
      setView(child.dataset.viewTarget || 'overview');
      const target = child.dataset.flowChild;
      const context = FLOW_CHILD_CONTEXTS[target];
      applyFlowChildDestination(context);
      setFlowChild(target);
    };
    child.addEventListener('click', activate);
    child.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); }
    });
  });
  $('training-engine')?.addEventListener('change', () => {
    renderEngineCapability();
  });
  renderEngineCapability();
  // G13 explicit preference: restore the last-used training profile and label
  // it; every change persists for the next visit. The saved value never
  // reaches the submit body on its own — the select stays the single source.
  const trainingProfileSelect = $('training-profile');
  if (trainingProfileSelect) {
    if (state.trainingProfile) {
      trainingProfileSelect.value = state.trainingProfile;
      const note = window.document.querySelector('[data-training-profile-note]');
      if (note) note.hidden = false;
    }
    trainingProfileSelect.addEventListener('change', () => {
      state.trainingProfile = trainingProfileSelect.value || '';
      saveWorkspaceContext();
    });
  }
  $('task-select')?.addEventListener('change', (event) => {
    const next = event.target.value;
    if (!ACTION_TASKS[next]) return;
    state.taskId = next;
    // Football tasks are owned by the platform football engine. Selecting one
    // in the workbench should prepare the matching engine automatically while
    // still allowing an operator to override it afterwards.
    if (next.startsWith('football-')) {
      const engine = $('training-engine');
      if (engine && (!engine.value || engine.value === 'starter-ppo')) {
        engine.value = 'microduck-football';
        renderEngineCapability();
      }
    }
    // Balance tasks are owned by the recurrent engine the same way: selecting
    // one prepares the matching engine without locking the operator in.
    if (next.startsWith('balance-')) {
      const engine = $('training-engine');
      if (engine && (!engine.value || engine.value === 'starter-ppo')) {
        engine.value = 'microduck-recurrent';
        renderEngineCapability();
      }
    }
    saveWorkspaceContext();
    try {
      window.localStorage?.setItem('rdk-duck-lab-task', next);
    } catch {
      // Preference persistence is optional in file:// and privacy contexts.
    }
    // Keep the selector responsive even when another dashboard panel fails to refresh.
    // The task is used by training payloads and the context panel can update independently.
    renderSelects();
    renderActionLibrary();
    showToast('当前动作任务：' + ACTION_TASKS[next].label, 'success');
    try { renderAll(); } catch (error) { console.warn('任务面板刷新失败，已保留当前动作：', error); }
  });
  document.querySelectorAll('[data-record-tab]').forEach((control) => {
    control.addEventListener('click', () => {
      setRecordsTab(control.dataset.recordTab || 'all');
    });
  });
  document.addEventListener('click', (event) => {
    const control = event.target instanceof Element ? event.target.closest('[data-workspace-view]') : null;
    if (!control) return;
    const view = control.dataset.workspaceView;
    if (view === 'contract') {
      setView('train');
      setTrainModule('contract');
      document.querySelector('#contract-fold')?.setAttribute('open', '');
      document.querySelector('#template-button')?.focus();
    } else if (view) setView(view);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const control = event.target instanceof Element ? event.target.closest('[data-workspace-view]') : null;
    if (!control || control instanceof HTMLButtonElement || control instanceof HTMLAnchorElement) return;
    event.preventDefault();
    control.click();
  });
  $('record-search')?.addEventListener('input', (event) => {
    state.recordsQuery = String(event.target.value || '');
    renderHistory();
  });
  document.querySelectorAll('[data-replay-task-link]').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      const task = ACTION_TASKS[state.taskId];
      const input = $('record-search');
      if (input && task) {
        input.value = task.label;
        state.recordsQuery = task.label;
      }
      setView('records');
      renderHistory();
    });
  });
  $('telemetry-file-input')?.addEventListener('change', importTelemetryFile);
  $('telemetry-demo-button')?.addEventListener('click', () => loadDemoTelemetry());
  $('telemetry-clear-button')?.addEventListener('click', clearTelemetry);
  $('telemetry-publish-button')?.addEventListener('click', () => publishTelemetry());
  $('replay-load-button')?.addEventListener('click', () => { void loadRunReplay(); });
  $('replay-play-button')?.addEventListener('click', toggleReplay);
  $('replay-stop-button')?.addEventListener('click', () => { state.replay.index = 0; stopReplay(); sendReplayFrame(); });
  $('replay-video-render')?.addEventListener('click', () => { void renderReplayVideo(); });
  $('replay-run-select')?.addEventListener('change', (event) => { state.replay.runId = String(event.target.value || ''); state.replay.loaded = false; state.replay.frames = []; state.replay.index = 0; stopReplay(); renderReplayPlayer(); });
  $('replay-speed-select')?.addEventListener('change', (event) => { state.replay.speed = Number(event.target.value || 1); if (state.replay.timer) { stopReplay(); toggleReplay(); } });
  $('replay-seek')?.addEventListener('input', (event) => { state.replay.index = Number(event.target.value || 0); sendReplayFrame(); });
  // 统一时间轴与逐帧回放共用 state.replay.index 作为唯一位置源：从任一控件
  // 拖动都会同时移动回放帧、三个画布的播放头和相机帧。回放播放器在
  // sendReplayFrame 里已重绘；这里补齐画布与相机侧。
  $('telemetry-scrub-input')?.addEventListener('input', (event) => {
    state.replay.index = Number(event.target.value || 0);
    sendReplayFrame();
  });
  $('policy-trial-button')?.addEventListener('click', startPolicyTrial);
  $('policy-trial-board')?.addEventListener('change', (event) => {
    const status = $('policy-trial-status');
    if (!status) return;
    if (event.target.checked !== true) {
      status.textContent = '在嵌入仿真器中用本机浏览器运行该策略的 ONNX 模型。';
      return;
    }
    status.textContent = '板端推理模式：正在读取板端策略运行时状态…';
    fetch(apiPath('/sim2real/board-station/policy'), { credentials: 'same-origin' })
      .then((response) => response.json())
      .then((payload) => {
        // Agent payloads historically nest the status under `policy`; accept
        // the flat shape too so either side may evolve independently.
        const policy = (payload && (payload.policy || payload)) || {};
        const model = policy.model || {};
        if (policy.state === 'ready' || policy.state === 'running') {
          status.textContent =
            `板端推理就绪：模型 ${String(model.path || '已加载').split('/').pop()}` +
            `（provider ${policy.provider || model.provider || 'cpu'}）——试跑动作将逐 tick 来自板端。`;
        } else {
          status.textContent = '板端策略运行时未就绪：请先在部署页上传并加载模型，再启用板端推理。';
        }
      })
      .catch(() => {
        status.textContent = '无法读取板端策略状态（agent 离线或未配置）。';
      });
  });
  $('policy-trial-stop')?.addEventListener('click', stopPolicyTrial);
  $('evaluation-next-button')?.addEventListener('click', (event) => {
    if (event.currentTarget?.dataset.action === 'import-telemetry') {
      event.preventDefault();
      $('telemetry-file-input')?.click();
    }
  });
  $('evaluation-empty-import')?.addEventListener('click', () => {
    $('telemetry-file-input')?.click();
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
    // A project can span several robot profiles. Keep it only when it links a
    // model for the newly selected product; otherwise return to the account
    // view rather than showing a misleading empty project context.
    const project = selectedProject();
    if (project?.modelIds?.length) {
      const productModelIds = new Set(
        (state.overview?.models || [])
          .filter((item) => item.manifest?.robot?.id === next)
          .map((item) => String(item.id)),
      );
      if (!project.modelIds.some((id) => productModelIds.has(String(id)))) state.projectId = '';
    }
    state.model = null;
    state.compatibility = [];
    state.activeDeployment = null;
    state.telemetry = null;
    stopReplay();
    state.replay = { runId: '', frames: [], index: 0, timer: null, speed: 1, loaded: false };
    saveWorkspaceContext();
    try {
      window.localStorage?.setItem('rdk-duck-lab-product', next);
    } catch {
      // Preference persistence is optional in file:// and privacy contexts.
    }
    renderAll();
    await loadOverview({ quiet: true });
    loadManifestTemplate();
    const nextProfile = PRODUCT_PROFILES[next];
    showToast(
      next === 'rdk-duck'
        ? '已切换到 RDK Duck；请导入或填写真实契约 manifest'
        : next === 'originbot'
          ? '已切换到 OriginBot；默认模板可直接开始仿真和训练'
          : '已切换到 MicroDuck 官方参考',
      'success',
    );
  });
  $('model-select')?.addEventListener('change', async (event) => {
    state.selectedModelId = event.target.value;
    state.activeDeployment = null;
    state.telemetry = state.telemetry?.modelId === state.selectedModelId ? state.telemetry : null;
    saveWorkspaceContext();
    renderAll();
    await loadModelDetails();
  });
  $('device-select')?.addEventListener('change', (event) => {
    state.selectedDeviceId = event.target.value;
    state.activeDeployment = null;
    saveWorkspaceContext();
    renderAll();
  });
  $('compute-resource-select')?.addEventListener('change', (event) => {
    state.selectedComputeResourceId = event.target.value;
    renderAll();
  });
  $('compute-resource-form')?.addEventListener('submit', saveComputeResource);
  $('compute-resource-cancel')?.addEventListener('click', resetComputeResourceForm);
  $('compute-resource-install')?.addEventListener('click', () => void showGpuAgentInstallCommand());
  $('compute-resource-autodetect')?.addEventListener('click', () => void autoDetectLocalGpuAgent());
  $('compute-resource-ssh-connect')?.addEventListener('click', () => void connectRemoteGpuThroughAgent());
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
  $('theme-toggle')?.addEventListener('click', toggleTheme);
  wireThemeSystemTracking();
  $('confirm-action-cancel')?.addEventListener('click', () => settleConfirmAction(false));
  $('confirm-action-approve')?.addEventListener('click', () => settleConfirmAction(true));
  const confirmActionDialog = $('confirm-action-dialog');
  confirmActionDialog?.addEventListener('cancel', (event) => {
    event.preventDefault();
    settleConfirmAction(false);
  });
  confirmActionDialog?.addEventListener('close', () => {
    if (state.confirmActionResolve) settleConfirmAction(false);
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

const COMMANDS = [
  { id: 'overview', label: '打开总览', hint: '查看项目进度与工作区状态 · ⌘1', view: 'overview' },
  { id: 'simulate', label: '开始仿真与录制', hint: '打开浏览器仿真 · ⌘2', view: 'simulate' },
  { id: 'train', label: '查看训练', hint: '选择模型与训练后端 · ⌘3', view: 'train' },
  { id: 'evaluate', label: '打开评测中心', hint: '查看指标与遥测证据 · ⌘4', view: 'evaluate' },
  { id: 'deploy', label: '准备部署', hint: '检查板卡与模型契约 · ⌘5', view: 'deploy' },
  { id: 'records', label: '查看运行记录', hint: '搜索 Run、部署与遥测 · ⌘6', view: 'records' },
  { id: 'station', label: '打开设备工作台', hint: '查看 X5 连接与只读诊断 · ⌘7', view: 'station' },
  { id: 'refresh', label: '刷新工作区', hint: '重新加载项目状态与设备信息', action: () => loadOverview() },
  { id: 'login', label: '登录工作区', hint: '登录以解锁训练记录与真机部署', action: () => window.open(state.publicHealth?.ssoLoginUrl || '/rdkstudio/', '_blank', 'noopener') },
  { id: 'agent', label: '呼出 Agent 助手', hint: '按当前阻塞项生成下一步计划', action: () => { if (typeof window.setAgentDrawerOpen === 'function') window.setAgentDrawerOpen(true); } },
  { id: 'onboarding', label: '重看新手指引', hint: '12 步走完整个平台', action: () => $('onboarding-help-button')?.click() },
];

// 窄屏侧栏抽屉。
// ≤1080px 时侧栏原本是 position:static 的整块，直接堆在正文上方：390×844
// 上顶栏+侧栏占掉 806px（首屏 95%），页面标题落在 y=1457。现在侧栏在窄屏
// 变成一个可开合的抽屉，正文回到首屏，导航由顶栏的开关按钮唤起。
const SIDEBAR_DRAWER_QUERY = '(max-width: 1080px)';
function sidebarDrawerAvailable() {
  return typeof window.matchMedia === 'function' && window.matchMedia(SIDEBAR_DRAWER_QUERY).matches;
}

function setSidebarDrawer(open, { restoreFocus = true } = {}) {
  const shell = document.querySelector('.app-shell');
  const toggle = $('sidebar-toggle');
  const backdrop = $('sidebar-backdrop');
  const sidebar = $('platform-sidebar');
  if (!shell || !toggle) return;
  const next = Boolean(open) && sidebarDrawerAvailable();
  shell.classList.toggle('is-sidebar-open', next);
  toggle.setAttribute('aria-expanded', next ? 'true' : 'false');
  toggle.setAttribute('aria-label', next ? '关闭导航菜单' : '打开导航菜单');
  toggle.title = next ? '关闭导航菜单' : '打开导航菜单';
  if (backdrop) backdrop.hidden = !next;
  // 抽屉打开时锁住页面滚动，否则在手机上滑动会同时滚动正文。
  document.body.classList.toggle('sidebar-drawer-open', next);
  if (next) {
    sidebar?.querySelector('.nav-item, button, a, select')?.focus({ preventScroll: true });
  } else if (restoreFocus && document.activeElement === toggle) {
    toggle.focus({ preventScroll: true });
  }
}

function closeSidebarDrawer(options) {
  setSidebarDrawer(false, options);
}

function wireSidebarDrawer() {
  const toggle = $('sidebar-toggle');
  const backdrop = $('sidebar-backdrop');
  if (!toggle) return;
  toggle.addEventListener('click', () => {
    const open = document.querySelector('.app-shell')?.classList.contains('is-sidebar-open');
    setSidebarDrawer(!open);
  });
  backdrop?.addEventListener('click', () => setSidebarDrawer(false));
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const open = document.querySelector('.app-shell')?.classList.contains('is-sidebar-open');
    if (open) {
      setSidebarDrawer(false);
      toggle.focus({ preventScroll: true });
    }
  });
  // 视口回到桌面宽度时抽屉必须失效，否则 .is-sidebar-open 会留在一个
  // 已经不需要它的布局上。
  const mq = typeof window.matchMedia === 'function' ? window.matchMedia(SIDEBAR_DRAWER_QUERY) : null;
  const onChange = (event) => {
    if (!event.matches) setSidebarDrawer(false, { restoreFocus: false });
  };
  if (mq) {
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
    else if (typeof mq.addListener === 'function') mq.addListener(onChange);
  }
}

// WAI-ARIA tabs 键盘约定。三个 tablist（登录方式 / 训练模块 / 设备控制台模块）
// 以前只支持鼠标点击：方向键无反应，而且 station 的 5 个 tab 全是 Tab 停靠点。
// 这里的 tab 都是"激活即切换"的本地面板，没有异步成本，所以方向键直接跟随激活。
function wireTablist(tablist) {
  const tabs = [...tablist.querySelectorAll('[role="tab"]')].filter((tab) => !tab.disabled);
  if (tabs.length < 2) return;
  tablist.addEventListener('keydown', (event) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    const current = tabs.indexOf(document.activeElement);
    let next = null;
    if (step) next = tabs[(current + step + tabs.length) % tabs.length];
    else if (event.key === 'Home') next = tabs[0];
    else if (event.key === 'End') next = tabs[tabs.length - 1];
    if (!next) return;
    event.preventDefault();
    next.focus();
    next.click();
  });
}

function wireTablists() {
  document.querySelectorAll('[role="tablist"]').forEach(wireTablist);
}

// 被 CSS 截断且没有 title 的文本，用户永远看不到完整内容。审查里最要命的
// 两例：「项目列表暂不可用 · 点击"重新连接"重试」在桌面端被截到 68px，正好
// 把"怎么恢复"整段藏掉；运行卡住的解释句在 289px 容器里装 831px 文本。
// 这里只在元素确实被截断（scrollWidth > clientWidth）时补 title，不碰布局，
// 所以对"本来就想省略"的场景也没有副作用。debounce + 变更观察，避免每次
// 轮询渲染都同步扫一遍 DOM。
function syncTruncationTitles(root = document) {
  for (const scope of ['#main-content', '.sidebar', '.context-strip', '.topbar']) {
    const host = root.querySelector(scope);
    if (!host) continue;
    for (const el of host.querySelectorAll('*')) {
      // 便宜的存在性检查放在前面：绝大多数元素没有溢出。
      if (el.clientWidth <= 4 || el.scrollWidth <= el.clientWidth + 2) continue;
      if (![...el.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim().length > 1)) continue;
      if (el.classList.contains('sr-only')) continue;
      const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
      if (!text) continue;
      if (el.getAttribute('title') !== text) el.setAttribute('title', text);
    }
  }
}
let truncationTimer = 0;
function scheduleTruncationTitles() {
  window.clearTimeout(truncationTimer);
  truncationTimer = window.setTimeout(() => {
    truncationTimer = 0;
    syncTruncationTitles();
  }, 220);
}

function wireTopMenu() {
  const button = $('top-menu-button');
  const list = $('top-menu-list');
  if (!button || !list) return;
  const setOpen = (open) => {
    list.hidden = !open;
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  button.addEventListener('click', () => {
    setOpen(list.hidden);
  });
  list.addEventListener('click', (event) => {
    // A menu action was taken; collapse so the topbar stays quiet.
    if (event.target instanceof Element && event.target.closest('.top-menu-item')) setOpen(false);
  });
  document.addEventListener('click', (event) => {
    if (list.hidden) return;
    if (event.target instanceof Element && event.target.closest('[data-top-menu]')) return;
    setOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !list.hidden) setOpen(false);
  });
  // WAI-ARIA menu 约定：方向键在菜单项之间移动，Home/End 跳首尾。菜单项本身是
  // 可聚焦的 <button>/<a>，所以这里只负责移动焦点，不改动激活语义。
  list.addEventListener('keydown', (event) => {
    const items = [...list.querySelectorAll('.top-menu-item')].filter((el) => !el.disabled);
    if (items.length < 2) return;
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    const current = items.indexOf(document.activeElement);
    let next = null;
    if (step) next = items[(current + step + items.length) % items.length];
    else if (event.key === 'Home') next = items[0];
    else if (event.key === 'End') next = items[items.length - 1];
    if (!next) return;
    event.preventDefault();
    next.focus();
  });
  // opening the menu with the keyboard should land on the first item
  button.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    setOpen(true);
    const items = [...list.querySelectorAll('.top-menu-item')];
    (event.key === 'ArrowDown' ? items[0] : items[items.length - 1])?.focus();
  });
}

function wireCommandPalette() {
  const dialog = $('command-palette');
  const input = $('command-palette-input');
  const list = $('command-palette-list');
  if (!dialog || !input || !list) return;
  let activeIndex = 0;
  const render = () => {
    const query = input.value.trim().toLowerCase();
    const matches = COMMANDS.filter((command) => `${command.label} ${command.hint}`.toLowerCase().includes(query));
    activeIndex = Math.max(0, Math.min(activeIndex, matches.length - 1));
    list.replaceChildren();
    if (!matches.length) {
      list.innerHTML = '<div class="command-palette-empty">没有匹配的操作</div>';
      input.removeAttribute('aria-activedescendant');
      return;
    }
    matches.forEach((command, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = `command-palette-option-${index}`;
      button.className = 'command-palette-item' + (index === activeIndex ? ' is-active' : '');
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', index === activeIndex ? 'true' : 'false');
      // listbox 的约定是：焦点留在输入框上，用 aria-activedescendant 播报
      // 当前项。以前每个 option 都是 <button>，于是 12 个命令各自变成一个
      // Tab 停靠点，而且方向键移动时读屏完全不知道选中项变了。
      button.tabIndex = -1;
      button.innerHTML = `<span class="command-palette-item-icon">${command.view ? '↗' : '↻'}</span><span><strong>${escapeHtml(command.label)}</strong><small>${escapeHtml(command.hint)}</small></span><kbd>${command.view ? '打开' : '执行'}</kbd>`;
      button.addEventListener('click', () => executeCommand(command));
      list.append(button);
    });
    // 让输入框把"当前高亮项"暴露给辅助技术。
    input.setAttribute('aria-activedescendant', `command-palette-option-${activeIndex}`);
  };
  const open = () => {
    input.value = '';
    activeIndex = 0;
    render();
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    window.requestAnimationFrame(() => input.focus());
  };  const close = () => {
    if (typeof dialog.close === 'function' && dialog.open) dialog.close();
    else dialog.removeAttribute('open');
  };
  const executeCommand = (command) => {
    close();
    if (command.view) setView(command.view);
    else command.action?.();
  };
  $('command-palette-close')?.addEventListener('click', close);
  dialog.addEventListener('click', (event) => { if (event.target === dialog) close(); });
  input.addEventListener('input', () => { activeIndex = 0; render(); });
  input.addEventListener('keydown', (event) => {
    const query = input.value.trim().toLowerCase();
    const matches = COMMANDS.filter((command) => `${command.label} ${command.hint}`.toLowerCase().includes(query));
    if (event.key === 'ArrowDown') { event.preventDefault(); activeIndex = Math.min(activeIndex + 1, Math.max(0, matches.length - 1)); render(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); activeIndex = Math.max(0, activeIndex - 1); render(); }
    else if (event.key === 'Enter' && matches[activeIndex]) { event.preventDefault(); executeCommand(matches[activeIndex]); }
  });
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); open(); }
  });
  // 顶栏可见触发按钮：⌘K 不能只藏在键盘里——专业工具的入口必须可见。
  $('command-palette-trigger')?.addEventListener('click', () => open());
}

// ⌘1–⌘7 直接切视图（与命令面板 hint 里的编号一致）。
function wireViewShortcuts() {
  document.addEventListener('keydown', (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    const index = Number(event.key);
    if (!Number.isInteger(index) || index < 1 || index > WORKFLOW_VIEWS.length) return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    event.preventDefault();
    setView(WORKFLOW_VIEWS[index - 1]);
  });
}

wireEvents();
wireViewShortcuts();
syncNotifyToggle();
syncThemeToggle();
connectEventStream();
// Boot view restore: no push, no focus grab, no announcement — it is the
// first paint, not a navigation.
const initialLocation = parseHashLocation();
setView(initialLocation.view, { updateHash: false, focus: false });
if (initialLocation.child) {
  applyFlowChildDestination(FLOW_CHILD_CONTEXTS[initialLocation.child]);
  setFlowChild(initialLocation.child, { updateHash: false, focus: false });
}
// Render the product boundary immediately, even while the account-scoped
// overview request is still loading (important when RDK Duck was selected in
// a previous session).
renderAll();
// Seed the editor silently on first paint; a toast here would obscure the
// landing view before the operator has taken an action.
loadManifestTemplate({ notify: false });
loadOverview();
loadWorkspaceNotices({ force: true });
// Re-check hook for long sessions and tests: the overview cycle re-fetches
// notices only on its own cadence, so an explicit nudge (server restart
// during a demo, or the spec harness) bypasses the cooldown deterministically.
window.addEventListener('sim2real-refetch-notices', () => {
  void loadWorkspaceNotices({ force: true });
});
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
