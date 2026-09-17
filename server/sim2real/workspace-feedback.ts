import { randomUUID } from 'node:crypto';

import { emitSim2RealEvent } from './sim2real-events.js';

/**
 * Granular user feedback (Amershi et al. 2019, G15) for workspace surfaces:
 * retraining advice verdicts, agent replies, and run records. This module owns
 * only validation + shaping; persistence lives in the sim2real ledger so the
 * existing owner scoping, write serialization, and size guards apply. Feedback
 * is operational telemetry, never a release input: nothing here feeds the
 * promotion or release gates.
 */

export const FEEDBACK_CAP = 500;
export const FEEDBACK_NOTE_MAX_CHARS = 600;
/** Rolling window the summary panel promises ("近 30 天") — enforced, not labeled. */
export const FEEDBACK_SUMMARY_WINDOW_DAYS = 30;

/** Closed surface contract — degrades to the generic 'other' surface. */
export const FEEDBACK_SURFACES = Object.freeze([
  'retraining-advice',
  'agent-reply',
  'run-record',
] as const);
export type Sim2RealFeedbackSurface = (typeof FEEDBACK_SURFACES)[number];

/** Closed verdict contract — mirrors the retraining advisor verdicts. */
export const FEEDBACK_VERDICTS = Object.freeze(['accurate', 'inaccurate'] as const);
export type Sim2RealFeedbackVerdict = (typeof FEEDBACK_VERDICTS)[number];

export interface Sim2RealFeedbackRecord {
  id: string;
  surface: Sim2RealFeedbackSurface;
  verdict: Sim2RealFeedbackVerdict;
  note: string;
  runId?: string;
  createdAt: string;
}

type StoredFeedback = Sim2RealFeedbackRecord & { owner?: string };

function controlCharsReplaced(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
}

export interface Sim2RealFeedbackInput {
  surface: string;
  verdict: string;
  note?: string;
  runId?: string;
}

/**
 * Validate and normalize a feedback submission. Unknown surfaces and verdicts
 * degrade to the closed contract instead of being rejected, so a stale client
 * after a deploy still files usable feedback; the note stays bounded and free
 * of terminal control characters.
 */
export function normalizeSim2RealFeedback(input: Sim2RealFeedbackInput): {
  record: Omit<StoredFeedback, 'id' | 'createdAt' | 'owner'>;
  degraded: { surface: boolean; verdict: boolean };
} {
  const rawSurface = String(input.surface ?? '').trim();
  const rawVerdict = String(input.verdict ?? '').trim();
  const knownSurface = (FEEDBACK_SURFACES as readonly string[]).includes(rawSurface);
  const knownVerdict = (FEEDBACK_VERDICTS as readonly string[]).includes(rawVerdict);
  const runIdRaw = String(input.runId ?? '').trim();
  return {
    record: {
      surface: knownSurface ? (rawSurface as Sim2RealFeedbackSurface) : 'run-record',
      verdict: knownVerdict ? (rawVerdict as Sim2RealFeedbackVerdict) : 'inaccurate',
      note: controlCharsReplaced(String(input.note ?? '')).slice(0, FEEDBACK_NOTE_MAX_CHARS),
      ...(runIdRaw ? { runId: runIdRaw.slice(0, 120) } : {}),
    },
    degraded: { surface: !knownSurface, verdict: !knownVerdict },
  };
}

export function isSim2RealFeedbackRecord(value: unknown): value is StoredFeedback {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || !record.id.trim()) return false;
  if (
    typeof record.surface !== 'string' ||
    !(FEEDBACK_SURFACES as readonly string[]).includes(record.surface)
  )
    return false;
  if (
    typeof record.verdict !== 'string' ||
    !(FEEDBACK_VERDICTS as readonly string[]).includes(record.verdict)
  )
    return false;
  if (typeof record.note !== 'string' || record.note.length > FEEDBACK_NOTE_MAX_CHARS) return false;
  if (record.createdAt !== undefined && typeof record.createdAt !== 'string') return false;
  if (record.runId !== undefined && typeof record.runId !== 'string') return false;
  return true;
}

