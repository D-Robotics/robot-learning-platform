#!/usr/bin/env node

/**
 * D6A arm acceptance driver — the machine-checkable half of the acceptance
 * checklist in docs/arm-drive.md ("真机验收清单").
 *
 * Stages:
 *   A  station reachable; GET /board-station/arm reports a REAL arm (mock:false)
 *   B  report the observed platform/board switches and stop latch (GET only)
 *   C  print the OPERATOR-ASSISTED move / gripper / stop / reset checklist.
 *      The script never sends a POST, even when both switches are enabled.
 *
 * Exit codes: 0 = machine stages passed (or SKIP when no station is running),
 * 1 = machine stage failed. This gate is an ops tool, not part of `npm run
 * verify` — a passing verify chain must never depend on hardware being wired.
 */

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

async function fetchJson(path) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
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
const envelope = arm.body || {};
const armState = envelope.arm;
if (envelope.available === false || envelope.state === 'offline' || armState?.available === false) {
  console.log(
    '[arm-acceptance] PENDING — the station is running but reports the board/arm offline ' +
      `(${armState?.reason || envelope.code || envelope.reason || 'unavailable'}). ` +
      'Wire the D6A to the board agent, deploy it, then re-run. Nothing was driven.',
  );
  process.exit(0);
}
if (armState?.mock === true) {
  console.error(
    '[arm-acceptance] FAIL — the station reports a MOCK arm (mock:true). ' +
      'Acceptance requires a physically connected D6A; simulating one here would be a fake verdict.',
  );
  process.exit(1);
}
if (!armState || armState.available !== true || armState.mock !== false) {
  console.error(
    '[arm-acceptance] FAIL — arm response must explicitly report arm.available:true and arm.mock:false. ' +
      'Missing hardware evidence cannot pass the read-only preflight.',
  );
  process.exit(1);
}
console.log(
  `[arm-acceptance] stage A PASS — real arm state: ${JSON.stringify({
    available: armState.available,
    mock: armState.mock,
  })}`,
);

// ---- Stage B: report state without attempting any mutation ------------------
console.log(
  `[arm-acceptance] stage B OBSERVED — ${JSON.stringify({
    platformEnabled: envelope.platformEnabled ?? null,
    boardEnabled: armState.enabled ?? null,
    moving: armState.moving ?? null,
    stopRequested: armState.stopRequested ?? null,
  })}. Switch refusal and physical stop/reset behavior remain operator acceptance work.`,
);

// ---- Stage C: operator-assisted, never automated ----------------------------
console.log(`[arm-acceptance] stage C — OPERATOR-ASSISTED checklist (this script will not drive a real arm):
  1. 操作者在场，工作区内无障碍；先验证双开关任一关闭时 move/gripper/reset 均被拒绝；
  2. 确认 agent 启动/重启即 stopRequested:true；双开关开启且现场安全后显式 arm/reset，再一次低速盒内移动：POST /api/sim2real/board-station/arm/move
     {"x":250,"y":0,"z":80,"speedMmPerS":60}（≤60 mm/s）；
  3. 一次夹爪开合：POST /api/sim2real/board-station/arm/gripper；
  4. arm/stop 锁定后续命令；确认 stopRequested:true、interrupted:false、homed:false，绝不自动回 home；
     在途 SDK 调用结束前 moving 必须保持 true，move/gripper 被 arm-stopped 拒绝；
     需要立即停止实体运动时使用机械臂物理急停；
  5. SDK 仍在执行时 arm/reset 应返回 409 move-in-progress；待现场安全且 idle 后显式 arm/reset；
     确认 stopRequested:false，恢复没有 SDK 致动或自动新运动；验证无操作者权限时恢复被拒绝；
  6. 归档请求/响应与遥测日志到 evidence/，更新 docs/arm-drive.md 状态与 README 能力表。
完成以上人工步骤并归档证据后，D6A 才可声明闭环可用。`);
console.log(
  '[arm-acceptance] read-only preflight PASS — motion/stop/reset acceptance PENDING operator evidence.',
);
