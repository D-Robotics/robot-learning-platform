import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const source = fileURLToPath(new URL('./package-platform-plugin.mjs', import.meta.url));
const name = 'rdk-robot-learning-platform';
const python = process.env.PYTHON || 'python3';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function fixture(testContext, target) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rdk-studio-portable-plugin-'));
  testContext.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const builder = path.join(root, 'scripts', 'package-platform-plugin.mjs');
  write(builder, fs.readFileSync(source));
  for (const installer of [
    'portable-studio-setup.mjs',
    'portable-studio-setup-macos.command',
    'portable-studio-setup-windows.cmd',
    'portable-studio-setup-windows.ps1',
  ]) {
    write(
      path.join(root, 'scripts', installer),
      fs.readFileSync(new URL(installer, import.meta.url)),
    );
  }
  const plugin = path.join(root, 'plugins', name);
  write(path.join(plugin, 'plugin.json'), JSON.stringify({ name, version: '1.2.3' }));
  for (const file of [
    '.codex-plugin/plugin.json',
    'mcp/source-checkout.example.json',
    'skills/setup/SKILL.md',
    'scripts/start-mcp.mjs',
    'scripts/experience-mcp.mjs',
  ])
    write(path.join(plugin, file), 'fixture file');
  write(path.join(plugin, '.mcp.json'), '{"mcpServers":{}}');
  write(path.join(root, '.agents/plugins/marketplace.json'), '{}');

  const universal = target === 'universal';
  const targets = universal ? ['darwin-arm64', 'win32-x64'] : [target];
  const runtimeTargets = {};
  const runtimeFiles = {};
  for (const current of targets) {
    const folder = 'node-fixture';
    const windows = current.startsWith('win32-');
    const binary = windows ? 'node.exe' : 'bin/node';
    const runtime = path.join(root, `node-${current}.${windows ? 'zip' : 'tar.gz'}`);
    execFileSync(python, [
      '-c',
      String.raw`
import io, sys, tarfile, zipfile
filename, binary = sys.argv[1:]
files = {binary: b'executable fixture', 'node-fixture/LICENSE': b'license fixture'}
if filename.endswith('.zip'):
    with zipfile.ZipFile(filename, 'w') as archive:
        for name, data in files.items(): archive.writestr(name, data)
else:
    with tarfile.open(filename, 'w:gz') as archive:
        for name, data in files.items():
            member = tarfile.TarInfo(name)
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
`,
      runtime,
      `${folder}/${binary}`,
    ]);
    runtimeFiles[current] = runtime;
    runtimeTargets[current] = {
      url: `https://nodejs.org/dist/v24.15.0/${path.basename(runtime)}`,
      sha256: digest(fs.readFileSync(runtime)),
      folder,
      binary,
    };
  }
  write(
    path.join(plugin, 'runtime-downloads.json'),
    JSON.stringify({
      version: '24.15.0',
      checksumSource: 'https://nodejs.org/dist/v24.15.0/SHASUMS256.txt',
      targets: runtimeTargets,
    }),
  );
  const output = path.join(root, 'output');
  const args = [
    builder,
    '--out-dir',
    output,
    ...(universal
      ? ['--studio-universal-runtime-dir', root]
      : ['--studio-target', target, '--studio-runtime', runtimeFiles[target]]),
  ];
  return { runtime: runtimeFiles[target], runtimeFiles, output, args };
}

for (const target of ['darwin-arm64', 'darwin-x64', 'win32-arm64', 'win32-x64']) {
  test(`exports a self-contained stock Studio ${target} ZIP and retains a generic ZIP`, (t) => {
    const { args, output } = fixture(t, target);
    const report = JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8' }));
    assert.equal(report.archives.length, 3);
    const generic = path.join(output, `${name}-1.2.3.zip`);
    const portable = path.join(output, `${name}-1.2.3-studio-${target}.zip`);
    assert.equal(digest(fs.readFileSync(portable)), report.archives[2].sha256);
    const tool = target.startsWith('win32-') ? 'node.exe' : 'node';
    execFileSync(python, [
      '-c',
      String.raw`
import hashlib, json, sys, zipfile
generic, portable, root, binary, native = sys.argv[1:]
with zipfile.ZipFile(generic) as archive:
    assert json.loads(archive.read(root + '.mcp.json')) == {'mcpServers': {}}
    assert root + binary not in archive.namelist()
with zipfile.ZipFile(portable) as archive:
    config = json.loads(archive.read(root + '.mcp.json'))['mcpServers'][root.rstrip('/')]
    assert config['commandByPlatform'] == {native: './' + binary}
    assert config['command'] == './' + binary
    assert config['args'] == ['./scripts/experience-mcp.mjs']
    launcher = 'setup-studio-windows.cmd' if binary.endswith('.exe') else 'setup-studio-macos.command'
    assert root + launcher in archive.namelist()
    assert root + 'setup-studio.mjs' in archive.namelist()
    assert launcher in archive.read(root + 'STUDIO-SETUP.md').decode()
    assert archive.getinfo(root + binary).external_attr >> 16 & 0o111 == 0o111
    assert archive.read(root + binary) == b'executable fixture'
    assert archive.read(root + 'mcp/runtime/LICENSE') == b'license fixture'
    inventory = dict(line.split('  ', 1)[::-1] for line in archive.read(root + 'FILES.sha256').decode().splitlines())
    entries = [name for name in archive.namelist() if name != root + 'FILES.sha256']
    assert set(inventory) == {name[len(root):] for name in entries}
    assert all(hashlib.sha256(archive.read(name)).hexdigest() == inventory[name[len(root):]] for name in entries)
`,
      generic,
      portable,
      `${name}/`,
      `mcp/runtime/${tool}`,
      target,
    ]);
  });
}

