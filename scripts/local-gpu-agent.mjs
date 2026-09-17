#!/usr/bin/env node
/** User-side GPU agent. Keeps GPU credentials on the user's machine.
 * It exposes a loopback-only Worker-compatible endpoint and can proxy a
 * remote worker through an SSH local forward. The platform Web server never
 * connects to the user's GPU.
 *
 * Access modes:
 *  - `local`: proxy a worker that is already reachable from this machine
 *    (same host, or a port you forwarded yourself).
 *  `ssh`:    spawn an SSH local forward to the GPU machine and proxy through it.
 *  `reverse`: the GPU machine dials BACK to this agent over an outbound SSH
 *    tunnel it opens itself (ssh -R). Nothing on the user's machine is exposed
 *    to the network, and no inbound SSH port is needed on the GPU side — the
 *    common case for cloud GPU boxes that only allow outbound connections.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function validHost(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/.test(value);
}
export function validUser(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(value);
}
export function validPort(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}
export function buildSshArgs(config, localPort) {
  if (
    !validHost(config.host) ||
    !validUser(config.user) ||
    !validPort(config.sshPort) ||
    !validPort(config.remotePort)
  )
    throw new Error('invalid SSH configuration');
  return [
    '-N',
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=3',
    '-p',
    String(config.sshPort),
    '-L',
    `127.0.0.1:${localPort}:127.0.0.1:${config.remotePort}`,
    `${config.user}@${config.host}`,
  ];
}

/**
 * Reverse-tunnel command for the GPU machine. Run ON the GPU host: it dials
 * OUT to the user's SSH server and opens a remote forward there, so the
 * user's loopback `forwardPort` becomes a pipe into this GPU's worker. The
 * GPU needs no inbound ports at all (only its own outbound SSH); the user's
 * machine needs a reachable sshd (LAN/VPN). The pairing secret rides in the
 * agent-side path, so the loopback endpoint can authenticate the pair without
 * a shared bearer token the browser could replay elsewhere.
 */
export function buildReverseTunnelCommand(config, secret) {
  if (!validDialback(config.dialback) || !validPort(config.forwardPort))
    throw new Error('invalid reverse configuration');
  return [
    'ssh',
    '-N',
    '-R',
    `127.0.0.1:${config.forwardPort}:127.0.0.1:19091`,
    config.dialback,
    // The GPU side proves itself with the pairing secret; treat it like a
    // credential (do not paste it into shared logs).
    `# pairing secret: ${secret}`,
  ].join(' ');
}

export function validDialback(value) {
  // An SSH target the GPU machine can resolve and reach: [user@]host.
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9._-]{1,64}@[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/.test(value)
  );
}

const port = Number(process.env.RDK_GPU_AGENT_PORT || 19190);
const stateDir = process.env.RDK_GPU_AGENT_HOME || path.join(os.homedir(), '.rdk-lab');
const stateFile = path.join(stateDir, 'agent.json');
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const state = existsSync(stateFile)
  ? JSON.parse(readFileSync(stateFile, 'utf8'))
  : { mode: 'local', workerUrl: 'http://127.0.0.1:19091', resources: [] };
// In reverse mode this is the user-side port the GPU's `ssh -R` binds; the
// pair endpoint proxies into it. Persisted in state so a restart keeps the
// pair working against the same tunnel.
function currentForwardPort() {
  return validPort(state.forwardPort) ? Number(state.forwardPort) : 19092;
}
let tunnel;

