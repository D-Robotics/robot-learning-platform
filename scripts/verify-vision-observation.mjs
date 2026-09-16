#!/usr/bin/env node
/**
 * Vision observation gate rehearsal.
 *
 * Exercises the image-branch contract against a REAL ONNX model input
 * signature rather than a hand-written fixture, because the failure this
 * guards is precisely a disagreement between a declared contract and an
 * exported model. The models are built with `onnx` in a temporary directory,
 * so the run is deterministic, offline and safe for CI.
 *
 * Skips (exit 0 with a SKIP line) when the python onnx stack is unavailable,
 * matching the repository's convention for optional engine probes.
 *
 * The contract shape is produced by the real `validateSim2RealManifest` and the
 * verdict by the real `validateVisionObservationAgainstModelInputs`, so this
 * script cannot drift from either.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PYTHON = process.env.PYTHON || 'python3';

const fail = (message) => {
  throw new Error(`[vision-observation] ${message}`);
};

/**
 * Loads a shared module. The verify chain builds first, so the compiled form is
 * normally present; running this gate standalone falls back to the TypeScript
 * sources through tsx.
 */
async function loadShared(relative) {
  const built = path.join(ROOT, 'dist-server', 'shared', relative.replace(/\.ts$/, '.js'));
  if (existsSync(built)) return import(pathToFileURL(built).href);
  const tsx = await import('tsx/esm/api').catch(() => null);
  if (!tsx) fail(`cannot load shared/${relative}: no build output and tsx is unavailable`);
  return tsx.import(path.join(ROOT, 'shared', relative), import.meta.url);
}

function pythonCanImport(...modules) {
  return (
    spawnSync(PYTHON, ['-c', modules.map((name) => `import ${name}`).join('; ')], {
      encoding: 'utf8',
    }).status === 0
  );
}

/** Builds an Identity ONNX model with the requested input shape. */
function buildModel(dir, fileName, shape) {
  const script = [
    'import sys',
    'import onnx',
    'from onnx import helper, TensorProto',
    'path, shape_json = sys.argv[1], sys.argv[2]',
    'shape = [int(v) for v in shape_json.split(",") if v != ""]',
    'node = helper.make_node("Identity", ["obs"], ["act"])',
    'graph = helper.make_graph(',
    '    [node], "vision_probe",',
    '    [helper.make_tensor_value_info("obs", TensorProto.FLOAT, shape)],',
    '    [helper.make_tensor_value_info("act", TensorProto.FLOAT, shape)],',
    ')',
    'model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)])',
    // Keep the IR version inside what the installed onnxruntime accepts.
    'model.ir_version = 8',
    'onnx.save(model, path)',
  ].join('\n');
  const result = spawnSync(PYTHON, ['-c', script, path.join(dir, fileName), shape], {
    encoding: 'utf8',
    cwd: ROOT,
  });
  if (result.status !== 0) {
    fail(
      `could not build ${fileName}: ${(result.stderr || '').trim().split('\n').slice(-2).join(' | ')}`,
    );
  }
}

/** Reads a model's real input signature through onnxruntime. */
function readSignature(dir, fileName) {
  const script = [
    'import json, sys',
    'import onnxruntime as rt',
    'sess = rt.InferenceSession(sys.argv[1], providers=["CPUExecutionProvider"])',
    'print(json.dumps([{"name": i.name, "shape": [',
    '    (d if isinstance(d, str) else int(d)) for d in i.shape]} for i in sess.get_inputs()]))',
  ].join('\n');
  const result = spawnSync(PYTHON, ['-c', script, path.join(dir, fileName)], {
    encoding: 'utf8',
    cwd: ROOT,
  });
  if (result.status !== 0) {
    fail(
      `could not read ${fileName}: ${(result.stderr || '').trim().split('\n').slice(-2).join(' | ')}`,
    );
  }
  const line = result.stdout.trim().split('\n').pop() ?? '[]';
  return JSON.parse(line);
}

