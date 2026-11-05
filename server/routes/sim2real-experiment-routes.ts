import type { Request, Response, Router } from 'express';
import { createExperimentSessions, ExperimentError } from '../sim2real/experiment-sessions.js';
import { getSim2RealRun } from '../sim2real/sim2real-store.js';
import { sendApiError, wrapAsync } from '../sim2real/http-helpers.js';
const streams = new Set<Response>();

export function registerSim2RealExperimentRoutes(
  router: Router,
  deps: {
    requestOwner: (request: Request, response: Response) => string | undefined | null;
  },
  options: { prefix: string },
) {
  const store = createExperimentSessions({
    root: () => String(process.env.RDK_SIM2REAL_STORAGE_DIR ?? '').trim(),
    getRun: getSim2RealRun,
  });
  const api = (suffix: string) => options.prefix + '/experiments' + suffix;
  const replyError = (response: Response, error: unknown) => {
    if (error instanceof ExperimentError)
      sendApiError(response, error.status, error.code, error.message);
    else
      sendApiError(
        response,
        503,
        'EXPERIMENT_STORAGE_UNAVAILABLE',
        '实验暂时不可读，请保留原任务稍后恢复。',
      );
  };
  router.get(api('/capabilities'), (request, response) => {
    if (deps.requestOwner(request, response) === null) return;
    response.setHeader('Cache-Control', 'no-store');
    response.json({
      ok: true,
      schemaVersion: 1,
      ownerScoped: true,
      events: { replay: true, retained: 128 },
      view: 'experiment.html',
      submission: false,
    });
  });
  router.post(
    api(''),
    wrapAsync(async (request, response) => {
      const owner = deps.requestOwner(request, response);
      if (owner === null) return;
      response.setHeader('Cache-Control', 'no-store');
      try {
        const state = await store.remember(request.body, owner);
        response.json({
          ok: true,
          schemaVersion: 1,
          contextId: state.reference.contextId,
          revision: state.revision,
          view: state.view,
        });
      } catch (error) {
        replyError(response, error);
      }
    }),
  );
  router.get(
    api('/:contextId'),
    wrapAsync(async (request, response) => {
      const owner = deps.requestOwner(request, response);
      if (owner === null) return;
      response.setHeader('Cache-Control', 'no-store');
      try {
        const state = await store.resume(String(request.params.contextId), owner);
        response.json({ ok: true, schemaVersion: 1, revision: state.revision, view: state.view });
      } catch (error) {
        replyError(response, error);
      }
    }),
  );
  router.get(
    api('/:contextId/events'),
    wrapAsync(async (request, response) => {
      const owner = deps.requestOwner(request, response);
      if (owner === null) return;
      const rawCursor = request.headers['last-event-id'] ?? request.query.after ?? '0';
      if (typeof rawCursor !== 'string' || !/^\d{1,12}$/.test(rawCursor)) {
        sendApiError(response, 400, 'EXPERIMENT_CURSOR_INVALID', '事件游标无效。');
        return;
      }
      let cursor = Number(rawCursor);
      if (streams.size >= 64) {
        sendApiError(
          response,
          503,
          'EXPERIMENT_STREAM_CAPACITY',
          '实时连接暂满，请稍后恢复原实验。',
        );
        return;
      }
      let initial;
      try {
        initial = await store.events(String(request.params.contextId), cursor, owner);
      } catch (error) {
        replyError(response, error);
        return;
      }
      response.status(200).set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        'X-Accel-Buffering': 'no',
      });
      response.flushHeaders();
      streams.add(response);
      let closed = false;
      let timer: NodeJS.Timeout | undefined;
      let wake: (() => void) | undefined;
      response.on('close', () => {
        closed = true;
        streams.delete(response);
        clearTimeout(timer);
        wake?.();
      });
      const emit = (batch: typeof initial) => {
        for (const event of batch.events) {
          response.write(
            `id: ${event.id}\nevent: ${batch.reset ? 'reset' : 'snapshot'}\ndata: ${JSON.stringify(event)}\n\n`,
          );
          cursor = event.id;
        }
        if (!batch.events.length) response.write(': current\n\n');
      };
      emit(initial);
      // Bounded connections re-enter the normal authentication boundary on reconnect.
      const deadline = Date.now() + 20_000;
      try {
        while (!closed && Date.now() < deadline) {
          await new Promise<void>((resolve) => {
            wake = resolve;
            timer = setTimeout(resolve, 1500);
          });
          if (closed) break;
          emit(await store.events(String(request.params.contextId), cursor, owner));
        }
      } catch {
        if (!closed)
          response.write(
            'event: unavailable\ndata: {"message":"实验状态暂不可读，请重连原实验。"}\n\n',
          );
      } finally {
        streams.delete(response);
        clearTimeout(timer);
        if (!closed) response.end();
      }
    }),
  );
}
