#!/usr/bin/env node

/**
 * Loopback BoardAgent reference for local Sim2Real acceptance.
 *
 * It deliberately implements two read-only surfaces and never opens SSH,
 * invokes a shell, uploads an artifact, starts a process, or enables
 * actuators:
 *
 *  1. The board passport probe used by deployment preflight
 *     (POST /v1/devices/:id/commands with the fixed preflight command).
 *  2. The host-station (上位机) protocol from ./board-station.mjs:
 *     GET /v1/station/status, GET /v1/station/status/stream (NDJSON),
 *     GET /v1/station/camera.mjpeg (MJPEG fixture loop), and the
 *     allowlisted read-only POST /v1/station/commands.
 *
 * Replace this process with the controlled RDK-X5 agent in a hardware
 * deployment; the wire contract is documented in docs/host-station.md.
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BOARD_CAMERA_FIXTURE_FRAMES } from './board-camera-frames.mjs';
import {
  STATION_CAMERA_INTERVAL_MS,
  STATION_COMMANDS,
  STATION_MAX_STREAM_CLIENTS,
  STATION_STATUS_INTERVAL_MS,
  buildStationCommandResult,
  buildStationStatus,
  isStationCommandId,
} from './board-station.mjs';

const MAX_BODY_BYTES = 64 * 1024;
// Policy upload ceiling: matches the real agent's (68 MB covers a 50 MB ONNX
// plus base64 inflation inside the JSON body).
const MAX_POLICY_BODY_BYTES = 68 * 1024 * 1024;
const BEGIN = '__STUDIO_SIM2REAL_PREFLIGHT_BEGIN__';
const END = '__STUDIO_SIM2REAL_PREFLIGHT_END__';
const BOUNDARY = 'rdk-board-station-frame';
const STATION_STARTED_AT_MS = Date.now();

// In-memory policies dir mirroring the real agent's pinned
// /root/rdk-board-agent/policies. Values are { bytes: Buffer } so the
// software loop can stage + load a trained policy without a board; every
// staged entry carries the SHA-256 it was verified against at upload time.
const stagedPolicies = new Map();

export function buildBoardPreflightCommand() {
  return [
    'set +e',
    `printf "${BEGIN}\\n"`,
    'printf "arch=%s\\n" "$(uname -m 2>/dev/null || echo unknown)"',
    'printf "kernel=%s\\n" "$(uname -r 2>/dev/null || echo unknown)"',
    'printf "python3=%s\\n" "$(command -v python3 2>/dev/null || echo missing)"',
    'printf "tros=%s\\n" "$(if test -d /opt/tros || test -d /opt/ros; then echo present; else echo missing; fi)"',
    'printf "disk_bytes=%s\\n" "$(df -Pk /tmp 2>/dev/null | awk \'NR==2 {print $4 * 1024}\' || echo unknown)"',
    'printf "bpu_toolchain=%s\\n" "$(if command -v hbdk-sim >/dev/null 2>&1 && (command -v hbrtmlin >/dev/null 2>&1 || command -v hbrt-tv >/dev/null 2>&1); then echo present; else echo missing; fi)"',
    `printf "${END}\\n"`,
  ].join('; ');
}

function json(response, status, payload) {
  const body = JSON.stringify(payload);
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('connection', 'close');
  response.setHeader('content-length', Buffer.byteLength(body));
  response.end(body);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('request too large'), { statusCode: 413 }));
        request.destroy();
      }
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function readBodyBounded(request, ceiling) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > ceiling) {
        reject(Object.assign(new Error('request too large'), { statusCode: 413 }));
        request.destroy();
      }
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

/**
 * Stage one uploaded ONNX into the in-memory policies dir. Same contract as
 * the real agent's policy_stage: bare <word>.onnx filename, base64 bytes,
 * SHA-256 verified against the declared digest BEFORE storage, and a
 * same-name conflict only resolves when the bytes hash identically. Staging
 * and loading remain two explicit actions.
 */
