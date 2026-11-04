import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shortTraining } from '../plugins/rdk-robot-learning-platform/scripts/short-training.mjs';
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'short-course-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const writes = [];
  let valid = true,
    online = true,
    terminal = 'completed';
  const manifest = JSON.parse(
    fs.readFileSync(
      new URL(
        '../plugins/rdk-robot-learning-platform/references/originman-manifest.json',
        import.meta.url,
      ),
    ),
  );
  const hash = 'a'.repeat(64);
  const origin = (id, phase = 'train') => ({
    id,
    modelId: 'model',
    status: id === 'old' ? 'completed' : terminal,
    mock: false,
    backend: 'local',
    taskId: 'originman-recovery',
    contractId: 'custom-policy-originman-recovery-v1',
    computeResourceId: 'worker',
    training: {
      engine: 'originman-recovery-reflect',
      algorithm: 'sac',
      numEnvs: 4,
      originmanWorkshop: {
        phase,
        timesteps: 8192,
        seed: 7,
        pushMaxForce: 8.1,
        groupId: 'om-test',
        ...(phase === 'evaluate' ? { sourceRunId: 'train' } : {}),
      },
    },
    artifact: { sha256: hash },
    metrics: {
      contractValid: true,
      observationSize: 14,
      actionSize: 2,
      originmanWorkshop: {
        phase,
        policySha256: hash,
        ...(phase === 'evaluate' ? { sourceRunId: 'train' } : {}),
      },
    },
  });
  const call = async (name, args) => {
    switch (name) {
      case 'rdk_platform_status':
        return {
          ok: true,
          baseUrl: 'https://example.test',
          health: { ready: true },
          session: { authenticated: true, accountId: 'test' },
        };
      case 'rdk_model_validate':
        assert.equal(args.manifest.contract.observationSize, 14);
        return { valid, errors: valid ? [] : ['contract rejected'] };
      case 'rdk_models_list':
        return { models: [{ id: 'model', manifest }] };
      case 'rdk_runs_list':
        return { runs: [{ id: 'old', modelId: 'model', taskId: 'originman-recovery' }] };
      case 'rdk_lineage_get':
        return { lineage: { run: origin(args.runId) } };
      case 'rdk_compute_resources_list':
        return { computeResources: [{ id: 'worker' }] };
      case 'rdk_compute_resource_test':
        return {
          id: 'worker',
          ok: online,
          status: online ? 'online' : 'offline',
          connected: online,
          mock: false,
          cuda: true,
        };
      case 'rdk_originman_training_preflight':
        return {
          computeResourceId: 'worker',
          report: {
            schemaVersion: 1,
            engine: 'originman-recovery-reflect',
            taskId: 'originman-recovery',
            device: 'cuda',
            trainingPerformed: false,
            readyForSmokeTraining: true,
          },
        };
      case 'rdk_training_status': {
        const r = origin(args.runId, args.runId === 'eval' ? 'evaluate' : 'train');
        return { ...r, runId: r.id };
      }
      case 'rdk_training_submit':
        writes.push(args);
        return {
          runId: args.originmanWorkshop.phase === 'train' ? 'train' : 'eval',
          status: 'queued',
        };
      default:
        throw Error('Unexpected ' + name);
    }
  };
  return {
    call,
    writes,
    options: {
      directory,
      toolNames: ['rdk_compute_resource_test', 'rdk_originman_training_preflight'],
    },
    setValid: (v) => (valid = v),
    setOnline: (v) => (online = v),
    setTerminal: (v) => (terminal = v),
  };
}
test('full fixed training request and repeated context never writes twice', async (t) => {
  const f = fixture(t);
  await shortTraining('rdk_originman_short_train', { contextId: 'om-test' }, f.call, f.options);
  assert.equal(f.writes.length, 1);
  const a = f.writes[0];
  assert.equal(a.originmanWorkshop.groupId, 'om-test');
  assert.equal(a.originmanWorkshop.device, 'cuda');
  assert.equal(a.video, false);
  assert.equal(a.engine, 'originman-recovery-reflect');
  assert.equal(a.idempotencyKey, 'om-test-train');
  await shortTraining('rdk_originman_short_train', { contextId: 'om-test' }, f.call, f.options);
  assert.equal(f.writes.length, 1);
});
test('invalid manifest or offline original resource cannot submit or switch', async (t) => {
  const f = fixture(t);
  f.setValid(false);
  await assert.rejects(
    shortTraining('rdk_originman_short_train', { contextId: 'om-test' }, f.call, f.options),
    /manifest/,
  );
  f.setValid(true);
  f.setOnline(false);
  await assert.rejects(
    shortTraining('rdk_originman_short_train', { contextId: 'om-test' }, f.call, f.options),
    /资源/,
  );
  assert.equal(f.writes.length, 0);
});
test('evaluation freezes source, seed, group and resource; second request is read only', async (t) => {
  const f = fixture(t);
  await shortTraining('rdk_originman_short_train', { contextId: 'om-test' }, f.call, f.options);
  await shortTraining('rdk_originman_short_evaluate', { contextId: 'om-test' }, f.call, f.options);
  assert.equal(f.writes.length, 2);
  assert.equal(f.writes[1].originmanWorkshop.sourceRunId, 'train');
  assert.equal(f.writes[1].originmanWorkshop.seed, f.writes[0].originmanWorkshop.seed);
  assert.equal(f.writes[1].computeResourceId, 'worker');
  assert.equal(f.writes[1].video, true);
  await shortTraining('rdk_originman_short_evaluate', { contextId: 'om-test' }, f.call, f.options);
  assert.equal(f.writes.length, 2);
});
test('failed training remains original failed run and cannot evaluate or resubmit', async (t) => {
  const f = fixture(t);
  f.setTerminal('failed');
  await shortTraining('rdk_originman_short_train', { contextId: 'om-test' }, f.call, f.options);
  await shortTraining('rdk_originman_short_train', { contextId: 'om-test' }, f.call, f.options);
  await assert.rejects(
    shortTraining('rdk_originman_short_evaluate', { contextId: 'om-test' }, f.call, f.options),
    /训练未完成/,
  );
  assert.equal(f.writes.length, 1);
});

