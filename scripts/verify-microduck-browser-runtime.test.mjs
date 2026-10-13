import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {
  inspectBundle,
  verifyBoundaryMarkup,
  verifyReleaseFiles,
} from './verify-microduck-browser-runtime.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const locked = (value) => ({ sha256: hash(value), bytes: Buffer.byteLength(value) });

test('runtime-looking comments and strings cannot satisfy the public capability gate', () => {
  assert.throws(
    () => inspectBundle('// window.rl={loadCustomPolicy:fn};\n"window.rl={loadCustomPolicy:fn}";'),
    /exactly one window.rl/,
  );
});

test('a recorder-only old runtime is rejected for its missing policy loader', () => {
  assert.throws(
    () =>
      inspectBundle(
        'function boot(){window.rl={model:0,data:0,mujoco:0,buildObs:0,lastAction:0,resetSim:0,controller:0,kbSource:0,padSource:0,sessions:0,ort:0,step:0,render:0,inputLocked:0,loco:0,locoSwitching:0,recovery:0,debugPush:0,spawnBall:0,setLoco:0};}',
      ),
    /runtime API missing: loadCustomPolicy/,
  );
});

test('invalid JavaScript cannot pass the capability check', () => {
  assert.throws(() => inspectBundle('window.rl = {'), /not valid JavaScript/);
});

test('asset bytes are checked rather than trusting a provenance claim', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'microduck-static-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = { files: { 'runtime.js': locked('approved') } };
  await writeFile(path.join(root, 'runtime.js'), 'approved');
  await verifyReleaseFiles(root, lock);
  await writeFile(path.join(root, 'runtime.js'), 'replaced');
  await assert.rejects(verifyReleaseFiles(root, lock), /approved asset mismatch/);
});

test('an asset symlink cannot escape the release even with matching bytes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'microduck-static-check-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'microduck-outside-'));
  t.after(() =>
    Promise.all(
      [root, outside].map((directory) => rm(directory, { recursive: true, force: true })),
    ),
  );
  await writeFile(path.join(outside, 'runtime.js'), 'approved');
  await symlink(path.join(outside, 'runtime.js'), path.join(root, 'runtime.js'));
  await assert.rejects(
    verifyReleaseFiles(root, { files: { 'runtime.js': locked('approved') } }),
    /asset escapes release/,
  );
});

test('an arbitrary index edit is rejected', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'microduck-static-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const approved = '<script src="/approved.js"></script>\n</body>\n';
  await writeFile(path.join(root, 'index.html'), approved.replace('approved', 'tampered'));
  await assert.rejects(
    verifyReleaseFiles(root, { files: { 'index.html': locked(approved) } }),
    /approved asset mismatch/,
  );
});

test('a wrong byte count in the lock is rejected even when its SHA matches', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'microduck-static-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'runtime.js'), 'approved');
  await assert.rejects(
    verifyReleaseFiles(root, { files: { 'runtime.js': { ...locked('approved'), bytes: 9 } } }),
    /approved asset size mismatch/,
  );
});

for (const filename of ['extra-runtime.js', 'extra-policy.onnx', 'artifact.sha256.json']) {
  test(`an unlocked ${filename} resource cannot enter the public release`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'microduck-static-check-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, 'runtime.js'), 'approved');
    await writeFile(path.join(root, filename), 'unapproved');
    await assert.rejects(
      verifyReleaseFiles(root, { files: { 'runtime.js': locked('approved') } }),
      /unexpected release file/,
    );
  });
}

test('an extra attribution symlink cannot escape the release', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'microduck-static-check-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'microduck-attribution-outside-'));
  t.after(() =>
    Promise.all(
      [root, outside].map((directory) => rm(directory, { recursive: true, force: true })),
    ),
  );
  await writeFile(path.join(root, 'runtime.js'), 'approved');
  await writeFile(path.join(outside, 'LICENSE'), 'terms');
  await symlink(path.join(outside, 'LICENSE'), path.join(root, 'LICENSE'));
  await assert.rejects(
    verifyReleaseFiles(root, { files: { 'runtime.js': locked('approved') } }),
    /asset escapes release/,
  );
});

test('a replaced overlay is rejected even without an index reference', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'microduck-static-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'runtime.js'), 'approved');
  await writeFile(path.join(root, 'microduck-community-overlay.js'), 'replaced');
  await assert.rejects(
    verifyReleaseFiles(root, { files: { 'runtime.js': locked('approved') } }),
    /installed additive asset/,
  );
});

