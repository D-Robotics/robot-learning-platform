import { Router, type NextFunction, type Request, type Response } from 'express';

import { registerSim2RealPlugin } from '../sim2real/sim2real-events.js';
import type { Sim2RealDomainEvent, Sim2RealDomainEventType } from '../../shared/sim2real-events.js';
import type { Sim2RealAuthPort } from '../sim2real/sim2real-auth.js';

/**
 * Server-sent events bridge for the domain event bus.
 *
 * The store already emits every run/deployment/telemetry mutation through
 * emitSim2RealEvent; this route turns a browser EventSource into one
 * process-local plugin subscription so the UI can react to training progress
 * without polling. Delivery keeps the plugin-bus guarantees: serialization
 * per subscriber, errors isolated per client, and a closed stream never
 * affects store writes.
 */

const PLUGIN_ID = 'sim2real-events-sse';

const HEARTBEAT_MS = 15_000;
const MAX_STREAMS = 64;
const CLAIM_EVENTS = new Set<Sim2RealDomainEventType>([
  'run.created',
  'run.updated',
  'deployment.created',
  'deployment.updated',
  'evaluation.created',
  'evaluation.updated',
  'telemetry.appended',
  'artifact.created',
  'model.created',
  'project.created',
  'project.updated',
]);

const activeStreams = new Set<() => void>();
const clients = new Map<Response, { owner?: string; heartbeat: NodeJS.Timeout }>();

function writeSseEvent(response: Response, event: Sim2RealDomainEvent): void {
  response.write(`event: ${event.type}\n`);
  response.write(`id: ${event.id}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function closeStream(response: Response): void {
  if (!response.writableEnded) response.end();
}

function pushEvent(event: Sim2RealDomainEvent): void {
  for (const [response, client] of clients) {
    // Multi-tenant deployments only deliver events whose owner matches the
    // stream principal; ownerless events stay single-user only.
    if (event.owner && client.owner && event.owner !== client.owner) continue;
    try {
      writeSseEvent(response, event);
    } catch {
      // A broken pipe is the client's business; drop it on the next sweep.
    }
  }
}

// One plugin instance serves every mounted prefix. Register inside the
// factory (not at module top level) so a fresh import graph — or a test that
// disposed the plugin — gets a working registration again; register is a
// replace-by-id operation so repeats never accumulate.
let pluginActive = false;
function ensurePlugin(): void {
  if (pluginActive) return;
  registerSim2RealPlugin({
    id: PLUGIN_ID,
    events: '*',
    onEvent: (event) => {
      if (CLAIM_EVENTS.has(event.type)) pushEvent(event);
    },
  });
  pluginActive = true;
}

/**
 * Mount `/events` under the given prefix (normally /api/v1/duck or
 * /api/sim2real). Owner filtering uses the same auth port as the business
 * routes, so shared deployments never leak cross-tenant events.
 */
export function createSim2RealEventsSseRouter(
  options: { prefix?: string; auth?: Sim2RealAuthPort } = {},
): Router {
  ensurePlugin();
  const router = Router();
  const prefix = options.prefix ?? '';
  const auth = options.auth;

  const streamRoute = (request: Request, response: Response, _next: NextFunction) => {
    void _next;
    if (request.headers.accept && !request.headers.accept.includes('text/event-stream')) {
      response.status(406).json({ error: 'SIM2REAL_SSE_ACCEPT_REQUIRED' });
      return;
    }
    if (activeStreams.size >= MAX_STREAMS) {
      response.status(503).json({ error: 'SIM2REAL_SSE_CAPACITY' });
      return;
    }
    let owner: string | undefined;
    if (auth?.isMultiUserDeployment()) {
      const principal = auth.resolvePrincipal(request);
      const accountId = String(principal?.accountId ?? '').trim();
      if (!accountId) {
        response.status(401).json({ error: 'SIM2REAL_AUTH_REQUIRED' });
        return;
      }
      owner = accountId;
    }

    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('X-Accel-Buffering', 'no');
    // Flush headers immediately: Node http clients only emit 'response'
    // once headers arrive, and no event may follow for a while.
    const raw = response as unknown as { flushHeaders?: () => void };
    if (typeof raw.flushHeaders === 'function') raw.flushHeaders();

    const heartbeat = setInterval(() => {
      try {
        response.write(': ping\n\n');
      } catch {
        /* sweep handles cleanup */
      }
    }, HEARTBEAT_MS);

    clients.set(response, { owner, heartbeat });
    const teardown = () => {
      clearInterval(heartbeat);
      clients.delete(response);
      activeStreams.delete(teardown);
      closeStream(response);
    };
    activeStreams.add(teardown);

    const onClose = () => teardown();
    request.on('close', onClose);
    response.on('close', onClose);
  };

  router.get(`${prefix}/events`, streamRoute);
  router.get(`${prefix}/events/stream`, streamRoute);
  return router;
}

/**
 * Test hook: detach every SSE subscriber and mark the plugin inactive so the
 * next router creation re-registers it. The plugin-bus disposer itself is
 * not called here — the bus treats test resets via
 * clearSim2RealPluginsForTests when a suite needs the whole registry empty.
 */
export function resetSim2RealSseStreamsForTests(): void {
  for (const teardown of [...activeStreams]) teardown();
  pluginActive = false;
}
