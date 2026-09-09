import { describe, expect, it } from 'vitest';

import { Sim2RealError, isSim2RealError, sim2RealErrorCode } from './sim2real-errors.js';

describe('Sim2RealError', () => {
  it('carries a stable code and keeps the legacy message', () => {
    const error = new Sim2RealError('sim2real_storage_unavailable');
    expect(error.code).toBe('sim2real_storage_unavailable');
    expect(error.message).toBe('sim2real_storage_unavailable');
    expect(isSim2RealError(error)).toBe(true);
  });

  it('forwards a cause and optional detail without affecting code matching', () => {
    const cause = new Error('ENOENT');
    const error = new Sim2RealError('sim2real_storage_unavailable', {
      cause,
      detail: 'ledger.json 在读取中途被替换',
    });
    expect(error.cause).toBe(cause);
    expect(error.detail).toBe('ledger.json 在读取中途被替换');
    expect(sim2RealErrorCode(error)).toBe('sim2real_storage_unavailable');
  });

  it('still recognizes plain Errors whose message is a known code', () => {
    // Adapters that do not import this module remain understandable.
    expect(sim2RealErrorCode(new Error('sim2real_model_version_exists'))).toBe(
      'sim2real_model_version_exists',
    );
    expect(isSim2RealError(new Error('sim2real_model_version_exists'))).toBe(false);
  });

  it('returns null for unknown errors and non-Error values', () => {
    expect(sim2RealErrorCode(new Error('totally unexpected'))).toBeNull();
    expect(sim2RealErrorCode('sim2real_storage_unavailable')).toBe(
      'sim2real_storage_unavailable',
    );
    expect(sim2RealErrorCode(undefined)).toBeNull();
  });
});