/** Ledger mutation helper: validate shape, enforce the cap, persist. */
export async function appendSim2RealFeedback(
  ledgerFeedback: unknown[],
  record: Omit<StoredFeedback, 'id' | 'createdAt' | 'owner'>,
  owner: string | undefined,
  persist: (next: StoredFeedback[]) => Promise<void>,
): Promise<Sim2RealFeedbackRecord> {
  const existing = ledgerFeedback.filter(isSim2RealFeedbackRecord) as StoredFeedback[];
  const now = new Date().toISOString();
  const stored: StoredFeedback = {
    ...record,
    id: randomUUID(),
    createdAt: now,
    ...(owner ? { owner } : {}),
  };
  // Bounded, FIFO-trimmed: feedback must never be able to push the ledger
  // toward its size guard, and the oldest entries are the least actionable.
  const next = [stored, ...existing].slice(0, FEEDBACK_CAP);
  await persist(next);
  void emitSim2RealEvent(
    'feedback.created',
    stored.id,
    {
      surface: stored.surface,
      verdict: stored.verdict,
      runId: stored.runId,
      noteLength: stored.note.length,
    },
    owner,
  );
  const { owner: _owner, ...publicRecord } = stored;
  return publicRecord;
}

export function listSim2RealFeedback(
  ledgerFeedback: unknown[],
  owner: string | undefined,
): Sim2RealFeedbackRecord[] {
  return (ledgerFeedback.filter(isSim2RealFeedbackRecord) as StoredFeedback[])
    .filter((item) => owner === undefined || item.owner === undefined || item.owner === owner)
    .map(({ owner: _owner, ...record }) => record);
}

/**
 * Aggregate the feedback into a reliance signal (Bakusevych #38 / Amershi
 * G17): counts per surface and verdict plus an accuracy share, so users and
 * operators can see what their feedback added up to. Still operational
 * telemetry only — never a release input.
 */
export function summarizeSim2RealFeedback(
  ledgerFeedback: unknown[],
  owner: string | undefined,
): {
  total: number;
  bySurface: Array<{ surface: Sim2RealFeedbackSurface; total: number; accurate: number }>;
  accurate: number;
  inaccurate: number;
  windowDays: number;
} {
  const records = listSim2RealFeedback(ledgerFeedback, owner);
  // The window label is a promise, not a caption: only records whose
  // createdAt actually falls inside the rolling window are tallied. Records
  // without a parseable createdAt cannot honestly claim to be in it, so they
  // are excluded rather than silently relabeled.
  const cutoff = Date.now() - FEEDBACK_SUMMARY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const windowed = records.filter((record) => {
    const at = Date.parse(String(record.createdAt ?? ''));
    return Number.isFinite(at) && at >= cutoff;
  });
  const bySurface = new Map<Sim2RealFeedbackSurface, { total: number; accurate: number }>();
  let accurate = 0;
  for (const record of windowed) {
    const tally = bySurface.get(record.surface) ?? { total: 0, accurate: 0 };
    tally.total += 1;
    if (record.verdict === 'accurate') {
      tally.accurate += 1;
      accurate += 1;
    }
    bySurface.set(record.surface, tally);
  }
  return {
    total: windowed.length,
    bySurface: FEEDBACK_SURFACES.map((surface) => {
      const tally = bySurface.get(surface) ?? { total: 0, accurate: 0 };
      return { surface, total: tally.total, accurate: tally.accurate };
    }).filter((row) => row.total > 0),
    accurate,
    inaccurate: windowed.length - accurate,
    windowDays: FEEDBACK_SUMMARY_WINDOW_DAYS,
  };
}

/**
 * Operator notices (Amershi et al. 2019, G18) are served, not stored: version
 * and capability notices come from package.json, health notices come from the
 * readiness snapshot, so there is no second source of truth to drift.
 */
export interface Sim2RealWorkspaceNotice {
  id: string;
  kind: 'info' | 'degraded';
  title: string;
  detail?: string;
  at: string;
}

interface NoticeSource {
  version: string;
  degraded: readonly string[];
  degradedMessage?: string;
}

export function sim2RealWorkspaceNotices(
  source: NoticeSource,
  now: Date = new Date(),
): Sim2RealWorkspaceNotice[] {
  const at = now.toISOString();
  const notices: Sim2RealWorkspaceNotice[] = [
    {
      id: `platform-version:${source.version}`,
      kind: 'info',
      title: `当前平台版本 ${source.version}`,
      at,
    },
  ];
  if (source.degraded.length) {
    notices.push({
      id: 'platform-degraded',
      kind: 'degraded',
      title: '平台存在降级项',
      detail:
        (source.degradedMessage ? `${source.degradedMessage}；` : '') +
        `当前降级：${source.degraded.join('、')}。相关功能可能不可用或使用替代数据。`,
      at,
    });
  }
  return notices;
}
