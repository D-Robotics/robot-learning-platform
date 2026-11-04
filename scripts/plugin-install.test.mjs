import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createMcpConfiguration,
  supportedNode,
  configurePlugin,
} from '../plugins/rdk-robot-learning-platform/configure.mjs';
import {
  studioDataDirectory,
  mergeStudioConnection,
  installStudioConnection,
} from '../plugins/rdk-robot-learning-platform/scripts/install-host.mjs';

test('Windows and macOS produce direct workflow launchers with Unicode paths and no credential bindings', () => {
  for (const [platform, root, nodePath] of [
    ['win32', 'C:\\课程 插件', 'C:\\Node Runtime\\node.exe'],
    ['darwin', '/tmp/课程 插件', '/tmp/Node Runtime/node'],
  ]) {
    const c = createMcpConfiguration({ platform, root, nodePath });
    const entry = c.mcpServers['rdk-learning-platform'];
    assert.equal(entry.command, nodePath);
    assert.equal(entry.args.length, 1);
    assert.ok(entry.args[0].endsWith('experience-mcp.mjs'));
    assert.equal(entry.env.RDK_STUDIO_INHERIT_LOGIN, '1');
    assert.ok(!JSON.stringify(c).includes('credentials'));
  }
  assert.throws(() =>
    createMcpConfiguration({
      root: '/tmp/plugin',
      nodePath: '/node',
      platformUrl: 'https://user:pass@studio.example/robotics-learning',
    }),
  );
});
test('runtime selection respects the shipped minimum versions', () => {
  for (const v of ['22.22.2', '22.23.0', '24.15.0', '24.22.1', '26.0.0'])
    assert.equal(supportedNode(v), true, v);
  for (const v of ['20.19.0', '22.22.1', '24.14.9', '25.6.1'])
    assert.equal(supportedNode(v), false, v);
});
test('Studio data location follows each host OS and honors an explicit data directory', () => {
  assert.equal(
    studioDataDirectory({
      platform: 'win32',
      home: 'C:\\Users\\fixture',
      env: { APPDATA: 'C:\\Users\\fixture\\AppData\\Roaming' },
    }),
    'C:\\Users\\fixture\\AppData\\Roaming\\rdk-studio\\data',
  );
  assert.equal(
    studioDataDirectory({ platform: 'darwin', home: '/Users/fixture', env: {} }),
    '/Users/fixture/Library/Application Support/rdk-studio/data',
  );
  assert.equal(
    studioDataDirectory({
      platform: 'darwin',
      home: '/unused',
      env: { RDK_DATA_DIR: '/tmp/explicit' },
    }),
    '/tmp/explicit',
  );
});
test('installation preserves unrelated MCP entries, permissions, disable state, and an owned recovery backup', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-install-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'mcp.json');
  const current = {
    disabled: ['rdk-learning-repaired'],
    otherSetting: { untouched: true },
    mcpServers: {
      sentinel: { command: 'sentinel', env: { EXISTING_TOKEN: 'fixture-private' } },
      'rdk-learning-repaired': { command: 'old' },
    },
  };
  const before = JSON.stringify(current);
  fs.writeFileSync(target, before, { mode: 0o600 });
  const result = installStudioConnection(
    { command: '/runtime/node', args: ['/plugin/experience-mcp.mjs'] },
    { directory: dir },
  );
  assert.equal(result.installed, true);
  assert.equal(result.wasDisabled, true);
  const after = JSON.parse(fs.readFileSync(target));
  assert.deepEqual(after.mcpServers.sentinel, current.mcpServers.sentinel);
  assert.deepEqual(after.disabled, current.disabled);
  assert.deepEqual(after.otherSetting, current.otherSetting);
  assert.equal(after.mcpServers['rdk-learning-repaired'].command, '/runtime/node');
  const backup = fs.readdirSync(dir).find((n) => n.includes('.before-learning-'));
  assert.equal(fs.readFileSync(path.join(dir, backup), 'utf8'), before);
});
test('multiple learning connections require a choice; invalid config and missing host are not overwritten', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-install-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = path.join(dir, 'mcp.json');
  const text = JSON.stringify({
    mcpServers: {
      'rdk-learning-repaired': { command: 'a' },
      'rdk-learning-platform': { command: 'b' },
    },
  });
  fs.writeFileSync(p, text);
  const r = installStudioConnection({ command: 'new' }, { directory: dir });
  assert.equal(r.needsSelection, true);
  assert.equal(fs.readFileSync(p, 'utf8'), text);
  assert.equal(fs.readdirSync(dir).length, 1);
  assert.throws(() => mergeStudioConnection({ mcpServers: [] }, { command: 'new' }));
  assert.equal(
    installStudioConnection({ command: 'new' }, { directory: path.join(dir, 'missing') })
      .needsHostImport,
    true,
  );
});
test('configuration is idempotent and accepts fresh installs without a credential file', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'mcp'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.writeFileSync(
    path.join(dir, 'runtime-requirements.json'),
    JSON.stringify({ node: '^24.15.0' }),
  );
  fs.writeFileSync(path.join(dir, 'mcp/bundle.mjs'), '');
  fs.writeFileSync(path.join(dir, 'scripts/experience-mcp.mjs'), '');
  const a = configurePlugin({ root: dir, nodeVersion: '24.15.0' });
  const b = configurePlugin({ root: dir, nodeVersion: '24.15.0' });
  assert.deepEqual(a.manifest, b.manifest);
  assert.equal(fs.readdirSync(dir).filter((x) => x.endsWith('.tmp')).length, 0);
  assert.ok(!JSON.stringify(a.manifest).includes('PASSWORD'));
});