test('rejects a changed runtime archive before publishing any ZIP', (t) => {
  const { args, output, runtime } = fixture(t, 'darwin-arm64');
  fs.appendFileSync(runtime, 'tampered');
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SHA-256 does not match/);
  assert.deepEqual(fs.readdirSync(output), []);
});

test('exports one Studio ZIP for Windows x64 and Apple Silicon with complete provenance', (t) => {
  const { args, output } = fixture(t, 'universal');
  const report = JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8' }));
  assert.equal(report.archives.length, 3);
  const portable = path.join(output, `${name}-1.2.3-studio-universal.zip`);
  assert.equal(digest(fs.readFileSync(portable)), report.archives[2].sha256);
  execFileSync(python, [
    '-c',
    String.raw`
import hashlib, json, sys, zipfile
portable, root = sys.argv[1:]
with zipfile.ZipFile(portable) as archive:
    assert archive.testzip() is None
    config = json.loads(archive.read(root + '.mcp.json'))['mcpServers'][root.rstrip('/')]
    assert config['commandByPlatform'] == {
        'darwin-arm64': './mcp/runtime/darwin-arm64/node',
        'win32-x64': './mcp/runtime/win32-x64/node.exe',
    }
    assert config['args'] == ['./scripts/experience-mcp.mjs']
    assert config['requestTimeoutMs'] == 150000
    assert config['permissions']['tools'] == dict.fromkeys([
        'rdk_workshop', 'rdk_originman_reference_track', 'rdk_originman_motion_library',
        'rdk_originman_motion_preview', 'rdk_training_status',
    ], 'readonly')
    guide = archive.read(root + 'STUDIO-SETUP.md').decode()
    for launcher in ['setup-studio-windows.cmd', 'setup-studio-macos.command']:
        assert root + launcher in archive.namelist()
        assert launcher in guide
    assert root + 'setup-studio-windows.ps1' in archive.namelist()
    assert root + 'mcp/runtime/provenance.json' not in archive.namelist()
    runtime_root = root + 'mcp/runtime/'
    assert {
        entry[len(runtime_root):].split('/')[0]
        for entry in archive.namelist() if entry.startswith(runtime_root)
    } == {'darwin-arm64', 'win32-x64'}
    assert 'Windows x64' in guide and 'Apple 芯片 Mac' in guide
    for target, binary in [('win32-x64', 'node.exe'), ('darwin-arm64', 'node')]:
        directory = runtime_root + target + '/'
        path = directory + binary
        provenance = json.loads(archive.read(directory + 'provenance.json'))
        assert provenance['target'] == target
        assert target in provenance['archive']
        assert provenance['binarySha256'] == hashlib.sha256(archive.read(path)).hexdigest()
        assert archive.getinfo(path).external_attr >> 16 & 0o111 == 0o111
        assert archive.read(directory + 'LICENSE') == b'license fixture'
    inventory = dict(line.split('  ', 1)[::-1] for line in archive.read(root + 'FILES.sha256').decode().splitlines())
    entries = [name for name in archive.namelist() if name != root + 'FILES.sha256']
    assert set(inventory) == {name[len(root):] for name in entries}
    assert all(hashlib.sha256(archive.read(name)).hexdigest() == inventory[name[len(root):]] for name in entries)
`,
    portable,
    `${name}/`,
  ]);
});

test('universal packaging discards staged ZIPs if any architecture fails validation', (t) => {
  const { args, output, runtimeFiles } = fixture(t, 'universal');
  fs.appendFileSync(runtimeFiles['win32-x64'], 'tampered');
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /pinned target: win32-x64/);
  assert.deepEqual(fs.readdirSync(output), []);
});
