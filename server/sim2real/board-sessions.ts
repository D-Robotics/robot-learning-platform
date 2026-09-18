import type {
  Sim2RealBoardSessionSummary,
  Sim2RealTelemetryRecord,
} from '../../shared/sim2real.js';

/**
 * Board session aggregator: reconstructs policy motion sessions from the
 * lifecycle event markers (`session-started` / `session-stopped`) that the
 * board runtime appends to its telemetry spool.
 *
 * Honesty rules, mirroring the replay builder:
 *  - only `board-agent` chunks contribute; imported/browser markers are not
 *    board sessions and never become one by aggregation;
 *  - `attested` is true only when EVERY contributing chunk was server-side
 *    attested — a single unattested marker keeps the session review-only;
 *  - a session whose stop marker never arrived (process killed mid-motion)
 *    is reported with an absent `stoppedAt`, surfaced as an interrupted
 *    session rather than a fabricated clean stop;
 *  - duplicate markers (uploader retries already dedupe at the chunk level;
 *    a defensive double-stop is the residual case) keep the FIRST terminal
 *    fields, so one session never shows two different stop reasons.
 */
export function buildBoardSessions(
  records: readonly Sim2RealTelemetryRecord[],
): Sim2RealBoardSessionSummary[] {
  const orderedRecords = [...records].sort(
    (left, right) =>
      (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER) ||
      left.receivedAt.localeCompare(right.receivedAt),
  );

  const sessions = new Map<string, Sim2RealBoardSessionSummary>();
  const contributingChunkIds = new Map<string, Set<string>>();

  const sessionFor = (sessionId: string, record: Sim2RealTelemetryRecord) => {
    let session = sessions.get(sessionId);
    if (!session) {
      session = {
        sessionId,
        attested: record.attested === true,
        chunks: 0,
        events: 0,
      };
      sessions.set(sessionId, session);
      contributingChunkIds.set(sessionId, new Set());
    }
    // Attestation is conjunctive across every chunk that carried a marker.
    session.attested = session.attested && record.attested === true;
    const chunkIds = contributingChunkIds.get(sessionId);
    if (chunkIds && !chunkIds.has(record.id)) {
      chunkIds.add(record.id);
      session.chunks = chunkIds.size;
    }
    session.events += 1;
    if (!session.deviceId && record.deviceId) session.deviceId = record.deviceId;
    return session;
  };

  for (const record of orderedRecords) {
    if (record.source !== 'board-agent') continue;
    for (const sample of record.samples) {
      const event = sample.event;
      if (!event?.sessionId) continue;
      const session = sessionFor(event.sessionId, record);
      if (event.kind === 'session-started') {
        // First observed start wins: a duplicated start marker must not move
        // the session's origin.
        if (!session.startedAt && event.startedAt) session.startedAt = event.startedAt;
        if (!session.adapterId && event.adapterId) session.adapterId = event.adapterId;
        if (session.controlHz == null && event.controlHz != null) {
          session.controlHz = event.controlHz;
        }
        if (session.mock == null && event.mock != null) session.mock = event.mock;
        if (!session.model && event.model) session.model = event.model;
        // The goalnav task target rides the start marker: first observed
        // wins, same as the origin fields.
        if (session.goalX == null && event.goalX != null) session.goalX = event.goalX;
        if (session.goalY == null && event.goalY != null) session.goalY = event.goalY;
      } else if (event.kind === 'session-stopped') {
        // First terminal marker wins for the same reason as the start.
        if (!session.stoppedAt && event.stoppedAt) session.stoppedAt = event.stoppedAt;
        if (!session.stopReason && event.stopReason) session.stopReason = event.stopReason;
        if (session.inferenceCount == null && event.inferenceCount != null) {
          session.inferenceCount = event.inferenceCount;
        }
        if (session.published == null && event.published != null) {
          session.published = event.published;
        }
        if (session.inferMs == null && event.inferMs != null) {
          session.inferMs = event.inferMs;
        }
        if (session.durationSec == null && event.durationSec != null) {
          session.durationSec = event.durationSec;
        }
        if (!session.lastInferenceAt && event.lastInferenceAt) {
          session.lastInferenceAt = event.lastInferenceAt;
        }
        // A stop without a recorded start still reconstructs what it can.
        if (!session.startedAt && event.startedAt) session.startedAt = event.startedAt;
      }
    }
  }

  return [...sessions.values()].sort(
    (left, right) =>
      String(left.startedAt ?? '').localeCompare(String(right.startedAt ?? '')) ||
      String(left.stoppedAt ?? '').localeCompare(String(right.stoppedAt ?? '')) ||
      left.sessionId.localeCompare(right.sessionId),
  );
}
