import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectWorkflow } from '../plugins/rdk-robot-learning-platform/scripts/workflow-inspection.mjs';
import {
  assessOnboarding,
  onboardingGuide,
  STAGES as ACCEPTANCE_STAGES,
} from '../plugins/rdk-robot-learning-platform/scripts/robot-onboarding.mjs';
const now = 1800000000000;

const acceptanceIdentity = {
  robotId: 'originman-lab-01',
  adapterSha256: 'a'.repeat(64),
  calibrationSha256: 'b'.repeat(64),
  policySha256: 'c'.repeat(64),
  runtimeSha256: 'd'.repeat(64),
};
function acceptanceEvidence(
  stage,
  facts = Object.fromEntries(ACCEPTANCE_STAGES[stage].map((key) => [key, true])),
) {
  return {
    stage,
    identity: acceptanceIdentity,
    observedAt: '2026-11-09T00:00:00.000Z',
    expiresAt: '2026-12-09T00:00:00.000Z',
    receiptSha256: 'e'.repeat(64),
    facts,
  };
}
function acceptanceRecordWithoutSimulation() {
  return {
    schemaVersion: 1,
    identity: acceptanceIdentity,
    evidence: Object.keys(ACCEPTANCE_STAGES)
      .filter((stage) => stage !== 'simulation')
      .map((stage) => acceptanceEvidence(stage)),
    unresolvedFaults: [],
  };
}

test('generic Sim2Real simulation gate is exposed for every task profile', () => {
  const guide = onboardingGuide();
  assert.equal(guide.motionAuthorized, false);
  assert.deepEqual(guide.stageCriteria.simulation, [
    'taskSuccessCriteriaMet',
    'heldOutScenariosPassed',
    'simToRealPerturbationsEvaluated',
    'actionLimitsRespected',
    'failureRecoveryEvaluated',
    'environmentAndPolicyPinned',
  ]);
  assert.match(guide.instructions, /所有任务共用simulation迁移门槛/);
});

test('hardware stages remain blocked until simulation evidence is present', () => {
  const result = assessOnboarding(
    { record: acceptanceRecordWithoutSimulation() },
    Date.parse('2026-11-10T00:00:00.000Z'),
  );
  const simulation = result.stages.find((stage) => stage.stage === 'simulation');
  const shadow = result.stages.find((stage) => stage.stage === 'shadow');
  assert.equal(simulation.status, 'missing');
  assert.deepEqual(simulation.issues, ['no-evidence']);
  assert.equal(shadow.status, 'blocked-by-prerequisite');
  assert.equal(result.hardwareEligible, false);
  assert.equal(result.motionAuthorized, false);
});

test('documented simulation evidence does not itself authorize hardware motion', () => {
  const record = acceptanceRecordWithoutSimulation();
  record.evidence.push(acceptanceEvidence('simulation'));
  const result = assessOnboarding({ record }, Date.parse('2026-11-10T00:00:00.000Z'));
  assert.equal(result.stages.find((stage) => stage.stage === 'simulation').status, 'documented');
  assert.equal(result.evidenceCoverageComplete, true);
  assert.equal(result.hardwareEligible, false);
  assert.equal(result.motionAuthorized, false);
  assert.equal(result.receiptsIndependentlyVerified, false);
});

