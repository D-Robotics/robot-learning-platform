import type { NextFunction, Request, Response } from 'express';

export function wrapAsync(handler: (request: Request, response: Response, next: NextFunction) => unknown) {
  return (request: Request, response: Response, next: NextFunction): void => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

export function sendApiError(response: Response, status: number, code: string, message: string, extra: Record<string, unknown> = {}): void {
  // Express exposes getHeader, while lightweight route harnesses may provide
  // only status/json. Keep the correlation field best-effort at this boundary.
  const requestId = typeof response.getHeader === 'function' ? response.getHeader('X-Request-Id') : undefined;
  response.status(status).json({
    ok: false,
    error: code,
    code,
    message,
    ...(typeof requestId === 'string' && requestId ? { requestId } : {}),
    ...extra,
  });
}

export function sendInternalApiError(
  response: Response,
  error: unknown,
  options: { code: string; message: string; messageEn?: string; request?: Request; scope?: string },
): void {
  console.error('[sim2real]', error instanceof Error ? error.message : error);
  sendApiError(response, 500, options.code, options.message, { retryable: true });
}
