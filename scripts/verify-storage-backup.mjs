#!/usr/bin/env node

/** Deterministic rehearsal for the production storage backup workflow. */
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBackup, restoreBackup, verifySnapshot } from './sim2real-storage-backup.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'rdk-sim2real-backup-check-'));
const storage = path.join(root, 'storage');
const snapshot = path.join(root, 'snapshot');
const restored = path.join(root, 'restored');
const externalRestored = path.join(root, 'external-restored');
const externalAudit = path.join(root, 'external-audit', 'audit.ndjson');
const broadAudit = path.join(root, 'broad-audit', 'audit.ndjson');
const linkedAudit = path.join(root, 'linked-audit', 'audit.ndjson');
const noAuditStorage = path.join(root, 'no-audit-storage');
const noAuditSnapshot = path.join(root, 'no-audit-snapshot');
const noAuditRestored = path.join(root, 'no-audit-restored');
const noAuditExternal = path.join(root, 'no-audit-external', 'audit.ndjson');
const ledger = {
  version: 1,
  models: [],
  runs: [],
  deployments: [],
  telemetry: [],
  projects: [],
  datasets: [],
  artifacts: [{ id: 'artifact-1', status: 'published' }],
  evaluations: [{ id: 'evaluation-1', status: 'passed' }],
  computeResources: [],
};

