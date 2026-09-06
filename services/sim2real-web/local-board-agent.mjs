#!/usr/bin/env node

/**
 * Loopback BoardAgent reference for local Sim2Real acceptance.
 *
 * It deliberately implements one operation: the read-only board passport
 * probe used by deployment preflight. It never opens SSH, invokes a shell,
 * uploads an artifact, starts a process, or enables actuators. Replace this
 * process with the controlled RDK-X5 agent in a hardware deployment.
 */
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_BODY_BYTES = 64 * 1024;
const BEGIN = '__STUDIO_SIM2REAL_PREFLIGHT_BEGIN__';
const END = '__STUDIO_SIM2REAL_PREFLIGHT_END__';

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

export function createLocalBoardAgentServer() {
  return createServer(async (request, response) => {
    if (!authorized(request)) {
      json(response, 401, { ok: false, error: 'BOARD_AGENT_UNAUTHORIZED' });
      return;
    }
    if (request.method === 'GET' && request.url === '/healthz') {
      json(response, 200, {
        ok: true,
        service: 'local-board-agent-reference',
        capabilities: ['read-only-preflight'],
        actuatorControl: false,
        mock: true,
      });
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
  });
  function shutdown() {
    server.close(() => process.exit(0));
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
