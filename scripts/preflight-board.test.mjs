#!/usr/bin/env node
/**
 * Self-test for scripts/preflight-board.sh.
 *
 * The SSH transport is replaced by a stub on PATH so no network or board is
 * needed.  Covered here: local grammar/profile rejection before any SSH, and
 * the evidence rule wrapper (a passing board transcript exits 0 and prints
 * the mock:false guidance; a failing transcript exits 1 and prints the
 * keep-mock guidance).  The remote probe body itself is exercised for real by
 * running the preflight against an actual board; see the S100 provenance note
 * in profiles/rdk-s100-generic-drive.json.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/preflight-board.sh');
const syntax = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
assert.equal(syntax.status, 0, 'preflight script must pass bash -n');

function runPreflight({ env, stub }) {
  const stubDir = mkdtempSync(path.join(os.tmpdir(), 'preflight-ssh-stub-'));
  let invokedMarker;
  if (stub) {
    invokedMarker = path.join(stubDir, '.invoked');
    const sshStub = path.join(stubDir, 'ssh');
    writeFileSync(
      sshStub,
      [
        '#!/bin/sh',
        'touch ' + JSON.stringify(invokedMarker),
        'cat > /dev/null',
        "printf '%s\\n' " + JSON.stringify(stub.transcript),
        `exit ${stub.exitCode}`,
        '',
      ].join('\n'),
    );
    chmodSync(sshStub, 0o755);
  }
  const result = spawnSync('bash', [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: stubDir + path.delimiter + process.env.PATH,
      ...env,
    },
  });
  return { ...result, stubInvoked: invokedMarker ? existsSync(invokedMarker) : null };
}

const baseEnv = {
  RDK_X5_SSH_TARGET: 'root@192.0.2.10',
  RDK_X5_PROFILE_NAME: 'rdk-s100-generic-drive.json',
};

const badProfile = runPreflight({
  env: { ...baseEnv, RDK_X5_PROFILE_NAME: 'rdk-s100-tampered.json' },
  stub: { transcript: 'should not run', exitCode: 0 },
});
assert.equal(badProfile.status, 2, 'unknown profile must be rejected locally');
assert.match(badProfile.stderr, /RDK_X5_PROFILE_NAME must be/);
assert.equal(badProfile.stubInvoked, false, 'rejection must happen before any SSH');

const badTarget = runPreflight({
  env: { ...baseEnv, RDK_X5_SSH_TARGET: 'root@board;id' },
  stub: { transcript: 'should not run', exitCode: 0 },
});
assert.equal(badTarget.status, 2, 'shell metacharacters in the SSH target must be rejected');
assert.equal(badTarget.stubInvoked, false, 'rejection must happen before any SSH');

const boardPass = runPreflight({
  env: baseEnv,
  stub: {
    transcript: [
      '== RDK board preflight: rdk-s100-generic-drive.json (platform rdk-s100) ==',
      'PASS    arch is aarch64',
      'PASS    topic /base/cmd_vel present',
      'PREFLIGHT=PASS',
    ].join('\n'),
    exitCode: 0,
  },
});
assert.equal(boardPass.status, 0, 'a passing board transcript must exit 0');
assert.match(boardPass.stdout, /licenses provenance mock:false/);

const boardFail = runPreflight({
  env: baseEnv,
  stub: {
    transcript: [
      '== RDK board preflight: rdk-s100-generic-drive.json (platform rdk-s100) ==',
      'FAIL    required topic /base/cmd_vel not present',
      'PREFLIGHT=FAIL',
    ].join('\n'),
    exitCode: 1,
  },
});
assert.equal(boardFail.status, 1, 'a failing board transcript must exit nonzero');
assert.match(boardFail.stdout, /keep provenance mock:true/);

console.log('preflight-board self-test passed');
