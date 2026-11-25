export function mountOriginmanMotion({ api, changed, initialMode }) {
  const byId = (name) => document.getElementById('reference-' + name);
  const mode = byId('mode');
  const controls = byId('motion-panel');
  const catalogSource = byId('motion-source');
  const preset = byId('motion-preset');
  const search = byId('motion-search');
  const action = byId('motion-action');
  const category = byId('motion-category');
  const add = byId('motion-add');
  const sequence = byId('motion-sequence');
  const bpm = byId('motion-bpm');
  const transition = byId('motion-transition');
  const prepare = byId('motion-prepare');
  const status = byId('motion-status');
  const estimate = byId('motion-estimate');
  const result = byId('motion-result');
  const joint = byId('motion-joint');
  const curve = byId('motion-curve');
  let catalog;
  let preview;
  let submission;
  let generation = 0;
  let loading = false;
  let locked = false;
  const blocks = [];
  mode.value = ['preset', 'blocks'].includes(initialMode) ? initialMode : 'upload';

  const isUpload = () => mode.value === 'upload';
  const recipe = () => mode.value === 'preset'
    ? (preset.value ? { presetId: preset.value } : null)
    : blocks.length && bpm.value && bpm.validity.valid && transition.value && transition.validity.valid
      ? { blocks: blocks.map(({ id, repeats }) => ({ id, repeats })), bpm: Number(bpm.value), transitionSeconds: Number(transition.value) }
      : null;

  function setPrepareState() {
    prepare.disabled = locked || !recipe() || isUpload() ||
      (mode.value === 'blocks' && estimate.dataset.invalidDuration === 'true');
  }

  function invalidate() {
    generation++;
    preview = submission = undefined;
    result.hidden = true;
    status.textContent = '';
    const count = blocks.reduce((sum, item) => sum + item.repeats, 0);
    const frames = blocks.reduce((sum, item) => sum + item.motion.frames * item.repeats, 0) +
      Math.max(0, count - 1) * Math.max(0, Math.round(Number(transition.value) * 50) - 1);
    estimate.textContent = mode.value === 'blocks' && count
      ? count + ' 段 · 至少 ' + (frames / 50).toFixed(2) + ' 秒（以预览为准）' : '';
    estimate.dataset.invalidDuration = String(frames > 4500 || (count === 1 && frames < 50) || (count > 0 && blocks.every(({ motion }) => motion.poseOnly)));
    setPrepareState();
    if (mode.value === 'blocks' && count > 0) {
      if (blocks.every(({ motion }) => motion.poseOnly)) status.textContent = '请搭配至少一个动态动作。';
      else if (count === 1 && frames < 50) status.textContent = '至少需要 1 秒，请增加片段或重复次数。';
      else if (frames > 4500) status.textContent = '超过 90 秒，请减少动作或重复次数。';
    }
    changed();
  }

  function populateActions() {
    const query = search.value.trim().toLowerCase();
    const selection = action.value;
    const motions = catalog?.motions.filter(({ id, displayName, category: group }) =>
      (!category.value || group === category.value) &&
      [id, displayName, group].some((value) => value.toLowerCase().includes(query))) ?? [];
    action.replaceChildren(...motions.map((motion) =>
      new Option(motion.displayName + ' · ' + motion.category + (motion.poseOnly ? ' · 定格' : '') + (motion.clipped ? ' · 已限幅' : ''), motion.id)));
    if (motions.some(({ id }) => id === selection)) action.value = selection;
    add.disabled = !action.value || locked || blocks.length >= 128;
  }

  function renderSequence() {
    sequence.replaceChildren(...blocks.map((block, index) => {
      const row = document.createElement('li');
      const title = document.createElement('span');
      title.textContent = block.motion.displayName + (block.motion.poseOnly ? '（定格）' : '') + (block.motion.clipped ? '（已限幅）' : '') + ' ';
      const repeats = document.createElement('input');
      Object.assign(repeats, { type: 'number', min: '1', max: '8', value: block.repeats, disabled: locked });
      repeats.setAttribute('aria-label', '第 ' + (index + 1) + ' 段重复次数');
      repeats.addEventListener('change', () => {
        if (!repeats.value || !repeats.validity.valid) repeats.value = block.repeats;
        block.repeats = Number(repeats.value);
        invalidate();
      });
      const button = (name, disabled, onClick) => {
        const control = document.createElement('button');
        Object.assign(control, { type: 'button', textContent: name, disabled: locked || disabled });
        control.setAttribute('aria-label', '第 ' + (index + 1) + ' 段' + name);
        control.addEventListener('click', () => {
          onClick();
          renderSequence();
          invalidate();
          (sequence.children[Math.min(index, blocks.length - 1)]?.querySelector('input') ?? add).focus();
        });
        return control;
      };
      const move = (target) => { [blocks[index], blocks[target]] = [blocks[target], blocks[index]]; };
      row.append(title, repeats,
        button('上移', index === 0, () => move(index - 1)),
        button('下移', index === blocks.length - 1, () => move(index + 1)),
        button('移除', false, () => blocks.splice(index, 1)));
      return row;
    }));
    populateActions();
  }

  async function showMode() {
    byId('import-section').hidden = !isUpload();
    byId('screen-file-control').hidden = !isUpload();
    controls.hidden = isUpload();
    byId('motion-presets').hidden = mode.value !== 'preset';
    byId('motion-blocks').hidden = mode.value !== 'blocks';
    invalidate();
    if (isUpload() || catalog || loading) return;
    loading = true;
    catalogSource.textContent = '正在读取动作库…';
    try {
      catalog = await api('originman-motion/catalog');
      catalogSource.textContent = catalog.catalogSource === 'built-in-example'
        ? '当前提供教学示例。已有动作文件可在「导入自己的轨迹」中使用。'
        : catalog.presets.length + ' 支预置 · ' + catalog.motions.length + ' 个动作';
      preset.replaceChildren(...catalog.presets.map(({ id, displayName, seconds, bpm: tempo, referenceMode }) =>
        new Option(referenceMode === 'source-exact'
          ? displayName + ' · 原版 ' + seconds.toFixed(2) + ' 秒'
          : referenceMode === 'timing-preserved'
            ? displayName + ' · 原节奏 ' + seconds.toFixed(2) + ' 秒'
            : displayName + ' · 约 ' + seconds.toFixed(1) + ' 秒 · ' + tempo + ' BPM', id)));
      const categories = [...new Set(catalog.motions.map((item) => item.category))];
      category.replaceChildren(new Option('全部分类', ''), ...categories.map((item) => new Option(item, item)));
      if (!catalog.presets.length && mode.value === 'preset') status.textContent = '当前动作库没有预置。';
      populateActions();
      setPrepareState();
    } catch (error) {
      catalogSource.textContent = error.message;
    } finally {
      loading = false;
    }
  }

  function plot() {
    const track = preview?.joints[Number(joint.value)];
    if (!track) return;
    const scale = Math.max(Math.abs(track.min), Math.abs(track.max), 0.05);
    curve.firstElementChild.setAttribute('d', track.values.map((q, index) =>
      (index ? ' L ' : 'M ') + (5 + 390 * index / (track.values.length - 1)) + ' ' + (55 - 47 * q / scale)).join(''));
    byId('motion-range').textContent = '范围 ' + track.min.toFixed(3) + ' 至 ' + track.max.toFixed(3) + ' rad';
  }

  mode.addEventListener('change', showMode);
  for (const input of [preset, bpm, transition]) input.addEventListener('change', invalidate);
  search.addEventListener('input', populateActions);
  category.addEventListener('change', populateActions);
  add.addEventListener('click', () => {
    const motion = catalog.motions.find(({ id }) => id === action.value);
    if (!motion || locked || blocks.length >= 128) return;
    blocks.push({ id: motion.id, motion, repeats: 1 });
    renderSequence();
    invalidate();
  });
  joint.addEventListener('change', plot);
  prepare.addEventListener('click', async () => {
    const selected = recipe();
    if (!selected) return;
    const current = ++generation;
    submission = undefined;
    prepare.disabled = true;
    result.hidden = true;
    status.textContent = '正在校验、拼接并预览…';
    changed();
    try {
      const response = await api('originman-motion/preview', selected);
      if (current !== generation) return;
      preview = response.preview;
      submission = {
        composition: selected,
        expectedTrajectorySha256: preview.trajectorySha256,
        ...(preview.stanceProfile && { expectedStanceProfile: preview.stanceProfile }),
      };
      joint.replaceChildren(...preview.joints.map(({ name }, index) => new Option(name, index)));
      const mostActive = preview.joints.reduce((best, track, index, tracks) =>
        track.max - track.min > tracks[best].max - tracks[best].min ? index : best, 0);
      joint.value = String(mostActive);
      const length = preview.seconds.toFixed(2) + ' 秒 · ' + preview.frames + ' 帧';
      status.textContent = preview.referenceMode === 'source-exact'
        ? length + ' · 保留交付轨迹的原始采样和节奏。'
        : preview.referenceMode === 'timing-preserved'
          ? length + ' · 保留交付节奏，动作幅度按仿真场景适配。'
          : length + ' · 约 ' + preview.beats.toFixed(1) + ' 拍。';
      if (preview.adjustedTransitions?.length) {
        const count = preview.adjustedTransitions.length;
        status.textContent += ' 为满足关节速度上限，已延长 ' + count + ' 处过渡，共增加 ' +
          preview.extraTransitionSeconds.toFixed(2) + ' 秒。';
      }
      result.hidden = false;
      plot();
    } catch (error) {
      if (current === generation) status.textContent = error.message;
    } finally {
      if (current === generation) {
        setPrepareState();
        changed();
      }
    }
  });

  return {
    start: showMode,
    isUpload,
    submission: () => isUpload() ? undefined : submission,
    setLocked(value) {
      if (locked === value) return;
      locked = value;
      for (const input of [mode, preset, search, action, category, bpm, transition]) input.disabled = locked;
      setPrepareState();
      renderSequence();
    },
  };
}
