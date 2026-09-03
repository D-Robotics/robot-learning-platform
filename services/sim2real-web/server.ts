/**
 * Standalone Sim2Real web service.
 *
 * This process intentionally owns its own web surface. It is not mounted into
 * the RDK Studio React shell; the shared contract and guarded server adapters
 * are reused so the browser and board hand-off cannot drift apart.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

import express, { type Express } from 'express';

import { MICRODUCK_SIM2REAL_CONTRACT, SIM2REAL_SCHEMA_VERSION } from '../../shared/sim2real.js';
import {
  createDeviceBoardDetectRouter,
  isSSOEnabled,
  isSSORequired,
  registerSSORoutes,
  restoreSsoSessionsFromDisk,
  runOnDevice,
  ssoAuthMiddleware,
  storageRequestContextMiddleware,
  studioSecurityHeadersMiddleware,
} from '../../server/sim2real/standalone-adapters.js';
import { createSim2RealRouter } from '../../server/routes/sim2real-routes.js';
import { studioSsoAuth } from './studio-sso-auth.js';

const SERVICE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = path.join(SERVICE_ROOT, 'public');
const DEFAULT_PORT = 18_102;

function configuredPort(): number {
  const value = Number(process.env.RDK_SIM2REAL_PORT ?? DEFAULT_PORT);
  return Number.isInteger(value) && value >= 1_024 && value <= 65_535 ? value : DEFAULT_PORT;
}

function configuredHost(): string {
  return String(process.env.RDK_SIM2REAL_BIND_HOST ?? '').trim() || '127.0.0.1';
}

function jsonError(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? 'unknown error');
}

export function createSim2RealWebApp(): Express {
  const app = express();
  app.disable('x-powered-by');

  // Keep the same signed-cookie context as the board/device adapters.
  app.use(storageRequestContextMiddleware);
  app.use(studioSecurityHeadersMiddleware);
  app.use(express.json({ limit: '2mb' }));

  // Health is intentionally public so systemd/nginx can probe the service
  // without possessing an account session.
  const health = (_request: express.Request, response: express.Response): void => {
    response.setHeader('Cache-Control', 'no-store');
    response.json({
      ok: true,
      service: 'sim2real-web',
      schemaVersion: SIM2REAL_SCHEMA_VERSION,
      contractId: MICRODUCK_SIM2REAL_CONTRACT.id,
      ssoRequired: isSSORequired(),
      ssoConfigured: isSSOEnabled(),
    });
  };
  app.get('/healthz', health);
  app.get('/api/healthz', health);

  // The standalone page participates in the existing D-Robotics SSO session.
  // It can therefore share the account-scoped RoboGo token and device cookie
  // without introducing a second login or a bearer-token URL.
  registerSSORoutes(app);
  app.use(ssoAuthMiddleware);

  // Board detection is read-only unless the caller explicitly asks the
  // existing route to persist the detected metadata. The sim2real router
  // itself only creates plans and runs the fixed preflight probe.
  app.use(createDeviceBoardDetectRouter(runOnDevice));
  // Studio SSO is injected at the standalone composition root. The Sim2Real
  // business router only sees the auth port, so the product can be extracted
  // into another repository or paired with a native OIDC adapter later.
  app.use(createSim2RealRouter({ runOnDevice, auth: studioSsoAuth }));

  app.use(
    express.static(PUBLIC_ROOT, {
      index: 'index.html',
      maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
    }),
  );
  // Express 5 wildcard syntax keeps the SPA fallback compatible with paths
  // such as `/` and `/sim2real/` without the legacy path-to-regexp pattern.
  app.get('/{*splat}', (request, response, next) => {
    if (request.path.startsWith('/api/')) {
      next();
      return;
    }
    response.sendFile(path.join(PUBLIC_ROOT, 'index.html'));
  });

  app.use(
    (
      error: unknown,
      request: express.Request,
      response: express.Response,
      _next: express.NextFunction,
    ): void => {
      console.error(
        '[sim2real-web] request failed',
        request.method,
        request.path,
        jsonError(error),
      );
      if (response.headersSent) return;
      response.status(500).json({
        ok: false,
        error: 'SIM2REAL_WEB_INTERNAL_ERROR',
        message: '独立仿真到真机服务暂时不可用，请稍后重试。',
      });
    },
  );

  return app;
}

export async function startSim2RealWebServer(): Promise<void> {
  // A standalone process may be restarted independently from Studio. Restore
  // sessions before accepting requests so an existing SSO cookie remains
  // usable after a service restart.
  await restoreSsoSessionsFromDisk().catch((error) => {
    console.warn('[sim2real-web] SSO session restore skipped:', jsonError(error));
  });

  const app = createSim2RealWebApp();
  const host = configuredHost();
  const port = configuredPort();
  const server = app.listen(port, host, () => {
    console.log(
      '[sim2real-web] listening on http://' +
        host +
        ':' +
        port +
        ' (contract=' +
        MICRODUCK_SIM2REAL_CONTRACT.id +
        ')',
    );
  });

  let closing = false;
  const close = (signal: string): void => {
    if (closing) return;
    closing = true;
    console.log('[sim2real-web] received ' + signal + '; closing');
    const forceExit = setTimeout(() => process.exit(1), 5_000);
    forceExit.unref();
    server.close((error) => {
      clearTimeout(forceExit);
      if (error) {
        console.error('[sim2real-web] close failed:', jsonError(error));
        process.exitCode = 1;
      }
      process.exit();
    });
  };
  process.once('SIGTERM', () => close('SIGTERM'));
  process.once('SIGINT', () => close('SIGINT'));
}

function isDirectEntryInvocation(): boolean {
  const argvPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
  const modulePath = path.resolve(fileURLToPath(import.meta.url));
  if (!argvPath) return false;
  // Production starts the service through /opt/sim2real-web/current, which is
  // an atomic symlink to a versioned release. Node may resolve import.meta.url
  // to the release path while process.argv[1] keeps the symlink path; compare
  // canonical paths so the standalone process still starts after a release
  // switch, while imports from tests remain side-effect free.
  try {
    return realpathSync(argvPath) === realpathSync(modulePath);
  } catch {
    return argvPath === modulePath;
  }
}

if (isDirectEntryInvocation()) {
  void startSim2RealWebServer().catch((error) => {
    console.error('[sim2real-web] startup failed:', jsonError(error));
    process.exitCode = 1;
  });
}
