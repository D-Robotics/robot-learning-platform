import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { buildReverseTunnelCommand, buildSshArgs, validDialback, validHost, validPort } =
  await import(`${here}/local-gpu-agent.mjs`);

// ---------- pure helpers ----------
assert.equal(validHost('gpu.example.com'), true);
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

// ---------- live reverse-mode round trip ----------
// Simulate the whole topology without ssh: a fake "GPU worker" HTTP server,
// a fake "GPU ssh -R" forwarder (just an HTTP proxy onto the worker), and the
// real agent process. The pair endpoint must proxy into the forwarder and
// rewrite the /pair/<secret> prefix away.
let workerHits = 0;
const worker = createServer((req, res) => {
  workerHits += 1;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, seenPath: req.url }));
});

const forwarder = createServer(async (req, res) => {
  // Stands in for `ssh -R 127.0.0.1:19092:127.0.0.1:19091` on the GPU side.
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const upstream = await fetch(`http://127.0.0.1:${worker.address().port}${req.url}`, {
    method: req.method,
    headers: { authorization: String(req.headers.authorization || '') },
    body: req.method === 'GET' ? undefined : Buffer.concat(chunks),
  });
  res.writeHead(upstream.status, { 'content-type': String(upstream.headers.get('content-type')) });
  res.end(Buffer.from(await upstream.arrayBuffer()));
});

await once(worker.listen(0, '127.0.0.1'), 'listening');
await once(forwarder.listen(19092, '127.0.0.1'), 'listening');

const home = mkdtempSync(path.join(tmpdir(), 'rdk-gpu-agent-test-'));
const agentPort = 19190 + (process.pid % 500);
const agent = spawn(process.execPath, [`${here}/local-gpu-agent.mjs`], {
  env: { ...process.env, RDK_GPU_AGENT_PORT: String(agentPort), RDK_GPU_AGENT_HOME: home },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await once(agent, 'spawn');
// Give the loopback listener a moment, then wait on demand.
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
const agentBase = `http://127.0.0.1:${agentPort}`;
const health = await eventually(
  () =>
    fetch(`${agentBase}/healthz`).then((r) => {
      assert.equal(r.status, 200);
      return r.json();
    }),
  'agent healthz',
);
assert.equal(health.agent, 'rdk-local-gpu-agent');

// Register the reverse pair: the GPU machine is told to dial back to the
// user's SSH server; the returned worker URL is what the platform registers.
const pair = await fetch(`${agentBase}/reverse`, {
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
assert.match(pair.workerUrl, new RegExp(`^http://127\\.0\\.0\\.1:${agentPort}/pair/[a-f0-9]{32}$`));
assert.match(pair.gpuCommand, /ssh -N -R 127\.0\.0\.1:19092:127\.0\.0\.1:19091/);

// Before the GPU dials in, status must stay honest: the forwarder IS up in
// this simulation, so online=true through the probe; verify the probe path.
const status = await fetch(`${agentBase}/pair-status`).then((r) => r.json());
assert.equal(status.mode, 'reverse');
assert.equal(status.online, true);
assert.equal(status.resource.status, 'online');

// The pair URL proxies into the forwarded worker with the prefix stripped:
// GET /pair/<secret>/healthz must hit the worker as /healthz.
const viaPair = await fetch(`${pair.workerUrl}/healthz`).then((r) => {
  assert.equal(r.status, 200);
  return r.json();
});
assert.deepEqual(viaPair, { ok: true, seenPath: '/healthz' });
assert.ok(workerHits >= 1, 'worker must have been reached through the pair');

// Authorization headers ride through the pair (the runner token).
const authed = await fetch(`${pair.workerUrl}/train`, {
  method: 'POST',
  headers: { authorization: 'Bearer runner-token', 'content-type': 'application/json' },
  body: JSON.stringify({ manifest: {} }),
}).then((r) => r.json());
assert.equal(authed.ok, true);
assert.equal(authed.seenPath, '/train');
assert.ok(workerHits >= 2);

// A malformed secret is a plain 404 with no oracle beyond not_found. (A
// format-valid but unregistered secret is NOT a 404: the pair path is only a
// loopback key — anyone holding the URL is already on the user's machine.)
const wrong = await fetch(`${agentBase}/pair/${'z'.repeat(32)}/healthz`);
assert.equal(wrong.status, 404);

// Pair state survives an agent restart (same home): the same worker URL
// (recomputed from the persisted forwardPort) keeps proxying.
agent.kill('SIGTERM');
await once(agent, 'exit');
const agent2 = spawn(process.execPath, [`${here}/local-gpu-agent.mjs`], {
  env: { ...process.env, RDK_GPU_AGENT_PORT: String(agentPort), RDK_GPU_AGENT_HOME: home },
  stdio: ['ignore', 'ignore', 'ignore'],
});
await once(agent2, 'spawn');
const resumed = await eventually(
  () =>
    fetch(`${agentBase}/pair-status`).then((r) => {
      assert.equal(r.status, 200);
      return r.json();
    }),
  'agent restart pair-status',
);
assert.equal(resumed.mode, 'reverse');
assert.equal(resumed.online, true);
agent2.kill('SIGTERM');
await once(agent2, 'exit');

// ---------- cleanup ----------
forwarder.close();
worker.close();
rmSync(home, { recursive: true, force: true });
console.log('local-gpu-agent: all tests passed');
