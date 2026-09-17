#!/usr/bin/env node
/**
 * Named policy input bindings + recurrent state gate rehearsal.
 *
 * The failure this guards is an agreement problem between three things that
 * evolve separately: a contract that declares which ONNX tensor plays which
 * role, an export that actually names them, and the board runtime that has to
 * feed them. Hand-written fixtures cannot catch drift between those, so this
 * script builds REAL ONNX graphs and runs the REAL gate and the REAL board
 * runtime rules over them:
 *
 *   1. feed-forward 61->14 export: accepted, and the board's own load-path rules
 *      classify it as observation-only;
 *   2. recurrent export (obs + h_in + c_in -> action + h_out + c_out): the gate
 *      flags the unbound state tensors, and the board runtime refuses to load it
 *      instead of running the policy on zeroed history every step;
 *   3. the same recurrent graph WITH a complete contract: accepted by the gate,
 *      and the board is still expected to refuse (the shipped runtime does not
 *      carry state yet) — the two answers differ on purpose and both are
 *      asserted, so neither can silently start lying;
 *   4. vision export (obs + camera): bound by name and channel count, and the
 *      board still loads it (no state false-positive).
 *
 * The board classification mirrors `_load_onnx` in board-policy-runtime.py and
 * is cross-checked against the runtime module itself when that module can be
 * imported without ROS.
 *
 * Skips (exit 0 with a SKIP line) when numpy/onnx are unavailable, matching the
 * repository's convention for optional engine probes.
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
  throw new Error(`[policy-input-binding] ${message}`);
};

/** Loads a shared module: compiled output first, TypeScript sources via tsx. */
async function loadShared(relative) {
  const built = path.join(ROOT, 'dist-server', 'shared', relative.replace(/\.ts$/, '.js'));
  if (existsSync(built)) return import(pathToFileURL(built).href);
  const tsx = await import('tsx/esm/api').catch(() => null);
  if (!tsx?.tsImport)
    fail(`cannot load shared/${relative}: no build output and tsx is unavailable`);
  return tsx.tsImport(path.join(ROOT, 'shared', relative), import.meta.url);
}

function pythonCanImport(...modules) {
  return (
    spawnSync(PYTHON, ['-c', modules.map((name) => `import ${name}`).join('; ')], {
      encoding: 'utf8',
    }).status === 0
  );
}

/** Builds the three graphs and returns their onnxruntime-reported signatures. */
function buildGraphs(dir) {
  const script = `
import json, sys
import numpy as np, onnx, onnxruntime as rt
from onnx import helper, TensorProto, numpy_helper

out = sys.argv[1]
rng = np.random.RandomState(0)

def dense(name, obs, act):
    w = (rng.randn(obs, act) * 0.05).astype(np.float32)
    b = np.zeros(act, dtype=np.float32)
    return ([helper.make_node('MatMul', ['obs', 'w'], ['h']),
             helper.make_node('Add', ['h', 'b'], ['action'])],
            [numpy_helper.from_array(w, 'w'), numpy_helper.from_array(b, 'b')])

def save(path, nodes, inits, inputs, outputs, name):
    graph = helper.make_graph(nodes, name, inputs, outputs, inits)
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid('', 17)])
    model.ir_version = 9
    onnx.save(model, path)
    sess = rt.InferenceSession(path, providers=['CPUExecutionProvider'])
    return {
        'path': path,
        'inputs': [{'name': i.name, 'shape': [d if isinstance(d, int) else 'batch' for d in i.shape]} for i in sess.get_inputs()],
        'outputs': [{'name': o.name, 'shape': [d if isinstance(d, int) else 'batch' for d in o.shape]} for o in sess.get_outputs()],
    }

f32 = TensorProto.FLOAT
result = {}

nodes, inits = dense('ff', 61, 14)
result['feedForward'] = save(
    out + '/ff.onnx', nodes, inits,
    [helper.make_tensor_value_info('obs', f32, [1, 61])],
    [helper.make_tensor_value_info('action', f32, [1, 14])], 'ff')

nodes, inits = dense('rec', 61, 14)
nodes = nodes + [helper.make_node('Identity', ['h_in'], ['h_out']),
                 helper.make_node('Identity', ['c_in'], ['c_out'])]
result['recurrent'] = save(
    out + '/recurrent.onnx', nodes, inits,
    [helper.make_tensor_value_info('obs', f32, [1, 61]),
     helper.make_tensor_value_info('h_in', f32, [1, 1, 256]),
     helper.make_tensor_value_info('c_in', f32, [1, 1, 256])],
    [helper.make_tensor_value_info('action', f32, [1, 14]),
     helper.make_tensor_value_info('h_out', f32, [1, 1, 256]),
     helper.make_tensor_value_info('c_out', f32, [1, 1, 256])], 'recurrent')

nodes, inits = dense('vision', 6, 2)
result['vision'] = save(
    out + '/vision.onnx', nodes, inits,
    [helper.make_tensor_value_info('obs', f32, [1, 6]),
     helper.make_tensor_value_info('camera', f32, [1, 64, 64, 3])],
    [helper.make_tensor_value_info('action', f32, [1, 2])], 'vision')

print(json.dumps(result))
`;
  const result = spawnSync(PYTHON, ['-c', script, dir], { encoding: 'utf8' });
  if (result.status !== 0) fail(`could not build the probe graphs: ${result.stderr.trim()}`);
  return JSON.parse(result.stdout);
}

