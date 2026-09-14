import { describe, expect, it } from 'vitest';

import { listDshCapabilityCatalog } from './dsh-capability-tools.js';
import { dshRuntimeEnabled } from './dsh-runtime.js';

describe('DSH product capability catalog', () => {
  it('marks deployment-owned adapters unbound instead of advertising callable tools', () => {
    const catalog = listDshCapabilityCatalog();

    expect(catalog.length).toBeGreaterThan(0);
    expect(catalog.every((item) => item.bound === false)).toBe(true);
    expect(catalog.find((item) => item.id === 'rdk_workspace_overview')).toMatchObject({
      readOnly: true,
      bound: false,
    });
  });

  it('reports only handlers that are actually supplied by the deployment', () => {
    const catalog = listDshCapabilityCatalog({
      rdk_workspace_overview: async () => ({ ok: true }),
    });

    expect(catalog.find((item) => item.id === 'rdk_workspace_overview')?.bound).toBe(true);
    expect(catalog.find((item) => item.id === 'rdk_training_submit')?.bound).toBe(false);
  });
});

describe('DSH runtime feature flag', () => {
  it.each(['1', 'true', 'TRUE', 'yes', 'on'])('accepts explicit enabled value %s', (value) => {
    expect(dshRuntimeEnabled(value)).toBe(true);
  });

  it.each(['', '0', 'false', 'off', 'random', undefined, null])(
    'rejects disabled or unknown value %s',
    (value) => {
      expect(dshRuntimeEnabled(value)).toBe(false);
    },
  );
});
