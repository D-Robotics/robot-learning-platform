import type { NextFunction, Request, Response } from 'express';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? 'unknown error');
}

/**
 * Keep provider/storage failures useful in server logs without allowing
 * endpoint coordinates, credentials, or control characters to cross the log
 * boundary.  This lives in the route helper so every HTTP error path shares
 * the same redaction policy (including the generic Express error middleware).
 */
export function redactInternalError(error: unknown): string {
  const text = errorText(error)
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[upstream-url]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, (match) => `${match.split(/\s+/, 1)[0]} [redacted]`)
    .replace(/\b(?:token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, (match) => {
      const separator = match.match(/\s*[:=]\s*/)?.[0] ?? '=';
      return `${match.split(separator)[0]}${separator}[redacted]`;
    });
  const printable = Array.from(text, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f ? ' ' : character;
  })
    .join('')
    .trim()
    .slice(0, 400);
  return printable || 'unknown error';
}

export function wrapAsync(
  handler: (request: Request, response: Response, next: NextFunction) => unknown,
) {
  return (request: Request, response: Response, next: NextFunction): void => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

export function sendApiError(
  response: Response,
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): void {
  // Express exposes getHeader, while lightweight route harnesses may provide
  // only status/json. Keep the correlation field best-effort at this boundary.
  const requestId =
    typeof response.getHeader === 'function' ? response.getHeader('X-Request-Id') : undefined;
  // Keep the error envelope authoritative even when a route adds optional
  // metadata.  A future caller accidentally passing `{ ok: true }` (or a
  // stale `message`/`requestId`) must not turn a failed response into a
  // success or break correlation semantics.  Filter only reserved envelope
  // keys; all other deployment-specific metadata remains available.
  const reservedKeys = new Set(['ok', 'error', 'code', 'message', 'requestId']);
  const safeExtra = Object.fromEntries(
    Object.entries(extra).filter(([key]) => !reservedKeys.has(key)),
  );
  response.status(status).json({
    ...safeExtra,
    ok: false,
    error: code,
    code,
    message,
    ...(typeof requestId === 'string' && requestId ? { requestId } : {}),
  });
}

export function sendInternalApiError(
  response: Response,
  error: unknown,
  options: { code: string; message: string; messageEn?: string; request?: Request; scope?: string },
): void {
  const requestId =
    typeof response.getHeader === 'function' ? response.getHeader('X-Request-Id') : undefined;
  const request = options.request;
  console.error(
    '[sim2real] internal error',
    JSON.stringify({
      scope: options.scope ?? 'http',
      requestId: typeof requestId === 'string' ? requestId : undefined,
      method: request?.method,
      path: request?.path,
      error: redactInternalError(error),
    }),
  );
  sendApiError(response, 500, options.code, options.message, { retryable: true });
}
