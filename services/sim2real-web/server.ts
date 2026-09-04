/**
 * Standalone Sim2Real web service.
 *
 * This process intentionally owns its own web surface. It is not mounted into
 * the RDK Studio React shell; the shared contract and guarded server adapters
 * are reused so the browser and board hand-off cannot drift apart.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, realpathSync, statSync } from 'node:fs';

import express, { type Express } from 'express';

import { MICRODUCK_SIM2REAL_CONTRACT, SIM2REAL_SCHEMA_VERSION } from '../../shared/sim2real.js';
import {
  createDeviceBoardDetectRouter,
  isSSOEnabled,
  isSSORequired,
  registerSSORoutes,
  restoreSsoSessionsFromDisk,
  runOnDevice,
  sim2RealCsrfMiddleware,
  ssoAuthMiddleware,
  storageRequestContextMiddleware,
  studioSecurityHeadersMiddleware,
} from '../../server/sim2real/standalone-adapters.js';
import {
  createSim2RealRouter,
  SIM2REAL_VERSIONED_API_PREFIX,
} from '../../server/routes/sim2real-routes.js';
import { sim2RealStorageReadiness } from '../../server/sim2real/sim2real-store.js';
import {
  studioSsoAdapterConfigured,
  studioSsoAdapterMode,
  studioSsoAuth,
} from './studio-sso-auth.js';

const SERVICE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = path.join(SERVICE_ROOT, 'public');
const DEFAULT_PORT = 18_102;

type MicroduckSurface = {
  state: 'mounted' | 'redirect' | 'missing';
  entryUrl: string;
  message: string;
};

function configuredPort(): number {
  const value = Number(process.env.RDK_SIM2REAL_PORT ?? DEFAULT_PORT);
  return Number.isInteger(value) && value >= 1_024 && value <= 65_535 ? value : DEFAULT_PORT;
}

function configuredHost(): string {
  return String(process.env.RDK_SIM2REAL_BIND_HOST ?? '').trim() || '127.0.0.1';
}

function publicPath(pathname: string): string {
  const rawBase = String(process.env.RDK_SIM2REAL_PUBLIC_BASE_PATH ?? '').trim();
  const base = rawBase && rawBase !== '/' ? `/${rawBase.replace(/^\/+|\/+$/g, '')}` : '';
  if (!base || !pathname.startsWith('/') || pathname.startsWith(`${base}/`)) return pathname;
  return `${base}${pathname}`;
}

function configuredMicroduckRequired(): boolean {
  return ['1', 'true', 'yes', 'on'].includes(
    String(process.env.RDK_SIM2REAL_REQUIRE_MICRODUCK ?? '').trim().toLowerCase(),
  );
}

function jsonError(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? 'unknown error');
}

function configuredMicroduckRoot(): string | null {
  const raw = String(process.env.RDK_SIM2REAL_MICRODUCK_ROOT ?? '').trim();
  if (!raw || !path.isAbsolute(raw)) return null;
  try {
    return existsSync(path.join(raw, 'index.html')) && statSync(raw).isDirectory()
      ? raw
      : null;
  } catch {
    return null;
  }
}

export function normalizeMicroduckRedirect(raw: string | undefined): string | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback))
  ) {
    return null;
  }
  return parsed.toString();
}

export function microduckSurface(): MicroduckSurface {
  const root = configuredMicroduckRoot();
  if (root) {
    return {
      state: 'mounted',
      entryUrl: publicPath('/mujoco/microduck/'),
      message: 'MicroDuck 静态仿真资源已挂载。',
    };
  }
  const redirect = normalizeMicroduckRedirect(process.env.RDK_SIM2REAL_MICRODUCK_URL);
  if (redirect) {
    return {
      state: 'redirect',
      entryUrl: redirect,
      message: 'MicroDuck 由独立仿真服务提供，入口将安全跳转。',
    };
  }
  return {
    state: 'missing',
    entryUrl: publicPath('/mujoco/microduck/'),
    message: '尚未挂载 MicroDuck 静态资源；当前提供安装指引页。',
  };
}

function microduckUnavailablePage(response: express.Response): void {
  response
    .status(503)
    .setHeader('Cache-Control', 'no-store')
    .sendFile(path.join(PUBLIC_ROOT, 'microduck-unavailable.html'));
}

export function createSim2RealWebApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  if (String(process.env.EXPRESS_TRUST_PROXY ?? '').trim() === '1') app.set('trust proxy', 1);

  // Keep the same signed-cookie context as the board/device adapters.
  app.use(storageRequestContextMiddleware);
  app.use(studioSecurityHeadersMiddleware);
  app.use(express.json({ limit: '2mb' }));

  // Health is intentionally public so systemd/nginx can probe the service
  // without possessing an account session.
  const healthPayload = async () => {
    const surface = microduckSurface();
    const storage = await sim2RealStorageReadiness();
    const microduckRequired = configuredMicroduckRequired();
    // Use the actual injected adapter as the source of truth. In particular,
    // trusted-proxy mode can be enabled independently of the legacy deployment
    // profile flags; reporting local-single-user in that case would be unsafe.
    const authRequired = studioSsoAuth.isMultiUserDeployment();
    const authAdapterConfigured = studioSsoAdapterConfigured();
    const degraded: string[] = [];
    if (surface.state === 'missing') degraded.push('microduck-not-mounted');
    if (!storage.writable) degraded.push('storage-not-configured');
    if (authRequired && !authAdapterConfigured) degraded.push('sso-adapter-required');
    return {
      ok: true,
      service: 'sim2real-web',
      schemaVersion: SIM2REAL_SCHEMA_VERSION,
      contractId: MICRODUCK_SIM2REAL_CONTRACT.id,
      ssoRequired: isSSORequired(),
      ssoConfigured: isSSOEnabled() || authAdapterConfigured,
      authRequired,
      authMode: authRequired
        ? authAdapterConfigured
          ? studioSsoAdapterMode()
          : 'sso-adapter-required'
        : 'local-single-user',
      microduck: surface,
      microduckRequired,
      storage,
      ready:
        degraded.every(
          (item) => item !== 'storage-not-configured' &&
            (!microduckRequired || item !== 'microduck-not-mounted'),
        ) &&
        (!authRequired || authAdapterConfigured),
      degraded,
    };
  };
  const health = async (_request: express.Request, response: express.Response): Promise<void> => {
    response.setHeader('Cache-Control', 'no-store');
    response.json(await healthPayload());
  };
  app.get('/healthz', health);
  app.get('/api/healthz', health);
  app.get('/readyz', async (_request, response) => {
    const payload = await healthPayload();
    response.status(payload.ready ? 200 : 503).json(payload);
  });
  app.get('/api/readyz', async (_request, response) => {
    const payload = await healthPayload();
    response.status(payload.ready ? 200 : 503).json(payload);
  });

  // Identity is supplied by the injected composition-root adapter. The public
  // default has no session store; a trusted SSO gateway (or a deployment-owned
  // OIDC adapter) must establish the account before shared mode is enabled.
  registerSSORoutes(app);
  app.use(ssoAuthMiddleware);
  app.use(sim2RealCsrfMiddleware);

  // Board detection is read-only unless the caller explicitly asks the
  // existing route to persist the detected metadata. The sim2real router
  // itself only creates plans and runs the fixed preflight probe.
  app.use(createDeviceBoardDetectRouter(runOnDevice));
  // Studio SSO is injected at the standalone composition root. The Sim2Real
  // business router only sees the auth port, so the product can be extracted
  // into another repository or paired with a native OIDC adapter later.
  // Keep the original `/api/sim2real` paths for existing clients while
  // exposing the stable product API under `/api/v1/duck`. Both routers are
  // created by the same factory and share the same auth/store adapters, so the
  // aliases cannot drift in validation or side effects.
  app.use(createSim2RealRouter({ runOnDevice, auth: studioSsoAuth }));
  app.use(
    createSim2RealRouter(
      { runOnDevice, auth: studioSsoAuth },
      { prefix: SIM2REAL_VERSIONED_API_PREFIX },
    ),
  );

  // MicroDuck is an optional, separately released static surface. Mounting it
  // here is useful for a self-contained deployment; when operators keep the
  // upstream simulator in its own service, a validated redirect is used. A
  // missing release gets an explicit 503 page instead of being mistaken for
  // the Sim2Real SPA (the old fallback made this look like a working simulator).
  // Resolve the release root per request. Operators can atomically switch the
  // reviewed `current` symlink without a race where healthz reports a mounted
  // bundle but the handler still holds the null/old path captured at startup.
  app.use('/mujoco/microduck', (request, response, next) => {
    const root = configuredMicroduckRoot();
    if (!root) {
      next();
      return;
    }
    express.static(root, { index: 'index.html' })(request, response, next);
  });
  app.get(['/mujoco/microduck', '/mujoco/microduck/'], (_request, response) => {
    const surface = microduckSurface();
    if (surface.state === 'redirect') {
      response.redirect(302, surface.entryUrl);
      return;
    }
    if (surface.state === 'mounted') {
      const root = configuredMicroduckRoot();
      if (root) {
        response.sendFile(path.join(root, 'index.html'));
        return;
      }
      microduckUnavailablePage(response);
      return;
    }
    microduckUnavailablePage(response);
  });
  app.get('/mujoco/microduck/{*splat}', (_request, response) => {
    if (microduckSurface().state === 'missing') microduckUnavailablePage(response);
    else response.status(404).json({ ok: false, error: 'MICRODUCK_ASSET_NOT_FOUND' });
  });

  // Keep the API surface machine-readable. Express' default final handler
  // returns an HTML 404 for unknown /api paths, which is especially confusing
  // for SDKs and the SPA when a route is mistyped.
  app.use('/api', (_request, response) => {
    response
      .status(404)
      .setHeader('Cache-Control', 'no-store')
      .json({ ok: false, error: 'SIM2REAL_API_NOT_FOUND', message: 'API 路径不存在。' });
  });

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
      if ((error as { type?: string })?.type === 'entity.too.large') {
        response.status(413).json({
          ok: false,
          error: 'SIM2REAL_REQUEST_TOO_LARGE',
          message: '请求体过大；请将遥测按更小的 JSON 分片上传。',
          retryable: false,
        });
        return;
      }
      if ((error as { type?: string })?.type === 'entity.parse.failed') {
        response.status(400).json({
          ok: false,
          error: 'SIM2REAL_INVALID_JSON',
          message: '请求体不是合法 JSON。',
          retryable: false,
        });
        return;
      }
      if (
        error instanceof Error &&
        (error.message === 'sim2real_storage_unavailable' ||
          error.message === 'sim2real_storage_not_configured' ||
          error.message === 'sim2real_storage_quota_exceeded')
      ) {
        response.status(error.message === 'sim2real_storage_quota_exceeded' ? 507 : 503).json({
          ok: false,
          error:
            error.message === 'sim2real_storage_quota_exceeded'
              ? 'SIM2REAL_STORAGE_QUOTA_EXCEEDED'
              : 'SIM2REAL_STORAGE_UNAVAILABLE',
          message:
            error.message === 'sim2real_storage_quota_exceeded'
              ? 'sim2real 台账已达到单实例大小上限，请迁移到对象存储 adapter。'
              : 'sim2real 台账暂不可用；请检查共享存储配置。',
          retryable: error.message !== 'sim2real_storage_quota_exceeded',
        });
        return;
      }
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
  // A standalone process may be restarted independently from Studio. Give a
  // deployment-owned adapter a chance to restore its sessions before accepting
  // requests; the public reference adapter is intentionally a no-op.
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
  // Production starts the service through /opt/rdk-robot-learning-platform/current, which is
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
