import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const {
  buildReverseTunnelCommand,
  buildSshArgs,
  hostHeaderIsLoopback,
  normalizeWorkerUrl,
  originAllowed,
  parseAllowedOrigins,
  validDialback,
  validHost,
  validPort,
  validWorkerToken,
} = await import(`${here}/local-gpu-agent.mjs`);

// ---------- pure helpers ----------
assert.equal(validHost('gpu.example.com'), true);
const authKeyArgs = buildSshArgs(
  {
    host: '120.48.90.140',
    user: 'ssh-authkey-85102bb109ce51f46533cab9',
    sshPort: 2222,
    remotePort: 19091,
  },
  19092,
);
assert.deepEqual(authKeyArgs, [
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
  '2222',
  '-L',
  '127.0.0.1:19092:127.0.0.1:19091',
  'ssh-authkey-85102bb109ce51f46533cab9@120.48.90.140',
]);
assert.throws(
  () => buildSshArgs({ host: 'bad;host', user: 'u', sshPort: 22, remotePort: 1 }, 19092),
  /invalid/,
);
assert.equal(validDialback('robot@192.168.1.5'), true);
assert.equal(validDialback('192.168.1.5'), false);
assert.equal(validPort(0), false);
assert.equal(validPort(70000), false);

const secret = 'a'.repeat(32);
const gpuCommand = buildReverseTunnelCommand(
  { dialback: 'robot@192.168.1.5', forwardPort: 19092 },
  secret,
);
assert.match(gpuCommand, /^ssh -N -R 127\.0\.0\.1:19092:127\.0\.0\.1:19091 robot@192\.168\.1\.5/);
assert.ok(gpuCommand.includes(secret), 'pairing secret must ride in the command comment');
assert.throws(
  () => buildReverseTunnelCommand({ dialback: 'no-at', forwardPort: 19092 }, secret),
  /invalid/,
);

// ---------- origin allowlist ----------
const defaultEntries = parseAllowedOrigins('');
assert.deepEqual(defaultEntries, []);
const entries = parseAllowedOrigins(
  'https://lab.example.com, HTTP://Localhost , bad://x ,, http://gpu.lan:19091',
);
assert.deepEqual(entries, [
  { scheme: 'https', host: 'lab.example.com', port: '*' },
  { scheme: 'http', host: 'localhost', port: '*' },
  { scheme: 'http', host: 'gpu.lan', port: '19091' },
]);
const defaults = [
  { scheme: 'http', host: 'localhost', port: '*' },
  { scheme: 'http', host: '127.0.0.1', port: '*' },
];
assert.equal(originAllowed('http://localhost:5173', defaults), true);
assert.equal(originAllowed('http://127.0.0.1:3000', defaults), true);
assert.equal(originAllowed('https://evil.example.com', defaults), false);
assert.equal(originAllowed('http://localhost.evil.com', defaults), false);
assert.equal(originAllowed('http://sub.localhost', defaults), false);
assert.equal(originAllowed('https://lab.example.com', entries), true);
// A portless entry matches any port on that host (mirrors http://localhost).
assert.equal(originAllowed('https://lab.example.com:8443', entries), true);
assert.equal(originAllowed('http://gpu.lan:19091', entries), true);
assert.equal(originAllowed('http://gpu.lan:19092', entries), false);
assert.equal(originAllowed('not a url', defaults), false);
assert.equal(originAllowed('', defaults), false);
assert.equal(originAllowed('http://localhost:5173/some/path', defaults), false);

// ---------- host header gate ----------
assert.equal(hostHeaderIsLoopback('127.0.0.1:19190'), true);
assert.equal(hostHeaderIsLoopback('localhost:19190'), true);
assert.equal(hostHeaderIsLoopback('[::1]:19190'), true);
assert.equal(hostHeaderIsLoopback('127.0.0.1'), true);
assert.equal(hostHeaderIsLoopback('evil.example.com:19190'), false);
assert.equal(hostHeaderIsLoopback('sub.localhost:19190'), false);
assert.equal(hostHeaderIsLoopback(undefined), false);

// ---------- worker url / token validation ----------
assert.equal(normalizeWorkerUrl('http://127.0.0.1:19091'), 'http://127.0.0.1:19091');
assert.equal(normalizeWorkerUrl('http://127.0.0.1:19091/'), 'http://127.0.0.1:19091');
assert.equal(normalizeWorkerUrl('http://gpu.lan:19091'), 'http://gpu.lan:19091');
assert.throws(() => normalizeWorkerUrl('http://127.0.0.1:19091/train'), /path/);
assert.throws(() => normalizeWorkerUrl('http://127.0.0.1:19091/?q=1'), /query/);
assert.throws(() => normalizeWorkerUrl('http://user:pass@127.0.0.1:19091'), /credentials/);
assert.throws(() => normalizeWorkerUrl('ftp://127.0.0.1'), /http/);
assert.throws(() => normalizeWorkerUrl('not a url'), /valid URL/);