test('configuration invoked through a directory alias actually runs instead of silently exiting', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-config-alias-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'real'),
    alias = path.join(dir, 'alias');
  fs.mkdirSync(source);
  fs.mkdirSync(path.join(source, 'mcp'));
  fs.mkdirSync(path.join(source, 'scripts'));
  fs.copyFileSync(
    new URL('../plugins/rdk-robot-learning-platform/configure.mjs', import.meta.url),
    path.join(source, 'configure.mjs'),
  );
  fs.writeFileSync(
    path.join(source, 'runtime-requirements.json'),
    JSON.stringify({ node: '^22.22.2 || ^24.15.0 || >=26.0.0' }),
  );
  fs.writeFileSync(path.join(source, 'mcp/bundle.mjs'), '');
  fs.writeFileSync(path.join(source, 'scripts/experience-mcp.mjs'), '');
  fs.symlinkSync(source, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const result = spawnSync(process.execPath, [path.join(alias, 'configure.mjs')], {
    encoding: 'utf8',
    timeout: 10000,
  });
  if (supportedNode(process.versions.node)) {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).configured, true);
    assert.ok(fs.existsSync(path.join(source, '.mcp.json')));
  } else {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Node版本不支持/);
  }
});

test('both click installers use the same runtime version rules without embedded native-command quotes', async () => {
  const { spawnSync } = await import('node:child_process');
  for (const file of ['setup-macos.command', 'setup-windows.ps1']) {
    const source = fs.readFileSync(
      new URL('../plugins/rdk-robot-learning-platform/' + file, import.meta.url),
      'utf8',
    );
    const program = source.match(/-e '([^']+)'/)[1];
    assert.ok(
      !program.includes('"'),
      'PowerShell legacy argument passing must not strip JS quotes',
    );
    for (const version of ['22.22.1', '22.22.2', '24.14.9', '24.15.0', '25.6.1', '26.0.0']) {
      const result = spawnSync(
        process.execPath,
        [
          '-e',
          'Object.defineProperty(process.versions,"node",{value:' +
            JSON.stringify(version) +
            '});' +
            program,
        ],
        { encoding: 'utf8', timeout: 10000 },
      );
      assert.equal(result.status, supportedNode(version) ? 0 : 1, file + ' ' + version);
    }
  }
});
test('download metadata pins all Windows/macOS architectures to HTTPS release archives and SHA-256 receipts', () => {
  const m = JSON.parse(
    fs.readFileSync(
      new URL('../plugins/rdk-robot-learning-platform/runtime-downloads.json', import.meta.url),
    ),
  );
  assert.equal(supportedNode(m.version), true);
  assert.deepEqual(Object.keys(m.targets).sort(), [
    'darwin-arm64',
    'darwin-x64',
    'win32-arm64',
    'win32-x64',
  ]);
  for (const [target, value] of Object.entries(m.targets)) {
    assert.match(value.sha256, /^[a-f0-9]{64}$/);
    assert.ok(value.url.startsWith('https://nodejs.org/dist/v' + m.version + '/'));
    assert.ok(value.url.endsWith(target.startsWith('win') ? '.zip' : '.tar.gz'));
    assert.ok(!value.folder.includes('/') && !value.folder.includes('\\'));
  }
});
