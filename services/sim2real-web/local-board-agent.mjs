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
import { randomUUID } from 'node:crypto';
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
const BEGIN = '__STUDIO_SIM2REAL_PREFLIGHT_BEGIN__';
const END = '__STUDIO_SIM2REAL_PREFLIGHT_END__';
const BOUNDARY = 'rdk-board-station-frame';
const STATION_STARTED_AT_MS = Date.now();

export function buildBoardPreflightCommand() {
  return [
    'set +e',
    `printf "${BEGIN}\\n"`,
    'printf "arch=%s\\n" "$(uname -m 2>/dev/null || echo unknown)"',
    'printf "kernel=%s\\n" "$(uname -r 2>/dev/null || echo unknown)"',
    'printf "python3=%s\\n" "$(command -v python3 2>/dev/null || echo missing)"',
    'printf "tros=%s\\n" "$(if test -d /opt/tros || test -d /opt/ros; then echo present; else echo missing; fi)"',
    'printf "disk_bytes=%s\\n" "$(df -Pk /tmp 2>/dev/null | awk \'NR==2 {print $4 * 1024}\' || echo unknown)"',
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

function authorized(request) {
  const token = String(process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN || '').trim();
  if (!token) return true;
  return request.headers.authorization === `Bearer ${token}`;
}

function passportOutput() {
  const arch = String(process.env.RDK_SIM2REAL_BOARD_AGENT_ARCH || 'aarch64').trim();
  const kernel = String(process.env.RDK_SIM2REAL_BOARD_AGENT_KERNEL || '6.1.0-rdk').trim();
  const python3 = String(process.env.RDK_SIM2REAL_BOARD_AGENT_PYTHON3 || '/usr/bin/python3').trim();
  const tros = String(process.env.RDK_SIM2REAL_BOARD_AGENT_TROS || 'present').trim();
  const diskBytes = Number(process.env.RDK_SIM2REAL_BOARD_AGENT_DISK_BYTES || 8 * 1024 ** 3);
  return [
    BEGIN,
    `arch=${arch}`,
    `kernel=${kernel}`,
    `python3=${python3}`,
    `tros=${tros}`,
    `disk_bytes=${Number.isFinite(diskBytes) ? Math.max(0, Math.floor(diskBytes)) : 0}`,
    END,
  ].join('\n') + '\n';
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
        stationCommands: STATION_COMMANDS.map((command) => ({ id: command.id, label: command.label })),
        actuatorControl: false,
        mock: true,
      });
      return;
    }
    if (request.method === 'GET' && request.url === '/v1/station/status') {
      const tick = Math.floor((Date.now() - STATION_STARTED_AT_MS) / STATION_STATUS_INTERVAL_MS);
      json(response, 200, buildStationStatus({ startedAtMs: STATION_STARTED_AT_MS, tick }));
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
  const host = String(process.env.RDK_SIM2REAL_BOARD_AGENT_BIND_HOST || '127.0.0.1').trim() || '127.0.0.1';
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
