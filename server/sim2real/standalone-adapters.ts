import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Request, RequestHandler, Response } from 'express';
import { Router } from 'express';
import type { Device } from '../../shared/types.js';
import type { Sim2RealAuthPort } from './sim2real-auth.js';
import { principalCan, SIM2REAL_PERMISSIONS } from './sim2real-rbac.js';
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
/** Keep every server-to-server adapter response bounded before JSON parsing. */
const MAX_BOARD_AGENT_RESPONSE_BYTES = 1_000_000;
const MAX_BOARD_AGENT_OUTPUT_CHARS = 12_000;
const MAX_BOARD_AGENT_COMMANDS = 8;
const MAX_BOARD_AGENT_COMMAND_CHARS = 16_000;
const MAX_BOARD_AGENT_REQUEST_BYTES = 128_000;
const MAX_BOARD_AGENT_COOKIE_CHARS = 16_384;
const DEFAULT_ADAPTER_TIMEOUT_MS = 45_000;
const MIN_ADAPTER_TIMEOUT_MS = 1_000;
const MAX_ADAPTER_TIMEOUT_MS = 60_000;
type FetchResponse = Awaited<ReturnType<typeof fetch>>;
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

/**
 * Validate an origin that will receive a browser session cookie. Remote
 * origins must use TLS; plain HTTP is accepted only for loopback development
 * endpoints. Paths, credentials, queries and fragments are rejected so an
 * environment typo cannot turn the bridge into a cookie forwarding proxy.
 */