test('first course training uses the registered manifest without requiring a previous Run', async (t) => {
  const f = fixture(t);
  const manifest = JSON.parse(
    fs.readFileSync(
      new URL(
        '../plugins/rdk-robot-learning-platform/references/originman-manifest.json',
        import.meta.url,
      ),
    ),
  );
  const call = async (name, args) => {
    if (name === 'rdk_models_list') return { models: [{ id: 'model', manifest }] };
    if (name === 'rdk_runs_list') throw Error('first training must not depend on historical runs');
    return f.call(name, args);
  };
  await shortTraining('rdk_originman_short_train', { contextId: 'om-test' }, call, f.options);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].modelId, 'model');
});
test('a new learner can register the bundled course model after resource readiness, once', async (t) => {
  const f = fixture(t);
  let registered = 0;
  const call = async (name, args) => {
    if (name === 'rdk_models_list') return { models: [] };
    if (name === 'rdk_runs_list') throw Error('no historical runs exist');
    if (name === 'rdk_model_register') {
      registered++;
      assert.equal(args.manifest.modelId, 'originman-recovery-workshop');
      assert.match(args.idempotencyKey, /^originman-course-/);
      return { id: 'model', contractId: args.manifest.contract.id };
    }
    return f.call(name, args);
  };
  await shortTraining('rdk_originman_short_train', { contextId: 'om-test' }, call, f.options);
  await shortTraining('rdk_originman_short_train', { contextId: 'om-test' }, call, f.options);
  assert.equal(registered, 1);
  assert.equal(f.writes.length, 1);
});
test('an offline new learner does not create a model or training job', async (t) => {
  const f = fixture(t);
  f.setOnline(false);
  let registered = 0;
  const call = async (name, args) => {
    if (name === 'rdk_models_list') return { models: [] };
    if (name === 'rdk_model_register') {
      registered++;
      return { id: 'model' };
    }
    return f.call(name, args);
  };
  await assert.rejects(
    shortTraining('rdk_originman_short_train', { contextId: 'om-test' }, call, f.options),
    /资源/,
  );
  assert.equal(registered, 0);
  assert.equal(f.writes.length, 0);
});
test('multiple resources require a named selection and never silently choose the first', async (t) => {
  const f = fixture(t);
  const manifest = JSON.parse(
    fs.readFileSync(
      new URL(
        '../plugins/rdk-robot-learning-platform/references/originman-manifest.json',
        import.meta.url,
      ),
    ),
  );
  const call = async (name, args) => {
    if (name === 'rdk_models_list') return { models: [{ id: 'model', manifest }] };
    if (name === 'rdk_compute_resources_list')
      return {
        computeResources: [
          { id: 'worker', name: 'OriginMan course A' },
          { id: 'worker-b', name: 'OriginMan course B' },
        ],
      };
    return f.call(name, args);
  };
  await assert.rejects(
    shortTraining('rdk_originman_short_train', { contextId: 'om-test' }, call, f.options),
    (e) =>
      e.platformCode === 'WORKSHOP_RESOURCE_SELECTION_REQUIRED' && e.details.choices.length === 2,
  );
  assert.equal(f.writes.length, 0);
  await shortTraining(
    'rdk_originman_short_train',
    { contextId: 'om-test', computeResourceId: 'worker' },
    call,
    f.options,
  );
  assert.equal(f.writes.length, 1);
});

