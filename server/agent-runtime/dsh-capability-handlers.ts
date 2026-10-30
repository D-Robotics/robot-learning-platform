/**
 * Product bindings for the DSH capability tools.
 *
 * Each handler calls this service's own authenticated domain routes over the
 * loopback executor instead of reaching into store internals. That keeps one
 * enforcement path — RBAC, motion switches, release-evidence gates, ledger
 * serialization — behind every model-initiated action, identical to what the
 * legacy agent executor and the web UI exercise.
 *
 * DSH tools are registered once at startup and have no per-request channel,
 * while HTTP auth is per-request. `createDshAuthChannel` bridges that gap: the
 * chat route stashes the caller's forwarded headers for the duration of one
 * turn, and handlers read them from an async-local context. Concurrent users
 * therefore keep their credentials isolated; the route separately serializes
 * turns that share one persisted DSH session.
 */
import type { DshCapabilityHandlers } from './dsh-capability-tools.js';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import { readSim2RealAgentResponseText } from '../routes/sim2real-agent-routes.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { normalizeOriginmanWorkshopResult } from '../../shared/originman-workshop.js';
import { createHash, randomUUID } from 'node:crypto';
import { listManuals } from 'rdk-docs-mcp/dist/catalog.js';
import { fetchText } from 'rdk-docs-mcp/dist/http.js';
import { getPage, listToc, searchDocs } from 'rdk-docs-mcp/dist/service.js';

export type LoopbackFetch = (
  path: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  },
) => Promise<Response>;

type ChannelEntry = {
  headers: Record<string, string>;
  idempotencyCounters: Map<string, number>;
};
const authContext = new AsyncLocalStorage<ChannelEntry>();

/** Forward one turn's caller identity (cookie / authorization) to tool calls. */
export function createDshAuthChannel(): {
  withAuth<T>(headers: Record<string, string>, work: () => Promise<T>): Promise<T>;
} {
  return {
    withAuth: <T>(headers: Record<string, string>, work: () => Promise<T>) =>
      authContext.run({ headers, idempotencyCounters: new Map() }, work),
  };
}

function forwardedHeaders(): Record<string, string> {
  return { ...(authContext.getStore()?.headers ?? {}) };
}

/** Read the current request identity from a DSH tool/approval callback. */
export function currentDshAuthHeaders(): Record<string, string> {
  return forwardedHeaders();
}

/** Reuse one turn key across retries while separating repeated writes in one turn. */
function dshIdempotencyKey(prefix: string): string {
  const store = authContext.getStore();
  const turnId = store?.headers['x-sim2real-turn-id'];
  const suffix = turnId || randomUUID();
  const ordinal = store
    ? (store.idempotencyCounters.get(prefix) ?? 0)
    : 0;
  store?.idempotencyCounters.set(prefix, ordinal + 1);
  const key = `dsh-${prefix}-${suffix}-${ordinal}`;
  if (key.length <= 128) return key;
  // Chat accepts turn ids up to 120 characters, while domain routes cap the
  // complete key at 128. Hash the entire suffix instead of truncating either
  // the id or ordinal. ':' cannot occur in a client turn id, keeping hashed
  // long ids distinct from unchanged short ids.
  const digest = createHash('sha256').update(suffix).digest('hex');
  return `dsh-${prefix}-sha256:${digest}-${ordinal}`;
}

function loopbackFetch(): LoopbackFetch {
  const port = Number(process.env.RDK_SIM2REAL_PORT ?? 18_102);
  const base = `http://127.0.0.1:${Number.isInteger(port) && port >= 1_024 && port <= 65_535 ? port : 18_102}`;
  return async (path, init) => {
    const response = await fetch(base + path, {
      method: init.method,
      headers: { accept: 'application/json', ...init.headers },
      body: init.body,
      redirect: 'error',
      signal: init.signal,
    });
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

type LoopbackResult = { status: number; ok: boolean; body: Record<string, unknown> };

async function call(
  fetchImpl: LoopbackFetch,
  signal: AbortSignal,
  path: string,
  init: { method: string; json?: unknown; idempotencyKey?: string },
): Promise<LoopbackResult> {
  const headers = { ...forwardedHeaders() };
  if (init.json !== undefined) headers['content-type'] = 'application/json';
  if (init.idempotencyKey) headers['idempotency-key'] = init.idempotencyKey;
  const raw = await fetchImpl(path, {
    method: init.method,
    headers,
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
    signal,
  });
  const text = await readSim2RealAgentResponseText(raw);
  let body: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    // HTML error pages and non-JSON bodies collapse to an empty payload;
    // the HTTP status alone drives the failure path.
  }
  return { status: raw.status, ok: raw.ok, body };
}

/**
 * Model-facing failures carry a short stable code plus the route's own
 * user-facing message; transport detail and upstream bodies never reach the
 * conversation.
 */
class CapabilityError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CapabilityError';
  }
}

function fail(status: number, body: Record<string, unknown>, fallback: string): never {
  const routeMessage = typeof body.message === 'string' ? body.message.trim() : '';
  throw new CapabilityError(
    status >= 400 && status < 500 ? 'DSH_CAPABILITY_REJECTED' : 'DSH_CAPABILITY_FAILED',
    routeMessage || fallback,
  );
}

function argsRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

/**
 * DSH requires tool results to be lossless JSON: a property holding
 * `undefined` survives normal `JSON.stringify` elision but fails the
 * registry's canonical-value check, so every optional field is normalized to
 * a concrete value before returning.
 */
function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function defined(value: unknown): unknown {
  return value === undefined ? null : value;
}

/**
 * External knowledge source for the agent: the lockfile-pinned
 * `rdk-docs-mcp` package (same owner as Studio's bundled docs MCP, per
 * that project's ADR D-008). We call its pure retrieval functions directly
 * instead of going through the MCP protocol — no second transport, no
 * client SDK, and the same versioned retrieval quality. The package fetches
 * developer.d-robotics.cc / forum.d-robotics.cc live with its own disk
 * cache; page reads are host-allowlisted below so a model cannot point
 * them at an arbitrary origin.
 */
export type DshDocsService = {
  searchDocs: typeof searchDocs;
  listToc: typeof listToc;
  getPage: typeof getPage;
  listManuals: typeof listManuals;
};

const defaultDocsService: DshDocsService = { searchDocs, listToc, getPage, listManuals };

const RDK_DOCS_ALLOWED_HOSTS = new Set(['developer.d-robotics.cc', 'forum.d-robotics.cc']);

/**
 * General web search, free tier: Bing's HTML results (cn.bing.com is
 * reachable from both mainland deployments and overseas; no API key). The
 * model never gets a fetch-everything primitive here — only ranked
 * title/url/snippet triples, so search cannot be turned into an SSRF or
 * scraping tool. Throttled per process to stay polite to the free endpoint.
 */
type WebSearchHit = { title: string; url: string; snippet: string };
export type WebSearchFn = (query: string) => Promise<WebSearchHit[]>;

const WEB_SEARCH_TIMEOUT_MS = 12_000;
const WEB_SEARCH_MIN_INTERVAL_MS = 3_000;
let webSearchLastAt = 0;
// 免费通道会被高频查询限流降级（返回无关内容）。相同查询在 10 分钟内
// 直接回缓存，既省配额也避免模型反复重试同一词时把通道打进降级态。
const WEB_SEARCH_CACHE_TTL_MS = 600_000;
const webSearchCache = new Map<string, { at: number; hits: WebSearchHit[] }>();

function webSearchCacheKey(query: string): string {
  return query.trim().replace(/\s+/g, ' ').toLowerCase();
}

function webSearchCacheGet(key: string): WebSearchHit[] | undefined {
  const entry = webSearchCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.at > WEB_SEARCH_CACHE_TTL_MS) {
    webSearchCache.delete(key);
    return undefined;
  }
  // 重新插入实现 LRU 语义（Map 迭代按插入序）。
  webSearchCache.delete(key);
  webSearchCache.set(key, entry);
  return entry.hits;
}

