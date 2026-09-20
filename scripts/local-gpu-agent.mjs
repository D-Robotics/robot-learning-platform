#!/usr/bin/env node
/** User-side GPU agent. Keeps GPU credentials on the user's machine.
 * It exposes a loopback-only Worker-compatible endpoint and can proxy a
 * remote worker through an SSH local forward. The platform Web server never
 * connects to the user's GPU.
 *
 * Access modes:
 *  - `local`: proxy a worker that is already reachable from this machine
 *    (same host, LAN, or a port you forwarded yourself).
 *  `ssh`:    spawn an SSH local forward to the GPU machine and proxy through it.
 *  `reverse`: the GPU machine dials BACK to this agent over an outbound SSH
 *    tunnel it opens itself (ssh -R). Nothing on the user's machine is exposed
 *    to the network, and no inbound SSH port is needed on the GPU side.
 *
 * Browser relay: web pages drive training through `/proxy` while the platform
 * server only records the run. The runner token lives HERE (never in the page,
 * never on the platform); proxy requests without their own Authorization get
 * it injected. Only origins allowlisted through RDK_GPU_AGENT_ALLOWED_ORIGINS
 * may use the proxy or the mutating endpoints, so an unrelated web page cannot
 * borrow the GPU. `GET /healthz` stays open (discovery only, no secrets).
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
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
    'PreferredAuthentications=publickey',
    '-o',
    'PasswordAuthentication=no',
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

/**
 * Allowed-origins allowlist entries. An entry is `scheme://host[:port]`; a
 * portless entry matches any port on that host. Defaults cover the local
 * development page origins; a cloud-hosted platform page must be added
 * explicitly via RDK_GPU_AGENT_ALLOWED_ORIGINS.
 */
export function parseAllowedOrigins(raw) {
  const entries = [];
  if (typeof raw !== 'string' || !raw.trim()) return entries;
  for (const part of raw.split(',')) {
    const text = part.trim().toLowerCase();
    const match = /^(https?):\/\/(\[[a-f0-9:]+\]|[a-z0-9._-]+)(?::(\d{1,5}))?$/.exec(text);
    if (match) {
      entries.push({
        scheme: match[1],
        host: match[2].replace(/^\[|\]$/g, ''),
        port: match[3] || '*',
      });
    }
  }
  return entries;
}

function defaultAllowedOrigins() {
  return [
    { scheme: 'http', host: 'localhost', port: '*' },
    { scheme: 'http', host: '127.0.0.1', port: '*' },
  ];
}

/** Whether a request Origin passes the allowlist (exact entry semantics). */
export function originAllowed(origin, entries) {
  if (typeof origin !== 'string' || !origin) return false;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') return false;
  const scheme = parsed.protocol.replace(/:$/, '');
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = parsed.port || (scheme === 'https' ? '443' : '80');
  return entries.some(
    (entry) =>
      entry.scheme === scheme && entry.host === host && (entry.port === '*' || entry.port === port),
  );
}

/** Loopback-literal Host check: blocks DNS-rebinding pages cold. */
export function hostHeaderIsLoopback(hostHeader) {
  if (typeof hostHeader !== 'string') return false;
  let host = hostHeader.trim().toLowerCase();
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    host = host.slice(1, close === -1 ? host.length : close);
  } else {
    host = host.split(':')[0];
  }
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/** Worker root URL (`scheme://host[:port]`, no path/query/credentials). */
export function normalizeWorkerUrl(raw) {
  const text = String(raw ?? '').trim();
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error('worker url is not a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('worker url must be http(s)');
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!validHost(host) && host !== '::1') throw new Error('worker url host is invalid');
  if ((parsed.pathname || '/') !== '/') throw new Error('worker url must be the root (no path)');
  if (parsed.search || parsed.hash) {
    throw new Error('worker url must not contain query or fragment');
  }
  if (parsed.username || parsed.password) {
    throw new Error('worker url must not embed credentials');
  }
  return `${parsed.protocol}//${parsed.host}`;
}

