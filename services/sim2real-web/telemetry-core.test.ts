import { describe, expect, it, beforeAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Behavior-level regression tests for the browser telemetry logic.
 *
 * The browser bundle is a classic (non-module) script, so the pure logic it
 * needs lives in public/telemetry-core.js and publishes
 * globalThis.SimTelemetryCore. The dynamic import below executes that exact
 * shipped file (the package is "type": "module", so the UMD branch that
 * assigns module.exports stays dormant and the global path runs, just like
 * a <script> tag) while keeping the file instrumentable for coverage.
 *
 * Each block names the commit whose bug it guards against so the suite stays
 * a "corpse detector" for regressions that were already fixed once.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

let core: any;

beforeAll(async () => {
  await import(pathToFileURL(path.join(here, 'public', 'telemetry-core.js')).href);
  core = (globalThis as Record<string, unknown>).SimTelemetryCore;
  if (!core) throw new Error('telemetry-core.js did not publish globalThis.SimTelemetryCore');
});

describe('formatTelemetrySeconds / formatTelemetryRate', () => {
  it('renders finite seconds with two decimals', () => {
    expect(core.formatTelemetrySeconds(1.5)).toBe('1.50s');
    expect(core.formatTelemetrySeconds('0.25')).toBe('0.25s');
  });

  it('renders an em dash for missing seconds', () => {
    expect(core.formatTelemetrySeconds(NaN)).toBe('—');
    expect(core.formatTelemetrySeconds('n/a')).toBe('—');
    expect(core.formatTelemetrySeconds(undefined)).toBe('—');
  });

  it('renders positive rates rounded to 0.1 Hz', () => {
    expect(core.formatTelemetryRate(5)).toBe('5Hz');
    expect(core.formatTelemetryRate(4.96)).toBe('5Hz');
  });

  it('renders an em dash for zero, negative, or missing rates', () => {
    expect(core.formatTelemetryRate(0)).toBe('—');
    expect(core.formatTelemetryRate(-3)).toBe('—');
    expect(core.formatTelemetryRate('n/a')).toBe('—');
  });
});

describe('stationTelemetrySnapshot (0b35d41, 7ee8481)', () => {
  it('prefers the generic telemetry field over legacy originbot', () => {
    const snapshot = core.stationTelemetrySnapshot({
      telemetry: { batteryVoltage: 11.1 },
      originbot: { batteryVoltage: 7.4 },
    });
    expect(snapshot).toEqual({ batteryVoltage: 11.1 });
  });

  it('falls back to originbot when telemetry is empty, not merely falsy', () => {
    // The pre-0b35d41 code used `status.telemetry || status.originbot`, which
    // returned the empty object and blanked the panel for boards that keep
    // sending `telemetry: {}` alongside real legacy payloads.
    const snapshot = core.stationTelemetrySnapshot({
      telemetry: {},
      originbot: { batteryVoltage: 7.4 },
    });
    expect(snapshot).toEqual({ batteryVoltage: 7.4 });
  });

  it('returns {} for missing or empty snapshots', () => {
    expect(core.stationTelemetrySnapshot({})).toEqual({});
    expect(core.stationTelemetrySnapshot({ telemetry: {}, originbot: {} })).toEqual({});
    expect(core.stationTelemetrySnapshot(null)).toEqual({});
    expect(core.stationTelemetrySnapshot(undefined)).toEqual({});
  });

  it('telemetryHasData marks empty snapshots offline (7ee8481)', () => {
    // An agent that reports `telemetry: {}` must NOT light the compare panel
    // live badge: the pre-7ee8481 truthiness check did exactly that.
    expect(core.telemetryHasData(core.stationTelemetrySnapshot({ telemetry: {} }))).toBe(false);
    expect(core.telemetryHasData(core.stationTelemetrySnapshot({}))).toBe(false);
    expect(core.telemetryHasData({ batteryVoltage: 7.4 })).toBe(true);
  });
});

describe('stationImuQuaternion (flat/nested shapes, 10858af)', () => {
  it('parses the legacy flat imu shape', () => {
    expect(core.stationImuQuaternion({ imu: { x: 0, y: 0, z: 0.7071, w: 0.7071 } })).toEqual({
      x: 0,
      y: 0,
      z: 0.7071,
      w: 0.7071,
    });
  });

  it('parses the nested quaternion shape', () => {
    expect(
      core.stationImuQuaternion({ imu: { quaternion: { x: 0, y: 0, z: 0, w: 1 }, gyro: {} } }),
    ).toEqual({ x: 0, y: 0, z: 0, w: 1 });
  });

  it('rejects zero-norm quaternions instead of rendering a bogus heading', () => {
    expect(core.stationImuQuaternion({ imu: { x: 0, y: 0, z: 0, w: 0 } })).toBeNull();
  });

  it('rejects incomplete or non-finite quaternions', () => {
    expect(core.stationImuQuaternion({ imu: { x: 0, y: 0, z: 0.5 } })).toBeNull();
    expect(core.stationImuQuaternion({ imu: { x: 'a', y: 0, z: 0, w: 1 } })).toBeNull();
    expect(core.stationImuQuaternion({})).toBeNull();
    expect(core.stationImuQuaternion(null)).toBeNull();
  });
});

describe('stationPowerView (dba930f)', () => {
  it('battery voltage wins and renders with two decimals', () => {
    const view = core.stationPowerView({
      telemetry: { batteryVoltage: 7.41 },
      power: { voltage: 5.0, current: 1.2 },
      profile: { displayName: 'OriginBot' },
    });
    expect(view.powerText).toBe('7.41V');
    expect(view.powerSubText).toBe('OriginBot 电池');
    // 7.41V exceeds the 3.3–5.4V bar window; the ratio clamps to 1.
    expect(view.powerRatio).toBe(1);
    expect(view.isBattery).toBe(true);
  });

  it('falls back to generic power voltage with one decimal', () => {
    const view = core.stationPowerView({
      telemetry: {},
      power: { voltage: 5.05 },
      profile: { displayName: 'CustomBoard' },
    });
    expect(view.powerText).toBe('5.0V');
    expect(view.powerSubText).toBe('CustomBoard 电源电压');
    expect(view.isBattery).toBe(false);
  });

  it('bar and text consume the same display voltage', () => {
    // The pre-dba930f code computed the battery bar ratio from the telemetry
    // voltage only, so a station reporting only power.voltage showed text
    // with a dark bar. Both must stay consistent.
    const view = core.stationPowerView({ telemetry: {}, power: { voltage: 4.8 } });
    expect(view.powerText).toBe('4.8V');
    expect(Number.isFinite(view.powerRatio)).toBe(true);
    expect(view.powerRatio).toBeCloseTo((4.8 - 3.3) / 2.1, 5);
  });

  it('clamps the bar ratio to [0, 1] for out-of-range voltages', () => {
    expect(core.stationPowerView({ power: { voltage: 9 } }).powerRatio).toBe(1);
    expect(core.stationPowerView({ power: { voltage: 1 } }).powerRatio).toBe(0);
  });

  it('degrades to current-only, then to 无电源监控', () => {
    const currentOnly = core.stationPowerView({ power: { current: 1.24 } });
    expect(currentOnly.powerText).toBe('--');
    expect(currentOnly.powerSubText).toBe('电流 1.2A');
    expect(Number.isNaN(currentOnly.powerRatio)).toBe(true);

    const nothing = core.stationPowerView({ power: {} });
    expect(nothing.powerText).toBe('--');
    expect(nothing.powerSubText).toBe('无电源监控');
  });

  it('names the adapter when no profile is selected', () => {
    const view = core.stationPowerView({ telemetry: { batteryVoltage: 7.4 }, adapterId: 'custom' });
    expect(view.powerSubText).toBe('custom 电池');
  });
});

describe('simulatorStatusLabels (31c5150)', () => {
  it('labels the browser simulator with the selected profile, not MicroDuck', () => {
    const labels = core.simulatorStatusLabels(
      { id: 'custom-robot', displayName: 'CustomBot' },
      true,
    );
    expect(labels.title).toBe('浏览器 CustomBot');
    expect(labels.detail).toBe('CustomBot 浏览器仿真适配器');
  });

  it('keeps the MicroDuck reference-policy wording', () => {
    const labels = core.simulatorStatusLabels({ id: 'microduck', displayName: 'MicroDuck' }, true);
    expect(labels.title).toBe('浏览器 MicroDuck');
    expect(labels.detail).toBe('固定官方参考策略');
  });

  it('explains the waiting state per product line', () => {
    const microduck = core.simulatorStatusLabels(
      { id: 'microduck', displayName: 'MicroDuck' },
      false,
    );
    expect(microduck.title).toBe('MicroDuck 仿真适配器');
    expect(microduck.detail).toBe('等待挂载经过审核的静态 bundle');

    const originbot = core.simulatorStatusLabels(
      { id: 'originbot', displayName: 'OriginBot' },
      false,
    );
    expect(originbot.detail).toBe('OriginBot 使用外部仿真/遥测适配器');

    const generic = core.simulatorStatusLabels({ id: 'custom', displayName: 'Custom' }, false);
    expect(generic.detail).toBe('当前产品线等待仿真适配器');
  });
});

describe('normalizeTelemetrySample', () => {
  it('accepts t, time, and timestamp keys and drops non-objects', () => {
    expect(core.normalizeTelemetrySample({ t: 1.5, reward: 0.25 })).toEqual({
      t: 1.5,
      reward: 0.25,
    });
    expect(core.normalizeTelemetrySample({ time: 2 })).toEqual({ t: 2 });
    expect(core.normalizeTelemetrySample({ timestamp: 3 })).toEqual({ t: 3 });
    expect(core.normalizeTelemetrySample(null)).toBeNull();
    expect(core.normalizeTelemetrySample('x')).toBeNull();
    expect(core.normalizeTelemetrySample({ reward: 1 })).toBeNull();
  });

  it('coerces done/fall flags and keeps only finite rewards', () => {
    expect(core.normalizeTelemetrySample({ t: 1, done: 'true', fall: 0 })).toEqual({
      t: 1,
      done: true,
      fall: false,
    });
    expect(core.normalizeTelemetrySample({ t: 1, reward: 'n/a' })).toEqual({ t: 1 });
  });

  it('truncates oversized vectors to the import contract limit', () => {
    const long = { t: 1, observation: new Array(5000).fill(0.1), action: new Array(5000).fill(0) };
    const sample = core.normalizeTelemetrySample(long);
    expect(sample.observation).toHaveLength(core.MAX_TELEMETRY_VECTOR_VALUES);
    expect(sample.action).toHaveLength(core.MAX_TELEMETRY_VECTOR_VALUES);
  });

  it('coerces numeric-string and boolean timestamps but rejects non-numeric ones', () => {
    expect(core.normalizeTelemetrySample({ t: '1.25' })).toEqual({ t: 1.25 });
    // finiteNumber() routes through Number(), so '' and false collapse to 0 and
    // stay. Only values Number() cannot make finite are dropped.
    expect(core.normalizeTelemetrySample({ t: '' })).toEqual({ t: 0 });
    expect(core.normalizeTelemetrySample({ t: false })).toEqual({ t: 0 });
    expect(core.normalizeTelemetrySample({ t: 'abc' })).toBeNull();
    expect(core.normalizeTelemetrySample({ t: NaN })).toBeNull();
    expect(core.normalizeTelemetrySample([1, 2])).toBeNull();
  });

  it('prefers t over time over timestamp', () => {
    expect(core.normalizeTelemetrySample({ timestamp: 4, t: 3 })).toEqual({ t: 3 });
    expect(core.normalizeTelemetrySample({ time: 5, timestamp: 4 })).toEqual({ t: 5 });
    expect(core.normalizeTelemetrySample({ t: null, time: 5 })).toEqual({ t: 5 });
  });

  it('keeps empty vectors and a zero reward instead of dropping them as falsy', () => {
    expect(core.normalizeTelemetrySample({ t: 1, observation: [], action: [], reward: 0 })).toEqual(
      { t: 1, observation: [], action: [], reward: 0 },
    );
  });

  it('drops non-array vectors, unknown fields, and non-coercible rewards', () => {
    expect(core.normalizeTelemetrySample({ t: 1, observation: 'abc' })).toEqual({ t: 1 });
    expect(core.normalizeTelemetrySample({ t: 1, foo: 'bar' })).toEqual({ t: 1 });
    expect(core.normalizeTelemetrySample({ t: 1, reward: undefined })).toEqual({ t: 1 });
    expect(core.normalizeTelemetrySample({ t: 1, reward: NaN })).toEqual({ t: 1 });
    expect(core.normalizeTelemetrySample({ t: 1, reward: Infinity })).toEqual({ t: 1 });
  });

  it('coerces a null or boolean reward through Number()', () => {
    // reward has no `!= null` gate (unlike done/fall), so finiteNumber() maps
    // null/false/'' to 0 and true to 1. This asymmetry is the shipped
    // behavior and is pinned here so the extraction cannot silently change it.
    expect(core.normalizeTelemetrySample({ t: 1, reward: null })).toEqual({ t: 1, reward: 0 });
    expect(core.normalizeTelemetrySample({ t: 1, reward: false })).toEqual({ t: 1, reward: 0 });
    expect(core.normalizeTelemetrySample({ t: 1, reward: true })).toEqual({ t: 1, reward: 1 });
    expect(core.normalizeTelemetrySample({ t: 1, reward: '' })).toEqual({ t: 1, reward: 0 });
  });

  it('keeps an explicit false done/fall flag but drops null and undefined', () => {
    expect(core.normalizeTelemetrySample({ t: 1, done: false, fall: false })).toEqual({
      t: 1,
      done: false,
      fall: false,
    });
    expect(core.normalizeTelemetrySample({ t: 1, done: null })).toEqual({ t: 1 });
    expect(core.normalizeTelemetrySample({ t: 1, fall: undefined })).toEqual({ t: 1 });
  });
});

describe('parseTelemetryText', () => {
  it('parses JSONL into samples with a summary', () => {
    const evidence = core.parseTelemetryText(
      '{"t":0,"reward":0.1}\n{"t":0.5,"reward":0.4}\n{"t":1.0,"reward":0.5,"done":true}\n',
    );
    expect(evidence.samples).toHaveLength(3);
    expect(evidence.source).toBe('import');
    expect(evidence.contractId).toBe('');
    expect(evidence.summary.sampleCount).toBe(3);
    expect(evidence.summary.durationSeconds).toBe(1);
    expect(evidence.summary.sampleRateHz).toBe(2);
    expect(evidence.summary.rewardMean).toBeCloseTo(0.333, 3);
    expect(evidence.summary.doneCount).toBe(1);
    expect(evidence.summary.fallCount).toBe(0);
  });

  it('accepts a header line plus a batched {samples: [...]} envelope', () => {
    const evidence = core.parseTelemetryText(
      [
        '{"type":"header","source":"demo-fixture","contractId":"microduck-policy-v1"}',
        '{"samples":[{"t":0,"reward":1},{"t":1,"reward":1,"fall":true}]}',
      ].join('\n'),
    );
    // The envelope line carries its own header role and overwrites the
    // standalone header, so source falls back to 'import'.
    expect(evidence.source).toBe('import');
    expect(evidence.samples).toHaveLength(2);
    expect(evidence.summary.fallCount).toBe(1);
  });

  it('keeps provenance from a standalone header line (demo fixture shape)', () => {
    // Exact shape of public/demo/microduck-telemetry-sample.jsonl.
    const evidence = core.parseTelemetryText(
      [
        '{"type":"header","format":"microduck-trajectory-v1","source":"demo-fixture","contractId":"microduck-policy-v1","sampleHz":50}',
        '{"type":"step","t":0.0,"reward":0.0,"done":false}',
        '{"type":"step","t":0.02,"reward":0.08,"done":false}',
      ].join('\n'),
    );
    expect(evidence.source).toBe('demo-fixture');
    expect(evidence.contractId).toBe('microduck-policy-v1');
    expect(evidence.samples).toHaveLength(2);
    expect(evidence.summary.sampleRateHz).toBe(50);
  });

  it('accepts an inline JSON array of samples', () => {
    const evidence = core.parseTelemetryText('[{"t":0},{"t":2}]\n');
    expect(evidence.samples).toHaveLength(2);
    expect(evidence.summary.sampleRateHz).toBe(0.5);
  });

  it('skips malformed lines instead of failing the import', () => {
    const evidence = core.parseTelemetryText('not-json\n{"t":0}\n');
    expect(evidence.samples).toHaveLength(1);
    expect(evidence.skipped).toBe(1);
  });

  it('rejects empty input and timestamp-less samples', () => {
    expect(() => core.parseTelemetryText('')).toThrow('遥测文件为空');
    expect(() => core.parseTelemetryText('\n  \n')).toThrow('遥测文件为空');
    expect(() => core.parseTelemetryText('{"reward":1}')).toThrow(
      '没有找到带 t/time 时间戳的有效遥测样本',
    );
  });

  it('drops blank lines, accepts CRLF, and does not require a trailing newline', () => {
    const crlf = core.parseTelemetryText('{"t":0}\r\n\r\n{"t":1}\r\n');
    expect(crlf.samples).toHaveLength(2);
    expect(crlf.skipped).toBe(0);
    const noTrailing = core.parseTelemetryText('{"t":0}\n{"t":1}');
    expect(noTrailing.samples).toHaveLength(2);
    expect(noTrailing.summary.lastTimestamp).toBe(1);
  });

  it('counts only unparseable lines as skipped', () => {
    // `5` is valid JSON but normalizes to nothing, so it is dropped silently;
    // only the unparseable line increments `skipped`.
    const evidence = core.parseTelemetryText('nope\n5\n{"t":0}\n');
    expect(evidence.samples).toHaveLength(1);
    expect(evidence.skipped).toBe(1);
  });

  it('reports a single sample as having no measurable rate', () => {
    const evidence = core.parseTelemetryText('{"t":3}');
    expect(evidence.summary.durationSeconds).toBe(0);
    expect(evidence.summary.sampleRateHz).toBeNull();
    expect(evidence.summary.firstTimestamp).toBe(3);
    expect(evidence.summary.lastTimestamp).toBe(3);
  });

  it('rounds the sample rate to 0.1 Hz and the reward mean to 3 decimals', () => {
    const two = core.parseTelemetryText('{"t":0,"reward":-1}\n{"t":1,"reward":0.5}\n');
    expect(two.summary.sampleRateHz).toBe(1);
    expect(two.summary.rewardMean).toBe(-0.25);
    const four = core.parseTelemetryText('{"t":0}\n{"t":0.5}\n{"t":1}\n{"t":1.5}');
    expect(four.summary.durationSeconds).toBe(1.5);
    expect(four.summary.sampleRateHz).toBe(2);
  });

  it('counts done and fall flags from the normalized samples', () => {
    const evidence = core.parseTelemetryText(
      '{"t":0,"done":true,"fall":"true"}\n{"t":1,"done":1,"fall":0}',
    );
    expect(evidence.summary.doneCount).toBe(2);
    expect(evidence.summary.fallCount).toBe(1);
  });

  it('lets the last header line win and still falls back to import provenance', () => {
    const evidence = core.parseTelemetryText(
      '{"type":"header","source":"a"}\n{"type":"header","source":"b"}\n{"t":0}',
    );
    expect(evidence.source).toBe('b');
    expect(evidence.contractId).toBe('');
  });

  it('treats missing and whitespace-only input as an empty file', () => {
    expect(() => core.parseTelemetryText(undefined)).toThrow('遥测文件为空');
    expect(() => core.parseTelemetryText(0)).toThrow('遥测文件为空');
    expect(() => core.parseTelemetryText('   \n  ')).toThrow('遥测文件为空');
  });

  it('throws when the file exceeds the import frame limit', () => {
    const line =
      '[' + new Array(core.MAX_TELEMETRY_IMPORT_SAMPLES + 1).fill('{"t":1}').join(',') + ']';
    expect(() => core.parseTelemetryText(line)).toThrow(
      `遥测文件超过 ${core.MAX_TELEMETRY_IMPORT_SAMPLES} 帧上限，请先分段导入`,
    );
  });

  it('accepts exactly the import frame limit', () => {
    const line = '[' + new Array(core.MAX_TELEMETRY_IMPORT_SAMPLES).fill('{"t":1}').join(',') + ']';
    const evidence = core.parseTelemetryText(line);
    expect(evidence.samples).toHaveLength(core.MAX_TELEMETRY_IMPORT_SAMPLES);
  });
});

/**
 * The read-only retraining advice panel (telemetry flywheel) renders verdicts
 * and drift measures through these two helpers. They are the honesty seam:
 * an unknown verdict must never read as healthy, and an incomparable measure
 * must never read as 0. Both rules are asserted here so app.js only keeps a
 * thin delegation wrapper.
 */
describe('retrainingVerdict / formatRetrainingMeasure (read-only advice panel)', () => {
  it('returns the three known verdicts with their presentation surface', () => {
    expect(core.retrainingVerdict('retrain-recommended')).toEqual({
      key: 'retrain-recommended',
      recognized: true,
      label: '建议重训',
      className: 'is-retrain-recommended',
    });
    expect(core.retrainingVerdict('healthy')).toEqual({
      key: 'healthy',
      recognized: true,
      label: '板端行为健康',
      className: 'is-healthy',
    });
    expect(core.retrainingVerdict('insufficient-evidence')).toEqual({
      key: 'insufficient-evidence',
      recognized: true,
      label: '证据不足（待补）',
      className: 'is-insufficient-evidence',
    });
  });

  it('degrades unknown, missing, and non-string verdicts to insufficient-evidence', () => {
    for (const value of ['retrain-recommend', '', undefined, null, 42, {}, ['healthy']]) {
      const verdict = core.retrainingVerdict(value);
      expect(verdict.key).toBe('insufficient-evidence');
      expect(verdict.recognized).toBe(false);
      expect(verdict.label).toBe('证据不足（待补）');
      expect(verdict.className).toBe('is-insufficient-evidence');
    }
  });

  it('never lets a degraded verdict carry healthy or retrain semantics', () => {
    // The panel spends `recognized: false` on an explicit "unknown verdict"
    // note, so a malformed payload can never read as success. Verdicts are
    // matched exactly (case included), not normalized.
    const degraded = core.retrainingVerdict('REtrain-recommended');
    expect(degraded.recognized).toBe(false);
    expect(degraded.label).not.toContain('建议重训');
    expect(degraded.className).not.toContain('is-healthy');
    expect(degraded.className).not.toContain('is-retrain-recommended');
  });

  it('formats a finite measure with three decimals', () => {
    expect(core.formatRetrainingMeasure(0.42)).toBe('0.420');
    expect(core.formatRetrainingMeasure(0)).toBe('0.000');
    expect(core.formatRetrainingMeasure(-1.23456)).toBe('-1.235');
    expect(core.formatRetrainingMeasure(120)).toBe('120.000');
  });

  it('returns null for null, undefined, NaN, Infinity, and non-numeric values', () => {
    // null is the "不可比/无数据" signal the DOM renders; 0.000 would be a lie.
    expect(core.formatRetrainingMeasure(null)).toBeNull();
    expect(core.formatRetrainingMeasure(undefined)).toBeNull();
    expect(core.formatRetrainingMeasure(NaN)).toBeNull();
    expect(core.formatRetrainingMeasure(Infinity)).toBeNull();
    expect(core.formatRetrainingMeasure(-Infinity)).toBeNull();
    expect(core.formatRetrainingMeasure('0.42')).toBeNull();
    expect(core.formatRetrainingMeasure({})).toBeNull();
  });

  it('sends the advisory threshold through the same formatter as the value', () => {
    // The panel renders `value / 阈值` from one formatter, so a missing
    // threshold must read as incomparable instead of 0.000.
    const signals = [
      { value: 0.42, threshold: 0.25 },
      { value: null, threshold: null },
    ];
    expect(signals.map((signal) => core.formatRetrainingMeasure(signal.value))).toEqual([
      '0.420',
      null,
    ]);
    expect(signals.map((signal) => core.formatRetrainingMeasure(signal.threshold))).toEqual([
      '0.250',
      null,
    ]);
  });

  it('pre-fills the operator-confirmed retrain request from the advice', () => {
    // The operator-submitted retrain button POSTs exactly this body. The
    // analysis itself never submits; the body builder stays a pure function so
    // the shape can be asserted without a DOM or network.
    expect(
      core.retrainingRequest({
        record: { id: 'run-1', taskId: 'walk' },
        advice: {
          suggestedTraining: {
            taskId: 'kick',
            backend: 'local',
            training: { profile: 'standard', algorithm: 'sac' },
          },
        },
        modelId: 'model-1',
        idempotencyKey: 'retrain-key-1',
      }),
    ).toEqual({
      modelId: 'model-1',
      backend: 'local',
      taskId: 'kick',
      idempotencyKey: 'retrain-key-1',
      training: { profile: 'standard', algorithm: 'sac' },
    });
  });

  it('falls back to the run task and a standard profile when the advice omits them', () => {
    expect(
      core.retrainingRequest({
        record: { id: 'run-1', taskId: 'walk' },
        advice: { suggestedTraining: {} },
        modelId: 'model-1',
        idempotencyKey: 'retrain-key-2',
      }),
    ).toEqual({
      modelId: 'model-1',
      backend: 'local',
      taskId: 'walk',
      idempotencyKey: 'retrain-key-2',
      training: { profile: 'standard' },
    });
  });

  it('omits taskId entirely when neither the advice nor the run names one', () => {
    const body = core.retrainingRequest({
      record: { id: 'run-1' },
      advice: { suggestedTraining: { taskId: '' } },
      modelId: 'model-1',
      idempotencyKey: 'retrain-key-3',
    });
    expect(Object.prototype.hasOwnProperty.call(body, 'taskId')).toBe(false);
    expect(body.backend).toBe('local');
  });
});

/**
 * The helpers below were moved out of app.js verbatim; app.js keeps only a
 * same-name delegation wrapper. These blocks pin the exact behavior the DOM
 * renderers relied on, including the fail-closed cases a refactor could
 * quietly widen into a success state.
 */
describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters in one pass', () => {
    expect(core.escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#039;y&#039;&gt;&amp;&lt;/a&gt;',
    );
  });

  it('escapes an existing entity again instead of trusting it', () => {
    expect(core.escapeHtml('&amp;')).toBe('&amp;amp;');
  });

  it('renders null and undefined as an empty string and stringifies other values', () => {
    expect(core.escapeHtml(null)).toBe('');
    expect(core.escapeHtml(undefined)).toBe('');
    expect(core.escapeHtml(0)).toBe('0');
    expect(core.escapeHtml(false)).toBe('false');
    expect(core.escapeHtml(['<b>'])).toBe('&lt;b&gt;');
  });
});

