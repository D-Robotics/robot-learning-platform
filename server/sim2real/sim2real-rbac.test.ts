import { describe, expect, it } from 'vitest';

import { principalCan, principalRoles, SIM2REAL_PERMISSIONS } from './sim2real-rbac.js';

describe('sim2real role policy', () => {
  it('keeps legacy principals operator-compatible', () => {
    const principal = { accountId: 'alice' };
    expect(principalCan(principal, SIM2REAL_PERMISSIONS.operate)).toBe(true);
    expect(principalCan(principal, SIM2REAL_PERMISSIONS.agent)).toBe(true);
    expect(principalRoles(principal)).toEqual(['operator']);
  });

  it('makes an explicit viewer read-only and lets owners operate', () => {
    expect(
      principalCan({ accountId: 'viewer', roles: ['viewer'] }, SIM2REAL_PERMISSIONS.operate),
    ).toBe(false);
    expect(
      principalCan({ accountId: 'viewer', roles: ['viewer'] }, SIM2REAL_PERMISSIONS.read),
    ).toBe(true);
    expect(principalCan({ accountId: 'owner', roles: ['owner'] }, SIM2REAL_PERMISSIONS.agent)).toBe(
      true,
    );
  });

  it('fails closed for an explicitly supplied unknown role claim', () => {
    const principal = { accountId: 'malformed', roles: ['not-a-role'] };
    expect(principalCan(principal, SIM2REAL_PERMISSIONS.read)).toBe(false);
    expect(principalCan(principal, SIM2REAL_PERMISSIONS.operate)).toBe(false);
    expect(principalRoles(principal)).toEqual([]);
  });
});