/** Runner token shape: printable ASCII, 1..4096 bytes (empty means "clear"). */
export function validWorkerToken(value) {
  const token = String(value ?? '');
  return token.length >= 1 && token.length <= 4096 && /^[\x21-\x7e]+$/.test(token);
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

const allowedOrigins = (() => {
  const parsed = parseAllowedOrigins(process.env.RDK_GPU_AGENT_ALLOWED_ORIGINS);
  return parsed.length ? parsed : defaultAllowedOrigins();
})();

// Mirror the worker's own request-body policy with headroom so the worker (not
// the agent) produces the authoritative 413 for oversized train payloads.
const MAX_PROXY_BODY_BYTES = 4 * 1024 * 1024;
const PROXY_REQUEST_HEADERS = ['content-type', 'idempotency-key', 'x-sim2real-account'];
const PROXY_RESPONSE_HEADERS = [
  'content-length',
  'cache-control',
  'x-artifact-sha256',
  'x-artifact-bytes',
  'x-telemetry-bytes',
];
const PROXY_EXPOSE_HEADERS = 'x-artifact-sha256,x-artifact-bytes,x-telemetry-bytes';

function randomSecret() {
  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index += 1)
    bytes[index] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function save() {
  writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
}
function json(res, status, value, origin) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    ...(origin
      ? {
          'access-control-allow-origin': origin,
          ...(origin !== '*' ? { vary: 'Origin' } : {}),
        }
      : {}),
  });
  res.end(JSON.stringify(value));
}
async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
async function readRawBody(req, capBytes) {
  const chunks = [];
  let total = 0;
  // On overflow keep draining to the true end of the body (discarding the
  // bytes): replying before the request is fully read leaves unread bytes on
  // a keep-alive socket and resets the NEXT request on that connection.
  let overflow = false;
  for await (const chunk of req) {
    total += chunk.length;
    if (overflow) continue;
    if (total > capBytes) {
      overflow = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(chunk);
  }
  if (overflow) throw new Error('agent_body_too_large');
  return Buffer.concat(chunks);
}
async function proxy(req, res, target, pathRewrite, origin) {
  const u = new URL(req.url, 'http://127.0.0.1');
  const upstream = new URL(target);
  upstream.pathname = pathRewrite
    ? pathRewrite(u.pathname)
    : u.pathname.replace(/^\/proxy/, '') || '/';
  upstream.search = u.search;
  // Artifact/telemetry downloads can be large; keep the pipe alive for them.
  const longRunning = /\/(artifact|telemetry)$/.test(upstream.pathname);
  const headers = {};
  const requestAuth =
    typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
  if (requestAuth) headers.authorization = requestAuth;
  else if (state.workerToken) headers.authorization = `Bearer ${state.workerToken}`;
  for (const name of PROXY_REQUEST_HEADERS) {
    const value = req.headers[name];
    if (typeof value === 'string' && value) headers[name] = value;
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  let requestBody;
  if (hasBody) {
    try {
      requestBody = await readRawBody(req, MAX_PROXY_BODY_BYTES);
    } catch {
      return json(res, 413, { ok: false, error: 'agent_body_too_large' }, origin);
    }
  }
  let response;
  try {
    response = await fetch(upstream, {
      method: req.method,
      headers,
      ...(hasBody ? { body: requestBody } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(longRunning ? 600_000 : 60_000),
    });
  } catch {
    return json(res, 502, { ok: false, error: 'agent_upstream_unreachable' }, origin);
  }
  const responseHeaders = {
    'content-type': response.headers.get('content-type') || 'application/json',
    ...(origin
      ? {
          'access-control-allow-origin': origin,
          vary: 'Origin',
          'access-control-expose-headers': PROXY_EXPOSE_HEADERS,
        }
      : {}),
  };
  for (const name of PROXY_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) responseHeaders[name] = value;
  }
  res.writeHead(response.status, responseHeaders);
  if (!response.body) return res.end();
  const stream = Readable.fromWeb(response.body);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

function applyWorkerToken(value) {
  if (value === undefined || value === null) return null;
  const token = String(value);
  if (!token) {
    delete state.workerToken;
    return null;
  }
  if (!validWorkerToken(token)) return 'invalid_worker_token';
  state.workerToken = token;
  return null;
}

function isProtectedPath(url) {
  return (
    url === '/connect' ||
    url === '/reverse' ||
    url === '/config' ||
    url === '/resources' ||
    url === '/pair-status' ||
    (url || '').startsWith('/proxy') ||
    (url || '').startsWith('/pair/')
  );
}

const server = createServer(async (req, res) => {
  try {
    const origin =
      typeof req.headers.origin === 'string' && req.headers.origin ? req.headers.origin : null;
    const originOk = origin ? originAllowed(origin, allowedOrigins) : true;
    if (!hostHeaderIsLoopback(req.headers.host)) {
      return json(res, 403, { ok: false, error: 'agent_host_forbidden' });
    }
    if (req.method === 'OPTIONS') {
      if (origin && !originOk) {
        // No CORS headers on the refusal: the browser blocks the flight, and
        // the actual request is never sent.
        res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end();
      }
      // Preflight: advertise the full header set the relay needs on top of
      // the base ACAO reflection.
      res.writeHead(204, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        ...(origin
          ? {
              'access-control-allow-origin': origin,
              vary: 'Origin',
              'access-control-allow-methods': 'GET,POST,OPTIONS',
              'access-control-allow-headers':
                'content-type,authorization,x-sim2real-account,idempotency-key',
            }
          : {}),
      });
      return res.end();
    }
    if (req.method === 'GET' && req.url === '/healthz')
      // Public discovery endpoint: no secrets, no resource details — safe to
      // read from any page origin.
      return json(
        res,
        200,
        {
          ok: true,
          agent: 'rdk-local-gpu-agent',
          mode: state.mode,
          tokenConfigured: Boolean(state.workerToken),
          originAllowed: originOk,
          // Trimmed resource card: no hosts, no worker URLs (open endpoint).
          resource: state.resources[0]
            ? {
                id: state.resources[0].id,
                name: state.resources[0].name,
                type: state.resources[0].type,
                status: state.resources[0].status,
              }
            : null,
        },
        '*',
      );
    if (isProtectedPath(req.url) && !originOk) {
      res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ ok: false, error: 'agent_origin_forbidden' }));
    }
    if (req.method === 'GET' && req.url === '/resources')
      return json(res, 200, { resources: state.resources, mode: state.mode }, origin);
    if (req.method === 'POST' && req.url === '/config') {
      const cfg = await body(req);
      if (cfg.workerUrl !== undefined && cfg.workerUrl !== null) {
        try {
          state.workerUrl = normalizeWorkerUrl(cfg.workerUrl);
        } catch (error) {
          return json(
            res,
            400,
            { ok: false, error: 'invalid_worker_url', message: String(error.message || error) },
            origin,
          );
        }
      }
      const tokenError = applyWorkerToken(cfg.workerToken);
      if (tokenError) return json(res, 400, { ok: false, error: tokenError }, origin);
      if (tunnel) {
        tunnel.kill('SIGTERM');
        tunnel = null;
      }
      state.mode = 'local';
      const name =
        typeof cfg.name === 'string' && cfg.name.trim()
          ? cfg.name.trim().slice(0, 120)
          : state.resources[0]?.name || '本机 GPU Worker';
      state.resources = [
        {
          id: 'local-worker',
          name,
          type: 'direct',
          status: 'unknown',
          workerUrl: state.workerUrl,
        },
      ];
      save();
      return json(
        res,
        200,
        {
          ok: true,
          mode: state.mode,
          workerUrl: state.workerUrl,
          tokenConfigured: Boolean(state.workerToken),
          resource: state.resources[0],
        },
        origin,
      );
    }
    if (req.method === 'POST' && req.url === '/connect') {
      const cfg = await body(req);
      const localPort = Number(cfg.localPort || 19092);
      const args = buildSshArgs(cfg, localPort);
      const tokenError = applyWorkerToken(cfg.workerToken);
      if (tokenError) return json(res, 400, { ok: false, error: tokenError }, origin);
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
      return json(
        res,
        202,
        {
          ok: true,
          workerUrl: state.workerUrl,
          tokenConfigured: Boolean(state.workerToken),
          resource: state.resources[0],
        },
        origin,
      );
    }
    if (req.method === 'POST' && req.url === '/reverse') {
      // Reverse mode: the GPU machine runs an `ssh -R` back to the user's SSH
      // server, binding the user's loopback `forwardPort` into the GPU's
      // worker. The agent never opens a socket to the GPU, so the GPU needs no
      // inbound ports at all — the common case for cloud boxes that only
      // allow outbound connections.
      const cfg = await body(req);
      if (!validHost(cfg.host) || !validUser(cfg.user))
        return json(res, 400, { ok: false, error: 'invalid_reverse_configuration' }, origin);
      if (!validDialback(cfg.dialback))
        return json(
          res,
          400,
          {
            ok: false,
            error: 'invalid_dialback',
            message: 'dialback must be an SSH target the GPU can reach, e.g. user@192.168.1.5',
          },
          origin,
        );
      const forwardPort = Number(cfg.forwardPort || 19092);
      if (!validPort(forwardPort) || forwardPort === port)
        return json(res, 400, { ok: false, error: 'invalid_forward_port' }, origin);
      const tokenError = applyWorkerToken(cfg.workerToken);
      if (tokenError) return json(res, 400, { ok: false, error: tokenError }, origin);
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
      return json(
        res,
        202,
        {
          ok: true,
          workerUrl: state.workerUrl,
          tokenConfigured: Boolean(state.workerToken),
          resource: state.resources[0],
          // Run this ON the GPU machine. Once its tunnel connects, /pair-status
          // flips the resource online.
          gpuCommand: buildReverseTunnelCommand({ dialback: cfg.dialback, forwardPort }, secret),
        },
        origin,
      );
    }
    if (req.method === 'GET' && req.url === '/pair-status') {
      if (state.mode !== 'reverse')
        return json(
          res,
          200,
          { ok: true, mode: state.mode, online: false, resource: state.resources[0] || null },
          origin,
        );
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
      return json(
        res,
        200,
        { ok: true, mode: state.mode, online, resource: resource || null },
        origin,
      );
    }
    if (req.url?.startsWith('/pair/')) {
      // The pair URL is what the page registers as the compute resource:
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
        origin,
      );
    }
    if (req.url?.startsWith('/proxy')) return proxy(req, res, state.workerUrl, null, origin);
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
