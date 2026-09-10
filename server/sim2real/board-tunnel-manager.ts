import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

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
}

interface StoredConnection extends DeviceConnectionRecord {
  ownerKey?: string;
}

const TUNNEL_SSH_CONNECT_TIMEOUT_SEC = 8;
const MAX_LOCAL_PORT = 65_530;
const MIN_LOCAL_PORT = 20_000;
const portRange = () => MIN_LOCAL_PORT + Math.floor(Math.random() * (MAX_LOCAL_PORT - MIN_LOCAL_PORT));

interface TunnelState {
  process: ChildProcess;
  localPort: number;
  startedAt: number;
  lastExit?: { code: number | null; signal: NodeJS.Signals | null };
}

const tunnels = new Map<string, TunnelState>();
let connectionWriteQueue: Promise<unknown> = Promise.resolve();

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

function readConnections(): StoredConnection[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(connectionsFile(), 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .slice(0, 100)
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
      .map((item): StoredConnection | null => {
        const host = normalizeHost(item.host);
        if (!host) return null;
        return {
          id: String(item.id ?? '').trim(),
          label: String(item.label ?? '').trim().slice(0, 120),
          host,
          port: normalizePort(item.port, 22, 1, 65_535),
          username: String(item.username ?? 'root').trim().slice(0, 64),
          agentPort: normalizePort(item.agentPort, 19_100, 1, 65_535),
          localPort: normalizePort(item.localPort, 0, 0, 65_535),
          createdAt: String(item.createdAt ?? ''),
          lastCheckedAt: item.lastCheckedAt ? String(item.lastCheckedAt) : null,
          lastCheckOk: item.lastCheckOk === true ? true : item.lastCheckOk === false ? false : null,
          lastCheckMessage: String(item.lastCheckMessage ?? '').slice(0, 400),
          ownerKey: item.ownerKey ? String(item.ownerKey).slice(0, 200) : undefined,
        };
      })
      .filter((item): item is StoredConnection => item !== null && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(item.id));
  } catch {
    return [];
  }
}

