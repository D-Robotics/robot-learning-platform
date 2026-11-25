import { mountOriginmanMotion } from './originman-motion-editor.mjs?v=10';
import { readOriginmanNpz } from './originman-reference-npz.mjs';
import {
  composeOriginmanReference, MAX_REFERENCE_CLIPS,
} from './originman-reference-compose.mjs?v=2';

const byId = (id) => document.getElementById(id);
const worker = byId('reference-worker');
const envs = byId('reference-envs');
const steps = byId('reference-steps');
const budgetHint = byId('reference-budget-hint');
const status = byId('reference-status');
const error = byId('reference-error');
const trainingError = byId('reference-training-error');
const submit = byId('reference-submit');
const file = byId('reference-file');
const appendFile = byId('reference-append');
const speedSelect = byId('reference-speed');
const exportButton = byId('reference-export');
const checkWorker = byId('reference-worker-check');
const refreshWorkers = byId('reference-worker-refresh');
const workerHint = byId('reference-worker-hint');
const screenCurrent = byId('reference-screen-current');
const screenFiles = byId('reference-screen-files');
const screenCancel = byId('reference-screen-cancel');
const screenStatus = byId('reference-screen-status');
const screenResults = byId('reference-screen-results');
const exampleButton = byId('reference-example');
const exampleDownload = byId('reference-example-download');
let example;
let calibration;
let clips = [];
let speed = 1;
let trajectory;
let trajectoryDigest;
const screenings = new Map();
let displayedScreenKey;
let attempt;
let preparing = false;
let checking = false;
let submitting = false;
let screening;
let resources = [];

async function api(path, body, idempotencyKey, signal) {
  const response = await fetch(new URL('./api/v1/duck/' + path, location.href), {
    credentials: 'same-origin', cache: 'no-store', signal,
    ...(body && { method: 'POST', body: JSON.stringify(body) }),
    headers: {
      accept: 'application/json',
      ...(body && { 'content-type': 'application/json' }),
      ...(idempotencyKey && { 'Idempotency-Key': idempotencyKey }),
      ...(path === 'runs' && { 'X-RDK-Reference-Trajectory': '1' }),
    },
  });
  const value = await response.json().catch(() => null);
  if (!response.ok || !value?.ok) {
    if (response.status === 401) throw Error('请先登录机器人学习平台，再刷新此页。');
    if (response.status === 413) throw Error('轨迹超过上传容量上限，请拆成更短的片段。');
    throw Error(value?.message || value?.error?.message || '暂时无法连接任务服务，请重试。');
  }
  return value;
}

function showError(target, message = '') {
  target.textContent = message;
  target.hidden = !message;
}

const query = new URLSearchParams(location.search);
const motion = mountOriginmanMotion({ api, changed: refresh, initialMode: query.get('mode') });
if (query.get('budget') === 'formal') steps.value = '503808';
byId('reference-mode').addEventListener('change', (event) => {
  const url = new URL(location.href);
  if (motion.isUpload()) url.searchParams.delete('mode');
  else url.searchParams.set('mode', event.target.value);
  history.replaceState(history.state, '', url);
});

function currentReference() {
  return motion.isUpload() ? (trajectory && { trajectory }) : motion.submission();
}

function screeningKey(computeResourceId, digest, stanceProfile) {
  return computeResourceId && digest ? [computeResourceId, digest, stanceProfile ?? 'default'].join('/') : '';
}

function currentScreenKey() {
  if (motion.isUpload()) return screeningKey(worker.value, trajectoryDigest);
  const selected = motion.submission();
  return screeningKey(worker.value, selected?.expectedTrajectorySha256, selected?.expectedStanceProfile);
}

function showBudgetHint() {
  const frames = motion.isUpload() ? trajectory?.joint_pos.length : motion.previewFrames();
  budgetHint.hidden = !frames;
  if (!frames) {
    budgetHint.textContent = '';
    return;
  }
  const stepsPerEnv = Number(steps.value) / Number(envs.value);
  const repeats = Math.floor(stepsPerEnv / frames);
  const estimate = repeats
    ? `按每个并行环境折算，步数约够 ${repeats.toLocaleString('zh-CN')} 支完整轨迹。`
    : '按每个并行环境折算，步数不足一支完整轨迹。增加预算或减少并行环境可延长每个环境的训练。';
  budgetHint.textContent = estimate + '每次评测从第一帧开始，尝试跑完整支。';
}

