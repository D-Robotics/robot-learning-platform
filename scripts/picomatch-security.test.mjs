import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('installed picomatch rejects the CVE-2026-112366 inputs within a bounded child process', () => {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=commonjs',
      '-e',
      `
    const assert = require('node:assert/strict');
    const pm = require('picomatch');
    for (const pattern of ['+(*a)', '*(*a)', '+(*a)c', '+(*)c', '*(*)c', '+(a*)c']) {
      assert.equal(pm.isMatch('a'.repeat(50) + 'b', pattern), false, pattern);
    }
    for (const pattern of ['+(*)', '+(*a)', '*(*a)', '+(a*)', '+(a*b)', '*(*.js)']) {
      assert.equal(/\\)[+*]/.test(pm.makeRe(pattern).source), false, pattern);
    }
  `,
    ],
    { cwd: root, encoding: 'utf8', timeout: 2000 },
  );
  assert.equal(child.error, undefined, String(child.error));
  assert.equal(child.status, 0, child.stderr);
});

test('the patched dependency preserves repeated-star glob semantics and normal tooling globs', () => {
  const pm = require('picomatch');
  for (const [input, pattern, expected] of [
    ['abc', '+(*)c', true],
    ['aaa', '+(*a)', true],
    ['a.a', '+(*a)', true],
    ['ab', '+(*a)', false],
    ['axbayb', '+(a*b)', true],
    ['axbay', '+(a*b)', false],
    ['foo.js', '*(*.js)', true],
    ['foo.ts', '*(*.js)', false],
    ['src/nested/a.test.ts', '**/*.{test,spec}.{ts,mjs}', true],
    ['src/a.js', '**/*.{test,spec}.{ts,mjs}', false],
    ['ab', '+(a|b)', true],
    ['aaa', '+(a)', true],
    ['a*b', '+(a\\*b)', true],
  ])
    assert.equal(pm.isMatch(input, pattern), expected, `${pattern}: ${input}`);
  for (const input of ['', 'a', 'aa', 'ab', 'axbayb', '.a', 'a/a', 'a\\a']) {
    for (const pattern of ['+(*a)', '*(a*)', '+(a*b)', '*(*.js)', '+([ab]*)']) {
      assert.equal(
        pm.isMatch(input, pattern, { dot: true }),
        pm.isMatch(input, pattern, { dot: true, maxExtglobRecursion: false }),
        `${pattern}: ${input}`,
      );
    }
  }
});

test('Vitest, Vite and tinyglobby all resolve the reviewed patched package', () => {
  const reviewed = require.resolve('picomatch');
  for (const consumer of ['vitest', 'vite', 'tinyglobby']) {
    const consumerRequire = createRequire(require.resolve(consumer));
    assert.equal(consumerRequire.resolve('picomatch'), reviewed, consumer);
  }
  assert.equal(require('picomatch/package.json').version, '4.0.7-rdk.1');
});
