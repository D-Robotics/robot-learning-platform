import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./lock-engines.mjs', import.meta.url));
const engines = [...readFileSync(script, 'utf8').matchAll(/^ {2}'([a-z0-9-]+)',/gm)].map(
  (match) => match[1],
);
assert.equal(engines.length, 10);
const fixture = mkdtempSync(path.join(os.tmpdir(), 'engine-lock-check-'));
const pin = (name, version, hash = 'a'.repeat(64)) => `${name}==${version} --hash=sha256:${hash}\n`;
const original = pin('direct', '1.0') + pin('transitive', '1.0');
try {
  mkdirSync(path.join(fixture, 'scripts'));
  mkdirSync(path.join(fixture, 'bin'));
  copyFileSync(script, path.join(fixture, 'scripts', 'lock-engines.mjs'));
  for (const engine of engines) {
    const dir = path.join(fixture, 'engines', engine);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'requirements.in'), 'direct==1.0\n');
    writeFileSync(path.join(dir, 'requirements.txt'), original);
  }
  const uv = path.join(fixture, 'bin', 'uv');
  writeFileSync(
    uv,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('uv fixture'); process.exit(0); }
const source = fs.readFileSync(args[args.indexOf('compile') + 1], 'utf8');
const output = args[args.indexOf('-o') + 1];
const index = args.indexOf('--constraint') >= 0 ? args.indexOf('--constraint') : args.indexOf('-c');
const constraint = index >= 0 ? fs.readFileSync(args[index + 1], 'utf8') : '';
if (source.includes('direct==2.0') && constraint.includes('direct==1.0')) { console.error('incompatible direct requirement'); process.exit(1); }
const pin = (name, version, hash = 'a'.repeat(64)) => name + '==' + version + ' --hash=sha256:' + hash + (process.env.FAKE_UV_ADDITIONAL_HASH === '1' ? ' --hash=sha256:' + 'c'.repeat(64) : '') + '\\n';
const old = constraint.includes('transitive==1.0');
let result = '# different output path and constraint annotation\\n' + pin('direct', source.includes('direct==2.0') ? '2.0' : '1.0') + pin('transitive', old ? '1.0' : '2.0');
if (source.includes('newdep')) result += pin('newdep', '3.0');
fs.writeFileSync(output, result);
`,
  );
  chmodSync(uv, 0o700);
  const run = (args = [], extraEnv = {}) =>
    spawnSync(process.execPath, ['scripts/lock-engines.mjs', ...args], {
      cwd: fixture,
      env: {
        ...process.env,
        ...extraEnv,
        PATH: path.join(fixture, 'bin') + path.delimiter + process.env.PATH,
      },
      encoding: 'utf8',
    });
  const check = (extraEnv = {}) => run(['--check'], extraEnv);
  const initial = check();
  assert.equal(
    initial.status,
    0,
    'a valid pinned transitive dependency must survive an upstream release: ' + initial.stderr,
  );
  const target = path.join(fixture, 'engines', engines[0], 'requirements.txt');
  const source = path.join(fixture, 'engines', engines[0], 'requirements.in');
  assert.equal(readFileSync(target, 'utf8'), original, 'check is read-only');
  const additionalHashes = check({ FAKE_UV_ADDITIONAL_HASH: '1' });
  assert.equal(
    additionalHashes.status,
    0,
    'new valid wheel hashes must not invalidate a verified historical lock: ' +
      additionalHashes.stderr,
  );

  writeFileSync(source, 'direct==2.0\n');
  assert.notEqual(check().status, 0, 'changed direct version must fail');
  writeFileSync(source, 'direct==1.0\nnewdep==3.0\n');
  assert.notEqual(check().status, 0, 'missing newly required dependency must fail');
  writeFileSync(source, 'direct==1.0\n');
  writeFileSync(target, 'direct==1.0\n' + pin('transitive', '1.0'));
  assert.notEqual(check().status, 0, 'an unhashed package must fail');
  writeFileSync(target, pin('direct', '1.0', 'b'.repeat(64)) + pin('transitive', '1.0'));
  assert.notEqual(check().status, 0, 'invalid committed hash must fail');
  writeFileSync(target, original + pin('obsolete', '1.0'));
  assert.notEqual(check().status, 0, 'obsolete dependency must fail');
  writeFileSync(target, original);
  const regenerated = run();
  assert.equal(regenerated.status, 0, regenerated.stderr);
  assert.match(
    readFileSync(target, 'utf8'),
    /transitive==2\.0/,
    'regeneration still resolves newer versions',
  );
  console.log(
    '[lock-engines-test] PASS — stable pinned checks, direct/dependency/hash failures, fresh regeneration',
  );
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