describe('formatDate', () => {
  it('renders a zh-CN month/day hour:minute string for a valid instant', () => {
    const formatted = core.formatDate('2026-01-02T03:04:05.000Z');
    expect(formatted).toMatch(/^\d{2}\/\d{2} \d{2}:\d{2}$/);
  });

  it('renders two instants apart by hours differently', () => {
    expect(core.formatDate('2026-01-02T03:04:00.000Z')).not.toBe(
      core.formatDate('2026-01-02T15:04:00.000Z'),
    );
  });

  it('degrades missing or unparseable values to the em dash', () => {
    // `0` is falsy, so the epoch itself is deliberately rendered as the
    // placeholder rather than 01/01 08:00.
    for (const value of [undefined, null, '', 0, 'not-a-date']) {
      expect(core.formatDate(value)).toBe('—');
    }
  });
});

describe('run status vocabularies', () => {
  it('classifies terminal statuses case-insensitively', () => {
    for (const status of ['completed', 'failed', 'blocked', 'cancelled', 'COMPLETED']) {
      expect(core.isTerminalRunStatus(status)).toBe(true);
    }
    for (const status of ['running', 'queued', 'ready', 'other', '']) {
      expect(core.isTerminalRunStatus(status)).toBe(false);
    }
  });

  it('classifies active statuses case-insensitively', () => {
    for (const status of ['queued', 'running', 'QUEUED']) {
      expect(core.isActiveRunStatus(status)).toBe(true);
    }
    for (const status of ['completed', 'failed', 'cancelled', 'ready', 'other']) {
      expect(core.isActiveRunStatus(status)).toBe(false);
    }
  });

  it('fails closed for missing and non-string statuses', () => {
    for (const status of [undefined, null, '', 0, {}]) {
      expect(core.isTerminalRunStatus(status)).toBe(false);
      expect(core.isActiveRunStatus(status)).toBe(false);
    }
  });
});