export function safeStudioOrigin(value: unknown): string | null {
  const raw = String(value ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const loopback = ['localhost', '127.0.0.1', '::1'].includes(hostname);
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
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

/** Register a device discovered through the user's Local Bridge. This is the
 * canonical hand-off between Studio's bridge session and Sim2Real's
 * owner-scoped deployment registry. */
export async function upsertBridgeDevice(input: {
  ownerKey: string;
  bridgeId: string;
  bridgeDeviceId: string;
  name?: string;
  host: string;
  port?: number;
  username?: string;
  transport?: 'ssh' | 'usb-ethernet' | 'serial';
  boardPlatform?: string | null;
  boardModel?: string | null;
}): Promise<Device> {
  const clean = (value: unknown, max: number): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const text = value.trim();
    return text && text.length <= max && !/[\u0000-\u001f\u007f]/.test(text) ? text : undefined;
  };
  const bridgeId = clean(input.bridgeId, 160);
  const bridgeDeviceId = clean(input.bridgeDeviceId, 160);
  const ownerKey = clean(input.ownerKey, 200);
  const host = clean(input.host, 255);
  if (!bridgeId || !bridgeDeviceId || !ownerKey || !host) throw new Error('invalid_bridge_device');
  const username = clean(input.username, 160) || 'root';
  const port =
    Number.isSafeInteger(input.port) && Number(input.port) >= 1 && Number(input.port) <= 65535
      ? Number(input.port)
      : 22;
  const file = path.join(resolveDataDir(), 'devices.json');
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const operation = deviceWriteQueue.then(async () => {
    let parsed: unknown = [];
    try {
      parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      // A missing or malformed bridge cache is recoverable; rebuild it from
      // the device returned by the authenticated Local Bridge call.
    }
    const devices = Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];
    const same = (item: Record<string, unknown>) =>
      item &&
      item.connectionMode === 'bridge' &&
      item.bridgeDeviceId === bridgeDeviceId &&
      item.bridgeOwnerKey === ownerKey;
    const existing: Record<string, unknown> = devices.find(same) ?? {};
    const baseGeneratedId = `bridge-${bridgeDeviceId.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 120)}`;
    // A bridge device id is scoped by the authenticated bridge owner.  The
    // historical id format was derived from the device id alone, so two
    // tenants connecting devices with the same bridge id could accidentally
    // overwrite one another during the atomic registry rewrite.  Keep the
    // short legacy id when it is free, but add a deterministic owner suffix
    // on collision; this preserves reconnect stability without exposing the
    // account id in the device identifier.
    const ownerSuffix = createHash('sha256').update(ownerKey).digest('hex').slice(0, 12);
    const generatedId =
      devices.some((item) => item?.id === baseGeneratedId && item?.bridgeOwnerKey !== ownerKey) &&
      !existing.id
        ? `${baseGeneratedId}-${ownerSuffix}`.slice(0, 160)
        : baseGeneratedId;
    const device = {
      ...existing,
      // Bridge device ids may contain transport/user separators such as @.
      // Keep the persisted platform id URL-safe and stable across reconnects.
      id:
        typeof existing.id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(existing.id)
          ? existing.id
          : generatedId,
      name: clean(input.name, 120) || existing.name || `${username}@${host}`,
      host,
      port,
      username,
      status: 'connected',
      lastCheckedAt: new Date().toISOString(),
      connectionMode: 'bridge',
      bridgeId,
      bridgeDeviceId,
      bridgeTransport: input.transport || 'ssh',
      bridgeOwnerKey: ownerKey,
      ...(clean(input.boardPlatform, 80) ? { boardPlatform: clean(input.boardPlatform, 80) } : {}),
      ...(clean(input.boardModel, 120) ? { boardModel: clean(input.boardModel, 120) } : {}),
    } as Device & { bridgeOwnerKey: string };
    const next = [
      device,
      ...devices.filter(
        (item) => !same(item) && !(item?.id === device.id && item?.bridgeOwnerKey === ownerKey),
      ),
    ].slice(0, 500);
    const temporary = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
    await fs.rename(temporary, file);
    return device;
  });
  deviceWriteQueue = operation.catch(() => undefined);
  return operation;
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
  scope: {
    /** Shared deployments must provide the owner key selected by the route. */
    ownerKey?: string | null;
    /** Single-user standalone mode intentionally keeps legacy id-only updates. */
    multiUser?: boolean;
  } = {},
): Promise<boolean> {
  const operation = deviceWriteQueue.then(async () => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(id)) return false;
    const multiUser = scope.multiUser === true;
    const ownerKey = typeof scope.ownerKey === 'string' ? scope.ownerKey.trim() : '';
    // In a shared deployment an owner-less persistence request is ambiguous;
    // fail closed instead of updating every record that happens to share an id.
    if (multiUser && !ownerKey) return false;
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
      if (multiUser && source.bridgeOwnerKey !== ownerKey) return item;
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
  /** Exact bridge row selected after the caller's owner check. */
  bridgeDeviceId?: string;
  bridgeOwnerKey?: string | null;
};

function adapterTimeout(raw: unknown, fallback = DEFAULT_ADAPTER_TIMEOUT_MS): number {
  const value = Number(raw ?? fallback);
  return Number.isFinite(value)
    ? Math.min(MAX_ADAPTER_TIMEOUT_MS, Math.max(MIN_ADAPTER_TIMEOUT_MS, Math.round(value)))
    : fallback;
}

/**
 * Validate a response length before consuming an untrusted upstream body.
 * `Number('garbage')` is intentionally not treated as zero: malformed
 * framing is a transport failure and must fail closed.
 */
function assertResponseLength(response: FetchResponse, maxBytes: number, errorCode: string): void {
  const raw = response.headers?.get('content-length');
  if (raw == null || raw.trim() === '') return;
  const normalized = raw.trim();
  if (!/^\d+$/.test(normalized)) throw new Error(errorCode);
  const declared = Number(normalized);
  if (!Number.isSafeInteger(declared) || declared > maxBytes) throw new Error(errorCode);
}

