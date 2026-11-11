import test from 'node:test';
import assert from 'node:assert/strict';
import { patchRunProgressTrack } from './patch-run-progress-track.mjs';

const html = '<link rel="stylesheet" href="./app.css?v=duck-lab-99">';
const css = `body #train-module-run-model .run-progress-track {
  height: 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--line-strong) 62%, transparent);
}`;

test('progress track keeps centered status text legible and invalidates the CSS cache key', () => {
  const result = patchRunProgressTrack(html, css);
  assert.match(result.css, /height: 22px;/);
  assert.match(result.html, /app\.css\?v=duck-lab-100/);
  assert.equal(result.cssSha256.length, 64);
  assert.equal(result.htmlSha256.length, 64);
});

test('patch fails closed when the deployed style or reference is missing or duplicated', () => {
  assert.throws(() => patchRunProgressTrack(html + html, css), /app\.css cache key/);
  assert.throws(() => patchRunProgressTrack(html, css + css), /8px progress track/);
  assert.throws(
    () => patchRunProgressTrack(html, css.replace('8px', '10px')),
    /8px progress track/,
  );
});