function stagePolicy(source) {
  const filename = typeof source?.filename === 'string' ? source.filename : '';
  if (!/^[\w.-]+\.onnx$/.test(filename) || filename.includes('..')) {
    return {
      ok: false,
      error: 'policy-filename-invalid',
      message: '仅接受 policies 目录内的 .onnx 文件名',
    };
  }
  const raw = typeof source?.bytesBase64 === 'string' ? source.bytesBase64 : '';
  let payload;
  try {
    payload = Buffer.from(raw, 'base64');
  } catch {
    payload = null;
  }
  if (!payload || payload.length === 0) {
    return { ok: false, error: 'policy-bytes-invalid', message: '制品字节必须是合法 base64' };
  }
  if (payload.length > 50 * 1024 * 1024) {
    return { ok: false, error: 'policy-too-large', message: '制品超过 50MB 上限' };
  }
  // Buffer.from is lenient with invalid base64; round-trip the decoded bytes
  // through a canonical re-encode and require the input to match exactly, so
  // padding tricks or truncated encodings cannot smuggle different bytes
  // past the digest check.
  if (payload.toString('base64') !== raw) {
    return { ok: false, error: 'policy-bytes-invalid', message: '制品字节必须是合法 base64' };
  }
  const digest = createHash('sha256').update(payload).digest('hex');
  const declared = typeof source?.sha256 === 'string' ? source.sha256.trim().toLowerCase() : '';
  if (!/^[a-f0-9]{64}$/.test(declared) || digest !== declared) {
    return {
      ok: false,
      error: 'policy-digest-mismatch',
      message: '制品 SHA-256 与声明不一致；拒绝写入',
      actual: digest,
    };
  }
  const existing = stagedPolicies.get(filename);
  if (existing) {
    if (existing.sha256 !== digest) {
      return {
        ok: false,
        error: 'policy-name-conflict',
        message: '同名制品已存在且内容不同；请先删除或换名重传',
        existing: existing.sha256,
      };
    }
    return {
      ok: true,
      staged: true,
      path: filename,
      bytes: payload.length,
      sha256: digest,
      note: 'byte-identical to the staged file; no rewrite',
    };
  }
  stagedPolicies.set(filename, { bytes: payload, sha256: digest });
  return {
    ok: true,
    staged: true,
    path: filename,
    bytes: payload.length,
    sha256: digest,
    note: 'staged (reference agent, in-memory); loading stays a separate action',
  };
}

function listPolicies() {
  return {
    ok: true,
    dir: '(reference agent, in-memory)',
    policies: [...stagedPolicies.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, entry]) => ({ name, bytes: entry.bytes.length, sha256: entry.sha256 })),
  };
}