function webSearchCachePut(key: string, hits: WebSearchHit[]): void {
  if (webSearchCache.size >= 16) {
    const oldest = webSearchCache.keys().next().value;
    if (oldest !== undefined) webSearchCache.delete(oldest);
  }
  webSearchCache.set(key, { at: Date.now(), hits });
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&ensp;/g, ' ')
    .replace(/&#0183;/g, '·')
    .replace(/&middot;/g, '·')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function unwrapBingRedirect(url: string): string {
  const marker = '&u=a1';
  const index = url.indexOf(marker);
  if (index < 0) return url;
  try {
    const encoded = url.slice(index + marker.length).split('&')[0];
    return Buffer.from(decodeURIComponent(encoded), 'base64url').toString('utf8');
  } catch {
    return url;
  }
}

async function bingWebSearch(query: string): Promise<WebSearchHit[]> {
  const response = await fetch(
    `https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=10`,
    {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'accept-language': 'zh-CN,zh;q=0.9',
      },
      signal: AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    fail(502, { status: response.status }, `全网搜索失败（HTTP ${response.status}）。`);
  }
  const html = (await response.text()).slice(0, 1_500_000);
  const blocks = html.split('<li class="b_algo"').slice(1);
  const hits: WebSearchHit[] = [];
  for (const block of blocks) {
    const anchor = block.match(/<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!anchor) continue;
    const snippetMatch = block.match(/<p class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    hits.push({
      title: decodeEntities(anchor[2].replace(/<[^>]*>/g, '')).slice(0, 200),
      url: unwrapBingRedirect(anchor[1]),
      snippet: snippetMatch ? decodeEntities(snippetMatch[1].replace(/<[^>]*>/g, '')).slice(0, 300) : '',
    });
    if (hits.length >= 6) break;
  }
  return hits;
}

/**
 * The docs package throws raw transport errors (fetch failed, parse errors).
 * D-008 discipline: upstream failures surface as a stable capability error
 * with an operator-facing message, never as a leaked transport detail — and
 * the model is expected to tell the user the official material is unverified.
 */
async function callDocs<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof CapabilityError) throw error;
    return fail(
      502,
      { reason: (error as Error)?.message },
      'D-Robotics 官方资料检索失败（网络或上游错误）；请告知用户官方资料未核对。',
    );
  }
}

function assertDocsUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !RDK_DOCS_ALLOWED_HOSTS.has(parsed.hostname)) {
      fail(400, { url }, '只允许读取 D-Robotics 官方站点（developer.d-robotics.cc / forum.d-robotics.cc）的页面。');
    }
    return parsed.toString();
  } catch (error) {
    if (error instanceof CapabilityError) throw error;
    return fail(400, { url }, '页面 URL 无法解析。');
  }
}

function argString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value.trim().slice(0, 128) : '';
}

function argText(args: Record<string, unknown>, key: string, max = 2_000): string {
  const value = args[key];
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function argNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function argStringList(
  args: Record<string, unknown>,
  key: string,
  max = 500,
): string[] | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, max);
}

function requiredArg(args: Record<string, unknown>, key: string, message: string): string {
  const value = argString(args, key);
  if (!value) throw new CapabilityError('DSH_CAPABILITY_REJECTED', message);
  return value;
}

function requiredNumberArg(args: Record<string, unknown>, key: string, message: string): number {
  const value = argNumber(args, key);
  if (value === undefined) throw new CapabilityError('DSH_CAPABILITY_REJECTED', message);
  return value;
}

function policyCommandArg(value: unknown): Record<string, number> {
  const command = argsRecord(value);
  if (Object.keys(command).some((key) => !['vx', 'vy', 'wz', 'ttlMs'].includes(key)) ||
      !['vx', 'vy', 'wz'].every((key) => typeof command[key] === 'number' && Number.isFinite(command[key])) ||
      (command.ttlMs !== undefined && (!Number.isInteger(command.ttlMs) || Number(command.ttlMs) < 1 || Number(command.ttlMs) > 2000))) {
    throw new CapabilityError('DSH_CAPABILITY_REJECTED', 'command 需包含有限数值 vx/vy/wz（m/s、m/s、rad/s）；ttlMs 可选，必须为 1..2000 的整数。');
  }
  return command as Record<string, number>;
}

/** Adapter shape only; platform policy, resource limits and approvals remain upstream. */
const TRAINING_ARGUMENT_TYPES: Record<string, 'string' | 'number' | 'boolean' | 'string-array' | 'object'> = {
  modelId: 'string', backend: 'string', profile: 'string', engine: 'string', algorithm: 'string',
  numEnvs: 'number', maxIterations: 'number', runName: 'string', taskId: 'string',
  projectId: 'string', experimentId: 'string', label: 'string', datasetIds: 'string-array',
  computeResourceId: 'string', video: 'boolean', idempotencyKey: 'string',
  demonstrationRunId: 'string', originmanWorkshop: 'object',
};

function rejectUnsupportedTrainingInputs(input: Record<string, unknown>): void {
  const unsupported = Object.keys(input).filter((key) => !Object.hasOwn(TRAINING_ARGUMENT_TYPES, key));
  if (unsupported.length) {
    throw new CapabilityError(
      'DSH_CAPABILITY_REJECTED',
      `rdk_training_submit 不支持参数 ${unsupported.join('、')}，不会忽略后提交另一种任务。` +
        '使用工具 schema 声明的平铺参数；真实 BC 可用 demonstrationRunId 选择已上传轨迹，ACT/DP 和额外调参请按仓库 CLI 契约执行，' +
        '检查点续训使用平台版本化 API 的 resumeFrom 契约。datasetIds 只关联血缘，不上传文件。',
    );
  }
  for (const [key, value] of Object.entries(input)) {
    const expected = TRAINING_ARGUMENT_TYPES[key];
    const valid = expected === 'object'
      ? value !== null && typeof value === 'object' && !Array.isArray(value)
      : expected === 'string-array'
      ? Array.isArray(value) && value.every((id) => typeof id === 'string' && !!id.trim())
      : expected === 'number'
        ? typeof value === 'number' && Number.isFinite(value)
        : expected === 'string'
          ? typeof value === 'string' && !!value.trim()
          : typeof value === 'boolean';
    if (!valid) {
      throw new CapabilityError(
        'DSH_CAPABILITY_REJECTED',
        `${key} 必须是${expected === 'string-array' ? '非空字符串 ID 的数组' : expected === 'number' ? '有限 JSON 数值（不接受字符串）' : expected === 'string' ? '非空字符串' : 'JSON 布尔值'}；不会忽略无效值或采用默认值后提交另一种训练。`,
      );
    }
  }
}

function trainingDataEvidence(trainingRun: Record<string, unknown>) {
  const source = objectValue(trainingRun.trainingData);
  const metrics = objectValue(trainingRun.metrics);
  const sha256 = str(source.sha256);
  const valid = /^[a-f0-9]{64}$/.test(sha256) && /^[a-f0-9]{64}$/.test(str(source.telemetryRevision)) &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(str(source.sourceRunId)) &&
    ['browser', 'import', 'board-agent'].includes(str(source.source)) &&
    typeof source.rows === 'number' && Number.isSafeInteger(source.rows) && source.rows >= 12 && source.rows <= 50000;
  const trainingData = valid ? {
    sourceRunId: str(source.sourceRunId).slice(0, 200),
    telemetryRevision: str(source.telemetryRevision).slice(0, 128),
    source: str(source.source).slice(0, 64),
    rows: defined(source.rows),
    sha256,
  } : null;
  const consumptionVerified = !!trainingData && trainingRun.status === 'completed' &&
    metrics.syntheticData === false && metrics.trainingDataSha256 === sha256;
  return { trainingData, consumptionVerified };
}

function queryPath(pathname: string, query: Record<string, string | number | undefined>): string {
  const params = Object.entries(query).filter(([, value]) => value !== undefined && value !== '');
  if (!params.length) return pathname;
  return `${pathname}?${params
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&')}`;
}

