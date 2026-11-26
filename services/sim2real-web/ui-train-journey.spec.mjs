// Desktop workbench with isolated, freshly initialized storage and a Worker.
// Default: mock worker, including model registration and truthful no-replay state.
// RDK_TRAIN_JOURNEY_MODE=starter: real CPU Starter PPO and same-Run replay.
// RDK_SIM2REAL_BASE_URL defaults to http://127.0.0.1:18103/.
// RDK_PLAYWRIGHT_MODULE and RDK_CHROMIUM_PATH follow the other visual sweeps.
// RDK_TRAIN_JOURNEY_SCREENSHOTS optionally captures the four desktop states.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const BASE = process.env.RDK_SIM2REAL_BASE_URL || 'http://127.0.0.1:18103/';
const starter = process.env.RDK_TRAIN_JOURNEY_MODE === 'starter';
const RUN_TIMEOUT_MS = starter ? 180_000 : 45_000;
const screenshots = process.env.RDK_TRAIN_JOURNEY_SCREENSHOTS;

async function loadPlaywright() {
  const ids = [process.env.RDK_PLAYWRIGHT_MODULE, 'playwright', 'playwright-core'].filter(Boolean);
  for (const id of ids) {
    try {
      const mod = await import(id);
      return mod.chromium ? mod : (mod.default ?? null);
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

const pw = await loadPlaywright();
if (!pw?.chromium) {
  console.log(
    '[sim2real-ui-journey] SKIP — Playwright is not installed.\n' +
      '  Install it (and a browser) to run this sweep:\n' +
      '    npm i --no-save --no-package-lock playwright && npx playwright install --with-deps chromium',
  );
  process.exit(starter ? 1 : 0);
}

const launchOptions = { headless: true };
if (process.env.RDK_CHROMIUM_PATH) launchOptions.executablePath = process.env.RDK_CHROMIUM_PATH;

let browser;
try {
  browser = await pw.chromium.launch(launchOptions);
} catch (error) {
  console.log(`[sim2real-ui-journey] SKIP — could not launch Chromium: ${error.message}`);
  process.exit(starter ? 1 : 0);
}

const checks = [];
const record = (name, ok, detail) => {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  locale: 'zh-CN',
  reducedMotion: 'reduce',
});
const page = await context.newPage();

const pageErrors = [];
const serverErrors = [];
const advisory5xx = new Set();
page.on('pageerror', (error) => pageErrors.push(String(error?.message ?? error).slice(0, 200)));
page.on('response', async (response) => {
  const url = response.url();
  const status = response.status();
  if (!url.includes('/api/') || status < 500) return;
  const short = `${status} ${url.replace(BASE, '/')}`;
  if (status === 502 && url.includes('/api/sim2real/local-bridge/')) {
    advisory5xx.add(`${short} (optional local GPU agent absent)`);
    return;
  }
  // During a journey any 5xx is a real fault — the mock worker path must be
  // clean. 503s carry the degradation envelope; keep them visible but do not
  // fail on them (e.g. an overview poll racing storage readiness at boot).
  if (status === 503) {
    let code = '';
    try {
      code = (await response.json())?.error ?? '';
    } catch {
      /* non-JSON degradation body */
    }
    advisory5xx.add(code ? `${short} (${code})` : short);
    return;
  }
  serverErrors.push(short);
});

const locator = (id) => page.locator('#' + id);
const writeRequests = [];
page.on('request', (request) => {
  if (
    request.method() === 'POST' &&
    new URL(request.url()).pathname.endsWith('/api/sim2real/runs')
  ) {
    writeRequests.push(request.postDataJSON());
  }
});

async function screenshot(name) {
  if (!screenshots) return;
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, name + '.png') });
}