describe('stateClass / statusLabel', () => {
  it('maps every known status to a stable state class', () => {
    for (const status of ['ready', 'completed', 'success']) {
      expect(core.stateClass(status)).toBe('state-success');
    }
    for (const status of ['blocked', 'queued', 'partial', 'running', 'planned']) {
      expect(core.stateClass(status)).toBe('state-partial');
    }
    for (const status of ['failed', 'error']) {
      expect(core.stateClass(status)).toBe('state-error');
    }
  });

  it('matches case-insensitively but never trims', () => {
    expect(core.stateClass('READY')).toBe('state-success');
    expect(core.stateClass('success ')).toBe('state-neutral');
  });

  it('degrades unknown and missing statuses to neutral, not success', () => {
    for (const status of ['unknown', '', undefined, null, 0]) {
      expect(core.stateClass(status)).toBe('state-neutral');
    }
  });

  it('maps every known status to its Chinese label', () => {
    expect(core.statusLabel('queued')).toBe('排队中');
    expect(core.statusLabel('running')).toBe('运行中');
    expect(core.statusLabel('completed')).toBe('已完成');
    expect(core.statusLabel('ready')).toBe('可运行');
    expect(core.statusLabel('planned')).toBe('已计划');
    expect(core.statusLabel('blocked')).toBe('已阻断');
    expect(core.statusLabel('failed')).toBe('失败');
    expect(core.statusLabel('cancelled')).toBe('已取消');
    expect(core.statusLabel('registered')).toBe('已登记');
    expect(core.statusLabel('demo')).toBe('演示样例');
  });

  it('looks up case-insensitively and otherwise echoes the raw value', () => {
    expect(core.statusLabel('COMPLETED')).toBe('已完成');
    expect(core.statusLabel('WeIrD')).toBe('WeIrD');
    expect(core.statusLabel(7)).toBe('7');
  });

  it('renders missing statuses as 未知', () => {
    for (const status of [undefined, null, '', 0, false]) {
      expect(core.statusLabel(status)).toBe('未知');
    }
  });
});

