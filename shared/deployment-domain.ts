export type DeploymentStatus =
  'draft' | 'preflight' | 'canary' | 'live' | 'rolled-back' | 'blocked';
export interface DeploymentSummary {
  id: string;
  status: DeploymentStatus;
  artifactId?: string;
  deviceId?: string;
  approvedBy?: string;
}
export function deploymentCanAdvance(
  d: Pick<DeploymentSummary, 'status' | 'artifactId' | 'deviceId' | 'approvedBy'>,
): boolean {
  return d.status === 'preflight' && Boolean(d.artifactId && d.deviceId && d.approvedBy);
}
export function deploymentNextAction(
  d: Pick<DeploymentSummary, 'status'>,
): 'preflight' | 'approve' | 'canary' | 'live' | 'rollback' | 'inspect' {
  switch (d.status) {
    case 'draft':
      return 'preflight';
    case 'preflight':
      return 'approve';
    case 'canary':
      return 'live';
    case 'live':
      return 'rollback';
    case 'rolled-back':
      return 'inspect';
    default:
      return 'inspect';
  }
}
