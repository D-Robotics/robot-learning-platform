import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Request, RequestHandler, Response } from 'express';
import { Router } from 'express';
import type { Device } from '../../shared/types.js';
import type { Sim2RealAuthPort } from './sim2real-auth.js';
import { studioCookieAuthConfigured } from './studio-cookie-auth.js';
import { activeTunnelAgentUrl, setTunnelDataDirResolver } from './board-tunnel-manager.js';

// Wire the tunnel manager's data-dir resolution to the adapters' own resolver
// (kept as an explicit init call instead of a direct import so this module
// stays the single owner of storage paths).
setTunnelDataDirResolver(resolveDataDir);

function isMultiUserStandaloneAuth(): boolean {
  return resolveStandaloneAuthMode() !== 'standalone' || isWebCloudDeployment();
}

const MAX_ROBOGO_API_RESPONSE_BYTES = 1_000_000;
const BOARD_PREFLIGHT_BEGIN = '__STUDIO_SIM2REAL_PREFLIGHT_BEGIN__';
const BOARD_PREFLIGHT_END = '__STUDIO_SIM2REAL_PREFLIGHT_END__';
let deviceWriteQueue: Promise<unknown> = Promise.resolve();

/** Minimal host adapters used by the public standalone distribution.
 *
 * The product core only talks to these ports. Deployments can replace this
 * module with an SSO, board-agent, object-store, or device-registry adapter
 * without changing the workflow routes.
 */
export function resolveDataDir(): string {
  return String(process.env.RDK_SIM2REAL_STORAGE_DIR || path.join(process.cwd(), '.data'));
}

export function isWebCloudDeployment(): boolean {
  return (
    String(process.env.RDK_SIM2REAL_DEPLOYMENT || '').trim() === 'web-cloud' ||
    String(process.env.RDK_STUDIO_DEPLOYMENT_PROFILE || '').trim() === 'web-cloud'
  );
}

/**
 * Single source of truth for auth-mode selection so the CSRF boundary and the
 * composition root cannot disagree about whether this is a multi-user
 * deployment. `studio-cookie` activates automatically when the shared Studio
 * cookie secret is present (the default-configurable path); any other value
 * must be set explicitly.
 */
export function resolveStandaloneAuthMode(): 'studio-cookie' | 'trusted-proxy' | 'standalone' {
  const raw = String(process.env.RDK_SIM2REAL_AUTH_MODE ?? '')
    .trim()
    .toLowerCase();
  if (raw === 'trusted-proxy') return 'trusted-proxy';
  if (raw === 'standalone') return 'standalone';
  if (raw === 'studio-cookie') return 'studio-cookie';
  return studioCookieAuthConfigured() ? 'studio-cookie' : 'standalone';
}

export const storageRequestContextMiddleware: RequestHandler = (_request, _response, next) =>
  next();

/** Baseline hardening applied to every response, including the relaxed
 * MicroDuck surface. These headers are cheap and cannot break a WASM bundle. */
const PERMISSIONS_POLICY = [
  'accelerometer=()',
  'ambient-light-sensor=()',
  'autoplay=(self)',
  'battery=()',
  'camera=()',
  'display-capture=()',
  'encrypted-media=()',
  'fullscreen=(self)',
  'geolocation=()',
  'gyroscope=()',
  'magnetometer=()',
  'microphone=()',
  'midi=()',
  'payment=()',
  'picture-in-picture=(self)',
  'publickey-credentials-get=(self)',
  'screen-wake-lock=()',
  'serial=()',
  'usb=()',
  'xr-spatial-tracking=()',
].join(', ');

/** 180 days. Deliberately conservative so a mistaken HSTS on a lab host does
 * not pin a browser for the customary two years. */
const HSTS_MAX_AGE_SECONDS = 15_552_000;

const CSP_MAX_EXTRA_SOURCES = 20;
const CSP_MAX_SOURCE_LENGTH = 200;
const CSP_FRAME_SRC_ENV = 'RDK_SIM2REAL_CSP_EXTRA_FRAME_SRC';
const CSP_CONNECT_SRC_ENV = 'RDK_SIM2REAL_CSP_EXTRA_CONNECT_SRC';
const CSP_DISABLE_ENV = 'RDK_SIM2REAL_CSP_DISABLE';
const CSP_WARNED_SOURCES = new Set<string>();

function environmentFlagEnabled(raw: unknown): boolean {
  return ['1', 'true', 'yes', 'on'].includes(
    String(raw ?? '')
      .trim()
      .toLowerCase(),
  );
}

/**
 * The public base path is a deployment concern owned by `server.ts`; mirror its
 * normalisation here so a path-scoped header decision cannot drift from the
 * actual mount when the service is published under a prefix.
 */
function publicBasePath(): string {
  const raw = String(process.env.RDK_SIM2REAL_PUBLIC_BASE_PATH ?? '').trim();
  return raw && raw !== '/' ? `/${raw.replace(/^\/+|\/+$/g, '')}` : '';
}

