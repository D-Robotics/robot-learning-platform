(function(root) {
  'use strict';
  function mount({request, getSource}) {
    const $ = id => document.getElementById(id);
    const panel = $('originman-workshop'), canvas = $('originman-sim-canvas');
    if (!canvas) return;
    const preview = $('originman-scene-preview');
    let webgl = null, graphicsStats = null, experience = null, experimentBusy = false, trial = null, experimentSequence = 0;
    const useWebGL = Boolean(root.OriginmanWebGL?.supported());
    let current = null, connecting = false, running = false, timer, recording = false;
    let rows = [], imageVersion = 0, camera = 15, distance = 0.82, drag, epoch = 0, source = '', policy = '';
    let hasFrame = false, previewReady = false, previewFailed = false, failed = false, ended = false, lastState;
    const frameInterval = useWebGL ? 80 : 40; // At most 25 display frames/s; physics stays at 50 Hz.
    let frameStarted = 0, lastStepAt = null, stepRemainder = 0, paintedAt = 0, displayFps = 0;
    const status = message => { $('originman-sim-status').textContent = message; };
    const activeView = () => ['simulate', 'classroom'].includes(panel.dataset.originmanView) && !panel.hidden;
    const path = id => '/sim2real/workshops/originman/sessions/' + encodeURIComponent(id);
    const motionButtons = [...panel.querySelectorAll('[data-originman-motion]')];
    const driveKeys = {w:'walk-forward',s:'walk-backward',a:'turn-left',d:'turn-right'};
    const heldKeys = new Set();
    const heldDirection = () => driveKeys[[...heldKeys].at(-1)];
    const toggleLink = $('originman-link-toggle');
    const cutLink = $('originman-link-cut');
    const linkStatus = $('originman-link-status');
    const linkReadout = $('originman-link-readout');
    let controlCut = false, linkPoll, linkVersion = 0;
    const endpoint = () => path(current.id) + '/teleop-rehearsal';
    const report = message => { linkStatus.textContent = message; };
    const link = root.OriginmanTeleopLink.create({
      request(url, options) {
        return controlCut ? Promise.reject(Error('联动演练：模拟断连')) : request(url, options);
      },
      onStatus: report,
      onLost: () => { heldKeys.clear(); controls(); },
    });
    const clearDrive = () => {
      heldKeys.clear();
      void link.stop();
    };
    function updateLinkControls() {
      const enabled = link.isEnabled();
      toggleLink.textContent = enabled ? '关闭联动演练' : '开启 WASD 联动演练';
      toggleLink.setAttribute('aria-pressed', String(enabled));
      cutLink.hidden = !enabled;
      cutLink.textContent = controlCut ? '恢复演练连接' : '模拟断连';
    }
    function stopLink() {
      ++linkVersion;
      clearTimeout(linkPoll);
      void link.disable();
      controlCut = false;
      updateLinkControls();
      linkReadout.textContent = '';
      report('演练关闭 · 真机执行器关闭');
    }
    const directions = {
      'walk-forward': '前进', 'walk-backward': '后退', 'turn-left': '左转', 'turn-right': '右转',
    };
    async function watchLink(session, version) {
      const active = () => link.isEnabled() && current === session && version === linkVersion;
      if (!active()) return;
      try {
        const state = await request(endpoint(), {
          method: 'POST', body: JSON.stringify({ operation: 'status' }), signal: AbortSignal.timeout(700),
        });
        if (!active()) return;
        const reason = state.lastStop === 'heartbeat-timeout' ? '心跳超时' :
          state.lastStop === 'operator-stop' ? '已撤销' : '等待输入';
        linkReadout.textContent = '演练指令：' + (directions[state.direction] || '空闲') +
          ' · 启动 ' + state.started + ' · 撤销 ' + state.stopped + ' · ' + reason;
      } catch {
        if (active()) linkReadout.textContent = '暂时无法读取演练状态';
      }
      if (active()) linkPoll = setTimeout(() => void watchLink(session, version), 250);
    }
    toggleLink.addEventListener('click', async () => {
      toggleLink.disabled = true;
      try {
        clearDrive();
        if (link.isEnabled()) { stopLink(); return; }
        if (!current && !await connect({ run: null })) return;
        if ($('originman-sim-controller').value === 'trained') {
          report('请选择基础 PD 后再开启联动演练。');
          return;
        }
        const session = current;
        const version = ++linkVersion;
        if (await link.enablePath(endpoint()) && current === session) void watchLink(session, version);
      } finally {
        updateLinkControls();
        toggleLink.disabled = false;
      }
    });
    // Preserve canvas focus for a pointer click so the exercise drops control
    // packets while a key is held, rather than stopping first via canvas blur.
    cutLink.addEventListener('pointerdown', event => event.preventDefault());
    cutLink.addEventListener('click', () => {
      if (!link.isEnabled()) return;
      if (controlCut) {
        clearDrive();
        controlCut = false;
        report('演练连接已恢复 · 请重新按键 · 真机执行器关闭');
      } else {
        controlCut = true;
        report('演练控制链路已断开 · 等待板端心跳超时');
      }
      updateLinkControls();
    });
    window.addEventListener('offline', clearDrive);
    const motionKeys = {j:'look-left',l:'look-right',n:'nod',q:'wave-left',e:'wave-right'};
    let motionPending = false;
    const motionBlocked = () => heldKeys.size > 0 || connecting || motionPending || experimentBusy || recording ||
      Boolean(current?.resetPending) || Boolean(lastState?.motion && !lastState?.done) ||
      $('originman-sim-controller').value === 'trained';
    function controls() {
      webgl?.setRunning(running);
      if (!running) { lastStepAt = null; stepRemainder = 0; }
      const ready = Boolean(current) && !connecting;
      for (const id of ['pause','step','left','right','benchmark','record']) $('originman-sim-'+id).disabled = !ready || Boolean(lastState?.done);
      $('originman-sim-record').disabled ||= Boolean(current?.resetPending);
      for (const id of ['reset','disconnect','home']) $('originman-sim-'+id).disabled = !ready;
      const trained = $('originman-sim-controller').value === 'trained';
      const selected = getSource();
      const previewStart = $('originman-sim-preview-start');
      previewStart.hidden = hasFrame;
      previewStart.textContent = connecting ? '正在装载…' : trained ? '▶ 运行所选策略' : '▶ 开始基础仿真';
      const eligible = selected?.status === 'completed' && selected.training?.originmanWorkshop?.phase === 'train';
      $('originman-sim-connect').disabled = connecting || trained && !eligible;
      previewStart.disabled = $('originman-sim-connect').disabled;
      $('originman-sim-connect').textContent = connecting ? '正在装载…' : current ? '重新装载并运行' : '装载并开始仿真';
      $('originman-sim-controller').disabled = connecting;
      $('originman-sim-run').disabled = connecting;
      $('originman-sim-model-picker').hidden = !trained;
      $('originman-sim-source').textContent = trained ? eligible ? '将装载 Run ' + selected.id + ' 的权重；不会替换为参考模型。' : '还没有可装载的已完成训练。可先体验基础 PD，或前往训练页。' : '基础 PD 对照，不使用学习权重。';
      $('originman-sim-pause').textContent = running ? '暂停' : '继续';
      $('originman-sim-record').textContent = recording ? '停止录制' : rows.length ? '开始新录制' : '开始录制';
      $('originman-sim-record-count').textContent = (recording ? '正在录制 · ' : rows.length ? '已保留 · ' : '') + (rows.length ? rows.length + ' 帧 / ' + (rows.length / 50).toFixed(1) + 's' : recording ? '0 帧' : '尚未录制');
      $('originman-sim-export').disabled = !rows.length;
      const label = connecting ? '正在装载' : failed ? '连接失败' : current ? !hasFrame ? '等待画面' : lastState?.fallen ? '已跌倒' : lastState?.done ? '回合结束' : running ? '运行中' : '已暂停' : ended ? '已结束' : previewReady ? '场景预览' : previewFailed ? '预览未加载' : '场景加载中';
      $('originman-sim-badge').textContent = label;
      $('originman-scene').setAttribute('aria-busy', String(connecting || !hasFrame && !previewReady && !previewFailed && !failed));
      $('originman-scene-caption').textContent = experience?.isReviewing() ? '本轮回看 · 原始采样' : hasFrame ? label + ' · ' + (policy ? '训练策略 ' + policy.slice(0,12) : '基础 PD') : '静态预览 · 尚未开始仿真';
      if (experimentBusy) for (const id of ['pause','step','left','right','benchmark','record','reset','connect','controller','run','force','force-gentle','force-medium','force-strong']) $('originman-sim-'+id).disabled = true;
      else for (const id of ['force','force-gentle','force-medium','force-strong']) $('originman-sim-'+id).disabled = false;
      if(webgl)$('originman-sim-home').disabled=false;
      for (const button of motionButtons) button.disabled = motionBlocked();
      $('originman-sim-record').disabled ||= motionPending || heldKeys.size > 0 || Boolean(lastState?.motion);
      const motionHelp = $('originman-motion-help');
      if (motionHelp) motionHelp.textContent =
        $('originman-sim-controller').value === 'trained' ? '切换基础 PD 后可手动操控动作。' :
        recording ? '结束录制后即可操作动作。' :
        heldKeys.size > 0 ? '按住移动或转向，松开后收步站稳。' :
        lastState?.heldDrive && !lastState.done ? '正在收步。' :
        lastState?.motion && !lastState.done ? '正在执行动作，结束后可选择下一个。' :
        '点击画面后按住 W / A / S / D 移动或转向，松开即收步。J / L / N / Q / E 做动作。';
      if(lastState && !running)metrics(lastState);
      experience?.sync();
    }
    preview.addEventListener('load', () => {
      previewReady = true; previewFailed = false;
      if (!hasFrame) { preview.hidden = false; $('originman-scene-placeholder').hidden = true; }
      controls();
    });
    preview.addEventListener('error', () => {
      previewReady = false; previewFailed = true;
      if (!hasFrame) { preview.hidden = true; $('originman-scene-placeholder').hidden = false; $('originman-scene-placeholder').textContent = '预览暂不可读；仍可装载策略，进入实时物理场景。'; }
      controls();
      $('originman-scene').setAttribute('aria-busy', 'false');
      if (!current && !connecting) $('originman-sim-badge').textContent = '预览未加载';
    });
    function setPreview(url) {
      if (!url) { preview.dispatchEvent(new Event('error')); return; }
      if (preview.getAttribute('src') !== url) preview.src = url;
    }
    function setSources(runs, selected) {
      const select = $('originman-sim-run');
      const options = runs.filter(run => run.status === 'completed' && run.training?.originmanWorkshop?.phase === 'train');
      const values = options.map(run => ({value:run.id,label:run.label || run.id}));
      if (!values.length) values.push({value:'',label:'尚无已完成训练，请先使用基础 PD'});
      if (JSON.stringify([...select.options].map(option => [option.value,option.textContent])) !== JSON.stringify(values.map(option => [option.value,option.label]))) {
        select.replaceChildren(...values.map(value => { const option = document.createElement('option'); option.value=value.value; option.textContent=value.label; return option; }));
      }
      select.value = values.some(value => value.value === selected) ? selected : '';
      controls();
    }
    function draw(state, snap = false) {
      const finishedMotion = lastState?.motion && !state.motion && !state.done && !snap;
      lastState = state;
      if (finishedMotion) status('动作完成，可继续操作。');
      if (state.visual) {
        if (!webgl) {
          if (!state.scene || !root.OriginmanWebGL) throw new Error("本地渲染场景缺失，请重新装载");
          webgl = root.OriginmanWebGL.create(canvas, state.scene, stats => {
            graphicsStats = stats;
            if (lastState) metrics(lastState);
          }, message => { void disconnect(); failed = true; status(message); controls(); }, pose => experience?.display(pose));
        }
        webgl.ingest(state, snap);
        hasFrame = true; canvas.hidden = false; preview.hidden = true; $('originman-scene-placeholder').hidden = true;
      } else {
      const version = ++imageVersion, image = new Image();
      image.onload = () => {
        if(version !== imageVersion) return;
        if (Number.isInteger(state.frameSize?.[0]) && Number.isInteger(state.frameSize?.[1]) && state.frameSize[0] > 0 && state.frameSize[0] <= 1280 && state.frameSize[1] > 0 && state.frameSize[1] <= 720) {
          if (canvas.width !== state.frameSize[0]) canvas.width = state.frameSize[0];
          if (canvas.height !== state.frameSize[1]) canvas.height = state.frameSize[1];
        }
        canvas.dataset.presentation = state.presentationVersion || 'legacy';
        const now = performance.now();
        if (paintedAt && now > paintedAt) displayFps = displayFps ? displayFps * 0.7 + 300 / (now - paintedAt) : 1000 / (now - paintedAt);
        paintedAt = now;
        canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
        hasFrame = true; canvas.hidden = false; preview.hidden = true; $('originman-scene-placeholder').hidden = true; controls();
      };
      image.onerror = () => {
        if(version !== imageVersion) return;
        void disconnect(); failed = true;
        status('实时画面未能解码，请重新装载；已录制的数据仍可导出。'); controls();
      };
      image.src = 'data:image/jpeg;base64,' + state.frame;
      }
      if(recording) {
        rows.push(...(state.samples || []).slice(0, 5000 - rows.length).map(sample => ({...sample,sourceRunId:source || null,policySha256:policy || null})));
        if(rows.length >= 5000) { recording=false; status('录制达到5000帧上限，已停止；可导出后开始新录制。'); }
      }
      experience?.capture(state, snap, {sessionId:current?.id, sourceRunId:source || null, policySha256:policy || null});
      metrics(state);
      if (trial && (state.done || state.time >= trial.duration - 1e-6)) {
        running=false;clearTimeout(timer);const finished=trial;trial=null;finished.resolve({...state,sourceRunId:source || null,policySha256:policy || null});
      }
      if(state.done) { clearDrive();running=false; recording=false; clearTimeout(timer); status(state.fallen?'机器人已跌倒，终态保留；重置后可重新尝试。':'本回合已结束，重置后继续。'); }
      controls();
    }
    function metrics(state) {
      if(experience?.isReviewing())return;
      $('originman-sim-metrics').textContent = '仿真 ' + state.time.toFixed(2) + 's · 场地位置 X ' + (100 * state.qpos[0]).toFixed(1) + ' cm / Y ' + (100 * state.qpos[1]).toFixed(1) + ' cm · 朝向 ' + state.yawDegrees.toFixed(1) + '° · 倾角 ' + state.tiltDegrees.toFixed(1) + '° · ' +
        (state.fallen ? '已跌倒，请重置' : experience?.phaseLabel() || (state.settled ? '保持平衡' : '恢复中')) + ' · 物理控制 50Hz' + (webgl && running ? ' · 本地画面 ' + (running ? graphicsStats?.motionFps || 0 : graphicsStats?.fps || 0).toFixed(0) + 'fps' + (graphicsStats?.stalled ? ' · 网络等待，画面已停住' : '') : running && displayFps ? ' · 画面 ' + displayFps.toFixed(1) + 'fps' : '') + ' · ' +
        (state.controller === 'trained-rl' ? '训练 Run ' + source + ' · 策略 ' + policy.slice(0,12) : '基础 PD，无学习修正');
    }
    function schedule() {
      clearTimeout(timer);
      if(running && current && activeView()) timer=setTimeout(()=>void step(),Math.max(0, frameInterval - (performance.now() - frameStarted)));
    }
    function command(body) {
      experience?.exitReview();
      const session = current;
      if(!session || connecting) return Promise.resolve();
      if(session.pending >= 4) { status('操作较密集，请等待当前操作完成。'); return Promise.resolve(); }
      session.pending++;
      const resets = body.command === 'reset';
      if (resets) {
        // A reset starts another episode. Keep the old export intact, but never
        // append its rewound timestamps to an existing single-episode recording.
        session.resetPending++; recording=false;
        status(rows.length ? '正在重置场景；原录制已结束并保留，可导出。' : '正在重置场景；完成后可开始录制。');
        controls();
      }
      const task = session.chain.then(async()=>{
        if(current !== session) return;
        try {
          const state=await request(path(session.id)+'/command',{method:'POST',body:JSON.stringify(body)});
          if(current !== session) return;
          draw(state, resets);
          if(resets) status('场景已重置；点击继续，或尝试单步与侧推。' + (rows.length ? '原录制已结束，仍可导出；新回合需重新开始录制。' : '可开始新回合录制。'));
          return state;
        }catch(error){
          if(current !== session) return;
          await disconnect(); failed=true;
          status('仿真操作失败：'+error.message+'。请重新装载；录制、训练和评测记录仍保留。'); controls();
        }
      }).finally(()=>{
        session.pending--;
        if (resets) { session.resetPending--; if(current === session) controls(); }
      });
      session.chain=task.catch(()=>undefined);
      return task;
    }
    async function step() {
      const session=current;
      if(!running || !session) return;
      frameStarted = performance.now();
      const elapsed = lastStepAt === null ? frameInterval : frameStarted - lastStepAt;
      lastStepAt = frameStarted;
      const due = Math.max(20, elapsed + stepRemainder);
      const remaining = trial ? Math.max(1, Math.round((trial.duration - (lastState?.time || 0)) * 50)) : 10;
      const steps = Math.max(1, Math.min(10, remaining, Math.floor(due / 20)));
      stepRemainder = Math.min(19.999, due - steps * 20);
      const drive = !trial && !recording && heldDirection();
      await command({command:'step',steps,...(drive ? {drive} : {})});
      if(current === session) schedule();
    }
    async function disconnect(keepExperience = false) {
      clearDrive();
      stopLink();
      if(!keepExperience){experimentSequence++;experience?.stop();}
      if(trial){const interrupted=trial;trial=null;interrupted.reject(new Error('实验已取消或连接已结束'));}
      epoch++;running=false;clearTimeout(timer);recording=false;imageVersion++;
      const previous=current;current=null;if(keepExperience || !experience){webgl?.dispose();webgl=null;}graphicsStats=null;ended=Boolean(previous) || ended;controls();
      if(previous)try{await request(path(previous.id),{method:'DELETE'});}catch{ /* Idle TTL also bounds abandoned sessions. */ }
    }
    async function connect(options = {}) {
      if(connecting) return false;
      connecting=true;failed=false;controls();
      await disconnect(true);
      if (Object.hasOwn(options, 'run')) $('originman-sim-controller').value = options.run ? 'trained' : 'baseline';
      const token=epoch, trained=$('originman-sim-controller').value==='trained', selected=options.run || getSource();
      try {
        if(trained && (!selected || selected.status!=='completed' || selected.training?.originmanWorkshop?.phase!=='train')) {
          status('先选择已完成的训练，或切换到基础 PD。');return false;
        }
        status('正在加载真实机器人模型'+(trained?'和所选权重':'')+'…');
        const state=await request('/sim2real/workshops/originman/sessions',{method:'POST',body:JSON.stringify({...trained?{sourceRunId:selected.id}:{}, ...(useWebGL?{renderMode:'webgl'}:{})})});
        if(epoch!==token || !activeView()) {
          await request(path(state.sessionId),{method:'DELETE'});return false;
        }
        current={id:state.sessionId,chain:Promise.resolve(),pending:0,resetPending:0};
        source=state.sourceRunId || '';policy=state.policySha256 || '';
        recording=false;running=true;ended=false;camera=15;distance=0.82;
        lastStepAt=null;stepRemainder=0;paintedAt=0;displayFps=0;frameStarted=performance.now();
        hasFrame=false;canvas.hidden=true;preview.hidden=!previewReady;draw(state);
        status('仿真已开始。方向键侧推；拖动旋转，滚轮缩放。当前是'+(trained?'所选训练策略':'基础 PD 对照')+'。');
        return true;
      }catch(error){failed=true;status('装载失败：'+error.message+'。可重试；不会自动改用其他模型，已有录制和评测保留。');return false;}
      finally{connecting=false;controls();schedule();}
    }
    $('originman-sim-preview-start').addEventListener('click',()=>void connect());
    $('originman-sim-connect').addEventListener('click',()=>void connect());
    $('originman-sim-disconnect').addEventListener('click',()=>void disconnect().then(()=>status('交互仿真已结束，录制数据仍可导出。')));
    $('originman-sim-controller').addEventListener('change',()=>{controls();if(current)void disconnect().then(()=>status('策略已改变，点击装载后运行；不会自动替换当前权重。'));});
    $('originman-sim-run').addEventListener('change',()=>{
      $('originman-run').value = $('originman-sim-run').value;
      $('originman-run').dispatchEvent(new Event('change', {bubbles:true}));
    });
    $('originman-run').addEventListener('change',()=>{controls();if(current || connecting)void disconnect().then(()=>status('所选训练已改变，请重新装载这次权重。'));});
    const togglePause = () => { clearDrive();experience?.exitReview();running=!running;controls();schedule(); };
    $('originman-sim-pause').addEventListener('click',togglePause);
    $('originman-sim-step').addEventListener('click',()=>{clearDrive();running=false;clearTimeout(timer);controls();void command({command:'step',steps:1});});
    $('originman-sim-reset').addEventListener('click',()=>{
      clearDrive();running=false;clearTimeout(timer);recording=false;controls();
      void command({command:'reset'}).then(state=>{if(state)status('场景已重置；点击继续，或尝试单步与侧推。原录制仍可导出。');});
    });
    const forceInput = $('originman-sim-force');
    function selectedForce() {
      const value = Number(forceInput.value);
      return Number.isFinite(value) ? Math.max(0.5, Math.min(9, value)) : 2;
    }
    function forceLabel() {
      const force = selectedForce().toFixed(1);
      $('originman-sim-force-value').textContent = force + ' N';
      $('originman-sim-left').textContent = '← 左侧推 ' + force + 'N';
      $('originman-sim-right').textContent = '右侧推 ' + force + 'N →';
    }
    forceInput.addEventListener('input', forceLabel);
    for (const [name, force] of [['gentle', 2], ['medium', 4], ['strong', 7.9]]) {
      $('originman-sim-force-' + name).addEventListener('click', () => { forceInput.value = force; forceLabel(); });
    }
    forceLabel();
    const push=direction=>command({command:'push',force:direction * selectedForce()});
    $('originman-sim-left').addEventListener('click',()=>void push(-1));
    $('originman-sim-right').addEventListener('click',()=>void push(1));
    $('originman-sim-home').addEventListener('click',()=>{camera=15;distance=0.82;if(webgl)webgl.setCamera({azimuth:camera,elevation:-20,distance});else void command({command:'camera',azimuth:camera,elevation:-20,distance});});
    $('originman-sim-benchmark').addEventListener('click',async()=>{
      clearDrive();running=false;clearTimeout(timer);controls();
      if(!await command({command:'reset'}))return;
      if(!await command({command:'push',force:-7.9,delay:1.55}))return;
      running=true;controls();schedule();
      status('正在复现公开条件0：1.55s时施加-7.9N侧推，持续0.2s。自由侧推的时机不同，表现可能不同。' + (rows.length ? '原录制已结束并保留，可导出；记录本次复现请点击开始新录制。' : '记录本次复现请点击开始录制。'));
    });
    $('originman-sim-record').addEventListener('click',()=>{if(current?.resetPending)return;recording=!recording;if(recording){rows=[];running=true;schedule();} controls();});
    $('originman-sim-export').addEventListener('click',()=>{
      const blob=new Blob([rows.map(row=>JSON.stringify(row)).join('\n')+'\n'],{type:'application/x-ndjson'});
      const url=URL.createObjectURL(blob),link=document.createElement('a');
      const recordedSource = rows[0]?.sourceRunId;
      link.href=url;link.download='originman-interactive-'+(recordedSource || 'baseline')+'.jsonl';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      status('已导出'+rows.length+'帧真实仿真观测与动作；交互录制不是正式评测或真机证据。');
    });
    async function act(name) {
      if (motionBlocked()) return;
      motionPending = true;
      controls();
      try {
        if (!current && !await connect()) return;
        if (lastState?.done && !await command({command:'reset'})) return;
        const state = await command({command:'motion',name});
        if (!state) return;
        running = true;
        lastStepAt = null;
        stepRemainder = 0;
        status('正在执行所选动作。可按空格暂停。');
        schedule();
      } finally {
        motionPending = false;
        controls();
      }
    }
    for (const button of motionButtons)
      button.addEventListener('click', () => void act(button.dataset.originmanMotion));
    async function holdDirection(key) {
      if (!current || connecting || motionPending || current.resetPending || experimentBusy || recording ||
          (lastState?.motion && !lastState.heldDrive && !lastState.done) ||
          $('originman-sim-controller').value === 'trained') return;
      heldKeys.add(key);
      if (lastState?.done && !await command({command:'reset'})) return;
      if (!heldKeys.has(key) || !current || heldDirection() !== driveKeys[key]) return;
      void link.start(driveKeys[key]);
      if (!running) {
        running = true;
        schedule();
      }
      controls();
    }
    window.addEventListener('keyup', event => {
      if (!heldKeys.delete(event.key.toLowerCase())) return;
      if (link.isEnabled()) clearDrive();
      controls();
    });
    canvas.addEventListener('blur',clearDrive);
    window.addEventListener('blur',clearDrive);
    document.addEventListener('visibilitychange',()=>{if(document.hidden)clearDrive();});
    canvas.addEventListener('keydown',event=>{
      const key = event.key.toLowerCase();
      if (Object.hasOwn(driveKeys,key) && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        if (!event.repeat) void holdDirection(key);
        return;
      }
      if (!event.repeat && Object.hasOwn(motionKeys,key)) {
        event.preventDefault();
        void act(motionKeys[key]);
        return;
      }
      if(event.repeat || experimentBusy || !current || lastState?.done && !['r','R'].includes(event.key)) return;
      if(['ArrowLeft','ArrowRight',' ','r','R'].includes(event.key))event.preventDefault();else return;
      if(event.key==='ArrowLeft')void push(-1);
      else if(event.key==='ArrowRight')void push(1);
      else if(event.key.toLowerCase()==='r'){clearDrive();running=false;clearTimeout(timer);recording=false;controls();void command({command:'reset'});}
      else togglePause();
    });
    canvas.addEventListener('pointerdown',event=>{drag={x:event.clientX,azimuth:camera};canvas.setPointerCapture(event.pointerId);canvas.focus();});
    canvas.addEventListener('pointermove',event=>{
      if(drag && webgl) webgl.setCamera({azimuth:Math.max(-360,Math.min(360,drag.azimuth+(event.clientX-drag.x)*0.4))});
    });
    canvas.addEventListener('pointerup',event=>{
      if(!drag)return;camera=Math.max(-360,Math.min(360,drag.azimuth+(event.clientX-drag.x)*0.4));drag=null;
      if(webgl)webgl.setCamera({azimuth:camera});else if(current)void command({command:'camera',azimuth:camera});
    });
    canvas.addEventListener('pointercancel',()=>{drag=null;});
    canvas.addEventListener('wheel',event=>{
      if(!current && !webgl)return;event.preventDefault();
      distance=Math.max(0.4,Math.min(2.5,distance+Math.sign(event.deltaY)*0.1));
      if(webgl)webgl.setCamera({distance});else void command({command:'camera',distance});
    },{passive:false});
    new MutationObserver(()=>{if(!activeView()){experience?.stop();if(current || webgl)void disconnect(true);else if(connecting)epoch++;}}).observe(panel,{attributes:true,attributeFilter:['data-originman-view','hidden']});
    window.addEventListener('pagehide',()=>{experience?.stop();void disconnect(true);},{once:true});
    experience = root.OriginmanExperience?.mount({
      getSource, supported:useWebGL, running:()=>running, connecting:()=>connecting, trained:()=>$('originman-sim-controller').value==='trained',
      force:selectedForce, canReplay:()=>Boolean(webgl),
      setBusy(value){experimentBusy=value;if(value)clearDrive();controls();},
      async pause(){clearDrive();running=false;clearTimeout(timer);controls();await current?.chain;},
      restore(){webgl?.clearReplay?.();if(lastState?.visual)webgl?.ingest(lastState,true);if(lastState)metrics(lastState);},
      showFrame(a,b,alpha){webgl?.showFrame?.(a,b,alpha);},
      cancelTrial(){experimentSequence++;running=false;clearTimeout(timer);if(trial){const cancelled=trial;trial=null;cancelled.reject(new Error('已取消'));}if(connecting)void disconnect();controls();},
      async runTrial({run,force,duration}) {
        const sequence=++experimentSequence;
        const assertActive=()=>{if(sequence!==experimentSequence)throw new Error('已取消');};
        if(!await connect({run}))throw new Error('策略装载未完成');
        assertActive();running=false;clearTimeout(timer);controls();await current?.chain;assertActive();
        canvas.scrollIntoView?.({block:'center',behavior:root.matchMedia?.('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
        if(!await command({command:'reset'}))throw new Error('场景重置未完成');
        assertActive();
        if(!await command({command:'push',force,delay:1.55}))throw new Error('定时扰动未设置');
        assertActive();
        return new Promise((resolve,reject)=>{trial={duration,resolve,reject};running=true;controls();schedule();});
      },
    }) || null;
    controls();
    return {disconnect,connect,setPreview,setSources};
  }
  root.OriginmanSimulator={mount};
})(globalThis);
