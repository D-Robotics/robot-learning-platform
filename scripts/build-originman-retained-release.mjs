#!/usr/bin/env node
/** Create a checked overlay release without mutating the retained upstream or its account storage. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    'Usage: node scripts/build-originman-retained-release.mjs --base <retained-release-root> --output <new-directory>',
  );
  process.exit(0);
}
function argument(name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--'))
    throw new Error(`Missing ${name}`);
  return path.resolve(args[index + 1]);
}
if (args.length !== 4 || args.some((v, i) => i % 2 === 0 && !['--base', '--output'].includes(v)))
  throw new Error('Use --help for accepted arguments.');
const base = argument('--base'),
  output = argument('--output');
if (output === base || output.startsWith(base + path.sep) || base.startsWith(output + path.sep))
  throw new Error('Base and output must be separate directories.');
const specRoot = path.join(sourceRoot, 'services/sim2real-web/retained-release');
const manifest = JSON.parse(
  await fs.readFile(path.join(specRoot, 'originman-retained-runtime.json'), 'utf8'),
);
const patchFile = path.join(specRoot, 'originman-retained-runtime.patch');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
if (sha(await fs.readFile(patchFile)) !== manifest.patchSha256)
  throw new Error('Release patch digest mismatch.');
for (const [name, record] of Object.entries(manifest.files)) {
  if (!name.startsWith('dist-server/') || name.split('/').includes('..'))
    throw new Error('Unsafe runtime path.');
  if (sha(await fs.readFile(path.join(base, name))) !== record.beforeSha256)
    throw new Error(`Upstream mismatch: ${name}; refusing to patch a different release.`);
}
for (const name of ['train_football.py'])
  await fs.access(path.join(base, 'dist-server/engines/microduck-football', name));
await fs.mkdir(output, { recursive: false, mode: 0o700 });
await fs.cp(path.join(base, 'dist-server'), path.join(output, 'dist-server'), { recursive: true });
for (const name of ['package.json', 'package-lock.json']) {
  try {
    await fs.copyFile(path.join(base, name), path.join(output, name));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
for (const item of await fs.readdir(base, { withFileTypes: true })) {
  if (item.isFile() && item.name.endsWith('.mjs'))
    await fs.copyFile(path.join(base, item.name), path.join(output, item.name));
}
execFileSync('git', ['apply', '--check', patchFile], { cwd: output, stdio: 'pipe' });
execFileSync('git', ['apply', patchFile], { cwd: output, stdio: 'pipe' });
for (const [input, destination] of Object.entries(manifest.addedSourceFiles)) {
  let bytes = await fs.readFile(path.join(sourceRoot, input));
  if (input.endsWith('.ts'))
    bytes = Buffer.from(
      ts.transpileModule(bytes.toString('utf8'), {
        fileName: input,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText,
    );
  await fs.mkdir(path.dirname(path.join(output, destination)), { recursive: true });
  await fs.writeFile(path.join(output, destination), bytes);
}
for (const engine of manifest.addedEngineDirectories)
  await fs.cp(
    path.join(sourceRoot, 'engines', engine),
    path.join(output, 'dist-server/engines', engine),
    { recursive: true, filter: (name) => !name.split(path.sep).includes('__pycache__') },
  );
for (const [name, record] of Object.entries(manifest.files)) {
  if (sha(await fs.readFile(path.join(output, name))) !== record.afterSha256)
    throw new Error(`Patched output mismatch: ${name}`);
  if (name.endsWith('.js')) await fs.rm(path.join(output, name + '.map'), { force: true });
}
const hashes = {};
async function collect(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Runtime must not contain symlinks.');
    if (entry.isDirectory()) await collect(file);
    else
      hashes[path.relative(output, file).split(path.sep).join('/')] = sha(await fs.readFile(file));
  }
}
await collect(path.join(output, 'dist-server'));
const receipt = {
  schemaVersion: 1,
  kind: 'retained-upstream-with-checked-originman-overlay',
  upstreamRelease: manifest.upstreamRelease,
  upstreamQualification: manifest.qualification,
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: sourceRoot,
    encoding: 'utf8',
  }).trim(),
  sourceDirty:
    execFileSync('git', ['status', '--porcelain'], { cwd: sourceRoot, encoding: 'utf8' }).trim()
      .length > 0,
  patchSha256: manifest.patchSha256,
  outputFiles: hashes,
  deploymentPerformed: false,
  hardwareVerified: false,
};
await fs.writeFile(
  path.join(output, 'originman-release-provenance.json'),
  JSON.stringify(receipt, null, 2) + '\n',
);
console.log(
  JSON.stringify({
    output,
    runtimeFiles: Object.keys(hashes).length,
    patchSha256: receipt.patchSha256,
    deploymentPerformed: false,
  }),
);
