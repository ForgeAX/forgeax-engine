import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

export function nativeFiles(platform) {
  return platform === 'win32'
    ? ['dawn.node', 'dxcompiler.dll', 'dxil.dll', 'd3dcompiler_47.dll']
    : ['dawn.node'];
}

export function nativeOutputReady(directory, inputKey, platform) {
  const provenance = join(directory, 'provenance.json');
  if (!existsSync(provenance)) return false;
  try {
    const record = JSON.parse(readFileSync(provenance, 'utf8'));
    return record.inputKey === inputKey && nativeFiles(platform).every((name) => {
      const path = join(directory, name);
      return existsSync(path) && record.files?.[name] === sha(path);
    });
  } catch {
    // An interrupted publication is rebuilt, never admitted as a native cache.
    return false;
  }
}

export function verifyWindowsX64(path) {
  const bytes = readFileSync(path);
  if (bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) throw new Error(`dawn-native-invalid-pe:${path}`);
  const offset = bytes.readUInt32LE(0x3c);
  if (offset > bytes.length - 6 || bytes.readUInt32LE(offset) !== 0x4550 || bytes.readUInt16LE(offset + 4) !== 0x8664) {
    throw new Error(`dawn-native-built-architecture-mismatch:${path}`);
  }
}
