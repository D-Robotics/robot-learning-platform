import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(here, 'public', 'app.js'), 'utf8');
const onboarding = fs.readFileSync(path.join(here, 'public', 'onboarding.js'), 'utf8');
const agentChat = fs.readFileSync(path.join(here, 'public', 'agent-chat.js'), 'utf8');
const cssIa = fs.readFileSync(path.join(here, 'public', 'refactor-ia.css'), 'utf8');

// ---- telemetry core wiring ----
// Pure telemetry logic lives in public/telemetry-core.js so vitest can
// execute it as a script and assert BEHAVIOR (telemetry-core.test.ts). This
// spec additionally guards the wiring: load order and the delegation seams.
const telemetryCore = fs.readFileSync(path.join(here, 'public', 'telemetry-core.js'), 'utf8');
const coreTag = html.indexOf('telemetry-core.js');
const appTag = html.indexOf('./app.js');
assert.ok(coreTag >= 0, 'index.html must load telemetry-core.js');
assert.ok(
  appTag < 0 || coreTag < appTag,
  'telemetry-core.js must load BEFORE app.js: app.js boots synchronously and its delegations resolve SimTelemetryCore at call time',
);
assert.match(telemetryCore, /root\.SimTelemetryCore = api/, 'telemetry-core.js must publish globalThis.SimTelemetryCore');
assert.doesNotMatch(telemetryCore, /document\.|window\.location/, 'telemetry-core.js must stay DOM-free');
assert.match(app, /SimTelemetryCore\.parseTelemetryText\(text\)/, 'app.js must delegate parseTelemetryText');
assert.match(app, /SimTelemetryCore\.stationTelemetrySnapshot\(status\)/, 'app.js must delegate stationTelemetrySnapshot');
assert.match(app, /SimTelemetryCore\.stationPowerView\(status\)/, 'app.js must read the station power surface from one view');
assert.match(app, /SimTelemetryCore\.simulatorStatusLabels\(profile, browserAvailable\)/, 'app.js must delegate simulator labels');
assert.match(app, /SimTelemetryCore\.stationImuQuaternion\(originbot\)/, 'app.js must delegate IMU quaternion parsing');

// ---- IA: one navigation surface, grouped like RDK Studio ----
// Core (overview + agent) / 流程 (01–04 real workflow) / 数据与工具 (records,
// station). Contract is no longer a first-class view; it is a fold on train.
const viewNames = [...app.matchAll(/WORKFLOW_VIEWS\s*=\s*\[([^\]]+)\]/g)][0][1]
  .match(/['"][^'"]+['"]/g)
  .map((value) => value.slice(1, -1));
const sections = [...html.matchAll(/data-view-section="([^"]+)"/g)].map((match) => match[1]);
const targets = [...html.matchAll(/data-view-target="([^"]+)"/g)].map((match) => match[1]);

assert.deepEqual(
  viewNames,
  ['overview', 'simulate', 'train', 'evaluate', 'deploy', 'records', 'station'],
  'workflow views: contract folded into train; steps stay a real sequence',
);
assert.deepEqual(sections, viewNames, 'each workflow view must have a rendered section');
assert.deepEqual(
  [...new Set(targets)].sort(),
  [...viewNames].sort(),
  'navigation targets must resolve to a workflow view',
);

const navItems = [...html.matchAll(/class="nav-item(?:\s[^"]*)?"/g)].length;
assert.equal(navItems, 8, 'sidebar nav: overview + agent + steps 01-04 + records + station');
const navLabels = [...html.matchAll(/class="nav-item(?:\s[^"]*)?"[\s\S]*?<strong>([^<]+)<\/strong>/g)]
  .map((m) => m[1]);
assert.deepEqual(
  navLabels,
  ['工作台总览', 'Agent 对话', '仿真与录制', '训练与模型', '评测与效果', '部署与上线', '记录与版本', '设备上位机'],
  'sidebar nav labels must match the three-group IA',
);
const navGroups = [...html.matchAll(/class="nav-label">([^<]+)<\/div>/g)].map((m) => m[1]);
assert.deepEqual(navGroups, ['核心', '流程', '数据与工具'], 'sidebar must group nav like RDK Studio: core / flow / data & tools');

