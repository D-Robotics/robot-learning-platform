(function(root) {
  'use strict';
  const tiltOf = pose => {
    const q = pose.bodies.slice(10, 14); // floating-base world quaternion, w x y z
    return Math.acos(Math.max(-1, Math.min(1, 1 - 2 * (q[1] * q[1] + q[2] * q[2])))) * 180 / Math.PI;
  };
  function summarize(frames, forceEnd = null) {
    let peak = 0, start = null, recovered = null, firstForce = null, lastForce = null;
    for (const f of frames) {
      peak = Math.max(peak, f.tilt);
      if (Math.abs(f.force[1]) > 0.001) { firstForce ??= f.time - 0.02; lastForce = f.time; }
    }
    const end = forceEnd ?? lastForce;
    for (const f of frames) {
      if (end === null || f.time <= end || f.tilt > 3) { start = null; continue; }
      start ??= f.time;
      if (f.time - start >= 0.5 - 1e-6) { recovered = Math.max(0, start - end); break; }
    }
    return { peak, recovered, firstForce, lastForce, duration: frames.at(-1)?.time || 0 };
  }
  function bracket(frames, time) {
    let lo = 0, hi = frames.length - 1;
    while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (frames[mid].time <= time) lo = mid; else hi = mid - 1; }
    const a = frames[lo], b = frames[Math.min(lo + 1, frames.length - 1)];
    return { a, b, alpha: b.time > a.time ? Math.max(0, Math.min(1, (time - a.time) / (b.time - a.time))) : 0 };
  }
  function mount(adapter) {
    const $ = name => document.getElementById('originman-lab-' + name);
    if (!$('panel')) return null;
    let frames = [], metadata = {}, records = [], reviewing = false, playing = false, busy = false, generation = 0;
    let chartMaxTime = 8;
    let selectedFrames = frames, position = 0, animation, lastTick = null, lastDisplayAt = -Infinity, applied = false, stableSince = null;
    const note = text => { $('note').textContent = text; };
    const eligible = () => { const run = adapter.getSource(); return run?.status === 'completed' && run.training?.originmanWorkshop?.phase === 'train'; };
    function sync() {
      $('demo').disabled = busy || adapter.connecting() || !adapter.supported || adapter.trained() && !eligible();
      $('direction').disabled = busy;
      $('compare').disabled = busy || adapter.connecting() || !eligible() || !adapter.supported;
      $('cancel').hidden = !busy;
      $('replay').disabled = busy || selectedFrames.length < 2 || !adapter.canReplay();
      $('seek').disabled = busy || selectedFrames.length < 2 || !adapter.canReplay();
      $('trace').disabled = busy || !records.length;
      $('save').disabled = busy || !records.length;
      $('speed').disabled = busy;
      $('live').disabled = !reviewing;
      $('replay').textContent = playing ? '暂停回看' : '播放本轮';
      $('source').textContent = !adapter.supported ? '当前浏览器使用兼容画面；定时实验与慢放需支持 WebGL2。下方仍可自由侧推。' : eligible() ? '对照将使用当前所选训练的真实权重。' : '先体验基础 PD；选择已完成的训练后可做同条件对照。';
    }
    function exitReview() {
      if(!reviewing && !playing)return;
      playing = false; reviewing = false; lastTick = null; cancelAnimationFrame(animation);
      adapter.restore(); sync();
    }
    function display(frame, time = frame.time, local = false) {
      const now = performance.now();
      if (!local && adapter.running() && now - lastDisplayAt < 80) return;
      lastDisplayAt = now;
      const force = frame.force[1] || 0;
      if (Math.abs(force) > 0.001) { applied = true; stableSince = null; }
      else if (applied && frame.tilt <= 3) stableSince ??= time;
      else stableSince = null;
      const phase = frame.fallen || frame.tilt > 45 ? '已跌倒' : Math.abs(force) > 0.001 ? '正在受力' : !applied ? '稳定站立 · 等待扰动' : stableSince !== null && time - stableSince >= 0.5 ? '已回到平衡区间' : '扰动后 · 观察恢复';
      if ($('phase').textContent !== phase) $('phase').textContent = phase;
      $('force').textContent = Math.abs(force).toFixed(1) + ' N' + (force < 0 ? ' ←' : force > 0 ? ' →' : '');
      $('tilt').textContent = frame.tilt.toFixed(1) + '°';
      $('clock').textContent = (reviewing ? '回看 ' : '') + time.toFixed(2) + 's';
      if (reviewing) document.getElementById('originman-sim-metrics').textContent = '本轮回看 ' + time.toFixed(2) + 's · 倾角 ' + frame.tilt.toFixed(1) + '° · 真实物理采样 50Hz · ' + $('speed').value + '×';
      const max = chartMaxTime;
      $('cursor').setAttribute('x1', String(36 + Math.min(1, time / max) * 592));
      $('cursor').setAttribute('x2', String(36 + Math.min(1, time / max) * 592));
    }
    function seek(time) {
      if (!selectedFrames.length) return;
      position = Math.max(selectedFrames[0].time, Math.min(selectedFrames.at(-1).time, time));
      const { a, b, alpha } = bracket(selectedFrames, position);
      adapter.showFrame(a, b, alpha);
      $('seek').value = String(position);
      const observed = alpha >= 1 ? b : a;
      const prefix = summarize(selectedFrames.filter(frame => frame.time <= position));
      applied = prefix.lastForce !== null;
      stableSince = prefix.recovered === null ? null : prefix.lastForce + prefix.recovered;
      display({ ...observed, tilt: a.tilt + (b.tilt - a.tilt) * alpha }, position, true);
      $('replay-time').textContent = position.toFixed(2) + ' / ' + selectedFrames.at(-1).time.toFixed(2) + 's';
    }
    function graph() {
      const traces = records.length > 1 ? records : records.length && busy ? [...records,{frames:selectedFrames,label:'当前'}] : [{ frames: selectedFrames, label: '本轮' }];
      const all = traces.flatMap(r => r.frames);
      const maxTime = Math.max(8, ...all.map(f => f.time));
      chartMaxTime = maxTime;
      const maxTilt = Math.max(15, Math.ceil(Math.max(0, ...all.map(f => f.tilt)) / 15) * 15);
      $('seek').max = String(selectedFrames.at(-1)?.time || 8);
      if(!reviewing)$('replay-time').textContent = position.toFixed(2)+' / '+(selectedFrames.at(-1)?.time || 0).toFixed(2)+'s';
      const layer = $('curves'); layer.replaceChildren();
      function svg(tag, attrs) { const el = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k,v] of Object.entries(attrs)) el.setAttribute(k,String(v)); layer.append(el); return el; }
      for (const value of [0, maxTilt / 2, maxTilt]) {
        const y = 120 - value / maxTilt * 100;
        svg('line', {x1:36,x2:628,y1:y,y2:y,class:'originman-chart-grid'});
        svg('text',{x:2,y:y+4,class:'originman-chart-label'}).textContent = value.toFixed(0) + '°';
      }
      for (const value of [0,maxTime/2,maxTime]) svg('text',{x:36+value/maxTime*592,y:153,class:'originman-chart-label'}).textContent=value.toFixed(1)+'s';
      traces.forEach((trace, index) => {
        let open = null;
        for (const f of trace.frames) {
          if (Math.abs(f.force[1]) > 0.001) open ??= f.time - 0.02;
          else if (open !== null) { svg('rect',{x:36+open/maxTime*592,y:124,width:Math.max(1,(f.time-open)/maxTime*592),height:8,class:'originman-chart-force'});open=null; }
        }
        if(open!==null) svg('rect',{x:36+open/maxTime*592,y:124,width:Math.max(1,((trace.frames.at(-1)?.time||0)-open)/maxTime*592),height:8,class:'originman-chart-force'});
        svg('polyline',{points:trace.frames.map(f=>(36+f.time/maxTime*592).toFixed(1)+','+(120-f.tilt/maxTilt*100).toFixed(1)).join(' '),class:index===0&&traces.length>1?'originman-chart-baseline':'originman-chart-policy'});
      });
      $('chart').setAttribute('aria-label','真实采样倾角曲线，横轴0至'+maxTime.toFixed(1)+'秒，纵轴0至'+maxTilt+'度，橙色条为实际施力区间');
    }
    function renderResults() {
      const body = $('results'); body.replaceChildren();
      for (const record of records) {
        const summary = summarize(record.frames);
        const row = document.createElement('tr');
        const result = record.fallen ? '已跌倒' : record.complete ? '8秒内未跌倒' : '已停止 · 未完成';
        const recovery = summary.lastForce === null ? '未观察到施力' : summary.recovered === null ? '未观察到回稳' : summary.recovered.toFixed(2) + 's';
        for (const value of [record.label, result, summary.peak.toFixed(1)+'°', recovery]) { const cell=document.createElement('td');cell.textContent=value;row.append(cell); }
        body.append(row);
      }
      $('result-section').hidden = !records.length;
      const picker = $('trace'); picker.replaceChildren();
      records.forEach((record,index)=>{const option=document.createElement('option');option.value=String(index);option.textContent=record.label;picker.append(option);});
      if(records.length)picker.value=String(records.length-1);
    }
    function capture(state, snap, meta) {
      if (reviewing) exitReview();
      if (snap || state.time < (frames.at(-1)?.time ?? -1) || meta.sessionId !== metadata.sessionId) {
        frames=[];selectedFrames=frames;position=0;applied=false;stableSince=null;metadata={...meta};
        if(!busy){records=[];renderResults();}
      }
      if(!busy && records.length && state.time > (frames.at(-1)?.time ?? 0)) {records=[];renderResults();note('已返回自由仿真；时间线继续记录本轮真实采样。');}
      const visuals = state.visuals?.length ? state.visuals : state.visual ? [state.visual] : [];
      visuals.forEach((visual,index)=>{
        const raw=state.samples?.[index];
        const sample={...visual,tilt:raw?.metrics?.tiltDegrees ?? tiltOf(visual),fallen:Boolean(raw?.metrics?.fallen || state.fallen && visual.time===state.time)};
        if(sample.time>(frames.at(-1)?.time??-1))frames.push(sample);
      });
      if(frames.length>3001)frames.splice(0,frames.length-3001);
      selectedFrames=frames; graph(); sync();
      if(!state.visual) display({time:state.time,tilt:state.tiltDegrees,force:state.externalForceWorldN||[0,0,0],fallen:state.fallen});
    }
    async function run(compare) {
      if(busy)return;
      const selected=adapter.getSource();
      if((compare||adapter.trained())&&!eligible()){note('请先选择已完成的训练；不会替换为基础 PD。');return;}
      exitReview(); busy=true; generation++;const token=generation;
      records=[];renderResults();adapter.setBusy(true);sync();
      const force=adapter.force()*Number($('direction').value);
      try {
        const modes=compare?[null,selected]:(adapter.trained()? [selected]:[null]);
        for(let index=0;index<modes.length;index++) {
          if(token!==generation)return;
          const run=modes[index],label=run?'所选训练策略':'基础 PD';
          note((compare?(index+1)+'/2 · ':'')+label+'：1.55秒施加'+Math.abs(force).toFixed(1)+'N，观察受扰与恢复。');
          const result=await adapter.runTrial({run,force,duration:8});
          if(token!==generation)return;
          if(!frames.length)throw new Error('未收到可回看的真实姿态');
          if(!result.sceneSha256)throw new Error('无法核对本轮模型来源');
          if(run&&!result.policySha256)throw new Error('未收到所选策略的权重摘要');
          if(records.length && records[0].sceneSha256!==result.sceneSha256)throw new Error('两轮模型摘要不同，无法生成同条件对照');
          if(run&&result.sourceRunId!==run.id)throw new Error('返回的训练来源与所选模型不一致');
          records.push({label:run?label+' · '+run.id.slice(0,8):label,frames:frames.slice(),fallen:result.fallen,complete:result.time>=8-1e-6,sceneSha256:result.sceneSha256,sourceRunId:result.sourceRunId,policySha256:result.policySha256,force});
          renderResults();graph();
        }
        const verdict = compare ? records[0].fallen && !records[1].fallen ? '本轮所选策略未跌倒，基础 PD 已跌倒。' : !records[0].fallen && records[1].fallen ? '本轮所选策略跌倒，基础 PD 未跌倒；训练结果尚需改进。' : records.every(record=>record.fallen) ? '本轮两种策略均跌倒，可减轻力度观察恢复过程。' : '本轮两种策略均未跌倒，可对照峰值倾角和回稳用时。' : '';
        note(compare?'同条件对照完成。'+verdict+'选择一轮，拖动时间线或慢放回看。':'本轮实验完成。橙色条是实际施力区间；拖动时间线，看清受扰与恢复。');
      } catch(error) {
        if(token===generation)note('实验已停止：'+error.message+'。已有曲线保留，可重新开始。');
      } finally { if(token===generation){busy=false;adapter.setBusy(false);sync();} }
    }
    $('demo').addEventListener('click',()=>void run(false));
    $('compare').addEventListener('click',()=>void run(true));
    $('cancel').addEventListener('click',()=>{generation++;busy=false;adapter.cancelTrial();adapter.setBusy(false);note('已取消实验，当前真实画面与采样保留。');sync();});
    $('trace').addEventListener('change',async()=>{const token=generation;await adapter.pause();if(token!==generation||!adapter.canReplay())return;selectedFrames=records[Number($('trace').value)]?.frames||frames;reviewing=true;playing=false;applied=false;stableSince=null;position=0;graph();seek(0);sync();});
    $('seek').addEventListener('input',async()=>{const token=generation;playing=false;await adapter.pause();if(token!==generation||!adapter.canReplay())return;reviewing=true;applied=false;stableSince=null;seek(Number($('seek').value));sync();});
    function animate(now) {
      if(!playing)return;
      const delta=lastTick===null?0:Math.min(0.1,(now-lastTick)/1000);lastTick=now;
      seek(position+delta*Number($('speed').value));
      if(position>=selectedFrames.at(-1).time-1e-6){playing=false;sync();return;}
      animation=requestAnimationFrame(animate);
    }
    $('replay').addEventListener('click',async()=>{
      if(playing){playing=false;sync();return;}
      const token=generation;await adapter.pause();if(token!==generation||!adapter.canReplay())return;reviewing=true;playing=true;lastTick=null;
      if(position>=selectedFrames.at(-1).time-1e-6){position=selectedFrames[0].time;applied=false;stableSince=null;}
      sync();animation=requestAnimationFrame(animate);
    });
    $('save').addEventListener('click',()=>{
      const report={schemaVersion:1,kind:'classroom-simulation-observation',protocol:{initialSeed:100,pushAtSeconds:1.55,pushDurationSeconds:0.2,observeSeconds:8,recoveryTiltDegrees:3,recoveryHoldSeconds:0.5},records:records.map(record=>({...record,summary:summarize(record.frames),frames:record.frames.map(({time,tilt,force,fallen})=>({time,tilt,force,fallen}))})),verified:false,hardwareEligible:false};
      const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
      const link=document.createElement('a');link.href=url;link.download='originman-workshop-observation.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      note('已保存本轮真实观察、扰动参数和策略来源，可用于课堂复盘。');
    });
    const stage=document.getElementById('originman-live-sim');
    // Use the top layer without reparenting the live renderer or relying on
    // embedded hosts to settle a native fullscreen request.
    function present(active) {
      stage.classList.toggle('is-presenting',active);
      if(active&&stage.showPopover){stage.setAttribute('popover','manual');stage.showPopover();}
      else if(stage.hasAttribute('popover')){stage.hidePopover();stage.removeAttribute('popover');}
      $('present').textContent=active?'退出演示模式':'演示模式 · 大屏';
    }
    $('present').addEventListener('click',()=>present(!stage.classList.contains('is-presenting')));
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&stage.classList.contains('is-presenting'))present(false);});
    $('live').addEventListener('click',exitReview);
    sync();
    return {capture,sync,exitReview,isReviewing:()=>reviewing,phaseLabel:()=>$('phase').textContent,display:pose=>{ if(!reviewing)display({...pose,tilt:tiltOf(pose)}); },stop:()=>{generation++;busy=false;playing=false;reviewing=false;cancelAnimationFrame(animation);adapter.restore();adapter.setBusy(false);sync();}};
  }
  root.OriginmanExperience={mount,summarize,bracket,tiltOf};
})(globalThis);
