#!/usr/bin/env node
/**
 * Deterministic local registry rehearsal. It exercises the same invariants a
 * production object store must provide: signed manifests, immutable versions,
 * digest verification, and an explicit rollback pointer. No network or
 * device is touched; the resulting evidence is safe to run in CI.
 */
import { createHmac, createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(os.tmpdir(), 'rdk-artifact-registry-'));
const secret = randomBytes(32);
const registry = path.join(root, 'registry');
await mkdir(registry, { recursive: true, mode: 0o700 });
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const signature = (manifest) =>
  createHmac('sha256', secret).update(JSON.stringify(manifest)).digest('hex');
const fail = (message) => {
  throw new Error(`[artifact-registry] ${message}`);
};
try {
  const publish = async (version, payload) => {
    const bytes = Buffer.from(payload);
    const manifest = Object.freeze({
      artifactId: 'policy',
      version,
      sha256: digest(bytes),
      bytes: bytes.length,
      status: 'published',
    });
    const dir = path.join(registry, version);
    await mkdir(dir, { recursive: false, mode: 0o700 });
    await writeFile(path.join(dir, 'policy.onnx'), bytes, { flag: 'wx', mode: 0o600 });
    await writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ ...manifest, signature: signature(manifest) }),
      { flag: 'wx', mode: 0o600 },
    );
    return manifest;
  };
  const _v1 = await publish('v1', 'policy-v1');
  const _v2 = await publish('v2', 'policy-v2');
  const verify = async (version) => {
    const dir = path.join(registry, version);
    const stored = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    const { signature: signed, ...manifest } = stored;
    if (signed !== signature(manifest)) fail(`${version} signature mismatch`);
    const bytes = await readFile(path.join(dir, 'policy.onnx'));
    if (digest(bytes) !== manifest.sha256 || bytes.length !== manifest.bytes)
      fail(`${version} digest mismatch`);
    return manifest;
  };
  await verify('v1');
  await verify('v2');
  const currentPath = path.join(registry, 'CURRENT');
  await writeFile(currentPath + '.tmp', 'v2\n', { flag: 'wx', mode: 0o600 });
  await rename(currentPath + '.tmp', currentPath);
  await writeFile(currentPath + '.tmp', 'v1\n', { flag: 'wx', mode: 0o600 });
  await rename(currentPath + '.tmp', currentPath);
  if ((await readFile(currentPath, 'utf8')).trim() !== 'v1') fail('rollback pointer mismatch');
  console.log(
    '[artifact-registry] PASS — signed immutable v1/v2 artifacts verified; explicit rollback v2 → v1 rehearsed',
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
