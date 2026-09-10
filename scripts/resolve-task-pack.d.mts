/**
 * Type declarations for scripts/resolve-task-pack.mjs (allowJs is off; the
 * resolver stays a plain .mjs shared with the CLI, so its surface is
 * declared here instead).
 */

export interface TaskPack {
  schemaVersion: number;
  kind: string;
  id: string;
  displayName: string;
  adapter: {
    id: string;
    policy: {
      observationAdapterId: string;
      actionAdapterId: string;
      observationSize: number;
      actionSize: number;
    };
    safety: { maxLinear: number; maxAngular: number };
    runtime?: { decisionHz?: number };
  };
  reward: Record<string, number>;
  termination: { goalDistance: number; timeoutSteps: number };
  workspace?: { bound?: number; obstacles?: { count?: number; radius?: number } };
  curriculum: Record<string, unknown>;
  domainRandomization?: Record<string, unknown>;
  evaluationConfig?: Record<string, unknown>;
  qualityGate?: Record<string, unknown>;
  controlHz: number;
  physicsTimestepSeconds: number;
  decimation: number;
  seed?: number;
  provenance?: Record<string, unknown>;
  [key: string]: unknown;
}

export function resolveTaskPack(taskId: string, context?: Record<string, unknown>): TaskPack;

export function trainingRequestFor(
  pack: TaskPack,
  context?: Record<string, unknown>,
): Record<string, unknown>;