function refresh() {
  const editing = submitting || preparing || Boolean(screening);
  const uploaded = motion.isUpload();
  const ready = Boolean(currentReference());
  const key = currentScreenKey();
  const passed = screenings.get(key);
  const failed = passed === false;
  const needsScreen = !uploaded && ready && passed !== true;
  submit.disabled = editing || checking || !ready || !selectedWorkerReady() || failed || needsScreen;
  submit.textContent = submitting ? '正在提交…' : '开始仿真训练';
  if (!screening && displayedScreenKey !== key) {
    screenResults.replaceChildren();
    screenStatus.textContent = passed === true ? '当前轨迹已在所选 Worker 通过筛查。'
      : failed ? '当前轨迹曾未通过筛查，请调整后复查。' : '';
    displayedScreenKey = key;
  }
  const blocker = byId('reference-screen-blocker');
  blocker.hidden = !failed && !(needsScreen && selectedWorkerReady());
  blocker.textContent = failed
    ? '当前轨迹未通过所选 Worker 的筛查。请调整轨迹或重新筛查后再提交。'
    : '预置和自由编排需在所选 Worker 通过筛查后才能提交。';
  motion.setLocked(editing || checking);
  file.disabled = editing || !calibration;
  appendFile.disabled = editing || !clips.length || clips.length >= MAX_REFERENCE_CLIPS;
  speedSelect.disabled = editing || !clips.length;
  exportButton.disabled = editing || !trajectory;
  exampleButton.disabled = editing || !example;
  exampleDownload.disabled = !example;
  worker.disabled = submitting || checking || Boolean(screening);
  checkWorker.disabled = worker.disabled || !worker.value;
  refreshWorkers.disabled = worker.disabled;
  screenCurrent.disabled = editing || checking || !ready || !selectedWorkerReady();
  screenFiles.disabled = editing || checking || !calibration || !selectedWorkerReady();
  screenCancel.hidden = !screening;
  envs.disabled = submitting;
  steps.disabled = submitting;
  showBudgetHint();
}

function selectedWorkerReady() {
  return resources.some(({ id, ready }) => id === worker.value && ready);
}

function showWorkerHint() {
  const selected = resources.find(({ id }) => id === worker.value);
  if (!resources.length) {
    workerHint.textContent = '当前账号未找到支持本课程的算力。可在工作台的「执行资源」中核对。';
  } else if (!selected?.ready) {
    workerHint.textContent = '选择算力并检查连接，确认支持参考轨迹训练。';
  } else if (selected.activeJobs >= selected.maxConcurrentJobs && selected.maxConcurrentJobs > 0) {
    workerHint.textContent = '所选算力的运行名额已满，提交后将在这张卡上排队。';
  } else {
    workerHint.textContent = '算力已连接，可以筛查当前轨迹。负载为最近一次查询的快照。';
  }
}

async function loadWorkers(selection) {
  const { computeResources } = await api('compute-resources');
  resources = computeResources
    .filter(({ source, mock, engines }) => source !== 'local-agent' && mock !== true &&
      (!engines?.length || engines.includes('originman-reference-ppo')))
    .map(({ id, name, status, mock, cuda, engines, activeJobs, maxConcurrentJobs, queuedJobs }) => ({
      id, name, cuda, activeJobs, maxConcurrentJobs, queuedJobs,
      ready: status === 'online' && mock === false && engines?.includes('originman-reference-ppo'),
    }));
  worker.replaceChildren(new Option('请选择', ''));
  for (const value of resources) {
    const measured = value.ready && Number.isInteger(value.activeJobs) && value.maxConcurrentJobs > 0;
    const state = measured ? `运行 ${value.activeJobs}/${value.maxConcurrentJobs}` : value.ready ? '可用' : '待检查';
    const queue = value.ready && Number.isInteger(value.queuedJobs) ? ` · 排队 ${value.queuedJobs}` : '';
    const option = new Option(`${value.name} · ${state}${queue}`, value.id);
    option.dataset.cuda = String(value.cuda === true);
    worker.append(option);
  }
  if (resources.some(({ id }) => id === selection)) worker.value = selection;
  else if (resources.length === 1) worker.value = resources[0].id;
  if (worker.value !== selection) worker.dispatchEvent(new Event('change'));
  else showWorkerHint();
}