describe('metricPercent / formatMetricPercent / formatMetricNumber', () => {
  it('treats a 0..1 value as a ratio and passes larger values through as percents', () => {
    expect(core.metricPercent(0)).toBe(0);
    expect(core.metricPercent(0.5)).toBe(50);
    expect(core.metricPercent(1)).toBe(100);
    // 1.5 is outside the ratio window, so it is read literally as 1.5% and
    // rounded; the same rule turns 42 into 42%.
    expect(core.metricPercent(1.5)).toBe(2);
    expect(core.metricPercent(42)).toBe(42);
    expect(core.metricPercent(100)).toBe(100);
  });

  it('rounds the ratio to the nearest whole percent', () => {
    expect(core.metricPercent(0.995)).toBe(100);
  });

  it('returns null for non-numbers, non-finite values, and out-of-range percents', () => {
    for (const value of [
      undefined,
      null,
      '',
      '50',
      true,
      false,
      NaN,
      Infinity,
      -Infinity,
      -0.5,
      -1,
      101,
    ]) {
      expect(core.metricPercent(value)).toBeNull();
    }
  });

  it('renders a percent or the em dash', () => {
    expect(core.formatMetricPercent(0)).toBe('0%');
    expect(core.formatMetricPercent(0.5)).toBe('50%');
    expect(core.formatMetricPercent(101)).toBe('—');
    expect(core.formatMetricPercent('50')).toBe('—');
  });

  it('formats finite numbers with the requested precision only', () => {
    expect(core.formatMetricNumber(1.23456, 3)).toBe('1.235');
    expect(core.formatMetricNumber(1.25, 1)).toBe('1.3');
    expect(core.formatMetricNumber(3, 0)).toBe('3');
    expect(core.formatMetricNumber(-1.23456, 2)).toBe('-1.23');
  });

  it('renders non-finite and non-number metrics as the em dash', () => {
    for (const value of [undefined, null, NaN, Infinity, -Infinity, '5']) {
      expect(core.formatMetricNumber(value, 2)).toBe('—');
    }
  });
});