try {
  await mkdir(path.join(storage, 'telemetry'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(storage, 'dsh-sessions', '_no-cwd'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(storage, 'sim2real.json'), `${JSON.stringify(ledger)}\n`, {
    mode: 0o600,
  });
  await writeFile(
    path.join(storage, 'telemetry', 'run-1.jsonl'),
    '{"id":"telemetry-1","runId":"run-1","samples":[]}\n',
    { mode: 0o600 },
  );
  await writeFile(
    path.join(storage, 'audit.ndjson'),
    '{"id":"audit-1","at":"2026-09-13T00:00:00.000Z","action":"POST /api/runs","resourceType":"runs","outcome":"succeeded","status":201}\n',
    { mode: 0o600 },
  );
  await writeFile(
    path.join(storage, 'audit.ndjson.1'),
    '{"id":"audit-0","at":"2026-09-12T00:00:00.000Z","action":"POST /api/models","resourceType":"models","outcome":"succeeded","status":201}\n',
    { mode: 0o600 },
  );

  const first = await createBackup({ storageDir: storage, output: snapshot });
  assert.equal(first.manifest.consistency, 'quiesced');
  const verified = await verifySnapshot(snapshot);
  assert.equal(verified.files, 4);
  assert.equal(verified.telemetryRows, 1);
  assert.equal(verified.auditRows, 2);
  assert.equal(verified.ledger.artifacts[0].id, 'artifact-1');
  assert.equal(verified.ledger.evaluations[0].id, 'evaluation-1');

  // An active writer is a hard stop unless the operator explicitly accepts a
  // best-effort snapshot. The current pid makes this deterministic without
  // starting another service.
  await writeFile(
    path.join(storage, 'writer-lease.json'),
    `${JSON.stringify({ schemaVersion: 1, host: os.hostname(), pid: process.pid, startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() })}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(
    () => createBackup({ storageDir: storage, output: path.join(root, 'blocked') }),
    (error) => error?.code === 'STORAGE_BACKUP_WRITER_ACTIVE',
  );
  const live = await createBackup({
    storageDir: storage,
    output: path.join(root, 'best-effort'),
    allowLive: true,
  });
  assert.equal(live.manifest.consistency, 'best-effort');

  const result = await restoreBackup({ snapshotDir: snapshot, storageDir: restored, yes: true });
  assert.equal(result.restoredTo, restored);
  assert.equal(JSON.parse(await readFile(path.join(restored, 'sim2real.json'), 'utf8')).version, 1);
  const restoredLedger = JSON.parse(await readFile(path.join(restored, 'sim2real.json'), 'utf8'));
  assert.equal(restoredLedger.artifacts[0].id, 'artifact-1');
  assert.equal(restoredLedger.evaluations[0].id, 'evaluation-1');
  assert.match(
    await readFile(path.join(restored, 'telemetry', 'run-1.jsonl'), 'utf8'),
    /telemetry-1/,
  );
  assert.match(await readFile(path.join(restored, 'audit.ndjson'), 'utf8'), /audit-1/);
  assert.match(await readFile(path.join(restored, 'audit.ndjson.1'), 'utf8'), /audit-0/);

  // An external audit replacement happens after the target tree has switched.
  // Force that step to fail and verify the old ledger is put back instead of
  // leaving the freshly restored tree active beside the old `.pre-restore`
  // directory.
  const legacyLedger = {
    ...ledger,
    artifacts: [{ id: 'legacy-artifact', status: 'published' }],
    evaluations: [{ id: 'legacy-evaluation', status: 'passed' }],
  };
  await mkdir(externalRestored, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(externalRestored, 'sim2real.json'),
    `${JSON.stringify(legacyLedger)}\n`,
    {
      mode: 0o600,
    },
  );
  await mkdir(path.dirname(externalAudit), { recursive: true, mode: 0o700 });
  await writeFile(externalAudit, 'legacy-current-audit\n', { mode: 0o600 });
  await writeFile(`${externalAudit}.1`, 'legacy-rotated-audit\n', { mode: 0o600 });
  let replacementCalls = 0;
  await assert.rejects(
    () =>
      restoreBackup({
        snapshotDir: snapshot,
        storageDir: externalRestored,
        auditFile: externalAudit,
        yes: true,
        auditReplacer: async () => {
          replacementCalls += 1;
          const error = new Error('forced audit replacement failure');
          error.code = 'STORAGE_BACKUP_TEST_AUDIT_REPLACER';
          throw error;
        },
      }),
    (error) => error?.code === 'STORAGE_BACKUP_TEST_AUDIT_REPLACER',
  );
  assert.equal(replacementCalls, 1);
  assert.equal(
    JSON.parse(await readFile(path.join(externalRestored, 'sim2real.json'), 'utf8')).artifacts[0]
      .id,
    'legacy-artifact',
  );
  assert.equal(await readFile(externalAudit, 'utf8'), 'legacy-current-audit\n');
  assert.equal(await readFile(`${externalAudit}.1`, 'utf8'), 'legacy-rotated-audit\n');

  // An external audit path is a privileged replacement target. A broad parent
  // (for example /etc) must be rejected before the ledger tree is switched;
  // otherwise a typo could overwrite an arbitrary regular system file.
  await mkdir(path.dirname(broadAudit), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(broadAudit), 0o755);
  await assert.rejects(
    () =>
      restoreBackup({
        snapshotDir: snapshot,
        storageDir: path.join(root, 'broad-target'),
        auditFile: broadAudit,
        yes: true,
      }),
    (error) => error?.code === 'STORAGE_BACKUP_AUDIT_PATH_INVALID',
  );

  // Ancestor symlinks are rejected even when the final file itself does not
  // exist, preventing a restore from redirecting its atomic replacement.
  const linkedParent = path.join(root, 'linked-parent-target');
  await mkdir(linkedParent, { recursive: true, mode: 0o700 });
  await symlink(linkedParent, path.join(root, 'linked-audit'));
  await assert.rejects(
    () =>
      restoreBackup({
        snapshotDir: snapshot,
        storageDir: path.join(root, 'linked-target'),
        auditFile: linkedAudit,
        yes: true,
      }),
    (error) => error?.code === 'STORAGE_BACKUP_SYMLINK',
  );

  // A snapshot without an external audit segment must fail closed when the
  // destination still contains an older segment; otherwise restore would mix
  // a new ledger with stale audit evidence.
  await mkdir(noAuditStorage, { recursive: true, mode: 0o700 });
  await writeFile(path.join(noAuditStorage, 'sim2real.json'), `${JSON.stringify(ledger)}\n`, {
    mode: 0o600,
  });
  const noAudit = await createBackup({
    storageDir: noAuditStorage,
    output: noAuditSnapshot,
    auditFile: noAuditExternal,
  });
  assert.equal(noAudit.manifest.files.length, 1);
  await mkdir(noAuditRestored, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(noAuditRestored, 'sim2real.json'),
    `${JSON.stringify(legacyLedger)}\n`,
    {
      mode: 0o600,
    },
  );
  await mkdir(path.dirname(noAuditExternal), { recursive: true, mode: 0o700 });
  await writeFile(noAuditExternal, 'stale-external-audit\n', { mode: 0o600 });
  await assert.rejects(
    () =>
      restoreBackup({
        snapshotDir: noAuditSnapshot,
        storageDir: noAuditRestored,
        auditFile: noAuditExternal,
        yes: true,
      }),
    (error) => error?.code === 'STORAGE_BACKUP_AUDIT_INCOMPLETE',
  );
  assert.equal(
    JSON.parse(await readFile(path.join(noAuditRestored, 'sim2real.json'), 'utf8')).artifacts[0].id,
    'legacy-artifact',
  );
  assert.equal(await readFile(noAuditExternal, 'utf8'), 'stale-external-audit\n');

  await writeFile(path.join(snapshot, 'sim2real.json'), '{"tampered":true}\n');
  await assert.rejects(
    () => verifySnapshot(snapshot),
    (error) => error?.code === 'STORAGE_BACKUP_DIGEST_MISMATCH',
  );
  console.log(
    '[storage-backup] PASS — ledger artifacts/evaluations, telemetry, audit rotation, active-writer gate, atomic external-audit rollback, missing-audit fail-closed, restore and digest tamper check verified',
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
