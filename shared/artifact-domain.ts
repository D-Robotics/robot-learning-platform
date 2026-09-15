export type ArtifactStatus = 'registered' | 'published' | 'revoked';
export interface ArtifactSummary {
  id: string;
  version: string;
  sha256: string;
  bytes: number;
  status: ArtifactStatus;
  immutable: boolean;
  signature?: string;
}
export function artifactIsUsable(
  a: Pick<ArtifactSummary, 'status' | 'immutable' | 'sha256'>,
): boolean {
  return a.status === 'published' && a.immutable && /^[a-f0-9]{64}$/i.test(a.sha256);
}
export function artifactRollbackTarget(
  items: readonly ArtifactSummary[],
  current: string,
): ArtifactSummary | undefined {
  return items
    .filter((a) => a.status === 'published' && a.immutable && a.version !== current)
    .sort((a, b) => b.version.localeCompare(a.version))[0];
}
