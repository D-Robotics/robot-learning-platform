#!/usr/bin/env node
/**
 * Demo preflight — the automated, read-only version of the "演示前 30 秒预检
 * 清单" in docs/demo-runbook.md. One command checks, item by item:
 *
 *   1. 工作台服务可达
 *   2. 板端 agent 健康（mock/real，如实区分）
 *   3. 设备隧道状态（web-managed SSH 隧道）
 *   4. 传感器遥测活着（IMU / 电池）
 *   5. 策略与驱动开关状态（只读；开关关闭是正常安全态，会如实提示）
 *   6. 板端策略制品在位（policies/*.onnx）
 *
 * Every item prints ✓/✗ with a concrete fix hint. The script only issues
 * GETs — it never commands motion, never flips switches, never stages files.
 *
 *   npm run demo:preflight
 *   node scripts/demo-preflight.mjs --url http://127.0.0.1:18104
 *   node scripts/demo-preflight.mjs --json          # machine-readable
 *   node scripts/demo-preflight.mjs --strict        # mock=agent 时退出码 2
 */

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

if (flag('help') || flag('h')) {
  console.log(`用法: npm run demo:preflight [选项]

选项:
  --url <base>   工作台地址（默认自动探测 18104 / 18102 / RDK_SIM2REAL_PORT）
  --json         输出 JSON 结果（CI / 脚本消费）
  --strict       连接的是 mock 参考 agent 时以退出码 2 失败
  --no-color     禁用 ANSI 颜色`);
  process.exit(0);
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR && !flag('no-color');
const c = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const green = (t) => c('32', t);
const red = (t) => c('31', t);
const yellow = (t) => c('33', t);
const dim = (t) => c('2', t);
const bold = (t) => c('1', t);

const stripTrailingSlash = (url) => url.replace(/\/$/, '');

async function api(base, path, timeoutMs = 5000) {
  const response = await fetch(`${base}${path}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

async function resolveBase() {
  const candidates = [];
  if (opt('url')) candidates.push(stripTrailingSlash(opt('url')));
  if (process.env.RDK_SIM2REAL_DEMO_URL)
    candidates.push(stripTrailingSlash(process.env.RDK_SIM2REAL_DEMO_URL));
  if (process.env.RDK_SIM2REAL_PORT)
    candidates.push(`http://127.0.0.1:${process.env.RDK_SIM2REAL_PORT}`);
  candidates.push('http://127.0.0.1:18104', 'http://127.0.0.1:18102');
  for (const base of [...new Set(candidates)]) {
    try {
      const probe = await api(base, '/api/sim2real/board-station/health', 2500);
      if (probe.status > 0) return base;
    } catch {
      /* candidate down, try next */
    }
  }
  return null;
}

// ---- check registry --------------------------------------------------------
// Each check: {id, label, run} → {ok: boolean, note: string, hint?: string}.
// A check that cannot reach its endpoint is ✗ (fail-visible), never silently
// skipped; the hint says how to fix it.
const checks = [];
const record = (id, label, result) => {
  checks.push({ id, label, ...result });
  const mark = result.ok ? green('✓') : red('✗');
  console.log(`  ${mark} ${label} — ${result.note}`);
  if (result.hint) console.log(dim(`     修复: ${result.hint}`));
};

const fmt = (value, digits = 2) => (typeof value === 'number' ? value.toFixed(digits) : '—');
const volts = (status) => status?.power?.voltage ?? status?.originbot?.batteryVoltage;

// ---- run -------------------------------------------------------------------
let base;
let exitCode = 0;
try {
  base = await resolveBase();
  if (!base) {
    console.error(`${red('✗')} 工作台不可达（18104/18102 均无响应）。先启动:`);
    console.error(dim('  npm run dev:sim2real'));
    process.exit(1);
  }

  console.log(`\n${bold('演示预检（全部只读 GET）')} — 工作台 ${base}`);

  // 1. 板端 agent 健康
  const health = await api(base, '/api/sim2real/board-station/health');
  const healthBody = health.body;
  const agentMock = healthBody?.agent?.mock !== false;
  const device = healthBody?.device;
  if (health.status === 200 && healthBody?.ok) {
    record('agent', '板端 agent', {
      ok: true,
      note: `${device ? `${device.name} (${device.boardModel ?? device.id}) · ` : ''}${agentMock ? 'mock 参考数据（彩排可用，非真机）' : 'mock=false 真实板卡'}`,
      ...(agentMock && !flag('strict')
        ? {
            hint: '接真机: .env 里 RDK_SIM2REAL_BOARD_AGENT_URL 指向板端 http://<IP>:19100（或经 device-connection 隧道），重启 dev:sim2real',
          }
        : {}),
    });
  } else {
    record('agent', '板端 agent', {
      ok: false,
      note: `不可达 — HTTP ${health.status} ${healthBody?.error || healthBody?.message || ''}`.trim(),
      hint: '重建 SSH 隧道后 ssh root@<板IP> systemctl restart rdk-board-agent；本机先 npm run dev:sim2real',
    });
    exitCode = 3;
  }
  if (agentMock && flag('strict')) {
    console.log(`\n${yellow('✗ --strict: 当前是 mock 参考 agent')}`);
    process.exit(2);
  }

  // 2. 设备隧道（web-managed）
  const connections = await api(base, '/api/sim2real/device-connections');
  const list = Array.isArray(connections.body?.connections) ? connections.body.connections : null;
  if (connections.status === 200 && list) {
    const active = list.filter((item) => item.tunnelActive);
    if (!list.length) {
      record('tunnel', '设备隧道', {
        ok: true,
        note: '无 web 管理的连接记录（若走直连 IP/Local Bridge 则不需要）',
      });
    } else if (active.length) {
      record('tunnel', '设备隧道', {
        ok: true,
        note: `${active.length}/${list.length} 条活跃 — ${active
          .map((item) => `${item.label || item.host}:${item.agentPort ?? 19100}`)
          .join(' · ')}`,
      });
    } else {
      record('tunnel', '设备隧道', {
        ok: false,
        note: `${list.length} 条记录但隧道均未连接（最近检查: ${
          list.find((item) => item.lastCheckOk === false) ? '有失败项' : '—'
        }）`,
        hint: 'station 页对该连接点「连接」重建隧道，或在 .env 直接指向板端 IP',
      });
      exitCode = 3;
    }
  } else {
    // Offline single-user mode has no connection records; not fatal.
    record('tunnel', '设备隧道', {
      ok: true,
      note: `连接列表不可读（HTTP ${connections.status}）——单机直连模式下可忽略`,
    });
  }

  // 3. 传感器遥测
  const snap = await api(base, '/api/sim2real/board-station/status');
  const status = snap.body?.status ?? snap.body;
  if (snap.status === 200 && status?.board) {
    const battery = volts(status);
    const imuLive = Boolean(status?.originbot?.imu?.quaternion || status?.imu);
    record('telemetry', '传感器遥测', {
      ok: imuLive || battery != null,
      note: `${status.board.model ?? '—'} ${status.board.mock === false ? '(mock=false)' : '(mock=true)'} · IMU ${imuLive ? '有数据' : '未见'} · 电池 ${battery != null ? `${fmt(battery)} V` : '—'} · CPU ${fmt(status.cpu?.percent, 1)}%`,
      ...(imuLive || battery != null
        ? {}
        : { hint: '板上 systemctl restart rdk-board-agent；确认 TROS 话题 (/imu /odom) 存在' }),
    });
  } else {
    record('telemetry', '传感器遥测', {
      ok: false,
      note: `不可达 — HTTP ${snap.status}（${snap.body?.reason || snap.body?.message || 'offline'}）`,
      hint: '重建隧道后重启板端 agent；退路: RDK_SIM2REAL_BOARD_AGENT_URL 指向 local-board-agent（页脚会标注模拟）',
    });
    exitCode = 3;
  }

  // 4. 策略开关（只读）
  const policy = await api(base, '/api/sim2real/board-station/policy');
  if (policy.status === 200 && policy.body?.ok) {
    const p = policy.body.policy ?? {};
    record('policy-switch', '策略运行时', {
      ok: true,
      note: `平台开关 ${policy.body.platformEnabled ? 'on' : 'off'} · 板端 ${p.enabled ? 'enabled' : 'disabled'} · runtime ${p.runtimeRunning ? 'running' : 'stopped'} · state=${p.state ?? 'null'}`,
      ...(policy.body.platformEnabled && p.enabled
        ? {}
        : {
            hint: '只演示加载/推理时保持关闭即可（start 会被安全拒绝并给出原因）；要运动: Mac 侧 RDK_SIM2REAL_STATION_POLICY_ENABLED=1 + 板端 agent.env ENABLE_POLICY=1',
          }),
    });
  } else {
    record('policy-switch', '策略运行时', {
      ok: false,
      note: `不可达 — HTTP ${policy.status}（本地参考 agent 不实现该端点）`,
    });
  }

  // 5. 驱动开关（只读）
  const drive = await api(base, '/api/sim2real/board-station/drive');
  if (drive.status === 200 && drive.body?.ok) {
    const d = drive.body.drive ?? {};
    const bothOn = drive.body.platformEnabled === true && d.enabled === true;
    record('drive-switch', '驱动闸门', {
      ok: true,
      note: `平台 ${drive.body.platformEnabled ? 'on' : 'off'} / 板端 ${d.enabled ? 'on' : 'off'}${drive.body.gates ? ` · gates ${drive.body.gates.ready ? 'ready' : 'blocked'}` : ''} · 钳制 ≤ ${fmt(drive.body.actuatorPolicy?.maxLinear)} m/s`,
      ...(bothOn
        ? {}
        : {
            hint: '不做运动演示时关闭是正常安全态（POST /drive 409 拒绝且不触达板端）；要运动: 双开 + docs/actuator-drive.md 闸门',
          }),
    });
  } else {
    record('drive-switch', '驱动闸门', {
      ok: false,
      note: `不可达 — HTTP ${drive.status}（本地参考 agent 不实现该端点）`,
    });
  }

  // 6. 板端策略制品
  const files = await api(base, '/api/sim2real/board-station/policy/files');
  if (files.status === 200 && files.body?.ok && Array.isArray(files.body.policies)) {
    const policies = files.body.policies;
    if (policies.length) {
      record('policy-files', '策略制品', {
        ok: true,
        note: `${policies.length} 个 in ${files.body.dir ?? 'policies/'} — ${policies
          .slice(0, 3)
          .map((item) => `${item.name} ${item.bytes ? `(${Math.round(item.bytes / 1024)}KB)` : ''}`)
          .join(' · ')}`,
        ...(policies.some((item) => /\.onnx$/i.test(item.name))
          ? {}
          : {
              hint: '没有 .onnx 制品: scp policy.onnx 到板端 /root/rdk-board-agent/policies/（或用 station 页 stage 按钮）',
            }),
      });
    } else {
      record('policy-files', '策略制品', {
        ok: false,
        note: '板端 policies/ 目录为空',
        hint: 'npm run demo:starter 生成真训练制品后 scp 上板；维度须与 agent.env 的 OBS_DIM/ACTION_DIM 一致',
      });
      exitCode = 3;
    }
  } else {
    record('policy-files', '策略制品', {
      ok: false,
      note: `不可达 — HTTP ${files.status}（本地参考 agent 不实现该端点）`,
    });
  }

  // ---- summary ----
  const failed = checks.filter((item) => !item.ok);
  // mock/501-style "endpoint unreachable" failures are rehearsal-able gaps of
  // the reference agent, not demo blockers — only hard board problems are.
  const referenceGap = (item) =>
    item.note.includes('本地参考 agent 不实现该端点') ||
    (agentMock && (item.id === 'telemetry' || item.id === 'policy-files'));
  const critical = failed.filter(
    (item) => ['agent', 'telemetry', 'policy-files'].includes(item.id) && !referenceGap(item),
  );
  const verdict = failed.length === 0 ? 'ok' : critical.length ? 'blocked' : 'degraded';
  console.log(
    `\n${failed.length === 0 ? green('✓ 预检通过') : critical.length ? red('✗ 有阻断项') : yellow('⚠ 有降级项（不阻断演示）')}: ${checks.length - failed.length}/${checks.length} 项通过`,
  );
  if (failed.length) {
    console.log(dim('  未通过: ' + failed.map((item) => item.label).join(' / ')));
  }
  if (flag('json')) {
    console.log(
      JSON.stringify(
        { base, verdict, checks: checks.map(({ id, label, ok }) => ({ id, label, ok })) },
        null,
        2,
      ),
    );
  }
  process.exitCode = verdict === 'ok' ? 0 : verdict === 'degraded' ? 0 : exitCode || 3;
} catch (error) {
  console.error(`${red('✗')} ${error.message}`);
  process.exit(1);
}
