/** Exercise the distributed authorization module, including real process restarts. */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

export function verifyPluginAuthRelease(directory) {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const env = {
    ...process.env,
    RDK_PLUGIN_AUTH_TEST_MODULE: pathToFileURL(
      path.join(path.resolve(directory), 'scripts/plugin-auth.mjs'),
    ).href,
  };
  // Builds invoked by node:test need an independent runner, not a recursive test child.
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=tap', path.join(root, 'scripts/plugin-auth.test.mjs')],
    {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  const count = (name) =>
    Number(new RegExp(`^# ${name} (\\d+)$`, 'm').exec(result.stdout || '')?.[1]);
  const tests = count('tests');
  if (
    result.error ||
    result.status !== 0 ||
    tests < 18 ||
    !Number.isFinite(tests) ||
    count('pass') !== tests ||
    count('fail') !== 0 ||
    count('skipped') !== 0 ||
    count('cancelled') !== 0
  ) {
    throw new Error(
      'Browser authorization release gate failed; do not distribute this package.\n' +
        (result.stdout || '') +
        (result.stderr || '') +
        (result.error?.message || ''),
    );
  }
  return { passed: true, tests, target: 'distributed-plugin-auth', processRestartVerified: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== '--plugin-dir')
    throw new Error(
      'Usage: node scripts/verify-plugin-auth-release.mjs --plugin-dir <distribution>',
    );
  console.log(JSON.stringify(verifyPluginAuthRelease(process.argv[3])));
}
