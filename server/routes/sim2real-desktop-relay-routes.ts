import type { Request, Response, Router } from 'express';
import type { Sim2RealAuthPort } from '../sim2real/sim2real-auth.js';
import { principalCan, SIM2REAL_PERMISSIONS } from '../sim2real/sim2real-rbac.js';
import { sendApiError, wrapAsync } from '../sim2real/http-helpers.js';
import {
  studioDesktopRelay,
  StudioDesktopRelayBroker,
  StudioDesktopRelayError,
} from '../sim2real/studio-desktop-relay.js';

/** Outbound transport presence only. No endpoint here can enqueue a board
 * command: existing platform station routes retain every business gate.
 */
export function registerSim2RealDesktopRelayRoutes(
  router: Router,
  deps: {
    auth: Sim2RealAuthPort;
    requestOwner: (request: Request, response: Response) => string | undefined | null;
    broker?: StudioDesktopRelayBroker;
  },
  options: { prefix?: string } = {},
) {
  const prefix = options.prefix ?? '/api/sim2real';
  if (!/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(prefix))
    throw Error('Invalid desktop relay API prefix');
  const broker = deps.broker ?? studioDesktopRelay;
  const base = prefix + '/desktop-relay/sessions';
  const ownerFor = (request: Request, response: Response): string | null => {
    response.setHeader('cache-control', 'no-store');
    const owner = deps.requestOwner(request, response);
    if (owner === null) return null;
    const principal = deps.auth.resolvePrincipal(request);
    if (!owner || principal?.accountId !== owner) {
      sendApiError(response, 401, 'SIM2REAL_AUTH_REQUIRED', '请先登录 RDK Studio。', {
        retryable: false,
      });
      return null;
    }
    // A connector can receive already-authorized mutating commands and model
    // bytes, so a read-only principal cannot impersonate that connector.
    if (!principalCan(principal, SIM2REAL_PERMISSIONS.operate)) {
      sendApiError(response, 403, 'SIM2REAL_PERMISSION_DENIED', '当前账号无权使用本地设备通道。', {
        retryable: false,
      });
      return null;
    }
    return owner;
  };
  const secretFor = (request: Request): string => {
    const value = request.headers['x-rdk-desktop-relay-token'];
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value))
      throw new StudioDesktopRelayError(403, 'DESKTOP_RELAY_FORBIDDEN');
    return value;
  };
  const objectBody = (value: unknown, keys: readonly string[]) => {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => !keys.includes(key))
    )
      throw new StudioDesktopRelayError(400, 'DESKTOP_RELAY_INVALID_REQUEST');
    return value as Record<string, unknown>;
  };
  const failure = (response: Response, error: unknown) => {
    if (response.destroyed || response.writableEnded) return;
    sendApiError(
      response,
      // The account is already authenticated here. A bad connector secret
      // must not masquerade as an expired Studio login and trigger re-login.
      error instanceof StudioDesktopRelayError ? (error.status === 401 ? 403 : error.status) : 503,
      error instanceof StudioDesktopRelayError ? error.code : 'DESKTOP_RELAY_UNAVAILABLE',
      '本地设备通道暂不可用，请检查当前 Studio 登录和设备连接。',
      { retryable: true },
    );
  };
  // A connector must feature-detect this protocol before enrolling: older
  // cloud releases can still serve account-scoped discovery without a relay.
  router.get(prefix + '/desktop-relay/capabilities', (request, response) => {
    if (!ownerFor(request, response)) return;
    response.json({ ok: true, protocolVersion: 1 });
  });
  router.post(
    base,
    wrapAsync(async (request, response) => {
      const owner = ownerFor(request, response);
      if (!owner) return;
      try {
        const body = objectBody(request.body, ['devices']);
        response.json({ ok: true, ...broker.register(owner, body.devices) });
      } catch (error) {
        failure(response, error);
      }
    }),
  );
  router.get(
    base + '/:sessionId/commands',
    wrapAsync(async (request, response) => {
      const owner = ownerFor(request, response);
      if (!owner) return;
      const cancel = new AbortController();
      const closed = () => {
        if (!response.writableEnded) cancel.abort();
      };
      response.once('close', closed);
      try {
        const sessionId = String(request.params.sessionId);
        const token = secretFor(request);
        const command = await broker.poll(owner, sessionId, token, cancel.signal);
        if (!response.destroyed)
          response.json({ ok: true, command, ...broker.lease(owner, sessionId, token) });
      } catch (error) {
        failure(response, error);
      } finally {
        response.off('close', closed);
      }
    }),
  );
  router.post(
    base + '/:sessionId/results',
    wrapAsync(async (request, response) => {
      const owner = ownerFor(request, response);
      if (!owner) return;
      try {
        const body = objectBody(request.body, ['requestId', 'reply']);
        if (typeof body.requestId !== 'string')
          throw new StudioDesktopRelayError(400, 'DESKTOP_RELAY_INVALID_REQUEST');
        const sessionId = String(request.params.sessionId);
        const token = secretFor(request);
        broker.complete(owner, sessionId, token, body.requestId, body.reply);
        response.json({ ok: true, ...broker.lease(owner, sessionId, token) });
      } catch (error) {
        failure(response, error);
      }
    }),
  );
  router.delete(
    base + '/:sessionId',
    wrapAsync(async (request, response) => {
      const owner = ownerFor(request, response);
      if (!owner) return;
      try {
        broker.close(owner, String(request.params.sessionId), secretFor(request));
        response.json({ ok: true });
      } catch (error) {
        failure(response, error);
      }
    }),
  );
}
