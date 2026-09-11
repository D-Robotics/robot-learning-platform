#!/usr/bin/env node

/**
 * Read-only acceptance gate for a new GPU server + OriginBot.
 *
 * This script deliberately does not start training, upload a model, enable a
 * drive switch, or publish /cmd_vel. It proves that the prerequisites for
 * those actions are reachable and reports the exact missing gate. A real
 * release still needs a separate, explicitly confirmed motion run.
 *
 * Configure endpoints with environment variables (see docs/new-originbot-
 * server-runbook.md) and run `npm run accept:new-device -- --json`.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const args = new Set(process.argv.slice(2));
const jsonOutput = args.has('--json');
const allowMissing = args.has('--allow-missing');
const timeoutMs = Number(process.env.RDK_ACCEPTANCE_TIMEOUT_MS || 5000);
const checks = [];

function add(name, status, detail, hint = '') {
  checks.push({ name, status, detail, ...(hint ? { hint } : {}) });
}

function env(name) {
  return String(process.env[name] || '').trim();
}

function authHeaders(tokenName) {
  const token = env(tokenName);
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function getJson(name, url, headers = {}) {
  if (!url) {
    add(name, 'blocked', '未配置 endpoint', '设置对应的 RDK_ACCEPTANCE_* 环境变量后重试');
    return null;
  }
  try {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(Number.isFinite(timeoutMs) ? timeoutMs : 5000),
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { text: text.slice(0, 240) };
    }
    if (!response.ok) {
      add(name, 'blocked', `HTTP ${response.status} ${body?.error || body?.message || ''}`.trim());
      return null;
    }
    add(name, 'pass', `HTTP ${response.status}`);
    return body;
  } catch (error) {
    add(name, 'blocked', error instanceof Error ? error.message : String(error));
    return null;
  }
}

function url(base, suffix) {
  return `${String(base).replace(/\/+$/, '')}${suffix}`;
}

function run(command, commandArgs, options = {}) {
  return spawnSync(command, commandArgs, {
    encoding: 'utf8',
    timeout: Number.isFinite(timeoutMs) ? timeoutMs : 5000,
    ...options,
  });
}

function checkLocalRuntime() {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  add(
    '本地 Node.js',
    nodeMajor >= 20 ? 'pass' : 'blocked',
    `${process.version}（需要 Node 20+）`,
  );
  const python = env('RDK_STARTER_ENGINE_PYTHON') || 'python3';
  const probe = run(python, ['-c', 'import torch, onnx; print(torch.__version__)']);
  add(
    '本地 Python/训练依赖',
    probe.status === 0 ? 'pass' : 'warn',
    probe.status === 0 ? probe.stdout.trim() : 'torch 或 onnx 不可用（远程 worker 仍可承担训练）',
    '在训练服务器运行 npm run doctor',
  );
}

function checkSshServer() {
  const host = env('RDK_ACCEPTANCE_SERVER_HOST');
  if (!host) {
    add(
      'GPU 服务器 SSH',
      'blocked',
      '未配置 RDK_ACCEPTANCE_SERVER_HOST',
      '设置主机、用户和端口；例如 RDK_ACCEPTANCE_SERVER_HOST=10.0.0.20',
    );
    return;
  }
  const user = env('RDK_ACCEPTANCE_SERVER_USER') || 'root';
  const port = env('RDK_ACCEPTANCE_SERVER_PORT') || '22';
  const identity = env('RDK_ACCEPTANCE_SERVER_IDENTITY');
  const sshArgs = [
    '-o',
    'BatchMode=yes',
    '-o',
    `ConnectTimeout=${Math.max(1, Math.ceil(timeoutMs / 1000))}`,
    '-p',
    port,
  ];
  if (identity) sshArgs.push('-i', identity);
  sshArgs.push(`${user}@${host}`, 'nvidia-smi --query-gpu=name --format=csv,noheader');
  const result = run('ssh', sshArgs);
  if (result.status === 0 && result.stdout.trim()) {
    add('GPU 服务器 SSH/GPU', 'pass', `${user}@${host}:${port} · ${result.stdout.trim()}`);
  } else {
    add(
      'GPU 服务器 SSH/GPU',
      'blocked',
      (result.stderr || result.stdout || 'ssh 失败').trim().slice(0, 240),
      '确认公钥认证、端口、防火墙和 nvidia-smi',
    );
  }
}

function checkCompiler() {
  const compiler = env('RDK_BPU_COMPILER');
  if (!compiler) {
    add(
      'HBDK 编译器',
      'blocked',
      '未配置 RDK_BPU_COMPILER',
      '设置 hb_mapper 或平台提供的受信任编译器绝对路径；不能把 ONNX 改名为 .bin',
    );
    return;
  }
  const result = run(compiler, ['--version']);
  add(
    'HBDK 编译器',
    result.status === 0 ? 'pass' : 'blocked',
    result.status === 0 ? (result.stdout || result.stderr).trim().slice(0, 240) : (result.stderr || '执行失败').trim(),
    result.status === 0 ? '' : '安装与 X5 匹配的 HBDK/OpenExplorer 工具链',
  );
}

function checkArtifact() {
  const artifact = env('RDK_ACCEPTANCE_POLICY_ARTIFACT');
  if (!artifact) {
    add(
      '策略 artifact',
      'blocked',
      '未配置 RDK_ACCEPTANCE_POLICY_ARTIFACT',
      '训练并编译后设置为 .bin（或先用 ONNX 进行只读预检）',
    );
    return;
  }
  try {
    const bytes = readFileSync(path.resolve(artifact));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const ext = path.extname(artifact).toLowerCase();
    add(
      '策略 artifact',
      ext === '.bin' || ext === '.onnx' ? 'pass' : 'blocked',
      `${path.resolve(artifact)} · ${bytes.length} bytes · sha256 ${sha256}`,
      ext === '.bin' || ext === '.onnx' ? '' : 'artifact 必须是 .onnx 或经过 HBDK 的 .bin',
    );
  } catch (error) {
    add('策略 artifact', 'blocked', error instanceof Error ? error.message : String(error));
  }
}

async function main() {
  checkLocalRuntime();
  checkSshServer();
  checkCompiler();
  checkArtifact();

  const platform = env('RDK_ACCEPTANCE_PLATFORM_URL') || env('RDK_SIM2REAL_DEMO_URL');
  if (!platform) {
    add('平台 API', 'blocked', '未配置 RDK_ACCEPTANCE_PLATFORM_URL', '例如 http://127.0.0.1:18102');
  } else {
    const headers = authHeaders('RDK_ACCEPTANCE_PLATFORM_TOKEN');
    await getJson('平台健康检查', url(platform, '/healthz'), headers);
    const overview = await getJson('平台工作区/设备清单', url(platform, '/api/sim2real/overview'), headers);
    if (overview) {
      const devices = Array.isArray(overview.devices) ? overview.devices.length : 0;
      add('平台设备注册', devices > 0 ? 'pass' : 'blocked', `${devices} 个设备`, '先在设备连接页登记 OriginBot');
    }
  }

  const worker = env('RDK_ACCEPTANCE_WORKER_URL') || env('RDK_SIM2REAL_LOCAL_RUNNER_URL');
  if (!worker) {
    add('GPU worker API', 'blocked', '未配置 RDK_ACCEPTANCE_WORKER_URL', '例如 http://127.0.0.1:19091/train');
  } else {
    const health = worker.replace(/\/train\/?$/, '/healthz').replace(/\/+$/, '/healthz');
    const body = await getJson('GPU worker 健康检查', health, authHeaders('RDK_SIM2REAL_LOCAL_RUNNER_TOKEN'));
    if (body && body.configured !== true)
      add('GPU worker 真实引擎', 'blocked', 'worker 可达但 configured=false', '设置 RDK_SIM2REAL_TRAIN_EXECUTABLE 和 RDK_SIM2REAL_TRAIN_ARGS_JSON');
  }

  const board = env('RDK_ACCEPTANCE_BOARD_URL') || env('RDK_SIM2REAL_BOARD_AGENT_URL');
  if (!board) {
    add('OriginBot board-agent', 'blocked', '未配置 RDK_ACCEPTANCE_BOARD_URL', '例如 http://10.0.0.30:19100');
  } else {
    const headers = authHeaders('RDK_SIM2REAL_BOARD_AGENT_TOKEN');
    const health = await getJson('OriginBot board-agent 健康检查', url(board, '/healthz'), headers);
    if (health && health.mock !== false)
      add('OriginBot 真实设备门禁', 'blocked', `mock=${String(health.mock)}`, '必须连接真实 board-agent，mock=true 只能用于协议演练');
    const status = await getJson('OriginBot 真实遥测', url(board, '/v1/station/status'), headers);
    if (status) {
      const real = status?.board?.mock === false || status?.mock === false;
      const imu = status?.originbot?.imu != null || status?.imu != null;
      const odom = status?.originbot?.odom != null || status?.odom != null;
      add('OriginBot IMU/odom', real && imu && odom ? 'pass' : 'blocked', `real=${real} imu=${imu} odom=${odom}`, '检查 /imu、/odom 发布和 board-agent 遥测适配');
    }
    await getJson('OriginBot 策略文件清单', url(board, '/v1/station/policy/files'), headers);
  }

  const blocked = checks.filter((item) => item.status === 'blocked').length;
  const warnings = checks.filter((item) => item.status === 'warn').length;
  const result = {
    ok: blocked === 0,
    readOnly: true,
    motionCommandsSent: 0,
    checks,
    summary: { passed: checks.filter((item) => item.status === 'pass').length, blocked, warnings },
  };
  if (jsonOutput) console.log(JSON.stringify(result, null, 2));
  else {
    console.log('\n新服务器 + OriginBot 接入验收（只读）');
    for (const check of checks) console.log(`  ${check.status === 'pass' ? '✓' : check.status === 'warn' ? '!' : '✗'} ${check.name} — ${check.detail}`);
    console.log(`\n结论：${result.ok ? 'PASS，可进入训练/部署阶段' : `BLOCKED，${blocked} 个前置条件未满足`}（未发送运动指令）`);
    for (const check of checks.filter((item) => item.hint)) console.log(`  ↳ ${check.hint}`);
  }
  if (blocked > 0 && !allowMissing) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[accept:new-device] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

