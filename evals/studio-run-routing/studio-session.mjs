import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { exportStudioPlugin } from '../../scripts/export-studio-plugin.mjs';
import { startScriptedModel } from './scripted-model.mjs';

const setup = process.env.RDK_STUDIO_EVAL_CASE;
const studio = process.env.RDK_STUDIO_SOURCE_DIR;
const load = (path) => import(pathToFileURL(join(studio, path)).href);
const { first, followup, runId } = JSON.parse(setup);
assert.ok(first.includes(runId) && !followup.includes(runId));
const profile = mkdtempSync(join(tmpdir(), 'rdk-studio-eval-'));
process.env.RDK_STUDIO_HOME = join(profile, 'studio-config');
process.env.RDK_DATA_DIR = join(profile, 'studio-data');
process.env.RDK_STUDIO_DEPLOYMENT_PROFILE = 'local-dev';
process.env.RDK_SIM2REAL_STORAGE_DIR = join(profile, 'learning-ledger');
process.chdir(profile);

const requests = [];
const cookie = 'studio-run-eval=fixture-owner';
const policySha256 = createHash('sha256').update('synthetic policy bytes').digest('hex');
const run = {
  id: runId,
  modelId: 'eval-model',
  status: 'completed',
  mock: false,
  artifact: { format: 'onnx', sha256: policySha256, deployable: false },
  artifactRetention: { state: 'retained' },
};
const platform = createServer((req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  requests.push({ method: req.method, path });
  const json = (status, body) =>
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  if (!['GET', 'HEAD'].includes(req.method)) return json(405, { error: 'fixture_is_read_only' });
  if (['/healthz', '/readyz'].includes(path)) return json(200, { ok: true, ready: true });
  if (req.headers.cookie !== cookie) return json(401, { error: 'fixture_auth_required' });
  if (['/api/sso/me', '/api/sim2real/auth/session'].includes(path)) {
    return json(200, {
      authenticated: true,
      accountId: 'fixture-owner',
      user: { id: 'fixture-owner' },
    });
  }
  if (path === '/api/v1/duck/runs/' + runId || path === '/api/sim2real/runs/' + runId)
    return json(200, { run });
  if (req.method === 'HEAD' && path === '/api/v1/duck/runs/' + runId + '/artifact') {
    return res
      .writeHead(200, {
        'x-artifact-sha256': policySha256,
        'content-disposition': 'attachment; filename="policy.onnx"',
      })
      .end();
  }
  return json(404, { error: 'SIM2REAL_RUN_NOT_FOUND' });
});

let app;
let importer;
let scriptedModel;
try {
  const scripted = process.env.RDK_STUDIO_EVAL_SCRIPTED_MODEL;
  let model;
  if (scripted) {
    assert.ok(['pass', 'history-only'].includes(scripted), 'Unknown scripted model scenario');
    scriptedModel = await startScriptedModel({ historyOnly: scripted === 'history-only' });
    model = scriptedModel.entry;
  } else {
    const registry = JSON.parse(readFileSync(process.env.RDK_STUDIO_EVAL_MODEL_CONFIG, 'utf8'));
    const entryId = process.env.RDK_STUDIO_EVAL_MODEL_ENTRY || registry.activeId;
    model = registry.entries.find((entry) => entry.id === entryId);
    assert.ok(model, 'The specified provider entry must exist');
  }
  mkdirSync(process.env.RDK_STUDIO_HOME);
  writeFileSync(
    join(process.env.RDK_STUDIO_HOME, 'agent-config.json'),
    JSON.stringify({ activeId: model.id, entries: [model] }),
    { mode: 0o600 },
  );
  await new Promise((done, fail) => platform.once('error', fail).listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${platform.address().port}`;
  const output = join(profile, 'plugin');
  exportStudioPlugin({ output, platformUrl: base });
  const mcpPath = join(output, '.mcp.json');
  const config = JSON.parse(readFileSync(mcpPath, 'utf8'));
  const server = config.mcpServers['rdk-robot-learning-platform'];
  server.args = [fileURLToPath(new URL('./fixture-mcp.mjs', import.meta.url))];
  server.permissions = { default: 'approval', tools: { rdk_training_status: 'readonly' } };
  writeFileSync(mcpPath, JSON.stringify(config));

  const [{ MossApp }, { initStudioMossBridge }, { createPluginsRouter }] = await Promise.all([
    load('server/moss/run/app.ts'),
    load('server/moss/moss-agent-bridge.ts'),
    load('server/routes/plugins-routes.ts'),
  ]);
  const express = createRequire(join(studio, 'package.json'))('express');
  const importApp = express();
  importApp.use(express.json());
  importApp.use(createPluginsRouter());
  importer = await new Promise((done) => {
    const listener = importApp.listen(0, '127.0.0.1', () => done(listener));
  });
  const imported = await fetch(`http://127.0.0.1:${importer.address().port}/api/plugins/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: output }),
  });
  assert.equal(imported.status, 200);
  assert.equal((await imported.json()).id, 'rdk-robot-learning-platform@user');
  const { resolveStudioMcpConfigPath, loadStudioMcpTools } = await load(
    'server/moss/run/run-mcp-tools.ts',
  );
  // The Moss Agent consumes the MCP settings separately from the skill importer.
  const configPath = resolveStudioMcpConfigPath();
  assert.ok(
    configPath.startsWith(process.env.RDK_DATA_DIR + '/'),
    'Studio MCP settings must be isolated',
  );
  mkdirSync(process.env.RDK_DATA_DIR, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const discovery = await loadStudioMcpTools({
    ownerKey: 'local:studio-eval',
    networkPolicy: { enabled: true },
  });
  try {
    assert.ok(
      discovery.tools.some(({ name }) => name.endsWith('__rdk_training_status')),
      'Studio could not discover the imported Run tool',
    );
  } finally {
    await discovery.close();
  }
  initStudioMossBridge();
  app = new MossApp(profile, {});
  const sessionId = randomUUID();
  const turns = [];
  for (const message of [first, followup]) {
    const start = requests.length;
    const events = [];
    for await (const event of app.streamChat({
      message,
      sessionId,
      userId: 'studio-eval',
      channel: 'studio',
      uiLocale: 'zh-CN',
      providerConfigEntryId: model.id,
      mossGatewayKey: '',
      abortSignal: AbortSignal.timeout(100_000),
    })) {
      if (
        ['meta', 'tool_start', 'tool_result', 'text', 'done', 'run_complete', 'error'].includes(
          event.type,
        )
      ) {
        events.push(
          event.type === 'meta'
            ? { type: 'meta', data: { sessionId: event.data.sessionId } }
            : event,
        );
      }
    }
    turns.push({ events, requests: requests.slice(start) });
  }
  console.log(
    'STUDIO_EVAL ' +
      JSON.stringify({
        turns,
        base,
        runId,
        sessionId,
        model: model.model,
        scripted: Boolean(scripted),
      }),
  );
} finally {
  app?.destroy();
  await scriptedModel?.close();
  if (importer) await new Promise((resolve) => importer.close(resolve));
  platform.closeAllConnections();
  if (platform.listening) await new Promise((resolve) => platform.close(resolve));
  rmSync(profile, { recursive: true, force: true });
}
// Studio owns long-lived watchers in-process.
process.exit(0);
