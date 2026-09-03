import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(here, 'public', 'app.js'), 'utf8');

const viewNames = [...app.matchAll(/WORKFLOW_VIEWS\s*=\s*\[([^\]]+)\]/g)][0][1]
  .match(/['"][^'"]+['"]/g)
  .map((value) => value.slice(1, -1));
const sections = [...html.matchAll(/data-view-section="([^"]+)"/g)].map((match) => match[1]);
const targets = [...html.matchAll(/data-view-target="([^"]+)"/g)].map((match) => match[1]);
const workflowTargets = [
  ...html.matchAll(/class="workflow-node"[^>]*data-view-target="([^"]+)"/g),
].map((match) => match[1]);
const moduleCards = (html.match(/class="module-card(?: module-card-highlight)?"/g) || []).length;
const moduleItems = (html.match(/class="module-item"/g) || []).length;

assert.deepEqual(sections, viewNames, 'each workflow view must have a rendered section');
assert.deepEqual(
  [...new Set(targets)].sort(),
  [...viewNames].sort(),
  'navigation targets must resolve to a workflow view',
);
assert.deepEqual(workflowTargets, ['simulate', 'train', 'evaluate', 'deploy']);
assert.equal(moduleCards, 6, 'overview must expose six independent platform modules');
assert.equal(moduleItems, 6, 'sidebar must expose six platform module shortcuts');
assert.match(html, /一条任务流，六个独立模块/);
assert.match(html, /id="task-select"/, 'workspace must expose an action-task context');
assert.match(html, /id="run-detail-dialog"/, 'runs must have a detail surface');
assert.match(html, /id="sim-action-list"/, 'simulation must show the manifest action library');
assert.equal(
  (html.match(/data-record-tab="(?:all|run|deploy|artifact|telemetry)"/g) || []).length,
  5,
  'records must expose all/run/deployment/artifact/telemetry filters',
);
assert.match(app, /function renderNextAction\(\)/);
assert.match(app, /function openRecordDetails\(record\)/);
assert.match(app, /function renderActionLibrary\(\)/);
assert.match(app, /function renderTelemetryEvidence\(\)/);
assert.match(app, /function parseTelemetryText\(text\)/);
assert.match(
  html,
  /id="telemetry-publish-button"/,
  'telemetry evidence must have an explicit publish action',
);
assert.match(app, /function publishTelemetry\(\)/, 'telemetry publish flow must be wired');
assert.match(
  app,
  /sim2real\/runs\/.*telemetry/,
  'telemetry publish flow must call the run-scoped ingest endpoint',
);
assert.match(app, /function refreshActiveRuns\(\)/, 'active runs must refresh from their runner');
assert.match(app, /sim2real\/runs\/.*encodeURIComponent\(run\.id\)/, 'run status must be polled');
assert.match(app, /dataset\.action === 'import-telemetry'/);
assert.match(app, /data-release-step/);
assert.match(app, /sim2real\/overview\?productId=/, 'overview must be product-aware');
assert.match(app, /taskId: state\.taskId/);
assert.match(app, /classList\.contains\('workflow-node'\)/);
assert.match(
  app,
  /const robogoRunnerAvailable = simulator\.robogo\?\.available === true/,
  'RoboGo action label must read runner availability from simulator integration',
);
assert.match(
  app,
  /const robogoAccountReady = robogo\.state === 'ready'/,
  'RoboGo action label must include account readiness',
);
assert.doesNotMatch(
  app,
  /'robogo-run-button',[\s\S]*?robogo\.available(?!\w)/,
  'RoboGo action label must not read a missing integrations.robogo.available field',
);

console.log(
  `[sim2real-ui] PASS — ${viewNames.length} views, ${moduleCards} overview modules, ${workflowTargets.length} workflow nodes`,
);
