import assert from 'node:assert/strict';
import test from 'node:test';
import { recoveryEnvironmentPreflight } from './recovery-environment-preflight.mjs';
test('executes only trusted probe with bounded resources and without inherited credentials', async () => {
  const report = {
    schemaVersion: 1,
    engine: 'originman-recovery',
    taskId: 'originman-recovery',
    trainingPerformed: false,
    checks: [],
  };
  const result = await recoveryEnvironmentPreflight(
    { executable: '/venv/python', args: ['/course/workshop_adapter.py'] },
    {
      PATH: '/bin',
      ORIGINMAN_SCENE: '/scene.xml',
      RDK_SIM2REAL_TOKEN: 'secret',
      SSO_COOKIE: 'private',
    },
    async (exe, args, opts) => {
      assert.equal(exe, '/venv/python');
      assert.deepEqual(args, ['/course/preflight.py']);
      assert.equal(opts.env.ORIGINMAN_TRAIN_DEVICE, 'cuda');
      assert.equal(opts.env.RDK_SIM2REAL_TOKEN, undefined);
      assert.equal(opts.env.SSO_COOKIE, undefined);
      assert.equal(opts.timeout, 45000);
      return { stdout: JSON.stringify(report) };
    },
  );
  assert.deepEqual(result, report);
  await assert.rejects(
    recoveryEnvironmentPreflight({ executable: '/python', args: ['/arbitrary.py'] }, {}),
  );
  await assert.rejects(
    recoveryEnvironmentPreflight(
      { executable: '/python', args: ['/course/workshop_adapter.py'] },
      {},
      async () => ({ stdout: '{"trainingPerformed":true}' }),
    ),
  );
});