test('explicitly named upstream attribution is preserved', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'microduck-static-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'runtime.js'), 'approved');
  await writeFile(path.join(root, 'LICENSE'), 'upstream terms');
  await writeFile(path.join(root, 'NOTICE.md'), 'upstream attribution');
  await verifyReleaseFiles(root, { files: { 'runtime.js': locked('approved') } });
});

test('the transport boundary blocks RTC construction before upstream boot and preserves local workers/fetch', async () => {
  const source = await readFile(
    new URL('../services/mujoco-web/microduck-network-boundary.js', import.meta.url),
    'utf8',
  );
  let rtcCalls = 0;
  let workerCalls = 0;
  const fetchLocal = () => 'local-response';
  const context = vm.createContext({
    DOMException,
    document: { documentElement: { dataset: {} } },
    RTCPeerConnection: function () {
      rtcCalls++;
    },
    webkitRTCPeerConnection: function () {
      rtcCalls++;
    },
    mozRTCPeerConnection: function () {
      rtcCalls++;
    },
    Worker: function () {
      workerCalls++;
    },
    fetch: fetchLocal,
  });
  vm.runInContext('globalThis.window=globalThis', context);
  vm.runInContext('new RTCPeerConnection({iceServers:[{urls:"stun:outside.invalid"}]})', context);
  assert.equal(rtcCalls, 1, 'the unprotected upstream transport counter must be live');
  rtcCalls = 0;
  vm.runInContext(source, context);
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection']) {
    assert.throws(
      () => vm.runInContext(`new ${name}({iceServers:[{urls:'stun:outside.invalid'}]})`, context),
      { name: 'NotAllowedError' },
    );
    assert.equal(Object.getOwnPropertyDescriptor(context, name).writable, false);
    assert.equal(Object.getOwnPropertyDescriptor(context, name).configurable, false);
  }
  assert.equal(rtcCalls, 0, 'an upstream constructor reached the original RTC transport');
  vm.runInContext('new Worker("blob:local");fetch("/local-policy.onnx")', context);
  assert.equal(workerCalls, 1);
  assert.equal(context.fetch, fetchLocal);
  assert.equal(context.document.documentElement.dataset.rdkSimulationNetwork, 'local');
});

test('a browser that cannot lock the transport stops subsequent script execution', async () => {
  const source = await readFile(
    new URL('../services/mujoco-web/microduck-network-boundary.js', import.meta.url),
    'utf8',
  );
  const policies = [];
  const context = vm.createContext({
    DOMException,
    document: {
      documentElement: { dataset: {} },
      head: { appendChild: (element) => policies.push(element) },
      createElement: () => ({
        setAttribute(name, value) {
          this[name] = value;
        },
      }),
    },
  });
  vm.runInContext(
    'globalThis.window=globalThis;Object.defineProperty(window,"RTCPeerConnection",{value:function(){},configurable:false,writable:false})',
    context,
  );
  assert.throws(() => vm.runInContext(source, context), /无法初始化单机仿真/);
  assert.equal(context.document.documentElement.dataset.rdkSimulationNetwork, 'blocked');
  assert.equal(policies[0].content, "script-src 'none'; connect-src 'none'; worker-src 'none'");
});

test('the HTML gate refuses a transport boundary scheduled after an upstream script', () => {
  const policy =
    '<meta id="rdk-microduck-network-policy" http-equiv="Content-Security-Policy" content="connect-src \'self\'" />';
  const boundary =
    '\n    ' +
    policy +
    '\n    <script src="./microduck-network-boundary.js?v=0123456789ab"></script>';
  const upstream = '<script type="module" src="upstream.js"></script>';
  verifyBoundaryMarkup('<head>' + boundary + upstream + '</head>', '0123456789ab');
  assert.throws(
    () => verifyBoundaryMarkup('<head>' + upstream + boundary + '</head>', '0123456789ab'),
    /must precede every upstream script/,
  );
  assert.throws(
    () =>
      verifyBoundaryMarkup(
        '<head>' + boundary.replace('></script>', ' defer></script>') + upstream + '</head>',
        '0123456789ab',
      ),
    /must precede every upstream script/,
  );
  assert.throws(
    () =>
      verifyBoundaryMarkup(
        '<head>' + boundary.replace("connect-src 'self'", 'connect-src *') + upstream + '</head>',
        '0123456789ab',
      ),
    /must precede every upstream script/,
  );
});
