#!/usr/bin/env node

/** Exercise the installable plugin boundary without calling platform or hardware APIs. */
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EXPERIENCE_TOOLS } from '../plugins/rdk-robot-learning-platform/scripts/experience-mcp.mjs';
import { isDirectInvocation } from '../plugins/rdk-robot-learning-platform/scripts/experience.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginRelative = 'plugins/rdk-robot-learning-platform';
const pluginRoot = path.join(repositoryRoot, pluginRelative);
const rootVariable = 'RDK_ROBOT_LEARNING_PLATFORM_ROOT';
const require = createRequire(import.meta.url);

function expectedCourseHint(name) {
  const exact = {
    rdk_training_submit:
      'OriginMan课程优先rdk_originman_train显式选择预算，再rdk_originman_evaluate同源评测；不手拼SAC大小写、环境数、sourceRunId或groupId。\n',
    rdk_artifact_promote:
      '这是制品发布生命周期晋升，不是保存或下载文件。OriginMan保存评测记录使用links.experiment页面的保存按钮；不要因用户说保存、导出或回放而调用晋升。\n',
    rdk_runs_replay:
      'OriginMan评测视频不依赖本工具的通用遥测样本；样本为0不能判定视频不存在。请恢复原评测引用并读取workshop视频回执。\n',
    rdk_simulator_open:
      'OriginMan参考演示与本组回放不同：打开course.links.simulation，在页面内启动并观察基础PD；entryUrl不是已运行证明。不直接导航WebM，参考不需要先训练。\n',
    rdk_golden_path:
      'OriginMan仅仿真课程：此全局平台摘要不能作为本课完成比例，不用其他实验或部署状态替代本次结果。\n',
  };
  return (
    exact[name] ??
    (/^rdk_(deployment_|board_|physical_evaluation|replay_video)/.test(name)
      ? 'OriginMan本课仅仿真：此通用硬件能力不属于本课下一步，不因本课仿真完成自动调用；仅在用户独立明确要求对应硬件工作时使用。\n'
      : '')
  );
}

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
    for (const match of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
      assert.ok(
        match[0].startsWith('127.') || match[0] === '0.0.0.0',
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

async function probeMcp(invocation, cwd) {
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
    assert.equal(initialization.serverInfo.name, 'duck-lab-mcp');
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
  const withOlderTrainingSchema = (source) => {
    const compatible = structuredClone(source);
    const discoveredSubmit = tools.find((tool) => tool.name === 'rdk_training_submit');
    const expectedSubmit = compatible.find((tool) => tool.name === 'rdk_training_submit');
    const discoveredProperties = discoveredSubmit?.inputSchema?.properties ?? {};
    const expectedProperties = expectedSubmit?.inputSchema?.properties ?? {};
    // These course fields were added after some independently deployed MCP
    // cores. Their schemas remain in the bundled catalog; older cores may
    // omit them while accepting extensions through additionalProperties.
    for (const field of ['originmanWorkshop', 'originmanDance'])
      if (!(field in discoveredProperties)) delete expectedProperties[field];
    return compatible;
  };
  assert.deepEqual(
    tools,
    withOlderTrainingSchema(expected.tools),
    'Plugin discovery must preserve schemas and safety annotations',
  );
  assert.deepEqual(
    expected.snapshot,
    expected.tools,
    'Bundled tool catalog must match the current MCP schemas and safety annotations',
  );
  const trainingSubmit = tools.find((tool) => tool.name === 'rdk_training_submit');
  assert.equal(
    trainingSubmit?.inputSchema?.additionalProperties,
    true,
    'Training submission must keep compatibility with additive course fields',
  );
  assert.deepEqual(
    tools,
    withOlderTrainingSchema(expected.snapshot),
    'Discovered tools must match the bundled catalog, including compatible older cores',
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

async function main() {
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
    const foreignCwd = path.join(temporary, 'unrelated-cwd');
    const unconfiguredFile = path.join(temporary, 'missing-binding.json');
    fs.cpSync(pluginRoot, installedRoot, { recursive: true });
    fs.mkdirSync(foreignCwd);
    const extendedTools = await probeMcp(
      {
        command: process.execPath,
        args: [path.join(installedRoot, 'scripts/experience-mcp.mjs')],
        env: {
          ...cleanEnvironment(unconfiguredFile),
          [rootVariable]: repositoryRoot,
          RDK_ROBOT_LEARNING_PLATFORM_MCP_MODE: 'source',
        },
      },
      foreignCwd,
    );
    const coreTools = extendedTools.slice(0, expected.tools.length);
    assert.equal(coreTools.length, expected.tools.length);
    for (let i = 0; i < coreTools.length; i++) {
      const actual = coreTools[i],
        original = expected.tools[i];
      if (original.name === 'rdk_replay_video') {
        // This deliberate applicability note fixes the workshop/board replay confusion.
        // Every schema, permission, name and other core field remains exact.
        assert.equal(
          actual.description,
          '仅用于真机遥测视频渲染；OriginMan短训评测的视频已随评测Run生成，不能用本工具。请rdk_experiment_resume优先获取links.experiment；旧平台使用links.workbench并在页面内选择本次Run、打开播放器。\n' +
            original.description,
        );
        assert.deepEqual({ ...actual, description: original.description }, original);
      } else if (expectedCourseHint(original.name)) {
        assert.equal(actual.description, expectedCourseHint(original.name) + original.description);
        assert.deepEqual({ ...actual, description: original.description }, original);
      } else assert.deepEqual(actual, original);
    }
    const optionalTools = extendedTools.slice(expected.tools.length);
    assert.deepEqual(
      optionalTools,
      EXPERIENCE_TOOLS,
      'Optional entry must expose its real descriptors',
    );
    assert.equal(new Set(extendedTools.map((tool) => tool.name)).size, extendedTools.length);
    for (const tool of optionalTools) {
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
      assert.equal(tool.annotations?.readOnlyHint, !mutations.has(tool.name));
      assert.equal(tool.annotations?.destructiveHint, false);
    }
    for (const config of [portable, compat]) {
      const installedConfig = path.join(installedRoot, path.relative(pluginRoot, config.mcpFile));
      const invocation = mcpInvocation(installedConfig, installedRoot, {
        ...cleanEnvironment(unconfiguredFile),
        [rootVariable]: repositoryRoot,
        RDK_ROBOT_LEARNING_PLATFORM_MCP_MODE: 'source',
      });
      verifyTools(await probeMcp(invocation, foreignCwd), expected, documentedTools, optionalTools);
    }
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
      optionalTools,
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
      optionalTools,
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
        optionalTools,
      );
      console.log('[platform-plugin] compiled-only repository entry passed');
    } else {
      console.log('[platform-plugin] compiled entry not checked; run npm run build to include it');
    }
    console.log(
      `[platform-plugin] ${skillCount} skills, ${expected.tools.length} platform + ${optionalTools.length} optional MCP tools, portable/compat discovery, root/local-binding cases and npm pack resources passed`,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (isDirectInvocation(import.meta.url))
  main().catch((error) => {
    console.error(`[platform-plugin] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
