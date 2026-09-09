/**
 * Stable domain events emitted by the Sim2Real core.
 *
 * Integrations (experiment trackers, object stores, notifications and future
 * plugins) consume these events instead of importing route internals. Payloads
 * are intentionally small and contain the public record only.
 */
export type Sim2RealDomainEventType =
  | 'project.created'
  | 'project.updated'
  | 'dataset.created'
  | 'model.created'
  | 'run.created'
  | 'run.updated'
  | 'telemetry.appended'
  | 'deployment.created'
  | 'deployment.updated';

export interface Sim2RealDomainEvent<T = unknown> {
  id: string;
  type: Sim2RealDomainEventType;
  at: string;
  /** Owner/tenant key, when the configured auth adapter supplied one. */
  owner?: string;
  entityId: string;
  data: T;
}
