// Browser-level user-journey sweep: register a model and complete one local
// training loop, entirely through the workbench UI.
//
// ui-workbench-path.spec.mjs proves every view mounts. This spec proves the
// product loop WORKS from the user's seat: 载入模板 → 登记模型 → 选择模型 →
// 发起本地训练 → 进度卡走到完成。It needs the full triangle running — web
// service + mock worker (RDK_SIM2REAL_LOCAL_RUNNER_URL) + a FRESH storage dir
// — and fails if any link breaks, which is exactly what a regression here
// looks like for a user.
//
// Like the other browser sweeps it skips (exit 0) when Playwright is
// unavailable; CI installs it explicitly in the ui-visual workflow.
//
//   node services/sim2real-web/ui-train-journey.spec.mjs
//
// Env:
//   RDK_SIM2REAL_BASE_URL   default http://127.0.0.1:18103/ (the journey
//                           service instance, distinct from the sweep's 18102)
//   RDK_PLAYWRIGHT_MODULE   module id to import (default: playwright, playwright-core)
//   RDK_CHROMIUM_PATH       explicit browser binary (default: Playwright's own)
import assert from 'node:assert/strict';

const BASE = process.env.RDK_SIM2REAL_BASE_URL || 'http://127.0.0.1:18103/';
const RUN_TIMEOUT_MS = 45_000;

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
  process.exit(0);
}

const launchOptions = { headless: true };
if (process.env.RDK_CHROMIUM_PATH) launchOptions.executablePath = process.env.RDK_CHROMIUM_PATH;

let browser;
try {
  browser = await pw.chromium.launch(launchOptions);
} catch (error) {
  console.log(`[sim2real-ui-journey] SKIP — could not launch Chromium: ${error.message}`);
  process.exit(0);
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

await page.addInitScript(() => {
  try {
    // Simulate a brand-new user: leftover workspace context (project/model
    // ids) from an earlier journey run against the same origin would bind the
    // fresh registration to a project this ledger has never seen.
    localStorage.clear();
    localStorage.setItem('rdk-duck-lab-onboarding-v1', 'done');
  } catch {
    /* private mode: the tour simply opens */
  }
});
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page
  .waitForFunction(
    () =>
      (document.querySelector('[data-view-section]:not([hidden])')?.textContent || '').trim()
        .length > 40,
    undefined,
    { timeout: 10_000 },
  )
  .catch(() => {});
await page.waitForTimeout(1600);

// ---- precondition: this instance must be a fresh ledger ----
// Registration is not idempotent (re-registering the same manifest is a 409),
// and the journey proves the FIRST-registration path. Against a reused
// storage dir the sweep would test a different story, so say so plainly.
const freshness = await page.evaluate(async () => {
  const [models, runs] = await Promise.all([
    fetch('/api/sim2real/models', {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    }).then((r) => r.json()),
    fetch('/api/sim2real/runs?limit=10', {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    }).then((r) => r.json()),
  ]);
  return {
    customModels: (models.models ?? []).filter((model) => !model.builtin).length,
    runs: (runs.runs ?? []).length,
  };
});
record(
  'instance has a fresh ledger (no custom models, no runs)',
  freshness.customModels === 0 && freshness.runs === 0,
  `${freshness.customModels} custom model(s), ${freshness.runs} run(s) — point this sweep at a fresh storage dir`,
);

async function clickStable(id) {
  await page.evaluate((buttonId) => {
    const button = document.getElementById(buttonId);
    if (!button) throw new Error(`missing #${buttonId}`);
    if (button.disabled) throw new Error(`#${buttonId} is disabled`);
    button.click();
  }, id);
}

// Poll a page-side fetch until it returns a non-pending result. Deliberately
// loops on the Node side (page.evaluate per tick): a long-lived async
// `waitForFunction` turned out not to issue its fetches reliably in headless,
// while evaluate-per-tick is deterministic and debuggable.
async function pollInPage(pageFunction, timeoutMs, intervalMs = 700) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await page
      .evaluate(pageFunction)
      .catch((error) => ({ __pending: true, error: String(error).slice(0, 120) }));
    if (last && last.__pending !== true) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return last ?? { __pending: true };
}

