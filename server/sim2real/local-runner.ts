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
  const localToken = String(input.runnerToken ?? process.env.RDK_SIM2REAL_LOCAL_RUNNER_TOKEN ?? '').trim();
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
  const localToken = String(input.runnerToken ?? process.env.RDK_SIM2REAL_LOCAL_RUNNER_TOKEN ?? '').trim();
  return requestRobogoTrainingStatus({
    ...input,
    requestToken: localToken || undefined,
    runnerUrl: input.runnerUrl ?? process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL ?? '',
    allowPrivateHttp: true,
    allowEnvironmentToken: false,
  });
}
