#!/usr/bin/env node

/** Real CPU learning through the plugin's raw MCP declaration, with an isolated ledger. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { COMMON_PYTHON_CANDIDATES, resolvePythonInterpreter } from './lib/python-interpreter.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = path.join(repositoryRoot, 'plugins/rdk-robot-learning-platform');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function parseJourneyArguments(args, defaultOutput) {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: { help: { type: 'boolean' }, output: { type: 'string' } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (cause) {
    throw Object.assign(
      new Error('Invalid arguments; use --help. Supported options: --help, --output FILE.', {
        cause,
      }),
      { exitCode: 2 },
    );
  }
  if (values.output !== undefined && (!values.output.trim() || values.output.startsWith('--'))) {
    throw Object.assign(new Error('--output requires a file path; use --help.'), { exitCode: 2 });
  }
  return { help: values.help === true, output: path.resolve(values.output ?? defaultOutput) };
}

export function scrubEvidence(value) {
  if (Array.isArray(value)) return value.map(scrubEvidence);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !/(?:password|cookie|token|secret|executable|stdout|stderr)/i.test(key))
        .map(([key, item]) => [key, scrubEvidence(item)]),
    );
  }
  if (typeof value !== 'string') return value;
  return value
    .replace(/https?:\/\/[^\s"'<>]+/g, '<isolated-endpoint>')
    .replace(
      /(?:\/Users\/|\/home\/|\/private\/var\/|\/var\/folders\/|\/tmp\/)[^\s"'<>]+/g,
      '<local-path>',
    )
    .replace(/[A-Z]:\\(?:Users|Temp)\\[^\s"'<>]+/gi, '<local-path>');
}

export async function verifyArtifactManifest(directory) {
  const listing = await fs.readFile(path.join(directory, 'SHA256SUMS'), 'utf8');
  const entries = [];
  for (const line of listing.trim().split('\n')) {
    const match = /^([a-f0-9]{64})\s{2}([^\r\n]+)$/.exec(line);
    assert.ok(match, 'Worker artifact manifest must contain SHA-256 entries');
    const [, sha256, name] = match;
    assert.ok(
      !path.isAbsolute(name) && !name.includes('/') && !name.includes('\\') && name !== '..',
      'Artifact manifest must contain local filenames',
    );
    const bytes = await fs.readFile(path.join(directory, name));
    assert.equal(digest(bytes), sha256, `Artifact bytes differ from SHA256SUMS: ${name}`);
    entries.push({ name, sha256, sizeBytes: bytes.length });
  }
  assert.ok(
    entries.some((entry) => entry.name === 'policy.onnx' && entry.sizeBytes > 1024),
    'A real exported ONNX must be covered by the artifact manifest',
  );
  return entries;
}

function environment(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(?:RDK_|RDK_STUDIO_|SSO_)/i.test(key)) delete env[key];
  return { ...env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', ...overrides };
}

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const port = socket.address().port;
  await new Promise((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  assert.notEqual(port, 18102, 'Journey services must not use the existing workbench port');
  return port;
}

function service(label, command, args, env, cwd = repositoryRoot, stdin = 'ignore') {
  const child = spawn(command, args, {
    cwd,
    env,
    detached: process.platform !== 'win32',
    stdio: [stdin, 'pipe', 'pipe'],
  });
  child.closed = false;
  child.once('close', () => {
    child.closed = true;
  });
  child.captured = '';
  const capture = (chunk) => {
    child.captured = (child.captured + String(chunk)).slice(-512 * 1024);
  };
  if (stdin !== 'pipe') child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.label = label;
  child.on('error', (error) => {
    child.startError = error;
  });
  return child;
}

async function terminate(child) {
  if (!child || child.closed || !child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  const stopped = new Promise((resolve) => child.once('close', resolve));
  const signal = (name) => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, name);
      else child.kill(name);
    } catch {
      /* Already stopped. */
    }
  };
  signal('SIGTERM');
  const timer = setTimeout(() => signal('SIGKILL'), 3000);
  await stopped;
  clearTimeout(timer);
}