function stationPath(pathname: string, args: Record<string, unknown>): string {
  return queryPath(pathname, { deviceId: argString(args, 'deviceId') });
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function boundedArray(value: unknown, max = 50): unknown[] {
  return Array.isArray(value) ? value.slice(0, max) : [];
}

function compactRecords(
  value: unknown,
  fields: readonly string[],
  max = 50,
): Array<Record<string, unknown>> {
  return boundedArray(value, max).map((item) => {
    const source = objectValue(item);
    return Object.fromEntries(fields.map((field) => [field, defined(source[field])]));
  });
}

/** Compact, low-cardinality overview the model can reason over in one call. */
function overviewDigest(body: Record<string, unknown>): Record<string, unknown> {
  const models = Array.isArray(body.models) ? body.models : [];
  const runs = Array.isArray(body.runs) ? body.runs : [];
  const devices = Array.isArray(body.devices) ? body.devices : [];
  const deployments = Array.isArray(body.deployments) ? body.deployments : [];
  const projects = Array.isArray(body.projects) ? body.projects : [];
  const datasets = Array.isArray(body.datasets) ? body.datasets : [];
  const artifacts = Array.isArray(body.artifacts) ? body.artifacts : [];
  const evaluations = Array.isArray(body.evaluations) ? body.evaluations : [];
  const computeResources = Array.isArray(body.computeResources) ? body.computeResources : [];
  const integrations = (body.integrations ?? {}) as Record<string, unknown>;
  const simulator = (integrations.simulator ?? {}) as Record<string, unknown>;
  return {
    models: models.map((item) => {
      const model = (item ?? {}) as Record<string, unknown>;
      return { id: str(model.id), taskId: str(model.taskId), status: str(model.status) };
    }),
    runs: runs.slice(0, 10).map((item) => {
      const run = (item ?? {}) as Record<string, unknown>;
      return {
        id: str(run.id),
        status: str(run.status),
        modelId: str(run.modelId),
        backend: str(run.backend),
      };
    }),
    devices: devices.map((item) => {
      const device = (item ?? {}) as Record<string, unknown>;
      return { id: str(device.id), profile: str(device.profile), status: str(device.status) };
    }),
    deployments: deployments.slice(0, 5).map((item) => {
      const deployment = (item ?? {}) as Record<string, unknown>;
      return {
        id: str(deployment.id),
        status: str(deployment.status),
        mode: str(deployment.mode),
      };
    }),
    projects: compactRecords(projects, ['id', 'name', 'slug', 'description'], 20),
    datasets: compactRecords(datasets, ['id', 'name', 'version', 'status', 'sampleCount'], 20),
    artifacts: compactRecords(
      artifacts,
      ['id', 'name', 'status', 'format', 'modelId', 'runId'],
      20,
    ),
    evaluations: compactRecords(evaluations, ['id', 'runId', 'status', 'summary'], 20),
    computeResources: compactRecords(
      computeResources,
      ['id', 'name', 'source', 'runnerUrl', 'health', 'tokenConfigured'],
      20,
    ),
    integrations: {
      simulator: defined(simulator.entryUrl ?? simulator.browser ?? null),
      boardAgent: defined(integrations.boardAgent),
      localTraining: defined(integrations.local),
    },
  };
}

function firstModelId(body: Record<string, unknown>): string {
  const models = Array.isArray(body.models) ? body.models : [];
  const model = (models[0] ?? {}) as Record<string, unknown>;
  return typeof model.id === 'string' ? model.id : 'builtin-microduck';
}

function firstDeviceId(body: Record<string, unknown>): string | null {
  const devices = Array.isArray(body.devices) ? body.devices : [];
  const device = (devices[0] ?? {}) as Record<string, unknown>;
  return typeof device.id === 'string' && device.id ? device.id : null;
}

/**
 * Real product handlers for the registered `rdk_*` DSH tools. Write operations ride
 * the same routes the UI uses, so RBAC and the motion/release gates apply
 * unchanged; nothing here bypasses a gate.
 */
export function createDshCapabilityHandlers(
  options: {
    fetchImpl?: LoopbackFetch;
    docsService?: DshDocsService;
    webSearch?: WebSearchFn;
  } = {},
): DshCapabilityHandlers {
  const fetchImpl = options.fetchImpl ?? loopbackFetch();
  const run = (signal: AbortSignal) => ({
    signal,
    fetch: (path: string, init: { method: string; json?: unknown; idempotencyKey?: string }) =>
      call(fetchImpl, signal, path, init),
  });
  return {
    async rdk_workspace_overview(_args: unknown, exec: ToolRunContext) {
      const result = await run(exec.signal).fetch('/api/sim2real/overview', { method: 'GET' });
      if (!result.ok) fail(result.status, result.body, '工作区读取失败');
      return overviewDigest(result.body);
    },

    async rdk_workspace_summary(_args: unknown, exec: ToolRunContext) {
      const result = await run(exec.signal).fetch('/api/sim2real/workspace-summary', {
        method: 'GET',
      });
      if (!result.ok) fail(result.status, result.body, '工作区摘要读取失败');
      return {
        generatedAt: str(result.body.generatedAt),
        counts: objectValue(result.body.counts),
        latest: objectValue(result.body.latest),
      };
    },

    async rdk_golden_path(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      const result = await run(exec.signal).fetch(
        queryPath('/api/sim2real/golden-path', {
          projectId: argString(input, 'projectId'),
          modelId: argString(input, 'modelId'),
          taskId: argString(input, 'taskId'),
        }),
        { method: 'GET' },
      );
      if (!result.ok) fail(result.status, result.body, 'RDK 主链路进度读取失败');
      return { goldenPath: defined(result.body.goldenPath) };
    },

    async rdk_projects_list(_args: unknown, exec: ToolRunContext) {
      const result = await run(exec.signal).fetch('/api/sim2real/projects', { method: 'GET' });
      if (!result.ok) fail(result.status, result.body, '项目列表读取失败');
      return {
        projects: compactRecords(result.body.projects, ['id', 'name', 'slug', 'description']),
      };
    },

    async rdk_project_create(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      const name = requiredArg(input, 'name', '请提供项目名称。');
      const modelIds = argStringList(input, 'modelIds', 100) ?? [];
      const datasetIds = argStringList(input, 'datasetIds', 500) ?? [];
      const result = await run(exec.signal).fetch('/api/sim2real/projects', {
        method: 'POST',
        idempotencyKey: dshIdempotencyKey('project'),
        json: {
          name,
          ...(argText(input, 'slug', 64) ? { slug: argText(input, 'slug', 64) } : {}),
          ...(argText(input, 'description', 4_000)
            ? { description: argText(input, 'description', 4_000) }
            : {}),
          modelIds,
          datasetIds,
        },
      });
      if (!result.ok) fail(result.status, result.body, '项目创建失败');
      const project = objectValue(result.body.project);
      return { id: str(project.id), name: str(project.name), slug: str(project.slug) };
    },

    async rdk_datasets_list(_args: unknown, exec: ToolRunContext) {
      const result = await run(exec.signal).fetch('/api/sim2real/datasets', { method: 'GET' });
      if (!result.ok) fail(result.status, result.body, '数据集列表读取失败');
      return {
        datasets: compactRecords(result.body.datasets, [
          'id',
          'name',
          'version',
          'status',
          'format',
          'sampleCount',
          'sourceRunId',
          'contractId',
        ]),
      };
    },

    async rdk_dataset_register(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      const name = requiredArg(input, 'name', '请提供数据集名称。');
      const tags = argStringList(input, 'tags', 32) ?? [];
      const result = await run(exec.signal).fetch('/api/sim2real/datasets', {
        method: 'POST',
        idempotencyKey: dshIdempotencyKey('dataset'),
        json: {
          name,
          ...(argText(input, 'version', 64) ? { version: argText(input, 'version', 64) } : {}),
          ...(argText(input, 'description', 4_000)
            ? { description: argText(input, 'description', 4_000) }
            : {}),
          ...(argText(input, 'uri', 2_048) ? { uri: argText(input, 'uri', 2_048) } : {}),
          ...(argText(input, 'format', 32) ? { format: argText(input, 'format', 32) } : {}),
          ...(argText(input, 'sha256', 64) ? { sha256: argText(input, 'sha256', 64) } : {}),
          ...(argText(input, 'contractId', 128)
            ? { contractId: argText(input, 'contractId', 128) }
            : {}),
          ...(argText(input, 'sourceRunId', 128)
            ? { sourceRunId: argText(input, 'sourceRunId', 128) }
            : {}),
          ...(argNumber(input, 'sampleCount') === undefined
            ? {}
            : { sampleCount: argNumber(input, 'sampleCount') }),
          ...(argNumber(input, 'sizeBytes') === undefined
            ? {}
            : { sizeBytes: argNumber(input, 'sizeBytes') }),
          tags,
        },
      });
      if (!result.ok) fail(result.status, result.body, '数据集登记失败');
      const dataset = objectValue(result.body.dataset);
      return { id: str(dataset.id), name: str(dataset.name), status: str(dataset.status) };
    },

    async rdk_models_list(_args: unknown, exec: ToolRunContext) {
      const result = await run(exec.signal).fetch('/api/sim2real/models', { method: 'GET' });
      if (!result.ok) fail(result.status, result.body, '模型列表读取失败');
      return {
        models: compactRecords(result.body.models, [
          'id',
          'taskId',
          'status',
          'builtin',
          'createdAt',
          'updatedAt',
        ]),
      };
    },

    async rdk_model_validate(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      const manifest = input.manifest ?? input;
      const platforms = argStringList(input, 'platforms', 12) ?? [];
      const result = await run(exec.signal).fetch('/api/sim2real/models/validate', {
        method: 'POST',
        json: { manifest, platforms },
      });
      if (!result.ok) fail(result.status, result.body, '模型 manifest 校验失败');
      const validation = objectValue(result.body.validation);
      return {
        valid: validation.valid === true,
        errors: boundedArray(validation.errors, 20),
        warnings: boundedArray(validation.warnings, 20),
        compatibility: defined(result.body.compatibility),
      };
    },

    async rdk_model_register(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      const manifest = input.manifest ?? input;
      const result = await run(exec.signal).fetch('/api/sim2real/models', {
        method: 'POST',
        idempotencyKey: dshIdempotencyKey('model'),
        json: manifest,
      });
      if (!result.ok) fail(result.status, result.body, '模型登记失败');
      const model = objectValue(result.body.model);
      return {
        id: str(model.id),
        productId: str(result.body.productId),
        contractId: str(result.body.contractId),
        status: str(model.status),
      };
    },

    async rdk_runs_list(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      const result = await run(exec.signal).fetch(
        queryPath('/api/sim2real/runs', {
          modelId: argString(input, 'modelId'),
          projectId: argString(input, 'projectId'),
          status: argString(input, 'status'),
          backend: argString(input, 'backend'),
          q: argText(input, 'query', 200),
          limit: argNumber(input, 'limit') ?? 50,
        }),
        { method: 'GET' },
      );
      if (!result.ok) fail(result.status, result.body, '运行列表读取失败');
      return {
        total: defined(result.body.total),
        available: defined(result.body.available),
        runs: compactRecords(result.body.runs, [
          'id',
          'status',
          'modelId',
          'projectId',
          'backend',
          'taskId',
          'summary',
          'createdAt',
        ]),
      };
    },

    async rdk_artifacts_list(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      const result = await run(exec.signal).fetch(
        queryPath('/api/sim2real/artifacts', {
          type: argString(input, 'type'),
          modelId: argString(input, 'modelId'),
          runId: argString(input, 'runId'),
          projectId: argString(input, 'projectId'),
          status: argString(input, 'status'),
          q: argText(input, 'query', 200),
          limit: argNumber(input, 'limit') ?? 50,
        }),
        { method: 'GET' },
      );
      if (!result.ok) fail(result.status, result.body, '制品列表读取失败');
      return {
        total: defined(result.body.total),
        available: defined(result.body.available),
        artifacts: compactRecords(result.body.artifacts, [
          'id',
          'name',
          'type',
          'status',
          'format',
          'modelId',
          'runId',
          'uri',
          'sampleCount',
        ]),
      };
    },

    async rdk_evaluations_list(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      const result = await run(exec.signal).fetch(
        queryPath('/api/sim2real/evaluations', {
          runId: argString(input, 'runId'),
          artifactId: argString(input, 'artifactId'),
          status: argString(input, 'status'),
          limit: argNumber(input, 'limit') ?? 50,
        }),
        { method: 'GET' },
      );
      if (!result.ok) fail(result.status, result.body, '评测列表读取失败');
      return {
        total: defined(result.body.total),
        available: defined(result.body.available),
        evaluations: compactRecords(result.body.evaluations, [
          'id',
          'runId',
          'status',
          'summary',
          'source',
          'createdAt',
          'updatedAt',
        ]),
      };
    },

    async rdk_lineage_get(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      const selectors = ['runId', 'artifactId', 'evaluationId', 'projectId']
        .map((key) => [key, argString(input, key)] as const)
        .filter(([, value]) => value);
      if (selectors.length !== 1) {
        throw new CapabilityError(
          'DSH_CAPABILITY_REJECTED',
          '请且只请提供 runId、artifactId、evaluationId 或 projectId 其中一个。',
        );
      }
      const [key, value] = selectors[0];
      const result = await run(exec.signal).fetch(
        queryPath('/api/sim2real/lineage', { [key]: value }),
        { method: 'GET' },
      );
      if (!result.ok) fail(result.status, result.body, '血缘关系读取失败');
      return { lineage: defined(result.body.lineage) };
    },

    async rdk_compute_resources_list(_args: unknown, exec: ToolRunContext) {
      const result = await run(exec.signal).fetch('/api/sim2real/compute-resources', {
        method: 'GET',
      });
      if (!result.ok) fail(result.status, result.body, '训练资源列表读取失败');
      return {
        computeResources: compactRecords(result.body.computeResources, [
          'id',
          'name',
          'source',
          'runnerUrl',
          'health',
          'tokenConfigured',
          'updatedAt',
        ]),
      };
    },

    async rdk_compute_resource_test(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      const id = requiredArg(input, 'computeResourceId', '请提供 computeResourceId。');
      const result = await run(exec.signal).fetch(
        `/api/sim2real/compute-resources/${encodeURIComponent(id)}/test`,
        { method: 'POST', json: {} },
      );
      if (!result.ok) fail(result.status, result.body, '训练资源健康检查失败');
      const resource = objectValue(result.body.computeResource ?? result.body.resource);
      return {
        id,
        ok: result.body.ok !== false,
        health: defined(resource.health ?? result.body.health),
        message: str(result.body.message),
      };
    },

    async rdk_device_discover(_args: unknown, exec: ToolRunContext) {
      const result = await run(exec.signal).fetch('/api/sim2real/device-connections', {
        method: 'GET',
      });
      if (!result.ok) fail(result.status, result.body, '设备列表读取失败');
      const connections = Array.isArray(result.body.connections) ? result.body.connections : [];
      return {
        connections: connections.map((item) => {
          const record = (item ?? {}) as Record<string, unknown>;
          return {
            id: str(record.id),
            label: str(record.label),
            host: str(record.host),
            tunnelActive: defined(record.tunnelActive),
          };
        }),
      };
    },

    async rdk_device_connect(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      const connectionId = requiredArg(input, 'connectionId', '请提供 connectionId。');
      const result = await run(exec.signal).fetch(
        `/api/sim2real/device-connections/${encodeURIComponent(connectionId)}/connect`,
        { method: 'POST', json: {} },
      );
      if (!result.ok) fail(result.status, result.body, '设备连接失败');
      const connection = (result.body.connection ?? {}) as Record<string, unknown>;
      const probe = (result.body.probe ?? {}) as Record<string, unknown>;
      return {
        connectionId,
        tunnelActive: defined(connection.tunnelActive),
        probe: {
          ok: defined(probe.ok),
          platform: str(probe.platform),
          model: str(probe.model),
        },
      };
    },

    async rdk_device_disconnect(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      const connectionId = requiredArg(input, 'connectionId', '请提供 connectionId。');
      const result = await run(exec.signal).fetch(
        `/api/sim2real/device-connections/${encodeURIComponent(connectionId)}/disconnect`,
        { method: 'POST', json: {} },
      );
      if (!result.ok) fail(result.status, result.body, '设备断开失败');
      const connection = objectValue(result.body.connection);
      return {
        connectionId,
        tunnelActive: defined(connection.tunnelActive ?? result.body.tunnelActive),
        disconnected: true,
      };
    },

    async rdk_board_health(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      const result = await run(exec.signal).fetch(
        stationPath('/api/sim2real/board-station/health', input),
        {
          method: 'GET',
        },
      );
      if (!result.ok) fail(result.status, result.body, '板端健康检查失败');
      const agent = (result.body.agent ?? {}) as Record<string, unknown>;
      const device = (result.body.device ?? {}) as Record<string, unknown>;
      return {
        online: result.body.ok !== false,
        device: { id: str(device.id), profile: str(device.profile) },
        agent: {
          state: str(agent.state ?? result.body.status),
          capabilities: defined(agent.capabilities),
          actuatorControl: defined(agent.actuatorControl),
        },
      };
    },

    async rdk_board_onboarding_preflight(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      const result = await run(exec.signal).fetch(
        stationPath('/api/sim2real/board-station/onboarding/preflight', input),
        { method: 'GET' },
      );
      if (!result.ok) fail(result.status, result.body, '板卡 onboarding 预检失败');
      return { deviceId: str(result.body.deviceId), passport: defined(result.body.passport) };
    },

    async rdk_board_station_status(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      const result = await run(exec.signal).fetch(
        stationPath('/api/sim2real/board-station/status', input),
        { method: 'GET' },
      );
      if (!result.ok) fail(result.status, result.body, '板端状态读取失败');
      return { status: defined(result.body.status), online: result.body.ok !== false };
    },

    async rdk_board_station_command(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      const id = requiredArg(input, 'id', '请提供白名单命令 id。');
      const result = await run(exec.signal).fetch(
        stationPath('/api/sim2real/board-station/commands', input),
        {
          method: 'POST',
          json: { id },
        },
      );
      if (!result.ok) fail(result.status, result.body, '板端只读命令执行失败');
      return {
        id,
        ok: result.body.ok !== false,
        result: defined(result.body.result ?? result.body.data ?? result.body),
      };
    },

    async rdk_board_policy_status(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      const result = await run(exec.signal).fetch(
        stationPath('/api/sim2real/board-station/policy', input),
        { method: 'GET' },
      );
      if (!result.ok) fail(result.status, result.body, '板端策略状态读取失败');
      return {
        platformEnabled: result.body.platformEnabled === true,
        drivePlatformEnabled: result.body.drivePlatformEnabled === true,
        policy: defined(result.body.policy),
        rehearsal: defined(result.body.rehearsal),
      };
    },

    async rdk_board_policy_files(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      const result = await run(exec.signal).fetch(
        stationPath('/api/sim2real/board-station/policy/files', input),
        { method: 'GET' },
      );
      if (!result.ok) fail(result.status, result.body, '板端策略制品列表读取失败');
      return { files: boundedArray(result.body.files, 100), ok: result.body.ok !== false };
    },

    async rdk_training_submit(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      rejectUnsupportedTrainingInputs(input);
      const requestedBackend = argString(input, 'backend');
      if (input.backend !== undefined && !['local', 'robogo', 'browser', 'contract'].includes(requestedBackend)) {
        throw new CapabilityError('DSH_CAPABILITY_REJECTED', 'backend 必须是 local、robogo、browser 或 contract；不会回退到另一后端。');
      }
      const overview = await run(exec.signal).fetch('/api/sim2real/overview', { method: 'GET' });
      if (!overview.ok) fail(overview.status, overview.body, '工作区读取失败');
      const requestedModelId = argString(input, 'modelId');
      const requestedProfile = argString(input, 'profile');
      const modelId = requestedModelId || firstModelId(overview.body);
      const backend = requestedBackend || 'local';
      const training: Record<string, unknown> = {
        profile: requestedProfile || 'smoke',
        ...(input.originmanWorkshop === undefined ? {} : { originmanWorkshop: input.originmanWorkshop }),
        ...(argString(input, 'engine') ? { engine: argString(input, 'engine') } : {}),
        ...(argString(input, 'algorithm') ? { algorithm: argString(input, 'algorithm') } : {}),
        ...(argNumber(input, 'numEnvs') === undefined
          ? {}
          : { numEnvs: argNumber(input, 'numEnvs') }),
        ...(argNumber(input, 'maxIterations') === undefined
          ? {}
          : { maxIterations: argNumber(input, 'maxIterations') }),
        ...(typeof input.video === 'boolean' ? { video: input.video } : {}),
        ...(argText(input, 'runName', 80) ? { runName: argText(input, 'runName', 80) } : {}),
      };
      const idempotencyKey = dshIdempotencyKey('training');
      const result = await run(exec.signal).fetch('/api/sim2real/runs', {
        method: 'POST',
        idempotencyKey,
        json: {
          modelId,
          backend,
          ...(argString(input, 'taskId') ? { taskId: argString(input, 'taskId') } : {}),
          training,
          // Provenance marker: lets research-loop metrics attribute this run
          // to agent automation instead of a workbench submission.
          requestedVia: 'agent',
          ...(argString(input, 'projectId') ? { projectId: argString(input, 'projectId') } : {}),
          ...(argString(input, 'experimentId')
            ? { experimentId: argString(input, 'experimentId') }
            : {}),
          ...(argText(input, 'label', 120) ? { label: argText(input, 'label', 120) } : {}),
          ...(argStringList(input, 'datasetIds')
            ? { datasetIds: argStringList(input, 'datasetIds') }
            : {}),
          ...(argString(input, 'computeResourceId')
            ? { computeResourceId: argString(input, 'computeResourceId') }
            : {}),
          ...(argString(input, 'demonstrationRunId')
            ? { demonstrationRunId: argString(input, 'demonstrationRunId') }
            : {}),
        },
      });
      if (!result.ok) fail(result.status, result.body, 'GPU 训练提交失败');
      const trainingRun = (result.body.run ?? {}) as Record<string, unknown>;
      const resolved = { ...training, ...objectValue(trainingRun.training) };
      const metrics = objectValue(trainingRun.metrics);
      const evidence = trainingDataEvidence(trainingRun);
      const realDemonstrations = !!argString(input, 'demonstrationRunId');
      const syntheticData = {
        confirmed: typeof metrics.syntheticData === 'boolean' ? metrics.syntheticData : null,
        builtinSmokePath: !realDemonstrations && ['act', 'diffusion-policy', 'offline-bc'].includes(str(resolved.engine)),
        note: realDemonstrations
          ? '已选择受管轨迹；以完成状态和训练输入摘要核对实际消费，不会回退合成数据。'
          : '没有提供 demonstrationRunId 时，仓库 ACT/BC/DP 文件协议包装使用 synthetic-smoke；数据集 ID 只关联血缘。',
      };
      const defaultsApplied = [
        ...(!requestedModelId ? ['modelId'] : []),
        ...(!requestedBackend ? ['backend'] : []),
        ...(!requestedProfile ? ['profile'] : []),
      ];
      const status = str(trainingRun.status);
      const summary = str(trainingRun.summary);
      return {
        runId: str(trainingRun.id),
        status,
        modelId,
        backend,
        mock: typeof trainingRun.mock === 'boolean' ? trainingRun.mock : null,
        summary: summary || null,
        resolvedTraining: {
          modelId: str(trainingRun.modelId) || modelId,
          backend: str(trainingRun.backend) || backend,
          profile: defined(resolved.profile),
          engine: defined(resolved.engine),
          algorithm: defined(resolved.algorithm),
          numEnvs: defined(resolved.numEnvs),
          maxIterations: defined(resolved.maxIterations),
          video: defined(resolved.video),
          runName: defined(resolved.runName),
          originmanWorkshop: defined(resolved.originmanWorkshop),
        },
        defaultsApplied,
        dataUsage: {
          datasetIds: argStringList(input, 'datasetIds') ?? [],
          ...evidence,
          note: evidence.consumptionVerified
            ? '已完成训练且输入摘要一致；行划分验证误差不能替代独立仿真评测或部署质量门。'
            : 'datasetIds 关联数据血缘；受管轨迹快照发送后，需等待训练完成并核对输入摘要。',
        },
        syntheticData,
        note: ['blocked', 'failed'].includes(status)
          ? `请求已登记，但训练${status === 'blocked' ? '被阻断' : '失败'}${summary ? `：${summary}` : ''}；先检查执行资源和运行详情，不要重复提交。`
          : '任务已提交；用 rdk_training_status 和 rdk_run_logs 查询进度，提交成功不等于训练或发布完成。',
      };
    },

    async rdk_training_status(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      const runId = requiredArg(input, 'runId', '请提供 runId。');
      const result = await run(exec.signal).fetch(
        `/api/sim2real/runs/${encodeURIComponent(runId)}`,
        { method: 'GET' },
      );
      if (!result.ok) fail(result.status, result.body, '训练状态查询失败');
      const trainingRun = (result.body.run ?? {}) as Record<string, unknown>;
      const metrics = (trainingRun.metrics ?? {}) as Record<string, unknown>;
      const workshop = normalizeOriginmanWorkshopResult(metrics.originmanWorkshop);
      return {
        runId: str(trainingRun.id),
        status: str(trainingRun.status),
        modelId: str(trainingRun.modelId),
        backend: str(trainingRun.backend),
        metrics: {
          reward: defined(metrics.reward),
          successRate: defined(metrics.successRate),
          fallRate: defined(metrics.fallRate),
          iterations: defined(metrics.iterations),
          trainingRows: defined(metrics.trainingRows),
          validationRows: defined(metrics.validationRows),
          initialTrainLoss: defined(metrics.initialTrainLoss),
          trainLoss: defined(metrics.trainLoss),
          validationLoss: defined(metrics.validationLoss),
          epochs: defined(metrics.epochs),
          syntheticData: defined(metrics.syntheticData),
          originmanWorkshop: workshop ? {
            phase: workshop.phase,
            trainingDevice: workshop.trainingDevice,
            gradientUpdates: workshop.gradientUpdates,
            requestedTimesteps: workshop.requestedTimesteps,
            actualTimesteps: workshop.actualTimesteps,
            seed: workshop.seed,
            pushMaxForce: workshop.pushMaxForce,
            policySha256: workshop.policySha256,
            sourceRunId: workshop.sourceRunId,
            baselineRecovered: workshop.baselineRecovered,
            rlRecovered: workshop.rlRecovered,
            clearGain: workshop.clearGain,
            normalStanding: workshop.normalStanding,
            cases: workshop.cases,
            video: workshop.video,
            videoError: workshop.videoError,
            hardwareEligible: false,
            note: '仅本次仿真、公开课堂条件和原基础反馈对照；不代表未见测试、优化传统控制或真机。',
          } : null,
        },
        dataUsage: trainingDataEvidence(trainingRun),
      };
    },

    async rdk_runs_replay(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      const runId = requiredArg(input, 'runId', '请提供 runId。');
      const result = await run(exec.signal).fetch(
        `/api/sim2real/runs/${encodeURIComponent(runId)}/replay`,
        { method: 'GET' },
      );
      if (!result.ok) fail(result.status, result.body, '运行回放读取失败');
      const replay = objectValue(result.body.replay);
      const evaluation = objectValue(result.body.evaluation);
      const returnedFrameCount = Array.isArray(result.body.frames) ? result.body.frames.length : 0;
      const projection = objectValue(result.body.projection);
      const declaredFrameCount = result.body.frameCount;
      const frameCount = typeof declaredFrameCount === 'number' && Number.isSafeInteger(declaredFrameCount) && declaredFrameCount >= 0
        ? declaredFrameCount : projection.truncated === true ? null : returnedFrameCount;
      return {
        runId,
        replay,
        evaluation: {
          status: defined(evaluation.status),
          warnings: boundedArray(evaluation.warnings, 10),
        },
        frameCount,
        returnedFrameCount,
        projection: Object.keys(projection).length ? projection : null,
      };
    },

    async rdk_telemetry_list(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      const runId = requiredArg(input, 'runId', '请提供 runId。');
      const limit = Math.min(Math.max(Math.trunc(argNumber(input, 'limit') ?? 50), 1), 200);
      const result = await run(exec.signal).fetch(
        queryPath(`/api/sim2real/runs/${encodeURIComponent(runId)}/telemetry`, { limit, includeSamples: 'false' }),
        { method: 'GET' },
      );
      if (!result.ok) fail(result.status, result.body, '遥测读取失败');
      const telemetry = boundedArray(result.body.telemetry, 200).map((item) => {
        const chunk = objectValue(item);
        return {
          id: str(chunk.id),
          source: str(chunk.source),
          sequence: defined(chunk.sequence),
          receivedAt: str(chunk.receivedAt),
          sampleCount: typeof chunk.sampleCount === 'number' && Number.isSafeInteger(chunk.sampleCount) && chunk.sampleCount >= 0
            ? chunk.sampleCount : Array.isArray(chunk.samples) ? chunk.samples.length : null,
          droppedCount: defined(chunk.droppedCount),
          attested: chunk.attested === true,
        };
      });
      return { runId, count: defined(result.body.count), telemetry };
    },

    async rdk_board_sessions(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      const runId = requiredArg(input, 'runId', '请提供 runId。');
      const result = await run(exec.signal).fetch(
        `/api/sim2real/runs/${encodeURIComponent(runId)}/board-sessions`,
        { method: 'GET' },
      );
      if (!result.ok) fail(result.status, result.body, '板端策略会话读取失败');
      return {
        runId,
        count: defined(result.body.count),
        sessions: boundedArray(result.body.sessions, 100),
      };
    },

    async rdk_run_logs(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      const runId = requiredArg(input, 'runId', '请提供 runId。');
      const after = Math.max(0, Math.trunc(argNumber(input, 'after') ?? 0));
      const result = await run(exec.signal).fetch(
        queryPath(`/api/sim2real/runs/${encodeURIComponent(runId)}/logs`, { after }),
        { method: 'GET' },
      );
      if (!result.ok) fail(result.status, result.body, '训练日志读取失败');
      return {
        runId,
        status: str(result.body.status),
        total: defined(result.body.total),
        retainedFrom: defined(result.body.retainedFrom),
        truncated: result.body.truncated === true,
        lines: boundedArray(result.body.lines, 200),
      };
    },

    async rdk_retraining_advice(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      const runId = requiredArg(input, 'runId', '请提供 runId。');
      const result = await run(exec.signal).fetch(
        `/api/sim2real/runs/${encodeURIComponent(runId)}/retraining-advice`,
        { method: 'GET' },
      );
      if (!result.ok) fail(result.status, result.body, '重训建议读取失败');
      return { runId, advice: defined(result.body.advice) };
    },

    async rdk_replay_video(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      const runId = requiredArg(input, 'runId', '请提供 runId。');
      const result = await run(exec.signal).fetch(
        `/api/sim2real/runs/${encodeURIComponent(runId)}/replay-video`,
        { method: 'POST', json: {} },
      );
      if (!result.ok) fail(result.status, result.body, '回放视频生成失败');
      return { runId, video: defined(result.body.video) };
    },

    async rdk_workshop_catalog(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      if (requiredArg(input, 'robot', 'robot is required') !== 'originman')
        throw new CapabilityError('DSH_CAPABILITY_REJECTED', '当前课程目录需显式选择 robot=originman。');
      const result = await run(exec.signal).fetch('/api/sim2real/workshops/originman', { method: 'GET' });
      if (!result.ok) fail(result.status, result.body, 'OriginMan 课程目录读取失败');
      return { ...result.body, robot: 'originman', entryUrl: './?robot=originman#train/submit' };
    },

    async rdk_simulator_open(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      const robot = argString(input, 'robot');
      const runId = argString(input, 'runId');
      if (input.robot !== undefined && !['originman', 'microduck'].includes(robot))
        throw new CapabilityError('DSH_CAPABILITY_REJECTED', '不支持的机器人；不会回退到 MicroDuck。');
      if (robot === 'originman') {
        if (runId || input.runId !== undefined)
          throw new CapabilityError('DSH_CAPABILITY_REJECTED', 'OriginMan 请在工作台按 Run 选择评测；打开入口不代表已加载策略。');
        const result = await run(exec.signal).fetch('/api/sim2real/workshops/originman', { method: 'GET' });
        if (!result.ok) fail(result.status, result.body, 'OriginMan 课程入口不可用');
        return { entryUrl: './?robot=originman#train/submit', robot: 'originman', simulationOnly: true,
          note: 'OriginMan 受扰恢复工作台；需要实际运行训练与评测后才有本组物理回放。' };
      }
      const overview = await run(exec.signal).fetch('/api/sim2real/overview', { method: 'GET' });
      if (!overview.ok) fail(overview.status, overview.body, '工作区读取失败');
      const digest = overviewDigest(overview.body);
      const integrations = (digest.integrations ?? {}) as Record<string, unknown>;
      const entryUrl =
        (typeof integrations.simulator === 'string' && integrations.simulator) ||
        (process.env.RDK_SIM2REAL_MICRODUCK_URL
          ? '/mujoco/microduck-proxy/'
          : '/mujoco/microduck/');
      return {
        entryUrl: String(entryUrl),
        robot: 'microduck',
        note: '在浏览器打开该路径即可查看参考仿真。',
      };
    },

    async rdk_evaluation_summarize(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      let runId = argString(input, 'runId');
      if (!runId) {
        const overview = await run(exec.signal).fetch('/api/sim2real/overview', { method: 'GET' });
        if (!overview.ok) fail(overview.status, overview.body, '工作区读取失败');
        const runs = Array.isArray(overview.body.runs) ? overview.body.runs : [];
        const latest =
          runs.find(
            (item) => String((item as Record<string, unknown>).status ?? '') === 'completed',
          ) ?? runs[0];
        runId = String((latest as Record<string, unknown> | undefined)?.id ?? '');
      }
      if (!runId)
        throw new CapabilityError('DSH_CAPABILITY_REJECTED', '当前没有可汇总的训练运行。');
      const result = await run(exec.signal).fetch(
        `/api/sim2real/runs/${encodeURIComponent(runId)}/evaluate`,
        { method: 'POST', json: {} },
      );
      if (!result.ok) fail(result.status, result.body, '评测执行失败');
      const trainingRun = (result.body.run ?? {}) as Record<string, unknown>;
      const metrics = (trainingRun.metrics ?? {}) as Record<string, unknown>;
      const evaluation = (result.body.evaluation ?? {}) as Record<string, unknown>;
      const replay = (evaluation.replay ?? {}) as Record<string, unknown>;
      return {
        runId,
        status: trainingRun.status,
        metrics: {
          reward: defined(metrics.reward),
          successRate: defined(metrics.successRate),
          fallRate: defined(metrics.fallRate),
          iterations: defined(metrics.iterations),
        },
        replay: {
          sampleCount: defined(replay.sampleCount),
          fallCount: defined(replay.fallCount),
          doneCount: defined(replay.doneCount),
        },
        warnings: Array.isArray(evaluation.warnings) ? evaluation.warnings.slice(0, 3) : [],
      };
    },

    async rdk_feedback_summary(_args: unknown, exec: ToolRunContext) {
      const result = await run(exec.signal).fetch('/api/sim2real/feedback/summary', {
        method: 'GET',
      });
      if (!result.ok) fail(result.status, result.body, '反馈汇总读取失败');
      return { summary: defined(result.body.summary) };
    },

    async rdk_artifact_promote(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      const artifactId = requiredArg(input, 'artifactId', '请提供 artifactId。');
      const status = requiredArg(input, 'status', '请提供 status（validated、published 或 revoked）。');
      if (!['validated', 'published', 'revoked'].includes(status)) {
        throw new CapabilityError(
          'DSH_CAPABILITY_REJECTED',
          'status 必须是 validated、published 或 revoked。',
        );
      }
      const path = `/api/sim2real/artifacts/${encodeURIComponent(artifactId)}${
        status === 'revoked' ? '/revoke' : ''
      }`;
      const result = await run(exec.signal).fetch(path, {
        method: status === 'revoked' ? 'POST' : 'PATCH',
        json: status === 'revoked' ? { reason: argText(input, 'reason', 500) } : { status },
        idempotencyKey: dshIdempotencyKey('artifact'),
      });
      if (!result.ok) fail(result.status, result.body, '制品生命周期操作失败');
      const artifact = objectValue(result.body.artifact);
      return {
        artifactId,
        status: str(artifact.status) || status,
        artifact: Object.fromEntries(
          [
            'id',
            'artifactId',
            'version',
            'name',
            'status',
            'format',
            'sha256',
            'modelId',
            'runId',
          ].map((field) => [field, defined(artifact[field])]),
        ),
      };
    },

    async rdk_deployment_preflight(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      const overview = await run(exec.signal).fetch('/api/sim2real/overview', { method: 'GET' });
      if (!overview.ok) fail(overview.status, overview.body, '工作区读取失败');
      const modelId = argString(input, 'modelId') || firstModelId(overview.body);
      const deviceId = argString(input, 'deviceId') || firstDeviceId(overview.body);
      if (!deviceId) throw new CapabilityError('DSH_CAPABILITY_REJECTED', '当前没有可用目标板卡。');
      const idempotencyKey = dshIdempotencyKey('deploy');
      const created = await run(exec.signal).fetch('/api/sim2real/deployments', {
        method: 'POST',
        idempotencyKey,
        json: {
          modelId,
          deviceId,
          mode: 'preflight',
          ...(argString(input, 'runId') ? { runId: argString(input, 'runId') } : {}),
          ...(argString(input, 'artifactId') ? { artifactId: argString(input, 'artifactId') } : {}),
          ...(argString(input, 'evaluationId')
            ? { evaluationId: argString(input, 'evaluationId') }
            : {}),
        },
      });
      if (!created.ok) fail(created.status, created.body, '部署计划创建失败');
      const deployment = (created.body.deployment ?? {}) as Record<string, unknown>;
      const deploymentId = typeof deployment.id === 'string' ? deployment.id : '';
      if (!deploymentId)
        throw new CapabilityError('DSH_CAPABILITY_FAILED', '部署计划创建未返回 ID。');
      const result = await run(exec.signal).fetch(
        `/api/sim2real/deployments/${encodeURIComponent(deploymentId)}/preflight`,
        { method: 'POST', json: {} },
      );
      const mockDrill =
        !result.ok &&
        (result.body.error === 'SIM2REAL_PREFLIGHT_MOCK_ONLY' ||
          ((result.body.preflight ?? null) as Record<string, unknown> | null)?.mock === true);
      if (!result.ok && !mockDrill) fail(result.status, result.body, '只读预检失败');
      const preflight = (result.body.preflight ?? {}) as Record<string, unknown>;
      return {
        deploymentId,
        modelId,
        deviceId,
        passed: preflight.passed === true,
        mock: mockDrill || preflight.mock === true,
        checks: defined(preflight.checks),
        note: mockDrill ? '协议演练通过；模拟 BoardAgent 不构成真机证据。' : '',
      };
    },

    async rdk_deployment_status(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      const id = requiredArg(input, 'deploymentId', '请提供 deploymentId。');
      const result = await run(exec.signal).fetch(
        `/api/sim2real/deployments/${encodeURIComponent(id)}`,
        { method: 'GET' },
      );
      if (!result.ok) fail(result.status, result.body, '部署状态读取失败');
      return { deployment: defined(result.body.deployment) };
    },

    async rdk_deployment_history(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      const id = requiredArg(input, 'deploymentId', '请提供 deploymentId。');
      const result = await run(exec.signal).fetch(
        `/api/sim2real/deployments/${encodeURIComponent(id)}/history`,
        { method: 'GET' },
      );
      if (!result.ok) fail(result.status, result.body, '部署历史读取失败');
      return {
        deploymentId: str(result.body.deploymentId) || id,
        history: boundedArray(result.body.history, 100),
        verification: defined(result.body.verification),
      };
    },

    async rdk_deployment_version_switch(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      const id = requiredArg(input, 'deploymentId', '请提供 deploymentId。');
      const targetModelId = requiredArg(input, 'targetModelId', '请提供 targetModelId。');
      const result = await run(exec.signal).fetch(
        `/api/sim2real/deployments/${encodeURIComponent(id)}/version-switch`,
        {
          method: 'POST',
          idempotencyKey: dshIdempotencyKey('version'),
          json: { targetModelId },
        },
      );
      if (!result.ok) fail(result.status, result.body, '部署版本切换计划创建失败');
      const deployment = objectValue(result.body.deployment);
      return {
        deploymentId: str(deployment.id),
        modelId: str(deployment.modelId),
        deviceId: str(deployment.deviceId),
        status: str(deployment.status),
        mode: str(deployment.mode),
      };
    },

    async rdk_deployment_cancel(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      const id = requiredArg(input, 'deploymentId', '请提供 deploymentId。');
      const result = await run(exec.signal).fetch(
        `/api/sim2real/deployments/${encodeURIComponent(id)}/cancel`,
        { method: 'POST', json: {} },
      );
      if (!result.ok) fail(result.status, result.body, '部署计划取消失败');
      const deployment = objectValue(result.body.deployment);
      return { deploymentId: id, status: str(deployment.status) || 'cancelled' };
    },

    async rdk_board_policy_stage(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      const runId = requiredArg(input, 'runId', '请提供要下发的训练 runId。');
      const payload = {
        runId,
        ...(argText(input, 'filename', 160) ? { filename: argText(input, 'filename', 160) } : {}),
      };
      const result = await run(exec.signal).fetch(
        stationPath('/api/sim2real/board-station/policy/stage', input),
        {
          method: 'POST',
          json: payload,
        },
      );
      if (!result.ok) fail(result.status, result.body, '板端策略制品暂存失败');
      return {
        runId,
        ok: result.body.ok !== false,
        file: defined(result.body.file ?? result.body.filename),
        sha256: str(result.body.sha256),
      };
    },

    async rdk_board_policy_load(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      const path = requiredArg(input, 'path', '请提供板端 policies 目录内的 ONNX 文件名。');
      const result = await run(exec.signal).fetch(
        stationPath('/api/sim2real/board-station/policy/load', input),
        {
          method: 'POST',
          json: {
            path,
            ...(argText(input, 'artifactSha256', 64)
              ? { artifactSha256: argText(input, 'artifactSha256', 64) }
              : {}),
            ...(input.rehearsalReceipt !== undefined
              ? { rehearsalReceipt: input.rehearsalReceipt }
              : {}),
          },
        },
      );
      if (!result.ok) fail(result.status, result.body, '板端策略加载失败');
      return { path, ok: result.body.ok !== false, policy: defined(result.body.policy) };
    },

    async rdk_board_policy_start(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      const command = input.command === undefined ? undefined : policyCommandArg(input.command);
      const direction = argNumber(input, 'direction');
      if (!command && direction === undefined) {
        throw new CapabilityError('DSH_CAPABILITY_REJECTED', '请提供 direction 数值或显式 command。');
      }
      if (input.direction !== undefined && (typeof input.direction !== 'number' || !Number.isFinite(input.direction) || input.direction < -1 || input.direction > 1)) {
        throw new CapabilityError('DSH_CAPABILITY_REJECTED', 'direction 必须是 -1..1 的有限数值。');
      }
      const result = await run(exec.signal).fetch(
        stationPath('/api/sim2real/board-station/policy/start', input),
        {
          method: 'POST',
          json: {
            ...(direction === undefined ? {} : { direction }),
            ...(command ? { command } : {}),
            ...(argNumber(input, 'goalX') === undefined
              ? {}
              : { goalX: argNumber(input, 'goalX') }),
            ...(argNumber(input, 'goalY') === undefined
              ? {}
              : { goalY: argNumber(input, 'goalY') }),
          },
        },
      );
      if (!result.ok) fail(result.status, result.body, '板端策略启动失败');
      return { ok: result.body.ok !== false, policy: defined(result.body.policy) };
    },

    async rdk_board_policy_command(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      const command = policyCommandArg(input.command);
      const result = await run(exec.signal).fetch(
        stationPath('/api/sim2real/board-station/policy/command', input),
        { method: 'POST', json: { command } },
      );
      if (!result.ok) fail(result.status, result.body, '板端策略命令更新失败');
      return { ok: result.body.ok !== false, policy: defined(result.body.policy) };
    },

    async rdk_board_policy_reset(_args: unknown, exec: ToolRunContext) {
      const input = argsRecord(_args);
      const result = await run(exec.signal).fetch(
        stationPath('/api/sim2real/board-station/policy/reset', input),
        { method: 'POST', json: {} },
      );
      if (!result.ok) fail(result.status, result.body, '板端策略复位失败');
      return { ok: result.body.ok !== false, policy: defined(result.body.policy) };
    },

    async rdk_board_arm_status(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      const result = await run(exec.signal).fetch(
        stationPath('/api/sim2real/board-station/arm', input),
        { method: 'GET' },
      );
      if (!result.ok) fail(result.status, result.body, '机械臂状态读取失败');
      return {
        ok: result.body.ok !== false,
        platformEnabled: defined(result.body.platformEnabled),
        arm: defined(result.body.arm),
        capabilities: defined(result.body.capabilities),
      };
    },

    async rdk_board_arm_move(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      const x = requiredNumberArg(input, 'x', '请提供数值型 x（mm）。');
      const y = requiredNumberArg(input, 'y', '请提供数值型 y（mm）。');
      const z = requiredNumberArg(input, 'z', '请提供数值型 z（mm）。');
      const result = await run(exec.signal).fetch(
        stationPath('/api/sim2real/board-station/arm/move', input),
        {
          method: 'POST',
          json: {
            x,
            y,
            z,
            ...(argNumber(input, 'speedMmPerS') === undefined
              ? {}
              : { speedMmPerS: argNumber(input, 'speedMmPerS') }),
          },
        },
      );
      if (!result.ok) fail(result.status, result.body, '机械臂移动被拒绝');
      return { ok: result.body.ok !== false, arm: defined(result.body.arm) };
    },

    async rdk_board_arm_gripper(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      const action = requiredArg(input, 'action', "action 需为 'close' 或 'open'。");
      const value = requiredNumberArg(input, 'value', '请提供正数 value（close=力，open=宽度 mm）。');
      if (action !== 'close' && action !== 'open') {
        throw new CapabilityError('DSH_CAPABILITY_REJECTED', "action 需为 'close' 或 'open'。");
      }
      if (value <= 0) {
        throw new CapabilityError('DSH_CAPABILITY_REJECTED', '请提供正数 value（close=力，open=宽度 mm）。');
      }
      const result = await run(exec.signal).fetch(
        stationPath('/api/sim2real/board-station/arm/gripper', input),
        { method: 'POST', json: { action, value } },
      );
      if (!result.ok) fail(result.status, result.body, '夹爪命令被拒绝');
      return { ok: result.body.ok !== false, detail: defined(result.body.detail) };
    },

    async rdk_board_arm_stop(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      const result = await run(exec.signal).fetch(
        stationPath('/api/sim2real/board-station/arm/stop', input),
        { method: 'POST', json: {} },
      );
      if (!result.ok) fail(result.status, result.body, '机械臂停止命令未送达');
      return {
        ok: result.body.ok !== false,
        wasMoving: defined(result.body.wasMoving),
        homed: defined(result.body.homed),
      };
    },

    async rdk_board_stop(args: unknown, exec: ToolRunContext) {
      const input = argsRecord(args);
      const context = run(exec.signal);
      let policyStop: LoopbackResult | null = null;
      let driveStop: LoopbackResult | null = null;
      let armStop: LoopbackResult | null = null;
      try {
        policyStop = await context.fetch(
          stationPath('/api/sim2real/board-station/policy/stop', input),
          {
            method: 'POST',
            json: {},
          },
        );
      } catch {
        // Always attempt the independent emergency drive stop below.
      }
      try {
        driveStop = await context.fetch(
          stationPath('/api/sim2real/board-station/drive/stop', input),
          {
            method: 'POST',
            json: {},
          },
        );
      } catch {
        // The failure below records that the safety state is unknown.
      }
      try {
        armStop = await context.fetch(
          stationPath('/api/sim2real/board-station/arm/stop', input),
          { method: 'POST', json: {} },
        );
      } catch {
        // Recorded in the aggregated failure below.
      }
      if (
        !policyStop ||
        !driveStop ||
        !policyStop.ok ||
        !driveStop.ok ||
        policyStop.body.ok === false ||
        driveStop.body.ok === false
      ) {
        throw new CapabilityError('DSH_CAPABILITY_FAILED', '停止命令未能同时确认策略与驱动状态。');
      }
      return {
        policyStopped: true,
        driveStopped: true,
        armStopped: Boolean(armStop?.ok) && armStop?.body.ok !== false,
      };
    },

    async rdk_docs_search(args: unknown, _exec: ToolRunContext) {
      const input = argsRecord(args);
      const query = requiredArg(input, 'query', '请提供检索关键词。');
      const docs = options.docsService ?? defaultDocsService;
      const manual = argString(input, 'manual');
      const result = await callDocs(() =>
        docs.searchDocs({ query, ...(manual ? { manual } : {}), limit: 8 }, fetchText),
      );
      return {
        query,
        hits: result.hits.map((hit) => ({
          title: hit.title,
          url: hit.url,
          manual: hit.manual,
          snippet: hit.snippet,
          source: hit.source,
          role: hit.role ?? null,
        })),
        warnings: result.warnings,
        guidance: result.guidance,
        hint: 'role=official-start 是官方起始页；引用时附来源链接。',
      };
    },

    async rdk_docs_manuals(_args: unknown, _exec: ToolRunContext) {
      const docs = options.docsService ?? defaultDocsService;
      return {
        manuals: docs.listManuals().map((manual) => ({
          id: manual.id,
          title: manual.title,
          category: manual.category,
          description: manual.description,
          aliases: manual.aliases,
          searchable: manual.searchable,
        })),
      };
    },

    async rdk_docs_toc(args: unknown, _exec: ToolRunContext) {
      const input = argsRecord(args);
      const manual = requiredArg(input, 'manual', '请提供手册 id（来自 rdk_docs_manuals 或检索结果的 manual 字段）。');
      const docs = options.docsService ?? defaultDocsService;
      const query = argString(input, 'query');
      return callDocs(() => docs.listToc({ manual, ...(query ? { query } : {}) }, fetchText));
    },

    async rdk_docs_page(args: unknown, _exec: ToolRunContext) {
      const input = argsRecord(args);
      const url = assertDocsUrl(requiredArg(input, 'url', '请提供页面 URL（来自检索、目录或上一轮结果）。'));
      const docs = options.docsService ?? defaultDocsService;
      return callDocs(() => docs.getPage({ url, maxChars: 6_000 }, fetchText));
    },

    async rdk_web_search(args: unknown, _exec: ToolRunContext) {
      const input = argsRecord(args);
      const query = requiredArg(input, 'query', '请提供搜索关键词。');
      const cacheKey = webSearchCacheKey(query.slice(0, 200));
      const cached = webSearchCacheGet(cacheKey);
      if (cached) {
        return {
          query,
          results: cached,
          cached: true,
          hint:
            '这些是全网第三方信息（非官方结论），本次结果来自 10 分钟内的缓存；与 rdk_docs_* 的官方资料冲突时以官方为准，引用时附链接并注明为网络检索结果。',
        };
      }
      const webSearch = options.webSearch ?? bingWebSearch;
      const elapsed = Date.now() - webSearchLastAt;
      if (elapsed < WEB_SEARCH_MIN_INTERVAL_MS) {
        await new Promise((resolve) => setTimeout(resolve, WEB_SEARCH_MIN_INTERVAL_MS - elapsed));
      }
      webSearchLastAt = Date.now();
      try {
        const hits = await webSearch(query.slice(0, 200));
        webSearchCachePut(cacheKey, hits);
        return {
          query,
          results: hits,
          hint:
            '这些是全网第三方信息（非官方结论）；与 rdk_docs_* 的官方资料冲突时以官方为准，引用时附链接并注明为网络检索结果。',
        };
      } catch (error) {
        if (error instanceof CapabilityError) throw error;
        return fail(
          502,
          { reason: (error as Error)?.message },
          '全网搜索失败（免费检索通道不可用或超时）；请告知用户该信息未经网络核对。',
        );
      }
    },
  };
}
