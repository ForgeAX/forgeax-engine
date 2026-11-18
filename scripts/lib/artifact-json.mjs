import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

/** Publish compact JSON atomically; a failed write preserves the existing input. */
export function writeArtifactJson(path, value) {
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, zstdCompressSync(Buffer.from(JSON.stringify(value))));
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

// Production artifacts may use a single zstd frame under their .json name.
export function readArtifactJsonText(path) {
  return decodeArtifactJsonText(readFileSync(path));
}

export function decodeArtifactJsonText(bytes) {
  const zstd = bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd;
  return (zstd ? zstdDecompressSync(bytes) : Buffer.from(bytes)).toString('utf8');
}
