#!/usr/bin/env node
/**
 * OriginBot live demo helper — one command for the read-only parts of
 * docs/demo-originbot-runbook.md (sections 0 / 6 / 9 preflight).
 *
 * Default (read-only): connection check, telemetry snapshot, policy & drive
 * gate states, and demo entry links. Never commands motion.
 *
 *   node scripts/demo-originbot-live.mjs
 *   node scripts/demo-originbot-live.mjs --watch 30
 *   node scripts/demo-originbot-live.mjs --stop
 *   node scripts/demo-originbot-live.mjs --canary --present   # 低速金丝雀
 *   node scripts/demo-originbot-live.mjs --require-real      # mock 时失败
 *
 * The script never bypasses safety gates: motion still requires both switches
 * from docs/actuator-drive.md and an explicit --present (operator on site).
 */

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const num = (name, fallback) => {
  const value = Number(opt(name, fallback));
  return Number.isFinite(value) ? value : fallback;
};

if (flag('help') || flag('h')) {
  console.log(`用法: node scripts/demo-originbot-live.mjs [选项]

选项:
  --url <base>        工作台地址（默认自动探测 18104 / 18102 / RDK_SIM2REAL_PORT）
  --watch <秒>        以 1 Hz 持续打印遥测流，Ctrl+C 随时退出
  --stop              急停（绕过所有开关，任何时候可用）
  --canary            低速运动金丝雀：零速 1s → 低速 2s → 急停收尾
  --present           金丝雀必需：确认操作者人在场、场地清空、急停可用
  --linear <m/s>      金丝雀线速度（默认 0.05，钳制 ≤ 0.30）
  --angular <rad/s>   金丝雀角速度（默认 0，钳制 |·| ≤ 1.0）
  --duration <秒>     金丝雀时长（默认 2，钳制 0.2–2.0）
  --require-real      连接的是 mock 参考 agent 时以退出码 2 失败
  --no-color          禁用 ANSI 颜色`);
  process.exit(0);
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR && !flag('no-color');
const c = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const green = (t) => c('32', t);
const red = (t) => c('31', t);
const yellow = (t) => c('33', t);
const dim = (t) => c('2', t);
const bold = (t) => c('1', t);

const section = (title) => console.log(`\n${bold(title)}`);
const kv = (label, value) => console.log(`  ${dim(label.padEnd(14, '　'))} ${value}`);

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const stripTrailingSlash = (url) => url.replace(/\/$/, '');

async function api(base, path, init = {}, timeoutMs = 6000) {
  const response = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: response.status, body };
}

async function resolveBase() {
  const candidates = [];
  if (opt('url')) candidates.push(stripTrailingSlash(opt('url')));
  if (process.env.RDK_SIM2REAL_DEMO_URL) candidates.push(stripTrailingSlash(process.env.RDK_SIM2REAL_DEMO_URL));
  if (process.env.RDK_SIM2REAL_PORT) candidates.push(`http://127.0.0.1:${process.env.RDK_SIM2REAL_PORT}`);
  candidates.push('http://127.0.0.1:18104', 'http://127.0.0.1:18102');
  for (const base of [...new Set(candidates)]) {
    try {
      const probe = await api(base, '/api/sim2real/board-station/health', {}, 2500);
      if (probe.status > 0) return base; // service answered; agent health is judged below
    } catch { /* candidate down, try next */ }
  }
  return null;
}

const yawFromQuaternion = (q) => {
  if (!q || typeof q.x !== 'number') return null;
  const yaw = Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z));
  return Math.round((yaw * 180) / Math.PI * 10) / 10;
};

const fmt = (value, digits = 2) => (typeof value === 'number' ? value.toFixed(digits) : '—');
const volts = (status) => status?.power?.voltage ?? status?.originbot?.batteryVoltage;

const realBoardHint = [
  '接真机三步（当前是本地参考 agent 的模拟数据）:',
  `  1. OriginBot 上电并接入同一网络，拿到板卡 IP；板端 agent: ssh root@<IP> systemctl status rdk-board-agent`,
  '  2. .env 中把 RDK_SIM2REAL_BOARD_AGENT_URL 改为 http://<IP>:19100（token 在板端 root-only env，本仓库不含）',
  '  3. 重启 npm run dev:sim2real 后重跑本脚本，应显示 mock=false',
  dim('  更新板端 agent: RDK_X5_SSH_TARGET=root@<IP> bash scripts/deploy-x5-board-agent.sh'),
  dim('  SSH 隧道方式: 先停本地参考 agent，再 ssh -N -L 19100:127.0.0.1:19100 root@<IP>'),
].join('\n');

