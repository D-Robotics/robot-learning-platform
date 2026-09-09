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
const navItems = (
  html.match(/class="nav-item(?: is-active| nav-item-quiet)?"/g) || []
).length;
const duplicateNavs = html.match(/module-nav|module-item/g);

assert.deepEqual(sections, viewNames, 'each workflow view must have a rendered section');
assert.deepEqual(
  [...new Set(targets)].sort(),
  [...viewNames].sort(),
  'navigation targets must resolve to a workflow view',
);
assert.deepEqual(
  workflowTargets,
  [],
  'the horizontal workflow strip must stay removed: one navigation surface only',
);
assert.equal(
  navItems,
  8,
  'sidebar must expose a single workflow navigation: overview, steps 01-06, contract',
);
assert.equal(
  duplicateNavs,
  null,
  'the duplicate “平台模块” secondary navigation must not regress',
);
assert.doesNotMatch(html, /section-kicker/, 'no legacy section kicker labels: keep the workflow surface compact');
assert.doesNotMatch(html, /让一个动作/, 'the marketing hero must stay removed');
assert.match(html, /id="task-select"/, 'workspace must expose an action-task context');
assert.match(html, /id="presentation-toggle"/, 'workspace must expose a reversible presentation view');
assert.match(html, /class="skip-link"/, 'workspace must expose a keyboard skip link');
assert.doesNotMatch(
  html,
  /data-pipeline-step/,
  'the overview vertical pipeline duplicate must stay removed',
);
assert.doesNotMatch(
  html,
  /workspace-brief|safety-banner|brief-title/,
  'the hero brief and standing safety banner must stay removed',
);
assert.match(html, /id="run-detail-dialog"/, 'runs must have a detail surface');
assert.match(html, /id="sim-action-list"/, 'simulation must show the manifest action library');
assert.equal(
  (html.match(/data-record-tab="(?:all|run|deploy|artifact|telemetry)"/g) || []).length,
  5,
  'records must expose all/run/deployment/artifact/telemetry filters',
);
assert.match(app, /function renderNextAction\(\)/);
assert.match(app, /function setPresentationMode\(enabled/);
assert.match(app, /function syncServicePill\(\)/, 'service status dot must follow loading and error state');
assert.match(app, /event\.key === 'Escape'/, 'presentation mode must have a keyboard exit');
assert.match(app, /function renderWorkflowProgress\(\)/);
assert.match(app, /main-content.*aria-busy/, 'loading state must be announced to assistive technology');
assert.match(app, /function openRecordDetails\(record\)/);
assert.match(app, /function renderActionLibrary\(\)/);
assert.match(app, /simulator\.controls/, 'action library must consume the manifest control map');
assert.match(app, /kick-left.*keys: \['Q'\]/, 'MicroDuck template must publish the Q left-kick binding');
assert.match(app, /kick-right.*keys: \['E'\]/, 'MicroDuck template must publish the E right-kick binding');
assert.doesNotMatch(
  app,
  /keys: \['ArrowUp', 'ArrowDown', 'A', 'E', 'Space'\]/,
  'the old A/E/Space mapping must not regress into the public template',
);
assert.match(app, /function renderTelemetryEvidence\(\)/);
assert.match(app, /function parseTelemetryText\(text\)/);
assert.match(app, /function safeLaunchUrl\(value\)/, 'browser launch targets must be validated');
assert.match(app, /const launchUrl = safeLaunchUrl\(run\.launchUrl\)/, 'external simulator URLs must open safely');
assert.match(app, /configuredBrowserEntry = safeLaunchUrl\(simulator\.browser\?\.entryUrl/, 'configured simulator entry must drive the iframe');
assert.match(html, /id="microduck-entry-link"/);
assert.match(html, /id="microduck-footer-link"/);
assert.match(app, /microduck-entry-link/);
assert.match(
  html,
  /id="telemetry-publish-button"/,
  'telemetry evidence must have an explicit publish action',
);
assert.match(
  html,
  /id="telemetry-demo-button"/,
  'MicroDuck presentation must expose a one-click synthetic evidence fixture',
);
assert.match(html, /id="eval-run-quality"/, 'evaluation must expose a provenance badge');
assert.match(html, /id="status-board-icon"/, 'board readiness must have a stateful status icon');
assert.match(
  html,
  /id="evaluation-next-button"[\s\S]*disabled/,
  'evaluation CTA must wait for initial service state',
);
assert.match(
  app,
  /if \(!state\.overview \|\| state\.authRequired \|\| state\.serviceError\)/,
  'evaluation CTA must stay disabled while the workspace is loading or gated',
);
assert.match(app, /function publishTelemetry\(\)/, 'telemetry publish flow must be wired');
assert.match(app, /microduck-telemetry-sample\.jsonl/, 'synthetic evidence path must stay explicit');
assert.match(app, /function isSyntheticEvidence\(evidence, run\)/, 'synthetic provenance must survive persisted replay state');
assert.match(app, /function hasRealEvaluation\(evidence, run\)/, 'persisted real evaluation must survive a page refresh');
assert.match(
  app,
  /function hasReleaseGradeEvidence\(evidence, run\)/,
  'release decisions must use a dedicated evidence predicate',
);
assert.match(
  app,
  /replay\?\.attested === true/,
  'only explicitly attested replay may satisfy the release evidence gate',
);
assert.match(
  app,
  /来源未验证/,
  'ordinary replay/source declarations must be visibly marked as unverified',
);
assert.match(
  app,
  /hasReleaseGradeEvidence\(evidence, latest\)/,
  'release gate and workflow CTAs must consume release-grade evidence',
);
assert.match(app, /function formatTelemetryRate\(value\)/, 'telemetry rates must be presentation-safe');
assert.match(
  app,
  /已评测 · 摘要已保存/,
  'a refreshed page must show the persisted replay summary instead of an empty telemetry card',
);
assert.match(
  app,
  /原始 JSONL 未载入/,
  'a restored replay summary must disclose that raw telemetry is not in browser memory',
);
assert.match(app, /telemetry:replay:/, 'saved replay summaries must remain discoverable in audit records');
assert.match(app, /const telemetrySource = acceptedSources\.has\(evidence\.source\)/, 'fixture uploads must retain provenance');
assert.match(app, /Mock 协议演示 · 非真实 RL/, 'mock metrics must be visibly labelled');
assert.match(app, /已载入遥测证据/, 'a real local import must not be labelled as synthetic evidence');
assert.match(app, /const performanceMetrics = demoEvidence \|\| mockRun \? \{\} : metrics/, 'mock performance values must stay out of real metric cards');
assert.match(app, /Mock 不可部署/, 'mock runs must stay blocked at the deployment gate');
assert.match(app, /协议演示完成，继续查看安全闸门/, 'mock completion must route to the safety gate');
assert.match(app, /pipeline-step.*is-demo|is-demo/, 'mock workflow state must have a dedicated visual state');
assert.match(app, /const realPercent =\s*latest && releaseGradeEvidence/, 'unverified metrics must not appear as real-device results');
assert.match(app, /new URLSearchParams\(window\.location\.search\)/, 'demo query must stabilize first-run preferences');
assert.match(app, /headers: \{ 'Idempotency-Key': requestKey \}/, 'deployment plans must be idempotent');
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
assert.doesNotMatch(
  app,
  /classList\.contains\('workflow-node'\)/,
  'workflow strip classes must not linger in view switching',
);
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
assert.match(
  app,
  /const robogoLoginRequired = robogo\.state === 'login_required'/,
  'RoboGo login gating must distinguish missing login from a degraded read-only probe',
);
assert.match(
  app,
  /if \(loginRequired\)[\s\S]*?runModel\('robogo'\)/,
  'a degraded RoboGo probe must defer authorization to the server-side launch gate',
);
assert.doesNotMatch(
  app,
  /'robogo-run-button',[\s\S]*?robogo\.available(?!\w)/,
  'RoboGo action label must not read a missing integrations.robogo.available field',
);
assert.match(html, /id="telemetry-visuals"/, 'telemetry panel must expose the visuals container');
assert.match(html, /id="telemetry-reward-canvas"/, 'telemetry panel must expose a reward timeline canvas');
assert.match(html, /id="telemetry-obs-heatmap"/, 'telemetry panel must expose an observation heatmap');
assert.match(html, /id="telemetry-action-heatmap"/, 'telemetry panel must expose an action heatmap');
assert.match(app, /function renderTelemetryVisuals\(\)/, 'telemetry visuals must have a renderer');
assert.match(
  app,
  /const samples = Array\.isArray\(evidence\?\.samples\) \? evidence\.samples : null/,
  'telemetry visuals must be driven only by locally imported raw samples',
);
assert.match(
  app,
  /visuals\.hidden = true;\s*\n\s*return;/,
  'a persisted replay summary without raw samples must not draw fabricated charts',
);
assert.match(app, /function drawTelemetryRewardTimeline\(samples\)/, 'reward timeline must be a dedicated drawing step');
assert.match(app, /function telemetryDivergingColor\(value\)/, 'heatmaps must use a fixed diverging color scale');
assert.match(app, /function renderRunMetricCards\(record\)/, 'run detail must render readable metric cards');
assert.match(
  app,
  /const known = new Set\(RUN_METRIC_CARDS\.map\(\(\[key\]\) => key\)\)/,
  'unknown metric fields must stay visible in the raw JSON block instead of disappearing',
);
assert.match(app, /'<div class="run-metric-card/, 'run metric cards must have a styled surface');

// ---- host station (上位机) ----
assert.match(html, /data-view-section="station"/, 'host station must be a rendered workflow view');
assert.match(html, /id="station-metric-grid"/, 'station must expose a live status metric grid');
assert.match(html, /id="station-camera-img"/, 'station must expose a camera <img> surface');
assert.match(html, /id="station-command-grid"/, 'station must expose the read-only command panel');
assert.match(html, /id="station-log-list"/, 'station must expose a streaming log surface');
assert.match(html, /id="station-honesty-note"/, 'station must surface the mock/reference honesty note');
assert.match(app, /function stationInit\(\)/, 'station must have a lazy initializer');
assert.match(
  app,
  /apiPath\('\/sim2real\/board-station\/status\/stream'\)/,
  'station status stream must go through the authenticated proxy, never the agent directly',
);
assert.match(
  app,
  /apiPath\('\/sim2real\/board-station\/camera\.mjpeg'\)/,
  'station camera stream must go through the authenticated proxy',
);
assert.match(app, /function stationRunCommand\(id\)/, 'station commands must be dispatched through the proxy');
assert.match(
  app,
  /stationSetCamera\(false\);/,
  'station teardown must close the camera stream on pagehide',
);
assert.doesNotMatch(
  app,
  /:19100/,
  'the browser must never hardcode the board agent port',
);

console.log(
  `[sim2real-ui] PASS — ${viewNames.length} views, ${navItems} sidebar entries, single workflow navigation`,
);
