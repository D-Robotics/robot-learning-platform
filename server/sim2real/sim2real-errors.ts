/**
 * Typed error hierarchy for the sim2real control plane.
 *
 * Storage and runner failures used to be plain `Error`s identified by their
 * message string. That made the HTTP mapping in the routes a chain of
 * `message === 'sim2real_...'` comparisons: adding a new failure mode was
 * easy to forget, and a typo silently fell into the 500 bucket. Every
 * throw site now constructs `Sim2RealError` with a stable code; the route
 * layer dispatches on `error.code` through one exhaustive table.
 *
 * The error `message` keeps the legacy snake_case string so existing
 * log-based alerts and tests that assert on it keep working.
 */

export type Sim2RealErrorCode =
  | 'sim2real_storage_not_configured'
  | 'sim2real_storage_unavailable'
  | 'sim2real_storage_quota_exceeded'
  | 'sim2real_model_version_exists'
  | 'sim2real_model_quota_exceeded'
  | 'sim2real_run_quota_exceeded'
  | 'sim2real_deployment_quota_exceeded'
  | 'sim2real_run_idempotency_required'
  | 'sim2real_run_idempotency_conflict'
  | 'sim2real_run_reservation_lost'
  | 'sim2real_telemetry_idempotency_conflict'
  | 'sim2real_telemetry_timestamp_order'
  | 'sim2real_telemetry_quota_exceeded'
  | 'sim2real_active_run_quota_exceeded'
  | 'sim2real_deployment_idempotency_conflict'
  | 'sim2real_runner_token_invalid'
  | 'sim2real_runner_account_invalid'
  | 'sim2real_runner_response_too_large'
  | 'sim2real_runner_idempotency_invalid'
  // Runner-level configuration and protocol failures. These never reach the
  // storageError HTTP table: the run routes catch them and translate them
  // into a failed (or outcome-unknown queued) run instead of an API error.
  | 'sim2real_robogo_runner_not_configured'
  | 'sim2real_robogo_runner_url_invalid'
  | 'sim2real_robogo_runner_url_must_be_https'
  | 'sim2real_robogo_runner_status_invalid'
  | 'sim2real_robogo_runner_run_id_missing'
  | 'sim2real_robogo_run_id_invalid'
  | 'sim2real_robogo_status_url_invalid';

export class Sim2RealError extends Error {
  readonly code: Sim2RealErrorCode;

  constructor(code: Sim2RealErrorCode, options?: { cause?: unknown; detail?: string }) {
    super(code, { cause: options?.cause });
    this.name = 'Sim2RealError';
    this.code = code;
    if (options?.detail) {
      // Keep the code as the first line; detail travels separately for logs.
      this.detail = options.detail;
    }
  }

  /** Human-facing context (zh-CN) that does not participate in code matching. */
  readonly detail?: string;
}

/** Narrow an unknown thrown value to a typed sim2real failure. */
export function isSim2RealError(error: unknown): error is Sim2RealError {
  return error instanceof Sim2RealError;
}

/**
 * Extract a sim2real error code from anything thrown. Plain `Error`s whose
 * message happens to be a known code (e.g. rethrown across a serialization
 * boundary or constructed by an older adapter) still map, so adapters do
 * not have to import this module to be understood.
 */
export function sim2RealErrorCode(error: unknown): Sim2RealErrorCode | null {
  if (isSim2RealError(error)) return error.code;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return (SIM2REAL_ERROR_CODE_SET as Set<string>).has(message)
    ? (message as Sim2RealErrorCode)
    : null;
}

const SIM2REAL_ERROR_CODE_SET = new Set<string>([
  'sim2real_storage_not_configured',
  'sim2real_storage_unavailable',
  'sim2real_storage_quota_exceeded',
  'sim2real_model_version_exists',
  'sim2real_model_quota_exceeded',
  'sim2real_run_quota_exceeded',
  'sim2real_deployment_quota_exceeded',
  'sim2real_run_idempotency_required',
  'sim2real_run_idempotency_conflict',
  'sim2real_run_reservation_lost',
  'sim2real_telemetry_idempotency_conflict',
  'sim2real_telemetry_timestamp_order',
  'sim2real_telemetry_quota_exceeded',
  'sim2real_active_run_quota_exceeded',
  'sim2real_deployment_idempotency_conflict',
  'sim2real_runner_token_invalid',
  'sim2real_runner_account_invalid',
  'sim2real_runner_response_too_large',
  'sim2real_runner_idempotency_invalid',
  'sim2real_robogo_runner_not_configured',
  'sim2real_robogo_runner_url_invalid',
  'sim2real_robogo_runner_url_must_be_https',
  'sim2real_robogo_runner_status_invalid',
  'sim2real_robogo_runner_run_id_missing',
  'sim2real_robogo_run_id_invalid',
  'sim2real_robogo_status_url_invalid',
]);