const summary = { base: null, serviceUp: false, agentMock: null, device: null, telemetry: null, motion: null, exitCode: 0 };

try {
  const base = await resolveBase();
  summary.base = base;
  if (!base) {
    console.error(`${red('✗')} 工作台不可达（18104/18102 均无响应）。先启动:`);
    console.error(dim('  npm run dev:sim2real'));
    process.exit(1);
  }
  summary.serviceUp = true;

  // ---------- 1. 连接体检 ----------
  section('1. 平台与设备连接');
  const health = await api(base, '/api/sim2real/board-station/health');
  const healthBody = health.body;
  const agentMock = healthBody?.agent?.mock !== false;
  summary.agentMock = agentMock;
  kv('工作台', base);
  kv('设备', healthBody?.device ? `${healthBody.device.name} (${healthBody.device.id}) · ${healthBody.device.status}` : '—');
  kv('板型', healthBody?.device ? `${healthBody.device.boardPlatform} · ${healthBody.device.boardModel}` : '—');
  kv('agent 能力', (healthBody?.agent?.capabilities || []).join(' / ') || '—');
  kv('相机', healthBody?.cameraSupported ? '支持 (MJPEG)' : '不支持');
  if (agentMock) {
    console.log(`  ${yellow('⚠ 当前是本地参考 agent（mock=true，模拟遥测）——适合彩排，不是真机数据')}`);
    if (flag('require-real')) { console.log(realBoardHint); process.exit(2); }
  } else {
    console.log(`  ${green('✓ 已连接真实板端 agent（mock=false）')}`);
  }

  // ---------- 2. 遥测快照 ----------
  section('2. 遥测快照（只读）');
  const snap = await api(base, '/api/sim2real/board-station/status');
  const status = snap.body?.status ?? snap.body;
  if (!status) {
    console.log(`  ${yellow('⚠ 遥测不可达')}: HTTP ${snap.status} ${snap.body?.code || snap.body?.error || ''}`.trim());
  } else {
    summary.telemetry = {
      board: status.board?.model ?? null,
      mock: status.board?.mock ?? null,
      batteryVoltage: volts(status) ?? null,
      topics: status.topics?.length ?? 0,
    };
    kv('板卡', `${status.board?.model ?? '—'} ${status.board?.mock === false ? green('(mock=false)') : yellow('(mock=true)')}`);
    kv('CPU / 温度', `${fmt(status.cpu?.percent, 1)}% / ${fmt(status.cpu?.temperatureC, 1)}°C`);
    kv('内存', `${fmt(status.memory?.usedMB, 0)} / ${fmt(status.memory?.totalMB, 0)} MB`);
    kv('网络', `rx ${fmt(status.network?.rxKbPerSec, 0)} KB/s · tx ${fmt(status.network?.txKbPerSec, 0)} KB/s`);
    const battery = volts(status);
    kv('电源', battery != null ? `${fmt(battery)} V${status.power?.current != null ? ` · ${fmt(status.power?.current)} A` : ''}` : '—');
    kv('IMU 航向', status.originbot?.imu ? `yaw ${fmt(yawFromQuaternion(status.originbot.imu), 1)}°（四元数实时解算）` : '—');
    kv('里程计', status.originbot?.odom
      ? `pos (${fmt(status.originbot.odom.positionX)}, ${fmt(status.originbot.odom.positionY)}) · v ${fmt(status.originbot.odom.linearX)} m/s · w ${fmt(status.originbot.odom.angularZ)} rad/s`
      : '—');
    kv('TROS 话题', status.topics ? `${status.topics.length} 个（${status.topics.slice(0, 4).map((t) => t.name).join(' ')}${status.topics.length > 4 ? ' …' : ''}）` : '—');
    kv('已运行', status.uptimeSec != null ? `${Math.floor(status.uptimeSec / 60)} 分钟` : '—');
  }

  // ---------- 3. 策略与驱动闸门（只读状态） ----------
  section('3. 策略与驱动闸门（只读状态，开关默认关闭是正常安全态）');
  const policy = await api(base, '/api/sim2real/board-station/policy');
  if (policy.body?.ok) {
    const p = policy.body.policy ?? {};
    summary.motion = summary.motion ?? {};
    summary.motion.policy = { enabled: p.enabled, runtimeRunning: p.runtimeRunning };
    kv('策略平台开关', policy.body.platformEnabled ? green('on') : 'off');
    kv('策略运行时', `${p.enabled ? 'enabled' : 'disabled'} · ${p.runtimeRunning ? 'running' : 'stopped'} · state=${p.state ?? 'null'}`);
    kv('运动授权', p.motionAuthorized ? yellow('true（允许下发速度）') : 'false（只加载不运动）');
    if (p.limits) kv('板端限速', `maxLinear ${fmt(p.limits.maxLinear)} m/s`);
  } else {
    kv('策略状态', `${yellow('不可达')} — HTTP ${policy.status} ${policy.body?.code || policy.body?.error || ''}`.trim());
  }

  const drive = await api(base, '/api/sim2real/board-station/drive');
  if (drive.body?.ok) {
    const d = drive.body.drive ?? {};
    kv('驱动平台开关', drive.body.platformEnabled ? green('on') : 'off');
    kv('板端驱动开关', d.enabled ? green('on') : 'off');
    kv('运动窗口', d.active ? yellow('ACTIVE') : 'idle');
    kv('最近停止原因', d.lastStopReason ?? '—');
    if (drive.body.gates) kv('闸门就绪', drive.body.gates.ready ? green('ready') : red('blocked'));
    if (drive.body.actuatorPolicy) kv('钳制', `maxLinear ${fmt(drive.body.actuatorPolicy.maxLinear)} m/s · 时长盒 0.2–2.0 s`);
    if (!drive.body.platformEnabled || !d.enabled) {
      console.log(dim('  驱动双开关未全开:POST /drive 会被 409 拒绝(不触达板端)。开启方法见 docs/actuator-drive.md。'));
    }
  } else {
    kv('驱动状态', `${yellow('不可达')} — HTTP ${drive.status} ${drive.body?.code || drive.body?.error || ''}`.trim());
    console.log(dim('  (本地参考 agent 不实现策略/驱动端点;真机 board-agent-x5.py 支持)'));
  }

  // ---------- 4. 演示入口 ----------
  section('4. 演示入口（投屏用）');
  kv('工作台', `${base}/`);
  kv('实时看板', `${base}/originbot-dashboard.html`);
  if (healthBody?.cameraSupported) kv('相机 MJPEG', `${base}/api/sim2real/board-station/camera.mjpeg`);
  if (agentMock) console.log(`\n${yellow(realBoardHint)}`);
  else console.log(dim('\n  遥测流: node scripts/demo-originbot-live.mjs --watch 30'));

  // ---------- 可选模式 ----------
  if (flag('stop')) {
    section('急停');
    const stop = await api(base, '/api/sim2real/board-station/drive/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, 5000);
    console.log(stop.status === 200 && stop.body?.ok
      ? `  ${green('✓')} 已下发急停（绕过所有开关）${stop.body.drive ? ` · lastStopReason=${stop.body.drive.lastStopReason ?? '—'}` : ''}`
      : `  ${red('✗')} 急停请求失败: HTTP ${stop.status} ${stop.body?.code || stop.body?.error || ''}`.trim());
    summary.exitCode = stop.status === 200 && stop.body?.ok ? 0 : 3;
  }

  if (opt('watch')) {
    const seconds = clamp(Math.floor(num('watch', 10)), 1, 600);
    section(`遥测流（${seconds}s · 1 Hz · Ctrl+C 退出）`);
    for (let i = 0; i < seconds; i++) {
      try {
        const poll = await api(base, '/api/sim2real/board-station/status', {}, 3000);
        const s = poll.body?.status ?? poll.body;
        if (!s) throw new Error('no status');
        const imu = s.originbot?.imu;
        const odom = s.originbot?.odom ?? {};
        console.log(`  ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}  bat ${fmt(volts(s))}V  yaw ${fmt(yawFromQuaternion(imu), 1)}°  odom (${fmt(odom.positionX)}, ${fmt(odom.positionY)}) v=${fmt(odom.linearX)} w=${fmt(odom.angularZ)}  cpu ${fmt(s.cpu?.percent, 1)}% ${fmt(s.cpu?.temperatureC, 1)}°C`);
      } catch {
        console.log(`  ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}  ${yellow('… 不可达')}`);
      }
      if (i < seconds - 1) await new Promise((r) => setTimeout(r, 1000));
    }
  }

  if (flag('canary')) {
    section('低速运动金丝雀');
    if (!flag('present')) {
      console.log(`${red('✗ 拒绝执行')}: 金丝雀要求人在场。确认操作者在机器人旁、场地清空、急停可用后，加 --present 重试。`);
      console.log(dim('  本脚本不会无人值守地驱动任何执行器。'));
      summary.exitCode = 4;
    } else {
      const linear = clamp(num('linear', 0.05), 0, 0.3);
      const angular = clamp(num('angular', 0), -1.0, 1.0);
      const duration = clamp(num('duration', 2), 0.2, 2.0);
      const gates = await api(base, '/api/sim2real/board-station/drive');
      if (!gates.body?.ok) {
        console.log(`${red('✗ 驱动状态不可达')} — HTTP ${gates.status} ${gates.body?.code || gates.body?.error || ''}。`.trim());
        console.log(dim('  无法确认双开关状态，拒绝执行且未向板端发送任何运动命令。'));
        summary.exitCode = 5;
      } else if (gates.body.platformEnabled !== true || gates.body.drive?.enabled !== true) {
        console.log(`${red('✗ 闸门未全开')}（平台 ${gates.body.platformEnabled ? 'on' : 'off'} / 板端 ${gates.body.drive?.enabled ? 'on' : 'off'}）——按设计拒绝，未向板端发送任何运动命令。`);
        console.log(dim('  开启: 板端 /root/rdk-board-agent/agent.env 加 RDK_SIM2REAL_BOARD_AGENT_ENABLE_DRIVE=1 并重启服务;'));
        console.log(dim('        平台侧 .env 加 RDK_SIM2REAL_STATION_DRIVE_ENABLED=1 并重启工作台。'));
        summary.exitCode = 5;
      } else {
        const post = (body) => api(base, '/api/sim2real/board-station/drive', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, 8000);
        const stopNow = () => api(base, '/api/sim2real/board-station/drive/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, 5000);
        let interrupted = false;
        const onSigint = () => { interrupted = true; };
        process.on('SIGINT', onSigint);
        try {
          const steps = [
            ['零速验证（完整链路但不动）', { linear: 0, angular: 0, durationSec: 1 }],
            [`低速短窗 ${linear} m/s × ${duration}s`, { linear, angular, durationSec: duration }],
          ];
          for (const [label, body] of steps) {
            if (interrupted) break;
            const res = await post(body);
            if (res.status >= 200 && res.status < 300 && res.body?.ok !== false) {
              console.log(`  ${green('✓')} ${label}: accepted`);
            } else {
              console.log(`  ${red('✗')} ${label}: HTTP ${res.status} ${res.body?.code || res.body?.error || ''} ${res.body?.reason ? `· ${res.body.reason}` : ''}`.trim());
              summary.exitCode = 6;
              break;
            }
            await new Promise((r) => setTimeout(r, body.durationSec * 1000 + 400));
            const after = await api(base, '/api/sim2real/board-station/drive', {}, 4000);
            console.log(dim(`    窗口后: active=${after.body?.drive?.active ?? '—'} lastStopReason=${after.body?.drive?.lastStopReason ?? '—'}`));
          }
        } finally {
          const stop = await stopNow();
          console.log(stop.status === 200 && stop.body?.ok
            ? `  ${green('✓')} 急停收尾完成${stop.body.drive ? ` · lastStopReason=${stop.body.drive.lastStopReason ?? '—'}` : ''}`
            : `  ${red('✗')} 急停失败: HTTP ${stop.status}——现场立即物理断电/按下底盘急停！`);
          process.off('SIGINT', onSigint);
          if (interrupted) { console.log(yellow('  （被 Ctrl+C 中断，已执行急停）')); summary.exitCode = 4; }
        }
      }
    }
  }

  if (summary.exitCode === 0 && summary.agentMock === false) {
    console.log(`\n${green('✓ 演示就绪')}: 真实板端已连接，遥测与闸门状态如实回读。`);
  }
  process.exitCode = summary.exitCode;
} catch (error) {
  console.error(`${red('✗')} ${error.message}`);
  process.exitCode = 1;
}