assert.equal(validWorkerToken('t'.repeat(48)), true);
assert.equal(validWorkerToken(''), false);
assert.equal(validWorkerToken('has space'), false);
assert.equal(validWorkerToken('line\nbreak'), false);
assert.equal(validWorkerToken('x'.repeat(4097)), false);

// ---------- live browser-relay round trip (direct mode) ----------
// A fake worker stands in for the GPU machine. The test drives the agent the
// way a browser would: with an Origin header, preflighted headers, and no
// Authorization of its own (the agent must inject the stored token).
const RUNNER_TOKEN = 'k'.repeat(48);
const allowedOrigin = 'http://localhost:9999';
const evilOrigin = 'https://evil.example.com';

const seen = { headers: null, body: null, count: 0 };
const artifactBytes = Buffer.from([0x08, 0x06, 0x07, 0x05, 0x03, 0x00, 0x09, 0x09]);
const artifactSha = createHash('sha256').update(artifactBytes).digest('hex');
const worker = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  seen.count += 1;
  seen.headers = req.headers;
  seen.body = Buffer.concat(chunks);
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(
      JSON.stringify({ ok: true, worker: 'sim2real-local', engines: ['default'], cuda: true }),
    );
  }
  if (req.method === 'POST' && req.url === '/train') {
    res.writeHead(202, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ runId: 'local-relay-1', status: 'queued' }));
  }
  if (req.method === 'GET' && req.url === '/runs/local-relay-1') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(
      JSON.stringify({ runId: 'local-relay-1', status: 'running', progress: [{ iteration: 1 }] }),
    );
  }
  if (req.method === 'GET' && req.url === '/runs/local-relay-1/artifact') {
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(artifactBytes.length),
      'x-artifact-sha256': artifactSha,
      'x-artifact-bytes': String(artifactBytes.length),
      'cache-control': 'no-store',
    });
    return res.end(artifactBytes);
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false }));
});
await once(worker.listen(0, '127.0.0.1'), 'listening');
const workerPort = worker.address().port;

function spawnAgent(home) {
  const agentPort = 19190 + (process.pid % 500);
  const child = spawn(process.execPath, [`${here}/local-gpu-agent.mjs`], {
    env: { ...process.env, RDK_GPU_AGENT_PORT: String(agentPort), RDK_GPU_AGENT_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { child, agentPort };
}
async function eventually(fn, label) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await fn();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`timed out: ${label}`);
}

const home = mkdtempSync(path.join(tmpdir(), 'rdk-gpu-agent-test-'));
const { child: agent, agentPort } = spawnAgent(home);
await once(agent, 'spawn');
const agentBase = `http://127.0.0.1:${agentPort}`;

// Healthz stays open for discovery from any origin, reports the caller's
// allowlist verdict, and never leaks the worker URL/host or the token.
const evilHealthResponse = await eventually(
  () => fetch(`${agentBase}/healthz`, { headers: { origin: evilOrigin } }),
  'agent healthz from foreign origin',
);
assert.equal(evilHealthResponse.status, 200);
assert.equal(evilHealthResponse.headers.get('access-control-allow-origin'), '*');
const evilHealth = await evilHealthResponse.json();
assert.equal(evilHealth.agent, 'rdk-local-gpu-agent');
assert.equal(evilHealth.originAllowed, false);
assert.equal(evilHealth.tokenConfigured, false);
assert.equal(evilHealth.workerUrl, undefined);
assert.equal(JSON.stringify(evilHealth).includes(RUNNER_TOKEN), false);

// The relay endpoints refuse foreign origins — 403 with no CORS headers, so
// a browser blocks both the preflight and the actual request.
const evilProxy = await fetch(`${agentBase}/proxy/healthz`, { headers: { origin: evilOrigin } });
assert.equal(evilProxy.status, 403);
assert.equal(evilProxy.headers.get('access-control-allow-origin'), null);
const evilPreflight = await fetch(`${agentBase}/proxy/train`, {
  method: 'OPTIONS',
  headers: { origin: evilOrigin, 'access-control-request-method': 'POST' },
});
assert.equal(evilPreflight.status, 403);
assert.equal(evilPreflight.headers.get('access-control-allow-origin'), null);
const evilConfig = await fetch(`${agentBase}/config`, {
  method: 'POST',
  headers: { origin: evilOrigin, 'content-type': 'application/json' },
  body: JSON.stringify({ workerUrl: 'http://127.0.0.1:9' }),
});
assert.equal(evilConfig.status, 403);

// Non-loopback Host headers (DNS rebinding) are refused outright.
const rebinding = await new Promise((resolve, reject) => {
  const req = httpRequest(
    { host: '127.0.0.1', port: agentPort, path: '/healthz', method: 'GET' },
    (res) => {
      let text = '';
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: text }));
    },
  );
  req.setHeader('Host', 'evil.example.com');
  req.on('error', reject);
  req.end();
});
assert.equal(rebinding.status, 403);
assert.match(rebinding.body, /agent_host_forbidden/);

