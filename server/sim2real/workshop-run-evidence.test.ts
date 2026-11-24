import { beforeEach, expect, it, vi } from 'vitest';
import type { Sim2RealRunRecord } from '../../shared/sim2real.js';
import { getWorkshopRun, readWorkshopRunEvidence } from './workshop-run-evidence.js';

const store = vi.hoisted(() => ({
  getSim2RealRun: vi.fn(),
  getSim2RealComputeResourceSecret: vi.fn(),
  updateSim2RealRun: vi.fn(),
}));
const worker = vi.hoisted(() => vi.fn());
vi.mock('./sim2real-store.js', () => store);
vi.mock('./local-runner.js', () => ({ requestLocalTrainingStatus: worker }));

const sha256 = 'c'.repeat(64);
const config = { phase: 'train', timesteps: 8192, seed: 7, pushMaxForce: 25 };
const run = {
  id: 'legacy-run',
  status: 'completed',
  mock: false,
  backend: 'local',
  computeResourceId: 'resource',
  externalRunId: 'original-worker-job',
  taskId: 'originman-recovery',
  training: { engine: 'originman-recovery', originmanWorkshop: config },
  metrics: { cuda: true },
  artifact: { sha256 },
};
const receipt = {
  phase: 'train',
  requestedTimesteps: 8192,
  seed: 7,
  pushMaxForce: 25,
  policySha256: sha256,
};
const result = {
  status: 'completed',
  mock: false,
  externalRunId: run.externalRunId,
  metrics: { engine: run.training.engine, originmanWorkshop: receipt },
  artifact: { sha256 },
};

beforeEach(() => {
  vi.resetAllMocks();
  store.getSim2RealRun.mockResolvedValue(run);
  store.getSim2RealComputeResourceSecret.mockResolvedValue({
    resource: { runnerUrl: 'https://worker.example/train' },
    runnerToken: 'fixture',
  });
  store.updateSim2RealRun.mockImplementation(async (_id, patch) => ({ ...run, ...patch }));
  worker.mockResolvedValue(result);
});

it('recovers once from the original account, job and policy', async () => {
  const recovered = await getWorkshopRun(run.id, 'alice');
  expect(recovered?.metrics?.originmanWorkshop).toEqual(receipt);
  expect(worker).toHaveBeenCalledWith(
    expect.objectContaining({ accountId: 'alice', externalRunId: run.externalRunId }),
  );
  expect(store.updateSim2RealRun).toHaveBeenCalledWith(
    run.id,
    expect.objectContaining({ metrics: { ...result.metrics, cuda: true } }),
    'alice',
  );
  store.getSim2RealRun.mockResolvedValue(recovered);
  await getWorkshopRun(run.id, 'alice');
  expect(worker).toHaveBeenCalledTimes(1);
});

it.each([
  { artifact: { sha256: 'b'.repeat(64) } },
  { externalRunId: 'different-job' },
  { mock: true },
  { metrics: { ...result.metrics, originmanWorkshop: { ...receipt, seed: 99 } } },
])('leaves incompatible historical evidence untouched', async (mismatch) => {
  worker.mockResolvedValue({ ...result, ...mismatch });
  expect(await getWorkshopRun(run.id, 'alice')).toBe(run);
  expect(store.updateSim2RealRun).not.toHaveBeenCalled();
});

it('consults the account ledger before contacting a worker', async () => {
  store.getSim2RealRun.mockResolvedValue(null);
  expect(await getWorkshopRun(run.id, 'bob')).toBeNull();
  expect(store.getSim2RealRun).toHaveBeenCalledWith(run.id, 'bob');
  expect(worker).not.toHaveBeenCalled();
});

it.each([
  [new Error('bad gateway'), 'worker-unavailable'],
  [Object.assign(new Error('not found'), { runnerNotFound: true }), 'job-missing'],
])(
  'preserves finished training and reports the cause of a failed receipt lookup',
  async (error, issue) => {
    worker.mockRejectedValue(error);
    expect(await readWorkshopRunEvidence(run as unknown as Sim2RealRunRecord, 'alice')).toEqual({
      run,
      workshopEvidenceIssue: issue,
    });
    expect(store.updateSim2RealRun).not.toHaveBeenCalled();
  },
);

it('identifies a missing receipt and accepts a matching one after the worker recovers', async () => {
  worker.mockResolvedValueOnce({ ...result, metrics: { engine: run.training.engine } });
  expect(await readWorkshopRunEvidence(run as unknown as Sim2RealRunRecord, 'alice')).toEqual({
    run,
    workshopEvidenceIssue: 'receipt-missing',
  });
  expect(
    (await readWorkshopRunEvidence(run as unknown as Sim2RealRunRecord, 'alice')).run.metrics
      ?.originmanWorkshop,
  ).toEqual(receipt);
});
