/**
 * Single validated surface for every environment knob the standalone
 * sim2real-web process reads. server.ts stays routing/composition only; any
 * question of "which env vars affect this process" is answered by this file.
 *
 * Two consumption styles live here on purpose:
 *  - `resolveSim2RealWebEnv` gives the boot path one validated snapshot with
 *    human-readable warnings, so a typo like `RDK_SIM2REAL_PORT=808o` is
 *    announced at startup instead of silently falling back to the default.
 *  - the individual parsers stay callable per request: the MicroDuck static
 *    root must be re-resolved per request so operators can atomically switch
 *    the reviewed `current` symlink without a restart (see server.ts mount),
 *    and tests flip env vars between app constructions.
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_SIM2REAL_WEB_PORT = 18_102;
export const DEFAULT_SIM2REAL_WEB_BIND_HOST = '127.0.0.1';

const TRUTHY_FLAGS = new Set(['1', 'true', 'yes', 'on']);

export function parseBooleanFlag(raw: unknown): boolean {
  return TRUTHY_FLAGS.has(
    String(raw ?? '')
      .trim()
      .toLowerCase(),
  );
}

export function isProductionEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.NODE_ENV ?? '').trim() === 'production';
}

export interface ParsedPort {
  port: number;
  warning?: string;
}

export function parsePortValue(raw: unknown): ParsedPort {
  const value = Number(raw ?? DEFAULT_SIM2REAL_WEB_PORT);
  if (Number.isInteger(value) && value >= 1_024 && value <= 65_535) {
    return { port: value };
  }
  const shown = String(raw ?? '').trim();
  return {
    port: DEFAULT_SIM2REAL_WEB_PORT,
    warning: `RDK_SIM2REAL_PORT=${JSON.stringify(shown)} is not an integer in [1024, 65535]; using ${DEFAULT_SIM2REAL_WEB_PORT}.`,
  };
}

/**
 * Canonical browser mount prefix. Empty string means "mounted at root". An
 * invalid value fails closed to the root mount — a bad base path must never
 * produce URLs that only work behind a proxy that happens to strip it.
 */
export function normalizePublicBasePath(raw: unknown): string {
  const value = String(raw ?? '').trim();
  if (!value || value === '/') return '';
  const normalized = `/${value.replace(/^\/+|\/+$/g, '')}`;
  // The charset alone admits '.' and '..' segments (dotted release names are
  // legitimate), so reject those explicitly: a mount prefix is only ever used
  // as a URL prefix and must never encode a relative climb.
  const segments = normalized.split('/');
  if (
    !/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(normalized) ||
    segments.some((segment) => segment === '.' || segment === '..')
  ) {
    return '';
  }
  return normalized;
}

/**
 * Accepted MicroDuck redirect targets: HTTPS anywhere, plain HTTP only on
 * loopback (local dev). Credentials, search and hash are rejected so the
 * redirect can never smuggle state into the upstream request.
 */
export function normalizeMicroduckRedirect(raw: unknown): string | null {
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

/**
 * The static MicroDuck release root. Relative paths are rejected (the value
 * meaningfully depends on the process cwd otherwise), and the directory must
 * already contain the entry document.
 */
export function resolveMicroduckStaticRoot(raw: unknown): string | null {
  const value = String(raw ?? '').trim();
  if (!value || !path.isAbsolute(value)) return null;
  try {
    return existsSync(path.join(value, 'index.html')) && statSync(value).isDirectory()
      ? value
      : null;
  } catch {
    return null;
  }
}

export function parseDirectBoardAgentUrl(raw: unknown): string {
  return String(raw ?? '').trim();
}

/**
 * Unlike the boolean flags above, trust proxy deliberately accepts only the
 * literal `1`: silently widening proxy trust because someone wrote "true"
 * would change remote-address semantics for every rate-limit and audit entry.
 */
export function parseTrustProxyFlag(raw: unknown): boolean {
  return String(raw ?? '').trim() === '1';
}

export interface Sim2RealWebEnvSnapshot {
  port: number;
  host: string;
  publicBasePath: string;
  microduckRoot: string | null;
  microduckRedirectUrl: string | null;
  microduckRequired: boolean;
  trustProxy: boolean;
  directBoardAgentUrl: string;
  isProduction: boolean;
  /** Invalid configured values that were replaced by a safe default. */
  warnings: string[];
}

export function resolveSim2RealWebEnv(
  env: NodeJS.ProcessEnv = process.env,
): Sim2RealWebEnvSnapshot {
  const warnings: string[] = [];
  const { port, warning } = parsePortValue(env.RDK_SIM2REAL_PORT);
  if (warning) warnings.push(warning);

  const host = String(env.RDK_SIM2REAL_BIND_HOST ?? '').trim() || DEFAULT_SIM2REAL_WEB_BIND_HOST;
  const rawBasePath = String(env.RDK_SIM2REAL_PUBLIC_BASE_PATH ?? '').trim();
  const publicBasePath = normalizePublicBasePath(rawBasePath);
  if (rawBasePath && rawBasePath !== '/' && !publicBasePath) {
    warnings.push(
      `RDK_SIM2REAL_PUBLIC_BASE_PATH=${JSON.stringify(rawBasePath)} is not a valid mount prefix; mounting at root.`,
    );
  }
  const rawRedirect = String(env.RDK_SIM2REAL_MICRODUCK_URL ?? '').trim();
  const microduckRedirectUrl = normalizeMicroduckRedirect(rawRedirect);
  if (rawRedirect && !microduckRedirectUrl) {
    warnings.push(
      'RDK_SIM2REAL_MICRODUCK_URL was rejected (https, or plain http on loopback only, no credentials/search/hash).',
    );
  }

  return {
    port,
    host,
    publicBasePath,
    microduckRoot: resolveMicroduckStaticRoot(env.RDK_SIM2REAL_MICRODUCK_ROOT),
    microduckRedirectUrl,
    microduckRequired: parseBooleanFlag(env.RDK_SIM2REAL_REQUIRE_MICRODUCK),
    trustProxy: String(env.EXPRESS_TRUST_PROXY ?? '').trim() === '1',
    directBoardAgentUrl: parseDirectBoardAgentUrl(env.RDK_SIM2REAL_BOARD_AGENT_URL),
    isProduction: isProductionEnv(env),
    warnings,
  };
}
