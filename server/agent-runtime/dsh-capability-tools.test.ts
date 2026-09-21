import { describe, expect, it } from 'vitest';

import { capabilityBriefing, listDshCapabilityCatalog } from './dsh-capability-tools.js';
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

describe('DSH capability briefing', () => {
  it('contributes nothing when the deployment binds no product handler', () => {
    expect(capabilityBriefing({})).toBe('');
  });

  it('completeness-pins the bound set and flags only bound gated tools', () => {
    const briefing = capabilityBriefing({
      rdk_workspace_overview: async () => ({ ok: true }),
      rdk_board_policy_start: async () => ({ ok: true }),
      rdk_training_submit: async () => ({ ok: true }),
    });

    expect(briefing).toContain('已绑定的 3 个');
    // The prose answer defers enumeration to the UI catalog card.
    expect(briefing).toContain('能力目录');
    expect(briefing).toContain('不要逐条罗列全部工具');
    // A gated tool must be listed so capability tours cannot drop the annotation.
    const gatedLine = briefing.match(/如实标注：(.+)。/)?.[1] ?? '';
    expect(gatedLine.split('、').sort()).toEqual(['rdk_board_policy_start', 'rdk_training_submit']);
    // A read-only tool must stay out of the gated list.
    expect(briefing).not.toContain('rdk_workspace_overview、');
    expect(briefing).toContain('其余 1 个均为只读');
  });

  it('keeps unbound tools out of the briefing so tours mirror the callable schema', () => {
    const briefing = capabilityBriefing({
      rdk_workspace_overview: async () => ({ ok: true }),
    });

    expect(briefing).not.toContain('rdk_board_policy_start');
    expect(briefing).toContain('其余 1 个均为只读');
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
