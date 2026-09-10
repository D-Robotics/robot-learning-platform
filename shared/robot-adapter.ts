/** Declarative hardware/task adapter contract shared by training and board runtimes. */
export const ROBOT_ADAPTER_SCHEMA_VERSION = 1 as const;

export type RobotFamily = 'diff-drive' | 'omni-drive' | 'joint' | 'custom';
export type RobotAdapterProvenanceKind = 'real' | 'synthetic' | 'template';

export interface RobotAdapterTopic {
  name: string;
  type: string;
  required: boolean;
  field?: string;
  qos?: 'best-effort' | 'reliable';
}

export interface RobotAdapterManifest {
  schemaVersion: typeof ROBOT_ADAPTER_SCHEMA_VERSION;
  id: string;
  displayName: string;
  /** Optional link when adapters/ and profiles/ keep separate named copies. */
  hardwareProfileId?: string;
  board: {
    platform: string;
    family: string;
    model: string;
  };
  ros: {
    setupPaths?: string[];
    topics: Record<string, RobotAdapterTopic> & {
      imu: RobotAdapterTopic;
      odom: RobotAdapterTopic;
      battery: RobotAdapterTopic;
      cmdVel: RobotAdapterTopic;
    };
  };
  actuator: {
    kind: RobotFamily;
    commandTopic: string;
    messageType: string;
    linearAxis?: string;
    angularAxis?: string;
    maxLinear: number;
    maxAngular: number;
    watchdogMs: number;
  };
  runtime: {
    decisionHz: number;
    actionProjection: 'identity' | 'paired' | 'custom';
  };
  safety: {
    maxLinear: number;
    maxAngular: number;
    sensorStallSec: number;
  };
  policy: {
    observationAdapterId: string;
    actionAdapterId: string;
    observationSize: number;
    actionSize: number;
  };
  capabilities: string[];
  provenance?: {
    kind: RobotAdapterProvenanceKind;
    mock: boolean;
    note?: string;
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmpty(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Validate the same schema consumed from adapters/*.json and profiles/*.json. */
export function validateRobotAdapterManifest(input: unknown): {
  valid: boolean;
  errors: string[];
  manifest?: RobotAdapterManifest;
} {
  const errors: string[] = [];
  const value = record(input);
  const board = record(value.board);
  const ros = record(value.ros);
  const topics = record(ros.topics);
  const actuator = record(value.actuator);
  const runtime = record(value.runtime);
  const safety = record(value.safety);
  const policy = record(value.policy);

  if (value.schemaVersion !== ROBOT_ADAPTER_SCHEMA_VERSION) {
    errors.push('schemaVersion must be 1');
  }
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(String(value.id ?? ''))) {
    errors.push('id must be a lowercase slug');
  }
  if (!nonEmpty(value.displayName)) errors.push('displayName is required');
  if (![board.platform, board.family, board.model].every(nonEmpty)) {
    errors.push('board platform/family/model are required');
  }

  const topicNames = new Set<string>();
  for (const key of ['imu', 'odom', 'battery', 'cmdVel']) {
    const topic = record(topics[key]);
    if (!nonEmpty(topic.name) || !String(topic.name ?? '').startsWith('/')) {
      errors.push(`ros.topics.${key}.name must be absolute`);
    }
    if (!nonEmpty(topic.type) || !String(topic.type ?? '').includes('/')) {
      errors.push(`ros.topics.${key}.type is required`);
    }
    if (typeof topic.required !== 'boolean') {
      errors.push(`ros.topics.${key}.required must be boolean`);
    }
    if (topic.qos !== undefined && topic.qos !== 'best-effort' && topic.qos !== 'reliable') {
      errors.push(`ros.topics.${key}.qos is invalid`);
    }
    const topicName = String(topic.name ?? '');
    if (topicName && topicNames.has(topicName)) errors.push(`duplicate ROS topic: ${topicName}`);
    topicNames.add(topicName);
  }

  const family = String(actuator.kind ?? '');
  if (!['diff-drive', 'omni-drive', 'joint', 'custom'].includes(family)) {
    errors.push('actuator.kind is invalid');
  }
  if (!nonEmpty(actuator.commandTopic) || !String(actuator.commandTopic ?? '').startsWith('/')) {
    errors.push('actuator.commandTopic must be absolute');
  }
  if (!nonEmpty(actuator.messageType) || !String(actuator.messageType ?? '').includes('/')) {
    errors.push('actuator.messageType is required');
  }
  const cmdVel = record(topics.cmdVel);
  if (actuator.commandTopic !== cmdVel.name) {
    errors.push('actuator.commandTopic must match ros.topics.cmdVel.name');
  }
  if (actuator.messageType !== cmdVel.type) {
    errors.push('actuator.messageType must match ros.topics.cmdVel.type');
  }

  const maxLinear = Number(actuator.maxLinear);
  const maxAngular = Number(actuator.maxAngular);
  const watchdogMs = Number(actuator.watchdogMs);
  if (!(maxLinear > 0 && maxLinear <= 0.3)) errors.push('actuator.maxLinear must be in (0, 0.3]');
  if (!(maxAngular > 0 && maxAngular <= 1)) errors.push('actuator.maxAngular must be in (0, 1]');
  if (!(Number.isInteger(watchdogMs) && watchdogMs >= 500 && watchdogMs <= 2_000)) {
    errors.push('actuator.watchdogMs must be an integer in [500, 2000]');
  }
  if (Number(safety.maxLinear) !== maxLinear || Number(safety.maxAngular) !== maxAngular) {
    errors.push('safety speed clamps must match actuator clamps');
  }
  const sensorStallSec = Number(safety.sensorStallSec);
  if (!(sensorStallSec >= 0.1 && sensorStallSec <= 2)) {
    errors.push('safety.sensorStallSec must be in [0.1, 2]');
  }

  const decisionHz = Number(runtime.decisionHz);
  if (!(Number.isFinite(decisionHz) && decisionHz >= 1 && decisionHz <= 50)) {
    errors.push('runtime.decisionHz must be in [1, 50]');
  }
  if (!['identity', 'paired', 'custom'].includes(String(runtime.actionProjection ?? ''))) {
    errors.push('runtime.actionProjection is invalid');
  }
  const observationSize = Number(policy.observationSize);
  const actionSize = Number(policy.actionSize);
  if (!(Number.isInteger(observationSize) && observationSize > 0 && observationSize <= 4_096)) {
    errors.push('policy.observationSize must be an integer in [1, 4096]');
  }
  if (!(Number.isInteger(actionSize) && actionSize > 0 && actionSize <= 4_096)) {
    errors.push('policy.actionSize must be an integer in [1, 4096]');
  }
  if (!nonEmpty(policy.observationAdapterId) || !nonEmpty(policy.actionAdapterId)) {
    errors.push('policy observation/action adapter ids are required');
  }
  if (runtime.actionProjection === 'identity' && actionSize !== 2) {
    errors.push('identity action projection requires actionSize=2');
  }

  const capabilities = Array.isArray(value.capabilities) ? value.capabilities : [];
  if (
    !capabilities.length ||
    capabilities.some((item) => !nonEmpty(item)) ||
    new Set(capabilities).size !== capabilities.length
  ) {
    errors.push('capabilities must be a non-empty unique string array');
  }

  if (value.provenance !== undefined) {
    const provenance = record(value.provenance);
    if (!['real', 'synthetic', 'template'].includes(String(provenance.kind ?? ''))) {
      errors.push('provenance.kind is invalid');
    }
    if (typeof provenance.mock !== 'boolean') errors.push('provenance.mock must be boolean');
    if (provenance.kind === 'real' && provenance.mock !== false) {
      errors.push('real provenance must set mock=false');
    }
    if (provenance.kind === 'synthetic' && provenance.mock !== true) {
      errors.push('synthetic provenance must set mock=true');
    }
  }

  return errors.length
    ? { valid: false, errors }
    : { valid: true, errors, manifest: input as RobotAdapterManifest };
}