const { BUILTIN_MICRODUCK_MODEL, MICRODUCK_OBSERVATION_LAYOUT, validateSim2RealManifest } =
  await loadShared('sim2real.ts');
const { validateVisionObservationAgainstModelInputs } = await loadShared(
  'artifact-quality-gate.ts',
);

const workdir = await mkdtemp(path.join(os.tmpdir(), 'rdk-vision-observation-'));
try {
  // 1. The fixed 61D contract must stay vector-only: no modality fields.
  if (MICRODUCK_OBSERVATION_LAYOUT.some((item) => 'modality' in item)) {
    fail('the fixed MicroDuck 61D layout must not declare a modality');
  }
  const microduck = validateSim2RealManifest(structuredClone(BUILTIN_MICRODUCK_MODEL.manifest));
  if (!microduck.valid) {
    fail(`the built-in MicroDuck manifest stopped validating: ${microduck.errors}`);
  }

  // 2. A vision contract is accepted and keeps its shape through normalization.
  //
  // The 32x32 shape is not an aesthetic choice: the platform's flat per-frame
  // observation budget is `SIM2REAL_CONTRACT_LIMITS.maxObservationSize` (4096
  // elements), and an image slot is counted in it because `size` is the
  // flattened element count. 32*32*3 = 3072 fits; a realistic 64x64 RGB frame
  // (12288) or any camera-native resolution does not. That collision is a real
  // open decision for the product, not something this gate should paper over,
  // so the rehearsal uses a shape that fits and the budget question stays
  // visible in the report.
  const imageHeight = 32;
  const imageWidth = 32;
  const channels = 3;
  const flatImage = channels * imageHeight * imageWidth;
  const vectorSize = 6;
  const visionManifest = structuredClone(BUILTIN_MICRODUCK_MODEL.manifest);
  visionManifest.modelId = 'vision-goal-navigation';
  visionManifest.robot = { id: 'originbot', variant: 'differential-drive' };
  visionManifest.contract = {
    ...visionManifest.contract,
    id: 'originbot-policy-vision-v1',
    robotId: 'originbot',
    observationSize: vectorSize + flatImage,
    observationLayout: [
      { name: 'imu-gravity', size: vectorSize },
      {
        name: 'camera',
        size: flatImage,
        modality: 'image',
        channels,
        height: imageHeight,
        width: imageWidth,
      },
    ],
  };
  visionManifest.artifacts = [
    {
      id: 'vision-policy',
      name: 'vision-policy.onnx',
      role: 'policy',
      kind: 'source',
      ref: 'artifact://originbot/vision-policy',
      format: 'onnx',
      runtime: 'cpu-onnx',
      workload: 'locomotion',
      threads: 1,
      targetPlatforms: ['rdk-x5'],
    },
  ];
  visionManifest.simulator = { backends: ['local'], policyArtifactId: 'vision-policy' };
  const vision = validateSim2RealManifest(visionManifest);
  if (!vision.valid) fail(`a vision contract was rejected: ${vision.errors.join('; ')}`);
  const normalized = vision.manifest.contract.observationLayout;
  const camera = normalized.find((item) => item.name === 'camera');
  if (!camera || camera.modality !== 'image' || camera.size !== flatImage) {
    fail(`the image slot did not survive normalization: ${JSON.stringify(camera)}`);
  }
  const total = normalized.reduce((sum, item) => sum + item.size, 0);
  if (total !== vision.manifest.contract.observationSize) {
    fail(`layout sum ${total} != observationSize ${vision.manifest.contract.observationSize}`);
  }
  // A shape that contradicts the declared size must be refused, not trusted.
  const contradictory = structuredClone(visionManifest);
  contradictory.contract.observationLayout = [
    { name: 'imu-gravity', size: vectorSize },
    {
      name: 'camera',
      size: flatImage - 1,
      modality: 'image',
      channels,
      height: imageHeight,
      width: imageWidth,
    },
  ];
  if (validateSim2RealManifest(contradictory).valid) {
    fail('an image slot whose size contradicts its shape was accepted');
  }
  console.log(
    `[vision-observation] contract: 61D MicroDuck stays vector-only; vision contract accepted (${vectorSize}D vector + ${channels}x${imageHeight}x${imageWidth} image, flat ${total}); contradictory shape refused`,
  );

  // 3. Real ONNX input signatures. A dimension-only check cannot tell these
  //    models apart, which is why the gate has to inspect the rank.
  if (!pythonCanImport('onnx', 'onnxruntime')) {
    console.log(
      '[vision-observation] SKIP real-model checks — python onnx/onnxruntime unavailable (install: python3 -m pip install --user onnx onnxruntime)',
    );
    console.log('[vision-observation] PASS (contract checks only)');
    process.exit(0);
  }

  buildModel(workdir, 'vector-only.onnx', `${vectorSize}`);
  const vectorSignature = readSignature(workdir, 'vector-only.onnx');
  const refused = validateVisionObservationAgainstModelInputs({
    layout: normalized,
    inputs: vectorSignature,
  });
  if (refused.passed) fail('a vector-only model was accepted for a vision contract');
  if (!refused.errors.join(' ').includes('rank-4')) {
    fail(`refusal did not cite the missing rank-4 input: ${refused.errors}`);
  }
  console.log(
    `[vision-observation] real model: vector-only export refused for a vision contract (${refused.errors[0]})`,
  );

  buildModel(workdir, 'vision-nhwc.onnx', `1,${imageHeight},${imageWidth},${channels}`);
  const matchingSignature = readSignature(workdir, 'vision-nhwc.onnx');
  const accepted = validateVisionObservationAgainstModelInputs({
    layout: normalized,
    inputs: [vectorSignature[0], matchingSignature[1] ?? matchingSignature[0]],
  });
  if (!accepted.passed) fail(`the matching export was refused: ${accepted.errors}`);
  console.log('[vision-observation] real model: matching NHWC export accepted');

  buildModel(workdir, 'vision-wrong-channel.onnx', `1,${imageHeight},${imageWidth},1`);
  const wrongSignature = readSignature(workdir, 'vision-wrong-channel.onnx');
  const wrongChannels = validateVisionObservationAgainstModelInputs({
    layout: normalized,
    inputs: [vectorSignature[0], wrongSignature[1] ?? wrongSignature[0]],
  });
  if (wrongChannels.passed) fail('a 1-channel export was accepted for a 3-channel contract');
  console.log(
    `[vision-observation] real model: channel mismatch refused (${wrongChannels.errors[0]})`,
  );

  buildModel(workdir, 'vision-small.onnx', `1,16,16,${channels}`);
  const smallSignature = readSignature(workdir, 'vision-small.onnx');
  const tooSmall = validateVisionObservationAgainstModelInputs({
    layout: normalized,
    inputs: [vectorSignature[0], smallSignature[1] ?? smallSignature[0]],
  });
  if (tooSmall.passed) {
    fail(`a spatially smaller export was accepted for a ${imageHeight}x${imageWidth} contract`);
  }
  console.log(`[vision-observation] real model: undersized export refused (${tooSmall.errors[0]})`);

  // 4. The vector-only path must stay completely unaffected.
  const unaffected = validateVisionObservationAgainstModelInputs({
    layout: MICRODUCK_OBSERVATION_LAYOUT,
    inputs: vectorSignature,
  });
  if (!unaffected.passed) {
    fail(`a vector-only contract was affected by the vision gate: ${unaffected.errors}`);
  }
  console.log('[vision-observation] vector-only contracts remain exempt');

  console.log('[vision-observation] PASS');
} finally {
  await rm(workdir, { recursive: true, force: true });
}
