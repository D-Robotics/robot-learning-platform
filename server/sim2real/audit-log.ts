/**
 * Durable, privacy-safe audit trail for the standalone Sim2Real control
 * plane.  The product ledger stores domain resources; this append-only NDJSON
 * stream stores who attempted an operation and what HTTP outcome resulted.
 * Keeping the concerns separate makes the audit path useful during a ledger
 * restore and prevents request bodies or credentials from ever becoming
 * evidence by accident.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import type { Request, RequestHandler } from 'express';

import type { Sim2RealAuthPort, Sim2RealPrincipal } from './sim2real-auth.js';
import { resolveDataDir } from './standalone-adapters.js';
import { redactInternalError } from './http-helpers.js';

export type Sim2RealAuditOutcome = 'succeeded' | 'failed' | 'denied';

export type Sim2RealAuditEvent = {
  id: string;
  at: string;
  owner?: string;
  actor?: {
    accountId: string;
    displayName?: string;
  };
  action: string;
  resourceType: string;
  resourceId?: string;
  outcome: Sim2RealAuditOutcome;
  status: number;
  requestId?: string;
  /** Small, explicitly whitelisted details; never contains request bodies. */
  details?: Record<string, string | number | boolean | null>;
};

export type Sim2RealAuditInput = Omit<Sim2RealAuditEvent, 'id' | 'at'> & {
  id?: string;
  at?: string;
};

/**
 * Identity facts established by a trusted route before the response closes.
 * Cookie/SSO principals are not available for board-agent uploads that use a
 * short-lived Bearer attestation, so routes may attach the verified owner to
 * the request for the generic audit middleware. The symbol keeps this
 * context non-enumerable and prevents a client-controlled field from being
 * mistaken for identity. Never put a raw token or secret here.
 */
export type Sim2RealAuditRequestContext = {
  owner?: string;
  attested?: boolean;
  runId?: string;
  deviceId?: string;
};

export const SIM2REAL_AUDIT_CONTEXT = Symbol('sim2real.audit-context');

type AuditedRequest = Request & {
  [SIM2REAL_AUDIT_CONTEXT]?: Sim2RealAuditRequestContext;
};

export function setSim2RealAuditContext(
  request: Request,
  context: Sim2RealAuditRequestContext,
): void {
  Object.defineProperty(request as AuditedRequest, SIM2REAL_AUDIT_CONTEXT, {
    configurable: true,
    enumerable: false,
    value: { ...context },
    writable: true,
  });
}

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const MAX_EVENT_BYTES = 16 * 1024;
const MAX_READ_EVENTS = 2_000;
const MAX_FIELD = 160;
const MAX_DETAIL_KEYS = 16;
const AUDIT_DIRECTORY_MODE = 0o700;
const AUDIT_FILE_MODE = 0o600;
const NO_FOLLOW = Number(fsSync.constants.O_NOFOLLOW ?? 0);

function cleanText(value: unknown, max = MAX_FIELD): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return text ? text.slice(0, max) : undefined;
}

function safeStatus(value: unknown): number {
  const status = Number(value);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : 500;
}

function safeOutcome(value: unknown, status: number): Sim2RealAuditOutcome {
  if (value === 'succeeded' || value === 'failed' || value === 'denied') return value;
  if (status === 401 || status === 403) return 'denied';
  return status >= 400 ? 'failed' : 'succeeded';
}

function safeDetails(
  value: Record<string, unknown> | undefined,
): Record<string, string | number | boolean | null> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result: Record<string, string | number | boolean | null> = {};
  for (const key of Object.keys(value).slice(0, MAX_DETAIL_KEYS)) {
    const cleanKey = cleanText(key, 64);
    if (!cleanKey || /token|secret|password|cookie|authorization|body|path/i.test(cleanKey))
      continue;
    const item = value[key];
    if (typeof item === 'string') result[cleanKey] = cleanText(item, 240) ?? '';
    else if (typeof item === 'number' && Number.isFinite(item)) result[cleanKey] = item;
    else if (typeof item === 'boolean' || item === null) result[cleanKey] = item;
  }
  return Object.keys(result).length ? result : undefined;
}

function normalizeActor(value: Sim2RealPrincipal | undefined): Sim2RealAuditEvent['actor'] {
  const accountId = cleanText(value?.accountId);
  if (!accountId) return undefined;
  const displayName = cleanText(value?.displayName, 120);
  return { accountId, ...(displayName ? { displayName } : {}) };
}

