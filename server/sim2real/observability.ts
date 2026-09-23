import type { Request, RequestHandler } from 'express';

/**
 * Lightweight, dependency-free observability for the standalone Sim2Real
 * service: JSON-Lines request logs on stdout plus in-process Prometheus
 * counters. It deliberately owns no transport (no external collector, no npm
 * package) so the public distribution keeps working offline.
 *
 * Two hard rules are enforced here rather than trusted to callers:
 *  1. Log records are built from a *whitelist* of fields. Headers, cookies,
 *     tokens and request bodies are never read, so they cannot be logged.
 *  2. Metric labels are normalised and cardinality-capped. A raw URL, run id or
 *     query string can never become a Prometheus label.
 */

export type Sim2RealLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LOG_LEVEL_RANK: Record<Sim2RealLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export const SIM2REAL_LOG_LEVEL_ENV = 'RDK_SIM2REAL_LOG_LEVEL';
export const DEFAULT_SIM2REAL_LOG_LEVEL: Sim2RealLogLevel = 'info';

/** Unknown or malformed values fall back to the documented default. */
export function resolveLogLevel(raw: unknown): Sim2RealLogLevel {
  const value = String(raw ?? '')
    .trim()
    .toLowerCase();
  return value in LOG_LEVEL_RANK ? (value as Sim2RealLogLevel) : DEFAULT_SIM2REAL_LOG_LEVEL;
}

/**
 * The only field names that can ever reach stdout. Adding a field here is the
 * explicit act required to log it; nothing else is copied from the request.
 */
export const LOG_FIELD_WHITELIST = [
  'ts',
  'level',
  'msg',
  'event',
  'requestId',
  'method',
  'path',
  'route',
  'status',
  'durationMs',
  'backend',
  'code',
  'detail',
  'hint',
  'modelId',
  'taskId',
] as const;

const MAX_STRING_FIELD_LENGTH = 200;
const MAX_PATH_FIELD_LENGTH = 300;

function cleanLogString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  // Control characters (notably CR/LF) are stripped so a crafted path can never
  // break the JSON-Lines framing or forge a second log record.
  const text = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return text ? text.slice(0, maxLength) : undefined;
}

function cleanLogNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function sanitizeLogFields(fields: Record<string, unknown>): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const key of LOG_FIELD_WHITELIST) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
    const value = fields[key];
    if (key === 'status' || key === 'durationMs') {
      const numeric = cleanLogNumber(value);
      if (numeric !== undefined) record[key] = Math.round(numeric * 100) / 100;
      continue;
    }
    if (key === 'ts') {
      const timestamp = cleanLogString(value, 40);
      if (timestamp) record[key] = timestamp;
      continue;
    }
    const text = cleanLogString(
      value,
      key === 'path' ? MAX_PATH_FIELD_LENGTH : MAX_STRING_FIELD_LENGTH,
    );
    if (text) record[key] = text;
  }
  return record;
}

export type Sim2RealLogger = {
  readonly level: Sim2RealLogLevel;
  enabled(level: Sim2RealLogLevel): boolean;
  log(level: Sim2RealLogLevel, msg: string, fields?: Record<string, unknown>): void;
};

export type Sim2RealLoggerOptions = {
  level?: unknown;
  sink?: (line: string) => void;
  now?: () => number;
  warn?: (message: string) => void;
};

