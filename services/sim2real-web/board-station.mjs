#!/usr/bin/env node

/**
 * Host-station (上位机) protocol module shared by the local reference
 * BoardAgent. It defines the wire contract the web workbench's board-station
 * view speaks with a real board agent:
 *
 *   GET  /healthz                                capability + mock/readonly flags
 *   GET  /v1/station/status                      status snapshot (CPU/memory/.../topics)
 *   GET  /v1/station/status/stream               NDJSON heartbeat stream
 *   GET  /v1/station/camera.mjpeg                multipart/x-mixed-replace JPEG stream
 *   POST /v1/station/commands                    read-only allowlisted commands
 *
 * Safety invariants shared with the preflight agent:
 * - token auth (Bearer) when RDK_SIM2REAL_BOARD_AGENT_TOKEN is set
 * - strictly allowlisted commands, never a shell
 * - `actuatorControl: false` is reported honestly; no teleop path exists here
 */

export const STATION_STATUS_INTERVAL_MS = 1000;
export const STATION_CAMERA_INTERVAL_MS = 200;
export const STATION_MAX_STREAM_CLIENTS = 4;

/** Allowlisted host-station commands with a fixed description + timeout. */
export const STATION_COMMANDS = [
  {
    id: 'list-tros-nodes',
    label: 'TROS 节点列表',
    description: '读取板端 TROS 节点（ros2 node list 的只读等价信息）',
    timeoutMs: 8000,
  },
  {
    id: 'list-tros-topics',
    label: 'TROS 话题列表',
    description: '读取板端 TROS 话题（ros2 topic list 的只读等价信息）',
    timeoutMs: 8000,
  },
  {
    id: 'disk-usage',
    label: '磁盘用量',
    description: '读取板端磁盘用量（df 的只读等价信息）',
    timeoutMs: 5000,
  },
  {
    id: 'service-status',
    label: '服务状态',
    description: '读取板端关键服务状态（systemctl is-active 的只读等价信息）',
    timeoutMs: 5000,
  },
];

export function isStationCommandId(id) {
  return STATION_COMMANDS.some((command) => command.id === id);
}

/**
 * Compute one synthetic status snapshot. `startedAt` keeps the uptime honest;
 * `frame` advances so callers can watch values change over the stream.
 */
export function buildStationStatus({ startedAtMs, tick }) {
  const now = Date.now();
  const uptimeSec = Math.max(0, Math.floor((now - startedAtMs) / 1000));
  const wave = (offset, scale, base) =>
    Number((base + scale * Math.sin((tick + offset) / 9)).toFixed(2));
  return {
    timestamp: new Date(now).toISOString(),
    board: {
      platform: 'rdk-x5',
      model: 'RDK X5 (simulated)',
      mock: true,
    },
    cpu: { percent: wave(0, 8, 22), temperatureC: wave(3, 3, 46) },
    memory: {
      totalMB: 4096,
      usedMB: Math.round(1200 + 200 * Math.sin(tick / 7)),
    },
    disk: { totalMB: 32768, usedMB: 10496 },
    network: {
      mode: 'ethernet',
      rxKbPerSec: Math.max(0, Math.round(wave(1, 400, 900))),
      txKbPerSec: Math.max(0, Math.round(wave(5, 300, 700))),
    },
    power: { voltage: wave(2, 0.2, 11.9), current: wave(4, 0.6, 2.1) },
    topics: [
      { name: '/tf', hz: 30 },
      { name: '/joint_states', hz: 50 },
      { name: '/camera/image_raw', hz: 15 },
      { name: '/imu/data', hz: 100 },
    ],
    uptimeSec,
    actuatorControl: false,
  };
}

/**
 * Render one allowlisted command result. Real agents map ids to their own
 * read-only probes; the reference agent returns bounded synthetic output.
 */
export function buildStationCommandResult(id, { tick }) {
  const command = STATION_COMMANDS.find((item) => item.id === id);
  if (!command) return null;
  const lines = [];
  if (id === 'list-tros-nodes') {
    lines.push('/odom_publisher', '/joint_state_publisher', '/camera_pipeline', '/imu_driver');
  } else if (id === 'list-tros-topics') {
    lines.push('/tf', '/joint_states', '/camera/image_raw', '/imu/data', '/cmd_vel');
  } else if (id === 'disk-usage') {
    lines.push(
      'Filesystem      Size  Used Avail Use%',
      '/dev/mmcblk1p1   32G   11G   21G  35%',
      `tmpfs            16G  ${Math.round(200 + 20 * Math.sin(tick / 5))}M   16G   1%`,
    );
  } else if (id === 'service-status') {
    lines.push('tros: active', 'hobot-camera: active', 'nvram: active');
  }
  return {
    ok: true,
    id,
    output: lines.join('\n'),
    mock: true,
    actuatorControl: false,
    executedAt: new Date().toISOString(),
  };
}