/** Read an upstream response with a byte cap before handing it to JSON.parse. */
async function boundedAdapterResponseText(
  response: FetchResponse,
  maxBytes: number,
  errorCode: string,
): Promise<string> {
  assertResponseLength(response, maxBytes, errorCode);
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error(errorCode);
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      total += chunk.byteLength;
      if (!Number.isSafeInteger(total) || total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(errorCode);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

function safeAgentOutput(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  const cleaned = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return cleaned.length <= MAX_BOARD_AGENT_OUTPUT_CHARS
    ? cleaned
    : cleaned.slice(0, MAX_BOARD_AGENT_OUTPUT_CHARS);
}

/**
 * Project an agent device record onto the small public device shape.  Agent
 * responses are third-party input and may contain SSH credentials, tokens or
 * plugin-private fields; spreading the object would expose those values to a
 * later route or log.
 */
function projectBoardAgentDevice(value: unknown, fallbackId: string): Record<string, unknown> {
  const result: Record<string, unknown> = { id: fallbackId };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  const source = value as Record<string, unknown>;
  const textFields = [
    ['id', 160],
    ['name', 120],
    ['kind', 80],
    ['status', 32],
    ['boardPlatform', 80],
    ['boardModel', 120],
    ['boardOsVersion', 120],
    ['osVersion', 120],
    ['model', 120],
    ['transport', 32],
  ] as const;
  for (const [key, maxLength] of textFields) {
    const raw = source[key];
    if (
      typeof raw === 'string' &&
      raw.trim() &&
      raw.length <= maxLength &&
      !/[\u0000-\u001f\u007f]/.test(raw)
    ) {
      result[key] = raw.trim();
    }
  }
  for (const key of ['online', 'mock', 'actuatorControl']) {
    if (typeof source[key] === 'boolean') result[key] = source[key];
  }
  const port = source.port;
  if (typeof port === 'number' && Number.isSafeInteger(port) && port >= 1 && port <= 65_535) {
    result.port = port;
  }
  // The transport is selected by the requested registry id. Do not let an
  // upstream payload silently rebind the result to a different device.
  result.id = fallbackId;
  return result;
}

function validBoardAgentInput(id: unknown, commands: unknown): commands is string[] {
  if (
    typeof id !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(id) ||
    !Array.isArray(commands) ||
    commands.length === 0 ||
    commands.length > MAX_BOARD_AGENT_COMMANDS
  ) {
    return false;
  }
  return commands.every(
    (command) =>
      typeof command === 'string' &&
      command.length <= MAX_BOARD_AGENT_COMMAND_CHARS &&
      !/[\u0000-\u001f\u007f]/.test(command),
  );
}

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

/**
 * A direct BoardAgent endpoint is an internal service-to-service trust
 * boundary.  Local development may intentionally use a loopback reference
 * agent without a token, but a production/web-cloud process must never fall
 * back to an unauthenticated agent just because the endpoint is reachable.
 * Studio Local Bridge is a separate, browser-session-authenticated path and
 * therefore does not require this static bearer token.
 */
export function boardAgentTokenRequired(endpointConfigured = false): boolean {
  const production =
    String(process.env.NODE_ENV ?? '')
      .trim()
      .toLowerCase() === 'production' || isWebCloudDeployment();
  const envConfigured = Boolean(String(process.env.RDK_SIM2REAL_BOARD_AGENT_URL ?? '').trim());
  return production && (endpointConfigured || envConfigured);
}

/** Return only whether the configured BoardAgent bearer is strong enough for
 * a production service.  The secret itself remains private to the adapter. */
export function boardAgentTokenConfigured(): boolean {
  const token = String(process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN ?? '').trim();
  if (token.length < 32 || token.length > 4096 || /[\u0000-\u001f\u007f]/.test(token)) {
    return false;
  }
  // Reject copied template values and one-character/repeated placeholders.
  if (
    /^(?:replace(?:[-_ ]?with)?(?:[-_ ].*)?|change(?:[-_ ]?me)?(?:[-_ ].*)?|changeme(?:[-_ ].*)?|example(?:[-_ ].*)?|placeholder(?:[-_ ].*)?|default(?:[-_ ]?secret)?(?:[-_ ].*)?|dummy(?:[-_ ].*)?|password(?:[-_ ].*)?|your[-_ ]?(?:secret|key)(?:[-_ ].*)?|secret(?:[-_ ].*)?)$/i.test(
      token,
    )
  ) {
    return false;
  }
  return new Set(token).size >= 2;
}

/** True when a configured endpoint can be used safely by this process. */
export function boardAgentConnectionReady(): boolean {
  const endpoint = boardAgentUrl();
  if (!endpoint) return Boolean(studioBridgeConfiguration());
  return !boardAgentTokenRequired(Boolean(endpoint)) || boardAgentTokenConfigured();
}

/** Whether the composition root has a syntactically safe BoardAgent endpoint. */
export function isBoardAgentConfigured(): boolean {
  return boardAgentConnectionReady();
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
  const origin = safeStudioOrigin(process.env.RDK_SIM2REAL_STUDIO_EXEC_ORIGIN);
  const deviceId = String(process.env.RDK_SIM2REAL_STUDIO_DEVICE_ID ?? '').trim();
  const agentPort = Number(process.env.RDK_SIM2REAL_STUDIO_AGENT_PORT ?? 19100);
  if (!origin) return null;
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
  request: Request,
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
  // Validate the target and command envelope before looking up a bridge
  // record.  This keeps malformed calls from reaching either transport and
  // avoids invoking `.join()` on attacker-controlled non-arrays.
  if (!validBoardAgentInput(id, commands)) return null;
  const serializedCommand = commands.join('; ');
  if (
    Buffer.byteLength(JSON.stringify({ command: serializedCommand }), 'utf8') >
    MAX_BOARD_AGENT_REQUEST_BYTES
  ) {
    return null;
  }
  // A Bridge device is reached through the operator's authenticated Studio
  // session. Keep this path ahead of the static BoardAgent URL so a dynamic
  // device selected in the web UI is the same execution target used by
  // preflight and deployment.
  const bridgeHintProvided =
    Object.prototype.hasOwnProperty.call(options, 'bridgeDeviceId') ||
    Object.prototype.hasOwnProperty.call(options, 'bridgeOwnerKey');
  const requestedBridgeDeviceId = String(options.bridgeDeviceId ?? '').trim();
  const requestedBridgeOwnerKey = String(options.bridgeOwnerKey ?? '').trim();
  const bridgeTarget = (await readDevices()).find(
    (device) =>
      device.id === id &&
      device.connectionMode === 'bridge' &&
      (!requestedBridgeDeviceId || device.bridgeDeviceId === requestedBridgeDeviceId) &&
      (!requestedBridgeOwnerKey ||
        (device as Device & { bridgeOwnerKey?: string }).bridgeOwnerKey ===
          requestedBridgeOwnerKey),
  );
  // The route passes the exact row it authorized. If that row disappeared or
  // changed between the ownership read and execution, fail closed instead of
  // selecting another tenant's colliding id or silently falling back to a
  // process-wide agent.
  if (bridgeHintProvided && !bridgeTarget) return null;
  const bridgeDeviceId = String(bridgeTarget?.bridgeDeviceId || '').trim();
  const cookie = String(request?.headers?.cookie || '').trim();
  const studioOrigin = safeStudioOrigin(
    process.env.RDK_SIM2REAL_STUDIO_EXEC_ORIGIN ||
      process.env.RDK_SIM2REAL_STUDIO_ORIGIN ||
      process.env.RDK_STUDIO_WEB_PUBLIC_ORIGIN ||
      'https://rdkstudio.d-robotics.cc',
  );
  const safeCookie =
    cookie.length <= MAX_BOARD_AGENT_COOKIE_CHARS && !/[\u0000-\u001f\u007f]/.test(cookie)
      ? cookie
      : '';
  if (bridgeDeviceId && safeCookie && studioOrigin) {
    const timeoutMs = adapterTimeout(options.timeoutMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(
        `${studioOrigin}/api/devices/${encodeURIComponent(bridgeDeviceId)}/exec`,
        {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            cookie: safeCookie,
            origin: String(
              safeStudioOrigin(
                process.env.RDK_SIM2REAL_PUBLIC_ORIGIN || process.env.RDK_STUDIO_WEB_PUBLIC_ORIGIN,
              ) || studioOrigin,
            ),
          },
          body: JSON.stringify({ command: serializedCommand }),
          signal: controller.signal,
          redirect: 'error',
        },
      );
      if (response.ok) {
        const raw = await boundedAdapterResponseText(
          response,
          MAX_BOARD_AGENT_RESPONSE_BYTES,
          'board_agent_response_too_large',
        );
        const parsed: unknown = raw ? JSON.parse(raw) : null;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const outer = parsed as Record<string, unknown>;
          const output = safeAgentOutput(outer.output);
          if (output) {
            const exitCode =
              typeof outer.exitCode === 'number' && Number.isSafeInteger(outer.exitCode)
                ? outer.exitCode
                : undefined;
            const outerDevice = projectBoardAgentDevice(outer.device, id);
            return {
              device: outerDevice,
              output,
              ...(exitCode === undefined ? {} : { exitCode }),
              ...(typeof outer.mock === 'boolean' ? { mock: outer.mock } : {}),
              ...(typeof outer.actuatorControl === 'boolean'
                ? { actuatorControl: outer.actuatorControl }
                : {}),
            };
          }
        }
      }
    } catch {
      // Fall through to the configured static/tunnel agent. A transient
      // Bridge failure should produce the normal unavailable result.
    } finally {
      clearTimeout(timer);
    }
  }

  const baseUrl = boardAgentUrl();
  if (!baseUrl) return null;
  if (boardAgentTokenRequired(Boolean(baseUrl)) && !boardAgentTokenConfigured()) return null;
  const token = String(process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN ?? '').trim();
  if (token.length > 4096 || /[\u0000-\u001f\u007f]/.test(token)) return null;
  const timeoutMs = adapterTimeout(options.timeoutMs);
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
      redirect: 'error',
    });
    if (!response.ok) return null;
    const raw = await boundedAdapterResponseText(
      response,
      MAX_BOARD_AGENT_RESPONSE_BYTES,
      'board_agent_response_too_large',
    );
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const payload = parsed as Record<string, unknown>;
    const output = safeAgentOutput(payload.output);
    if (!output) return null;
    const device = projectBoardAgentDevice(payload.device, id);
    const exitCode =
      typeof payload.exitCode === 'number' && Number.isSafeInteger(payload.exitCode)
        ? payload.exitCode
        : undefined;
    return {
      device,
      output,
      ...(exitCode === undefined ? {} : { exitCode }),
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
      if (!id || id.length > 160 || /[\u0000-\u001f\u007f]/.test(id)) {
        response.status(400).json({
          ok: false,
          error: 'SIM2REAL_DEVICE_ID_INVALID',
          message: '设备 ID 格式无效。',
        });
        return;
      }
      const ownerKey = principal?.accountId ? `sso:${principal.accountId}:web` : null;
      const devices = (await readDevices()) as Array<Device & { bridgeOwnerKey?: string }>;
      // Resolve the same owner-scoped row that will be passed to the runner;
      // duplicate bridge ids are valid across tenants and must not make one
      // account accidentally select another account's record.
      const device = devices.find(
        (item) =>
          item.id === id &&
          requestOwnsDevice(request, item, ownerKey, auth.isMultiUserDeployment()),
      );
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
        ...(device.connectionMode === 'bridge'
          ? {
              bridgeDeviceId: device.bridgeDeviceId,
              bridgeOwnerKey: device.bridgeOwnerKey ?? ownerKey,
            }
          : {}),
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
      const persistRequested = ['1', 'true'].includes(
        String(request.query.persist ?? '').toLowerCase(),
      );
      if (
        persistRequested &&
        auth.isMultiUserDeployment() &&
        !principalCan(principal, SIM2REAL_PERMISSIONS.edit) &&
        !principalCan(principal, SIM2REAL_PERMISSIONS.operate)
      ) {
        response.status(403).json({
          ok: false,
          error: 'SIM2REAL_PERMISSION_DENIED',
          code: 'SIM2REAL_PERMISSION_DENIED',
          message: '当前账号没有保存设备预检元数据的权限。',
          retryable: false,
        });
        return;
      }
      const persisted = persistRequested
        ? await persistDeviceBoardDetection(
            id,
            {
              boardPlatform: platform || null,
              boardModel: model || null,
              boardOsVersion: osVersion || null,
              researchSeeds: [],
            },
            {
              ownerKey,
              multiUser: auth.isMultiUserDeployment(),
            },
          )
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
  let parsedBase: URL;
  try {
    parsedBase = new URL(baseUrl);
  } catch {
    throw new Error('robogo_api_not_configured');
  }
  if (
    parsedBase.protocol !== 'https:' ||
    parsedBase.username ||
    parsedBase.password ||
    parsedBase.search ||
    parsedBase.hash ||
    /[\u0000-\u001f\u007f]/.test(baseUrl)
  ) {
    throw new Error('robogo_api_not_configured');
  }
  const normalizedBasePath = parsedBase.pathname.replace(/\/+$/, '');
  const resolveRequestUrl = (rawPath: unknown): string => {
    const requestPath = String(rawPath ?? '').trim();
    if (
      !requestPath.startsWith('/') ||
      requestPath.length > 1_024 ||
      /[\u0000-\u001f\u007f\\]/.test(requestPath)
    ) {
      throw new Error('robogo_api_path_invalid');
    }
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(requestPath);
    } catch {
      throw new Error('robogo_api_path_invalid');
    }
    const pathBeforeQuery = decodedPath.split(/[?#]/, 1)[0] ?? '';
    if (pathBeforeQuery.split('/').some((segment) => segment === '..')) {
      throw new Error('robogo_api_path_invalid');
    }
    let target: URL;
    try {
      target = new URL(`${normalizedBasePath}${requestPath}`, parsedBase.origin);
    } catch {
      throw new Error('robogo_api_path_invalid');
    }
    if (
      target.origin !== parsedBase.origin ||
      target.username ||
      target.password ||
      target.hash ||
      target.pathname.split('/').some((segment) => segment === '..')
    ) {
      throw new Error('robogo_api_path_invalid');
    }
    return target.toString();
  };
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
      const method = String(input.method ?? '')
        .trim()
        .toUpperCase();
      if (!/^[A-Z]{1,16}$/.test(method)) throw new Error('robogo_api_method_invalid');
      const targetUrl = resolveRequestUrl(input.path);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), adapterTimeout(input.timeoutMs, 12_000));
      try {
        const response = await (options.fetchImpl || fetch)(targetUrl, {
          method,
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${token}`,
            'x-sim2real-account': accountId,
          },
          signal: controller.signal,
          redirect: 'error',
        });
        if (!response.ok) {
          await boundedAdapterResponseText(
            response,
            MAX_ROBOGO_API_RESPONSE_BYTES,
            'robogo_api_response_too_large',
          ).catch(() => undefined);
          throw new Error(`robogo_http_${response.status}`);
        }
        const raw = await boundedAdapterResponseText(
          response,
          MAX_ROBOGO_API_RESPONSE_BYTES,
          'robogo_api_response_too_large',
        );
        if (!raw) return null;
        let payload: unknown;
        try {
          payload = JSON.parse(raw) as unknown;
        } catch {
          throw new Error('robogo_api_invalid_json');
        }
        return payload;
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
