#!/usr/bin/env node
/** Keep both MCP manifests tied to the same dependency-free launcher. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plugin = path.join(root, 'plugins', 'rdk-robot-learning-platform');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    'Usage: node scripts/update-platform-plugin-entry.mjs [--check]\nGenerate portable/compat MCP configs from start-mcp.mjs. No host path macros, network or service startup.',
  );
  process.exit(0);
}
if (args.some((arg) => arg !== '--check')) throw new Error('Use --help for options.');
const source = fs
  .readFileSync(path.join(plugin, 'scripts', 'start-mcp.mjs'), 'utf8')
  .replace(/^#![^\n]*\n/, '')
  .trim();
const mcpServers = {
  'duck-lab': { type: 'stdio', command: 'node', args: ['--input-type=module', '-e', source] },
};
const configuration = await resolveConfig(path.join(root, 'package.json'));
for (const [name, manifest] of [
  ['mcp.json', { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers }],
  ['.mcp.json', { mcpServers }],
]) {
  const file = path.join(plugin, name);
  const content = await format(JSON.stringify(manifest), { ...configuration, parser: 'json' });
  if (args.includes('--check')) {
    if (fs.readFileSync(file, 'utf8') !== content) {
      throw new Error(`${name} differs from start-mcp.mjs; run npm run update:plugin-entry.`);
    }
  } else {
    fs.writeFileSync(file, content);
  }
}
console.log(
  `Platform plugin MCP entry ${args.includes('--check') ? 'verified' : 'generated'} without host path substitution.`,
);
