#!/usr/bin/env node
/**
 * Self-test for scripts/demo-preflight.mjs.
 *
 * Spins a throwaway HTTP server (in a worker thread — the preflight child is
 * driven synchronously with spawnSync, which blocks the parent's event loop,
 * so the mock server must live on its own loop) that mocks the workbench API
 * surface (board-station health/status/policy/drive/policy/files +
 * device-connections), then runs the preflight script as a child process
 * against it in three scenarios:
 *
 *   real-ready  — real board, all green → exit 0, no ✗
 *   mock-agent  — reference agent (mock=true, station endpoints missing) →
 *                 exit 0 (degraded is demo-rehearsal-able), mock is labelled
 *   board-down  — agent unreachable → exit 3 (blocked)
 *
 * Also asserts the safety invariant: only GETs are issued (the preflight
 * never commands motion, flips switches, or stages files).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/demo-preflight.mjs');

// The mock server records every request; the parent drains the log between
// scenarios via a request-log endpoint.
const WORKER_SOURCE = `
import http from 'node:http';
import { parentPort } from 'node:worker_threads';
const recorded = [];
const server = http.createServer((req, res) => {
  recorded.push({ method: req.method, path: req.url });
  res.setHeader('content-type', 'application/json');
  const send = (status, body) => { res.statusCode = status; res.end(JSON.stringify(body)); };
  const scenario = process.env.SCENARIO;
  if (req.url === '/__log') {
    return send(200, { log: recorded.slice() });
  }
  if (scenario === 'board-down') {
    if (req.url.startsWith('/api/sim2real/device-connections')) {
      return send(200, { ok: true, connections: [] });
    }
    return send(503, { ok: false, error: 'SIM2REAL_STATION_OFFLINE', message: '板端 agent 不可达' });
  }
  if (req.url.startsWith('/api/sim2real/board-station/health')) {
    return send(200, {
      ok: true,
      device: { id: 'device-1', name: 'X5 台架', status: 'connected', boardPlatform: 'rdk-x5', boardModel: 'RDK X5' },
      agent: {
        capabilities: ['host-station', 'policy'],
        stationCommands: [],
        actuatorControl: false,
        mock: scenario === 'mock-agent',
      },
      cameraSupported: true,
    });
  }
  if (req.url.startsWith('/api/sim2real/board-station/status')) {
    if (scenario === 'mock-agent') return send(501, { ok: false });
    return send(200, {
      ok: true,
      status: {
        board: { model: 'RDK X5', mock: false },
        power: { voltage: 5.02, current: 0.9 },
        cpu: { percent: 23.5 },
        originbot: {
          imu: { quaternion: { x: 0, y: 0, z: 0.2, w: 0.98 } },
          batteryVoltage: 5.02,
          odom: { positionX: 0.1, positionY: -0.2, linearX: 0.05, angularZ: 0.01 },
        },
        topics: [{ name: '/imu' }, { name: '/odom' }],
      },
    });
  }
  if (req.url.startsWith('/api/sim2real/board-station/policy/files')) {
    if (scenario === 'mock-agent') return send(501, { ok: false });
    return send(200, {
      ok: true,
      dir: '/root/rdk-board-agent/policies',
      policies: [{ name: 'policy.onnx', bytes: 95370 }],
    });
  }
  if (req.url.startsWith('/api/sim2real/board-station/policy')) {
    if (scenario === 'mock-agent') return send(501, { ok: false });
    return send(200, {
      ok: true,
      platformEnabled: true,
      policy: { enabled: true, runtimeRunning: false, state: 'ready', motionAuthorized: false },
    });
  }
  if (req.url.startsWith('/api/sim2real/board-station/drive')) {
    if (scenario === 'mock-agent') return send(501, { ok: false });
    return send(200, {
      ok: true,
      platformEnabled: false,
      drive: { enabled: false, active: false, lastStopReason: 'operator-stop' },
      gates: { ready: false },
      actuatorPolicy: { maxLinear: 0.3 },
    });
  }
  if (req.url.startsWith('/api/sim2real/device-connections')) {
    return send(200, {
      ok: true,
      connections: scenario === 'mock-agent' ? [] : [
        { id: 'conn-1', label: 'X5 台架', host: '192.168.1.42', agentPort: 19100, tunnelActive: true, lastCheckOk: true },
      ],
    });
  }
  return send(404, { ok: false });
});
server.listen(0, '127.0.0.1', () => parentPort.postMessage(server.address().port));
`;

async function startWorkerServer(scenario) {
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(WORKER_SOURCE)}`), {
    env: { ...process.env, SCENARIO: scenario },
  });
  const port = await new Promise((resolve, reject) => {
    worker.on('message', resolve);
    worker.on('error', reject);
  });
  return {
    base: `http://127.0.0.1:${port}`,
    async requestLog() {
      const response = await fetch(`http://127.0.0.1:${port}/__log`);
      const body = await response.json();
      return body.log;
    },
    async close() {
      await worker.terminate();
    },
  };
}

async function runScenario(scenario) {
  const server = await startWorkerServer(scenario);
  const result = spawnSync(process.execPath, [script, '--url', server.base, '--no-color'], {
    encoding: 'utf8',
    timeout: 30000,
  });
  const log = await server.requestLog();
  await server.close();
  return { base: server.base, result, log };
}

// ---- 1. real-ready ---------------------------------------------------------
{
  const { result, log } = await runScenario('real-ready');
  assert.equal(result.status, 0, `real-ready exit 0, got ${result.status}\n${result.stdout}`);
  const out = result.stdout;
  assert.ok(out.includes('预检'), 'prints header');
  assert.ok(out.includes('mock=false 真实板卡'), 'labels real board');
  assert.ok(out.includes('5.02 V'), 'reads battery');
  assert.ok(!/✗/.test(out), `no failed item in real-ready:\n${out}`);
  assert.ok(out.includes('预检通过'), 'prints overall pass');
  // Safety: GET only, and only the read-only surface.
  const traffic = log.filter((entry) => entry.path !== '/__log');
  assert.ok(
    traffic.every((entry) => entry.method === 'GET'),
    `preflight must only issue GETs, saw ${traffic.map((entry) => entry.method)}`,
  );
  assert.ok(
    traffic.every(
      (entry) =>
        entry.path.startsWith('/api/sim2real/board-station/') ||
        entry.path.startsWith('/api/sim2real/device-connections'),
    ),
    `preflight must only probe read-only endpoints, saw ${traffic.map((entry) => entry.path)}`,
  );
  assert.ok(!traffic.some((entry) => entry.path.includes('/drive/stop')), 'never commands stop');
}

// ---- 2. mock-agent ---------------------------------------------------------
{
  const { result } = await runScenario('mock-agent');
  assert.equal(result.status, 0, `mock-agent exit 0 (rehearsal-able), got ${result.status}`);
  const out = result.stdout;
  assert.ok(out.includes('mock 参考数据'), 'labels mock agent honestly');
  assert.ok(out.includes('✗'), 'station endpoints missing → visible failures');
  assert.ok(out.includes('有降级项'), 'degraded verdict, not a fabricated pass');
}

// ---- 2b. mock-agent strict ---------------------------------------------------
{
  const server = await startWorkerServer('mock-agent');
  const result = spawnSync(
    process.execPath,
    [script, '--url', server.base, '--no-color', '--strict'],
    { encoding: 'utf8', timeout: 30000 },
  );
  await server.close();
  assert.equal(result.status, 2, `--strict mock → exit 2, got ${result.status}`);
}

// ---- 3. board-down -----------------------------------------------------------
{
  const { result } = await runScenario('board-down');
  assert.equal(result.status, 3, `board-down exit 3 (blocked), got ${result.status}`);
  const out = result.stdout;
  assert.ok(out.includes('不可达'), 'reports unreachable');
  assert.ok(out.includes('有阻断项'), 'blocked verdict');
  assert.ok(out.includes('修复:'), 'prints a fix hint');
}

// ---- 4. --json machine-readable ----------------------------------------------
{
  const server = await startWorkerServer('board-down');
  const result = spawnSync(
    process.execPath,
    [script, '--url', server.base, '--no-color', '--json'],
    { encoding: 'utf8', timeout: 30000 },
  );
  await server.close();
  // The JSON block is pretty-printed (multi-line); bracket-balance from the
  // first top-level '{' that opens a complete object to the end of stdout.
  const start = result.stdout.indexOf('\n{');
  assert.ok(start >= 0, 'json output present');
  let depth = 0;
  let end = -1;
  let inString = false;
  for (let i = start + 1; i < result.stdout.length; i += 1) {
    const char = result.stdout[i];
    if (char === '"') inString = !inString;
    if (inString) continue;
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  assert.ok(end > start, 'complete json block present');
  const parsed = JSON.parse(result.stdout.slice(start + 1, end));
  assert.equal(parsed.verdict, 'blocked');
  assert.ok(Array.isArray(parsed.checks) && parsed.checks.length >= 5);
  assert.ok(parsed.checks.every((check) => typeof check.ok === 'boolean'));
}

console.log('[demo-preflight] PASS — ✓/✗ 分级、mock 诚实标注、阻断退出码、只读 GET 均符合契约');