function authorized(request) {
  const token = String(process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN || '').trim();
  if (!token) return true;
  // Constant-time comparison so a network attacker cannot recover the token
  // byte by byte from response timing. Length mismatch is still rejected
  // before the comparison, which leaks only the header length (already
  // visible on the wire), never token content.
  const presented = Buffer.from(String(request.headers.authorization ?? ''), 'utf8');
  const expected = Buffer.from(`Bearer ${token}`, 'utf8');
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

function passportOutput() {
  const arch = String(process.env.RDK_SIM2REAL_BOARD_AGENT_ARCH || 'aarch64').trim();
  const kernel = String(process.env.RDK_SIM2REAL_BOARD_AGENT_KERNEL || '6.1.0-rdk').trim();
  const python3 = String(process.env.RDK_SIM2REAL_BOARD_AGENT_PYTHON3 || '/usr/bin/python3').trim();
  const tros = String(process.env.RDK_SIM2REAL_BOARD_AGENT_TROS || 'present').trim();
  const diskBytes = Number(process.env.RDK_SIM2REAL_BOARD_AGENT_DISK_BYTES || 8 * 1024 ** 3);
  // The simulated agent mirrors the real agent's probe field; defaults to
  // missing so the demo never claims a BPU toolchain the host does not have.
  const bpuToolchain =
    String(process.env.RDK_SIM2REAL_BOARD_AGENT_BPU_TOOLCHAIN || '').trim() === 'present'
      ? 'present'
      : 'missing';
  return (
    [
      BEGIN,
      `arch=${arch}`,
      `kernel=${kernel}`,
      `python3=${python3}`,
      `tros=${tros}`,
      `disk_bytes=${Number.isFinite(diskBytes) ? Math.max(0, Math.floor(diskBytes)) : 0}`,
      `bpu_toolchain=${bpuToolchain}`,
      END,
    ].join('\n') + '\n'
  );
}

function onboardingPreflight() {
  const camera = String(process.env.RDK_SIM2REAL_BOARD_AGENT_CAMERA || 'fixture').trim();
  const tros = String(process.env.RDK_SIM2REAL_BOARD_AGENT_TROS || 'present').trim() === 'present';
  const topics = tros ? ['/imu', '/odom', '/cmd_vel'] : [];
  const checks = {
    identity: { ok: true, board: { platform: 'rdk-x5', model: 'RDK X5 (simulated)' } },
    python: { ok: true, path: '/usr/bin/python3' },
    tros: { ok: tros, setup: '/opt/tros' },
    camera: { ok: camera !== 'missing', devices: camera === 'missing' ? [] : ['/dev/video-fixture'], cv2: true },
    ros: { ok: topics.length > 0, topicCount: topics.length, topics, expected: {
      imu: { name: '/imu', present: topics.includes('/imu') },
      odom: { name: '/odom', present: topics.includes('/odom') },
      cmdVel: { name: '/cmd_vel', present: topics.includes('/cmd_vel') },
    } },
    telemetry: { ok: tros, fresh: tros, fields: tros ? ['imu', 'odom'] : [] },
    policy: { enabled: false, runtimeRunning: false, artifactDir: '(reference agent, in-memory)', artifactDirPresent: true, artifactCount: stagedPolicies.size },
    safety: { driveEnabled: false, policyEnabled: false, motionAuthorized: false, limits: { maxLinear: 0, maxAngular: 0 }, emergencyStop: '/v1/station/drive/stop' },
  };
  const blockingChecks = Object.entries(checks).filter(([, value]) => value.ok === false).map(([key]) => key);
  return {
    ok: true, kind: 'originbot-onboarding-preflight', schemaVersion: 1, mock: true,
    status: blockingChecks.length ? 'attention' : 'ready', ready: blockingChecks.length === 0,
    blockingChecks, nextActions: blockingChecks.length ? ['reference agent is mock-only; connect a real board for release evidence'] : [],
    checks, observedAt: new Date().toISOString(), motion: { started: false, note: 'onboarding preflight is read-only' },
  };
}

/**
 * Heartbeat stream. Each line is a `buildStationStatus` snapshot; the stream
 * is capped by a shared client budget so a demo cannot fan out unbounded
 * timers. Closed sockets stop their own timer (no leaked intervals).
 */
function pipeStationStatusStream(request, response, streams) {
  if (streams.clients >= STATION_MAX_STREAM_CLIENTS) {
    json(response, 503, {
      ok: false,
      error: 'BOARD_AGENT_STREAM_BUSY',
      message: `station streams support at most ${STATION_MAX_STREAM_CLIENTS} concurrent clients`,
    });
    return;
  }
  streams.clients += 1;
  let tick = Math.floor((Date.now() - STATION_STARTED_AT_MS) / STATION_STATUS_INTERVAL_MS);
  response.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'close',
  });
  const cleanup = () => {
    clearInterval(timer);
    streams.clients = Math.max(0, streams.clients - 1);
    try {
      response.destroy();
    } catch {
      /* already closed */
    }
  };
  const writeSnapshot = () => {
    try {
      response.write(
        JSON.stringify(buildStationStatus({ startedAtMs: STATION_STARTED_AT_MS, tick })) + '\n',
      );
      tick += 1;
    } catch {
      cleanup();
    }
  };
  const timer = setInterval(writeSnapshot, STATION_STATUS_INTERVAL_MS);
  request.on('close', cleanup);
  response.on('error', cleanup);
  writeSnapshot();
}

