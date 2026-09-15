#!/usr/bin/env node
/** User-side GPU agent. Keeps GPU credentials on the user's machine.
 * It exposes a loopback-only Worker-compatible endpoint and can proxy a
 * remote worker through an SSH local forward. The platform Web server never
 * connects to the user's GPU.
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

const port = Number(process.env.RDK_GPU_AGENT_PORT || 19190);
const stateDir = process.env.RDK_GPU_AGENT_HOME || path.join(os.homedir(), '.rdk-lab');
const stateFile = path.join(stateDir, 'agent.json');
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const state = existsSync(stateFile)
  ? JSON.parse(readFileSync(stateFile, 'utf8'))
  : { mode: 'local', workerUrl: 'http://127.0.0.1:19091', resources: [] };
let tunnel;

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
async function proxy(req, res, target) {
  const u = new URL(req.url, 'http://127.0.0.1');
  const upstream = new URL(target);
  upstream.pathname = u.pathname.replace(/^\/proxy/, '') || '/';
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
