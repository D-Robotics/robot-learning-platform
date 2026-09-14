import { describe, expect, it } from 'vitest';

import {
  assertLifecycleTransition,
  canTransition,
  isTerminalLifecycleStatus,
  lifecycleMeta,
} from './sim2real-lifecycle.js';

describe('sim2real lifecycle contract', () => {
  it('allows forward run/deployment transitions and rejects resurrection', () => {
    expect(canTransition('run', 'queued', 'running')).toBe(true);
    expect(canTransition('run', 'completed', 'running')).toBe(false);
    expect(canTransition('deployment', 'blocked', 'planned')).toBe(true);
    expect(canTransition('deployment', 'cancelled', 'running')).toBe(false);
    expect(() => assertLifecycleTransition('run', 'completed', 'queued')).toThrow(
      'sim2real_run_transition_invalid',
    );
  });

  it('keeps artifact publication immutable and exposes stable UI metadata', () => {
    expect(canTransition('artifact', 'validated', 'published')).toBe(true);
    expect(canTransition('artifact', 'published', 'validated')).toBe(false);
    expect(isTerminalLifecycleStatus('artifact', 'published')).toBe(false);
    expect(lifecycleMeta('deployment', 'blocked')).toMatchObject({
      terminal: false,
      tone: 'warning',
      label: '已阻断',
    });
  });
});
