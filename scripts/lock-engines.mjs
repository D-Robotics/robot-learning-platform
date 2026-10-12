#!/usr/bin/env node
/**
 * Regenerates every engine's pinned dependency lock.
 *
 * The engines' libraries were previously installed with unpinned
 * `pip install --user numpy torch onnx`-style commands, which means a training
 * run could not be reproduced once the environment moved on: `sourceCommit`
 * names the code, but nothing named the libraries. Each engine now carries a
 * `requirements.in` (direct dependencies, hand-edited) and a `requirements.txt`
 * (the full transitive pin plus hashes, generated). This script owns the second
 * file.
 *
 * `uv` is required and is a *development* tool, not a runtime dependency of the
 * platform or the engines: the engines keep running on whatever Python the
 * operator already has, and the lock is what makes that environment
 * reproducible. Hashes are generated so a locked install is verifiable.
 *
 * Usage:
 *   node scripts/lock-engines.mjs            # regenerate every lock
 *   node scripts/lock-engines.mjs --check    # validate the committed pins and hashes
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, renameSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ENGINES = [
  'starter-ppo',
  'mjx-adapter',
  'mjlab-rsl-rl-adapter',
  'microduck-eval',
  'microduck-recurrent',
  'offline-bc',
  'act',
  'diffusion-policy',
  'smolvla',
  // A CLI format tool, not a training engine — but its pyarrow/numpy pins
  // deserve the same reproducible-lock treatment as the engines.
  'lerobot-converter',
];
const check = process.argv.includes('--check');

/**
 * uv writes its cache outside the workspace by default, which fails under a
 * restricted sandbox. A workspace-local cache keeps the command runnable
 * wherever the repository is checked out.
 */
function uvEnvironment() {
  return { ...process.env, UV_CACHE_DIR: path.join(ROOT, '.data', 'uv-cache') };
}

function uvAvailable() {
  return spawnSync('uv', ['--version'], { encoding: 'utf8' }).status === 0;
}

function compile(source, target, constraint) {
  const args = ['pip', 'compile', source, '-o', target, '--generate-hashes', '--quiet'];
  if (constraint) args.push('-c', constraint);
  return spawnSync('uv', args, {
    encoding: 'utf8',
    cwd: ROOT,
    env: uvEnvironment(),
  });
}

/**
 * Compare requirements rather than uv headers/annotations. Each package must
 * be exactly pinned and hashed. Added upstream wheel hashes may expand the
 * resolver's set without invalidating already committed, verified hashes.
 */
function lockEntries(text) {
  const entries = new Map();
  for (const line of text.replace(/\\\r?\n/g, ' ').split(/\r?\n/)) {
    const requirement = line.trim();
    if (!requirement || requirement.startsWith('#')) continue;
    const hashes = [...requirement.matchAll(/--hash=sha256:([a-f0-9]{64})(?=\s|$)/g)].map(
      (match) => match[1],
    );
    const pin = requirement
      .replace(/--hash=sha256:[a-f0-9]{64}(?=\s|$)/g, '')
      .trim()
      .replace(/\s+/g, ' ');
    const parsed = /^([a-zA-Z0-9][a-zA-Z0-9._-]*)==([^\s;]+)(.*)$/.exec(pin);
    if (!parsed || !hashes.length || pin.includes('--hash'))
      throw new Error('lock must contain exact pins with valid SHA-256 hashes');
    const key = parsed[1].toLowerCase().replace(/[-_.]+/g, '-') + '==' + parsed[2] + parsed[3];
    if (entries.has(key)) throw new Error('duplicate locked requirement: ' + key);
    entries.set(key, new Set(hashes));
  }
  if (!entries.size) throw new Error('lock is empty');
  return entries;
}

function lockMatches(committed, resolved) {
  const expected = lockEntries(committed);
  const actual = lockEntries(resolved);
  return (
    expected.size === actual.size &&
    [...expected].every(([pin, hashes]) => {
      const verified = actual.get(pin);
      return verified && [...hashes].every((hash) => verified.has(hash));
    })
  );
}

function packageCount(text) {
  return text.split('\n').filter((line) => /^[a-z0-9]/.test(line)).length;
}

const missing = ENGINES.filter(
  (engine) => !existsSync(path.join(ROOT, 'engines', engine, 'requirements.in')),
);
if (missing.length) {
  console.error(`[lock-engines] FAIL — missing requirements.in for: ${missing.join(', ')}`);
  process.exit(1);
}
if (!uvAvailable()) {
  // A missing development tool is a SKIP for --check (CI may not install uv) but
  // a hard failure when the operator explicitly asked to regenerate.
  console.log(
    `[lock-engines] ${check ? 'SKIP' : 'FAIL'} — uv is not installed (https://docs.astral.sh/uv/)`,
  );
  process.exit(check ? 0 : 1);
}

const scratch = mkdtempSync(path.join(os.tmpdir(), 'lock-engines-'));
try {
  const stale = [];
  for (const engine of ENGINES) {
    const source = path.join('engines', engine, 'requirements.in');
    const target = path.join('engines', engine, 'requirements.txt');
    const targetPath = path.join(ROOT, target);
    // A check validates the existing solution against the direct requirements,
    // using its pins as constraints. Regeneration deliberately resolves afresh.
    // Both modes write only to scratch until an explicit regeneration succeeds.
    const output = path.join(scratch, `${engine}.txt`);
    if (check) {
      try {
        lockEntries(readFileSync(targetPath, 'utf8'));
      } catch (error) {
        console.error(`[lock-engines] FAIL — ${engine}: ${error.message}`);
        process.exit(1);
      }
    }
    const run = compile(source, output, check ? targetPath : undefined);
    if (run.status !== 0) {
      console.error(`[lock-engines] FAIL — ${engine}: ${(run.stderr || '').trim()}`);
      process.exit(1);
    }
    if (check) {
      const fresh = readFileSync(output, 'utf8');
      const committed = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : '';
      if (!lockMatches(committed, fresh)) stale.push(engine);
      else
        console.log(`[lock-engines] ${engine}: lock is current (${packageCount(fresh)} packages)`);
    } else {
      // Stage inside the target directory so the final rename is atomic on
      // one filesystem (scratch lives in os.tmpdir(), possibly another volume).
      const staged = `${targetPath}.tmp`;
      copyFileSync(output, staged);
      renameSync(staged, targetPath);
      const written = readFileSync(targetPath, 'utf8');
      console.log(`[lock-engines] ${engine}: wrote ${target} (${packageCount(written)} packages)`);
    }
  }
  if (stale.length) {
    console.error(
      `[lock-engines] FAIL — stale lock(s): ${stale.join(', ')}. Run: node scripts/lock-engines.mjs`,
    );
    process.exit(1);
  }
  if (check) console.log('[lock-engines] OK — every engine lock matches its requirements.in');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