export function normalizeAuditEvent(input: Sim2RealAuditInput): Sim2RealAuditEvent {
  const status = safeStatus(input.status);
  const action = cleanText(input.action, 200) ?? 'unknown';
  const resourceType = cleanText(input.resourceType, 80) ?? 'unknown';
  const event: Sim2RealAuditEvent = {
    id: cleanText(input.id, 80) ?? randomUUID(),
    at: cleanText(input.at, 40) ?? new Date().toISOString(),
    ...(cleanText(input.owner) ? { owner: cleanText(input.owner) } : {}),
    ...(input.actor ? { actor: normalizeActor(input.actor) } : {}),
    action,
    resourceType,
    ...(cleanText(input.resourceId) ? { resourceId: cleanText(input.resourceId) } : {}),
    outcome: safeOutcome(input.outcome, status),
    status,
    ...(cleanText(input.requestId, 128) ? { requestId: cleanText(input.requestId, 128) } : {}),
    ...(safeDetails(input.details) ? { details: safeDetails(input.details) } : {}),
  };
  return event;
}

function maxBytes(): number {
  const raw = Number(process.env.RDK_SIM2REAL_AUDIT_MAX_BYTES ?? DEFAULT_MAX_BYTES);
  return Number.isSafeInteger(raw) && raw >= 1 * 1024 * 1024 && raw <= 512 * 1024 * 1024
    ? raw
    : DEFAULT_MAX_BYTES;
}

export function sim2RealAuditPath(): string {
  const configured = String(process.env.RDK_SIM2REAL_AUDIT_FILE ?? '').trim();
  if (configured && path.isAbsolute(configured)) return configured;
  return path.join(resolveDataDir(), 'audit.ndjson');
}

let appendChain: Promise<void> = Promise.resolve();
let lastAppendErrorAt: number | undefined;

function isNoEntry(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function modeBits(mode: number): number {
  return mode & 0o7777;
}

/**
 * macOS exposes the writable temporary and variable-data trees through the
 * stable `/tmp` and `/var` aliases.  They are created by the operating system
 * and are present before the service starts, so rejecting those aliases would
 * make the normal test/runtime paths fail.  We still reject every other
 * symlink, including one created below either alias, and continue walking the
 * canonical target from that point onward.
 */
function isTrustedDarwinRootAlias(link: string, target: string): boolean {
  if (process.platform !== 'darwin') return false;
  const normalizedLink = path.normalize(link);
  if (normalizedLink !== '/tmp' && normalizedLink !== '/var') return false;
  return target === `/private${normalizedLink}`;
}

/**
 * Audit files contain account and operation metadata.  Keep the containing
 * directory private instead of silently accepting a pre-created 0755/0750
 * path that would expose the stream to another local user.  The service may
 * create a missing directory, but an existing directory must already be the
 * dedicated 0700 directory provisioned for this service; changing permissions
 * on an arbitrary operator-owned parent (for example /var/log) would be a
 * surprising and unsafe side effect.
 */
async function ensureAuditDirectory(file: string, create: boolean): Promise<boolean> {
  const parent = path.dirname(file);
  // Walk every component instead of relying on recursive mkdir.  A symlink
  // several levels above the final directory would otherwise redirect an
  // apparently safe absolute audit path into an operator-controlled tree.
  const root = path.parse(parent).root;
  const components = path.relative(root, parent).split(path.sep).filter(Boolean);
  let current = root;
  for (const component of components) {
    current = path.join(current, component);
    let info: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      info = await fs.lstat(current);
    } catch (error) {
      if (!isNoEntry(error)) throw error;
      if (!create) return false;
      await fs.mkdir(current, { mode: AUDIT_DIRECTORY_MODE });
      info = await fs.lstat(current);
    }
    if (info.isSymbolicLink()) {
      const target = await fs.realpath(current);
      if (!isTrustedDarwinRootAlias(current, target)) {
        throw new Error('sim2real_audit_directory_symlink');
      }
      current = target;
      continue;
    }
    if (!info.isDirectory()) throw new Error('sim2real_audit_directory_invalid');
  }
  const info = await fs.lstat(parent);
  if (info.isSymbolicLink()) throw new Error('sim2real_audit_directory_symlink');
  if (!info.isDirectory()) throw new Error('sim2real_audit_directory_invalid');
  if (modeBits(info.mode) !== AUDIT_DIRECTORY_MODE) {
    throw new Error('sim2real_audit_directory_permissions');
  }
  return true;
}

/**
 * Check an existing audit segment without following a symlink.  Legacy files
 * created before the hardening may be 0644; they are safely repaired through
 * an O_NOFOLLOW handle, then verified again before the handle is released.
 */
