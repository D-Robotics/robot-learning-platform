// Behavior-level tests for the web-managed device connection surface:
// SSH-tunnel record persistence, tunnel open/teardown lifecycle, owner
// scoping, and the platform switch override (confirm-gated fail-safe).
// Runs on the development machine with a fake `ssh` shim and a throwaway
// loopback HTTP agent — no board, no network, no real ssh needed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tunnelManagerPath = path.join(root, 'dist-server/server/sim2real/board-tunnel-manager.js');
const stationSwitchesPath = path.join(root, 'dist-server/server/sim2real/station-switches.js');

assert.ok(
  fs.existsSync(tunnelManagerPath),
  'run npm run build first (board-tunnel-manager.js missing)',
);
assert.ok(
  fs.existsSync(stationSwitchesPath),
  'run npm run build first (station-switches.js missing)',
);

const tunnelManager = await import(tunnelManagerPath);
const stationSwitches = await import(stationSwitchesPath);

// ---- shared fixtures -------------------------------------------------------
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdk-device-conn-'));
fs.writeFileSync(path.join(dataDir, 'device-connections.json'), '[]', { mode: 0o600 });
tunnelManager.setTunnelDataDirResolver(() => dataDir);
process.env.RDK_SIM2REAL_STORAGE_DIR = dataDir;

// fake ssh: `-V` probe exits fast (like real ssh); a tunnel invocation parses
// `-L localPort:targetHost:targetPort` and ACTUALLY forwards it to the
// throwaway agent (like real ssh), so the healthz probe round-trips for real.
// MODE=fail: exits 255 immediately (auth refused).
const binDir = path.join(dataDir, 'bin');
fs.mkdirSync(binDir, { recursive: true });
const fakeSshJs = path.join(binDir, 'fake-ssh.mjs');
fs.writeFileSync(
  fakeSshJs,
  [
    `import net from 'node:net';`,
    `import fs from 'node:fs';`,
    `const args = process.argv.slice(2);`,
    `if (args[0] === '-V') { process.exit(0); }`,
    `fs.appendFileSync(process.env.FAKE_SSH_LOG, args.join(' ') + '\\n');`,
    `if (process.env.FAKE_SSH_MODE === 'fail') { console.error('Permission denied (publickey).'); process.exit(255); }`,
    `const fwd = args[args.indexOf('-L') + 1].split(':');`,
    `const local = Number(fwd[0]); const target = Number(fwd[2]);`,
    `const server = net.createServer((socket) => {`,
    `  const upstream = net.connect(target, '127.0.0.1');`,
    `  socket.pipe(upstream).pipe(socket);`,
    `  socket.on('error', () => upstream.destroy());`,
    `  upstream.on('error', () => socket.destroy());`,
    `});`,
    `server.listen(local, '127.0.0.1', () => console.log('FORWARD READY'));`,
    `process.on('SIGTERM', () => process.exit(0));`,
  ].join('\n'),
  { mode: 0o755 },
);
const fakeSsh = path.join(binDir, 'ssh');
fs.writeFileSync(fakeSsh, `#!/bin/sh\nexec "${process.execPath}" "${fakeSshJs}" "$@"\n`, {
  mode: 0o755,
});
const sshLog = path.join(dataDir, 'ssh.log');
process.env.FAKE_SSH_LOG = sshLog;
const realPath = process.env.PATH;
const withFakeSsh = (mode) => {
  process.env.FAKE_SSH_MODE = mode || '';
  process.env.PATH = `${binDir}:${realPath}`;
};
const withRealPath = () => {
  process.env.PATH = realPath;
};

// throwaway agent: answers /healthz with a mock board document.
const agent = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, mock: true, board: { model: 'TestBoard' } }));
    return;
  }
  res.statusCode = 404;
  res.end('{}');
});
await new Promise((resolve) => agent.listen(0, '127.0.0.1', resolve));
const agentPort = agent.address().port;

const results = [];
const test = async (name, fn) => {
  try {
    await fn();
    results.push(`PASS ${name}`);
  } catch (error) {
    results.push(`FAIL ${name}: ${error && error.message}`);
    process.exitCode = 1;
  }
};

