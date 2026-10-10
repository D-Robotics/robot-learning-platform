/* Recorded Run inspection: one elapsed-time clock for image, signals and events.
 * Loaded by a classic script after run-inspector-core.js. The host supplies
 * project-scoped runs/manifests and its mounted API prefix through configure().
 */
(function () {
  'use strict';
  const core = globalThis.RdkRunInspectorCore;
  if (!core || !globalThis.customElements || customElements.get('rdk-run-inspector')) return;

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function button(text, listener) {
    const element = node('button', 'button button-ghost button-small', text);
    element.type = 'button';
    element.addEventListener('click', listener);
    return element;
  }
  function number(value) {
    return core.finite(value) === null ? '—' : String(Number(value.toPrecision(5)));
  }
  function seconds(value) {
    return `${Number(value).toFixed(3)}s`;
  }
  function title(run) {
    const label = run.label || run.summary || run.taskId || run.id || '本地遥测';
    return run.id ? `${label} · ${String(run.id).slice(0, 8)}` : label;
  }
  function dimensionLabel(dimension) {
    return `${dimension.name} · ${dimension.unit || '单位未声明'}`;
  }

  class RunInspector extends HTMLElement {
    constructor() {
      super();
      this.options = { apiRoot: '/api/sim2real', runs: [], manifests: {}, mode: 'single' };
      this.tracks = [];
      this.pendingRunIds = [];
      this.elapsed = 0;
      this.limit = 0;
      this.generation = 0;
      this.playing = false;
    }

    connectedCallback() {
      this.build();
    }
    disconnectedCallback() {
      this.pause();
      this.controller?.abort();
      this.generation += 1;
      this.pendingRunIds = [];
    }

    build() {
      if (this.built) return;
      this.built = true;
      this.classList.add('rdk-run-inspector');
      this.heading = node('h3', '', 'Run 诊断');
      this.note = node('p', 'small-note');
      this.status = node('p', 'small-note', '选择一个有原始遥测的 Run，或导入本地遥测。');
      this.status.setAttribute('role', 'status');
      this.toolbar = node('div', 'run-inspector-toolbar');
      const selectRun = (label) => {
        const wrapper = node('label', 'field-label', label);
        const select = node('select');
        select.setAttribute('aria-label', label);
        wrapper.append(select);
        this.toolbar.append(wrapper);
        return { wrapper, select };
      };
      this.first = selectRun('诊断 Run');
      this.second = selectRun('对照 Run');
      this.loadButton = button('加载诊断', () => {
        void this.load(
          this.first.select.value,
          this.options.mode === 'compare' ? this.second.select.value : '',
        );
      });
      this.toolbar.append(this.loadButton);
      this.clock = node('div', 'run-inspector-toolbar');
      this.playButton = button('播放', () => (this.playing ? this.pause() : this.play()));
      const back = button('上一采样点', () => this.step(-1));
      const forward = button('下一采样点', () => this.step(1));
      this.speed = node('select');
      this.speed.setAttribute('aria-label', '回放速度');
      for (const value of [0.25, 0.5, 1, 2, 4]) {
        const option = node('option', '', `${value}×`);
        option.value = String(value);
        this.speed.append(option);
      }
      this.speed.value = '1';
      this.position = node('output', 'small-note', '0.000s');
      this.clock.append(
        this.playButton,
        back,
        forward,
        this.speed,
        this.position,
        button('下载当前 Run CSV', () => this.exportCsv()),
      );
      this.scrub = node('input');
      this.scrub.type = 'range';
      this.scrub.min = '0';
      this.scrub.max = '0';
      this.scrub.step = '0.001';
      this.scrub.value = '0';
      this.scrub.setAttribute('aria-label', '统一经过时间：相机、奖励、观测、动作与事件');
      this.scrub.addEventListener('input', () => {
        this.pause();
        this.seek(Number(this.scrub.value));
      });
      this.panes = node('div', 'run-inspector-panes');
      this.append(
        this.heading,
        this.note,
        this.toolbar,
        this.status,
        this.clock,
        this.scrub,
        this.panes,
      );
      this.updateMode();
      this.updateClock();
    }

    configure(options = {}) {
      this.build();
      const previousMode = this.options.mode;
      this.options = { ...this.options, ...options };
      this.options.mode = this.options.mode === 'compare' ? 'compare' : 'single';
      const allowed = new Set((this.options.runs || []).map((run) => String(run.id)));
      if (
        this.pendingRunIds.some((id) => !allowed.has(String(id))) ||
        this.tracks.some((track) =>
          track.local
            ? track.run.modelId && !this.options.manifests?.[track.run.modelId]
            : !allowed.has(String(track.run.id)),
        )
      ) {
        this.pause();
        this.controller?.abort();
        this.generation += 1;
        this.pendingRunIds = [];
        this.tracks = [];
        this.viewPanes = [];
        this.limit = 0;
        this.elapsed = 0;
        this.panes.replaceChildren();
        this.loadButton.disabled = false;
        this.status.textContent = '项目或产品已切换，请重新选择 Run。';
      }
      for (const { select } of [this.first, this.second]) {
        const previous = select.value;
        select.replaceChildren();
        const empty = node(
          'option',
          '',
          select === this.second.select ? '不加载对照 Run' : '请选择 Run',
        );
        empty.value = '';
        select.append(empty);
        for (const run of this.options.runs || []) {
          const option = node('option', '', title(run));
          option.value = run.id;
          select.append(option);
        }
        if (allowed.has(previous)) select.value = previous;
      }
      this.updateMode(previousMode !== this.options.mode);
      this.updateClock();
      return this;
    }

    updateMode(remount = false) {
      const compare = this.options.mode === 'compare';
      this.second.wrapper.hidden = !compare;
      this.heading.textContent = compare ? '两 Run 同步对照' : '单 Run 诊断';
      this.note.textContent = compare
        ? '按各自首个记录时间对齐经过时间；使用当时或之前的真实采样，不插值、不推断因果，也不将不同契约的同维序号当成同一信号。'
        : '相机、奖励、原始观测与动作、事件共用记录时间。原始数据不会被替换为默认值；显示不能替代来源验证。';
      if (remount && this.tracks.length) this.mountPanes();
    }

    async fetchJson(path, signal) {
      if (typeof this.options.requestJson === 'function')
        return this.options.requestJson(path, { signal });
      const response = await fetch(this.options.apiRoot.replace(/\/$/, '') + path, {
        credentials: 'same-origin',
        signal,
      });
      if (!(response.headers.get('content-type') || '').includes('application/json'))
        throw new Error('服务未返回 JSON；请检查登录状态和连接。');
      const payload = await response.json();
      if (!response.ok)
        throw new Error(payload.message || payload.error || `HTTP ${response.status}`);
      return payload;
    }

    async readTrack(runId, signal) {
      const path = '/runs/' + encodeURIComponent(runId);
      const [detail, replay] = await Promise.all([
        this.fetchJson(path, signal),
        this.fetchJson(path + '/replay', signal),
      ]);
      const prepared = core.prepareFrames(replay.frames);
      if (!prepared.frames.length)
        throw new Error(`Run ${runId} 没有含有效时间戳的原始遥测，不能绘制诊断。`);
      const run = detail.run || detail;
      const summary = replay.replay || {};
      // /replay returns provenance inside its replay summary. Keep an explicit
      // fresh rejection instead of inheriting a previously attested Run row.
      const attested =
        typeof summary.attested === 'boolean'
          ? summary.attested
          : typeof replay.attested === 'boolean'
            ? replay.attested
            : run.evaluation?.replay?.attested === true;
      return {
        run,
        ...prepared,
        manifest: this.options.manifests?.[run.modelId] || run.manifest || {},
        replay: {
          ...replay,
          ...summary,
          source: run.evaluation?.replay?.source || summary.source || replay.source,
          attested,
        },
        local: false,
      };
    }

    async load(runId, compareRunId = '') {
      this.build();
      if (!runId) {
        this.status.textContent = '先选择一个 Run。';
        return false;
      }
      const allowed = new Set((this.options.runs || []).map((run) => String(run.id)));
      if (!allowed.has(String(runId)) || (compareRunId && !allowed.has(String(compareRunId)))) {
        this.status.textContent = '所选 Run 不属于当前项目或产品的可选列表。';
        return false;
      }
      if (compareRunId === runId) {
        this.status.textContent = '请选择两个不同的 Run。';
        return false;
      }
      this.pause();
      this.controller?.abort();
      this.controller = new AbortController();
      const generation = ++this.generation;
      const ids = [runId, ...(compareRunId && compareRunId !== runId ? [compareRunId] : [])];
      this.pendingRunIds = ids;
      this.loadButton.disabled = true;
      this.status.textContent = '正在读取所选 Run 原始数据…';
      try {
        const tracks = await Promise.all(
          ids.map((id) => this.readTrack(id, this.controller.signal)),
        );
        if (generation !== this.generation) return false;
        this.tracks = tracks;
        this.elapsed = 0;
        this.limit = Math.max(...tracks.map((track) => core.duration(track.frames)));
        this.first.select.value = runId;
        this.second.select.value = compareRunId;
        this.status.textContent = `已载入 ${tracks.length} 个 Run；${tracks.map((track) => `${track.frames.length} 帧${track.dropped ? `，跳过 ${track.dropped} 条无有效时间戳记录` : ''}`).join(' / ')}。`;
        this.mountPanes();
        this.seek(0);
        this.dispatchEvent(
          new CustomEvent('run-inspector-load', {
            bubbles: true,
            detail: { runId, compareRunId: ids[1] || '', local: false },
          }),
        );
        return true;
      } catch (error) {
        if (generation === this.generation && error.name !== 'AbortError')
          this.status.textContent = `加载失败：${error.message}。保留上次已加载数据。`;
        return false;
      } finally {
        if (generation === this.generation) {
          this.pendingRunIds = [];
          this.loadButton.disabled = false;
        }
      }
    }

    loadLocal(input = {}) {
      this.build();
      this.pause();
      this.controller?.abort();
      this.generation += 1;
      this.pendingRunIds = [];
      this.loadButton.disabled = false;
      const prepared = core.prepareFrames(input.samples);
      if (!prepared.frames.length) {
        this.status.textContent = '本地文件没有含有效时间戳的原始遥测。';
        return false;
      }
      this.tracks = [
        {
          ...prepared,
          run: { modelId: input.modelId, summary: input.fileName || '本地遥测' },
          manifest: this.options.manifests?.[input.modelId] || {},
          replay: { source: input.source },
          local: true,
        },
      ];
      this.limit = core.duration(prepared.frames);
      this.elapsed = 0;
      this.status.textContent = `已载入本地 ${prepared.frames.length} 帧；来源未验证，未创建 Run${prepared.dropped ? `；跳过 ${prepared.dropped} 条无时间戳记录` : ''}。`;
      this.mountPanes();
      this.seek(0);
      this.dispatchEvent(
        new CustomEvent('run-inspector-load', {
          bubbles: true,
          detail: { local: true, modelId: input.modelId },
        }),
      );
      return true;
    }

    clear() {
      this.build();
      this.pause();
      this.controller?.abort();
      this.generation += 1;
      this.pendingRunIds = [];
      this.tracks = [];
      this.viewPanes = [];
      this.limit = 0;
      this.elapsed = 0;
      this.panes.replaceChildren();
      this.loadButton.disabled = false;
      this.status.textContent = '诊断已清除；请选择 Run 或导入本地遥测。';
      this.updateClock();
    }

    visibleTracks() {
      return this.options.mode === 'compare' ? this.tracks : this.tracks.slice(0, 1);
    }

    mountPanes() {
      this.panes.replaceChildren();
      this.viewPanes = this.visibleTracks().map((track) => this.createPane(track));
      this.limit = Math.max(0, ...this.visibleTracks().map((track) => core.duration(track.frames)));
      this.seek(Math.min(this.elapsed, this.limit));
    }

    createPane(track) {
      const root = node('article', 'run-inspector-pane');
      root.append(node('h4', '', title(track.run)));
      const mock = track.run.mock === true || track.replay.source === 'demo-fixture';
      const provenance = mock
        ? '演示数据 · 不能证明真实设备'
        : track.local
          ? '本地导入 · 来源未验证'
          : track.replay.attested === true
            ? '服务器标注受信来源 · 可视化不替代发布门'
            : '来源未验证 · 可供审阅';
      root.append(
        node(
          'p',
          'small-note',
          `${provenance} · ${track.run.id || '尚未绑定 Run'} · ${track.frames.length} 帧`,
        ),
      );
      const instant = node('p', 'small-note');
      root.append(instant);
      const camera = node('canvas', 'run-inspector-camera');
      camera.width = 1;
      camera.height = 1;
      camera.setAttribute('role', 'img');
      camera.setAttribute('aria-label', '记录的相机画面');
      const cameraNote = node('p', 'small-note');
      root.append(camera, cameraNote);
      const pane = {
        root,
        track,
        instant,
        camera,
        cameraNote,
        charts: [],
        lastCamera: null,
        hasCamera: track.frames.some((frame) => frame.cameraFrame),
      };
      const reward = this.createChart(pane, 'reward', null);
      root.append(reward.host);
      pane.charts.push(reward);
      for (const field of ['observation', 'action']) {
        const count = Math.min(
          4096,
          track.frames.reduce(
            (max, sample) => Math.max(max, Array.isArray(sample[field]) ? sample[field].length : 0),
            0,
          ),
        );
        const dims = core.dimensions(track.manifest.contract || {}, field, count);
        const chart = this.createChart(pane, field, dims);
        root.append(chart.host);
        pane.charts.push(chart);
      }
      const parts = node('p', 'small-note');
      pane.parts = parts;
      root.append(parts);
      const raw = node('details', 'run-inspector-raw');
      raw.append(node('summary', '', '当前采样原始观测 / 动作'));
      const table = node('table', 'record-table');
      const head = node('thead');
      const header = node('tr');
      ['信号', '单位', '值'].forEach((label) => header.append(node('th', '', label)));
      head.append(header);
      const body = node('tbody');
      table.append(head, body);
      raw.append(table);
      pane.raw = body;
      pane.rawDetails = raw;
      raw.addEventListener('toggle', () => {
        if (raw.open) this.renderPane(pane);
      });
      root.append(raw);
      const eventBox = node('details', 'run-inspector-events');
      const events = core.events(track.frames);
      eventBox.append(node('summary', '', `事件（${events.length}）· 点击跳转`));
      if (!events.length)
        eventBox.append(node('p', 'small-note', '当前回放没有记录 done / fall / 生命周期事件。'));
      for (const event of events)
        eventBox.append(
          button(`${seconds(event.elapsed)} · ${event.label}`, () => {
            this.pause();
            this.seek(event.elapsed);
          }),
        );
      root.append(eventBox);
      this.panes.append(root);
      return pane;
    }

    createChart(pane, field, dims) {
      const host = node('div', 'run-inspector-chart');
      const heading = node(
        'strong',
        '',
        field === 'reward' ? '奖励' : field === 'observation' ? '观测信号' : '动作信号',
      );
      host.append(heading);
      let select;
      if (dims) {
        select = node('select');
        select.setAttribute('aria-label', `${title(pane.track.run)} ${field} 维度`);
        for (const dim of dims) {
          const option = node('option', '', dimensionLabel(dim));
          option.value = String(dim.index);
          select.append(option);
        }
        if (!dims.length) {
          select.append(node('option', '', '未记录该向量'));
          select.disabled = true;
        }
        host.append(select);
      }
      const canvas = node('canvas', 'telemetry-canvas');
      canvas.width = 720;
      canvas.height = 160;
      canvas.tabIndex = 0;
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', `${field} 按实际时间的信号曲线，点击定位`);
      const detail = node('p', 'small-note');
      host.append(canvas, detail);
      const chart = { host, canvas, detail, field, dims, select, pane };
      const refresh = () => {
        chart.points = null;
        this.renderPane(pane);
      };
      select?.addEventListener('change', refresh);
      canvas.addEventListener('click', (event) => {
        this.pause();
        this.seek(this.pointerTime(canvas, event));
      });
      canvas.addEventListener('pointermove', (event) =>
        this.chartDetail(chart, this.pointerTime(canvas, event)),
      );
      canvas.addEventListener('pointerleave', () => this.chartDetail(chart, this.elapsed));
      canvas.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          this.step(event.key === 'ArrowRight' ? 1 : -1);
        }
      });
      return chart;
    }

    pointerTime(canvas, event) {
      const rect = canvas.getBoundingClientRect();
      const x = ((event.clientX - rect.left) * canvas.width) / Math.max(1, rect.width);
      return Math.max(0, Math.min(this.limit, ((x - 50) / (canvas.width - 64)) * this.limit));
    }

    value(chart, sample) {
      return core.finite(
        chart.field === 'reward'
          ? sample?.reward
          : sample?.[chart.field]?.[Number(chart.select?.value) || 0],
      );
    }

    chartDetail(chart, elapsed) {
      const selected = core.sampleAtElapsed(chart.pane.track.frames, elapsed);
      const dim = chart.dims?.[Number(chart.select?.value) || 0];
      const label = dim ? dimensionLabel(dim) : '奖励';
      chart.detail.textContent = selected.sample
        ? `${label} = ${number(this.value(chart, selected.sample))} · 采样 t=${seconds(selected.sample.t)} · 经过 ${seconds(selected.sample.t - chart.pane.track.frames[0].t)}`
        : `${label} · ${selected.ended ? '该 Run 在当前经过时间已结束' : '无采样'}`;
    }

    drawChart(chart) {
      const canvas = chart.canvas;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const style = getComputedStyle(document.documentElement);
      const color = (token) => style.getPropertyValue(token).trim() || getComputedStyle(this).color;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const frames = chart.pane.track.frames;
      if (!chart.points) {
        chart.points = frames.map((sample) => ({
          t: sample.t - frames[0].t,
          value: this.value(chart, sample),
        }));
        const values = chart.points
          .filter((point) => point.value !== null)
          .map((point) => point.value);
        chart.min = values.reduce((minimum, value) => Math.min(minimum, value), 0);
        chart.max = values.length
          ? values.reduce((maximum, value) => Math.max(maximum, value), 0)
          : 1;
        if (chart.min === chart.max) chart.max = chart.min + 1;
        chart.hasValues = values.length > 0;
      }
      ctx.font = '12px sans-serif';
      ctx.fillStyle = color('--muted-strong');
      if (!chart.hasValues) {
        ctx.fillText('源数据未记录此信号，不补绘曲线', 50, 70);
        this.chartDetail(chart, this.elapsed);
        return;
      }
      const xOf = (time) => 50 + (time / (this.limit || 1)) * (canvas.width - 64);
      const yOf = (value) => 130 - ((value - chart.min) / (chart.max - chart.min)) * 104;
      ctx.fillText(number(chart.max), 0, 26);
      ctx.fillText(number(chart.min), 0, 130);
      ctx.fillText('0s', 50, 152);
      ctx.fillText(seconds(this.limit), canvas.width - 72, 152);
      ctx.strokeStyle = color('--line-strong');
      ctx.beginPath();
      ctx.moveTo(50, 20);
      ctx.lineTo(50, 130);
      ctx.lineTo(canvas.width - 14, 130);
      ctx.stroke();
      ctx.strokeStyle = color(
        chart.field === 'reward'
          ? '--green'
          : chart.field === 'observation'
            ? '--blue'
            : '--orange',
      );
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let active = false;
      for (const point of chart.points) {
        if (point.value === null) {
          active = false;
          continue;
        }
        if (active) ctx.lineTo(xOf(point.t), yOf(point.value));
        else ctx.moveTo(xOf(point.t), yOf(point.value));
        active = true;
      }
      ctx.stroke();
      ctx.strokeStyle = color('--text');
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(xOf(this.elapsed), 20);
      ctx.lineTo(xOf(this.elapsed), 130);
      ctx.stroke();
      this.chartDetail(chart, this.elapsed);
    }

    renderPane(pane) {
      const { track } = pane;
      const selected = core.sampleAtElapsed(track.frames, this.elapsed);
      const sample = selected.sample;
      pane.instant.textContent = sample
        ? `经过 ${seconds(this.elapsed)} · 实际采样 t=${seconds(sample.t)} · 第 ${selected.index + 1} 帧 · 采样距播放头 ${seconds(Math.max(0, track.frames[0].t + this.elapsed - sample.t))}`
        : '该 Run 在当前经过时间已结束，没有对应采样。';
      const camera = core.cameraAtElapsed(track.frames, this.elapsed);
      const cameraSource = camera?.frame.cameraFrame;
      if (!cameraSource) {
        pane.camera.hidden = true;
        pane.lastCamera = null;
        pane.cameraNote.textContent = selected.ended
          ? '该 Run 已结束，不显示其他时刻的相机画面。'
          : pane.hasCamera
            ? '当前时刻尚无已记录的相机帧；不提前显示未来画面。'
            : '该运行未记录相机帧（向量观测）；没有可显示的图像。';
      } else {
        try {
          if (pane.lastCamera !== camera.frame) {
            const raw = atob(cameraSource.data);
            const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
            const rgba = core.cameraRgba(cameraSource, bytes);
            if (!rgba) throw new Error('相机格式或几何不合法');
            pane.camera.width = cameraSource.width;
            pane.camera.height = cameraSource.height;
            const ctx = pane.camera.getContext('2d');
            if (!ctx) throw new Error('画布不可用');
            const image = ctx.createImageData(cameraSource.width, cameraSource.height);
            image.data.set(rgba);
            ctx.putImageData(image, 0, 0);
            pane.lastCamera = camera.frame;
          }
          pane.camera.hidden = false;
          pane.cameraNote.textContent = `相机 t=${seconds(camera.frame.t)} · 帧龄 ${seconds(camera.age)}${camera.index !== selected.index ? ' · 此前最近帧，非本采样点' : ''} · ${cameraSource.encoding}`;
        } catch (error) {
          pane.camera.hidden = true;
          pane.lastCamera = null;
          pane.cameraNote.textContent = `相机帧无法解码：${error.message}；不保留旧画面。`;
        }
      }
      const parts = core.rewardParts(sample);
      pane.parts.textContent = parts.length
        ? '源数据奖励分项：' + parts.map((part) => `${part.name}=${number(part.value)}`).join(' · ')
        : '源数据未记录奖励分项；只能查看总奖励，不能推断各项贡献。';
      if (pane.rawDetails.open && pane.lastRaw !== sample) {
        pane.lastRaw = sample;
        pane.raw.replaceChildren();
        for (const field of ['observation', 'action']) {
          const vector = sample?.[field];
          if (!Array.isArray(vector)) continue;
          const dims = core.dimensions(track.manifest.contract || {}, field, vector.length);
          for (const dim of dims) {
            const rawValue = core.finite(vector[dim.index]);
            const row = node('tr');
            row.append(
              node('td', '', dim.name),
              node('td', '', dim.unit || '未声明'),
              node('td', '', rawValue === null ? '—' : String(rawValue)),
            );
            pane.raw.append(row);
          }
        }
        if (!pane.raw.children.length) {
          const row = node('tr');
          const cell = node('td', '', '当前采样没有观测或动作向量。');
          cell.colSpan = 3;
          row.append(cell);
          pane.raw.append(row);
        }
      }
      for (const chart of pane.charts) this.drawChart(chart);
    }

    seekRecordedFrame(runId, timestamp) {
      const track = this.tracks[0];
      if (!track || track.local || track.run.id !== runId || !Number.isFinite(timestamp)) return false;
      const elapsed = Math.max(0, Math.min(this.limit, timestamp - track.frames[0].t));
      if (Math.abs(this.elapsed - elapsed) > 0.000001) this.seek(elapsed);
      return true;
    }

    seek(elapsed) {
      this.elapsed = Math.max(0, Math.min(this.limit, Number.isFinite(elapsed) ? elapsed : 0));
      this.updateClock();
      for (const pane of this.viewPanes || []) this.renderPane(pane);
      const selected = core.sampleAtElapsed(this.tracks[0]?.frames || [], this.elapsed);
      this.dispatchEvent(
        new CustomEvent('run-inspector-seek', {
          bubbles: true,
          detail: {
            elapsed: this.elapsed,
            runId: this.tracks[0]?.run.id,
            frame: selected.sample,
            index: selected.index,
          },
        }),
      );
    }

    updateClock() {
      this.scrub.max = String(this.limit);
      this.scrub.value = String(this.elapsed);
      this.scrub.disabled = !this.tracks.length || this.limit <= 0;
      this.position.textContent = `${seconds(this.elapsed)} / ${seconds(this.limit)}`;
      this.playButton.disabled = !this.tracks.length || this.limit <= 0;
      this.playButton.textContent = this.playing ? '暂停' : '播放';
    }

    pause() {
      this.playing = false;
      cancelAnimationFrame(this.animation);
      if (this.built) this.updateClock();
    }
    play() {
      if (!this.limit || !this.tracks.length) return;
      if (this.elapsed >= this.limit) this.seek(0);
      this.playing = true;
      let last = performance.now();
      let lastPaint = last;
      const tick = (now) => {
        if (!this.playing) return;
        const elapsed = Math.min(
          this.limit,
          this.elapsed + ((now - last) / 1000) * Number(this.speed.value),
        );
        last = now;
        this.elapsed = elapsed;
        if (now - lastPaint >= 100 || elapsed >= this.limit) {
          this.seek(elapsed);
          lastPaint = now;
        }
        if (elapsed >= this.limit) {
          this.pause();
          return;
        }
        this.animation = requestAnimationFrame(tick);
      };
      this.updateClock();
      this.animation = requestAnimationFrame(tick);
    }
    step(direction) {
      this.pause();
      this.seek(core.nextElapsed(this.tracks[0]?.frames || [], this.elapsed, direction));
    }

    exportCsv() {
      const track = this.tracks[0];
      if (!track) return;
      const cell = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
      const fields = ['t', 'reward', 'observation', 'action', 'done', 'fall', 'event'];
      const lines = [
        fields.map(cell).join(','),
        ...track.frames.map((sample) =>
          fields
            .map((field) =>
              cell(
                typeof sample[field] === 'object' ? JSON.stringify(sample[field]) : sample[field],
              ),
            )
            .join(','),
        ),
      ];
      const url = URL.createObjectURL(
        new Blob([lines.join('\n') + '\n'], { type: 'text/csv;charset=utf-8' }),
      );
      const anchor = node('a');
      anchor.href = url;
      anchor.download = `run-${track.run.id || 'local'}-telemetry.csv`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  }

  customElements.define('rdk-run-inspector', RunInspector);
})();
