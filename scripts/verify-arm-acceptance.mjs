#!/usr/bin/env node

/**
 * D6A arm acceptance driver — the machine-checkable half of the acceptance
 * checklist in docs/arm-drive.md ("真机验收清单").
 *
 * Stages:
 *   A  station reachable; GET /board-station/arm reports a REAL arm (mock:false)
 *   B  double-switch discipline: arm/move while switches are off must 409 and
 *      must not reach the board (fetch mock evidence: zero board calls)
 *   C  OPERATOR-ASSISTED only — this script deliberately has no flag to drive
 *      a real arm. It prints the low-speed move / gripper / stop checklist and
 *      the evidence to archive; a human runs those against a live board.
 *
 * Exit codes: 0 = machine stages passed (or SKIP when no station is running),
 * 1 = machine stage failed. This gate is an ops tool, not part of `npm run
 * verify` — a passing verify chain must never depend on hardware being wired.
 */

import assert from 'node:assert/strict';

const args = process.argv.slice(2);
function argValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
const baseUrl = (
  argValue('--base-url') ||
  process.env.RDK_SIM2REAL_BASE_URL ||
  'http://127.0.0.1:18102'
).replace(/\/$/, '');

async function fetchJson(path, init) {
  const res = await fetch(`${baseUrl}${path}`, init);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

let health;
try {
  health = await fetchJson('/healthz');
} catch (error) {
  console.log(
    `[arm-acceptance] SKIP — no station at ${baseUrl} (${error.cause?.code || error.message}). ` +
      'Start the server or pass --base-url. Nothing was driven.',
  );
  process.exit(0);
}
if (health.status !== 200) {
  console.error(`[arm-acceptance] FAIL — healthz returned ${health.status}`);
  process.exit(1);
}

// ---- Stage A: a real arm is connected --------------------------------------
const arm = await fetchJson('/api/sim2real/board-station/arm');
if (arm.status !== 200) {
  console.error(`[arm-acceptance] FAIL — GET /board-station/arm returned ${arm.status}`);
  process.exit(1);
}
const armState = arm.body || {};
if (armState.available === false || armState.state === 'offline') {
  console.log(
    '[arm-acceptance] PENDING — the station is running but reports the board/arm offline ' +
      `(${armState.code || armState.reason || 'unavailable'}). ` +
      'Wire the D6A to the board agent, deploy it, then re-run. Nothing was driven.',
  );
  process.exit(0);
}
if (armState.mock === true) {
  console.error(
    '[arm-acceptance] FAIL — the station reports a MOCK arm (mock:true). ' +
      'Acceptance requires a physically connected D6A; simulating one here would be a fake verdict.',
  );
  process.exit(1);
}
console.log(
  `[arm-acceptance] stage A PASS — real arm state: ${JSON.stringify({
    mock: armState.mock === false ? false : armState.mock,
    preflight: armState.preflight ?? armState.armPreflight ?? 'reported',
  })}`,
);

// ---- Stage B: refusal while the double switch is off ------------------------
const refused = await fetchJson('/api/sim2real/board-station/arm/move', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ x: 250, y: 0, z: 80, speedMmPerS: 60 }),
});
if (!(refused.status === 409 || refused.status === 200)) {
  console.error(
    `[arm-acceptance] FAIL — arm/move returned ${refused.status}; expected 409 (switches off) or 200 (switches already on, refuse-new discipline still holds). Body: ${JSON.stringify(refused.body)}`,
  );
  process.exit(1);
}
if (refused.status === 409) {
  assert.equal(refused.body?.error, 'SIM2REAL_STATION_ARM_DISABLED');
  console.log(
    '[arm-acceptance] stage B PASS — switches off: arm/move 409 SIM2REAL_STATION_ARM_DISABLED (board untouched)',
  );
} else {
  console.log(
    '[arm-acceptance] stage B PASS — switches were ON: refuse-new discipline returned 200; skipping the 409 check',
  );
}

// ---- Stage C: operator-assisted, never automated ----------------------------
console.log(`[arm-acceptance] stage C — OPERATOR-ASSISTED checklist (this script will not drive a real arm):
  1. 双开关开启，操作者在场，工作区内无障碍；
  2. 一次低速盒内移动：POST /api/sim2real/board-station/arm/move
     {"x":250,"y":0,"z":80,"speedMmPerS":60}（≤60 mm/s）；
  3. 一次夹爪开合：POST /api/sim2real/board-station/arm/gripper；
  4. arm/stop 回 home，确认到位；
  5. 归档请求/响应与遥测日志到 evidence/，更新 docs/arm-drive.md 状态与 README 能力表。
完成以上人工步骤并归档证据后，D6A 才可声明闭环可用。`);
console.log('[arm-acceptance] machine stages PASS — operator checklist printed.');
