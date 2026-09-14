import type { Request, Response, Router } from 'express';

import type { Sim2RealAuthPort } from '../sim2real/sim2real-auth.js';
import {
  listSim2RealAuditEvents,
  sim2RealAuditHealth,
  type Sim2RealAuditOutcome,
} from '../sim2real/audit-log.js';
import { sendApiError, wrapAsync } from '../sim2real/http-helpers.js';

type AuditDeps = {
  auth: Sim2RealAuthPort;
  requestOwner: (request: Request, response: Response) => string | undefined | null;
};

function text(value: unknown, max = 120): string {
  return (Array.isArray(value) ? value[0] : value == null ? '' : String(value))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);
}

const OUTCOMES = new Set<Sim2RealAuditOutcome>(['succeeded', 'failed', 'denied']);

/** Read-only, owner-scoped audit and health endpoints. */
export function registerSim2RealAuditRoutes(
  router: Router,
  deps: AuditDeps,
  options: { prefix: string },
): void {
  const api = (suffix: string) => `${options.prefix}${suffix}`;
  router.get(
    api('/audit'),
    wrapAsync(async (request, response) => {
      const owner = deps.requestOwner(request, response);
      if (owner === null) return;
      const rawLimit = Number(request.query.limit ?? 200);
      const limit = Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : 200;
      const outcomeRaw = text(request.query.outcome, 24).toLowerCase();
      if (outcomeRaw && !OUTCOMES.has(outcomeRaw as Sim2RealAuditOutcome)) {
        sendApiError(
          response,
          400,
          'SIM2REAL_INVALID_AUDIT_FILTER',
          'outcome 必须是 succeeded、failed 或 denied。',
          { retryable: false },
        );
        return;
      }
      response.setHeader('Cache-Control', 'no-store');
      const events = await listSim2RealAuditEvents(owner ?? undefined, {
        limit,
        ...(text(request.query.resourceType, 80)
          ? { resourceType: text(request.query.resourceType, 80) }
          : {}),
        ...(outcomeRaw ? { outcome: outcomeRaw as Sim2RealAuditOutcome } : {}),
      });
      response.json({ ok: true, events, total: events.length });
    }),
  );

  router.get(
    api('/audit/health'),
    wrapAsync(async (request, response) => {
      const owner = deps.requestOwner(request, response);
      if (owner === null) return;
      // The path itself is intentionally omitted from the public payload. It
      // can reveal deployment layout; operators can inspect server logs or
      // the local filesystem when debugging storage.
      const health = await sim2RealAuditHealth();
      response.setHeader('Cache-Control', 'no-store');
      response.json({
        ok: health.readable && health.writable,
        configured: health.configured,
        readable: health.readable,
        writable: health.writable,
        eventCount: health.eventCount ?? null,
      });
    }),
  );
}
