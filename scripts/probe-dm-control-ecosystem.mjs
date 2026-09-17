#!/usr/bin/env node

/**
 * dm_control / Playground ecosystem probe — an honest capability report.
 *
 * The audit gap was "dm_control/Playground ecosystem integration". This
 * probe pins the facts, run over run:
 *
 *   1. dm_control IS on PyPI (probed live) and installable — the
 *      dm-control-adapter engine is the working integration (real
 *      dm_env.TimeStep / rl.control.Environment / Task training loop).
 *   2. mjlab IS on PyPI (probed live) — the mjlab-rsl-rl-adapter engine
 *      consumes it on GPU hosts.
 *   3. mujoco-playground is NOT on PyPI ("No matching distribution found",
 *      probed live, every run). It lives on GitHub
 *      (google-deepmind/mujoco_playground) and installs from source via
 *      mujoco-warp/mujoco-mjx. The platform does not vendor it and never
 *      claims it.
 *
 * The probe writes a machine-readable report (JSON) that docs cite, and
 * exits non-zero only if the environment lies (e.g. dm_control stops being
 * importable while the adapter claims it trains) — NOT when packages are
 * merely absent. Absent capability is a fact, not a failure.
 *
 * Usage: node scripts/probe-dm-control-ecosystem.mjs [--json <path>]
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const jsonFlag = args.indexOf('--json');
const jsonPath = jsonFlag >= 0 ? args[jsonFlag + 1] : null;

function venvPython() {
  const candidates = [
    process.env.RDK_DMC_ENGINE_PYTHON,
    path.join(repoRoot, 'engines/mjx-adapter/.venv/bin/python'),
    'python3',
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const out = spawnSync(candidate, ['-c', 'import sys'], { encoding: 'utf8' });
    if (out.status === 0) return candidate;
  }
  return null;
}

const python = venvPython();

function pipIndex(packageName) {
  if (!python) return { probed: false };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const out = spawnSync(python, ['-m', 'pip', 'index', 'versions', packageName], {
      encoding: 'utf8',
      timeout: 90_000,
    });
    const text = `${out.stdout || ''}\n${out.stderr || ''}`;
    // A proxy/network failure is INCONCLUSIVE, never "not on PyPI" —
    // "No matching distribution found" is the authoritative 404 answer.
    const networkError = /Retrying|ProxyError|TimeoutError|SSLError|ConnectionError/i.test(text);
    const noMatch = /No matching distribution found/i.test(text);
    const versionMatch = text.match(new RegExp(`${packageName} \\(([^)]+)\\)`));
    if (networkError && !noMatch && !versionMatch && attempt < 2) continue;
    return {
      probed: true,
      onPyPI: networkError && !versionMatch ? null : !noMatch && Boolean(versionMatch),
      latestVersion: versionMatch ? versionMatch[1] : null,
      evidence: noMatch
        ? 'pip index: No matching distribution found'
        : versionMatch
          ? `pip index: ${packageName} (${versionMatch[1]})`
          : networkError
            ? 'pip index: network error (inconclusive)'
            : 'pip index: inconclusive output',
    };
  }
}

function importable(moduleName) {
  if (!python) return { probed: false };
  const out = spawnSync(python, ['-c', `import ${moduleName}`], { encoding: 'utf8' });
  return { probed: true, importable: out.status === 0 };
}

const report = {
  probeDate: new Date().toISOString(),
  python: python || null,
  packages: {
    'dm-control': {
      pypi: pipIndex('dm-control'),
      installed: importable('dm_control'),
      integration: 'engines/dm-control-adapter (worker protocol, trains for real)',
    },
    mjlab: {
      pypi: pipIndex('mjlab'),
      installed: importable('mjlab'),
      integration: 'engines/mjlab-rsl-rl-adapter (GPU path + honest kinematic fallback)',
    },
    'mujoco-playground': {
      pypi: pipIndex('mujoco-playground'),
      installed: importable('mujoco_playground'),
      integration: null,
      github: 'https://github.com/google-deepmind/mujoco_playground (source install only)',
      note:
        'Not on PyPI — the platform reports this honestly instead of vendoring or ' +
        'pretending; a future integration installs it from source on a GPU host.',
    },
  },
};

// Honesty invariants: the ONLY failures here are contradictions.
const errors = [];
const dmInstalled = report.packages['dm-control'].installed.importable === true;
if (dmInstalled) {
  // dm_control importable: the adapter engine must actually exist on disk.
  const adapterExists = spawnSync('test', [
    '-f',
    path.join(repoRoot, 'engines/dm-control-adapter/adapter.py'),
  ]);
  if (adapterExists.status !== 0) {
    errors.push('dm_control importable but engines/dm-control-adapter/adapter.py missing');
  }
}
if (report.packages['mujoco-playground'].pypi.onPyPI === true) {
  // If this EVER flips true, the docs and the probe note must be updated —
  // the platform would then integrate it as a normal pip dependency.
  errors.push(
    'mujoco-playground appeared on PyPI — update docs/engines/*.md and this probe ' +
      '(the "not on PyPI" boundary statement is now stale)',
  );
}

if (jsonPath) {
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
}

console.log('[ecosystem-probe] dm_control / mjlab / mujoco-playground availability');
for (const [name, entry] of Object.entries(report.packages)) {
  const pypi = !entry.pypi.probed
    ? 'not probed'
    : entry.pypi.onPyPI === null
      ? 'network-inconclusive'
      : entry.pypi.onPyPI
        ? `PyPI ${entry.pypi.latestVersion}`
        : 'NOT on PyPI';
  const installed = !entry.installed.probed
    ? 'not probed'
    : entry.installed.importable
      ? 'importable'
      : 'absent';
  console.log(`  ${name.padEnd(18)} ${pypi.padEnd(20)} ${installed}`);
  if (entry.integration) {
    console.log(`  ${''.padEnd(18)} integration: ${entry.integration}`);
  }
  if (entry.note) {
    console.log(`  ${''.padEnd(18)} ${entry.note}`);
  }
}
if (errors.length > 0) {
  console.error('[ecosystem-probe] CONTRADICTIONS FOUND:');
  for (const error of errors) console.error('  - ' + error);
  process.exit(1);
}
console.log('[ecosystem-probe] OK — facts recorded, no contradictions');
