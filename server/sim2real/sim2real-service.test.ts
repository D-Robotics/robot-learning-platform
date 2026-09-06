import { describe, expect, it } from 'vitest';

import {
  BUILTIN_MICRODUCK_MODEL,
  type Sim2RealModelManifest,
  validateSim2RealManifest,
} from '../../shared/sim2real.js';
import {
  compatibilityForManifest,
  deploymentStepsFor,
  probeRobogoIntegration,
  simulatorIntegration,
} from './sim2real-service.js';

function manifestFixture(): Sim2RealModelManifest {
  return structuredClone(BUILTIN_MICRODUCK_MODEL.manifest);
}

describe('Sim2Real compatibility service', () => {
  it('keeps the published MicroDuck control map aligned with the runtime', () => {
    const manifest = manifestFixture();
    const controls = manifest.simulator.controls || [];
    expect(controls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'move', keys: ['W', 'A', 'S', 'D', '↑', '↓', '←', '→'] }),
        expect.objectContaining({ id: 'kick-left', keys: ['Q'] }),
        expect.objectContaining({ id: 'kick-right', keys: ['E'] }),
        expect.objectContaining({ id: 'alternate-kick', keys: ['F'] }),
        expect.objectContaining({ id: 'quack', keys: ['B'], source: 'ui' }),
        expect.objectContaining({ id: 'reset', keys: ['Space'] }),
      ]),
    );
    expect(manifest.simulator.policyBundle?.policies[0]?.keys).toEqual([
      'W',
      'A',
      'S',
      'D',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
    ]);
    expect(validateSim2RealManifest(manifest).valid).toBe(true);
  });

  it('does not treat the browser ONNX policy as a board binary', () => {
    const result = compatibilityForManifest(manifestFixture(), 'rdk-x5');

    expect(result.status).toBe('requires-conversion');
    expect(result.deployable).toBe(false);
    expect(result.artifactId).toBe('official-walking-policy');
  });

  it('keeps a product-scoped target from being reported as deployable on another board', () => {
    const manifest = manifestFixture();
    manifest.robot = { id: 'rdk-duck', variant: 'x5-kit' };

    const result = compatibilityForManifest(manifest, 'rdk-s600');

    expect(result.status).toBe('incompatible');
    expect(result.deployable).toBe(false);
    expect(result.result.reasons[0]).toMatch(/rdk-s600/);
  });

  it('allows the explicitly declared CPU ONNX locomotion path on X5', () => {
    const manifest = manifestFixture();
    manifest.modelId = 'cpu-locomotion';
    manifest.artifacts[0] = {
      ...manifest.artifacts[0],
      runtime: 'cpu-onnx',
      workload: 'locomotion',
      threads: 1,
    };

    const result = compatibilityForManifest(manifest, 'rdk-x5');
    const steps = deploymentStepsFor(result);

    expect(result.status).toBe('compatible');
    expect(result.deployable).toBe(true);
    expect(result.artifactRuntime).toBe('cpu-onnx');
    expect(result.reason).toMatch(/BPU remains available for perception/);
    expect(steps.find((step) => step.id === 'artifact')).toMatchObject({
      label: 'Stage CPU ONNX policy',
      status: 'pending',
    });
  });

  it('does not generalize the X5 CPU exception to other board platforms', () => {
    const manifest = manifestFixture();
    manifest.modelId = 'cpu-locomotion-s600-check';
    manifest.artifacts[0] = {
      ...manifest.artifacts[0],
      runtime: 'cpu-onnx',
      workload: 'locomotion',
      threads: 1,
    };
    const result = compatibilityForManifest(manifest, 'rdk-s600');
    expect(result.deployable).toBe(false);
  });

  it('does not let conflicting target metadata bypass the X5 CPU exception', () => {
    const manifest = manifestFixture();
    manifest.modelId = 'cpu-locomotion-conflicting-target';
    manifest.artifacts[0] = {
      ...manifest.artifacts[0],
      runtime: 'cpu-onnx',
      workload: 'locomotion',
      threads: 1,
      targetPlatforms: ['rdk-x3'],
    };

    const result = compatibilityForManifest(manifest, 'rdk-x5');
    expect(result.deployable).toBe(false);
    expect(result.status).toBe('requires-conversion');
  });

  it('rejects manifest dimensions that exceed the worker safety bounds', () => {
    const manifest = manifestFixture();
    manifest.robot = { id: 'rdk-duck', variant: 'x5-kit' };
    manifest.contract = {
      id: 'rdk-duck-policy-v1',
      robotId: 'rdk-duck',
      jointCount: 12,
      observationSize: 4_097,
      actionSize: 12,
      controlHz: 100,
      physicsTimestepSeconds: 0.002,
      decimation: 1,
      observationLayout: [{ name: 'observation', size: 4_097 }],
    };

    const validation = validateSim2RealManifest(manifest);
    expect(validation.valid).toBe(false);
    expect(validation.errors).toEqual(
      expect.arrayContaining([
        'contract.observationSize must be at most 4096',
        'contract.observationLayout item size must be a positive integer at most 4096',
      ]),
    );
  });

  it('prefers an exact compiled target over the source policy', () => {
    const manifest = manifestFixture();
    manifest.artifacts.push({
      id: 'compiled-x5',
      role: 'compiled-policy',
      name: 'policy.bin',
      kind: 'compiled',
      format: 'bin',
      ref: 'artifact://user/policy.bin',
      targetPlatforms: ['rdk-x5'],
      acceleratorArchitecture: 'bayes-e',
      toolchainTarget: 'rdk-x5',
    });

    const result = compatibilityForManifest(manifest, 'rdk-x5');
    const steps = deploymentStepsFor(result);

    expect(result.status).toBe('compatible');
    expect(result.deployable).toBe(true);
    expect(result.artifactId).toBe('compiled-x5');
    expect(steps.find((step) => step.id === 'artifact')?.status).toBe('pending');
    expect(steps.find((step) => step.id === 'live')?.status).toBe('blocked');
  });

  it('does not let a mismatched compiled artifact hide the conversion path', () => {
    const manifest = manifestFixture();
    manifest.artifacts.push({
      id: 'compiled-s600',
      role: 'compiled-policy',
      name: 'policy.hbm',
      kind: 'compiled',
      format: 'hbm',
      ref: 'artifact://user/policy.hbm',
      targetPlatforms: ['rdk-s600'],
      acceleratorArchitecture: 'nash-s600',
      toolchainTarget: 'rdk-s600',
    });

    const result = compatibilityForManifest(manifest, 'rdk-x5');

    expect(result.status).toBe('requires-conversion');
    expect(result.deployable).toBe(false);
    expect(result.artifactId).toBe('official-walking-policy');
  });

  it('reports an unconfigured RoboGo runner without manufacturing a URL', () => {
    const previous = process.env.RDK_SIM2REAL_ROBOGO_RUNNER_URL;
    const previousMicroduckRoot = process.env.RDK_SIM2REAL_MICRODUCK_ROOT;
    const previousMicroduckUrl = process.env.RDK_SIM2REAL_MICRODUCK_URL;
    delete process.env.RDK_SIM2REAL_ROBOGO_RUNNER_URL;
    delete process.env.RDK_SIM2REAL_MICRODUCK_ROOT;
    delete process.env.RDK_SIM2REAL_MICRODUCK_URL;
    try {
      expect(simulatorIntegration()).toMatchObject({
        browser: { available: false, state: 'missing', entryUrl: '/mujoco/microduck/' },
        robogo: { available: false },
      });
    } finally {
      if (previous === undefined) delete process.env.RDK_SIM2REAL_ROBOGO_RUNNER_URL;
      else process.env.RDK_SIM2REAL_ROBOGO_RUNNER_URL = previous;
      if (previousMicroduckRoot === undefined) delete process.env.RDK_SIM2REAL_MICRODUCK_ROOT;
      else process.env.RDK_SIM2REAL_MICRODUCK_ROOT = previousMicroduckRoot;
      if (previousMicroduckUrl === undefined) delete process.env.RDK_SIM2REAL_MICRODUCK_URL;
      else process.env.RDK_SIM2REAL_MICRODUCK_URL = previousMicroduckUrl;
    }
  });

  it('reports a safe loopback BoardAgent as available without treating it as hardware proof', () => {
    const previous = process.env.RDK_SIM2REAL_BOARD_AGENT_URL;
    process.env.RDK_SIM2REAL_BOARD_AGENT_URL = 'http://[::1]:19100';
    try {
      expect(simulatorIntegration().boardAgent).toMatchObject({ available: true });
      expect(simulatorIntegration().boardAgent.reason).toMatch(/只读板端预检/);
    } finally {
      if (previous === undefined) delete process.env.RDK_SIM2REAL_BOARD_AGENT_URL;
      else process.env.RDK_SIM2REAL_BOARD_AGENT_URL = previous;
    }
  });

  it('uses a request-scoped Web Cloud token when the standalone process has no local session map', async () => {
    const originalFetch = globalThis.fetch;
    const originalBase = process.env.RDK_SIM2REAL_ROBOGO_API_URL;
    const authorizations: string[] = [];
    process.env.RDK_SIM2REAL_ROBOGO_API_URL = 'https://robogo.example.test';
    globalThis.fetch = (async (_input, init) => {
      authorizations.push(String(new Headers(init?.headers).get('authorization') || ''));
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      await expect(probeRobogoIntegration('alice', 'web-cloud-token')).resolves.toMatchObject({
        state: 'ready',
        clusterQueried: true,
        devMachineQueried: true,
      });
      expect(authorizations).toEqual(['Bearer web-cloud-token', 'Bearer web-cloud-token']);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalBase === undefined) delete process.env.RDK_SIM2REAL_ROBOGO_API_URL;
      else process.env.RDK_SIM2REAL_ROBOGO_API_URL = originalBase;
    }
  });

  it('does not use a process-wide RoboGo token when a custom auth adapter declares multi-user mode', async () => {
    const originalFetch = globalThis.fetch;
    const originalBase = process.env.RDK_SIM2REAL_ROBOGO_API_URL;
    const originalToken = process.env.RDK_SIM2REAL_ROBOGO_TOKEN;
    const authorizations: string[] = [];
    process.env.RDK_SIM2REAL_ROBOGO_API_URL = 'https://robogo.example.test';
    process.env.RDK_SIM2REAL_ROBOGO_TOKEN = 'must-not-forward';
    globalThis.fetch = (async (_input, init) => {
      authorizations.push(String(new Headers(init?.headers).get('authorization') || ''));
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      await expect(
        probeRobogoIntegration('alice', undefined, { multiUser: true }),
      ).resolves.toMatchObject({ state: 'unavailable' });
      expect(authorizations).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalBase === undefined) delete process.env.RDK_SIM2REAL_ROBOGO_API_URL;
      else process.env.RDK_SIM2REAL_ROBOGO_API_URL = originalBase;
      if (originalToken === undefined) delete process.env.RDK_SIM2REAL_ROBOGO_TOKEN;
      else process.env.RDK_SIM2REAL_ROBOGO_TOKEN = originalToken;
    }
  });
});