describe('evidence predicates (isSyntheticEvidence / hasPersistedEvaluation / hasRealEvaluation)', () => {
  it('flags demo-fixture provenance on either the evidence or the persisted replay', () => {
    expect(core.isSyntheticEvidence({ source: 'demo-fixture' }, null)).toBe(true);
    expect(
      core.isSyntheticEvidence(null, { evaluation: { replay: { source: 'demo-fixture' } } }),
    ).toBe(true);
    expect(
      core.isSyntheticEvidence(
        { source: 'import' },
        { evaluation: { replay: { source: 'import' } } },
      ),
    ).toBe(false);
  });

  it('matches provenance exactly, so a differently-cased source is not synthetic', () => {
    expect(core.isSyntheticEvidence({ source: 'DEMO-FIXTURE' }, null)).toBe(false);
  });

  it('fails closed when the evidence or the run is missing', () => {
    expect(core.isSyntheticEvidence(undefined, undefined)).toBe(false);
    expect(core.isSyntheticEvidence(null, null)).toBe(false);
    expect(core.isSyntheticEvidence({}, {})).toBe(false);
  });

  it('treats a persisted replay with a positive sample count as an evaluation', () => {
    expect(core.hasPersistedEvaluation({ evaluation: { replay: { sampleCount: 1 } } })).toBe(true);
    expect(core.hasPersistedEvaluation({ evaluation: { replay: { sampleCount: '3' } } })).toBe(
      true,
    );
  });

  it('fails closed for a missing, empty, zero, or negative replay count', () => {
    for (const run of [
      undefined,
      null,
      {},
      { evaluation: {} },
      { evaluation: { replay: null } },
      { evaluation: { replay: {} } },
      { evaluation: { replay: { sampleCount: 0 } } },
      { evaluation: { replay: { sampleCount: -2 } } },
      { evaluation: { replay: { sampleCount: null } } },
    ]) {
      expect(core.hasPersistedEvaluation(run)).toBe(false);
    }
  });

  it('rejects mock and demo-fixture runs even when metrics or replay are present', () => {
    expect(core.hasRealEvaluation({}, { mock: true, metrics: { successRate: 0.9 } })).toBe(false);
    expect(
      core.hasRealEvaluation({}, { mock: true, evaluation: { replay: { sampleCount: 5 } } }),
    ).toBe(false);
    expect(
      core.hasRealEvaluation({ source: 'demo-fixture' }, { metrics: { successRate: 0.9 } }),
    ).toBe(false);
    expect(
      core.hasRealEvaluation(
        {},
        { metrics: { successRate: 0.9 }, evaluation: { replay: { source: 'demo-fixture' } } },
      ),
    ).toBe(false);
  });

  it('accepts a persisted replay, numeric worker metrics, or a bound upload', () => {
    expect(core.hasRealEvaluation({}, { evaluation: { replay: { sampleCount: 2 } } })).toBe(true);
    expect(core.hasRealEvaluation({}, { metrics: { successRate: 0.9 } })).toBe(true);
    expect(
      core.hasRealEvaluation({ publishedRunId: 'r1', summary: { sampleCount: 5 } }, { id: 'r1' }),
    ).toBe(true);
  });

  it('rejects non-numeric metrics and uploads bound to a different run', () => {
    expect(core.hasRealEvaluation({}, { metrics: { successRate: '0.9' } })).toBe(false);
    expect(
      core.hasRealEvaluation({ publishedRunId: 'r2', summary: { sampleCount: 5 } }, { id: 'r1' }),
    ).toBe(false);
    expect(
      core.hasRealEvaluation({ publishedRunId: 'r1', summary: { sampleCount: 0 } }, { id: 'r1' }),
    ).toBe(false);
    expect(core.hasRealEvaluation(undefined, { id: 'r1' })).toBe(false);
  });

  it('fails closed for empty evidence and run pairs', () => {
    expect(core.hasRealEvaluation(undefined, undefined)).toBe(false);
    expect(core.hasRealEvaluation(null, null)).toBe(false);
    expect(core.hasRealEvaluation({}, {})).toBe(false);
  });

  it('documents the undefined-id equality the original comparison keeps', () => {
    // Preserved verbatim from app.js: `evidence.publishedRunId === run.id` is
    // true when both sides are undefined, so a summary-only upload still
    // counts. Callers pass a real run id; relaxing this is a separate
    // behavior decision, not part of the extraction.
    expect(core.hasRealEvaluation({ summary: { sampleCount: 5 } }, {})).toBe(true);
    expect(core.hasRealEvaluation({ summary: { sampleCount: 5 } }, { id: 'r1' })).toBe(false);
  });
});

