#!/usr/bin/env node
/** Export portable plugin ZIPs, with an optional self-contained Studio target. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    'Usage: node scripts/package-platform-plugin.mjs [--out-dir DIR] [--plugin-dir DIR] [--studio-target OS-ARCH --studio-runtime ARCHIVE]\nExports plugin and marketplace ZIPs plus SHA256SUMS.\nPass --studio-target <os-arch> --studio-runtime <official Node archive> to include a self-contained Studio setup ZIP.\nRequires Python 3 (PYTHON override).\nRun npm run verify:plugin before distributing a candidate.',
  );
  process.exit(0);
}
const options = new Map();
for (let index = 0; index < args.length; index += 2) {
  const option = args[index];
  const value = args[index + 1];
  if (
    !['--out-dir', '--plugin-dir', '--studio-target', '--studio-runtime'].includes(option) ||
    !value ||
    value.startsWith('--') ||
    options.has(option)
  ) {
    throw new Error('Use --help for options.');
  }
  options.set(option, value);
}
const outputDirectory = path.resolve(
  options.get('--out-dir') ?? path.join(repositoryRoot, 'dist', 'plugins'),
);
const studioTarget = options.get('--studio-target');
const studioRuntime = options.get('--studio-runtime');
if (Boolean(studioTarget) !== Boolean(studioRuntime)) {
  throw new Error('Specify --studio-target and --studio-runtime together.');
}
const pluginRoot = path.resolve(
  options.get('--plugin-dir') ??
    path.join(repositoryRoot, 'plugins', 'rdk-robot-learning-platform'),
);
const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'plugin.json'), 'utf8'));
if (!/^[a-z][a-z0-9-]+$/.test(manifest.name) || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
  throw new Error('Invalid plugin archive identity.');
}
function collect(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (
      ['.git', '.local', 'node_modules', '__pycache__', '.DS_Store', '.env'].includes(entry.name) ||
      entry.name.startsWith('.env.') ||
      /\.py[co]$/.test(entry.name)
    )
      return [];
    const source = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Plugin resources must not be symbolic links.');
    return entry.isDirectory() ? collect(source) : [source];
  });
}
const files = collect(pluginRoot).sort();
for (const relative of [
  '.codex-plugin/plugin.json',
  '.mcp.json',
  'mcp/source-checkout.example.json',
  'skills/setup/SKILL.md',
  'scripts/start-mcp.mjs',
]) {
  if (!files.includes(path.join(pluginRoot, relative)))
    throw new Error(`Required plugin file missing: ${relative}`);
}
const catalog = path.join(repositoryRoot, '.agents', 'plugins', 'marketplace.json');
const pluginArchive = `${manifest.name}-${manifest.version}.zip`;
const marketplaceArchive = `rdk-learning-platform-marketplace-${manifest.version}.zip`;
fs.mkdirSync(outputDirectory, { recursive: true });
const instructions = [
  {
    output: path.join(outputDirectory, pluginArchive),
    entries: files.map((source) => ({
      source,
      name: `${manifest.name}/${path.relative(pluginRoot, source).split(path.sep).join('/')}`,
    })),
  },
  {
    output: path.join(outputDirectory, marketplaceArchive),
    entries: [
      { source: catalog, name: '.agents/plugins/marketplace.json' },
      ...files.map((source) => ({
        source,
        name: `plugins/${manifest.name}/${path.relative(pluginRoot, source).split(path.sep).join('/')}`,
      })),
    ],
  },
];
const archiveNames = [pluginArchive, marketplaceArchive];
if (studioTarget) {
  if (!files.includes(path.join(pluginRoot, 'scripts/experience-mcp.mjs'))) {
    throw new Error('Required Studio MCP launcher missing.');
  }
  const studioManifest = JSON.parse(
    fs.readFileSync(path.join(pluginRoot, '.rdstudio-plugin/plugin.json'), 'utf8'),
  );
  if (studioManifest.mcpServers !== './.mcp.json' || studioManifest.defaultEnabled !== true) {
    throw new Error('The Studio manifest must declare the bundled MCP and enable it on import.');
  }
  const runtimeManifest = JSON.parse(
    fs.readFileSync(path.join(pluginRoot, 'runtime-downloads.json'), 'utf8'),
  );
  const runtime =
    Object.hasOwn(runtimeManifest.targets, studioTarget) && runtimeManifest.targets[studioTarget];
  if (!runtime) throw new Error(`Unsupported Studio target: ${studioTarget}`);
  const studioArchive = `${manifest.name}-${manifest.version}-studio-${studioTarget}.zip`;
  const windows = studioTarget.startsWith('win32-');
  const binary = windows ? 'node.exe' : 'node';
  const launcher = windows ? 'setup-studio-windows.cmd' : 'setup-studio-macos.command';
  const launcherSource = windows
    ? 'portable-studio-setup-windows.cmd'
    : 'portable-studio-setup-macos.command';
  instructions.push({
    output: path.join(outputDirectory, studioArchive),
    entries: [
      ...instructions[0].entries,
      {
        source: path.join(repositoryRoot, 'scripts/portable-studio-setup.mjs'),
        name: `${manifest.name}/setup-studio.mjs`,
      },
      {
        source: path.join(repositoryRoot, 'scripts', launcherSource),
        name: `${manifest.name}/${launcher}`,
        mode: 0o100755,
      },
    ],
    studio: {
      name: manifest.name,
      target: studioTarget,
      runtimeVersion: runtimeManifest.version,
      source: runtime.url,
      checksumSource: runtimeManifest.checksumSource,
      archive: path.resolve(studioRuntime),
      sha256: runtime.sha256,
      binaryMember: `${runtime.folder}/${runtime.binary}`,
      licenseMember: `${runtime.folder}/LICENSE`,
      binary,
      launcher,
    },
  });
  archiveNames.push(studioArchive);
}
// ZIP is the supported plugin interchange format; the Python stdlib avoids an
// extra npm archiver dependency and does not execute packaged resources.
const result = spawnSync(
  process.env.PYTHON || 'python3',
  [
    '-c',
    String.raw`
import hashlib, io, json, stat, sys, tarfile, zipfile
from pathlib import Path

def checksum(data):
    return hashlib.sha256(data).hexdigest()

def json_bytes(data):
    return (json.dumps(data, ensure_ascii=False, indent=2) + '\n').encode()

def runtime_files(studio):
    data = Path(studio['archive']).read_bytes()
    if checksum(data) != studio['sha256']:
        raise ValueError('Official Node archive SHA-256 does not match the pinned target')
    members = [studio['binaryMember'], studio['licenseMember']]
    if studio['target'].startswith('win32-'):
        with zipfile.ZipFile(io.BytesIO(data)) as source:
            for member in members:
                info = source.getinfo(member)
                if info.is_dir() or stat.S_ISLNK(info.external_attr >> 16):
                    raise ValueError('Node runtime and license must be regular archive files')
            return [source.read(member) for member in members]
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as source:
        entries = [source.getmember(member) for member in members]
        if not all(entry.isfile() for entry in entries):
            raise ValueError('Node runtime and license must be regular archive files')
        return [source.extractfile(entry).read() for entry in entries]

def studio_payloads(studio, payloads, runtime):
    root = studio['name'] + '/'
    binary, license_text = runtime
    binary_path = 'mcp/runtime/' + studio['binary']
    payloads[root + binary_path] = (binary, 0o100755)
    payloads[root + 'mcp/runtime/LICENSE'] = (license_text, 0o100644)
    payloads[root + 'mcp/runtime/provenance.json'] = (json_bytes({
        'target': studio['target'],
        'nodeVersion': studio['runtimeVersion'],
        'archive': studio['source'],
        'checksumSource': studio['checksumSource'],
        'archiveSha256': studio['sha256'],
        'binarySha256': checksum(binary),
    }), 0o100644)
    plugin_root = '$' + '{PLUGIN_ROOT}/'
    payloads[root + '.mcp.json'] = (json_bytes({
        'mcpServers': {
            studio['name']: {
                'transport': 'stdio',
                'command': plugin_root + binary_path,
                'args': [plugin_root + 'scripts/experience-mcp.mjs'],
                'env': {
                    'RDK_SIM2REAL_MCP_BASE_URL': 'https://rdkstudio.d-robotics.cc/robotics-learning',
                    'RDK_STUDIO_INHERIT_LOGIN': '1',
                },
            }
        },
    }), 0o100644)
    guide = (
        '# Studio 安装\n\n'
        '此包适用于 ' + studio['target'] + '，已包含 Node.js 运行时。\n\n'
        '1. 解压 ZIP，打开 Studio。\n'
        '2. 在扩展中心选择「添加 → 导入工具目录」，选中解压后的插件目录并启用插件。\n'
        '3. 在扩展中心的插件详情核对「打包的 MCP」显示 1 项。新建对话检查学习平台状态。\n'
        '需要账号数据时，按 Studio 或平台的登录提示连接。\n\n'
        '安装完成后，启动文件位于 Studio 的插件安装目录。解压来源可移走。'
        '如需停用此插件，可在扩展中心停用。旧安装单独登记的同名连接可在 MCP 设置中管理。\n'
    ).encode()
    payloads[root + 'STUDIO-SETUP.md'] = (guide, 0o100644)
    inventory = ''.join(
        checksum(payload) + '  ' + name[len(root):] + '\n'
        for name, (payload, _) in sorted(payloads.items()) if name != root + 'FILES.sha256'
    )
    payloads[root + 'FILES.sha256'] = (inventory.encode(), 0o100644)

archives = json.load(sys.stdin)
verified_runtimes = {
    archive['output']: runtime_files(archive['studio'])
    for archive in archives if 'studio' in archive
}
for archive in archives:
    payloads = {}
    for entry in archive['entries']:
        source = Path(entry['source'])
        payloads[entry['name']] = (source.read_bytes(), entry.get('mode', source.stat().st_mode))
    if 'studio' in archive:
        studio_payloads(archive['studio'], payloads, verified_runtimes[archive['output']])
    with zipfile.ZipFile(archive['output'], 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as target:
        for name, (data, mode) in payloads.items():
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (mode & 0xffff) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            target.writestr(info, data)
`,
  ],
  { input: JSON.stringify(instructions), encoding: 'utf8' },
);
if (result.error || result.status !== 0) {
  throw new Error(`Python ZIP export failed: ${result.stderr?.trim() || result.error?.message}`);
}
const hashes = archiveNames.map((name) => {
  const file = fs.readFileSync(path.join(outputDirectory, name));
  return { name, bytes: file.length, sha256: createHash('sha256').update(file).digest('hex') };
});
fs.writeFileSync(
  path.join(outputDirectory, 'SHA256SUMS'),
  hashes.map(({ name, sha256 }) => `${sha256}  ${name}\n`).join(''),
);
console.log(
  JSON.stringify({
    ok: true,
    plugin: manifest.name,
    version: manifest.version,
    resourceCount: files.length,
    archives: hashes,
  }),
);
