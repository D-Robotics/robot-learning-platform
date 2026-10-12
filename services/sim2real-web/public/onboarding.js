(() => {
  const STORAGE_KEY = 'rdk-duck-lab-onboarding-v1';
  const steps = [
    { target: '#user-start-panel', view: 'overview', kicker: '01 / 04 · 选择目标', title: '先选你想做的事', body: '首页提供三条入口：先体验一下、使用自己的设备、导入已有模型。先体验无需设备或 GPU；有设备和已有模型分别有自己的准备步骤。', best: '先选一个目标即可。左侧导航和进阶功能可以在需要时再看。', time: '约 10 秒阅读' },
    { target: '#onboard-card', view: 'overview', kicker: '02 / 04 · 先体验', title: '体验：录下动作，再回看记录', body: '选择“先体验一下”后，在示例仿真中实际采集观测和动作数据，再到评测页回看采样时间轴。录制并完整播放同一段记录，才算完成体验；阅读指引不会替你完成操作。', best: '此处回看动作数据，不重演三维机器人动作。无需先连接 GPU 或开发板；刷新前可在示例中导出记录。', time: '约 15 秒阅读' },
    { target: '#user-start-panel', view: 'overview', kicker: '03 / 04 · 设备与模型', title: '使用自己的设备或模型', body: '有自己的设备，先连接设备并检查连接状态。已有模型，先导入文件并检查与所选机器人是否兼容。平台会根据检查结果提示可继续的操作和缺少的条件。', best: '设备连接成功只是准备就绪；模型检查通过也不代表已经训练或部署。', time: '约 15 秒阅读' },
    { target: '#overview-advanced-evidence', view: 'overview', kicker: '04 / 04 · 继续进阶', title: '准备训练或真机时再继续', body: '需要训练时，选择任务模板并准备可用的训练后端。准备真机时，先完成只读预检；预检不会启动机器人。真实部署和运动仍需现场确认安全条件。', best: '体验以实际录制并完整回看同一段记录为准。关闭指引不会完成任务，训练、评测和部署按需要继续。', time: '约 15 秒阅读' },
  ];
  let index = 0, overlay = null, spotlight = null, card = null, lastFocus = null;
  // 指引声明了 role="dialog" aria-modal="true"，所以必须真的把背景隔离掉：
  // 以前只有一层视觉 scrim，键盘 Tab 仍能走到后面的工作台，屏幕阅读器也仍能
  // 读到被"盖住"的内容。inert 覆盖 body 下除指引本身以外的交互节点。
  function setBackgroundInert(inert) {
    for (const node of [document.querySelector('.app-shell'), document.getElementById('agent-floating-toggle')]) {
      if (node) node.inert = inert;
    }
  }
  // Tab 循环限制在卡片内。agent-chat.js 里已有一个手动循环的先例，这里沿用
  // 同样的写法，避免引入依赖。
  function trapTab(event) {
    if (event.key !== 'Tab' || !card) return;
    const focusables = [...card.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(
      (el) => !el.disabled && el.getClientRects().length,
    );
    if (!focusables.length) {
      event.preventDefault();
      card.focus();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (!card.contains(active)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }
  // 新手指引是一个完整的全屏交互，不在首次访问时抢占工作台；顶栏按钮或
  // 显式的 ?tour=1 才会打开它。
  const targetFor = (step) => step.target ? document.querySelector(step.target) : null;
  function build() {
    overlay = document.createElement('div'); overlay.className = 'onboarding-overlay'; overlay.hidden = true;
    overlay.innerHTML = `<div class="onboarding-scrim"></div><div class="onboarding-spotlight" aria-hidden="true"></div><section class="onboarding-card" role="dialog" aria-modal="true" aria-labelledby="onboarding-title" tabindex="-1"><div class="onboarding-card-top"><span class="onboarding-kicker" id="onboarding-kicker"></span><button class="onboarding-close" type="button" aria-label="关闭新手指引"><span aria-hidden="true">×</span></button></div><div class="onboarding-progress"><span id="onboarding-progress-label"></span><span class="onboarding-progress-track"><i id="onboarding-progress-bar"></i></span></div><h2 id="onboarding-title"></h2><p class="onboarding-body" id="onboarding-body"></p><div class="onboarding-best"><span>最佳实践</span><p id="onboarding-best"></p></div><div class="onboarding-card-foot"><span id="onboarding-time"></span><div class="onboarding-actions"><button class="button button-ghost button-small" id="onboarding-skip" type="button">跳过</button><button class="button button-ghost button-small" id="onboarding-prev" type="button">上一步</button><button class="button button-primary button-small" id="onboarding-next" type="button">下一步 →</button></div></div></section>`;
    document.body.append(overlay); spotlight = overlay.querySelector('.onboarding-spotlight'); card = overlay.querySelector('.onboarding-card');
    // 兜底：inert 一旦留在 .app-shell 上，整个工作台会永久失去交互能力。
    // finish() 是唯一的正常释放路径，但如果有代码（或测试）直接把覆盖层从
    // DOM 摘掉，这里保证 inert 会跟着释放。
    if (typeof MutationObserver === 'function') {
      new MutationObserver(() => {
        if (!document.body.contains(overlay)) setBackgroundInert(false);
      }).observe(document.body, { childList: true });
    }
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
    const step = steps[index]; if (step.view && typeof setView === 'function') setView(step.view, { focus: false });
    overlay.querySelector('#onboarding-kicker').textContent = step.kicker; overlay.querySelector('#onboarding-progress-label').textContent = `第 ${index + 1} / ${steps.length} 步`; overlay.querySelector('#onboarding-progress-bar').style.width = `${((index + 1) / steps.length) * 100}%`; overlay.querySelector('#onboarding-title').textContent = step.title; overlay.querySelector('#onboarding-body').textContent = step.body; overlay.querySelector('#onboarding-best').textContent = step.best; overlay.querySelector('#onboarding-time').textContent = `预计 ${step.time}`; overlay.querySelector('#onboarding-prev').disabled = index === 0; overlay.querySelector('#onboarding-next').textContent = index === steps.length - 1 ? '回到任务' : '下一步 →'; window.requestAnimationFrame(place);
  }
  function start() { if (!overlay) build(); lastFocus = document.activeElement; index = 0; overlay.hidden = false; document.body.classList.add('onboarding-open'); setBackgroundInert(true); render(); window.setTimeout(() => card?.focus(), 0); }
  function finish() { if (!overlay) return; overlay.hidden = true; document.body.classList.remove('onboarding-open'); setBackgroundInert(false); try { window.localStorage?.setItem(STORAGE_KEY, 'done'); } catch { /* storage may be unavailable (private mode): onboarding still works */ } if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus(); }
  document.getElementById('onboarding-help-button')?.addEventListener('click', start); document.addEventListener('keydown', (event) => { if (!overlay || overlay.hidden) return; if (event.key === 'Escape') { event.preventDefault(); finish(); return; } trapTab(event); }); window.addEventListener('resize', () => window.requestAnimationFrame(place)); window.addEventListener('scroll', () => window.requestAnimationFrame(place), { passive: true });
  // 等 DOM 就绪后再起算延迟：脚本是 defer 加载的，固定计时会从解析期开始
  // 计时，目标元素可能还没渲染出来。
  // Keep the workbench usable on first load. The guide is a deliberate,
  // full-screen interaction: open it from the top-bar button or explicitly
  // request it with ?tour=1. An automatic timeout used to cover the page
  // before the user had chosen a product or task, which made the dashboard
  // feel blocked and also interrupted keyboard users.
  const armAutoStart = () => window.setTimeout(() => {
    const forced = new URLSearchParams(window.location.search).get('tour') === '1';
    if (forced && (!document.getElementById('auth-gate') || document.getElementById('auth-gate').hidden)) start();
  }, 0);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', armAutoStart, { once: true });
  else armAutoStart();
})();
