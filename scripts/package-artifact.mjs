#!/usr/bin/env node
import { createHmac, createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

function fail(message) {
  throw new Error(`[artifact] ${message}`);
}
function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}
async function walk(root, current = '') {
  const dir = path.join(root, current);
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const files = [];
  for (const entry of entries) {
    const rel = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(root, rel)));
    else if (entry.isFile()) {
      const bytes = await readFile(path.join(root, rel));
      files.push({
        path: rel.split(path.sep).join('/'),
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
  }
  return files;
}
const input = path.resolve(arg('input'));
const output = path.resolve(arg('output', 'artifact-manifest.json'));
const artifactId = arg('artifact-id');
const secret = arg('hmac-secret', process.env.RDK_SIM2REAL_ARTIFACT_HMAC_SECRET ?? '');
if (!artifactId || !secret) fail('--artifact-id and --hmac-secret are required');
const info = await stat(input).catch(() => null);
if (!info?.isDirectory()) fail(`input directory not found: ${input}`);
const manifest = {
  schemaVersion: 1,
  artifactId,
  immutable: true,
  createdAt: new Date().toISOString(),
  files: await walk(input),
  lineage: {
    simulationSnapshot: arg('simulation-snapshot') || null,
    domainRandomization: arg('domain-randomization') || null,
    rewardConfig: arg('reward-config') || null,
    runId: arg('run-id') || null,
    datasetId: arg('dataset-id') || null,
    contractId: arg('contract-id') || null,
    targetBoard: arg('target-board') || null,
  },
};
manifest.payloadSha256 = createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex');
manifest.signature = createHmac('sha256', secret).update(JSON.stringify(manifest)).digest('hex');
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
console.log(
  JSON.stringify({
    ok: true,
    artifactId,
    output,
    fileCount: manifest.files.length,
    payloadSha256: manifest.payloadSha256,
  }),
);
