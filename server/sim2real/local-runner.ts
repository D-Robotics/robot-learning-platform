import { createHash } from 'node:crypto';

import type {
  Sim2RealCheckpointRef,
  Sim2RealModelManifest,
  Sim2RealTrainingSpec,
} from '../../shared/sim2real.js';
import {
  isLocalRunnerConfigured as isRunnerConfigured,
  normalizeRunnerUrl,
  requestRobogoTraining,
  requestRobogoTrainingStatus,
  type Sim2RealRobogoRunResult,
} from './robogo-runner.js';
import { Sim2RealError } from './sim2real-errors.js';

const WEAK_RUNNER_TOKEN_RE =
  /^(?:replace(?:[-_ ]?with)?(?:[-_ ].*)?|change(?:[-_ ]?me)?(?:[-_ ].*)?|changeme(?:[-_ ]?.*)?|example(?:[-_ ].*)?|placeholder(?:[-_ ].*)?|default(?:[-_ ]?secret)?(?:[-_ ].*)?|dummy(?:[-_ ].*)?|password(?:[-_ ].*)?|your[-_ ]?(?:secret|key)(?:[-_ ].*)?|secret(?:[-_ ].*)?)$/i;
const REPEATED_RUNNER_TOKEN_RE = /^(.)\1{31,}$/s;

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if ((code >= 0 && code <= 0x1f) || code === 0x7f) return true;
  }
  return false;
}

/** Token syntax check shared by route-level credential validation. */
export function localRunnerTokenFormatValid(value: unknown): boolean {
  const token = String(value ?? '').trim();
  return Buffer.byteLength(token, 'utf8') <= 4096 && !containsControlCharacter(token);
}

function loopbackHost(hostname: string): boolean {
  const host = String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/** Match the local worker's exposed-endpoint token policy. */
export function localRunnerTokenUsable(value: unknown): boolean {
  const token = String(value ?? '').trim();
  return (
    Boolean(token) &&
    Buffer.byteLength(token, 'utf8') >= 32 &&
    Buffer.byteLength(token, 'utf8') <= 4096 &&
    localRunnerTokenFormatValid(token) &&
    !WEAK_RUNNER_TOKEN_RE.test(token) &&
    !REPEATED_RUNNER_TOKEN_RE.test(token)
  );
}

/**
 * A loopback development worker may use a short fixture token (or no token),
 * while production and every non-loopback endpoint must be authenticated.
 * Keeping this check in the outbound adapter prevents a misconfigured server
 * from sending a job to an exposed worker before the worker can reject it.
 */
export function localRunnerTokenRequired(rawUrl?: string): boolean {
  const production =
    String(process.env.NODE_ENV ?? '')
      .trim()
      .toLowerCase() === 'production' ||
    String(process.env.RDK_SIM2REAL_DEPLOYMENT ?? '')
      .trim()
      .toLowerCase() === 'web-cloud' ||
    String(process.env.RDK_STUDIO_DEPLOYMENT_PROFILE ?? '')
      .trim()
      .toLowerCase() === 'web-cloud';
  if (production) return true;
  try {
    const parsed = new URL(
      normalizeRunnerUrl(rawUrl ?? process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL ?? '', {
        localHttp: true,
      }),
    );
    return !loopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

/** Whether a configured endpoint is safe to advertise as executable. */
export function localRunnerConnectionReady(rawUrl?: string, token?: string): boolean {
  const url = rawUrl ?? process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL ?? '';
  if (!isRunnerConfigured(url)) return false;
  const effectiveToken = String(token ?? process.env.RDK_SIM2REAL_LOCAL_RUNNER_TOKEN ?? '').trim();
  return !localRunnerTokenRequired(url) || localRunnerTokenUsable(effectiveToken);
}

function assertLocalRunnerToken(rawUrl: string | undefined, token: string): void {
  if (localRunnerTokenRequired(rawUrl) && !localRunnerTokenUsable(token)) {
    throw new Sim2RealError('sim2real_runner_token_invalid', {
      detail: '远程或生产 local runner 必须配置至少 32 字节随机 bearer token。',
    });
  }
}

/**
 * Local training uses the same narrow runner protocol as RoboGo, but points at
 * a worker on the user's own server. Keeping the adapter separate makes the
 * deployment choice explicit without duplicating payload validation.
 */
export function isLocalRunnerConfigured(raw?: string): boolean {
  return isRunnerConfigured(raw ?? process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL ?? '');
}

export async function requestLocalTraining(input: {
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
  const runnerUrl = input.runnerUrl ?? process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL ?? '';
  assertLocalRunnerToken(runnerUrl, localToken);
  return requestRobogoTraining({
    ...input,
    // A local worker is an internal deployment boundary.  Never forward the
    // Studio/RoboGo bearer token to it, even if a caller happens to provide
    // one while reusing the shared adapter input shape.
    requestToken: localToken || undefined,
    // Pass an explicit empty value when the local endpoint is unset so the
    // generic adapter can never fall back to the RoboGo endpoint.
    runnerUrl,
    allowPrivateHttp: true,
    allowEnvironmentToken: false,
  });
}

export async function requestLocalTrainingStatus(input: {
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
  const runnerUrl = input.runnerUrl ?? process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL ?? '';
  assertLocalRunnerToken(runnerUrl, localToken);
  return requestRobogoTrainingStatus({
    ...input,
    requestToken: localToken || undefined,
    runnerUrl,
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
  let runnerUrl: string;
  try {
    runnerUrl = normalizeRunnerUrl(
      input.runnerUrl ?? process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL ?? '',
      { localHttp: true },
    );
  } catch {
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.min(Math.max(input.timeoutMs ?? 60_000, 1000), 180_000),
  );
  try {
    const token = String(
      input.runnerToken ?? process.env.RDK_SIM2REAL_LOCAL_RUNNER_TOKEN ?? '',
    ).trim();
    if (localRunnerTokenRequired(runnerUrl) && !localRunnerTokenUsable(token)) return null;
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
    // Do not trust a worker-provided digest by itself.  The digest is part of
    // the release evidence chain, so verify the downloaded bytes locally
    // before handing them to BoardStation for staging.
    const computedSha256 = createHash('sha256').update(bytes).digest('hex');
    if (computedSha256 !== sha256) return null;
    return { bytes, sha256 };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