test('a lost submission reply never issues a second POST for the same experiment', async (t) => {
  const f = fixture(t);
  let submissions = 0;
  const call = async (name, args) => {
    if (name === 'rdk_training_submit') {
      submissions++;
      throw new TypeError('fixture connection reset after submission');
    }
    return f.call(name, args);
  };
  await assert.rejects(
    shortTraining('rdk_originman_short_train', { contextId: 'om-test' }, call, f.options),
  );
  await assert.rejects(
    shortTraining('rdk_originman_short_train', { contextId: 'om-test' }, call, f.options),
    (e) => e.platformCode === 'SUBMISSION_RESULT_UNKNOWN',
  );
  assert.equal(submissions, 1);
});
test('concurrent double-clicks submit one job and keep the original experiment key', async (t) => {
  const f = fixture(t);
  const results = await Promise.allSettled([
    shortTraining('rdk_originman_short_train', { contextId: 'om-test' }, f.call, f.options),
    shortTraining('rdk_originman_short_train', { contextId: 'om-test' }, f.call, f.options),
  ]);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].idempotencyKey, 'om-test-train');
  assert.ok(results.some((r) => r.status === 'fulfilled'));
});
test('a visible CPU-only resource cannot silently downgrade the GPU recipe', async (t) => {
  const f = fixture(t);
  const call = async (name, args) =>
    name === 'rdk_compute_resource_test'
      ? { id: 'worker', ok: true, status: 'online', connected: true, cuda: false }
      : f.call(name, args);
  await assert.rejects(
    shortTraining('rdk_originman_short_train', { contextId: 'om-test' }, call, f.options),
    /GPU/,
  );
  assert.equal(f.writes.length, 0);
});

test('an acknowledged Run with an interrupted bookmark recovers by querying, without resource preparation', async (t) => {
  const f = fixture(t);
  let failRemember = true,
    recovery = false;
  const call = async (name, args) => {
    if (name === 'rdk_training_status' && failRemember) {
      failRemember = false;
      throw Error('fixture bookmark interrupted');
    }
    if (
      recovery &&
      [
        'rdk_model_validate',
        'rdk_models_list',
        'rdk_compute_resources_list',
        'rdk_compute_resource_test',
        'rdk_training_submit',
      ].includes(name)
    )
      throw Error('recovery must only query the original Run');
    return f.call(name, args);
  };
  await assert.rejects(
    shortTraining('rdk_originman_short_train', { contextId: 'om-test' }, call, f.options),
    (e) => e.platformCode === 'SUBMISSION_REFERENCE_SAVE_FAILED' && e.details.runId === 'train',
  );
  recovery = true;
  const result = await shortTraining(
    'rdk_originman_short_train',
    { contextId: 'om-test' },
    call,
    f.options,
  );
  assert.equal(result.recoveredReceipt, true);
  assert.equal(result.experiment.training.runId, 'train');
  assert.equal(f.writes.length, 1);
});

test('repeating an explicit resource remains idempotent when the core status projection omits its resource ID', async (t) => {
  const f = fixture(t);
  const call = async (name, args) => {
    const result = await f.call(name, args);
    if (name === 'rdk_training_status') {
      const { computeResourceId, ...compact } = result;
      return compact;
    }
    return result;
  };
  await shortTraining(
    'rdk_originman_short_train',
    { contextId: 'om-test', computeResourceId: 'worker' },
    call,
    f.options,
  );
  const repeated = await shortTraining(
    'rdk_originman_short_train',
    { contextId: 'om-test', computeResourceId: 'worker' },
    call,
    f.options,
  );
  assert.equal(repeated.alreadySubmitted, true);
  assert.equal(f.writes.length, 1);
});

test('busy preflight keeps the selected Worker and never submits a job', async (t) => {
  const f = fixture(t);
  const call = async (name, args) => {
    if (name === 'rdk_originman_training_preflight')
      throw Object.assign(new Error('Worker busy'), {
        platformCode: 'SIM2REAL_ENGINE_PREFLIGHT_BUSY',
        httpStatus: 429,
      });
    return f.call(name, args);
  };
  await assert.rejects(
    shortTraining('rdk_originman_short_train', { contextId: 'om-test' }, call, f.options),
    (error) =>
      error.platformCode === 'SIM2REAL_ENGINE_PREFLIGHT_BUSY' &&
      error.httpStatus === 429 &&
      error.details?.computeResourceId === 'worker' &&
      error.details?.trainingSubmitted === false &&
      /同一资源/.test(error.nextAction),
  );
  assert.equal(f.writes.length, 0);
});

test('a configured course resource cannot be overridden before any platform call', async (t) => {
  const f = fixture(t);
  let reads = 0;
  await assert.rejects(
    shortTraining(
      'rdk_originman_short_train',
      { contextId: 'om-test', computeResourceId: 'different-worker' },
      async () => {
        reads++;
      },
      { ...f.options, defaultResourceId: 'worker' },
    ),
    (e) => e.platformCode === 'WORKSHOP_RESOURCE_LOCKED' && e.stopWorkflow === true,
  );
  assert.equal(reads, 0);
  assert.equal(f.writes.length, 0);
  await shortTraining('rdk_originman_short_train', { contextId: 'om-test' }, f.call, {
    ...f.options,
    defaultResourceId: 'worker',
  });
  assert.equal(f.writes[0].computeResourceId, 'worker');
});
