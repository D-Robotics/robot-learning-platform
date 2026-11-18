import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';

const base = new URL(process.env.RDK_SIM2REAL_BASE_URL || 'http://127.0.0.1:18102/');
const evidence =
  process.env.RDK_ORIGINMAN_UI_EVIDENCE || join(tmpdir(), `rdk-originman-ui-${process.pid}`);
const runId = 'originman-release-fixture';
const policySha256 = 'a'.repeat(64);
const sceneSha256 = 'b'.repeat(64);
const scene = {
  version: 1,
  bodyCount: 2,
  meshes: {},
  geoms: [
    {
      body: 0,
      type: 0,
      size: [2, 2, 0.1],
      position: [0, 0, 0],
      quaternion: [1, 0, 0, 0],
      rgba: [0.5, 0.5, 0.5, 1],
    },
    {
      body: 1,
      type: 6,
      size: [0.08, 0.08, 0.15],
      position: [0, 0, 0],
      quaternion: [1, 0, 0, 0],
      rgba: [0.1, 0.5, 0.8, 1],
    },
  ],
};

async function installSimulationFixture(page) {
  // Use the built site's HTML, scripts and navigation. Only the trained Run
  // and physics responses are synthetic, so this gate does not need private assets.
  const run = {
    id: runId,
    modelId: 'originman-ui-model',
    status: 'completed',
    label: 'OriginMan 发布验收',
    backend: 'local',
    progress: [],
    training: {
      engine: 'originman-recovery',
      originmanWorkshop: {
        phase: 'train',
        groupId: 'group-01',
        timesteps: 8192,
        seed: 7,
        pushMaxForce: 4,
      },
    },
  };
  await page.route('**/api/sim2real/runs', async (route) => {
    assert.equal(route.request().method(), 'GET', 'release exercise must not submit a Run');
    const original = await route.fetch();
    assert.ok(original.ok(), 'built run-list endpoint must be available');
    await route.fulfill({ response: original, json: { ...(await original.json()), runs: [run] } });
  });

  const loaded = [];
  const sessions = new Map();
  await page.route('**/api/sim2real/workshops/originman/sessions**', async (route) => {
    const request = route.request();
    const tail = new URL(request.url()).pathname.split('/sessions')[1];
    const command = request.postDataJSON();
    if (!tail) {
      assert.equal(request.method(), 'POST');
      assert.equal(command.renderMode, 'webgl', 'replay needs a real WebGL canvas');
      assert.ok(
        !command.sourceRunId || command.sourceRunId === runId,
        'must load the selected Run',
      );
      const id = String(loaded.length + 1);
      loaded.push(command.sourceRunId ?? null);
      const session = { time: 0, sourceRunId: command.sourceRunId ?? null, push: false };
      sessions.set(id, session);
      await route.fulfill({
        status: 201,
        json: { ...state(session), scene, sessionId: id, simulationOnly: true },
      });
      return;
    }
    const [, id, action] = tail.split('/');
    const session = sessions.get(id);
    assert.ok(session, `unknown fixture session ${id}`);
    if (request.method() === 'DELETE') {
      sessions.delete(id);
      await route.fulfill({ json: { ok: true } });
      return;
    }
    assert.equal(action, 'command');
    switch (command.command) {
      case 'reset':
        session.time = 0;
        session.push = false;
        break;
      case 'push':
        session.push = true;
        break;
      case 'step':
        session.time += command.steps * 0.02;
        break;
      default:
        assert.fail(`unexpected simulation command ${command.command}`);
    }
    await route.fulfill({ json: state(session) });
  });
  return { loaded, sessions };
}

function state({ time, sourceRunId, push }) {
  const force = push && time >= 1.55 && time < 1.75 ? [0, 2, 0] : [0, 0, 0];
  return {
    ok: true,
    time,
    sourceRunId,
    policySha256: sourceRunId ? policySha256 : null,
    sceneSha256,
    controller: sourceRunId ? 'trained-rl' : 'baseline-pd',
    qpos: [time / 10, 0],
    tiltDegrees: 2,
    yawDegrees: 0,
    externalForceWorldN: force,
    fallen: push && time >= 2.1,
    done: push && time >= 2.1,
    visual: { time, force, bodies: [0, 0, 0, 1, 0, 0, 0, time / 10, 0, 0.2, 1, 0, 0, 0] },
  };
}

