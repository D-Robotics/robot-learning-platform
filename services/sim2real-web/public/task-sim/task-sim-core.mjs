// Shared protocol and geometry functions are deliberately independent of the DOM.
export const FORMAT = 'rdk-task-trajectory-v1';
export const clamp = (value, low = -1, high = 1) => Math.min(high, Math.max(low, Number(value) || 0));
export const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const CAMERA_HALF_FOV = Math.PI / 7;

export function policyStepLimit(value) {
  if (value === undefined) return 600;
  if (!Number.isInteger(value) || value < 1 || value > 10000) throw new Error('策略试跑步数必须是 1 到 10,000 的整数。');
  return value;
}

export function recordingLineBytes(row) { return new TextEncoder().encode(JSON.stringify(row) + '\n').byteLength; }
export function recordingAppendBudget(row, bytes, limit = 30 * 1024 * 1024) {
  const lineBytes = recordingLineBytes(row);
  return { accepted: bytes + lineBytes <= limit, bytes: bytes + lineBytes <= limit ? bytes + lineBytes : bytes, lineBytes };
}

export function sameOriginPath(input, origin, fallback) {
  const url = new URL(input || fallback, origin);
  if (url.origin !== new URL(origin).origin || !/^https?:$/.test(url.protocol)) throw new Error('接口必须与工作台同源。');
  return url.href.replace(/\/+$/, '');
}

export function normalizedAction(value, contract) {
  const { actionDim, numAgents = 1 } = contract;
  const rows = numAgents > 1 ? value : [value];
  if (!Array.isArray(rows) || rows.length !== numAgents) throw new Error(`动作需要 ${numAgents} 个智能体。`);
  const result = rows.map((row) => {
    if (!Array.isArray(row) || row.length !== actionDim || row.some((n) => !Number.isFinite(n))) throw new Error(`动作必须是 ${actionDim} 维有限数值。`);
    return row.map((n) => clamp(n));
  });
  return numAgents > 1 ? result : result[0];
}

export function replaySnapshot(frame, taskId) {
  if (frame?.taskId !== taskId) throw new Error('回放任务与当前场景不一致。请切换到对应任务。');
  const replay = frame.replay;
  if (!replay || !Array.isArray(replay.qpos) || !Array.isArray(replay.qvel) || [...replay.qpos, ...replay.qvel].some((n) => !Number.isFinite(n))) throw new Error('这段回放缺少引擎状态快照，无法还原任务场景。');
  if (replay.taskId !== taskId) throw new Error('引擎快照所属任务与当前场景不一致。');
  return replay;
}

export function recordingHeader(task, contract) {
  return { type: 'header', format: FORMAT, taskId: task.taskId, taskName: task.name, source: 'engine-task-simulation', engine: task.engine, contractId: contract.contractId || `${task.taskId}-engine-v1`, observationSize: contract.observationDim, actionSize: contract.actionDim, numAgents: contract.numAgents || 1, ...((contract.numAgents || 1) > 1 ? { recordedAgent: 0 } : {}), controlPeriodSeconds: contract.controlPeriodSeconds, representation: 'engine-proxy', createdAt: new Date().toISOString() };
}

export function recordingSample(before, after, action) {
  const team = (before.contract?.numAgents || 1) > 1;
  return { type: 'sample', taskId: before.taskId, t: after.time, time: after.time, step: after.stepCount, observation: team ? before.observation[0] : before.observation, action: team ? action[0] : action, nextObservation: team ? after.observation[0] : after.observation, qpos: after.qpos, qvel: after.qvel, reward: team ? after.reward[0] : after.reward, metrics: after.metrics, done: after.done, replay: after.replay, ...(team ? { allAgents: { observation: before.observation, action, nextObservation: after.observation, reward: after.reward } } : {}) };
}

