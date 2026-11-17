const fields = new Set(['fps.npy', 'joint_names.npy', 'joint_pos.npy', 'joint_vel.npy']);
const maxEntry = 12_000 * 20 * 8 + 4096;
const utf8 = new TextDecoder();

async function unpack(bytes, method, length) {
  if (method === 0 && bytes.length === length) return bytes;
  if (method !== 8 || length > maxEntry) throw Error('NPZ 使用了不支持的压缩方式或字段过大。');
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const result = new Uint8Array(length);
  let offset = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (offset + value.length > length) throw Error('NPZ 解压大小与目录不符。');
      result.set(value, offset);
      offset += value.length;
    }
    if (offset !== length) throw Error('NPZ 字段有缺损。');
  } finally {
    await reader.cancel().catch(() => {});
  }
  return result;
}

function parseArray(bytes, name) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] !== 0x93 || utf8.decode(bytes.subarray(1, 6)) !== 'NUMPY' || ![1, 2, 3].includes(bytes[6]))
    throw Error(`${name} 缺少有效的 NumPy 头。`);
  const infoSize = bytes[6] === 1 ? 10 : 12;
  const length = infoSize === 10 ? view.getUint16(8, true) : view.getUint32(8, true);
  const start = infoSize + length;
  if (length > 4096 || start >= bytes.length) throw Error(`${name} 的 NumPy 头无效。`);
  const header = utf8.decode(bytes.subarray(infoSize, start));
  const dtype = header.match(/'descr':\s*'([^']+)'/)?.[1];
  const shape = header.match(/'shape':\s*\(([^)]*)\)/)?.[1];
  if (shape === undefined || !/'fortran_order':\s*False/.test(header))
    throw Error(`${name} 须为普通 NumPy 数组（C 顺序）。`);
  const dimensions = shape.split(',').map((item) => item.trim()).filter(Boolean).map(Number);
  if (name === 'joint_names.npy') {
    const stringType = dtype?.match(/^(<U|\|S)(\d+)$/);
    const length = Number(stringType?.[2]);
    if (dimensions.length !== 1 || dimensions[0] !== 20 || !stringType || length < 1 || length > 64)
      throw Error('joint_names 须是长度为 20 的字符串数组。');
    const unicode = stringType[1] === '<U';
    const width = length * (unicode ? 4 : 1);
    if (bytes.length !== start + 20 * width) throw Error('joint_names 数据长度不匹配。');
    return Array.from({ length: 20 }, (_, j) => {
      const offset = start + j * width;
      if (!unicode) return utf8.decode(bytes.subarray(offset, offset + width)).replace(/\0+$/, '');
      const codes = Array.from({ length }, (_, i) => view.getUint32(offset + i * 4, true))
        .filter(Boolean);
      return String.fromCodePoint(...codes);
    });
  }
  const getter = { '<f4': 'getFloat32', '<f8': 'getFloat64', '<i4': 'getInt32',
    '<i8': 'getBigInt64', '<u4': 'getUint32', '<u8': 'getBigUint64' }[dtype];
  if (!getter) throw Error(`${name} 须使用小端数字数组。`);
  const width = Number(dtype[2]);
  if (name === 'fps.npy') {
    if ((dimensions.length !== 0 && !(dimensions.length === 1 && dimensions[0] === 1)) ||
      bytes.length !== start + width) throw Error('fps 须是单个数字。');
    return Number(view[getter](start, true));
  }
  const [rows, cols] = dimensions;
  if (dimensions.length !== 2 || !Number.isInteger(rows) || rows < 50 || rows > 12_000 ||
      cols !== 20 || bytes.length !== start + rows * cols * width)
    throw Error(`${name} 须是 50–12,000 行、20 列的数组。`);
  return Array.from({ length: rows }, (_, row) => Array.from({ length: cols }, (_, col) => {
    const value = Number(view[getter](start + (row * cols + col) * width, true));
    if (!Number.isFinite(value)) throw Error(`${name} 含非有限数值。`);
    return Number(value.toFixed(5));
  }));
}

export async function readOriginmanNpz(input) {
  const raw = new Uint8Array(input);
  if (raw.length < 22 || raw.length > 8 * 1024 * 1024) throw Error('NPZ 文件大小超出范围。');
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const u16 = (p) => view.getUint16(p, true);
  const u32 = (p) => view.getUint32(p, true);
  let end = raw.length - 22;
  while (end >= Math.max(0, raw.length - 65_557)) {
    if (u32(end) === 0x06054b50 && end + 22 + u16(end + 20) === raw.length) break;
    end--;
  }
  if (end < Math.max(0, raw.length - 65_557) || u16(end + 4) || u16(end + 6))
    throw Error('NPZ 文件的 ZIP 目录无效。');
  const entries = u16(end + 10);
  let pos = u32(end + 16);
  if (entries < 4 || entries > 32 || u16(end + 8) !== entries || pos + u32(end + 12) !== end)
    throw Error('NPZ 文件的字段目录无效。');
  const arrays = new Map();
  for (let i = 0; i < entries; i++) {
    if (pos + 46 > end || u32(pos) !== 0x02014b50) throw Error('NPZ 字段目录损坏。');
    const nameLength = u16(pos + 28);
    const next = pos + 46 + nameLength + u16(pos + 30) + u16(pos + 32);
    if (next > end) throw Error('NPZ 字段目录损坏。');
    const name = utf8.decode(raw.subarray(pos + 46, pos + 46 + nameLength));
    if (fields.has(name)) {
      const offset = u32(pos + 42);
      const unpacked = u32(pos + 24);
      const dataSize = u32(pos + 20);
      if (arrays.has(name) || unpacked > maxEntry || offset + 30 > u32(end + 16) ||
        u32(offset) !== 0x04034b50 || (u16(pos + 8) & 1) || (u16(offset + 6) & 1) ||
        u16(offset + 8) !== u16(pos + 10)) throw Error(`${name} 的 NPZ 记录无效。`);
      const data = offset + 30 + u16(offset + 26) + u16(offset + 28);
      if (data + dataSize > u32(end + 16)) throw Error(`${name} 的 NPZ 数据损坏。`);
      arrays.set(name, parseArray(await unpack(raw.subarray(data, data + dataSize), u16(pos + 10), unpacked), name));
    }
    pos = next;
  }
  if (arrays.size !== fields.size || pos !== end) throw Error('NPZ 须包含 fps、joint_names、joint_pos 和 joint_vel。');
  return {
    schemaVersion: 1, fps: arrays.get('fps.npy'), joint_names: arrays.get('joint_names.npy'),
    joint_pos: arrays.get('joint_pos.npy'), joint_vel: arrays.get('joint_vel.npy'),
  };
}
