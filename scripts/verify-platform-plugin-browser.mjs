#!/usr/bin/env node
/* global window, document */

/** Real MuJoCo/ONNX browser recording, platform ingestion, and plugin evidence reads. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  environment,
  freePort,
  service,
  terminate,
  http,
  waitReady,
  mcpClient,
  scrubEvidence,
  parseJourneyArguments,
} from './verify-platform-plugin-journey.mjs';
import {
  startDemonstrationWorker,
  verifyBrowserBcTraining,
  resetSimulatorEpisode,
} from './lib/browser-bc-acceptance.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = path.join(repositoryRoot, 'plugins/rdk-robot-learning-platform');

async function loadBrowser() {
  for (const id of [process.env.RDK_PLAYWRIGHT_MODULE, 'playwright', 'playwright-core'].filter(
    Boolean,
  )) {
    try {
      const module = await import(id);
      const result = module.chromium ? module : module.default;
      if (result?.chromium) return result;
    } catch {
      /* Try the next declared dependency. */
    }
  }
  const error = new Error(
    'Playwright is required; set RDK_PLAYWRIGHT_MODULE or install it. Browser validation was not run.',
  );
  error.code = 'MISSING_BROWSER';
  throw error;
}

export async function verifyBrowserJourney({ trainBC = false, defaultOutput } = {}) {
  const { output, help } = parseJourneyArguments(
    process.argv.slice(2),
    defaultOutput ?? path.join(repositoryRoot, 'dist/plugins/platform-plugin-browser.json'),
  );
  if (help) {
    console.log(
      'Usage: npm run verify:plugin:browser -- [--output FILE]\nRuns actual browser MuJoCo/ONNX simulation, six recorder episodes, workbench upload and platform evidence reads using isolated temporary storage. Requires RDK_PLUGIN_JOURNEY_MICRODUCK_ROOT plus Playwright/Chromium; use RDK_PLAYWRIGHT_MODULE and RDK_CHROMIUM_PATH for explicit installations. Missing dependencies exit 2; no synthetic fallback or motor actions. --help starts no browser/services and writes no evidence.',
    );
    return;
  }
  await fs.mkdir(path.dirname(output), { recursive: true });
  const evidenceDirectory = await fs.mkdtemp(path.join(path.dirname(output), 'browser-evidence-'));
  const started = Date.now();
  const report = {
    schemaVersion: 1,
    journey: 'platform-plugin-real-browser-v1',
    startedAt: new Date().toISOString(),
    status: 'running',
    exitCode: 1,
    evidenceDirectory: path.basename(evidenceDirectory),
    scope: {
      simulation: 'Real browser MuJoCo WASM physics and ONNX reference policy',
      recording:
        'Actual 61D observations and 14D actions from the recorder, not a generated test fixture',
      evidence:
        'Browser simulation/import, review-only; no real board attestation or actuator operation',
    },
    cases: [],
  };
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-plugin-browser-'));
  const children = [];
  let browser;
  let failure;
  const step = async (id, transport, execute) => {
    const since = Date.now();
    try {
      const evidence = await execute();
      report.cases.push({
        id,
        status: 'passed',
        exitCode: 0,
        durationMs: Date.now() - since,
        transport,
        evidence: scrubEvidence(evidence),
      });
      console.log(`[plugin-browser] ${id} passed (${Date.now() - since}ms)`);
      return evidence;
    } catch (error) {
      report.cases.push({
        id,
        status: ['MISSING_BROWSER', 'MISSING_ASSETS', 'MISSING_PYTHON'].includes(error.code)
          ? 'blocked'
          : 'failed',
        exitCode: ['MISSING_BROWSER', 'MISSING_ASSETS', 'MISSING_PYTHON'].includes(error.code)
          ? 2
          : 1,
        durationMs: Date.now() - since,
        transport,
        error: scrubEvidence(error.message),
      });
      throw error;
    }
  };
  try {
    if (trainBC) {
      report.implementationDigests = Object.fromEntries(
        await Promise.all(
          [
            'engines/offline-bc/train_bc.py',
            'server/sim2real/demonstrations.ts',
            'server/routes/sim2real-routes.ts',
            'server/sim2real/robogo-runner.ts',
            'server/sim2real/sim2real-store.ts',
            'shared/sim2real.ts',
            'server/agent-runtime/dsh-capability-handlers.ts',
            'services/duck-lab-mcp/server.ts',
            'services/sim2real-web/public/app.js',
            'services/sim2real-web/public/index.html',
            'services/mujoco-web/microduck-community-overlay.js',
            'scripts/lib/browser-bc-acceptance.mjs',
            'scripts/verify-platform-plugin-browser.mjs',
          ].map(async (name) => [
            name,
            createHash('sha256')
              .update(await fs.readFile(path.join(repositoryRoot, name)))
              .digest('hex'),
          ]),
        ),
      );
    }
    const prerequisites = await step('B00.browser-and-assets', 'dependency checks', async () => {
      const assets = process.env.RDK_PLUGIN_JOURNEY_MICRODUCK_ROOT;
      if (!assets || !(await fs.stat(assets).catch(() => null))?.isDirectory()) {
        const error = new Error(
          'Mounted MicroDuck assets are required via RDK_PLUGIN_JOURNEY_MICRODUCK_ROOT; no synthetic browser fallback was run.',
        );
        error.code = 'MISSING_ASSETS';
        throw error;
      }
      const index = await fs.readFile(path.join(assets, 'index.html'), 'utf8').catch(() => '');
      const overlayReady =
        index.includes('microduck-community-overlay.js') &&
        (
          await fs.stat(path.join(assets, 'microduck-community-overlay.js')).catch(() => null)
        )?.isFile() &&
        (
          await fs.stat(path.join(assets, 'community/microduck-wechat.png')).catch(() => null)
        )?.isFile();
      if (!overlayReady) {
        const error = new Error(
          'The mounted simulator is missing the Studio recording overlay. Run services/mujoco-web/install-microduck-overlay.py with MICRODUCK_STATIC_ROOT pointing to a copy of the simulator release.',
        );
        error.code = 'MISSING_ASSETS';
        throw error;
      }
      const playwright = await loadBrowser();
      try {
        browser = await playwright.chromium.launch({
          headless: true,
          ...(process.env.RDK_CHROMIUM_PATH
            ? { executablePath: process.env.RDK_CHROMIUM_PATH }
            : {}),
          args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
        });
      } catch {
        const error = new Error(
          'Chromium could not launch; set RDK_CHROMIUM_PATH or install a supported browser.',
        );
        error.code = 'MISSING_BROWSER';
        throw error;
      }
      return { assets, browserVersion: browser.version() };
    });
    report.browserVersion = prerequisites.browserVersion;
    const storage = path.join(scratch, 'ledger');
    await fs.mkdir(storage, { mode: 0o700 });
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const learning = trainBC
      ? await startDemonstrationWorker({ repositoryRoot, scratch, children })
      : null;
    const web = service(
      'isolated-browser-platform',
      process.execPath,
      ['--import', 'tsx/esm', path.join(repositoryRoot, 'services/sim2real-web/server.ts')],
      environment({
        RDK_SIM2REAL_BIND_HOST: '127.0.0.1',
        RDK_SIM2REAL_PORT: String(port),
        RDK_SIM2REAL_STORAGE_DIR: storage,
        RDK_SIM2REAL_DEPLOYMENT: 'local',
        RDK_SIM2REAL_SSO_ENABLED: '0',
        RDK_SIM2REAL_SSO_REQUIRED: '0',
        RDK_SIM2REAL_REQUIRE_MICRODUCK: '1',
        RDK_SIM2REAL_MICRODUCK_ROOT: prerequisites.assets,
        RDK_SIM2REAL_STATION_POLICY_ENABLED: '0',
        RDK_SIM2REAL_ALLOW_ACTUATOR_CONTROL: '0',
        ...(learning?.environment ?? {}),
      }),
    );
    children.push(web);
    await step('B01.isolated-platform', 'health + fresh ledger', async () => {
      const health = await waitReady(base, web, (item) => item.ok && item.ready);
      assert.equal(health.ready, true);
      const runs = await http(base, '/api/v1/duck/runs');
      assert.equal(runs.status, 200);
      assert.equal(runs.body.runs.length, 0);
      return { serviceReady: true, freshLedger: true, isolatedPort: true, assetsMounted: true };
    });
    const config = JSON.parse(await fs.readFile(path.join(pluginRoot, 'mcp.json'), 'utf8'))
      .mcpServers['duck-lab'];
    const child = service(
      'raw-browser-plugin',
      config.command,
      config.args,
      environment({
        RDK_ROBOT_LEARNING_PLATFORM_ROOT: repositoryRoot,
        RDK_ROBOT_LEARNING_PLATFORM_NODE: process.execPath,
        RDK_ROBOT_LEARNING_PLATFORM_CONFIG: path.join(scratch, 'no-binding.json'),
        RDK_SIM2REAL_MCP_BASE_URL: base,
      }),
      scratch,
      'pipe',
    );
    children.push(child);
    const mcp = mcpClient(child);
    await mcp.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'platform-plugin-browser-probe', version: '1.0.0' },
    });
    mcp.notify('notifications/initialized');
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      locale: 'zh-CN',
    });
    await context.addInitScript(() => {
      localStorage.clear();
      localStorage.setItem('rdk-duck-lab-onboarding-v1', 'done');
      localStorage.setItem('rdk-duck-lab-product', 'microduck');
    });
    const page = await context.newPage();
    const pageErrors = [];
    const policyRequests = new Set();
    const projectResponses = [];
    const projectTransportFailures = [];
    const qrResponses = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('requestfailed', (request) => {
      if (/\/api\/(?:sim2real|v1\/duck)\/projects$/.test(new URL(request.url()).pathname))
        projectTransportFailures.push({
          route: new URL(request.url()).pathname,
          failure: request.failure()?.errorText ?? 'unknown',
        });
    });
    page.on('response', async (response) => {
      if (response.ok() && /\.(?:wasm|onnx)(?:$|\?)/i.test(response.url()))
        policyRequests.add(path.basename(new URL(response.url()).pathname));
      const route = new URL(response.url()).pathname;
      if (route.endsWith('/community/microduck-wechat.png'))
        qrResponses.push({
          httpStatus: response.status(),
          contentType: response.headers()['content-type'],
        });
      if (/\/api\/(?:sim2real|v1\/duck)\/projects$/.test(route)) {
        const payload = await response.json().catch(() => null);
        projectResponses.push({
          route,
          httpStatus: response.status(),
          projectsArray: Array.isArray(payload?.projects),
          projectCount: Array.isArray(payload?.projects) ? payload.projects.length : null,
        });
      }
    });
    context.on('page', (popup) => {
      if (popup !== page) void popup.close();
    });
    let runId;
    await step(
      'B02.plugin-entry-and-browser-run',
      'MCP simulator_open + real workbench UI',
      async () => {
        const entry = await mcp.call('rdk_simulator_open');
        assert.ok(entry.entryUrl.startsWith('/mujoco/'));
        await page.goto(`${base}/#train`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(
          () => {
            const note = document.getElementById('project-context-note')?.textContent ?? '';
            return !!note && !/加载中|正在连接/.test(note);
          },
          undefined,
          { timeout: 20_000 },
        );
        const projectContextNote = await page.locator('#project-context-note').textContent();
        assert.ok(
          projectResponses.some((item) => item.httpStatus === 200 && item.projectsArray),
          `Project request must settle successfully: ${JSON.stringify({ projectResponses, projectTransportFailures })}`,
        );
        assert.doesNotMatch(
          projectContextNote,
          /暂不可用|错误|失败/,
          `Stable project context must not contradict a successful response: ${JSON.stringify({ projectContextNote, projectResponses, projectTransportFailures })}`,
        );
        if (trainBC) {
          await page.evaluate(() => {
            window.location.hash = 'simulate';
          });
          await page.locator('#simulator-frame').waitFor({ state: 'visible', timeout: 15000 });
          const runs = await http(base, '/api/v1/duck/runs');
          assert.equal(
            runs.body.runs.length,
            0,
            'A new user must be able to record without an existing Run',
          );
          return {
            pluginEntryResolved: true,
            directSimulationBeforeRun: true,
            existingRuns: 0,
            projectContextNote,
          };
        }
        await page.locator('#browser-run-button').waitFor({ state: 'visible', timeout: 20_000 });
        await page.waitForFunction(
          () => !document.getElementById('browser-run-button')?.disabled,
          undefined,
          { timeout: 20_000 },
        );
        const accepted = page.waitForResponse(
          (response) =>
            /\/api\/(?:sim2real|v1\/duck)\/runs(?:$|\?)/.test(response.url()) &&
            response.request().method() === 'POST',
        );
        await page.locator('#browser-run-button').click();
        const response = await accepted;
        assert.equal(response.status(), 201);
        const payload = await response.json();
        assert.equal(payload.run.backend, 'browser');
        runId = payload.run.id;
        assert.ok(runId);
        await page.locator('#simulator-frame').waitFor({ state: 'visible', timeout: 15_000 });
        return {
          runId,
          backend: 'browser',
          pluginEntryResolved: true,
          runRegisteredThroughUI: true,
          registrationIsNotSimulationProof: true,
          projectContextNote,
          projectResponses,
        };
      },
    );
    const frameElement = await page.locator('#simulator-frame').elementHandle();
    const frame = await frameElement.contentFrame();
    assert.ok(frame, 'Workbench must contain the real simulator iframe');
    let initial;
    await step('B03.real-mujoco-physics', 'actual Chromium iframe + MuJoCo state', async () => {
      await page.locator('#simulator-frame').scrollIntoViewIfNeeded();
      await frame
        .getByRole('button', { name: /开始仿真|waddle in/i })
        .first()
        .click({ timeout: 60_000 });
      await frame.waitForFunction(
        () =>
          window.rl?.data &&
          typeof window.rl.buildObs === 'function' &&
          window.rl.lastAction?.length === 14,
        undefined,
        { timeout: 60_000 },
      );
      initial = await frame.evaluate(() => ({
        time: Number(window.rl.data.time),
        qpos: Array.from(window.rl.data.qpos),
        observation: Array.from(window.rl.buildObs()),
        actions: Array.from(window.rl.lastAction),
      }));
      assert.equal(initial.observation.length, 61);
      assert.equal(initial.actions.length, 14);
      assert.ok(Number.isFinite(initial.time));
      await frame.waitForFunction(
        (before) => Number(window.rl?.data?.time) > before + 0.05,
        initial.time,
        { timeout: 20_000 },
      );
      const advanced = await frame.evaluate(() => ({
        time: Number(window.rl.data.time),
        qpos: Array.from(window.rl.data.qpos),
      }));
      const stateDelta = Math.max(
        ...advanced.qpos.map((value, index) => Math.abs(value - initial.qpos[index])),
      );
      assert.ok(stateDelta > 1e-7, 'Physics must change actual qpos, not just a timer label');
      await frame.waitForFunction(
        () => {
          const image = document.querySelector('img.rdk-community-wall-qr');
          return image?.complete === true && image.naturalWidth > 0;
        },
        undefined,
        { timeout: 15_000 },
      );
      const qrImage = await frame.evaluate(() => {
        const image = document.querySelector('img.rdk-community-wall-qr');
        return {
          complete: image.complete,
          naturalWidth: image.naturalWidth,
          naturalHeight: image.naturalHeight,
        };
      });
      assert.ok(
        qrResponses.some((item) => item.httpStatus === 200 && /image\/png/.test(item.contentType)),
        'Community PNG must load from the platform route',
      );
      await fs.mkdir(path.dirname(output), { recursive: true });
      await page.screenshot({
        path: path.join(evidenceDirectory, 'platform-plugin-browser-simulation.png'),
        fullPage: false,
      });
      return {
        observationSize: 61,
        actionSize: 14,
        physicsTimeBefore: initial.time,
        physicsTimeAfter: advanced.time,
        qposMaxDelta: stateDelta,
        physicsAdvances: true,
        qrImage,
        qrResponses,
      };
    });
    const commands = [
      { name: 'stand', twist: [0, 0, 0] },
      { name: 'forward', twist: [0.2, 0, 0] },
      { name: 'turn', twist: [0, 0, 0.5] },
    ];
    const recordEpisode = async (command) => {
      const reset = await frame.evaluate(resetSimulatorEpisode);
      assert.ok(
        reset.resetTimeAfter < reset.resetTimeBefore,
        'Episode requires an observed physics reset',
      );
      await frame.locator('[data-recorder-start]').click();
      let commandEvidence;
      try {
        commandEvidence = await frame.evaluate(async (twist) => {
          const rl = window.rl;
          const getCommand = rl.controller.getCommand;
          try {
            rl.controller.getCommand = () => new Float32Array(twist);
            const deadline = performance.now() + 2000;
            while (twist.some((value, axis) => Math.abs(rl.buildObs()[48 + axis] - value) > 1e-5)) {
              if (performance.now() > deadline)
                throw new Error('Recording command never reached policy input');
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
            const started = Number(rl.data.time);
            const wallStart = performance.now();
            while (Number(rl.data.time) - started < 5.05) {
              if (Number(rl.data.time) < started || performance.now() - wallStart > 25000) {
                throw new Error('Recording reset or failed to advance five physics seconds');
              }
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
            return {
              actualCommand: Array.from(rl.buildObs()).slice(48, 51),
              physicsSeconds: Number(rl.data.time) - started,
            };
          } finally {
            rl.controller.getCommand = getCommand;
          }
        }, command.twist);
      } finally {
        await frame.locator('[data-recorder-stop]').click();
      }
      const text = await frame.evaluate(() => window.__microduckRecorder.getText());
      const [header, ...rows] = text.trim().split('\n').map(JSON.parse);
      assert.equal(header.source, 'browser-microduck');
      assert.equal(header.contractId, 'microduck-policy-v1');
      assert.equal(header.pairing, 'policy-inference-v1');
      assert.equal(header.sampleCount, rows.length);
      assert.ok(rows.length >= 200, 'Five seconds must capture actual policy inferences');
      assert.ok(rows.at(-1).time - rows[0].time >= 5);
      assert.ok(
        rows.every(
          (row) =>
            row.pairing === 'policy-inference-v1' &&
            row.observation.length === 61 &&
            row.action.length === 14 &&
            [...row.observation, ...row.action].every(Number.isFinite),
        ),
      );
      const commandedRows = rows.filter((row) =>
        command.twist.every((value, axis) => Math.abs(row.observation[48 + axis] - value) < 1e-5),
      );
      assert.ok(
        commandedRows.length >= 200,
        'Recorded observations must contain the actual requested command',
      );
      return {
        text,
        header,
        rows,
        evidence: {
          command: command.name,
          desiredCommand: command.twist,
          ...commandEvidence,
          ...reset,
          sampleCount: rows.length,
          commandedRows: commandedRows.length,
          durationSeconds: rows.at(-1).time - rows[0].time,
          sha256: createHash('sha256').update(text).digest('hex'),
        },
      };
    };
    let firstEpisode;
    let reusedRecording;
    await step(
      'B04.real-trajectory-recording',
      'visible recorder controls + public simulator commands',
      async () => {
        if (process.env.RDK_DEMONSTRATION_RECORDING_FILE) {
          const source = path.resolve(process.env.RDK_DEMONSTRATION_RECORDING_FILE);
          const text = await fs.readFile(source, 'utf8');
          const receiptText = await fs.readFile(
            path.join(path.dirname(source), 'demonstration-training.json'),
            'utf8',
          );
          const receipt = JSON.parse(receiptText);
          const coverage = receipt.cases.find((item) => item.id === 'B08.real-command-coverage');
          const uploaded = receipt.cases.find((item) => item.id === 'B05.ui-upload-api-readback');
          const sha256 = createHash('sha256').update(text).digest('hex');
          assert.equal(coverage?.status, 'passed');
          assert.equal(uploaded?.status, 'passed');
          assert.equal(uploaded.evidence.uploadedSha256, sha256);
          assert.equal(coverage.evidence.episodeCount, 6);
          assert.ok(coverage.evidence.physicsSeconds >= 30);
          assert.equal(coverage.evidence.episodes.length, 6);
          for (const [index, episode] of coverage.evidence.episodes.entries()) {
            const command = commands[index % commands.length];
            assert.equal(episode.command, command.name);
            assert.ok(
              episode.inputReleased && episode.physicsSeconds >= 5 && episode.commandedRows >= 200,
            );
            assert.ok(
              command.twist.every(
                (value, axis) => Math.abs(value - episode.actualCommand[axis]) < 1e-5,
              ),
            );
          }
          const [header, ...rows] = text.trim().split('\n').map(JSON.parse);
          assert.equal(header.pairing, 'policy-inference-v1');
          assert.equal(header.source, 'browser-microduck');
          assert.equal(rows.length, coverage.evidence.sampleCount);
          assert.ok(rows.every((row) => row.pairing === 'policy-inference-v1'));
          reusedRecording = {
            text,
            header,
            rows,
            coverage: coverage.evidence,
            sha256,
            receiptSha256: createHash('sha256').update(receiptText).digest('hex'),
          };
          return {
            sourceMode: 'reused-recording',
            originalDataSha256: sha256,
            originalReceiptSha256: reusedRecording.receiptSha256,
            newlyRecordedThisRun: false,
          };
        }
        assert.equal(
          await frame.evaluate(() => typeof window.__microduckRecorder?.getText === 'function'),
          true,
        );
        firstEpisode = await recordEpisode(commands[0]);
        await page.waitForFunction(
          () =>
            /已同步\s*\d+\s*帧/.test(
              document.getElementById('simulator-evidence-status')?.textContent ?? '',
            ),
          undefined,
          { timeout: 10000 },
        );
        await page.screenshot({
          path: path.join(evidenceDirectory, 'platform-plugin-browser-simulation.png'),
          fullPage: false,
        });
        return firstEpisode.evidence;
      },
    );
    let uploadedTrajectory;
    let uploadedRecording;
    await step(
      'B08.real-command-coverage',
      'six reset recorder episodes combined for workbench import',
      async () => {
        const directory = path.join(evidenceDirectory, 'browser-episodes');
        await fs.mkdir(directory, { recursive: true });
        const recordings = reusedRecording ? [] : [firstEpisode];
        if (!reusedRecording)
          for (const command of [...commands.slice(1), ...commands])
            recordings.push(await recordEpisode(command));
        const rows = reusedRecording ? reusedRecording.rows : [];
        let offset = 0;
        for (const [index, episode] of recordings.entries()) {
          await fs.writeFile(
            path.join(directory, `episode-${String(index + 1).padStart(2, '0')}.jsonl`),
            episode.text,
            { flag: 'wx' },
          );
          const start = episode.rows[0].time;
          for (const row of episode.rows) rows.push({ ...row, time: offset + row.time - start });
          offset = rows.at(-1).time + 0.02;
        }
        const header = reusedRecording?.header ?? {
          ...firstEpisode.header,
          sampleCount: rows.length,
          durationSeconds: rows.at(-1).time,
          episodes: 6,
        };
        uploadedTrajectory =
          reusedRecording?.text ??
          [header, ...rows].map((row) => JSON.stringify(row)).join('\n') + '\n';
        uploadedRecording = {
          sampleCount: rows.length,
          sha256: createHash('sha256').update(uploadedTrajectory).digest('hex'),
        };
        await fs.writeFile(
          path.join(evidenceDirectory, 'platform-plugin-browser-trajectory.jsonl'),
          uploadedTrajectory,
          { flag: 'wx' },
        );
        // Use the visible file import path for the combined, preserved real episodes.
        await page.locator('#telemetry-file-input').setInputFiles({
          name: 'microduck-browser-episodes.jsonl',
          mimeType: 'application/x-ndjson',
          buffer: Buffer.from(uploadedTrajectory),
        });
        await page.waitForFunction(
          (count) =>
            document.getElementById('telemetry-summary')?.textContent.includes(`样本数${count}`),
          rows.length,
          { timeout: 10000 },
        );
        return {
          episodeCount: 6,
          allEpisodesIncludedInImport: true,
          noIndependentEpisodeHoldoutClaim: true,
          sampleCount: rows.length,
          sourceMode: reusedRecording ? 'reused-recording' : 'new-recording',
          originalReceiptSha256: reusedRecording?.receiptSha256,
          physicsSeconds:
            reusedRecording?.coverage.physicsSeconds ??
            recordings.reduce((sum, episode) => sum + episode.evidence.physicsSeconds, 0),
          episodes:
            reusedRecording?.coverage.episodes ??
            recordings.map((episode, index) => ({
              episode: index + 1,
              ...episode.evidence,
            })),
          synthetic: false,
        };
      },
    );
    await step(
      'B05.ui-upload-api-readback',
      'workbench upload UI + versioned ledger API',
      async () => {
        await page.evaluate(() => {
          window.location.hash = 'evaluate';
        });
        const inspector = page.locator('.telemetry-panel');
        if (!(await inspector.evaluate((panel) => panel.open))) {
          await inspector.locator('summary').click();
        }
        await page
          .locator('#telemetry-publish-button')
          .waitFor({ state: 'visible', timeout: 10_000 });
        await page.waitForFunction(
          () => !document.getElementById('telemetry-publish-button')?.disabled,
          undefined,
          { timeout: 10_000 },
        );
        const evaluated = page.waitForResponse(
          (response) =>
            /\/runs\/[^/]+\/evaluate$/.test(new URL(response.url()).pathname) &&
            response.request().method() === 'POST',
        );
        await page.locator('#telemetry-publish-button').click();
        const response = await evaluated;
        assert.equal(response.status(), 200);
        runId = decodeURIComponent(new URL(response.url()).pathname.split('/').at(-2));
        const telemetry = await http(base, `/api/v1/duck/runs/${runId}/telemetry`);
        assert.equal(telemetry.status, 200);
        const samples = telemetry.body.telemetry.flatMap((chunk) => chunk.samples);
        assert.equal(samples.length, uploadedRecording.sampleCount);
        const recorded = uploadedTrajectory.trim().split('\n').slice(1).map(JSON.parse);
        assert.ok(
          samples.every((sample) => sample.pairing === 'policy-inference-v1'),
          'The ledger must retain pairing for every recorded sample',
        );
        assert.deepEqual(samples[0].observation, recorded[0].observation);
        assert.deepEqual(samples.at(-1).action, recorded.at(-1).action);
        assert.ok(
          telemetry.body.telemetry.every(
            (chunk) => chunk.source === 'browser' && chunk.attested !== true,
          ),
          'Imported simulator episodes must retain browser provenance without attestation',
        );
        return {
          runId,
          savedSampleCount: samples.length,
          uploadedEpisode: uploadedRecording.episode,
          uploadedSha256: uploadedRecording.sha256,
          recordedVectorsMatchLedger: true,
          source: 'browser',
          attested: false,
          inferencePairingPersisted: true,
          ...(trainBC ? { savedWithoutPreExistingRun: true } : {}),
        };
      },
    );
    await step(
      'B06.plugin-replay-and-evaluation',
      'raw plugin MCP reads/evaluation/lineage',
      async () => {
        const telemetry = await mcp.call('rdk_telemetry_list', { runId });
        assert.ok(telemetry.count > 0);
        assert.equal(
          telemetry.telemetry.reduce((sum, chunk) => sum + chunk.sampleCount, 0),
          uploadedRecording.sampleCount,
        );
        assert.ok(telemetry.telemetry.every((chunk) => chunk.attested === false));
        const replay = await mcp.call('rdk_runs_replay', { runId });
        assert.equal(replay.frameCount, uploadedRecording.sampleCount);
        const evaluation = await mcp.call('rdk_evaluation_summarize', { runId });
        assert.equal(evaluation.replay.sampleCount, uploadedRecording.sampleCount);
        const sessions = await mcp.call('rdk_board_sessions', { runId });
        assert.equal(sessions.count, 0);
        const lineage = await mcp.call('rdk_lineage_get', { runId });
        assert.ok(JSON.stringify(lineage.lineage).includes(runId));
        return {
          pluginCanReadActualRecording: true,
          replayFrameCount: replay.frameCount,
          evaluationSampleCount: evaluation.replay.sampleCount,
          boardSessions: 0,
          attested: false,
          releaseGradeRealBoardEvidence: false,
        };
      },
    );
    await step(
      'B07.browser-runtime-integrity',
      'real browser resources + runtime errors',
      async () => {
        const projectContextNote = await page.locator('#project-context-note').textContent();
        assert.doesNotMatch(
          projectContextNote,
          /暂不可用|错误|失败|加载中/,
          `Settled workspace context must stay available after background refresh: ${JSON.stringify({ projectContextNote, projectResponses, projectTransportFailures })}`,
        );
        assert.equal(
          projectTransportFailures.length,
          0,
          `Project transport failures: ${JSON.stringify(projectTransportFailures)}`,
        );
        assert.ok(
          projectResponses.every((item) => item.httpStatus === 200 && item.projectsArray),
          `Project API failures: ${JSON.stringify(projectResponses)}`,
        );
        assert.equal(
          pageErrors.length,
          0,
          `Browser execution errors: ${JSON.stringify(pageErrors)}`,
        );
        assert.ok(
          [...policyRequests].some((name) => name.endsWith('.wasm')),
          'Browser must load actual MuJoCo/ONNX WASM resources',
        );
        assert.ok(
          [...policyRequests].some((name) => name.endsWith('.onnx')),
          'Browser must load actual reference ONNX policies',
        );
        return {
          wasmResources: [...policyRequests].filter((name) => name.endsWith('.wasm')).length,
          onnxResources: [...policyRequests].filter((name) => name.endsWith('.onnx')).length,
          pageErrors: 0,
          realPhysicsAndPolicyResourcesLoaded: true,
          projectContextNote,
          projectResponses,
          projectTransportFailures,
        };
      },
    );
    if (trainBC) {
      report.independentQuality = await verifyBrowserBcTraining({
        page,
        base,
        mcp,
        sourceRunId: runId,
        uploadedTrajectory,
        workerData: learning.workerData,
        workerPython: learning.python,
        step,
        output: path.join(evidenceDirectory, path.basename(output)),
      });
      report.scope.training =
        'Actual recorded vectors through workbench BC and tuned MCP run; retained ONNX and fresh reference/BC/zero policy episodes';
    }
    report.status = trainBC
      ? report.independentQuality?.status === 'blocked-policy-loader'
        ? 'passed-software-training-policy-rejected'
        : report.independentQuality?.qualityPassed
          ? 'passed-software-training-and-diagnostic-quality'
          : 'passed-software-training-quality-failed'
      : 'passed-browser-simulation';
    report.exitCode = 0;
    report.outcome = {
      realMujocoPhysics: true,
      realBrowserOnnxPolicy: true,
      realTrajectory: true,
      workbenchUpload: true,
      apiReadback: true,
      pluginReads: true,
      realBoardTelemetry: false,
      actuatorsInvoked: false,
      ...(trainBC
        ? {
            managedDemonstrationTraining: true,
            actualDataConsumption: true,
            tunedRun: true,
            independentRolloutsMeasured: true,
            trainedPolicyRolloutsMeasured: report.independentQuality?.trainedRolloutsMeasured ?? 0,
            trainedPolicyQualityPassed: report.independentQuality?.qualityPassed === true,
            physicalDeploymentVerified: false,
          }
        : {}),
    };
  } catch (error) {
    failure = error;
    report.status = ['MISSING_BROWSER', 'MISSING_ASSETS', 'MISSING_PYTHON'].includes(error.code)
      ? 'blocked-missing-dependencies'
      : 'failed';
    report.exitCode = ['MISSING_BROWSER', 'MISSING_ASSETS', 'MISSING_PYTHON'].includes(error.code)
      ? 2
      : 1;
  } finally {
    const cleanupErrors = [];
    let browserClosed = !browser;
    if (browser) {
      try {
        await browser.close();
        browserClosed = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    const stopped = await Promise.allSettled(children.reverse().map(terminate));
    for (const result of stopped)
      if (result.status === 'rejected') cleanupErrors.push(result.reason);
    let temporaryLedgerRemoved = false;
    try {
      await fs.rm(scratch, { recursive: true, force: true });
      temporaryLedgerRemoved = true;
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length) {
      failure ??= cleanupErrors[0];
      report.exitCode = 1;
      report.status = 'failed-cleanup';
      report.cleanupErrors = cleanupErrors.map((error) => scrubEvidence(error.message));
    }
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - started;
    report.cleanup = {
      browserClosed,
      servicesStopped: stopped.every((result) => result.status === 'fulfilled'),
      temporaryLedgerRemoved,
    };
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, `${JSON.stringify(scrubEvidence(report), null, 2)}\n`);
  }
  console.log(
    `[plugin-browser] ${report.status}; ${report.cases.filter((item) => item.status === 'passed').length}/${report.cases.length} cases passed; evidence written`,
  );
  if (failure) console.error(`[plugin-browser] ${scrubEvidence(failure.message)}`);
  process.exitCode = report.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyBrowserJourney().catch((error) => {
    console.error(`[plugin-browser] ${scrubEvidence(error.message)}`);
    process.exitCode = error.exitCode ?? 1;
  });
}
