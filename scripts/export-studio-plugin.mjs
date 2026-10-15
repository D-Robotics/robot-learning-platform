#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readStudioPluginCredentialEnv,
  resolveStudioPluginRuntime,
} from './start-studio-plugin-mcp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function copyResources(source, destination) {
  const info = fs.lstatSync(source);
  if (info.isSymbolicLink()) throw new Error('Plugin export resources must not be symbolic links.');
  if (info.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const name of fs.readdirSync(source).sort()) {
      copyResources(path.join(source, name), path.join(destination, name));
    }
  } else if (info.isFile()) {
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  }
}

export function exportStudioPlugin({
  output,
  platformUrl = 'http://127.0.0.1:18102',
  runtimeRoot = root,
  nodePath = process.execPath,
  credentialsFile,
} = {}) {
  if (typeof output !== 'string' || !output.trim()) throw new Error('--output is required.');
  const destination = path.resolve(output);
  if (fs.existsSync(destination)) throw new Error('Output already exists; choose a new directory.');
  const origin = new URL(platformUrl);
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  ) {
    throw new Error(
      'Platform URL must be HTTP(S) without credentials, query parameters, or fragments.',
    );
  }
  const runtime = fs.realpathSync(path.resolve(runtimeRoot));
  const pkg = JSON.parse(fs.readFileSync(path.join(runtime, 'package.json'), 'utf8'));
  if (pkg.name !== '@d-robotics/robot-learning-platform')
    throw new Error('Runtime root is not the robot-learning-platform package.');
  resolveStudioPluginRuntime(runtime);
  const launcher = path.join(runtime, 'scripts/start-studio-plugin-mcp.mjs');
  if (!fs.existsSync(launcher) || !path.isAbsolute(nodePath) || !fs.existsSync(nodePath)) {
    throw new Error('An existing absolute Node executable and the MCP launcher are required.');
  }
  const template = path.join(root, 'plugins/rdk-robot-learning-platform');
  const manifest = JSON.parse(
    fs.readFileSync(path.join(template, '.rdstudio-plugin/plugin.json'), 'utf8'),
  );
  manifest.skills = './skills';
  const mcp = {
    mcpServers: {
      'rdk-learning-platform': {
        transport: 'stdio',
        command: nodePath,
        args: [launcher],
        env: { RDK_SIM2REAL_MCP_BASE_URL: origin.toString().replace(/\/+$/, '') },
      },
    },
  };
  if (credentialsFile) {
    const credentialPath = path.resolve(credentialsFile);
    readStudioPluginCredentialEnv(credentialPath);
    if (credentialPath === destination || credentialPath.startsWith(destination + path.sep))
      throw new Error('Credentials file must remain outside the exported plugin directory.');
    mcp.mcpServers['rdk-learning-platform'].env.RDK_SIM2REAL_MCP_CREDENTIALS_FILE = credentialPath;
  }
  fs.mkdirSync(path.join(destination, '.rdstudio-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(destination, '.rdstudio-plugin/plugin.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  fs.writeFileSync(path.join(destination, '.mcp.json'), JSON.stringify(mcp, null, 2) + '\n');
  const clientNameFor = (name) =>
    name.startsWith('rdk-platform-') ? name : `rdk-platform-${name}`;
  const readme = fs.readFileSync(path.join(template, 'README.md'), 'utf8');
  fs.writeFileSync(
    path.join(destination, 'README.md'),
    readme.replace(/\]\(skills\/([^/]+)\//g, (_, name) => `](skills/${clientNameFor(name)}/`),
  );
  copyResources(path.join(template, 'references'), path.join(destination, 'references'));
  for (const name of fs.readdirSync(path.join(template, 'skills')).sort()) {
    const source = path.join(template, 'skills', name);
    if (!fs.existsSync(path.join(source, 'SKILL.md'))) continue;
    const clientName = clientNameFor(name);
    const directory = path.join(destination, 'skills', clientName);
    copyResources(source, directory);
    const file = path.join(directory, 'SKILL.md');
    const text = fs.readFileSync(file, 'utf8');
    if (!/^name:\s*\S+\s*$/m.test(text)) throw new Error(`Skill name missing: ${name}`);
    fs.writeFileSync(file, text.replace(/^name:\s*\S+\s*$/m, `name: ${clientName}`));
  }
  return {
    pluginDirectory: destination,
    pluginName: manifest.name,
    mcpServerName: 'rdk-learning-platform',
  };
}

function optionsFromArgs(args) {
  const options = {};
  const flags = {
    '--output': 'output',
    '--platform-url': 'platformUrl',
    '--runtime-root': 'runtimeRoot',
    '--node': 'nodePath',
    '--credentials-file': 'credentialsFile',
  };
  for (let index = 0; index < args.length; index += 1) {
    const key = flags[args[index]];
    if (!key || !args[index + 1] || args[index + 1].startsWith('--'))
      throw new Error(`Invalid argument: ${args[index]}`);
    options[key] = args[++index];
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(
      JSON.stringify(exportStudioPlugin(optionsFromArgs(process.argv.slice(2)))) + '\n',
    );
  } catch (error) {
    process.stderr.write(
      `[studio-plugin] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