describe('telemetryDivergingColor', () => {
  it('returns the fixed stop colors at their anchors and clamps out-of-range magnitudes', () => {
    expect(core.telemetryDivergingColor(-1)).toBe('rgb(37, 99, 235)');
    expect(core.telemetryDivergingColor(-0.25)).toBe('rgb(189, 214, 252)');
    expect(core.telemetryDivergingColor(0)).toBe('rgb(251, 251, 249)');
    expect(core.telemetryDivergingColor(0.25)).toBe('rgb(252, 216, 200)');
    expect(core.telemetryDivergingColor(1)).toBe('rgb(220, 38, 38)');
    expect(core.telemetryDivergingColor(-2)).toBe('rgb(37, 99, 235)');
    expect(core.telemetryDivergingColor(2)).toBe('rgb(220, 38, 38)');
  });

  it('interpolates between stops deterministically', () => {
    expect(core.telemetryDivergingColor(-0.5)).toBe('rgb(138, 176, 246)');
    expect(core.telemetryDivergingColor(0.5)).toBe('rgb(241, 157, 146)');
  });

  it('coerces numeric strings and null', () => {
    expect(core.telemetryDivergingColor('0.5')).toBe('rgb(241, 157, 146)');
    expect(core.telemetryDivergingColor(null)).toBe('rgb(251, 251, 249)');
  });

  it('falls back to the final color for NaN and undefined', () => {
    expect(core.telemetryDivergingColor(NaN)).toBe('rgb(255, 144, 152)');
    expect(core.telemetryDivergingColor(undefined)).toBe('rgb(255, 144, 152)');
  });
});

