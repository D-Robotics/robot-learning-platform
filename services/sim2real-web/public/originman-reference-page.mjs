import { readOriginmanNpz } from './originman-reference-npz.mjs';

const byId = (id) => document.getElementById(id);
const worker = byId('reference-worker');
const envs = byId('reference-envs');
const status = byId('reference-status');
const error = byId('reference-error');
const submit = byId('reference-submit');
const file = byId('reference-file');
const exampleButton = byId('reference-example');
const exampleDownload = byId('reference-example-download');
let example;
let trajectory;
let attempt;
let requestSequence = 0;
let submitting = false;

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
  submit.disabled = submitting || !trajectory || !worker.value;
  file.disabled = submitting;
  exampleButton.disabled = submitting || !example;
  worker.disabled = submitting;
  envs.disabled = submitting;
  byId('reference-steps').disabled = submitting;
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

async function selectTrajectory(load, label) {
  const sequence = ++requestSequence;
  trajectory = undefined;
  attempt = undefined;
  setError();
  status.textContent = '正在校验关节顺序、频率和角度范围。';
  refresh();
  try {
    const value = await load();
    if (sequence !== requestSequence) return;
    const receipt = await api('originman-reference/validate', { trajectory: value });
    if (sequence !== requestSequence) return;
    trajectory = value;
    status.textContent = `${label}已通过格式校验，${receipt.frames} 帧，${receipt.durationSeconds} 秒，${receipt.fps} Hz。任务启动后会先做物理仿真筛查。`;
  } catch (cause) {
    if (sequence !== requestSequence) return;
    status.textContent = '请重新导入参考轨迹。';
    setError(cause.message);
  } finally {
    refresh();
  }
}

worker.addEventListener('change', () => {
  envs.value = worker.selectedOptions[0]?.dataset.cuda === 'true' ? '64' : '1';
  refresh();
});
file.addEventListener('change', () => {
  const incoming = file.files[0];
  if (!incoming) return;
  void selectTrajectory(async () => {
    if (incoming.size > 8 * 1024 * 1024) throw Error('参考文件大小不能超过 8 MiB。');
    return /\.npz$/i.test(incoming.name)
      ? readOriginmanNpz(await incoming.arrayBuffer())
      : JSON.parse(await incoming.text());
  }, incoming.name);
});
exampleButton.addEventListener('click', () => {
  file.value = '';
  void selectTrajectory(() => example, '示例摆臂');
});
exampleDownload.addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(example)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'originman-reference-example.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

byId('reference-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submitting || !worker.value || !trajectory) return;
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
  showCalibration(setup.calibration);
  for (const value of setup.resources) {
    const option = document.createElement('option');
    option.value = value.id;
    option.textContent = value.name;
    option.dataset.cuda = value.cuda === true;
    worker.append(option);
  }
  if (setup.resources.length === 1) {
    worker.value = setup.resources[0].id;
    worker.dispatchEvent(new Event('change'));
  }
  status.textContent = '请选择文件或加载示例。';
  if (!setup.resources.length)
    byId('reference-worker-hint').textContent = '当前账号暂无支持参考轨迹跟跳的在线 Worker。可以先导入并校验轨迹。';
} catch (cause) {
  status.textContent = '任务配置读取失败。';
  setError(cause.message);
}
refresh();
