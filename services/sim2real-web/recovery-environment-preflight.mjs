/** Read-only probe beside the trusted recovery adapter; never executes training args. */
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
export async function recoveryEnvironmentPreflight(config, environment, run = execute) {
  if (
    !path.isAbsolute(config?.executable ?? '') ||
    !path.isAbsolute(config?.args?.[0] ?? '') ||
    path.basename(config.args[0]) !== 'workshop_adapter.py'
  )
    throw Error('recovery adapter not configured');
  const env = Object.fromEntries(
    Object.entries(environment).filter(([key]) =>
      [
        'PATH',
        'HOME',
        'LANG',
        'LD_LIBRARY_PATH',
        'CUDA_VISIBLE_DEVICES',
        'MUJOCO_GL',
        'EGL_DEVICE_ID',
        'ORIGINMAN_SCENE',
        'ORIGINMAN_TRAIN_DEVICE',
      ].includes(key),
    ),
  );
  env.RDK_PREFLIGHT_TASK_ID = 'originman-recovery';
  env.ORIGINMAN_TRAIN_DEVICE = 'cuda';
  const { stdout } = await run(
    config.executable,
    [path.join(path.dirname(config.args[0]), 'preflight.py')],
    { env, timeout: 45000, maxBuffer: 65536, windowsHide: true },
  );
  const report = JSON.parse(stdout);
  if (
    report?.schemaVersion !== 1 ||
    report.engine !== 'originman-recovery' ||
    report.taskId !== 'originman-recovery' ||
    report.trainingPerformed !== false ||
    !Array.isArray(report.checks)
  )
    throw Error('invalid recovery preflight evidence');
  return report;
}
