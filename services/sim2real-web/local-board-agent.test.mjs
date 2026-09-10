import assert from 'node:assert/strict';
import process from 'node:process';

const previousToken = process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN;
delete process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN;

const { buildBoardPreflightCommand, createLocalBoardAgentServer } =
  await import('./local-board-agent.mjs');
const { STATION_COMMANDS } = await import('./board-station.mjs');
const server = createLocalBoardAgentServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const base = `http://127.0.0.1:${address.port}`;
const preflight = buildBoardPreflightCommand();

async function readStreamPrefix(response, { maxBytes = 64 * 1024, timeoutMs = 3000 } = {}) {
  if (!response.body) throw new Error('no stream body');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  const timer = setTimeout(() => {
    reader.cancel().catch(() => undefined);
  }, timeoutMs);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      bytes += value.length;
      if (bytes >= maxBytes) break;
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks);
}

try {
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  const healthPayload = await health.json();
  assert.deepEqual(healthPayload, {
    ok: true,
    service: 'local-board-agent-reference',
    capabilities: ['read-only-preflight', 'host-station'],
    stationCommands: STATION_COMMANDS.map((command) => ({ id: command.id, label: command.label })),
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

  const forged = await fetch(`${base}/v1/devices/x5/commands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commands: [`${preflight}\n; echo forged`] }),
  });
  assert.equal(forged.status, 403);
  assert.equal((await forged.json()).error, 'BOARD_AGENT_READ_ONLY');

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

  // ---- host-station surface ----
  const status = await fetch(`${base}/v1/station/status`);
  assert.equal(status.status, 200);
  const statusPayload = await status.json();
  assert.equal(statusPayload.board.mock, true);
  assert.equal(statusPayload.actuatorControl, false);
  assert.ok(Number.isFinite(statusPayload.cpu.percent));
  assert.ok(Array.isArray(statusPayload.topics));

  const badStationCommand = await fetch(`${base}/v1/station/commands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'reboot' }),
  });
  assert.equal(badStationCommand.status, 403);
  assert.equal((await badStationCommand.json()).error, 'BOARD_AGENT_READ_ONLY');

  const goodStationCommand = await fetch(`${base}/v1/station/commands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'list-tros-nodes' }),
  });
  assert.equal(goodStationCommand.status, 200);
  const commandPayload = await goodStationCommand.json();
  assert.equal(commandPayload.ok, true);
  assert.equal(commandPayload.mock, true);
  assert.equal(commandPayload.actuatorControl, false);
  assert.ok(commandPayload.output.length > 0);

  const statusStream = await fetch(`${base}/v1/station/status/stream`);
  assert.equal(statusStream.status, 200);
  assert.match(statusStream.headers.get('content-type') || '', /x-ndjson/);
  const statusStreamBody = await readStreamPrefix(statusStream, {
    maxBytes: 8192,
    timeoutMs: 1500,
  });
  const statusLines = statusStreamBody.toString('utf8').split('\n').filter(Boolean);
  assert.ok(statusLines.length >= 1, 'status stream should emit at least one heartbeat');
  assert.ok(Number.isFinite(JSON.parse(statusLines[0]).cpu.percent));

  const camera = await fetch(`${base}/v1/station/camera.mjpeg`);
  assert.equal(camera.status, 200);
  assert.match(camera.headers.get('content-type') || '', /multipart\/x-mixed-replace/);
  const cameraBody = await readStreamPrefix(camera, { maxBytes: 32 * 1024, timeoutMs: 1500 });
  const cameraText = cameraBody.toString('latin1');
  assert.match(cameraText, /content-type: image\/jpeg/);
  const jpegStart = cameraBody.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
  assert.ok(jpegStart > 0, 'camera stream must contain real JPEG SOI bytes');

  // ---- policy staging surface (software loop closes here) ----
  // A tiny valid "policy" byte blob; the reference agent only stores and
  // verifies, it never loads — that stays the runtime's own gated action.
  const { createHash } = await import('node:crypto');
  const policyBytes = Buffer.from(Array.from({ length: 64 }, (_, i) => i & 0xff));
  const policySha = createHash('sha256').update(policyBytes).digest('hex');

  const emptyList = await fetch(`${base}/v1/station/policy/files`);
  assert.equal(emptyList.status, 200);
  const emptyPayload = await emptyList.json();
  assert.deepEqual(emptyPayload.policies, []);

  const traversal = await fetch(`${base}/v1/station/policy/upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      filename: '../escape.onnx',
      bytesBase64: policyBytes.toString('base64'),
      sha256: policySha,
    }),
  });
  assert.equal(traversal.status, 409);
  assert.equal((await traversal.json()).error, 'policy-filename-invalid');

  const badDigest = await fetch(`${base}/v1/station/policy/upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      filename: 'probe.onnx',
      bytesBase64: policyBytes.toString('base64'),
      sha256: '0'.repeat(64),
    }),
  });
  assert.equal(badDigest.status, 409);
  assert.equal((await badDigest.json()).error, 'policy-digest-mismatch');

  const staged = await fetch(`${base}/v1/station/policy/upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      filename: 'probe.onnx',
      bytesBase64: policyBytes.toString('base64'),
      sha256: policySha,
    }),
  });
  assert.equal(staged.status, 200);
  const stagedPayload = await staged.json();
  assert.equal(stagedPayload.ok, true);
  assert.equal(stagedPayload.staged, true);
  assert.equal(stagedPayload.path, 'probe.onnx');
  assert.equal(stagedPayload.sha256, policySha);

  const conflict = await fetch(`${base}/v1/station/policy/upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      filename: 'probe.onnx',
      bytesBase64: Buffer.from('different-bytes').toString('base64'),
      sha256: createHash('sha256').update('different-bytes').digest('hex'),
    }),
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error, 'policy-name-conflict');

  const idempotentRestage = await fetch(`${base}/v1/station/policy/upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      filename: 'probe.onnx',
      bytesBase64: policyBytes.toString('base64'),
      sha256: policySha,
    }),
  });
  assert.equal(idempotentRestage.status, 200);
  assert.equal(
    (await idempotentRestage.json()).note,
    'byte-identical to the staged file; no rewrite',
  );

  const list = await fetch(`${base}/v1/station/policy/files`);
  assert.equal(list.status, 200);
  const listPayload = await list.json();
  assert.equal(listPayload.policies.length, 1);
  assert.equal(listPayload.policies[0].name, 'probe.onnx');
  assert.equal(listPayload.policies[0].sha256, policySha);

  process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN = 'board-test-token';
  const unauthorized = await fetch(`${base}/healthz`);
  assert.equal(unauthorized.status, 401);
  const unauthorizedStation = await fetch(`${base}/v1/station/status`);
  assert.equal(unauthorizedStation.status, 401);
  const authorized = await fetch(`${base}/healthz`, {
    headers: { authorization: 'Bearer board-test-token' },
  });
  assert.equal(authorized.status, 200);
  console.log(
    '[local-board-agent] PASS — read-only contract, host-station surface, mock marker, and token gate verified',
  );
} finally {
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  if (previousToken === undefined) delete process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN;
  else process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN = previousToken;
}
