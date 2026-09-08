import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Request } from 'express';

import type { Sim2RealAuthPort, Sim2RealPrincipal } from './sim2real-auth.js';

/**
 * Drop-in auth adapter for the rdkstudio.d-robotics.cc web-cloud deployment.
 *
 * RDK Studio's login flow (`POST /api/sso/direct/login` on the Studio main
 * shell) issues a site-wide encrypted session cookie, `rdk_sso_web_session`.
 * Because nginx serves `/sim2real/` from the same origin, the browser sends
 * that cookie here too. This adapter decrypts it with the shared
 * `RDK_STUDIO_COOKIE_SECRET` — the exact AES-256-GCM envelope Studio uses
 * (see dist-server/server/sso-web-cloud-cookie.js) — so a Studio login
 * transparently authenticates the Sim2Real workbench without a second login.
 *
 * Contract with Studio's implementation (must stay byte-compatible):
 *   cookie value  = "v1." + b64url(iv) + "." + b64url(authTag) + "." + b64url(ciphertext)
 *   key           = sha256(secret)                              (32 bytes)
 *   plaintext     = JSON { v: 1, user: {id,name,email,avatar?}, expiresAt, accessToken? }
 *   cookie string = encodeURIComponent(<value>)
 * Secrets: RDK_STUDIO_COOKIE_SECRET (current) plus a comma-separated
 * RDK_STUDIO_COOKIE_SECRET_PREVIOUS rotation grace list, both >= 32 chars.
 */
export const STUDIO_WEB_CLOUD_SESSION_COOKIE = 'rdk_sso_web_session';

const MIN_SECRET_LENGTH = 32;
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_ACCOUNT_ID_LENGTH = 160;

function cookieSecrets(options?: { secret?: string; previousSecrets?: string }): string[] {
  const rawPrevious = options
    ? options.previousSecrets
    : process.env.RDK_STUDIO_COOKIE_SECRET_PREVIOUS;
  const values = [
    options ? options.secret : process.env.RDK_STUDIO_COOKIE_SECRET,
    ...String(rawPrevious ?? '')
      .split(',')
      .map((item) => item.trim()),
  ];
  const unique: string[] = [];
  for (const value of values) {
    const secret = String(value ?? '').trim();
    if (secret.length < MIN_SECRET_LENGTH) continue;
    if (!unique.includes(secret)) unique.push(secret);
  }
  return unique;
}

function cookieKey(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

function safeAccountText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim().slice(0, maxLength);
  if (!text || /[\u0000-\u001f\u007f]/.test(text)) return undefined;
  return text;
}

type WebCloudCookieUser = {
  id: string;
  name: string;
  email: string;
  avatar?: string;
};

type WebCloudCookiePayload = {
  v: 1;
  user: WebCloudCookieUser;
  expiresAt: number;
  accessToken?: string;
};

/** Decoded principal + RoboGo runner token from a validated session cookie. */
export type StudioCookieIdentity = {
  principal: Sim2RealPrincipal;
  runnerToken?: string;
  expiresAt: number;
};

export function parseCookieValue(cookieHeader: unknown, name: string): string {
  const header = Array.isArray(cookieHeader)
    ? String(cookieHeader[0] ?? '')
    : String(cookieHeader ?? '');
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return '';
  }
}

/**
 * Decrypt and validate a Studio web-cloud session cookie value. The GCM auth
 * tag makes tampering detectable; expiry and user shape are re-validated after
 * decryption. Any malformed input fails closed by returning null.
 */
