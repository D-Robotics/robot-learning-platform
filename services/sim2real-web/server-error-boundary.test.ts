import { describe, expect, it, vi } from 'vitest';

import { sendApiError, sendInternalApiError } from '../../server/sim2real/http-helpers.js';
import { publicUpstreamErrorMessage, redactInternalError } from './server.js';

describe('web upstream error boundary', () => {
  it('redacts endpoint coordinates and credentials before logging', () => {
    const message = redactInternalError(
      new Error(
        'fetch https://runner.example.test/train?token=secret-value failed: Bearer super-secret-token password=another-secret',
      ),
    );

    expect(message).not.toContain('runner.example.test');
    expect(message).not.toContain('secret-value');
    expect(message).not.toContain('super-secret-token');
    expect(message).not.toContain('another-secret');
    expect(message).toContain('[upstream-url]');
    expect(message).toContain('Bearer [redacted]');
    expect(message.length).toBeLessThanOrEqual(400);
  });

  it('keeps client-facing upstream messages fixed and actionable', () => {
    expect(publicUpstreamErrorMessage('microduck')).toBe(
      'MicroDuck 上游仿真服务暂时不可达，请稍后重试。',
    );
    expect(publicUpstreamErrorMessage('dsh')).toBe('智能体运行时暂时不可用，请稍后重试。');
  });

  it('uses the same redaction policy for internal route failures', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = {
      getHeader: () => 'request-123',
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as any;
    sendInternalApiError(
      response,
      new Error(
        'upstream https://runner.example.test/train?token=private-value Bearer long-secret-token',
      ),
      {
        code: 'SIM2REAL_STORE_FAILED',
        message: '状态保存失败。',
        request: { method: 'POST', path: '/api/sim2real/runs' } as any,
        scope: 'test-boundary',
      },
    );
    const output = log.mock.calls.flat().map(String).join(' ');
    expect(output).not.toContain('private-value');
    expect(output).not.toContain('long-secret-token');
    expect(output).toContain('request-123');
    expect(response.status).toHaveBeenCalledWith(500);
    log.mockRestore();
  });

  it('keeps the public error envelope authoritative over optional metadata', () => {
    const response = {
      getHeader: () => 'request-123',
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as any;

    sendApiError(response, 409, 'SIM2REAL_CONFLICT', '操作冲突。', {
      retryable: false,
      detail: 'safe metadata',
      ok: true,
      error: 'spoofed',
      code: 'spoofed-code',
      message: 'spoofed message',
      requestId: 'spoofed-request',
    });

    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith({
      retryable: false,
      detail: 'safe metadata',
      ok: false,
      error: 'SIM2REAL_CONFLICT',
      code: 'SIM2REAL_CONFLICT',
      message: '操作冲突。',
      requestId: 'request-123',
    });
  });
});
