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
    ['the exact same trained policies that drive the real robot, live in your browser.', '与真实机器人相同的训练策略，直接在浏览器中运行。'],
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
    const findCard = (label, keyCount) => cards
      .filter((element) => {
        const text = (element.innerText || '').trim();
        return new RegExp(label, 'i').test(text) && element.querySelectorAll('kbd').length === keyCount;
      })
      .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];

    const moveCard = findCard('移动|move', 4);
    if (moveCard) {
      const hint = [...moveCard.querySelectorAll('div')]
        .find((element) => /方向键或\s*(?:ZQSD|WASD)|arrows?\s+or\s+zqsd/i.test(element.textContent || ''));
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
    return [...document.querySelectorAll('button')]
      .find((element) => /开始仿真|waddle in/i.test(element.textContent || ''));
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
    events: [],
    last: null,
    timer: null,
    uiTimer: null,
    observer: null,
  };

  function copyNumeric(value) {
    if (!value || typeof value.length !== 'number') return null;
    try {
      return Array.from(value, (item) => Number.isFinite(Number(item)) ? Number(item) : 0);
    } catch {
      return null;
    }
  }

  function recorderReady() {
    const current = runtime();
    return Boolean(current && typeof current.buildObs === 'function' && current.lastAction?.length);
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
      if (!observation || !action) return;
      const sample = {
        step: recorder.samples.length,
        time: Number(((performance.now() - recorder.startedAt) / 1000).toFixed(4)),
        observation,
        action,
        command: copyNumeric(current.cmd),
        mode: typeof current.mode === 'string' ? current.mode : null,
        locomotion: typeof current.loco === 'string' ? current.loco : null,
      };
      // qpos/qvel are useful for debugging and reward design, but are not
      // required by the policy contract.  Keep them bounded to the base state
      // so a long browser recording remains reasonably small.
      const qpos = copyNumeric(current.data?.qpos);
      const qvel = copyNumeric(current.data?.qvel);
      if (qpos) sample.qpos = qpos.slice(0, 7);
      if (qvel) sample.qvel = qvel.slice(0, 6);
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
    recorder.events = [];
    recorder.last = null;
  }

  function stopRecording(reason = '已停止') {
    if (!recorder.active && !recorder.timer) return;
    recorder.active = false;
    if (recorder.timer) clearInterval(recorder.timer);
    recorder.timer = null;
    recorder.last = recorder.samples.length ? recordingHeader() : null;
    const panel = document.getElementById(RECORDER_PANEL_ID);
    panel?.querySelector('[data-recorder-status]')?.replaceChildren(document.createTextNode(reason));
    panel?.classList.remove('is-recording');
    panel?.querySelector('[data-recorder-start]')?.removeAttribute('disabled');
    panel?.querySelector('[data-recorder-stop]')?.setAttribute('disabled', '');
    panel?.querySelector('[data-recorder-export]')?.toggleAttribute('disabled', !recorder.samples.length);
    panel?.querySelector('[data-recorder-clear]')?.toggleAttribute('disabled', !recorder.samples.length);
    panel?.querySelector('[data-recorder-count]')?.replaceChildren(
      document.createTextNode(`${recorder.samples.length} 帧 · ${recorder.samples.length ? (recorder.samples.at(-1).time || 0).toFixed(1) : '0.0'} 秒`),
    );
  }

  function startRecording() {
    if (!recorderReady()) return false;
    if (recorder.active) return true;
    recorder.samples = [];
    recorder.events = [];
    recorder.last = null;
    recorder.active = true;
    recorder.startedAt = performance.now();
    recorder.timer = setInterval(recordSample, 20);
    recordSample();
    const panel = document.getElementById(RECORDER_PANEL_ID);
    panel?.classList.add('is-recording');
    panel?.querySelector('[data-recorder-status]')?.replaceChildren(document.createTextNode('录制中'));
    panel?.querySelector('[data-recorder-start]')?.setAttribute('disabled', '');
    panel?.querySelector('[data-recorder-stop]')?.removeAttribute('disabled');
    panel?.querySelector('[data-recorder-export]')?.setAttribute('disabled', '');
    panel?.querySelector('[data-recorder-clear]')?.setAttribute('disabled', '');
    return true;
  }

  function recordInputEvent(type, event) {
    if (!recorder.active || event.repeat) return;
    const code = String(event.code || event.key || '').slice(0, 24);
    if (!code) return;
    recorder.events.push({
      type,
      code,
      time: Number(((performance.now() - recorder.startedAt) / 1000).toFixed(4)),
    });
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
    start.addEventListener('click', () => {
      if (!startRecording()) panel.querySelector('[data-recorder-status]').textContent = '等待仿真引擎';
    });
    stop.addEventListener('click', () => stopRecording());
    exportButton.addEventListener('click', downloadRecording);
    clear.addEventListener('click', clearRecording);
    window.__microduckRecorder = {
      start: startRecording,
      stop: stopRecording,
      clear: clearRecording,
      download: downloadRecording,
      get active() { return recorder.active; },
      get sampleCount() { return recorder.samples.length; },
      get lastHeader() { return recorder.last; },
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
      const ready = recorderReady();
      panel.hidden = isLanding();
      if (!recorder.active) {
        start.disabled = !ready;
        stop.disabled = true;
        if (ready && panel.querySelector('[data-recorder-status]').textContent === '等待仿真引擎') {
          panel.querySelector('[data-recorder-status]').textContent = '已就绪';
        }
      }
      panel.querySelector('[data-recorder-count]').textContent = `${recorder.samples.length} 帧 · ${recorder.samples.length ? (recorder.samples.at(-1).time || 0).toFixed(1) : '0.0'} 秒`;
    }, 500);
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
    window.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      code,
      key: keys[code] || code,
      repeat: false,
    }));
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
    const source = sources.find((candidate) =>
      candidate && (candidate.id === 'keyboard' || candidate.id === 'touch') &&
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
    const init = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', buttons: 1 };
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
      [...actionButtons, ...locoButtons, ...variantButtons].forEach((item) => { item.disabled = !ready; });
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
      locoButtons.forEach((item) => item.setAttribute('aria-pressed', String(item.dataset.mobileLoco === current.loco)));
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
        }
        else if (action === 'pick') {
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
          sent = callRuntimeMethod(current, 'resetSim') || dispatchControllerAction('reset') || dispatchShortcut('Space');
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
    actionButtons.forEach((item) => item.addEventListener('click', () => invoke(item.dataset.mobileAction)));
    locoButtons.forEach((item) => item.addEventListener('click', () => {
      const current = runtime();
      if (!current) return showNotice('仿真引擎尚未就绪');
      try {
        const api = window.__gameApi;
        if (typeof api?.requestLoco === 'function') api.requestLoco(item.dataset.mobileLoco);
        else current.setLoco?.(item.dataset.mobileLoco);
        showNotice(item.dataset.mobileLoco === 'rollers' ? '正在切换到滚轮模式' : '正在切换到双足模式');
      } catch (error) {
        console.warn('[microduck mobile controls] locomotion switch failed', error);
        showNotice('模式切换失败');
      }
      setTimeout(updateState, 120);
    }));
    variantButtons.forEach((item) => item.addEventListener('click', () => {
      const api = window.__gameApi;
      if (typeof api?.setVariant !== 'function') return showNotice('外观控制尚未就绪');
      api.setVariant(item.dataset.mobileVariant);
      variantButtons.forEach((candidate) => candidate.setAttribute('aria-pressed', String(candidate === item)));
      showNotice('外观已切换');
    }));

    window.addEventListener('keydown', (event) => {
      if (event.repeat || isLanding() || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.code === 'KeyB') {
        event.preventDefault();
        // B is a platform overlay shortcut.  The pinned upstream browser
        // build exposes quack on touch/gamepad, not as a desktop key; capture
        // this convenience key so a future upstream binding cannot fire two
        // unrelated actions at once.
        event.stopPropagation();
        if (!dispatchQuack()) console.info('[microduck controls] quack is not exposed by this engine');
      }
    }, { capture: true });

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
    panel.querySelector('[data-mobile-action="reset"]')?.insertAdjacentElement('afterend', fullscreenButton);

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
      background: 'linear-gradient(rgba(21, 19, 26, .96), rgba(21, 19, 26, .96)) padding-box, linear-gradient(135deg, rgba(255, 122, 47, .95), rgba(255, 45, 166, .9)) border-box',
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
      boxShadow: '0 8px 0 rgba(255, 45, 166, .3), 0 18px 38px rgba(0, 0, 0, .4), 0 0 28px rgba(255, 91, 86, .2)',
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
    recorder.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  document.addEventListener('keydown', (event) => {
    recordInputEvent('keydown', event);
    if (event.key === 'Escape') closeModal();
  });
  document.addEventListener('keyup', (event) => recordInputEvent('keyup', event));

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
