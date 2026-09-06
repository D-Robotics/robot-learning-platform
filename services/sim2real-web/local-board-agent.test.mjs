import assert from 'node:assert/strict';
import process from 'node:process';

const previousToken = process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN;
delete process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN;

const { createLocalBoardAgentServer } = await import('./local-board-agent.mjs');
const server = createLocalBoardAgentServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const base = `http://127.0.0.1:${address.port}`;
const preflight = '__STUDIO_SIM2REAL_PREFLIGHT_BEGIN__\nprobe\n__STUDIO_SIM2REAL_PREFLIGHT_END__';

try {
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    ok: true,
    service: 'local-board-agent-reference',
    capabilities: ['read-only-preflight'],
    actuatorControl: false,
    mock: true,
  });

  const rejected = await fetch(`${base}/v1/devices/x5/commands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commands: ['rm -rf /'] }),
  });
  assert.equal(rejected.status, 403);
  assert.equal((await rejected.json()).error, 'BOARD_AGENT_READ_ONLY');

  const accepted = await fetch(`${base}/v1/devices/x5/commands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commands: [preflight] }),
  });
  assert.equal(accepted.status, 200);
  const payload = await accepted.json();
  assert.equal(payload.mock, true);
  assert.equal(payload.actuatorControl, false);
  assert.equal(payload.device.boardPlatform, 'rdk-x5');

  process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN = 'board-test-token';
  const unauthorized = await fetch(`${base}/healthz`);
  assert.equal(unauthorized.status, 401);
  const authorized = await fetch(`${base}/healthz`, {
    headers: { authorization: 'Bearer board-test-token' },
  });
  assert.equal(authorized.status, 200);
  console.log('[local-board-agent] PASS — read-only contract, mock marker, and token gate verified');
} finally {
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  if (previousToken === undefined) delete process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN;
  else process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN = previousToken;
}
