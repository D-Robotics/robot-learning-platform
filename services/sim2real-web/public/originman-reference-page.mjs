import { mountOriginmanMotion } from './originman-motion-editor.mjs';
import { readOriginmanNpz } from './originman-reference-npz.mjs';
import {
  composeOriginmanReference, MAX_REFERENCE_CLIPS,
} from './originman-reference-compose.mjs';

const byId = (id) => document.getElementById(id);
const worker = byId('reference-worker');
const envs = byId('reference-envs');
const status = byId('reference-status');
const error = byId('reference-error');
const submit = byId('reference-submit');
const file = byId('reference-file');
const appendFile = byId('reference-append');
const speedSelect = byId('reference-speed');
const exportButton = byId('reference-export');
const checkWorker = byId('reference-worker-check');
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
const failedScreenings = new Set();
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

function setError(message = '') {
  error.textContent = message;
  error.hidden = !message;
}

const query = new URLSearchParams(location.search);
const motion = mountOriginmanMotion({ api, changed: refresh, initialMode: query.get('mode') });
if (query.get('budget') === 'formal') byId('reference-steps').value = '503808';

function refresh() {
  const editing = submitting || preparing || Boolean(screening);
  const uploaded = motion.isUpload();
  const failed = uploaded && currentScreeningFailed();
  const ready = uploaded ? Boolean(trajectory) : Boolean(motion.submission());
  submit.disabled = editing || checking || !ready || !selectedWorkerReady() || failed;
  motion.setLocked(editing || checking);
  byId('reference-screen-blocker').hidden = !failed;
  file.disabled = editing || !calibration;
  appendFile.disabled = editing || !clips.length || clips.length >= MAX_REFERENCE_CLIPS;
  speedSelect.disabled = editing || !clips.length;
  exportButton.disabled = editing || !trajectory;
  exampleButton.disabled = editing || !example;
  exampleDownload.disabled = !example;
  worker.disabled = submitting || checking || Boolean(screening);
  checkWorker.disabled = worker.disabled || !worker.value;
  screenCurrent.disabled = editing || checking || !trajectory || !selectedWorkerReady();
  screenFiles.disabled = editing || checking || !selectedWorkerReady();
  screenCancel.hidden = !screening;
  envs.disabled = submitting;
  byId('reference-steps').disabled = submitting;
}

function selectedWorkerReady() {
  return resources.some(({ id, ready }) => id === worker.value && ready);
}

function currentScreeningFailed() {
  return trajectory && failedScreenings.has(worker.value + '/' + trajectoryDigest);
}

function showWorkerHint() {
  workerHint.textContent = !resources.length
    ? '当前账号未登记支持跟跳的 Worker。可先导入轨迹，在工作台的「执行资源」中配置算力。'
    : selectedWorkerReady()
      ? '已通过连接检查，可以提交仿真训练。'
      : '选择 Worker 后检查连接，确认支持参考轨迹跟跳。';
}

async function loadWorkers(selection) {
  const { computeResources } = await api('compute-resources');
  resources = computeResources
    .filter(({ source, mock, engines }) => source !== 'local-agent' && mock !== true &&
      (!engines?.length || engines.includes('originman-reference-ppo')))
    .map(({ id, name, status, mock, cuda, engines }) => ({
      id, name, cuda,
      ready: status === 'online' && mock === false && engines?.includes('originman-reference-ppo'),
    }));
  worker.replaceChildren(new Option('请选择', ''));
  for (const value of resources) {
    const option = new Option(value.name + (value.ready ? ' · 可用' : ' · 待检查'), value.id);
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
  setError();
  status.textContent = '正在校验关节顺序、频率和角度范围。';
  refresh();
  try {
    const nextClips = await load();
    const value = composeOriginmanReference(nextClips, nextSpeed, calibration.robot.jointOrder, calibration.trajectory);
    const receipt = await api('originman-reference/validate', { trajectory: value });
    clips = nextClips;
    speed = nextSpeed;
    trajectory = value;
    trajectoryDigest = receipt.referenceSha256;
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
    setError(cause.message);
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
checkWorker.addEventListener('click', async () => {
  if (!worker.value || checking || submitting) return;
  const selection = worker.value;
  checking = true;
  workerHint.textContent = '正在检查所选 Worker。';
  refresh();
  try {
    const result = await api('compute-resources/' + encodeURIComponent(selection) + '/test', {});
    await loadWorkers(selection);
    if (!selectedWorkerReady()) {
      workerHint.textContent = result.connected
        ? 'Worker 已连接，跟跳引擎还不可用。请在执行资源中核对引擎配置。'
        : result.diagnostic?.message || 'Worker 连接失败，请检查执行资源配置。';
    }
  } catch (cause) {
    resources = resources.map((resource) => resource.id === selection ? { ...resource, ready: false } : resource);
    workerHint.textContent = cause.message;
  } finally {
    checking = false;
    refresh();
  }
});

async function readClip(incoming) {
  if (incoming.size > 16 * 1024 * 1024) throw Error('参考文件大小不能超过 16 MiB。');
  const value = /\.npz$/i.test(incoming.name)
    ? await readOriginmanNpz(await incoming.arrayBuffer())
    : JSON.parse(await incoming.text());
  return { value, label: incoming.name };
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
        const value = await load();
        const { result } = await api('originman-reference/screen', {
          computeResourceId, trajectory: value,
        }, undefined, controller.signal);
        const key = computeResourceId + '/' + result.referenceSha256;
        if (result.passed) failedScreenings.delete(key);
        else failedScreenings.add(key);
        if (result.passed) passed++;
        const failure = result.firstFailedFrame === null ? '' : `，首个失败帧 ${result.firstFailedFrame}`;
        const detail = document.createElement('small');
        detail.textContent = `参考 SHA-256 ${result.referenceSha256}`;
        row.textContent = `${label} · ${result.passed ? '通过' : '未通过'}，${result.framesEvaluated}/${result.framesExpected} 帧，峰值倾角 ${result.maxTiltDeg.toFixed(2)}°${failure}。 `;
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
  { label: '当前轨迹', load: () => trajectory },
]));
screenFiles.addEventListener('change', () => {
  const files = Array.from(screenFiles.files);
  screenFiles.value = '';
  void screenBatch(files.map((incoming) => ({ label: incoming.name, load: async () => (await readClip(incoming)).value })));
});
screenCancel.addEventListener('click', () => screening?.abort());

byId('reference-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const reference = motion.isUpload() ? (trajectory && { trajectory }) : motion.submission();
  if (submitting || checking || preparing || screening || !selectedWorkerReady() || !reference ||
      (motion.isUpload() && currentScreeningFailed())) return;
  submitting = true;
  refresh();
  setError();
  const computeResourceId = worker.value;
  const trainingSteps = Number(byId('reference-steps').value);
  const numEnvs = Number(envs.value);
  const key = JSON.stringify([computeResourceId, trainingSteps, numEnvs,
    reference.composition, reference.expectedTrajectorySha256 ?? trajectoryDigest]);
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
    setError(cause.message);
  } finally {
    submitting = false;
    refresh();
  }
});

try {
  const setup = await api('originman-reference');
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
  setError(cause.message);
}
refresh();

void motion.start();
