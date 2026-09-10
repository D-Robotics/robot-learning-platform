/**
 * Pure telemetry/presentation logic shared by the Sim2Real web UI.
 *
 * This file is a classic script (no import/export) so index.html can load it
 * BEFORE app.js, which boots synchronously at the top level. It also defines
 * itself on globalThis so vitest can execute it as a module side effect and
 * assert behavior directly (services/sim2real-web/telemetry-core.test.ts).
 *
 * Everything here must stay DOM-free and dependency-free: app.js keeps thin
 * delegation wrappers with the same names, so call sites never change.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SimTelemetryCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';

  function finiteNumber(value) {
    const number = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function booleanValue(value) {
    if (value === true || value === false) return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') return ['1', 'true', 'yes', 'y'].includes(value.toLowerCase());
    return false;
  }

  function formatTelemetrySeconds(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric.toFixed(2) + 's' : '—';
  }

  function formatTelemetryRate(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return '—';
    const rounded = Math.round(numeric * 10) / 10;
    return rounded + 'Hz';
  }

  // Retraining advice verdicts are a closed server contract. Map a raw verdict
  // to its presentation surface, and degrade an unknown/missing/non-string
  // value to the neutral "insufficient-evidence" verdict instead of inventing a
  // success state. `recognized` lets the UI state the degradation explicitly.
  const RETRAINING_VERDICTS = Object.freeze({
    'retrain-recommended': { label: '建议重训', className: 'is-retrain-recommended' },
    healthy: { label: '板端行为健康', className: 'is-healthy' },
    'insufficient-evidence': { label: '证据不足（待补）', className: 'is-insufficient-evidence' },
  });

  function retrainingVerdict(verdict) {
    const raw = typeof verdict === 'string' ? verdict : '';
    if (Object.prototype.hasOwnProperty.call(RETRAINING_VERDICTS, raw)) {
      return { key: raw, recognized: true, ...RETRAINING_VERDICTS[raw] };
    }
    return {
      key: 'insufficient-evidence',
      recognized: false,
      ...RETRAINING_VERDICTS['insufficient-evidence'],
    };
  }

  // A re-training signal may legitimately be incomparable (no reference
  // trajectory, no telemetry window). Report null so the UI can say
  // "不可比/无数据" instead of fabricating 0.000. Numeric strings stay
  // incomparable on purpose: the server contract sends a number or null.
  function formatRetrainingMeasure(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(3) : null;
  }

  // Pre-filled training request for the operator-confirmed retrain action.
  // Pure and deterministic: the caller resolves the model id and supplies the
  // idempotency key, so the body shape is unit testable without a DOM, crypto,
  // or network. The panel POSTs this only after an explicit click plus
  // confirmation — the analysis itself never submits a run.
  function retrainingRequest(input) {
    const record = input?.record || {};
    const suggested = input?.advice?.suggestedTraining;
    const taskId = suggested?.taskId ?? record.taskId;
    return {
      modelId: input?.modelId,
      backend: 'local',
      ...(taskId ? { taskId } : {}),
      idempotencyKey: input?.idempotencyKey,
      training: suggested?.training ?? { profile: 'standard' },
    };
  }

  // Keep browser import capacity aligned with SIM2REAL_CONTRACT_LIMITS on the
  // server. RDK Duck manifests may legitimately declare vectors larger than
  // MicroDuck's 61/14 contract; truncating them here would make valid telemetry
  // impossible to publish.
  const MAX_TELEMETRY_VECTOR_VALUES = 4096;

  function normalizeTelemetrySample(value) {
    if (!value || typeof value !== 'object') return null;
    const raw = value;
    const timestamp = finiteNumber(raw.t ?? raw.time ?? raw.timestamp);
    if (timestamp === null) return null;
    return {
      t: timestamp,
      ...(Array.isArray(raw.observation)
        ? { observation: raw.observation.slice(0, MAX_TELEMETRY_VECTOR_VALUES) }
        : {}),
      ...(Array.isArray(raw.action)
        ? { action: raw.action.slice(0, MAX_TELEMETRY_VECTOR_VALUES) }
        : {}),
      ...(finiteNumber(raw.reward) !== null ? { reward: finiteNumber(raw.reward) } : {}),
      ...(raw.done != null ? { done: booleanValue(raw.done) } : {}),
      ...(raw.fall != null ? { fall: booleanValue(raw.fall) } : {}),
    };
  }

  const MAX_TELEMETRY_IMPORT_SAMPLES = 100_000;

  function parseTelemetryText(text) {
    const lines = String(text || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.length) throw new Error('遥测文件为空');
    const values = [];
    let skipped = 0;
    let header = null;
    const appendValues = (items) => {
      if (values.length + items.length > MAX_TELEMETRY_IMPORT_SAMPLES) {
        throw new Error(`遥测文件超过 ${MAX_TELEMETRY_IMPORT_SAMPLES} 帧上限，请先分段导入`);
      }
      values.push(...items);
    };
    for (const line of lines) {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        skipped += 1;
        continue;
      }
      if (Array.isArray(parsed)) {
        appendValues(parsed);
        continue;
      }
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.samples)) {
        appendValues(parsed.samples);
        header = parsed;
        continue;
      }
      if (parsed?.type === 'header') {
        header = parsed;
        continue;
      }
      appendValues([parsed]);
    }
    const samples = values.map(normalizeTelemetrySample).filter(Boolean);
    if (!samples.length) throw new Error('没有找到带 t/time 时间戳的有效遥测样本');
    const firstTimestamp = samples[0].t;
    const lastTimestamp = samples[samples.length - 1].t;
    const durationSeconds = Math.max(0, lastTimestamp - firstTimestamp);
    const rewardValues = samples.map((sample) => sample.reward).filter((value) => value != null);
    return {
      fileName: '',
      source: header?.source || 'import',
      contractId: header?.contractId || '',
      samples,
      skipped,
      summary: {
        sampleCount: samples.length,
        durationSeconds,
        sampleRateHz:
          durationSeconds > 0 ? Math.round(((samples.length - 1) / durationSeconds) * 10) / 10 : null,
        firstTimestamp,
        lastTimestamp,
        rewardMean: rewardValues.length
          ? Math.round(
              (rewardValues.reduce((sum, value) => sum + value, 0) / rewardValues.length) * 1000,
            ) / 1000
          : null,
        doneCount: samples.filter((sample) => sample.done).length,
        fallCount: samples.filter((sample) => sample.fall).length,
      },
    };
  }

  /**
   * IMU 快照有两种形状：平铺 {x,y,z,w}（旧遥测节点）与嵌套
   * {quaternion:{...}, gyro:{...}}（新版遥测节点）。统一在这里解析，
   * 两条数据路径（罗盘、顶部航向）都用它，避免升级遥测节点后罗盘停转。
   */
  function stationImuQuaternion(originbot) {
    const imu = (originbot && originbot.imu) || {};
    const q = imu.quaternion && typeof imu.quaternion === 'object' ? imu.quaternion : imu;
    const x = Number(q.x);
    const y = Number(q.y);
    const z = Number(q.z);
    const w = Number(q.w);
    if (![x, y, z, w].every(Number.isFinite)) return null;
    if (Math.hypot(x, y, z, w) < 1e-6) return null;
    return { x, y, z, w };
  }

  /**
   * The board agent exposes adapter telemetry under both `originbot`
   * (legacy clients) and `telemetry` (generic clients). Prefer the generic
   * field, skip EMPTY objects instead of trusting their truthiness, and fall
   * back to {} so every caller can branch on content, not shape.
   */
  function stationTelemetrySnapshot(status) {
    for (const candidate of [status?.telemetry, status?.originbot]) {
      if (candidate && typeof candidate === 'object' && Object.keys(candidate).length > 0) {
        return candidate;
      }
    }
    return {};
  }

  function telemetryHasData(snapshot) {
    return Boolean(snapshot) && typeof snapshot === 'object' && Object.keys(snapshot).length > 0;
  }

  /**
   * Power surface view for the host-station metric card: telemetry battery
   * voltage wins, then the generic station power.voltage, then current-only.
   * Text and bar ratio must consume the SAME display voltage — the bar going
   * dark while text shows a voltage is exactly the inconsistency this
   * function exists to prevent.
   */
  function stationPowerView(status) {
    const telemetry = stationTelemetrySnapshot(status);
    const power = status?.power || {};
    const batteryVoltage = Number(telemetry.batteryVoltage ?? telemetry.battery?.voltage);
    const isBattery = Number.isFinite(batteryVoltage);
    const displayVoltage = isBattery ? batteryVoltage : Number(power.voltage);
    const hasVoltage = Number.isFinite(displayVoltage);
    const owner = status?.profile?.displayName || status?.adapterId || '设备';
    let powerSubText;
    if (isBattery) powerSubText = `${owner} 电池`;
    else if (hasVoltage) powerSubText = `${owner} 电源电压`;
    else if (Number.isFinite(power.current)) powerSubText = `电流 ${Number(power.current).toFixed(1)}A`;
    else powerSubText = '无电源监控';
    return {
      telemetry,
      isBattery,
      hasVoltage,
      powerText: hasVoltage ? `${displayVoltage.toFixed(isBattery ? 2 : 1)}V` : '--',
      powerSubText,
      powerRatio: hasVoltage
        ? Math.max(0, Math.min(1, (displayVoltage - 3.3) / (5.4 - 3.3)))
        : NaN,
    };
  }

  /**
   * Simulator integration labels. Browser simulator naming must follow the
   * SELECTED profile, not assume MicroDuck — a custom hardware profile with
   * a browser adapter must never be labelled as the MicroDuck reference.
   */
  function simulatorStatusLabels(profile, browserAvailable) {
    const microduckProduct = profile?.id === 'microduck';
    const originbotProduct = profile?.id === 'originbot';
    const displayName = profile?.displayName;
    return {
      title: browserAvailable ? `浏览器 ${displayName}` : `${displayName} 仿真适配器`,
      detail: browserAvailable
        ? microduckProduct
          ? '固定官方参考策略'
          : `${displayName} 浏览器仿真适配器`
        : microduckProduct
          ? '等待挂载经过审核的静态 bundle'
          : originbotProduct
            ? 'OriginBot 使用外部仿真/遥测适配器'
            : '当前产品线等待仿真适配器',
    };
  }

  // --- Presentation helpers -------------------------------------------------
  // The DOM renderers only ever ask these for strings, so the HTML escaper and
  // the locale date formatter live here where they can be asserted without
  // booting the app.
  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function formatDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  // Run statuses are a closed server contract: an unknown value degrades to a
  // neutral surface instead of guessing success.
  const RUN_TERMINAL_STATUSES = Object.freeze(['completed', 'failed', 'blocked', 'cancelled']);
  const ACTIVE_RUN_STATUSES = Object.freeze(['queued', 'running']);

  function isTerminalRunStatus(status) {
    return RUN_TERMINAL_STATUSES.includes(String(status || '').toLowerCase());
  }

  function isActiveRunStatus(status) {
    return ACTIVE_RUN_STATUSES.includes(String(status || '').toLowerCase());
  }

  function stateClass(status) {
    const normalized = String(status || '').toLowerCase();
    if (['ready', 'completed', 'success'].includes(normalized)) return 'state-success';
    if (['blocked', 'queued', 'partial', 'running', 'planned'].includes(normalized)) {
      return 'state-partial';
    }
    if (['failed', 'error'].includes(normalized)) return 'state-error';
    return 'state-neutral';
  }

  function statusLabel(status) {
    return (
      {
        queued: '排队中',
        running: '运行中',
        completed: '已完成',
        ready: '可运行',
        planned: '已计划',
        blocked: '已阻断',
        failed: '失败',
        cancelled: '已取消',
        registered: '已登记',
        demo: '演示样例',
      }[String(status || '').toLowerCase()] || String(status || '未知')
    );
  }

  // Run metric cards share one numeric vocabulary: a value outside the metric
  // contract reads as an em dash instead of a fabricated 0.
  function metricPercent(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const percent = value >= 0 && value <= 1 ? value * 100 : value;
    return percent >= 0 && percent <= 100 ? Math.round(percent) : null;
  }

  function formatMetricPercent(value) {
    const percent = metricPercent(value);
    return percent === null ? '—' : percent + '%';
  }

  function formatMetricNumber(value, digits) {
    return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';
  }

  // Evidence provenance. A synthetic fixture and a mock run stay visible for
  // review, but neither may satisfy a real-evaluation predicate.
  function isSyntheticEvidence(evidence, run) {
    return evidence?.source === 'demo-fixture' || run?.evaluation?.replay?.source === 'demo-fixture';
  }

  function hasPersistedEvaluation(run) {
    return Boolean(run?.evaluation?.replay && Number(run.evaluation.replay.sampleCount) > 0);
  }

  // A raw browser import is useful for the local review step, but it is not a
  // release-grade evaluation. Keep this broader predicate for review/navigation
  // so ordinary replay remains visible after refresh; release decisions use the
  // stricter hasReleaseGradeEvidence below. Mock and demo-fixture evidence
  // remain gated.
  function hasRealEvaluation(evidence, run) {
    if (run?.mock === true || isSyntheticEvidence(evidence, run)) return false;
    return Boolean(
      hasPersistedEvaluation(run) ||
        (run?.metrics && typeof run.metrics.successRate === 'number') ||
        (evidence?.publishedRunId === run?.id && evidence?.summary?.sampleCount > 0),
    );
  }

  // A release may advance only on metrics returned by a real worker or on an
  // explicitly attested replay. `source: "board-agent"` is an uploader's claim,
  // so it remains useful for review/replay but cannot prove that an X5 produced
  // the samples. The optional attested flag is intentionally read-only here;
  // trusted adapters may add it without changing the existing API shape.
  function hasReleaseGradeEvidence(evidence, run) {
    if (run?.mock === true || isSyntheticEvidence(evidence, run)) return false;
    const metrics = run?.metrics;
    const workerMetrics = Boolean(
      run &&
        ['local', 'robogo'].includes(String(run.backend || '').toLowerCase()) &&
        metrics?.contractValid === true &&
        typeof metrics.successRate === 'number',
    );
    const replay = run?.evaluation?.replay;
    const attestedReplay = Boolean(replay?.attested === true && Number(replay.sampleCount) > 0);
    return workerMetrics || attestedReplay;
  }

  // Diverging scale for the heatmaps: blue (negative) → canvas-light (zero) →
  // red (positive), so sign and magnitude stay readable on the light theme.
  function telemetryDivergingColor(value) {
    const stops = [
      [-1, 37, 99, 235],
      [-0.25, 189, 214, 252],
      [0, 251, 251, 249],
      [0.25, 252, 216, 200],
      [1, 220, 38, 38],
    ];
    const v = Math.max(-1, Math.min(1, value));
    for (let i = 1; i < stops.length; i++) {
      if (v <= stops[i][0]) {
        const [p0, r0, g0, b0] = stops[i - 1];
        const [p1, r1, g1, b1] = stops[i];
        const f = (v - p0) / (p1 - p0 || 1);
        return (
          'rgb(' +
          Math.round(r0 + (r1 - r0) * f) +
          ', ' +
          Math.round(g0 + (g1 - g0) * f) +
          ', ' +
          Math.round(b0 + (b1 - b0) * f) +
          ')'
        );
      }
    }
    return 'rgb(255, 144, 152)';
  }

  return {
    MAX_TELEMETRY_VECTOR_VALUES,
    MAX_TELEMETRY_IMPORT_SAMPLES,
    finiteNumber,
    booleanValue,
    formatTelemetrySeconds,
    formatTelemetryRate,
    retrainingVerdict,
    formatRetrainingMeasure,
    retrainingRequest,
    normalizeTelemetrySample,
    parseTelemetryText,
    stationImuQuaternion,
    stationTelemetrySnapshot,
    telemetryHasData,
    stationPowerView,
    simulatorStatusLabels,
    escapeHtml,
    formatDate,
    isTerminalRunStatus,
    isActiveRunStatus,
    stateClass,
    statusLabel,
    metricPercent,
    formatMetricPercent,
    formatMetricNumber,
    isSyntheticEvidence,
    hasPersistedEvaluation,
    hasRealEvaluation,
    hasReleaseGradeEvidence,
    telemetryDivergingColor,
  };
});
