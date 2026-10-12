import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('./verify-arm-acceptance.mjs', import.meta.url));

async function runAgainstFakeStation(arm) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(request.url === '/healthz' ? { ok: true } : arm));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const child = spawn(process.execPath, [script, '--base-url', `http://127.0.0.1:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const timer = setTimeout(() => child.kill(), 5000);
    const exitCode = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    clearTimeout(timer);
    return { requests, exitCode, output };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('acceptance preflight sends only GET even when both arm switches are enabled', async () => {
  const result = await runAgainstFakeStation({
    ok: true,
    platformEnabled: true,
    arm: { available: true, mock: false, enabled: true, moving: false },
  });
  assert.equal(result.exitCode, 0, result.output);
  assert.deepEqual(result.requests, [
    { method: 'GET', path: '/healthz' },
    { method: 'GET', path: '/api/sim2real/board-station/arm' },
  ]);
  assert.match(result.output, /arm\/stop/);
  assert.match(result.output, /arm\/reset/);
  assert.match(result.output, /stopRequested/);
  assert.doesNotMatch(result.output, /arm\/stop 回 home/);
});

test('nested mock arm evidence cannot pass acceptance', async () => {
  const result = await runAgainstFakeStation({ ok: true, arm: { available: true, mock: true } });
  assert.equal(result.exitCode, 1, result.output);
  assert.match(result.output, /FAIL.*MOCK/);
  assert.equal(
    result.requests.every((request) => request.method === 'GET'),
    true,
  );
});

test('an unavailable nested arm reports pending without a false PASS', async () => {
  const result = await runAgainstFakeStation({
    ok: true,
    arm: { available: false, reason: 'arm-sdk-unavailable' },
  });
  assert.equal(result.exitCode, 0, result.output);
  assert.match(result.output, /PENDING/);
  assert.doesNotMatch(result.output, /stage A PASS/);
  assert.equal(
    result.requests.every((request) => request.method === 'GET'),
    true,
  );
});

test('missing mock evidence cannot pass the read-only preflight', async () => {
  const result = await runAgainstFakeStation({ ok: true, arm: { available: true } });
  assert.equal(result.exitCode, 1, result.output);
  assert.match(result.output, /FAIL.*explicitly report/);
  assert.equal(
    result.requests.every((request) => request.method === 'GET'),
    true,
  );
});