const html2 = html; // keep later assertions reading the same document
assert.match(html, /overview-density\.css/, 'overview typography/density layer must be loaded');

// Typography scale is locked at four steps; any new overview text size must
// map onto 11/13/15/24 instead of reintroducing a fifth step.
const densityCss = fs.readFileSync(path.join(here, 'public', 'overview-density.css'), 'utf8');
assert.doesNotMatch(
  densityCss,
  /font-size:\s*(?:9|10|12|14|16|17|18)px/,
  'overview density layer must only speak the 11/13/15/24 scale',
);
assert.match(
  densityCss,
  /\.overview-environment \.status-grid \{\s*display: flex/,
  'environment status cards collapse into one inline strip',
);
assert.match(densityCss, /\.status-card p \{[^}]*white-space: nowrap/, 'inline status detail must ellipsize instead of wrapping');

// ---- IA: topbar collapsed to guide + one menu ----
assert.match(html, /id="top-menu-button"/, 'topbar must collapse settings into one menu');
assert.match(html, /id="top-menu-list"/, 'topbar menu must have a list surface');
assert.match(app, /function wireTopMenu\(\)/, 'topbar menu must be wired');
assert.doesNotMatch(
  html,
  /presentation-toggle[\s\S]{0,80}refresh-button[\s\S]{0,80}notify-toggle[\s\S]{0,500}RDK Studio/,
  'presentation/notify/refresh/Studio must not sit as four always-on topbar buttons',
);
assert.match(html, /id="onboarding-help-button"/, 'onboarding help stays a top-level affordance');
assert.match(app, /function setPresentationMode\(enabled/, 'presentation mode logic must survive the menu move');

// ---- IA: context strip is read-only, selectors live on their pages ----
const stripHtml = html.slice(
  html.indexOf('class="context-strip"'),
  html.indexOf('</section>', html.indexOf('class="context-strip"')),
);
assert.doesNotMatch(stripHtml, /<select/, 'context strip must be read-only: no global selectors');
assert.match(stripHtml, /id="context-live-model"/, 'context strip keeps the live model status chip');
assert.match(stripHtml, /id="context-live-device"/, 'context strip keeps the live device status chip');
assert.match(stripHtml, /id="status-storage"/, 'context strip keeps the ledger health chip');

assert.match(html, /sidebar-project[\s\S]{0,400}id="product-select"/, 'product selector lives in the sidebar project card');
assert.match(html, /id="task-select"/, 'task selector must exist');
assert.match(html, /guide-panel[\s\S]{0,2000}id="task-select"/, 'task selector lives on the simulate page');
assert.match(html, /model-panel[\s\S]{0,2000}id="model-select"/, 'model selector lives on the train page');
assert.match(html, /board-panel[\s\S]{0,2000}id="device-select"/, 'device selector lives on the deploy page');

// ---- IA: contract registration folded into train ----
assert.match(html, /id="contract-fold"/, 'train page must expose the contract fold');
assert.match(html, /id="manifest-editor"/, 'manifest editor stays reachable inside the fold');
assert.match(html, /id="contract-run-button"/, 'train page keeps the contract validation action');
assert.match(
  app,
  /querySelector\('\.next-card'\)\)\?\.after\(panel\)/,
  'agent suggestion panel anchors after the project workspace',
);

// ---- IA: agent entry points converge on one drawer ----
assert.match(html, /data-agent-open/, 'sidebar Agent entry must use the shared drawer opener');
assert.match(app, /window\.setAgentDrawerOpen === 'function'/, 'app.js must delegate agent opening to agent-chat.js');
assert.match(agentChat, /window\.setAgentDrawerOpen = /, 'agent-chat.js must publish setAgentDrawerOpen');
assert.match(agentChat, /agent-prompt-chip/, 'agent composer must expose example prompts');
assert.match(agentChat, /form\.requestSubmit\(\)/, 'prompt chips must submit the task in one click, not just fill the input');
assert.match(agentChat, /agent-task-card/, 'agent chat must render a conversation-native task card');
assert.match(agentChat, /setAttribute\('role', 'progressbar'\)/, 'task card must expose an accessible progress bar');
assert.match(agentChat, /updateTaskCard/, 'task card must update in place while polling the run');
assert.match(agentChat, /agent-event-more/, 'event log must collapse history behind an expand control');
assert.match(agentChat, /正在执行：/, 'runtime status must surface the live step label');
assert.match(cssIa, /\.agent-task-card/, 'task card styles must exist in refactor-ia.css');
assert.match(cssIa, /\.agent-task-progress/, 'task card progress bar styles must exist');
assert.match(html, /id="agent-floating-toggle"/, 'Agent stays available from a compact floating launcher');
assert.match(html, /id="agent-chat-close"/, 'Agent drawer must expose an explicit close action');
assert.match(html, /id="agent-chat-backdrop"/, 'Agent drawer must expose a dismissible backdrop');

// ---- onboarding ----
assert.match(html, /onboarding\.js/, 'workspace must load the guided onboarding layer');
assert.match(onboarding, /const steps = \[/, 'onboarding must define guided steps');
assert.match(onboarding, /最佳实践/, 'onboarding must include practical guidance');
assert.match(onboarding, /localStorage/, 'onboarding completion must persist locally');
assert.match(onboarding, /在左侧项目卡里切换产品线/, 'onboarding step 01 must point at the sidebar product card');
assert.match(onboarding, /view: 'simulate', kicker: '02/, 'onboarding step 02 must open the simulate page for the task selector');
assert.match(onboarding, /view: 'train', kicker: '03/, 'onboarding step 03 must open the train page for the model selector');
assert.match(onboarding, /view: 'deploy', kicker: '04/, 'onboarding step 04 must open the deploy page for the device selector');

// ---- a11y baseline ----
assert.match(html, /class="skip-link"/, 'workspace must expose a keyboard skip link');
assert.match(app, /main-content.*aria-busy/, 'loading state must be announced to assistive technology');
assert.match(app, /event\.key === 'Escape'/, 'menus and modes must have a keyboard exit');

// ---- preserved behavior anchors (unchanged by the IA refactor) ----
assert.match(html, /id="task-select"/, 'workspace must expose an action-task context');
assert.match(html, /id="presentation-toggle"/, 'workspace must expose a reversible presentation view');
assert.doesNotMatch(html, /section-kicker/, 'no legacy section kicker labels: keep the workflow surface compact');
assert.doesNotMatch(html, /让一个动作/, 'the marketing hero must stay removed');
assert.doesNotMatch(html, /data-pipeline-step/, 'the overview vertical pipeline duplicate must stay removed');
assert.doesNotMatch(
  html,
  /workspace-brief|safety-banner|brief-title/,
  'the hero brief and standing safety banner must stay removed',
);
assert.doesNotMatch(
  html,
  /workspace-command-bar|workspace-quick-panel|agent-entry-card/,
  'the overview duplicate command bar (context/quick-actions/agent card) must stay removed',
);
assert.match(html, /id="run-detail-dialog"/, 'runs must have a detail surface');
assert.match(html, /id="sim-action-list"/, 'simulation must show the manifest action library');
assert.equal(
  (html.match(/data-record-tab="(?:all|run|deploy|artifact|telemetry)"/g) || []).length,
  5,
  'records must expose all/run/deployment/artifact/telemetry filters',
);
assert.match(app, /function renderNextAction\(\)/);
assert.match(app, /function syncServicePill\(\)/, 'service status dot must follow loading and error state');
assert.match(app, /function renderWorkflowProgress\(\)/);
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
  `[sim2real-ui] PASS — ${viewNames.length} views, ${navItems} sidebar entries, grouped IA (core / flow / tools), read-only context strip`,
);
