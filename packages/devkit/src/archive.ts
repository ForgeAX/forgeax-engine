import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { sha256 as contentSha256 } from '@forgeax/engine-types';
import type { CommandResult } from './types.js';
import { failCommand } from './types.js';

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
    local.writeUInt16LE(DOS_EPOCH_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.byteLength, 18);
    local.writeUInt32LE(source.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x0201_4b50, 0);
    central.writeUInt16LE(20, 4);
    // The central directory stores the same entry fields after its creator version.
    local.copy(central, 6, 4, 28);
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

export async function publishChecksummedFile(file: string, bytes: Uint8Array) {
  const sha256 = contentSha256(bytes);
  const checksumPath = `${file}.sha256`;
  const suffix = `.partial-${process.pid}`;
  const temporary = file + suffix;
  const checksum = checksumPath + suffix;
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(temporary, bytes);
    await writeFile(checksum, `${sha256}  ${basename(file)}\n`, 'utf8');
    await rename(checksum, checksumPath);
    await rename(temporary, file);
    return { path: file, bytes: bytes.byteLength, sha256, checksumPath };
  } finally {
    await Promise.all([rm(temporary, { force: true }), rm(checksum, { force: true })]);
  }
}

export const GAME_PACKAGE_DOCUMENT_PATHS = Object.freeze([
  'README.md',
  'docs/feedback.md',
] as const);

export async function readGamePackageDocuments(
  root: string,
): Promise<CommandResult<readonly ZipEntry[]>> {
  const entries: ZipEntry[] = [];
  for (const path of GAME_PACKAGE_DOCUMENT_PATHS) {
    try {
      entries.push({ path, bytes: await readFile(resolve(root, path)) });
    } catch (cause) {
      return failCommand(
        'game-package-document-missing',
        'the game to contain README.md and docs/feedback.md',
        'Restore README.md and docs/feedback.md before creating a Web ZIP.',
        {
          root,
          path,
          reason: cause instanceof Error ? cause.message : String(cause),
        },
      );
    }
  }
  return { ok: true, value: entries };
}