export function policyBinding(session, contract) {
  const agents = contract.numAgents || 1;
  const meta = (name) => Array.isArray(session.inputMetadata) ? session.inputMetadata[session.inputNames.indexOf(name)] : session.inputMetadata?.[name];
  const inputName = session.inputNames.find((name) => ['obs', 'observation', 'observations'].includes(name)) || (session.inputNames.length === 1 ? session.inputNames[0] : '');
  if (!inputName) throw new Error('模型未声明可识别的观测输入。');
  const shape = meta(inputName)?.shape || meta(inputName)?.dimensions;
  if (!Array.isArray(shape) || shape.length !== 2 || Number(shape[1]) !== contract.observationDim || (Number(shape[0]) > 0 && Number(shape[0]) !== agents)) throw new Error(`模型观测维度与任务 ${contract.observationDim}D × ${agents} 契约不一致。`);
  const hiddenShapes = {};
  for (const name of session.inputNames.filter((name) => name !== inputName)) {
    if (!['h_in', 'c_in'].includes(name) || !session.outputNames.includes(name.replace('_in', '_out'))) throw new Error(`模型辅助输入 ${name} 未声明支持的循环状态契约。`);
    const dims = meta(name)?.shape || meta(name)?.dimensions;
    if (!Array.isArray(dims) || dims.length !== 3 || !Number.isInteger(Number(dims[0])) || !Number.isInteger(Number(dims[2])) || (Number(dims[1]) > 0 && Number(dims[1]) !== agents)) throw new Error('模型循环状态形状不可识别。');
    const actual = [Number(dims[0]), agents, Number(dims[2])];
    if (actual.some((n) => n <= 0) || actual.reduce((a, b) => a * b, 1) > 1e6) throw new Error('模型循环状态形状无效。');
    hiddenShapes[name] = actual;
  }
  const outputName = session.outputNames.find((name) => ['action', 'actions', 'act'].includes(name)) || session.outputNames[0];
  return { inputName, outputName, hiddenShapes };
}

export function modelMatrix(geom) {
  const m = identity();
  const r = geom.xmat || [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) m[col * 4 + row] = r[row * 3 + col];
  m.set(geom.xpos || [0, 0, 0], 12);
  return m;
}

export function multiply(a, b) {
  const c = new Float32Array(16);
  for (let col = 0; col < 4; col++) for (let row = 0; row < 4; row++) for (let k = 0; k < 4; k++) c[col * 4 + row] += a[k * 4 + row] * b[col * 4 + k];
  return c;
}

export function perspective(aspect, near = .01, far = 200) {
  const f = 1 / Math.tan(CAMERA_HALF_FOV);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, 2 * far * near / (near - far), 0]);
}

