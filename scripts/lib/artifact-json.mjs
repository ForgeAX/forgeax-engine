import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

// Production artifacts may use a single zstd frame under their .json name.
export function readArtifactJsonText(path) {
  return decodeArtifactJsonText(readFileSync(path));
}

export function decodeArtifactJsonText(bytes) {
  const zstd = bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd;
  return (zstd ? zstdDecompressSync(bytes) : Buffer.from(bytes)).toString('utf8');
}
