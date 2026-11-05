/** Build a private Qoder desktop import ZIP using Node built-ins only. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
const outputName = 'Qoder本机导入包.zip';
const directories = new Set([
  'ui',
  'scripts',
  'skills',
  'references',
  'licenses',
  'mcp',
  'host',
  '.qoder-plugin',
  '.codex-plugin',
  '.rdstudio-plugin',
]);
const rootFiles = new Set([
  '.mcp.json',
  'plugin.json',
  'provenance.json',
  'upstream-provenance.json',
  'retained-workflow-provenance.json',
  'retained-workflow-044-provenance.json',
  'experience-extension.json',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'README.md',
  'configure.mjs',
  'setup.mjs',
  'setup-macos.command',
  'setup-qoder-macos.command',
  'setup-windows.cmd',
  'setup-windows.ps1',
  'setup-qoder-windows.cmd',
  'runtime-downloads.json',
  'runtime-requirements.json',
  'windows-binding.mjs',
]);
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function createQoderImportZip(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'));
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(manifest.name)) throw Error('插件名称不适合生成导入包。');
  const files = [];
  let total = 0;
  const visit = (directory, relative = '') => {
    for (const name of fs.readdirSync(directory).sort()) {
      if (!relative && !directories.has(name) && !rootFiles.has(name)) continue;
      if (name === '.DS_Store') continue;
      const file = path.join(directory, name),
        rel = relative ? relative + '/' + name : name;
      const info = fs.lstatSync(file);
      if (info.isSymbolicLink()) throw Error('导入包包含符号链接，请使用完整解压目录。');
      if (info.isDirectory()) visit(file, rel);
      else if (info.isFile()) {
        total += info.size;
        if (info.size > 16 * 1024 * 1024 || total > 64 * 1024 * 1024 || files.length >= 4095)
          throw Error('导入包超出体积预算，请核对插件目录。');
        files.push({ name: rel, bytes: fs.readFileSync(file), mode: info.mode });
      }
    }
  };
  visit(root);
  if (
    !files.some((f) => f.name === '.mcp.json') ||
    !files.some((f) => f.name === 'scripts/experience-mcp.mjs')
  )
    throw Error('插件文件不完整，无法生成Qoder导入包。');
  const inventory = files
    .map((f) => createHash('sha256').update(f.bytes).digest('hex') + '  ' + f.name + '\n')
    .join('');
  files.push({ name: 'FILES.sha256', bytes: Buffer.from(inventory), mode: 0o100644 });
  const parts = [],
    central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(manifest.name + '/' + f.name),
      crc = crc32(f.bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(33, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(f.bytes.length, 18);
    header.writeUInt32LE(f.bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    parts.push(header, name, f.bytes);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(0x0314, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x800, 8);
    c.writeUInt16LE(33, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(f.bytes.length, 20);
    c.writeUInt32LE(f.bytes.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(((f.mode & 0xffff) * 65536) >>> 0, 38);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += header.length + name.length + f.bytes.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  const archive = Buffer.concat([...parts, directory, end]);
  const target = path.join(root, outputName),
    temporary = target + '.' + randomBytes(8).toString('hex') + '.tmp';
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink())
    throw Error('导入包目标是符号链接，未覆盖。');
  try {
    fs.writeFileSync(temporary, archive, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return { archive: target, files: files.length, bytes: archive.length, privateCopy: true };
}
