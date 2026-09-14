import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { Sim2RealError } from './sim2real-errors.js';

/**
 * Data directory resolver is injected to avoid a circular import with
 * standalone-adapters.ts (which imports this module's tunnel query hook).
 * The composition root wires resolveDataDir in at startup; the default
 * matches the adapters' own fallback.
 */
let resolveDataDirImpl: () => string = () =>
  String(process.env.RDK_SIM2REAL_STORAGE_DIR || path.join(process.cwd(), '.data'));

export function setTunnelDataDirResolver(resolver: () => string): void {
  resolveDataDirImpl = resolver;
}

/**
 * Web-managed board connections (RDK Studio 网页版-style 添加设备).
 *
 * The platform's SSRF rule only allows plain-HTTP agents on loopback; a real
 * board on the LAN is therefore reached through an operator-initiated SSH
 * tunnel: the web process spawns `ssh -N -L <localPort>:127.0.0.1:19100` and
 * keeps it alive. The agent URL seen by the proxy stays a loopback URL, so
 * every existing safety property (bounded fetches, bearer token, no direct
 * browser-to-board path) is preserved; only the operator's own machine opens
 * the outbound SSH connection.
 *
 * The tunnel forwards to 127.0.0.1 on the board, so a URL like
 * `http://192.168.x.x:19100` is never stored — only the SSH coordinates are.
 * Stored records live in `<dataDir>/device-connections.json` (0600, atomic
 * rename) and never contain SSH private keys: authentication relies on the
 * operator's local ssh config/agent, the same as deploy-x5-board-agent.sh.
 */

export interface DeviceConnectionRecord {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  agentPort: number;
  localPort: number;
  createdAt: string;
  lastCheckedAt: string | null;
  lastCheckOk: boolean | null;
  lastCheckMessage: string;
  profile?: string;
  transport?: string;
}

interface StoredConnection extends DeviceConnectionRecord {
  ownerKey?: string;
}

const TUNNEL_SSH_CONNECT_TIMEOUT_SEC = 8;
const MAX_LOCAL_PORT = 65_530;
const MIN_LOCAL_PORT = 20_000;
// A connection registry is deliberately bounded (at most 50 records per
// owner and 500 per instance), but the read path still needs a byte bound.
// Without one, an operator or a compromised volume could make every list
// request allocate an unbounded string before the JSON parser gets a chance to
// reject it.
const MAX_CONNECTION_RECORDS = 500;
const MAX_CONNECTIONS_FILE_BYTES = 1 * 1024 * 1024;
const MAX_HEALTH_RESPONSE_BYTES = 32 * 1024;
const NO_FOLLOW = Number(fsConstants.O_NOFOLLOW ?? 0);
// Keep a FIFO replacement from blocking the synchronous registry read before
// fstat can reject it. O_NONBLOCK is harmless for regular files.
const NO_BLOCK = Number(fsConstants.O_NONBLOCK ?? 0);
const STORED_CONNECTION_KEYS = new Set([
  'id',
  'label',
  'host',
  'port',
  'username',
  'agentPort',
  'localPort',
  'createdAt',
  'lastCheckedAt',
  'lastCheckOk',
  'lastCheckMessage',
  'profile',
  'transport',
  'ownerKey',
]);
const portRange = () =>
  MIN_LOCAL_PORT + Math.floor(Math.random() * (MAX_LOCAL_PORT - MIN_LOCAL_PORT));

interface TunnelState {
  connectionId: string;
  process: ChildProcess;
  localPort: number;
  startedAt: number;
  lastExit?: { code: number | null; signal: NodeJS.Signals | null };
}

type DeviceConnectionTunnelResult = { url: string; probe: TunnelProbeResult } | { error: string };

