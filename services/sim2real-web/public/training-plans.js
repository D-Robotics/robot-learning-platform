/* Shared workbench UI for named, server-stored training configuration. */
window.TrainingPlans = (() => {
  const base = '/v1/duck/training-plans';
  const controls = {
    profile: 'training-profile', algorithm: 'training-algorithm', engine: 'training-engine',
    numEnvs: 'training-num-envs', maxIterations: 'training-max-iterations',
  };
  const advanced = {
    ppo: { learningRate: 'training-ppo-learning-rate', entropyCoefficient: 'training-ppo-entropy', clipParameter: 'training-ppo-clip' },
    taskTuning: { trackLinearVelocityWeight: 'training-reward-linear', trackAngularVelocityWeight: 'training-reward-angular', headPoseTrackingWeight: 'training-reward-head' },
  };
  const names = {
    'alternating-arms': '左右交替摆臂',
    'weight-shift': '左右换重心',
    'squat-rise': '下蹲起身',
    'open-pose': '展开定格',
    'single-arm-wave': '单臂挥手',
    'arms-overhead': '双臂上举',
    'cross-and-open': '胸前交叉展开',
    'side-lean': '左右侧身',
    'alternating-knee-lift': '交替抬膝',
    'side-tap': '侧点步收回',
  };
  const byId = (id) => document.getElementById(id);
  const field = (id) => byId(id)?.value.trim() || '';
  const idValid = (id) => /^[a-f0-9-]{36}$/.test(id);

  const presets = [
    { id: 'alternating-arms', title: '左右交替摆臂', bpm: 100, sections: [
      { type: 'alternating-arms', beats: 8, intensity: 0.25 },
    ] },
    { id: 'rhythm-and-pose', title: '节奏变换与定格', bpm: 110, sections: [
      { type: 'alternating-arms', beats: 8, intensity: 0.7 },
      { type: 'weight-shift', beats: 8, intensity: 0.5 },
      { type: 'squat-rise', beats: 8, intensity: 0.6 },
      { type: 'open-pose', beats: 8, intensity: 0.5 },
    ] },
  ];

  function mountDanceEditor(onChange) {
    const root = byId('originman-goal-editor');
    const goal = byId('originman-training-goal');
    const presetPicker = byId('originman-dance-preset');
    const fields = byId('originman-dance-fields');
    const sections = byId('originman-dance-sections');
    const add = byId('originman-dance-add');
    const error = byId('originman-dance-error');
    const title = byId('originman-dance-title');
    const bpm = byId('originman-dance-bpm');
    const steps = byId('originman-dance-steps');
    const seed = byId('originman-dance-seed');
    const numEnvs = byId('originman-dance-num-envs');
    const configPanel = byId('train-module-config');
    const preset = () => presets.find(({ id }) => id === presetPicker.value) ?? presets[0];
    const number = (input) => input.value !== '' && input.validity.valid ? Number(input.value) : NaN;
    const enabled = () => !root.hidden;
    let mode = 'preset';
    const draft = {
      preset: { title: presets[0].title, bpm: presets[0].bpm },
      custom: { title: '', bpm: 100 },
    };
    presets.forEach(({ id, title: name }) => presetPicker.add(new Option(name, id)));
    title.value = draft.preset.title;

    function selectedSections() {
      return mode === 'preset' ? preset().sections : Array.from(sections.children, (row) => ({
        type: row.querySelector('[data-dance-type]').value,
        beats: Number(row.querySelector('[data-dance-beats]').value),
        intensity: number(row.querySelector('[data-dance-intensity]')),
      }));
    }

    function read() {
      if (!enabled()) return null;
      const recipe = {
        schemaVersion: 1, compositionMode: mode, title: title.value.trim(), bpm: number(bpm),
        trainingSteps: number(steps),
        ...(seed.value !== '' ? { seed: number(seed) } : {}),
        ...(draft[mode].rewardTuning ? { rewardTuning: draft[mode].rewardTuning } : {}),
        sections: selectedSections(),
      };
      if (!recipe.title || !Number.isFinite(recipe.bpm) || !Number.isFinite(recipe.trainingSteps) || !Number.isFinite(number(numEnvs)) ||
          ('seed' in recipe && !Number.isFinite(recipe.seed)) || !recipe.sections.length ||
          recipe.sections.some((section) => !Object.hasOwn(names, section.type) || !Number.isFinite(section.intensity))) return null;
      return recipe;
    }

    function refresh() {
      fields.hidden = !enabled();
      configPanel.classList.toggle('is-dance-goal', enabled());
      byId('originman-dance-presets').hidden = mode !== 'preset';
      byId('originman-dance-custom').hidden = mode !== 'custom';
      byId('originman-dance-preview').textContent = preset().sections.map(({ type, beats }) => names[type] + ' ' + beats + ' 拍').join(' → ');
      byId('originman-dance-empty').hidden = sections.childElementCount !== 0;
      add.disabled = sections.childElementCount >= 8;
      Array.from(sections.children).forEach((row, index) => {
        row.querySelector('legend').textContent = '第 ' + (index + 1) + ' 段';
        row.querySelector('[data-dance-up]').disabled = index === 0;
        row.querySelector('[data-dance-down]').disabled = index === sections.childElementCount - 1;
      });
      error.textContent = enabled() && !read()
        ? mode === 'custom' && !sections.childElementCount
          ? ''
          : '请填写作品名称，选择每段动作并检查节奏、步数、并行环境、种子和强度。'
        : '';
    }

    function append(section = { type: '', beats: 8, intensity: 0.25 }) {
      const row = document.createElement('fieldset');
      row.className = 'dance-goal-section';
      row.innerHTML = '<legend></legend><div class="dance-goal-fields">' +
        '<label>动作组 <select data-dance-type><option value="">请选择动作</option></select></label>' +
        '<label>拍数 <select data-dance-beats></select></label>' +
        '<label>强度（0.25–1） <input data-dance-intensity type="number" min="0.25" max="1" step="any"></label>' +
        '</div><div class="training-plans-actions">' +
        '<button type="button" class="button button-ghost button-small" data-dance-up>上移</button>' +
        '<button type="button" class="button button-ghost button-small" data-dance-down>下移</button>' +
        '<button type="button" class="button button-ghost button-small" data-dance-remove>移除这段</button></div>';
      const type = row.querySelector('[data-dance-type]');
      const beats = row.querySelector('[data-dance-beats]');
      const up = row.querySelector('[data-dance-up]');
      const down = row.querySelector('[data-dance-down]');
      for (const [value, name] of Object.entries(names)) type.add(new Option(name, value));
      for (const count of [4, 8, 16]) beats.add(new Option(String(count), String(count)));
      type.value = section.type;
      beats.value = section.beats;
      row.querySelector('[data-dance-intensity]').value = section.intensity;
      up.addEventListener('click', () => {
        if (!row.previousElementSibling) return;
        row.previousElementSibling.before(row);
        changed();
        (up.disabled ? down : up).focus();
      });
      down.addEventListener('click', () => {
        if (!row.nextElementSibling) return;
        row.nextElementSibling.after(row);
        changed();
        (down.disabled ? up : down).focus();
      });
      row.querySelector('[data-dance-remove]').addEventListener('click', () => {
        const next = row.nextElementSibling || row.previousElementSibling;
        row.remove();
        changed();
        (next?.querySelector('[data-dance-type]') || add).focus();
      });
      sections.append(row);
      return type;
    }

    function changed() {
      refresh();
      onChange();
    }

    function showDraft() {
      goal.value = mode === 'preset' ? 'originman-dance' : 'originman-dance-custom';
      title.value = draft[mode].title;
      bpm.value = draft[mode].bpm;
    }

    root.addEventListener('input', (event) => {
      // The resource selector updates workbench state on change. Rendering here would reset it first.
      if (event.target === byId('compute-resource-select')) return;
      if (event.target === goal) {
        Object.assign(draft[mode], { title: title.value, bpm: bpm.value });
        mode = goal.value === 'originman-dance' ? 'preset' : 'custom';
        showDraft();
      } else if (event.target === presetPicker) {
        draft.preset = { title: preset().title, bpm: preset().bpm };
        showDraft();
      }
      changed();
    });
    add.addEventListener('click', () => {
      if (sections.childElementCount >= 8) return;
      const type = append();
      changed();
      type.focus();
    });
    return {
      enabled,
      read,
      numEnvs: () => number(numEnvs),
      syncProduct(product) {
        root.hidden = product !== 'originman';
        refresh();
      },
      load(recipe, count) {
        if (recipe) {
          const matched = recipe.compositionMode === 'preset' && presets.find(({ sections }) =>
            sections.length === recipe.sections.length && sections.every((section, index) => {
              const saved = recipe.sections[index];
              return section.type === saved.type && section.beats === saved.beats && section.intensity === saved.intensity;
            }));
          mode = matched ? 'preset' : 'custom';
          if (matched) presetPicker.value = matched.id;
          else {
            sections.replaceChildren();
            recipe.sections.forEach(append);
          }
          draft[mode] = { title: recipe.title, bpm: recipe.bpm, rewardTuning: recipe.rewardTuning };
          showDraft();
          steps.value = recipe.trainingSteps ?? 500000;
          seed.value = recipe.seed ?? '';
          numEnvs.value = count ?? 64;
        }
        refresh();
      },
    };
  }

  function mount({ request, readContext, applyContext, refreshControls, ready, onDraftChange, hasDanceContract, selectWorkshopResource }) {
    const root = byId('training-plans');
    if (!root) return null;
    const select = byId('training-plan-select');
    const status = byId('training-plan-status');
    const dialog = byId('training-plan-dialog');
    const form = byId('training-plan-form');
    const nameInput = byId('training-plan-name');
    const formError = byId('training-plan-form-error');
    const loadButton = byId('training-plan-load');
    const saveButton = byId('training-plan-save');
    const copyButton = byId('training-plan-copy');
    const newButton = byId('training-plan-new');
    let current = null;
    let busy = false;
    let listing = null;
    let dirty = false;
    let editingCopy = false;
    const danceEditor = mountDanceEditor(() => {
      markDirty();
      onDraftChange();
    });
    danceEditor.syncProduct(readContext().productId);

    function syncButtons() {
      loadButton.disabled = busy || !select.value;
      saveButton.disabled = busy;
      copyButton.disabled = busy || !current;
      newButton.hidden = !current;
      newButton.disabled = busy;
      select.disabled = busy;
      byId('training-plan-confirm').disabled = busy;
      saveButton.textContent = current ? '保存修改' : '保存为新方案';
    }

    function setStatus(message) { status.textContent = message; }
    function rememberLink(id) {
      const url = new URL(location.href);
      if (id) {
        url.searchParams.set('trainingPlan', id);
        url.searchParams.delete('fromRun');
      }
      else url.searchParams.delete('trainingPlan');
      history.replaceState(history.state, '', url);
    }
    function errorMessage(error) {
      return error?.status === 401 ? '请登录后管理训练方案。' : error?.message || '训练方案暂时不可用。';
    }

    async function list() {
      if (listing) return listing;
      listing = request(base).then(({ plans }) => {
        const selected = select.value;
        select.replaceChildren(new Option(plans.length ? '选择已保存方案' : '暂无已保存方案', ''));
        for (const plan of plans) select.add(new Option(plan.name, plan.id));
        select.value = [...select.options].some((option) => option.value === selected) ? selected : '';
        syncButtons();
      }).finally(() => { listing = null; });
      return listing;
    }

    function collect() {
      const config = { ...readContext() };
      const training = {};
      for (const [key, id] of Object.entries(controls)) {
        if (!byId(id)) {
          if (current?.config.training[key] !== undefined) training[key] = current.config.training[key];
          continue;
        }
        const value = field(id);
        if (value) training[key] = ['numEnvs', 'maxIterations'].includes(key) ? Number(value) : value;
      }
      for (const [group, fields] of Object.entries(advanced)) {
        const values = Object.fromEntries(Object.entries(fields).flatMap(([key, id]) => {
          if (field(id)) return [[key, Number(field(id))]];
          if (!byId(id) && current?.config.training[group]?.[key] !== undefined)
            return [[key, current.config.training[group][key]]];
          return [];
        }));
        if (Object.keys(values).length) training[group] = values;
      }
      if (danceEditor.enabled()) {
        const dance = danceEditor.read();
        if (!dance) throw Error('请先完成舞蹈目标配置。');
        const numEnvs = danceEditor.numEnvs();
        config.taskId = 'originman-dance';
        if (!hasDanceContract()) delete config.modelId;
        delete config.demonstrationRunId;
        return { ...config, training: {
          profile: 'standard', algorithm: 'ppo', engine: 'originman-dance-ppo',
          numEnvs, maxIterations: danceIterations(dance.trainingSteps, numEnvs),
          originmanDance: dance, video: true,
        } };
      }
      if (training.engine === 'originman-dance-ppo') delete training.engine;
      if (typeof current?.config.training.video === 'boolean') training.video = current.config.training.video;
      const checkpointId = field('resume-checkpoint-id');
      const artifactRef = field('resume-artifact-ref');
      if (checkpointId || artifactRef) {
        if (!checkpointId || !artifactRef) throw Error('续训需要同时填写 checkpoint 和制品引用。');
        config.resumeFrom = { checkpointId, artifactRef };
      }
      return { ...config, training };
    }

    function applyPlanConfig(config, options) {
      const training = config.training;
      const engine = byId(controls.engine);
      for (const [key, id] of Object.entries(controls)) {
        const control = byId(id);
        if (!control || control.tagName !== 'SELECT' || !training[key]) continue;
        const option = Array.from(control.options).find((item) => item.value === training[key]);
        if (!option && !(key === 'engine' && training.originmanDance))
          throw Error('方案中的训练选项当前不可用，已保留表单原值。');
      }
      applyContext(config, options);
      for (const old of engine?.querySelectorAll('[data-training-plan-engine]') || []) old.remove();
      if (training.originmanDance && engine && !Array.from(engine.options).some((item) => item.value === training.engine)) {
        const option = new Option('OriginMan 舞蹈 · PPO', training.engine);
        option.dataset.trainingPlanEngine = 'true';
        engine.add(option);
      }
      for (const [key, id] of Object.entries(controls)) {
        const control = byId(id);
        if (control) control.value = training[key] ?? (key === 'profile' ? 'standard' : key === 'algorithm' ? 'ppo' : '');
      }
      for (const [group, fields] of Object.entries(advanced))
        for (const [key, id] of Object.entries(fields)) if (byId(id)) byId(id).value = training[group]?.[key] ?? '';
      if (byId('resume-checkpoint-id')) byId('resume-checkpoint-id').value = config.resumeFrom?.checkpointId ?? '';
      if (byId('resume-artifact-ref')) byId('resume-artifact-ref').value = config.resumeFrom?.artifactRef ?? '';
      danceEditor.load(training.originmanDance, training.numEnvs);
      refreshControls();
      if (byId('training-demonstration-run')) byId('training-demonstration-run').value = config.demonstrationRunId || '';
    }

    function showPlan(plan) {
      applyPlanConfig(plan.config);
      current = plan;
      select.value = plan.id;
      rememberLink(plan.id);
      dirty = false;
      setStatus(`已加载「${plan.name}」。调整后可保存修改或另存为。`);
    }

    async function action(fn, onError = (error) => setStatus(errorMessage(error))) {
      if (busy) return;
      busy = true;
      syncButtons();
      try { await fn(); } catch (error) { onError(error); }
      finally { busy = false; syncButtons(); }
    }

    select.addEventListener('change', syncButtons);
    select.addEventListener('focus', () => { void list().catch((error) => setStatus(errorMessage(error))); });
    loadButton.addEventListener('click', () => void action(async () => {
      const { plan } = await request(base + '/' + select.value);
      showPlan(plan);
    }));
    function markDirty() {
      if (!current || dirty) return;
      dirty = true;
      setStatus(`「${current.name}」有未保存的修改。`);
    }
    byId('train-module-config').addEventListener('input', (event) => {
      if (!root.contains(event.target)) markDirty();
    });

    function openName(copy) {
      editingCopy = copy;
      formError.textContent = '';
      byId('training-plan-dialog-title').textContent = copy ? '另存为训练方案' : current ? '保存训练方案修改' : '保存训练方案';
      nameInput.value = copy && current ? (current.name.slice(0, 59) + ' 副本') : current?.name || '';
      dialog.showModal();
      nameInput.select();
    }
    saveButton.addEventListener('click', () => openName(false));
    copyButton.addEventListener('click', () => openName(true));
    newButton.addEventListener('click', () => {
      current = null;
      dirty = false;
      select.value = '';
      rememberLink(null);
      syncButtons();
      setStatus('已取消选中方案。保存会创建一套新方案。');
    });
    byId('training-plan-cancel').addEventListener('click', () => dialog.close());
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void action(async () => {
        const update = !editingCopy && current;
        const result = await request(base + (update ? '/' + current.id : ''), {
          method: update ? 'PUT' : 'POST',
          body: JSON.stringify({ name: nameInput.value, config: collect(), ...(update ? { revision: current.revision } : {}) }),
        });
        current = result.plan;
        dirty = false;
        if (!Array.from(select.options).some((option) => option.value === current.id))
          select.add(new Option(current.name, current.id));
        select.value = current.id;
        rememberLink(current.id);
        select.selectedOptions[0].text = current.name;
        dialog.close();
        setStatus(`已保存「${current.name}」。训练需在「Run 与进度」单独提交。`);
      }, (error) => { formError.textContent = errorMessage(error); });
    });
    syncButtons();
    const params = new URL(location.href).searchParams;
    const linked = params.get('trainingPlan');
    const sourceRunId = params.get('fromRun');
    const preset = params.get('danceBudget');
    const useWorkshopPreset = !linked && !sourceRunId && readContext().productId === 'originman' &&
      (preset === 'quick' || preset === 'formal');
    if (useWorkshopPreset) {
      byId('originman-training-goal').value = 'originman-dance';
      byId('originman-dance-steps').value = preset === 'quick' ? 8192 : 500000;
      byId('originman-dance-budget-help').textContent = preset === 'quick'
        ? '已填入快检的步数，可以修改。先练习提交和查看结果。'
        : '已填入正式实验的步数，可以修改。动作效果以本轮评测为准。';
      danceEditor.syncProduct('originman');
    }
    const begin = () => {
      if (useWorkshopPreset && readContext().productId === 'originman') {
        selectWorkshopResource?.(params.get('computeResourceId'));
      }
      if (linked && idValid(linked)) {
        void action(async () => {
          await list();
          const { plan } = await request(base + '/' + linked);
          showPlan(plan);
        });
      } else if (sourceRunId && idValid(sourceRunId)) {
        void action(async () => {
          const { run } = await request('/sim2real/runs/' + encodeURIComponent(sourceRunId));
          if (new URL(location.href).searchParams.get('fromRun') !== sourceRunId) return;
          if (run?.id !== sourceRunId || run.taskId !== 'originman-dance' ||
              !run.training?.originmanDance || !run.modelId)
            throw Error('未取得本次舞蹈 Run 的训练配置。');
          applyPlanConfig({
            productId: 'originman', taskId: 'originman-dance', modelId: run.modelId,
            computeResourceId: run.computeResourceId, projectId: run.projectId,
            training: run.training,
          }, { fromRun: true });
          setStatus('已复制本轮参数。可修改并保存为新方案，再到「Run 与进度」提交。');
        });
      } else if (byId('train-module-config').open) {
        void list().catch((error) => setStatus(errorMessage(error)));
      }
    };
    void Promise.resolve(ready).then(begin);
    byId('train-module-config').addEventListener('toggle', () => {
      if (byId('train-module-config').open) void list().catch((error) => setStatus(errorMessage(error)));
    });
    return { hasDance: danceEditor.enabled, dance: danceEditor.read, danceNumEnvs: danceEditor.numEnvs, syncProduct: danceEditor.syncProduct, video: () => current?.config.training.video };
  }
  function danceIterations(steps, numEnvs) {
    const stepsPerEnvironment = Math.min(256, Math.floor(4096 / numEnvs));
    return Math.ceil(steps / (numEnvs * stepsPerEnvironment));
  }
  return { mount, danceIterations };
})();