export function createSim2RealLogger(options: Sim2RealLoggerOptions = {}): Sim2RealLogger {
  const requested =
    options.level === undefined ? process.env[SIM2REAL_LOG_LEVEL_ENV] : options.level;
  const level = resolveLogLevel(requested);
  const sink =
    options.sink ??
    ((line: string) => {
      process.stdout.write(line);
    });
  const now = options.now ?? (() => Date.now());
  const warn =
    options.warn ??
    ((message: string) => {
      console.warn(message);
    });
  const requestedText = String(requested ?? '')
    .trim()
    .toLowerCase();
  if (requestedText && requestedText !== level) {
    // A typo must not silently change verbosity in either direction: keep the
    // documented default and say so exactly once per logger instance.
    warn(
      `[sim2real] ${SIM2REAL_LOG_LEVEL_ENV}="${requestedText}" 不是合法日志级别` +
        `（debug|info|warn|error|silent），已回退为 ${level}。`,
    );
  }

  return {
    level,
    enabled: (candidate) => LOG_LEVEL_RANK[candidate] >= LOG_LEVEL_RANK[level],
    log(candidate, msg, fields = {}) {
      // `silent` and unknown levels are never emitted; the configured threshold
      // filters everything below it.
      if (candidate === 'silent' || !(candidate in LOG_LEVEL_RANK)) return;
      if (LOG_LEVEL_RANK[candidate] < LOG_LEVEL_RANK[level]) return;
      const record = sanitizeLogFields({
        ...fields,
        ts: new Date(now()).toISOString(),
        level: candidate,
        msg,
      });
      if (!record.msg || !record.level) return;
      sink(`${JSON.stringify(record)}\n`);
    },
  };
}

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_SEGMENT = /^[0-9a-f]{16,}$/i;
const NUMERIC_SEGMENT = /^\d+$/;
const ID_TOKEN_SEGMENT = /^[A-Za-z0-9._~-]{20,}$/;

export const MAX_ROUTE_SEGMENTS = 24;
export const MAX_ROUTE_LABEL_LENGTH = 256;

function looksLikeIdentifier(segment: string): boolean {
  if (NUMERIC_SEGMENT.test(segment)) return true;
  if (UUID_SEGMENT.test(segment) || HEX_SEGMENT.test(segment)) return true;
  // Opaque ids such as `run-2026-09-04T00-00-00-000Z-ab12` mix digits and
  // letters and are long; plain route words (`device-connections`) are not
  // rewritten because they carry no digits.
  return ID_TOKEN_SEGMENT.test(segment) && /\d/.test(segment) && /[A-Za-z]/.test(segment);
}

/**
 * Turns a request path into a bounded label: query/hash are dropped and id-like
 * segments become `:id`, so the same route never creates a new time series when
 * a different run id is requested. Express route patterns are already
 * normalised (`/api/sim2real/runs/:runId`) and pass through unchanged.
 */