export function decodeStudioWebCloudCookie(
  value: string,
  options: { secrets?: string[]; now?: () => number } = {},
): WebCloudCookiePayload | null {
  const parts = String(value ?? '').split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  const secrets = options.secrets ?? cookieSecrets();
  if (!secrets.length) return null;
  const now = options.now ?? Date.now;
  let iv: Buffer;
  let authTag: Buffer;
  let ciphertext: Buffer;
  try {
    iv = Buffer.from(parts[1], 'base64url');
    authTag = Buffer.from(parts[2], 'base64url');
    ciphertext = Buffer.from(parts[3], 'base64url');
  } catch {
    return null;
  }
  if (iv.length !== 12 || authTag.length !== 16 || ciphertext.length === 0) return null;
  for (const secret of secrets) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', cookieKey(secret), iv);
      decipher.setAuthTag(authTag);
      const raw = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const user = parsed.user;
      const expiresAt = parsed.expiresAt;
      if (
        parsed.v !== 1 ||
        typeof expiresAt !== 'number' ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= now() ||
        !user ||
        typeof (user as Record<string, unknown>).id !== 'string' ||
        !String((user as Record<string, unknown>).id).trim()
      ) {
        return null;
      }
      return {
        v: 1,
        user: {
          id: String((user as Record<string, unknown>).id),
          name: typeof (user as Record<string, unknown>).name === 'string'
            ? String((user as Record<string, unknown>).name)
            : '',
          email: typeof (user as Record<string, unknown>).email === 'string'
            ? String((user as Record<string, unknown>).email)
            : '',
          ...(typeof (user as Record<string, unknown>).avatar === 'string'
            ? { avatar: String((user as Record<string, unknown>).avatar) }
            : {}),
        },
        expiresAt,
        ...(typeof parsed.accessToken === 'string' && parsed.accessToken.trim()
          ? { accessToken: parsed.accessToken }
          : {}),
      };
    } catch {
      // Try the next secret during a rotation grace period.
    }
  }
  return null;
}

/** Mint a Studio-compatible cookie — the mirror of the decoder, used by tests. */
export function encodeStudioWebCloudCookie(
  user: WebCloudCookieUser,
  expiresAt: number,
  accessToken?: string,
  options: { secret?: string } = {},
): string | null {
  const secret = options.secret ?? cookieSecrets()[0];
  if (!secret) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cookieKey(secret), iv);
  const payload: Record<string, unknown> = { v: 1, user, expiresAt };
  if (accessToken) payload.accessToken = accessToken;
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

function resolveIdentity(
  request: Request,
  options: { secrets?: string[]; now?: () => number },
): StudioCookieIdentity | null {
  const value = parseCookieValue(request.headers.cookie, STUDIO_WEB_CLOUD_SESSION_COOKIE);
  const payload = decodeStudioWebCloudCookie(value, options);
  if (!payload) return null;
  const accountId = safeAccountText(payload.user.id, MAX_ACCOUNT_ID_LENGTH);
  if (!accountId || accountId.includes('/')) return null;
  return {
    principal: {
      accountId,
      ...(safeAccountText(payload.user.name, 120) ? { displayName: payload.user.name.trim().slice(0, 120) } : {}),
      ...(safeAccountText(payload.user.email, 240) ? { email: payload.user.email.trim().slice(0, 240) } : {}),
    },
    ...(safeAccountText(payload.accessToken, 4_096) ? { runnerToken: payload.accessToken } : {}),
    expiresAt: payload.expiresAt,
  };
}

/** Whether the shared cookie secret is present (readiness probes only). */
export function studioCookieAuthConfigured(options?: { secret?: string }): boolean {
  return cookieSecrets(options).length > 0;
}

/**
 * Create the auth port. Without a usable secret the adapter stays fail-closed:
 * multi-user mode rejects every caller instead of silently trusting cookies.
 */
export function createStudioCookieAuth(options: {
  secret?: string;
  previousSecrets?: string;
  now?: () => number;
} = {}): Sim2RealAuthPort {
  const verifyOptions = {
    ...(options.secret !== undefined || options.previousSecrets !== undefined
      ? {
          secrets: cookieSecrets({
            secret: options.secret,
            previousSecrets: options.previousSecrets,
          }),
        }
      : {}),
    now: options.now,
  };
  const identityCache = new WeakMap<object, StudioCookieIdentity | null>();
  const verify = (request: Request): StudioCookieIdentity | null => {
    if (identityCache.has(request)) return identityCache.get(request) ?? null;
    const identity = resolveIdentity(request, verifyOptions);
    identityCache.set(request, identity);
    return identity;
  };
  return Object.freeze({
    isMultiUserDeployment: () => true,
    resolvePrincipal: (request: Request) => verify(request)?.principal ?? null,
    resolveAccessToken: (request: Request) => verify(request)?.runnerToken ?? null,
  });
}

/** Default session TTL exported for login relay response consistency. */
export const STUDIO_COOKIE_SESSION_TTL_MS = SESSION_TTL_MS;