async function ensureAuditFile(file: string): Promise<boolean> {
  let info: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    info = await fs.lstat(file);
  } catch (error) {
    if (isNoEntry(error)) return false;
    throw error;
  }
  if (info.isSymbolicLink()) throw new Error('sim2real_audit_file_symlink');
  if (!info.isFile()) throw new Error('sim2real_audit_file_invalid');
  if (modeBits(info.mode) === AUDIT_FILE_MODE) return true;

  const handle = await fs.open(file, fsSync.constants.O_RDONLY | NO_FOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error('sim2real_audit_file_invalid');
    await handle.chmod(AUDIT_FILE_MODE);
    const secured = await handle.stat();
    if (!secured.isFile() || modeBits(secured.mode) !== AUDIT_FILE_MODE) {
      throw new Error('sim2real_audit_file_permissions');
    }
  } finally {
    await handle.close();
  }
  return true;
}

/** Open a segment with a no-follow flag and enforce its mode on the handle. */
async function openAuditFile(
  file: string,
  flags: number,
  mode?: number,
): Promise<Awaited<ReturnType<typeof fs.open>>> {
  const handle = await fs.open(file, flags | NO_FOLLOW, mode);
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error('sim2real_audit_file_invalid');
    if (modeBits(opened.mode) !== AUDIT_FILE_MODE) await handle.chmod(AUDIT_FILE_MODE);
    const secured = await handle.stat();
    if (!secured.isFile() || modeBits(secured.mode) !== AUDIT_FILE_MODE) {
      throw new Error('sim2real_audit_file_permissions');
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function prepareAuditPath(file: string, createDirectory: boolean): Promise<boolean> {
  const directoryReady = await ensureAuditDirectory(file, createDirectory);
  if (!directoryReady) return false;
  await ensureAuditFile(file);
  await ensureAuditFile(`${file}.1`);
  return true;
}

async function rotateIfNeeded(file: string, incomingBytes: number): Promise<void> {
  let size = 0;
  try {
    const info = await fs.lstat(file);
    if (info.isSymbolicLink()) throw new Error('sim2real_audit_file_symlink');
    if (!info.isFile()) throw new Error('sim2real_audit_file_invalid');
    size = info.size;
  } catch (error) {
    if (!isNoEntry(error)) throw error;
  }
  if (!size || size + incomingBytes <= maxBytes()) return;
  const rotated = `${file}.1`;
  // Keep one bounded previous segment. The current audit stream remains
  // append-only and a rotation is atomic from readers' perspective.
  try {
    const rotatedInfo = await fs.lstat(rotated);
    if (rotatedInfo.isSymbolicLink()) throw new Error('sim2real_audit_file_symlink');
    if (!rotatedInfo.isFile()) throw new Error('sim2real_audit_file_invalid');
  } catch (error) {
    if (!isNoEntry(error)) throw error;
  }
  await fs.rm(rotated, { force: true });
  await fs.rename(file, rotated);
}

async function appendEvent(input: Sim2RealAuditInput): Promise<void> {
  const event = normalizeAuditEvent(input);
  const line = `${JSON.stringify(event)}\n`;
  if (Buffer.byteLength(line, 'utf8') > MAX_EVENT_BYTES) return;
  const file = sim2RealAuditPath();
  await prepareAuditPath(file, true);
  await rotateIfNeeded(file, Buffer.byteLength(line, 'utf8'));
  const handle = await openAuditFile(
    file,
    fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_APPEND,
    AUDIT_FILE_MODE,
  );
  try {
    await handle.writeFile(line, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  lastAppendErrorAt = undefined;
}

/**
 * Append an event without allowing an audit outage to break the user-facing
 * operation. Errors are surfaced to stderr and the caller can inspect the
 * audit health endpoint; domain writes remain authoritative.
 */
export function recordSim2RealAudit(input: Sim2RealAuditInput): void {
  appendChain = appendChain
    .then(() => appendEvent(input))
    .catch((error) => {
      lastAppendErrorAt = Date.now();
      console.error('[sim2real] audit append failed:', redactInternalError(error));
    });
}

/** Test/maintenance hook; production callers normally do not need to await audit I/O. */
export async function flushSim2RealAudit(): Promise<void> {
  await appendChain;
}

async function readSegment(file: string, owner?: string): Promise<Sim2RealAuditEvent[]> {
  if (!(await ensureAuditDirectory(file, false))) return [];
  await ensureAuditFile(file);
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await openAuditFile(file, fsSync.constants.O_RDONLY);
  } catch (error) {
    if (isNoEntry(error)) return [];
    throw error;
  }
  let raw: string;
  try {
    raw = await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
  const result: Sim2RealAuditEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const event = normalizeAuditEvent(parsed as Sim2RealAuditInput);
      if (owner !== undefined && event.owner !== owner) continue;
      result.push(event);
    } catch {
      // A damaged line never hides the rest of the audit stream.
    }
  }
  return result;
}

export async function listSim2RealAuditEvents(
  owner?: string,
  options: {
    limit?: number;
    resourceType?: string;
    outcome?: Sim2RealAuditOutcome;
  } = {},
): Promise<Sim2RealAuditEvent[]> {
  const file = sim2RealAuditPath();
  const segments = await Promise.all([readSegment(`${file}.1`, owner), readSegment(file, owner)]);
  const resourceType = cleanText(options.resourceType, 80);
  const limit = Number.isSafeInteger(options.limit)
    ? Math.max(1, Math.min(MAX_READ_EVENTS, options.limit as number))
    : 200;
  return segments
    .flat()
    .filter((event) => !resourceType || event.resourceType === resourceType)
    .filter((event) => !options.outcome || event.outcome === options.outcome)
    .sort((left, right) => right.at.localeCompare(left.at) || right.id.localeCompare(left.id))
    .slice(0, limit);
}

export async function sim2RealAuditHealth(): Promise<{
  configured: boolean;
  readable: boolean;
  writable: boolean;
  healthy: boolean;
  path: string;
  eventCount?: number;
  lastErrorAt?: string;
}> {
  const file = sim2RealAuditPath();
  try {
    await prepareAuditPath(file, true);
    // `fs.access(W_OK)` is a mode check and can report writable on a
    // read-only filesystem or a full volume. Open the actual append handle
    // and sync it without writing an event so readiness catches the failure
    // before the first mutating request arrives.
    const probe = await openAuditFile(
      file,
      fsSync.constants.O_WRONLY | fsSync.constants.O_APPEND | fsSync.constants.O_CREAT,
      AUDIT_FILE_MODE,
    );
    try {
      await probe.sync();
    } finally {
      await probe.close();
    }
    await fs.access(path.dirname(file), fsSync.constants.R_OK | fsSync.constants.W_OK);
    const events = await listSim2RealAuditEvents(undefined, { limit: MAX_READ_EVENTS });
    return {
      configured: true,
      readable: true,
      writable: true,
      healthy: lastAppendErrorAt === undefined,
      path: file,
      eventCount: events.length,
      ...(lastAppendErrorAt === undefined
        ? {}
        : { lastErrorAt: new Date(lastAppendErrorAt).toISOString() }),
    };
  } catch {
    return {
      configured: false,
      readable: false,
      writable: false,
      healthy: false,
      path: file,
    };
  }
}

function methodIsMutating(method: string): boolean {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase());
}

function requestResourceType(request: Request): string {
  const pathValue = String(request.route?.path ?? request.path ?? '');
  const first = pathValue
    .replace(/^\/+/, '')
    .split('/')
    .find((segment) => segment && !segment.startsWith(':'));
  return cleanText(first, 80) ?? 'api';
}

function requestResourceId(request: Request): string | undefined {
  const params = request.params as Record<string, unknown> | undefined;
  for (const key of ['id', 'runId', 'deploymentId', 'modelId', 'projectId', 'deviceId']) {
    const value = cleanText(params?.[key], 128);
    if (value) return value;
  }
  return undefined;
}

/** Attach an audit event to every mutating API response without reading body/cookie data. */
export function createSim2RealAuditMiddleware(auth: Sim2RealAuthPort): RequestHandler {
  return (request, response, next) => {
    if (!methodIsMutating(request.method) || !String(request.path ?? '').startsWith('/api/')) {
      next();
      return;
    }
    response.on('finish', () => {
      const principal = auth.resolvePrincipal(request);
      const context = (request as AuditedRequest)[SIM2REAL_AUDIT_CONTEXT];
      const owner = auth.isMultiUserDeployment()
        ? (context?.owner ?? principal?.accountId)
        : 'local-dev';
      const requestId = response.getHeader('X-Request-Id');
      const status = Number(response.statusCode) || 500;
      recordSim2RealAudit({
        ...(owner ? { owner } : {}),
        ...(principal ? { actor: principal } : {}),
        action: `${request.method.toUpperCase()} ${String(request.route?.path ?? request.path ?? '').slice(0, 180)}`,
        resourceType: requestResourceType(request),
        ...(requestResourceId(request) ? { resourceId: requestResourceId(request) } : {}),
        outcome:
          status === 401 || status === 403 ? 'denied' : status >= 400 ? 'failed' : 'succeeded',
        status,
        ...(typeof requestId === 'string' ? { requestId } : {}),
        ...(context
          ? {
              details: {
                ...(context.attested === true ? { attested: true } : {}),
                ...(context.runId ? { runId: context.runId } : {}),
                ...(context.deviceId ? { deviceId: context.deviceId } : {}),
              },
            }
          : {}),
      });
    });
    next();
  };
}
