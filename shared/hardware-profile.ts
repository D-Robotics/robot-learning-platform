/** Declarative hardware boundary shared by the platform and board adapters.
 * The platform owns contracts, gates, audit and UI; a profile owns hardware facts.
 */
export const HARDWARE_PROFILE_SCHEMA_VERSION = 1 as const;

export type HardwareActuatorKind = 'diff-drive' | 'omni-drive' | 'joint' | 'custom';
export type HardwareQos = 'best-effort' | 'reliable';

export interface HardwareTopicProfile {
  name: string;
  type: string;
  qos?: HardwareQos;
  field?: string;
  required?: boolean;
}

export interface HardwareProfile {
  schemaVersion: typeof HARDWARE_PROFILE_SCHEMA_VERSION;
  id: string;
  displayName: string;
  board: { platform: string; family: string; model: string };
  ros: {
    setupPaths?: string[];
    topics: Record<string, HardwareTopicProfile>;
  };
  actuator: {
    kind: HardwareActuatorKind;
    commandTopic: string;
    messageType: string;
    linearAxis?: string;
    angularAxis?: string;
    maxLinear: number;
    maxAngular: number;
    watchdogMs: number;
  };
  runtime?: { decisionHz?: number; actionProjection?: 'paired' | 'identity' | string };
  safety?: { maxLinear?: number; maxAngular?: number; sensorStallSec?: number };
  policy: {
    observationAdapterId: string;
    actionAdapterId: string;
    observationSize: number;
    actionSize: number;
  };
  capabilities: string[];
}

const ID = /^[a-z][a-z0-9-]{1,63}$/;
const ROS_NAME = /^\/[A-Za-z0-9_~/.-]+$/;

export function validateHardwareProfile(input: unknown): { valid: boolean; errors: string[]; profile?: HardwareProfile } {
  const errors: string[] = [];
  const value = input && typeof input === 'object' ? input as Record<string, any> : {};
  if (value.schemaVersion !== HARDWARE_PROFILE_SCHEMA_VERSION) errors.push('schemaVersion must be 1');
  if (!ID.test(String(value.id ?? ''))) errors.push('id must be a lowercase slug');
  if (!String(value.displayName ?? '').trim()) errors.push('displayName is required');
  const board = value.board && typeof value.board === 'object' ? value.board : {};
  for (const key of ['platform', 'family', 'model']) if (!String(board[key] ?? '').trim()) errors.push(`board.${key} is required`);
  const ros = value.ros && typeof value.ros === 'object' ? value.ros : {};
  const topics = ros.topics && typeof ros.topics === 'object' ? ros.topics : {};
  if (!Object.keys(topics).length) errors.push('ros.topics must contain at least one topic');
  const topicNames = new Set<string>();
  for (const [id, topic] of Object.entries(topics)) {
    if (!topic || typeof topic !== 'object') { errors.push(`ros.topics.${id} must be an object`); continue; }
    const name = String((topic as any).name ?? '');
    if (!ROS_NAME.test(name)) errors.push(`ros.topics.${id}.name must be an absolute ROS topic`);
    else if (topicNames.has(name)) errors.push(`ros.topics.${id}.name duplicates another topic`);
    else topicNames.add(name);
    if (!String((topic as any).type ?? '').includes('/')) errors.push(`ros.topics.${id}.type is required`);
    if ((topic as any).qos !== undefined && !['best-effort', 'reliable'].includes((topic as any).qos)) {
      errors.push(`ros.topics.${id}.qos is invalid`);
    }
  }
  const actuator = value.actuator && typeof value.actuator === 'object' ? value.actuator : {};
  if (!['diff-drive', 'omni-drive', 'joint', 'custom'].includes(actuator.kind)) errors.push('actuator.kind is invalid');
  if (!ROS_NAME.test(String(actuator.commandTopic ?? ''))) errors.push('actuator.commandTopic must be an absolute ROS topic');
  if (!String(actuator.messageType ?? '').includes('/')) errors.push('actuator.messageType is required');
  if (!(Number(actuator.maxLinear) > 0 && Number(actuator.maxLinear) <= 0.3)) errors.push('actuator.maxLinear must be in (0, 0.3]');
  if (!(Number(actuator.maxAngular) > 0 && Number(actuator.maxAngular) <= 1)) errors.push('actuator.maxAngular must be in (0, 1]');
  if (!(Number.isInteger(actuator.watchdogMs) && actuator.watchdogMs >= 500 && actuator.watchdogMs <= 2000)) errors.push('actuator.watchdogMs must be 500..2000ms');
  const commandTopic = topics.cmdVel;
  if (['diff-drive', 'omni-drive'].includes(actuator.kind) && !commandTopic) {
    errors.push('ros.topics.cmdVel is required for a drive actuator');
  }
  if (commandTopic && String((commandTopic as any).name ?? '') !== String(actuator.commandTopic ?? '')) errors.push('actuator.commandTopic must match ros.topics.cmdVel.name');
  if (commandTopic && String((commandTopic as any).type ?? '') !== String(actuator.messageType ?? '')) errors.push('actuator.messageType must match ros.topics.cmdVel.type');
  const policy = value.policy && typeof value.policy === 'object' ? value.policy : {};
  if (!String(policy.observationAdapterId ?? '').trim()) errors.push('policy.observationAdapterId is required');
  if (!String(policy.actionAdapterId ?? '').trim()) errors.push('policy.actionAdapterId is required');
  if (!(Number.isInteger(policy.observationSize) && policy.observationSize > 0 && policy.observationSize <= 4096)) errors.push('policy.observationSize is invalid');
  if (!(Number.isInteger(policy.actionSize) && policy.actionSize > 0 && policy.actionSize <= 4096)) errors.push('policy.actionSize is invalid');
  if (!Array.isArray(value.capabilities) || value.capabilities.some((item: unknown) => typeof item !== 'string' || !item.trim())) errors.push('capabilities must be a non-empty string array');
  const runtime = value.runtime && typeof value.runtime === 'object' ? value.runtime : {};
  if (runtime.decisionHz !== undefined && !(Number.isFinite(Number(runtime.decisionHz)) && Number(runtime.decisionHz) >= 1 && Number(runtime.decisionHz) <= 50)) errors.push('runtime.decisionHz must be 1..50');
  if (runtime.actionProjection !== undefined && !String(runtime.actionProjection).trim()) errors.push('runtime.actionProjection is invalid');
  const safety = value.safety && typeof value.safety === 'object' ? value.safety : {};
  if (safety.maxLinear !== undefined && !(Number(safety.maxLinear) > 0 && Number(safety.maxLinear) <= 0.3)) errors.push('safety.maxLinear must be in (0, 0.3]');
  if (safety.maxAngular !== undefined && !(Number(safety.maxAngular) > 0 && Number(safety.maxAngular) <= 1)) errors.push('safety.maxAngular must be in (0, 1]');
  if (safety.sensorStallSec !== undefined && !(Number(safety.sensorStallSec) >= 0.1 && Number(safety.sensorStallSec) <= 2)) errors.push('safety.sensorStallSec must be 0.1..2 seconds');
  if (errors.length) return { valid: false, errors };
  return { valid: true, errors, profile: value as HardwareProfile };
}
