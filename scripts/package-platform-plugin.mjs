#!/usr/bin/env node
/** Export only the platform plugin and its marketplace, without local bindings. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    'Usage: node scripts/package-platform-plugin.mjs [--out-dir DIR]\nExports plugin and marketplace ZIPs plus SHA256SUMS. Requires Python 3 (PYTHON override).\nRun npm run verify:plugin before distributing a candidate.',
  );
  process.exit(0);
}
let outputDirectory = path.join(repositoryRoot, 'dist', 'plugins');
if (args.length) {
  if (args.length !== 2 || args[0] !== '--out-dir') throw new Error('Use --help for options.');
  outputDirectory = path.resolve(args[1]);
}
const pluginRoot = path.join(repositoryRoot, 'plugins', 'rdk-robot-learning-platform');
const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'plugin.json'), 'utf8'));
if (!/^[a-z][a-z0-9-]+$/.test(manifest.name) || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
  throw new Error('Invalid plugin archive identity.');
}
function collect(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (
      ['.git', '.local', 'node_modules', '__pycache__', '.DS_Store', '.env'].includes(entry.name) ||
      entry.name.startsWith('.env.') ||
      /\.py[co]$/.test(entry.name)
    )
      return [];
    const source = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Plugin resources must not be symbolic links.');
    return entry.isDirectory() ? collect(source) : [source];
  });
}
const files = collect(pluginRoot).sort();
for (const relative of [
  '.codex-plugin/plugin.json',
  '.mcp.json',
  'mcp.json',
  'skills/setup/SKILL.md',
  'scripts/start-mcp.mjs',
]) {
  if (!files.includes(path.join(pluginRoot, relative)))
    throw new Error(`Required plugin file missing: ${relative}`);
}
const catalog = path.join(repositoryRoot, '.agents', 'plugins', 'marketplace.json');
const pluginArchive = `${manifest.name}-${manifest.version}.zip`;
const marketplaceArchive = `rdk-learning-platform-marketplace-${manifest.version}.zip`;
fs.mkdirSync(outputDirectory, { recursive: true });
const instructions = [
  {
    output: path.join(outputDirectory, pluginArchive),
    entries: files.map((source) => ({
      source,
      name: `${manifest.name}/${path.relative(pluginRoot, source).split(path.sep).join('/')}`,
    })),
  },
  {
    output: path.join(outputDirectory, marketplaceArchive),
    entries: [
      { source: catalog, name: '.agents/plugins/marketplace.json' },
      ...files.map((source) => ({
        source,
        name: `plugins/${manifest.name}/${path.relative(pluginRoot, source).split(path.sep).join('/')}`,
      })),
    ],
  },
];
// ZIP is the supported plugin interchange format; the Python stdlib avoids an
// extra npm archiver dependency and does not execute packaged resources.
const result = spawnSync(
  process.env.PYTHON || 'python3',
  [
    '-c',
    `
import json, sys, zipfile
from pathlib import Path
for archive in json.load(sys.stdin):
    with zipfile.ZipFile(archive['output'], 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as target:
        for entry in archive['entries']:
            source = Path(entry['source'])
            info = zipfile.ZipInfo(entry['name'], (1980, 1, 1, 0, 0, 0))
            info.external_attr = (source.stat().st_mode & 0xffff) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            target.writestr(info, source.read_bytes())
`,
  ],
  { input: JSON.stringify(instructions), encoding: 'utf8' },
);
if (result.error || result.status !== 0) {
  throw new Error(`Python ZIP export failed: ${result.error?.message || result.stderr}`);
}
const hashes = [pluginArchive, marketplaceArchive].map((name) => {
  const file = fs.readFileSync(path.join(outputDirectory, name));
  return { name, bytes: file.length, sha256: createHash('sha256').update(file).digest('hex') };
});
fs.writeFileSync(
  path.join(outputDirectory, 'SHA256SUMS'),
  hashes.map(({ name, sha256 }) => `${sha256}  ${name}\n`).join(''),
);
console.log(
  JSON.stringify({
    ok: true,
    plugin: manifest.name,
    version: manifest.version,
    resourceCount: files.length,
    archives: hashes,
  }),
);