// An allowlisted origin passes preflight with the full relay header set.
const preflight = await fetch(`${agentBase}/proxy/train`, {
  method: 'OPTIONS',
  headers: {
    origin: allowedOrigin,
    'access-control-request-method': 'POST',
    'access-control-request-headers': 'content-type,x-sim2real-account,idempotency-key',
  },
});
assert.equal(preflight.status, 204);
assert.equal(preflight.headers.get('access-control-allow-origin'), allowedOrigin);
assert.match(preflight.headers.get('access-control-allow-headers') || '', /x-sim2real-account/);
assert.match(preflight.headers.get('access-control-allow-headers') || '', /idempotency-key/);

// Configure the direct-mode worker + token through /config (browser flow).
const configured = await fetch(`${agentBase}/config`, {
  method: 'POST',
  headers: { origin: allowedOrigin, 'content-type': 'application/json' },
  body: JSON.stringify({
    workerUrl: `http://127.0.0.1:${workerPort}`,
    workerToken: RUNNER_TOKEN,
    name: '测试 GPU',
  }),
}).then((r) => {
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), allowedOrigin);
  return r.json();
});
assert.equal(configured.ok, true);
assert.equal(configured.mode, 'local');
assert.equal(configured.tokenConfigured, true);
assert.equal(JSON.stringify(configured).includes(RUNNER_TOKEN), false);
assert.equal(JSON.stringify(configured).includes(RUNNER_TOKEN.slice(0, 12)), false);

// Bad worker URLs are rejected without mutating state.
const badUrl = await fetch(`${agentBase}/config`, {
  method: 'POST',
  headers: { origin: allowedOrigin, 'content-type': 'application/json' },
  body: JSON.stringify({ workerUrl: 'http://127.0.0.1:1/train' }),
});
assert.equal(badUrl.status, 400);
const badToken = await fetch(`${agentBase}/config`, {
  method: 'POST',
  headers: { origin: allowedOrigin, 'content-type': 'application/json' },
  body: JSON.stringify({ workerToken: 'has space' }),
});
assert.equal(badToken.status, 400);

// Token injection: the browser sends no Authorization; the agent adds the
// stored bearer before reaching the worker.
const relayHealth = await fetch(`${agentBase}/proxy/healthz`, {
  headers: { origin: allowedOrigin },
}).then((r) => {
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), allowedOrigin);
  assert.match(r.headers.get('access-control-expose-headers') || '', /x-artifact-sha256/);
  return r.json();
});
assert.deepEqual(relayHealth, {
  ok: true,
  worker: 'sim2real-local',
  engines: ['default'],
  cuda: true,
});
assert.equal(seen.headers.authorization, `Bearer ${RUNNER_TOKEN}`);

// Train submission: relay headers ride through and the body bytes are passed
// untouched (no re-serialization).
const trainBody = JSON.stringify({
  schemaVersion: 1,
  accountId: 'acct-1',
  model: { modelId: 'microduck-policy-v1' },
  training: { profile: 'smoke' },
});
const submitted = await fetch(`${agentBase}/proxy/train`, {
  method: 'POST',
  headers: {
    origin: allowedOrigin,
    'content-type': 'application/json',
    'idempotency-key': 'run-key-1',
    'x-sim2real-account': 'acct-1',
  },
  body: trainBody,
}).then((r) => {
  assert.equal(r.status, 202);
  assert.equal(r.headers.get('access-control-allow-origin'), allowedOrigin);
  return r.json();
});
assert.deepEqual(submitted, { runId: 'local-relay-1', status: 'queued' });
assert.equal(seen.headers.authorization, `Bearer ${RUNNER_TOKEN}`);
assert.equal(seen.headers['idempotency-key'], 'run-key-1');
assert.equal(seen.headers['x-sim2real-account'], 'acct-1');
assert.equal(seen.headers['content-type'], 'application/json');
assert.equal(seen.body.toString(), trainBody);

