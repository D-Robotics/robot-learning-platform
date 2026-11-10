(() => {
  const STORAGE_KEY = 'rdk-duck-lab-onboarding-v1';
  const steps = [
    { target: '#product-select', view: 'overview', kicker: '01 / 05 · 机器人', title: '选择机器人档案', body: '选择内置参考机器人，或选择自定义机器人并登记自己的契约。', best: '自定义机器人需要对应的仿真、训练或设备适配器；未支持的能力会明确标出。', time: '约 10 秒' },
    { target: '#task-select', view: 'simulate', kicker: '02 / 05 · 数据', title: '准备数据或场景', body: '选择当前适配器提供的任务和仿真场景。没有仿真时，可沿用已有数据和训练环境。', best: '先跑通一个最小任务，再增加传感器和场景复杂度。', time: '约 30 秒' },
    { target: '[data-view-target="train"]', view: 'train', kicker: '03 / 05 · 训练', title: '绑定契约并训练', body: '确认观测、动作、数据和训练引擎与机器人档案匹配，再选择算力提交 Run。', best: '训练结果会绑定具体契约和来源；Mock 只验证流程，不代表真实学习。', time: '约 1 分钟' },
    { target: '[data-view-target="evaluate"]', view: 'evaluate', kicker: '04 / 05 · 结果', title: '检查结果和证据', body: '查看指定 Run 的指标、回放和数据来源；训练完成本身不代表质量达标。', best: '使用同一模型、任务和评测条件进行对比。', time: '约 1 分钟' },
    { target: '[data-view-target="deploy"]', view: 'deploy', kicker: '05 / 05 · 交付', title: '通过设备适配与预检', body: '在“更多”中管理设备和算力。目标设备须有对应适配器，通过兼容性和安全检查后才可发布。', best: '连接、预检和执行是不同阶段；每一步都保留可核验记录。', time: '约 1 分钟' },
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
    overlay.querySelector('#onboarding-kicker').textContent = step.kicker; overlay.querySelector('#onboarding-progress-label').textContent = `第 ${index + 1} / ${steps.length} 步`; overlay.querySelector('#onboarding-progress-bar').style.width = `${((index + 1) / steps.length) * 100}%`; overlay.querySelector('#onboarding-title').textContent = step.title; overlay.querySelector('#onboarding-body').textContent = step.body; overlay.querySelector('#onboarding-best').textContent = step.best; overlay.querySelector('#onboarding-time').textContent = `预计 ${step.time}`; overlay.querySelector('#onboarding-prev').disabled = index === 0; overlay.querySelector('#onboarding-next').textContent = index === steps.length - 1 ? '完成指引 ✓' : '下一步 →'; window.requestAnimationFrame(place);
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