test('failed task-agnostic robustness checks keep the simulation gate open', () => {
  const record = acceptanceRecordWithoutSimulation();
  const facts = Object.fromEntries(ACCEPTANCE_STAGES.simulation.map((key) => [key, true]));
  facts.heldOutScenariosPassed = false;
  record.evidence.push(acceptanceEvidence('simulation', facts));
  const result = assessOnboarding({ record }, Date.parse('2026-11-10T00:00:00.000Z'));
  const simulation = result.stages.find((stage) => stage.stage === 'simulation');
  assert.equal(simulation.status, 'needs-review');
  assert.deepEqual(simulation.issues, ['heldOutScenariosPassed']);
  assert.equal(result.evidenceCoverageComplete, false);
  assert.equal(result.motionAuthorized, false);
});
test('OriginMan inspection binds its evaluation Run and never reuses MicroDuck quality', async () => {
  const sha = 'a'.repeat(64);
  const tools = ['rdk_platform_status', 'rdk_workshop_catalog', 'rdk_training_status'];
  for (const wrong of [false, true]) {
    const calls = [];
    const r = await inspectWorkflow(
      { productId: 'originman', runId: 'train', evaluationRunId: 'eval' },
      async (name, args) => {
        calls.push([name, args]);
        if (name === 'rdk_platform_status')
          return {
            ok: true,
            health: { ready: true, degraded: ['microduck-not-mounted'] },
            session: { authenticated: true },
          };
        if (name === 'rdk_workshop_catalog')
          return {
            robot: 'originman',
            simulationOnly: true,
            manifest: {
              contract: {
                id: 'custom-policy-originman-recovery-v1',
                observationSize: 14,
                actionSize: 2,
              },
            },
          };
        return {
          runId: args.runId,
          modelId: 'origin-model',
          status: 'completed',
          metrics: {
            originmanWorkshop:
              args.runId === 'train'
                ? {
                    phase: 'train',
                    hardwareEligible: false,
                    policySha256: sha,
                    actualTimesteps: 4096,
                  }
                : {
                    phase: 'evaluate',
                    hardwareEligible: false,
                    policySha256: sha,
                    sourceRunId: wrong ? 'another-group' : 'train',
                    cases: Array(31).fill({}),
                    baselineRecovered: 13,
                    rlRecovered: 13,
                    clearGain: false,
                  },
          },
        };
      },
      tools,
      { now },
    );
    assert.equal(r.stages.find((s) => s.id === 'evaluate').state, wrong ? 'blocked' : 'completed');
    // The retained course explicitly ends in simulation; an omitted hardware
    // exercise is not a failed deployment and must never trigger a deploy call.
    assert.equal(r.stages.find((s) => s.id === 'deploy').state, 'not_applicable');
    assert.ok(calls.every(([name]) => !name.includes('deployment')));
    assert.ok(calls.every(([name]) => !name.includes('physical_evaluation')));
    if (!wrong) assert.match(r.markdown, /未达明显收益/);
  }
});

