/* 轻量层设计预览：纯前端闯关状态机，未接真实数据。
   CSP 要求外链脚本（script-src 'self'），所以逻辑单独放在这个文件里。 */
(function () {
  'use strict';

  var PROGRESS_KEY = 'rdk-light-lab-progress-v1';
  var ADVANCED_KEY = 'rdk-light-lab-advanced';
  var THEME_KEY = 'rdk-lab-theme';
  var STEPS = [1, 2, 3, 4];
  var VIEWS = ['home', 'step-1', 'step-2', 'step-3', 'step-4'];

  function $(id) {
    return document.getElementById(id);
  }

  /* ---------- 闯关进度（localStorage 持久化） ---------- */
  var progress = readProgress();

  function readProgress() {
    var clean = {};
    STEPS.forEach(function (n) {
      clean['step' + n] = false;
    });
    try {
      var raw = window.localStorage && window.localStorage.getItem(PROGRESS_KEY);
      var parsed = raw ? JSON.parse(raw) : {};
      STEPS.forEach(function (n) {
        clean['step' + n] = Boolean(parsed['step' + n]);
      });
    } catch (error) {
      /* 存储不可用时退化为会话内状态 */
    }
    return clean;
  }

  function writeProgress() {
    try {
      window.localStorage && window.localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
    } catch (error) {
      /* 忽略持久化失败 */
    }
  }

  function renderProgress() {
    var done = STEPS.filter(function (n) {
      return progress['step' + n];
    }).length;
    var fill = $('progress-fill');
    if (fill) fill.style.width = (done / STEPS.length) * 100 + '%';
    Array.prototype.forEach.call(document.querySelectorAll('.quest-item'), function (item) {
      var n = Number(item.getAttribute('data-step'));
      var stateEl = item.querySelector('.quest-state');
      var isDone = progress['step' + n];
      var isNext = !isDone && n === done + 1;
      item.classList.toggle('is-done', isDone);
      item.classList.toggle('is-next', isNext);
      if (stateEl) {
        stateEl.textContent = isDone ? '已完成 ✓' : isNext ? '就从这个开始 →' : '未开始';
        stateEl.setAttribute('data-state', isDone ? 'done' : isNext ? 'next' : 'todo');
      }
    });
    var finalCard = $('final-card');
    if (finalCard) finalCard.hidden = done < STEPS.length;
  }

  /* ---------- hash 路由 ---------- */
  function currentView() {
    var hash = (location.hash || '#home').replace(/^#/, '');
    return VIEWS.indexOf(hash) >= 0 ? hash : 'home';
  }

  function route() {
    var view = currentView();
    Array.prototype.forEach.call(document.querySelectorAll('.lab-view'), function (el) {
      el.hidden = el.getAttribute('data-view') !== view;
    });
    if (view === 'step-2') startTrainingAnimation();
    window.scrollTo(0, 0);
    renderProgress();
  }

  window.addEventListener('hashchange', route);

  /* ---------- 过关按钮：标记完成并跳下一关 ---------- */
  Array.prototype.forEach.call(document.querySelectorAll('[data-complete]'), function (button) {
    button.addEventListener('click', function () {
      var n = Number(button.getAttribute('data-complete'));
      if (n >= 1 && n <= 4) {
        progress['step' + n] = true;
        writeProgress();
      }
      location.hash = '#' + button.getAttribute('data-goto');
    });
  });

  /* 关卡卡片本身也可点进对应关 */
  Array.prototype.forEach.call(document.querySelectorAll('.quest-item'), function (item) {
    item.addEventListener('click', function () {
      location.hash = '#step-' + item.getAttribute('data-step');
    });
  });

  $('quest-reset')?.addEventListener('click', function () {
    STEPS.forEach(function (n) {
      progress['step' + n] = false;
    });
    writeProgress();
    renderProgress();
  });

  /* ---------- 高级模式开关 ---------- */
  function applyAdvanced(enabled) {
    var panel = $('advanced-panel');
    var toggle = $('advanced-toggle');
    if (panel) panel.hidden = !enabled;
    if (toggle) toggle.checked = enabled;
    document.body.classList.toggle('is-advanced', enabled);
    try {
      window.localStorage && window.localStorage.setItem(ADVANCED_KEY, enabled ? '1' : '0');
    } catch (error) {
      /* 忽略持久化失败 */
    }
  }

  $('advanced-toggle')?.addEventListener('change', function () {
    applyAdvanced(this.checked);
  });

  /* ---------- 主题切换（与主站共享同一个偏好键） ---------- */
  function syncThemeFace() {
    var button = $('theme-toggle');
    if (!button) return;
    var dark = document.documentElement.classList.contains('theme-dark');
    button.textContent = dark ? '☀' : '☾';
  }

  $('theme-toggle')?.addEventListener('click', function () {
    var dark = !document.documentElement.classList.contains('theme-dark');
    document.documentElement.classList.toggle('theme-dark', dark);
    try {
      window.localStorage && window.localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light');
    } catch (error) {
      /* 忽略持久化失败 */
    }
    syncThemeFace();
  });

  /* ---------- 第 2 关：训练曲线动画（示意） ---------- */
  var trainingTimer = 0;

  function smooth(t) {
    return t * t * (3 - 2 * t);
  }

  function formatClock(totalSeconds) {
    var minutes = Math.floor(totalSeconds / 60);
    var seconds = totalSeconds % 60;
    return minutes + ':' + (seconds < 10 ? '0' : '') + seconds;
  }

  function samplePath(t) {
    var x = t * 320;
    /* S 型学习曲线 + 收敛前的探索抖动 */
    var learn = 0.03 + smooth(t) * 0.82;
    var wobble = Math.sin(t * 34) * 3.5 * (1 - t) + Math.sin(t * 9) * 1.8;
    var y = 118 - Math.max(0.02, learn + wobble / 110) * 110;
    return x.toFixed(1) + ',' + y.toFixed(1);
  }

  function startTrainingAnimation() {
    window.cancelAnimationFrame(trainingTimer);
    var curve = $('train-curve');
    var rewardEl = $('train-reward');
    var episodeEl = $('train-episode');
    var timeEl = $('train-time');
    if (!curve || !rewardEl || !episodeEl || !timeEl) return;
    var started = performance.now();
    var DURATION = 6500;
    curve.setAttribute('points', '0,118');

    function frame(now) {
      var t = Math.min(1, (now - started) / DURATION);
      var count = Math.max(2, Math.round(t * 80));
      var points = [];
      for (var i = 0; i <= count; i++) {
        points.push(samplePath(i / 80));
      }
      curve.setAttribute('points', points.join(' '));
      rewardEl.textContent = String(12 + Math.round(smooth(t) * 175));
      episodeEl.textContent = String(Math.round(t * 1240));
      timeEl.textContent = formatClock(Math.round(t * 252));
      if (t < 1) trainingTimer = window.requestAnimationFrame(frame);
    }
    trainingTimer = window.requestAnimationFrame(frame);
  }

  $('train-replay')?.addEventListener('click', function () {
    startTrainingAnimation();
  });

  /* ---------- 启动 ---------- */
  try {
    var advPref = window.localStorage && window.localStorage.getItem(ADVANCED_KEY);
    applyAdvanced(advPref === '1');
  } catch (error) {
    applyAdvanced(false);
  }
  syncThemeFace();
  if (!location.hash) location.hash = '#home';
  route();
})();
