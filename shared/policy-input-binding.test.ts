import { describe, expect, it } from 'vitest';
import {
  unhandledStateInputs,
  validatePolicyInputBindingsAgainstModelGraph,
} from './artifact-quality-gate.js';
import { BUILTIN_MICRODUCK_MODEL, validateSim2RealManifest } from './sim2real.js';

/**
 * Named policy input bindings and the recurrent state contract.
 *
 * Context: the platform used to bind a model's inputs by RANK — "some rank-2
 * input is the observation". That is an inference, and it holds for an export
 * whose input order changed, for an export that grew a second rank-2 input, and
 * (worst) for a recurrent export whose `h_in`/`c_in` are simply never fed, so
 * ONNX Runtime defaults them to zeros and the policy runs as if it had no
 * memory. These cases pin the replacement: declare the names, check them against
 * the real graph, and refuse every ambiguity.
 */

/** A manifest with a manifest-defined (non-MicroDuck) contract, so fields vary. */
function manifestWithContract(contract: Record<string, unknown>) {
  const base = structuredClone(BUILTIN_MICRODUCK_MODEL.manifest) as any;
  base.modelId = 'policy-binding';
  base.robot = { id: 'originbot', variant: 'differential-drive' };
  base.contract = {
    ...base.contract,
    id: 'originbot-policy-binding-v1',
    robotId: 'originbot',
    observationSize: 61,
    actionSize: 14,
    ...contract,
  };
  base.simulator = { backends: ['local'], policyArtifactId: 'binding-policy' };
  base.artifacts = [
    {
      id: 'binding-policy',
      name: 'binding-policy.onnx',
      role: 'policy',
      kind: 'source',
      ref: 'artifact://originbot/binding-policy',
      format: 'onnx',
      runtime: 'cpu-onnx',
      workload: 'locomotion',
      threads: 1,
      targetPlatforms: ['rdk-x5'],
    },
  ];
  return base;
}

const feedForwardGraph = {
  inputs: [{ name: 'obs', shape: [1, 61] }],
  outputs: [{ name: 'action', shape: [1, 14] }],
};

const recurrentGraph = {
  inputs: [
    { name: 'obs', shape: [1, 61] },
    { name: 'h_in', shape: [1, 1, 256] },
    { name: 'c_in', shape: [1, 1, 256] },
  ],
  outputs: [
    { name: 'action', shape: [1, 14] },
    { name: 'h_out', shape: [1, 1, 256] },
    { name: 'c_out', shape: [1, 1, 256] },
  ],
};