// ---- tests -----------------------------------------------------------------
await test('create + list + dedup + delete round-trips the record', async () => {
  const created = await tunnelManager.createDeviceConnection({
    host: '192.0.2.10',
    label: 'OriginBot',
    username: 'root',
    port: 22,
  });
  assert.ok(!('error' in created), `unexpected error: ${created.error}`);
  assert.match(created.id, /^board-[a-z0-9]{8}$/);
  assert.equal(created.lastCheckMessage, '尚未测试连接。');
  const dup = await tunnelManager.createDeviceConnection({ host: '192.0.2.10' });
  assert.equal(dup.error, 'ALREADY_EXISTS');
  assert.equal(tunnelManager.listDeviceConnections().length, 1);
  assert.equal(
    tunnelManager.listDeviceConnections('alice@example.com').length,
    0,
    'multi-user mode must scope by owner',
  );
  const alice = await tunnelManager.createDeviceConnection(
    { host: '192.168.1.5' },
    'alice@example.com',
  );
  assert.ok(!('error' in alice));
  assert.equal(tunnelManager.listDeviceConnections().length, 2, 'single-user mode sees all');
  assert.equal(tunnelManager.listDeviceConnections('alice@example.com').length, 1);
  assert.equal(await tunnelManager.deleteDeviceConnection(created.id), true);
  assert.equal(await tunnelManager.deleteDeviceConnection('board-nope'), false);
});

await test('URL-ish hosts are rejected (SSRF guard on stored coordinates)', async () => {
  for (const bad of [
    'http://10.0.0.1',
    'https://board.example.com',
    'user@host',
    'host/path',
    '',
  ]) {
    const result = await tunnelManager.createDeviceConnection({ host: bad });
    assert.equal(result.error, 'INVALID_HOST', `host "${bad}" must be rejected`);
  }
});