function randomSecret() {
  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index += 1)
    bytes[index] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function save() {
  writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
}
function json(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
  });
  res.end(JSON.stringify(value));
}
async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
async function proxy(req, res, target, pathRewrite) {
  const u = new URL(req.url, 'http://127.0.0.1');
  const upstream = new URL(target);
  upstream.pathname = pathRewrite
    ? pathRewrite(u.pathname)
    : u.pathname.replace(/^\/proxy/, '') || '/';
  upstream.search = u.search;
  const response = await fetch(upstream, {
    method: req.method,
    headers: { authorization: req.headers.authorization || '' },
    body: req.method === 'GET' ? undefined : await body(req).then(JSON.stringify),
  });
  res.writeHead(response.status, {
    'content-type': response.headers.get('content-type') || 'application/json',
  });
  res.end(Buffer.from(await response.arrayBuffer()));
}
const server = createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return json(res, 204, {});
    if (req.method === 'GET' && req.url === '/healthz')
      return json(res, 200, {
        ok: true,
        agent: 'rdk-local-gpu-agent',
        mode: state.mode,
        workerUrl: state.workerUrl,
        resources: state.resources,
      });
    if (req.method === 'GET' && req.url === '/resources')
      return json(res, 200, { resources: state.resources });
    if (req.method === 'POST' && req.url === '/connect') {
      const cfg = await body(req);
      const localPort = Number(cfg.localPort || 19092);
      const args = buildSshArgs(cfg, localPort);
      if (tunnel) tunnel.kill('SIGTERM');
      tunnel = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      state.mode = 'ssh';
      state.workerUrl = `http://127.0.0.1:${localPort}`;
      state.resources = [
        {
          id: cfg.id || 'remote-gpu',
          name: cfg.name || `${cfg.host} GPU`,
          type: 'remote-ssh',
          host: cfg.host,
          status: 'connecting',
          workerUrl: state.workerUrl,
        },
      ];
      save();
      tunnel.once('error', (error) => {
        state.resources[0].status = 'offline';
        state.resources[0].error = error.message;
        save();
      });
      tunnel.once('spawn', () => {
        state.resources[0].status = 'online';
        save();
      });
      return json(res, 202, { ok: true, workerUrl: state.workerUrl, resource: state.resources[0] });
    }
    if (req.method === 'POST' && req.url === '/reverse') {
      // Reverse mode: the GPU machine runs an `ssh -R` back to the user's SSH
      // server, binding the user's loopback `forwardPort` into the GPU's
      // worker. The agent never opens a socket to the GPU, so the GPU needs no
      // inbound ports at all — the common case for cloud boxes that only
      // allow outbound connections.
      const cfg = await body(req);
      if (!validHost(cfg.host) || !validUser(cfg.user))
        return json(res, 400, { ok: false, error: 'invalid_reverse_configuration' });
      if (!validDialback(cfg.dialback))
        return json(res, 400, {
          ok: false,
          error: 'invalid_dialback',
          message: 'dialback must be an SSH target the GPU can reach, e.g. user@192.168.1.5',
        });
      const forwardPort = Number(cfg.forwardPort || 19092);
      if (!validPort(forwardPort) || forwardPort === port)
        return json(res, 400, { ok: false, error: 'invalid_forward_port' });
      const secret = randomSecret();
      if (tunnel) tunnel.kill('SIGTERM');
      state.forwardPort = forwardPort;
      state.mode = 'reverse';
      state.workerUrl = `http://127.0.0.1:${port}/pair/${secret}`;
      state.resources = [
        {
          id: cfg.id || 'remote-gpu-reverse',
          name: cfg.name || `${cfg.host} GPU（反向）`,
          type: 'remote-reverse',
          host: cfg.host,
          status: 'waiting-for-gpu',
          workerUrl: state.workerUrl,
        },
      ];
      save();
      return json(res, 202, {
        ok: true,
        workerUrl: state.workerUrl,
        resource: state.resources[0],
        // Run this ON the GPU machine. Once its tunnel connects, /pair-status
        // flips the resource online.
        gpuCommand: buildReverseTunnelCommand({ dialback: cfg.dialback, forwardPort }, secret),
      });
    }
    if (req.method === 'GET' && req.url === '/pair-status') {
      if (state.mode !== 'reverse')
        return json(res, 200, {
          ok: true,
          mode: state.mode,
          online: false,
          resource: state.resources[0] || null,
        });
      // Honest status: probe the reverse-forwarded endpoint instead of
      // trusting that a pair request once arrived.
      let online = false;
      try {
        const probe = await fetch(`http://127.0.0.1:${currentForwardPort()}/healthz`, {
          signal: AbortSignal.timeout(1_500),
        });
        online = probe.ok;
      } catch {
        online = false;
      }
      const resource = state.resources[0];
      if (resource) {
        resource.status = online ? 'online' : 'waiting-for-gpu';
        save();
      }
      return json(res, 200, { ok: true, mode: state.mode, online, resource: resource || null });
    }
    if (req.url?.startsWith('/pair/')) {
      // The pair URL is what the platform registers as the compute resource:
      // every request through it proxies into the reverse-forwarded worker
      // endpoint. The secret gates the pair; a wrong one is a plain 404.
      const secret = req.url.slice('/pair/'.length).split('/')[0].split('?')[0];
      if (!/^[a-f0-9]{32}$/.test(secret) || state.mode !== 'reverse')
        return json(res, 404, { ok: false, error: 'not_found' });
      return proxy(
        req,
        res,
        `http://127.0.0.1:${currentForwardPort()}`,
        (pathname) => pathname.replace(/^\/pair\/[a-f0-9]{32}/, '') || '/',
      );
    }
    if (req.url?.startsWith('/proxy')) return proxy(req, res, state.workerUrl);
    json(res, 404, { ok: false, error: 'not_found' });
  } catch (error) {
    json(res, 400, { ok: false, error: String(error.message || error) });
  }
});
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(port, '127.0.0.1', () =>
    console.log(`[rdk-local-gpu-agent] listening on http://127.0.0.1:${port}`),
  );
  process.on('SIGTERM', () => {
    tunnel?.kill('SIGTERM');
    server.close(() => process.exit(0));
  });
}