export function normalizeRouteLabel(_method: string, rawPath: unknown): string {
  const withoutQuery = String(rawPath ?? '').split(/[?#]/, 1)[0] || '/';
  const bounded = withoutQuery.slice(0, 1024);
  const label = bounded
    .split('/')
    .slice(0, MAX_ROUTE_SEGMENTS)
    .map((segment) => (segment && looksLikeIdentifier(segment) ? ':id' : segment.slice(0, 64)))
    .join('/');
  const normalized = label || '/';
  return normalized.length > MAX_ROUTE_LABEL_LENGTH
    ? normalized.slice(0, MAX_ROUTE_LABEL_LENGTH)
    : normalized;
}

export function normalizeMethodLabel(method: unknown): string {
  const value = String(method ?? '')
    .trim()
    .toUpperCase();
  return /^[A-Z]{3,10}$/.test(value) ? value : 'OTHER';
}

function normalizeStatusLabel(status: unknown): string {
  const value = Number(status);
  return Number.isInteger(value) && value >= 100 && value <= 599 ? String(value) : '000';
}

export const DURATION_BUCKETS_SECONDS: readonly number[] = Object.freeze([
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
]);
export const DEFAULT_MAX_ROUTE_LABELS = 300;
const ROUTE_LABEL_OVERFLOW = '__other__';

export type Sim2RealHttpMetricsInput = {
  method: unknown;
  route: unknown;
  status: unknown;
  durationMs: unknown;
};

export type Sim2RealMetrics = {
  recordRequest(input: Sim2RealHttpMetricsInput): void;
  renderPrometheus(): string;
  routeLabelCount(): number;
  requestCount(): number;
};

function escapePrometheusLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

export function createSim2RealMetrics(options: { maxRouteLabels?: number } = {}): Sim2RealMetrics {
  const maxRouteLabels =
    typeof options.maxRouteLabels === 'number' &&
    Number.isSafeInteger(options.maxRouteLabels) &&
    options.maxRouteLabels > 0
      ? options.maxRouteLabels
      : DEFAULT_MAX_ROUTE_LABELS;
  const counters = new Map<string, number>();
  const histograms = new Map<string, { buckets: number[]; sum: number; count: number }>();
  const routeLabels = new Set<string>();
  let totalRequests = 0;

  function boundRoute(route: string): string {
    if (routeLabels.has(route)) return route;
    if (routeLabels.size >= maxRouteLabels) {
      // Cardinality guard: once the budget is spent every new route collapses
      // into one series instead of creating unbounded label values. The
      // overflow label is not itself tracked, so the budget stays exact.
      return ROUTE_LABEL_OVERFLOW;
    }
    routeLabels.add(route);
    return route;
  }

  function recordRequest(input: Sim2RealHttpMetricsInput): void {
    const method = normalizeMethodLabel(input.method);
    const route = boundRoute(normalizeRouteLabel(method, input.route));
    const status = normalizeStatusLabel(input.status);
    const durationMs =
      typeof input.durationMs === 'number' &&
      Number.isFinite(input.durationMs) &&
      input.durationMs >= 0
        ? input.durationMs
        : 0;
    const counterKey = `${method}\u0000${route}\u0000${status}`;
    counters.set(counterKey, (counters.get(counterKey) ?? 0) + 1);
    const histogramKey = `${method}\u0000${route}`;
    let histogram = histograms.get(histogramKey);
    if (!histogram) {
      histogram = { buckets: new Array(DURATION_BUCKETS_SECONDS.length).fill(0), sum: 0, count: 0 };
      histograms.set(histogramKey, histogram);
    }
    const seconds = durationMs / 1000;
    histogram.sum += seconds;
    histogram.count += 1;
    for (let index = 0; index < DURATION_BUCKETS_SECONDS.length; index += 1) {
      if (seconds <= DURATION_BUCKETS_SECONDS[index]) histogram.buckets[index] += 1;
    }
    totalRequests += 1;
  }

  function renderPrometheus(): string {
    const lines: string[] = [];
    lines.push(
      '# HELP sim2real_http_requests_total Completed HTTP requests by method, normalized route and status.',
    );
    lines.push('# TYPE sim2real_http_requests_total counter');
    for (const key of [...counters.keys()].sort()) {
      const [method, route, status] = key.split('\u0000');
      lines.push(
        `sim2real_http_requests_total{method="${escapePrometheusLabel(method)}",` +
          `route="${escapePrometheusLabel(route)}",status="${escapePrometheusLabel(status)}"} ` +
          String(counters.get(key)),
      );
    }
    lines.push(
      '# HELP sim2real_http_request_duration_seconds Completed HTTP request duration in seconds.',
    );
    lines.push('# TYPE sim2real_http_request_duration_seconds histogram');
    for (const key of [...histograms.keys()].sort()) {
      const [method, route] = key.split('\u0000');
      const histogram = histograms.get(key);
      if (!histogram) continue;
      const labels = `method="${escapePrometheusLabel(method)}",route="${escapePrometheusLabel(route)}"`;
      DURATION_BUCKETS_SECONDS.forEach((bound, index) => {
        lines.push(
          `sim2real_http_request_duration_seconds_bucket{${labels},le="${bound}"} ` +
            String(histogram.buckets[index]),
        );
      });
      lines.push(
        `sim2real_http_request_duration_seconds_bucket{${labels},le="+Inf"} ${histogram.count}`,
      );
      lines.push(`sim2real_http_request_duration_seconds_sum{${labels}} ${histogram.sum}`);
      lines.push(`sim2real_http_request_duration_seconds_count{${labels}} ${histogram.count}`);
    }
    lines.push('# HELP sim2real_process_uptime_seconds Process uptime in seconds.');
    lines.push('# TYPE sim2real_process_uptime_seconds gauge');
    lines.push(`sim2real_process_uptime_seconds ${Math.max(0, process.uptime()).toFixed(3)}`);
    lines.push('# HELP sim2real_memory_rss_bytes Resident set size of the process in bytes.');
    lines.push('# TYPE sim2real_memory_rss_bytes gauge');
    lines.push(`sim2real_memory_rss_bytes ${Math.max(0, Math.trunc(process.memoryUsage().rss))}`);
    // Only counters and gauges derived from this process are exposed: no
    // environment variable, token, file path or client address is ever read.
    return `${lines.join('\n')}\n`;
  }

  return {
    recordRequest,
    renderPrometheus,
    routeLabelCount: () => routeLabels.size,
    requestCount: () => totalRequests,
  };
}

/**
 * Resolves the label for a completed request. A matched Express route supplies
 * its own pattern (`:runId`); unmatched requests (404s) fall back to the
 * normalised path so a probe storm cannot explode label cardinality.
 */
export function routeLabelForRequest(request: Request): string {
  const method = normalizeMethodLabel(request.method);
  const routePath =
    request.route && typeof request.route.path === 'string' ? request.route.path : '';
  const baseUrl = typeof request.baseUrl === 'string' ? request.baseUrl : '';
  const candidate = routePath ? `${baseUrl}${routePath}` : String(request.path ?? '/');
  return normalizeRouteLabel(method, candidate);
}

export type RequestObservabilityOptions = {
  logger: Sim2RealLogger;
  metrics: Sim2RealMetrics;
  now?: () => number;
  /**
   * Optional 5xx side channel for external ops-event reporting. The middleware
   * stays transport-free; the callback owns any network delivery and must
   * never throw (handler errors would escape the response 'finish' listener).
   */
  onServerError?: (input: {
    method: string;
    route: string;
    status: number;
    requestId?: string;
    durationMs: number;
  }) => void;
};

/**
 * Records every completed request as a metric; logs API traffic and every 5xx
 * (error level). Static asset noise is intentionally not logged, and the log
 * record is assembled from the whitelist above — never from headers or bodies.
 */
export function createRequestObservabilityMiddleware(
  options: RequestObservabilityOptions,
): RequestHandler {
  const now = options.now ?? (() => Date.now());
  return (request, response, next) => {
    const startedAt = now();
    response.on('finish', () => {
      const durationMs = Math.max(0, now() - startedAt);
      const method = normalizeMethodLabel(request.method);
      const route = routeLabelForRequest(request);
      const status = Number(response.statusCode) || 0;
      options.metrics.recordRequest({ method, route, status, durationMs });
      const path = normalizeRouteLabel(method, request.path);
      if (!path.startsWith('/api/') && status < 500) return;
      const header =
        typeof response.getHeader === 'function' ? response.getHeader('X-Request-Id') : undefined;
      options.logger.log(status >= 500 ? 'error' : 'info', 'http_request', {
        event: 'http_request',
        requestId: typeof header === 'string' ? header : undefined,
        method,
        path,
        route,
        status,
        durationMs,
      });
      if (status >= 500 && options.onServerError) {
        try {
          options.onServerError({
            method,
            route,
            status,
            requestId: typeof header === 'string' ? header : undefined,
            durationMs,
          });
        } catch {
          // A reporting hook must never break the finish listener.
        }
      }
    });
    next();
  };
}

export type Sim2RealObservability = {
  logger: Sim2RealLogger;
  metrics: Sim2RealMetrics;
  requestMiddleware: RequestHandler;
  renderMetrics(): string;
};

export function createSim2RealObservability(
  options: Sim2RealLoggerOptions & {
    maxRouteLabels?: number;
    onServerError?: RequestObservabilityOptions['onServerError'];
  } = {},
): Sim2RealObservability {
  const logger = createSim2RealLogger(options);
  const metrics = createSim2RealMetrics({ maxRouteLabels: options.maxRouteLabels });
  return {
    logger,
    metrics,
    requestMiddleware: createRequestObservabilityMiddleware({
      logger,
      metrics,
      now: options.now,
      ...(options.onServerError ? { onServerError: options.onServerError } : {}),
    }),
    renderMetrics: () => metrics.renderPrometheus(),
  };
}
