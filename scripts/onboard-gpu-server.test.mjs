import assert from 'node:assert/strict';
import { parseArgs, runOnboarding } from './onboard-gpu-server.mjs';

const flags = parseArgs(['--host', 'gpu.example.com', '--user', 'robot', '--port', '2222']);
assert.equal(flags.port, 2222);
assert.throws(() => parseArgs(['--host', 'gpu.example.com;rm', '--user', 'robot']), /invalid/);
assert.throws(
  () => parseArgs(['--host', 'gpu.example.com', '--user', 'robot', '--dir', '/tmp/x;id']),
  /invalid/,
);

const commands = [];
const result = runOnboarding(flags, (_flags, command) => {
  commands.push(command);
  if (command.startsWith('printf')) return { ok: true, status: 0, stdout: 'ready', stderr: '' };
  if (command.startsWith('command -v nvidia-smi'))
    return { ok: true, status: 0, stdout: 'NVIDIA RTX 5090, 32768 MiB, 570.00', stderr: '' };
  if (command.startsWith('python3 -c'))
    return { ok: true, status: 0, stdout: '3.12.1', stderr: '' };
  if (command.startsWith('test -x')) return { ok: true, status: 0, stdout: '', stderr: '' };
  if (command.includes('hb_mapper'))
    return { ok: true, status: 0, stdout: 'hb_mapper 1.24.3', stderr: '' };
  return { ok: true, status: 0, stdout: '{"ok":true,"configured":true}', stderr: '' };
});

assert.equal(result.ok, true);
assert.equal(result.readOnly, true);
assert.equal(result.checks.length, 6);
// The probe set contains fixed `&&` guards, but never interpolates the host,
// user, or arbitrary caller text into a remote command.
assert.ok(commands.every((command) => !command.includes('gpu.example.com')));
assert.ok(commands.every((command) => !/[;|`]\s*(?:rm|sh|bash)\b/.test(command)));
assert.equal(result.next, 'server-ready-for-training-and-compilation');

const blocked = runOnboarding(flags, (_flags, command) => ({
  ok: !command.startsWith('command -v nvidia-smi'),
  status: command.startsWith('command -v nvidia-smi') ? 1 : 0,
  stdout: '',
  stderr: 'missing',
}));
assert.equal(blocked.ok, false);
assert.equal(blocked.next, 'fix-failed-checks-before-training');
console.log('onboard-gpu-server: all tests passed');
