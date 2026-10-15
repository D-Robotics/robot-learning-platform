import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_MICRODUCK_MODEL,
  type Sim2RealRunRecord,
  type Sim2RealTelemetryRecord,
} from '../../shared/sim2real.js';
import {
  buildTrainingDemonstrations,
  TrainingDemonstrationError,
} from './training-demonstrations.js';
import { telemetryRevision } from './sim2real-store.js';

const contract = BUILTIN_MICRODUCK_MODEL.manifest.contract;
const run: Sim2RealRunRecord = {
  id: 'recording-1',
  modelId: BUILTIN_MICRODUCK_MODEL.id,
  contractId: contract.id,
  backend: 'browser',
  status: 'ready',
  summary: 'recording',
  createdAt: '2026-10-14T00:00:00Z',
};
function chunk(): Sim2RealTelemetryRecord {
  return {
    id: 'chunk-1',
    runId: run.id,
    modelId: run.modelId,
    contractId: contract.id,
    source: 'browser',
    receivedAt: '2026-10-14T00:00:01Z',
    samples: Array.from({ length: 12 }, (_, i) => ({
      t: i / 50,
      pairing: 'policy-inference-v1',
      observation: Array(contract.observationSize).fill(i / 10),
      action: Array(contract.actionSize).fill(i / 20),
    })),
  };
}
function build(
  telemetry = [chunk()],
  sourceRun = run,
  sourceContract = contract,
  targetContract = contract,
) {
  return buildTrainingDemonstrations({ run: sourceRun, sourceContract, targetContract, telemetry });
}
function rejects(code: string, invoke: () => unknown) {
  try {
    invoke();
    throw new Error('expected rejection');
  } catch (error) {
    expect(error).toBeInstanceOf(TrainingDemonstrationError);
    expect(error).toMatchObject({ code });
  }
}

