-- Additive production foundation for the provider-neutral MLOps workflow.
--
-- The current standalone server still uses its JSON ledger.  This migration is
-- deliberately additive so a deployment can introduce PostgreSQL + object
-- storage behind the existing store interface without changing API contracts.
-- Every row is tenant scoped and protected by the same fail-closed RLS rule as
-- 001_initial.sql.

CREATE TABLE IF NOT EXISTS parameter_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id text NOT NULL,
  project_id uuid NOT NULL REFERENCES projects(id),
  name text NOT NULL,
  version text NOT NULL,
  values jsonb NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  immutable boolean NOT NULL DEFAULT true,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id, project_id, name, version),
  UNIQUE(account_id, sha256)
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id text NOT NULL,
  project_id uuid NOT NULL REFERENCES projects(id),
  run_id uuid REFERENCES runs(id),
  workflow_key text NOT NULL,
  idempotency_key text NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('manual', 'schedule', 'event')),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  spec jsonb NOT NULL,
  parameter_set_id uuid REFERENCES parameter_sets(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE(account_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS workflow_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id text NOT NULL,
  workflow_run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_key text NOT NULL,
  step_kind text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'ready', 'running', 'succeeded', 'failed', 'cancelled', 'skipped')),
  depends_on text[] NOT NULL DEFAULT '{}',
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts integer NOT NULL DEFAULT 1 CHECK (max_attempts > 0),
  resource_request jsonb NOT NULL,
  input_refs jsonb NOT NULL DEFAULT '{}',
  output_refs jsonb NOT NULL DEFAULT '{}',
  error jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE(workflow_run_id, step_key)
);

CREATE TABLE IF NOT EXISTS workflow_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id text NOT NULL,
  workflow_run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workflow_run_id, sequence)
);

CREATE TABLE IF NOT EXISTS serving_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id text NOT NULL,
  project_id uuid NOT NULL REFERENCES projects(id),
  name text NOT NULL,
  robot_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('shadow', 'staging', 'production')),
  status text NOT NULL CHECK (status IN ('draft', 'ready', 'degraded', 'offline')),
  desired_revision_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id, project_id, name)
);

CREATE TABLE IF NOT EXISTS serving_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id text NOT NULL,
  endpoint_id uuid NOT NULL REFERENCES serving_endpoints(id) ON DELETE CASCADE,
  artifact_id uuid NOT NULL REFERENCES artifacts(id),
  revision text NOT NULL,
  traffic_percent integer NOT NULL DEFAULT 0 CHECK (traffic_percent BETWEEN 0 AND 100),
  status text NOT NULL CHECK (status IN ('pending', 'serving', 'draining', 'rolled_back')),
  metrics jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(endpoint_id, revision)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'serving_endpoints_desired_revision_fk'
      AND conrelid = 'serving_endpoints'::regclass
  ) THEN
    ALTER TABLE serving_endpoints
      ADD CONSTRAINT serving_endpoints_desired_revision_fk
      FOREIGN KEY (desired_revision_id) REFERENCES serving_revisions(id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS workflow_runs_project_status_idx
  ON workflow_runs(account_id, project_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS workflow_steps_ready_idx
  ON workflow_steps(account_id, status, created_at);
CREATE INDEX IF NOT EXISTS workflow_events_run_sequence_idx
  ON workflow_events(workflow_run_id, sequence);
CREATE INDEX IF NOT EXISTS serving_revisions_traffic_idx
  ON serving_revisions(account_id, endpoint_id, status, traffic_percent);

ALTER TABLE parameter_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE serving_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE serving_revisions ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'parameter_sets',
    'workflow_runs',
    'workflow_steps',
    'workflow_events',
    'serving_endpoints',
    'serving_revisions'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = current_schema()
        AND tablename = table_name
        AND policyname = 'tenant_isolation'
    ) THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I USING (account_id = current_setting(''rdk.account_id'', true)) WITH CHECK (account_id = current_setting(''rdk.account_id'', true))',
        table_name
      );
    END IF;
  END LOOP;
END $$;
