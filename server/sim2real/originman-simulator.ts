import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OriginmanTeleopRehearsal } from './originman-teleop-rehearsal.mjs';

const driveDirections = ['walk-forward', 'walk-backward', 'turn-left', 'turn-right'];
const motions = ['look-left', 'look-right', 'nod', 'wave-left', 'wave-right', ...driveDirections];
export type SimulationCommand = {
  command: 'step' | 'reset' | 'push' | 'camera' | 'motion';
  steps?: number;
  drive?: string;
  name?: string;
  force?: number;
  azimuth?: number;
  elevation?: number;
  distance?: number;
};
export function validateSimulationCommand(value: unknown): SimulationCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid_command');
  const v = value as Record<string, unknown>;
  const allowed: Record<string, string[]> = {
    step: ['steps', 'drive'],
    reset: [],
    motion: ['name'],
    push: ['force', 'delay'],
    camera: ['azimuth', 'elevation', 'distance'],
  };
  const keys = Object.hasOwn(allowed, String(v.command)) ? allowed[String(v.command)] : undefined;
  if (!keys || Object.keys(v).some((k) => k !== 'command' && !keys.includes(k)))
    throw new Error('invalid_command');
  for (const [key, low, high] of [
    ['steps', 1, 10],
    ['force', -9, 9],
    ['delay', 0, 5],
    ['azimuth', -360, 360],
    ['elevation', -80, -5],
    ['distance', 0.4, 2.5],
  ] as const) {
    if (v[key] === undefined) continue;
    if (
      typeof v[key] !== 'number' ||
      !Number.isFinite(v[key]) ||
      v[key] < low ||
      v[key] > high ||
      (key === 'steps' && !Number.isInteger(v[key]))
    )
      throw new Error('invalid_command');
  }
  if (
    (v.command === 'push' && v.force === undefined) ||
    (v.drive !== undefined &&
      (typeof v.drive !== 'string' || !driveDirections.includes(v.drive))) ||
    (v.command === 'motion' && (typeof v.name !== 'string' || !motions.includes(v.name)))
  )
    throw new Error('invalid_command');
  return v as SimulationCommand;
}
const MAX_SIMULATION_SESSIONS = 12;
type Reply = Record<string, unknown>;
type Session = {
  owner: string;
  process: ChildProcessWithoutNullStreams;
  busy: boolean;
  touched: number;
  created: number;
  teleop?: OriginmanTeleopRehearsal;
  pending?: {
    resolve: (v: Reply) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
};
export class OriginmanSimulator {
  private sessions = new Map<string, Session>();
  constructor() {
    const timer = setInterval(() => this.sweep(), 30_000);
    timer.unref();
  }
  available() {
    return Boolean(process.env.RDK_ORIGINMAN_SIM_PYTHON && process.env.RDK_ORIGINMAN_SCENE_PATH);
  }
  sweep(now = Date.now()) {
    for (const [id, session] of this.sessions) {
      if (now - session.touched > 120_000 || now - session.created > 900_000)
        this.close(id, session.owner);
    }
  }
  owns(id: string, owner: string) {
    return this.sessions.get(id)?.owner === owner;
  }
  close(id: string, owner: string) {
    const session = this.sessions.get(id);
    if (!session || session.owner !== owner) return false;
    session.teleop?.close();
    this.sessions.delete(id);
    session.pending?.reject(new Error('simulation_closed'));
    if (session.pending) clearTimeout(session.pending.timer);
    session.process.kill('SIGTERM');
    return true;
  }
  async create(
    owner: string,
    policy?: { bytes: Buffer; sha256: string },
    renderMode: 'jpeg' | 'webgl' = 'jpeg',
  ) {
    this.sweep();
    if (!this.available()) throw new Error('simulation_not_configured');
    if (
      this.sessions.size >= MAX_SIMULATION_SESSIONS ||
      [...this.sessions.values()].filter((s) => s.owner === owner).length >= 2
    )
      throw new Error('simulation_quota');
    if (
      policy &&
      (policy.bytes.length > 2_000_000 ||
        createHash('sha256').update(policy.bytes).digest('hex') !== policy.sha256)
    )
      throw new Error('policy_digest_mismatch');
    const id = randomUUID();
    const script = fileURLToPath(
      new URL('../../engines/originman-straight/interactive_sim.py', import.meta.url),
    );
    const child = spawn(
      process.env.RDK_ORIGINMAN_SIM_PYTHON!,
      [script, process.env.RDK_ORIGINMAN_SCENE_PATH!],
      {
        env: {
          PATH: process.env.PATH,
          LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH,
          MUJOCO_GL: process.env.RDK_ORIGINMAN_SIM_GL || 'egl',
          PYTHONUNBUFFERED: '1',
          MESA_SHADER_CACHE_DISABLE: 'true',
          OPENBLAS_NUM_THREADS: '1',
          OMP_NUM_THREADS: '1',
        },
        cwd: path.dirname(script),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      },
    );
    const session: Session = {
      owner,
      process: child,
      busy: false,
      touched: Date.now(),
      created: Date.now(),
    };
    this.sessions.set(id, session);
    // Python stderr may contain private filesystem paths; never return it to a browser.
    child.stderr.resume();
    let buffered = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      if (buffered.length > 16_000_000) {
        this.close(id, owner);
        return;
      }
      const newline = buffered.indexOf('\n');
      if (newline < 0) return;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      const pending = session.pending;
      if (!pending) return;
      session.pending = undefined;
      session.busy = false;
      clearTimeout(pending.timer);
      try {
        const reply = JSON.parse(line) as Reply;
        if (reply.ok !== true) throw new Error('simulation_command_failed');
        pending.resolve(reply);
      } catch {
        pending.reject(new Error('simulation_command_failed'));
      }
    });
    const died = () => {
      session.teleop?.close();
      const pending = session.pending;
      if (pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error('simulation_process_stopped'));
      }
      this.sessions.delete(id);
    };
    child.stdin.on('error', died);
    child.once('error', died);
    child.once('close', died);
    try {
      const state = await this.exchange(
        id,
        owner,
        {
          command: 'init',
          renderMode,
          ...(policy ? { policy: policy.bytes.toString('base64') } : {}),
        },
        30_000,
      );
      return { ...state, sessionId: id };
    } catch (error) {
      this.close(id, owner);
      throw error;
    }
  }
  teleop(id: string, owner: string, body: unknown): [number, unknown] {
    const session = this.sessions.get(id);
    if (!session || session.owner !== owner) throw new Error('simulation_not_found');
    session.teleop ??= new OriginmanTeleopRehearsal();
    return session.teleop.handle(body);
  }
  async command(id: string, owner: string, command: SimulationCommand) {
    return this.exchange(id, owner, validateSimulationCommand(command), 8_000);
  }
  private exchange(id: string, owner: string, value: object, timeout: number): Promise<Reply> {
    const session = this.sessions.get(id);
    if (!session || session.owner !== owner)
      return Promise.reject(new Error('simulation_not_found'));
    if (session.busy) return Promise.reject(new Error('simulation_busy'));
    session.busy = true;
    session.touched = Date.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.close(id, owner);
        reject(new Error('simulation_timeout'));
      }, timeout);
      session.pending = { resolve, reject, timer };
      session.process.stdin.write(JSON.stringify(value) + '\n');
    });
  }
}
