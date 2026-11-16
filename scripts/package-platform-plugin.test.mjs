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
  write(
    path.join(plugin, '.rdstudio-plugin/plugin.json'),
    JSON.stringify({ name, version: '1.2.3', mcpServers: './.mcp.json', defaultEnabled: true }),
  );
  write(path.join(plugin, '.mcp.json'), '{"mcpServers":{}}');
  write(path.join(root, '.agents/plugins/marketplace.json'), '{}');

  const folder = 'node-fixture';
  const windows = target.startsWith('win32-');
  const binary = windows ? 'node.exe' : 'bin/node';
  const runtime = path.join(root, windows ? 'node.zip' : 'node.tar.gz');
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
  write(
    path.join(plugin, 'runtime-downloads.json'),
    JSON.stringify({
      version: '24.15.0',
      checksumSource: 'https://nodejs.org/dist/v24.15.0/SHASUMS256.txt',
      targets: {
        [target]: {
          url: `https://nodejs.org/dist/v24.15.0/${path.basename(runtime)}`,
          sha256: digest(fs.readFileSync(runtime)),
          folder,
          binary,
        },
      },
    }),
  );
  const output = path.join(root, 'output');
  const args = [
    builder,
    '--out-dir',
    output,
    '--studio-target',
    target,
    '--studio-runtime',
    runtime,
  ];
  return { runtime, output, args };
}

for (const target of ['darwin-arm64', 'win32-x64']) {
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
generic, portable, root, binary = sys.argv[1:]
with zipfile.ZipFile(generic) as archive:
    assert json.loads(archive.read(root + '.mcp.json')) == {'mcpServers': {}}
    assert root + binary not in archive.namelist()
with zipfile.ZipFile(portable) as archive:
    config = json.loads(archive.read(root + '.mcp.json'))['mcpServers']
    assert list(config) == [root.rstrip('/')]
    server = config[root.rstrip('/')]
    assert server['transport'] == 'stdio'
    assert server['command'] == '$' + '{PLUGIN_ROOT}/' + binary
    assert server['args'] == ['$' + '{PLUGIN_ROOT}/scripts/experience-mcp.mjs']
    assert server['env'] == {
        'RDK_SIM2REAL_MCP_BASE_URL': 'https://rdkstudio.d-robotics.cc/robotics-learning',
        'RDK_STUDIO_INHERIT_LOGIN': '1',
    }
    launcher = 'setup-studio-windows.cmd' if binary.endswith('.exe') else 'setup-studio-macos.command'
    assert root + launcher in archive.namelist()
    assert root + 'setup-studio.mjs' in archive.namelist()
    assert '打包的 MCP' in archive.read(root + 'STUDIO-SETUP.md').decode()
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