const tunnels = new Map<string, TunnelState>();
// A browser can issue duplicate connect requests (double-click, retry after a
// slow SSH handshake, or two tabs).  Keep one in-flight operation per owner
// and connection id so a second request cannot replace the first ChildProcess
// in `tunnels` and leave an orphaned SSH process behind.
const openingTunnels = new Map<string, Promise<DeviceConnectionTunnelResult>>();
// All connection mutations must include their read-modify-write sequence in
// this queue.  Queuing only the final write is insufficient: two concurrent
// creates can both read the same old array and the later write then erases the
// first record.  The queue is process-local, matching the single web process
// that owns the tunnel map; the atomic rename below keeps individual reads
// crash-safe as well.
let connectionWriteQueue: Promise<void> = Promise.resolve();

function connectionsFile(): string {
  return path.join(resolveDataDirImpl(), 'device-connections.json');
}

function ensureDataDir(): void {
  const dir = resolveDataDirImpl();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function normalizeHost(value: unknown): string | null {
  const host = String(value ?? '').trim();
  if (!host || host.length > 253) return null;
  // Hostname (no scheme) or IPv4/IPv6 literal. Anything with a scheme,
  // userinfo, or path is a URL, not an SSH target — reject it.
  if (/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host)) return host;
  if (/^\[?[0-9a-fA-F:]+\]?$/.test(host) && host.includes(':')) return host.replace(/^\[|\]$/g, '');
  return null;
}

function normalizePort(value: unknown, fallback: number, min: number, max: number): number {
  const port = Number(value);
  return Number.isSafeInteger(port) && port >= min && port <= max ? port : fallback;
}

function isSshAvailable(): boolean {
  // Bounded probe: a broken PATH entry (or a hung ssh shim) must never
  // wedge the request. 2s is far above a real `ssh -V` and far below the
  // HTTP layer's patience.
  const probe = spawnSync('ssh', ['-V'], { stdio: 'ignore', timeout: 2000 });
  return probe.status === 0 || probe.error === undefined;
}

