#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Contract drift gate: every path declared in docs/api/openapi.yaml must be a
 * route the composition root actually mounts, and every API route mounted by
 * the routers the spec covers must be declared there. Two direction checks,
 * one shared source of truth.
 *
 * The route table is built by instantiating the real router factories the
 * same way the standalone server does (both the legacy /api/sim2real prefix
 * and the versioned /api/v1/duck prefix come from the same factory), then
 * reading Express's router.stack. This is deliberately runtime introspection
 * rather than regex over source: refactors that rename helpers but keep the
 * HTTP surface still pass, while any surface change that misses the spec
 * fails here and in CI.
 *
 * The spec declares the versioned prefix only; the legacy /api/sim2real
 * alias is an implementation detail of the same factory and is checked for
 * equality instead of being listed twice.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const openapiText = readFileSync(path.join(root, 'docs/api/openapi.yaml'), 'utf8');

/** Extract declared paths + methods from the OpenAPI YAML without a parser. */
function declaredOperations(text) {
  const operations = new Map();
  const lines = text.split('\n');
  // Path keys sit at exactly two spaces of indentation under `paths:`.
  let inPaths = false;
  let currentPath = null;
  for (const line of lines) {
    if (/^paths:\s*$/.test(line)) {
      inPaths = true;
      continue;
    }
    if (inPaths && /^components:\s*$/.test(line)) break;
    if (!inPaths) continue;
    const pathMatch = line.match(/^  (\/[^\s:]+):\s*$/);
    if (pathMatch) {
      currentPath = pathMatch[1];
      operations.set(currentPath, new Set());
      continue;
    }
    if (currentPath && /^    (get|post|put|patch|delete):\s*$/.test(line)) {
      const method = line.trim().replace(':', '');
      operations.get(currentPath).add(method);
    }
  }
  return operations;
}

/** Walk an Express router (recursing into mounted sub-routers) into method+path pairs. */
function collectRoutes(router, prefix = '') {
  const found = [];
  for (const layer of router.stack ?? []) {
    if (layer.route) {
      const routePath = prefix + layer.route.path;
      for (const [method, enabled] of Object.entries(layer.route.methods ?? {})) {
        if (enabled) found.push([method, routePath]);
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      // Nested mount: the regexp prefix is not trivially recoverable; all
      // routers used here register absolute paths, so recurse without it.
      found.push(...collectRoutes(layer.handle, prefix));
    }
  }
  return found;
}

function normalizeRoutePath(routePath) {
  return routePath
    .replace(/\/\(\?:\?\?\)/g, '')
    .replace(/\?.*$/, '')
    .replace(/\/+$/, '') || '/';
}

const { createSim2RealRouter, SIM2REAL_VERSIONED_API_PREFIX } = await import(
  path.join(root, 'dist-server/server/routes/sim2real-routes.js')
);
const { createStudioLoginRelayRouter } = await import(
  path.join(root, 'dist-server/server/sim2real/studio-login-relay.js')
);
const { createDeviceBoardDetectRouter } = await import(
  path.join(root, 'dist-server/server/sim2real/standalone-adapters.js')
);
const { createSim2RealAgentRouter } = await import(
  path.join(root, 'dist-server/server/routes/sim2real-agent-routes.js')
);

const legacyRouter = createSim2RealRouter({});
const versionedRouter = createSim2RealRouter({}, { prefix: SIM2REAL_VERSIONED_API_PREFIX });
const relayRouter = createStudioLoginRelayRouter();
const boardDetectRouter = createDeviceBoardDetectRouter(undefined, {});
const agentRouter = createSim2RealAgentRouter();

const legacyRoutes = collectRoutes(legacyRouter).map(([method, p]) => [method, normalizeRoutePath(p)]);
const versionedRoutes = collectRoutes(versionedRouter).map(([method, p]) => [method, normalizeRoutePath(p)]);

// The two prefixes must be route-for-route identical (the alias promise):
// compare route shapes with each router's own prefix stripped.
const LEGACY_PREFIX = '/api/sim2real';
function stripPrefix(routePath, prefix) {
  assert.ok(
    routePath === prefix || routePath.startsWith(`${prefix}/`),
    `route outside its router prefix: ${routePath} (expected ${prefix})`,
  );
  return routePath === prefix ? '/' : routePath.slice(prefix.length);
}
const legacyShapes = new Set(
  legacyRoutes.map(([m, p]) => `${m} ${stripPrefix(p, LEGACY_PREFIX)}`),
);
const versionedShapes = new Set(
  versionedRoutes.map(([m, p]) => `${m} ${stripPrefix(p, SIM2REAL_VERSIONED_API_PREFIX)}`),
);
assert.deepEqual(
  [...legacyShapes].sort(),
  [...versionedShapes].sort(),
  'legacy /api/sim2real and /api/v1/duck route sets must be identical (alias drift)',
);

// Runtime surface: versioned duck routes + SSO relay + board detect.
const runtimeRoutes = new Set([
  ...versionedRoutes.map(([m, p]) => `${m} ${p}`),
  ...collectRoutes(relayRouter).map(([m, p]) => `${m} ${normalizeRoutePath(p)}`),
  ...collectRoutes(boardDetectRouter).map(([m, p]) => `${m} ${normalizeRoutePath(p)}`),
  ...collectRoutes(agentRouter).map(([m, p]) => `${m} ${normalizeRoutePath(p)}`),
]);

const declared = declaredOperations(openapiText);
assert.ok(declared.size >= 25, `expected a substantive spec, found only ${declared.size} paths`);

const specOperations = new Set();
for (const [routePath, methods] of declared) {
  for (const method of methods) specOperations.add(`${method} ${routePath}`);
}

// Mount-path parameters use Express :id with the resource named by the
// preceding segment; the spec spells the same slot {modelId}/{runId}/...
// Normalize runtime shapes to the spec's names so the sets compare by
// structure: /models/:id -> {modelId}, /api/devices/:id -> {deviceId}.
const RESOURCE_PARAM_NAMES = {
  models: 'modelId',
  runs: 'runId',
  deployments: 'deploymentId',
  devices: 'deviceId',
};
function toSpecShape(routePath) {
  return routePath.replace(/\/([A-Za-z0-9_-]+)\/:([A-Za-z0-9_]+)/g, (match, resource, name) => {
    const specName = name === 'id' ? RESOURCE_PARAM_NAMES[resource] ?? 'id' : name;
    return `/${resource}/{${specName}}`;
  });
}
const runtimeShapes = new Set(
  [...runtimeRoutes].map((op) => {
    const [method, routePath] = op.split(' ');
    return `${method} ${toSpecShape(routePath)}`;
  }),
);

// The spec only declares the versioned prefix and /api/sso, /api/devices —
// the legacy alias set is verified by equality above and excluded here.
const missingInSpec = [...runtimeShapes].filter((op) => !specOperations.has(op)).sort();
const missingInRuntime = [...specOperations]
  .filter((op) => !runtimeShapes.has(op) && !op.includes(' /healthz') && !op.includes(' /readyz'))
  .sort();

assert.deepEqual(
  missingInSpec,
  [],
  'routes are mounted but missing from docs/api/openapi.yaml (spec drift)',
);
assert.deepEqual(
  missingInRuntime,
  [],
  'openapi.yaml declares routes that the routers do not mount (dead contract)',
);

console.log(
  `[api-contract] PASS — ${specOperations.size} spec operations match ${runtimeShapes.size} mounted routes (legacy alias verified equal)`,
);