describe('platform demonstration snapshot', () => {
  it('rejects legacy browser frames whose inference pairing is not declared', () => {
    const legacy = chunk();
    for (const sample of legacy.samples) delete sample.pairing;
    expect(telemetryRevision([legacy])).not.toBe(telemetryRevision([chunk()]));
    rejects('SIM2REAL_DEMONSTRATION_PAIRING_UNVERIFIED', () => build([legacy]));
  });
  it('does not infer causal pairing for imported or board data', () => {
    for (const source of ['import', 'board-agent'] as const) {
      const external = chunk();
      external.source = source;
      for (const sample of external.samples) delete sample.pairing;
      expect(build([external]).trainingData.source).toBe(source);
    }
  });
  it.each([
    {
      ...contract,
      observationLayout: [
        ...contract.observationLayout,
        {
          name: 'camera',
          size: 4096,
          modality: 'image' as const,
          channels: 1,
          height: 64,
          width: 64,
        },
      ],
    },
    { ...contract, inputs: { image: 'camera_frame' } },
    { ...contract, inputs: { stateInputs: ['h_in'] } },
    { ...contract, inputs: { stateOutputs: ['h_out'] } },
    {
      ...contract,
      state: { kind: 'gru' as const, layers: 1, hiddenSize: 32, reset: 'on-activation' as const },
    },
  ])(
    'rejects unsupported source and target image/recurrent contract roles %# before flattening data',
    (unsupported) => {
      rejects('SIM2REAL_DEMONSTRATION_CONTRACT_UNSUPPORTED', () =>
        build([chunk()], run, unsupported, contract),
      );
      rejects('SIM2REAL_DEMONSTRATION_CONTRACT_UNSUPPORTED', () =>
        build([chunk()], run, contract, unsupported),
      );
    },
  );
  it('retains the BC exported observation name and accepts an arbitrary source input name', () => {
    const target = { ...contract, inputs: { observation: 'observation' } };
    const source = { ...contract, inputs: { observation: 'source_obs' } };
    expect(build([chunk()], run, source, target).trainingData.rows).toBe(12);
  });
  it('refuses a target named observation input that the fixed BC graph does not export', () => {
    const target = { ...contract, inputs: { observation: 'custom_obs' } };
    rejects('SIM2REAL_DEMONSTRATION_CONTRACT_UNSUPPORTED', () =>
      build([chunk()], run, contract, target),
    );
  });
  it('freezes exact vectors into canonical JSONL without telemetry metadata', () => {
    const first = build();
    const second = build();
    expect(first).toEqual(second);
    expect(first.trainingData.rows).toBe(12);
    expect(first.demonstrations.jsonl.endsWith('\n')).toBe(true);
    const rows = first.demonstrations.jsonl
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(rows[0]).toEqual({
      observation: chunk().samples[0].observation,
      action: chunk().samples[0].action,
    });
    expect(Object.keys(rows[0])).toEqual(['observation', 'action']);
    expect(first.trainingData.sha256).toBe(
      createHash('sha256').update(first.demonstrations.jsonl).digest('hex'),
    );
    expect(first.trainingData).not.toHaveProperty('jsonl');
  });
  it('gives an appended accepted chunk a new snapshot identity', () => {
    const extra = { ...chunk(), id: 'chunk-2', receivedAt: '2026-10-14T00:00:02Z' };
    expect(build([chunk(), extra]).trainingData.telemetryRevision).not.toBe(
      build().trainingData.telemetryRevision,
    );
  });
  it('rejects mock Runs and demo fixtures', () => {
    rejects('SIM2REAL_DEMONSTRATION_SYNTHETIC', () => build([chunk()], { ...run, mock: true }));
    rejects('SIM2REAL_DEMONSTRATION_SYNTHETIC', () =>
      build([{ ...chunk(), source: 'demo-fixture' }]),
    );
  });
  it('rejects contract identities and dimensions that do not match the target model', () => {
    rejects('SIM2REAL_DEMONSTRATION_CONTRACT_MISMATCH', () =>
      build([chunk()], run, { ...contract, id: 'another-contract' }),
    );
    rejects('SIM2REAL_DEMONSTRATION_CONTRACT_MISMATCH', () =>
      build([chunk()], run, { ...contract, observationSize: 1 }),
    );
    rejects('SIM2REAL_DEMONSTRATION_CONTRACT_MISMATCH', () =>
      build([{ ...chunk(), contractId: undefined }]),
    );
  });
  it('refuses missing, malformed, non-finite and wrong-width vectors instead of dropping rows', () => {
    for (const observation of [undefined, [], [1], Array(contract.observationSize).fill(NaN)]) {
      const bad = chunk();
      bad.samples[3].observation = observation;
      rejects('SIM2REAL_DEMONSTRATION_VECTOR_INVALID', () => build([bad]));
    }
    const bad = chunk();
    bad.samples[3].action = undefined;
    rejects('SIM2REAL_DEMONSTRATION_VECTOR_INVALID', () => build([bad]));
  });
  it('rejects fewer than 12 valid control frames, mixed sources and mock session markers', () => {
    rejects('SIM2REAL_DEMONSTRATION_TOO_SHORT', () =>
      build([{ ...chunk(), samples: chunk().samples.slice(0, 11) }]),
    );
    rejects('SIM2REAL_DEMONSTRATION_SOURCE_INVALID', () =>
      build([chunk(), { ...chunk(), id: 'chunk-2', source: 'import' }]),
    );
    const bad = chunk();
    bad.samples.push({ t: 1, event: { kind: 'session-started', mock: true } });
    rejects('SIM2REAL_DEMONSTRATION_SYNTHETIC', () => build([bad]));
  });
  it('rejects a dataset exceeding the byte cap before a worker can be called', () => {
    const largeContract = { ...contract, observationSize: 4096, actionSize: 4096 };
    const large = {
      ...chunk(),
      samples: Array.from({ length: 40 }, (_, t) => ({
        t,
        pairing: 'policy-inference-v1' as const,
        observation: Array(4096).fill(0.1234567891234567),
        action: Array(4096).fill(0.1234567891234567),
      })),
    };
    rejects('SIM2REAL_DEMONSTRATION_TOO_LARGE', () =>
      build([large], run, largeContract, largeContract),
    );
  });
});
