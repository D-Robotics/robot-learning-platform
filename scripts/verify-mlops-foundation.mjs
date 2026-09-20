import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationPath = path.join(root, 'db/postgres/002_mlops_platform_foundation.sql');
const migration = fs.readFileSync(migrationPath, 'utf8');

const requiredTables = [
  'parameter_sets',
  'workflow_runs',
  'workflow_steps',
  'workflow_events',
  'serving_endpoints',
  'serving_revisions',
];

for (const table of requiredTables) {
  if (!new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(`).test(migration)) {
    throw new Error(`[mlops-foundation] missing table ${table}`);
  }
  if (!new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`).test(migration)) {
    throw new Error(`[mlops-foundation] ${table} is missing RLS`);
  }
}

const forbidden = /\b(DROP|TRUNCATE)\s+(TABLE|SCHEMA|DATABASE)\b/i;
if (forbidden.test(migration)) throw new Error('[mlops-foundation] destructive SQL is forbidden');

for (const token of [
  'UNIQUE(account_id, idempotency_key)',
  "status IN ('pending', 'ready', 'running', 'succeeded', 'failed', 'cancelled', 'skipped')",
  'sha256 ~',
  'CREATE POLICY tenant_isolation',
  'workflow_steps_ready_idx',
]) {
  if (!migration.includes(token)) throw new Error(`[mlops-foundation] missing invariant: ${token}`);
}

console.log(
  `[mlops-foundation] PASS — ${requiredTables.length} tenant-isolated tables and workflow invariants verified`,
);
