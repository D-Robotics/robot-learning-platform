/*
 * Small, dependency-free interaction layer for the canvas visualizations.
 *
 * The charts themselves stay owned by app.js. This file adds the interactions
 * that are useful while investigating a run (hover values, keyboard stepping,
 * and CSV export) without changing the rendering contract or inventing data.
 * It is deliberately a classic script so the standalone file:// demo keeps
 * working.
 */
(function visualizationEnhancements() {
  'use strict';

  const TOOLTIP_CLASS = 'visualization-tooltip';
  const ACTION_BAR_CLASS = 'visualization-action-bar';

  function node(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function csvCell(value) {
    const text = value == null ? '' : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }

  function download(filename, content, type) {
    const blob = new Blob([content], { type: type || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function telemetrySamples() {
    if (typeof currentTelemetry !== 'function') return [];
    const evidence = currentTelemetry();
    return Array.isArray(evidence && evidence.samples) ? evidence.samples : [];
  }

  function ensureTooltip(canvas) {
    const host = canvas && canvas.parentElement;
    if (!host) return null;
    host.classList.add('visualization-interaction-host');
    let tooltip = host.querySelector(`.${TOOLTIP_CLASS}`);
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.className = TOOLTIP_CLASS;
      tooltip.setAttribute('role', 'status');
      tooltip.setAttribute('aria-live', 'polite');
      tooltip.hidden = true;
      host.append(tooltip);
    }
    return tooltip;
  }

  function hideTooltip(canvas) {
    const tooltip = canvas?.parentElement?.querySelector(`.${TOOLTIP_CLASS}`);
    if (tooltip) tooltip.hidden = true;
  }

  function showTooltip(canvas, event, html) {
    const tooltip = ensureTooltip(canvas);
    if (!tooltip) return;
    const rect = canvas.getBoundingClientRect();
    const hostRect = canvas.parentElement.getBoundingClientRect();
    const x = Math.max(8, Math.min(hostRect.width - 220, event.clientX - rect.left + 12));
    const y = Math.max(8, Math.min(hostRect.height - 56, event.clientY - rect.top + 12));
    // escape-audit:allow html is assembled only from escapeHtml/canonical numeric formatters above
    tooltip.innerHTML = html;
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
    tooltip.hidden = false;
  }

  function sampleAtPointer(canvas, event, samples) {
    if (!samples.length) return null;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / Math.max(1, rect.width);
    const x = (event.clientX - rect.left) * scaleX;
    const plotLeft = 38;
    const plotRight = canvas.width - 10;
    const ratio = Math.max(0, Math.min(1, (x - plotLeft) / (plotRight - plotLeft)));
    const first = Number(samples[0]?.t) || 0;
    const last = Number(samples[samples.length - 1]?.t) || first + 1;
    const target = first + ratio * (last - first || 1);
    let bestIndex = 0;
    let bestDistance = Infinity;
    samples.forEach((sample, index) => {
      const distance = Math.abs((Number(sample?.t) || 0) - target);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    return { sample: samples[bestIndex], index: bestIndex };
  }

  function formatSeconds(value) {
    if (typeof formatTelemetrySeconds === 'function') return formatTelemetrySeconds(value);
    const number = Number(value);
    return Number.isFinite(number) ? `${number.toFixed(2)}s` : '—';
  }

  function formatNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(4) : '—';
  }

  function bindRewardTooltip() {
    const canvas = node('telemetry-reward-canvas');
    const samples = telemetrySamples();
    if (!canvas || !samples.length || canvas.dataset.visualizationInteraction === 'reward') return;
    canvas.dataset.visualizationInteraction = 'reward';
    canvas.tabIndex = 0;
    canvas.title = '悬停查看逐帧值；使用左右方向键移动统一时间轴';
    canvas.addEventListener('pointermove', (event) => {
      const selected = sampleAtPointer(canvas, event, telemetrySamples());
      if (!selected) return;
      const sample = selected.sample;
      showTooltip(
        canvas,
        event,
        `<strong>帧 ${selected.index + 1}</strong><span>时间 ${escapeHtml(formatSeconds(sample.t))}</span><span>奖励 ${escapeHtml(formatNumber(sample.reward))}</span><span>${sample.fall ? '跌倒' : sample.done ? '完成' : '进行中'}</span>`,
      );
    });
    canvas.addEventListener('pointerleave', () => hideTooltip(canvas));
    canvas.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const input = node('telemetry-scrub-input');
      if (!input || input.disabled) return;
      event.preventDefault();
      const step = event.key === 'ArrowRight' ? 1 : -1;
      input.value = String(Math.max(0, Math.min(Number(input.max) || 0, Number(input.value || 0) + step)));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  function bindHeatmapTooltip(canvasId, field) {
    const canvas = node(canvasId);
    const samples = telemetrySamples();
    if (!canvas || !samples.length || canvas.dataset.visualizationInteraction === field) return;
    canvas.dataset.visualizationInteraction = field;
    canvas.tabIndex = 0;
    canvas.title = '悬停查看维度值';
    canvas.addEventListener('pointermove', (event) => {
      const selected = sampleAtPointer(canvas, event, telemetrySamples());
      const vector = selected?.sample?.[field];
      if (!selected || !Array.isArray(vector) || !vector.length) return;
      const rect = canvas.getBoundingClientRect();
      const y = (event.clientY - rect.top) * (canvas.height / Math.max(1, rect.height));
      const dim = Math.max(0, Math.min(vector.length - 1, Math.floor(((y - 8) / Math.max(1, canvas.height - 24)) * Math.min(vector.length, 48))));
      showTooltip(
        canvas,
        event,
        `<strong>${escapeHtml(field)} · 维度 ${dim}</strong><span>帧 ${selected.index + 1} · ${escapeHtml(formatSeconds(selected.sample.t))}</span><span>值 ${escapeHtml(formatNumber(vector[dim]))}</span>`,
      );
    });
    canvas.addEventListener('pointerleave', () => hideTooltip(canvas));
  }

  function telemetryCsv() {
    const samples = telemetrySamples();
    if (!samples.length) return '';
    const columns = ['t', 'reward', 'done', 'fall', 'observation', 'action'];
    const rows = [columns];
    samples.forEach((sample) => rows.push(columns.map((key) => Array.isArray(sample?.[key]) ? JSON.stringify(sample[key]) : sample?.[key])));
    return rows.map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
  }

  function runComparisonCsv() {
    if (typeof runsForCurrentModel !== 'function') return '';
    const runs = runsForCurrentModel().slice(0, Number(node('run-compare-count')?.value) || 5);
    const columns = ['index', 'id', 'status', 'backend', 'createdAt', 'reward', 'successRate', 'fallRate', 'episodeLength', 'iterations'];
    const rows = [columns];
    runs.forEach((run, index) => rows.push([
      index + 1,
      run?.id,
      run?.status,
      run?.backend,
      run?.createdAt,
      run?.metrics?.reward,
      run?.metrics?.successRate,
      run?.metrics?.fallRate,
      run?.metrics?.episodeLength,
      run?.metrics?.iterations,
    ]));
    return rows.map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
  }

  function addActionBar(host, actions) {
    if (!host || host.querySelector(`.${ACTION_BAR_CLASS}`)) return;
    const bar = document.createElement('div');
    bar.className = ACTION_BAR_CLASS;
    actions.forEach(({ label, title, onClick }) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button button-quiet button-small';
      button.textContent = label;
      if (title) button.title = title;
      button.addEventListener('click', onClick);
      bar.append(button);
    });
    host.insertBefore(bar, host.firstChild);
  }

  function bindExportActions() {
    const visuals = node('telemetry-visuals');
    addActionBar(visuals, [{
      label: '下载遥测 CSV',
      title: '导出当前页面已导入的原始遥测，不上传数据',
      onClick: () => {
        const csv = telemetryCsv();
        if (csv) download('rdk-telemetry.csv', csv, 'text/csv;charset=utf-8');
      },
    }]);
    const compare = node('run-comparison-chart');
    addActionBar(compare, [{
      label: '下载 Run CSV',
      title: '导出当前 Run 对比表',
      onClick: () => {
        const csv = runComparisonCsv();
        if (csv) download('rdk-run-comparison.csv', csv, 'text/csv;charset=utf-8');
      },
    }]);
  }

  function bind() {
    bindRewardTooltip();
    bindHeatmapTooltip('telemetry-obs-heatmap', 'observation');
    bindHeatmapTooltip('telemetry-action-heatmap', 'action');
    bindExportActions();
  }

  bind();
  const observer = new MutationObserver(bind);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
})();
