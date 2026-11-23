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
const exampleButton = byId('reference-example');
const exampleDownload = byId('reference-example-download');
let example;
let calibration;
let clips = [];
let speed = 1;
let trajectory;
let attempt;
let preparing = false;
let checking = false;
let submitting = false;
let resources = [];

async function api(path, body, idempotencyKey) {
  const response = await fetch(new URL('./api/v1/duck/' + path, location.href), {
    credentials: 'same-origin', cache: 'no-store',
    ...(body && { method: 'POST', body: JSON.stringify(body) }),
    headers: {
      accept: 'application/json',
      ...(body && { 'content-type': 'application/json' }),
      ...(idempotencyKey && { 'Idempotency-Key': idempotencyKey }),
    },
  });
  const value = await response.json().catch(() => null);
  if (!response.ok || !value?.ok) {
    if (response.status === 401) throw Error('请先登录机器人学习平台，再刷新此页。');
    if (response.status === 413) throw Error('轨迹超过当前请求的 2 MB 上限，请拆成更短的片段。');
    throw Error(value?.message || value?.error?.message || '暂时无法连接任务服务，请重试。');
  }
  return value;
}

function setError(message = '') {
  error.textContent = message;
  error.hidden = !message;
}

function refresh() {
  const editing = submitting || preparing;
  submit.disabled = editing || checking || !trajectory || !selectedWorkerReady();
  file.disabled = editing || !calibration;
  appendFile.disabled = editing || !clips.length || clips.length >= MAX_REFERENCE_CLIPS;
  speedSelect.disabled = editing || !clips.length;
  exportButton.disabled = editing || !trajectory;
  exampleButton.disabled = editing || !example;
  exampleDownload.disabled = !example;
  worker.disabled = submitting || checking;
  checkWorker.disabled = submitting || checking || !worker.value;
  envs.disabled = submitting;
  byId('reference-steps').disabled = submitting;
}

function selectedWorkerReady() {
  return resources.some(({ id, ready }) => id === worker.value && ready);
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
  if (incoming.size > 8 * 1024 * 1024) throw Error('参考文件大小不能超过 8 MiB。');
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

byId('reference-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submitting || checking || preparing || !selectedWorkerReady() || !trajectory) return;
  submitting = true;
  refresh();
  setError();
  const computeResourceId = worker.value;
  const trainingSteps = Number(byId('reference-steps').value);
  const numEnvs = Number(envs.value);
  const key = [computeResourceId, trainingSteps, numEnvs].join('/');
  if (!attempt || attempt.key !== key) attempt = { key, id: crypto.randomUUID() };
  try {
    const { modelId } = await api('originman-reference/model', { computeResourceId });
    const result = await api('runs', {
      requestedVia: 'workbench', modelId, computeResourceId, backend: 'local',
      taskId: 'originman-reference-track', label: 'OriginMan · 参考轨迹跟跳',
      training: {
        profile: trainingSteps === 8192 ? 'smoke' : 'standard', algorithm: 'ppo',
        engine: 'originman-reference-ppo', video: true, maxIterations: trainingSteps / 4096, numEnvs,
        originmanReference: { trajectory, trainingSteps, seed: 7 },
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
    await loadWorkers();
  } catch (cause) {
    workerHint.textContent = cause.message;
  }
} catch (cause) {
  status.textContent = '任务配置读取失败。';
  setError(cause.message);
}
refresh();
