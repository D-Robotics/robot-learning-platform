import type { Sim2RealRunRecord } from '../../shared/sim2real.js';
import { isOriginmanWorkshopEngine } from '../../shared/originman-workshop.js';
import { requestLocalTrainingStatus } from './local-runner.js';
import {
  getSim2RealRun,
  getSim2RealComputeResourceSecret,
  updateSim2RealRun,
} from './sim2real-store.js';

/** Recover a missing receipt from the original worker without launching another job. */
export async function restoreWorkshopEvidence(run: Sim2RealRunRecord, owner?: string) {
  const config = run.training?.originmanWorkshop;
  if (
    !config ||
    run.metrics?.originmanWorkshop ||
    run.status !== 'completed' ||
    run.taskId !== 'originman-recovery' ||
    !isOriginmanWorkshopEngine(run.training?.engine) ||
    run.mock !== false ||
    run.backend !== 'local' ||
    run.relayAgentUrl ||
    !run.externalRunId ||
    !run.computeResourceId ||
    !run.artifact?.sha256
  )
    return run;
  const selected = await getSim2RealComputeResourceSecret(run.computeResourceId, owner);
  if (!selected || selected.resource.source === 'local-agent') return run;
  const latest = await requestLocalTrainingStatus({
    accountId: owner ?? 'local-dev',
    externalRunId: run.externalRunId,
    runnerUrl: selected.resource.runnerUrl,
    runnerToken: selected.runnerToken ?? '',
    timeoutMs: 5000,
  }).catch(() => null);
  const evidence = latest?.metrics?.originmanWorkshop;
  if (
    !latest?.metrics ||
    latest.status !== 'completed' ||
    latest.mock !== false ||
    latest.externalRunId !== run.externalRunId ||
    latest.metrics?.engine !== run.training?.engine ||
    latest.artifact?.sha256 !== run.artifact.sha256 ||
    evidence?.policySha256 !== run.artifact.sha256 ||
    evidence.phase !== config.phase ||
    evidence.requestedTimesteps !== config.timesteps ||
    evidence.seed !== config.seed ||
    evidence.pushMaxForce !== config.pushMaxForce ||
    evidence.sourceRunId !== config.sourceRunId ||
    (evidence.groupId !== undefined && evidence.groupId !== config.groupId)
  )
    return run;
  return (
    (await updateSim2RealRun(
      run.id,
      { metrics: { ...latest.metrics, ...run.metrics, originmanWorkshop: evidence } },
      owner,
    )) ?? run
  );
}

export async function getWorkshopRun(id: string, owner?: string) {
  const run = await getSim2RealRun(id, owner);
  return run ? restoreWorkshopEvidence(run, owner) : null;
}