async function http(base, route, body, options = {}) {
  const response = await fetch(new URL(route, base), {
    method: options.method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.key ? { 'idempotency-key': options.key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

async function waitReady(base, child, predicate) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.startError) throw child.startError;
    assert.equal(child.exitCode, null, `${child.label} exited before readiness: ${child.captured}`);
    try {
      const result = await http(base, '/healthz');
      if (result.status === 200 && predicate(result.body)) return result.body;
    } catch {
      /* Service is still starting. */
    }
    await sleep(150);
  }
  throw new Error(`${child.label} readiness timed out: ${child.captured}`);
}

function mcpClient(child) {
  const pending = new Map();
  let sequence = 0;
  let buffer = '';
  let protocolFailure;
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines.filter((entry) => entry.trim())) {
      try {
        const message = JSON.parse(line);
        assert.equal(message.jsonrpc, '2.0', 'Plugin stdout must contain only JSON-RPC');
        const target = pending.get(message.id);
        if (target) {
          pending.delete(message.id);
          target.resolve(message);
        }
      } catch (error) {
        protocolFailure = error;
        for (const target of pending.values()) target.reject(error);
        pending.clear();
      }
    }
  });
  const rejectAll = () => {
    for (const target of pending.values())
      target.reject(new Error(`Plugin MCP stopped: ${child.captured}`));
    pending.clear();
  };
  child.on('close', rejectAll);
  child.stdin.on('error', rejectAll);
  const request = async (method, params) => {
    if (protocolFailure) throw protocolFailure;
    const id = ++sequence;
    let timer;
    try {
      const result = await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP request timed out: ${method}`));
        }, 30_000);
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`,
        );
      });
      assert.equal(
        result.error,
        undefined,
        `MCP protocol failure: ${JSON.stringify(result.error)}`,
      );
      return result.result;
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    request,
    notify: (method) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`),
    call: async (name, args = {}, expectError = false) => {
      const result = await request('tools/call', { name, arguments: args });
      const text =
        result.content
          ?.filter((item) => item.type === 'text')
          .map((item) => item.text)
          .join('\n') ?? '';
      if (expectError) {
        assert.equal(result.isError, true, `${name} must reject unsafe or unsupported evidence`);
        return { rejected: true, message: scrubEvidence(text) };
      }
      assert.notEqual(result.isError, true, `${name} failed: ${text}`);
      return result.structuredContent ?? JSON.parse(text || '{}');
    },
  };
}

async function main() {
  const { output, help } = parseJourneyArguments(
    process.argv.slice(2),
    path.join(repositoryRoot, 'dist/plugins/platform-plugin-journey.json'),
  );
  if (help) {
    console.log(
      'Usage: node scripts/verify-platform-plugin-journey.mjs [--output FILE]\nRuns two real CPU Starter PPO rounds through raw plugin MCP with isolated temporary services and storage. No motor actions. Requires Python numpy/torch/onnx; set RDK_STARTER_ENGINE_PYTHON when needed. Optional mounted simulator assets: RDK_PLUGIN_JOURNEY_MICRODUCK_ROOT. Missing dependencies exit 2; hardware deployment remains unverified. --help starts no services and writes no evidence.',
    );
    return;
  }
  const started = Date.now();
  const report = {
    schemaVersion: 1,
    journey: 'platform-plugin-real-starter-v1',
    startedAt: new Date().toISOString(),
    status: 'running',
    exitCode: 1,
    scope: {
      training: 'Real CPU PPO gradients, NumPy pendulum-chain simulation, Torch ONNX export',
      simulator:
        'Platform simulator entry and separately generated starter environment trajectory; browser rendering is not asserted',
      sim2real:
        'Imported host simulation rollout against untrained reference; no attested real sensor evidence',
      board: 'Local reference BoardAgent, mock=true, actuatorControl=false',
      deployment: 'Preflight and safety rejection only; no real board rollout or motor command',
      cloud: 'No paid cloud resource or network model service is used',
    },
    budget: {
      firstIterations: 20,
      tunedIterations: 30,
      environments: 16,
      rolloutSteps: 64,
      perTrainingTimeoutMs: 120_000,
    },
    cases: [],
  };
  const children = [];
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-platform-plugin-journey-'));
  let failure;
  const step = async (id, transport, execute) => {
    const caseStarted = Date.now();
    try {
      const evidence = await execute();
      report.cases.push({
        id,
        status: 'passed',
        exitCode: 0,
        durationMs: Date.now() - caseStarted,
        transport,
        evidence: scrubEvidence(evidence),
      });
      console.log(`[plugin-journey] ${id} passed (${Date.now() - caseStarted}ms)`);
      return evidence;
    } catch (error) {
      report.cases.push({
        id,
        status: error.code === 'MISSING_PYTHON' ? 'blocked' : 'failed',
        exitCode: error.code === 'MISSING_PYTHON' ? 2 : 1,
        durationMs: Date.now() - caseStarted,
        transport,
        error: scrubEvidence(error.message),
      });
      throw error;
    }
  };
  try {
    const dependencies = await step('J00.dependencies', 'runtime', async () => {
      const selected = resolvePythonInterpreter(
        [process.env.RDK_STARTER_ENGINE_PYTHON, ...COMMON_PYTHON_CANDIDATES],
        'import numpy, torch, onnx',
      );
      if (!selected) {
        const error = new Error(
          'Python numpy+torch+onnx are required for real learning; no mock fallback was run. Set RDK_STARTER_ENGINE_PYTHON.',
        );
        error.code = 'MISSING_PYTHON';
        throw error;
      }
      const probe = spawnSync(
        selected,
        [
          '-c',
          'import json,sys,numpy,torch,onnx;print(json.dumps({"pythonExecutable":sys.executable,"pythonVersion":sys.version.split()[0],"numpy":numpy.__version__,"torch":torch.__version__,"onnx":onnx.__version__}))',
        ],
        { encoding: 'utf8', timeout: 20_000 },
      );
      assert.equal(probe.status, 0, 'Python dependency version probe must succeed');
      const result = JSON.parse(probe.stdout);
      report.dependencies = {
        node: process.versions.node,
        python: result.pythonVersion,
        numpy: result.numpy,
        torch: result.torch,
        onnx: result.onnx,
      };
      return result;
    });
    const python = dependencies.pythonExecutable;
    const storage = path.join(scratch, 'ledger');
    const workerData = path.join(scratch, 'worker');
    await fs.mkdir(storage, { mode: 0o700 });
    await fs.mkdir(workerData, { mode: 0o700 });
    const [webPort, workerPort, boardPort] = await Promise.all([
      freePort(),
      freePort(),
      freePort(),
    ]);
    const base = `http://127.0.0.1:${webPort}`;
    const workerBase = `http://127.0.0.1:${workerPort}`;
    const boardBase = `http://127.0.0.1:${boardPort}`;
    const privateRunnerToken = randomUUID();
    await fs.writeFile(
      path.join(storage, 'devices.json'),
      JSON.stringify([
        {
          id: 'plugin-reference-board',
          host: '127.0.0.1',
          username: 'reference',
          status: 'connected',
          lastCheckedAt: new Date().toISOString(),
        },
      ]),
    );
    const worker = service(
      'real-local-worker',
      process.execPath,
      [path.join(repositoryRoot, 'services/sim2real-web/local-training-worker.mjs')],
      environment({
        RDK_SIM2REAL_LOCAL_WORKER_HOST: '127.0.0.1',
        RDK_SIM2REAL_LOCAL_WORKER_PORT: String(workerPort),
        RDK_SIM2REAL_LOCAL_WORKER_DATA_DIR: workerData,
        RDK_SIM2REAL_LOCAL_RUNNER_TOKEN: privateRunnerToken,
        RDK_SIM2REAL_TRAIN_EXECUTABLE: python,
        RDK_SIM2REAL_TRAIN_ARGS_JSON: JSON.stringify([
          path.join(repositoryRoot, 'engines/starter-ppo/runner.py'),
        ]),
        RDK_SIM2REAL_TRAIN_ENGINES_JSON: JSON.stringify({
          'starter-ppo': {
            executable: python,
            args: [path.join(repositoryRoot, 'engines/starter-ppo/runner.py')],
          },
        }),
        RDK_SIM2REAL_TRAIN_TIMEOUT_MS: '120000',
        RDK_STARTER_ENGINE_STEPS: '64',
        RDK_STARTER_ENGINE_DEVICE: 'cpu',
        CUDA_VISIBLE_DEVICES: '',
        OMP_NUM_THREADS: '1',
        MKL_NUM_THREADS: '1',
      }),
    );
    children.push(worker);
    const board = service(
      'reference-board-agent',
      process.execPath,
      [path.join(repositoryRoot, 'services/sim2real-web/local-board-agent.mjs')],
      environment({
        RDK_SIM2REAL_BOARD_AGENT_BIND_HOST: '127.0.0.1',
        RDK_SIM2REAL_BOARD_AGENT_PORT: String(boardPort),
        RDK_SIM2REAL_BOARD_AGENT_ARCH: 'aarch64',
        RDK_SIM2REAL_BOARD_AGENT_KERNEL: 'reference-fixture',
        RDK_SIM2REAL_BOARD_AGENT_TROS: 'present',
        RDK_SIM2REAL_BOARD_AGENT_DISK_BYTES: String(4 * 1024 ** 3),
      }),
    );
    children.push(board);
    const web = service(
      'isolated-platform',
      process.execPath,
      ['--import', 'tsx/esm', path.join(repositoryRoot, 'services/sim2real-web/server.ts')],
      environment({
        RDK_SIM2REAL_BIND_HOST: '127.0.0.1',
        RDK_SIM2REAL_PORT: String(webPort),
        RDK_SIM2REAL_STORAGE_DIR: storage,
        RDK_SIM2REAL_DEPLOYMENT: 'local',
        RDK_SIM2REAL_SSO_REQUIRED: '0',
        RDK_SIM2REAL_SSO_ENABLED: '0',
        RDK_SIM2REAL_REQUIRE_MICRODUCK: '0',
        ...(process.env.RDK_PLUGIN_JOURNEY_MICRODUCK_ROOT
          ? { RDK_SIM2REAL_MICRODUCK_ROOT: process.env.RDK_PLUGIN_JOURNEY_MICRODUCK_ROOT }
          : {}),
        RDK_SIM2REAL_LOCAL_RUNNER_URL: `${workerBase}/train`,
        RDK_SIM2REAL_LOCAL_RUNNER_TOKEN: privateRunnerToken,
        RDK_SIM2REAL_BOARD_AGENT_URL: boardBase,
        RDK_SIM2REAL_STATION_POLICY_ENABLED: '0',
        RDK_SIM2REAL_ALLOW_ACTUATOR_CONTROL: '0',
      }),
    );
    children.push(web);
    await step('J01.isolated-services', 'health-probes', async () => {
      const [workerHealth, boardHealth, webHealth] = await Promise.all([
        waitReady(workerBase, worker, (body) => body.ok && body.configured),
        waitReady(boardBase, board, (body) => body.ok),
        waitReady(base, web, (body) => body.ok && body.ready),
      ]);
      assert.equal(boardHealth.mock, true);
      assert.equal(boardHealth.actuatorControl, false);
      assert.equal(workerHealth.configured, true);
      assert.equal(webHealth.ready, true);
      return {
        freshLedger: true,
        isolatedPorts: true,
        workerConfigured: true,
        boardMock: true,
        actuatorControl: false,
        serviceReady: true,
      };
    });
    const declaration = JSON.parse(await fs.readFile(path.join(pluginRoot, 'mcp.json'), 'utf8'))
      .mcpServers['duck-lab'];
    assert.equal(declaration.command, 'node');
    const mcpProcess = service(
      'plugin-raw-stdio',
      declaration.command,
      declaration.args,
      environment({
        RDK_ROBOT_LEARNING_PLATFORM_ROOT: repositoryRoot,
        RDK_ROBOT_LEARNING_PLATFORM_NODE: process.execPath,
        RDK_ROBOT_LEARNING_PLATFORM_CONFIG: path.join(scratch, 'unconfigured.json'),
        RDK_SIM2REAL_MCP_BASE_URL: base,
        RDK_SIM2REAL_MCP_TIMEOUT_MS: '15000',
      }),
      scratch,
      'pipe',
    );
    children.push(mcpProcess);
    const mcp = mcpClient(mcpProcess);
    await step('J02.plugin-protocol', 'MCP initialize/tools/list/ping', async () => {
      const initialized = await mcp.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'platform-plugin-real-journey', version: '1.0.0' },
      });
      mcp.notify('notifications/initialized');
      assert.equal(initialized.serverInfo.name, 'duck-lab-mcp');
      const { tools } = await mcp.request('tools/list');
      assert.deepEqual(await mcp.request('ping'), {});
      const snapshot = JSON.parse(
        await fs.readFile(path.join(pluginRoot, 'references/tool-catalog.json'), 'utf8'),
      );
      assert.ok(
        isDeepStrictEqual(tools, snapshot),
        'Plugin catalog snapshot drift: regenerate update:plugin-catalog before running the journey',
      );
      const status = await mcp.call('rdk_platform_status');
      assert.equal(status.ok, true);
      assert.equal(status.health.ready, true);
      return {
        toolCount: tools.length,
        schemasMatchPublishedPlugin: true,
        protocolStdoutClean: true,
        platformReady: true,
      };
    });
    await step('J03.simulator-entry', 'MCP rdk_simulator_open + HTTP browser asset', async () => {
      const entry = await mcp.call('rdk_simulator_open');
      assert.ok(entry.entryUrl.startsWith('/mujoco/'));
      const response = await fetch(new URL(entry.entryUrl, base), {
        signal: AbortSignal.timeout(15_000),
      });
      const html = await response.text();
      assert.equal(response.status, 200);
      assert.match(html, /(?:<html|<!doctype)/i);
      assert.ok(html.length > 500);
      return {
        entryResolved: true,
        htmlBytes: Buffer.byteLength(html),
        browserPhysicsNotMeasured: true,
      };
    });
    const demoFile = path.join(scratch, 'starter-simulation.jsonl');
    const dataset = await step(
      'J04.simulation-data',
      'real NumPy simulator + MCP rdk_dataset_register',
      async () => {
        const code = `import importlib.util,json,sys,numpy as np\nspec=importlib.util.spec_from_file_location("journey_starter",sys.argv[1]);module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)\nenv=module.PendulumChain(1,12,6,seed=7);rows=[]\nfor i in range(50):\n obs=env.observe()[0];action=np.zeros((1,12),dtype=np.float32);_,reward,done,fall=env.step(action,0.002,10)\n rows.append({"t":round(i/50,4),"observation":obs.tolist(),"action":action[0].tolist(),"reward":float(reward[0]),"done":bool(done[0]),"fall":bool(fall[0])})\nwith open(sys.argv[2],"w") as handle:\n for row in rows:handle.write(json.dumps(row)+"\\n")\n`;
        const generated = spawnSync(
          python,
          ['-c', code, path.join(repositoryRoot, 'engines/starter-ppo/runner.py'), demoFile],
          { encoding: 'utf8', timeout: 20_000 },
        );
        assert.equal(generated.status, 0, generated.stderr);
        const bytes = await fs.readFile(demoFile);
        const rows = bytes.toString().trim().split('\n').map(JSON.parse);
        assert.equal(rows.length, 50);
        assert.equal(rows[0].observation.length, 42);
        assert.equal(rows[0].action.length, 12);
        const registered = await mcp.call('rdk_dataset_register', {
          name: 'Plugin starter simulator trajectory',
          version: '1.0.0',
          uri: 'artifact://plugin-journey/starter-simulation/seed-7.jsonl',
          format: 'jsonl',
          sha256: digest(bytes),
          contractId: 'rdk-duck-policy-starter-v1',
          sampleCount: rows.length,
          sizeBytes: bytes.length,
          tags: ['host-simulation', 'online-ppo-metadata'],
          idempotencyKey: 'plugin-journey-dataset-1',
        });
        assert.ok(registered.id);
        return {
          datasetId: registered.id,
          sampleCount: rows.length,
          sha256: digest(bytes),
          observations: 42,
          actions: 12,
          provenance:
            'Actual starter NumPy environment, seed 7; dataset registration does not imply PPO consumes offline demonstration data',
        };
      },
    );
    const modelAndProject = await step(
      'J05.model-project-data',
      'MCP model_validate/model_register/project_create/*_list',
      async () => {
        const manifest = JSON.parse(
          await fs.readFile(
            path.join(repositoryRoot, 'examples/starter-ppo-manifest.json'),
            'utf8',
          ),
        );
        manifest.modelId = 'starter-plugin-journey-v1';
        manifest.version = '0.1.0-journey';
        const valid = await mcp.call('rdk_model_validate', { manifest });
        assert.equal(valid.valid, true);
        const model = await mcp.call('rdk_model_register', {
          manifest,
          idempotencyKey: 'plugin-journey-model-1',
        });
        assert.ok(model.id);
        const project = await mcp.call('rdk_project_create', {
          name: 'Platform plugin real CPU journey',
          slug: 'platform-plugin-journey',
          modelIds: [model.id],
          datasetIds: [dataset.datasetId],
          idempotencyKey: 'plugin-journey-project-1',
        });
        assert.ok(project.id);
        const [models, projects, datasets] = await Promise.all([
          mcp.call('rdk_models_list'),
          mcp.call('rdk_projects_list'),
          mcp.call('rdk_datasets_list'),
        ]);
        assert.ok(models.models.some((item) => item.id === model.id));
        assert.ok(projects.projects.some((item) => item.id === project.id));
        assert.ok(datasets.datasets.some((item) => item.id === dataset.datasetId));
        return {
          modelId: model.id,
          projectId: project.id,
          datasetId: dataset.datasetId,
          validatedContract: '42D/12D starter host simulation',
        };
      },
    );
    const train = async (iterations, key) => {
      const args = {
        modelId: modelAndProject.modelId,
        projectId: modelAndProject.projectId,
        datasetIds: [dataset.datasetId],
        backend: 'local',
        engine: 'starter-ppo',
        algorithm: 'ppo',
        taskId: 'balance',
        profile: 'smoke',
        numEnvs: 16,
        maxIterations: iterations,
        video: false,
        idempotencyKey: key,
      };
      const launched = await mcp.call('rdk_training_submit', args);
      assert.ok(launched.runId);
      const duplicate = await mcp.call('rdk_training_submit', args);
      assert.equal(
        duplicate.runId,
        launched.runId,
        'Repeated submit must reuse the run rather than enqueue a second gradient job',
      );
      const deadline = Date.now() + 120_000;
      let status;
      while (Date.now() < deadline) {
        status = await mcp.call('rdk_training_status', { runId: launched.runId });
        if (['completed', 'failed', 'blocked'].includes(status.status)) break;
        await sleep(250);
      }
      const detail = await http(base, `/api/v1/duck/runs/${encodeURIComponent(launched.runId)}`);
      assert.equal(detail.status, 200);
      const run = detail.body.run;
      if (status.status !== 'completed') {
        let failedLogs;
        try {
          failedLogs = await mcp.call('rdk_run_logs', { runId: launched.runId });
        } catch (error) {
          failedLogs = { unavailable: error.message };
        }
        throw new Error(
          `Real starter learning did not complete: ${JSON.stringify({ status: status.status, error: run.error, errorCode: run.errorCode, message: run.message, summary: run.summary, logTail: failedLogs.lines?.slice(-12), logsUnavailable: failedLogs.unavailable })}`,
        );
      }
      assert.notEqual(run.mock, true);
      assert.equal(run.backend, 'local');
      assert.equal(run.metrics.engine, 'starter-ppo');
      assert.equal(run.metrics.iterations, iterations);
      assert.equal(run.metrics.measurementStage, 'host-torch');
      assert.equal(run.artifact.format, 'onnx');
      assert.equal(run.artifact.deployable, false);
      const logs = await mcp.call('rdk_run_logs', { runId: run.id });
      assert.ok(logs.lines.length > 0);
      const job = path.join(workerData, run.externalRunId);
      const entries = await verifyArtifactManifest(job);
      const summary = JSON.parse(
        await fs.readFile(path.join(job, 'training-summary.json'), 'utf8'),
      );
      assert.equal(summary.algorithm, 'ppo');
      assert.equal(summary.device, 'cpu');
      assert.equal(summary.iterations, iterations);
      assert.equal(summary.numEnvs, 16);
      assert.equal(summary.rolloutSteps, 64);
      assert.equal(summary.rewardCurve.length, iterations);
      assert.ok(summary.rewardCurve.every(Number.isFinite));
      assert.equal(summary.onnxExported, true);
      const policy = entries.find((entry) => entry.name === 'policy.onnx');
      assert.equal(policy.sha256, run.artifact.sha256);
      return {
        run,
        job,
        summary,
        policy,
        evidence: {
          runId: run.id,
          iterations,
          algorithm: 'ppo',
          mock: false,
          measuredOn: 'host-torch CPU',
          gradientIterations: summary.rewardCurve.length,
          reward: run.metrics.reward,
          successRate: run.metrics.successRate,
          fallRate: run.metrics.fallRate,
          sizeBytes: policy.sizeBytes,
          sha256: policy.sha256,
          manifestFilesVerified: entries.length,
          logLineCount: logs.lines.length,
          idempotentSubmit: true,
          deployable: false,
        },
      };
    };
    let first;
    await step(
      'J06.real-learning',
      'MCP submit/status/logs + worker artifact verification',
      async () => {
        first = await train(20, 'plugin-journey-train-first');
        return first.evidence;
      },
    );
    await step('J07.onnx-host-inference', 'real ONNX validation/inference, host CPU', async () => {
      const code = `import json,sys,numpy as np,onnx\nmodel=onnx.load(sys.argv[1]);onnx.checker.check_model(model)\ntry:import onnxruntime as ort\nexcept ImportError:print(json.dumps({"onnxValid":True,"inferenceAvailable":False}));sys.exit(0)\noptions=ort.SessionOptions();options.intra_op_num_threads=1;session=ort.InferenceSession(sys.argv[1],sess_options=options,providers=["CPUExecutionProvider"])\nrows=[json.loads(line) for line in open(sys.argv[2]) if line.strip()];observations=np.asarray([row["observation"] for row in rows],dtype=np.float32);expected=np.asarray([row["action"] for row in rows],dtype=np.float32);actual=session.run(None,{session.get_inputs()[0].name:observations})[0];print(json.dumps({"onnxValid":True,"inferenceAvailable":True,"samples":len(rows),"actionSize":int(actual.shape[-1]),"finite":bool(np.isfinite(actual).all()),"maxAbsoluteError":float(np.max(np.abs(actual-expected)))}))`;
      const inferred = spawnSync(
        python,
        ['-c', code, path.join(first.job, 'policy.onnx'), path.join(first.job, 'telemetry.jsonl')],
        { encoding: 'utf8', timeout: 30_000 },
      );
      assert.equal(inferred.status, 0, inferred.stderr);
      const result = JSON.parse(inferred.stdout);
      assert.equal(result.onnxValid, true);
      if (result.inferenceAvailable) {
        assert.equal(result.actionSize, 12);
        assert.equal(result.finite, true);
        assert.ok(
          result.maxAbsoluteError < 0.0001,
          'Exported ONNX actions must numerically match the Torch evaluation rollout',
        );
      } else
        report.scope.hostInference =
          'ONNX syntax validated; onnxruntime missing, pure inference not verified';
      return { ...result, measurementStage: 'host-onnx', boardInferenceNotVerified: true };
    });
    const evaluated = await step(
      'J08.telemetry-evaluation-replay',
      'MCP telemetry/evaluation/replay + versioned reference evaluation API',
      async () => {
        const telemetry = await mcp.call('rdk_telemetry_list', { runId: first.run.id });
        assert.ok(telemetry.count > 0);
        assert.ok(
          telemetry.telemetry.every((item) => item.source === 'import' && item.attested === false),
        );
        const summarized = await mcp.call('rdk_evaluation_summarize', { runId: first.run.id });
        assert.ok(summarized.replay.sampleCount > 0);
        const reference = (
          await fs.readFile(path.join(first.job, 'baseline-telemetry.jsonl'), 'utf8')
        )
          .trim()
          .split('\n')
          .map(JSON.parse);
        const referenceEvaluation = await http(base, `/api/v1/duck/runs/${first.run.id}/evaluate`, {
          referenceSamples: reference,
        });
        assert.equal(referenceEvaluation.status, 200);
        const evaluation = referenceEvaluation.body.evaluation;
        assert.equal(referenceEvaluation.body.evaluationRecord.status, 'passed');
        assert.equal(referenceEvaluation.body.evaluationRecord.attested, false);
        assert.equal(referenceEvaluation.body.evaluationRecord.runId, first.run.id);
        assert.equal(referenceEvaluation.body.evaluationRecord.modelId, first.run.modelId);
        assert.ok(evaluation.sampleCount > 0);
        assert.equal(evaluation.replay.attested, false);
        assert.ok(Number.isFinite(evaluation.actionMae));
        assert.ok(Number.isFinite(evaluation.actionRmse));
        const replay = await mcp.call('rdk_runs_replay', { runId: first.run.id });
        assert.ok(replay.frameCount > 0);
        const sessions = await mcp.call('rdk_board_sessions', { runId: first.run.id });
        assert.equal(
          sessions.count,
          0,
          'Imported simulation data must never become a real board session',
        );
        const listed = await mcp.call('rdk_evaluations_list', { runId: first.run.id });
        assert.ok(
          listed.evaluations.some(
            (item) => item.id === referenceEvaluation.body.evaluationRecord.id,
          ),
        );
        return {
          runId: first.run.id,
          evaluationId: referenceEvaluation.body.evaluationRecord.id,
          sampleCount: evaluation.sampleCount,
          source: 'import',
          attested: false,
          evaluationRecordStatus: referenceEvaluation.body.evaluationRecord.status,
          actionMae: evaluation.actionMae,
          actionRmse: evaluation.actionRmse,
          observationMae: evaluation.observationMae,
          replayFrames: replay.frameCount,
          boardSessions: 0,
          evidenceScope:
            'Trained host simulation versus untrained simulation reference, not sim-to-real robot accuracy',
        };
      },
    );
    await step('J09.lineage', 'MCP rdk_lineage_get', async () => {
      const result = await mcp.call('rdk_lineage_get', { runId: first.run.id });
      const text = JSON.stringify(result.lineage);
      assert.ok(text.includes(first.run.id));
      assert.ok(text.includes(modelAndProject.projectId));
      assert.ok(text.includes(dataset.datasetId));
      assert.ok(text.includes(evaluated.evaluationId));
      return {
        runId: first.run.id,
        projectLinked: true,
        datasetLinked: true,
        evaluationLinked: true,
      };
    });
    const artifact = await step(
      'J10.artifact-lifecycle',
      'versioned registry API + MCP rdk_artifact_promote',
      async () => {
        const payload = {
          artifactId: 'plugin-journey-trained-policy',
          name: 'Starter CPU policy',
          version: '1.0.0',
          role: 'policy',
          kind: 'source',
          format: 'onnx',
          runtime: 'cpu-onnx',
          workload: 'locomotion',
          threads: 1,
          ref: 'artifact://plugin-journey/trained-policy/v1/policy.onnx',
          sha256: first.policy.sha256,
          sizeBytes: first.policy.sizeBytes,
          modelId: first.run.modelId,
          runId: first.run.id,
          contractId: 'rdk-duck-policy-starter-v1',
          datasetIds: [dataset.datasetId],
          evaluationIds: [evaluated.evaluationId],
        };
        const unattested = await http(base, '/api/v1/duck/artifacts', payload);
        assert.equal(
          unattested.status,
          422,
          `Unattested evaluation binding must hit the lineage gate: ${JSON.stringify(unattested.body)}`,
        );
        assert.equal(unattested.body.code, 'SIM2REAL_ARTIFACT_LINEAGE_INVALID');
        assert.match(unattested.body.message, /血缘引用无效/);
        const registered = await http(
          base,
          '/api/v1/duck/artifacts',
          {
            ...payload,
            evaluationIds: [],
            metadata: { measurementStage: 'host-torch', boardReady: false },
          },
          { key: 'plugin-journey-artifact-source' },
        );
        assert.equal(registered.status, 201);
        const id = registered.body.artifact.id;
        assert.equal(registered.body.artifact.status, 'draft');
        const validated = await mcp.call('rdk_artifact_promote', {
          artifactId: id,
          status: 'validated',
          idempotencyKey: 'plugin-journey-artifact-validate',
        });
        assert.equal(validated.status, 'validated');
        const published = await mcp.call('rdk_artifact_promote', {
          artifactId: id,
          status: 'published',
          idempotencyKey: 'plugin-journey-artifact-publish',
        });
        assert.equal(published.status, 'published');
        assert.equal(published.artifact.sha256, first.policy.sha256);
        return {
          artifactId: id,
          sha256: first.policy.sha256,
          lifecycle: ['draft', 'validated', 'published'],
          unattestedEvaluationBindingRejected: true,
          attestationRejection: {
            httpStatus: unattested.status,
            code: unattested.body.code,
            message: unattested.body.message,
            evaluationStatus: evaluated.evaluationRecordStatus,
            evaluationAttested: evaluated.attested,
            matchingModelAndRun: true,
            identicalSourcePayloadAcceptedWithoutEvaluationBinding: true,
          },
          publicationScope:
            'Immutable source artifact registry metadata; not board deployment readiness',
        };
      },
    );
    await step(
      'J11.motion-and-staging-gates',
      'MCP board_health/policy_stage/policy_start',
      async () => {
        const health = await mcp.call('rdk_board_health');
        assert.ok(health);
        const passport = await http(
          base,
          '/api/devices/plugin-reference-board/board/detect?persist=true',
          {},
          { method: 'POST' },
        );
        assert.equal(passport.status, 200);
        assert.equal(passport.body.mock, true);
        assert.equal(passport.body.actuatorControl, false);
        assert.equal(passport.body.persisted, true);
        const staging = await mcp.call('rdk_board_policy_stage', { runId: first.run.id }, true);
        assert.match(staging.message, /(?:DISABLED|未开启|关闭)/);
        const start = await mcp.call('rdk_board_policy_start', { direction: 0 }, true);
        assert.match(start.message, /(?:DISABLED|未开启|关闭)/);
        const unchanged = await http(boardBase, '/healthz');
        assert.equal(unchanged.body.mock, true);
        assert.equal(unchanged.body.actuatorControl, false);
        return {
          stagingRejected: true,
          startRejected: true,
          referenceAgentMock: true,
          actuatorControl: false,
          noPolicyLoadedOrMotorMoved: true,
        };
      },
    );
    await step('J12.deployment-preflight', 'MCP preflight/status/history/cancel', async () => {
      const preflight = await mcp.call('rdk_deployment_preflight', {
        modelId: modelAndProject.modelId,
        deviceId: 'plugin-reference-board',
        runId: first.run.id,
        idempotencyKey: 'plugin-journey-deployment-preflight',
      });
      assert.equal(preflight.mock, true);
      assert.equal(preflight.passed, false);
      assert.ok(preflight.deploymentId);
      const status = await mcp.call('rdk_deployment_status', {
        deploymentId: preflight.deploymentId,
      });
      assert.equal(status.deployment.status, 'blocked');
      assert.equal(status.deployment.mode, 'preflight');
      assert.equal(status.deployment.verification.mock, true);
      const history = await mcp.call('rdk_deployment_history', {
        deploymentId: preflight.deploymentId,
      });
      assert.ok(history.history.length > 0);
      const cancelled = await mcp.call('rdk_deployment_cancel', {
        deploymentId: preflight.deploymentId,
      });
      assert.equal(cancelled.status, 'cancelled');
      return {
        deploymentId: preflight.deploymentId,
        preflightPassed: false,
        mock: true,
        statusBeforeCancel: 'blocked',
        statusAfterCancel: 'cancelled',
        historyEntries: history.history.length,
        hardwareDeployment: 'not-completed',
      };
    });
    await step(
      'J13.feedback-and-advice',
      'versioned feedback API + MCP feedback_summary/retraining_advice',
      async () => {
        const feedback = await http(base, '/api/v1/duck/feedback', {
          surface: 'run-record',
          verdict: 'accurate',
          runId: first.run.id,
          note: 'CPU training evidence is valid; host simulation does not qualify as real board evidence. Next controlled experiment increases iterations from 20 to 30.',
        });
        assert.equal(feedback.status, 201);
        assert.equal(feedback.body.feedback.runId, first.run.id);
        const summary = await mcp.call('rdk_feedback_summary');
        assert.equal(summary.summary.total, 1);
        assert.equal(summary.summary.accurate, 1);
        const advice = await mcp.call('rdk_retraining_advice', { runId: first.run.id });
        assert.ok(advice.advice && typeof advice.advice === 'object');
        return {
          feedbackRecorded: true,
          feedbackSummary: summary.summary,
          retrainingAdvice: advice.advice,
          tuningChoice:
            'Increase PPO iteration budget 20→30, preserving seed/environment/device; feedback is operational evidence and never a release approval',
        };
      },
    );
    let tuned;
    await step('J14.controlled-tuning', 'MCP real learning + metrics comparison', async () => {
      tuned = await train(30, 'plugin-journey-train-tuned');
      assert.notEqual(tuned.run.id, first.run.id);
      assert.notEqual(tuned.policy.sha256, first.policy.sha256);
      const runs = await mcp.call('rdk_runs_list', { projectId: modelAndProject.projectId });
      assert.equal(
        runs.runs.filter((run) => run.id === first.run.id || run.id === tuned.run.id).length,
        2,
      );
      const lineage = await mcp.call('rdk_lineage_get', { runId: tuned.run.id });
      assert.ok(JSON.stringify(lineage.lineage).includes(dataset.datasetId));
      return {
        ...tuned.evidence,
        comparison: {
          firstIterations: 20,
          tunedIterations: 30,
          firstReward: first.run.metrics.reward,
          tunedReward: tuned.run.metrics.reward,
          rewardDelta: tuned.run.metrics.reward - first.run.metrics.reward,
          firstSuccessRate: first.run.metrics.successRate,
          tunedSuccessRate: tuned.run.metrics.successRate,
          improvementGuaranteed: false,
        },
      };
    });
    await step('J15.revocation-gate', 'MCP rdk_artifact_promote', async () => {
      const revoked = await mcp.call('rdk_artifact_promote', {
        artifactId: artifact.artifactId,
        status: 'revoked',
        reason: 'Disposable integration journey completed',
        idempotencyKey: 'plugin-journey-artifact-revoke',
      });
      assert.equal(revoked.status, 'revoked');
      const rejected = await mcp.call(
        'rdk_artifact_promote',
        {
          artifactId: artifact.artifactId,
          status: 'published',
          idempotencyKey: 'plugin-journey-artifact-republish',
        },
        true,
      );
      assert.ok(rejected.rejected);
      assert.match(rejected.message, /不可原地修改|不可.*(?:再次|重新).*发布|revok|NOT_MUTABLE/i);
      const persisted = await http(base, `/api/v1/duck/artifacts/${artifact.artifactId}`);
      assert.equal(persisted.status, 200);
      assert.equal(persisted.body.artifact.status, 'revoked');
      return {
        status: 'revoked',
        republishRejected: true,
        immutableRejection: rejected.message,
        persistedStatusAfterRejectedRepublish: 'revoked',
      };
    });
    await step(
      'J16.final-workspace-audit',
      'MCP overview/summary/golden_path + audit health',
      async () => {
        const overview = await mcp.call('rdk_workspace_overview');
        assert.ok(
          overview.runs.some((run) => run.id === first.run.id && run.status === 'completed'),
        );
        assert.ok(
          overview.runs.some((run) => run.id === tuned.run.id && run.status === 'completed'),
        );
        const summary = await mcp.call('rdk_workspace_summary');
        assert.ok(summary.counts);
        const golden = await mcp.call('rdk_golden_path', {
          projectId: modelAndProject.projectId,
          modelId: modelAndProject.modelId,
          taskId: 'balance',
        });
        assert.ok(golden.goldenPath);
        const audit = await http(base, '/api/v1/duck/audit/health');
        assert.equal(audit.status, 200);
        assert.equal(audit.body.readable, true);
        assert.equal(audit.body.writable, true);
        assert.ok(audit.body.eventCount > 0);
        return {
          twoRealCompletedRuns: true,
          workspaceCounts: summary.counts,
          auditEvents: audit.body.eventCount,
          auditHealthy: true,
          hardwareDeploymentRemainsBlocked: true,
        };
      },
    );
    report.status = 'passed-with-hardware-limitations';
    report.exitCode = 0;
    report.outcome = {
      realTraining: true,
      realOnnxExport: true,
      realHostSimulation: true,
      pluginBusinessCallsVerified: true,
      tuningExperimentCompleted: true,
      realBoardTelemetry: false,
      realBoardInference: false,
      realHardwareDeployment: false,
      actuatorsInvoked: false,
    };
  } catch (error) {
    failure = error;
    report.status = error.code === 'MISSING_PYTHON' ? 'blocked-missing-dependencies' : 'failed';
    report.exitCode = error.code === 'MISSING_PYTHON' ? 2 : 1;
  } finally {
    await Promise.all(children.reverse().map(terminate));
    await fs.rm(scratch, { recursive: true, force: true });
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - started;
    report.cleanup = { servicesStopped: true, temporaryLedgerRemoved: true };
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, `${JSON.stringify(scrubEvidence(report), null, 2)}\n`);
  }
  console.log(
    `[plugin-journey] ${report.status}; ${report.cases.filter((item) => item.status === 'passed').length}/${report.cases.length} cases passed; evidence written`,
  );
  if (failure) console.error(`[plugin-journey] ${scrubEvidence(failure.message)}`);
  process.exitCode = report.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(`[plugin-journey] ${scrubEvidence(error.message)}`);
    process.exitCode = error.exitCode ?? 1;
  });

export { environment, freePort, service, terminate, http, waitReady, mcpClient };