function storageUnavailable(detail: string, cause?: unknown): Sim2RealError {
  return new Sim2RealError('sim2real_storage_unavailable', {
    detail,
    ...(cause === undefined ? {} : { cause }),
  });
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function recordPort(item: Record<string, unknown>, key: string, fallback: number, min = 0): number {
  const value = item[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' && typeof value !== 'string') throw new Error(`invalid ${key}`);
  if (typeof value === 'string' && !value.trim()) throw new Error(`invalid ${key}`);
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < min || port > 65_535) {
    throw new Error(`invalid ${key}`);
  }
  return port;
}

function parseStoredConnection(item: unknown): StoredConnection {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error('device connection record is not an object');
  }
  const source = item as Record<string, unknown>;
  const unknownKeys = Object.keys(source).filter((key) => !STORED_CONNECTION_KEYS.has(key));
  if (unknownKeys.length) throw new Error('device connection record contains unknown fields');
  if (source.host !== undefined && typeof source.host !== 'string') {
    throw new Error('invalid device connection host type');
  }
  const host = normalizeHost(source.host);
  if (!host) throw new Error('invalid device connection host');
  if (source.id !== undefined && typeof source.id !== 'string') {
    throw new Error('invalid device connection id type');
  }
  const id = String(source.id ?? '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(id)) {
    throw new Error('invalid device connection id');
  }
  if (source.username !== undefined && typeof source.username !== 'string') {
    throw new Error('invalid device connection username type');
  }
  if (typeof source.username === 'string' && source.username.length > 64) {
    throw new Error('invalid device connection username length');
  }
  const username = String(source.username ?? 'root')
    .trim()
    .slice(0, 64);
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,63}$/.test(username)) {
    throw new Error('invalid device connection username');
  }
  if (source.label !== undefined && typeof source.label !== 'string') {
    throw new Error('invalid device connection label type');
  }
  if (typeof source.label === 'string' && source.label.length > 120) {
    throw new Error('invalid device connection label length');
  }
  const label = String(source.label ?? '')
    .trim()
    .slice(0, 120);
  if (typeof source.createdAt !== 'string') throw new Error('invalid device connection createdAt');
  const createdAt = source.createdAt.trim();
  if (!createdAt || createdAt.length > 64) throw new Error('invalid device connection createdAt');
  if (
    source.lastCheckedAt !== undefined &&
    source.lastCheckedAt !== null &&
    (typeof source.lastCheckedAt !== 'string' || source.lastCheckedAt.length > 64)
  ) {
    throw new Error('invalid device connection lastCheckedAt');
  }
  if (
    source.lastCheckOk !== undefined &&
    source.lastCheckOk !== null &&
    typeof source.lastCheckOk !== 'boolean'
  ) {
    throw new Error('invalid device connection lastCheckOk');
  }
  if (
    source.lastCheckMessage !== undefined &&
    (typeof source.lastCheckMessage !== 'string' || source.lastCheckMessage.length > 400)
  ) {
    throw new Error('invalid device connection lastCheckMessage');
  }
  if (source.ownerKey !== undefined) {
    if (
      typeof source.ownerKey !== 'string' ||
      !source.ownerKey ||
      source.ownerKey.length > 200 ||
      hasControlCharacters(source.ownerKey)
    ) {
      throw new Error('invalid device connection ownerKey');
    }
  }
  if (
    source.profile !== undefined &&
    (typeof source.profile !== 'string' || !source.profile || source.profile.length > 64)
  ) {
    throw new Error('invalid device connection profile');
  }
  if (source.transport !== undefined) {
    if (source.transport !== 'ssh' && source.transport !== 'bridge') {
      throw new Error('invalid device connection transport');
    }
  }
  return {
    id,
    label,
    host,
    port: recordPort(source, 'port', 22, 1),
    username,
    agentPort: recordPort(source, 'agentPort', 19_100, 1),
    localPort: recordPort(source, 'localPort', 0),
    createdAt,
    lastCheckedAt:
      typeof source.lastCheckedAt === 'string' && source.lastCheckedAt
        ? source.lastCheckedAt
        : null,
    lastCheckOk: source.lastCheckOk === true ? true : source.lastCheckOk === false ? false : null,
    lastCheckMessage: String(source.lastCheckMessage ?? '').slice(0, 400),
    ...(typeof source.profile === 'string' && source.profile
      ? { profile: source.profile.slice(0, 64) }
      : {}),
    ...(source.transport === 'ssh' || source.transport === 'bridge'
      ? { transport: source.transport }
      : {}),
    ...(typeof source.ownerKey === 'string' && source.ownerKey
      ? { ownerKey: source.ownerKey.slice(0, 200) }
      : {}),
  };
}

/**
 * Read the registry without ever treating an existing failure as an empty
 * database.  A previous implementation did exactly that, so a later create
 * could replace a corrupt, unreadable, or symlinked file and silently destroy
 * the operator's records.  The descriptor is opened with O_NOFOLLOW where the
 * host supports it and then checked again with fstat, closing the small
 * lstat/read race around a mutable path.
 */
function readConnections(): StoredConnection[] {
  const file = connectionsFile();
  let descriptor: number | undefined;
  try {
    // O_NOFOLLOW is available on the Unix hosts supported by the board
    // service.  Keep an explicit lstat fallback for platforms whose Node
    // runtime does not expose it, so a final-path symlink is never accepted.
    if (!NO_FOLLOW) {
      const linkStat = lstatSync(file);
      if (linkStat.isSymbolicLink() || !linkStat.isFile()) {
        throw new Error('device connection registry is not a regular file');
      }
    }
    descriptor = openSync(file, fsConstants.O_RDONLY | NO_FOLLOW | NO_BLOCK);
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error('device connection registry is not a regular file');
    if ((stat.mode & 0o077) !== 0 || (stat.mode & 0o400) === 0) {
      throw new Error('device connection registry permissions are unsafe');
    }
    if (stat.size > MAX_CONNECTIONS_FILE_BYTES) {
      throw new Error('device connection registry exceeds the size limit');
    }
    const parsed: unknown = JSON.parse(readFileSync(descriptor, 'utf8'));
    if (!Array.isArray(parsed) || parsed.length > MAX_CONNECTION_RECORDS) {
      throw new Error('device connection registry shape is invalid');
    }
    const records = parsed.map(parseStoredConnection);
    const ids = new Set<string>();
    for (const record of records) {
      if (ids.has(record.id)) throw new Error('device connection registry contains duplicate ids');
      ids.add(record.id);
    }
    return records;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    if (error instanceof Sim2RealError) throw error;
    throw storageUnavailable(
      'device connection registry is unreadable; refusing to overwrite existing records',
      error,
    );
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        /* The read result is already bounded; a close failure cannot make it safe to write. */
      }
    }
  }
}

