import type { RobotAdapterManifest } from './robot-adapter.js';
import { validateRobotAdapterManifest } from './robot-adapter.js';

export interface DeviceCapabilities {
  family: string;
  boardPlatform?: string;
  topics?: string[];
  observationSize?: number;
  actionSize?: number;
}

export function registerRobotAdapters(inputs: unknown[]): {
  adapters: RobotAdapterManifest[];
  errors: string[];
} {
  const adapters: RobotAdapterManifest[] = [];
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const input of inputs) {
    const result = validateRobotAdapterManifest(input);
    if (!result.valid || !result.manifest) {
      errors.push(...result.errors);
      continue;
    }
    if (ids.has(result.manifest.id)) {
      errors.push(`duplicate adapter id: ${result.manifest.id}`);
      continue;
    }
    ids.add(result.manifest.id);
    adapters.push(result.manifest);
  }
  return { adapters, errors };
}

/** Discover only an exact capability match; ambiguity remains visible to the caller. */
export function discoverRobotAdapter(
  adapters: RobotAdapterManifest[],
  capabilities: DeviceCapabilities,
): RobotAdapterManifest | undefined {
  return adapters.find((adapter) => {
    if (adapter.actuator.kind !== capabilities.family) return false;
    if (capabilities.boardPlatform && adapter.board.platform !== capabilities.boardPlatform) {
      return false;
    }
    if (
      capabilities.observationSize &&
      adapter.policy.observationSize !== capabilities.observationSize
    ) {
      return false;
    }
    if (capabilities.actionSize && adapter.policy.actionSize !== capabilities.actionSize) {
      return false;
    }
    if (capabilities.topics) {
      const topicKeys = new Set(Object.keys(adapter.ros.topics));
      const topicNames = new Set(Object.values(adapter.ros.topics).map((topic) => topic.name));
      if (!capabilities.topics.every((topic) => topicKeys.has(topic) || topicNames.has(topic))) {
        return false;
      }
    }
    return true;
  });
}
