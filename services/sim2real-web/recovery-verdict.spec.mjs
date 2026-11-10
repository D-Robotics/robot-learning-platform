import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveryVerdict } from './public/recovery-verdict.mjs';
test('legacy summary separates standing and refuses incomplete evidence', () => {
  const cases = Array.from({ length: 31 }, (_, i) => ({
    force: i === 30 ? 0 : 8,
    original: i > 17,
    tuned: i > 13,
    rl: i === 30,
  }));
  const result = recoveryVerdict(cases, false, false, true);
  assert.match(result, /受扰恢复：原 PD 12\/30，调参反馈 16\/30，RL 0\/30/);
  assert.match(result, /无扰站立：原 PD 1\/1，调参反馈 1\/1，RL 1\/1/);
  assert.match(recoveryVerdict([{}], false, false, true), /尚未验证/);
});