/**
 * Content-Security-Policy relaxation for the MicroDuck surface.
 *
 * `services/sim2real-web/server.ts` owns exactly three simulator mounts under
 * this namespace: `/mujoco/microduck` (static release served straight from
 * `RDK_SIM2REAL_MICRODUCK_ROOT`), `/mujoco/microduck/{*splat}` (index/404
 * handling for that release) and `/mujoco/microduck-proxy/{*splat}` (a
 * transparent reverse proxy of `RDK_SIM2REAL_MICRODUCK_URL`). The bundle behind
 * them is a third-party MuJoCo/WASM build whose inline bootstrap and blob
 * workers are outside this repository's control; the strict SPA policy breaks
 * it (WebAssembly bootstrap fails to start). Responses under `/mujoco` keep the
 * other hardening headers but are not given the strict CSP. Operators can still
 * set `RDK_SIM2REAL_CSP_DISABLE=1` to drop the strict policy everywhere.
 */
function isMicroduckSurfacePath(requestPath: unknown): boolean {
  const pathValue = String(requestPath ?? '/');
  const base = publicBasePath();
  const relative =
    base && (pathValue === base || pathValue.startsWith(`${base}/`))
      ? pathValue.slice(base.length) || '/'
      : pathValue;
  return /^\/mujoco(?:\/|$)/.test(relative);
}

/**
 * Origin of the optional externally hosted MicroDuck entry. Mirrors the SSRF
 * validation in `server.ts#normalizeMicroduckRedirect` (TLS, or plain HTTP on
 * loopback, and no credentials/query/hash) so the iframe allowlist can never be
 * widened by a malformed URL.
 */
