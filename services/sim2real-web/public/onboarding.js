(() => {
  const STORAGE_KEY = 'rdk-duck-lab-onboarding-v1';
  const steps = [
    { target: '#product-select', view: 'overview', kicker: '01 / 09 · 工作台', title: '先选产品线', body: '在左侧项目卡里切换产品线。MicroDuck 是开箱参考；RDK Duck 使用你们自己的契约、仿真和策略资产。切换后，模型、运行记录和部署状态都会按产品隔离。', best: '最佳实践：先选产品线，再登记模型，避免把不同设备的证据混在一起。', time: '约 20 秒' },
    { target: '#task-select', view: 'simulate', kicker: '02 / 09 · 仿真与录制', title: '确定动作任务', body: '仿真页右侧选择动作任务。从“行走”开始最容易验证闭环，也可以切换转向、坐下 / 站起、自恢复或踢球。动作任务会贯穿仿真、训练和评测。', best: '建议：一次只验证一个动作任务，先跑通再增加复杂动作。', time: '约 20 秒' },
    { target: '#model-select', view: 'train', kicker: '03 / 09 · 训练与模型', title: '确认模型版本', body: '训练页顶部选择模型。模型契约定义观测、动作、关节和目标平台。没有模型时，展开“套件与契约 · 登记模型”，载入模板、校验并登记；当前产品只会显示自己的模型。', best: '最佳实践：把版本和 manifest 一起保存，后续评测与部署才能追溯。', time: '约 1 分钟' },
    { target: '#device-select', view: 'deploy', kicker: '04 / 09 · 部署与上线', title: '选择目标设备', body: '部署页顶部选择要验证的板卡。没有连接真机也可以继续仿真、训练和评测；部署会停在只读预检，不会把离线设备误报为可上线。', best: '无设备演示：选择登记的目标板卡即可查看流程，所有真机动作仍受安全门控。', time: '约 20 秒' },
    { target: '[data-view-target="simulate"]', view: 'simulate', kicker: '05 / 09 · 仿真与录制', title: '先做一段仿真', body: '仿真页用于运行场景和录制动作证据。录制文件可以下载为 JSONL，供复盘、训练和后续仿真 / 真机对照使用。', best: '建议：先录制 30–60 秒稳定动作；使用 Space 重置，再重复同一动作观察一致性。', time: '约 1 分钟' },
    { target: '[data-view-target="train"]', view: 'train', kicker: '06 / 09 · 训练', title: '再发起训练', body: '训练页可以选择本地 Worker、自己的 GPU Worker 或 RoboGo。先用冒烟档验证资源和契约，再升级到标准训练，运行状态会持续写入记录。', best: '最佳实践：先确认模型契约和算力后端，再提交长任务；不要用演示样例判断真实效果。', time: '约 1–5 分钟' },
    { target: '[data-view-target="evaluate"]', view: 'evaluate', kicker: '07 / 09 · 评测', title: '用遥测做评测', body: '评测页汇总成功率、跌倒率、控制延迟，并支持导入仿真或板端 JSONL。合成演示证据会明确标记，不会冒充真实评测。', best: '建议：保持同一动作任务和模型版本，再比较仿真与真机，结论才有意义。', time: '约 1 分钟' },
    { target: '[data-view-target="deploy"]', view: 'deploy', kicker: '08 / 09 · 部署', title: '最后生成只读预检', body: '部署页先探测板型、生成预检计划，再检查契约、模型、板卡和运行时。没有真实 BoardAgent 时，预检会保持阻断，不会启动节点或电机。', best: '最佳实践：先看评测证据，再做只读预检；Canary / Live 始终需要人工批准。', time: '约 1 分钟' },
    { target: '#agent-floating-toggle', view: null, kicker: '09 / 09 · Agent', title: '随时让 Agent 规划', body: '右下角 Agent 可以把“仿真 → 训练 → 评测 → 预检”整理成可追踪步骤，并展示计划、工具事件和运行结果。', best: '提示：输入具体目标更容易得到可执行计划；所有真机动作仍需人工批准。', time: '随时可用' },
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
  function finish() { if (!overlay) return; overlay.hidden = true; document.body.classList.remove('onboarding-open'); try { window.localStorage?.setItem(STORAGE_KEY, 'done'); } catch {} if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus(); }
  document.getElementById('onboarding-help-button')?.addEventListener('click', start); document.addEventListener('keydown', (event) => { if (!overlay?.hidden && event.key === 'Escape') { event.preventDefault(); finish(); } }); window.addEventListener('resize', () => window.requestAnimationFrame(place)); window.addEventListener('scroll', () => window.requestAnimationFrame(place), { passive: true });
  window.setTimeout(() => { let seen = false; try { seen = window.localStorage?.getItem(STORAGE_KEY) === 'done'; } catch {} const forced = new URLSearchParams(window.location.search).get('tour') === '1'; if ((!seen || forced) && (!document.getElementById('auth-gate') || document.getElementById('auth-gate').hidden)) start(); }, 900);
})();
