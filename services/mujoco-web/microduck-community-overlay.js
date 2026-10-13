(() => {
  'use strict';

  const BUTTON_ID = 'rdk-microduck-community-button';
  const WALL_ID = 'rdk-microduck-community-wall';
  const MODAL_ID = 'rdk-microduck-community-modal';
  const MOBILE_TOGGLE_ID = 'rdk-microduck-mobile-toggle';
  const MOBILE_PANEL_ID = 'rdk-microduck-mobile-controls';
  const MOBILE_STYLE_ID = 'rdk-microduck-mobile-style';
  const LANDING_HELP_ID = 'rdk-microduck-touch-help';
  const LANDING_HELP_STYLE_ID = 'rdk-microduck-touch-help-style';
  const RECORDER_PANEL_ID = 'rdk-microduck-recorder';
  const RECORDER_STYLE_ID = 'rdk-microduck-recorder-style';
  const RECORDER_MAX_STEPS = 30_000; // 10 minutes at the 50 Hz policy loop.
  const RECORDER_MAX_BYTES = 30 * 1024 * 1024; // Leave room for the parent's 32 MiB import limit.
  const POLICY_PANEL_ID = 'rdk-microduck-policy';
  const POLICY_STYLE_ID = 'rdk-microduck-policy-style';
  // Keep every policy request in the workbench's mounted API namespace. The
  // site root can host a separate Studio API, even though the origin is shared.
  // An independently mounted simulator can use ?rdkApi=/robotics-learning.
  const POLICY_API_BASE = (() => {
    const mounted = window.location.pathname.match(/^(.*?)\/mujoco\/microduck(?:\/|$)/);
    const fallback = String(mounted?.[1] || '').replace(/\/+$/, '');
    try {
      const override = new URLSearchParams(window.location.search).get('rdkApi');
      if (override) {
        const api = new URL(override, `${window.location.origin}/`);
        if (api.origin === window.location.origin && !api.search && !api.hash)
          return api.pathname.replace(/\/+$/, '');
      }
    } catch {
      /* keep the mounted same-origin default */
    }
    return fallback;
  })();
  const QR_SRC = './community/microduck-wechat.png';

  function style(element, values) {
    Object.assign(element.style, values);
  }

  function closeModal() {
    document.getElementById(MODAL_ID)?.remove();
  }

  function openModal() {
    if (document.getElementById(MODAL_ID)) return;

    const backdrop = document.createElement('div');
    backdrop.id = MODAL_ID;
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.setAttribute('aria-label', '加入 MicroDuck 微信群');
    style(backdrop, {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483647',
      display: 'grid',
      placeItems: 'center',
      padding: '24px',
      background: 'rgba(0, 0, 0, .68)',
      backdropFilter: 'blur(5px)',
    });

    const card = document.createElement('section');
    style(card, {
      position: 'relative',
      width: 'min(360px, 100%)',
      padding: '24px 24px 22px',
      borderRadius: '22px',
      background: '#fff',
      color: '#111318',
      textAlign: 'center',
      boxShadow: '0 24px 80px rgba(0, 0, 0, .45)',
      fontFamily: 'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    });

    const close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭二维码');
    close.textContent = '×';
    style(close, {
      position: 'absolute',
      top: '8px',
      right: '12px',
      width: '34px',
      height: '34px',
      border: '0',
      borderRadius: '50%',
      background: 'transparent',
      color: '#777',
      fontSize: '28px',
      lineHeight: '1',
      cursor: 'pointer',
    });
    close.addEventListener('click', closeModal);

    const title = document.createElement('h2');
    title.textContent = '加入 MicroDuck 微信群';
    style(title, { margin: '0 18px 6px', fontSize: '20px', lineHeight: '1.3' });

    const hint = document.createElement('p');
    hint.textContent = '微信扫一扫，和大家一起交流仿真与训练';
    style(hint, { margin: '0 0 16px', color: '#6c7280', fontSize: '13px', lineHeight: '1.5' });

    const image = document.createElement('img');
    image.src = QR_SRC;
    image.alt = 'MicroDuck 微信群二维码';
    image.width = 396;
    image.height = 396;
    style(image, {
      display: 'block',
      width: 'min(296px, 100%)',
      height: 'auto',
      margin: '0 auto',
      imageRendering: 'pixelated',
      borderRadius: '4px',
    });

    card.append(close, title, hint, image);
    backdrop.append(card);
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) closeModal();
    });
    document.body.append(backdrop);
    close.focus();
  }

  function isLanding() {
    return /WADDLE\s+IN|开始仿真/i.test(document.body?.innerText || '');
  }

  const translations = new Map([
    [
      'the exact same trained policies that drive the real robot, live in your browser.',
      '与真实机器人相同的训练策略，直接在浏览器中运行。',
    ],
    ['move', '移动'],
    ['arrows or zqsd', '方向键或 WASD'],
    ['kick', '踢球'],
    ['quack', '叫一声'],
    ['head', '头部视角'],
    ['left / right', '左 / 右'],
    ['sit', '坐下'],
    ['tap again to stand', '再次按下即可站立'],
    ['pick up', '拾取'],
    ['beak to the ground', '喙朝地面'],
    ['camera', '跟随视角'],
    ['toggle chase', '切换跟随视角'],
    ['reset', '重置'],
    ['fresh start', '重新开始'],
    ['drag to orbit • scroll to zoom', '拖动旋转视角 · 滚动缩放'],
    ['drag to orbit · scroll to zoom', '拖动旋转视角 · 滚动缩放'],
    ['waddle in', '开始仿真'],
    ['resume', '继续仿真'],
    ['mode', '模式'],
    ['color', '配色'],
    ['nav', '导航'],
    ['duck colours', '鸭子配色'],
    ['locomotion mode', '移动模式'],
    ['feet', '双足'],
    ['rollers', '滚轮'],
    ['back', '返回'],
  ]);

  function translatePage() {
    if (!document.body) return;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    for (const textNode of nodes) {
      const original = textNode.nodeValue || '';
      const normalized = original.trim().toLowerCase();
      const translated = translations.get(normalized);
      if (!translated) continue;
      const leading = original.match(/^\s*/)?.[0] || '';
      const trailing = original.match(/\s*$/)?.[0] || '';
      textNode.nodeValue = leading + translated + trailing;
    }
  }

  // The upstream landing cards currently show A/E for kick and ZQSD for
  // movement, but the keyboard adapter listens to Q/E and W/A/S/D. Correct
  // the visual legend without changing the simulator's event handling.
  function patchControlKeyLabels() {
    const cards = [...document.querySelectorAll('div')];
    const findCard = (label, keyCount) =>
      cards
        .filter((element) => {
          const text = (element.innerText || '').trim();
          return (
            new RegExp(label, 'i').test(text) && element.querySelectorAll('kbd').length === keyCount
          );
        })
        .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];

    const moveCard = findCard('移动|move', 4);
    if (moveCard) {
      const hint = [...moveCard.querySelectorAll('div')].find((element) =>
        /方向键或\s*(?:ZQSD|WASD)|arrows?\s+or\s+zqsd/i.test(element.textContent || ''),
      );
      if (hint && hint.textContent !== '方向键或 WASD') hint.textContent = '方向键或 WASD';
    }

    const kickCard = findCard('踢球|kick', 2);
    if (kickCard) {
      const keys = kickCard.querySelectorAll('kbd');
      if (keys.length === 2) {
        if (keys[0].textContent !== 'Q') keys[0].textContent = 'Q';
        if (keys[1].textContent !== 'E') keys[1].textContent = 'E';
      }
    }
  }

  function isTouchSurface() {
    const forced = new URLSearchParams(window.location.search).get('touch') === '1';
    return Boolean(
      forced ||
      window.__microduckTouched ||
      navigator.maxTouchPoints > 0 ||
      window.matchMedia?.('(pointer: coarse)').matches,
    );
  }

  function landingStartButton() {
    return [...document.querySelectorAll('button')].find((element) =>
      /开始仿真|waddle in/i.test(element.textContent || ''),
    );
  }

  function mountTouchLandingHelp() {
    if (!isLanding() || !isTouchSurface()) {
      document.getElementById(LANDING_HELP_ID)?.remove();
      return;
    }
    if (document.getElementById(LANDING_HELP_ID)) return;

    const startButton = landingStartButton();
    const host = startButton?.parentElement?.parentElement;
    if (!host) return;

    if (!document.getElementById(LANDING_HELP_STYLE_ID)) {
      const styleTag = document.createElement('style');
      styleTag.id = LANDING_HELP_STYLE_ID;
      styleTag.textContent = `
        #${LANDING_HELP_ID} {
          width: min(100%, 720px);
          margin: 16px auto 0;
          padding: 13px 15px 12px;
          border: 1px solid rgba(255, 122, 47, .38);
          border-radius: 14px;
          background: linear-gradient(135deg, rgba(31, 28, 35, .9), rgba(19, 18, 25, .84));
          color: rgba(255, 255, 255, .92);
          box-sizing: border-box;
          font: 600 12px/1.35 system-ui, -apple-system, sans-serif;
          text-align: left;
          box-shadow: 0 10px 30px rgba(0, 0, 0, .16), inset 0 1px 0 rgba(255, 255, 255, .05);
        }
        #${LANDING_HELP_ID} .rdk-touch-help-heading {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 12px;
        }
        #${LANDING_HELP_ID} .rdk-touch-help-heading strong { color: #ffad72; font-size: 13px; letter-spacing: .04em; }
        #${LANDING_HELP_ID} .rdk-touch-help-heading small { color: rgba(255, 255, 255, .38); font-size: 9px; letter-spacing: .16em; }
        #${LANDING_HELP_ID} .rdk-touch-help-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 7px;
          margin-top: 10px;
        }
        #${LANDING_HELP_ID} .rdk-touch-help-item {
          display: flex;
          align-items: center;
          gap: 7px;
          min-width: 0;
          padding: 7px 8px;
          border: 1px solid rgba(255, 255, 255, .1);
          border-radius: 9px;
          background: rgba(255, 255, 255, .045);
        }
        #${LANDING_HELP_ID} kbd {
          flex: 0 0 auto;
          padding: 2px 5px;
          border: 1px solid rgba(255, 255, 255, .3);
          border-radius: 5px;
          color: #171018;
          background: #ffad72;
          font: 800 10px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
          white-space: nowrap;
        }
        #${LANDING_HELP_ID} .rdk-touch-help-item span { min-width: 0; color: rgba(255, 255, 255, .78); font-size: 11px; white-space: nowrap; }
        #${LANDING_HELP_ID} .rdk-touch-help-note { margin: 9px 1px 0; color: rgba(255, 255, 255, .46); font-size: 10px; }
        @media (min-width: 651px) {
          #${LANDING_HELP_ID} .rdk-touch-help-grid { grid-template-columns: repeat(5, minmax(0, 1fr)); }
        }
        @media (max-width: 650px) {
          #${LANDING_HELP_ID} { margin-top: 13px; padding: 12px; }
          #${LANDING_HELP_ID} .rdk-touch-help-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
          #${LANDING_HELP_ID} .rdk-touch-help-item { padding: 7px 6px; gap: 5px; }
          #${LANDING_HELP_ID} .rdk-touch-help-item span { font-size: 10px; }
        }
        @media (max-width: 390px) {
          #${LANDING_HELP_ID} .rdk-touch-help-heading small { display: none; }
          #${LANDING_HELP_ID} .rdk-touch-help-item span { font-size: 9px; }
        }
      `;
      document.head.append(styleTag);
    }

    const help = document.createElement('section');
    help.id = LANDING_HELP_ID;
    help.setAttribute('aria-label', '完整仿真操作说明');
    help.innerHTML = `
      <div class="rdk-touch-help-heading">
        <strong>完整操作说明</strong>
        <small>FULL CONTROLS</small>
      </div>
      <div class="rdk-touch-help-grid">
        <div class="rdk-touch-help-item"><kbd>摇杆 / WASD</kbd><span>移动</span></div>
        <div class="rdk-touch-help-item"><kbd>Q · E</kbd><span>左 / 右踢球</span></div>
        <div class="rdk-touch-help-item"><kbd>F</kbd><span>换脚踢球</span></div>
        <div class="rdk-touch-help-item"><kbd>B（平台）</kbd><span>叫一声</span></div>
        <div class="rdk-touch-help-item"><kbd>R</kbd><span>坐下 / 站起</span></div>
        <div class="rdk-touch-help-item"><kbd>G</kbd><span>拾取</span></div>
        <div class="rdk-touch-help-item"><kbd>C</kbd><span>跟随视角</span></div>
        <div class="rdk-touch-help-item"><kbd>M</kbd><span>运动模式</span></div>
        <div class="rdk-touch-help-item"><kbd>Space</kbd><span>重置仿真</span></div>
        <div class="rdk-touch-help-item"><kbd>拖动 / 双指</kbd><span>旋转 / 缩放</span></div>
      </div>
      <p class="rdk-touch-help-note">手机端启动后，点击右侧橙色“更多操作”可打开完整控制面板。</p>
    `;
    host.insertBefore(help, startButton.parentElement);
  }

  function runtime() {
    return window.rl || null;
  }

  const BROWSER_SCENE_ID = 'microduck-single-duck-v1';
  const BROWSER_TASK_IDS = new Set(['walk', 'turn', 'sit', 'recover', 'kick', 'custom']);
  const BROWSER_TASK_LABELS = {
    walk: '行走',
    turn: '转向',
    sit: '坐下 / 站起',
    recover: '自恢复',
    kick: '踢球',
    custom: '自定义动作',
  };
  const simulatorContext = {
    taskId: 'walk',
    ready: false,
    active: true,
    pending: null,
    timer: null,
    replay: null,
    pause: null,
  };
  const policyTrial = {
    token: 0,
    timer: null,
    active: false,
    loading: false,
    runId: '',
    trialId: undefined,
    loadChain: Promise.resolve(),
    binding: null,
    monitor: null,
    phase: 'stopped',
    message: '',
    taskId: '',
    slots: [],
    relevantModeCount: 0,
    maxSteps: 600,
    startedAt: 0,
  };

  function parentOrigin() {
    try {
      return window.parent.location.origin;
    } catch {
      /* cross-origin embed */
    }
    try {
      return new URL(document.referrer).origin;
    } catch {
      return window.location.origin;
    }
  }

  function trustedParentMessage(event) {
    return (
      window.parent !== window &&
      event.source === window.parent &&
      event.origin !== 'null' &&
      event.origin === parentOrigin()
    );
  }

  function notifyParent(payload, origin = parentOrigin()) {
    if (window.parent === window) return;
    try {
      window.parent.postMessage(payload, origin);
    } catch {
      /* detached parent */
    }
  }

  function taskState(taskId, phase, message) {
    notifyParent({
      type: 'rdk-simulator-task-state',
      taskId,
      sceneId: BROWSER_SCENE_ID,
      phase,
      message,
    });
  }

  function clearMotionCommand(current) {
    current.velCmd?.fill?.(0);
    for (const source of current.controller?.sources || []) source.command?.fill?.(0);
    if (current.cmd?.length >= 3) {
      current.cmd[0] = 0;
      current.cmd[1] = 0;
      current.cmd[2] = 0;
    }
  }

  function stopReplayState() {
    const replay = simulatorContext.replay;
    if (!replay) return;
    if (replay.current.mujoco.mj_step === replay.guard)
      replay.current.mujoco.mj_step = replay.originalStep;
    replay.current.controller?.setLocked?.(replay.wasLocked);
    simulatorContext.replay = null;
    if (!simulatorContext.active) pauseSimulatorState();
  }

  function stopSimulatorPause() {
    const pause = simulatorContext.pause;
    if (!pause) return;
    if (pause.current.mujoco.mj_step === pause.guard)
      pause.current.mujoco.mj_step = pause.originalStep;
    pause.current.controller?.setLocked?.(pause.wasLocked);
    simulatorContext.pause = null;
  }

  function pauseSimulatorState() {
    if (simulatorContext.pause || simulatorContext.replay) return;
    const current = runtime();
    if (
      !current?.model ||
      !current.data?.qpos ||
      !current.data?.qvel ||
      typeof current.mujoco?.mj_step !== 'function' ||
      typeof current.mujoco?.mj_forward !== 'function'
    )
      return;
    const pause = {
      current,
      model: current.model,
      data: current.data,
      originalStep: current.mujoco.mj_step,
      wasLocked: Boolean(current.inputLocked),
      qpos: Array.from(current.data.qpos),
      qvel: Array.from(current.data.qvel),
    };
    pause.guard = (...args) => {
      if (current.data !== pause.data) {
        stopSimulatorPause();
        return pause.originalStep.apply(current.mujoco, args);
      }
      if (args.length && (args[0] !== pause.model || args[1] !== pause.data))
        return pause.originalStep.apply(current.mujoco, args);
      pause.data.qpos.set(pause.qpos);
      pause.data.qvel.set(pause.qvel);
      current.mujoco.mj_forward(pause.model, pause.data);
    };
    current.mujoco.mj_step = pause.guard;
    current.controller?.setLocked?.(true);
    simulatorContext.pause = pause;
  }

  function setSimulatorActive(active) {
    simulatorContext.active = active === true;
    if (simulatorContext.active) {
      stopSimulatorPause();
      if (simulatorContext.pending?.startedAt !== null && simulatorContext.pending)
        simulatorContext.pending.startedAt = performance.now();
      pumpTask();
    } else {
      if (recorder.active) stopRecording('仿真视图已离开，录制已结束');
      if (simulatorContext.timer) clearTimeout(simulatorContext.timer);
      simulatorContext.timer = null;
      stopPolicyRun();
      pauseSimulatorState();
    }
  }

  function queueTask(taskId, preserveTrial = false) {
    if (!BROWSER_TASK_IDS.has(taskId)) {
      taskState(taskId, 'failed', '当前单鸭仿真未装载该任务场景');
      return false;
    }
    if (simulatorContext.ready && simulatorContext.taskId === taskId && !simulatorContext.pending) {
      taskState(taskId, 'ready', '任务场景已就绪');
      return true;
    }
    if (simulatorContext.pending?.taskId === taskId) return true;
    if (recorder.active) stopRecording('任务切换，已结束上一段录制');
    if (!preserveTrial) stopPolicyRun();
    stopReplayState();
    simulatorContext.ready = false;
    simulatorContext.pending = { taskId, startedAt: null, waitStage: null, reset: false };
    taskState(taskId, 'loading', '正在准备任务场景');
    pumpTask();
    return true;
  }

  function pumpTask() {
    if (simulatorContext.timer) clearTimeout(simulatorContext.timer);
    simulatorContext.timer = null;
    const pending = simulatorContext.pending;
    if (!pending) return;
    if (!simulatorContext.active) return;
    const current = runtime();
    try {
      // The introduction is user-paced, and WASM does not expose window.rl
      // until initialization finishes. Neither wait consumes task setup time.
      const waitStage = isLanding()
        ? 'intro'
        : !current || typeof current.resetSim !== 'function'
          ? 'runtime'
          : null;
      if (waitStage) {
        pending.startedAt = null;
        if (pending.waitStage !== waitStage) {
          pending.waitStage = waitStage;
          taskState(
            pending.taskId,
            'loading',
            waitStage === 'intro'
              ? '等待开始仿真，请点击画面中的“开始仿真”'
              : '正在加载仿真引擎，加载完成后会自动准备任务',
          );
        }
        simulatorContext.timer = setTimeout(pumpTask, 100);
        return;
      }
      if (pending.startedAt === null) {
        pending.startedAt = performance.now();
        pending.waitStage = null;
        taskState(pending.taskId, 'loading', '正在准备任务场景');
      }
      if (performance.now() - pending.startedAt > 15_000)
        throw new Error('仿真引擎未在 15 秒内就绪');
      if (current && typeof current.resetSim === 'function') {
        if (!pending.reset) {
          clearMotionCommand(current);
          current.resetSim();
          pending.reset = true;
        }
        // Reset animations lock the controller; wait for the real runtime to
        // release it before requesting a one-shot action.
        if (!current.inputLocked && !current.locoSwitching) {
          if (current.loco && current.loco !== 'legs') {
            if (typeof current.setLoco !== 'function') throw new Error('当前仿真不能切回双足模型');
            current.setLoco('legs');
          } else {
            if (pending.taskId === 'kick') {
              if (typeof current.spawnBall !== 'function')
                throw new Error('当前仿真未开放球的生成接口');
              current.spawnBall();
            }
            if (pending.taskId === 'sit' && !dispatchControllerAction('sitToggle')) {
              throw new Error('当前仿真未开放坐下动作接口');
            }
            simulatorContext.taskId = pending.taskId;
            simulatorContext.ready = true;
            simulatorContext.pending = null;
            document.body.dataset.simulatorTask = pending.taskId;
            updateTaskControls();
            taskState(
              pending.taskId,
              'ready',
              pending.taskId === 'recover'
                ? '自恢复场景已就绪；点击跌倒测试后施加扰动'
                : '任务场景已就绪，使用操作控件执行动作',
            );
            return;
          }
        }
      }
      simulatorContext.timer = setTimeout(pumpTask, 100);
    } catch (error) {
      simulatorContext.pending = null;
      taskState(pending.taskId, 'failed', String(error?.message || error));
    }
  }

  function testRecovery() {
    const current = runtime();
    if (
      !simulatorContext.ready ||
      simulatorContext.taskId !== 'recover' ||
      current?.inputLocked ||
      typeof current?.debugPush !== 'function'
    )
      return false;
    current.debugPush(0, 0, 0, 7, 0, 0);
    return true;
  }

  function updateTaskControls() {
    const panel = document.getElementById(RECORDER_PANEL_ID);
    const label = panel?.querySelector('[data-simulator-task-label]');
    const taskId = simulatorContext.pending?.taskId || simulatorContext.taskId;
    if (label) label.textContent = `当前任务 · ${BROWSER_TASK_LABELS[taskId] || taskId}`;
    const button = panel?.querySelector('[data-recovery-test]');
    if (button) {
      button.hidden = taskId !== 'recover';
      button.disabled =
        !simulatorContext.ready ||
        Boolean(runtime()?.inputLocked) ||
        typeof runtime()?.debugPush !== 'function';
    }
  }

  function validatedState(value, expected, legacy, label) {
    if (!Array.isArray(value) && !ArrayBuffer.isView(value)) throw new Error(`缺少 ${label} 状态`);
    if (value.length !== expected && !(expected > legacy && value.length === legacy))
      throw new Error(`${label} 维度与当前模型不匹配`);
    if (
      !Array.from(value).every((number) => typeof number === 'number' && Number.isFinite(number))
    ) {
      throw new Error(`${label} 包含非有限数值`);
    }
    return Array.from(value);
  }

  function applyReplay(payload) {
    const frame = payload.frame;
    const current = runtime();
    let scope = 'full';
    try {
      const taskId = payload.taskId || frame?.taskId;
      const sceneId = payload.sceneId || frame?.sceneId;
      if (taskId && !BROWSER_TASK_IDS.has(taskId)) throw new Error('回放任务不属于当前单鸭场景');
      if (sceneId && sceneId !== BROWSER_SCENE_ID) throw new Error('回放场景与当前模型不匹配');
      if (frame?.locomotion && current?.loco && frame.locomotion !== current.loco)
        throw new Error('回放的双足 / 滚轮模型与当前模型不匹配');
      if (
        !current?.model ||
        !current.data?.qpos ||
        !current.data?.qvel ||
        typeof current.mujoco?.mj_forward !== 'function' ||
        typeof current.render !== 'function'
      ) {
        throw new Error('当前仿真未开放物理状态回放接口');
      }
      const qpos = validatedState(frame?.qpos, current.data.qpos.length, 7, 'qpos');
      const qvel = validatedState(frame?.qvel, current.data.qvel.length, 6, 'qvel');
      const quaternionNorm = Math.hypot(...qpos.slice(3, 7));
      if (Math.abs(quaternionNorm - 1) > 0.01) throw new Error('回放浮动基座的姿态四元数无效');
      if (qpos.length !== current.data.qpos.length || qvel.length !== current.data.qvel.length)
        scope = 'base-only';
      if (recorder.active) stopRecording('进入回放，已结束当前录制');
      stopPolicyRun();
      stopSimulatorPause();
      if (
        simulatorContext.replay?.current !== current ||
        simulatorContext.replay?.data !== current.data
      )
        stopReplayState();
      if (!simulatorContext.replay) {
        if (typeof current.mujoco.mj_step !== 'function')
          throw new Error('当前仿真不能暂停物理步进');
        const replay = {
          current,
          model: current.model,
          data: current.data,
          originalStep: current.mujoco.mj_step,
          wasLocked: Boolean(current.inputLocked),
          qpos: null,
          qvel: null,
        };
        replay.guard = (...args) => {
          if (current.data !== replay.data) {
            stopReplayState();
            return replay.originalStep.apply(current.mujoco, args);
          }
          // Other model instances may share this WASM module (for example a
          // lazily loaded roller model). Freeze only this playback world.
          if (args.length && (args[0] !== replay.model || args[1] !== replay.data)) {
            return replay.originalStep.apply(current.mujoco, args);
          }
          if (replay.qpos) {
            replay.data.qpos.set(replay.qpos);
            replay.data.qvel.set(replay.qvel);
            current.mujoco.mj_forward(replay.model, replay.data);
          }
        };
        current.mujoco.mj_step = replay.guard;
        if (current.mujoco.mj_step !== replay.guard) throw new Error('当前仿真物理步进不可暂停');
        current.controller?.setLocked?.(true);
        simulatorContext.replay = replay;
      }
      const replay = simulatorContext.replay;
      // Legacy recordings retain only the floating base; keep joint state
      // stationary and report that limitation instead of claiming full pose.
      replay.qpos = Array.from(current.data.qpos);
      replay.qvel = Array.from(current.data.qvel);
      qpos.forEach((value, index) => {
        replay.qpos[index] = value;
      });
      qvel.forEach((value, index) => {
        replay.qvel[index] = value;
      });
      replay.guard();
      current.render();
      notifyParent({
        type: 'rdk-replay-state',
        applied: true,
        scope,
        runId: payload.runId,
        index: payload.index,
      });
      window.dispatchEvent(
        new CustomEvent('rdk-replay-frame', {
          detail: { ...frame, index: payload.index, runId: payload.runId, applied: true, scope },
        }),
      );
      return true;
    } catch (error) {
      notifyParent({
        type: 'rdk-replay-state',
        applied: false,
        runId: payload.runId,
        index: payload.index,
        message: String(error?.message || error),
      });
      return false;
    }
  }

  window.__microduckSimulator = {
    setTask: queueTask,
    testRecovery,
    stopReplay: stopReplayState,
    setActive: setSimulatorActive,
    get taskId() {
      return simulatorContext.taskId;
    },
    get sceneId() {
      return BROWSER_SCENE_ID;
    },
    get ready() {
      return simulatorContext.ready;
    },
  };

  function policyStatus(phase, message) {
    policyTrial.phase = phase;
    policyTrial.message = message;
    notifyParent({
      type: 'rdk-policy-status',
      phase,
      message,
      runId: policyTrial.runId,
      ...(policyTrial.trialId ? { trialId: policyTrial.trialId } : {}),
      taskId: policyTrial.taskId,
      slots: policyTrial.binding?.slots || policyTrial.slots,
      relevantModeCount: policyTrial.relevantModeCount,
      maxSteps: policyTrial.maxSteps,
    });
  }

  function restorePolicyBinding(binding) {
    if (!binding) return;
    for (const [slot, original] of Object.entries(binding.originals)) {
      // The runtime may have restored its official walker itself, or loaded
      // another move. Restore only references still owned by this trial.
      if (binding.current.sessions[slot] === binding.loaded.session)
        binding.current.sessions[slot] = original;
    }
    if (binding.loaded.session.run === binding.run)
      binding.loaded.session.run = binding.originalRun;
    if (binding.loaded.slot === binding.slot) binding.loaded.slot = binding.originalSlot;
  }

  function taskPolicySlot(current, taskId) {
    if (current.loco !== 'legs' || current.recovery === 'fallen') return null;
    if (current.recovery === 'recovering') return taskId === 'recover' ? 'stand' : null;
    if (taskId === 'sit') return current.mode === 'sitstand' ? 'sitstand' : null;
    if (taskId === 'kick') return ['kickL', 'kickR'].includes(current.mode) ? current.mode : null;
    if (taskId === 'recover') return null;
    return current.mode === 'walk' ? 'walk' : null;
  }

  function attachTaskPolicy(current, loaded, taskId, originals) {
    const slots =
      taskId === 'sit'
        ? ['sitstand']
        : taskId === 'kick'
          ? ['kickL', 'kickR']
          : taskId === 'recover'
            ? ['stand']
            : ['walk'];
    if (!current.sessions || slots.some((slot) => typeof originals[slot]?.run !== 'function'))
      throw new Error(`当前仿真未开放任务策略槽位：${slots.join(' / ')}`);
    const binding = {
      current,
      loaded,
      slots,
      originals,
      taskId,
      originalRun: loaded.session.run,
      originalSlot: loaded.slot,
      slot: slots[0],
    };
    policyTrial.binding = binding;
    // Direct ONNX URLs default to walk upstream. Keep unrelated reference
    // policies in place, then bind this validated graph to its real task.
    for (const [slot, original] of Object.entries(originals)) {
      if (current.sessions[slot] === loaded.session) current.sessions[slot] = original;
    }
    loaded.slot = binding.slot;
    for (const slot of slots) {
      current.sessions[slot] = loaded.session;
      if (current.sessions[slot] !== loaded.session) throw new Error(`任务策略槽位 ${slot} 不可写`);
    }
    binding.run = async function (feeds, ...args) {
      const slot = taskPolicySlot(current, taskId);
      if (current.customPolicy !== loaded) {
        // Upstream's watchdog only restores walk/sitstand/roll. A kick or
        // recovery session captured just before its revert must use the
        // reference graph as well, without one extra custom inference.
        if (policyTrial.binding === binding)
          stopPolicyRun('failed', '仿真引擎已撤销策略，已还原任务参考策略');
        else restorePolicyBinding(binding);
        const official = originals[slot || binding.slot];
        const observation = feeds[loaded.session.inputNames?.[0]] || Object.values(feeds)[0];
        const outputs = await official.run({ [official.inputNames[0]]: observation }, ...args);
        return { ...outputs, [loaded.session.outputNames[0]]: outputs[official.outputNames[0]] };
      }
      const relevant = Boolean(
        slot && slots.includes(slot) && current.sessions[slot] === loaded.session,
      );
      let result;
      try {
        result = await binding.originalRun.call(this, feeds, ...args);
      } catch (error) {
        if (policyTrial.binding === binding)
          stopPolicyRun('failed', `策略推理失败：${error?.message || error}`);
        throw error;
      }
      if (policyTrial.binding !== binding || current.customPolicy !== loaded) return result;
      const action = result?.[loaded.session.outputNames?.[0]]?.data;
      if (!action || action.length !== 14 || !Array.from(action).every(Number.isFinite)) {
        stopPolicyRun('failed', '策略返回了无效的 14D 动作，已还原任务参考策略');
        return result;
      }
      if (relevant) {
        policyTrial.relevantModeCount++;
        if (policyTrial.relevantModeCount === 1)
          policyStatus(
            'running',
            `策略正在执行${BROWSER_TASK_LABELS[taskId]}；已完成 1 次任务模式推理`,
          );
        if (policyTrial.relevantModeCount >= policyTrial.maxSteps) {
          // Let the control loop consume this last output with the loaded
          // graph's action scale before releasing the custom policy.
          if (policyTrial.timer) clearTimeout(policyTrial.timer);
          policyTrial.timer = setTimeout(() => {
            if (policyTrial.binding === binding)
              stopPolicyRun(
                'finished',
                `策略试跑已完成 ${policyTrial.relevantModeCount} 次任务模式推理，已还原参考策略`,
              );
          }, 0);
        }
      }
      return result;
    };
    loaded.session.run = binding.run;
    if (loaded.session.run !== binding.run) throw new Error('当前仿真未开放策略执行计数接口');
    return binding;
  }

  function stopPolicyRun(phase = 'stopped', message = '策略试跑已停止，已还原官方策略') {
    policyTrial.token++;
    if (policyTrial.timer) clearTimeout(policyTrial.timer);
    policyTrial.timer = null;
    if (policyTrial.monitor) clearInterval(policyTrial.monitor);
    policyTrial.monitor = null;
    const running = policyTrial.active || policyTrial.loading;
    const binding = policyTrial.binding;
    restorePolicyBinding(binding);
    if (binding && binding.current.customPolicy === binding.loaded)
      binding.current.clearCustomPolicy?.();
    policyTrial.binding = null;
    policyTrial.active = false;
    policyTrial.loading = false;
    if (running) policyStatus(phase, message);
  }

  async function startPolicyRun(payload) {
    stopPolicyRun();
    const token = policyTrial.token;
    policyTrial.runId = String(payload.runId || '');
    policyTrial.trialId = typeof payload.trialId === 'string' ? payload.trialId : undefined;
    policyTrial.taskId = '';
    policyTrial.slots = [];
    policyTrial.relevantModeCount = 0;
    const requested = Number(payload.maxSteps);
    policyTrial.maxSteps = Math.round(
      Math.min(3000, Math.max(1, Number.isFinite(requested) ? requested : 600)),
    );
    policyTrial.loading = true;
    policyStatus('loading', '正在校验并装载 MicroDuck ONNX 策略');
    try {
      if (payload.backend && payload.backend !== 'wasm')
        throw new Error('MicroDuck 单鸭仿真只支持浏览器 ONNX 策略试跑');
      if (!policyTrial.runId || policyTrial.runId.length > 256)
        throw new Error('请选择已完成的训练运行');
      const api = new URL(
        payload.apiRoot || `${POLICY_API_BASE}/api/sim2real`,
        `${parentOrigin()}/`,
      );
      if (api.origin !== parentOrigin() || !api.pathname.endsWith('/api/sim2real')) {
        throw new Error('策略接口必须属于当前工作台');
      }
      const response = await fetch(
        `${api.href.replace(/\/$/, '')}/runs/${encodeURIComponent(policyTrial.runId)}`,
        { credentials: 'same-origin', headers: { accept: 'application/json' } },
      );
      if (!response.ok) throw new Error(`读取策略运行失败：HTTP ${response.status}`);
      const result = await response.json();
      const run = result.run;
      if (
        !run ||
        run.status !== 'completed' ||
        run.backend !== 'local' ||
        run.mock === true ||
        String(run.artifact?.format || '').toLowerCase() !== 'onnx' ||
        !BROWSER_TASK_IDS.has(run.taskId)
      ) {
        throw new Error('该运行不是适用于单鸭场景的已完成 ONNX 策略');
      }
      if (token !== policyTrial.token) return;
      policyTrial.taskId = run.taskId;
      // The operator explicitly started this trial. Prepare the run's task
      // before loading its graph; a pending reset must never erase its setup.
      if (!simulatorContext.ready || simulatorContext.taskId !== run.taskId) {
        queueTask(run.taskId, true);
      }
      const taskToken = policyTrial.token;
      while (simulatorContext.pending) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (taskToken !== policyTrial.token) return;
      }
      if (!simulatorContext.ready || simulatorContext.taskId !== run.taskId)
        throw new Error('任务场景未就绪');
      const current = runtime();
      if (
        typeof current?.loadCustomPolicy !== 'function' ||
        typeof current?.clearCustomPolicy !== 'function'
      )
        throw new Error('当前仿真未开放 ONNX 策略装载');
      stopReplayState();
      const policyUrl = `${api.href.replace(/\/$/, '')}/runs/${encodeURIComponent(run.id || policyTrial.runId)}/policy.onnx`;
      // The upstream loader is asynchronous and has no cancellation hook.
      // Revert a cancelled load before the next trial enters that loader;
      // otherwise an old completion can overwrite or clear the newer graph.
      const loadTask = policyTrial.loadChain
        .catch(() => {})
        .then(async () => {
          if (taskToken !== policyTrial.token) return false;
          if (current.customPolicy) current.clearCustomPolicy();
          const originals = Object.fromEntries(
            ['walk', 'sitstand', 'roll', 'kickL', 'kickR', 'stand']
              .filter((slot) => current.sessions && slot in current.sessions)
              .map((slot) => [slot, current.sessions[slot]]),
          );
          await current.loadCustomPolicy(policyUrl);
          if (taskToken !== policyTrial.token) {
            if (current.customPolicy?.ref === policyUrl) current.clearCustomPolicy();
            return false;
          }
          const loaded = current.customPolicy;
          // Upstream resolves its promise even for a rejected graph or a
          // busy loader. Inspect the actual runtime before reporting success.
          try {
            if (loaded?.ref !== policyUrl || typeof loaded.session?.run !== 'function')
              throw new Error('ONNX 策略未实际装载；引擎可能拒绝了接口或仍在装载其他策略');
            attachTaskPolicy(current, loaded, run.taskId, originals);
          } catch (error) {
            if (loaded?.ref === policyUrl) {
              restorePolicyBinding(policyTrial.binding);
              policyTrial.binding = null;
              current.clearCustomPolicy();
            }
            throw error;
          }
          return true;
        });
      policyTrial.loadChain = loadTask.catch(() => {});
      if (!(await loadTask) || taskToken !== policyTrial.token) return;
      policyTrial.active = true;
      policyTrial.loading = false;
      policyTrial.slots = policyTrial.binding.slots;
      const seconds = policyTrial.maxSteps / 50;
      policyTrial.startedAt = performance.now();
      const instructions =
        run.taskId === 'kick'
          ? '按 Q / E 或点击踢球后执行该策略'
          : run.taskId === 'recover'
            ? '点击“测试跌倒恢复”，进入恢复状态后执行该策略'
            : '使用操作控件执行任务';
      policyStatus(
        'armed',
        `策略已装入 ${policyTrial.binding.slots.join(' / ')}；${instructions}，最多 ${policyTrial.maxSteps} 次任务模式推理 / ${seconds.toFixed(1)} 秒`,
      );
      policyTrial.monitor = setInterval(() => {
        const binding = policyTrial.binding;
        if (!binding) return;
        if (
          runtime() !== binding.current ||
          binding.current.customPolicy !== binding.loaded ||
          binding.slots.some((slot) => binding.current.sessions[slot] !== binding.loaded.session)
        )
          stopPolicyRun('failed', '任务策略已被引擎撤销或替换，已还原参考策略');
        else if (policyTrial.relevantModeCount > 0) {
          const executing = Boolean(taskPolicySlot(binding.current, binding.taskId));
          policyStatus(
            executing ? 'running' : 'armed',
            `已完成 ${policyTrial.relevantModeCount} / ${policyTrial.maxSteps} 次任务模式推理${executing ? '' : `；${instructions}`}`,
          );
        }
      }, 250);
      policyTrial.timer = setTimeout(
        () =>
          stopPolicyRun(
            'finished',
            `策略试跑窗口已结束；完成 ${policyTrial.relevantModeCount} 次任务模式推理，已还原参考策略`,
          ),
        seconds * 1000,
      );
      return true;
    } catch (error) {
      if (token === policyTrial.token) {
        stopPolicyRun('failed', String(error?.message || error));
      }
      return false;
    }
  }

  // The upstream simulator intentionally exposes a small, read-only-ish
  // verification surface as window.rl.  The recorder uses that surface rather
  // than guessing from key presses: every sample contains the actual 61D
  // observation and 14D policy action produced by the MuJoCo/ONNX loop.
  // This keeps browser recordings compatible with microduck_rl's 50 Hz
  // sim2real contract.  If an older upstream build does not expose window.rl,
  // the panel stays disabled and never pretends that key presses are training
  // data.
  const recorder = {
    active: false,
    startedAt: 0,
    samples: [],
    bytes: 1024, // Fixed header allowance; event and step JSON are charged incrementally.
    events: [],
    last: null,
    timer: null,
    uiTimer: null,
    observer: null,
  };

  function copyNumeric(value) {
    if (!value || typeof value.length !== 'number') return null;
    try {
      const copied = Array.from(value);
      return copied.every((item) => typeof item === 'number' && Number.isFinite(item))
        ? copied
        : null;
    } catch {
      return null;
    }
  }

  function recorderReady() {
    const current = runtime();
    return Boolean(
      simulatorContext.active &&
      !simulatorContext.pending &&
      !simulatorContext.replay &&
      current &&
      typeof current.buildObs === 'function' &&
      current.lastAction?.length === 14,
    );
  }

  function recordSample() {
    if (!recorder.active) return;
    const current = runtime();
    if (!current || typeof current.buildObs !== 'function' || !current.lastAction) return;
    if (recorder.samples.length >= RECORDER_MAX_STEPS) {
      stopRecording('已达到 10 分钟上限');
      return;
    }
    try {
      const observation = copyNumeric(current.buildObs());
      const action = copyNumeric(current.lastAction);
      if (!observation || !action || observation.length !== 61 || action.length !== 14) return;
      const sample = {
        step: recorder.samples.length,
        time: Number(((performance.now() - recorder.startedAt) / 1000).toFixed(4)),
        observation,
        action,
        command: copyNumeric(current.cmd),
        mode: typeof current.mode === 'string' ? current.mode : null,
        locomotion: typeof current.loco === 'string' ? current.loco : null,
        taskId: simulatorContext.taskId,
        sceneId: BROWSER_SCENE_ID,
      };
      // Full physical state permits an exact pose replay. Legacy recordings
      // retained only the floating base; consumers must label that fallback.
      const qpos = copyNumeric(current.data?.qpos);
      const qvel = copyNumeric(current.data?.qvel);
      if (qpos?.length <= 512) sample.qpos = qpos;
      if (qvel?.length <= 512) sample.qvel = qvel;
      const bytes = new Blob([JSON.stringify({ type: 'step', ...sample }), '\n']).size;
      if (recorder.bytes + bytes > RECORDER_MAX_BYTES) {
        stopRecording('已达到 30 MiB 录制上限');
        return;
      }
      recorder.bytes += bytes;
      recorder.samples.push(sample);
    } catch (error) {
      console.warn('[microduck recorder] sample failed', error);
    }
  }

  function recordingHeader() {
    const first = recorder.samples[0] || {};
    return {
      format: 'microduck-trajectory-v1',
      source: 'browser-microduck',
      contractId: 'microduck-policy-v1',
      taskId: first.taskId || simulatorContext.taskId,
      sceneId: first.sceneId || BROWSER_SCENE_ID,
      observationSize: Array.isArray(first.observation) ? first.observation.length : 61,
      actionSize: Array.isArray(first.action) ? first.action.length : 14,
      sampleHz: 50,
      controlHz: 50,
      createdAt: new Date().toISOString(),
      sampleCount: recorder.samples.length,
      durationSeconds: recorder.samples.length ? recorder.samples.at(-1).time : 0,
      events: recorder.events.slice(0, 2000),
    };
  }

  function recordingText() {
    return [
      JSON.stringify({ type: 'header', ...recordingHeader() }),
      ...recorder.samples.map((sample) => JSON.stringify({ type: 'step', ...sample })),
      '',
    ].join('\n');
  }

  // The recorder is embedded inside the Sim2Real workbench.  Keep the local
  // download for standalone use, but also publish a small ready signal so the
  // parent can pull the complete JSONL through the exposed API and place it in
  // the platform's telemetry/evaluation flow.  Sending only metadata here
  // avoids copying a potentially multi-minute trajectory through postMessage.
  function notifyParentRecordingReady() {
    if (!recorder.samples.length || window.parent === window) return;
    try {
      window.parent.postMessage(
        {
          type: 'rdk-microduck-recording-ready',
          format: 'microduck-trajectory-v1',
          sampleCount: recorder.samples.length,
          durationSeconds: recorder.samples.at(-1)?.time || 0,
          contractId: 'microduck-policy-v1',
          taskId: recorder.samples[0]?.taskId || simulatorContext.taskId,
          sceneId: BROWSER_SCENE_ID,
        },
        '*',
      );
    } catch {
      // A detached or cross-origin parent may reject the signal. The local
      // export button remains available in that case.
    }
  }

  function downloadRecording() {
    if (!recorder.samples.length) return false;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const blob = new Blob([recordingText()], { type: 'application/x-ndjson' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `microduck-trajectory-${stamp}.jsonl`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    return true;
  }

  function clearRecording() {
    if (recorder.active) stopRecording('已停止');
    recorder.samples = [];
    recorder.bytes = 1024;
    recorder.events = [];
    recorder.last = null;
  }

  function stopRecording(reason = '已停止', notify = true) {
    if (!recorder.active && !recorder.timer) return;
    recorder.active = false;
    if (recorder.timer) clearInterval(recorder.timer);
    recorder.timer = null;
    recorder.last = recorder.samples.length ? recordingHeader() : null;
    if (notify) notifyParentRecordingReady();
    const panel = document.getElementById(RECORDER_PANEL_ID);
    panel
      ?.querySelector('[data-recorder-status]')
      ?.replaceChildren(document.createTextNode(reason));
    panel?.classList.remove('is-recording');
    panel?.querySelector('[data-recorder-start]')?.removeAttribute('disabled');
    panel?.querySelector('[data-recorder-stop]')?.setAttribute('disabled', '');
    panel
      ?.querySelector('[data-recorder-export]')
      ?.toggleAttribute('disabled', !recorder.samples.length);
    panel
      ?.querySelector('[data-recorder-clear]')
      ?.toggleAttribute('disabled', !recorder.samples.length);
    panel
      ?.querySelector('[data-recorder-count]')
      ?.replaceChildren(
        document.createTextNode(
          `${recorder.samples.length} 帧 · ${recorder.samples.length ? (recorder.samples.at(-1).time || 0).toFixed(1) : '0.0'} 秒`,
        ),
      );
  }

  function startRecording() {
    if (!recorderReady()) return false;
    if (recorder.active) return true;
    recorder.samples = [];
    recorder.bytes = 1024;
    recorder.events = [];
    recorder.last = null;
    recorder.active = true;
    recorder.startedAt = performance.now();
    recorder.timer = setInterval(recordSample, 20);
    recordSample();
    const panel = document.getElementById(RECORDER_PANEL_ID);
    panel?.classList.add('is-recording');
    panel
      ?.querySelector('[data-recorder-status]')
      ?.replaceChildren(document.createTextNode('录制中'));
    panel?.querySelector('[data-recorder-start]')?.setAttribute('disabled', '');
    panel?.querySelector('[data-recorder-stop]')?.removeAttribute('disabled');
    panel?.querySelector('[data-recorder-export]')?.setAttribute('disabled', '');
    panel?.querySelector('[data-recorder-clear]')?.setAttribute('disabled', '');
    return true;
  }

  function recordInputEvent(type, event) {
    if (!recorder.active || event.repeat) return;
    if (recorder.events.length >= 2000) return;
    const code = String(event.code || event.key || '').slice(0, 24);
    if (!code) return;
    const recorded = {
      type,
      code,
      time: Number(((performance.now() - recorder.startedAt) / 1000).toFixed(4)),
    };
    const bytes = new Blob([JSON.stringify(recorded), ',']).size;
    if (recorder.bytes + bytes > RECORDER_MAX_BYTES) {
      stopRecording('已达到 30 MiB 录制上限');
      return;
    }
    recorder.bytes += bytes;
    recorder.events.push(recorded);
  }

  function mountRecorder() {
    if (document.getElementById(RECORDER_PANEL_ID)) return;
    if (!document.getElementById(RECORDER_STYLE_ID)) {
      const styleTag = document.createElement('style');
      styleTag.id = RECORDER_STYLE_ID;
      styleTag.textContent = `
        #${RECORDER_PANEL_ID} {
          position: fixed;
          left: clamp(14px, 2.5vw, 34px);
          bottom: clamp(14px, 2.5vw, 32px);
          z-index: 2147483645;
          width: min(286px, calc(100vw - 28px));
          padding: 12px;
          border: 1px solid rgba(103, 225, 255, .34);
          border-radius: 14px;
          background: rgba(9, 13, 22, .92);
          color: #fff;
          box-shadow: 0 16px 38px rgba(0, 0, 0, .38), 0 0 28px rgba(103, 225, 255, .08);
          backdrop-filter: blur(13px);
          font: 600 11px/1.35 system-ui, -apple-system, sans-serif;
        }
        #${RECORDER_PANEL_ID}[hidden] { display: none; }
        #${RECORDER_PANEL_ID} .rdk-recorder-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
        #${RECORDER_PANEL_ID} .rdk-recorder-head strong { color: #67e1ff; font-size: 13px; }
        #${RECORDER_PANEL_ID} .rdk-recorder-status { color: rgba(255, 255, 255, .62); font-size: 10px; }
        #${RECORDER_PANEL_ID}.is-recording { border-color: rgba(255, 92, 113, .85); box-shadow: 0 16px 38px rgba(0, 0, 0, .4), 0 0 28px rgba(255, 92, 113, .18); }
        #${RECORDER_PANEL_ID}.is-recording .rdk-recorder-status { color: #ff8d91; }
        #${RECORDER_PANEL_ID} .rdk-recorder-note { margin: 0 0 9px; color: rgba(255, 255, 255, .52); font-size: 10px; }
        #${RECORDER_PANEL_ID} .rdk-task-context { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 9px; }
        #${RECORDER_PANEL_ID} button[hidden] { display: none; }
        #${RECORDER_PANEL_ID} .rdk-recorder-count { display: block; margin: 0 0 9px; color: rgba(255, 255, 255, .72); font: 10px ui-monospace, SFMono-Regular, Menlo, monospace; }
        #${RECORDER_PANEL_ID} .rdk-recorder-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
        #${RECORDER_PANEL_ID} button { min-height: 30px; border: 1px solid rgba(255, 255, 255, .2); border-radius: 8px; padding: 5px 8px; color: #fff; background: rgba(255, 255, 255, .07); cursor: pointer; font: 700 11px/1 system-ui, -apple-system, sans-serif; }
        #${RECORDER_PANEL_ID} button:hover:not(:disabled) { border-color: rgba(103, 225, 255, .75); background: rgba(103, 225, 255, .12); }
        #${RECORDER_PANEL_ID} button[data-recorder-start] { border-color: rgba(113, 229, 174, .5); color: #71e5ae; }
        #${RECORDER_PANEL_ID} button[data-recorder-stop] { border-color: rgba(255, 141, 145, .45); color: #ffb2b5; }
        #${RECORDER_PANEL_ID} button:disabled { opacity: .38; cursor: not-allowed; }
        @media (max-width: 650px) {
          #${RECORDER_PANEL_ID} { left: 12px; right: 12px; bottom: 12px; width: auto; }
        }
      `;
      document.head.append(styleTag);
    }
    const panel = document.createElement('section');
    panel.id = RECORDER_PANEL_ID;
    panel.hidden = true;
    panel.setAttribute('aria-label', 'MicroDuck 动作录制');
    panel.innerHTML = `
      <div class="rdk-recorder-head"><strong>动作录制</strong><span class="rdk-recorder-status" data-recorder-status>等待仿真引擎</span></div>
      <p class="rdk-recorder-note">记录真实 61D 观测 + 14D 动作，不只是按键。可导出给模仿学习或奖励设计。</p>
      <div class="rdk-task-context"><strong data-simulator-task-label>当前任务 · 行走</strong><button type="button" data-recovery-test hidden>测试跌倒恢复</button></div>
      <span class="rdk-recorder-count" data-recorder-count>0 帧 · 0.0 秒</span>
      <div class="rdk-recorder-actions">
        <button type="button" data-recorder-start disabled>开始录制</button>
        <button type="button" data-recorder-stop disabled>停止</button>
        <button type="button" data-recorder-export disabled>导出 JSONL</button>
        <button type="button" data-recorder-clear disabled>清空</button>
      </div>
    `;
    document.body.append(panel);
    const start = panel.querySelector('[data-recorder-start]');
    const stop = panel.querySelector('[data-recorder-stop]');
    const exportButton = panel.querySelector('[data-recorder-export]');
    const clear = panel.querySelector('[data-recorder-clear]');
    panel.querySelector('[data-recovery-test]').addEventListener('click', () => {
      panel.querySelector('[data-recorder-status]').textContent = testRecovery()
        ? '已施加跌倒扰动，观察起身结果'
        : '引擎尚未开放跌倒测试';
    });
    updateTaskControls();
    start.addEventListener('click', () => {
      if (!startRecording())
        panel.querySelector('[data-recorder-status]').textContent = '等待仿真引擎';
    });
    stop.addEventListener('click', () => stopRecording());
    exportButton.addEventListener('click', downloadRecording);
    clear.addEventListener('click', clearRecording);
    window.__microduckRecorder = {
      start: startRecording,
      stop(options) {
        const config = options && typeof options === 'object' ? options : null;
        stopRecording(config ? undefined : options, config ? config.notify !== false : true);
        return recorder.samples.length ? recordingText() : '';
      },
      clear: clearRecording,
      download: downloadRecording,
      get active() {
        return recorder.active;
      },
      get recording() {
        return recorder.active;
      },
      get sampleCount() {
        return recorder.samples.length;
      },
      get byteLength() {
        return recorder.samples.length ? new Blob([recordingText()]).size : 0;
      },
      get lastHeader() {
        return recorder.last;
      },
      getText() {
        return recorder.samples.length ? recordingText() : '';
      },
      destroy() {
        stopRecording('已停止');
        if (recorder.uiTimer) clearInterval(recorder.uiTimer);
        recorder.uiTimer = null;
        recorder.observer?.disconnect();
        recorder.observer = null;
        panel.remove();
      },
    };
    recorder.uiTimer = setInterval(() => {
      if (!simulatorContext.active) pauseSimulatorState();
      const ready = recorderReady();
      updateTaskControls();
      panel.hidden = isLanding();
      if (!recorder.active) {
        start.disabled = !ready;
        stop.disabled = true;
        if (ready && panel.querySelector('[data-recorder-status]').textContent === '等待仿真引擎') {
          panel.querySelector('[data-recorder-status]').textContent = '已就绪';
        }
      }
      panel.querySelector('[data-recorder-count]').textContent =
        `${recorder.samples.length} 帧 · ${recorder.samples.length ? (recorder.samples.at(-1).time || 0).toFixed(1) : '0.0'} 秒`;
    }, 500);
  }

  /**
   * Load a policy trained on the platform straight into this simulation.
   *
   * The upstream bundle already owns the hard part: `window.rl.loadCustomPolicy(ref)`
   * accepts an absolute .onnx URL, validates that the graph takes the robot's 61D
   * observation and emits 14 actions (the same contract the platform's training
   * manifest pins), binds it to the selected task slot, and reverts to
   * the stock policy and reports a reason whenever the move misbehaves. The
   * panel therefore adds no policy maths of its own; it lists the account's
   * completed runs, hands the simulator the platform's digest-verified bytes
   * URL, and shows what the simulator reports back.
   */
  function mountPolicyPanel() {
    if (document.getElementById(POLICY_PANEL_ID)) return;

    if (!document.getElementById(POLICY_STYLE_ID)) {
      const styleTag = document.createElement('style');
      styleTag.id = POLICY_STYLE_ID;
      styleTag.textContent = `
        #${POLICY_PANEL_ID} {
          position: fixed;
          left: clamp(14px, 2.5vw, 32px);
          bottom: calc(clamp(14px, 2.5vw, 32px) + 190px);
          z-index: 2147483644;
          width: min(286px, calc(100vw - 28px));
          padding: 12px;
          border: 1px solid rgba(255, 176, 103, .34);
          border-radius: 14px;
          background: rgba(9, 13, 22, .92);
          color: #fff;
          box-shadow: 0 16px 38px rgba(0, 0, 0, .38), 0 0 28px rgba(255, 176, 103, .08);
          backdrop-filter: blur(13px);
          font: 600 11px/1.35 system-ui, -apple-system, sans-serif;
        }
        #${POLICY_PANEL_ID}[hidden] { display: none; }
        #${POLICY_PANEL_ID} .rdk-policy-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
        #${POLICY_PANEL_ID} .rdk-policy-head strong { color: #ffb067; font-size: 13px; }
        #${POLICY_PANEL_ID} .rdk-policy-status { color: rgba(255, 255, 255, .62); font-size: 10px; text-align: right; }
        #${POLICY_PANEL_ID}.is-active { border-color: rgba(113, 229, 174, .7); }
        #${POLICY_PANEL_ID}.is-active .rdk-policy-status { color: #71e5ae; }
        #${POLICY_PANEL_ID}.is-error { border-color: rgba(255, 92, 113, .8); }
        #${POLICY_PANEL_ID}.is-error .rdk-policy-status { color: #ff8d91; }
        #${POLICY_PANEL_ID} .rdk-policy-note { margin: 0 0 8px; color: rgba(255, 255, 255, .52); font-size: 10px; }
        #${POLICY_PANEL_ID} .rdk-policy-list { display: grid; gap: 5px; max-height: 168px; overflow-y: auto; margin-bottom: 8px; }
        #${POLICY_PANEL_ID} .rdk-policy-item { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; align-items: center; padding: 6px 7px; border: 1px solid rgba(255, 255, 255, .12); border-radius: 8px; background: rgba(255, 255, 255, .04); }
        #${POLICY_PANEL_ID} .rdk-policy-item.is-current { border-color: rgba(113, 229, 174, .6); }
        #${POLICY_PANEL_ID} .rdk-policy-item-meta { min-width: 0; }
        #${POLICY_PANEL_ID} .rdk-policy-item-meta strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
        #${POLICY_PANEL_ID} .rdk-policy-item-meta span { color: rgba(255, 255, 255, .5); font: 9px ui-monospace, SFMono-Regular, Menlo, monospace; }
        #${POLICY_PANEL_ID} .rdk-policy-empty { padding: 7px; border: 1px dashed rgba(255, 255, 255, .18); border-radius: 8px; color: rgba(255, 255, 255, .5); font-size: 10px; }
        #${POLICY_PANEL_ID} button { min-height: 28px; border: 1px solid rgba(255, 255, 255, .2); border-radius: 8px; padding: 4px 8px; color: #fff; background: rgba(255, 255, 255, .07); cursor: pointer; font: 700 10px/1 system-ui, -apple-system, sans-serif; }
        #${POLICY_PANEL_ID} button:hover:not(:disabled) { border-color: rgba(255, 176, 103, .75); background: rgba(255, 176, 103, .12); }
        #${POLICY_PANEL_ID} button:disabled { opacity: .38; cursor: not-allowed; }
        #${POLICY_PANEL_ID} .rdk-policy-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
        @media (max-width: 650px) {
          #${POLICY_PANEL_ID} { left: 12px; right: 12px; bottom: auto; top: 12px; width: auto; }
        }
      `;
      document.head.append(styleTag);
    }

    const panel = document.createElement('section');
    panel.id = POLICY_PANEL_ID;
    panel.hidden = true;
    panel.setAttribute('aria-label', 'MicroDuck 策略装载');
    panel.innerHTML = `
      <div class="rdk-policy-head"><strong>策略装载</strong><span class="rdk-policy-status" data-policy-status>未连接平台</span></div>
      <p class="rdk-policy-note">把平台上训练好的 <code>policy.onnx</code> 直接装进这只鸭子。仿真引擎会校验 61D 观测 / 14D 动作，不匹配会拒绝并还原原策略。</p>
      <div class="rdk-policy-list" data-policy-list><div class="rdk-policy-empty">点击“刷新训练结果”读取已完成的训练</div></div>
      <div class="rdk-policy-actions">
        <button type="button" data-policy-refresh disabled>刷新训练结果</button>
        <button type="button" data-policy-clear disabled>还原官方策略</button>
      </div>
    `;
    document.body.append(panel);

    const status = panel.querySelector('[data-policy-status]');
    const list = panel.querySelector('[data-policy-list]');
    const refresh = panel.querySelector('[data-policy-refresh]');
    const clearButton = panel.querySelector('[data-policy-clear]');

    const state = { runs: [], current: null, busy: false, loaded: false };

    function setStatus(text, mode) {
      status.textContent = text;
      panel.classList.toggle('is-active', mode === 'active');
      panel.classList.toggle('is-error', mode === 'error');
    }

    function policyLoaderReady() {
      const current = runtime();
      return Boolean(current && typeof current.loadCustomPolicy === 'function');
    }

    function runLabel(run) {
      const digest = String((run.artifact && run.artifact.sha256) || '').slice(0, 8);
      const iteration = Number(run.metrics && run.metrics.iterations);
      const parts = [run.taskId || 'run'];
      if (Number.isFinite(iteration)) parts.push(`iter ${iteration}`);
      if (digest) parts.push(digest);
      return parts.join(' · ');
    }

    function renderList() {
      list.textContent = '';
      if (!state.runs.length) {
        const empty = document.createElement('div');
        empty.className = 'rdk-policy-empty';
        empty.textContent = state.loaded
          ? '还没有带 ONNX 制品的已完成训练'
          : '点击“刷新训练结果”读取已完成的训练';
        list.append(empty);
        return;
      }
      for (const run of state.runs) {
        const item = document.createElement('div');
        item.className = 'rdk-policy-item';
        if (state.current === run.id) item.classList.add('is-current');
        const meta = document.createElement('div');
        meta.className = 'rdk-policy-item-meta';
        const title = document.createElement('strong');
        title.textContent = run.modelId || run.id;
        const sub = document.createElement('span');
        sub.textContent = runLabel(run);
        meta.append(title, sub);
        const load = document.createElement('button');
        load.type = 'button';
        load.textContent = state.current === run.id ? '已装载' : '装载';
        load.disabled = state.busy || state.current === run.id || !policyLoaderReady();
        load.addEventListener('click', () => loadPolicy(run));
        item.append(meta, load);
        list.append(item);
      }
    }

    async function refreshRuns() {
      if (state.busy) return;
      state.busy = true;
      refresh.disabled = true;
      setStatus('读取训练记录…');
      try {
        const response = await fetch(`${POLICY_API_BASE}/api/sim2real/runs`, {
          headers: { accept: 'application/json' },
          credentials: 'same-origin',
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        if (payload?.ok !== true || !Array.isArray(payload.runs))
          throw new Error('训练记录响应格式错误');
        const runs = payload.runs;
        state.runs = runs.filter(
          (run) =>
            run &&
            run.backend === 'local' &&
            run.mock !== true &&
            run.status === 'completed' &&
            BROWSER_TASK_IDS.has(run.taskId) &&
            run.artifact &&
            String(run.artifact.format || '').toLowerCase() === 'onnx',
        );
        state.loaded = true;
        setStatus(state.runs.length ? `${state.runs.length} 个可用策略` : '暂无可用策略');
      } catch (error) {
        state.runs = [];
        state.loaded = false;
        setStatus(`平台不可达：${error?.message || error}`, 'error');
      } finally {
        state.busy = false;
        refresh.disabled = false;
        renderList();
      }
    }

    async function loadPolicy(run) {
      const current = runtime();
      if (!current || typeof current.loadCustomPolicy !== 'function') {
        setStatus('仿真引擎未就绪', 'error');
        return;
      }
      if (!BROWSER_TASK_IDS.has(run.taskId)) {
        setStatus('该策略需要对应的训练场景，不能装入当前单鸭场景', 'error');
        return;
      }
      if (state.busy) return;
      state.busy = true;
      setStatus('装载中…');
      renderList();
      try {
        const loaded = await startPolicyRun({
          runId: run.id,
          apiRoot: `${POLICY_API_BASE}/api/sim2real`,
        });
        state.current = loaded ? run.id : null;
        setStatus(policyTrial.message, policyTrial.phase === 'failed' ? 'error' : 'active');
      } catch (error) {
        state.current = null;
        setStatus(String(error?.message || error).slice(0, 120), 'error');
      } finally {
        state.busy = false;
        renderList();
        clearButton.disabled = !state.current;
      }
    }

    function clearPolicy() {
      stopPolicyRun();
      const current = runtime();
      if (current?.customPolicy && typeof current.clearCustomPolicy === 'function')
        current.clearCustomPolicy();
      state.current = null;
      clearButton.disabled = true;
      setStatus('已还原官方策略', 'active');
      renderList();
    }

    refresh.addEventListener('click', () => void refreshRuns());
    clearButton.addEventListener('click', clearPolicy);

    const syncPolicyStatus = () => {
      panel.hidden = isLanding();
      const ready = policyLoaderReady();
      refresh.disabled = state.busy;
      const active = runtime()?.customPolicy;
      if (policyTrial.loading) {
        setStatus(policyTrial.message);
      } else if (policyTrial.active || state.current) {
        state.current = policyTrial.active ? policyTrial.runId : null;
        setStatus(policyTrial.message, policyTrial.phase === 'failed' ? 'error' : 'active');
        clearButton.disabled = !state.current;
        renderList();
      } else if (active?.session && !state.current) {
        // The operator can also load a move from the simulator's own menu;
        // mirror whatever is actually active instead of claiming otherwise.
        state.current = null;
        setStatus(`引擎已装载：${active.name || active.ref}`, 'active');
      }
      const waiting = [
        '等待仿真引擎',
        '未连接平台',
        '仿真引擎未就绪',
        '当前仿真版本未开放策略装载',
      ].includes(status.textContent);
      if (!state.busy && !policyTrial.loading && !policyTrial.active) {
        if (!ready && !panel.classList.contains('is-error')) {
          setStatus(
            typeof runtime()?.buildObs === 'function'
              ? '当前仿真版本未开放策略装载'
              : '等待仿真引擎',
          );
        } else if (ready && waiting) {
          setStatus(
            state.loaded
              ? state.runs.length
                ? `${state.runs.length} 个可用策略`
                : '暂无可用策略'
              : '引擎已就绪；点击刷新训练结果',
          );
        }
      }
      clearButton.disabled = !policyTrial.active && !policyTrial.loading && !active;
      for (const button of list.querySelectorAll('button')) button.disabled = state.busy || !ready;
    };
    const uiTimer = setInterval(syncPolicyStatus, 700);
    syncPolicyStatus();

    window.__microduckPolicy = {
      refresh: refreshRuns,
      load: (runId) => {
        const run = state.runs.find((candidate) => candidate.id === runId);
        return run ? loadPolicy(run) : Promise.reject(new Error('unknown run'));
      },
      clear: clearPolicy,
      get runs() {
        return state.runs.slice();
      },
      get current() {
        return policyTrial.active ? policyTrial.runId : null;
      },
      get phase() {
        return policyTrial.phase;
      },
      get relevantModeCount() {
        return policyTrial.relevantModeCount;
      },
      destroy() {
        clearInterval(uiTimer);
        panel.remove();
      },
    };
  }

  function dispatchShortcut(code) {
    const keys = {
      KeyC: 'c',
      KeyG: 'g',
      KeyM: 'm',
      KeyR: 'r',
      KeyQ: 'q',
      KeyE: 'e',
      Space: ' ',
    };
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        code,
        key: keys[code] || code,
        repeat: false,
      }),
    );
    return true;
  }

  function callRuntimeMethod(current, method, ...args) {
    if (typeof current?.[method] !== 'function') return false;
    const result = current[method](...args);
    // Runtime actions historically returned void.  Treat any result other
    // than an explicit false as a dispatched action.
    return result !== false;
  }

  // The current simulator exposes the controller sources through window.rl,
  // but its desktop keyboard intentionally has no quack key (the touch B
  // button is the quack source). Invoke the same action bus when available so
  // a desktop fallback cannot depend on a hidden mobile DOM node. Older
  // releases may not expose the controller; callers below retain their
  // public-method / touch-button fallbacks for those builds.
  function dispatchControllerAction(action) {
    const current = runtime();
    const sources = current?.controller?.sources;
    if (!Array.isArray(sources)) return false;
    const source = sources.find(
      (candidate) =>
        candidate &&
        (candidate.id === 'keyboard' || candidate.id === 'touch') &&
        typeof candidate.onAction === 'function',
    );
    if (!source) return false;
    try {
      source.onAction(action);
      return true;
    } catch (error) {
      console.warn('[microduck controls] controller action failed', action, error);
      return false;
    }
  }

  function dispatchQuack() {
    const current = runtime();
    if (typeof current?.triggerQuack === 'function') {
      current.triggerQuack();
      return true;
    }
    const api = window.__gameApi;
    if (typeof api?.quack === 'function') {
      api.quack();
      return true;
    }
    if (dispatchControllerAction('quack')) return true;
    return triggerTouchButton('touch-b');
  }

  function triggerTouchButton(id) {
    const button = document.getElementById(id);
    if (!button) return false;
    const PointerCtor = window.PointerEvent || window.MouseEvent;
    const init = {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: 'mouse',
      buttons: 1,
    };
    button.dispatchEvent(new PointerCtor('pointerdown', init));
    button.dispatchEvent(new PointerCtor('pointerup', { ...init, buttons: 0 }));
    return true;
  }

  function mountMobileControls() {
    if (document.getElementById(MOBILE_TOGGLE_ID)) return;

    const styleTag = document.createElement('style');
    styleTag.id = MOBILE_STYLE_ID;
    styleTag.textContent = `
      :root { --rdk-mobile-toggle-top: max(10.5rem, calc(8% + 132px + env(safe-area-inset-top))); }
      #${MOBILE_TOGGLE_ID} {
        position: fixed;
        top: var(--rdk-mobile-toggle-top);
        bottom: auto;
        right: max(1.25rem, calc(env(safe-area-inset-right) + 1rem));
        z-index: 2147483646;
        display: none;
        align-items: center;
        justify-content: center;
        gap: 8px;
        min-width: 132px;
        min-height: 52px;
        padding: 0 16px;
        border: 2px solid rgba(255, 255, 255, .86);
        border-radius: 999px;
        background: linear-gradient(135deg, #ff9a3d 0%, #ff5b45 100%);
        color: #171018;
        box-shadow: 0 0 0 4px rgba(255, 122, 47, .2), 0 12px 28px rgba(0, 0, 0, .42), 0 0 26px rgba(255, 122, 47, .3);
        backdrop-filter: blur(10px);
        font: 800 .82rem/1 system-ui, -apple-system, sans-serif;
        letter-spacing: .02em;
        white-space: nowrap;
        cursor: pointer;
        touch-action: manipulation;
        -webkit-tap-highlight-color: transparent;
        transition: transform .18s ease, box-shadow .18s ease, filter .18s ease;
        animation: rdk-mobile-toggle-attention 2.8s ease-in-out infinite;
      }
      #${MOBILE_TOGGLE_ID}:hover {
        transform: translateY(-3px);
        filter: saturate(1.08) brightness(1.04);
        box-shadow: 0 0 0 5px rgba(255, 122, 47, .26), 0 16px 34px rgba(0, 0, 0, .46), 0 0 32px rgba(255, 122, 47, .38);
      }
      #${MOBILE_TOGGLE_ID}:active { transform: translateY(1px) scale(.98); }
      #${MOBILE_TOGGLE_ID}:focus-visible {
        outline: 3px solid rgba(255, 255, 255, .96);
        outline-offset: 4px;
      }
      #${MOBILE_TOGGLE_ID}[aria-expanded="true"] {
        border-color: #fff;
        background: linear-gradient(135deg, #fff1e5 0%, #ffd0ae 100%);
        color: #8f351d;
        box-shadow: 0 0 0 4px rgba(255, 255, 255, .2), 0 12px 28px rgba(0, 0, 0, .4);
        animation: none;
      }
      #${MOBILE_TOGGLE_ID} .rdk-mobile-toggle-icon { font-size: 1.18rem; line-height: 1; }
      #${MOBILE_TOGGLE_ID} .rdk-mobile-toggle-label { line-height: 1; }
      #${MOBILE_TOGGLE_ID} .rdk-mobile-toggle-arrow { font-size: 1.18rem; line-height: .8; transition: transform .18s ease; }
      #${MOBILE_TOGGLE_ID}[aria-expanded="true"] .rdk-mobile-toggle-arrow { transform: rotate(90deg); }
      @keyframes rdk-mobile-toggle-attention {
        0%, 100% { box-shadow: 0 0 0 4px rgba(255, 122, 47, .2), 0 12px 28px rgba(0, 0, 0, .42), 0 0 26px rgba(255, 122, 47, .3); }
        50% { box-shadow: 0 0 0 7px rgba(255, 122, 47, .28), 0 14px 32px rgba(0, 0, 0, .46), 0 0 34px rgba(255, 122, 47, .42); }
      }
      @media (prefers-reduced-motion: reduce) {
        #${MOBILE_TOGGLE_ID} { animation: none; transition: none; }
      }
      #${MOBILE_PANEL_ID} {
        position: fixed;
        top: calc(var(--rdk-mobile-toggle-top) + 52px + .75rem);
        bottom: auto;
        right: max(1.25rem, calc(env(safe-area-inset-right) + 1rem));
        z-index: 2147483646;
        display: none;
        width: min(286px, calc(100vw - 2rem));
        max-height: min(72vh, 560px);
        overflow: auto;
        padding: 13px;
        border: 1px solid rgba(255, 122, 47, .52);
        border-radius: 16px;
        background: rgba(13, 13, 20, .95);
        color: #fff;
        box-shadow: 0 18px 46px rgba(0, 0, 0, .48), 0 0 28px rgba(255, 91, 86, .12);
        backdrop-filter: blur(16px);
        font-family: system-ui, -apple-system, sans-serif;
      }
      #${MOBILE_PANEL_ID}.open { display: block; }
      #${MOBILE_PANEL_ID} .rdk-mobile-heading {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 10px;
        margin: 0 2px 10px;
      }
      #${MOBILE_PANEL_ID} .rdk-mobile-heading strong { font-size: .86rem; letter-spacing: .04em; }
      #${MOBILE_PANEL_ID} .rdk-mobile-status { color: rgba(255, 173, 114, .9); font-size: .64rem; white-space: nowrap; }
      #${MOBILE_PANEL_ID} .rdk-mobile-group {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 7px;
        margin-top: 9px;
      }
      #${MOBILE_PANEL_ID} .rdk-mobile-group-label {
        grid-column: 1 / -1;
        margin: 3px 2px 0;
        color: rgba(255, 255, 255, .42);
        font-size: .58rem;
        font-weight: 700;
        letter-spacing: .14em;
        text-transform: uppercase;
      }
      #${MOBILE_PANEL_ID} button {
        min-width: 0;
        min-height: 42px;
        border: 1px solid rgba(255, 255, 255, .14);
        border-radius: 10px;
        padding: 8px 7px;
        background: rgba(255, 255, 255, .055);
        color: rgba(255, 255, 255, .9);
        font: 600 .72rem/1.2 system-ui, -apple-system, sans-serif;
        cursor: pointer;
        touch-action: manipulation;
        -webkit-tap-highlight-color: transparent;
      }
      #${MOBILE_PANEL_ID} button:active,
      #${MOBILE_PANEL_ID} button[aria-pressed="true"] {
        border-color: rgba(255, 122, 47, .92);
        background: rgba(255, 122, 47, .88);
        color: #111018;
      }
      #${MOBILE_PANEL_ID} button:disabled { opacity: .42; cursor: wait; }
      #${MOBILE_PANEL_ID} .rdk-mobile-colors { display: flex; gap: 7px; grid-column: 1 / -1; }
      #${MOBILE_PANEL_ID} .rdk-mobile-color {
        flex: 1;
        min-height: 34px;
        border-radius: 8px;
        padding: 0;
        color: #171018;
        font-size: .68rem;
        font-weight: 800;
        text-shadow: 0 1px 0 rgba(255, 255, 255, .35);
      }
      #${MOBILE_PANEL_ID} .rdk-mobile-color[data-mobile-variant="classic"] { --rdk-swatch-bg: #f7e6cb; --rdk-swatch-ink: #4c3024; background: var(--rdk-swatch-bg); color: var(--rdk-swatch-ink); }
      #${MOBILE_PANEL_ID} .rdk-mobile-color[data-mobile-variant="charcoal"] { --rdk-swatch-bg: #6c6a68; --rdk-swatch-ink: #fff; background: var(--rdk-swatch-bg); color: var(--rdk-swatch-ink); text-shadow: 0 1px 2px rgba(0, 0, 0, .72); }
      #${MOBILE_PANEL_ID} .rdk-mobile-color[data-mobile-variant="purple"] { --rdk-swatch-bg: #bfa9cf; --rdk-swatch-ink: #2b1d3f; background: var(--rdk-swatch-bg); color: var(--rdk-swatch-ink); }
      #${MOBILE_PANEL_ID} .rdk-mobile-color[data-mobile-variant="blue"] { --rdk-swatch-bg: #a9dbe8; --rdk-swatch-ink: #0c2b36; background: var(--rdk-swatch-bg); color: var(--rdk-swatch-ink); }
      #${MOBILE_PANEL_ID} .rdk-mobile-color[aria-pressed="true"] { background: var(--rdk-swatch-bg); color: var(--rdk-swatch-ink); box-shadow: inset 0 0 0 3px #fff, 0 0 0 2px rgba(255, 122, 47, .95); }
      #${MOBILE_PANEL_ID} .rdk-mobile-footnote { margin: 10px 2px 0; color: rgba(255, 255, 255, .4); font-size: .62rem; line-height: 1.45; }
      @media (max-width: 900px) {
        #${MOBILE_TOGGLE_ID} { top: var(--rdk-mobile-toggle-top); bottom: auto; }
        #${MOBILE_PANEL_ID} { top: calc(var(--rdk-mobile-toggle-top) + 52px + .75rem); bottom: auto; }
      }
      @media (max-width: 430px) {
        #${MOBILE_TOGGLE_ID} { top: var(--rdk-mobile-toggle-top); right: .75rem; min-width: 124px; min-height: 48px; padding: 0 13px; font-size: .78rem; }
        #${MOBILE_PANEL_ID} { top: calc(var(--rdk-mobile-toggle-top) + 52px + .75rem); right: .75rem; width: min(274px, calc(100vw - 1.5rem)); }
      }
      @media (orientation: landscape) and (max-height: 520px) {
        #${MOBILE_PANEL_ID} { top: calc(3.8rem + env(safe-area-inset-top)); max-height: 78vh; }
      }
    `;
    document.head.append(styleTag);

    const toggle = document.createElement('button');
    toggle.id = MOBILE_TOGGLE_ID;
    toggle.type = 'button';
    toggle.innerHTML = [
      '<span class="rdk-mobile-toggle-icon" aria-hidden="true">☷</span>',
      '<span class="rdk-mobile-toggle-label">更多操作</span>',
      '<span class="rdk-mobile-toggle-arrow" aria-hidden="true">›</span>',
    ].join('');
    toggle.setAttribute('aria-controls', MOBILE_PANEL_ID);
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', '打开完整仿真控制');
    toggle.title = '打开完整仿真控制';

    const panel = document.createElement('section');
    panel.id = MOBILE_PANEL_ID;
    panel.setAttribute('aria-label', '完整仿真控制');
    panel.innerHTML = `
      <div class="rdk-mobile-heading">
        <strong>完整控制</strong>
        <span class="rdk-mobile-status" data-mobile-status>引擎加载中…</span>
      </div>
      <div class="rdk-mobile-group">
        <span class="rdk-mobile-group-label">动作</span>
        <button type="button" data-mobile-action="sit" disabled>坐下</button>
        <button type="button" data-mobile-action="pick" disabled>拾取</button>
        <button type="button" data-mobile-action="kick-left" disabled>左脚踢</button>
        <button type="button" data-mobile-action="kick-right" disabled>右脚踢</button>
        <button type="button" data-mobile-action="head" disabled>头部视角</button>
        <button type="button" data-mobile-action="chase" disabled>跟随镜头</button>
        <button type="button" data-mobile-action="quack" disabled>叫一声</button>
        <button type="button" data-mobile-action="alternate-kick" disabled>换脚踢球</button>
        <button type="button" data-mobile-action="roll" disabled>翻滚</button>
        <button type="button" data-mobile-action="ball" disabled>生成球</button>
        <button type="button" data-mobile-action="reset" disabled>重置仿真</button>
      </div>
      <div class="rdk-mobile-group">
        <span class="rdk-mobile-group-label">移动模式</span>
        <button type="button" data-mobile-loco="legs" disabled>双足行走</button>
        <button type="button" data-mobile-loco="rollers" disabled>滚轮移动</button>
      </div>
      <div class="rdk-mobile-group">
        <span class="rdk-mobile-group-label">外观</span>
        <div class="rdk-mobile-colors">
          <button type="button" class="rdk-mobile-color" data-mobile-variant="classic" aria-label="奶油色" aria-pressed="false" disabled>奶油</button>
          <button type="button" class="rdk-mobile-color" data-mobile-variant="charcoal" aria-label="石墨色" aria-pressed="false" disabled>石墨</button>
          <button type="button" class="rdk-mobile-color" data-mobile-variant="purple" aria-label="薰衣草色" aria-pressed="false" disabled>紫色</button>
          <button type="button" class="rdk-mobile-color" data-mobile-variant="blue" aria-label="天空蓝" aria-pressed="false" disabled>蓝色</button>
        </div>
      </div>
      <p class="rdk-mobile-footnote">平台覆盖层提供 B 叫一声、F 换脚踢球；移动端按钮和手柄也可触发。官方引擎若未暴露入口会明确提示。</p>
    `;
    document.body.append(toggle, panel);

    const status = panel.querySelector('[data-mobile-status]');
    const actionButtons = [...panel.querySelectorAll('[data-mobile-action]')];
    const locoButtons = [...panel.querySelectorAll('[data-mobile-loco]')];
    const variantButtons = [...panel.querySelectorAll('[data-mobile-variant]')];
    let noticeTimer = null;

    const setStatus = (message) => {
      if (status && status.textContent !== message) status.textContent = message;
    };

    const setButtonText = (button, message) => {
      if (button && button.textContent !== message) button.textContent = message;
    };

    const updateState = () => {
      const current = runtime();
      const ready = Boolean(current);
      [...actionButtons, ...locoButtons, ...variantButtons].forEach((item) => {
        item.disabled = !ready;
      });
      if (!current) {
        setStatus('引擎加载中…');
        return;
      }
      const mode = current.loco === 'rollers' ? '滚轮' : '双足';
      const camera = current.chaseCam ? ' · 跟随' : '';
      if (!noticeTimer) setStatus(`${mode}${camera}`);
      const sitButton = panel.querySelector('[data-mobile-action="sit"]');
      setButtonText(sitButton, current.sitFlag ? '站起' : '坐下');
      const chaseButton = panel.querySelector('[data-mobile-action="chase"]');
      if (chaseButton) {
        setButtonText(chaseButton, current.chaseCam ? '取消跟随' : '跟随镜头');
        chaseButton.setAttribute('aria-pressed', String(Boolean(current.chaseCam)));
      }
      const headButton = panel.querySelector('[data-mobile-action="head"]');
      if (headButton) {
        setButtonText(headButton, current.headMode ? '退出头部视角' : '头部视角');
        headButton.setAttribute('aria-pressed', String(Boolean(current.headMode)));
      }
      const rollButton = panel.querySelector('[data-mobile-action="roll"]');
      setButtonText(rollButton, current.loco === 'rollers' ? '蹲伏' : '翻滚');
      locoButtons.forEach((item) =>
        item.setAttribute('aria-pressed', String(item.dataset.mobileLoco === current.loco)),
      );
    };

    const showNotice = (message) => {
      clearTimeout(noticeTimer);
      setStatus(message);
      noticeTimer = setTimeout(() => {
        noticeTimer = null;
        updateState();
      }, 1200);
    };

    const invoke = (action) => {
      const current = runtime();
      if (!current) {
        showNotice('仿真引擎尚未就绪');
        return;
      }
      try {
        let sent = false;
        let failureMessage = '当前引擎暂未提供此动作';
        if (action === 'sit') {
          sent = dispatchControllerAction('sitToggle') || dispatchShortcut('KeyR');
        } else if (action === 'pick') {
          if (current.loco === 'rollers') {
            failureMessage = '滚轮模式不支持拾取，请切换到双足模式';
          } else if (typeof current.triggerGroundPick === 'function') {
            // triggerGroundPick is intentionally void in the upstream build;
            // the mode transition is the reliable success signal. Do not
            // dispatch a second action when the method exists but is gated.
            current.triggerGroundPick('ui');
            sent = current.mode === 'groundpick';
          } else {
            sent = dispatchControllerAction('groundPick') || dispatchShortcut('KeyG');
          }
        } else if (action === 'kick-left') {
          if (current.loco === 'rollers') {
            failureMessage = '滚轮模式不支持踢球，请切换到双足模式';
          } else if (typeof current.triggerKick === 'function') {
            sent = current.triggerKick('left', 'ui') !== false;
          } else {
            sent = dispatchControllerAction('kickL') || dispatchShortcut('KeyQ');
          }
        } else if (action === 'kick-right') {
          if (current.loco === 'rollers') {
            failureMessage = '滚轮模式不支持踢球，请切换到双足模式';
          } else if (typeof current.triggerKick === 'function') {
            sent = current.triggerKick('right', 'ui') !== false;
          } else {
            sent = dispatchControllerAction('kickR') || dispatchShortcut('KeyE');
          }
        } else if (action === 'head') {
          if (typeof current.toggleHeadMode === 'function') {
            const before = typeof current.headMode === 'boolean' ? current.headMode : null;
            current.toggleHeadMode();
            sent = before === null || current.headMode !== before;
          } else {
            sent = dispatchControllerAction('headToggle');
          }
          failureMessage = '头部视角需要更新后的仿真引擎';
        } else if (action === 'chase') {
          if (typeof current.chaseCam === 'boolean') {
            current.chaseCam = !current.chaseCam;
            sent = true;
          } else {
            sent = dispatchControllerAction('chaseToggle') || dispatchShortcut('KeyC');
          }
        } else if (action === 'quack') {
          sent = dispatchQuack();
          if (!sent) showNotice('当前引擎没有叫声入口');
        } else if (action === 'alternate-kick') {
          if (current.loco === 'rollers') {
            failureMessage = '滚轮模式不支持踢球，请切换到双足模式';
          } else {
            sent = dispatchControllerAction('alternateKick') || dispatchShortcut('KeyF');
          }
        } else if (action === 'roll') {
          if (typeof current.triggerRoll === 'function') {
            current.triggerRoll('ui');
            sent = current.mode === 'roll' || current.mode === 'crouch';
          } else {
            sent = dispatchControllerAction('roll');
          }
        } else if (action === 'ball') {
          sent = callRuntimeMethod(current, 'spawnBall') || dispatchControllerAction('spawnBall');
        } else if (action === 'reset') {
          sent =
            callRuntimeMethod(current, 'resetSim') ||
            dispatchControllerAction('reset') ||
            dispatchShortcut('Space');
        }
        if (!sent) {
          showNotice(failureMessage);
          return;
        }
        showNotice('操作已发送');
      } catch (error) {
        console.warn('[microduck mobile controls] action failed', action, error);
        showNotice('当前动作暂不可用');
      }
      setTimeout(updateState, 80);
    };

    toggle.addEventListener('click', () => {
      const open = !panel.classList.contains('open');
      panel.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', String(open));
      if (open) updateState();
    });
    actionButtons.forEach((item) =>
      item.addEventListener('click', () => invoke(item.dataset.mobileAction)),
    );
    locoButtons.forEach((item) =>
      item.addEventListener('click', () => {
        const current = runtime();
        if (!current) return showNotice('仿真引擎尚未就绪');
        try {
          const api = window.__gameApi;
          if (typeof api?.requestLoco === 'function') api.requestLoco(item.dataset.mobileLoco);
          else current.setLoco?.(item.dataset.mobileLoco);
          showNotice(
            item.dataset.mobileLoco === 'rollers' ? '正在切换到滚轮模式' : '正在切换到双足模式',
          );
        } catch (error) {
          console.warn('[microduck mobile controls] locomotion switch failed', error);
          showNotice('模式切换失败');
        }
        setTimeout(updateState, 120);
      }),
    );
    variantButtons.forEach((item) =>
      item.addEventListener('click', () => {
        const api = window.__gameApi;
        if (typeof api?.setVariant !== 'function') return showNotice('外观控制尚未就绪');
        api.setVariant(item.dataset.mobileVariant);
        variantButtons.forEach((candidate) =>
          candidate.setAttribute('aria-pressed', String(candidate === item)),
        );
        showNotice('外观已切换');
      }),
    );

    window.addEventListener(
      'keydown',
      (event) => {
        if (
          event.repeat ||
          isLanding() ||
          event.target instanceof HTMLInputElement ||
          event.target instanceof HTMLTextAreaElement
        )
          return;
        if (event.code === 'KeyB') {
          event.preventDefault();
          // B is a platform overlay shortcut.  The pinned upstream browser
          // build exposes quack on touch/gamepad, not as a desktop key; capture
          // this convenience key so a future upstream binding cannot fire two
          // unrelated actions at once.
          event.stopPropagation();
          if (!dispatchQuack())
            console.info('[microduck controls] quack is not exposed by this engine');
        }
      },
      { capture: true },
    );

    const fullscreenButton = document.createElement('button');
    fullscreenButton.type = 'button';
    fullscreenButton.dataset.mobileAction = 'fullscreen';
    fullscreenButton.textContent = '全屏显示';
    fullscreenButton.addEventListener('click', async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen?.();
        else await document.documentElement.requestFullscreen?.();
        showNotice(document.fullscreenElement ? '已进入全屏' : '已退出全屏');
      } catch (error) {
        console.warn('[microduck mobile controls] fullscreen failed', error);
        showNotice('浏览器不允许全屏，请用新标签页打开');
      }
    });
    panel
      .querySelector('[data-mobile-action="reset"]')
      ?.insertAdjacentElement('afterend', fullscreenButton);

    const refreshMobileVisibility = () => {
      const visible = !isLanding();
      toggle.style.display = visible ? 'inline-flex' : 'none';
      panel.classList.toggle('open', visible && panel.classList.contains('open'));
      if (!visible) {
        panel.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      }
      if (visible) updateState();
    };

    const runtimeTimer = window.setInterval(updateState, 900);
    window.addEventListener('resize', refreshMobileVisibility, { passive: true });
    refreshMobileVisibility();
    return { refreshMobileVisibility, runtimeTimer };
  }

  function mount() {
    if (!document.body || document.getElementById(BUTTON_ID)) return;

    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.className = 'rdk-microduck-community-card';
    button.innerHTML = [
      '<span class="rdk-community-mark" aria-hidden="true">群</span>',
      '<span class="rdk-community-copy">',
      '<strong>加入微信群</strong>',
      '<small>交流仿真 · 训练 · 上板</small>',
      '</span>',
      '<span class="rdk-community-arrow" aria-hidden="true">↗</span>',
    ].join('');
    button.setAttribute('aria-label', '打开 MicroDuck 微信群二维码');
    style(button, {
      position: 'fixed',
      top: '50%',
      right: 'clamp(24px, 6vw, 96px)',
      transform: 'translateY(-50%)',
      zIndex: '2147483646',
      display: 'none',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '11px',
      width: '228px',
      minHeight: '92px',
      padding: '15px 16px',
      border: '1px solid transparent',
      borderRadius: '18px',
      background:
        'linear-gradient(rgba(21, 19, 26, .96), rgba(21, 19, 26, .96)) padding-box, linear-gradient(135deg, rgba(255, 122, 47, .95), rgba(255, 45, 166, .9)) border-box',
      color: '#fff',
      textAlign: 'left',
      font: '600 13px/1 system-ui, -apple-system, sans-serif',
      cursor: 'pointer',
      boxShadow: '0 16px 38px rgba(0, 0, 0, .34), 0 0 28px rgba(255, 91, 86, .12)',
      backdropFilter: 'blur(12px)',
      transition: 'transform .2s ease, box-shadow .2s ease, border-color .2s ease',
    });
    const responsiveStyle = document.createElement('style');
    responsiveStyle.textContent = `
      #${BUTTON_ID}:hover { transform: translateY(calc(-50% - 3px)); box-shadow: 0 20px 44px rgba(0, 0, 0, .4), 0 0 34px rgba(255, 91, 86, .2); }
      #${BUTTON_ID} .rdk-community-mark { display: grid; place-items: center; flex: 0 0 auto; width: 40px; height: 40px; border-radius: 13px; background: linear-gradient(145deg, #ff7a2f, #ff2da6); color: #fff; font-size: 17px; box-shadow: 3px 3px 0 rgba(255, 45, 166, .45); }
      #${BUTTON_ID} .rdk-community-copy { display: grid; gap: 7px; min-width: 0; }
      #${BUTTON_ID} .rdk-community-copy strong { color: #fff; font-size: 15px; letter-spacing: .01em; white-space: nowrap; }
      #${BUTTON_ID} .rdk-community-copy small { color: #ffad72; font-size: 10px; letter-spacing: .06em; white-space: nowrap; }
      #${BUTTON_ID} .rdk-community-arrow { margin-left: auto; color: #ff5e86; font-size: 20px; line-height: 1; }
      #${WALL_ID} { appearance: none; }
      #${WALL_ID} { top: 8% !important; right: clamp(16px, 3.5vw, 48px) !important; left: auto !important; transform: perspective(900px) rotateY(-2deg) !important; }
      #${WALL_ID}::before, #${WALL_ID}::after { content: ''; position: absolute; top: 8px; width: 5px; height: 5px; border: 1px solid rgba(255, 255, 255, .48); border-radius: 50%; background: #11131a; box-shadow: 0 0 0 1px rgba(0, 0, 0, .28); }
      #${WALL_ID}::before { left: 9px; }
      #${WALL_ID}::after { right: 9px; }
      #${WALL_ID}:hover, #${WALL_ID}:focus-visible { transform: perspective(900px) rotateY(-2deg) translateY(-3px) !important; box-shadow: 0 8px 0 rgba(255, 45, 166, .38), 0 20px 38px rgba(0, 0, 0, .42), 0 0 34px rgba(255, 91, 86, .28); }
      #${WALL_ID}:focus-visible { outline: 2px solid #ffad72; outline-offset: 4px; }
      #${WALL_ID} .rdk-community-wall-qr { flex: 0 0 auto; width: 82px; height: 82px; padding: 4px; border-radius: 4px; background: #fff; image-rendering: pixelated; }
      #${WALL_ID} .rdk-community-wall-copy { display: grid; gap: 4px; min-width: 0; text-align: left; }
      #${WALL_ID} .rdk-community-wall-copy small { color: #ff7a2f; font-size: 9px; font-weight: 800; letter-spacing: .09em; white-space: nowrap; }
      #${WALL_ID} .rdk-community-wall-copy strong { color: #fff; font-size: 18px; letter-spacing: .02em; white-space: nowrap; }
      #${WALL_ID} .rdk-community-wall-copy span { color: #ffad72; font-size: 11px; line-height: 1.35; white-space: nowrap; }
      #${WALL_ID} .rdk-community-wall-copy em { color: rgba(255, 255, 255, .58); font-size: 9px; font-style: normal; line-height: 1.35; white-space: nowrap; }
      #${WALL_ID} .rdk-community-wall-arrow { align-self: flex-start; margin-left: auto; color: #ff5e86; font-size: 22px; line-height: 1; }
      @media (max-width: 900px) {
        #${BUTTON_ID} { top: 16px !important; right: 16px !important; transform: none !important; width: auto !important; min-height: 0 !important; padding: 10px 12px !important; border-radius: 999px !important; gap: 8px !important; }
        #${BUTTON_ID}:hover { transform: translateY(-2px) !important; }
        #${BUTTON_ID} .rdk-community-mark { width: 27px; height: 27px; border-radius: 9px; font-size: 12px; box-shadow: 2px 2px 0 rgba(255, 45, 166, .45); }
        #${BUTTON_ID} .rdk-community-copy { display: block; }
        #${BUTTON_ID} .rdk-community-copy strong { font-size: 12px; }
        #${BUTTON_ID} .rdk-community-copy small, #${BUTTON_ID} .rdk-community-arrow { display: none; }
        #${WALL_ID} { top: 8% !important; right: 4% !important; left: auto !important; width: min(286px, 82vw) !important; min-height: 86px !important; padding: 10px 12px !important; gap: 9px !important; }
        #${WALL_ID} .rdk-community-wall-qr { width: 58px; height: 58px; }
        #${WALL_ID} .rdk-community-wall-copy strong { font-size: 15px; }
        #${WALL_ID} .rdk-community-wall-copy span { font-size: 10px; white-space: normal; }
        #${WALL_ID} .rdk-community-wall-copy em { display: none; }
      }
    `;
    document.head.append(responsiveStyle);
    button.addEventListener('click', openModal);
    document.body.append(button);

    const mobileControls = mountMobileControls();
    mountRecorder();
    mountPolicyPanel();

    const wall = document.createElement('button');
    wall.id = WALL_ID;
    wall.type = 'button';
    wall.className = 'rdk-microduck-community-wall';
    wall.innerHTML = [
      `<img class="rdk-community-wall-qr" src="${QR_SRC}" alt="" aria-hidden="true">`,
      '<span class="rdk-community-wall-copy">',
      '<small>RDK STUDIO · MICRODUCK 社区</small>',
      '<strong>加入微信群</strong>',
      '<span>云端仿真 · 模型训练 · RDK X5 上板</span>',
      '<em>扫码加入，和开发者一起打通 Sim2Real</em>',
      '</span>',
      '<span class="rdk-community-wall-arrow" aria-hidden="true">↗</span>',
    ].join('');
    wall.setAttribute('aria-label', '仿真墙面：打开 MicroDuck 微信群二维码');
    style(wall, {
      position: 'fixed',
      top: '8%',
      right: 'clamp(16px, 3.5vw, 48px)',
      left: 'auto',
      transform: 'perspective(900px) rotateY(-2deg)',
      zIndex: '2147483645',
      display: 'none',
      alignItems: 'center',
      gap: '11px',
      width: '332px',
      minHeight: '116px',
      padding: '15px 16px',
      border: '1px solid rgba(255, 122, 47, .86)',
      borderRadius: '7px',
      background: 'linear-gradient(145deg, rgba(13, 14, 21, .97), rgba(28, 17, 25, .94))',
      color: '#fff',
      textAlign: 'left',
      font: '600 12px/1 system-ui, -apple-system, sans-serif',
      cursor: 'pointer',
      boxShadow:
        '0 8px 0 rgba(255, 45, 166, .3), 0 18px 38px rgba(0, 0, 0, .4), 0 0 28px rgba(255, 91, 86, .2)',
      backdropFilter: 'blur(7px)',
      transition: 'transform .2s ease, box-shadow .2s ease',
    });
    wall.addEventListener('click', openModal);
    document.body.append(wall);

    const refreshVisibility = () => {
      translatePage();
      patchControlKeyLabels();
      mountTouchLandingHelp();
      button.style.display = isLanding() ? 'inline-flex' : 'none';
      wall.style.display = isLanding() ? 'none' : 'flex';
      mobileControls?.refreshMobileVisibility();
    };
    refreshVisibility();
    recorder.observer = new MutationObserver(refreshVisibility);
    recorder.observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  // Only the embedding workbench may control this runtime. A peer tab or
  // unrelated frame must never trigger a task, policy, or physical state write.
  window.addEventListener('message', (event) => {
    if (!trustedParentMessage(event)) return;
    const payload = event?.data;
    if (payload?.type === 'rdk-simulator-task') {
      queueTask(payload.taskId);
      return;
    }
    if (payload?.type === 'rdk-simulator-action' && payload.action === 'recovery-test') {
      notifyParent({
        type: 'rdk-simulator-action-state',
        action: payload.action,
        applied: testRecovery(),
      });
      return;
    }
    if (payload?.type === 'rdk-replay-frame' && payload.frame) applyReplay(payload);
    if (payload?.type === 'rdk-replay-stop') stopReplayState();
    if (payload?.type === 'rdk-simulator-active') setSimulatorActive(payload.active);
    if (payload?.type === 'rdk-policy-run') void startPolicyRun(payload);
    if (payload?.type === 'rdk-policy-stop') stopPolicyRun();
  });
  window.addEventListener('pagehide', () => {
    simulatorContext.active = true;
    stopReplayState();
    stopSimulatorPause();
    stopPolicyRun();
    if (simulatorContext.timer) clearTimeout(simulatorContext.timer);
  });

  document.addEventListener('keydown', (event) => {
    recordInputEvent('keydown', event);
    if (event.key === 'Escape') closeModal();
  });
  document.addEventListener('keyup', (event) => recordInputEvent('keyup', event));

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