function showCalibration(calibration) {
  const { robot, source } = calibration;
  byId('reference-calibration').textContent =
    `资料来自 ${source.name}（${source.date}）。本体 20 关节，18 路舵机，参考质量 ${robot.massKg} kg。PWM 比例仍待逐关节实测。`;
  const labels = { measured: '原包实测', 'mirror-inferred': '镜像推断', unmeasured: '待实测' };
  const rows = robot.jointOrder.map((joint, index) => {
    const info = calibration.servoMap.find((value) => value.joint === joint);
    const row = document.createElement('tr');
    for (const value of [index + 1, joint, info?.servo ?? info?.channel ?? '—', info?.pwm_zero ?? '—', info?.sign ?? '待测', labels[info?.evidence] ?? '待核对']) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    return row;
  });
  byId('reference-joints').replaceChildren(...rows);
}

async function selectTrajectory(load, nextSpeed) {
  if (preparing || submitting) return;
  preparing = true;
  showError(error);
  status.textContent = '正在校验关节顺序、频率和角度范围。';
  refresh();
  try {
    const nextClips = await load();
    const value = composeOriginmanReference(nextClips, nextSpeed, calibration.robot.jointOrder, calibration.trajectory);
    const receipt = await api('originman-reference/validate', { trajectory: value });
    clips = nextClips;
    speed = nextSpeed;
    trajectory = value;
    trajectoryDigest = receipt.trajectorySha256 ?? receipt.referenceSha256;
    attempt = undefined;
    const list = byId('reference-clips');
    list.replaceChildren(...clips.map(({ label }) => {
      const item = document.createElement('li');
      item.textContent = label;
      return item;
    }));
    const label = clips.length === 1 ? clips[0].label : `${clips.length} 个拼接片段`;
    status.textContent = `${label} · ${speed} 倍速，通过格式校验，${receipt.frames} 帧，${receipt.durationSeconds} 秒，${receipt.fps} Hz。提交后先做物理仿真筛查。`;
  } catch (cause) {
    status.textContent = trajectory ? '已保留上次通过校验的轨迹。' : '请重新导入参考轨迹。';
    showError(error, cause.message);
  } finally {
    preparing = false;
    speedSelect.value = String(speed);
    refresh();
  }
}

worker.addEventListener('change', () => {
  envs.value = worker.selectedOptions[0]?.dataset.cuda === 'true' ? '64' : '1';
  showWorkerHint();
  refresh();
});
steps.addEventListener('change', showBudgetHint);
envs.addEventListener('change', showBudgetHint);
async function updateWorkers(testConnection) {
  if (checking || submitting || screening || (testConnection && !worker.value)) return;
  const selection = worker.value;
  checking = true;
  workerHint.textContent = testConnection ? '正在检查所选算力。' : '正在刷新算力负载。';
  refresh();
  try {
    const result = testConnection
      ? await api('compute-resources/' + encodeURIComponent(selection) + '/test', {})
      : undefined;
    await loadWorkers(selection);
    if (result && !selectedWorkerReady()) {
      workerHint.textContent = result.connected
        ? 'Worker 已连接，跟跳引擎还不可用。请在执行资源中核对引擎配置。'
        : result.diagnostic?.message || 'Worker 连接失败，请检查执行资源配置。';
    }
  } catch (cause) {
    if (testConnection) {
      resources = resources.map((resource) => resource.id === selection ? { ...resource, ready: false } : resource);
    }
    workerHint.textContent = testConnection ? cause.message : '无法刷新负载，已保留上次查询结果。';
  } finally {
    checking = false;
    refresh();
  }
}
checkWorker.addEventListener('click', () => void updateWorkers(true));
refreshWorkers.addEventListener('click', () => void updateWorkers(false));

