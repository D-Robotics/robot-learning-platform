/** Source-verified compatibility patch for Studio's common JavaScript host, on macOS and Windows. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function resolveStudioArchive(appPath, platform = process.platform) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (!paths.isAbsolute(appPath)) throw Error('请提供Studio的绝对安装路径。');
  if (/\.asar$/i.test(appPath)) return appPath;
  if (platform === 'darwin' && /\.app\/?$/i.test(appPath))
    return paths.join(appPath, 'Contents', 'Resources', 'app.asar');
  if (platform === 'win32')
    return paths.join(
      /\.exe$/i.test(appPath) ? paths.dirname(appPath) : appPath,
      'resources',
      'app.asar',
    );
  throw Error('请提供macOS Studio.app、Windows安装目录或明确的app.asar文件。');
}
export function encodeAsarHeader(header) {
  const json = Buffer.from(JSON.stringify(header));
  const payload = 4 + json.length + 1,
    padded = (payload + 3) & ~3;
  const pickle = Buffer.alloc(4 + padded);
  pickle.writeUInt32LE(padded, 0);
  pickle.writeUInt32LE(json.length, 4);
  json.copy(pickle, 8);
  const size = Buffer.alloc(8);
  size.writeUInt32LE(4, 0);
  size.writeUInt32LE(pickle.length, 4);
  return Buffer.concat([size, pickle]);
}
export function patchAsarBuffer(input, patch) {
  if (input.length < 16 || input.readUInt32LE(0) !== 4)
    throw Error('Studio归档头格式不受支持；未修改应用。');
  const headerLength = input.readUInt32LE(4),
    jsonLength = input.readUInt32LE(12),
    dataStart = 8 + headerLength;
  if (dataStart > input.length || headerLength < 8 || jsonLength > headerLength - 8)
    throw Error('Studio归档头长度无效；未修改应用。');
  const header = JSON.parse(input.subarray(16, 16 + jsonLength).toString('utf8'));
  if (!header.files || !patch?.files || typeof patch.files !== 'object')
    throw Error('Studio补丁或归档清单无效。');
  const lookup = (name, create = false) => {
    let node = header;
    for (const part of name.split('/')) {
      if (
        !part ||
        ['.', '..', '__proto__', 'constructor', 'prototype'].includes(part) ||
        part.includes('\\')
      )
        throw Error('补丁路径无效。');
      if (create) node.files ??= {};
      if (!node.files || !Object.hasOwn(node.files, part)) {
        if (!create) return null;
        node.files[part] = {};
      }
      node = node.files[part];
    }
    return node;
  };
  const bytesFor = (entry) => {
    const offset = Number(entry.offset);
    if (
      entry.unpacked ||
      entry.link ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      dataStart + offset + entry.size > input.length
    )
      throw Error('目标文件不是受支持的归档内常规文件。');
    return input.subarray(dataStart + offset, dataStart + offset + entry.size);
  };
  const append = [];
  let offset = input.length - dataStart,
    changes = 0;
  for (const [name, item] of Object.entries(patch.files)) {
    if (typeof item.text !== 'string') throw Error('补丁内容无效。');
    const entry = lookup(name),
      bytes = Buffer.from(item.text);
    if (entry && sha(bytesFor(entry)) === sha(bytes)) continue;
    if (item.oldSha) {
      if (!entry || sha(bytesFor(entry)) !== item.oldSha)
        throw Error(
          '此Studio版本不兼容登录补丁，已停止且未修改应用；请升级Studio或使用浏览器授权。',
        );
    } else if (entry) throw Error('已有不同的登录适配器；未修改应用。');
    const next = lookup(name, true),
      blockSize = entry?.integrity?.blockSize || 4194304;
    Object.assign(next, {
      size: bytes.length,
      offset: String(offset),
      integrity: {
        algorithm: 'SHA256',
        hash: sha(bytes),
        blockSize,
        blocks: Array.from({ length: Math.ceil(bytes.length / blockSize) }, (_, i) =>
          sha(bytes.subarray(i * blockSize, (i + 1) * blockSize)),
        ),
      },
    });
    append.push(bytes);
    offset += bytes.length;
    changes++;
  }
  return {
    changes,
    output: changes
      ? Buffer.concat([encodeAsarHeader(header), input.subarray(dataStart), ...append])
      : input,
  };
}
export function studioProcessRunning(appPath, platform = process.platform, run = execFileSync) {
  if (platform === 'win32') {
    const image = /\.exe$/i.test(appPath) ? path.win32.basename(appPath) : 'RDK Studio.exe';
    const rows = run('tasklist.exe', ['/FI', 'IMAGENAME eq ' + image, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
    });
    return rows.toLowerCase().includes('"' + image.toLowerCase() + '"');
  }
  if (platform === 'darwin') {
    const archive = resolveStudioArchive(appPath, platform);
    const application = path.dirname(path.dirname(path.dirname(archive)));
    const processes = run('/bin/ps', ['-axo', 'comm='], { encoding: 'utf8', timeout: 10000 });
    return processes
      .split('\n')
      .some((line) => line.trim().startsWith(application + '/Contents/MacOS/'));
  }
  throw Error('无法确认Studio进程状态，未修改应用。');
}
export function installStudioLoginPatch({
  appPath,
  patch,
  platform = process.platform,
  isRunning = studioProcessRunning,
}) {
  const target = resolveStudioArchive(appPath, platform);
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) throw Error('Studio归档必须是明确的常规文件。');
  const input = fs.readFileSync(target);
  const { changes, output } = patchAsarBuffer(input, patch);
  if (!changes) return { installed: true, alreadyInstalled: true, filesChanged: 0 };
  if (isRunning(appPath, platform))
    throw Error('请先完全退出Studio，再重新双击安装；不会停止正在进行的任务或覆盖运行中的应用。');
  const suffix = randomBytes(8).toString('hex'),
    backup = target + '.before-learning-' + suffix,
    temp = target + '.learning-' + suffix + '.tmp';
  try {
    fs.writeFileSync(temp, output, { mode: stat.mode, flag: 'wx' });
    if (!fs.readFileSync(target).equals(input))
      throw Error('Studio正在更新；未覆盖应用，请退出后重试。');
    fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL);
    try {
      fs.renameSync(temp, target);
    } catch {
      throw Error('无法更新Studio归档；原文件与备份已保留。请完全退出Studio后重新安装。');
    }
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return { installed: true, filesChanged: changes, backupCreated: true, restartRequired: true };
}
if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    const [appPath, patchFile, ...extra] = process.argv.slice(2);
    if (!appPath || !patchFile || extra.length)
      throw Error(
        '请先完全退出Studio，再运行：node scripts/studio-login-patch.mjs <Studio安装路径> <host-patch.json>',
      );
    console.log(
      JSON.stringify(
        installStudioLoginPatch({ appPath, patch: JSON.parse(fs.readFileSync(patchFile, 'utf8')) }),
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
