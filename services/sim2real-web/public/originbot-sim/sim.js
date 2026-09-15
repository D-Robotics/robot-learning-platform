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
  const configuredBase = String(
    window.RDK_MUJOCO_BASE || document.documentElement.dataset.mujocoBase || '/mujoco',
  ).trim();
  const normalizedBase = configuredBase.replace(/^\/+|\/+$/g, '');
  const mujocoBase = normalizedBase ? `/${normalizedBase}` : '';
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

  async function api(path, options = {}) {
    const response = await fetch(`${API_ROOT}/${path.replace(/^\/+/, '')}`, {
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
        const message = typeof parsed?.message === 'string' ? parsed.message : '';
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
  }

  function updateGoalReadout() {
    const readout = $('goal-readout');
    if (readout) readout.textContent = `X ${goal.x.toFixed(2)} · Y ${goal.y.toFixed(2)}`;
  }

  function distanceToGoal(state = latestState) {
    const position = positionOf(state);
    return Math.hypot(goal.x - position.x, goal.y - position.y);
  }

  function updateTransport() {
    const runButton = $('run');
    const recordButton = $('record');
    const exportButton = $('stop');
    const status = $('status-badge');
    if (runButton) {
      runButton.textContent = running ? 'Ⅱ 暂停' : '▶ 继续';
      runButton.setAttribute('aria-pressed', String(running));
    }
    if (recordButton) {
      recordButton.textContent = recording ? '■ 停止录制' : '● 开始录制';
      recordButton.classList.toggle('recording', recording);
      recordButton.setAttribute('aria-pressed', String(recording));
      recordButton.disabled = !sessionId;
    }
    if (exportButton) exportButton.disabled = rows.length === 0;
    if (status) {
      const reached = latestState && distanceToGoal(latestState) <= GOAL_EPSILON;
      const collision = Boolean(latestState?.collision);
      const outcome = collision ? 'collision' : reached ? 'goal' : '';
      status.textContent = outcome === 'collision' ? '● 发生碰撞' : outcome === 'goal' ? '● 已到达目标' : running ? (recording ? '● 录制中' : '● 运行中') : '● 已暂停';
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

  function observationOf(state) {
    const position = positionOf(state);
    const yaw = yawOf(state);
    const odom = odomOf(state);
    const imu = imuOf(state);
    return [
      position.x,
      position.y,
      Math.sin(yaw),
      Math.cos(yaw),
      goal.x - position.x,
      goal.y - position.y,
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

  function appendSample(state, previousState = state, command = actionOf(state)) {
    const metrics = updateReadouts(state);
    const action = [finite(command?.linear), finite(command?.angular)];
    const maxLinear = finite(state?.cmd_vel?.maxLinear, 0.3);
    const maxAngular = finite(state?.cmd_vel?.maxAngular, 1.0);
    const distanceBefore = distanceToGoal(previousState);
    const distanceAfter = metrics.distance;
    const collision = Boolean(state?.collision);
    const done = distanceAfter <= GOAL_EPSILON || collision;
    rows.push({
      t: finite(previousState?.time, finite(state?.time)),
      tNext: finite(state?.time),
      controlPeriodSeconds: finite(state?.model?.controlPeriod, 0.05),
      controlHz: finite(state?.model?.controlHz, 20),
      // Keep the original observation/action keys while adding an explicit
      // transition pair for offline RL consumers.
      observation: observationOf(previousState),
      nextObservation: observationOf(state),
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
      reward: Number((distanceBefore - distanceAfter - 0.01 * (Math.abs(action[0]) + Math.abs(action[1])) + (distanceAfter <= GOAL_EPSILON ? 5 : 0) - (collision ? 5 : 0)).toFixed(6)),
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
    });
  }

  async function drawFrame() {
    if (!sessionId) return;
    const response = await fetch(
      `${API_ROOT}/sessions/${sessionId}/frame.jpg?t=${Date.now()}`,
      { cache: 'no-store', headers: { accept: 'image/jpeg' } },
    );
    if (!response.ok) throw new Error(`frame ${response.status}`);
    const blob = await response.blob();
    if (typeof createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(blob);
      paintFrame(bitmap, bitmap.width, bitmap.height);
      bitmap.close();
      return;
    }
    // Safari/WebViews without createImageBitmap still get the server frame.
    await new Promise((resolve, reject) => {
      const image = new Image();
      const objectUrl = URL.createObjectURL(blob);
      image.onload = () => {
        paintFrame(image, image.naturalWidth || image.width, image.naturalHeight || image.height);
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
    const response = await fetch(`${API_ROOT}/sessions/${sessionId}/depth.jpg?t=${Date.now()}`, {
      cache: 'no-store', headers: { accept: 'image/jpeg' },
    });
    if (!response.ok) throw new Error(`depth ${response.status}`);
    const nextUrl = URL.createObjectURL(await response.blob());
    const previousUrl = depthObjectUrl;
    depthObjectUrl = nextUrl;
    const image = $('depth-view');
    image.src = nextUrl;
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    if ($('depth-readout-mini')) $('depth-readout-mini').textContent = '实时 · mono8';
  }

  async function render(state, { forceFrame = false } = {}) {
    latestState = state;
    updateReadouts(state);
    drawMap(state);
    drawLidar(state);
    $('observation').textContent = JSON.stringify(state?.sensors || {}, null, 2);
    $('action').textContent = JSON.stringify(state?.cmd_vel || {}, null, 2);
    if (!forceFrame && Date.now() - lastFrameAt < FRAME_MS) return;
    try {
      await drawFrame();
      if (forceFrame || Date.now() - lastDepthAt >= 300) {
        await drawDepth();
        lastDepthAt = Date.now();
      }
      lastFrameAt = Date.now();
    } catch (error) {
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

  async function loop() {
    if (!sessionId || loopBusy) return;
    loopBusy = true;
    try {
      let state = await api(`sessions/${sessionId}/state`);
      if (running) {
        const previousState = state;
        const command = computeCommand(state);
        state = await api(`sessions/${sessionId}/cmd_vel`, {
          method: 'POST',
          body: JSON.stringify(command),
        });
        if (recording) appendSample(state, previousState, command);
      }
      await render(state);
    } catch (error) {
      setConnection(false, 'MuJoCo 连接异常');
      setEvent(`MuJoCo 服务暂时不可用：${error.message}`, 'warn');
    } finally {
      loopBusy = false;
      if (sessionId) loopTimer = window.setTimeout(loop, LOOP_MS);
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
  // The parent Run page posts frames of a completed run's evaluation
  // telemetry. Rendering keeps the physics session untouched: the replay is
  // recorded evidence, not a re-simulation, so it paints onto the map view
  // as a trajectory trace while the robot marker follows the frame's
  // position.
  function renderReplayFrame(frame) {
    if (!frame || !Array.isArray(frame.observation)) return;
    const [x, y] = frame.observation;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (!replayTrace) replayTrace = { positions: [], t: [] };
    replayTrace.positions.push({ x, y });
    replayTrace.t.push(finite(frame.t));
    if (replayTrace.positions.length > 2000) {
      replayTrace.positions.shift();
      replayTrace.t.shift();
    }
    const mockState = {
      qpos: [x, y, 0, 1, 0, 0, 0],
      sensors: {
        odom: { x, y },
        scan: Array.isArray(frame.observation) ? [] : [],
      },
      time: finite(frame.t),
    };
    drawMap(mockState);
    if ($('map-readout')) {
      $('map-readout').textContent = `回放 t=${finite(frame.t).toFixed(2)} s`;
    }
    setEvent(`回放帧 ${replayTrace.positions.length}：position (${x.toFixed(2)}, ${y.toFixed(2)})`, 'ok');
  }

  // Policy trial runs entirely inside this page (microduck pattern): the
  // parent posts only clonable data (runId + API root); postMessage cannot
  // carry functions, so the ONNX session, the bytes fetch, and the inference
  // loop all live here. Status flows back through 'rdk-policy-status'.
  const postPolicyStatus = (phase, message) => {
    try {
      window.parent?.postMessage({ type: 'rdk-policy-status', phase, message }, '*');
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

  async function startPolicyRun(options = {}) {
    if (policySession) {
      setEvent('策略试跑已在进行中。', 'warn');
      return;
    }
    const runId = String(options.runId || '').trim();
    const apiRoot = String(options.apiRoot || '').trim();
    if (!runId || !apiRoot) {
      setEvent('父页面未提供 runId / apiRoot，无法试跑策略。', 'warn');
      postPolicyStatus('failed', '缺少 runId 或 apiRoot。');
      return;
    }
    if (!sessionId) {
      setEvent('MuJoCo 会话不可用，策略试跑中止。', 'warn');
      postPolicyStatus('failed', 'MuJoCo 会话不可用。');
      return;
    }
    policySession = {
      runId,
      maxSteps: finite(options.maxSteps, 600),
      steps: 0,
      session: null,
    };
    setEvent(`策略试跑开始：run ${runId.slice(0, 8)}（最多 ${policySession.maxSteps} 步）。`, 'ok');
    postPolicyStatus('loading', '正在加载浏览器 ONNX 运行时…');
    try {
      const ort = await loadOrt();
      const response = await fetch(
        `${apiRoot.replace(/\/+$/, '')}/runs/${encodeURIComponent(runId)}/policy.onnx`,
        { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/octet-stream' } },
      );
      if (!response.ok) throw new Error(`策略字节获取失败（HTTP ${response.status}）`);
      const bytes = await response.arrayBuffer();
      if (!bytes.byteLength) throw new Error('策略字节为空');
      postPolicyStatus('loading', '正在编译 ONNX 模型（首次约数秒）…');
      policySession.session = await ort.InferenceSession.create(bytes, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
      postPolicyStatus('running', `模型已编译，开始推理（${policySession.maxSteps} 步上限）。`);
      runPolicyStep();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setEvent(`策略试跑启动失败：${message}`, 'warn');
      postPolicyStatus('failed', message);
      policySession = null;
    }
  }

  async function runPolicyStep() {
    if (!policySession || !policySession.session) return;
    if (policySession.steps >= policySession.maxSteps) {
      const reached = latestState && distanceToGoal(latestState) <= GOAL_EPSILON;
      const message = `策略试跑结束：${policySession.steps} 步${reached ? '，到达目标点。' : '，达到步数上限。'}`;
      setEvent(message, reached ? 'ok' : 'warn');
      postPolicyStatus('finished', message);
      policySession = null;
      return;
    }
    try {
      const state = await api(`sessions/${sessionId}/state`);
      const ort = ortRuntime;
      const obs = observationOf(state);
      const session = policySession.session;
      const inputName = session.inputNames[0] || 'observation';
      const outputName = session.outputNames[0] || 'action';
      const results = await session.run({
        [inputName]: new ort.Tensor('float32', Float32Array.from(obs.map(finite)), [1, obs.length]),
      });
      const output = results[outputName]?.data;
      const action = [finite(output?.[0]), finite(output?.[1])];
      const maxLinear = finite(state?.cmd_vel?.maxLinear, 0.3);
      const maxAngular = finite(state?.cmd_vel?.maxAngular, 1.0);
      // The policy head is normalized [-1, 1]; project to the same physical
      // twist bounds the built-in navigator and the board runtime use.
      const command = {
        linear: clamp(action[0], -1, 1) * maxLinear,
        angular: clamp(action[1], -1, 1) * maxAngular,
      };
      const next = await api(`sessions/${sessionId}/cmd_vel`, {
        method: 'POST',
        body: JSON.stringify(command),
      });
      policySession.steps += 1;
      await render(next);
      if (distanceToGoal(next) <= GOAL_EPSILON || next?.collision) {
        const collided = Boolean(next?.collision);
        const message = `策略试跑结束：${policySession.steps} 步，${collided ? '发生碰撞。' : '到达目标点。'}`;
        setEvent(message, collided ? 'warn' : 'ok');
        postPolicyStatus('finished', message);
        policySession = null;
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setEvent(`策略试跑失败：${message}`, 'warn');
      postPolicyStatus('failed', message);
      policySession = null;
      return;
    }
    if (policySession) {
      window.setTimeout(runPolicyStep, LOOP_MS);
    }
  }

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'rdk-replay-frame' && data.frame) {
      renderReplayFrame(data.frame);
      return;
    }
    if (data.type === 'rdk-policy-run') {
      startPolicyRun(data);
      return;
    }
    if (data.type === 'rdk-policy-stop') {
      if (policySession) {
        policySession = null;
        setEvent('策略试跑已手动停止。', 'warn');
        postPolicyStatus('stopped', '策略试跑已手动停止。');
      }
      return;
    }
    if (data.type === 'rdk-replay-clear') {
      replayTrace = null;
      setEvent('回放轨迹已清除，恢复实时地图。', 'ok');
      if (latestState) drawMap(latestState);
    }
  });

  function clearRecording(message) {
    rows = [];
    recording = false;
    updateTransport();
    if (message) setEvent(message, 'ok');
  }

  $('run').addEventListener('click', () => {
    running = !running;
    setEvent(running ? '仿真继续运行。' : '仿真已暂停。', running ? 'ok' : 'warn');
    updateTransport();
  });

  $('reset').addEventListener('click', async () => {
    if (!sessionId) return;
    try {
      const state = await api(`sessions/${sessionId}/reset`, { method: 'POST' });
      running = true;
      clearRecording('仿真已重置，录制缓存已清空。');
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
      recording = true;
      setEvent('开始录制 OriginBot 8D→2D 契约数据。', 'ok');
    } else {
      recording = false;
      setEvent(`录制已停止，共 ${rows.length} 个样本；可导出 JSONL。`, 'ok');
    }
    updateTransport();
  });

  $('stop').addEventListener('click', () => {
    if (!rows.length) return;
    const url = URL.createObjectURL(
      new Blob([`${rows.map((row) => JSON.stringify(row)).join('\n')}\n`], {
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
    const cruise = event.target.value.includes('巡航');
    setGoal(cruise ? { x: -1.1, y: 1 } : { x: 1.5, y: 0.8 }, cruise ? '已切换到定点巡航示例。' : '已切换到目标导航。');
    clearRecording('任务已切换，录制缓存已清空。');
  });

  canvas.addEventListener('click', (event) => {
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
    get mode() { return 'goal-navigation'; },
    get loco() { return 'differential-drive'; },
    get telemetry() { return telemetryOf(latestState); },
  };

  updateGoalReadout();
  updateTransport();
  setEvent('正在创建 OriginBot MuJoCo 会话……');
  api('sessions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'originbot',
      seed: sessionSeed,
      domain_randomization: domainRandomization,
    }),
  })
    .then(async (state) => {
      // A slow session create can resolve after pagehide.  Do not install a
      // late session into a page that is already gone; release it directly
      // with keepalive so it cannot consume a slot until the TTL.
      if (pageUnloading) {
        fetch(`${API_ROOT}/sessions/${state.id}`, {
          method: 'DELETE',
          keepalive: true,
          headers: { accept: 'application/json' },
        }).catch(() => {});
        return;
      }
      sessionId = state.id;
      setConnection(true, 'MuJoCo 已连接');
      latestState = state;
      goalStartDistance = Math.max(distanceToGoal(state), GOAL_EPSILON);
      updateTransport();
      await render(state, { forceFrame: true });
      setEvent('MuJoCo 会话已就绪，点击场景可设置目标点。', 'ok');
      loop();
    })
    .catch((error) => {
      setConnection(false, 'MuJoCo 不可用');
      updateTransport();
      setEvent(`MuJoCo 服务不可用：${error.message}`, 'warn');
    });

  window.addEventListener('pagehide', () => {
    releaseSession();
    if (depthObjectUrl) URL.revokeObjectURL(depthObjectUrl);
  });
})();
