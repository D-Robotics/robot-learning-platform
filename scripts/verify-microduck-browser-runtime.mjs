#!/usr/bin/env node
/**
 * Verify a separately mounted, approved MicroDuck release before publication.
 * The bundle stays upstream-owned. We parse its actual public API and execute
 * its actual policy loader/revert functions in an isolated, network-free VM.
 * Real ONNX graphs run through the repository's locked ONNX WASM backend.
 * This gate complements the browser physics/record/replay acceptance check.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_PATH = path.join(REPO_ROOT, 'services/mujoco-web/microduck-browser-runtime.lock.json');
const ADDITIVE_ASSETS = new Set([
  'microduck-community-overlay.js',
  'community/microduck-wechat.png',
  'microduck-network-boundary.js',
]);
const NETWORK_POLICY =
  '<meta id="rdk-microduck-network-policy" http-equiv="Content-Security-Policy" content="connect-src \'self\'" />';

function networkMarkup(digest) {
  return `\n    ${NETWORK_POLICY}\n    <script src="./microduck-network-boundary.js?v=${digest}"></script>`;
}

export function verifyBoundaryMarkup(content, digest) {
  const head = /<head\b[^>]*>/i.exec(content);
  assert.ok(head, 'network boundary requires an HTML head');
  assert.ok(
    content.slice(head.index + head[0].length).startsWith(networkMarkup(digest)),
    'network boundary and same-origin policy must precede every upstream script',
  );
  assert.equal(
    content.split('microduck-network-boundary.js').length - 1,
    1,
    'network bootstrap must occur exactly once',
  );
  assert.equal(
    content.split('rdk-microduck-network-policy').length - 1,
    1,
    'network policy must occur exactly once',
  );
}
// Preserve upstream attribution supplied by the deployer, without allowing
// stale bundles, policy files, backups, or release sidecars into this mount.
const ATTRIBUTION_BASENAMES = new Set([
  'LICENSE',
  'LICENSE.txt',
  'LICENSE.md',
  'COPYING',
  'COPYING.txt',
  'NOTICE',
  'NOTICE.txt',
  'NOTICE.md',
  'THIRD_PARTY_NOTICES.md',
]);
const REQUIRED_API = [
  'model',
  'data',
  'mujoco',
  'buildObs',
  'lastAction',
  'resetSim',
  'controller',
  'kbSource',
  'padSource',
  'sessions',
  'ort',
  'step',
  'render',
  'inputLocked',
  'loco',
  'locoSwitching',
  'recovery',
  'debugPush',
  'spawnBall',
  'setLoco',
  'loadCustomPolicy',
  'clearCustomPolicy',
  'customPolicy',
];
const POLICIES = [
  'BEST_alpha_walking.onnx',
  'BEST_alpha_sitstand.onnx',
  'roulade.onnx',
  'ball_kick_left.onnx',
  'ball_kick_right.onnx',
  'alpha_ground_pick.onnx',
  'BEST_alpha_stand.onnx',
];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function upstreamIndex(content) {
  // The installer only inserts this additive tag. No upstream index edits
  // (entry point, base path, preload order, etc.) are permitted by this gate.
  return content
    .replace(
      / {2}<script src="\.\/microduck-community-overlay\.js\?v=[a-f0-9]{12}" defer><\/script>\n/,
      '',
    )
    .replace(
      /\n {4}<meta id="rdk-microduck-network-policy" http-equiv="Content-Security-Policy" content="connect-src 'self'" \/>\n {4}<script src="\.\/microduck-network-boundary\.js\?v=[a-f0-9]{12}"><\/script>/,
      '',
    );
}

export async function verifyReleaseFiles(root, lock) {
  const actualRoot = await realpath(root);
  async function inventory(directory) {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      const relative = path.relative(actualRoot, filename).split(path.sep).join('/');
      const resolved = await realpath(filename);
      assert.ok(
        resolved.startsWith(`${actualRoot}${path.sep}`),
        `asset escapes release: ${relative}`,
      );
      if (entry.isSymbolicLink())
        assert.ok(
          (await stat(filename)).isFile(),
          `non-file symlink is not a release asset: ${relative}`,
        );
      if (entry.isDirectory()) files.push(...(await inventory(filename)));
      else {
        assert.ok(
          entry.isFile() || entry.isSymbolicLink(),
          `non-regular release asset: ${relative}`,
        );
        files.push(relative);
      }
    }
    return files;
  }
  const releaseFiles = new Set(await inventory(actualRoot));
  for (const relative of releaseFiles) {
    if (Object.hasOwn(lock.files, relative)) continue;
    if (ADDITIVE_ASSETS.has(relative)) {
      const bytes = await readFile(path.join(actualRoot, relative));
      const ours = await readFile(path.join(REPO_ROOT, 'services/mujoco-web', relative));
      assert.equal(
        bytes.length,
        ours.length,
        `installed additive asset size mismatch: ${relative}`,
      );
      assert.equal(
        sha256(bytes),
        sha256(ours),
        `installed additive asset differs from checked source: ${relative}`,
      );
      continue;
    }
    assert.ok(
      ATTRIBUTION_BASENAMES.has(path.basename(relative)),
      `unexpected release file: ${relative}`,
    );
  }
  for (const [relative, expected] of Object.entries(lock.files)) {
    assert.ok(
      !path.isAbsolute(relative) && !relative.split('/').includes('..'),
      'unsafe locked path',
    );
    const filename = path.join(actualRoot, relative);
    const resolved = await realpath(filename);
    assert.ok(
      resolved.startsWith(`${actualRoot}${path.sep}`),
      `asset escapes release: ${relative}`,
    );
    const bytes = await readFile(resolved);
    if (
      relative === 'index.html' &&
      (releaseFiles.has('microduck-community-overlay.js') ||
        releaseFiles.has('microduck-network-boundary.js') ||
        bytes.toString().includes('rdk-microduck-network-policy'))
    ) {
      const guard = await readFile(path.join(actualRoot, 'microduck-network-boundary.js'));
      verifyBoundaryMarkup(bytes.toString(), sha256(guard).slice(0, 12));
    }
    if (relative === 'index.html' && bytes.toString().includes('microduck-community-overlay.js')) {
      const overlay = await readFile(path.join(actualRoot, 'microduck-community-overlay.js'));
      const ours = await readFile(
        path.join(REPO_ROOT, 'services/mujoco-web/microduck-community-overlay.js'),
      );
      assert.equal(
        sha256(overlay),
        sha256(ours),
        'installed overlay differs from the checked source',
      );
      assert.ok(
        bytes
          .toString()
          .includes(`./microduck-community-overlay.js?v=${sha256(overlay).slice(0, 12)}`),
        'installed overlay cache key is stale',
      );
    }
    const approvedBytes =
      relative === 'index.html' ? Buffer.from(upstreamIndex(bytes.toString())) : bytes;
    assert.ok(
      Number.isSafeInteger(expected.bytes) && expected.bytes >= 0,
      `invalid locked asset size: ${relative}`,
    );
    assert.equal(approvedBytes.length, expected.bytes, `approved asset size mismatch: ${relative}`);
    assert.equal(sha256(approvedBytes), expected.sha256, `approved asset mismatch: ${relative}`);
  }
  return actualRoot;
}

export function inspectBundle(source) {
  const ast = ts.createSourceFile(
    'upstream.js',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  assert.equal(ast.parseDiagnostics.length, 0, 'upstream bundle is not valid JavaScript');
  const surfaces = [];
  function visit(node) {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.expression.getText(ast) === 'window' &&
      node.left.name.text === 'rl' &&
      ts.isObjectLiteralExpression(node.right)
    )
      surfaces.push(node.right);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(surfaces.length, 1, 'exactly one window.rl runtime API is required');
  const api = surfaces[0];
  const keys = new Set(api.properties.map((property) => property.name?.text));
  for (const name of REQUIRED_API) assert.ok(keys.has(name), `runtime API missing: ${name}`);
  let block = api.parent;
  while (block && !ts.isBlock(block)) block = block.parent;
  assert.ok(block, 'runtime functions have no enclosing block');
  const topFunctions = new Map(
    ast.statements.filter(ts.isFunctionDeclaration).map((node) => [node.name?.text, node]),
  );
  const nativeFunctions = new Map(
    block.statements.filter(ts.isFunctionDeclaration).map((node) => [node.name?.text, node]),
  );
  const topVariables = new Map();
  const nativeVariables = new Map();
  for (const [statements, variables] of [
    [ast.statements, topVariables],
    [block.statements, nativeVariables],
  ]) {
    for (const statement of statements)
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name))
            variables.set(declaration.name.text, declaration.initializer);
        }
      }
  }
  const propertyRef = (name) => {
    const property = api.properties.find((item) => item.name?.text === name);
    assert.ok(
      ts.isPropertyAssignment(property) && ts.isIdentifier(property.initializer),
      `${name} must expose a native function`,
    );
    return property.initializer.text;
  };
  const loadName = propertyRef('loadCustomPolicy');
  const clearName = propertyRef('clearCustomPolicy');
  function definition(table, name) {
    const node = table.get(name);
    assert.ok(node, `pinned native definition missing: ${name}`);
    return node.getText(ast);
  }
  // Names are pinned to the reviewed bundle SHA, not guessed for arbitrary
  // third-party input. Only these pure loader/lifecycle definitions execute.
  const pure = ['rC', 'iC', 'aC', 'oC', 'sC', 'cC', 'lC', 'uC', 'dC', 'fC', 'pC', 'mC'];
  const functions = pure.map((name) => definition(topFunctions, name));
  const constants = ['eC', 'tC', 'nC', '$S'].map(
    (name) => `const ${name}=${definition(topVariables, name)};`,
  );
  const lifecycle = [definition(nativeFunctions, loadName), definition(nativeFunctions, clearName)];
  const moveDescription = definition(nativeVariables, 'ue');
  return {
    api: [...keys].sort(),
    nativeCode: `${constants.join('\n')}\n${functions.join('\n')}\nlet L=false,P=null,F=null,ce=[];const v=officials,ae=v.walk,oe=v.sitstand,N=v.roll;const ue=${moveDescription};\n${lifecycle.join('\n')}\nglobalThis.checkedRuntime={load:${loadName},clear:${clearName},get current(){return P},sessions:v};`,
  };
}

export function createPolicyHarness(inspected, ort, fetchAsset) {
  const originals = Object.fromEntries(
    ['walk', 'sitstand', 'roll'].map((slot) => [slot, { slot }]),
  );
  const statuses = [];
  const context = vm.createContext({
    URL,
    URLSearchParams,
    Uint8Array,
    Float32Array,
    Float64Array,
    performance,
    fetch: fetchAsset,
    c: ort,
    officials: { ...originals },
    r: (state) => statuses.push(state),
    console: { info() {}, warn() {} },
  });
  new vm.Script(inspected.nativeCode, {
    filename: 'approved-microduck-policy-runtime.js',
  }).runInContext(context, { timeout: 2000 });
  return { runtime: context.checkedRuntime, originals, statuses };
}

async function runPolicyChecks(root, inspected) {
  const ort = await import('onnxruntime-web');
  ort.env.wasm.numThreads = 1;
  const allowed = new Set(POLICIES);
  const fetchAsset = async (url) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://runtime-check.invalid', 'network access refused');
    if (parsed.pathname === '/manifest.json') return new Response('', { status: 404 });
    const filename = parsed.pathname.slice(1);
    assert.ok(allowed.has(filename), 'unexpected policy path');
    return new Response(await readFile(path.join(root, 'policies', filename)));
  };
  const checks = [];
  for (const filename of POLICIES) {
    const harness = createPolicyHarness(inspected, ort, fetchAsset);
    const reference = `https://runtime-check.invalid/${filename}`;
    await harness.runtime.load(reference);
    const loaded = harness.runtime.current;
    assert.equal(loaded?.ref, reference, `official ONNX failed native load: ${filename}`);
    assert.equal(loaded.actionScale, 1, 'native action scale drift');
    assert.equal(harness.runtime.sessions.walk, loaded.session, 'native walk slot not installed');
    const output = await loaded.session.run({
      [loaded.session.inputNames[0]]: new ort.Tensor('float32', new Float32Array(61), [1, 61]),
    });
    assert.deepEqual(output[loaded.session.outputNames[0]].dims, [1, 14]);
    harness.runtime.clear();
    assert.equal(harness.runtime.current, null, 'native clear kept a custom policy');
    for (const slot of Object.keys(harness.originals))
      assert.equal(
        harness.runtime.sessions[slot],
        harness.originals[slot],
        `native clear did not restore ${slot}`,
      );
    await loaded.session.release();
    checks.push({ name: `native load / infer / restore ${filename}`, ok: true });
  }
  for (const [name, makeSession, expected] of [
    [
      'wrong inputs',
      () => ({ inputNames: ['obs', 'hidden'], outputNames: ['action'] }),
      /expected 1 input/,
    ],
    ['wrong shape', () => fakeSession([1, 13]), /bad output shape/],
    ['non-finite output', () => fakeSession([1, 14], NaN), /non-finite actions/],
    ['constant output', () => fakeSession([1, 14], 0), /constant output/],
  ]) {
    const harness = createPolicyHarness(
      inspected,
      {
        Tensor: ort.Tensor,
        InferenceSession: { create: async () => makeSession() },
      },
      fetchAsset,
    );
    await harness.runtime.load(`https://runtime-check.invalid/${POLICIES[0]}`);
    assert.equal(harness.runtime.current, null, `native loader accepted ${name}`);
    assert.match(harness.statuses.at(-1)?.customPolicy?.error || '', expected);
    for (const slot of Object.keys(harness.originals))
      assert.equal(harness.runtime.sessions[slot], harness.originals[slot]);
    checks.push({ name: `native rejection: ${name}`, ok: true });
  }
  return { checks, verificationBackend: `onnxruntime-web ${ort.env.versions.web} WASM` };
}

function fakeSession(dims, value = 1) {
  return {
    inputNames: ['obs'],
    outputNames: ['action'],
    run: async () => ({ action: { dims, data: new Float32Array(14).fill(value) } }),
  };
}

export async function verifyBrowserRuntime(root) {
  assert.ok(root, 'set MICRODUCK_STATIC_ROOT to the approved static release');
  const lock = JSON.parse(await readFile(LOCK_PATH, 'utf8'));
  const actualRoot = await verifyReleaseFiles(root, lock);
  const html = await readFile(path.join(actualRoot, 'index.html'), 'utf8');
  const networkBoundaryInstalled = html.includes(NETWORK_POLICY);
  if (process.env.MICRODUCK_REQUIRE_NETWORK_BOUNDARY === '1')
    assert.ok(
      networkBoundaryInstalled,
      'publication requires the network boundary installed first',
    );
  const source = await readFile(path.join(actualRoot, lock.runtimeBundle), 'utf8');
  const inspected = inspectBundle(source);
  const result = await runPolicyChecks(actualRoot, inspected);
  return {
    ok: true,
    sourceCommit: lock.sourceCommit,
    checkedAssets: Object.keys(lock.files).length,
    networkBoundaryInstalled,
    runtimeApi: inspected.api,
    ...result,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await verifyBrowserRuntime(process.env.MICRODUCK_STATIC_ROOT);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`[microduck-browser-runtime] ${error.message}`);
    process.exitCode = 1;
  }
}
