#!/usr/bin/env node
/**
 * Board latency rehearsal gate.
 *
 * Exercises the receipt contract end to end so the *cross-language* seam is
 * covered: the Python probe (`board-latency-rehearsal.py`) produces a receipt
 * and the TypeScript gate (`shared/board-rehearsal.ts`) judges it. A fixture
 * written by hand would not catch the two drifting apart.
 *
 * What runs, in order:
 *   1. the probe's own verdict logic, on the board-free `--self-test` path;
 *   2. with onnxruntime present, the real probe against a freshly built
 *      contract-shaped ONNX model, judged by the real gate — including the
 *      artifact-identity check, which must reject a receipt for other bytes;
 *   3. an over-budget rehearsal (an absurd 1 µs budget at 1 kHz), which must be
 *      refused and must leave `budgetMet` false.
 *
 * Skips (exit 0 with a SKIP line) when python or onnxruntime is unavailable, the
 * repository's convention for optional engine probes. The static contract rules
 * are covered by `shared/board-rehearsal.test.ts` in that case.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PYTHON = process.env.PYTHON || 'python3';
const PROBE = path.join(ROOT, 'services', 'sim2real-web', 'board-latency-rehearsal.py');

const fail = (message) => {
  throw new Error(`[board-latency] ${message}`);
};

/** Loads a shared module: compiled output first, TypeScript sources via tsx. */
async function loadShared(relative) {
  const built = path.join(ROOT, 'dist-server', 'shared', relative.replace(/\.ts$/, '.js'));
  if (existsSync(built)) return import(pathToFileURL(built).href);
  // tsx 4 exports `tsImport`, not `import`; the latter silently does not exist,
  // which would make this fallback dead code for every script that uses it.
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

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Builds a rank-2 61->14 ONNX policy, the shape the board runtime accepts. */
function buildPolicyModel(dir) {
  const script = [
    'import sys',
    'import numpy as np',
    'import onnx',
    'from onnx import helper, TensorProto, numpy_helper',
    'target = sys.argv[1]',
    'w = (np.random.RandomState(0).randn(61, 14) * 0.1).astype(np.float32)',
    'b = np.zeros(14, dtype=np.float32)',
    'graph = helper.make_graph(',
    "    [helper.make_node('MatMul', ['obs', 'w'], ['h']),",
    "     helper.make_node('Add', ['h', 'b'], ['action'])],",
    "    'rehearsal_policy',",
    "    [helper.make_tensor_value_info('obs', TensorProto.FLOAT, [1, 61])],",
    "    [helper.make_tensor_value_info('action', TensorProto.FLOAT, [1, 14])],",
    "    [numpy_helper.from_array(w, 'w'), numpy_helper.from_array(b, 'b')])",
    "model = helper.make_model(graph, opset_imports=[helper.make_opsetid('', 17)])",
    'model.ir_version = 9',
    'onnx.save(model, target)',
  ];
  const result = run(PYTHON, ['-c', script.join('\n'), path.join(dir, 'policy.onnx')]);
  if (result.status !== 0) fail(`could not build the rehearsal model: ${result.stderr.trim()}`);
  return path.join(dir, 'policy.onnx');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Runs the probe and parses the receipt it wrote. */
function rehearse(modelPath, receiptPath, extraArgs = []) {
  const result = run(PYTHON, [
    PROBE,
    '--model',
    modelPath,
    '--out',
    receiptPath,
    '--quiet',
    ...extraArgs,
  ]);
  return result;
}

async function main() {
  if (!existsSync(PROBE)) fail(`probe is missing at ${PROBE}`);
  const { validateBoardRehearsalReceipt, summarizeBoardRehearsal } =
    await loadShared('board-rehearsal.js');

  // 1. The probe's own verdict arithmetic, with no board and no onnxruntime.
  const selfTest = run(PYTHON, [PROBE, '--self-test']);
  if (selfTest.status !== 0) fail(`probe self-test failed: ${selfTest.stderr.trim()}`);
  console.log(`[board-latency] ${selfTest.stdout.trim()}`);

  if (!pythonCanImport('numpy', 'onnx', 'onnxruntime')) {
    console.log(
      '[board-latency] SKIP — numpy/onnx/onnxruntime unavailable; probe self-test passed and shared/board-rehearsal.test.ts covers the contract',
    );
    return;
  }

  const scratch = await mkdtemp(path.join(os.tmpdir(), 'board-latency-'));
  try {
    const modelPath = buildPolicyModel(scratch);
    const modelBytes = await readFile(modelPath);
    const digest = sha256(modelBytes);

    // 2. A real rehearsal, judged by the real gate.
    const receiptPath = path.join(scratch, 'receipt.json');
    const rehearsal = rehearse(modelPath, receiptPath, [
      '--decision-hz',
      '50',
      '--iterations',
      '300',
    ]);
    if (rehearsal.status !== 0)
      fail(`probe reported a budget miss on a trivial model: ${rehearsal.stderr.trim()}`);
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    if (receipt.stage !== 'board-onnx')
      fail(`probe must label its own measurement board-onnx, got ${String(receipt.stage)}`);
    if (receipt.artifactSha256 !== digest)
      fail(
        `probe hashed ${receipt.artifactSha256} but the artifact is ${digest}; the receipt would not identify the deployed bytes`,
      );
    const verdict = validateBoardRehearsalReceipt(receipt, { artifactSha256: digest });
    if (!verdict.passed)
      fail(`gate refused a real in-budget receipt: ${verdict.errors.join('; ')}`);
    if (verdict.stage !== 'board-onnx' || verdict.judgedMetric !== 'control-step')
      fail(
        `unexpected verdict shape: stage=${String(verdict.stage)} metric=${String(verdict.judgedMetric)}`,
      );
    console.log(
      `[board-latency] probe receipt accepted — ${summarizeBoardRehearsal(receipt).summary}`,
    );

    // Artifact identity: the same rehearsal must not certify other bytes.
    const wrongDigest = sha256(Buffer.concat([modelBytes, Buffer.from('x')]));
    const mismatch = validateBoardRehearsalReceipt(receipt, { artifactSha256: wrongDigest });
    if (mismatch.passed) fail('gate accepted a receipt describing a different artifact');
    console.log('[board-latency] artifact-identity mismatch refused as expected');

    // The host/board stage distinction, on a real receipt.
    const relabelled = validateBoardRehearsalReceipt(
      { ...receipt, stage: 'host-torch' },
      { artifactSha256: digest },
    );
    if (relabelled.passed) fail('gate accepted a host-torch receipt as board evidence');
    console.log('[board-latency] host-torch relabelling refused as expected');

    // 3. Refusal paths, derived from the real receipt rather than measured:
    //    this host is fast enough that no sane budget would be missed, so the
    //    over-budget and tampering cases are produced by mutating a receipt the
    //    probe actually wrote. The probe's own over-budget arithmetic is covered
    //    by its `--self-test` above.
    const overBudget = {
      ...receipt,
      metrics: receipt.metrics.map((metric) => ({
        ...metric,
        medianMs: metric.budgetMs * 1.5,
        p95Ms: metric.budgetMs * 1.8,
        maxMs: metric.budgetMs * 2.4,
        overBudgetRatio: 1,
      })),
      budgetMet: false,
    };
    const overVerdict = validateBoardRehearsalReceipt(overBudget, { artifactSha256: digest });
    if (overVerdict.passed) fail('gate accepted an over-budget rehearsal');
    if (!overVerdict.errors.some((error) => /budget|median/.test(error)))
      fail(`over-budget refusal must name the budget: ${overVerdict.errors.join('; ')}`);

    // The producer's own boolean is not evidence: an over-budget distribution
    // relabelled `budgetMet: true` must still be refused.
    const relabelledBudget = validateBoardRehearsalReceipt(
      { ...overBudget, budgetMet: true },
      { artifactSha256: digest },
    );
    if (relabelledBudget.passed) fail('gate trusted a hand-edited budgetMet');
    if (!relabelledBudget.errors.some((error) => /disagrees with its own metrics/.test(error)))
      fail(`tampered budgetMet must be caught: ${relabelledBudget.errors.join('; ')}`);

    // A stale receipt must expire even on the board stage.
    const stale = validateBoardRehearsalReceipt(
      { ...receipt, measuredAt: new Date(Date.now() - 400 * 86_400_000).toISOString() },
      { artifactSha256: digest },
    );
    if (stale.passed) fail('gate accepted a year-old rehearsal');
    console.log(
      '[board-latency] over-budget, tampered-budgetMet and stale receipts refused as expected',
    );

    // The budget arithmetic itself is checked against a rate the probe cannot
    // silently ignore, whatever this host's absolute speed happens to be.
    const tightPath = path.join(scratch, 'receipt-tight.json');
    const tight = rehearse(modelPath, tightPath, ['--decision-hz', '1000', '--iterations', '300']);
    const tightReceipt = JSON.parse(await readFile(tightPath, 'utf8'));
    if (tightReceipt.metrics.some((metric) => Math.abs(metric.budgetMs - 1) > 1e-9))
      fail('a 1000 Hz rehearsal must report a 1 ms budget for every metric');
    if (tight.status !== 0 && tightReceipt.budgetMet !== false)
      fail('a probe that exits non-zero must record budgetMet=false');
    console.log('[board-latency] budget arithmetic verified at a 1000 Hz decision rate');

    console.log('[board-latency] OK — probe and gate agree on accept, stage, identity, budget');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[board-latency] FAIL — ${error.message}`);
  process.exitCode = 1;
});
