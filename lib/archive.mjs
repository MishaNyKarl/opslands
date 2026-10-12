import { deflateRawSync, inflateRawSync } from 'node:zlib';

const MAX = 40 * 1024 * 1024;
const table = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = table[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export function safePath(name) {
  if (!name || name.includes('\\') || name.startsWith('/') || /[:\x00-\x1f]/.test(name) || name.split('/').some(x => x === '..' || x === '.' || !x)) throw new Error('Недопустимый путь в архиве');
  return name;
}
export function zip(files) {
  const chunks = [], directory = [];
  let offset = 0;
  for (const [path, content] of Object.entries(files)) {
    const name = Buffer.from(safePath(path)), bytes = Buffer.from(content, 'base64');
    const compressed = deflateRawSync(bytes), crc = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    directory.push(central, name); offset += local.length + name.length + compressed.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(directory.length / 2, 8); end.writeUInt16LE(directory.length / 2, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, central, end]);
}
export function unzip(bytes) {
  try {
    let end = -1;
    for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--) {
      if (bytes.readUInt32LE(p) === 0x06054b50 && p + 22 + bytes.readUInt16LE(p + 20) === bytes.length) { end = p; break; }
    }
    if (end < 0) throw new Error('Обычный ZIP-архив не найден');
    if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw new Error('Многотомные ZIP не поддерживаются');
    const count = bytes.readUInt16LE(end + 10);
    if (!count || count > 500) throw new Error('В архиве должно быть от 1 до 500 файлов');
    let pos = bytes.readUInt32LE(end + 16), size = 0;
    const files = Object.create(null);
    for (let i = 0; i < count; i++) {
      if (bytes.readUInt32LE(pos) !== 0x02014b50) throw new Error('Поврежден ZIP');
      const flags = bytes.readUInt16LE(pos + 8), method = bytes.readUInt16LE(pos + 10);
      const compressedSize = bytes.readUInt32LE(pos + 20), expanded = bytes.readUInt32LE(pos + 24);
      const n = bytes.readUInt16LE(pos + 28), extra = bytes.readUInt16LE(pos + 30), comment = bytes.readUInt16LE(pos + 32);
      const offset = bytes.readUInt32LE(pos + 42), mode = bytes.readUInt32LE(pos + 38) >>> 16;
      const name = bytes.subarray(pos + 46, pos + 46 + n).toString('utf8');
      const expected = bytes.readUInt32LE(pos + 16);
      pos += 46 + n + extra + comment;
      if (flags & 1 || ![0, 8].includes(method)) throw new Error('Нужен ZIP без пароля, со сжатием Deflate или Store');
      if ((mode & 0xf000) === 0xa000) throw new Error('Символические ссылки не поддерживаются');
      if (name.endsWith('/')) { safePath(name.slice(0, -1)); continue; }
      safePath(name);
      if (Object.hasOwn(files, name)) throw new Error('Повторяющиеся пути в архиве');
      size += expanded;
      if (size > MAX) throw new Error('Распакованный архив превышает 40 МБ');
      if (bytes.readUInt32LE(offset) !== 0x04034b50) throw new Error('Поврежден ZIP');
      const start = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28);
      if (start + compressedSize > bytes.length) throw new Error('Поврежден ZIP');
      const packed = bytes.subarray(start, start + compressedSize);
      const raw = method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: MAX });
      if (raw.length !== expanded || crc32(raw) !== expected) throw new Error('Ошибка целостности ZIP');
      files[name] = raw.toString('base64');
    }
    // Common downloads wrap the site in one root directory.
    const paths = Object.keys(files), prefix = paths[0]?.split('/')[0] + '/';
    if (paths.length && paths.every(p => p.startsWith(prefix))) return Object.fromEntries(paths.map(p => [p.slice(prefix.length), files[p]]));
    return files;
  } catch (error) {
    if (error instanceof RangeError) throw new Error('Поврежден ZIP');
    throw error;
  }
}
