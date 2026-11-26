#!/usr/bin/env node
/** Export portable plugin ZIPs, optionally bundling Studio runtimes. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    'Usage: node scripts/package-platform-plugin.mjs [--out-dir DIR] [--studio-target OS-ARCH --studio-runtime ARCHIVE | --studio-universal-runtime-dir DIR]\nExports plugin and marketplace ZIPs plus SHA256SUMS.\nTo produce one Studio ZIP for Windows x64 and Apple Silicon Mac, place the pinned win32-x64 and darwin-arm64 Node archives from runtime-downloads.json in DIR under their original names.\nRequires Python 3 (PYTHON override).\nRun npm run verify:plugin before distributing a candidate.',
  );
  process.exit(0);
}
const options = new Map();
for (let index = 0; index < args.length; index += 2) {
  const option = args[index];
  const value = args[index + 1];
  if (
    ![
      '--out-dir',
      '--studio-target',
      '--studio-runtime',
      '--studio-universal-runtime-dir',
    ].includes(option) ||
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
const universalRuntimeDirectory = options.get('--studio-universal-runtime-dir');
if (Boolean(studioTarget) !== Boolean(studioRuntime)) {
  throw new Error('Specify --studio-target and --studio-runtime together.');
}
if (studioTarget && universalRuntimeDirectory) {
  throw new Error('Choose either single-target or universal Studio packaging.');
}
const pluginRoot = path.join(repositoryRoot, 'plugins', 'rdk-robot-learning-platform');
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
if (studioTarget || universalRuntimeDirectory) {
  if (!files.includes(path.join(pluginRoot, 'scripts/experience-mcp.mjs'))) {
    throw new Error('Required Studio MCP launcher missing.');
  }
  const runtimeManifest = JSON.parse(
    fs.readFileSync(path.join(pluginRoot, 'runtime-downloads.json'), 'utf8'),
  );
  const universal = Boolean(universalRuntimeDirectory);
  const targets = universal ? ['darwin-arm64', 'win32-x64'] : [studioTarget];
  const runtimes = targets.map((target) => {
    const runtime =
      Object.hasOwn(runtimeManifest.targets, target) && runtimeManifest.targets[target];
    if (!runtime) throw new Error(`Unsupported Studio target: ${target}`);
    return {
      target,
      runtimeVersion: runtimeManifest.version,
      source: runtime.url,
      checksumSource: runtimeManifest.checksumSource,
      archive: universal
        ? path.resolve(
            universalRuntimeDirectory,
            path.posix.basename(new URL(runtime.url).pathname),
          )
        : path.resolve(studioRuntime),
      sha256: runtime.sha256,
      binaryMember: `${runtime.folder}/${runtime.binary}`,
      licenseMember: `${runtime.folder}/LICENSE`,
      binary: target.startsWith('win32-') ? 'node.exe' : 'node',
    };
  });
  const studioArchive = `${manifest.name}-${manifest.version}-studio-${universal ? 'universal' : studioTarget}.zip`;
  const launchers = [
    ...(targets.some((target) => target.startsWith('darwin-'))
      ? ['setup-studio-macos.command']
      : []),
    ...(targets.some((target) => target.startsWith('win32-'))
      ? ['setup-studio-windows.cmd', 'setup-studio-windows.ps1']
      : []),
  ];
  instructions.push({
    output: path.join(outputDirectory, studioArchive),
    entries: [
      ...instructions[0].entries,
      {
        source: path.join(repositoryRoot, 'scripts/portable-studio-setup.mjs'),
        name: `${manifest.name}/setup-studio.mjs`,
      },
      ...launchers.map((launcher) => ({
        source: path.join(
          repositoryRoot,
          'scripts',
          'portable-' + launcher.replace('setup-studio', 'studio-setup'),
        ),
        name: `${manifest.name}/${launcher}`,
        mode: 0o100755,
      })),
    ],
    studio: { name: manifest.name, universal, runtimes },
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
import hashlib, json, stat, sys, tarfile, tempfile, zipfile
from pathlib import Path

def checksum(data):
    return hashlib.sha256(data).hexdigest()

def json_bytes(data):
    return (json.dumps(data, ensure_ascii=False, indent=2) + '\n').encode()

def runtime_files(studio):
    members = [studio['binaryMember'], studio['licenseMember']]
    with Path(studio['archive']).open('rb') as archive:
        digest = hashlib.sha256()
        for chunk in iter(lambda: archive.read(1024 * 1024), b''):
            digest.update(chunk)
        if digest.hexdigest() != studio['sha256']:
            raise ValueError('Official Node archive SHA-256 does not match the pinned target: ' + studio['target'])
        archive.seek(0)
        if studio['target'].startswith('win32-'):
            with zipfile.ZipFile(archive) as source:
                for member in members:
                    info = source.getinfo(member)
                    if info.is_dir() or stat.S_ISLNK(info.external_attr >> 16):
                        raise ValueError('Node runtime and license must be regular archive files')
                return [source.read(member) for member in members]
        with tarfile.open(fileobj=archive, mode='r:gz') as source:
            entries = [source.getmember(member) for member in members]
            if not all(entry.isfile() for entry in entries):
                raise ValueError('Node runtime and license must be regular archive files')
            return [source.extractfile(entry).read() for entry in entries]

def write_zip_entry(archive, name, data, mode):
    info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
    info.create_system = 3
    info.external_attr = (mode & 0xffff) << 16
    info.compress_type = zipfile.ZIP_DEFLATED
    archive.writestr(info, data)

def write_runtime(add, studio, directory):
    binary, license_text = runtime_files(studio)
    add(directory + studio['binary'], binary, 0o100755)
    add(directory + 'LICENSE', license_text, 0o100644)
    add(directory + 'provenance.json', json_bytes({
        'target': studio['target'],
        'nodeVersion': studio['runtimeVersion'],
        'archive': studio['source'],
        'checksumSource': studio['checksumSource'],
        'archiveSha256': studio['sha256'],
        'binarySha256': checksum(binary),
    }), 0o100644)

def write_studio_entries(add, studio):
    commands = {}
    for item in studio['runtimes']:
        directory = 'mcp/runtime/'
        if studio['universal']:
            directory += item['target'] + '/'
        write_runtime(add, item, directory)
        commands[item['target']] = './' + directory + item['binary']
    # On older Studio versions the ordinary command remains usable on Apple Silicon
    # and in single-target packages. Updated Studio selects the installed native path.
    add('.mcp.json', json_bytes({'mcpServers': {studio['name']: {
        'transport': 'stdio',
        'command': next(iter(commands.values())),
        'commandByPlatform': commands,
        'args': ['./scripts/experience-mcp.mjs'],
        'requestTimeoutMs': 150000,
        'permissions': {'tools': {tool: 'readonly' for tool in (
            'rdk_workshop', 'rdk_originman_reference_track', 'rdk_originman_motion_preview',
            'rdk_originman_motion_library', 'rdk_training_status',
        )}},
        'env': {'RDK_SIM2REAL_MCP_BASE_URL': 'https://rdkstudio.d-robotics.cc/robotics-learning'},
    }}}), 0o100644)
    if studio['universal']:
        platform = '此包适用于 Windows x64 和 Apple 芯片 Mac，已包含这两种机型的 Node.js 运行时。'
        launcher = 'Windows 双击 setup-studio-windows.cmd，macOS 双击 setup-studio-macos.command。安装器会选择本机架构的运行时。'
    else:
        target = studio['runtimes'][0]['target']
        platform = '此包适用于 ' + target + '，已包含 Node.js 运行时。'
        filename = 'setup-studio-windows.cmd' if target.startswith('win32-') else 'setup-studio-macos.command'
        launcher = '双击解压目录中的 ' + filename + '。'
    add('STUDIO-SETUP.md', (
        '# Studio 安装\n\n'
        + platform + '\n\n'
        '1. 解压 ZIP，打开 Studio。\n'
        '2. 在扩展中心选择「添加 → 从目录导入插件」，选中解压后的插件目录。升级时选择覆盖安装。\n'
        '3. 连接检查通过后，在对话中说「打开 Workshop」。首次访问账号数据按页面提示登录。\n\n'
        '若早期 Studio 提示连接失败，' + launcher + '兼容安装器会核对 Studio 已导入的副本与连接。\n\n'
        '安装完成后，启动文件位于 Studio 的插件安装目录。解压来源可移走。'
        '如需停用此插件，也在 Studio 的 MCP 设置中停用机器人学习连接。\n'
    ).encode(), 0o100644)

def write_zip(archive, filename):
    with zipfile.ZipFile(filename, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as target:
        studio = archive.get('studio')
        root = studio['name'] + '/' if studio else ''
        inventory = {}
        def add(name, data, mode):
            write_zip_entry(target, root + name, data, mode)
            inventory[name] = checksum(data)
        for entry in archive['entries']:
            name, source = entry['name'], Path(entry['source'])
            if studio and name in {root + 'FILES.sha256', root + '.mcp.json'}:
                continue
            mode = entry.get('mode', source.stat().st_mode)
            if studio:
                add(name[len(root):], source.read_bytes(), mode)
            else:
                write_zip_entry(target, name, source.read_bytes(), mode)
        if studio:
            write_studio_entries(add, studio)
            receipt = ''.join(digest + '  ' + name + '\n' for name, digest in sorted(inventory.items()))
            write_zip_entry(target, root + 'FILES.sha256', receipt.encode(), 0o100644)

archives = json.load(sys.stdin)
with tempfile.TemporaryDirectory(dir=Path(archives[0]['output']).parent) as stage:
    for archive in archives:
        write_zip(archive, Path(stage) / Path(archive['output']).name)
    for archive in archives:
        (Path(stage) / Path(archive['output']).name).replace(archive['output'])
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