/**
 * Synthetic MJPEG camera stream: loops the fixture frames inside a standard
 * multipart/x-mixed-replace response so a plain <img> tag renders it. A
 * browser that cancels the stream simply closes the socket; the interval is
 * cleared and the client budget released.
 */
function pipeStationCamera(request, response, streams) {
  if (streams.clients >= STATION_MAX_STREAM_CLIENTS) {
    json(response, 503, {
      ok: false,
      error: 'BOARD_AGENT_STREAM_BUSY',
      message: `station streams support at most ${STATION_MAX_STREAM_CLIENTS} concurrent clients`,
    });
    return;
  }
  streams.clients += 1;
  let index = 0;
  response.writeHead(200, {
    'content-type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
    'cache-control': 'no-store',
    'x-board-camera': 'synthetic-fixture',
    connection: 'close',
  });
  const cleanup = () => {
    clearInterval(timer);
    streams.clients = Math.max(0, streams.clients - 1);
    try {
      response.destroy();
    } catch {
      /* already closed */
    }
  };
  const writeFrame = () => {
    const frame = BOARD_CAMERA_FIXTURE_FRAMES[index % BOARD_CAMERA_FIXTURE_FRAMES.length];
    index += 1;
    try {
      response.write(
        `--${BOUNDARY}\r\ncontent-type: image/jpeg\r\ncontent-length: ${frame.length}\r\n\r\n`,
      );
      response.write(frame);
      response.write('\r\n');
    } catch {
      cleanup();
    }
  };
  const timer = setInterval(writeFrame, STATION_CAMERA_INTERVAL_MS);
  request.on('close', cleanup);
  response.on('error', cleanup);
  writeFrame();
}

function handleStationCommand(request, response) {
  readBody(request)
    .then((body) => {
      const payload = JSON.parse(body);
      const id = String(payload?.id ?? '').trim();
      if (!isStationCommandId(id)) {
        json(response, 403, {
          ok: false,
          error: 'BOARD_AGENT_READ_ONLY',
          message: 'unknown station command; only the allowlisted read-only commands are accepted',
          commands: STATION_COMMANDS.map((command) => ({ id: command.id, label: command.label })),
        });
        return;
      }
      const tick = Math.floor((Date.now() - STATION_STARTED_AT_MS) / STATION_STATUS_INTERVAL_MS);
      json(response, 200, buildStationCommandResult(id, { tick }));
    })
    .catch((error) => {
      json(response, Number(error?.statusCode) || 400, {
        ok: false,
        error: 'BOARD_AGENT_INVALID_JSON',
      });
    });
}