try {
  // Dismiss only the introductory help in this separate browser context.
  await page.addInitScript(() => {
    localStorage.setItem('rdk-duck-lab-onboarding-v1', 'done');
  });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  const freshness = await page.evaluate(async () => {
    const [models, runs] = await Promise.all(
      ['models', 'runs'].map(async (entry) => {
        const response = await fetch('/api/sim2real/' + entry);
        if (!response.ok) throw new Error(entry + ' returned ' + response.status);
        return response.json();
      }),
    );
    return {
      customModels: models.models.filter((model) => !model.builtin).length,
      runs: runs.runs.length,
    };
  });
  assert.deepEqual(freshness, { customModels: 0, runs: 0 }, 'Use a new isolated journey ledger');
  record('new workspace has no custom models or runs', true);

  const example = locator('next-action-button').filter({ hasText: '配置示例训练' });
  await example.waitFor({ state: 'visible' });
  const heroBox = await example.boundingBox();
  assert.ok(heroBox && heroBox.y + heroBox.height <= 900, 'first action should fit on the desktop');
  assert.equal(await page.locator('#onboard-list [data-view-target="train"]').count(), 0);
  assert.equal(
    await page.locator('#onboard-list .is-current').getAttribute('data-onboard-step'),
    'train',
  );
  assert.equal(await locator('platform-score-total').isVisible(), false);
  const readiness = page.locator('#project-readiness > summary');
  await readiness.focus();
  await page.keyboard.press('Enter');
  await locator('platform-score-total').waitFor({ state: 'visible' });
  await page.keyboard.press('Enter');
  await locator('platform-score-total').waitFor({ state: 'hidden' });
  await page.evaluate(() => window.scrollTo(0, 0));
  await screenshot('01-home');
  record('home gives one first-training action and hides the score until opened', true);

  await example.click();
  await locator('train-tab-config').waitFor({ state: 'visible' });
  assert.equal(await locator('train-tab-config').getAttribute('aria-selected'), 'true');
  assert.equal(await locator('training-profile').inputValue(), 'smoke');
  assert.equal(await locator('training-engine').inputValue(), 'starter-ppo');
  assert.ok((await locator('model-select').inputValue()).length > 0);
  record('home opens a prefilled training configuration', true);

  if (!starter) {
    await locator('train-tab-contract').click();
    await locator('template-button').click();
    assert.ok((await locator('manifest-editor').inputValue()).length > 100);
    await locator('register-button').click();
    await locator('validation-result').filter({ hasText: '已登记' }).waitFor({ state: 'visible' });
    await locator('train-tab-run').click();
    const modelId = await page.evaluate(async () => {
      const list = await fetch('/api/sim2real/models').then((response) => response.json());
      return list.models.find((model) => !model.builtin)?.id;
    });
    assert.ok(modelId);
    await locator('model-select').selectOption(modelId);
    await locator('train-tab-config').click();
    record('template registers and the new model can be selected', true);
  }

  const submitBox = await locator('training-config-submit').boundingBox();
  assert.ok(
    submitBox && submitBox.y + submitBox.height <= 900,
    'submission should fit on the desktop',
  );
  await screenshot('02-configuration');
  await locator('training-config-submit').click();
  await locator('confirm-action-dialog').waitFor({ state: 'visible' });
  assert.match(await locator('confirm-action-details').innerText(), /starter-ppo/);
  await page.keyboard.press('Escape');
  await locator('confirm-action-dialog').waitFor({ state: 'hidden' });
  assert.equal(writeRequests.length, 0);
  assert.equal(await locator('training-engine').inputValue(), 'starter-ppo');
  record('cancelling confirmation preserves the configuration without submitting', true);

  await locator('training-config-submit').click();
  const accepted = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith('/api/sim2real/runs'),
  );
  await locator('confirm-action-approve').click();
  const response = await accepted;
  assert.equal(response.ok(), true, await response.text());
  const { run } = await response.json();
  assert.ok(run.id);
  assert.equal(writeRequests.length, 1);
  assert.equal(run.training.engine, 'starter-ppo');
  await locator('run-progress-card').waitFor({ state: 'visible' });
  assert.equal(await locator('run-progress-card').getAttribute('data-run-id'), run.id);
  assert.equal(await locator('train-tab-run').getAttribute('aria-selected'), 'true');
  record('one submit opens the exact accepted Run', true, run.id);

  await locator('run-progress-status')
    .filter({ hasText: /已完成|失败|已阻断|已取消/ })
    .waitFor({
      state: 'visible',
      timeout: RUN_TIMEOUT_MS,
    });
  assert.equal(await locator('run-progress-card').getAttribute('data-run-id'), run.id);
  const stored = await page.evaluate(async (runId) => {
    const detail = await fetch('/api/sim2real/runs/' + encodeURIComponent(runId));
    if (!detail.ok) throw new Error('Run detail returned ' + detail.status);
    return (await detail.json()).run;
  }, run.id);
  assert.equal(stored.id, run.id);
  assert.equal(stored.status, 'completed');
  assert.equal(stored.mock, !starter);
  await screenshot('03-completed-run');
  record(
    starter
      ? 'real CPU run completes and renders in the workbench'
      : 'mock run completes and is labelled as Mock',
    true,
    run.id,
  );

  if (starter) {
    assert.ok(stored.artifact?.sha256, 'real policy digest is available');
    const [replayResponse] = await Promise.all([
      page.waitForResponse(
        (result) =>
          new URL(result.url()).pathname.endsWith(
            '/runs/' + encodeURIComponent(run.id) + '/replay',
          ) && result.ok(),
      ),
      locator('run-progress-replay').click(),
    ]);
    const replay = await replayResponse.json();
    assert.ok(replay.frames.length > 1);
    await locator('replay-play-button').waitFor({ state: 'visible' });
    await locator('replay-status').filter({ hasText: '已加载' }).waitFor({ state: 'visible' });
    assert.equal(await locator('replay-run-select').inputValue(), run.id);
    await screenshot('04-same-run-replay');
    await locator('replay-play-button').click();
    await page.waitForFunction(() => Number(document.getElementById('replay-seek').value) > 0);
    const end = await locator('replay-seek').getAttribute('max');
    await locator('replay-seek').focus();
    await page.keyboard.press('End');
    assert.equal(await locator('replay-seek').inputValue(), end);
    record(
      'exact Run replay loads, plays and seeks',
      true,
      `${replay.frames.length} frames · ${run.id}`,
    );
  } else {
    assert.match(await locator('run-progress-status').innerText(), /Mock/);
    assert.equal(await locator('run-progress-replay').isVisible(), false);
    record('mock completion does not offer a fabricated replay', true);
  }
  assert.equal(writeRequests.length, 1, 'navigation and replay never submit training');

  await page.locator('.nav-item[data-view-target="overview"]').click();
  await locator('overview-recent-run').click();
  await locator('run-detail-dialog').waitFor({ state: 'visible' });
  assert.match(await locator('run-detail-dialog').innerText(), new RegExp(run.id));
  record('the homepage opens the same recent Run', true);
} catch (error) {
  await screenshot('failure').catch(() => {});
  record('desktop training journey', false, error.stack || error.message);
}

record(
  'no uncaught script errors during the journey',
  pageErrors.length === 0,
  pageErrors.join(' | '),
);
record('no unhandled 5xx during the journey', serverErrors.length === 0, serverErrors.join(' | '));
record(
  'structured 5xx degradations (advisory)',
  true,
  advisory5xx.size ? [...advisory5xx].slice(0, 4).join(' | ') : 'none',
);

await context.close();
await browser.close();

const failed = checks.filter((c) => !c.ok);
console.log(
  `\n[sim2real-ui-journey] ${checks.length - failed.length}/${checks.length} checks passed against ${BASE}`,
);
assert.ok(failed.length === 0, `${failed.length} journey check(s) failed`);
process.exitCode = 0;