// Status polling through the proxy.
const status = await fetch(`${agentBase}/proxy/runs/local-relay-1`, {
  headers: { origin: allowedOrigin },
}).then((r) => r.json());
assert.equal(status.status, 'running');

// Artifact download: bytes stream through unchanged, the digest headers stay
// readable, and content-length is preserved.
const artifact = await fetch(`${agentBase}/proxy/runs/local-relay-1/artifact`, {
  headers: { origin: allowedOrigin },
});
assert.equal(artifact.status, 200);
assert.equal(artifact.headers.get('content-type'), 'application/octet-stream');
assert.equal(artifact.headers.get('content-length'), String(artifactBytes.length));
assert.equal(artifact.headers.get('x-artifact-sha256'), artifactSha);
assert.equal(artifact.headers.get('x-artifact-bytes'), String(artifactBytes.length));
assert.deepEqual(Buffer.from(await artifact.arrayBuffer()), artifactBytes);

// A browser-sent Authorization still wins over the stored token (explicit
// passthrough keeps the reverse-pair contract intact).
const authed = await fetch(`${agentBase}/proxy/healthz`, {
  headers: { origin: allowedOrigin, authorization: 'Bearer runner-token' },
}).then((r) => r.json());
assert.equal(authed.ok, true);
assert.equal(seen.headers.authorization, 'Bearer runner-token');

// Oversized bodies are rejected before the upstream is touched.
const oversized = await fetch(`${agentBase}/proxy/train`, {
  method: 'POST',
  headers: { origin: allowedOrigin, 'content-type': 'application/json' },
  body: 'x'.repeat(5 * 1024 * 1024),
});
assert.equal(oversized.status, 413);

// An unreachable upstream maps to a clean 502 (never a hang, never a crash).
await fetch(`${agentBase}/config`, {
  method: 'POST',
  headers: { origin: allowedOrigin, 'content-type': 'application/json' },
  body: JSON.stringify({ workerUrl: 'http://127.0.0.1:9' }),
});
const unreachable = await fetch(`${agentBase}/proxy/healthz`, {
  headers: { origin: allowedOrigin },
});
assert.equal(unreachable.status, 502);
assert.equal((await unreachable.json()).error, 'agent_upstream_unreachable');
await fetch(`${agentBase}/config`, {
  method: 'POST',
  headers: { origin: allowedOrigin, 'content-type': 'application/json' },
  body: JSON.stringify({ workerUrl: `http://127.0.0.1:${workerPort}` }),
});

// Token and worker URL survive a restart (same home directory).
agent.kill('SIGTERM');
await once(agent, 'exit');
const { child: agent1 } = spawnAgent(home);
await once(agent1, 'spawn');
const resumedHealth = await eventually(
  () => fetch(`${agentBase}/healthz`),
  'agent restart healthz',
).then((r) => {
  assert.equal(r.status, 200);
  return r.json();
});
assert.equal(resumedHealth.tokenConfigured, true);
assert.equal(resumedHealth.mode, 'local');
await fetch(`${agentBase}/proxy/healthz`, { headers: { origin: allowedOrigin } });
assert.equal(seen.headers.authorization, `Bearer ${RUNNER_TOKEN}`);

// Clearing the token stops injection.
await fetch(`${agentBase}/config`, {
  method: 'POST',
  headers: { origin: allowedOrigin, 'content-type': 'application/json' },
  body: JSON.stringify({ workerToken: '' }),
});
const cleared = await fetch(`${agentBase}/healthz`).then((r) => r.json());
assert.equal(cleared.tokenConfigured, false);
await fetch(`${agentBase}/proxy/healthz`, { headers: { origin: allowedOrigin } });
assert.equal(seen.headers.authorization, undefined);
agent1.kill('SIGTERM');
await once(agent1, 'exit');

// ---------- live reverse-mode round trip ----------
// Simulate the whole topology without ssh: a fake "GPU worker" HTTP server,
// a fake "GPU ssh -R" forwarder (just an HTTP proxy onto the worker), and the
// real agent process. The pair endpoint must proxy into the forwarder and
// rewrite the /pair/<secret> prefix away.
let workerHits = 0;
const reverseWorker = createServer((req, res) => {
  workerHits += 1;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, seenPath: req.url }));
});