function persistConnections(next: StoredConnection[]): Promise<void> {
  const operation = connectionWriteQueue.then(() => {
    ensureDataDir();
    const temporary = `${connectionsFile()}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(temporary, connectionsFile());
  });
  connectionWriteQueue = operation.catch(() => undefined);
  return operation as Promise<void>;
}

function ownerScope(owner: string | undefined): { ownerKey: string | null; matches: (record: StoredConnection) => boolean } {
  const key = owner ? `sso:${owner}:web` : null;
  return {
    ownerKey: key,
    // Single-user mode sees every connection (mirrors visibleDevices).
    matches: (record) => !key || record.ownerKey === key,
  };
}

export function listDeviceConnections(owner?: string): DeviceConnectionRecord[] {
  const { matches } = ownerScope(owner);
  return readConnections().filter(matches).map(({ ownerKey: _ownerKey, ...publicRecord }) => publicRecord);
}

/** The loopback agent URL of a connection, if its tunnel is up. */
export function deviceConnectionAgentUrl(id: string, owner?: string): string | null {
  const { matches } = ownerScope(owner);
  const record = readConnections().find((item) => item.id === id && matches(item));
  if (!record) return null;
  const state = tunnels.get(id);
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
      headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return { ok: false, message: `板端 agent 返回 HTTP ${response.status}` };
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return { ok: false, message: '板端 agent 健康响应不是合法 JSON' };
    const board = body.board && typeof body.board === 'object' ? (body.board as Record<string, unknown>) : null;
    return {
      ok: true,
      message: '连接正常',
      agentInfo: {
        mock: body.mock === true,
        capabilities: Array.isArray(body.capabilities)
          ? (body.capabilities as unknown[]).slice(0, 8).map((item) => String(item))
          : undefined,
        boardModel: board && typeof board.model === 'string' ? board.model.slice(0, 120) : undefined,
      },
    };
  } catch (error) {
    return { ok: false, message: `板端 agent 不可达：${error instanceof Error ? error.message : '未知错误'}` };
  }
}

/**
 * Start (or reuse) the SSH tunnel for a connection and verify the agent
 * answers on the forwarded loopback port. Fails closed: any SSH or health
 * failure tears the tunnel down and reports honestly.
 */
export async function openDeviceConnectionTunnel(
  id: string,
  owner?: string,
): Promise<{ url: string; probe: TunnelProbeResult } | { error: string }> {
  const { matches } = ownerScope(owner);
  const record = readConnections().find((item) => item.id === id && matches(item));
  if (!record) return { error: 'NOT_FOUND' };
  if (!isSshAvailable()) return { error: 'SSH_UNAVAILABLE' };

  const existing = tunnels.get(id);
  if (existing && existing.process.exitCode === null && existing.process.signalCode === null) {
    const probe = await probeAgent(existing.localPort);
    if (probe.ok) return { url: `http://127.0.0.1:${existing.localPort}`, probe };
    await closeDeviceConnectionTunnel(id);
  }

  const localPort = portRange();
  const child = spawn(
    'ssh',
    [
      '-N',
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', `ConnectTimeout=${TUNNEL_SSH_CONNECT_TIMEOUT_SEC}`,
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=4',
      '-o', 'TCPKeepAlive=yes',
      '-L', `${localPort}:127.0.0.1:${record.agentPort}`,
      `${record.username}@${record.host}`,
      '-p', String(record.port),
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
  tunnels.set(id, { process: child, localPort, startedAt: Date.now() });

  // Wait until ssh either establishes the forward (process keeps running) or
  // exits. ExitOnForwardFailure turns a failed forward into a quick exit.
  const exited = await new Promise<null | { code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    const timer = setTimeout(() => resolve(null), TUNNEL_SSH_CONNECT_TIMEOUT_SEC * 1000 + 1500);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    child.once('exit', onExit);
  });
  if (exited) {
    tunnels.delete(id);
    const reason = stderrTail.trim() || `ssh 退出（code=${exited.code}）`;
    return { error: `SSH 连接失败：${reason}` };
  }

  const probe = await probeAgent(localPort);
  if (!probe.ok) {
    await closeDeviceConnectionTunnel(id);
    return { error: probe.message };
  }

  // Persist the healthy state so the UI can show it after refresh.
  const next = readConnections().map((item) =>
    item.id === id
      ? { ...item, localPort, lastCheckedAt: new Date().toISOString(), lastCheckOk: true, lastCheckMessage: probe.message }
      : item,
  );
  await persistConnections(next);
  return { url: `http://127.0.0.1:${localPort}`, probe };
}

/** Tear down one connection's tunnel (idempotent). */
export function closeDeviceConnectionTunnel(id: string): Promise<void> {
  const state = tunnels.get(id);
  if (!state) return Promise.resolve();
  tunnels.delete(id);
  return new Promise((resolve) => {
    const forceKill = setTimeout(() => {
      try { state.process.kill('SIGKILL'); } catch { /* already gone */ }
      resolve();
    }, 2000);
    state.process.once('exit', () => {
      clearTimeout(forceKill);
      resolve();
    });
    try { state.process.kill('SIGTERM'); } catch { /* already gone */ }
  });
}

export function activeDeviceConnections(): string[] {
  return [...tunnels.entries()]
    .filter(([, state]) => state.process.exitCode === null && state.process.signalCode === null)
    .map(([id]) => id);
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
}

export async function createDeviceConnection(
  input: CreateConnectionInput,
  owner?: string,
): Promise<DeviceConnectionRecord | { error: string }> {
  const host = normalizeHost(input.host);
  if (!host) return { error: 'INVALID_HOST' };
  const username = String(input.username ?? 'root').trim();
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,63}$/.test(username)) return { error: 'INVALID_USERNAME' };
  const label = String(input.label ?? '').trim().slice(0, 120);
  const port = normalizePort(input.port, 22, 1, 65_535);
  const agentPort = normalizePort(input.agentPort, 19_100, 1, 65_535);
  const existing = readConnections();
  if (existing.some((item) => item.host === host && item.port === port && item.username === username)) {
    return { error: 'ALREADY_EXISTS' };
  }
  if (existing.length >= 50) return { error: 'QUOTA_EXCEEDED' };
  const { ownerKey } = ownerScope(owner);
  const record: StoredConnection = {
    id: `board-${randomUUID().slice(0, 8)}`,
    label: label || `${username}@${host}`,
    host,
    port,
    username,
    agentPort,
    localPort: 0,
    createdAt: new Date().toISOString(),
    lastCheckedAt: null,
    lastCheckOk: null,
    lastCheckMessage: '尚未测试连接。',
    ...(ownerKey ? { ownerKey } : {}),
  };
  await persistConnections([...existing, record]);
  const { ownerKey: _ownerKey, ...publicRecord } = record;
  return publicRecord;
}

export async function deleteDeviceConnection(id: string, owner?: string): Promise<boolean> {
  await closeDeviceConnectionTunnel(id);
  const { matches } = ownerScope(owner);
  const existing = readConnections();
  const next = existing.filter((item) => !(item.id === id && matches(item)));
  if (next.length === existing.length) return false;
  await persistConnections(next);
  return true;
}

/** Record a failed probe result on the stored record. */
export async function markConnectionCheck(
  id: string,
  ok: boolean,
  message: string,
  owner?: string,
): Promise<void> {
  const { matches } = ownerScope(owner);
  const next = readConnections().map((item) =>
    item.id === id && matches(item)
      ? {
          ...item,
          lastCheckedAt: new Date().toISOString(),
          lastCheckOk: ok,
          lastCheckMessage: String(message).slice(0, 400),
        }
      : item,
  );
  await persistConnections(next);
}

process.once('exit', () => {
  for (const state of tunnels.values()) {
    try { state.process.kill('SIGTERM'); } catch { /* already gone */ }
  }
});
