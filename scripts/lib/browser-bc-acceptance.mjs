/* global document, window */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { COMMON_PYTHON_CANDIDATES, resolvePythonInterpreter } from './python-interpreter.mjs';
import {
  environment,
  freePort,
  service,
  http,
  waitReady,
  verifyArtifactManifest,
} from '../verify-platform-plugin-journey.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');

// Serializable Playwright callback; the public simulator reset includes a
// respawn animation that suppresses commands. Never start an episode inside it.
export async function resetSimulatorEpisode() {
  const rl = window.rl;
  rl.clearCustomPolicy();
  const resetTimeBefore = Number(rl.data.time);
  rl.resetSim();
  const resetTimeAfter = Number(rl.data.time);
  const started = performance.now();
  while (rl.inputLocked || rl.respawnActive) {
    if (performance.now() - started > 15000)
      throw new Error('Simulator reset never released input');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { resetTimeBefore, resetTimeAfter, inputReleased: true };
}

export function summarizePolicyEpisode(samples, desiredCommand) {
  const measured = samples.filter((sample) => sample.elapsed >= 0.4);
  const finite =
    samples.length > 0 &&
    samples.every((sample) =>
      [...sample.qpos, ...sample.qvel, ...sample.observation, ...sample.action].every(
        Number.isFinite,
      ),
    );
  let linearSquared = 0;
  let angularSquared = 0;
  let commandMaxError = 0;
  let minBaseHeight = Infinity;
  let maxTilt = 0;
  let fell = false;
  let reset = false;
  for (const [index, sample] of samples.entries()) {
    const q = sample.qpos;
    const yaw = Math.atan2(2 * (q[3] * q[6] + q[4] * q[5]), 1 - 2 * (q[5] ** 2 + q[6] ** 2));
    const bodyVx = Math.cos(yaw) * sample.qvel[0] + Math.sin(yaw) * sample.qvel[1];
    const bodyVy = -Math.sin(yaw) * sample.qvel[0] + Math.cos(yaw) * sample.qvel[1];
    const tilt = Math.acos(Math.max(-1, Math.min(1, -sample.observation[5])));
    minBaseHeight = Math.min(minBaseHeight, q[2]);
    maxTilt = Math.max(maxTilt, tilt);
    fell ||= q[2] < 0.06 || tilt > Math.PI / 3 || !!sample.recovery;
    reset ||= index > 0 && sample.time < samples[index - 1].time;
    if (sample.elapsed >= 0.4) {
      linearSquared += (bodyVx - desiredCommand[0]) ** 2 + (bodyVy - desiredCommand[1]) ** 2;
      angularSquared += (sample.qvel[5] - desiredCommand[2]) ** 2;
      commandMaxError = Math.max(
        commandMaxError,
        ...desiredCommand.map((value, axis) => Math.abs(value - sample.observation[48 + axis])),
      );
    }
  }
  const linearRmse = measured.length ? Math.sqrt(linearSquared / measured.length) : null;
  const angularRmse = measured.length ? Math.sqrt(angularSquared / measured.length) : null;
  const controllerRetained = samples.every((sample) => sample.controllerMatches === true);
  const physicsSeconds = samples.length > 1 ? samples.at(-1).time - samples[0].time : 0;
  const passed =
    finite &&
    samples.length >= 30 &&
    measured.length >= 20 &&
    physicsSeconds >= 2 &&
    !fell &&
    !reset &&
    controllerRetained &&
    commandMaxError < 1e-5 &&
    linearRmse <= 0.15 &&
    angularRmse <= 0.4;
  return {
    sampleCount: samples.length,
    measuredSamples: measured.length,
    physicsSeconds,
    finite,
    fell,
    automaticReset: reset,
    controllerRetained,
    minBaseHeightM: Number.isFinite(minBaseHeight) ? minBaseHeight : null,
    maxTiltRad: maxTilt,
    commandMaxError,
    linearVelocityRmseMps: linearRmse,
    angularVelocityRmseRadps: angularRmse,
    passed,
  };
}

async function evaluateIndependentPolicyRollouts({ page, base, run, output, step }) {
  return step(
    'BC04.independent-policy-rollouts',
    'fresh MuJoCo episodes with reference/BC/zero controls',
    async () => {
      await page.evaluate(() => {
        window.location.hash = 'simulate';
      });
      const element = await page.locator('#simulator-frame').elementHandle();
      const frame = await element.contentFrame();
      assert.ok(frame, 'Independent evaluation needs the real simulator iframe');
      await frame.waitForFunction(() => window.rl?.data && !window.rl.inputLocked);
      const directory = path.join(path.dirname(output), 'independent-rollouts');
      await fs.mkdir(directory, { recursive: true });
      const commands = [
        { name: 'stand', twist: [0, 0, 0] },
        { name: 'forward', twist: [0.2, 0, 0] },
        { name: 'turn', twist: [0, 0, 0.5] },
      ];
      const episodes = [];
      for (const controller of ['reference', 'bc', 'zero']) {
        for (const command of commands) {
          const reset = await frame.evaluate(resetSimulatorEpisode);
          const runResult = await frame.evaluate(
            async ({ controller, twist, policyUrl }) => {
              const rl = window.rl;
              rl.clearCustomPolicy();
              const reference = rl.sessions.walk;
              const getCommand = rl.controller.getCommand;
              let expectedSession;
              try {
                if (controller === 'bc') {
                  await rl.loadCustomPolicy(policyUrl);
                  if (!rl.customPolicy?.session || rl.sessions.walk !== rl.customPolicy.session) {
                    const state = window.__store?.getState()?.customPolicy;
                    const reason =
                      state?.error || state?.revertReason || 'No active walking session';
                    if (!reason.includes('constant output in smoke run')) throw new Error(reason);
                    return { samples: [], loadRejected: { reason, status: state?.status } };
                  }
                  expectedSession = rl.customPolicy.session;
                } else if (controller === 'zero') {
                  expectedSession = {
                    inputNames: reference.inputNames,
                    outputNames: reference.outputNames,
                    run: async () => ({
                      [reference.outputNames[0]]: new rl.ort.Tensor(
                        'float32',
                        new Float32Array(14),
                        [1, 14],
                      ),
                    }),
                  };
                  rl.sessions.walk = expectedSession;
                } else expectedSession = reference;
                rl.controller.getCommand = () => new Float32Array(twist);
                const commandStarted = performance.now();
                while (
                  twist.some((value, axis) => Math.abs(rl.buildObs()[48 + axis] - value) > 1e-5)
                ) {
                  if (performance.now() - commandStarted > 2000)
                    throw new Error('Requested command never reached policy input');
                  await new Promise((resolve) => setTimeout(resolve, 20));
                }
                const started = performance.now();
                const rows = [];
                while (performance.now() - started < 3000) {
                  const observation = Array.from(rl.buildObs());
                  rows.push({
                    elapsed: (performance.now() - started) / 1000,
                    time: Number(rl.data.time),
                    qpos: Array.from(rl.data.qpos),
                    qvel: Array.from(rl.data.qvel),
                    observation,
                    action: Array.from(rl.lastAction),
                    recovery: rl.recovery,
                    controllerMatches: rl.sessions.walk === expectedSession,
                  });
                  await new Promise((resolve) => setTimeout(resolve, 20));
                }
                return { samples: rows };
              } finally {
                rl.controller.getCommand = getCommand;
                rl.clearCustomPolicy();
                rl.sessions.walk = reference;
              }
            },
            {
              controller,
              twist: command.twist,
              policyUrl: `${base}/api/sim2real/runs/${encodeURIComponent(run.id)}/policy.onnx`,
            },
          );
          if (runResult.loadRejected) {
            episodes.push({
              controller,
              command: command.name,
              desiredCommand: command.twist,
              artifactSha256: run.artifact.sha256,
              runPerformed: false,
              loadRejected: runResult.loadRejected,
              reset,
              passed: false,
            });
            continue;
          }
          const samples = runResult.samples;
          const result = summarizePolicyEpisode(samples, command.twist);
          assert.ok(
            result.finite && result.sampleCount >= 30,
            'The evaluation itself must capture finite actual physics samples',
          );
          const file = `${controller}-${command.name}.jsonl`;
          const content = `${samples.map((sample) => JSON.stringify(sample)).join('\n')}\n`;
          await fs.writeFile(path.join(directory, file), content, { flag: 'wx' });
          episodes.push({
            controller,
            runPerformed: true,
            command: command.name,
            desiredCommand: command.twist,
            reset,
            artifactSha256: controller === 'bc' ? run.artifact.sha256 : null,
            trajectory: `independent-rollouts/${file}`,
            sha256: digest(content),
            ...result,
          });
        }
      }
      const trained = episodes.filter((episode) => episode.controller === 'bc');
      return {
        runId: run.id,
        artifactSha256: run.artifact.sha256,
        episodes,
        qualityPassed: trained.every((episode) => episode.passed),
        trainedRolloutsMeasured: trained.filter((episode) => episode.runPerformed).length,
        status: trained.some((episode) => episode.loadRejected)
          ? 'blocked-policy-loader'
          : trained.every((episode) => episode.passed)
            ? 'passed-diagnostic-quality'
            : 'failed-diagnostic-quality',
        criteria: {
          durationWallSeconds: 3,
          startupGraceSeconds: 0.4,
          minPhysicsSeconds: 2,
          minBaseHeightM: 0.06,
          maxTiltRad: Math.PI / 3,
          maxLinearRmseMps: 0.15,
          maxAngularRmseRadps: 0.4,
          noFallbackOrAutomaticReset: true,
        },
        scope:
          'Fresh reset episodes after training; short deterministic software diagnostics, not release qualification',
        zeroBaseline: '14 zero offsets through the same simulator action session interface',
        independentFromTrainingRows: true,
        releaseQualification: false,
        deployable: false,
        physicalStandOrWalkVerified: false,
      };
    },
  );
}

export async function startDemonstrationWorker({ repositoryRoot, scratch, children }) {
  const selected = resolvePythonInterpreter(
    [process.env.RDK_OFFLINE_BC_PYTHON, ...COMMON_PYTHON_CANDIDATES],
    'import numpy, onnx, onnxruntime',
  );
  if (!selected)
    throw Object.assign(
      new Error(
        'Real BC needs Python numpy, onnx and onnxruntime; set RDK_OFFLINE_BC_PYTHON. No synthetic fallback.',
      ),
      { code: 'MISSING_PYTHON' },
    );
  const probe = spawnSync(selected, ['-c', 'import sys;print(sys.executable)'], {
    encoding: 'utf8',
    timeout: 10000,
  });
  const python = probe.stdout?.trim();
  assert.ok(
    probe.status === 0 && path.isAbsolute(python),
    'BC Worker needs the detected absolute Python executable',
  );
  const workerData = path.join(scratch, 'bc-worker');
  await fs.mkdir(workerData, { mode: 0o700 });
  const workerPort = await freePort();
  const workerBase = `http://127.0.0.1:${workerPort}`;
  const token = randomUUID();
  const worker = service(
    'real-bc-worker',
    process.execPath,
    [path.join(repositoryRoot, 'services/sim2real-web/local-training-worker.mjs')],
    environment({
      RDK_SIM2REAL_LOCAL_WORKER_HOST: '127.0.0.1',
      RDK_SIM2REAL_LOCAL_WORKER_PORT: String(workerPort),
      RDK_SIM2REAL_LOCAL_WORKER_DATA_DIR: workerData,
      RDK_SIM2REAL_LOCAL_RUNNER_TOKEN: token,
      RDK_SIM2REAL_TRAIN_ENGINES_JSON: JSON.stringify({
        'offline-bc': {
          executable: python,
          args: [path.join(repositoryRoot, 'engines/offline-bc/train_bc.py')],
        },
      }),
      RDK_SIM2REAL_TRAIN_TIMEOUT_MS: '120000',
      OMP_NUM_THREADS: '1',
      MKL_NUM_THREADS: '1',
    }),
  );
  children.push(worker);
  await waitReady(
    workerBase,
    worker,
    (body) => body.configured && body.engines.includes('offline-bc'),
  );
  return {
    workerData,
    python,
    environment: {
      RDK_SIM2REAL_LOCAL_RUNNER_URL: `${workerBase}/train`,
      RDK_SIM2REAL_LOCAL_RUNNER_TOKEN: token,
    },
  };
}

async function completedRun(base, runId) {
  const until = Date.now() + 120000;
  while (Date.now() < until) {
    const result = await http(base, `/api/v1/duck/runs/${encodeURIComponent(runId)}`);
    assert.equal(result.status, 200);
    if (['failed', 'blocked'].includes(result.body.run.status))
      throw new Error(`BC run did not train: ${result.body.run.summary}`);
    if (result.body.run.status === 'completed') return result.body.run;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('Actual BC run completion timed out');
}

export async function verifyBrowserBcTraining({
  page,
  base,
  mcp,
  sourceRunId,
  uploadedTrajectory,
  workerData,
  workerPython,
  step,
  output,
}) {
  const source = (await http(base, `/api/v1/duck/runs/${sourceRunId}`)).body.run;
  const recorded = uploadedTrajectory
    .trim()
    .split('\n')
    .map(JSON.parse)
    .filter((row) => Array.isArray(row.observation) && Array.isArray(row.action));
  const sourceHeader = JSON.parse(uploadedTrajectory.split('\n')[0]);
  assert.equal(
    sourceHeader.pairing,
    'policy-inference-v1',
    'Training needs causally paired inference data',
  );
  const previousActionIdentityMse =
    recorded.reduce(
      (total, row) =>
        total +
        row.action.reduce(
          (sum, value, index) => sum + (row.observation[34 + index] - value) ** 2,
          0,
        ),
      0,
    ) /
    (recorded.length * 14);
  assert.ok(
    previousActionIdentityMse > 1e-12,
    'This moving demonstration must not contain labels copied into every previous-action input slot',
  );
  const canonical = recorded
    .map(({ observation, action }) => `${JSON.stringify({ observation, action })}\n`)
    .join('');
  const inputSha256 = digest(canonical);
  const verify = async (run) => {
    assert.notEqual(run.mock, true);
    assert.equal(run.training.engine, 'offline-bc');
    assert.equal(run.trainingData.sourceRunId, sourceRunId);
    assert.equal(run.trainingData.sha256, inputSha256);
    assert.equal(run.metrics.trainingDataSha256, inputSha256);
    assert.equal(run.metrics.syntheticData, false);
    assert.equal(run.metrics.trainingRows + run.metrics.validationRows, recorded.length);
    assert.ok(
      run.metrics.trainLoss < run.metrics.initialTrainLoss,
      'Real training must lower training loss',
    );
    assert.ok(Number.isFinite(run.metrics.validationLoss));
    assert.equal(run.artifact.deployable, false);
    assert.equal(run.artifact.format, 'onnx');
    const job = path.join(workerData, run.externalRunId);
    const request = JSON.parse(await fs.readFile(path.join(job, 'request.json'), 'utf8'));
    assert.equal(
      request.demonstrations.jsonl,
      canonical,
      'The worker must receive the actual uploaded vectors',
    );
    const files = await verifyArtifactManifest(job);
    const policy = files.find((item) => item.name === 'policy.onnx');
    assert.equal(policy.sha256, run.artifact.sha256);
    assert.ok(!files.some((item) => item.name === 'job.json'));
    const result = JSON.parse(await fs.readFile(path.join(job, 'result.json'), 'utf8'));
    assert.equal(result.mock, false, 'The engine must explicitly report real training');
    assert.equal(result.dataset.synthetic, false);
    assert.equal(result.dataset.provenance.sha256, inputSha256);
    const relativeDirectory = `learning-artifacts/${run.id}`;
    const retained = path.join(path.dirname(output), relativeDirectory);
    await fs.mkdir(retained, { recursive: true });
    const retainedFiles = [];
    for (const name of ['policy.onnx', 'model.json', 'SHA256SUMS']) {
      const bytes = await fs.readFile(path.join(job, name));
      await fs.writeFile(path.join(retained, name), bytes, { flag: 'wx' });
      retainedFiles.push({ file: `${relativeDirectory}/${name}`, sha256: digest(bytes) });
    }
    await fs.writeFile(path.join(retained, 'training-input.jsonl'), canonical, { flag: 'wx' });
    retainedFiles.push({ file: `${relativeDirectory}/training-input.jsonl`, sha256: inputSha256 });
    const probe = spawnSync(
      workerPython,
      [
        '-c',
        `
import json, pathlib, sys, numpy as np, onnxruntime as ort
p=pathlib.Path(sys.argv[1]); model=json.loads((p/'model.json').read_text())
session=ort.InferenceSession(str(p/'policy.onnx'),providers=['CPUExecutionProvider'])
rng=np.random.default_rng(42)
probe=rng.uniform(-.05,.05,(2,61)).astype(np.float32)
y=session.run(None,{session.get_inputs()[0].name:probe})[0]
rows=[json.loads(line) for line in (p/'training-input.jsonl').read_text().splitlines()]
x=np.asarray([row['observation'] for row in rows],np.float32)
actual=session.run(None,{session.get_inputs()[0].name:x})[0]
y_recorded=np.asarray([row['action'] for row in rows],np.float32)
std=np.asarray(model['normalization']['std'])
print(json.dumps({
 'inputs':[{'name':v.name,'shape':v.shape,'type':v.type} for v in session.get_inputs()],
 'outputs':[{'name':v.name,'shape':v.shape,'type':v.type} for v in session.get_outputs()],
 'nearZeroProbeMaxOutputDifference':float(np.max(np.abs(y[0]-y[1]))),
 'recordedInputOutputVarianceMean':float(actual.var(axis=0).mean()),
 'previousActionIdentityMse':float(np.mean((x[:,34:48]-y_recorded)**2)),
 'meanActionBaselineMse':float(np.mean((y_recorded-y_recorded.mean(axis=0))**2)),
 'normalizationStdMin':float(std.min()), 'normalizationStdMax':float(std.max()),
 'normalizationStdBelow1eMinus3Slots':np.flatnonzero(std<1e-3).tolist(),
 'probeSeed':42,'probeRange':[-.05,.05],
 'nearZeroProbeIsNotRepresentativePhysicalObservation':True,
}))
`,
        retained,
      ],
      { encoding: 'utf8', timeout: 10000, env: { ...process.env, OMP_NUM_THREADS: '1' } },
    );
    assert.equal(
      probe.status,
      0,
      'Retained actual ONNX must support an independent numerical probe',
    );
    const policyProbe = JSON.parse(probe.stdout.trim());
    return {
      runId: run.id,
      sourceRunId,
      inputSha256,
      rows: recorded.length,
      metrics: run.metrics,
      artifact: run.artifact,
      manifestVerified: true,
      retainedFiles,
      policyProbe,
      sourcePairing: sourceHeader.pairing,
      rowValidationIsNotIndependentEpisodeEvaluation: true,
    };
  };
  let first;
  let tuned;
  await step(
    'BC01.recording-to-training-through-ui',
    'real workbench controls + controlled local Worker',
    async () => {
      await page.goto(`${base}/#train`, { waitUntil: 'domcontentloaded' });
      await page.locator('#train-tab-config').click();
      await page.locator('#training-engine').selectOption('offline-bc');
      await page.waitForFunction(
        (id) =>
          Array.from(document.getElementById('training-demonstration-run')?.options ?? []).some(
            (option) => option.value === id,
          ),
        sourceRunId,
        { timeout: 15000 },
      );
      await page.locator('#training-demonstration-run').selectOption(sourceRunId);
      await page.locator('#training-bc-epochs').fill('100');
      await page.locator('#train-tab-run').click();
      const accepted = page.waitForResponse(
        (response) =>
          /\/api\/(?:sim2real|v1\/duck)\/runs$/.test(new URL(response.url()).pathname) &&
          response.request().method() === 'POST',
      );
      await page.locator('#local-run-button').click();
      const response = await accepted;
      assert.equal(response.status(), 201);
      const submitted = await response.json();
      first = await completedRun(base, submitted.run.id);
      const evidence = await verify(first);
      await page.waitForFunction(
        () =>
          /训练数据已核对/.test(
            document.getElementById('run-progress-bc-result')?.textContent ?? '',
          ),
        undefined,
        { timeout: 20000 },
      );
      evidence.visibleResult = await page.locator('#run-progress-bc-result').textContent();
      assert.match(evidence.visibleResult, /独立轨迹评测/);
      await page.screenshot({
        path: path.join(path.dirname(output), 'demonstration-training.png'),
        fullPage: true,
      });
      return evidence;
    },
  );
  await step(
    'BC02.tuning-through-platform-agent',
    'MCP submission/status with same immutable recording',
    async () => {
      const submitted = await mcp.call('rdk_training_submit', {
        modelId: source.modelId,
        backend: 'local',
        engine: 'offline-bc',
        demonstrationRunId: sourceRunId,
        profile: 'smoke',
        maxIterations: 150,
        idempotencyKey: 'bc-recording-tuned-run',
      });
      assert.equal(submitted.dataUsage.consumptionVerified, false);
      const run = await completedRun(base, submitted.runId);
      tuned = run;
      const evidence = await verify(run);
      const status = await mcp.call('rdk_training_status', { runId: run.id });
      assert.equal(status.dataUsage.consumptionVerified, true);
      assert.equal(status.metrics.epochs, 150);
      assert.equal(status.metrics.trainLoss, run.metrics.trainLoss);
      evidence.previousEpochs = first.metrics.epochs;
      evidence.currentEpochs = run.metrics.epochs;
      evidence.validationDelta = run.metrics.validationLoss - first.metrics.validationLoss;
      evidence.claimsIndependentQualityImprovement = false;
      return evidence;
    },
  );
  await step(
    'BC03.missing-and-incompatible-data-fail-closed',
    'versioned API rejection with no worker fallback',
    async () => {
      for (const [demonstrationRunId, training] of [
        ['missing-recording', { profile: 'smoke', engine: 'offline-bc' }],
        [sourceRunId, { profile: 'smoke', engine: 'act' }],
      ]) {
        const response = await http(
          base,
          '/api/v1/duck/runs',
          { modelId: source.modelId, backend: 'local', training, demonstrationRunId },
          { key: randomUUID() },
        );
        assert.ok(
          [400, 404, 422].includes(response.status),
          'Invalid source requests must fail before creating an alternate training',
        );
      }
      const trained = await http(base, `/api/v1/duck/runs/${first.id}/telemetry`);
      assert.equal(trained.status, 200);
      assert.equal(
        trained.body.telemetry.length,
        0,
        'Training inputs must not be relabeled as independent trained-policy rollout',
      );
      assert.equal(first.artifact.deployable, false);
      return {
        invalidSourceRejected: true,
        incompatibleEngineRejected: true,
        noSyntheticFallback: true,
        noFabricatedEvaluation: true,
        deploymentStillRequiresQualityEvidence: true,
      };
    },
  );
  return evaluateIndependentPolicyRollouts({ page, base, run: tuned, output, step });
}
