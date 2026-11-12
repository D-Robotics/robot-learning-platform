#!/usr/bin/env node

/** Exercise the installable plugin boundary without calling platform or hardware APIs. */
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMcpConfiguration } from '../plugins/rdk-robot-learning-platform/configure.mjs';
import { EXPERIENCE_TOOLS } from '../plugins/rdk-robot-learning-platform/scripts/experience-mcp.mjs';
import { isDirectInvocation } from '../plugins/rdk-robot-learning-platform/scripts/experience.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginRelative = 'plugins/rdk-robot-learning-platform';
const pluginRoot = path.join(repositoryRoot, pluginRelative);
const rootVariable = 'RDK_ROBOT_LEARNING_PLATFORM_ROOT';
const require = createRequire(import.meta.url);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function contained(root, reference, label) {
  assert.equal(typeof reference, 'string', `${label} must be a local path`);
  assert.ok(!path.isAbsolute(reference), `${label} must be relative to the plugin`);
  const resolved = path.resolve(root, reference);
  const relative = path.relative(root, resolved);
  assert.ok(
    relative !== '..' && !relative.startsWith(`..${path.sep}`),
    `${label} must stay inside the plugin`,
  );
  assert.ok(fs.existsSync(resolved), `${label} is missing: ${reference}`);
  return resolved;
}

function filesIn(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    assert.ok(!entry.isSymbolicLink(), `Plugin resources must be real files: ${file}`);
    return entry.isDirectory() ? filesIn(file) : [file];
  });
}

function validateManifest(file) {
  const manifest = readJson(file);
  assert.equal(manifest.name, 'rdk-robot-learning-platform');
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/);
  assert.equal(typeof manifest.description, 'string');
  assert.ok(manifest.description.trim());
  const skillPaths = manifest.skills ?? './skills/';
  const skillRoots = (Array.isArray(skillPaths) ? skillPaths : [skillPaths]).map((reference) =>
    contained(pluginRoot, reference, `${path.basename(file)} skills`),
  );
  const mcpFile = contained(
    pluginRoot,
    manifest.mcpServers ?? './mcp.json',
    `${path.basename(file)} mcpServers`,
  );
  if (manifest.extensions?.['com.openai']?.onboardingSkill) {
    contained(pluginRoot, manifest.extensions['com.openai'].onboardingSkill, 'onboardingSkill');
  }
  for (const interfaceMetadata of [
    manifest.interface,
    manifest.extensions?.['com.openai']?.interface,
  ]) {
    for (const key of ['iconSmall', 'iconLarge']) {
      if (interfaceMetadata?.[key]) contained(pluginRoot, interfaceMetadata[key], key);
    }
  }
  return { manifest, skillRoots, mcpFile };
}

