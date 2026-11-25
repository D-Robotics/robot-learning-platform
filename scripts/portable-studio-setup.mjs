#!/usr/bin/env node
/** Run from the Studio package. Bind the copy the stock Studio importer owns. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fs.realpathSync(path.dirname(fileURLToPath(import.meta.url)));
const name = 'rdk-robot-learning-platform';
const allowed = new Set([
  '--platform-url',
  '--studio-data-dir',
  '--connection-name',
  '--resource-id',
]);

function readFile(file) {
  if (!fs.lstatSync(file).isFile()) throw Error('安装包含非常规文件：' + path.basename(file));
  return fs.readFileSync(file);
}

function importedRoot(dataDirectory, expectedVersion) {
  const registry = path.join(dataDirectory, 'plugins-registry.json');
  if (!fs.existsSync(registry)) return null;
  if (fs.lstatSync(registry).size > 2 * 1024 * 1024) throw Error('Studio 插件登记文件过大。');
  const record = JSON.parse(readFile(registry)).plugins?.[name + '@user'];
  if (
    !record ||
    record.enabled !== true ||
    record.version !== expectedVersion ||
    typeof record.installPath !== 'string'
  ) {
    return null;
  }
  if (!path.isAbsolute(record.installPath) || !fs.existsSync(record.installPath)) return null;
  if (!fs.lstatSync(record.installPath).isDirectory()) throw Error('Studio 插件安装目录无效。');
  return fs.realpathSync(record.installPath);
}

function vendorPath(installed, relative) {
  if (
    /[:\\]/.test(relative) ||
    relative.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw Error('安装包文件清单格式无效。');
  const local = path.resolve(installed, relative);
  if (fs.realpathSync(local) !== local) throw Error('导入的插件含符号链接：' + relative);
  if (!fs.lstatSync(local).isFile()) throw Error('安装包含非常规文件：' + relative);
  return local;
}

async function verifyImportedFiles(installed) {
  const expected = readFile(path.join(root, 'FILES.sha256'));
  if (!readFile(vendorPath(installed, 'FILES.sha256')).equals(expected)) {
    throw Error('Studio 中的插件与当前安装包不一致。请重新从这个目录导入。');
  }
  for (const row of expected.toString('utf8').trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(row);
    if (!match) throw Error('安装包文件清单格式无效。');
    const [, checksum, relative] = match;
    // Re-running setup may replace this single machine-local configuration.
    if (relative === '.mcp.json') continue;
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(vendorPath(installed, relative))) {
      hash.update(chunk);
    }
    if (hash.digest('hex') !== checksum) throw Error('已导入的插件文件校验失败：' + relative);
  }
}

try {
  const args = process.argv.slice(2);
  const options = new Map();
  for (let i = 0; i < args.length; i += 2) {
    const [key, value] = args.slice(i, i + 2);
    if (!allowed.has(key) || !value || value.startsWith('--') || options.has(key)) {
      throw Error('Studio 安装参数无效。');
    }
    options.set(key, value);
  }
  const { studioDataDirectory } = await import('./scripts/install-host.mjs');
  const dataDirectory = options.get('--studio-data-dir') ?? studioDataDirectory();
  if (!path.isAbsolute(dataDirectory)) throw Error('Studio 数据目录必须是绝对路径。');
  const manifest = JSON.parse(readFile(path.join(root, 'plugin.json')));
  const target = process.platform + '-' + process.arch;
  const legacyRuntime = path.join('mcp', 'runtime');
  const runtimeDirectory = fs.existsSync(path.join(root, legacyRuntime, 'provenance.json'))
    ? legacyRuntime
    : path.join(legacyRuntime, target);
  const runtime = JSON.parse(readFile(path.join(root, runtimeDirectory, 'provenance.json')));
  if (
    manifest.name !== name ||
    runtime.target !== target ||
    runtime.nodeVersion !== process.versions.node
  ) {
    throw Error('插件或 Node 与当前 Studio 安装包不匹配。请按系统和架构选择对应包。');
  }
  const installed = importedRoot(dataDirectory, manifest.version);
  if (!installed) {
    console.log(
      JSON.stringify({
        ok: true,
        installationState: 'requires-action',
        nextAction: '请在 Studio 扩展中心导入此解压目录并启用插件，然后重新运行安装器。',
      }),
    );
    process.exitCode = 2;
  } else {
    await verifyImportedFiles(installed);
    const binary = path.join(
      installed,
      runtimeDirectory,
      process.platform === 'win32' ? 'node.exe' : 'node',
    );
    const child = spawnSync(
      binary,
      [path.join(installed, 'setup.mjs'), '--host', 'studio', ...args],
      {
        stdio: 'inherit',
      },
    );
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
  }
} catch (error) {
  console.error(
    JSON.stringify({
      ok: false,
      installationState: 'failed',
      nextAction: error.message,
    }),
  );
  process.exitCode = 1;
}
