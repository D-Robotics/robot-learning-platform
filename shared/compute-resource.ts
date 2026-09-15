/** Versioned compute resource contract shared by UI, Local Agent and server. */
export const COMPUTE_RESOURCE_SCHEMA_VERSION = 1 as const;

export type ComputeResourceSource = 'local-agent' | 'server-runner' | 'robogo';
export type ComputeResourceStatus = 'discovered' | 'connecting' | 'online' | 'offline' | 'error';

export interface ComputeCapability {
  id: string;
  label: string;
  value?: string | number | boolean;
}

export interface ComputeResource {
  schemaVersion: typeof COMPUTE_RESOURCE_SCHEMA_VERSION;
  id: string;
  name: string;
  source: ComputeResourceSource;
  status: ComputeResourceStatus;
  endpoint?: string;
  capabilities: ComputeCapability[];
  activeJobs: number;
  queuedJobs: number;
  lastCheckedAt?: string;
  error?: string;
}

export function computeResourceIsUsable(
  resource: Pick<ComputeResource, 'status' | 'source'>,
): boolean {
  return resource.status === 'online' && resource.source !== 'server-runner';
}

export function normalizeComputeResource(input: Partial<ComputeResource>): ComputeResource {
  const source: ComputeResourceSource =
    input.source === 'server-runner' || input.source === 'robogo' ? input.source : 'local-agent';
  const status: ComputeResourceStatus = [
    'discovered',
    'connecting',
    'online',
    'offline',
    'error',
  ].includes(String(input.status))
    ? (input.status as ComputeResourceStatus)
    : 'discovered';
  return {
    schemaVersion: COMPUTE_RESOURCE_SCHEMA_VERSION,
    id: String(input.id || 'local-agent'),
    name: String(input.name || '本机 GPU Agent'),
    source,
    status,
    ...(input.endpoint ? { endpoint: String(input.endpoint) } : {}),
    capabilities: Array.isArray(input.capabilities)
      ? input.capabilities.filter((item): item is ComputeCapability =>
          Boolean(item && typeof item.id === 'string' && typeof item.label === 'string'),
        )
      : [],
    activeJobs:
      Number.isInteger(input.activeJobs) && input.activeJobs! >= 0 ? input.activeJobs! : 0,
    queuedJobs:
      Number.isInteger(input.queuedJobs) && input.queuedJobs! >= 0 ? input.queuedJobs! : 0,
    ...(input.lastCheckedAt ? { lastCheckedAt: String(input.lastCheckedAt) } : {}),
    ...(input.error ? { error: String(input.error).slice(0, 240) } : {}),
  };
}