function microduckRedirectOrigin(): string | null {
  const raw = String(process.env.RDK_SIM2REAL_MICRODUCK_URL ?? '').trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    const loopback = ['localhost', '127.0.0.1', '::1'].includes(
      parsed.hostname.replace(/^\[|\]$/g, ''),
    );
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/** Accept only bare origins: no wildcards, no separator/quote characters and no
 * control characters, so an environment value can never terminate a directive
 * or inject a second header. */
function normalizeCspOrigin(raw: string, allowedProtocols: readonly string[]): string | null {
  if (!raw || raw.length > CSP_MAX_SOURCE_LENGTH) return null;
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  if (/[\s;,'"`\\*(){}<>]/.test(raw)) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (!parsed.hostname) return null;
  if (!allowedProtocols.includes(parsed.protocol)) return null;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  if (parsed.pathname !== '' && parsed.pathname !== '/') return null;
  return parsed.origin;
}

function extraCspSources(envName: string, allowedProtocols: readonly string[]): string[] {
  const configured = String(process.env[envName] ?? '');
  if (!configured) return [];
  const accepted: string[] = [];
  for (const candidate of configured
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)) {
    if (accepted.length >= CSP_MAX_EXTRA_SOURCES) break;
    const origin = normalizeCspOrigin(candidate, allowedProtocols);
    if (origin) {
      if (!accepted.includes(origin)) accepted.push(origin);
      continue;
    }
    // A silently dropped allowlist entry is an outage waiting to happen; report
    // it once per distinct value instead of on every request.
    const warningKey = `${envName}\u0000${candidate}`;
    if (!CSP_WARNED_SOURCES.has(warningKey)) {
      CSP_WARNED_SOURCES.add(warningKey);
      console.warn(`[sim2real] 已忽略 ${envName} 中不合法的来源：${candidate.slice(0, 80)}`);
    }
  }
  return accepted;
}

let cachedCspSignature = '\u0000uninitialised';
let cachedCsp: string | null = null;

function contentSecurityPolicy(): string | null {
  if (environmentFlagEnabled(process.env[CSP_DISABLE_ENV])) return null;
  const signature = [
    process.env[CSP_DISABLE_ENV],
    process.env[CSP_FRAME_SRC_ENV],
    process.env[CSP_CONNECT_SRC_ENV],
    process.env.RDK_SIM2REAL_MICRODUCK_URL,
  ].join('\u0000');
  if (signature === cachedCspSignature) return cachedCsp;
  cachedCspSignature = signature;
  const simulatorOrigin = microduckRedirectOrigin();
  const frameSources = [
    "'self'",
    ...(simulatorOrigin ? [simulatorOrigin] : []),
    ...extraCspSources(CSP_FRAME_SRC_ENV, ['http:', 'https:']),
  ];
  const connectSources = [
    "'self'",
    ...extraCspSources(CSP_CONNECT_SRC_ENV, ['http:', 'https:', 'ws:', 'wss:']),
  ];
  cachedCsp = [
    "default-src 'self'",
    "script-src 'self'",
    // Deliberate: the SPA builds `style="…"` attributes through innerHTML
    // templates, so 'unsafe-inline' is required for style-src. Inline <script>
    // blocks and on* handler attributes stay blocked, which is the boundary
    // that actually protects the page.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connectSources.join(' ')}`,
    "worker-src 'self' blob:",
    "child-src 'self'",
    `frame-src ${frameSources.join(' ')}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; ');
  return cachedCsp;
}

/**
 * HSTS is only emitted when it cannot lock a development host: either the
 * operator asked for it explicitly, or the request itself arrived over TLS
 * (`request.secure`/`request.protocol` honour `trust proxy`, and the raw
 * `x-forwarded-proto` check covers a TLS-terminating proxy that has not been
 * declared yet). Sending HSTS on a plaintext response is a no-op in browsers,
 * which is why the forwarded check is safe here.
 */
function requestLooksSecure(request: Request): boolean {
  if (request.secure === true) return true;
  if (String(request.protocol ?? '') === 'https') return true;
  const forwarded = String(request.headers['x-forwarded-proto'] ?? '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return forwarded === 'https';
}

function strictTransportSecurityValue(request: Request): string | null {
  if (
    !environmentFlagEnabled(process.env.RDK_SIM2REAL_ENABLE_HSTS) &&
    !requestLooksSecure(request)
  ) {
    return null;
  }
  const includeSubDomains = environmentFlagEnabled(
    process.env.RDK_SIM2REAL_HSTS_INCLUDE_SUBDOMAINS,
  );
  return `max-age=${HSTS_MAX_AGE_SECONDS}${includeSubDomains ? '; includeSubDomains' : ''}`;
}

export const studioSecurityHeadersMiddleware: RequestHandler = (request, response, next) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'same-origin');
  response.setHeader('X-Frame-Options', 'SAMEORIGIN');
  response.setHeader('Permissions-Policy', PERMISSIONS_POLICY);
  const hsts = strictTransportSecurityValue(request);
  if (hsts) response.setHeader('Strict-Transport-Security', hsts);
  if (!isMicroduckSurfacePath(request.path)) {
    const policy = contentSecurityPolicy();
    if (policy) response.setHeader('Content-Security-Policy', policy);
  }
  next();
};

export function isSSOEnabled(): boolean {
  return (
    String(process.env.RDK_SIM2REAL_SSO_ENABLED || process.env.SSO_ENABLED || '').trim() === '1' ||
    String(process.env.RDK_STUDIO_DEPLOYMENT_PROFILE || '').trim() === 'web-cloud' ||
    String(process.env.RDK_SIM2REAL_AUTH_MODE || '')
      .trim()
      .toLowerCase() === 'trusted-proxy'
  );
}

export function isSSORequired(): boolean {
  return (
    String(process.env.RDK_SIM2REAL_SSO_REQUIRED || process.env.SSO_REQUIRED || '').trim() ===
      '1' ||
    String(process.env.RDK_STUDIO_DEPLOYMENT_PROFILE || '').trim() === 'web-cloud' ||
    String(process.env.RDK_SIM2REAL_AUTH_MODE || '')
      .trim()
      .toLowerCase() === 'trusted-proxy'
  );
}

/**
 * The public adapter has no identity provider of its own.  If an operator
 * opts into SSO/web-cloud mode without replacing this adapter, fail closed
 * instead of silently treating every caller as one anonymous owner.
 */
export function isStandaloneMultiUserMode(): boolean {
  // Cookie/header based auth modes are multi-user regardless of the legacy
  // deployment-profile flags; the CSRF boundary depends on this predicate.
  const mode = resolveStandaloneAuthMode();
  if (mode !== 'standalone') return true;
  return isWebCloudDeployment() || isSSORequired() || isSSOEnabled();
}

export function registerSSORoutes(_app: unknown): void {
  // The standalone sample intentionally has no identity provider dependency.
}

export async function restoreSsoSessionsFromDisk(): Promise<void> {
  // Identity/session persistence belongs to the deployment adapter.
}

export const ssoAuthMiddleware: RequestHandler = (_request, _response, next) => next();

/**
 * Lightweight CSRF boundary for cookie-based SSO deployments.  API clients
 * such as a board agent normally omit Origin and continue to work; browsers
 * sending a cross-site request are rejected.  A production OIDC adapter may
 * replace this with a synchronizer token, but should keep the same fail-closed
 * behaviour for unknown origins.
 */
export const sim2RealCsrfMiddleware: RequestHandler = (request, response, next) => {
  if (
    !isStandaloneMultiUserMode() ||
    !['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method.toUpperCase()) ||
    !request.path.startsWith('/api/')
  ) {
    next();
    return;
  }
  const fetchSite = String(request.headers['sec-fetch-site'] ?? '')
    .trim()
    .toLowerCase();
  if (fetchSite === 'cross-site') {
    response.status(403).json({
      ok: false,
      error: 'SIM2REAL_CSRF_BLOCKED',
      message: '跨站请求被拒绝，请从已登录的 Sim2Real 页面重试。',
    });
    return;
  }
  const origin = String(request.headers.origin ?? '').trim();
  if (origin) {
    const configured = String(
      process.env.RDK_SIM2REAL_ALLOWED_ORIGINS ??
        process.env.RDK_SIM2REAL_PUBLIC_ORIGIN ??
        'https://rdkstudio.d-robotics.cc',
    )
      .split(',')
      .map((item) => item.trim().replace(/\/$/, ''))
      .filter(Boolean);
    if (origin === 'null' || !configured.includes(origin.replace(/\/$/, ''))) {
      response.status(403).json({
        ok: false,
        error: 'SIM2REAL_CSRF_BLOCKED',
        message: '请求来源未被允许。',
      });
      return;
    }
  }
  response.setHeader('Vary', 'Origin, Sec-Fetch-Site');
  next();
};

export const standaloneAuth = {
  // Never infer an identity from a client-controlled header. A production
  // deployment must inject a verified OIDC/SSO adapter at this boundary.
  isMultiUserDeployment: isStandaloneMultiUserMode,
  resolvePrincipal: (_request: Request) => null,
  resolveAccessToken: (_request: Request) => null,
};

function normalizedDevice(value: unknown): (Device & { bridgeOwnerKey?: string }) | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  // Device records are read from a shared JSON file that may also be written
  // by another product (or by an older Studio version). Never spread that
  // object into the adapter result: legacy records can contain credentials or
  // arbitrary plugin fields which must not cross this boundary. Keep only the
  // fields understood by the Sim2Real device contract and bound every string
  // before a future BoardAgent receives it.
  const optionalText = (key: string, maxLength: number): string | undefined => {
    const raw = source[key];
    if (typeof raw !== 'string') return undefined;
    const text = raw.trim();
    if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) return undefined;
    return text;
  };
  const optionalPort = (key: string): number | undefined => {
    const raw = source[key];
    return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 1 && raw <= 65_535
      ? raw
      : undefined;
  };
  const id = typeof source.id === 'string' ? source.id.trim() : '';
  const host = typeof source.host === 'string' ? source.host.trim() : '';
  const username = typeof source.username === 'string' ? source.username.trim() : '';
  const status =
    source.status === 'connected' || source.status === 'disconnected' ? source.status : null;
  const lastCheckedAt = typeof source.lastCheckedAt === 'string' ? source.lastCheckedAt.trim() : '';
  if (
    !id ||
    id.length > 160 ||
    !host ||
    host.length > 255 ||
    !username ||
    username.length > 160 ||
    !status ||
    !lastCheckedAt ||
    /[\u0000-\u001f\u007f]/.test(id + host + username + lastCheckedAt)
  ) {
    return null;
  }
  const normalized: Device & { bridgeOwnerKey?: string } = {
    id,
    host,
    username,
    status,
    lastCheckedAt,
  };
  const name = optionalText('name', 120);
  if (name) normalized.name = name;
  const port = optionalPort('port');
  if (port !== undefined) normalized.port = port;
  const manualDisconnectedAt = optionalText('manualDisconnectedAt', 80);
  if (manualDisconnectedAt) normalized.manualDisconnectedAt = manualDisconnectedAt;
  const boardPlatform = optionalText('boardPlatform', 80);
  if (boardPlatform) normalized.boardPlatform = boardPlatform;
  const boardModel = optionalText('boardModel', 120);
  if (boardModel) normalized.boardModel = boardModel;
  const boardOsVersion = optionalText('boardOsVersion', 120);
  if (boardOsVersion) normalized.boardOsVersion = boardOsVersion;
  const boardDetectedAt = optionalText('boardDetectedAt', 80);
  if (boardDetectedAt) normalized.boardDetectedAt = boardDetectedAt;
  const boardFamilyDetectedBy = optionalText('boardFamilyDetectedBy', 32);
  if (
    boardFamilyDetectedBy === 'uname' ||
    boardFamilyDetectedBy === 'os-release' ||
    boardFamilyDetectedBy === 'device-tree' ||
    boardFamilyDetectedBy === 'tegra-release' ||
    boardFamilyDetectedBy === 'cpuinfo' ||
    boardFamilyDetectedBy === 'timeout'
  ) {
    normalized.boardFamilyDetectedBy = boardFamilyDetectedBy;
  }
  const researchSeeds = Array.isArray(source.researchSeeds)
    ? source.researchSeeds
        .slice(0, 8)
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter((item) => item && item.length <= 300 && !/[\u0000-\u001f\u007f]/.test(item))
    : [];
  if (researchSeeds.length) normalized.researchSeeds = researchSeeds;
  const lanSshHost = optionalText('lanSshHost', 255);
  if (lanSshHost) normalized.lanSshHost = lanSshHost;
  const lanSshPort = optionalPort('lanSshPort');
  if (lanSshPort !== undefined) normalized.lanSshPort = lanSshPort;
  const frpRemotePort = optionalPort('frpRemotePort');
  if (frpRemotePort !== undefined) normalized.frpRemotePort = frpRemotePort;
  const sshReachability = optionalText('sshReachability', 16);
  if (sshReachability === 'direct' || sshReachability === 'tunnel') {
    normalized.sshReachability = sshReachability;
  }
  const connectionMode = optionalText('connectionMode', 16);
  if (connectionMode === 'direct' || connectionMode === 'bridge') {
    normalized.connectionMode = connectionMode;
  }
  const bridgeId = optionalText('bridgeId', 160);
  if (bridgeId) normalized.bridgeId = bridgeId;
  const bridgeDeviceId = optionalText('bridgeDeviceId', 160);
  if (bridgeDeviceId) normalized.bridgeDeviceId = bridgeDeviceId;
  const bridgeTransport = optionalText('bridgeTransport', 24);
  if (
    bridgeTransport === 'ssh' ||
    bridgeTransport === 'usb-ethernet' ||
    bridgeTransport === 'serial'
  ) {
    normalized.bridgeTransport = bridgeTransport;
  }
  const bridgeOwnerKey = optionalText('bridgeOwnerKey', 200);
  if (bridgeOwnerKey) normalized.bridgeOwnerKey = bridgeOwnerKey;
  return normalized;
}

export async function readDevices(): Promise<Device[]> {
  try {
    const raw = await fs.readFile(path.join(resolveDataDir(), 'devices.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // A corrupt record must not make the whole overview fail. Keep a bounded
    // registry in memory; the device manager remains the owner of persistence.
    return parsed
      .slice(0, 500)
      .map(normalizedDevice)
      .filter((device): device is Device => device !== null);
  } catch {
    return [];
  }
}

/**
 * Persist only board passport fields through the standalone device adapter.
 * The device registry remains the owner of credentials and other fields; this
 * narrow update preserves the raw records and uses an atomic rename.
 */
export function persistDeviceBoardDetection(
  id: string,
  patch: {
    boardPlatform?: string | null;
    boardModel?: string | null;
    boardOsVersion?: string | null;
    researchSeeds?: string[];
  },
): Promise<boolean> {
  const operation = deviceWriteQueue.then(async () => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(id)) return false;
    const clean = (value: unknown, max: number): string | null => {
      if (value == null) return null;
      if (typeof value !== 'string') return null;
      const text = value.trim();
      return text && text.length <= max && !/[\u0000-\u001f\u007f]/.test(text) ? text : null;
    };
    const boardPlatform = clean(patch.boardPlatform, 80);
    const boardModel = clean(patch.boardModel, 120);
    const boardOsVersion = clean(patch.boardOsVersion, 120);
    const researchSeeds = Array.isArray(patch.researchSeeds)
      ? patch.researchSeeds
          .slice(0, 8)
          .map((item) => clean(item, 300))
          .filter((item): item is string => Boolean(item))
      : [];
    const file = path.join(resolveDataDir(), 'devices.json');
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      return false;
    }
    if (!Array.isArray(parsed)) return false;
    let found = false;
    const next = parsed.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
      const source = item as Record<string, unknown>;
      if (source.id !== id) return item;
      found = true;
      return {
        ...source,
        boardPlatform,
        boardModel,
        boardOsVersion,
        researchSeeds,
        boardDetectedAt: new Date().toISOString(),
      };
    });
    if (!found) return false;
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
      await fs.rename(temporary, file);
      return true;
    } catch {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      return false;
    }
  });
  deviceWriteQueue = operation.catch(() => undefined);
  return operation as Promise<boolean>;
}

export function isForeignOwnedDevice(
  device: Device & { bridgeOwnerKey?: string },
  ownerKey: string | null | undefined,
  multiUser = false,
): boolean {
  const deviceOwner = String(device.bridgeOwnerKey ?? '').trim();
  // In a shared deployment an ownerless or malformed record is not public;
  // hiding it is safer than allowing one tenant to claim it. Single-user
  // development keeps the convenient legacy behaviour and can inspect all
  // locally discovered devices.
  if (!multiUser) return false;
  if (!deviceOwner || !ownerKey) return true;
  return deviceOwner !== ownerKey;
}

export function requestOwnsDevice(
  request: Request,
  device: Device & { bridgeOwnerKey?: string },
  expectedOwnerKey?: string | null,
  multiUser = false,
): boolean {
  const owner = String(device.bridgeOwnerKey ?? '').trim();
  // A standalone service is intentionally private to its operator. It may
  // inspect the local device registry even when records carry an owner key
  // copied from Studio; there is no cross-tenant boundary to enforce here.
  if (!multiUser) return true;
  // The route has already resolved the verified principal and passes the
  // derived owner key. Never trust a client header here; a missing key remains
  // fail-closed in shared mode, while an injected SSO adapter can operate its
  // own devices. Unknown owner-key formats are deliberately not special-cased.
  void request;
  return Boolean(owner && expectedOwnerKey && owner === expectedOwnerKey);
}

type BoardAgentRunOptions = {
  timeoutMs?: number;
  abortSignal?: AbortSignal;
};

/** Fixed read-only probe shared by the deployment and device-detect routes. */
export function buildBoardPreflightCommand(): string {
  return [
    'set +e',
    `printf "${BOARD_PREFLIGHT_BEGIN}\\n"`,
    'printf "arch=%s\\n" "$(uname -m 2>/dev/null || echo unknown)"',
    'printf "kernel=%s\\n" "$(uname -r 2>/dev/null || echo unknown)"',
    'printf "python3=%s\\n" "$(command -v python3 2>/dev/null || echo missing)"',
    'printf "tros=%s\\n" "$(if test -d /opt/tros || test -d /opt/ros; then echo present; else echo missing; fi)"',
    'printf "disk_bytes=%s\\n" "$(df -Pk /tmp 2>/dev/null | awk \'NR==2 {print $4 * 1024}\' || echo unknown)"',
    // Honest BPU toolchain probe: report presence of the quantization
    // (hbdk-sim) and on-device runtime (hbrtmlin/hbrt-tv) tools on PATH.
    // Presence only — parsing versions here would let a partial install or
    // an unusual version string silently fail deployment preflight.
    'printf "bpu_toolchain=%s\\n" "$(if command -v hbdk-sim >/dev/null 2>&1 && (command -v hbrtmlin >/dev/null 2>&1 || command -v hbrt-tv >/dev/null 2>&1); then echo present; else echo missing; fi)"',
    `printf "${BOARD_PREFLIGHT_END}\\n"`,
  ].join('; ');
}

function parseBoardPreflight(output: string): Record<string, string> {
  const text = String(output || '');
  const begin = text.indexOf(BOARD_PREFLIGHT_BEGIN);
  const end = text.indexOf(BOARD_PREFLIGHT_END, begin + BOARD_PREFLIGHT_BEGIN.length);
  if (begin < 0 || end <= begin) return {};
  const fields: Record<string, string> = {};
  for (const line of text.slice(begin + BOARD_PREFLIGHT_BEGIN.length, end).split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (/^(?:arch|kernel|python3|tros|disk_bytes|bpu_toolchain)$/.test(key))
      fields[key] = value.slice(0, 255);
  }
  // A board passport is only useful when the complete fixed probe was
  // returned.  Do not let a partial/malformed agent response look like a
  // successful detection with a handful of fields.
  const required = ['arch', 'kernel', 'python3', 'tros', 'disk_bytes', 'bpu_toolchain'];
  return required.every((key) => fields[key]) ? fields : {};
}

/**
 * BoardAgent base URL after the SSRF-safe parse: plain HTTP is limited to
 * loopback; remote agents must use TLS; credentials/query/hash are rejected.
 * Exported for the board-station proxy, which shares the same rule.
 *
 * In single-user (standalone) mode, a web-managed tunnel connection that is
 * currently up takes precedence over the env URL: it is still a loopback URL
 * (the tunnel process owns the outbound SSH), so the SSRF boundary is intact.
 * Multi-user deployments never consult tunnels — their agent endpoint is
 * deployment infrastructure, not per-operator state.
 */
export function boardAgentUrl(): string | null {
  const raw = String(process.env.RDK_SIM2REAL_BOARD_AGENT_URL ?? '')
    .trim()
    .replace(/\/+$/, '');
  let fromEnv: string | null = null;
  if (raw) {
    try {
      const parsed = new URL(raw);
      const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
      const loopback = ['localhost', '127.0.0.1', '::1'].includes(hostname);
      // Plain HTTP is intentionally limited to loopback. A remote agent must
      // use TLS so credentials and preflight results cannot be intercepted.
      if (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopback)) {
        if (!parsed.username && !parsed.password && !parsed.search && !parsed.hash) {
          fromEnv = parsed.toString().replace(/\/+$/, '');
        }
      }
    } catch {
      fromEnv = null;
    }
  }
  if (!isMultiUserStandaloneAuth()) {
    const tunneled = activeTunnelAgentUrl();
    if (tunneled) return tunneled;
  }
  return fromEnv;
}

/** Whether the composition root has a syntactically safe BoardAgent endpoint. */
export function isBoardAgentConfigured(): boolean {
  return Boolean(boardAgentUrl() || studioBridgeConfiguration());
}
/**
 * Shared Studio deployments can reach a board through the already-authenticated
 * Local Bridge WebSocket. Sim2Real uses Studio's device exec route as a narrow
 * command transport in that mode, so the board never needs a second tunnel.
 */
export function studioBridgeConfiguration(): {
  origin: string;
  deviceId: string;
  agentPort: number;
} | null {
  const origin = String(process.env.RDK_SIM2REAL_STUDIO_EXEC_ORIGIN ?? '')
    .trim()
    .replace(/\/+$/, '');
  const deviceId = String(process.env.RDK_SIM2REAL_STUDIO_DEVICE_ID ?? '').trim();
  const agentPort = Number(process.env.RDK_SIM2REAL_STUDIO_AGENT_PORT ?? 19100);
  if (!/^https?:\/\/[^\s/]+(?::\d+)?$/.test(origin)) return null;
  // The registry can supply a per-device Studio bridge id. Keep the
  // environment value optional so one deployment can serve multiple bridge
  // devices; a non-empty value still receives the same strict validation.
  if (deviceId && !/^[A-Za-z0-9._:-]{1,160}$/.test(deviceId)) return null;
  if (!Number.isSafeInteger(agentPort) || agentPort < 1 || agentPort > 65535) return null;
  return { origin, deviceId, agentPort };
}

/**
 * Small HTTP BoardAgent client for a private server deployment.
 *
 * The agent receives a structured command request; this process never runs
 * the command locally or interpolates it into a shell. The reference agent
 * in `services/sim2real-web/local-board-agent.mjs` only implements the
 * read-only passport probe. Production deployments should replace this
 * function with an authenticated BoardAgentPort that owns actuator policy.
 */
export const runOnDevice = async (
  _request: Request,
  _response: Response,
  id: string,
  commands: string[],
  options: BoardAgentRunOptions = {},
): Promise<{
  device: unknown;
  output: string;
  exitCode?: number;
  mock?: boolean;
  actuatorControl?: boolean;
} | null> => {
  const baseUrl = boardAgentUrl();
  if (
    !baseUrl ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(id) ||
    !Array.isArray(commands) ||
    !commands.length ||
    commands.length > 8 ||
    commands.some((command) => typeof command !== 'string' || command.length > 16_000)
  )
    return null;
  const token = String(process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN ?? '').trim();
  if (token.length > 4096 || /[\u0000-\u001f\u007f]/.test(token)) return null;
  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs) || 45_000, 1_000), 60_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  options.abortSignal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(`${baseUrl}/v1/devices/${encodeURIComponent(id)}/commands`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ commands: commands.slice(0, 8) }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_ROBOGO_API_RESPONSE_BYTES)
      return null;
    const raw = await response.text();
    if (Buffer.byteLength(raw, 'utf8') > MAX_ROBOGO_API_RESPONSE_BYTES) return null;
    const payload = JSON.parse(raw) as Record<string, unknown>;
    const output = typeof payload.output === 'string' ? payload.output : '';
    if (!output || output.length > 12_000) return null;
    const device = payload.device && typeof payload.device === 'object' ? payload.device : { id };
    const exitCode = Number(payload.exitCode);
    return {
      device,
      output,
      ...(Number.isSafeInteger(exitCode) ? { exitCode } : {}),
      ...(typeof payload.mock === 'boolean' ? { mock: payload.mock } : {}),
      ...(typeof payload.actuatorControl === 'boolean'
        ? { actuatorControl: payload.actuatorControl }
        : {}),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    options.abortSignal?.removeEventListener('abort', abort);
  }
};

/**
 * Read-only board detection route backed by the injected BoardAgent. It is
 * intentionally separate from the deployment release gate: detecting and
 * persisting a passport never uploads an artifact or enables actuators.
 */
export function createDeviceBoardDetectRouter(
  runner: typeof runOnDevice,
  options: { auth?: Sim2RealAuthPort } = {},
): Router {
  const router = Router();
  const auth = options.auth ?? standaloneAuth;
  router.post('/api/devices/:id/board/detect', (request, response, next) => {
    void (async () => {
      const principal = auth.resolvePrincipal(request);
      if (auth.isMultiUserDeployment() && !principal) {
        response.status(401).json({
          ok: false,
          error: 'SIM2REAL_AUTH_REQUIRED',
          message: '共享部署需要已验证的账号会话。',
        });
        return;
      }
      const id = String(request.params.id || '').trim();
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(id)) {
        response.status(400).json({
          ok: false,
          error: 'SIM2REAL_DEVICE_ID_INVALID',
          message: '设备 ID 格式无效。',
        });
        return;
      }
      const devices = (await readDevices()) as Array<Device & { bridgeOwnerKey?: string }>;
      const device = devices.find((item) => item.id === id);
      const ownerKey = principal?.accountId ? `sso:${principal.accountId}:web` : null;
      if (!device || !requestOwnsDevice(request, device, ownerKey, auth.isMultiUserDeployment())) {
        response.status(404).json({
          ok: false,
          error: 'SIM2REAL_DEVICE_NOT_FOUND',
          message: '设备不存在，或不属于当前账号。',
        });
        return;
      }
      const executed = await runner(request, response, id, [buildBoardPreflightCommand()], {
        timeoutMs: 45_000,
      });
      if (!executed) {
        response.status(503).json({
          ok: false,
          error: 'SIM2REAL_BOARD_AGENT_UNAVAILABLE',
          message: '板端只读预检未返回结果；未执行模型下发或电机动作。',
          retryable: true,
        });
        return;
      }
      const fields = parseBoardPreflight(executed.output);
      if (!Object.keys(fields).length || (executed.exitCode != null && executed.exitCode !== 0)) {
        response.status(502).json({
          ok: false,
          error: 'SIM2REAL_BOARD_PASSPORT_INVALID',
          message: '板端返回的只读 passport 不完整；未写入设备元数据，也未执行设备动作。',
          retryable: true,
        });
        return;
      }
      const agentDevice =
        executed.device && typeof executed.device === 'object'
          ? (executed.device as Record<string, unknown>)
          : {};
      const safeField = (key: string): string | undefined => {
        const value = typeof agentDevice[key] === 'string' ? agentDevice[key] : fields[key];
        return typeof value === 'string' && value.trim() ? value.trim().slice(0, 160) : undefined;
      };
      const platform =
        safeField('boardPlatform') || (agentDevice.kind === 'simulated-x5' ? 'rdk-x5' : undefined);
      const model = safeField('boardModel') || safeField('model');
      const osVersion =
        safeField('boardOsVersion') || safeField('osVersion') || safeField('kernel');
      const persisted =
        String(request.query.persist ?? '').toLowerCase() === '1' ||
        String(request.query.persist ?? '').toLowerCase() === 'true'
          ? await persistDeviceBoardDetection(id, {
              boardPlatform: platform || null,
              boardModel: model || null,
              boardOsVersion: osVersion || null,
              researchSeeds: [],
            })
          : false;
      response.json({
        ok: true,
        platform: platform || null,
        model: model || '',
        osVersion: osVersion || '',
        checks: fields,
        device: {
          id,
          ...(platform ? { boardPlatform: platform } : {}),
          ...(model ? { boardModel: model } : {}),
        },
        output: executed.output.slice(0, 12_000),
        persisted,
        mock: executed.mock === true,
        actuatorControl: executed.actuatorControl === true,
      });
    })().catch(next);
  });
  return router;
}

export function createStandaloneRobogoApiClient(
  options: {
    requestToken?: string;
    fetchImpl?: typeof fetch;
    /** Global env token is only safe for a private single-user deployment. */
    allowEnvironmentToken?: boolean;
  } = {},
) {
  const baseUrl = String(process.env.RDK_SIM2REAL_ROBOGO_API_URL || '')
    .trim()
    .replace(/\/+$/, '');
  if (!/^https:\/\//i.test(baseUrl)) throw new Error('robogo_api_not_configured');
  return {
    async request(accountId: string, input: { method: string; path: string; timeoutMs?: number }) {
      const token = String(
        options.requestToken ||
          (options.allowEnvironmentToken ? process.env.RDK_SIM2REAL_ROBOGO_TOKEN : '') ||
          '',
      ).trim();
      if (!token || token.length > 4096 || /[\u0000-\u001f\u007f]/.test(token)) {
        throw new Error('robogo_api_token_not_configured');
      }
      if (!accountId || accountId.length > 160 || /[\u0000-\u001f\u007f/]/.test(accountId)) {
        throw new Error('robogo_api_account_invalid');
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 12_000);
      try {
        const response = await (options.fetchImpl || fetch)(`${baseUrl}${input.path}`, {
          method: input.method,
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${token}`,
            'x-sim2real-account': accountId,
          },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`robogo_http_${response.status}`);
        const declaredLength = Number(response.headers.get('content-length') || 0);
        if (Number.isFinite(declaredLength) && declaredLength > MAX_ROBOGO_API_RESPONSE_BYTES) {
          throw new Error('robogo_api_response_too_large');
        }
        if (!response.body) {
          const raw = await response.text();
          if (Buffer.byteLength(raw, 'utf8') > MAX_ROBOGO_API_RESPONSE_BYTES) {
            throw new Error('robogo_api_response_too_large');
          }
          return raw ? (JSON.parse(raw) as unknown) : null;
        }
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            total += next.value.byteLength;
            if (total > MAX_ROBOGO_API_RESPONSE_BYTES) {
              await reader.cancel();
              throw new Error('robogo_api_response_too_large');
            }
            chunks.push(next.value);
          }
        } finally {
          reader.releaseLock();
        }
        const raw = new TextDecoder().decode(
          Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
        );
        return raw ? (JSON.parse(raw) as unknown) : null;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function collectSandboxBoards(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  const source = value as Record<string, unknown>;
  for (const key of ['boards', 'devices', 'instances', 'data', 'items', 'records', 'list']) {
    if (Array.isArray(source[key])) return source[key] as unknown[];
  }
  return [];
}