await test('openDeviceConnectionTunnel probes healthz through the tunnel', async () => {
  withFakeSsh('');
  const created = await tunnelManager.createDeviceConnection({
    host: '127.0.0.1',
    port: 22,
    agentPort, // forward straight to the throwaway agent
  });
  assert.ok(!('error' in created));
  const opened = await tunnelManager.openDeviceConnectionTunnel(created.id);
  assert.ok(!('error' in opened), `open failed: ${opened.error}`);
  assert.equal(opened.probe.ok, true);
  assert.equal(opened.probe.agentInfo.mock, true);
  assert.equal(opened.probe.agentInfo.boardModel, 'TestBoard');
  assert.match(opened.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(tunnelManager.deviceConnectionAgentUrl(created.id), opened.url);
  assert.ok(tunnelManager.activeDeviceConnections().includes(created.id));
  assert.equal(tunnelManager.activeTunnelAgentUrl(), opened.url);
  // the ssh shim saw the exact forward + host coordinates
  const argv = fs
    .readFileSync(sshLog, 'utf8')
    .trim()
    .split('\n')
    .find((line) => line.includes('-L'));
  assert.match(argv, new RegExp(`-L \\d+:127\\.0\\.0\\.1:${agentPort} root@127\\.0\\.0\\.1 -p 22`));
  // record persisted the healthy state
  const stored = tunnelManager.listDeviceConnections().find((item) => item.id === created.id);
  assert.equal(stored.lastCheckOk, true);
  // teardown works and is idempotent
  await tunnelManager.closeDeviceConnectionTunnel(created.id);
  await tunnelManager.closeDeviceConnectionTunnel(created.id);
  assert.equal(tunnelManager.deviceConnectionAgentUrl(created.id), null);
  assert.equal(tunnelManager.activeTunnelAgentUrl(), null);
  await tunnelManager.deleteDeviceConnection(created.id);
});

await test('concurrent connect requests share one in-flight tunnel', async () => {
  withFakeSsh('');
  const created = await tunnelManager.createDeviceConnection({
    host: '127.0.0.1',
    port: 22,
    agentPort,
  });
  assert.ok(!('error' in created));
  const before = fs.existsSync(sshLog)
    ? fs.readFileSync(sshLog, 'utf8').trim().split('\n').length
    : 0;
  const firstPromise = tunnelManager.openDeviceConnectionTunnel(created.id);
  const secondPromise = tunnelManager.openDeviceConnectionTunnel(created.id);
  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  assert.ok(!('error' in first), `first open failed: ${first.error}`);
  assert.ok(!('error' in second), `second open failed: ${second.error}`);
  assert.equal(first.url, second.url, 'duplicate requests must share the same loopback tunnel');
  const after = fs.readFileSync(sshLog, 'utf8').trim().split('\n').length;
  assert.equal(after - before, 1, 'duplicate requests must spawn exactly one ssh process');
  await tunnelManager.closeDeviceConnectionTunnel(created.id);
  await tunnelManager.deleteDeviceConnection(created.id);
});

await test('different owners do not share an in-flight tunnel for a colliding id', async () => {
  withFakeSsh('fail');
  const registry = path.join(dataDir, 'device-connections.json');
  const collisionId = 'board-owner-collision';
  const records = [
    {
      id: collisionId,
      label: 'Alice board',
      host: '192.0.2.21',
      port: 22,
      username: 'root',
      agentPort: 19_100,
      localPort: 0,
      createdAt: new Date(0).toISOString(),
      lastCheckedAt: null,
      lastCheckOk: null,
      lastCheckMessage: '尚未测试连接。',
      profile: 'custom',
      transport: 'ssh',
      ownerKey: 'sso:alice@example.com:web',
    },
  ];
  fs.writeFileSync(registry, JSON.stringify(records, null, 2), { mode: 0o600 });
  const before = fs.readFileSync(sshLog, 'utf8').trim().split('\n').filter(Boolean).length;
  const alicePromise = tunnelManager.openDeviceConnectionTunnel(collisionId, 'alice@example.com');
  const bobPromise = tunnelManager.openDeviceConnectionTunnel(collisionId, 'bob@example.com');
  assert.notEqual(alicePromise, bobPromise, 'owner scopes must have separate in-flight entries');
  const [alice, bob] = await Promise.all([alicePromise, bobPromise]);
  assert.match(alice.error, /SSH 连接失败：/);
  assert.equal(bob.error, 'NOT_FOUND', "another owner must not inherit Alice's result");
  const after = fs.readFileSync(sshLog, 'utf8').trim().split('\n').filter(Boolean).length;
  assert.equal(after - before, 1, "an unauthorized owner must not start or reuse Alice's ssh");
  // A failed operation must be removed from the map so a later retry is not
  // pinned to the previous result.
  const retry = await tunnelManager.openDeviceConnectionTunnel(collisionId, 'alice@example.com');
  assert.match(retry.error, /SSH 连接失败：/);
  const retried = fs.readFileSync(sshLog, 'utf8').trim().split('\n').filter(Boolean).length;
  assert.equal(retried - after, 1);
});

await test('ssh failure fails closed: no tunnel, no stale record state', async () => {
  withFakeSsh('fail');
  const created = await tunnelManager.createDeviceConnection({ host: '192.0.2.10' });
  assert.ok(!('error' in created));
  const opened = await tunnelManager.openDeviceConnectionTunnel(created.id);
  assert.equal('error' in opened, true);
  assert.match(opened.error, /SSH 连接失败：/);
  assert.equal(
    tunnelManager.activeDeviceConnections().length,
    0,
    'failed tunnel must not stay in the live map',
  );
  assert.equal(tunnelManager.deviceConnectionAgentUrl(created.id), null);
  const stored = tunnelManager.listDeviceConnections().find((item) => item.id === created.id);
  assert.equal(
    stored.lastCheckOk,
    null,
    'open failure itself does not mutate lastCheck (route marks it)',
  );
  await tunnelManager.deleteDeviceConnection(created.id);
});

await test('station switches: confirm-gated on, free off, env default honored', async () => {
  delete process.env.RDK_SIM2REAL_STATION_DRIVE_ENABLED;
  delete process.env.RDK_SIM2REAL_STATION_POLICY_ENABLED;
  const switchesFile = path.join(dataDir, 'station-switches.json');
  fs.rmSync(switchesFile, { force: true });
  // default: off when no env and no override
  assert.equal(stationSwitches.stationSwitchEnabled('drive'), false);
  stationSwitches.setStationSwitch('drive', true);
  assert.equal(stationSwitches.stationSwitchEnabled('drive'), true);
  assert.equal(stationSwitches.stationSwitchEnabled('policy'), false);
  assert.equal(JSON.parse(fs.readFileSync(switchesFile, 'utf8')).drive, true, 'override persists');
  stationSwitches.setStationSwitch('drive', false);
  assert.equal(stationSwitches.stationSwitchEnabled('drive'), false);
  stationSwitches.setStationSwitch('policy', true);
  stationSwitches.clearStationSwitch('policy');
  assert.equal(stationSwitches.stationSwitchEnabled('policy'), false);
  // env default: ON flows through when override absent
  process.env.RDK_SIM2REAL_STATION_POLICY_ENABLED = '1';
  stationSwitches.clearStationSwitch('policy');
  assert.equal(stationSwitches.stationSwitchEnabled('policy'), true);
  // override beats env (runtime OFF over deploy-time ON — the safe direction)
  stationSwitches.setStationSwitch('policy', false);
  assert.equal(stationSwitches.stationSwitchEnabled('policy'), false);
  stationSwitches.clearStationSwitch('policy');
  delete process.env.RDK_SIM2REAL_STATION_POLICY_ENABLED;
});

// ---- teardown --------------------------------------------------------------
withRealPath();
agent.close();
fs.rmSync(dataDir, { recursive: true, force: true });
for (const line of results) console.log(line);
const failed = results.filter((line) => line.startsWith('FAIL')).length;
if (failed === 0) {
  console.log(
    '[sim2real device-connections] PASS — tunnels, records, scoping, and switches behave',
  );
} else {
  console.log(`[sim2real device-connections] ${failed} FAIL`);
}
