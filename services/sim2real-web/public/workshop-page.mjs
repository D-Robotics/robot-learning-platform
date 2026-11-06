const WORKSHOP_ENGINE = 'originman-recovery-reflect';

/** Button-driven orchestration. The normal authenticated /runs API owns every submission. */
export async function startWorkshop({
  document,
  location,
  fetchImpl = fetch,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  historyImpl = globalThis.history,
  ResizeObserverImpl = globalThis.ResizeObserver,
} = {}) {
  const $ = (id) => document.getElementById(id);
  const referenceVideo = $('reference-video');
  const referencePlayButton = $('play-reference');
  const root = new URL('./', location.href),
    api = new URL('api/v1/duck/', root);
  const entryUrl = new URL(location.href);
  const entryContextId = entryUrl.searchParams.get('context');
  const entryPreview = entryUrl.searchParams.get('start') === '1' && !entryContextId;
  const entryRounds = entryUrl.searchParams.get('with')?.split(',') ?? [];
  let contextId = entryContextId,
    session = null,
    timer = null,
    busy = false,
    selecting = false,
    disposed = false,
    halted = false,
    reference = null,
    referenceExpanded = false,
    executionExpanded = false,
    pendingRecipe = null,
    failureMessage = '',
    frameObserver = null,
    primaryAction = null,
    comparisonRequest = 0,
    comparisonLoaded = null,
    loginNeeded = false,
    reconnectNeeded = false,
    setupAccount,
    setupReady = false,
    unverifiedCompute = null,
    failureLogsUnavailable = false,
    budgetReadiness = '',
    previewObserved = false;
  const validId = (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(v);
  const listeners = [];
  const listen = (id, type, fn) => {
    const node = $(id);
    node.addEventListener(type, fn);
    listeners.push(() => node.removeEventListener(type, fn));
  };
  const json = async (path, body) => {
    let r;
    try {
      r = await fetchImpl(new URL(path, api), {
        credentials: 'same-origin',
        cache: 'no-store',
        ...(body === undefined
          ? {}
          : {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }),
      });
    } catch {
      throw Object.assign(Error('与学习平台的连接中断。恢复网络后会核对原实验。'), { offline: true });
    }
    if (r.status === 401)
      throw Object.assign(Error(entryPreview && !contextId
        ? '登录学习平台后，回到这里选算力机。'
        : '登录学习平台后，回到这里继续原实验。'), { status: 401 });
    let value;
    try {
      value = await r.json();
    } catch {
      throw Object.assign(Error('课程响应暂不可用，请保留原实验稍后刷新。'), { status: r.status });
    }
    if (!r.ok || value.ok !== true)
      throw Object.assign(Error(value.message ?? '课程读取失败，请保留原实验稍后恢复。'), {
        status: r.status, code: value.code ?? value.error,
      });
    return value;
  };
  const error = (e) => {
    halted = true;
    clearTimer(timer);
    loginNeeded = e.status === 401;
    reconnectNeeded = e.offline === true;
    $('workshop-error-message').textContent = e.message ?? '课程暂不可用。';
    $('workshop-error').hidden = false;
    const login = $('workshop-login');
    login.hidden = !loginNeeded;
    const destination = new URL('login', root);
    if (entryPreview && !contextId) destination.searchParams.set('workshop', 'start');
    else if (/^ws-[a-f0-9]{20}$/.test(contextId ?? ''))
      destination.searchParams.set('workshop', contextId);
    login.href = destination.href;
    $('workshop-retry').textContent = entryPreview && !contextId
      ? loginNeeded ? '已登录，继续选算力' : '重试读取算力机'
      : loginNeeded ? '登录后接续原实验' : '重试读取本轮';
    $('connection-status').textContent = '需要处理';
    show();
  };
  const run = (fn) => {
    void fn().catch(error);
  };
  const schedule = () => {
    clearTimer(timer);
    if (
      !disposed &&
      !halted &&
      session &&
      (['training', 'evaluating', 'unknown'].includes(session.stage) ||
        (session.stage === 'ready-evaluate' && session.autoContinue))
    )
      timer = setTimer(() => run(refresh), 4000);
  };
  const recipeFields = [
    ['timesteps', '训练步数', 'custom-timesteps'],
    ['seed', '随机种子', 'custom-seed'],
    ['pushMaxForce', '侧推上限', 'custom-push'],
  ];
  const formatNumber = (n) => n.toLocaleString('zh-CN');
  const roundDifference = (current, previous) => current.recovered - previous.recovered;
  const comparisonStatus = (message) => { $('round-comparison-status').textContent = message; };
  const renderRounds = (comparison) => {
    const table = $('round-comparison-table');
    const summary = $('round-comparison-summary');
    summary.hidden = true;
    const body = $('round-comparison-rows');
    body.replaceChildren();
    const { rounds, comparable, sameTrainingSetup } = comparison;
    const evidenceNote = rounds.every((round) => round.evidence === 'fixture') ? '测试数据。' : '';
    table.hidden = rounds.length < 2;
    if (table.hidden) {
      comparisonStatus('本轮还没有对照实验。可选择历史轮次，或点「改一个参数再试」。');
      return;
    }
    let multipleChanges = false;
    let unchanged = false;
    for (const [index, round] of rounds.entries()) {
      const previous = rounds[index - 1];
      const changes = previous ? recipeFields.filter(([key]) => previous.recipe[key] !== round.recipe[key]) : [];
      if (previous && changes.length > 1) multipleChanges = true;
      if (previous && !changes.length) unchanged = true;
      const row = document.createElement('tr');
      const title = document.createElement('th');
      title.scope = 'row';
      const link = document.createElement('a');
      link.href = new URL('workshop.html?context=' + encodeURIComponent(round.contextId), root).href;
      link.textContent = '第 ' + (index + 1) + ' 轮' + (round.contextId === contextId ? ' · 本轮' : '');
      title.append(link);
      row.append(title);
      const { timesteps, seed, pushMaxForce } = round.recipe;
      const steps = formatNumber(timesteps) + (round.actualTimesteps != null && round.actualTimesteps !== timesteps
        ? '（实跑 ' + formatNumber(round.actualTimesteps) + '）' : '');
      const changeLabel = previous ? changes.map(([key, label]) =>
        label + ' ' + formatNumber(previous.recipe[key]) + ' → ' + formatNumber(round.recipe[key])).join('；') || '参数相同' : '对照起点';
      const counts = round.suites.map((suite, i) => {
        const count = suite.recovered + '/' + suite.total;
        if (!previous || !comparable) return count;
        const difference = roundDifference(suite, previous.suites[i]);
        return count + (difference === 0 ? '（持平）' : '（' + (difference > 0 ? '+' : '−') + Math.abs(difference) + '）');
      });
      const verdict = round.clearGain === true ? '通过' : round.clearGain === false ? '未通过' : '待核对';
      for (const value of [steps + ' / ' + seed + ' / ' + pushMaxForce + ' N', changeLabel, ...counts, verdict]) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(cell);
      }
      body.append(row);
    }
    if (comparable) {
      const latest = rounds.at(-1);
      const previous = rounds.at(-2);
      const subject = latest.contextId === contextId ? '本轮' : '最后一轮';
      summary.textContent = subject + '比上一轮：' + latest.suites.map((suite, i) => {
        const difference = roundDifference(suite, previous.suites[i]);
        const label = i === 0 ? '公开组' : '补充组';
        return label + ' ' + (difference === 0 ? '持平' : (difference > 0 ? '多' : '少') + '恢复 ' + Math.abs(difference) + ' 次');
      }).join('，') + '。';
      summary.hidden = false;
    }
    const [historical, additional] = rounds[0].suites;
    const baselines = '原 PD：' + historical.original + '/' + historical.total + '、' + additional.original + '/' + additional.total +
      '；调参反馈：' + historical.tuned + '/' + historical.total + '、' + additional.tuned + '/' + additional.total + '。';
    comparisonStatus(evidenceNote + (!comparable ? '所选轮次的评测协议、基线或证据类型不同，仅列各轮原始成绩。'
      : baselines + (!sameTrainingSetup || multipleChanges ? '有多项参数或训练设置同时变化，差值不能归给单一参数。'
        : unchanged ? '参数相同的相邻轮次可用于复核复现。'
          : '每行括号内为相对上一轮的恢复次数变化。此对比只代表所列仿真与种子。')));
  };
  const loadRounds = async (ids = []) => {
    const activeId = contextId;
    const request = ++comparisonRequest;
    $('round-comparison-table').hidden = true;
    $('round-comparison-summary').hidden = true;
    comparisonStatus('正在核对各轮的训练、权重与评测条件。');
    try {
      const suffix = ids.length ? '?with=' + encodeURIComponent(ids.join(',')) : '';
      const { comparison } = await json('workshop-sessions/' + encodeURIComponent(activeId) + '/comparison' + suffix);
      if (!disposed && contextId === activeId && request === comparisonRequest) renderRounds(comparison);
    } catch (e) {
      if (!disposed && contextId === activeId && request === comparisonRequest)
        comparisonStatus(e.message ?? '暂时无法对比所选实验。');
    }
  };
  const show = () => {
    const ready = session?.stage === 'ready';
    if (ready && ['observed', 'skipped'].includes(session.reference)) reference = session.reference;
    const preview = entryPreview && !contextId;
    $('reference-section').hidden = !preview && (!session || (!(ready && !reference) && !referenceExpanded));
    $('reference-instructions').textContent = preview
      ? '先看看机器人被推后如何站稳。也可以直接点「开始实操」。'
      : '先看看机器人被推了一下后，怎样重新站稳。播完会自动进入下一步。';
    $('workshop-setup').hidden = !preview || !setupReady || halted;
    $('workshop-compute').disabled = busy || selecting;
    $('workshop-setup-confirm').disabled = busy || selecting || !$('workshop-compute').value;
    $('skip-reference').hidden = !ready || Boolean(reference);
    $('skip-reference').disabled = busy || selecting;
    if (referencePlayButton) referencePlayButton.disabled = busy || selecting;
    $('budget-readiness').textContent = budgetReadiness;
    $('budget-readiness').hidden = !budgetReadiness;
    $('budget-section').hidden = !ready || !reference;
    $('execution-section').hidden = !session || ready || (session.stage === 'results' && !executionExpanded);
    $('result-section').hidden = !session?.training;
    $('round-comparison').hidden = session?.stage !== 'results' || Boolean(session.legacy);
    const linkedRounds = contextId === entryContextId && entryRounds.length <= 2 &&
      entryRounds.every(validId) ? entryRounds : [];
    if (session?.stage === 'results' && (session.comparisonBase || linkedRounds.length) && comparisonLoaded !== contextId) {
      comparisonLoaded = contextId;
      $('round-comparison').open = true;
      void loadRounds(linkedRounds);
    }
    $('compare-parameters').hidden = session?.stage !== 'results' || !session.recipe;
    $('compare-parameters').disabled = busy || selecting;
    $('result-guide').textContent = session?.stage === 'results'
      ? '先看两组各恢复了几次。原 PD 是未叠加学习修正的基线；回放只展示其中一个条件。'
      : '训练曲线随任务更新。等评测完成，再看同条件下的恢复次数。';
    $('new-experiment').disabled = !session || busy || selecting;
    $('history-toggle').disabled = busy || selecting;
    for (const button of $('history-list').querySelectorAll('button'))
      button.disabled = busy || selecting;
    $('new-experiment').title = '保留原实验和已提交任务，创建独立新实验；不会取消或重交原任务。';
    $('pause-workshop').disabled =
      busy || selecting || !session?.autoContinue || ['results', 'blocked'].includes(session.stage);
    $('recover-workshop-request').hidden = session?.stage !== 'unknown' || !session.recoveryPhase;
    $('recover-workshop-request').disabled = busy || selecting;
    $('continue-evaluation').hidden =
      session?.stage !== 'ready-evaluate' || session.autoContinue || session.legacy;
    const step = !session ? -1 : ready ? (reference ? 1 : 0) : session.stage === 'results' ? 3 : 2;
    for (const [i, name] of ['reference', 'budget', 'execution', 'result'].entries()) {
      const b = $('workshop-step-' + name);
      b.disabled = busy || selecting || !session ||
        (i === 1 ? !ready : i > 1 ? !session.training : false);
      b.dataset.state = i < step ? 'done' : i === step ? 'current' : 'waiting';
      if (session && i === step) b.setAttribute('aria-current', 'step');
      else b.removeAttribute('aria-current');
    }
    $('go-results').disabled = !session?.training;
    $('go-results').textContent = session?.stage === 'results' ? '查看对比与回放 ↓'
      : session?.stage === 'blocked' && session.training?.status === 'completed' ? '查看保留的训练结果 ↓'
        : '查看实时曲线 ↓';
    $('active-recipe').textContent = session?.recipe
      ? `${session.recipe.timesteps.toLocaleString('zh-CN')} 步 · 随机种子 ${session.recipe.seed} · 侧推 ${session.recipe.pushMaxForce} N`
      : '';
    $('execution-status').textContent =
      session?.stage === 'unknown'
        ? session.recoveryPhase
          ? '提交状态待核对。可接续原请求，沿用原预算和参数。'
          : '提交状态待核对。可刷新恢复原任务。'
        : halted
          ? '连接或提交需要处理，已暂停自动推进；请刷新原实验。'
          : session?.stage === 'results'
            ? '训练与评测已完成。效果和回放请在下方查看。'
            : session?.stage === 'blocked'
              ? failureMessage || (session.training?.status === 'completed'
                ? '评测没有完成，本次训练结果仍可查看。'
                : '训练没有完成。可查看原运行，或另开实验重新选择算力。')
              : session?.stage === 'ready-evaluate'
                ? session.legacy
                  ? '已有训练完成；此旧版实验仅查看，可在聊天明确要求同源评测。'
                  : session.autoContinue
                    ? '训练完成，准备评测同一策略。'
                    : '训练完成，后续自动步骤已暂停。'
                : session?.stage === 'evaluating'
                  ? '正在评测同一策略。'
                  : ['queued', 'pending'].includes(session?.training?.status)
                    ? '训练已提交，等待算力开始。'
                    : '训练进行中，页面会自动更新。';
    const phase = session?.stage;
    const terminalRun = [session?.evaluation, session?.training].find(
      (run) => run && ['failed', 'blocked', 'canceled', 'cancelled'].includes(run.status),
    );
    $('workshop-recovery').hidden = phase !== 'blocked' && phase !== 'unknown';
    $('workshop-execution-more').hidden = phase === 'blocked';
    $('refresh-workshop').hidden = phase === 'unknown';
    $('workshop-recovery-status').textContent = phase === 'unknown'
      ? '先刷新核对原任务。若仍显示待核对，可点「接续原请求」，沿用原提交记录。'
      : terminalRun
        ? `原运行 ${terminalRun.runId} 已保留。${failureLogsUnavailable ? '暂时读不到该运行的引擎日志。' : ''}`
        : '';
    $('workshop-recovery-records').hidden = phase === 'unknown';
    $('workshop-recovery-new').hidden = phase !== 'blocked' || session?.training?.status === 'completed';
    $('refresh-original-workshop').disabled = busy || selecting;
    let guide;
    if (selecting) {
      guide = ['正在切换实验', '正在读取所选实验的进度。'];
    } else if (preview && !halted) {
      guide = setupReady
        ? $('workshop-setup-form').hidden
          ? ['选择本轮算力机', '当前没有可选算力机。', '刷新算力列表', 'start-setup']
          : ['选择本轮算力机', '检查课程环境后进入预算页。']
        : ['先看看，再动手', '用仿真训练一个受扰恢复策略，比较恢复次数并看回放。', '开始实操', 'start-setup'];
    } else if (halted) {
      guide = loginNeeded && preview
        ? ['登录后选算力机', '登录后会直接进入选算力页。', '登录学习平台', 'workshop-login']
        : loginNeeded
        ? ['先登录学习平台', '请使用原实验所在的学习平台账号。', '去登录', 'workshop-login']
        : reconnectNeeded
          ? ['连接暂时中断', '网络恢复后会核对原实验，无需重新开始。', '查看恢复方式', 'workshop-error']
          : ['当前步骤需要处理', '原实验和已经提交的任务会保留，可先重试读取状态。', '查看原因', 'workshop-error'];
    } else if (!session) {
      guide = ['选择课程实验', '有实验就从列表接着做。第一次可以在聊天说“带我开始 Workshop”。', '查看实验列表', 'history'];
    } else if (ready) {
      if (reference && !$('comparison-recipe-help').hidden) {
        guide = ['修改上一轮配方', '可以直接选步数加倍，或只改一项自定义参数。确认后才会开训。', '选择要改的参数', 'budget-section'];
      } else {
        guide = reference
          ? ['选择这轮怎么训练', '第一次可以选快速体验。开始后会用同一策略自动评测。', '选择训练预算', 'budget-section']
          : ['先看看机器人怎样恢复站稳', '播放一段讲师参考，或跳过后直接选训练预算。', '看参考或跳过', 'reference-section'];
      }
    } else if (phase === 'results') {
      guide = ['训练和评测已完成', '先看恢复成功次数，再看回放。想找原因，可以只改一项参数再试。', '查看本轮结果', 'result-section'];
    } else if (phase === 'blocked' || phase === 'unknown' || phase === 'ready-evaluate') {
      guide = [
        phase === 'blocked' ? '实验暂时停在这里' : phase === 'unknown' ? '正在核对原提交' : '本轮训练已完成',
        $('execution-status').textContent,
        phase === 'ready-evaluate' ? '查看评测安排' : '查看处理方式',
        'execution-section',
      ];
    } else {
      guide = [
        phase === 'evaluating' ? '正在评测本轮策略' : ['queued', 'pending'].includes(session.training?.status) ? '训练正在排队' : '正在训练本轮策略',
        phase === 'evaluating' ? '结果出来后，可以比较三种策略的恢复次数。' : '可看实时曲线。训练完成后，页面会按当前设置继续评测。',
        '查看本轮进度', 'execution-section',
      ];
    }
    const [title, description, label, target] = guide;
    $('workshop-current-step').textContent = session
      ? `第 ${step + 1} 步 / 共 4 步`
      : '课程进度';
    $('workshop-current-title').textContent = title;
    if ($('workshop-status').textContent !== description)
      $('workshop-status').textContent = description;
    const primary = $('workshop-primary');
    primary.hidden = !label;
    primary.disabled = busy || selecting;
    primary.textContent = label ?? '';
    primaryAction = target;
    $('workshop-diagnostics').textContent = JSON.stringify(session, null, 2);
    $('connection-status').textContent =
      halted || session?.stage === 'unknown'
        ? '需要处理'
        : session
          ? '已连接当前实验'
          : preview ? (setupReady ? '请选择算力机' : '课程预览') : '请选择实验';
    if (session?.training) {
      const url = new URL('experiment.html?context=' + encodeURIComponent(session.contextId), root)
        .href;
      $('open-result').href = url;
      $('go-recovery-counts').href = url + '#comparison-heading';
      $('go-replay').href = url + '#replay-heading';
      if ($('result-frame').getAttribute('src') !== url) $('result-frame').src = url;
    }
    $('go-recovery-counts').hidden = phase !== 'results';
    $('go-replay').hidden = phase !== 'results';
    const parentRecipe = session?.comparisonBase?.recipe;
    $('budget-presets').hidden = Boolean(parentRecipe);
    $('comparison-presets').hidden = !parentRecipe;
    $('compare-double-steps').disabled = busy || selecting || !ready || !parentRecipe || parentRecipe.timesteps > 500000;
    $('compare-formal-budget').disabled = busy || selecting || !ready || parentRecipe?.timesteps === 500000;
    $('workshop-retry').disabled = busy || selecting;
    $('start-quick').disabled = busy || selecting || !ready;
    $('start-formal').disabled = busy || selecting || !ready;
    $('confirm-recipe').disabled = busy || selecting || !ready;
  };
  const reveal = (id) => {
    const node = $(id);
    if (node.hidden) return;
    node.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    node.setAttribute('tabindex', '-1');
    node.focus({ preventScroll: true });
  };
  // The result remains an independently authenticated view, but shares one
  // scroll surface with the host. Never inspect an unrelated iframe document.
  const experimentFrameDocument = () => {
    if (!session?.training) return null;
    const frame = $('result-frame');
    try {
      const actual = new URL(frame.contentWindow.location.href);
      const expected = new URL('experiment.html?context=' + encodeURIComponent(contextId), root);
      return actual.href === expected.href ? frame.contentDocument : null;
    } catch {
      return null;
    }
  };
  for (const [id, heading] of [['go-recovery-counts', 'comparison-heading'], ['go-replay', 'replay-heading']]) {
    listen(id, 'click', (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = experimentFrameDocument()?.getElementById(heading);
      if (!target) return;
      event.preventDefault();
      target.scrollIntoView?.({ block: 'start' });
      target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
    });
  }
  listen('result-frame', 'load', () => {
    frameObserver?.disconnect();
    frameObserver = null;
    const frame = $('result-frame');
    const child = experimentFrameDocument();
    if (!child?.body) return;
    child.body.classList.add('workshop-embedded');
    const resize = () => { frame.style.height = Math.ceil(child.body.scrollHeight) + 'px'; };
    if (ResizeObserverImpl) {
      frameObserver = new ResizeObserverImpl(resize);
      frameObserver.observe(child.body);
    }
    resize();
  });
  for (const name of ['reference', 'budget', 'execution', 'result'])
    listen('workshop-step-' + name, 'click', () => {
      referenceExpanded = name === 'reference';
      executionExpanded = name === 'execution';
      show();
      reveal(name === 'result' ? 'result-section' : name + '-section');
    });
  listen('go-results', 'click', () => reveal('result-section'));
  listen('workshop-primary', 'click', () => {
    if (!primaryAction) return;
    if (primaryAction === 'start-setup') {
      run(loadSetup);
      return;
    }
    if (primaryAction === 'history') {
      run(async () => {
        await history();
        $('history').hidden = false;
        $('history-toggle').setAttribute('aria-expanded', 'true');
        reveal('history');
      });
      return;
    }
    if (primaryAction === 'workshop-login') $('workshop-login').click();
    else reveal(primaryAction);
  });
  const claimAndSubmit = async (phase, recipe = {}) => {
    // A draft can outlive the resource health TTL; probe before consuming its
    // durable submission claim, including after a long training run.
    const health = await json(
      'compute-resources/' + encodeURIComponent(session.computeResourceId) + '/test',
      {},
    );
    if (health.connected !== true || health.computeResource?.status !== 'online')
      throw Error('训练资源暂不可用，请检查连接后刷新原实验。');
    const engines = health.computeResource.engines;
    if (phase === 'train' && Array.isArray(engines) && !engines.includes(WORKSHOP_ENGINE))
      throw Error('这台算力机缺少本课程的训练引擎。请另开实验，选择支持本课程的算力机。');
    // Recovering an interrupted claim returns the same payload and idempotency
    // key. The /runs reservation prevents concurrent requests from dispatching twice.
    const claim = await json(
      'workshop-sessions/' + encodeURIComponent(contextId) + '/claim/' + phase,
      recipe,
    );
    await json('runs', claim.submission);
  };
  const refresh = async () => {
    if (busy || selecting || disposed || !contextId) return;
    const previousStage = session?.stage;
    const wasReadingExecution = document.activeElement === $('execution-section');
    busy = true;
    halted = false;
    failureMessage = '';
    failureLogsUnavailable = false;
    show();
    try {
      session = (await json('workshop-sessions/' + encodeURIComponent(contextId))).session;
      for (const r of [session.training, session.evaluation])
        if (r && ['queued', 'running', 'pending'].includes(r.status))
          await json('runs/' + encodeURIComponent(r.runId));
      session = (await json('workshop-sessions/' + encodeURIComponent(contextId))).session;
      show();
      if (session.stage === 'ready-evaluate' && session.autoContinue) {
        await claimAndSubmit('evaluate');
        session = (await json('workshop-sessions/' + encodeURIComponent(contextId))).session;
      }
      const failed = [session.evaluation, session.training].find((run) => run?.status === 'failed');
      if (session.stage === 'blocked' && validId(failed?.runId)) {
        try {
          const log = await json('runs/' + encodeURIComponent(failed.runId) + '/logs');
          const matching = log.runId === failed.runId;
          failureLogsUnavailable = !matching || !Array.isArray(log.lines) || log.lines.length === 0;
          if (matching && Array.isArray(log.lines) &&
              log.lines.some((line) => line.stream === 'stderr' &&
                typeof line.text === 'string' &&
                line.text.includes('RuntimeError: 可用磁盘空间不足，保留记录'))) {
            failureMessage = session.training?.status === 'completed'
              ? '算力机磁盘空间不足，测试停在这里。本次训练已保留，请联系课程管理员处理。'
              : '算力机磁盘空间不足，训练停在这里。请联系课程管理员处理。';
          }
        } catch {
          failureLogsUnavailable = true;
        }
      }
      $('workshop-error').hidden = true;
    } catch (e) {
      error(e);
    } finally {
      busy = false;
      show();
      schedule();
    }
    if (previousStage !== 'results' && session?.stage === 'results' &&
        wasReadingExecution && $('history').hidden &&
        !referenceExpanded) reveal('result-section');
  };
  const start = async (recipe) => {
    if (busy || selecting || session?.stage !== 'ready' || !reference) return;
    busy = true;
    halted = false;
    show();
    try {
      await claimAndSubmit('train', { ...recipe, reference });
      session = (await json('workshop-sessions/' + encodeURIComponent(contextId))).session;
      $('workshop-error').hidden = true;
    } catch (e) {
      error(e);
      try {
        session = (await json('workshop-sessions/' + encodeURIComponent(contextId))).session;
        if (e.offline && session?.contextId === contextId && validId(session.training?.runId)) {
          halted = false;
          reconnectNeeded = false;
          $('workshop-error').hidden = true;
        }
      } catch {
        /* preserve uncertain state */
      }
    } finally {
      busy = false;
      show();
      schedule();
    }
    if (session?.training) reveal('execution-section');
  };
  const choose = async (id) => {
    if (busy || selecting) return;
    if (!validId(id)) throw Error('实验标识无效。');
    selecting = true;
    clearTimer(timer);
    contextId = id;
    session = null;
    budgetReadiness = '';
    failureMessage = '';
    failureLogsUnavailable = false;
    if (!referenceVideo.paused) referenceVideo.pause();
    if (referenceVideo.currentTime > 0) referenceVideo.currentTime = 0;
    reference = null;
    referenceExpanded = false;
    executionExpanded = false;
    pendingRecipe = null;
    $('recipe-confirm').hidden = true;
    comparisonRequest++;
    comparisonLoaded = null;
    $('round-comparison').open = false;
    $('round-comparison-table').hidden = true;
    $('round-comparison-summary').hidden = true;
    $('round-comparison-picker').hidden = true;
    comparisonStatus('');
    $('comparison-recipe-help').hidden = true;
    $('custom-recipe').open = false;
    for (const id of ['custom-timesteps', 'custom-seed', 'custom-push']) $(id).value = $(id).defaultValue;
    $('reference-status').textContent = '';
    frameObserver?.disconnect();
    frameObserver = null;
    halted = false;
    $('result-frame').src = 'about:blank';
    show();
    const selectedUrl = new URL(location.href);
    selectedUrl.searchParams.set('context', id);
    selectedUrl.searchParams.delete('start');
    selectedUrl.searchParams.delete('setup');
    if (id !== entryContextId) selectedUrl.searchParams.delete('with');
    historyImpl?.replaceState(null, '', selectedUrl.href);
    try {
      const selected = (await json('workshop-sessions/' + encodeURIComponent(id) + '/select', {}))
        .session;
      if (selected?.contextId !== id) throw Error('返回的实验与所选记录不一致。');
      session = selected;
      if (session.stage === 'ready' && session.comparisonBase) {
        const parent = session.comparisonBase;
        for (const [key, , id] of recipeFields) $(id).value = parent.recipe[key];
        $('comparison-base-link').href = new URL(
          'experiment.html?context=' + encodeURIComponent(parent.contextId), root,
        ).href;
        $('comparison-recipe-help').hidden = false;
        $('custom-recipe').open = true;
      }
      $('history').hidden = true;
      $('workshop-error').hidden = true;
    } finally {
      selecting = false;
      show();
      schedule();
    }
  };
  const history = async () => {
    const list = await json('workshop-sessions');
    $('history-list').replaceChildren();
    $('history-empty').hidden = list.sessions.length > 0 || (list.experiments?.length ?? 0) > 0;
    for (const s of list.sessions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent =
        new Date(s.createdAt).toLocaleString('zh-CN') +
        ' · ' +
        (s.timesteps ? s.timesteps + ' 步' : '待选择预算') +
        ' · ' +
        s.contextId.slice(-6);
      b.addEventListener('click', () => run(() => choose(s.contextId)));
      $('history-list').append(b);
    }
    for (const item of list.experiments ?? []) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent =
        new Date(item.createdAt).toLocaleString('zh-CN') +
        ' · 已有实验 · ' +
        item.contextId.slice(-6);
      b.addEventListener('click', () => run(() => choose(item.contextId)));
      $('history-list').append(b);
    }
    return list;
  };
  referenceVideo.src = new URL(
    'api/sim2real/workshops/originman/reference-video?format=webm',
    root,
  ).href;
  if (referencePlayButton) {
    listen('play-reference', 'click', () => {
      if (referenceVideo.paused) {
        void referenceVideo.play().catch(() => {
          $('reference-status').textContent = '参考暂不可播放。可以跳过参考继续。';
        });
      } else {
        referenceVideo.pause();
      }
    });
    listen('reference-video', 'playing', () => {
      referencePlayButton.textContent = '暂停讲师参考';
    });
    for (const event of ['pause', 'ended', 'error'])
      listen('reference-video', event, () => {
        referencePlayButton.textContent = '播放讲师参考';
      });
  }
  const saveReference = async (choice) => {
    if (busy || selecting || disposed || session?.stage !== 'ready') return;
    if (reference === 'observed' || (choice === 'skipped' && reference)) return;
    busy = true;
    show();
    try {
      const saved = (
        await json('workshop-sessions/' + encodeURIComponent(contextId) + '/reference', {
          reference: choice,
        })
      ).session;
      if (disposed) return;
      if (saved?.contextId !== contextId || saved.reference !== choice)
        throw Error('参考记录与本次实验不一致，请刷新课程。');
      session = saved;
      reference = choice;
      if (choice === 'skipped' && !referenceVideo.paused) referenceVideo.pause();
      referenceExpanded = false;
      $('reference-status').textContent =
        choice === 'observed' ? '参考播放已结束。现在选择一次预算。' : '已选择跳过参考。';
      $('workshop-error').hidden = true;
      halted = false;
    } catch (e) {
      if (!disposed) error(e);
      return;
    } finally {
      busy = false;
      if (!disposed) {
        show();
        schedule();
      }
    }
    reveal('budget-section');
  };
  listen('reference-video', 'ended', () => {
    if (entryPreview && !contextId) previewObserved = true;
    else run(() => saveReference('observed'));
  });
  listen('reference-video', 'error', () => {
    $('reference-status').textContent = '参考暂不可播放。可打开参考仿真，或明确跳过后继续。';
  });
  listen('skip-reference', 'click', () => run(() => saveReference('skipped')));
  listen('start-quick', 'click', () =>
    run(() => start({ timesteps: 8192, seed: 7, pushMaxForce: 8.1 })),
  );
  const review = (recipe) => {
    pendingRecipe = recipe;
    const parent = session?.comparisonBase?.recipe;
    const changes = parent ? recipeFields
      .filter(([key]) => recipe[key] !== parent[key])
      .map(([key, label]) => label + ' ' + formatNumber(parent[key]) + ' → ' + formatNumber(recipe[key])) : [];
    const difference = parent
      ? changes.length ? '相对上一轮改动：' + changes.join('、') + '。' : '与上一轮参数相同。'
      : '';
    $('recipe-confirm-text').textContent = difference +
      `本轮 ${formatNumber(recipe.timesteps)} 步 · 随机种子 ${recipe.seed} · 侧推上限 ${recipe.pushMaxForce} N。训练完成后自动评测这份策略。`;
    $('recipe-confirm').hidden = false;
    reveal('recipe-confirm');
  };
  listen('start-formal', 'click', () => {
    const { seed = 7, pushMaxForce = 8.1 } = session?.comparisonBase?.recipe ?? {};
    review({ timesteps: 500000, seed, pushMaxForce });
  });
  const reviewComparisonBudget = (timesteps) => {
    const parent = session?.comparisonBase?.recipe;
    if (parent) review({ timesteps, seed: parent.seed, pushMaxForce: parent.pushMaxForce });
  };
  listen('compare-double-steps', 'click', () => {
    reviewComparisonBudget(session.comparisonBase.recipe.timesteps * 2);
  });
  listen('compare-formal-budget', 'click', () => reviewComparisonBudget(500000));
  listen('review-custom', 'click', () => {
    for (const n of ['custom-timesteps', 'custom-seed', 'custom-push'])
      if (!$(n).reportValidity()) return;
    review({
      timesteps: Number($('custom-timesteps').value),
      seed: Number($('custom-seed').value),
      pushMaxForce: Number($('custom-push').value),
    });
  });
  listen('confirm-recipe', 'click', () => {
    if (pendingRecipe) run(() => start(pendingRecipe));
  });
  listen('cancel-recipe', 'click', () => {
    pendingRecipe = null;
    $('recipe-confirm').hidden = true;
  });
  listen('refresh-workshop', 'click', () => run(refresh));
  listen('refresh-original-workshop', 'click', () => run(refresh));
  const resetComputeCheck = () => {
    unverifiedCompute = null;
    $('workshop-compute-check').textContent = '';
    $('workshop-setup-confirm').textContent = '检查这台算力机并继续';
  };
  const checkCompute = async (id) => {
    const resource = 'compute-resources/' + encodeURIComponent(id);
    const health = await json(resource + '/test', {});
    if (health.connected !== true || health.computeResource?.status !== 'online')
      return 'offline';
    // CUDA preflight exercises the base engine. The Workshop claim uses the
    // reflect variant, which must also be registered on this worker.
    const engines = health.computeResource.engines;
    if (!Array.isArray(engines)) return 'unverified';
    if (!engines.includes(WORKSHOP_ENGINE)) return 'engine';
    let checked;
    try {
      checked = await json('training/preflight', {
        computeResourceId: id, taskId: 'originman-recovery', engine: 'originman-recovery',
      });
    } catch (e) {
      if (e.code === 'SIM2REAL_ENGINE_PREFLIGHT_BUSY') return 'busy';
      if (e.code === 'SIM2REAL_PREFLIGHT_NOT_SUPPORTED' ||
          e.code === 'SIM2REAL_ENGINE_PREFLIGHT_UNSUPPORTED' || (e.status === 404 && !e.code))
        return 'unverified';
      throw e;
    }
    const report = checked.report;
    if (checked.computeResourceId !== id || report?.schemaVersion !== 1 ||
        report.trainingPerformed !== false || report.engine !== 'originman-recovery' ||
        report.taskId !== 'originman-recovery' || !Array.isArray(report.checks)) return 'invalid';
    const device = report.checks.find((check) => check.id === 'training-device');
    if (device?.status === 'blocked') return 'cuda';
    if (report.readyForSmokeTraining !== true) return 'blocked';
    try {
      if (device?.status === 'passed') {
        const resolved = JSON.parse(device.detail)?.resolvedDevice;
        if (resolved === 'cuda') return 'ready';
        if (resolved === 'cpu') return 'cuda';
      }
    } catch {
      // An older runner may not include machine-readable CUDA evidence.
    }
    return 'unverified';
  };
  const loadSetup = async () => {
    if (busy || selecting || disposed || contextId) return;
    busy = true;
    show();
    try {
      const data = await json('workshop-sessions/setup');
      if (!Array.isArray(data.resources)) throw Error('暂时读不到算力机列表。');
      setupAccount = data.accountId;
      resetComputeCheck();
      const select = $('workshop-compute');
      const placeholder = new document.defaultView.Option('请选择一台算力机', '', true, true);
      placeholder.disabled = true;
      select.replaceChildren(placeholder);
      for (const resource of data.resources) {
        const status = { online: '上次检查可用', offline: '上次检查离线', unknown: '待检查' }[resource.status] ?? '待检查';
        const option = new document.defaultView.Option(resource.name + ' · ' + status, resource.id);
        select.add(option);
      }
      const available = data.resources.length > 0;
      $('workshop-setup-form').hidden = !available;
      $('workshop-setup-status').textContent = available
        ? (setupAccount ? '当前账号：' + setupAccount + '。' : '') + '选择一台算力机后再选预算。'
        : '当前账号没有可选算力机。请联系课程管理员分配算力，再刷新列表。';
      $('workshop-error').hidden = true;
      setupReady = true;
      halted = false;
    } finally {
      busy = false;
      show();
    }
    reveal('workshop-setup');
  };
  listen('workshop-compute', 'change', () => {
    resetComputeCheck();
    show();
  });
  listen('workshop-setup-form', 'submit', (event) => {
    event.preventDefault();
    const select = $('workshop-compute');
    if (busy || selecting || disposed || contextId || !setupReady || !select.value ||
        select.selectedOptions[0]?.disabled) return;
    run(async () => {
      busy = true;
      show();
      const resourceId = select.value;
      const checkStatus = $('workshop-compute-check');
      let created;
      const environmentUnverified = unverifiedCompute === resourceId;
      try {
        if (!environmentUnverified) {
          checkStatus.textContent = '正在检查连接和本课程的运行环境…';
          let result;
          try {
            result = await checkCompute(resourceId);
          } catch (e) {
            if (e.status === 401) throw e;
            checkStatus.textContent = '暂时无法完成算力检查。可以重新检查这台机器，或另选一台。';
            return;
          }
          if (result !== 'ready') {
            checkStatus.textContent = {
              invalid: '平台返回的检查结果无法与本次选机对应。请重新检查，或联系课程管理员。',
              offline: '这台算力机暂时连不上。可以重新检查，或另选一台。',
              engine: '这台算力机缺少本课程的训练引擎。请选择另一台。',
              busy: '课程环境检查正忙。稍后重新检查，或另选一台。',
              blocked: '连接正常，但课程运行环境未通过检查。请选择另一台，或联系课程管理员。',
              cuda: '这台机器的 CUDA 检查未通过。请选择另一台支持本课程的算力机。',
              unverified: '连接正常，当前平台无法核对课程环境。可换一台，或确认继续选预算。',
            }[result];
            if (result === 'unverified') {
              unverifiedCompute = resourceId;
              $('workshop-setup-confirm').textContent = '环境未验证，仍继续选预算';
            }
            return;
          }
          checkStatus.textContent = '连接与课程环境检查通过，正在打开预算页。';
        }
        ({ session: created } = await json('workshop-sessions/setup', {
          accountId: setupAccount, computeResourceId: resourceId,
        }));
        if (!validId(created?.contextId) || created.computeResourceId !== resourceId)
          throw Error('平台尚未确认本次实验，请在历史中核对后继续。');
      } finally {
        busy = false;
        show();
      }
      await choose(created.contextId);
      budgetReadiness = environmentUnverified
        ? '所选算力机连接正常，课程环境未验证。'
        : '所选算力机的连接和课程环境检查通过。';
      await saveReference(previewObserved ? 'observed' : 'skipped');
    });
  });
  const previewReferenceKey = 'rdk-workshop:preview-observed';
  listen('workshop-login', 'click', () => {
    if (!entryPreview || contextId) return;
    try {
      if (previewObserved) document.defaultView?.sessionStorage.setItem(previewReferenceKey, '1');
      else document.defaultView?.sessionStorage.removeItem(previewReferenceKey);
    } catch {
      // Private browser settings can disable session storage.
    }
  });
  const onVisible = () => {
    if (!document.hidden && !halted && contextId && session?.autoContinue &&
        ['training', 'ready-evaluate', 'evaluating', 'unknown'].includes(session.stage))
      run(refresh);
  };
  document.addEventListener('visibilitychange', onVisible);
  listeners.push(() => document.removeEventListener('visibilitychange', onVisible));
  const reconnect = async () => {
    if (busy || selecting || disposed) return;
    if (entryPreview && !contextId) return loadSetup();
    if (!session && contextId) await choose(contextId);
    if (contextId) await refresh();
    else {
      const list = await history();
      if (list.current) {
        await choose(list.current.contextId);
        await refresh();
      } else {
        halted = false;
        $('history').hidden = false;
        $('workshop-error').hidden = true;
        show();
      }
    }
  };
  listen('workshop-retry', 'click', () => run(reconnect));
  const onOnline = () => {
    if (halted && reconnectNeeded) run(reconnect);
  };
  document.defaultView?.addEventListener('online', onOnline);
  listeners.push(() => document.defaultView?.removeEventListener('online', onOnline));
  listen('recover-workshop-request', 'click', () =>
    run(async () => {
      if (busy || selecting || session?.stage !== 'unknown') return;
      const phase = session.recoveryPhase;
      if (phase !== 'train' && phase !== 'evaluate') return;
      busy = true;
      show();
      try {
        await claimAndSubmit(phase, { recover: true });
      } finally {
        busy = false;
        show();
      }
      await refresh();
    }),
  );
  const updateIntent = async (action) => {
    if (busy || selecting || !contextId) return;
    busy = true;
    show();
    try {
      const next = (
        await json('workshop-sessions/' + encodeURIComponent(contextId) + '/' + action, {})
      ).session;
      if (next?.contextId !== contextId) throw Error('返回的实验与当前记录不一致。');
      session = next;
    } finally {
      busy = false;
      show();
      schedule();
    }
    if (action === 'continue') await refresh();
  };
  listen('pause-workshop', 'click', () => run(() => updateIntent('pause')));
  listen('continue-evaluation', 'click', () => run(() => updateIntent('continue')));
  listen('history-toggle', 'click', () =>
    run(async () => {
      const opened = $('history').hidden;
      await history();
      $('history').hidden = !opened;
      $('history-toggle').setAttribute('aria-expanded', String(opened));
    }),
  );
  const createExperiment = async (compare = false) => {
    if (busy || selecting || !session) return;
    const source = session;
    busy = true;
    show();
    let next;
    try {
      next = (
        await json('workshop-sessions', {
          modelId: source.modelId,
          computeResourceId: source.computeResourceId,
          ...(compare ? { comparisonBaseId: source.contextId } : {}),
        })
      ).session;
    } finally {
      busy = false;
      show();
    }
    await choose(next.contextId);
    if (!compare || session?.stage !== 'ready') return;
    if (reference) reveal('budget-section');
  };
  listen('choose-rounds', 'click', () => {
    const activeId = contextId;
    void json('workshop-sessions').then(({ sessions }) => {
      if (disposed || activeId !== contextId) return;
      for (const id of ['round-one', 'round-two']) {
        const select = $(id);
        const option = (value, label) => {
          const element = document.createElement('option');
          element.value = value;
          element.textContent = label;
          return element;
        };
        select.replaceChildren(option('', '不选择'), ...sessions
          .filter((row) => row.contextId !== activeId && row.evaluationRecorded)
          .map((row) => option(row.contextId, formatNumber(row.timesteps) + ' 步 · ' +
            new Date(row.createdAt).toLocaleString('zh-CN') + ' · ' + row.contextId.slice(-6))));
      }
      $('round-comparison-picker').hidden = false;
      $('round-one').focus();
    }).catch((e) => { if (activeId === contextId) comparisonStatus(e.message); });
  });
  listen('apply-rounds', 'click', () => {
    const ids = [$('round-one').value, $('round-two').value].filter(validId);
    if (new Set(ids).size !== ids.length) {
      comparisonStatus('两处选到了同一轮，请选择不同实验。');
      return;
    }
    if (!ids.length) {
      comparisonStatus('请选择至少一轮历史实验。');
      return;
    }
    const url = new URL(location.href);
    url.searchParams.set('with', ids.join(','));
    historyImpl?.replaceState(null, '', url.href);
    void loadRounds(ids);
  });
  listen('new-experiment', 'click', () => run(() => createExperiment()));
  listen('compare-parameters', 'click', () => run(() => createExperiment(true)));
  try {
    if (entryPreview) {
      show();
      if (entryUrl.searchParams.get('setup') === '1') {
        try {
          const storage = document.defaultView?.sessionStorage;
          previewObserved = storage?.getItem(previewReferenceKey) === '1';
          storage?.removeItem(previewReferenceKey);
        } catch {
          // Reference completion is optional.
        }
        await loadSetup();
      }
    } else if (contextId) {
      if (!validId(contextId)) throw Error('实验标识无效。');
      await choose(contextId);
    } else {
      const list = await history();
      if (list.current) await choose(list.current.contextId);
      else $('history').hidden = false;
    }
    await refresh();
  } catch (e) {
    error(e);
  }
  return {
    refresh,
    dispose() {
      disposed = true;
      frameObserver?.disconnect();
      clearTimer(timer);
      for (const remove of listeners) remove();
    },
  };
}
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const ready = () => void startWorkshop({ document, location: window.location });
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', ready, { once: true });
  else ready();
}
