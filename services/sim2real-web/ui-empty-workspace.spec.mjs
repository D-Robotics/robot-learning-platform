import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = new URL(process.env.RDK_SIM2REAL_BASE_URL || 'http://127.0.0.1:18103/');
const output = process.env.RDK_EMPTY_WORKSPACE_SCREENSHOTS;
const { chromium } = await import(process.env.RDK_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.RDK_CHROMIUM_PATH,
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  locale: 'zh-CN',
  reducedMotion: 'reduce',
});
const id = (name) => page.locator('#' + name);
const pageErrors = [];
const writes = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('request', (request) => {
  const pathname = new URL(request.url()).pathname;
  if (pathname.includes('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
    writes.push(pathname);
  }
});
await page.addInitScript(() => {
  localStorage.setItem('rdk-duck-lab-onboarding-v1', 'done');
});

async function capture(name) {
  if (!output) return;
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: join(output, name + '.png') });
}

async function visibleText(name, hasText) {
  await id(name).filter({ hasText }).waitFor({ state: 'visible' });
}

async function firstScreen(name) {
  const bounds = await id(name).boundingBox();
  assert.ok(
    bounds && bounds.y >= 0 && bounds.y + bounds.height <= 900,
    name + ' must fit in the desktop viewport',
  );
}

try {
  const training = await page.request.get(new URL('api/sim2real/runs', base).href);
  assert.equal(training.ok(), true);
  assert.deepEqual((await training.json()).runs, []);
  const devices = await page.request.get(new URL('api/sim2real/device-connections', base).href);
  assert.equal(devices.ok(), true);
  const catalog = await devices.json();
  assert.deepEqual(catalog.connections, []);
  assert.deepEqual(catalog.studioDevices, []);

  await page.goto(new URL('#evaluate/evaluation-run', base).href);
  await visibleText('evaluation-empty-title', '还没有评测记录');
  await firstScreen('evaluation-empty-import');
  assert.equal(await id('evaluation-inspector').isVisible(), false);
  assert.equal(await id('evaluation-telemetry').isVisible(), false);
  assert.equal(await id('evaluation-next').isVisible(), false);
  await capture('01-evaluation-empty');
  console.log(
    'PASS  a fresh workspace offers the three evaluation actions on the desktop deep link',
  );

  await id('eval-tab-comparison').click();
  await visibleText('evaluation-empty-title', '还没有评测记录');
  assert.equal(await id('evaluation-comparison-panel').isVisible(), false);
  await id('evaluation-empty-demo').click();
  await visibleText('telemetry-state', '演示');
  assert.equal(await id('eval-tab-run').getAttribute('aria-selected'), 'true');
  assert.equal(await id('evaluation-empty').isVisible(), false);
  assert.match(await id('telemetry-source-note').innerText(), /演示/);
  await capture('02-evaluation-demo');
  await id('telemetry-clear-button').click();
  await visibleText('evaluation-empty-title', '还没有评测记录');
  console.log(
    'PASS  the example opens actual synthetic evidence and clearing it restores the empty state',
  );

  const emptyImport = id('evaluation-empty-import');
  const [badFile] = await Promise.all([page.waitForEvent('filechooser'), emptyImport.click()]);
  await badFile.setFiles({
    name: 'invalid.jsonl',
    mimeType: 'application/json',
    buffer: Buffer.from('not json'),
  });
  await visibleText('evaluation-empty-error', 'JSONL 后重试');
  assert.equal(await emptyImport.isEnabled(), true);
  const [goodFile] = await Promise.all([page.waitForEvent('filechooser'), emptyImport.click()]);
  await goodFile.setFiles(
    fileURLToPath(new URL('./public/demo/microduck-telemetry-sample.jsonl', import.meta.url)),
  );
  await id('telemetry-summary').filter({ hasText: '样本数' }).waitFor({ state: 'visible' });
  assert.equal(await id('evaluation-empty').isVisible(), false);
  await id('telemetry-clear-button').click();
  await id('evaluation-empty-run').click();
  await page.waitForURL(/#train\/configure$/);
  assert.equal(await id('train-tab-config').getAttribute('aria-selected'), 'true');
  console.log(
    'PASS  file picker, invalid-file retry, valid local import, and training navigation work without writes',
  );

  await page.goto(new URL('#station/devices', base).href);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await visibleText('station-device-manager-note', '尚未连接设备');
  assert.equal(await id('station-notice').isVisible(), false);
  assert.equal(await id('station-device-host').isVisible(), false);
  assert.equal(
    await id('station-device-host').evaluate((field) => field.getClientRects().length),
    0,
  );
  await firstScreen('station-studio-entry');
  await firstScreen('station-address-entry');
  await capture('03-device-empty');
  console.log(
    'PASS  a new workspace has a neutral status and both connection entry points in the first screen',
  );

  const studio = id('station-studio-entry').locator('summary');
  await studio.focus();
  await page.keyboard.press('Enter');
  await id('station-device-refresh').click();
  await visibleText('station-device-manager-note', '尚未连接设备');
  assert.equal(await id('station-studio-entry').getAttribute('open'), '');
  const address = id('station-address-entry').locator('summary');
  await address.focus();
  await page.keyboard.press('Enter');
  await id('station-device-host').waitFor({ state: 'visible' });
  await id('station-device-add-btn').click();
  await visibleText('station-device-pairing-hint', '请填写板卡 IP');
  assert.equal(await page.locator(':focus').getAttribute('id'), 'station-device-host');
  await capture('04-device-address');
  console.log(
    'PASS  keyboard disclosures, refresh, and blank-address validation are available without attempting a connection',
  );

  const discoveryPath = (url) => url.pathname.endsWith('/api/sim2real/device-connections');
  await studio.click();
  await page.route(discoveryPath, (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'fixture: device inventory unavailable' }),
    }),
  );
  await id('station-device-refresh').click();
  await visibleText('station-device-manager-note', '暂时无法读取全部设备');
  assert.equal(await id('station-discovery-diagnostic').isVisible(), false);
  await id('station-connection-diagnostics').locator('summary').click();
  await visibleText('station-discovery-diagnostic', 'fixture: device inventory unavailable');
  await page.unroute(discoveryPath);
  await id('station-device-refresh').click();
  await visibleText('station-device-manager-note', '尚未连接设备');
  await page.setViewportSize({ width: 1280, height: 900 });
  assert.equal(
    await page.evaluate(
      () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
    ),
    true,
  );
  assert.deepEqual(writes, []);
  assert.deepEqual(pageErrors, []);
  console.log(
    'PASS  discovery errors stay in diagnostics and retry recovers without a hardware or ledger write',
  );
} catch (error) {
  await capture('failure').catch(() => {});
  throw error;
} finally {
  await browser.close();
}