const normalize = (v) => { const n = Math.hypot(...v) || 1; return v.map((a) => a / n); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a.reduce((s, n, i) => s + n * b[i], 0);
export function fitCameraBounds(bounds, aspect = 1, azimuth = -1.1, elevation = .48, padding = .15) {
  const { low, high } = bounds || {};
  if (!Array.isArray(low) || !Array.isArray(high) || low.length !== 3 || high.length !== 3 || [...low, ...high].some((n) => !Number.isFinite(n)) || low.some((n, i) => n > high[i])) {
    return { target: [...(bounds?.center || [0, 0, .4])], distance: Math.max(.4, bounds?.radius || 1) * 2.8 };
  }
  const target = low.map((n, i) => (n + high[i]) / 2);
  const backward = [Math.cos(elevation) * Math.cos(azimuth), Math.cos(elevation) * Math.sin(azimuth), Math.sin(elevation)];
  const right = [-Math.sin(azimuth), Math.cos(azimuth), 0], up = cross(backward, right);
  const vertical = Math.tan(CAMERA_HALF_FOV) * (1 - clamp(padding, 0, .8));
  const horizontal = vertical * (Number.isFinite(aspect) && aspect > 0 ? aspect : 1);
  let distance = .2;
  // Fit all eight world bounds corners in perspective, accounting for each
  // corner's depth rather than treating a long, low field as a sphere.
  for (const x of [low[0], high[0]]) for (const y of [low[1], high[1]]) for (const z of [low[2], high[2]]) {
    const relative = [x, y, z].map((n, i) => n - target[i]), depth = dot(relative, backward);
    distance = Math.max(distance, depth + .02, depth + Math.abs(dot(relative, right)) / horizontal, depth + Math.abs(dot(relative, up)) / vertical);
  }
  return { target, distance };
}
export function lookAt(eye, target) {
  const z = normalize(eye.map((v, i) => v - target[i]));
  const x = normalize(cross([0, 0, 1], z));
  const y = cross(z, x);
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
}

// MuJoCo convention: size holds half extents; capsules/cylinders run along Z.
export function primitive(type, size = [1, 1, 1]) {
  const vertices = [];
  const push = (p, n) => vertices.push(...p, ...n);
  const triangle = (a, b, c, n) => { push(a, n); push(b, n); push(c, n); };
  if (type === 'box' || type === 'plane') {
    const [x, y, z] = type === 'plane' ? [size[0] || 8, size[1] || 8, .002] : size;
    const corners = [[-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z], [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]];
    for (const [ids, n] of [[[0, 3, 2, 1], [0, 0, -1]], [[4, 5, 6, 7], [0, 0, 1]], [[0, 1, 5, 4], [0, -1, 0]], [[1, 2, 6, 5], [1, 0, 0]], [[2, 3, 7, 6], [0, 1, 0]], [[3, 0, 4, 7], [-1, 0, 0]]]) { triangle(corners[ids[0]], corners[ids[1]], corners[ids[2]], n); triangle(corners[ids[0]], corners[ids[2]], corners[ids[3]], n); }
  } else if (type === 'cylinder') {
    const radius = size[0], half = size[1];
    for (let i = 0; i < 24; i++) {
      const a = i / 24 * Math.PI * 2, b = (i + 1) / 24 * Math.PI * 2;
      const na = [Math.cos(a), Math.sin(a), 0], nb = [Math.cos(b), Math.sin(b), 0];
      const pa = [radius * na[0], radius * na[1], -half], pb = [radius * nb[0], radius * nb[1], -half], pc = [pb[0], pb[1], half], pd = [pa[0], pa[1], half];
      push(pa, na); push(pb, nb); push(pc, nb); push(pa, na); push(pc, nb); push(pd, na);
      triangle([0, 0, -half], pb, pa, [0, 0, -1]); triangle([0, 0, half], pd, pc, [0, 0, 1]);
    }
  } else if (['sphere', 'ellipsoid', 'capsule'].includes(type)) {
    const radius = size[0];
    const scale = type === 'ellipsoid' ? size : [radius, radius, radius];
    const point = (lat, lon) => {
      const normal = [Math.sin(lat) * Math.cos(lon), Math.sin(lat) * Math.sin(lon), Math.cos(lat)];
      const pos = normal.map((n, i) => n * scale[i]);
      if (type === 'capsule') pos[2] += normal[2] >= 0 ? size[1] : -size[1];
      return [pos, normalize(normal.map((n, i) => n / (scale[i] || 1)))];
    };
    // A double equator closes the capsule's cylinder without stretching normals.
    const latitudes = Array.from({ length: 17 }, (_, i) => i / 16 * Math.PI);
    if (type === 'capsule') latitudes.splice(9, 0, Math.PI / 2 + 1e-7);
    for (let j = 0; j < latitudes.length - 1; j++) for (let i = 0; i < 24; i++) {
      const a = i / 24 * Math.PI * 2, b = (i + 1) / 24 * Math.PI * 2;
      const p = [point(latitudes[j], a), point(latitudes[j], b), point(latitudes[j + 1], b), point(latitudes[j + 1], a)];
      for (const index of [0, 1, 2, 0, 2, 3]) push(...p[index]);
    }
  } else throw new Error(`不支持的场景几何：${type}`);
  return new Float32Array(vertices);
}