function inspectResources(skillRoots, files) {
  const skills = skillRoots
    .flatMap((root) => filesIn(root))
    .filter((file) => /[/\\]SKILL\.md$/.test(file));
  assert.ok(skills.length > 0, 'Plugin must expose at least one skill');
  const skillNames = new Set();
  for (const file of skills) {
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /^---\r?\n[\s\S]*?\bname:\s*\S+/);
    assert.match(text, /^---\r?\n[\s\S]*?\bdescription:\s*\S+/);
    const skillName = text.match(/^name:\s*([\w-]+)\s*$/m)?.[1];
    assert.equal(
      skillName,
      path.basename(path.dirname(file)),
      'Skill directory and frontmatter name must agree',
    );
    assert.ok(!skillNames.has(skillName), `Plugin declares duplicate skill: ${skillName}`);
    skillNames.add(skillName);
  }
  const docs = files.filter((file) =>
    /(?:[/\\]SKILL\.md|[/\\]references[/\\].*\.(?:md|json))$/.test(file),
  );
  const documentedTools = new Set();
  const links = new Map();
  for (const file of files.filter((entry) => /\.(?:md|json|mjs|svg)$/.test(entry))) {
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(
      text,
      /(?:\/Users\/|\/home\/)[^\s/]+|[A-Z]:\\Users\\/i,
      `${file} contains a personal path`,
    );
    const isRetainedBundle = path.relative(pluginRoot, file) === path.join('mcp', 'bundle.mjs');
    for (const match of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
      // The retained bundle embeds quoted network ranges and a numbered docs title.
      const bundleLiteral = isRetainedBundle ? text.slice(match.index - 1, match.index + 22) : '';
      const knownBundleMetadata =
        /^"(?:169\.254\.0\.0\/16|10\.0\.0\.0\/8|172\.16\.0\.0\/12|192\.168\.0\.0\/16)"/.test(
          bundleLiteral,
        ) ||
        (bundleLiteral.startsWith('"3.3.2.2 GPIO ') &&
          text.slice(match.index - 7, match.index) === 'title:"');
      assert.ok(
        match[0].startsWith('127.') || match[0] === '0.0.0.0' || knownBundleMetadata,
        `${file} contains a device address: ${match[0]}`,
      );
    }
    if (docs.includes(file)) {
      for (const match of text.matchAll(/["`](rdk_[a-z0-9_]+)["`]/g)) documentedTools.add(match[1]);
    }
    if (file.endsWith('.md')) {
      const targets = [];
      for (const match of text.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
        const target = match[1];
        if (/^(?:[a-z][a-z\d+.-]*:|#|\$\{)/i.test(target)) continue;
        targets.push(
          contained(
            pluginRoot,
            path.relative(pluginRoot, path.resolve(path.dirname(file), target.split('#')[0])),
            `Markdown link in ${path.relative(pluginRoot, file)}`,
          ),
        );
      }
      links.set(file, targets);
    }
  }
  const reachable = new Set(skills);
  const queue = [...skills];
  while (queue.length) {
    for (const target of links.get(queue.shift()) ?? []) {
      if (!reachable.has(target)) {
        reachable.add(target);
        queue.push(target);
      }
    }
  }
  for (const file of docs)
    assert.ok(
      reachable.has(file),
      `Plugin reference is not discoverable from a skill: ${path.relative(pluginRoot, file)}`,
    );
  return { skillCount: skills.length, documentedTools };
}

function mcpInvocation(configFile, installedRoot, env) {
  const servers = Object.values(readJson(configFile).mcpServers ?? {});
  assert.equal(servers.length, 1, 'Plugin must expose its platform MCP server');
  const server = servers[0];
  assert.equal(
    server.command,
    'node',
    'MCP must launch Node directly without shell startup output',
  );
  assert.ok(Array.isArray(server.args));
  const bootstrapSource = fs
    .readFileSync(path.join(installedRoot, 'scripts/start-mcp.mjs'), 'utf8')
    .replace(/^#![^\n]*\n/, '')
    .trim();
  assert.deepEqual(
    server.args,
    ['--input-type=module', '-e', bootstrapSource],
    'Both MCP manifests must contain the current bootstrap source without host path macros',
  );
  return { command: process.execPath, args: server.args, env: { ...env, ...server.env } };
}

function cleanEnvironment(configFile) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('RDK_SIM2REAL_MCP_') || key.startsWith('RDK_ROBOT_LEARNING_PLATFORM_'))
      delete env[key];
  }
  // Discovery requests are local protocol operations and must work without a service.
  env.RDK_SIM2REAL_MCP_BASE_URL = 'http://127.0.0.1:1';
  if (configFile) env.RDK_ROBOT_LEARNING_PLATFORM_CONFIG = configFile;
  return env;
}

async function probeMcp(invocation, cwd, { name = 'duck-lab-mcp', version } = {}) {
  const child = spawn(invocation.command, invocation.args, {
    cwd,
    env: invocation.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  const messages = [];
  let buffered = '';
  let stderr = '';
  let protocolError;
  let nextId = 0;
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    buffered += chunk;
    const lines = buffered.split('\n');
    buffered = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        assert.equal(message.jsonrpc, '2.0', 'MCP stdout must contain only JSON-RPC');
        messages.push(message);
        const request = pending.get(message.id);
        if (request) {
          pending.delete(message.id);
          request.resolve(message);
        }
      } catch (error) {
        protocolError = error;
        for (const request of pending.values()) request.reject(error);
        pending.clear();
      }
    }
  });
  const closed = new Promise((resolve) =>
    child.once('close', (code, signal) => {
      for (const request of pending.values())
        request.reject(new Error(`MCP exited (${code ?? signal}): ${stderr}`));
      pending.clear();
      resolve({ code, signal });
    }),
  );
  child.on('error', (error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  });
  const request = async (method, params) => {
    if (protocolError) throw protocolError;
    const id = ++nextId;
    let timer;
    try {
      const response = await new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP ${method} timed out: ${stderr}`));
        }, 15_000);
        pending.set(id, { resolve, reject });
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`,
        );
      });
      assert.equal(response.error, undefined, `MCP ${method} returned an error`);
      return response.result;
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const initialization = await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'platform-plugin-verifier', version: '1.0.0' },
    });
    assert.equal(initialization.serverInfo.name, name);
    if (version !== undefined) assert.equal(initialization.serverInfo.version, version);
    assert.equal(initialization.protocolVersion, '2025-06-18');
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    const result = await request('tools/list');
    assert.deepEqual(await request('ping'), {});
    assert.equal(messages.length, 3, 'Initialization notification must not produce a response');
    assert.equal(protocolError, undefined);
    return result.tools;
  } finally {
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 3_000);
    await closed;
    clearTimeout(timer);
    assert.equal(
      buffered.trim(),
      '',
      'MCP stdout must not end with an incomplete protocol message',
    );
  }
}

function expectedCatalog() {
  let tsx;
  try {
    tsx = require.resolve('tsx/esm');
  } catch {
    throw new Error('Plugin verification requires repository dev dependencies; run npm ci first.');
  }
  const moduleUrl = (relative) =>
    JSON.stringify(pathToFileURL(path.join(repositoryRoot, relative)).href);
  const code = `
    import { listDshCapabilityCatalog } from ${moduleUrl('server/agent-runtime/dsh-capability-tools.ts')};
    import { createDshCapabilityHandlers } from ${moduleUrl('server/agent-runtime/dsh-capability-handlers.ts')};
    import { createMcpService } from ${moduleUrl('services/duck-lab-mcp/server.ts')};
    const fetchImpl = async () => { throw new Error('Catalog discovery must not request HTTP'); };
    const handlers = createDshCapabilityHandlers({ fetchImpl });
    const catalog = listDshCapabilityCatalog(handlers).filter(item => item.bound);
    const service = createMcpService({ baseUrl: 'http://127.0.0.1:1', apiPrefix: '/api/v1/duck', timeoutMs: 1000 }, {}, { handlers });
    const { tools } = await service.methods['tools/list']();
    process.stdout.write(JSON.stringify({ catalog, tools }));
  `;
  return JSON.parse(
    execFileSync(
      process.execPath,
      ['--import', pathToFileURL(tsx).href, '--input-type=module', '-e', code],
      {
        cwd: repositoryRoot,
        env: cleanEnvironment(),
        encoding: 'utf8',
        timeout: 20_000,
        maxBuffer: 2 * 1024 * 1024,
      },
    ),
  );
}

export function verifyTools(tools, expected, documentedTools, verifiedOptionalTools = []) {
  assert.ok(Array.isArray(tools));
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [...expected.catalog.map((tool) => tool.id), 'rdk_platform_status'].sort(),
    'Plugin MCP must expose every bound platform capability plus service status',
  );
  assert.deepEqual(
    tools,
    expected.tools,
    'Plugin discovery must preserve schemas and safety annotations',
  );
  assert.deepEqual(
    tools,
    expected.snapshot,
    'Bundled tool catalog must match actual MCP schemas and safety annotations',
  );
  for (const tool of tools) {
    assert.equal(
      typeof tool.annotations?.readOnlyHint,
      'boolean',
      `${tool.name} needs readOnlyHint`,
    );
    assert.equal(
      typeof tool.annotations?.destructiveHint,
      'boolean',
      `${tool.name} needs destructiveHint`,
    );
    assert.ok(
      !(tool.annotations.readOnlyHint && tool.annotations.destructiveHint),
      `${tool.name} cannot be both read-only and destructive`,
    );
    assert.ok(
      documentedTools.has(tool.name),
      `${tool.name} is missing from plugin skills/references`,
    );
  }
  for (const name of documentedTools)
    assert.ok(
      [...tools, ...verifiedOptionalTools].some((tool) => tool.name === name),
      `Plugin documentation advertises an unknown tool: ${name}`,
    );
}

function verifyPack(files) {
  const output = execFileSync('npm', ['pack', '--ignore-scripts', '--dry-run', '--json'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const packedFiles = new Set(JSON.parse(output)[0].files.map((entry) => entry.path));
  for (const file of files) {
    const relative = path.relative(repositoryRoot, file).split(path.sep).join('/');
    assert.ok(packedFiles.has(relative), `npm pack omits plugin resource: ${relative}`);
  }
  assert.ok(
    packedFiles.has('.agents/plugins/marketplace.json'),
    'npm pack must include the plugin marketplace',
  );
}

function verifyInventory(root, digest) {
  const manifestPath = path.join(root, 'FILES.sha256');
  const files = filesIn(root).filter((file) => file !== manifestPath);
  const entries = new Map();
  for (const line of fs.readFileSync(manifestPath, 'utf8').trimEnd().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
    assert.ok(match, 'Invalid distribution inventory row');
    const [, hash, name] = match;
    assert.ok(!entries.has(name), `Duplicate inventory entry: ${name}`);
    entries.set(name, hash);
  }
  assert.equal(entries.size, files.length, 'Inventory must cover every distribution file');
  for (const file of files) {
    const name = path.relative(root, file).split(path.sep).join('/');
    assert.equal(entries.get(name), digest(name), `Distribution inventory mismatch: ${name}`);
  }
}

async function main(distribution) {
  const portable = validateManifest(path.join(pluginRoot, 'plugin.json'));
  const compat = validateManifest(path.join(pluginRoot, '.codex-plugin/plugin.json'));
  assert.deepEqual(
    portable.skillRoots,
    compat.skillRoots,
    'Plugin formats must expose the same skills',
  );
  const marketplace = readJson(path.join(repositoryRoot, '.agents/plugins/marketplace.json'));
  assert.equal(
    marketplace.plugins?.length,
    1,
    'Repository marketplace must contain only its learning platform plugin',
  );
  const entry = marketplace.plugins[0];
  assert.equal(entry.name, portable.manifest.name);
  assert.equal(entry.source?.source, 'local');
  assert.equal(
    path.resolve(repositoryRoot, entry.source.path),
    pluginRoot,
    'Marketplace must resolve this repository plugin',
  );
  const files = filesIn(pluginRoot);
  const { skillCount, documentedTools } = inspectResources(portable.skillRoots, files);
  verifyPack(files);
  const expected = expectedCatalog();
  const snapshot = readJson(path.join(pluginRoot, 'references/tool-catalog.json'));
  expected.snapshot = Array.isArray(snapshot) ? snapshot : snapshot.tools;
  assert.ok(
    Array.isArray(expected.snapshot),
    'Bundled tool catalog must contain full MCP descriptors',
  );
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rdk-platform-plugin-'));
  try {
    const installedRoot = path.join(temporary, 'installed-plugin');
    const runtimeRoot = distribution ? path.join(temporary, 'distribution') : installedRoot;
    const foreignCwd = path.join(temporary, 'unrelated-cwd');
    const unconfiguredFile = path.join(temporary, 'missing-binding.json');
    fs.cpSync(pluginRoot, installedRoot, { recursive: true });
    if (distribution) {
      filesIn(distribution);
      fs.cpSync(distribution, runtimeRoot, { recursive: true });
      for (const host of ['.codex-plugin', '.qoder-plugin', '.rdstudio-plugin']) {
        const manifest = readJson(path.join(runtimeRoot, host, 'plugin.json'));
        assert.equal(manifest.name, portable.manifest.name);
        assert.equal(manifest.version, portable.manifest.version);
      }
    }
    fs.mkdirSync(foreignCwd);
    // A source checkout has no workstation-specific Studio connection. The
    // installer generates the actual launch command for a relocated copy.
    assert.deepEqual(readJson(compat.mcpFile).mcpServers, {});
    const manifest = createMcpConfiguration({
      root: runtimeRoot,
      nodePath: process.execPath,
      platformUrl: 'http://127.0.0.1:1',
    });
    const server = manifest.mcpServers['rdk-learning-platform'];
    const environment = { ...cleanEnvironment(unconfiguredFile), ...server.env };
    const provenance = readJson(path.join(runtimeRoot, 'provenance.json'));
    const digest = (name) =>
      createHash('sha256')
        .update(fs.readFileSync(path.join(runtimeRoot, name)))
        .digest('hex');
    verifyInventory(runtimeRoot, digest);
    assert.equal(digest('mcp/bundle.mjs'), provenance.coreBundleSha256);
    for (const [name, hash] of Object.entries(provenance.wrapperSources)) {
      contained(runtimeRoot, name, 'Wrapper provenance file');
      assert.equal(digest(name), hash, `Wrapper provenance mismatch: ${name}`);
    }
    const bundled = await probeMcp(
      {
        command: server.command,
        args: [path.join(runtimeRoot, 'scripts/start-core-mcp.mjs')],
        env: environment,
      },
      foreignCwd,
    );
    const extendedTools = await probeMcp(
      { command: server.command, args: server.args, env: environment },
      foreignCwd,
      { name: portable.manifest.name, version: portable.manifest.version },
    );
    const forwarded = bundled.filter((tool) => tool.name !== 'rdk_learning_guide');
    const coreTools = extendedTools.slice(0, forwarded.length);
    assert.equal(coreTools.length, forwarded.length);
    for (let i = 0; i < forwarded.length; i++) {
      const { description, ...contract } = coreTools[i];
      const { description: originalDescription, ...originalContract } = forwarded[i];
      assert.deepEqual(
        contract,
        originalContract,
        `Forwarded contract changed for ${contract.name}`,
      );
      assert.ok(
        description.endsWith(originalDescription),
        `Upstream description missing for ${contract.name}`,
      );
    }
    const optionalTools = extendedTools.slice(forwarded.length);
    assert.deepEqual(
      optionalTools,
      EXPERIENCE_TOOLS,
      'Optional entry must expose its real descriptors',
    );
    assert.equal(new Set(extendedTools.map((tool) => tool.name)).size, extendedTools.length);
    const mutations = new Set([
      'rdk_workshop',
      'rdk_development_targets',
      'rdk_experiment_remember',
      'rdk_auth_login',
      'rdk_auth_switch_account',
      'rdk_auth_logout',
      'rdk_originman_train',
      'rdk_originman_dance_train',
      'rdk_originman_evaluate',
      'rdk_originman_short_train',
      'rdk_originman_short_evaluate',
    ]);
    for (const tool of optionalTools) {
      assert.equal(tool.annotations?.readOnlyHint, !mutations.has(tool.name), tool.name);
      assert.equal(tool.annotations?.destructiveHint, false, tool.name);
    }
    for (const tool of coreTools) {
      assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean', tool.name);
      assert.equal(typeof tool.annotations?.destructiveHint, 'boolean', tool.name);
      assert.ok(!(tool.annotations.readOnlyHint && tool.annotations.destructiveHint), tool.name);
    }
    const developmentNames = new Set(expected.tools.map((tool) => tool.name));
    for (const name of developmentNames) {
      assert.ok(
        extendedTools.some((tool) => tool.name === name),
        `Missing shipped tool: ${name}`,
      );
    }
    const shippedExtras = extendedTools.filter((tool) => !developmentNames.has(tool.name));
    const invocation = mcpInvocation(
      path.join(installedRoot, path.relative(pluginRoot, portable.mcpFile)),
      installedRoot,
      {
        ...cleanEnvironment(unconfiguredFile),
        [rootVariable]: repositoryRoot,
        RDK_ROBOT_LEARNING_PLATFORM_MCP_MODE: 'source',
      },
    );
    verifyTools(await probeMcp(invocation, foreignCwd), expected, documentedTools, shippedExtras);
    verifyTools(
      await probeMcp(
        {
          command: process.execPath,
          args: [path.join(pluginRoot, 'scripts/start-mcp.mjs')],
          env: cleanEnvironment(unconfiguredFile),
        },
        foreignCwd,
      ),
      expected,
      documentedTools,
      shippedExtras,
    );
    for (const badRoot of [undefined, path.join(temporary, 'missing-root'), foreignCwd]) {
      const env = cleanEnvironment(unconfiguredFile);
      if (badRoot !== undefined) env[rootVariable] = badRoot;
      const invocation = mcpInvocation(
        path.join(installedRoot, path.relative(pluginRoot, portable.mcpFile)),
        installedRoot,
        env,
      );
      const result = spawnSync(invocation.command, invocation.args, {
        cwd: foreignCwd,
        env: invocation.env,
        input: '',
        encoding: 'utf8',
        timeout: 10_000,
      });
      assert.equal(result.error, undefined, 'Invalid configuration must fail promptly');
      assert.ok(
        result.status !== null && result.status !== 0,
        'Invalid repository configuration must fail',
      );
      assert.equal(result.stdout, '', 'Bootstrap failures must not pollute MCP stdout');
      assert.match(
        result.stderr,
        new RegExp(rootVariable),
        'Bootstrap failure must identify the repository setting',
      );
    }
    const bindingFile = path.join(temporary, 'local-binding.json');
    fs.writeFileSync(bindingFile, JSON.stringify({ root: repositoryRoot, node: process.execPath }));
    const installedConfig = path.join(installedRoot, path.relative(pluginRoot, portable.mcpFile));
    verifyTools(
      await probeMcp(
        mcpInvocation(installedConfig, installedRoot, cleanEnvironment(bindingFile)),
        foreignCwd,
      ),
      expected,
      documentedTools,
      shippedExtras,
    );
    const malformedBinding = path.join(temporary, 'malformed-binding.json');
    fs.writeFileSync(malformedBinding, '{invalid json');
    const malformedInvocation = mcpInvocation(
      installedConfig,
      installedRoot,
      cleanEnvironment(malformedBinding),
    );
    const malformed = spawnSync(malformedInvocation.command, malformedInvocation.args, {
      cwd: foreignCwd,
      env: malformedInvocation.env,
      input: '',
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(malformed.error, undefined, 'Malformed local binding must fail promptly');
    assert.ok(
      malformed.status !== null && malformed.status !== 0,
      'Malformed local binding must fail',
    );
    assert.equal(malformed.stdout, '', 'Malformed binding errors must stay off MCP stdout');
    assert.match(
      malformed.stderr,
      /RDK_ROBOT_LEARNING_PLATFORM_CONFIG/,
      'Binding error must identify the configuration setting',
    );
    const compiledEntry = path.join(repositoryRoot, 'dist-server/services/duck-lab-mcp/server.js');
    if (fs.existsSync(compiledEntry)) {
      const compiledRoot = path.join(temporary, 'compiled-platform');
      fs.mkdirSync(compiledRoot);
      fs.copyFileSync(
        path.join(repositoryRoot, 'package.json'),
        path.join(compiledRoot, 'package.json'),
      );
      fs.symlinkSync(
        path.join(repositoryRoot, 'dist-server'),
        path.join(compiledRoot, 'dist-server'),
        'dir',
      );
      fs.symlinkSync(
        path.join(repositoryRoot, 'node_modules'),
        path.join(compiledRoot, 'node_modules'),
        'dir',
      );
      verifyTools(
        await probeMcp(
          mcpInvocation(
            path.join(installedRoot, path.relative(pluginRoot, portable.mcpFile)),
            installedRoot,
            {
              ...cleanEnvironment(unconfiguredFile),
              [rootVariable]: compiledRoot,
              RDK_ROBOT_LEARNING_PLATFORM_MCP_MODE: 'built',
            },
          ),
          foreignCwd,
        ),
        expected,
        documentedTools,
        shippedExtras,
      );
      console.log('[platform-plugin] compiled-only repository entry passed');
    } else {
      console.log('[platform-plugin] compiled entry not checked; run npm run build to include it');
    }
    console.log(
      `[platform-plugin] ${skillCount} skills, ${expected.tools.length} development MCP tools, ${extendedTools.length} installed MCP tools, provenance, root/local-binding cases and npm pack resources passed`,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (isDirectInvocation(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--distribution' || !args[1])) {
    console.error(
      'Usage: node scripts/verify-platform-plugin.mjs [--distribution <extracted-plugin-directory>]',
    );
    process.exitCode = 2;
  } else {
    main(args[1] ? path.resolve(args[1]) : undefined).catch((error) => {
      console.error(`[platform-plugin] ${error instanceof Error ? error.message : error}`);
      process.exitCode = 1;
    });
  }
}