export function createLocalBoardAgentServer() {
  // One shared budget across every stream of this process: a demo browser
  // cannot fan out unbounded status/camera timers per tab.
  const streams = { clients: 0 };
  return createServer(async (request, response) => {
    if (!authorized(request)) {
      json(response, 401, { ok: false, error: 'BOARD_AGENT_UNAUTHORIZED' });
      return;
    }
    if (request.method === 'GET' && request.url === '/healthz') {
      json(response, 200, {
        ok: true,
        service: 'local-board-agent-reference',
        capabilities: ['read-only-preflight', 'host-station'],
        stationCommands: STATION_COMMANDS.map((command) => ({
          id: command.id,
          label: command.label,
        })),
        actuatorControl: false,
        mock: true,
      });
      return;
    }
    if (request.method === 'GET' && request.url === '/v1/onboarding/preflight') {
      json(response, 200, onboardingPreflight());
      return;
    }
    if (request.method === 'GET' && request.url === '/v1/station/status') {
      const tick = Math.floor((Date.now() - STATION_STARTED_AT_MS) / STATION_STATUS_INTERVAL_MS);
      json(response, 200, buildStationStatus({ startedAtMs: STATION_STARTED_AT_MS, tick }));
      return;
    }
    if (request.method === 'GET' && request.url === '/v1/station/policy/files') {
      json(response, 200, listPolicies());
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/station/policy/upload') {
      try {
        const body = JSON.parse(await readBodyBounded(request, MAX_POLICY_BODY_BYTES));
        const result = stagePolicy(body);
        json(response, result.ok ? 200 : 409, { ...result, policies: listPolicies().policies });
      } catch (error) {
        json(response, Number(error?.statusCode) || 400, {
          ok: false,
          error:
            Number(error?.statusCode) === 413
              ? 'policy-upload-too-large'
              : 'BOARD_AGENT_INVALID_JSON',
        });
      }
      return;
    }
    if (request.method === 'GET' && request.url === '/v1/station/status/stream') {
      pipeStationStatusStream(request, response, streams);
      return;
    }
    if (request.method === 'GET' && request.url === '/v1/station/camera.mjpeg') {
      pipeStationCamera(request, response, streams);
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/station/commands') {
      handleStationCommand(request, response);
      return;
    }
    if (request.method !== 'POST' || !/^\/v1\/devices\/[^/]+\/commands$/.test(request.url || '')) {
      json(response, 404, { ok: false, error: 'BOARD_AGENT_NOT_FOUND' });
      return;
    }
    try {
      const body = JSON.parse(await readBody(request));
      const commands = Array.isArray(body?.commands) ? body.commands : [];
      if (
        !commands.length ||
        commands.length > 8 ||
        commands.some((item) => typeof item !== 'string' || item.length > 16_000)
      ) {
        json(response, 400, { ok: false, error: 'BOARD_AGENT_INVALID_COMMANDS' });
        return;
      }
      // Only the fixed preflight protocol is understood. Unknown commands are
      // rejected instead of being passed to a shell or a board.
      if (commands.length !== 1 || commands[0] !== buildBoardPreflightCommand()) {
        json(response, 403, {
          ok: false,
          error: 'BOARD_AGENT_READ_ONLY',
          message: 'reference agent only accepts the read-only preflight command',
        });
        return;
      }
      json(response, 200, {
        ok: true,
        device: {
          id: decodeURIComponent((request.url || '').split('/')[3] || ''),
          kind: 'simulated-x5',
          boardPlatform: 'rdk-x5',
          boardModel: 'RDK X5 (simulated)',
          boardOsVersion: String(process.env.RDK_SIM2REAL_BOARD_AGENT_KERNEL || '6.1.0-rdk').trim(),
        },
        output: passportOutput(),
        exitCode: 0,
        mock: true,
        actuatorControl: false,
        requestUuid: randomUUID().slice(0, 8),
      });
    } catch (error) {
      json(response, Number(error?.statusCode) || 400, {
        ok: false,
        error: 'BOARD_AGENT_INVALID_JSON',
      });
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const host =
    String(process.env.RDK_SIM2REAL_BOARD_AGENT_BIND_HOST || '127.0.0.1').trim() || '127.0.0.1';
  const rawPort = Number(process.env.RDK_SIM2REAL_BOARD_AGENT_PORT || 19100);
  const port = Number.isInteger(rawPort) && rawPort >= 1024 && rawPort <= 65535 ? rawPort : 19100;
  const server = createLocalBoardAgentServer();
  server.listen(port, host, () => {
    console.log(`local BoardAgent reference listening on http://${host}:${port}`);
    console.log(
      'host-station endpoints: /v1/station/status /v1/station/status/stream /v1/station/camera.mjpeg /v1/station/commands',
    );
  });
  function shutdown() {
    server.close(() => process.exit(0));
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