test('OriginMan preparation never previews PPO or accepts another task', async () => {
  const { prepareTraining } =
    await import('../plugins/rdk-robot-learning-platform/scripts/workflow-inspection.mjs');
  const calls = [];
  const call = async (name, args) => {
    calls.push([name, args]);
    return name === 'rdk_compute_resource_test'
      ? { id: 'cpu', connected: true, mock: false }
      : {
          computeResourceId: 'cpu',
          report: {
            readyForSmokeTraining: true,
            taskId: 'originman-recovery',
            engine: 'originman-recovery-reflect',
            device: 'cuda',
          },
        };
  };
  const r = await prepareTraining({ productId: 'originman', computeResourceId: 'cpu' }, call);
  assert.equal(r.preview.arguments.engine, 'originman-recovery');
  assert.equal(r.preview.arguments.algorithm, 'sac');
  assert.equal(r.preview.arguments.originmanWorkshop.timesteps, 500000);
  assert.equal(calls[1][1].taskId, 'originman-recovery');
  await assert.rejects(
    prepareTraining({ productId: 'originman', computeResourceId: 'cpu', taskId: 'walk' }, call),
  );
});
const names = [
  'rdk_platform_status',
  'rdk_workspace_overview',
  'rdk_compute_resources_list',
  'rdk_lineage_get',
  'rdk_training_preflight',
  'rdk_physical_evaluation_status',
];
function fixture(overrides = {}) {
  const reads = [];
  const data = {
    rdk_platform_status: {
      ok: true,
      canAccessWorkspace: true,
      health: { ready: true, degraded: [] },
      session: { authenticated: true },
    },
    rdk_workspace_overview: { integrations: { simulator: { available: true } } },
    rdk_compute_resources_list: {
      computeResources: [
        { id: 'gpu', status: 'online', lastCheckedAt: new Date(now - 1000).toISOString() },
      ],
    },
    rdk_lineage_get: {
      lineage: {
        run: { id: 'run', status: 'completed', taskId: 'walk', artifact: { deployable: false } },
      },
    },
    rdk_training_preflight: { report: { readyForSmokeTraining: true } },
    ...overrides,
  };
  return {
    reads,
    call: async (name, args) => {
      reads.push([name, args]);
      const v = data[name];
      if (v instanceof Error) throw v;
      return v;
    },
  };
}
test('workflow separates completed training from deployability and independent quality', async () => {
  const f = fixture();
  const r = await inspectWorkflow({ runId: 'run', computeResourceId: 'gpu' }, f.call, names, {
    now,
  });
  assert.equal(r.stages.find((s) => s.id === 'train').state, 'completed');
  assert.equal(r.stages.find((s) => s.id === 'deploy').state, 'blocked');
  assert.equal(r.stages.find((s) => s.id === 'evaluate').state, 'needs_input');
  assert.equal(r.verdict, 'blocked');
  assert.match(r.markdown, /独立评测/);
  assert.ok(Object.values(r.execution).every((v) => v === false));
});
test('offline, stale and unknown resources cannot be presented as ready', async () => {
  for (const resource of [
    { id: 'gpu', status: 'offline', message: 'GPU 正常' },
    { id: 'gpu', status: 'online', lastCheckedAt: new Date(now - 700000).toISOString() },
    { id: 'gpu', status: 'unknown', message: '连接正常' },
  ]) {
    const f = fixture({ rdk_compute_resources_list: { computeResources: [resource] } });
    const r = await inspectWorkflow({ computeResourceId: 'gpu' }, f.call, names, { now });
    assert.notEqual(r.stages.find((s) => s.id === 'compute').state, 'ready');
  }
});
test('missing interfaces are visible without falling back to another platform or a write', async () => {
  const error = Object.assign(new Error('API 路径不存在'), {
    httpStatus: 404,
    platformCode: 'SIM2REAL_API_NOT_FOUND',
  });
  const f = fixture({ rdk_training_preflight: error });
  const r = await inspectWorkflow({ computeResourceId: 'gpu' }, f.call, names, { now });
  assert.equal(r.stages.find((s) => s.id === 'environment').state, 'blocked');
  assert.ok(r.observations.some((o) => o.httpStatus === 404));
  assert.ok(f.reads.every(([name]) => names.includes(name)));
});
test('authentication failure stops workspace access; explicit unknown Run is not replaced', async () => {
  const f = fixture({
    rdk_platform_status: { ok: true, health: { ready: true }, session: { authenticated: false } },
  });
  const r = await inspectWorkflow({}, f.call, names, { now });
  assert.equal(r.verdict, 'blocked');
  assert.equal(f.reads.length, 1);
  const x = fixture({
    rdk_lineage_get: { lineage: { run: { id: 'other', status: 'completed' } } },
  });
  const report = await inspectWorkflow({ runId: 'requested' }, x.call, names, { now });
  assert.equal(report.stages.find((s) => s.id === 'train').state, 'blocked');
  assert.deepEqual(x.reads.find(([name]) => name === 'rdk_lineage_get')[1], { runId: 'requested' });
});
test('another product does not inherit MicroDuck preflight or simulation success', async () => {
  const f = fixture();
  const r = await inspectWorkflow({ productId: 'another-robot' }, f.call, names, { now });
  assert.equal(f.reads.length, 1);
  assert.equal(r.verdict, 'incomplete');
  assert.equal(r.stages.find((s) => s.id === 'product').state, 'unknown');
});
test('invalid input and unknown comparison cannot turn incomplete quality into success', async () => {
  const f = fixture({ rdk_physical_evaluation_status: { status: 'completed' } });
  await assert.rejects(inspectWorkflow({ runId: '' }, f.call, names, { now }));
  const r = await inspectWorkflow({ evaluationId: 'eval' }, f.call, names, { now });
  assert.equal(r.stages.find((s) => s.id === 'evaluate').state, 'unknown');
  assert.equal(r.stages.find((s) => s.id === 'tune').state, 'unknown');
});