const forwarder = createServer(async (req, res) => {
  // Stands in for `ssh -R 127.0.0.1:19092:127.0.0.1:19091` on the GPU side.
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const upstream = await fetch(`http://127.0.0.1:${reverseWorker.address().port}${req.url}`, {
    method: req.method,
    headers: { authorization: String(req.headers.authorization || '') },
    body: req.method === 'GET' ? undefined : Buffer.concat(chunks),
  });
  res.writeHead(upstream.status, {
    'content-type': String(upstream.headers.get('content-type')),
  });
  res.end(Buffer.from(await upstream.arrayBuffer()));
});

await once(reverseWorker.listen(0, '127.0.0.1'), 'listening');
await once(forwarder.listen(19092, '127.0.0.1'), 'listening');

const home2 = mkdtempSync(path.join(tmpdir(), 'rdk-gpu-agent-reverse-'));
const { child: agent2, agentPort: agent2Port } = spawnAgent(home2);
await once(agent2, 'spawn');
const agent2Base = `http://127.0.0.1:${agent2Port}`;

const health2 = await eventually(
  () => fetch(`${agent2Base}/healthz`),
  'reverse agent healthz',
).then((r) => {
  assert.equal(r.status, 200);
  return r.json();
});
assert.equal(health2.agent, 'rdk-local-gpu-agent');

// Register the reverse pair: the GPU machine is told to dial back to the
// user's SSH server; the returned worker URL is what the page registers.
const pair = await fetch(`${agent2Base}/reverse`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    host: 'gpu.example.com',
    user: 'robot',
    dialback: 'robot@127.0.0.1',
    forwardPort: 19092,
  }),
}).then((r) => {
  assert.equal(r.status, 202);
  return r.json();
});
assert.equal(pair.ok, true);
assert.match(
  pair.workerUrl,
  new RegExp(`^http://127\\.0\\.0\\.1:${agent2Port}/pair/[a-f0-9]{32}$`),
);
assert.match(pair.gpuCommand, /ssh -N -R 127\.0\.0\.1:19092:127\.0\.0\.1:19091/);

// Before the GPU dials in, status must stay honest: the forwarder IS up in
// this simulation, so online=true through the probe; verify the probe path.
const status2 = await fetch(`${agent2Base}/pair-status`).then((r) => r.json());
assert.equal(status2.mode, 'reverse');
assert.equal(status2.online, true);
assert.equal(status2.resource.status, 'online');

// The pair URL proxies into the forwarded worker with the prefix stripped:
// GET /pair/<secret>/healthz must hit the worker as /healthz.
const viaPair = await fetch(`${pair.workerUrl}/healthz`).then((r) => {
  assert.equal(r.status, 200);
  return r.json();
});
assert.deepEqual(viaPair, { ok: true, seenPath: '/healthz' });
assert.ok(workerHits >= 1, 'worker must have been reached through the pair');

// Authorization headers ride through the pair (the runner token).
const authedPair = await fetch(`${pair.workerUrl}/train`, {
  method: 'POST',
  headers: { authorization: 'Bearer runner-token', 'content-type': 'application/json' },
  body: JSON.stringify({ manifest: {} }),
}).then((r) => r.json());
assert.equal(authedPair.ok, true);
assert.equal(authedPair.seenPath, '/train');
assert.ok(workerHits >= 2);

// A malformed secret is a plain 404 with no oracle beyond not_found. (A
// format-valid but unregistered secret is NOT a 404: the pair path is only a
// loopback key — anyone holding the URL is already on the user's machine.)
const wrong = await fetch(`${agent2Base}/pair/${'z'.repeat(32)}/healthz`);
assert.equal(wrong.status, 404);

// Pair state survives an agent restart (same home): the same worker URL
// (recomputed from the persisted forwardPort) keeps proxying.
agent2.kill('SIGTERM');
await once(agent2, 'exit');
const { child: agent3 } = spawnAgent(home2);
await once(agent3, 'spawn');
const resumed2 = await eventually(
  () =>
    fetch(`${agent2Base}/pair-status`).then((r) => {
      assert.equal(r.status, 200);
      return r.json();
    }),
  'agent restart pair-status',
);
assert.equal(resumed2.mode, 'reverse');
assert.equal(resumed2.online, true);
agent3.kill('SIGTERM');
await once(agent3, 'exit');

// ---------- cleanup ----------
forwarder.close();
worker.close();
reverseWorker.close();
rmSync(home, { recursive: true, force: true });
rmSync(home2, { recursive: true, force: true });
console.log('local-gpu-agent: all tests passed');
