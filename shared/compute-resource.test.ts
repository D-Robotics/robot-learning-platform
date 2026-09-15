import { describe, expect, it } from 'vitest';
import { computeResourceIsUsable, normalizeComputeResource } from './compute-resource.js';

describe('compute resource contract', () => {
  it('defaults to a local agent without inventing health', () => {
    const resource = normalizeComputeResource({ id: 'laptop' });
    expect(resource.source).toBe('local-agent');
    expect(resource.status).toBe('discovered');
    expect(computeResourceIsUsable(resource)).toBe(false);
  });
  it('keeps server runners distinct from local resources', () => {
    const resource = normalizeComputeResource({ source: 'server-runner', status: 'online' });
    expect(computeResourceIsUsable(resource)).toBe(false);
  });
  it('preserves only bounded capability data', () => {
    const resource = normalizeComputeResource({
      capabilities: [
        { id: 'gpu', label: 'GPU', value: 'RTX 5090' },
        { id: 1 as never, label: 'bad' },
      ],
    });
    expect(resource.capabilities).toHaveLength(1);
  });
});