test('quality requires the same Run, exact digest, real independent report and complete evidence', async () => {
  const sha = 'a'.repeat(64);
  const evaluation = {
    ok: true,
    evaluation: {
      id: 'eval',
      runId: 'run',
      status: 'passed',
      source: 'runner',
      execution: { kind: 'microduck-physics', policySha256: sha },
      taskEvaluation: {
        reportSha256: 'b'.repeat(64),
        dynamicsFacts: { policySha256: sha },
        harnessQualification: { passed: true },
        trained: {
          envelopes: {
            nominal: { episodes: 50, successRate: 1 },
            hard: { episodes: 50, successRate: 1 },
          },
        },
        qualityGate: { passed: true },
      },
    },
    qualityConclusion: { conclusive: true, passed: true },
  };
  const toolNames = [...names, 'rdk_training_status'];
  for (const variation of ['valid', 'wrong-run', 'wrong-sha', 'missing-report']) {
    const ev = structuredClone(evaluation);
    if (variation === 'wrong-run') ev.evaluation.runId = 'other';
    if (variation === 'wrong-sha') ev.evaluation.execution.policySha256 = 'c'.repeat(64);
    if (variation === 'missing-report') delete ev.evaluation.taskEvaluation.reportSha256;
    const f = fixture({
      rdk_training_status: {
        runId: 'run',
        status: 'completed',
        mock: false,
        artifactRetention: { state: 'retained', sha256: sha },
      },
      rdk_physical_evaluation_status: ev,
    });
    const r = await inspectWorkflow({ runId: 'run', evaluationId: 'eval' }, f.call, toolNames, {
      now,
    });
    assert.equal(
      r.stages.find((s) => s.id === 'evaluate').state,
      variation === 'valid' ? 'completed' : variation === 'missing-report' ? 'unknown' : 'blocked',
    );
  }
});

test('new-training preparation refreshes health before environment without submitting a job', async () => {
  const { prepareTraining } =
    await import('../plugins/rdk-robot-learning-platform/scripts/workflow-inspection.mjs');
  const calls = [];
  const call = async (name, args) => {
    calls.push([name, args]);
    return name === 'rdk_compute_resource_test'
      ? { id: 'gpu', connected: true, mock: false, browserRelay: false }
      : { computeResourceId: 'gpu', report: { readyForSmokeTraining: true } };
  };
  const r = await prepareTraining({ computeResourceId: 'gpu', taskId: 'walk' }, call);
  assert.equal(r.status, 'prepared');
  assert.equal(r.trainingSubmitted, false);
  assert.deepEqual(
    calls.map((x) => x[0]),
    ['rdk_compute_resource_test', 'rdk_training_preflight'],
  );
  const stopped = [];
  const bad = await prepareTraining({ computeResourceId: 'gpu' }, async (name) => {
    stopped.push(name);
    return { id: 'gpu', connected: false, mock: false };
  });
  assert.equal(bad.status, 'blocked');
  assert.equal(stopped.length, 1);
});

test('older cores without task preflight return an explicit limitation without calling a missing tool', async () => {
  const { prepareTraining } =
    await import('../plugins/rdk-robot-learning-platform/scripts/workflow-inspection.mjs');
  const calls = [];
  const result = await prepareTraining(
    { productId: 'originman', computeResourceId: 'gpu' },
    async (name) => {
      calls.push(name);
      if (name !== 'rdk_compute_resource_test') throw new Error('unknown tool');
      return { id: 'gpu', connected: true, browserRelay: false };
    },
    ['rdk_compute_resource_test'],
  );
  assert.equal(result.status, 'incomplete');
  assert.equal(result.trainingSubmitted, false);
  assert.equal(result.taskEnvironmentVerified, false);
  assert.deepEqual(result.unsupportedTools, ['rdk_training_preflight']);
  assert.deepEqual(calls, ['rdk_compute_resource_test']);
});
