import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { discoverRobotAdapter, registerRobotAdapters } from './robot-adapter-registry.js';
import { validateRobotAdapterManifest } from './robot-adapter.js';

const root = path.resolve('adapters');
const adapter = JSON.parse(readFileSync(path.join(root, 'rdk-originbot.json'), 'utf8'));

describe('robot adapter registry', () => {
  it('validates the real JSON schema consumed by the task and board runtimes', () => {
    expect(validateRobotAdapterManifest(adapter)).toMatchObject({ valid: true, errors: [] });
  });

  it('registers and discovers an exact board/dimension/topic match', () => {
    const result = registerRobotAdapters([adapter]);
    expect(result.errors).toEqual([]);
    expect(
      discoverRobotAdapter(result.adapters, {
        family: 'diff-drive',
        boardPlatform: 'rdk-x5',
        observationSize: 8,
        actionSize: 2,
        topics: ['imu', 'odom', '/cmd_vel'],
      })?.id,
    ).toBe('rdk-originbot');
  });

  it('rejects duplicate ids, mismatched hardware, and split safety truth', () => {
    expect(registerRobotAdapters([adapter, adapter]).errors).toContain(
      'duplicate adapter id: rdk-originbot',
    );
    expect(
      discoverRobotAdapter([adapter], {
        family: 'diff-drive',
        boardPlatform: 'rdk-s100',
        observationSize: 8,
        actionSize: 2,
      }),
    ).toBeUndefined();
    expect(
      validateRobotAdapterManifest({
        ...adapter,
        safety: { ...adapter.safety, maxLinear: 0.1 },
      }).errors,
    ).toContain('safety speed clamps must match actuator clamps');
  });
});
