#!/usr/bin/env node
/** Start the platform's existing MCP adapter without duplicating business logic. */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_ENV = 'RDK_ROBOT_LEARNING_PLATFORM_ROOT';
const MODE_ENV = 'RDK_ROBOT_LEARNING_PLATFORM_MCP_MODE';
const NODE_ENV = 'RDK_ROBOT_LEARNING_PLATFORM_NODE';
const CONFIG_ENV = 'RDK_ROBOT_LEARNING_PLATFORM_CONFIG';
const PACKAGE_NAME = '@d-robotics/robot-learning-platform';
const args = process.argv.slice(2);

if (args.includes('--help')) {
  console.log(`RDK Robot Learning Platform MCP launcher
Usage: node scripts/start-mcp.mjs [--check]
${ROOT_ENV}: platform checkout or installed package root.
Inside this repository it can be discovered from this script or the working directory.
${MODE_ENV}: source (default) or built; built requires npm run build.
${NODE_ENV}: optional compatible Node executable for the MCP child.
${CONFIG_ENV}: optional local binding file (root and node only).
Default binding: ~/.config/rdk-robot-learning-platform/plugin.json; configure with npm run setup:plugin.
RDK_SIM2REAL_MCP_BASE_URL and authentication variables are inherited unchanged.
--check validates runtime and dependencies without starting MCP or the platform.
Normal startup writes only JSON-RPC protocol messages to stdout.`);
  process.exit(0);
}

function platformPackage(directory) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
    return pkg.name === PACKAGE_NAME ? pkg : null;
  } catch {
    return null;
  }
}

function findAncestor(start) {
  let directory = path.resolve(start);
  for (;;) {
    if (platformPackage(directory)) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function localBinding() {
  const file =
    process.env[CONFIG_ENV] ||
    path.join(homedir(), '.config', 'rdk-robot-learning-platform', 'plugin.json');
  if (!existsSync(file)) return {};
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    for (const key of ['root', 'node']) {
      if (data[key] !== undefined && (typeof data[key] !== 'string' || !data[key].trim()))
        throw new Error();
    }
    return data;
  } catch {
    throw new Error(
      `${CONFIG_ENV} local binding must be JSON with string root/node fields; rerun npm run setup:plugin.`,
    );
  }
}

function resolveRoot(binding) {
  const explicit = process.env[ROOT_ENV]?.trim();
  if (explicit) {
    const directory = path.resolve(explicit);
    if (!platformPackage(directory)) {
      throw new Error(`${ROOT_ENV} must point to the ${PACKAGE_NAME} package root.`);
    }
    return realpathSync(directory);
  }
  const directory =
    findAncestor(path.dirname(fileURLToPath(import.meta.url))) ?? findAncestor(process.cwd());
  if (directory) return realpathSync(directory);
  if (binding.root && platformPackage(binding.root)) return realpathSync(binding.root);
  throw new Error(
    `Set ${ROOT_ENV} to the platform package root, or run npm run setup:plugin inside its checkout.`,
  );
}

// Interpret the platform's declared ^major floors and >= floors, rather than
// relaxing its Node requirement because the default shell happens to differ.
function supportedRuntime(range, version) {
  const current = version.split('.').map(Number);
  return String(range)
    .split('||')
    .some((clause) => {
      const match = /^(\^|>=)(\d+)\.(\d+)\.(\d+)$/.exec(clause.trim());
      if (!match) return false;
      const floor = match.slice(2).map(Number);
      const atLeast =
        current[0] > floor[0] ||
        (current[0] === floor[0] &&
          (current[1] > floor[1] || (current[1] === floor[1] && current[2] >= floor[2])));
      return atLeast && (match[1] === '>=' || current[0] === floor[0]);
    });
}

try {
  if (args.some((arg) => arg !== '--check')) throw new Error('Unknown option; use --help.');
  const binding = localBinding();
  const root = resolveRoot(binding);
  const pkg = platformPackage(root);
  const node = process.env[NODE_ENV]?.trim() || binding.node || process.execPath;
  let version;
  try {
    version =
      node === process.execPath
        ? process.versions.node
        : execFileSync(node, ['-p', 'process.versions.node'], {
            encoding: 'utf8',
            timeout: 5000,
            maxBuffer: 1024,
          }).trim();
  } catch {
    throw new Error(
      `${NODE_ENV} executable is unavailable; run npm run setup:plugin using a supported Node.`,
    );
  }
  if (!supportedRuntime(pkg.engines?.node, version)) {
    throw new Error(
      `Node ${version} does not satisfy package.engines: ${pkg.engines?.node}; bind a supported runtime with ${NODE_ENV} or npm run setup:plugin.`,
    );
  }
  const mode = process.env[MODE_ENV]?.trim() || 'source';
  if (!['source', 'built'].includes(mode)) throw new Error(`${MODE_ENV} must be source or built.`);
  const require = createRequire(path.join(root, 'package.json'));
  // This shared runtime dependency is required by both source and built MCP.
  try {
    require.resolve('rdk-docs-mcp/dist/service.js');
  } catch {
    throw new Error(`Platform dependencies are missing; run npm ci in ${ROOT_ENV}.`);
  }
  const entry = path.join(
    root,
    mode === 'built'
      ? 'dist-server/services/duck-lab-mcp/server.js'
      : 'services/duck-lab-mcp/server.ts',
  );
  if (!existsSync(entry)) {
    throw new Error(
      mode === 'built'
        ? `Built MCP entry is missing; run npm run build in ${ROOT_ENV}.`
        : `Source MCP entry is missing; check ${ROOT_ENV} or select built mode.`,
    );
  }
  const commandArgs = [];
  if (mode === 'source') {
    try {
      commandArgs.push('--import', require.resolve('tsx/esm'));
    } catch {
      throw new Error(
        `Source mode needs tsx; run npm ci in ${ROOT_ENV} or select a built release.`,
      );
    }
  }
  commandArgs.push(entry);
  if (args.includes('--check')) {
    console.log(
      JSON.stringify({
        ok: true,
        package: pkg.name,
        version: pkg.version,
        nodeVersion: version,
        mode,
      }),
    );
  } else {
    const child = spawn(node, commandArgs, {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
    });
    child.once('error', (error) => {
      console.error(`[rdk-platform-plugin] MCP could not start: ${error.message}`);
      process.exitCode = 1;
    });
    const forward = (signal) => {
      if (!child.killed) child.kill(signal);
    };
    const onInterrupt = () => forward('SIGINT');
    const onTerminate = () => forward('SIGTERM');
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onTerminate);
    child.once('exit', (code, signal) => {
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onTerminate);
      process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 143);
    });
  }
} catch (error) {
  console.error(`[rdk-platform-plugin] ${error.message}`);
  process.exitCode = 1;
}