async function readClip(incoming) {
  if (incoming.size > 16 * 1024 * 1024) throw Error('参考文件大小不能超过 16 MiB。');
  const isNpz = /\.npz$/i.test(incoming.name);
  const value = isNpz
    ? await readOriginmanNpz(await incoming.arrayBuffer())
    : JSON.parse(await incoming.text());
  return { value, label: incoming.name, float32: isNpz };
}

function readSelection(input, append) {
  const incoming = input.files[0];
  if (!incoming) return;
  input.value = '';
  void selectTrajectory(async () => [...(append ? clips : []), await readClip(incoming)], append ? speed : 1);
}

file.addEventListener('change', () => readSelection(file, false));
appendFile.addEventListener('change', () => readSelection(appendFile, true));
speedSelect.addEventListener('change', () => void selectTrajectory(() => clips, Number(speedSelect.value)));
exampleButton.addEventListener('click', () => {
  void selectTrajectory(() => [{ value: example, label: '示例摆臂' }], 1);
});
function downloadReference(value, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
exampleDownload.addEventListener('click', () => downloadReference(example, 'originman-reference-example.json'));
exportButton.addEventListener('click', () => downloadReference(trajectory, 'originman-reference-prepared.json'));

async function screenBatch(entries) {
  if (screening || preparing || submitting || checking || !selectedWorkerReady()) return;
  if (entries.length > MAX_REFERENCE_CLIPS) {
    screenStatus.textContent = '每次最多筛查 8 个文件。';
    return;
  }
  if (!entries.length) return;
  const controller = new AbortController();
  screening = controller;
  const computeResourceId = worker.value;
  let passed = 0;
  let tested = 0;
  screenResults.replaceChildren();
  refresh();
  try {
    for (const { label, load } of entries) {
      if (controller.signal.aborted) break;
      screenStatus.textContent = `正在筛查第 ${tested + 1} / ${entries.length} 项。`;
      const row = document.createElement('li');
      try {
        const reference = await load();
        const { result } = await api('originman-reference/screen', {
          computeResourceId, ...reference,
        }, undefined, controller.signal);
        const digest = result.trajectorySha256 ?? result.referenceSha256;
        if (reference.expectedTrajectorySha256 && digest !== reference.expectedTrajectorySha256)
          throw Error('筛查轨迹与当前预览不一致，请重新预览。');
        if (reference.expectedStanceProfile && result.stanceProfile !== reference.expectedStanceProfile)
          throw Error('筛查站姿与当前预览不一致，请重新预览。');
        screenings.set(screeningKey(computeResourceId, digest, result.stanceProfile), result.passed);
        if (result.passed) passed++;
        const location = result.failureLocation;
        const block = location?.blockNumber ? `，第 ${location.blockNumber} 段（${location.motionId}）`
          : location?.fromBlockNumber
            ? `，第 ${location.fromBlockNumber} 段（${location.fromMotionId}）到第 ${location.toBlockNumber} 段（${location.toMotionId}）的过渡`
            : location?.betweenBlocks ? '，发生在两段过渡处' : '';
        const failure = result.firstFailedFrame == null ? '' : `，首个失败帧 ${result.firstFailedFrame}${block}`;
        const violation = result.limitViolation;
        if (violation) {
          row.textContent = `${label} · 未通过${failure}。${violation.joint} 目标角 ${violation.targetRad.toFixed(3)} rad，允许 ${violation.minRad.toFixed(3)} 至 ${violation.maxRad.toFixed(3)} rad，共 ${violation.framesOutside} 帧超限。`;
        } else {
          row.textContent = `${label} · ${result.passed ? '通过' : '未通过'}，${result.framesEvaluated}/${result.framesExpected} 帧，峰值倾角 ${result.maxTiltDeg.toFixed(2)}°${failure}。`;
          const reasons = result.failure;
          if (reasons?.nonFootContacts?.length) {
            row.textContent += `非足底碰撞体触地（${reasons.nonFootContacts.join('、')}）。`;
          }
          if (reasons?.tilt) {
            row.textContent += `失败帧倾角 ${reasons.tilt.actualDeg.toFixed(2)}°，达到 ${reasons.tilt.limitDeg.toFixed(2)}° 上限。`;
          }
          if (reasons?.height) {
            row.textContent += `机身高度 ${reasons.height.actualM.toFixed(3)} m，低于 ${reasons.height.limitM.toFixed(3)} m。`;
          }
        }
        const detail = document.createElement('small');
        detail.textContent = ` 训练轨迹 SHA-256 ${digest}`;
        row.append(detail);
      } catch (cause) {
        if (controller.signal.aborted) break;
        row.textContent = `${label} · ${cause.message}`;
      }
      tested++;
      screenResults.append(row);
    }
    screenStatus.textContent = `${controller.signal.aborted ? '筛查已取消，' : ''}已返回 ${tested}/${entries.length} 项，通过 ${passed} 项。`;
  } finally {
    screening = undefined;
    refresh();
  }
}

screenCurrent.addEventListener('click', () => void screenBatch([
  { label: '当前轨迹', load: currentReference },
]));
screenFiles.addEventListener('change', () => {
  const files = Array.from(screenFiles.files);
  screenFiles.value = '';
  void screenBatch(files.map((incoming) => ({
    label: incoming.name,
    load: async () => ({
      trajectory: composeOriginmanReference(
        [await readClip(incoming)], 1, calibration.robot.jointOrder, calibration.trajectory,
      ),
    }),
  })));
});
screenCancel.addEventListener('click', () => screening?.abort());

byId('reference-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const reference = currentReference();
  const passed = screenings.get(currentScreenKey());
  if (submitting || checking || preparing || screening || !selectedWorkerReady() || !reference ||
      passed === false || (!motion.isUpload() && passed !== true)) return;
  submitting = true;
  refresh();
  showError(trainingError);
  const computeResourceId = worker.value;
  const trainingSteps = Number(steps.value);
  const numEnvs = Number(envs.value);
  const key = JSON.stringify([computeResourceId, trainingSteps, numEnvs,
    reference.composition, reference.expectedTrajectorySha256 ?? trajectoryDigest, reference.expectedStanceProfile]);
  if (!attempt || attempt.key !== key) attempt = { key, id: crypto.randomUUID() };
  try {
    const { modelId } = await api('originman-reference/model', { computeResourceId });
    const result = await api('runs', {
      requestedVia: 'workbench', modelId, computeResourceId, backend: 'local',
      taskId: 'originman-reference-track', label: 'OriginMan · 参考轨迹跟跳',
      training: {
        profile: trainingSteps === 8192 ? 'smoke' : 'standard', algorithm: 'ppo',
        engine: 'originman-reference-ppo', video: true, maxIterations: trainingSteps / 4096, numEnvs,
        originmanReference: { ...reference, trainingSteps, seed: 7 },
      },
    }, attempt.id);
    const runId = result.run?.id;
    if (!/^[\w.-]{1,120}$/.test(runId ?? '')) throw Error('平台未返回 Run ID。请保留本页再试。');
    const url = new URL('./originman-reference-run.html', location.href);
    url.searchParams.set('runId', runId);
    location.assign(url.href);
  } catch (cause) {
    showError(trainingError, cause.message);
  } finally {
    submitting = false;
    refresh();
  }
});

let draftScope;
try {
  const setup = await api('originman-reference');
  draftScope = setup.draftScope;
  example = setup.example;
  calibration = setup.calibration;
  showCalibration(calibration);
  status.textContent = '请选择文件或加载示例。';
  try {
    await loadWorkers(query.get('computeResourceId'));
  } catch (cause) {
    workerHint.textContent = cause.message;
  }
} catch (cause) {
  status.textContent = '任务配置读取失败。';
  showError(trainingError, cause.message);
}
refresh();

void motion.start(draftScope);
