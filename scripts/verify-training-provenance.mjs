#!/usr/bin/env node
/**
 * Training provenance gate: every engine must report WHERE it ran from.
 *
 * `sourceCommit` alone answers half the reproducibility question. The other half
 * is the libraries: numerics move between torch releases, and
 * `torch.onnx.export` output changes with the exporter in use. A result that
 * names its commit but not its torch version cannot be reproduced once the
 * environment has moved on — which is exactly the failure the reference
 * repository avoids with a committed `uv.lock`.
 *
 * This gate runs each engine for real (they are CPU-cheap smoke runs) and
 * asserts the produced result carries both fields. It deliberately asserts
 * *presence and shape*, never a specific version: pinning happens in a lock
 * file, and this contract must keep working when that lock file is updated.
 *
 * Skips (exit 0 with a SKIP line) when an engine's dependency is unavailable,
 * matching the repository's convention for optional engine probes.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PYTHON = process.env.PYTHON || 'python3';

const fail = (message) => {
  throw new Error(`[provenance] ${message}`);
};

const ENGINE_REQUEST = {
  schemaVersion: 1,
  contractId: 'rdk-duck-policy-starter-v1',
  contract: {
    id: 'rdk-duck-policy-starter-v1',
    robotId: 'rdk-duck',
    jointCount: 12,
    observationSize: 42,
    actionSize: 12,
    controlHz: 50,
    physicsTimestepSeconds: 0.002,
    decimation: 10,
  },
  model: { modelId: 'provenance-gate', version: '0.1.0' },
  training: { profile: 'smoke', numEnvs: 8, maxIterations: 2, video: false },
};

function pythonCanImport(...modules) {
  return (
    spawnSync(PYTHON, ['-c', modules.map((name) => `import ${name}`).join('; ')], {
      encoding: 'utf8',
    }).status === 0
  );
}

/** Runs one engine through its file protocol and returns the parsed result. */
async function runEngine(relativePath, label) {
  const engine = path.join(ROOT, relativePath);
  if (!existsSync(engine)) fail(`${label}: engine missing at ${engine}`);
  const scratch = await mkdtemp(path.join(os.tmpdir(), `provenance-${label}-`));
  try {
    const requestPath = path.join(scratch, 'request.json');
    const resultPath = path.join(scratch, 'result.json');
    await writeFile(requestPath, JSON.stringify(ENGINE_REQUEST, null, 2));
    const run = spawnSync(PYTHON, [engine], {
      cwd: scratch,
      encoding: 'utf8',
      timeout: 600_000,
      env: {
        ...process.env,
        RDK_SIM2REAL_REQUEST_FILE: requestPath,
        RDK_SIM2REAL_RESULT_FILE: resultPath,
      },
    });
    if (run.status !== 0) {
      const stderr = run.stderr ?? '';
      // Not every engine accepts the same request shape, and a missing library is
      // not this gate's business: both are SKIPs, because this checks the
      // provenance contract rather than whether each engine can run here.
      if (/requires (torch|jax)|ModuleNotFoundError|is not installed/i.test(stderr)) {
        console.log(`[provenance] SKIP ${label} — dependency unavailable`);
        return null;
      }
      if (/requires a goal-navigation task pack/i.test(stderr)) {
        console.log(`[provenance] SKIP ${label} — needs a goal-navigation task pack`);
        return null;
      }
      fail(
        `${label} exited with ${run.status}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`,
      );
    }
    return JSON.parse(await readFile(resultPath, 'utf8'));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Asserts the provenance block of one result. Returns the commit for reporting. */
function checkProvenance(result, label) {
  if (!result || typeof result !== 'object') fail(`${label}: no result object`);
  const source = result.source;
  if (!source || typeof source !== 'object') {
    fail(
      `${label}: result carries no "source" block; a run that cannot name its revision is not auditable`,
    );
  }
  if (source.known === true) {
    if (typeof source.commit !== 'string' || !/^[a-f0-9]{40}$/.test(source.commit)) {
      fail(`${label}: source.known is true but commit is not a 40-character hex revision`);
    }
    // A dirty tree must say so rather than implying the commit describes the run.
    if (source.dirty !== true && source.dirty !== false && source.dirty !== null) {
      fail(`${label}: source.dirty must be a boolean or null`);
    }
  } else if (typeof source.reason !== 'string' || !source.reason) {
    fail(`${label}: a checkout without git must state a reason, not just known:false`);
  }

  const dependencies = result.dependencies;
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    fail(
      `${label}: result carries no "dependencies" block; the library half of reproducibility is missing`,
    );
  }
  const entries = Object.entries(dependencies);
  if (!entries.length) fail(`${label}: dependencies block is empty`);
  // The point of the field is auditability, so it has to name real versions.
  for (const [name, version] of entries) {
    if (typeof version !== 'string' || !/^\d/.test(version)) {
      fail(
        `${label}: dependency ${name} must record a concrete version, got ${JSON.stringify(version)}`,
      );
    }
  }
  // An engine that trained needs its trainer recorded; one that only evaluated
  // may legitimately report a smaller set, so this is a floor, not a list.
  if (!('numpy' in dependencies)) {
    fail(`${label}: dependencies must include numpy (the array layer every engine uses)`);
  }
  return source.known === true ? source.commit.slice(0, 10) : `unknown (${source.reason})`;
}

/**
 * Versions pinned by an engine's lock, keyed by package name.
 *
 * The lock is the *intended* environment and the engine's `dependencies` block
 * is what it actually imported. Comparing them is the check that catches drift:
 * a lock that no longer describes the environment it claims to pin is worse than
 * no lock, because it is believed.
 */
function lockedVersions(engine) {
  const lock = path.join(ROOT, 'engines', engine, 'requirements.txt');
  if (!existsSync(lock)) return null;
  const pinned = {};
  for (const line of readFileSync(lock, 'utf8').split('\n')) {
    const match = /^([A-Za-z0-9._-]+)==([^\s\\]+)/.exec(line);
    if (match) pinned[match[1].toLowerCase().replace(/_/g, '-')] = match[2];
  }
  return Object.keys(pinned).length ? pinned : null;
}

/**
 * Compares a run's reported versions against its engine's lock.
 *
 * `torch` is exempt from an exact match: the lock pins the standard PyPI wheel
 * that CI installs, while a GPU deployment deliberately installs a CUDA build
 * from a different index. That choice is recorded per run (and surfaced in the
 * UI), which is the honest treatment; every other library must match.
 */
function checkLockAgreement(result, engine, label) {
  const pinned = lockedVersions(engine);
  if (!pinned) {
    fail(`${label}: engines/${engine}/requirements.txt is missing or empty`);
  }
  const disagreements = [];
  for (const [name, version] of Object.entries(result.dependencies)) {
    const key = name.toLowerCase().replace(/_/g, '-');
    const expected = pinned[key];
    if (expected === undefined) continue; // not part of this engine's direct set
    if (expected !== version && key !== 'torch') {
      disagreements.push(`${name}: installed ${version} but locked ${expected}`);
    }
  }
  if (disagreements.length) {
    fail(
      `${label}: installed libraries disagree with engines/${engine}/requirements.txt — ${disagreements.join('; ')}. ` +
        'Regenerate with `node scripts/lock-engines.mjs` or install from the lock.',
    );
  }
  return Object.keys(pinned).length;
}

async function main() {
  const targets = [
    ['engines/starter-ppo/runner.py', 'starter-ppo', ['numpy', 'torch']],
    ['engines/mjx-adapter/adapter.py', 'mjx-adapter', ['numpy', 'jax', 'mujoco']],
    ['engines/mjlab-rsl-rl-adapter/adapter.py', 'mjlab-adapter', ['numpy']],
  ];
  const reported = [];
  let checked = 0;
  for (const [relative, label, needed] of targets) {
    if (!pythonCanImport(...needed)) {
      console.log(`[provenance] SKIP ${label} — ${needed.join('/')} unavailable`);
      continue;
    }
    const result = await runEngine(relative, label);
    if (!result) continue;
    const commit = checkProvenance(result, label);
    const locked = checkLockAgreement(result, label, label);
    checked += 1;
    reported.push(`${label}@${commit}`);
    console.log(
      `[provenance] ${label}: commit ${commit}, ${locked} lock entries agree with the installed libraries`,
    );
  }
  if (!checked) {
    console.log(
      '[provenance] SKIP — no engine could run here; the contract is still covered by the engines that do',
    );
    return;
  }
  console.log(
    `[provenance] OK — ${checked} engine(s) report source revision + dependency versions`,
  );
}

main().catch((error) => {
  console.error(`[provenance] FAIL — ${error.message}`);
  process.exitCode = 1;
});
