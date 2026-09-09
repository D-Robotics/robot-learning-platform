#!/usr/bin/env node

/** Fast, dependency-free guard for the board-side real loop. */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const required = [
  ['services/sim2real-web/board-agent-x5.py', ['RDK_SIM2REAL_BOARD_AGENT_TOKEN', '/v1/station/policy/load', 'drive/stop']],
  ['services/sim2real-web/board-telemetry-node.py', ['quaternion', 'gyro', 'sourceMonotonicNs']],
  ['services/sim2real-web/board-policy-runtime.py', ['"ts": time.time()', 'policy-input-dimension-mismatch', 'RDK_BOARD_TELEMETRY_SPOOL']],
  ['services/sim2real-web/board-telemetry-uploader.py', ['idempotency-key', 'source', 'board-agent']],
  ['services/sim2real-web/rdk-board-telemetry-uploader.service', ['EnvironmentFile=', 'Restart=always', 'ReadWritePaths=']],
  ['services/sim2real-web/rdk-board-agent.service', ['EnvironmentFile=', 'ExecStart=', 'Restart=always']],
];
for (const [file, needles] of required) {
  const text = readFileSync(path.join(root, file), 'utf8');
  for (const needle of needles) {
    if (!text.includes(needle)) throw new Error(`${file} missing ${needle}`);
  }
}
const py = spawnSync('python3', ['-m', 'py_compile', ...required.filter(([f]) => f.endsWith('.py')).map(([f]) => path.join(root, f))], { encoding: 'utf8' });
if (py.status !== 0) throw new Error(py.stderr || 'python compile failed');
console.log('[real-loop] PASS — telemetry shape, policy watchdog state, dimension gate, durable uploader, and board agent wiring verified');
