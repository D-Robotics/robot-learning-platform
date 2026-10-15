#!/usr/bin/env node
/** Save this platform's local checkout/runtime binding outside the plugin package. */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    'Usage: node scripts/configure-platform-plugin.mjs\nRun using a Node version supported by package.engines. Saves root and Node executable in ~/.config/rdk-robot-learning-platform/plugin.json.\nRDK_ROBOT_LEARNING_PLATFORM_CONFIG can choose another local binding file. No credentials are stored.',
  );
  process.exit(0);
}
if (args.length) throw new Error('Use --help for options.');
const file =
  process.env.RDK_ROBOT_LEARNING_PLATFORM_CONFIG ||
  path.join(homedir(), '.config', 'rdk-robot-learning-platform', 'plugin.json');
const check = spawnSync(
  process.execPath,
  [
    path.join(root, 'plugins', 'rdk-robot-learning-platform', 'scripts', 'start-mcp.mjs'),
    '--check',
  ],
  {
    env: {
      ...process.env,
      RDK_ROBOT_LEARNING_PLATFORM_ROOT: root,
      RDK_ROBOT_LEARNING_PLATFORM_NODE: process.execPath,
    },
    encoding: 'utf8',
  },
);
if (check.error || check.status !== 0) throw new Error(check.error?.message || check.stderr.trim());
const binding = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
if (!binding || typeof binding !== 'object' || Array.isArray(binding))
  throw new Error('Existing local binding is not an object.');
fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
const temporary = `${file}.${process.pid}.tmp`;
fs.writeFileSync(
  temporary,
  JSON.stringify({ ...binding, root, node: process.execPath }, null, 2) + '\n',
  { mode: 0o600 },
);
fs.renameSync(temporary, file);
console.log(
  JSON.stringify({
    ok: true,
    package: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name,
    nodeVersion: process.versions.node,
    credentialsStored: false,
  }),
);