function writeConnections(next: StoredConnection[]): void {
  const file = connectionsFile();
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    ensureDataDir();
    if (next.length > MAX_CONNECTION_RECORDS) {
      throw new Sim2RealError('sim2real_storage_quota_exceeded', {
        detail: `device connection registry exceeds ${MAX_CONNECTION_RECORDS} records`,
      });
    }
    const ids = new Set<string>();
    for (const record of next) {
      if (ids.has(record.id)) {
        throw new Sim2RealError('sim2real_storage_unavailable', {
          detail: 'device connection registry contains duplicate ids',
        });
      }
      ids.add(record.id);
    }
    const serialized = JSON.stringify(next, null, 2);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_CONNECTIONS_FILE_BYTES) {
      throw new Sim2RealError('sim2real_storage_quota_exceeded', {
        detail: 'device connection registry exceeds its byte limit',
      });
    }
    writeFileSync(temporary, serialized, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      /* best-effort cleanup; preserve the original write failure */
    }
    if (error instanceof Sim2RealError) throw error;
    throw storageUnavailable(
      'device connection registry could not be persisted; refusing to report a successful mutation',
      error,
    );
  }
}

function serializedConnectionMutation<T>(task: () => T | PromiseLike<T>): Promise<T> {
  const operation = connectionWriteQueue.then(task, task);
  connectionWriteQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

function ownerScope(owner: string | undefined): {
  ownerKey: string | null;
  matches: (record: StoredConnection) => boolean;
} {
  const key = owner ? `sso:${owner}:web` : null;
  return {
    ownerKey: key,
    // Single-user mode sees every connection (mirrors visibleDevices).
    matches: (record) => !key || record.ownerKey === key,
  };
}

function tunnelKey(id: string, owner: string | undefined): string {
  // Use the same normalized owner scope as registry access.  The owner is
  // part of the live-tunnel key so two tenants with a colliding/manual record
  // id cannot probe or tear down each other's SSH process.
  const { ownerKey } = ownerScope(owner);
  return JSON.stringify([ownerKey, id]);
}

export function listDeviceConnections(owner?: string): DeviceConnectionRecord[] {
  const { matches } = ownerScope(owner);
  return readConnections()
    .filter(matches)
    .map(({ ownerKey: _ownerKey, ...publicRecord }) => publicRecord);
}

/** The loopback agent URL of a connection, if its tunnel is up. */
export function deviceConnectionAgentUrl(id: string, owner?: string): string | null {
  const { matches } = ownerScope(owner);
  const record = readConnections().find((item) => item.id === id && matches(item));
  if (!record) return null;
  const state = tunnels.get(tunnelKey(id, owner));
  if (!state || state.process.exitCode !== null || state.process.signalCode !== null) return null;
  return `http://127.0.0.1:${state.localPort}`;
}

export interface TunnelProbeResult {
  ok: boolean;
  message: string;
  agentInfo?: { mock?: boolean; capabilities?: string[]; boardModel?: string };
}

/**
 * Probe `127.0.0.1:localPort/healthz` with a bounded fetch. Only the agent's
 * own health document is read; no credentials beyond the optional bearer
 * token configured for the loopback proxy.
 */
async function probeAgent(localPort: number): Promise<TunnelProbeResult> {
  const token = String(process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN ?? '').trim();
  try {
    const response = await fetch(`http://127.0.0.1:${localPort}/healthz`, {
      headers: {
        accept: 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      redirect: 'error',
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return { ok: false, message: `板端 agent 返回 HTTP ${response.status}` };
    const declaredHeader = response.headers.get('content-length');
    if (declaredHeader !== null) {
      const normalized = declaredHeader.trim();
      const contentLength = /^\d+$/.test(normalized) ? Number(normalized) : Number.NaN;
      if (
        !Number.isSafeInteger(contentLength) ||
        contentLength < 0 ||
        contentLength > MAX_HEALTH_RESPONSE_BYTES
      ) {
        return { ok: false, message: '板端 agent 健康响应长度无效或过大' };
      }
    }
    if (!response.body) return { ok: false, message: '板端 agent 健康响应为空' };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const value = chunk.value;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_HEALTH_RESPONSE_BYTES) {
          await reader.cancel();
          return { ok: false, message: '板端 agent 健康响应过大' };
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bodyText = Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk)),
      totalBytes,
    ).toString('utf8');
    let body: Record<string, unknown> | null;
    try {
      const parsed: unknown = JSON.parse(bodyText);
      body =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
    } catch {
      body = null;
    }
    if (!body) return { ok: false, message: '板端 agent 健康响应不是合法 JSON' };
    const board =
      body.board && typeof body.board === 'object' ? (body.board as Record<string, unknown>) : null;
    return {
      ok: true,
      message: '连接正常',
      agentInfo: {
        mock: body.mock === true,
        capabilities: Array.isArray(body.capabilities)
          ? (body.capabilities as unknown[]).slice(0, 8).map((item) => String(item))
          : undefined,
        boardModel:
          board && typeof board.model === 'string' ? board.model.slice(0, 120) : undefined,
      },
    };
  } catch (error) {
    return {
      ok: false,
      message: `板端 agent 不可达：${error instanceof Error ? error.message : '未知错误'}`,
    };
  }
}

/**
 * Start (or reuse) the SSH tunnel for a connection and verify the agent
 * answers on the forwarded loopback port. Fails closed: any SSH or health
 * failure tears the tunnel down and reports honestly.
 */
export function openDeviceConnectionTunnel(
  id: string,
  owner?: string,
): Promise<DeviceConnectionTunnelResult> {
  const key = tunnelKey(id, owner);
  const pending = openingTunnels.get(key);
  if (pending) return pending;
  const operation = openDeviceConnectionTunnelInternal(id, owner);
  openingTunnels.set(key, operation);
  const clear = () => {
    if (openingTunnels.get(key) === operation) openingTunnels.delete(key);
  };
  // Handle both outcomes so a rejected storage/SSH path cannot leave a stale
  // Promise that turns every later retry into the old failure.
  void operation.then(clear, clear);
  return operation;
}

async function openDeviceConnectionTunnelInternal(
  id: string,
  owner?: string,
): Promise<DeviceConnectionTunnelResult> {
  const { matches } = ownerScope(owner);
  const key = tunnelKey(id, owner);
  const record = readConnections().find((item) => item.id === id && matches(item));
  if (!record) return { error: 'NOT_FOUND' };
  if (!isSshAvailable()) return { error: 'SSH_UNAVAILABLE' };

  const existing = tunnels.get(key);
  if (existing && existing.process.exitCode === null && existing.process.signalCode === null) {
    const probe = await probeAgent(existing.localPort);
    if (probe.ok) return { url: `http://127.0.0.1:${existing.localPort}`, probe };
    await closeDeviceConnectionTunnel(id, owner);
  }

  const localPort = portRange();
  const child = spawn(
    'ssh',
    [
      '-N',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      `ConnectTimeout=${TUNNEL_SSH_CONNECT_TIMEOUT_SEC}`,
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=4',
      '-o',
      'TCPKeepAlive=yes',
      '-L',
      `${localPort}:127.0.0.1:${record.agentPort}`,
      `${record.username}@${record.host}`,
      '-p',
      String(record.port),
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  // stderr is diagnostics only; cap what we keep in memory.
  let stderrTail = '';
  if (child.stderr) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-500);
    });
  }
  tunnels.set(key, {
    connectionId: id,
    process: child,
    localPort,
    startedAt: Date.now(),
  });

  // Wait until ssh either establishes the forward (process keeps running) or
  // exits. ExitOnForwardFailure turns a failed forward into a quick exit.
  const exited = await new Promise<null | { code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      const timer = setTimeout(() => resolve(null), TUNNEL_SSH_CONNECT_TIMEOUT_SEC * 1000 + 1500);
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        clearTimeout(timer);
        resolve({ code, signal });
      };
      child.once('exit', onExit);
    },
  );
  if (exited) {
    if (tunnels.get(key)?.process === child) tunnels.delete(key);
    const reason = stderrTail.trim() || `ssh 退出（code=${exited.code}）`;
    return { error: `SSH 连接失败：${reason}` };
  }

  const probe = await probeAgent(localPort);
  if (!probe.ok) {
    await closeDeviceConnectionTunnel(id, owner);
    return { error: probe.message };
  }

  // Persist the healthy state so the UI can show it after refresh.  Read the
  // latest registry inside the mutation queue: a create/delete that completed
  // while the SSH probe was running must never be overwritten by this update.
  try {
    const persisted = await serializedConnectionMutation(() => {
      const existing = readConnections();
      const index = existing.findIndex((item) => item.id === id && matches(item));
      if (index < 0) return false;
      const next = [...existing];
      next[index] = {
        ...next[index],
        localPort,
        lastCheckedAt: new Date().toISOString(),
        lastCheckOk: true,
        lastCheckMessage: probe.message,
      };
      writeConnections(next);
      return true;
    });
    if (!persisted) {
      await closeDeviceConnectionTunnel(id, owner);
      return { error: 'NOT_FOUND' };
    }
  } catch (error) {
    // A healthy tunnel whose durable record could not be updated is not a
    // usable connection after refresh.  Tear it down before surfacing the
    // storage error so the live map cannot advertise an untracked tunnel.
    await closeDeviceConnectionTunnel(id, owner);
    throw error;
  }
  return { url: `http://127.0.0.1:${localPort}`, probe };
}