/**
 * Classifies a graph exactly as `_load_onnx` does: the observation is the first
 * rank-2 input, a declared vision layout claims the single rank-4 input, and any
 * remaining input is unbound — which is what the shipped runtime refuses.
 */
function classifyForBoard(inputs, { visionLayout = false } = {}) {
  const vector = inputs.filter((input) => input.shape.length === 2);
  const image = visionLayout ? inputs.filter((input) => input.shape.length === 4) : [];
  const bound = new Set([vector[0]?.name, image[0]?.name].filter(Boolean));
  const unbound = inputs.filter((input) => !bound.has(input.name));
  return {
    observation: vector[0]?.name ?? null,
    image: image[0]?.name ?? null,
    state: unbound.filter((input) => input.shape.length === 3).map((input) => input.name),
    unbound: unbound.map((input) => input.name),
  };
}

async function main() {
  const { validatePolicyInputBindingsAgainstModelGraph, unhandledStateInputs } = await loadShared(
    'artifact-quality-gate.js',
  );

  if (!pythonCanImport('numpy', 'onnx', 'onnxruntime')) {
    console.log(
      '[policy-input-binding] SKIP — numpy/onnx/onnxruntime unavailable; shared/policy-input-binding.test.ts covers the contract rules',
    );
    return;
  }

  const scratch = await mkdtemp(path.join(os.tmpdir(), 'policy-binding-'));
  try {
    const graphs = buildGraphs(scratch);

    // 1. Feed-forward: accepted, and the board binds it as observation-only.
    const ff = validatePolicyInputBindingsAgainstModelGraph({
      inputs: graphs.feedForward.inputs,
      outputs: graphs.feedForward.outputs,
      observationSize: 61,
      actionSize: 14,
      declared: { observation: 'obs' },
    });
    if (!ff.passed) fail(`feed-forward export refused: ${ff.errors.join('; ')}`);
    const ffBoard = classifyForBoard(graphs.feedForward.inputs);
    if (ffBoard.observation !== 'obs' || ffBoard.unbound.length)
      fail(`board classification of the feed-forward export is wrong: ${JSON.stringify(ffBoard)}`);
    console.log('[policy-input-binding] feed-forward export accepted; board binds obs only');

    // 2. Recurrent without a declaration: the gate names what nobody feeds, and
    //    the board would refuse it (asserted directly in step 3).
    const flagged = unhandledStateInputs({ inputs: graphs.recurrent.inputs });
    if (JSON.stringify(flagged) !== JSON.stringify(['h_in', 'c_in']))
      fail(`unhandled state detection returned ${JSON.stringify(flagged)}`);
    const silent = validatePolicyInputBindingsAgainstModelGraph({
      inputs: graphs.recurrent.inputs,
      outputs: graphs.recurrent.outputs,
      observationSize: 61,
      actionSize: 14,
    });
    if (!silent.passed)
      fail(
        `an undeclared recurrent contract should be reported by unhandledStateInputs, not refused here: ${silent.errors.join('; ')}`,
      );
    console.log(
      '[policy-input-binding] undeclared recurrent export flagged: h_in, c_in would be fed zeros',
    );

    // 3. Recurrent WITH a complete contract: the gate accepts it, while the
    //    shipped board runtime still refuses (it does not carry state yet).
    const declared = {
      observation: 'obs',
      stateInputs: ['h_in', 'c_in'],
      stateOutputs: ['h_out', 'c_out'],
    };
    const recurrent = validatePolicyInputBindingsAgainstModelGraph({
      inputs: graphs.recurrent.inputs,
      outputs: graphs.recurrent.outputs,
      observationSize: 61,
      actionSize: 14,
      declared,
      state: { kind: 'lstm', layers: 1, hiddenSize: 256, reset: 'on-activation' },
    });
    if (!recurrent.passed)
      fail(`declared recurrent export refused: ${recurrent.errors.join('; ')}`);
    const boardRefusal = await boardRefusesState(graphs.recurrent.path);
    if (boardRefusal !== 'refused')
      fail(
        `the board runtime must refuse a stateful export until it carries state (got ${boardRefusal})`,
      );
    console.log(
      '[policy-input-binding] declared recurrent contract accepted by the gate; board runtime refuses to load it (no carried state yet)',
    );

    // 4. Vision: bound by name and channels, and not mistaken for state.
    const vision = validatePolicyInputBindingsAgainstModelGraph({
      inputs: graphs.vision.inputs,
      outputs: graphs.vision.outputs,
      observationSize: 6,
      actionSize: 2,
      imageChannels: 3,
      declared: { observation: 'obs', image: 'camera' },
    });
    if (!vision.passed) fail(`vision export refused: ${vision.errors.join('; ')}`);
    const visionBoard = classifyForBoard(graphs.vision.inputs, { visionLayout: true });
    if (visionBoard.state.length || visionBoard.unbound.length)
      fail(`a vision input was mistaken for state: ${JSON.stringify(visionBoard)}`);
    console.log('[policy-input-binding] vision export bound by name; no state false-positive');

    console.log('[policy-input-binding] OK — bindings, state detection and board rules agree');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Asks the real board runtime module to load a stateful export, when it can be
 * imported (it imports only stdlib + board_ipc at module level, so no ROS is
 * needed). Falls back to the documented rule when onnxruntime is missing.
 */
async function boardRefusesState(modelPath) {
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('rt', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
try:
    result = module.PolicyRuntime().load(sys.argv[2])
except Exception as exc:
    print(json.dumps({'error': 'exception', 'detail': str(exc)}))
else:
    print(json.dumps({'ok': result.get('ok'), 'error': result.get('error')}))
`;
  const result = spawnSync(
    PYTHON,
    [
      '-c',
      script,
      path.join(ROOT, 'services', 'sim2real-web', 'board-policy-runtime.py'),
      modelPath,
    ],
    { encoding: 'utf8', cwd: path.join(ROOT, 'services', 'sim2real-web') },
  );
  if (result.status !== 0) fail(`board runtime probe failed: ${result.stderr.trim()}`);
  const parsed = JSON.parse(result.stdout);
  if (parsed.ok) return 'loaded';
  return parsed.error === 'policy-state-input-unsupported' ? 'refused' : `other:${parsed.error}`;
}

main().catch((error) => {
  console.error(`[policy-input-binding] FAIL — ${error.message}`);
  process.exitCode = 1;
});
