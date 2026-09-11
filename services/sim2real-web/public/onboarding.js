(() => {
  const STORAGE_KEY = 'rdk-duck-lab-onboarding-v1';
  const steps = [
    { target: '#product-select', view: 'overview', kicker: '01 / 12 · 项目', title: '先选择 OriginBot', body: '在左侧产品选择器选择“OriginBot · X5 真机”。选择后，仿真、模型契约、设备和发布状态都会切换到 OriginBot 这一条产品线。', best: '不要停留在 RDK Duck 或 MicroDuck；它们的观测和动作契约不同。', time: '约 10 秒' },
    { target: '[data-view-target="station"]', view: 'station', kicker: '02 / 12 · 服务器与设备', title: '先连接服务器和设备', body: '在设备上位机登记 GPU 服务器和 OriginBot，完成 SSH/board-agent 预检。实时遥测在线不等于 SSH 隧道已验证，两条状态会分别显示。', best: '先看到 mock=false、相机、IMU、odom 均通过，再进入仿真和训练。', time: '约 1 分钟' },
    { target: '#task-select', view: 'simulate', kicker: '03 / 12 · 仿真', title: '选择 OriginBot 任务', body: '在仿真页选择目标导航或视觉控制任务。仿真轨迹会进入统一数据契约，后续可回放、评测和对照真机。', best: '先用最小目标导航任务跑通，再扩展视觉和复杂场景。', time: '约 20 秒' },
    { target: '[data-view-target="simulate"]', view: 'simulate', kicker: '04 / 12 · 录制', title: '录制一段可复现轨迹', body: '运行仿真并录制轨迹。录制结果必须显示来源、版本和 synthetic/mock 标记，不能把仿真证据当成真实设备证据。', best: '建议先录制 30–60 秒稳定轨迹，并立即回放确认。', time: '约 1 分钟' },
    { target: '#model-select', view: 'train', kicker: '05 / 12 · 模型', title: '确认模型与契约', body: '训练页选择 OriginBot 模型，确认 observation/action shape、目标平台和数据来源。契约不匹配时，后续加载会被阻断。', best: '模型版本、manifest 和数据集版本必须一起保存。', time: '约 30 秒' },
    { target: '[data-view-target="train"]', view: 'train', kicker: '06 / 12 · GPU 训练', title: '提交 GPU 训练', body: '选择真实 GPU worker，先执行冒烟训练，再提交正式任务。运行状态、GPU 型号、指标和 ONNX artifact 会自动记录。', best: 'mock=true 的结果只能验证协议，不能进入发布。', time: '约 1–5 分钟' },
    { target: '[data-view-target="evaluate"]', view: 'evaluate', kicker: '07 / 12 · 评测', title: '检查数据和评测', body: '评测页汇总仿真、真实传感器和板端遥测。真实视觉策略必须有真实图像与动作标签；缺少证据会明确显示 blocked。', best: '不要跳过评测直接部署。', time: '约 1 分钟' },
    { target: '[data-view-target="deploy"]', view: 'deploy', kicker: '08 / 12 · 编译', title: '编译 X5 BPU 制品', body: '部署页检查 ONNX、HBDK 版本、march、校准集和 SHA-256。HBDK 缺失或制品不匹配时，平台不会伪造成功。', best: '保留编译日志和 artifact digest。', time: '约 1–3 分钟' },
    { target: '#device-select', view: 'deploy', kicker: '09 / 12 · 加载', title: '加载到 OriginBot', body: '选择真实 OriginBot，上传并校验制品，然后由 hobot_dnn/BPU 原生加载和 forward。只读加载不会启动电机。', best: '确认 provider=hobot_dnn、shape 正确且 lastError=null。', time: '约 30 秒' },
    { target: '[data-view-target="deploy"]', view: 'deploy', kicker: '10 / 12 · 低速验收', title: '执行低速策略验收', body: '现场确认安全区域、急停和速度上限后，才进入低速 canary。运行时间、速度、推理延迟和自动 stop 都会记录。', best: '第一轮建议不超过 0.05 m/s、1–2 秒。', time: '约 1 分钟' },
    { target: '[data-view-target="records"]', view: 'records', kicker: '11 / 12 · 证据', title: '检查发布证据', body: '记录页查看训练、编译、加载、遥测和 stop 证据。任何 mock、synthetic、stale telemetry 或未完成评测都会阻断发布。', best: '发布前确认所有证据来自同一模型和设备版本。', time: '约 1 分钟' },
    { target: '#agent-floating-toggle', view: null, kicker: '12 / 12 · Agent', title: '让 Agent 编排下一步', body: '右下角 Agent 可以按当前阻塞项生成下一步计划，并调用服务器、设备和训练工具。危险动作始终需要人工确认。', best: '直接说“检查 OriginBot 并继续到下一步”即可。', time: '随时可用' },
  ];
  let index = 0, overlay = null, spotlight = null, card = null, lastFocus = null;
  const targetFor = (step) => step.target ? document.querySelector(step.target) : null;
  function build() {
    overlay = document.createElement('div'); overlay.className = 'onboarding-overlay'; overlay.hidden = true;
    overlay.innerHTML = `<div class="onboarding-scrim"></div><div class="onboarding-spotlight" aria-hidden="true"></div><section class="onboarding-card" role="dialog" aria-modal="true" aria-labelledby="onboarding-title" tabindex="-1"><div class="onboarding-card-top"><span class="onboarding-kicker" id="onboarding-kicker"></span><button class="onboarding-close" type="button" aria-label="关闭新手指引">×</button></div><div class="onboarding-progress"><span id="onboarding-progress-label"></span><span class="onboarding-progress-track"><i id="onboarding-progress-bar"></i></span></div><h2 id="onboarding-title"></h2><p class="onboarding-body" id="onboarding-body"></p><div class="onboarding-best"><span>最佳实践</span><p id="onboarding-best"></p></div><div class="onboarding-card-foot"><span id="onboarding-time"></span><div class="onboarding-actions"><button class="button button-ghost button-small" id="onboarding-skip" type="button">跳过</button><button class="button button-ghost button-small" id="onboarding-prev" type="button">上一步</button><button class="button button-primary button-small" id="onboarding-next" type="button">下一步 →</button></div></div></section>`;
    document.body.append(overlay); spotlight = overlay.querySelector('.onboarding-spotlight'); card = overlay.querySelector('.onboarding-card');
    overlay.querySelector('.onboarding-close').addEventListener('click', finish); overlay.querySelector('#onboarding-skip').addEventListener('click', finish);
    overlay.querySelector('#onboarding-prev').addEventListener('click', () => { if (index > 0) { index -= 1; render(); } });
    overlay.querySelector('#onboarding-next').addEventListener('click', () => { if (index >= steps.length - 1) finish(); else { index += 1; render(); } });
    overlay.addEventListener('click', (event) => { if (event.target === overlay.querySelector('.onboarding-scrim')) finish(); });
  }
  function place() {
    if (!overlay || overlay.hidden) return; const target = targetFor(steps[index]);
    if (!target || target.getClientRects().length === 0) { spotlight.hidden = true; card.classList.add('is-centered'); return; }
    spotlight.hidden = false; card.classList.remove('is-centered'); const rect = target.getBoundingClientRect(); const pad = 8;
    spotlight.style.left = `${Math.max(8, rect.left - pad)}px`; spotlight.style.top = `${Math.max(8, rect.top - pad)}px`; spotlight.style.width = `${Math.min(window.innerWidth - 16, rect.width + pad * 2)}px`; spotlight.style.height = `${Math.min(window.innerHeight - 16, rect.height + pad * 2)}px`;
    const cardRect = card.getBoundingClientRect(); let left = Math.min(Math.max(16, rect.left), window.innerWidth - cardRect.width - 16); let top = rect.bottom + 18;
    if (top + cardRect.height > window.innerHeight - 16) top = rect.top - cardRect.height - 18; if (top < 16) { top = 16; left = Math.min(Math.max(16, rect.right + 18), window.innerWidth - cardRect.width - 16); }
    card.style.left = `${Math.max(16, left)}px`; card.style.top = `${Math.max(16, top)}px`;
  }
  function render() {
    const step = steps[index]; if (step.view && typeof setView === 'function') setView(step.view);
    overlay.querySelector('#onboarding-kicker').textContent = step.kicker; overlay.querySelector('#onboarding-progress-label').textContent = `第 ${index + 1} / ${steps.length} 步`; overlay.querySelector('#onboarding-progress-bar').style.width = `${((index + 1) / steps.length) * 100}%`; overlay.querySelector('#onboarding-title').textContent = step.title; overlay.querySelector('#onboarding-body').textContent = step.body; overlay.querySelector('#onboarding-best').textContent = step.best; overlay.querySelector('#onboarding-time').textContent = `预计 ${step.time}`; overlay.querySelector('#onboarding-prev').disabled = index === 0; overlay.querySelector('#onboarding-next').textContent = index === steps.length - 1 ? '完成指引 ✓' : '下一步 →'; window.requestAnimationFrame(place);
  }
  function start() { if (!overlay) build(); lastFocus = document.activeElement; index = 0; overlay.hidden = false; document.body.classList.add('onboarding-open'); render(); window.setTimeout(() => overlay.querySelector('#onboarding-next')?.focus(), 0); }
  function finish() { if (!overlay) return; overlay.hidden = true; document.body.classList.remove('onboarding-open'); try { window.localStorage?.setItem(STORAGE_KEY, 'done'); } catch { /* storage may be unavailable (private mode): onboarding still works */ } if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus(); }
  document.getElementById('onboarding-help-button')?.addEventListener('click', start); document.addEventListener('keydown', (event) => { if (!overlay?.hidden && event.key === 'Escape') { event.preventDefault(); finish(); } }); window.addEventListener('resize', () => window.requestAnimationFrame(place)); window.addEventListener('scroll', () => window.requestAnimationFrame(place), { passive: true });
  window.setTimeout(() => { let seen = false; try { seen = window.localStorage?.getItem(STORAGE_KEY) === 'done'; } catch { /* storage may be unavailable (private mode): onboarding still works */ } const forced = new URLSearchParams(window.location.search).get('tour') === '1'; if ((!seen || forced) && (!document.getElementById('auth-gate') || document.getElementById('auth-gate').hidden)) start(); }, 900);
})();
