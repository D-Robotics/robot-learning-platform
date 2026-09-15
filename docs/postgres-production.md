# PostgreSQL + object storage production path

The repository's JSON ledger remains the zero-dependency development mode.
For multi-user deployments, apply [`db/postgres/001_initial.sql`](../db/postgres/001_initial.sql)
and implement the `Sim2RealStore` port against PostgreSQL. Store telemetry and
artifact bytes in S3-compatible object storage; PostgreSQL keeps metadata,
SHA-256, signatures, lifecycle state and lineage. Set `rdk.account_id` on
every transaction so row-level security cannot be bypassed by a missing tenant
filter. Artifact versions are unique and immutable; rollback changes only a
deployment pointer.
