import type {
  Sim2RealCheckpointRef,
  Sim2RealModelManifest,
  Sim2RealTrainingSpec,
} from '../../shared/sim2real.js';
import {
  isLocalRunnerConfigured as isRunnerConfigured,
  requestRobogoTraining,
  requestRobogoTrainingStatus,
  type Sim2RealRobogoRunResult,
} from './robogo-runner.js';

/**
 * Local training uses the same narrow runner protocol as RoboGo, but points at
 * a worker on the user's own server. Keeping the adapter separate makes the
 * deployment choice explicit without duplicating payload validation.
 */
export function isLocalRunnerConfigured(raw?: string): boolean {
  return isRunnerConfigured(raw ?? process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL ?? '');
}

export function requestLocalTraining(input: {
  accountId: string;
  requestToken?: string | null;
  manifest: Sim2RealModelManifest;
  training?: Sim2RealTrainingSpec;
  resumeFrom?: Sim2RealCheckpointRef;
  taskId?: string;
  idempotencyKey?: string;
  fetchImpl?: typeof fetch;
  runnerUrl?: string;
  runnerToken?: string;
  timeoutMs?: number;
}): Promise<Sim2RealRobogoRunResult> {
  const localToken = String(
    input.runnerToken ?? process.env.RDK_SIM2REAL_LOCAL_RUNNER_TOKEN ?? '',
  ).trim();
  return requestRobogoTraining({
    ...input,
    // A local worker is an internal deployment boundary.  Never forward the
    // Studio/RoboGo bearer token to it, even if a caller happens to provide
    // one while reusing the shared adapter input shape.
    requestToken: localToken || undefined,
    // Pass an explicit empty value when the local endpoint is unset so the
    // generic adapter can never fall back to the RoboGo endpoint.
    runnerUrl: input.runnerUrl ?? process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL ?? '',
    allowPrivateHttp: true,
    allowEnvironmentToken: false,
  });
}

export function requestLocalTrainingStatus(input: {
  accountId: string;
  requestToken?: string | null;
  externalRunId: string;
  fetchImpl?: typeof fetch;
  runnerUrl?: string;
  statusUrl?: string;
  runnerToken?: string;
  timeoutMs?: number;
}): Promise<Sim2RealRobogoRunResult> {
  const localToken = String(
    input.runnerToken ?? process.env.RDK_SIM2REAL_LOCAL_RUNNER_TOKEN ?? '',
  ).trim();
  return requestRobogoTrainingStatus({
    ...input,
    requestToken: localToken || undefined,
    runnerUrl: input.runnerUrl ?? process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL ?? '',
    allowPrivateHttp: true,
    allowEnvironmentToken: false,
  });
}

/**
 * Fetch a completed local-worker run's ONNX artifact bytes (GET
 * /runs/:id/artifact). The worker re-hashes the file before serving, so the
 * bytes this returns are verified against the digest recorded at completion.
 * Returns null for any transport failure, non-2xx, size anomaly, or digest
 * mismatch — staging must fail closed, never fall back to a guess.
 */
export async function fetchLocalRunArtifact(input: {
  externalRunId: string;
  fetchImpl?: typeof fetch;
  runnerUrl?: string;
  runnerToken?: string;
  timeoutMs?: number;
}): Promise<{ bytes: Buffer; sha256: string } | null> {
  const runnerUrl = (input.runnerUrl ?? process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (!runnerUrl) return null;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.min(Math.max(input.timeoutMs ?? 60_000, 1000), 180_000),
  );
  try {
    const token = String(
      input.runnerToken ?? process.env.RDK_SIM2REAL_LOCAL_RUNNER_TOKEN ?? '',
    ).trim();
    const response = await (input.fetchImpl ?? fetch)(
      `${runnerUrl}/runs/${encodeURIComponent(input.externalRunId)}/artifact`,
      {
        method: 'GET',
        headers: {
          accept: 'application/octet-stream',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        redirect: 'error',
        signal: controller.signal,
      },
    );
    if (!response.ok) return null;
    const declared = Number(response.headers.get('content-length') || 0);
    // Same ceiling the worker enforces (50 MB). A lie or an absent header is
    // re-checked while streaming.
    if (!Number.isFinite(declared) || declared <= 0 || declared > 50 * 1024 * 1024) return null;
    if (!response.body) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 50 * 1024 * 1024) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
    if (total !== declared) return null;
    const bytes = Buffer.concat(chunks);
    const sha256 = String(response.headers.get('x-artifact-sha256') || '')
      .trim()
      .toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sha256)) return null;
    return { bytes, sha256 };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
