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
    const microduck = core.simulatorStatusLabels({ id: 'microduck', displayName: 'MicroDuck' }, false);
    expect(microduck.title).toBe('MicroDuck 仿真适配器');
    expect(microduck.detail).toBe('等待挂载经过审核的静态 bundle');

    const originbot = core.simulatorStatusLabels({ id: 'originbot', displayName: 'OriginBot' }, false);
    expect(originbot.detail).toBe('OriginBot 使用外部仿真/遥测适配器');

    const generic = core.simulatorStatusLabels({ id: 'custom', displayName: 'Custom' }, false);
    expect(generic.detail).toBe('当前产品线等待仿真适配器');
  });
});

describe('normalizeTelemetrySample', () => {
  it('accepts t, time, and timestamp keys and drops non-objects', () => {
    expect(core.normalizeTelemetrySample({ t: 1.5, reward: 0.25 })).toEqual({ t: 1.5, reward: 0.25 });
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
});
