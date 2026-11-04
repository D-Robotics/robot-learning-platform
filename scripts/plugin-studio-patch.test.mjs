import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  resolveStudioArchive,
  encodeAsarHeader,
  patchAsarBuffer,
  installStudioLoginPatch,
} from '../plugins/rdk-robot-learning-platform/scripts/studio-login-patch.mjs';
const sha = (b) => createHash('sha256').update(b).digest('hex');
function fixture() {
  const original = Buffer.from('export const version=1;'),
    other = Buffer.from('unchanged'),
    head = {
      files: {
        'host.js': { offset: '0', size: original.length },
        'other.js': { offset: String(original.length), size: other.length },
        native: {
          files: {
            'module.node': {
              size: 12,
              unpacked: true,
              integrity: { algorithm: 'SHA256', hash: 'native-receipt' },
            },
          },
        },
      },
    };
  return {
    input: Buffer.concat([encodeAsarHeader(head), original, other]),
    patch: {
      files: {
        'host.js': { oldSha: sha(original), text: 'export const version=2;' },
        'adapter.js': { oldSha: null, text: 'export const login=true;' },
      },
    },
  };
}
function extract(buffer, name) {
  const start = 8 + buffer.readUInt32LE(4);
  const head = JSON.parse(buffer.subarray(16, 16 + buffer.readUInt32LE(12)));
  let entry = head;
  for (const part of name.split('/')) entry = entry.files[part];
  return buffer.subarray(start + Number(entry.offset), start + Number(entry.offset) + entry.size);
}
test('Studio archive paths support Windows x64/ARM64 layouts and macOS app bundles', () => {
  assert.equal(
    resolveStudioArchive('C:\\Program Files\\RDK Studio\\RDK Studio.exe', 'win32'),
    'C:\\Program Files\\RDK Studio\\resources\\app.asar',
  );
  assert.equal(
    resolveStudioArchive('C:\\课程\\Studio', 'win32'),
    'C:\\课程\\Studio\\resources\\app.asar',
  );
  assert.equal(
    resolveStudioArchive('/Applications/RDK Studio.app', 'darwin'),
    '/Applications/RDK Studio.app/Contents/Resources/app.asar',
  );
});
test('ASAR patch is hash-pinned, idempotent, preserves unrelated bytes and unpacked metadata', () => {
  const f = fixture();
  const r = patchAsarBuffer(f.input, f.patch);
  assert.equal(r.changes, 2);
  assert.equal(extract(r.output, 'host.js').toString(), 'export const version=2;');
  assert.equal(extract(r.output, 'other.js').toString(), 'unchanged');
  const header = JSON.parse(r.output.subarray(16, 16 + r.output.readUInt32LE(12)));
  assert.equal(header.files.native.files['module.node'].unpacked, true);
  assert.equal(header.files.native.files['module.node'].integrity.hash, 'native-receipt');
  assert.equal(patchAsarBuffer(r.output, f.patch).changes, 0);
  assert.throws(
    () => patchAsarBuffer(f.input, { files: { 'host.js': { oldSha: 'wrong', text: 'bad' } } }),
    /不兼容/,
  );
  assert.throws(
    () => patchAsarBuffer(f.input, { files: { '../escape.js': { oldSha: null, text: 'bad' } } }),
    /路径/,
  );
});
test('installation writes a reversible backup; an incompatible app is untouched', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-patch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'app.asar'),
    f = fixture();
  fs.writeFileSync(target, f.input);
  const r = installStudioLoginPatch({ appPath: target, patch: f.patch });
  assert.equal(r.backupCreated, true);
  const backup = fs.readdirSync(dir).find((x) => x.includes('.before-learning-'));
  assert.ok(fs.readFileSync(path.join(dir, backup)).equals(f.input));
  const current = fs.readFileSync(target);
  assert.throws(() =>
    installStudioLoginPatch({
      appPath: target,
      patch: { files: { 'other.js': { oldSha: 'wrong', text: 'bad' } } },
    }),
  );
  assert.ok(fs.readFileSync(target).equals(current));
  assert.equal(fs.readdirSync(dir).filter((x) => x.endsWith('.tmp')).length, 0);
});

test('a running Studio is never overwritten or stopped', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-patch-running-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'app.asar'),
    f = fixture();
  fs.writeFileSync(target, f.input);
  assert.throws(
    () => installStudioLoginPatch({ appPath: target, patch: f.patch, isRunning: () => true }),
    /退出Studio/,
  );
  assert.ok(fs.readFileSync(target).equals(f.input));
  assert.equal(fs.readdirSync(dir).length, 1);
});