describe('hasReleaseGradeEvidence (release gate)', () => {
  const workerRun = {
    backend: 'local',
    metrics: { contractValid: true, successRate: 0.88 },
  };

  it('accepts a real worker run with contract-valid numeric metrics', () => {
    expect(core.hasReleaseGradeEvidence({}, workerRun)).toBe(true);
    expect(core.hasReleaseGradeEvidence({}, { ...workerRun, backend: 'robogo' })).toBe(true);
    // Backend comparison is case-insensitive.
    expect(core.hasReleaseGradeEvidence({}, { ...workerRun, backend: 'LOCAL' })).toBe(true);
  });

  it('accepts only an explicitly attested replay with positive sample count', () => {
    const attested = { evaluation: { replay: { attested: true, sampleCount: 12 } } };
    expect(core.hasReleaseGradeEvidence({}, attested)).toBe(true);
    // Number(sampleCount) coerces numeric strings, matching the original.
    expect(
      core.hasReleaseGradeEvidence(
        {},
        { evaluation: { replay: { attested: true, sampleCount: '5' } } },
      ),
    ).toBe(true);
    expect(
      core.hasReleaseGradeEvidence(
        {},
        { evaluation: { replay: { attested: true, sampleCount: 0 } } },
      ),
    ).toBe(false);
    expect(core.hasReleaseGradeEvidence({}, { evaluation: { replay: { sampleCount: 12 } } })).toBe(
      false,
    );
    expect(
      core.hasReleaseGradeEvidence(
        {},
        { evaluation: { replay: { attested: 'true', sampleCount: 12 } } },
      ),
    ).toBe(false);
  });

  it('fails closed for mock, synthetic, or unprovenanced runs even with good metrics', () => {
    expect(core.hasReleaseGradeEvidence({}, { ...workerRun, mock: true })).toBe(false);
    expect(core.hasReleaseGradeEvidence({ source: 'demo-fixture' }, workerRun)).toBe(false);
    // board-agent is an uploader claim: replay stays reviewable, never release grade.
    expect(
      core.hasReleaseGradeEvidence(
        { source: 'board-agent' },
        { evaluation: { replay: { sampleCount: 3, source: 'board-agent' } } },
      ),
    ).toBe(false);
  });

  it('rejects non-worker backends and incomplete worker metrics', () => {
    expect(
      core.hasReleaseGradeEvidence({}, { metrics: { contractValid: true, successRate: 0.9 } }),
    ).toBe(false);
    expect(core.hasReleaseGradeEvidence({}, { ...workerRun, backend: 'contract' })).toBe(false);
    expect(
      core.hasReleaseGradeEvidence(
        {},
        { backend: 'local', metrics: { contractValid: false, successRate: 0.9 } },
      ),
    ).toBe(false);
    expect(
      core.hasReleaseGradeEvidence({}, { backend: 'local', metrics: { successRate: 0.9 } }),
    ).toBe(false);
    expect(
      core.hasReleaseGradeEvidence(
        {},
        { backend: 'local', metrics: { contractValid: true, successRate: '0.9' } },
      ),
    ).toBe(false);
  });

  it('fails closed for empty, null, or missing inputs', () => {
    expect(core.hasReleaseGradeEvidence(undefined, undefined)).toBe(false);
    expect(core.hasReleaseGradeEvidence(null, null)).toBe(false);
    expect(core.hasReleaseGradeEvidence({}, {})).toBe(false);
    expect(core.hasReleaseGradeEvidence({}, { evaluation: {} })).toBe(false);
  });
});