const browser = await chromium.launch({
  executablePath: process.env.RDK_PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  args: ['--enable-unsafe-swiftshader'],
});
try {
  for (const viewport of [
    { width: 1200, height: 820 },
    { width: 390, height: 844 },
  ]) {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
    await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const { loaded, sessions } = await installSimulationFixture(page);
    const canvas = page.locator('#originman-sim-canvas');
    const badge = page.locator('#originman-sim-badge');
    const status = page.locator('#originman-sim-status');
    const clock = page.locator('#originman-lab-clock');
    let passed = false;
    try {
      await page.goto(new URL('workshop.html', base).href);
      await page.getByRole('heading', { name: 'OriginMan 舞蹈 Workshop' }).waitFor();
      await page.getByRole('link', { name: '配置快检' }).click();
      await page.waitForURL((url) => url.hash === '#train/configure');
      await page.locator('#originman-training-goal').waitFor();

      await page.goto(new URL('workshop.html', base).href);
      await page.getByRole('link', { name: '打开受扰恢复课程' }).click();
      await page.getByRole('heading', { name: 'OriginMan 受扰恢复课程' }).waitFor();
      await page.getByText('实验管理与自由探索', { exact: true }).click();
      await page.getByRole('link', { name: '打开交互仿真' }).click();
      await page.locator('#originman-sim-preview-start').waitFor({ timeout: 7500 });

      // Verify the normal shared deep link and the in-workbench classroom entry.
      await page.goto(new URL('?robot=originman#simulate/simulate', base).href);
      await page.locator('#originman-sim-preview-start').waitFor();
      await page.goto(new URL('?robot=originman#train/prepare', base).href);
      await page.locator('#originman-contract-template').selectOption('recovery');
      await page.getByRole('button', { name: '打开受扰恢复课堂' }).click();
      await page.getByRole('heading', { name: 'OriginMan · 受扰恢复课堂' }).waitFor();

      await page.locator('#originman-sim-preview-start').click();
      await canvas.waitFor();
      await badge.filter({ hasText: /^运行中$/ }).waitFor();
      await canvas.press('Shift');
      await page.waitForFunction(
        () => parseFloat(globalThis.document.querySelector('#originman-lab-clock').textContent) > 0,
      );
      await page.locator('#originman-sim-pause').click();
      await badge.filter({ hasText: /^已暂停$/ }).waitFor();
      await page.locator('#originman-sim-reset').click();
      await status.filter({ hasText: /场景已重置/ }).waitFor();
      assert.equal(await clock.textContent(), '0.00s');
      await page.locator('#originman-sim-step').click();
      await clock.filter({ hasText: /^0\.02s$/ }).waitFor();

      await page.locator('#originman-sim-controller').selectOption('trained');
      await page.locator('#originman-sim-run').selectOption(runId);
      await page.locator('#originman-sim-connect').click();
      await status.filter({ hasText: /当前是所选训练策略/ }).waitFor();
      await page
        .locator('#originman-scene-caption')
        .filter({ hasText: /训练策略 aaaaaaaaaaaa/ })
        .waitFor();
      assert.deepEqual(loaded, [null, runId]);

      await page.locator('#originman-lab-demo').click();
      await page
        .locator('#originman-lab-note')
        .filter({ hasText: /本轮实验完成/ })
        .waitFor();
      await page.locator('#originman-lab-replay').click();
      await page.waitForFunction(
        () =>
          parseFloat(globalThis.document.querySelector('#originman-lab-replay-time').textContent) >
          0,
      );
      await page
        .locator('#originman-scene-caption')
        .filter({ hasText: /本轮回看/ })
        .waitFor();
      assert.deepEqual(loaded, [null, runId, runId]);
      assert.equal(await page.evaluate(() => globalThis.innerWidth), viewport.width);
      assert.ok(
        await page.evaluate(
          () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth + 1,
        ),
        'horizontal overflow',
      );
      const closed = page.waitForResponse(
        (response) =>
          response.request().method() === 'DELETE' &&
          response.url().includes('/originman/sessions/') &&
          response.ok(),
      );
      await page.locator('#originman-sim-disconnect').click();
      await closed;
      assert.equal(sessions.size, 0);
      assert.deepEqual(errors, []);
      passed = true;
      console.log(
        `[originman UI] PASS ${viewport.width}px · classroom entries, simulation controls, selected policy and replay (synthetic physics)`,
      );
    } finally {
      if (!passed) {
        await mkdir(evidence, { recursive: true });
        await page.screenshot({ path: join(evidence, `${viewport.width}.png`) });
        await context.tracing.stop({ path: join(evidence, `${viewport.width}.zip`) });
        console.error('[originman UI] Failure trace: ' + evidence);
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
}
