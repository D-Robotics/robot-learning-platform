(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const canvas = $('scene');
  const context = canvas?.getContext('2d');
  if (!canvas || !context) return;
  const mapCanvas = $('map-view');
  const mapContext = mapCanvas?.getContext('2d');
  const lidarCanvas = $('lidar-view');
  const lidarContext = lidarCanvas?.getContext('2d');

  // The MuJoCo service is mounted independently from the Sim2Real app. Keep
  // the base configurable for installations that put both routes below one
  // reverse-proxy prefix while retaining /mujoco as the production default.
  const query = new URLSearchParams(location.search);
  const configuredBase = String(query.get('mujocoBase') ||
    window.RDK_MUJOCO_BASE || document.documentElement.dataset.mujocoBase || '/mujoco',
  ).trim();
  const baseUrl = new URL(configuredBase, location.origin);
  if (baseUrl.origin !== location.origin || !/^https?:$/.test(baseUrl.protocol)) {
    setEvent('MuJoCo 接口必须与工作台同源。', 'warn'); return;
  }
  const mujocoBase = baseUrl.pathname.replace(/\/+$/, '');
  const API_ROOT = `${mujocoBase}/api`;
  const LOOP_MS = 50; // five 10 ms MuJoCo steps per control update = 20 Hz
  const FRAME_MS = 100; // keep control/telemetry at 20 Hz without rendering 20 JPEGs/s
  const GOAL_EPSILON = 0.12;
  // Domain randomization is on for the browser preview so a policy cannot
  // silently overfit one ideal friction/gain envelope.  Integrators can set
  // `window.RDK_MUJOCO_DOMAIN_RANDOMIZATION = false` for deterministic demos.
  const domainRandomization = window.RDK_MUJOCO_DOMAIN_RANDOMIZATION !== false;
  const configuredSeed = Number(window.RDK_MUJOCO_SEED);
  const sessionSeed = Number.isInteger(configuredSeed) && configuredSeed >= 0
    ? configuredSeed
    : 7;

  let sessionId = null;
  let latestState = null;
  let running = true;
  let recording = false;
  let rows = [];
  let recordingTask = null;
  let recordingCreatedAt = '';
  let recordingBytes = 0;
  let pendingRecordedCommand = null;
  let pendingRecordingNotice = null;
  const MAX_RECORDING_BYTES = 30 * 1024 * 1024;
  const lineBytes = (row) => new TextEncoder().encode(JSON.stringify(row) + '\n').byteLength;
  let goal = { x: 1.5, y: 0.8 };
  let goalStartDistance = Math.hypot(goal.x, goal.y);
  let loopTimer = null;
  let loopBusy = false;
  let imageErrorAt = 0;
  let lastFrameAt = 0;
  let lastDepthAt = 0;
  let depthObjectUrl = null;
  let lastOutcome = '';
  let pageUnloading = false;
  let active = true;
  let replaying = false;
  let generation = 0;
  let mutationQueue = Promise.resolve();
  let currentTask = query.get('taskId') || 'goal-navigation';
  let manualCommand = { linear: 0, angular: 0 };
  let resumeRunning = true;
  let loadingPolicy = false;
  let loadingPolicyTrialId;
  let connectionError = false;
  const TASKS = {
    'goal-navigation': { name: '目标导航', help: '点击场景设置目标，导航控制器驱动物理场景。', automatic: true },
    'data-collection': { name: '遥操作采集', help: '用线速度与角速度控制机器人，录制真实 8D 观测、2D 动作及传感器。', manual: true },
    'visual-twist': { name: '视觉控制预览', help: '查看相机和传感器。视觉策略需要目标检测特征适配器，当前尚未提供，不会自动产生视觉控制动作。' },
    custom: { name: '自定义手动控制', help: '使用手动速度探索物理环境；自定义策略须匹配 OriginBot 8D→2D 契约。', manual: true },
  };
  // Recorded replay trajectory and policy-drive session state (driven by
  // postMessage from the parent Sim2Real Run page).
  let replayTrace = null;
  let policySession = null;

  const finite = (value, fallback = 0) =>
    Number.isFinite(Number(value)) ? Number(value) : fallback;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const qposOf = (state) => (Array.isArray(state?.qpos) ? state.qpos : []);
  const qvelOf = (state) => (Array.isArray(state?.qvel) ? state.qvel : []);
  const odomOf = (state) => state?.sensors?.odom || {};
  const imuOf = (state) => state?.sensors?.imu || {};
  const positionOf = (state) => {
    const odom = odomOf(state);
    const qpos = qposOf(state);
    return { x: finite(odom.x, finite(qpos[0])), y: finite(odom.y, finite(qpos[1])) };
  };
  const yawOf = (state) => {
    const odom = odomOf(state);
    const qpos = qposOf(state);
    return finite(odom.yaw, 2 * Math.atan2(finite(qpos[6]), finite(qpos[3], 1)));
  };

  const post = (type, data = {}) => { if (window.parent !== window) window.parent.postMessage({ type, taskId: currentTask, ...data }, location.origin); };
  const taskState = (phase, message) => post('rdk-simulator-task-state', { phase, message, controlHz: 20, contract: { observationDim: 8, actionDim: 2, numAgents: 1, contractId: 'originbot-policy-v1', source: 'originbot-sim' } });
  async function api(path, options = {}) {
    const { guardGeneration, recordTransition, ...requestOptions } = options;
    if (['POST', 'DELETE'].includes(options.method)) {
      const next = mutationQueue.catch(() => {}).then(() => {
        if (guardGeneration !== undefined && (guardGeneration !== generation || !active || pageUnloading)) return null;
        if (recordTransition) recordTransition.accepted = true;
        return executeApi(path, requestOptions);
      });
      mutationQueue = next.catch(() => {});
      return next;
    }
    return executeApi(path, requestOptions);
  }
  async function executeApi(path, options = {}) {
    const response = await fetch(`${API_ROOT}/${path.replace(/^\/+/, '')}`, {
      credentials: 'same-origin', cache: 'no-store',
      ...options,
      headers: {
        accept: 'application/json',
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    });
    if (!response.ok) {
      let detail = '';
      try {
        detail = await response.text();
      } catch {
        // Keep the status useful even when a gateway closes the body.
      }
      throw new Error(`${response.status} ${describeUpstreamFailure(response, detail)}`);
    }
    return response.json();
  }

  // A gateway/bridge failure arrives as JSON (`{"error":"..."}`) or as an
  // HTML error page (Express fallbacks). Surfacing the raw HTML flooded the
  // diagnostics bar with markup; project both shapes to one short line.
  function describeUpstreamFailure(response, detail) {
    const contentType = String(response.headers.get('content-type') || '');
    if (contentType.includes('application/json')) {
      try {
        const parsed = JSON.parse(detail);
        const code = typeof parsed?.error === 'string' ? parsed.error : '';
        const message = typeof parsed?.message === 'string' ? parsed.message : typeof parsed?.detail === 'string' ? parsed.detail : '';
        return [code, message].filter(Boolean).join('：') || 'request failed';
      } catch {
        return 'request failed';
      }
    }
    const text = String(detail || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return text.slice(0, 80) || response.statusText || 'request failed';
  }

  function releaseSession() {
    pageUnloading = true;
    generation++;
    stopPolicyRun('页面已关闭。');
    const id = sessionId;
    if (!id) return;
    sessionId = null;
    if (loopTimer) window.clearTimeout(loopTimer);
    loopTimer = null;
    // A pagehide request is best-effort by design.  The MuJoCo service also
    // expires idle sessions and closes their GL renderers, so a browser that
    // is killed mid-request cannot pin a slot forever.
    fetch(`${API_ROOT}/sessions/${id}`, {
      method: 'DELETE',
      credentials: 'same-origin',
      keepalive: true,
      headers: { accept: 'application/json' },
    }).catch(() => {});
  }

  function setEvent(message, tone = '') {
    const event = $('event');
    if (!event) return;
    event.textContent = message;
    event.classList.remove('ok', 'warn');
    if (tone) event.classList.add(tone);
  }

  function setConnection(connected, label) {
    const badge = $('engine-badge');
    const text = $('engine-label');
    if (text) text.textContent = label;
    if (badge) badge.classList.toggle('disconnected', !connected);
    if ($('retry')) $('retry').hidden = connected;
  }

  function updateGoalReadout() {
    const readout = $('goal-readout');
    if (readout) readout.textContent = `X ${goal.x.toFixed(2)} · Y ${goal.y.toFixed(2)}`;
  }

  function distanceToGoal(state = latestState, target = goal) {
    const position = positionOf(state);
    return Math.hypot(target.x - position.x, target.y - position.y);
  }

  function updateTransport() {
    const runButton = $('run');
    const recordButton = $('record');
    const exportButton = $('stop');
    const status = $('status-badge');
    if ($('samples-readout')) $('samples-readout').textContent = String(rows.length);
    if (runButton) {
      runButton.disabled = !sessionId || !active || currentTask === 'visual-twist' || Boolean(policySession) || loadingPolicy;
      runButton.textContent = running ? 'Ⅱ 暂停' : '▶ 继续';
      runButton.setAttribute('aria-pressed', String(running));
    }
    if (recordButton) {
      recordButton.textContent = recording ? '■ 停止录制' : '● 开始录制';
      recordButton.classList.toggle('recording', recording);
      recordButton.setAttribute('aria-pressed', String(recording));
      recordButton.disabled = !sessionId || replaying || !active || loadingPolicy || currentTask === 'visual-twist' || (!recording && pendingRecordedCommand?.accepted);
    }
    if (exportButton) exportButton.disabled = rows.length === 0;
    if (status) {
      const reached = TASKS[currentTask]?.automatic && latestState && distanceToGoal(latestState) <= GOAL_EPSILON;
      const collision = Boolean(latestState?.collision);
      const outcome = collision ? 'collision' : reached ? 'goal' : '';
      status.textContent = replaying ? '● 回放中' : outcome === 'collision' ? '● 发生碰撞' : outcome === 'goal' ? '● 已到达目标' : policySession ? '● 策略试跑中' : running ? (recording ? '● 录制中' : '● 运行中') : '● 已暂停';
      status.classList.toggle('paused', !running && !outcome);
      status.classList.toggle('warn', outcome === 'collision');
      if (outcome && outcome !== lastOutcome) {
        setEvent(outcome === 'collision' ? '检测到碰撞，已记录为终止状态。' : '已到达目标点，当前距离小于 0.12 m。', outcome === 'collision' ? 'warn' : 'ok');
      }
      lastOutcome = outcome;
    }
  }

  function worldToMap(x, y, width, height) {
    const scale = Math.min(width, height) / 8;
    return { x: width / 2 + x * scale, y: height / 2 - y * scale };
  }

  function drawMap(state) {
    if (!mapContext || !mapCanvas) return;
    const width = mapCanvas.width;
    const height = mapCanvas.height;
    mapContext.clearRect(0, 0, width, height);
    mapContext.fillStyle = '#07111b';
    mapContext.fillRect(0, 0, width, height);
    mapContext.strokeStyle = '#193044';
    mapContext.lineWidth = 1;
    for (let i = -4; i <= 4; i += 1) {
      const x = worldToMap(i, 0, width, height).x;
      const y = worldToMap(0, i, width, height).y;
      mapContext.beginPath(); mapContext.moveTo(x, 0); mapContext.lineTo(x, height); mapContext.stroke();
      mapContext.beginPath(); mapContext.moveTo(0, y); mapContext.lineTo(width, y); mapContext.stroke();
    }
    // Recorded replay trajectory (from the parent Run page): a fading trail
    // so the operator can see the full evaluation rollout, not just the
    // per-frame marker.
    if (replayTrace && replayTrace.positions.length) {
      mapContext.strokeStyle = '#55ddb0';
      mapContext.lineWidth = 2;
      mapContext.globalAlpha = 0.7;
      mapContext.beginPath();
      replayTrace.positions.forEach((point, index) => {
        const pixel = worldToMap(point.x, point.y, width, height);
        if (index === 0) mapContext.moveTo(pixel.x, pixel.y);
        else mapContext.lineTo(pixel.x, pixel.y);
      });
      mapContext.stroke();
      mapContext.globalAlpha = 1;
    }
    const position = positionOf(state);
    const robot = worldToMap(position.x, position.y, width, height);
    const target = worldToMap(goal.x, goal.y, width, height);
    mapContext.strokeStyle = '#ffad68';
    mapContext.setLineDash([4, 4]);
    mapContext.beginPath(); mapContext.moveTo(robot.x, robot.y); mapContext.lineTo(target.x, target.y); mapContext.stroke();
    mapContext.setLineDash([]);
    mapContext.fillStyle = '#ffad68';
    mapContext.beginPath(); mapContext.arc(target.x, target.y, 6, 0, Math.PI * 2); mapContext.fill();
    mapContext.strokeStyle = '#fff0d7'; mapContext.lineWidth = 2; mapContext.stroke();
    const yaw = yawOf(state);
    mapContext.save(); mapContext.translate(robot.x, robot.y); mapContext.rotate(-yaw);
    mapContext.fillStyle = state?.collision ? '#ff6d5a' : '#62a7ff';
    mapContext.beginPath(); mapContext.moveTo(11, 0); mapContext.lineTo(-8, -7); mapContext.lineTo(-5, 7); mapContext.closePath(); mapContext.fill();
    mapContext.restore();
    const scan = Array.isArray(state?.sensors?.scan) ? state.sensors.scan : [];
    const meta = state?.sensors?.scanMeta || {};
    const start = finite(meta.angleMin, -Math.PI / 2);
    const increment = finite(meta.angleIncrement, scan.length > 1 ? Math.PI / Math.max(1, scan.length - 1) : 0);
    mapContext.fillStyle = '#55ddb0aa';
    scan.forEach((range, index) => {
      const distance = finite(range, 0);
      if (distance <= 0 || distance > 4) return;
      const angle = start + increment * index + yaw;
      const point = worldToMap(position.x + Math.cos(angle) * distance, position.y + Math.sin(angle) * distance, width, height);
      mapContext.fillRect(point.x - 1, point.y - 1, 2, 2);
    });
    if ($('map-readout')) $('map-readout').textContent = `目标 ${distanceToGoal(state).toFixed(2)} m`;
  }

  function drawLidar(state) {
    if (!lidarContext || !lidarCanvas) return;
    const width = lidarCanvas.width;
    const height = lidarCanvas.height;
    const cx = width / 2;
    const cy = height / 2;
    const radius = Math.min(width, height) * .42;
    lidarContext.clearRect(0, 0, width, height);
    lidarContext.fillStyle = '#07111b'; lidarContext.fillRect(0, 0, width, height);
    lidarContext.strokeStyle = '#193044'; lidarContext.lineWidth = 1;
    [0.25, 0.5, 0.75, 1].forEach((ratio) => { lidarContext.beginPath(); lidarContext.arc(cx, cy, radius * ratio, 0, Math.PI * 2); lidarContext.stroke(); });
    const scan = Array.isArray(state?.sensors?.scan) ? state.sensors.scan : [];
    const meta = state?.sensors?.scanMeta || {};
    const start = finite(meta.angleMin, -Math.PI / 2);
    const increment = finite(meta.angleIncrement, scan.length > 1 ? Math.PI / Math.max(1, scan.length - 1) : 0);
    const rangeMax = finite(meta.rangeMax, 4);
    lidarContext.fillStyle = '#55ddb0';
    scan.forEach((range, index) => {
      const distance = finite(range, 0);
      if (distance <= 0) return;
      const angle = start + increment * index;
      const px = cx + Math.cos(angle) * radius * Math.min(distance / rangeMax, 1);
      const py = cy - Math.sin(angle) * radius * Math.min(distance / rangeMax, 1);
      lidarContext.fillRect(px - 1, py - 1, 2, 2);
    });
    lidarContext.fillStyle = '#62a7ff'; lidarContext.beginPath(); lidarContext.arc(cx, cy, 5, 0, Math.PI * 2); lidarContext.fill();
    if ($('lidar-readout')) $('lidar-readout').textContent = `${scan.length} beams · ${rangeMax.toFixed(1)} m`;
  }

  function updateReadouts(state) {
    const position = positionOf(state);
    const distance = distanceToGoal(state);
    const progress = goalStartDistance > 1e-6
      ? clamp((goalStartDistance - distance) / goalStartDistance, 0, 1)
      : distance <= GOAL_EPSILON ? 1 : 0;
    const odom = odomOf(state);
    const imu = imuOf(state);
    const scan = Array.isArray(state?.sensors?.scan) ? state.sensors.scan : [];
    const depth = state?.sensors?.depth;
    const speed = finite(odom.linearX);
    const angular = finite(imu.gyroZ);
    if ($('speed-readout')) $('speed-readout').textContent = `${speed.toFixed(2)} m/s`;
    if ($('yaw-readout')) $('yaw-readout').textContent = `${angular.toFixed(2)} rad/s`;
    if ($('distance-readout')) $('distance-readout').textContent = `${distance.toFixed(2)} m`;
    if ($('samples-readout')) $('samples-readout').textContent = String(rows.length);
    if ($('scan-readout')) {
      const finiteScan = scan.map(Number).filter(Number.isFinite);
      const minimum = finiteScan.length ? Math.min(...finiteScan).toFixed(2) : '—';
      $('scan-readout').textContent = `${scan.length} beams · min ${minimum} m`;
    }
    if ($('depth-readout')) $('depth-readout').textContent = depth?.available ? '可用' : '不可用';
    if ($('progress-bar')) $('progress-bar').style.width = `${(progress * 100).toFixed(1)}%`;
    if ($('progress-label')) $('progress-label').textContent = `目标完成度 ${Math.round(progress * 100)}%`;
    if ($('sim-time')) $('sim-time').textContent = `t = ${finite(state?.time).toFixed(2)} s`;
    updateGoalReadout();
    updateTransport();
    return { position, distance, progress };
  }

  function observationOf(state, target = goal) {
    const position = positionOf(state);
    const yaw = yawOf(state);
    const odom = odomOf(state);
    const imu = imuOf(state);
    return [
      position.x,
      position.y,
      Math.sin(yaw),
      Math.cos(yaw),
      target.x - position.x,
      target.y - position.y,
      finite(odom.linearX),
      finite(imu.gyroZ),
    ].map((value) => finite(value));
  }

  function actionOf(state) {
    const command = state?.cmd_vel || {};
    return [finite(command.linear), finite(command.angular)];
  }

  function telemetryOf(state) {
    return {
      command: state?.cmd_vel || null,
      odom: state?.sensors?.odom || null,
      imu: state?.sensors?.imu || null,
      scan: Array.isArray(state?.sensors?.scan) ? state.sensors.scan : [],
      scanMeta: state?.sensors?.scanMeta || null,
      depth: state?.sensors?.depth || null,
      drive: state?.drive || null,
      sensorRaw: state?.sensorRaw || null,
      contacts: Array.isArray(state?.contacts) ? state.contacts : [],
      collision: Boolean(state?.collision),
    };
  }

  function paintFrame(image, width, height) {
    const sourceWidth = Math.max(1, finite(width, canvas.width));
    const sourceHeight = Math.max(1, finite(height, canvas.height));
    const scale = Math.min(canvas.width / sourceWidth, canvas.height / sourceHeight);
    const targetWidth = sourceWidth * scale;
    const targetHeight = sourceHeight * scale;
    context.fillStyle = '#09111b';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(
      image,
      (canvas.width - targetWidth) / 2,
      (canvas.height - targetHeight) / 2,
      targetWidth,
      targetHeight,
    );
  }

  function appendSample(state, previousState = state, command = actionOf(state), transition = null) {
    const sampleGoal = transition?.goal || goal, sampleTask = transition?.taskId || currentTask;
    if (active && sampleTask === currentTask) updateReadouts(state);
    const action = [finite(command?.linear), finite(command?.angular)];
    const maxLinear = finite(state?.cmd_vel?.maxLinear, 0.3);
    const maxAngular = finite(state?.cmd_vel?.maxAngular, 1.0);
    const distanceBefore = distanceToGoal(previousState, sampleGoal);
    const distanceAfter = distanceToGoal(state, sampleGoal);
    const collision = Boolean(state?.collision);
    const goalReached = TASKS[sampleTask]?.automatic && distanceAfter <= GOAL_EPSILON;
    const done = goalReached || collision;
    const sample = {
      type: 'sample', taskId: sampleTask, qpos: qposOf(state), qvel: qvelOf(state), replay: state?.replay || null,
      metrics: { goalX: sampleGoal.x, goalY: sampleGoal.y, goalDistance: distanceAfter, collision },
      t: finite(state?.time), tStart: finite(previousState?.time),
      tNext: finite(state?.time),
      controlPeriodSeconds: finite(state?.model?.controlPeriod, 0.05),
      controlHz: finite(state?.model?.controlHz, 20),
      // Keep the original observation/action keys while adding an explicit
      // transition pair for offline RL consumers.
      observation: transition?.observation || observationOf(previousState, sampleGoal),
      nextObservation: observationOf(state, sampleGoal),
      action,
      // Browser control is a physical twist. Keep a normalized copy for
      // consumers that train the 2D [-1, 1] policy head; never make them
      // guess which units the legacy `action` field uses.
      policyAction: [
        clamp(action[0] / Math.max(maxLinear, 1e-9), -1, 1),
        clamp(action[1] / Math.max(maxAngular, 1e-9), -1, 1),
      ],
      actionOutput: 'physical-twist',
      actionScale: { linear: maxLinear, angular: maxAngular, units: 'm/s,rad/s' },
      cmd_vel: {
        linear: finite(state?.cmd_vel?.appliedLinear, action[0]),
        angular: finite(state?.cmd_vel?.appliedAngular, action[1]),
      },
      reward: Number(((TASKS[sampleTask]?.automatic ? distanceBefore - distanceAfter : 0) - 0.01 * (Math.abs(action[0]) + Math.abs(action[1])) + (goalReached ? 5 : 0) - (collision ? 5 : 0)).toFixed(6)),
      done,
      terminated: done,
      truncated: false,
      collision,
      source: 'originbot-sim',
      telemetry: telemetryOf(state),
      appliedAction: [
        finite(state?.cmd_vel?.appliedLinear, action[0]),
        finite(state?.cmd_vel?.appliedAngular, action[1]),
      ],
      episode: state?.episode || null,
    };
    const bytes = lineBytes(sample);
    if (recordingBytes + bytes <= MAX_RECORDING_BYTES) { rows.push(sample); recordingBytes += bytes; }
    else { stopRecording('已达到 30 MiB 录制上限，已保存此前完整帧。'); return; }
    if (rows.length >= 30000) stopRecording('已达到 30,000 帧录制上限，轨迹已保存。');
  }

  async function drawFrame() {
    if (!sessionId) return;
    const token = generation;
    const response = await fetch(
      `${API_ROOT}/sessions/${sessionId}/frame.jpg?t=${Date.now()}`,
      { cache: 'no-store', credentials: 'same-origin', headers: { accept: 'image/jpeg' } },
    );
    if (!response.ok) throw new Error(`frame ${response.status}`);
    const blob = await response.blob();
    if (token !== generation || pageUnloading) return;
    if (typeof createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(blob);
      if (token === generation && !pageUnloading) paintFrame(bitmap, bitmap.width, bitmap.height);
      bitmap.close();
      return;
    }
    // Safari/WebViews without createImageBitmap still get the server frame.
    await new Promise((resolve, reject) => {
      const image = new Image();
      const objectUrl = URL.createObjectURL(blob);
      image.onload = () => {
        if (token === generation && !pageUnloading) paintFrame(image, image.naturalWidth || image.width, image.naturalHeight || image.height);
        URL.revokeObjectURL(objectUrl);
        resolve();
      };
      image.onerror = (error) => {
        URL.revokeObjectURL(objectUrl);
        reject(error);
      };
      image.src = objectUrl;
    });
  }

  async function drawDepth() {
    if (!sessionId || !document.getElementById('depth-view')) return;
    const token = generation;
    const response = await fetch(`${API_ROOT}/sessions/${sessionId}/depth.jpg?t=${Date.now()}`, {
      cache: 'no-store', credentials: 'same-origin', headers: { accept: 'image/jpeg' },
    });
    if (!response.ok) throw new Error(`depth ${response.status}`);
    const nextUrl = URL.createObjectURL(await response.blob());
    if (token !== generation || pageUnloading) { URL.revokeObjectURL(nextUrl); return; }
    const previousUrl = depthObjectUrl;
    depthObjectUrl = nextUrl;
    const image = $('depth-view');
    image.src = nextUrl;
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    if ($('depth-readout-mini')) $('depth-readout-mini').textContent = '实时 · mono8';
  }

  async function render(state, { forceFrame = false, token = generation, requireFrame = false } = {}) {
    if (token !== generation || pageUnloading) return;
    latestState = state;
    updateReadouts(state);
    drawMap(state);
    drawLidar(state);
    $('observation').textContent = JSON.stringify(state?.sensors || {}, null, 2);
    $('action').textContent = JSON.stringify(state?.cmd_vel || {}, null, 2);
    if (!forceFrame && Date.now() - lastFrameAt < FRAME_MS) return;
    try {
      await drawFrame();
      if (token !== generation || pageUnloading) return;
      if (forceFrame || Date.now() - lastDepthAt >= 300) {
        await drawDepth();
        lastDepthAt = Date.now();
      }
      lastFrameAt = Date.now();
    } catch (error) {
      if (requireFrame) throw error;
      // Do not turn a transient JPEG request into a noisy event every 50 ms.
      const now = Date.now();
      if (now - imageErrorAt > 2000) {
        imageErrorAt = now;
        setEvent(`MuJoCo 画面暂时不可用：${error.message}`, 'warn');
      }
    }
  }

  function computeCommand(state) {
    const position = positionOf(state);
    const heading = yawOf(state);
    const desired = Math.atan2(goal.y - position.y, goal.x - position.x);
    const error = Math.atan2(Math.sin(desired - heading), Math.cos(desired - heading));
    const distance = Math.hypot(goal.x - position.x, goal.y - position.y);
    return {
      linear: distance <= GOAL_EPSILON ? 0 : Math.min(0.3, distance * 0.25),
      angular: clamp(error * 2, -1, 1),
    };
  }

  function captureCommandRecording(state) {
    const transition = { rows, recorded: recording, accepted: false, goal: { ...goal }, taskId: currentTask, observation: observationOf(state) };
    pendingRecordedCommand = transition;
    return transition;
  }
  function finishCommandRecording(transition) {
    if (pendingRecordedCommand === transition) pendingRecordedCommand = null;
    if (pendingRecordingNotice === rows) { pendingRecordingNotice = null; publishRecording(); }
    updateTransport();
  }

  async function loop() {
    if (!sessionId || loopBusy || !active || pageUnloading) return;
    loopBusy = true;
    const token = generation;
    let nextDelay = LOOP_MS;
    let transition = null;
    try {
      if (policySession || loadingPolicy || replaying) return;
      await mutationQueue;
      let state = await api(`sessions/${sessionId}/state`);
      if (token !== generation || pageUnloading || !active) return;
      setConnection(true, 'MuJoCo 已连接'); if (connectionError) { connectionError = false; taskState('ready', 'MuJoCo 连接已恢复，仿真保持暂停。'); }
      if (running) {
        const previousState = state;
        const command = TASKS[currentTask]?.automatic ? computeCommand(state) : { ...manualCommand };
        transition = captureCommandRecording(previousState);
        state = await api(`sessions/${sessionId}/cmd_vel`, {
          method: 'POST',
          body: JSON.stringify(command),
          guardGeneration: token, recordTransition: transition,
        });
        if (!state) return;
        if (transition.recorded && transition.rows === rows) appendSample(state, previousState, command, transition);
        if (token !== generation || pageUnloading || !active) return;
        if (state.collision || (TASKS[currentTask]?.automatic && distanceToGoal(state) <= GOAL_EPSILON)) { running = false; stopRecording(state.collision ? '发生碰撞，仿真已暂停，轨迹已保存。' : '已到达目标，仿真已暂停，轨迹已保存。'); }
      }
      await render(state, { token });
    } catch (error) {
      if (token !== generation || pageUnloading || !active) return;
      running = false; stopRecording(); nextDelay = 2000;
      setConnection(false, 'MuJoCo 连接异常');
      setEvent(`MuJoCo 服务暂时不可用：${error.message}`, 'warn');
      if (!connectionError) taskState('failed', error.message); connectionError = true;
      if (/^404\b/.test(error.message)) { sessionId = null; running = false; stopPolicyRun('仿真会话已过期。'); stopRecording('会话已过期，已有录制可导出。'); updateTransport(); }
    } finally {
      finishCommandRecording(transition);
      loopBusy = false;
      if (sessionId && active && !pageUnloading) loopTimer = window.setTimeout(loop, nextDelay);
    }
  }

  function setGoal(nextGoal, message = '目标点已更新。') {
    goal = {
      x: clamp(finite(nextGoal.x), -3.5, 3.5),
      y: clamp(finite(nextGoal.y), -3.5, 3.5),
    };
    goalStartDistance = Math.max(
      distanceToGoal(latestState || { qpos: [0, 0, 0, 1, 0, 0, 0] }),
      GOAL_EPSILON,
    );
    updateGoalReadout();
    setEvent(message, 'ok');
  }

  // ---- embedded replay / policy-drive channel (parent app.js) ----
  // Restore the recorded physical state before asking the server for images.
  // Telemetry without a real state snapshot cannot faithfully move this scene.
  async function renderReplayFrame(frame, taskId, index = 0) {
    if (!sessionId) { const message = 'OriginBot 场景正在加载，请稍后重新选择回放帧。'; setEvent(message, 'warn'); post('rdk-replay-status', { phase: 'loading', index, message }); return; }
    if (!frame || (frame.taskId || taskId) !== currentTask) { const message = '回放任务与当前 OriginBot 任务不一致。'; setEvent(message, 'warn'); post('rdk-replay-status', { phase: 'failed', index, message }); return; }
    if (!frame.replay || frame.replay.taskId !== 'originbot' || !Array.isArray(frame.replay.qpos) || !Array.isArray(frame.replay.qvel) || [...frame.replay.qpos, ...frame.replay.qvel].some((n) => !Number.isFinite(n))) { const message = '回放缺少 OriginBot 引擎快照，无法还原三维场景。'; setEvent(message, 'warn'); post('rdk-replay-status', { phase: 'failed', index, message }); return; }
    stopPolicyRun(); stopRecording(); running = false; replaying = true; const token = ++generation;
    try {
      const state = await api(`sessions/${sessionId}/replay`, { method: 'POST', body: JSON.stringify(frame.replay) });
      if (token !== generation || pageUnloading) return;
      if (Number.isFinite(frame.metrics?.goalX) && Number.isFinite(frame.metrics?.goalY)) setGoal({ x: frame.metrics.goalX, y: frame.metrics.goalY });
      const { x, y } = positionOf(state);
    if (!replayTrace) replayTrace = { positions: [], t: [] };
    replayTrace.positions.push({ x, y });
    replayTrace.t.push(finite(frame.t));
    if (replayTrace.positions.length > 2000) {
      replayTrace.positions.shift();
      replayTrace.t.shift();
    }
    await render(state, { forceFrame: true, token, requireFrame: true });
    if (token !== generation || pageUnloading) return;
    if ($('map-readout')) {
      $('map-readout').textContent = `回放 t=${finite(frame.t).toFixed(2)} s`;
    }
    const message = `回放帧 ${index + 1}：位置 (${x.toFixed(2)}, ${y.toFixed(2)})`; setEvent(message, 'ok'); updateTransport(); post('rdk-replay-status', { phase: 'applied', index, message });
    } catch (error) { if (token === generation) { setEvent(`回放还原失败：${error.message}`, 'warn'); post('rdk-replay-status', { phase: 'failed', index, message: error.message }); } }
  }

  // Policy trial runs entirely inside this page (microduck pattern): the
  // parent posts only clonable data (runId + API root); postMessage cannot
  // carry functions, so the ONNX session, the bytes fetch, and the inference
  // loop all live here. Status flows back through 'rdk-policy-status'.
  const postPolicyStatus = (phase, message, trialId) => {
    try {
      post('rdk-policy-status', { phase, message, trialId });
    } catch {
      // A detached or cross-origin parent simply misses the status update;
      // the local event line below still informs this page.
    }
  };

  let ortRuntime = null;
  async function loadOrt() {
    if (ortRuntime) return ortRuntime;
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      // This page lives at <base>/originbot-sim/; the vendored runtime sits
      // at <base>/vendor/ — same origin, no CDN.
      script.src = new URL('../vendor/onnxruntime-web/dist/ort.min.js', document.baseURI).toString();
      script.onload = resolve;
      script.onerror = () => reject(new Error('ONNX 运行时脚本加载失败'));
      document.head.appendChild(script);
    });
    const ort = window?.ort;
    if (!ort) throw new Error('ONNX 运行时未正确暴露 window.ort');
    ort.env.wasm.wasmPaths = new URL('../vendor/onnxruntime-web/dist/', document.baseURI).toString();
    ort.env.wasm.numThreads = 1;
    ortRuntime = ort;
    return ort;
  }

  function stopPolicyRun(message = '策略试跑已停止。') {
    if (!policySession && !loadingPolicy) return;
    const previous = policySession;
    const trialId = previous ? previous.trialId : loadingPolicyTrialId;
    policySession = null; loadingPolicy = false; running = false; generation++;
    loadingPolicyTrialId = undefined;
    if (previous?.session) void Promise.resolve(previous.inference).catch(() => {}).then(() => previous.session.release()).catch(() => {});
    postPolicyStatus('stopped', message, trialId); updateTransport();
  }

  async function startPolicyRun(options = {}) {
    stopPolicyRun(); stopRecording(); running = false; replaying = false;
    const token = ++generation; loadingPolicy = true; loadingPolicyTrialId = options.trialId; updateTransport();
    let loaded = null;
    try {
      if (!sessionId || !active) throw new Error('OriginBot 场景尚未就绪或当前视图未激活。');
      if (options.taskId !== currentTask) throw new Error('策略任务与当前 OriginBot 场景任务不一致。');
      if (currentTask === 'visual-twist') throw new Error('视觉策略需要目标检测特征适配器；当前相机预览不能替代模型所需的视觉观测。');
      if (options.backend === 'board') throw new Error('板端策略未提供 OriginBot 任务与 8D→2D 契约证明，无法在此场景试跑。');
      if (!options.runId || !options.apiRoot) throw new Error('缺少策略运行 ID 或接口地址。');
      const maxSteps = options.maxSteps === undefined ? 600 : options.maxSteps;
      if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 10000) throw new Error('策略试跑步数必须是 1 到 10,000 的整数。');
      const root = new URL(options.apiRoot, location.origin);
      if (root.origin !== location.origin || !/^https?:$/.test(root.protocol)) throw new Error('策略接口必须与工作台同源。');
      const base = root.href.replace(/\/+$/, '');
      postPolicyStatus('loading', '正在校验 OriginBot 任务并加载 ONNX 策略…', options.trialId);
      const response = await fetch(`${base}/runs/${encodeURIComponent(options.runId)}`, { credentials: 'same-origin', cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || '策略运行不可访问。');
      const run = payload.run || payload;
      if (run.taskId !== currentTask) throw new Error('制品所属任务与当前 OriginBot 任务不一致。');
      const ort = await loadOrt();
      const bytes = await fetch(`${base}/runs/${encodeURIComponent(options.runId)}/policy.onnx`, { credentials: 'same-origin', cache: 'no-store' });
      if (!bytes.ok) { const error = await bytes.json().catch(() => null); throw new Error(error?.message || `策略制品加载失败（HTTP ${bytes.status}）`); }
      loaded = await ort.InferenceSession.create(await bytes.arrayBuffer(), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
      if (token !== generation || pageUnloading) { await loaded.release(); return; }
      if (loaded.inputNames.length !== 1) throw new Error('OriginBot 试跑仅支持已声明的单一 8D 观测输入。');
      const inputName = loaded.inputNames[0];
      const metadata = Array.isArray(loaded.inputMetadata) ? loaded.inputMetadata[0] : loaded.inputMetadata?.[inputName];
      const shape = metadata?.shape || metadata?.dimensions;
      if (!Array.isArray(shape) || shape.length !== 2 || Number(shape[1]) !== 8 || (Number(shape[0]) > 0 && Number(shape[0]) !== 1)) throw new Error('模型观测输入不符合 OriginBot 8D 契约。');
      policySession = { session: loaded, ort, inputName, outputName: loaded.outputNames.find((name) => ['action', 'actions', 'act'].includes(name)) || loaded.outputNames[0], token, steps: 0, maxSteps, trialId: options.trialId };
      loadingPolicy = false; loadingPolicyTrialId = undefined;
      await mutationQueue;
      if (token !== generation || pageUnloading) return;
      postPolicyStatus('running', 'OriginBot ONNX 策略正在试跑，导航控制器已暂停。', options.trialId); updateTransport();
      void runPolicyStep();
    } catch (error) {
      if (loaded) void loaded.release().catch(() => {});
      if (token !== generation || pageUnloading) return;
      policySession = null; loadingPolicy = false; loadingPolicyTrialId = undefined; running = false;
      setEvent(`策略试跑失败：${error.message}`, 'warn'); postPolicyStatus('failed', error.message, options.trialId); updateTransport();
    }
  }

  async function runPolicyStep() {
    const driver = policySession;
    if (!driver || !active || pageUnloading) return;
    let transition = null;
    try {
      const state = await api(`sessions/${sessionId}/state`);
      if (driver !== policySession || driver.token !== generation) return;
      const observation = observationOf(state);
      driver.inference = driver.session.run({ [driver.inputName]: new driver.ort.Tensor('float32', Float32Array.from(observation), [1, 8]) });
      const results = await driver.inference;
      if (driver !== policySession || driver.token !== generation || !active) return;
      const output = results[driver.outputName]?.data;
      if (!output || output.length !== 2 || Array.from(output).some((value) => !Number.isFinite(value))) throw new Error('模型动作输出不符合 OriginBot 2D 有限数值契约。');
      const command = { linear: clamp(output[0], -1, 1) * finite(state?.cmd_vel?.maxLinear, .3), angular: clamp(output[1], -1, 1) * finite(state?.cmd_vel?.maxAngular, 1) };
      transition = captureCommandRecording(state);
      const next = await api(`sessions/${sessionId}/cmd_vel`, { method: 'POST', body: JSON.stringify(command), guardGeneration: driver.token, recordTransition: transition });
      if (!next) return;
      if (transition.recorded && transition.rows === rows) appendSample(next, state, command, transition);
      if (driver !== policySession || driver.token !== generation || !active) return;
      driver.steps++;
      await render(next, { token: driver.token });
      if (driver !== policySession || driver.token !== generation || !active || pageUnloading) return;
      const reached = TASKS[currentTask]?.automatic && distanceToGoal(next) <= GOAL_EPSILON;
      if (driver.steps >= driver.maxSteps || reached || next.collision) {
        policySession = null; stopRecording(); void driver.session.release().catch(() => {});
        const message = `策略试跑结束：${driver.steps} 步${next.collision ? '，发生碰撞' : reached ? '，到达目标' : '，达到步数上限'}。`;
        setEvent(message, 'ok'); postPolicyStatus('finished', message, driver.trialId); updateTransport(); return;
      }
    } catch (error) {
      if (driver !== policySession || driver.token !== generation) return;
      policySession = null; stopRecording(); void driver.session.release().catch(() => {});
      setEvent(`策略试跑失败：${error.message}`, 'warn'); postPolicyStatus('failed', error.message, driver.trialId); updateTransport(); return;
    } finally { finishCommandRecording(transition); }
    if (driver === policySession) window.setTimeout(runPolicyStep, LOOP_MS);
  }

  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin || event.source !== window.parent) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'rdk-replay-frame' && data.frame) {
      void renderReplayFrame(data.frame, data.taskId, finite(data.index));
      return;
    }
    if (data.type === 'rdk-policy-run') {
      void startPolicyRun(data);
      return;
    }
    if (data.type === 'rdk-policy-stop') {
      stopPolicyRun();
      return;
    }
    if (data.type === 'rdk-replay-clear' || data.type === 'rdk-replay-stop') {
      replaying = false; generation++;
      replayTrace = null;
      setEvent('回放轨迹已清除，恢复实时地图。', 'ok');
      if (latestState) drawMap(latestState);
      updateTransport();
    }
    if (data.type === 'rdk-simulator-task') void setTask(data.taskId);
    if (data.type === 'rdk-simulator-active') {
      const next = data.active === true; if (next === active) return;
      active = next; generation++;
      if (!active) { resumeRunning = running; running = false; stopPolicyRun('当前仿真视图已暂停。'); stopRecording(); window.clearTimeout(loopTimer); loopTimer = null; }
      else { running = resumeRunning && currentTask !== 'visual-twist' && !replaying; void loop(); }
      updateTransport();
    }
  });

  function recordingHeader() {
    return { type: 'header', format: 'originbot-trajectory-v1', source: 'originbot-sim', contractId: 'originbot-policy-v1', taskId: recordingTask, observationSize: 8, actionSize: 2, actionOutput: 'physical-twist', controlPeriodSeconds: .05, createdAt: recordingCreatedAt };
  }
  function recordingText() {
    if (!rows.length) return '';
    return [recordingHeader(), ...rows].map((row) => JSON.stringify(row)).join('\n') + '\n';
  }
  function stopRecording(message, notify = true) {
    if (!recording) { if (!notify) pendingRecordingNotice = null; return recordingText(); }
    recording = false;
    if (notify && pendingRecordedCommand?.recorded && pendingRecordedCommand.accepted && pendingRecordedCommand.rows === rows) pendingRecordingNotice = rows;
    else if (notify) publishRecording();
    if (message) setEvent(message, 'ok'); updateTransport(); return recordingText();
  }
  function publishRecording() {
    if (rows.length) post('rdk-originbot-recording-ready', { taskId: recordingTask, format: 'originbot-trajectory-v1', source: 'originbot-sim', sampleCount: rows.length, contractId: 'originbot-policy-v1', observationSize: 8, actionSize: 2, durationSeconds: finite(rows.at(-1)?.t) - finite(rows[0]?.tStart) });
  }
  window.__rdkOriginbotRecorder = Object.freeze({ get recording() { return recording; }, getText: recordingText, stop: (options = {}) => stopRecording('轨迹已保存。', options.notify !== false), getMetadata: () => ({ taskId: recordingTask, sampleCount: rows.length, format: 'originbot-trajectory-v1' }) });

  function configureTask() {
    const task = TASKS[currentTask];
    $('task-select').value = currentTask;
    if ($('task-title')) $('task-title').textContent = `OriginBot ${task.name}仿真`;
    if ($('stage-title')) $('stage-title').textContent = `${task.name}工作区`;
    if ($('stage-help')) $('stage-help').textContent = task.help;
    if ($('task-description')) $('task-description').textContent = task.help;
    if ($('canvas-hint')) $('canvas-hint').textContent = task.automatic ? '点击设置目标点' : task.manual ? '使用手动速度控制；可录制轨迹' : '相机预览 · 等待视觉观测适配器';
    if ($('manual-controls')) $('manual-controls').hidden = !task.manual;
    manualCommand = { linear: 0, angular: 0 };
    for (const key of ['linear', 'angular']) if ($(`manual-${key}`)) { $(`manual-${key}`).value = '0'; $(`manual-${key}-value`).textContent = key === 'linear' ? '0.00 m/s' : '0.00 rad/s'; }
    running = active && Boolean(task.automatic); resumeRunning = Boolean(task.automatic); updateTransport();
  }
  async function setTask(taskId) {
    if (!TASKS[taskId]) { setEvent(`不支持的 OriginBot 任务：${String(taskId)}`, 'warn'); return; }
    if (taskId === currentTask) { taskState(sessionId ? 'ready' : 'loading', TASKS[currentTask].help); return; }
    stopPolicyRun(); stopRecording(); replaying = false; replayTrace = null; currentTask = taskId;
    const token = ++generation; configureTask();
    taskState('loading', '正在重置并切换 OriginBot 任务控制模式。');
    if (!sessionId) return;
    try { const state = await api(`sessions/${sessionId}/reset`, { method: 'POST' }); if (token !== generation || pageUnloading) return; goalStartDistance = Math.max(distanceToGoal(state), GOAL_EPSILON); await render(state, { forceFrame: true, token }); setEvent(TASKS[currentTask].help, 'ok'); taskState('ready', TASKS[currentTask].help); }
    catch (error) { if (token === generation) { setEvent(`任务切换失败：${error.message}`, 'warn'); taskState('failed', error.message); } }
  }

  $('run').addEventListener('click', () => {
    if (currentTask === 'visual-twist' || !active || !sessionId) return;
    replaying = false;
    running = !running;
    if (!running) stopRecording('仿真已暂停，轨迹已保存。');
    setEvent(running ? '仿真继续运行。' : '仿真已暂停。', running ? 'ok' : 'warn');
    updateTransport();
  });

  $('reset').addEventListener('click', async () => {
    if (!sessionId) return;
    stopPolicyRun(); stopRecording(); running = false; replaying = false; replayTrace = null; const token = ++generation;
    try {
      const state = await api(`sessions/${sessionId}/reset`, { method: 'POST' });
      if (token !== generation || pageUnloading) return;
      configureTask(); setEvent('仿真已重置，已有录制可导出。', 'ok');
      goalStartDistance = Math.max(distanceToGoal(state), GOAL_EPSILON);
      await render(state, { forceFrame: true });
    } catch (error) {
      setEvent(`重置失败：${error.message}`, 'warn');
    }
  });

  $('record').addEventListener('click', () => {
    if (!sessionId) return;
    if (!recording) {
      rows = [];
      recordingTask = currentTask; recordingCreatedAt = new Date().toISOString();
      recordingBytes = lineBytes(recordingHeader());
      recording = true;
      running = !policySession;
      setEvent('开始录制 OriginBot 8D→2D 契约数据。', 'ok');
    } else {
      stopRecording(`录制已停止，共 ${rows.length} 个样本；可导出 JSONL。`);
    }
    updateTransport();
  });

  $('stop').addEventListener('click', () => {
    if (!rows.length) return;
    stopRecording();
    const url = URL.createObjectURL(
      new Blob([recordingText()], {
        type: 'application/x-ndjson',
      }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'originbot-mujoco.jsonl';
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setEvent(`已导出 ${rows.length} 个 JSONL 样本。`, 'ok');
  });

  $('task-select').addEventListener('change', (event) => {
    void setTask(event.target.value); post('rdk-simulator-task-selected', { taskId: event.target.value });
  });
  for (const key of ['linear', 'angular']) $(`manual-${key}`)?.addEventListener('input', (event) => { manualCommand[key] = finite(event.target.value); $(`manual-${key}-value`).textContent = `${manualCommand[key].toFixed(2)} ${key === 'linear' ? 'm/s' : 'rad/s'}`; });
  $('manual-zero')?.addEventListener('click', () => { manualCommand = { linear: 0, angular: 0 }; for (const key of ['linear', 'angular']) { $(`manual-${key}`).value = '0'; $(`manual-${key}-value`).textContent = `0.00 ${key === 'linear' ? 'm/s' : 'rad/s'}`; } });

  canvas.addEventListener('click', (event) => {
    if (!TASKS[currentTask]?.automatic || replaying || policySession || loadingPolicy) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    setGoal(
      {
        x: ((event.clientX - rect.left) * canvas.width / rect.width - canvas.width / 2) / 180,
        y: (canvas.height / 2 - (event.clientY - rect.top) * canvas.height / rect.height) / 180,
      },
      '已设置新的目标点。',
    );
  });

  // The recorder and diagnostics overlay consume this small compatibility
  // surface. It always reflects the latest MuJoCo state and exposes the
  // canonical OriginBot 8D observation / 2D twist action.
  window.rl = {
    buildObs: () => observationOf(latestState),
    get lastAction() { return actionOf(latestState); },
    get cmd() { return actionOf(latestState); },
    // Low-level MuJoCo escape hatch for deterministic replay/diagnostics.
    // The normal goal-navigation loop uses /cmd_vel so the server remains
    // the single source of differential-drive projection.
    step: (controls = [], steps = 1) => sessionId
      ? api(`sessions/${sessionId}/step`, {
          method: 'POST',
          body: JSON.stringify({ controls, steps }),
        })
      : Promise.reject(new Error('MuJoCo session is not ready')),
    get data() { return { qpos: qposOf(latestState), qvel: qvelOf(latestState) }; },
    get mode() { return currentTask; },
    get loco() { return 'differential-drive'; },
    get telemetry() { return telemetryOf(latestState); },
  };

  let connectionAttempt = 0;
  async function connect() {
    const attempt = ++connectionAttempt; generation++; running = false;
    window.clearTimeout(loopTimer); loopTimer = null;
    stopPolicyRun(); stopRecording();
    const previousId = sessionId; sessionId = null; updateTransport();
    setConnection(false, '连接 MuJoCo…'); if ($('retry')) $('retry').disabled = true;
    taskState('loading', '正在创建 OriginBot 物理场景。');
    try {
      if (previousId) await api(`sessions/${previousId}`, { method: 'DELETE' }).catch(() => {});
      const state = await api('sessions', { method: 'POST', body: JSON.stringify({ model: 'originbot', seed: sessionSeed, domain_randomization: domainRandomization }) });
      if (pageUnloading || attempt !== connectionAttempt) { void fetch(`${API_ROOT}/sessions/${state.id}`, { method: 'DELETE', credentials: 'same-origin', keepalive: true }).catch(() => {}); return; }
      sessionId = state.id; latestState = state; configureTask();
      setConnection(true, 'MuJoCo 已连接');
      goalStartDistance = Math.max(distanceToGoal(state), GOAL_EPSILON);
      await render(state, { forceFrame: true });
      setEvent(TASKS[currentTask].help, 'ok'); taskState('ready', TASKS[currentTask].help);
      if (active) void loop();
    } catch (error) {
      if (pageUnloading || attempt !== connectionAttempt) return;
      setConnection(false, 'MuJoCo 不可用'); updateTransport();
      setEvent(`MuJoCo 服务不可用：${error.message}`, 'warn'); taskState('failed', error.message);
    } finally { if ($('retry')) $('retry').disabled = false; }
  }
  if (!TASKS[currentTask]) currentTask = 'goal-navigation';
  configureTask(); updateGoalReadout(); updateTransport();
  $('retry')?.addEventListener('click', () => { void connect(); });
  void connect();

  window.addEventListener('pagehide', () => {
    releaseSession();
    if (depthObjectUrl) URL.revokeObjectURL(depthObjectUrl);
  });
})();