// ---- step 1: 载入模板并登记模型 ----
await page.evaluate(() => {
  window.location.hash = '#train';
});
await page.waitForTimeout(900);
let stepOk = true;
try {
  await clickStable('template-button');
  const templateChars = await page.evaluate(
    () => document.getElementById('manifest-editor')?.value.length ?? 0,
  );
  record('manifest template loads into the editor', templateChars > 100, `${templateChars} chars`);
} catch (error) {
  stepOk = false;
  record('manifest template loads into the editor', false, String(error.message ?? error));
}
if (stepOk) {
  // Snapshot the selector BEFORE registering: the app refreshes the model
  // options within ~1s of a successful registration, so a snapshot taken
  // after the confirmation would already contain the new model.
  const optionsBefore = await page.evaluate(() =>
    [...document.querySelectorAll('#model-select option')].map((option) => option.value),
  );
  await clickStable('register-button');
  const registered = await page
    .waitForFunction(
      () => {
        const result = document.getElementById('validation-result');
        return Boolean(
          result && result.classList.contains('is-ok') && /登记/.test(result.textContent || ''),
        );
      },
      { timeout: 15_000 },
    )
    .then(() => true)
    .catch(() => false);
  record(
    'model registers through the UI',
    registered,
    registered ? 'validation-result reports 登记' : 'no success confirmation within 15s',
  );

  // ---- step 2: 选中刚登记的模型 + smoke 档位 ----
  // Option values are internal model ids, not manifest.modelId, so identify
  // the registered model by the option that appears after registration.
  const newModelValue = await page
    .waitForFunction(
      (before) => {
        const select = document.getElementById('model-select');
        if (!select) return false;
        const fresh = [...select.options].find((option) => !before.includes(option.value));
        if (!fresh) return false;
        if (select.value !== fresh.value) {
          select.value = fresh.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return select.value === fresh.value ? fresh.value : false;
      },
      optionsBefore,
      { timeout: 15_000 },
    )
    .catch(() => false);
  record(
    'registered model is selectable and selected',
    Boolean(newModelValue),
    newModelValue ? `selected ${newModelValue}` : 'no new option appeared after registration',
  );
  await page.evaluate(() => {
    const select = document.getElementById('training-profile');
    if (select) {
      select.value = 'smoke';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });

  // ---- step 3: 发起本地训练并等它走完 ----
  let launched = false;
  try {
    await clickStable('local-run-button');
    launched = true;
  } catch (error) {
    record('local training launches from the UI', false, String(error.message ?? error));
  }
  if (launched) {
    const progressVisible = await page
      .waitForFunction(() => !document.getElementById('run-progress-card')?.hidden, undefined, {
        timeout: 10_000,
      })
      .then(() => true)
      .catch(() => false);
    record(
      'run progress card appears after launch',
      progressVisible,
      progressVisible ? 'card un-hidden' : 'card stayed hidden',
    );
    // Completion is driven by the platform's lazy reconcile: GET /runs/{id}
    // polls the worker and materializes queued→running→completed (the same
    // path the progress card drives). The mock badge "协议演示" is a static
    // backend label shown at launch, so completion must be read from the run
    // record, never from the badge.
    const runOutcome = await pollInPage(async () => {
      const listResponse = await fetch('/api/sim2real/runs?limit=10', {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      });
      if (!listResponse.ok) return { __pending: true, listStatus: listResponse.status };
      const list = await listResponse.json();
      const runs = list.runs ?? [];
      const terminal = runs.find((item) => item.status === 'completed' || item.status === 'failed');
      if (terminal) {
        return {
          id: terminal.id,
          status: terminal.status,
          hasArtifact: Boolean(terminal.artifact),
          summary: String(terminal.summary ?? '').slice(0, 80),
        };
      }
      const active = runs.find((item) => item.status === 'queued' || item.status === 'running');
      if (!active?.id) return { __pending: true, note: 'no active run in ledger yet' };
      // The detail read is what drives the reconcile forward.
      const detail = await fetch(`/api/sim2real/runs/${encodeURIComponent(active.id)}`, {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      });
      if (!detail.ok) return { __pending: true, detailStatus: detail.status };
      return { __pending: true, status: (await detail.json()).run?.status ?? 'unknown' };
    }, RUN_TIMEOUT_MS);
    record(
      'local run completes through the platform reconcile path',
      runOutcome?.status === 'completed',
      runOutcome
        ? runOutcome.status === 'completed'
          ? `${runOutcome.id}: ${runOutcome.status}${runOutcome.hasArtifact ? ', artifact attached' : ''} — ${runOutcome.summary}`
          : `last observed: ${JSON.stringify(runOutcome).slice(0, 140)}`
        : `run still active after ${RUN_TIMEOUT_MS / 1000}s`,
    );
    const meta = await page.evaluate(
      () => document.getElementById('run-progress-meta')?.textContent.trim() ?? '',
    );
    record('run evidence rendered in the progress card', meta.length > 20, meta.slice(0, 120));
  }
}

// ---- the ledger agrees with what the UI showed ----
const ledgerRun = await pollInPage(
  async () => {
    const response = await fetch('/api/sim2real/runs?limit=10', {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    });
    if (!response.ok) return { __pending: true, status: response.status };
    const body = await response.json();
    const run = (body.runs ?? []).find((item) => item.status === 'completed');
    return run
      ? { id: run.id, status: run.status, total: (body.runs ?? []).length }
      : { __pending: true };
  },
  15_000,
  500,
);
record(
  'ledger holds the completed run',
  Boolean(ledgerRun?.id),
  ledgerRun?.id
    ? `${ledgerRun.total} run(s) total, completed: ${ledgerRun.id}`
    : `no completed run within 15s (${JSON.stringify(ledgerRun).slice(0, 100)})`,
);

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
