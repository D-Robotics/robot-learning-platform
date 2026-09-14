import { describe, expect, it } from 'vitest';

import type { Sim2RealTelemetryRecord } from '../../shared/sim2real.js';

import { buildBoardSessions } from './board-sessions.js';

function chunk(
  id: string,
  samples: Sim2RealTelemetryRecord['samples'],
  options: Partial<Sim2RealTelemetryRecord> = {},
): Sim2RealTelemetryRecord {
  return {
    id,
    runId: 'run-1',
    modelId: 'model-1',
    source: 'board-agent',
    receivedAt: '2026-09-14T00:00:00.000Z',
    samples,
    ...options,
  };
}

const started = (sessionId: string, t = 1) => ({
  t,
  event: {
    kind: 'session-started' as const,
    sessionId,
    startedAt: '2026-09-14T00:00:01Z',
    adapterId: 'originbot-differential-drive',
    controlHz: 10,
    mock: false,
    model: {
      sha256: 'a'.repeat(64),
      provider: 'CPUExecutionProvider',
      inputDim: 8,
      outputDim: 2,
      bytes: 96 * 1024,
    },
  },
});

const stopped = (sessionId: string, t = 2) => ({
  t,
  event: {
    kind: 'session-stopped' as const,
    sessionId,
    startedAt: '2026-09-14T00:00:01Z',
    stoppedAt: '2026-09-14T00:00:04Z',
    stopReason: 'operator-stop',
    inferenceCount: 31,
    lastInferenceAt: '2026-09-14T00:00:03.900Z',
    durationSec: 3.0,
    inferMs: 1.42,
    published: 31,
    mock: false,
  },
});

describe('buildBoardSessions', () => {
  it('reconstructs one session from start and stop markers across chunks', () => {
    const sessions = buildBoardSessions([
      chunk('chunk-1', [started('sess-1'), { t: 1.1, observation: [0, 0, 0], action: [0, 0] }]),
      chunk('chunk-2', [stopped('sess-1')], { deviceId: 'x5-board-1' }),
    ]);
    expect(sessions).toHaveLength(1);
    const session = sessions[0]!;
    expect(session.sessionId).toBe('sess-1');
    expect(session.startedAt).toBe('2026-09-14T00:00:01Z');
    expect(session.stoppedAt).toBe('2026-09-14T00:00:04Z');
    expect(session.stopReason).toBe('operator-stop');
    expect(session.inferenceCount).toBe(31);
    expect(session.inferMs).toBe(1.42);
    expect(session.model?.sha256).toBe('a'.repeat(64));
    expect(session.deviceId).toBe('x5-board-1');
    expect(session.chunks).toBe(2);
    expect(session.events).toBe(2);
  });

  it('marks a session interrupted when the stop marker never arrived', () => {
    const sessions = buildBoardSessions([chunk('chunk-1', [started('sess-1')])]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.stoppedAt).toBeUndefined();
    expect(sessions[0]!.stopReason).toBeUndefined();
    expect(sessions[0]!.events).toBe(1);
  });

  it('keeps attestation conjunctive across contributing chunks', () => {
    const attested = buildBoardSessions([
      chunk('chunk-1', [started('sess-1')], { attested: true, sequence: 10 }),
      chunk('chunk-2', [stopped('sess-1')], { attested: true, sequence: 220 }),
    ]);
    expect(attested[0]!.attested).toBe(true);

    const mixed = buildBoardSessions([
      chunk('chunk-1', [started('sess-2')], { attested: true, sequence: 10 }),
      chunk('chunk-2', [stopped('sess-2')], { attested: false, sequence: 220 }),
    ]);
    expect(mixed[0]!.attested).toBe(false);
  });

  it('ignores non-board-agent markers entirely', () => {
    const sessions = buildBoardSessions([
      chunk('chunk-1', [started('sess-1')], { source: 'browser' as const }),
      chunk('chunk-2', [stopped('sess-1')], { source: 'import' as const }),
    ]);
    expect(sessions).toHaveLength(0);
  });

  it('keeps the first terminal fields on a duplicated stop marker', () => {
    const sessions = buildBoardSessions([
      chunk('chunk-1', [started('sess-1'), stopped('sess-1'), stopped('sess-1')]),
    ]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.events).toBe(3);
    expect(sessions[0]!.stopReason).toBe('operator-stop');
    expect(sessions[0]!.stoppedAt).toBe('2026-09-14T00:00:04Z');
  });

  it('reconstructs from a stop marker even when the start marker was lost', () => {
    const sessions = buildBoardSessions([chunk('chunk-1', [stopped('sess-9')])]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.sessionId).toBe('sess-9');
    expect(sessions[0]!.startedAt).toBe('2026-09-14T00:00:01Z');
    expect(sessions[0]!.stopReason).toBe('operator-stop');
  });

  it('orders sessions by start time and returns an empty array for no markers', () => {
    const sessions = buildBoardSessions([
      chunk('chunk-1', [
        started('sess-b', 5),
        stopped('sess-b', 6),
        started('sess-a', 1),
        stopped('sess-a', 2),
      ]),
    ]);
    expect(sessions.map((session) => session.sessionId)).toEqual(['sess-a', 'sess-b']);
    expect(buildBoardSessions([chunk('chunk-1', [{ t: 1, observation: [1] }])])).toEqual([]);
  });
});