/** Tear down one connection's tunnel (idempotent). */
export function closeDeviceConnectionTunnel(id: string, owner?: string): Promise<void> {
  const key = tunnelKey(id, owner);
  const state = tunnels.get(key);
  if (!state) return Promise.resolve();
  if (tunnels.get(key) === state) tunnels.delete(key);
  return new Promise((resolve) => {
    const forceKill = setTimeout(() => {
      try {
        state.process.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      resolve();
    }, 2000);
    state.process.once('exit', () => {
      clearTimeout(forceKill);
      resolve();
    });
    try {
      state.process.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  });
}

export function activeDeviceConnections(): string[] {
  return [...tunnels.entries()]
    .filter(([, state]) => state.process.exitCode === null && state.process.signalCode === null)
    .map(([, state]) => state.connectionId);
}

/**
 * Loopback agent URL of the live tunnel, for the SSRF-safe proxy override.
 * The UI drives one active connection at a time; if several are open the most
 * recently opened wins. Every candidate is a loopback URL by construction, so
 * the SSRF boundary itself cannot move. Returns null when no tunnel is up so
 * the env-configured agent (or none) is used unchanged.
 */
export function activeTunnelAgentUrl(): string | null {
  let url: string | null = null;
  for (const [id, state] of [...tunnels.entries()].reverse()) {
    void id;
    if (state.process.exitCode === null && state.process.signalCode === null) {
      url = `http://127.0.0.1:${state.localPort}`;
      break;
    }
  }
  return url;
}

export interface CreateConnectionInput {
  host: string;
  port?: number;
  username?: string;
  label?: string;
  agentPort?: number;
  profile?: string;
  transport?: string;
}

export async function createDeviceConnection(
  input: CreateConnectionInput,
  owner?: string,
): Promise<DeviceConnectionRecord | { error: string }> {
  const host = normalizeHost(input.host);
  if (!host) return { error: 'INVALID_HOST' };
  const username = String(input.username ?? 'root').trim();
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,63}$/.test(username)) return { error: 'INVALID_USERNAME' };
  const label = String(input.label ?? '')
    .trim()
    .slice(0, 120);
  const port = normalizePort(input.port, 22, 1, 65_535);
  const agentPort = normalizePort(input.agentPort, 19_100, 1, 65_535);
  const { ownerKey } = ownerScope(owner);
  return serializedConnectionMutation(async () => {
    const existing = readConnections();
    // Shared deployments must meter connection records per tenant. A global
    // duplicate check would disclose another account's SSH coordinates through
    // a 409, and a global 50-row cap would let one noisy tenant exhaust every
    // other tenant's onboarding capacity. Standalone mode keeps the historical
    // process-wide behaviour because it has one operator-owned registry.
    const scopedExisting = ownerKey
      ? existing.filter((item) => item.ownerKey === ownerKey)
      : existing;
    if (
      scopedExisting.some(
        (item) => item.host === host && item.port === port && item.username === username,
      )
    ) {
      return { error: 'ALREADY_EXISTS' };
    }
    if (scopedExisting.length >= 50 || existing.length >= MAX_CONNECTION_RECORDS) {
      return { error: 'QUOTA_EXCEEDED' };
    }
    let id = `board-${randomUUID().slice(0, 8)}`;
    while (existing.some((item) => item.id === id)) {
      id = `board-${randomUUID().slice(0, 8)}`;
    }
    const record: StoredConnection = {
      id,
      label: label || `${username}@${host}`,
      host,
      port,
      username,
      agentPort,
      profile: String(input.profile || 'custom').slice(0, 64),
      transport: input.transport === 'bridge' ? 'bridge' : 'ssh',
      localPort: 0,
      createdAt: new Date().toISOString(),
      lastCheckedAt: null,
      lastCheckOk: null,
      lastCheckMessage: '尚未测试连接。',
      ...(ownerKey ? { ownerKey } : {}),
    };
    writeConnections([...existing, record]);
    const { ownerKey: _ownerKey, ...publicRecord } = record;
    return publicRecord;
  });
}

export async function deleteDeviceConnection(id: string, owner?: string): Promise<boolean> {
  await closeDeviceConnectionTunnel(id, owner);
  const { matches } = ownerScope(owner);
  return serializedConnectionMutation(() => {
    const existing = readConnections();
    const next = existing.filter((item) => !(item.id === id && matches(item)));
    if (next.length === existing.length) return false;
    writeConnections(next);
    return true;
  });
}

/** Record a failed probe result on the stored record. */
export async function markConnectionCheck(
  id: string,
  ok: boolean,
  message: string,
  owner?: string,
): Promise<void> {
  const { matches } = ownerScope(owner);
  await serializedConnectionMutation(() => {
    const existing = readConnections();
    const index = existing.findIndex((item) => item.id === id && matches(item));
    if (index < 0) return;
    const next = [...existing];
    next[index] = {
      ...next[index],
      lastCheckedAt: new Date().toISOString(),
      lastCheckOk: ok,
      lastCheckMessage: String(message).slice(0, 400),
    };
    writeConnections(next);
  });
}

process.once('exit', () => {
  for (const state of tunnels.values()) {
    try {
      state.process.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
});
