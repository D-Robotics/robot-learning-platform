#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('./reify-deployment-optional-deps.mjs', import.meta.url));

function fixture(t, packages, installed) {
  const target = mkdtempSync(path.join(tmpdir(), 'reify-deployment-test.'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  writeFileSync(path.join(target, 'package-lock.json'), JSON.stringify({ packages }));
  for (const location of installed) {
    mkdirSync(path.join(target, location), { recursive: true });
    writeFileSync(
      path.join(target, location, 'package.json'),
      JSON.stringify({ name: location.split('node_modules/').at(-1), ...packages[location] }),
    );
  }
  return target;
}

function run(target, dryRun = true, env = {}) {
  return spawnSync(
    process.execPath,
    [script, '--target', target, ...(dryRun ? ['--dry-run'] : [])],
    {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    },
  );
}

const linuxAddon = (version) => ({ version, optional: true, os: ['linux'], cpu: ['x64'] });

test('finds a hoisted Linux optional dependency without including other platforms', (t) => {
  const target = fixture(
    t,
    {
      '': { dependencies: { host: '1.0.0' } },
      'node_modules/host': {
        version: '1.0.0',
        optionalDependencies: { 'native-linux': '1.0.0', 'native-darwin': '1.0.0' },
      },
      'node_modules/native-linux': linuxAddon('1.0.0'),
      'node_modules/native-darwin': { ...linuxAddon('1.0.0'), os: ['darwin'] },
    },
    ['node_modules/host'],
  );
  const result = run(target);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /native-linux@1\.0\.0/);
  assert.doesNotMatch(result.stdout, /native-darwin/);
});

test('keeps nested versions separate when discovering Linux dependencies', (t) => {
  const target = fixture(
    t,
    {
      '': { dependencies: { outer: '1.0.0', bridge: '2.0.0' } },
      'node_modules/outer': { version: '1.0.0', dependencies: { bridge: '1.0.0' } },
      'node_modules/outer/node_modules/bridge': {
        version: '1.0.0',
        optionalDependencies: { 'native-linux': '1.0.0' },
      },
      'node_modules/outer/node_modules/native-linux': linuxAddon('1.0.0'),
      'node_modules/bridge': {
        version: '2.0.0',
        optionalDependencies: { 'native-linux': '2.0.0' },
      },
      'node_modules/native-linux': linuxAddon('2.0.0'),
    },
    ['node_modules/outer', 'node_modules/outer/node_modules/bridge', 'node_modules/bridge'],
  );
  const result = run(target);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /native-linux@1\.0\.0/);
  assert.match(result.stdout, /native-linux@2\.0\.0/);
});

test('finds a missing platform optional dependency declared directly by the root', (t) => {
  const target = fixture(
    t,
    {
      '': { optionalDependencies: { 'native-linux': '1.0.0' } },
      'node_modules/native-linux': linuxAddon('1.0.0'),
    },
    [],
  );
  const result = run(target);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /native-linux@1\.0\.0/);
});

test('extracts a verified nested addon into its locked location', (t) => {
  const target = fixture(
    t,
    {
      '': { dependencies: { host: '1.0.0' } },
      'node_modules/host': {
        version: '1.0.0',
        optionalDependencies: { 'native-linux': '1.0.0' },
      },
      'node_modules/host/node_modules/native-linux': linuxAddon('1.0.0'),
    },
    ['node_modules/host'],
  );
  const packageDir = path.join(target, 'archive', 'package');
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    path.join(packageDir, 'package.json'),
    JSON.stringify({ name: 'native-linux', version: '1.0.0' }),
  );
  const archive = path.join(target, 'native-linux-1.0.0.tgz');
  execFileSync('tar', ['-czf', archive, '-C', path.dirname(packageDir), 'package'], {
    env: { ...process.env, LC_ALL: 'C' },
  });
  const lockPath = path.join(target, 'package-lock.json');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  lock.packages['node_modules/host/node_modules/native-linux'].integrity =
    `sha512-${createHash('sha512').update(readFileSync(archive)).digest('base64')}`;
  writeFileSync(lockPath, JSON.stringify(lock));
  const bin = path.join(target, 'bin');
  mkdirSync(bin);
  const npm = path.join(bin, 'npm');
  writeFileSync(
    npm,
    `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst path = require('node:path');\nconst args = process.argv.slice(2);\nfs.copyFileSync(process.env.FIXTURE_ARCHIVE, path.join(args[args.indexOf('--pack-destination') + 1], 'native-linux-1.0.0.tgz'));\n`,
  );
  chmodSync(npm, 0o755);
  const result = run(target, false, {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    FIXTURE_ARCHIVE: archive,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    JSON.parse(
      readFileSync(path.join(target, 'node_modules/host/node_modules/native-linux/package.json')),
    ).version,
    '1.0.0',
  );

  // A matching name/version cannot bypass the locked archive digest.
  rmSync(path.join(target, 'node_modules/host/node_modules/native-linux'), { recursive: true });
  lock.packages['node_modules/host/node_modules/native-linux'].integrity = 'sha512-invalid';
  writeFileSync(lockPath, JSON.stringify(lock));
  const rejected = run(target, false, {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    FIXTURE_ARCHIVE: archive,
  });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /integrity mismatch/);
});

test('rejects an addon whose ordinary dependency is absent', (t) => {
  const target = fixture(
    t,
    {
      '': { dependencies: { host: '1.0.0' } },
      'node_modules/host': {
        version: '1.0.0',
        optionalDependencies: { 'native-linux': '1.0.0' },
      },
      'node_modules/native-linux': {
        ...linuxAddon('1.0.0'),
        dependencies: { 'missing-runtime': '1.0.0' },
      },
      'node_modules/missing-runtime': { version: '1.0.0' },
    },
    ['node_modules/host'],
  );
  const result = run(target);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing-runtime/);
});
