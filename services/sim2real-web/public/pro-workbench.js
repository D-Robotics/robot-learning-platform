/* 专业工作台方向的设计预览：引导层（上手清单、上下文条、命令面板）
   是易用性外壳，专业功能是主体。数据为示意，未接真实 API。
   CSP：脚本必须外链（script-src 'self'），所以逻辑在此文件。 */
(function () {
  'use strict';

  var ONBOARD_KEY = 'rdk-pw-onboarding-v1';
  var THEME_KEY = 'rdk-lab-theme';

  /* ---------- 状态 ---------- */
  // 上手清单：第 1 步预置完成（导入契约），模拟真实回访用户。
  var steps = [
    { id: 1, label: '导入模型契约', done: true },
    { id: 2, label: '在仿真中验证', done: false },
    { id: 3, label: '发起第一次训练', done: false },
    { id: 4, label: '查看评测对比', done: false },
    { id: 5, label: '部署到真机', done: false },
  ];
  var view = 'overview';
  var recording = false;
  var recTimer = 0;
  var recTick = null;
  var trainDone = false;
  var trainTimer = null;

  function $(id) {
    return document.getElementById(id);
  }

  /* ---------- 上手清单持久化 ---------- */
  function persistSteps() {
    try {
      window.localStorage &&
        window.localStorage.setItem(
          ONBOARD_KEY,
          JSON.stringify(steps.map(function (s) { return s.done ? 1 : 0; })),
        );
    } catch (error) {
      /* 预览页：持久化失败不致命 */
    }
  }

  function restoreSteps() {
    try {
      var raw = window.localStorage && window.localStorage.getItem(ONBOARD_KEY);
      if (!raw) return;
      var parsed = JSON.parse(raw);
      steps.forEach(function (s, i) {
        s.done = Boolean(parsed[i]);
      });
    } catch (error) {
      /* 忽略损坏的本地数据 */
    }
  }

  function doneCount() {
    return steps.filter(function (s) { return s.done; }).length;
  }

  function completeStep(id) {
    var step = steps.find(function (s) { return s.id === id; });
    if (!step || step.done) return;
    step.done = true;
    persistSteps();
    renderOnboarding();
  }

  /* ---------- 渲染：清单 + 闭环管线 + 下一步卡 ---------- */
  function renderOnboarding() {
    var done = doneCount();
    var fill = $('onboard-fill');
    if (fill) fill.style.width = (done / steps.length) * 100 + '%';
    var count = $('onboard-count');
    if (count) count.textContent = done + '/' + steps.length;

    var currentIdx = done; // 第一个未完成项即当前项
    Array.prototype.forEach.call(document.querySelectorAll('.pw-oitem'), function (item) {
      var id = Number(item.getAttribute('data-step'));
      var isDone = steps[id - 1].done;
      item.classList.toggle('is-done', isDone);
      item.classList.toggle('is-current', !isDone && id === currentIdx + 1);
      var meta = item.querySelector('.pw-oitem-meta');
      if (!meta) return;
      if (isDone) {
        meta.innerHTML = '<span class="pw-oitem-done-label">已完成</span>';
      } else if (id <= 3) {
        var label = id === 2 ? '打开仿真 →' : '去发起 →';
        var btn = document.createElement('button');
        btn.className = 'pw-btn' + (id === currentIdx + 1 ? ' is-small' : ' is-ghost is-small');
        btn.type = 'button';
        btn.setAttribute('data-goto-step', String(id));
        btn.textContent = label;
        meta.innerHTML = '';
        meta.appendChild(btn);
      } else {
        meta.innerHTML = '<span class="pw-badge is-warn">需登录</span>';
      }
    });

    // 顶栏闭环管线：阶段 i 完成 ⇔ 清单第 i 步完成
    Array.prototype.forEach.call(document.querySelectorAll('.pw-stage'), function (stage) {
      var i = Number(stage.getAttribute('data-stage'));
      stage.classList.toggle('is-done', steps[i - 1].done);
      stage.classList.toggle('is-active', !steps[i - 1].done && i === currentIdx + 1);
    });

    // 下一步卡与清单联动
    var titles = {
      2: '在仿真中验证「行走」策略',
      3: '用 starter 模板发起第一次训练',
      4: '对比仿真与真机，量化差距',
      5: '把策略部署到 RDK 板卡',
    };
    var copies = {
      2: '契约已通过校验。打开仿真录 30 秒轨迹，平台会自动生成可回放证据，供后续对比使用。',
      3: '仿真证据就绪。从模板提交 PPO 任务，跟踪奖励曲线直到收敛（示意约 2 小时）。',
      4: '训练收敛后，同一策略在仿真与真机各回放一轮，差距即 Sim2Real 待收敛量。',
      5: '预检通过后一键部署；版本、回滚、审计全程留痕。',
    };
    var next = steps.find(function (s) { return !s.done; });
    var titleEl = $('next-title');
    var copyEl = $('next-copy');
    if (titleEl && next && titles[next.id]) titleEl.textContent = titles[next.id];
    if (copyEl && next && copies[next.id]) copyEl.textContent = copies[next.id];
    if (titleEl && !next) titleEl.textContent = '第一个闭环已走完 🎉';
    if (copyEl && !next) copyEl.textContent = '五步全部完成。登录后解锁完整工作台：评测对比、真机部署、审计链。';
  }

  /* ---------- 视图切换 ---------- */
  var VIEWS = ['overview', 'sim', 'train'];

  function gotoView(next) {
    if (VIEWS.indexOf(next) < 0) return;
    view = next;
    Array.prototype.forEach.call(document.querySelectorAll('.pw-view'), function (el) {
      el.hidden = el.getAttribute('data-view') !== next;
    });
    Array.prototype.forEach.call(document.querySelectorAll('.pw-nav-item'), function (item) {
      var target = item.getAttribute('data-nav');
      item.classList.toggle('is-active', target === next);
    });
    window.scrollTo(0, 0);
  }

  /* ---------- Toast ---------- */
  var toastTimer = null;

  function showToast(message) {
    var toast = $('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      toast.hidden = true;
    }, 2600);
  }

  function initFailureCases() {
    var status = document.getElementById('failure-cases-status');
    var list = document.getElementById('failure-cases-list');
    var reload = document.getElementById('failure-cases-reload');
    var fork = document.getElementById('failure-cases-fork');
    if (!status || !list || !reload || !fork) return;
    var load = function () {
      status.textContent = '正在加载…'; list.textContent = ''; fork.disabled = true; reload.disabled = true;
      fetch('/api/v1/duck/task-packs/goal-navigation-clear-arena/failure-cases', { headers: { Accept: 'application/json' } })
        .then(function (r) { if (!r.ok) throw new Error('案例库暂时不可用'); return r.json(); })
        .then(function (data) {
          var cases = Array.isArray(data.cases) ? data.cases : [];
          status.textContent = cases.length ? ('共 ' + cases.length + ' 个可复现案例 · 已绑定目标点导航') : '暂无失败案例';
          cases.forEach(function (item) {
            var row = document.createElement('div'); row.className = 'pw-card-sub';
            row.style.cssText = 'padding:8px 0;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:12px';
            var title = document.createElement('span'); title.textContent = item.title || item.id;
            var type = document.createElement('span'); type.textContent = item.failureType || 'unknown'; type.style.color = 'var(--accent-text)';
            row.appendChild(title); row.appendChild(type); list.appendChild(row);
          });
          fork.disabled = false;
        })
        .catch(function (e) { status.textContent = e.message + '，可稍后重试'; })
        .finally(function () { reload.disabled = false; });
    };
    reload.addEventListener('click', load);
    fork.addEventListener('click', function () {
      fork.disabled = true; fork.textContent = '已创建 Fork · 准备训练…';
      showToast('任务包已 Fork：已带入 baseline、失败案例和评测信封。');
      setTimeout(function () { fork.disabled = false; fork.textContent = '继续训练这个 Fork'; }, 1200);
    });
    load();
  }
  initFailureCases();

  /* ---------- 录制（仿真页专业反馈） ---------- */
  function formatRec(sec) {
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function setRecording(on) {
    recording = on;
    var button = $('rec-button');
    if (!button) return;
    if (on) {
      button.classList.add('is-rec');
      button.textContent = '⏹ 停止录制 (' + formatRec(recTimer) + ')';
      recTick = window.setInterval(function () {
        recTimer += 1;
        button.textContent = '⏹ 停止录制 (' + formatRec(recTimer) + ')';
      }, 1000);
    } else {
      window.clearInterval(recTick);
      button.classList.remove('is-rec');
      button.classList.remove('pw-btn');
      button.classList.add('pw-btn');
      button.textContent = '⏺ 开始录制';
    }
  }

  function stopRecordingAndSave() {
    setRecording(false);
    var line = $('evidence-line');
    if (recTimer < 2) {
      if (line) {
        line.classList.remove('is-saved');
        replaceChildrenWithText(line, '录制太短（' + recTimer + 's），未生成证据 · 至少录 2 秒');
      }
      recTimer = 0;
      return;
    }
    // 专业反馈：给出可核对的轨迹编号与规模
    var frames = recTimer * 40;
    var id = 'tr-0' + String(180 + Math.floor(Math.random() * 20));
    if (line) {
      line.classList.add('is-saved');
      // textContent-built DOM instead of innerHTML: the trail id and counts
      // stay plain text nodes, so no string here can become markup.
      line.replaceChildren(
        document.createTextNode('已生成轨迹 '),
        (function () {
          var mono = document.createElement('b');
          mono.className = 'pw-mono';
          mono.textContent = id;
          return mono;
        })(),
        document.createTextNode(' · ' + recTimer + 's · ' + frames + ' 帧 → 已同步到评测证据（登录后持久保存）'),
      );
    }
    recTimer = 0;
    completeStep(2);
    showToast('第 2 步完成：仿真证据已生成，可继续发起训练。');
  }

  function replaceChildrenWithText(node, text) {
    node.replaceChildren(document.createTextNode(text));
  }

  /* ---------- 训练任务（提交 → 进度 → 完成） ---------- */
  function submitTraining() {
    if (trainDone) return;
    var empty = $('train-empty');
    var run = $('train-run');
    if (!empty || !run) return;
    empty.hidden = true;
    run.hidden = false;
    $('run-id').textContent = 'run-0042';
    $('run-desc').textContent = '行走 · baseline · Starter PPO 模板';
    $('run-status').className = 'pw-badge is-run';
    $('run-status').textContent = '运行中';
    $('run-reward').textContent = '—';
    $('run-episode').textContent = '0';
    $('run-eta').textContent = '1h 58m';
    var bar = $('run-bar');
    bar.classList.remove('is-done');
    bar.querySelector('i').style.width = '0%';

    // 概览任务表：插入进行中行（专业工具的跨页一致性）
    var body = $('runs-body');
    if (body) {
      var tr = document.createElement('tr');
      tr.id = 'run-row-live';
      tr.innerHTML =
        '<td class="pw-mono">run-0042</td><td>行走 · baseline</td><td>本地 GPU</td>' +
        '<td><span class="pw-badge is-run">运行中</span></td>' +
        '<td class="is-num" id="run-row-reward">—</td><td class="is-num">—</td>';
      body.insertBefore(tr, body.firstChild);
    }

    var started = performance.now();
    var DURATION = 6000; // 6 秒演绎约 2 小时的训练
    window.clearInterval(trainTimer);
    trainTimer = window.setInterval(function () {
      var t = Math.min(1, (performance.now() - started) / DURATION);
      var eased = t * t * (3 - 2 * t);
      bar.querySelector('i').style.width = (eased * 100).toFixed(1) + '%';
      $('run-episode').textContent = String(Math.round(eased * 1240));
      $('run-reward').textContent = t < 1 ? (12 + eased * 175).toFixed(1) : '187.2';
      if (t >= 1) {
        window.clearInterval(trainTimer);
        trainDone = true;
        $('run-status').className = 'pw-badge is-ok';
        $('run-status').textContent = '已完成';
        $('run-eta').textContent = '2h 00m';
        $('run-bar').classList.add('is-done');
        var row = $('run-row-live');
        if (row) {
          row.innerHTML =
            '<td class="pw-mono">run-0042</td><td>行走 · baseline</td><td>本地 GPU</td>' +
            '<td><span class="pw-badge is-ok">已完成</span></td>' +
            '<td class="is-num">187.2</td><td class="is-num">2h 00m</td>';
          row.removeAttribute('id');
        }
        completeStep(3);
        showToast('第 3 步完成：训练收敛，奖励 187.2。');
      }
    }, 120);
  }

  /* ---------- 命令面板 ---------- */
  var commands = [
    { key: 'overview', label: '前往：概览', hint: '⌘1', run: function () { gotoView('overview'); } },
    { key: 'sim', label: '前往：仿真与录制', hint: '⌘2', run: function () { gotoView('sim'); } },
    { key: 'train', label: '前往：训练任务', hint: '⌘3', run: function () { gotoView('train'); } },
    {
      key: 'record',
      label: '仿真：开始 / 停止录制',
      hint: 'R',
      run: function () {
        gotoView('sim');
        window.setTimeout(function () { toggleRecord(); }, 250);
      },
    },
    {
      key: 'submit-train',
      label: '训练：用 Starter 模板提交任务',
      run: function () {
        gotoView('train');
        window.setTimeout(submitTraining, 250);
      },
    },
    { key: 'device', label: '设备：连接 RDK 板卡', run: function () { showToast('设备管理在完整工作台内（预览未包含）。'); } },
    { key: 'deploy', label: '部署：发布到真机', run: function () { showToast('部署发布在完整工作台内（预览未包含）。'); } },
    { key: 'contract', label: '模型：导入契约 manifest', run: function () { showToast('契约导入在完整工作台内（预览未包含）。'); } },
    { key: 'theme', label: '外观：切换深浅主题', run: function () { toggleTheme(); } },
    {
      key: 'reset',
      label: '预览：重置上手进度',
      run: function () {
        steps.forEach(function (s) { s.done = s.id === 1; });
        persistSteps();
        renderOnboarding();
        resetTrainView();
        showToast('已重置：回到第 2 步。');
      },
    },
  ];
  var cmdkOpen = false;
  var cmdkSel = 0;
  var cmdkFiltered = commands.slice();

  function renderCmdkList() {
    var list = $('cmdk-list');
    if (!list) return;
    list.innerHTML = '';
    if (!cmdkFiltered.length) {
      var empty = document.createElement('li');
      empty.className = 'pw-cmdk-empty';
      empty.textContent = '没有匹配的命令';
      list.appendChild(empty);
      return;
    }
    cmdkFiltered.forEach(function (cmd, i) {
      var li = document.createElement('li');
      li.className = 'pw-cmdk-item' + (i === cmdkSel ? ' is-sel' : '');
      var label = document.createElement('span');
      label.textContent = cmd.label;
      li.appendChild(label);
      if (cmd.hint) {
        var hint = document.createElement('span');
        hint.className = 'pw-cmdk-hint';
        hint.textContent = cmd.hint;
        li.appendChild(hint);
      }
      li.addEventListener('click', function () {
        execCommand(i);
      });
      list.appendChild(li);
    });
  }

  function filterCmdk(query) {
    var q = String(query || '').trim().toLowerCase();
    cmdkFiltered = commands.filter(function (cmd) {
      return !q || cmd.label.toLowerCase().indexOf(q) >= 0 || cmd.key.indexOf(q) >= 0;
    });
    cmdkSel = 0;
    renderCmdkList();
  }

  function openCmdk() {
    cmdkOpen = true;
    $('cmdk-back').hidden = false;
    filterCmdk('');
    var input = $('cmdk-input');
    if (input) {
      input.value = '';
      input.focus();
    }
  }

  function closeCmdk() {
    cmdkOpen = false;
    $('cmdk-back').hidden = true;
  }

  function execCommand(i) {
    var cmd = cmdkFiltered[i];
    if (!cmd) return;
    closeCmdk();
    cmd.run();
  }

  /* ---------- 主题 ---------- */
  function toggleTheme() {
    var dark = !document.documentElement.classList.contains('theme-dark');
    document.documentElement.classList.toggle('theme-dark', dark);
    try {
      window.localStorage && window.localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light');
    } catch (error) {
      /* 忽略持久化失败 */
    }
    var button = $('theme-toggle');
    if (button) button.textContent = dark ? '☀' : '☾';
  }

  function toggleRecord() {
    if (recording) stopRecordingAndSave();
    else setRecording(true);
  }

  function resetTrainView() {
    window.clearInterval(trainTimer);
    trainDone = false;
    var empty = $('train-empty');
    var run = $('train-run');
    if (empty) empty.hidden = false;
    if (run) run.hidden = true;
    var row = $('run-row-live');
    if (row) row.remove();
  }

  /* ---------- 事件绑定（CSP：全部 addEventListener） ---------- */
  function wire() {
    // 侧栏导航
    Array.prototype.forEach.call(document.querySelectorAll('.pw-nav-item'), function (item) {
      item.addEventListener('click', function () {
        var target = item.getAttribute('data-nav');
        if (target === 'soon') {
          showToast('「' + item.textContent.trim().replace(/[⌘\d]/g, '') + '」在完整工作台内，此预览聚焦引导前半段。');
          return;
        }
        gotoView(target);
      });
    });

    // 上手清单跳转 / 下一步按钮（事件委托：清单会重渲染）
    document.addEventListener('click', function (event) {
      var gotoBtn = event.target.closest ? event.target.closest('[data-goto-step]') : null;
      if (gotoBtn) {
        var id = Number(gotoBtn.getAttribute('data-goto-step'));
        gotoView(id === 2 ? 'sim' : 'train');
        return;
      }
      var paletteBtn = event.target.closest ? event.target.closest('[data-cmd="palette"]') : null;
      if (paletteBtn) {
        openCmdk();
        return;
      }
      var soonBtn = event.target.closest ? event.target.closest('[data-cmd="soon"]') : null;
      if (soonBtn) {
        showToast('该功能在完整工作台内（预览未包含）。');
        return;
      }
      var advBtn = event.target.closest ? event.target.closest('[data-adv-toggle]') : null;
      if (advBtn) {
        advBtn.closest('.pw-adv').classList.toggle('is-open');
        return;
      }
    });

    // 仿真页
    $('rec-button')?.addEventListener('click', toggleRecord);
    var advToggle = $('adv-toggle');
    advToggle?.addEventListener('click', function () {
      $('adv-drawer').classList.toggle('is-open');
    });
    var fric = $('fric-range');
    fric?.addEventListener('input', function () {
      $('fric-out').textContent = '±' + fric.value + '%';
    });
    var mass = $('mass-range');
    mass?.addEventListener('input', function () {
      $('mass-out').textContent = '±' + mass.value + '%';
    });

    // 训练页
    $('train-submit')?.addEventListener('click', submitTraining);
    Array.prototype.forEach.call(document.querySelectorAll('.pw-tpl'), function (tpl) {
      tpl.addEventListener('click', function () {
        Array.prototype.forEach.call(document.querySelectorAll('.pw-tpl'), function (t) {
          t.classList.toggle('is-picked', t === tpl);
        });
        var isBaseline = tpl.getAttribute('data-tpl') === 'baseline';
        $('run-desc').textContent = isBaseline
          ? '行走 · baseline · Starter PPO 模板'
          : '行走 · robust-v3 · 域随机化模板';
        showToast('模板已选择：' + (isBaseline ? 'baseline（约 2h）' : 'robust-v3（约 3.5h）'));
      });
    });

    // 命令面板
    // ⌘K 按钮是 toggle：再点一次即关闭，与快捷键行为一致。
    $('cmdk-open')?.addEventListener('click', function () {
      if (cmdkOpen) closeCmdk();
      else openCmdk();
    });
    $('cmdk-close')?.addEventListener('click', closeCmdk);
    $('cmdk-back')?.addEventListener('click', function (event) {
      if (event.target === $('cmdk-back')) closeCmdk();
    });
    var input = $('cmdk-input');
    input?.addEventListener('input', function () {
      filterCmdk(input.value);
    });
    input?.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        cmdkSel = Math.min(cmdkFiltered.length - 1, cmdkSel + 1);
        renderCmdkList();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        cmdkSel = Math.max(0, cmdkSel - 1);
        renderCmdkList();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        execCommand(cmdkSel);
      } else if (event.key === 'Escape') {
        closeCmdk();
      }
    });

    // 主题
    $('theme-toggle')?.addEventListener('click', toggleTheme);
    var dark = document.documentElement.classList.contains('theme-dark');
    var themeBtn = $('theme-toggle');
    if (themeBtn) themeBtn.textContent = dark ? '☀' : '☾';

    // 全局快捷键：⌘K / ⌘1-3 / R
    document.addEventListener('keydown', function (event) {
      var meta = event.metaKey || event.ctrlKey;
      if (meta && (event.key === 'k' || event.key === 'K')) {
        event.preventDefault();
        if (cmdkOpen) closeCmdk();
        else openCmdk();
        return;
      }
      if (cmdkOpen && event.key === 'Escape') {
        closeCmdk();
        return;
      }
      if (meta && ['1', '2', '3'].indexOf(event.key) >= 0) {
        event.preventDefault();
        gotoView(VIEWS[Number(event.key) - 1]);
        return;
      }
      if (!meta && (event.key === 'r' || event.key === 'R') && !isTyping(event.target)) {
        if (view === 'sim') {
          event.preventDefault();
          toggleRecord();
        }
      }
    });
  }

  function isTyping(target) {
    if (!target) return false;
    var tag = String(target.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select';
  }

  /* ---------- 启动 ---------- */
  restoreSteps();
  wire();
  renderOnboarding();
  gotoView('overview');
})();
