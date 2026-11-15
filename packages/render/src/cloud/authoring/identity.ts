import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { cloudRecord } from './material';

const textEncoder = new TextEncoder();

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  return cloudRecord(value)
    ? Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, ordered(value[key])]),
      )
    : value;
}

export function cloudIdentity(value: unknown): string {
  return digestCloudBytes(textEncoder.encode(JSON.stringify(ordered(value))));
}

export function digestCloudBytes(bytes: Uint8Array): string {
  return `sha256:${bytesToHex(sha256(bytes))}`;
}
