/** Account-bound, in-memory transport only. Existing platform routes own all business admission. */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export type DesktopRelayDevice = {
  id: string;
  name: string;
  status: 'connected' | 'disconnected';
  boardPlatform?: string;
  boardModel?: string;
};
export type DesktopRelayCommand = {
  requestId: string;
  deviceId: string;
  method: 'GET' | 'POST';
  path: string;
  body?: string;
  agentToken?: string;
  deadlineAt: number;
};
export type DesktopRelayReply = { ok: true; status: number } & (
  { body: string; contentType: string } | { bodyBase64: string; contentType: 'image/jpeg' }
);
export class StudioDesktopRelayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
export type DesktopRelayOptions = {
  now?: () => number;
  sessionTtlMs?: number;
  maxSessionAgeMs?: number;
  pollTimeoutMs?: number;
  maxSessionsPerOwner?: number;
  maxSessions?: number;
  maxDevicesPerSession?: number;
  maxPendingPerSession?: number;
  maxPending?: number;
};
type CommandInput = Pick<DesktopRelayCommand, 'method' | 'path' | 'body' | 'agentToken'>;
type Timer = ReturnType<typeof setTimeout>;
type Pending = {
  command: DesktopRelayCommand;
  delivered: boolean;
  resolve: (reply: DesktopRelayReply) => void;
  reject: (error: StudioDesktopRelayError) => void;
  cleanup: () => void;
};
type Poll = {
  resolve: (command: DesktopRelayCommand | null) => void;
  reject: (error: StudioDesktopRelayError) => void;
  cleanup: () => void;
};
type Session = {
  id: string;
  owner: string;
  token: string;
  devices: DesktopRelayDevice[];
  sequence: number;
  expiresAt: number;
  absoluteExpiry: number;
  timer?: Timer;
  poll?: Poll;
  pending: Map<string, Pending>;
};
const DEVICE_ID = /^studio-[a-f0-9]{24}$/;
const MAX_JSON = 1024 * 1024;
const MAX_UPLOAD = 2 * MAX_JSON;
const MAX_JPEG = 180 * 1024;
// Same protocol surface as Studio's parseBoardAgentEnvelope, never an arbitrary URL/command.
const GET_PATHS = new Set([
  '/healthz',
  '/v1/onboarding/preflight',
  '/v1/station/status',
  '/v1/station/policy',
  '/v1/station/policy/files',
  '/v1/station/drive',
  '/v1/config',
  '/v1/station/camera.snapshot',
]);
const POST_PATHS = new Set([
  '/v1/station/commands',
  '/v1/station/policy-infer',
  '/v1/station/policy/upload',
  '/v1/station/policy/load',
  '/v1/station/policy/start',
  '/v1/station/policy/reset',
  '/v1/station/policy/stop',
  '/v1/station/drive',
  '/v1/station/drive/stop',
]);
function fail(status: number, code: string): never {
  throw new StudioDesktopRelayError(status, code);
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function text(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    !Array.from(value).some((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}
function ownerValue(owner: string) {
  if (!text(owner, 200) || !owner.trim()) fail(400, 'DESKTOP_RELAY_INVALID_OWNER');
  return owner;
}
function numeric(value: number | undefined, fallback: number) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) fail(400, 'DESKTOP_RELAY_INVALID_LIMIT');
  return value;
}
function timer(callback: () => void, delay: number): Timer {
  const handle = setTimeout(callback, delay);
  handle.unref?.();
  return handle;
}
function parseDevices(value: unknown, limit: number): DesktopRelayDevice[] {
  if (!Array.isArray(value) || value.length > limit) fail(400, 'DESKTOP_RELAY_INVALID_DEVICES');
  const seen = new Set<string>();
  return value.map((device: unknown) => {
    if (
      !object(device) ||
      !keys(device, ['id', 'name', 'status', 'boardPlatform', 'boardModel']) ||
      typeof device.id !== 'string' ||
      !DEVICE_ID.test(device.id) ||
      seen.has(device.id) ||
      !text(device.name, 120) ||
      (device.status !== 'connected' && device.status !== 'disconnected') ||
      (device.boardPlatform !== undefined && !text(device.boardPlatform, 80)) ||
      (device.boardModel !== undefined && !text(device.boardModel, 120))
    )
      fail(400, 'DESKTOP_RELAY_INVALID_DEVICES');
    seen.add(device.id);
    return {
      id: device.id,
      name: device.name,
      status: device.status as DesktopRelayDevice['status'],
      ...(device.boardPlatform !== undefined
        ? { boardPlatform: device.boardPlatform as string }
        : {}),
      ...(device.boardModel !== undefined ? { boardModel: device.boardModel as string } : {}),
    };
  });
}
function parseInput(value: unknown): CommandInput {
  if (
    !object(value) ||
    !keys(value, ['method', 'path', 'body', 'agentToken']) ||
    typeof value.path !== 'string' ||
    (value.method !== 'GET' && value.method !== 'POST')
  )
    fail(400, 'DESKTOP_RELAY_INVALID_REQUEST');
  const allowed =
    value.method === 'GET'
      ? GET_PATHS.has(value.path)
      : POST_PATHS.has(value.path) ||
        /^\/v1\/devices\/[a-zA-Z0-9_-]{1,128}\/commands$/.test(value.path);
  if (!allowed) fail(400, 'DESKTOP_RELAY_INVALID_PATH');
  if (
    value.agentToken !== undefined &&
    (typeof value.agentToken !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(value.agentToken))
  )
    fail(400, 'DESKTOP_RELAY_INVALID_TOKEN');
  if (value.body !== undefined) {
    if (value.method !== 'POST' || typeof value.body !== 'string')
      fail(400, 'DESKTOP_RELAY_INVALID_BODY');
    if (
      Buffer.byteLength(value.body) >
      (value.path === '/v1/station/policy/upload' ? MAX_UPLOAD : MAX_JSON)
    )
      fail(413, 'DESKTOP_RELAY_TOO_LARGE');
    try {
      JSON.parse(value.body);
    } catch {
      fail(400, 'DESKTOP_RELAY_INVALID_BODY');
    }
  }
  return {
    method: value.method,
    path: value.path,
    ...(value.body !== undefined ? { body: value.body as string } : {}),
    ...(value.agentToken !== undefined ? { agentToken: value.agentToken as string } : {}),
  };
}
function parseReply(value: unknown, command: DesktopRelayCommand): DesktopRelayReply {
  if (
    !object(value) ||
    value.ok !== true ||
    !Number.isInteger(value.status) ||
    Number(value.status) < 200 ||
    Number(value.status) > 599 ||
    (Number(value.status) >= 300 && Number(value.status) < 400)
  )
    fail(400, 'DESKTOP_RELAY_INVALID_REPLY');
  const snapshotSuccess =
    command.path === '/v1/station/camera.snapshot' && Number(value.status) < 300;
  if (value.contentType === 'image/jpeg') {
    if (
      !snapshotSuccess ||
      !keys(value, ['ok', 'status', 'bodyBase64', 'contentType']) ||
      typeof value.bodyBase64 !== 'string' ||
      !value.bodyBase64.length ||
      value.bodyBase64.length > Math.ceil(MAX_JPEG / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.bodyBase64)
    )
      fail(400, 'DESKTOP_RELAY_INVALID_REPLY');
    const bytes = Buffer.from(value.bodyBase64, 'base64');
    if (
      bytes.length > MAX_JPEG ||
      bytes.length < 4 ||
      bytes.toString('base64') !== value.bodyBase64 ||
      bytes[0] !== 0xff ||
      bytes[1] !== 0xd8 ||
      bytes[bytes.length - 2] !== 0xff ||
      bytes[bytes.length - 1] !== 0xd9
    )
      fail(400, 'DESKTOP_RELAY_INVALID_REPLY');
    return {
      ok: true,
      status: Number(value.status),
      bodyBase64: value.bodyBase64,
      contentType: 'image/jpeg',
    };
  }
  if (
    snapshotSuccess ||
    !keys(value, ['ok', 'status', 'body', 'contentType']) ||
    typeof value.body !== 'string' ||
    !text(value.contentType, 200) ||
    !/^application\/json(?:\s*;|$)/i.test(value.contentType)
  )
    fail(400, 'DESKTOP_RELAY_INVALID_REPLY');
  if (Buffer.byteLength(value.body) > MAX_JSON) fail(413, 'DESKTOP_RELAY_TOO_LARGE');
  try {
    JSON.parse(value.body);
  } catch {
    fail(400, 'DESKTOP_RELAY_INVALID_REPLY');
  }
  return {
    ok: true,
    status: Number(value.status),
    body: value.body,
    contentType: value.contentType,
  };
}

export class StudioDesktopRelayBroker {
  private readonly sessions = new Map<string, Session>();
  private sequence = 0;
  private pendingCount = 0;
  private readonly now: () => number;
  private readonly ttl: number;
  private readonly maxAge: number;
  private readonly pollMs: number;
  private readonly ownerLimit: number;
  private readonly sessionLimit: number;
  private readonly deviceLimit: number;
  private readonly pendingSessionLimit: number;
  private readonly pendingLimit: number;
  constructor(options: DesktopRelayOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttl = numeric(options.sessionTtlMs, 30_000);
    this.maxAge = numeric(options.maxSessionAgeMs, 30 * 60_000);
    this.pollMs = numeric(options.pollTimeoutMs, 5000);
    this.ownerLimit = numeric(options.maxSessionsPerOwner, 8);
    this.sessionLimit = numeric(options.maxSessions, 64);
    this.deviceLimit = numeric(options.maxDevicesPerSession, 64);
    this.pendingSessionLimit = numeric(options.maxPendingPerSession, 32);
    this.pendingLimit = numeric(options.maxPending, 256);
  }
  register(
    owner: string,
    devices: unknown,
  ): { sessionId: string; sessionToken: string; expiresAt: number } {
    ownerValue(owner);
    const parsed = parseDevices(devices, this.deviceLimit);
    this.reap();
    if (
      this.sessions.size >= this.sessionLimit ||
      [...this.sessions.values()].filter((s) => s.owner === owner).length >= this.ownerLimit
    )
      fail(429, 'DESKTOP_RELAY_SESSION_QUOTA');
    const session: Session = {
      id: randomUUID(),
      owner,
      token: randomBytes(32).toString('base64url'),
      devices: parsed,
      sequence: ++this.sequence,
      expiresAt: 0,
      absoluteExpiry: this.now() + this.maxAge,
      pending: new Map(),
    };
    this.sessions.set(session.id, session);
    this.touch(session);
    return { sessionId: session.id, sessionToken: session.token, expiresAt: session.expiresAt };
  }
  async poll(
    owner: string,
    sessionId: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<DesktopRelayCommand | null> {
    const session = this.authenticate(owner, sessionId, token);
    if (session.poll) fail(409, 'DESKTOP_RELAY_POLL_CONFLICT');
    if (signal?.aborted) fail(499, 'DESKTOP_RELAY_ABORTED');
    this.touch(session);
    const pending = [...session.pending.values()].find((p) => !p.delivered);
    if (pending) {
      pending.delivered = true;
      return { ...pending.command };
    }
    return new Promise((resolve, reject) => {
      const finish = () => {
        if (session.poll === poll) session.poll = undefined;
        clearTimeout(handle);
        signal?.removeEventListener('abort', abort);
      };
      const poll: Poll = { resolve, reject, cleanup: finish };
      const abort = () => {
        finish();
        reject(new StudioDesktopRelayError(499, 'DESKTOP_RELAY_ABORTED'));
      };
      const handle = timer(() => {
        finish();
        if (this.sessions.has(session.id)) this.touch(session);
        resolve(null);
      }, this.pollMs);
      session.poll = poll;
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
  complete(
    owner: string,
    sessionId: string,
    token: string,
    requestId: string,
    reply: unknown,
  ): void {
    const session = this.authenticate(owner, sessionId, token);
    const pending = session.pending.get(requestId);
    if (!pending || !pending.delivered || pending.command.deadlineAt <= this.now())
      fail(409, 'DESKTOP_RELAY_REQUEST_NOT_PENDING');
    const parsed = parseReply(reply, pending.command);
    this.removePending(session, pending);
    this.touch(session);
    pending.resolve(parsed);
  }
  /** Observe the authenticated sliding deadline without renewing the desktop's lease. */
  lease(owner: string, sessionId: string, token: string): { expiresAt: number } {
    return { expiresAt: this.authenticate(owner, sessionId, token).expiresAt };
  }
  close(owner: string, sessionId: string, token: string): void {
    this.removeSession(this.authenticate(owner, sessionId, token), 'DESKTOP_RELAY_SESSION_CLOSED');
  }
  devices(owner: string): DesktopRelayDevice[] {
    ownerValue(owner);
    this.reap();
    const devices = new Map<string, DesktopRelayDevice>();
    // Newest live connected session wins. An offline replacement cannot mask a live board.
    const sessions = [...this.sessions.values()]
      .filter((s) => s.owner === owner)
      .sort((a, b) => b.sequence - a.sequence);
    for (const session of sessions)
      for (const device of session.devices) {
        const existing = devices.get(device.id);
        if (!existing || (existing.status !== 'connected' && device.status === 'connected'))
          devices.set(device.id, { ...device });
      }
    return [...devices.values()];
  }
  hasOwnerSession(owner: string): boolean {
    ownerValue(owner);
    this.reap();
    return [...this.sessions.values()].some((session) => session.owner === owner);
  }
  has(owner: string, deviceId: string): boolean {
    return this.devices(owner).some((d) => d.id === deviceId && d.status === 'connected');
  }
  async request(
    owner: string,
    deviceId: string,
    input: CommandInput,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<DesktopRelayReply> {
    ownerValue(owner);
    const parsed = parseInput(input);
    this.reap();
    if (!DEVICE_ID.test(deviceId)) fail(400, 'DESKTOP_RELAY_INVALID_DEVICE');
    if (options.signal?.aborted) fail(499, 'DESKTOP_RELAY_ABORTED');
    const session = [...this.sessions.values()]
      .filter(
        (s) =>
          s.owner === owner && s.devices.some((d) => d.id === deviceId && d.status === 'connected'),
      )
      .sort((a, b) => b.sequence - a.sequence)[0];
    if (!session) fail(404, 'DESKTOP_RELAY_DEVICE_UNAVAILABLE');
    if (session.pending.size >= this.pendingSessionLimit || this.pendingCount >= this.pendingLimit)
      fail(429, 'DESKTOP_RELAY_REQUEST_QUOTA');
    const timeoutMs = Math.min(numeric(options.timeoutMs, 15_000), 120_000);
    const command: DesktopRelayCommand = {
      ...parsed,
      requestId: randomBytes(24).toString('base64url'),
      deviceId,
      deadlineAt: this.now() + timeoutMs,
    };
    return new Promise((resolve, reject) => {
      const abort = () => settle('DESKTOP_RELAY_ABORTED', 499);
      const handle = timer(() => settle('DESKTOP_RELAY_TIMEOUT', 504), timeoutMs);
      const pending: Pending = {
        command,
        delivered: false,
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(handle);
          options.signal?.removeEventListener('abort', abort);
        },
      };
      const settle = (code: string, status: number) => {
        this.removePending(session, pending);
        reject(new StudioDesktopRelayError(status, code));
      };
      session.pending.set(command.requestId, pending);
      this.pendingCount++;
      options.signal?.addEventListener('abort', abort, { once: true });
      if (session.poll) {
        const poll = session.poll;
        poll.cleanup();
        pending.delivered = true;
        poll.resolve({ ...command });
      }
    });
  }
  closeAll(): void {
    for (const session of [...this.sessions.values()])
      this.removeSession(session, 'DESKTOP_RELAY_SESSION_CLOSED');
  }
  private authenticate(owner: string, id: string, token: string): Session {
    this.reap();
    const session = this.sessions.get(id);
    if (
      !session ||
      session.owner !== owner ||
      typeof token !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(token) ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(session.token))
    )
      fail(401, 'DESKTOP_RELAY_UNAUTHORIZED');
    return session;
  }
  private touch(session: Session): void {
    session.expiresAt = Math.min(this.now() + this.ttl, session.absoluteExpiry);
    this.armExpiry(session);
  }
  private armExpiry(session: Session): void {
    if (session.timer) clearTimeout(session.timer);
    session.timer = timer(
      () => {
        if (session.expiresAt <= this.now())
          this.removeSession(session, 'DESKTOP_RELAY_SESSION_EXPIRED');
        else this.armExpiry(session);
      },
      Math.max(1, session.expiresAt - this.now()),
    );
  }
  private reap(): void {
    const now = this.now();
    for (const session of [...this.sessions.values()]) {
      if (session.expiresAt <= now) {
        this.removeSession(session, 'DESKTOP_RELAY_SESSION_EXPIRED');
        continue;
      }
      // A delayed timer callback must not permit delivery/acknowledgment after its deadline.
      for (const pending of [...session.pending.values()]) {
        if (pending.command.deadlineAt <= now) {
          this.removePending(session, pending);
          pending.reject(new StudioDesktopRelayError(504, 'DESKTOP_RELAY_TIMEOUT'));
        }
      }
    }
  }
  private removePending(session: Session, pending: Pending): void {
    if (session.pending.delete(pending.command.requestId)) this.pendingCount--;
    pending.cleanup();
  }
  private removeSession(session: Session, code: string): void {
    if (!this.sessions.delete(session.id)) return;
    if (session.timer) clearTimeout(session.timer);
    if (session.poll) {
      const poll = session.poll;
      poll.cleanup();
      poll.reject(new StudioDesktopRelayError(410, code));
    }
    for (const pending of [...session.pending.values()]) {
      this.removePending(session, pending);
      pending.reject(new StudioDesktopRelayError(410, code));
    }
  }
}
export const studioDesktopRelay = new StudioDesktopRelayBroker();
