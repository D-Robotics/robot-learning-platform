import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

if (!['linux', 'darwin'].includes(process.platform)) process.exit(0);

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'rdk-reference-screen-')));
const adapter = path.join(root, 'engines/originman-reference-ppo/adapter.py');
const bundle = path.join(root, 'bundle');
const jobs = path.join(root, 'jobs');
const python = path.join(root, 'venv/bin/python');
const packages = path.join(root, 'venv/lib/python3.12/site-packages');
const physicsModule = path.join(packages, 'mujoco/__init__.py');
const calibration = path.join(root, 'plugins/rdk-robot-learning-platform/references');
const profileFile = path.join(calibration, 'originman-reference-calibration.json');
const referenceModule = new URL(
  '../../plugins/rdk-robot-learning-platform/references/',
  import.meta.url,
);
const realNow = Date.now;
let server;
const installedFile = async (filename, data) => {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, data);
};

try {
  const profile = JSON.parse(
    await readFile(new URL('originman-reference-calibration.json', referenceModule)),
  );
  await installedFile(profileFile, JSON.stringify(profile));
  await installedFile(
    path.join(calibration, 'originman-reference-manifest.json'),
    await readFile(new URL('originman-reference-manifest.json', referenceModule)),
  );
  const scene = '<mujoco><asset><mesh name="fixture" file="meshes/fixture.stl"/></asset></mujoco>';
  const mesh = path.join(bundle, 'model/meshes/fixture.stl');
  await installedFile(mesh, 'model fixture');
  await installedFile(path.join(bundle, 'model/scene.xml'), scene);
  await installedFile(
    path.join(bundle, 'model/model-manifest.json'),
    JSON.stringify({
      floatingBase: true,
      joints: profile.robot.jointOrder,
      sceneSha256: createHash('sha256').update(scene).digest('hex'),
      meshSha256: {
        'fixture.stl': createHash('sha256').update('model fixture').digest('hex'),
      },
    }),
  );
  await installedFile(path.join(bundle, 'reference.npy'), 'reference fixture');
  await installedFile(path.join(root, 'venv/pyvenv.cfg'), 'include-system-site-packages = false\n');
  await mkdir(path.dirname(python), { recursive: true });
  await symlink(process.execPath, python);
  for (const dependency of ['mujoco', 'numpy', 'scipy', 'gymnasium'])
    await installedFile(path.join(packages, dependency, '__init__.py'), '# physics fixture\n');
  await installedFile(
    path.join(root, 'engines/originman-dance-ppo/env.py'),
    '# simulator fixture\n',
  );
  // The child records only invocation count. Distinct payloads produce normal,
  // failed, or malformed receipts without a real simulation dependency.
  await installedFile(
    adapter,
    [
      "const fs = require('node:fs');",
      "const crypto = require('node:crypto');",
      "if (process.argv[2] !== '--screen-reference') process.exit(3);",
      "fs.appendFileSync(process.env.RDK_SIM2REAL_JOB_DIR + '/screen-visits', 'x');",
      "const payload = JSON.parse(fs.readFileSync(0, 'utf8'));",
      'const frames = payload.joint_pos.length;',
      'const testValue = payload.joint_pos[2][2];',
      'const stance = payload.stanceProfile;',
      "const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');",
      'const calibration = fs.readFileSync(' + JSON.stringify(profileFile) + ');',
      "const calibrationDigest = hash(stance ? Buffer.concat([calibration, Buffer.from('\\0' + stance)]) : calibration);",
      'const completed = testValue !== -1;',
      "const digest = crypto.createHash('sha256').update('originman-reference-f64be-v1\\0');",
      'const dimensions = Buffer.alloc(8);',
      'dimensions.writeUInt32BE(payload.fps);',
      'dimensions.writeUInt32BE(frames, 4);',
      'digest.update(dimensions);',
      "for (const name of payload.joint_names) digest.update(name + '\\0');",
      'for (const field of [payload.joint_pos, payload.joint_vel]) {',
      '  for (const row of field) {',
      '    const data = Buffer.alloc(row.length * 8);',
      '    row.forEach((value, index) => data.writeDoubleBE(value === 0 ? 0 : value, index * 8));',
      '    digest.update(data);',
      '  }',
      '}',
      'console.log(JSON.stringify({',
      '  sceneSha256: hash(fs.readFileSync(' +
        JSON.stringify(path.join(bundle, 'model/scene.xml')) +
        ')),',
      "  calibrationSha256: testValue === -2 ? 'malformed' : calibrationDigest,",
      "  trajectorySha256: digest.digest('hex'),",
      '  ...(stance && { stanceProfile: stance }),',
      '  gate: { completed, framesExpected: frames, framesEvaluated: completed ? frames : 1,',
      '          firstFailedFrame: completed ? null : 1, maxTiltDeg: 1 },',
      '}));',
    ].join('\n'),
  );

  process.env.NODE_ENV = 'development';
  delete process.env.RDK_SIM2REAL_DEPLOYMENT;
  for (const variable of [
    'PYTHONPATH',
    'PYTHONHOME',
    'PYTHONSTARTUP',
    'LD_LIBRARY_PATH',
    'LD_PRELOAD',
    'MUJOCO_PLUGIN_PATH',
  ])
    delete process.env[variable];
  process.env.RDK_SIM2REAL_LOCAL_WORKER_DATA_DIR = jobs;
  process.env.RDK_SIM2REAL_MAX_CONCURRENT_JOBS = '1';
  process.env.RDK_SIM2REAL_MAX_CONCURRENT_JOBS_PER_ACCOUNT = '1';
  process.env.RDK_SIM2REAL_LOCAL_RUNNER_TOKEN = 'worker-test-token';
  process.env.RDK_ORIGINMAN_DANCE_BUNDLE_DIR = bundle;
  process.env.RDK_SIM2REAL_TRAIN_ENGINES_JSON = JSON.stringify({
    'originman-reference-ppo': { executable: python, args: [adapter] },
  });
  const { createLocalTrainingWorkerServer } = await import('./local-training-worker.mjs');
  server = createLocalTrainingWorkerServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = 'http://127.0.0.1:' + server.address().port + '/originman-reference/screen';
  const makeTrajectory = (testValue, stanceProfile) => ({
    schemaVersion: 1,
    fps: 50,
    joint_names: profile.robot.jointOrder,
    joint_pos: Array.from({ length: 50 }, (_, frame) =>
      profile.robot.jointOrder.map((_, joint) => (frame === 2 && joint === 2 ? testValue : 0)),
    ),
    joint_vel: Array.from({ length: 50 }, () => Array(profile.robot.jointOrder.length).fill(0)),
    ...(stanceProfile && { stanceProfile }),
  });
  const trajectory = makeTrajectory(0.05);
  const screen = async ({
    owner = 'alice',
    resource = 'gpu-7',
    body = trajectory,
    cached = false,
    authenticated = true,
  } = {}) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authenticated && { authorization: 'Bearer worker-test-token' }),
        'x-sim2real-account': owner,
        ...(resource && { 'x-sim2real-screen-resource': resource }),
      },
      body: JSON.stringify(body),
    });
    if (!authenticated) {
      assert.equal(response.status, 401);
      return;
    }
    assert.equal(response.status, 200);
    const report = await response.json();
    assert.equal(report.cached === true, cached);
    return report;
  };
  const count = async () => (await readFile(path.join(jobs, 'screen-visits'))).length;

  await screen({ authenticated: false });
  const fresh = await screen();
  const cached = await screen({ cached: true });
  assert.deepEqual(cached, { ...fresh, cached: true });
  assert.equal(await count(), 1);

  for (const change of [
    { owner: 'bob' },
    { resource: 'gpu-8' },
    { body: makeTrajectory(0.06) },
    { body: makeTrajectory(0.05, 'source-neutral-v1') },
  ]) {
    await screen(change);
    await screen({ ...change, cached: true });
  }
  assert.equal(await count(), 5);
  await screen({ cached: true });

  for (const change of [
    () => writeFile(profileFile, JSON.stringify({ ...profile, fixtureRevision: 1 })),
    () => writeFile(physicsModule, '# updated physics\n'),
    () => writeFile(mesh, 'updated model fixture'),
  ]) {
    await change();
    await screen();
    await screen({ cached: true });
  }
  assert.equal(await count(), 8);

  Date.now = () => realNow() + 6 * 60_000;
  await screen();
  await screen({ cached: true });
  assert.equal(await count(), 9);

  for (const request of [
    { resource: '' },
    { body: makeTrajectory(-1) },
    { body: makeTrajectory(-2) },
  ]) {
    await screen(request);
    await screen(request);
  }
  assert.equal(await count(), 15);
  console.log(
    '[local-reference-screen] PASS — scoped reuse, physical basis changes, expiry, and fail-closed receipts',
  );
} finally {
  Date.now = realNow;
  server?.closeAllConnections();
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
