/** Button-driven orchestration. The normal authenticated /runs API owns every submission. */
export async function startWorkshop({
  document,
  location,
  fetchImpl = fetch,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  historyImpl = globalThis.history,
} = {}) {
  const $ = (id) => document.getElementById(id);
  const root = new URL('./', location.href),
    api = new URL('api/v1/duck/', root);
  let contextId = new URL(location.href).searchParams.get('context'),
    session = null,
    timer = null,
    busy = false,
    disposed = false,
    reference = null,
    pendingRecipe = null;
  const validId = (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(v);
  const listeners = [];
  const listen = (id, type, fn) => {
    const node = $(id);
    node.addEventListener(type, fn);
    listeners.push(() => node.removeEventListener(type, fn));
  };
  const json = async (path, body) => {
    const r = await fetchImpl(new URL(path, api), {
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
    const value = await r.json();
    if (!r.ok || value.ok !== true)
      throw Error(value.message ?? '课程读取失败，请保留原实验稍后恢复。');
    return value;
  };
  const error = (e) => {
    $('workshop-error').textContent = e.message ?? '课程暂不可用。';
    $('workshop-error').hidden = false;
    $('connection-status').textContent = '需要处理';
  };
  const run = (fn) => {
    void fn().catch(error);
  };
  const schedule = () => {
    clearTimer(timer);
    if (
      !disposed &&
      session &&
      (['training', 'evaluating', 'unknown'].includes(session.stage) ||
        (session.stage === 'ready-evaluate' && session.autoContinue))
    )
      timer = setTimer(() => run(refresh), 4000);
  };
  const show = () => {
    const ready = session?.stage === 'ready';
    if (ready && ['observed', 'skipped'].includes(session.reference)) reference = session.reference;
    $('reference-section').hidden = !ready;
    $('budget-section').hidden = !ready || !reference;
    $('execution-section').hidden = !session || ready;
    $('result-section').hidden = !session?.training;
    $('new-experiment').disabled = !session || busy;
    $('new-experiment').title = '保留原实验和已提交任务，创建独立新实验；不会取消或重交原任务。';
    $('pause-workshop').disabled =
      !session?.autoContinue || ['results', 'blocked'].includes(session.stage);
    $('continue-evaluation').hidden =
      session?.stage !== 'ready-evaluate' || session.autoContinue || session.legacy;
    $('workshop-status').textContent =
      session?.nextAction ?? '选择一个实验继续，或回到插件开始课程。';
    $('execution-status').textContent =
      session?.stage === 'unknown'
        ? '提交状态待核对。已停止新的提交，可刷新恢复原任务。'
        : session?.stage === 'results'
          ? '训练与评测已完成。效果和回放请在下方查看。'
          : session?.stage === 'blocked'
            ? '原任务未成功，已停止自动步骤。'
            : session?.stage === 'ready-evaluate'
              ? session.legacy
                ? '已有训练完成；此旧版实验仅查看，可在聊天明确要求同源评测。'
                : session.autoContinue
                  ? '训练完成，准备评测同一策略。'
                  : '训练完成，后续自动步骤已暂停。'
              : session?.stage === 'evaluating'
                ? '正在评测同一策略。'
                : '训练进行中，正在等待本次任务。';
    $('workshop-diagnostics').textContent = JSON.stringify(session, null, 2);
    $('connection-status').textContent = session ? '已连接当前实验' : '请选择实验';
    if (session?.training) {
      const url = new URL('experiment.html?context=' + encodeURIComponent(session.contextId), root)
        .href;
      $('open-result').href = url;
      if ($('result-frame').getAttribute('src') !== url) $('result-frame').src = url;
    }
    $('start-quick').disabled = busy;
    $('start-formal').disabled = busy;
    $('confirm-recipe').disabled = busy;
  };
  const claimAndSubmit = async (phase, recipe = {}) => {
    // A durable single claim is obtained before the only POST /runs. On a lost
    // response we only read: another tab or restarted host cannot submit twice.
    const claim = await json(
      'workshop-sessions/' + encodeURIComponent(contextId) + '/claim/' + phase,
      recipe,
    );
    await json('runs', claim.submission);
  };
  const refresh = async () => {
    if (busy || disposed || !contextId) return;
    busy = true;
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
      $('workshop-error').hidden = true;
    } catch (e) {
      error(e);
    } finally {
      busy = false;
      show();
      schedule();
    }
  };
  const start = async (recipe) => {
    if (busy || session?.stage !== 'ready' || !reference) return;
    busy = true;
    show();
    try {
      await claimAndSubmit('train', { ...recipe, reference });
      session = (await json('workshop-sessions/' + encodeURIComponent(contextId))).session;
      $('workshop-error').hidden = true;
    } catch (e) {
      error(e);
      try {
        session = (await json('workshop-sessions/' + encodeURIComponent(contextId))).session;
      } catch {
        /* preserve uncertain state */
      }
    } finally {
      busy = false;
      show();
      schedule();
    }
  };
  const choose = async (id) => {
    if (!validId(id)) throw Error('实验标识无效。');
    clearTimer(timer);
    contextId = id;
    const selectedUrl = new URL(location.href);
    selectedUrl.searchParams.set('context', id);
    historyImpl?.replaceState(null, '', selectedUrl.href);
    reference = null;
    session = (await json('workshop-sessions/' + encodeURIComponent(id) + '/select', {})).session;
    show();
    $('history').hidden = true;
    schedule();
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
  $('reference-video').src = new URL(
    'api/sim2real/workshops/originman/reference-video?format=webm',
    root,
  ).href;
  listen('reference-video', 'ended', () =>
    run(async () => {
      session = (
        await json('workshop-sessions/' + encodeURIComponent(contextId) + '/reference', {
          reference: 'observed',
        })
      ).session;
      reference = 'observed';
      $('reference-status').textContent = '参考播放已结束。现在选择一次预算。';
      show();
    }),
  );
  listen('reference-video', 'error', () => {
    $('reference-status').textContent = '参考暂不可播放。可打开参考仿真，或明确跳过后继续。';
  });
  listen('skip-reference', 'click', () =>
    run(async () => {
      session = (
        await json('workshop-sessions/' + encodeURIComponent(contextId) + '/reference', {
          reference: 'skipped',
        })
      ).session;
      reference = 'skipped';
      $('reference-status').textContent = '已选择跳过参考。';
      show();
    }),
  );
  listen('start-quick', 'click', () =>
    run(() => start({ timesteps: 8192, seed: 7, pushMaxForce: 8.1 })),
  );
  const review = (recipe) => {
    pendingRecipe = recipe;
    $('recipe-confirm-text').textContent =
      `本次选择 ${recipe.timesteps} 训练步、seed ${recipe.seed}、侧推上限 ${recipe.pushMaxForce}N，随后自动做同源评测。不会扩大预算，也不保证提升。`;
    $('recipe-confirm').hidden = false;
  };
  listen('start-formal', 'click', () => review({ timesteps: 500000, seed: 7, pushMaxForce: 8.1 }));
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
  listen('pause-workshop', 'click', () =>
    run(async () => {
      session = (await json('workshop-sessions/' + encodeURIComponent(contextId) + '/pause', {})).session;
      show();
    }),
  );
  listen('continue-evaluation', 'click', () =>
    run(async () => {
      await json('workshop-sessions/' + encodeURIComponent(contextId) + '/continue', {});
      await refresh();
    }),
  );
  listen('history-toggle', 'click', () =>
    run(async () => {
      const opened = $('history').hidden;
      await history();
      $('history').hidden = !opened;
      $('history-toggle').setAttribute('aria-expanded', String(opened));
    }),
  );
  listen('new-experiment', 'click', () =>
    run(async () => {
      if (busy) return;
      const next = (
        await json('workshop-sessions', {
          modelId: session.modelId,
          computeResourceId: session.computeResourceId,
        })
      ).session;
      await choose(next.contextId);
    }),
  );
  try {
    if (contextId) {
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
