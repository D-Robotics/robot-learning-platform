#!/usr/bin/env node
/** Live preflight for the station demo. Fails closed when the board is reachable
 * but does not provide real station telemetry. This complements static tests. */
const base = (process.env.RDK_SIM2REAL_DEMO_URL || 'http://127.0.0.1:18104').replace(/\/$/, '');
const required = async (path) => {
  const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5000) });
  let body = null;
  try { body = await response.json(); } catch {}
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${body?.code || body?.error || ''}`.trim());
  return body;
};
try {
  const health = await required('/api/sim2real/board-station/health');
  if (health?.agent?.mock !== false) throw new Error('agent.mock is not false');
  const snapshot = await required('/api/sim2real/board-station/status');
  const status = snapshot?.status ?? snapshot;
  if (status?.board?.mock !== false) throw new Error('status.board.mock is not false');
  if (!status?.originbot || !status?.originbot.imu) throw new Error('real OriginBot IMU telemetry is missing');
  if (status?.power == null && status?.originbot?.batteryVoltage == null) throw new Error('real battery telemetry is missing');
  const policy = await required('/api/sim2real/board-station/policy');
  console.log(JSON.stringify({ ok: true, base, board: status.board, battery: status.power ?? status.originbot.batteryVoltage, topics: status.topics?.length ?? 0, policy: policy.policy }, null, 2));
} catch (error) {
  console.error(`[live-board] FAIL — ${error.message}`);
  process.exitCode = 1;
}
