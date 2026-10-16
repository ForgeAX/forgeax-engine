import { deflateRawSync } from 'node:zlib';

export interface ZipEntry {
  readonly path: string;
  readonly bytes: Uint8Array;
}

const ZIP32_LIMIT = 0xffff_ffff;
const ZIP_ENTRY_LIMIT = 0xffff;
const UTF8_FLAG = 0x0800;
const DEFLATE_METHOD = 8;
const DOS_EPOCH_DATE = 0x0021;

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb8_8320 & -(value & 1));
  CRC_TABLE[index] = value >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffff_ffff;
  for (const byte of bytes) value = (value >>> 8) ^ (CRC_TABLE[(value ^ byte) & 0xff] ?? 0);
  return (value ^ 0xffff_ffff) >>> 0;
}

function assertArchivePath(path: string): void {
  if (
    path.length === 0 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new TypeError(`invalid ZIP entry path: ${path}`);
  }
}

export function createZip(entriesInput: readonly ZipEntry[]): Buffer {
  if (entriesInput.length > ZIP_ENTRY_LIMIT) throw new RangeError('ZIP32 entry limit exceeded');
  const entries = [...entriesInput].sort((left, right) => left.path.localeCompare(right.path));
  const seen = new Set<string>();
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    assertArchivePath(entry.path);
    if (seen.has(entry.path)) throw new TypeError(`duplicate ZIP entry path: ${entry.path}`);
    seen.add(entry.path);
    const name = Buffer.from(entry.path, 'utf8');
    const source = Buffer.from(entry.bytes);
    const compressed = deflateRawSync(source, { level: 9 });
    if (source.byteLength > ZIP32_LIMIT || compressed.byteLength > ZIP32_LIMIT) {
      throw new RangeError(`ZIP32 file limit exceeded: ${entry.path}`);
    }
    const checksum = crc32(source);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x0403_4b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(DEFLATE_METHOD, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_EPOCH_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.byteLength, 18);
    local.writeUInt32LE(source.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x0201_4b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(DEFLATE_METHOD, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_EPOCH_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.byteLength, 20);
    central.writeUInt32LE(source.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.byteLength + name.byteLength + compressed.byteLength;
    if (offset > ZIP32_LIMIT) throw new RangeError('ZIP32 archive limit exceeded');
  }

  const centralDirectory = Buffer.concat(centralParts);
  if (centralDirectory.byteLength > ZIP32_LIMIT)
    throw new RangeError('ZIP32 directory limit exceeded');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x0605_4b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}