describe('policy input contract declarations', () => {
  it('keeps a contract without declared inputs byte-identical', () => {
    const result = validateSim2RealManifest(
      structuredClone(BUILTIN_MICRODUCK_MODEL.manifest) as any,
    );
    expect(result.valid).toBe(true);
    expect(result.manifest?.contract.inputs).toBeUndefined();
    expect(result.manifest?.contract.state).toBeUndefined();
  });

  it('accepts a named observation binding', () => {
    const result = validateSim2RealManifest(
      manifestWithContract({ inputs: { observation: 'obs' } }),
    );
    expect(result.errors).toEqual([]);
    expect(result.manifest?.contract.inputs).toEqual({ observation: 'obs' });
  });

  it('accepts a complete LSTM contract', () => {
    const result = validateSim2RealManifest(
      manifestWithContract({
        inputs: {
          observation: 'obs',
          stateInputs: ['h_in', 'c_in'],
          stateOutputs: ['h_out', 'c_out'],
        },
        state: { kind: 'lstm', layers: 1, hiddenSize: 256, reset: 'on-activation' },
      }),
    );
    expect(result.errors).toEqual([]);
    expect(result.manifest?.contract.state).toEqual({
      kind: 'lstm',
      layers: 1,
      hiddenSize: 256,
      reset: 'on-activation',
    });
  });

  it('rejects a state block with no named state tensors', () => {
    const result = validateSim2RealManifest(
      manifestWithContract({
        state: { kind: 'lstm', layers: 1, hiddenSize: 256, reset: 'on-activation' },
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/names no state tensor/);
  });

  it('rejects state tensor names with no state block', () => {
    const result = validateSim2RealManifest(
      manifestWithContract({
        inputs: {
          observation: 'obs',
          stateInputs: ['h_in', 'c_in'],
          stateOutputs: ['h_out', 'c_out'],
        },
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/contract.state is missing/);
  });

  it('rejects a tensor count that does not match the declared kind and layers', () => {
    // A GRU carries one tensor per layer, so two names is an LSTM-shaped claim.
    const result = validateSim2RealManifest(
      manifestWithContract({
        inputs: {
          observation: 'obs',
          stateInputs: ['h_in', 'c_in'],
          stateOutputs: ['h_out', 'c_out'],
        },
        state: { kind: 'gru', layers: 1, hiddenSize: 256, reset: 'on-activation' },
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/needs 1/);
  });

  it('rejects an unpaired state declaration', () => {
    const result = validateSim2RealManifest(
      manifestWithContract({
        inputs: { observation: 'obs', stateInputs: ['h_in'] },
        state: { kind: 'gru', layers: 1, hiddenSize: 256, reset: 'on-activation' },
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/declared together/);
  });

  it('rejects an unknown reset policy rather than promising unimplemented semantics', () => {
    const result = validateSim2RealManifest(
      manifestWithContract({
        inputs: { observation: 'obs', stateInputs: ['h_in'], stateOutputs: ['h_out'] },
        state: { kind: 'gru', layers: 1, hiddenSize: 256, reset: 'every-step' },
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/reset must be "on-activation"/);
  });

  it('rejects unknown fields inside inputs', () => {
    const result = validateSim2RealManifest(
      manifestWithContract({ inputs: { observation: 'obs', camera: 'camera' } }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/unknown field "camera"/);
  });

  it('rejects a tensor name that is not an identifier', () => {
    const result = validateSim2RealManifest(
      manifestWithContract({ inputs: { observation: 'obs input; rm -rf /' } }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/must be a tensor name/);
  });
});

describe('policy input binding against an exported graph', () => {
  const base = { observationSize: 61, actionSize: 14 };

  it('accepts a feed-forward graph with a declared observation', () => {
    const verdict = validatePolicyInputBindingsAgainstModelGraph({
      ...feedForwardGraph,
      ...base,
      declared: { observation: 'obs' },
    });
    expect(verdict.errors).toEqual([]);
    expect(verdict.passed).toBe(true);
  });

  it('accepts a recurrent graph that declares and closes its state', () => {
    const verdict = validatePolicyInputBindingsAgainstModelGraph({
      ...recurrentGraph,
      ...base,
      declared: {
        observation: 'obs',
        stateInputs: ['h_in', 'c_in'],
        stateOutputs: ['h_out', 'c_out'],
      },
      state: { kind: 'lstm', layers: 1, hiddenSize: 256, reset: 'on-activation' },
    });
    expect(verdict.errors).toEqual([]);
  });

  it('refuses a declared observation the graph does not have', () => {
    const verdict = validatePolicyInputBindingsAgainstModelGraph({
      ...feedForwardGraph,
      ...base,
      declared: { observation: 'observation' },
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.errors.join(' ')).toMatch(/graph has no such input/);
  });

  it('refuses an input-order change that rank matching would have accepted', () => {
    // Two rank-2 inputs: the historical rank pick would silently take whichever
    // came first, so it cannot tell these two exports apart. The declared name
    // binds the contract to `obs` regardless of position.
    const withNoiseFirst = validatePolicyInputBindingsAgainstModelGraph({
      inputs: [
        { name: 'noise', shape: [1, 61] },
        { name: 'obs', shape: [1, 61] },
      ],
      outputs: [{ name: 'action', shape: [1, 14] }],
      ...base,
      declared: { observation: 'obs' },
    });
    expect(withNoiseFirst.errors).toEqual([]);
    // Same graph, contract bound to the other tensor: the *contract* is what
    // decides, so a mislabelled export is caught rather than accommodated.
    const boundToNoise = validatePolicyInputBindingsAgainstModelGraph({
      inputs: [
        { name: 'noise', shape: [1, 61] },
        { name: 'obs', shape: [1, 61] },
      ],
      outputs: [{ name: 'action', shape: [1, 14] }],
      ...base,
      declared: { observation: 'observation' },
    });
    expect(boundToNoise.passed).toBe(false);
    expect(boundToNoise.errors.join(' ')).toMatch(/graph has no such input/);
  });

  it('refuses an observation of the wrong width', () => {
    const verdict = validatePolicyInputBindingsAgainstModelGraph({
      inputs: [{ name: 'obs', shape: [1, 42] }],
      outputs: [{ name: 'action', shape: [1, 14] }],
      ...base,
      declared: { observation: 'obs' },
    });
    expect(verdict.errors.join(' ')).toMatch(
      /has width 42 but the contract declares observationSize 61/,
    );
  });

  it('binds a vision input by name and channel count, not by position', () => {
    const verdict = validatePolicyInputBindingsAgainstModelGraph({
      inputs: [
        { name: 'obs', shape: [1, 6] },
        { name: 'camera', shape: [1, 64, 64, 3] },
      ],
      outputs: [{ name: 'action', shape: [1, 2] }],
      observationSize: 6,
      actionSize: 2,
      imageChannels: 3,
      declared: { observation: 'obs', image: 'camera' },
    });
    expect(verdict.errors).toEqual([]);
  });

  it('refuses a vision channel mismatch', () => {
    const verdict = validatePolicyInputBindingsAgainstModelGraph({
      inputs: [
        { name: 'obs', shape: [1, 6] },
        { name: 'camera', shape: [1, 64, 64, 1] },
      ],
      outputs: [{ name: 'action', shape: [1, 2] }],
      observationSize: 6,
      actionSize: 2,
      imageChannels: 3,
      declared: { observation: 'obs', image: 'camera' },
    });
    expect(verdict.errors.join(' ')).toMatch(
      /has 1 channels but the contract image slot declares 3/,
    );
  });

  it('refuses a state output whose shape cannot close the loop', () => {
    const verdict = validatePolicyInputBindingsAgainstModelGraph({
      inputs: [
        { name: 'obs', shape: [1, 61] },
        { name: 'h_in', shape: [1, 1, 256] },
      ],
      outputs: [
        { name: 'action', shape: [1, 14] },
        { name: 'h_out', shape: [1, 1, 128] },
      ],
      ...base,
      declared: { observation: 'obs', stateInputs: ['h_in'], stateOutputs: ['h_out'] },
      state: { kind: 'gru', layers: 1, hiddenSize: 256, reset: 'on-activation' },
    });
    expect(verdict.errors.join(' ')).toMatch(/does not match its input/);
  });

  it('refuses a hidden size that disagrees with the state declaration', () => {
    const verdict = validatePolicyInputBindingsAgainstModelGraph({
      inputs: [
        { name: 'obs', shape: [1, 61] },
        { name: 'h_in', shape: [1, 1, 128] },
      ],
      outputs: [
        { name: 'action', shape: [1, 14] },
        { name: 'h_out', shape: [1, 1, 128] },
      ],
      ...base,
      declared: { observation: 'obs', stateInputs: ['h_in'], stateOutputs: ['h_out'] },
      state: { kind: 'gru', layers: 1, hiddenSize: 256, reset: 'on-activation' },
    });
    expect(verdict.errors.join(' ')).toMatch(/hidden size 128 does not match/);
  });

  it('refuses a state declaration with no state tensors', () => {
    const verdict = validatePolicyInputBindingsAgainstModelGraph({
      ...feedForwardGraph,
      ...base,
      declared: { observation: 'obs' },
      state: { kind: 'lstm', layers: 1, hiddenSize: 256, reset: 'on-activation' },
    });
    expect(verdict.errors.join(' ')).toMatch(/names no state input tensor/);
  });

  it('refuses an ambiguous action output instead of picking one', () => {
    const verdict = validatePolicyInputBindingsAgainstModelGraph({
      inputs: [{ name: 'obs', shape: [1, 61] }],
      outputs: [
        { name: 'action', shape: [1, 14] },
        { name: 'action_ema', shape: [1, 14] },
      ],
      ...base,
      declared: { observation: 'obs' },
    });
    expect(verdict.errors.join(' ')).toMatch(/ambiguous action output/);
  });

  it('refuses a graph with no readable action output', () => {
    const verdict = validatePolicyInputBindingsAgainstModelGraph({
      inputs: [{ name: 'obs', shape: [1, 61] }],
      outputs: [{ name: 'action', shape: [1, 7] }],
      ...base,
      declared: { observation: 'obs' },
    });
    expect(verdict.errors.join(' ')).toMatch(/no rank-2 output of width 14/);
  });
});

describe('unhandled recurrent state detection', () => {
  it('flags the state tensors a feed-forward contract never binds', () => {
    expect(unhandledStateInputs({ inputs: recurrentGraph.inputs })).toEqual(['h_in', 'c_in']);
  });

  it('stays quiet once the state tensors are declared', () => {
    expect(
      unhandledStateInputs({
        inputs: recurrentGraph.inputs,
        declared: {
          observation: 'obs',
          stateInputs: ['h_in', 'c_in'],
          stateOutputs: ['h_out', 'c_out'],
        },
      }),
    ).toEqual([]);
  });

  it('does not mistake a vision input for state', () => {
    expect(
      unhandledStateInputs({
        inputs: [
          { name: 'obs', shape: [1, 6] },
          { name: 'camera', shape: [1, 64, 64, 3] },
        ],
        declared: { observation: 'obs', image: 'camera' },
      }),
    ).toEqual([]);
  });

  it('flags state even when the contract declares no inputs at all', () => {
    // The historical contract shape: nothing declared, so the only defence is
    // noticing that the graph carries tensors nobody will feed.
    expect(unhandledStateInputs({ inputs: recurrentGraph.inputs })).not.toEqual([]);
  });
});
