import type { AnimationTargetIdValue } from '@forgeax/engine-types';
import { blake3 } from '@noble/hashes/blake3.js';

const NAMESPACE = Uint8Array.of(
  0x31,
  0x79,
  0xf5,
  0x19,
  0xd9,
  0x27,
  0x4f,
  0xf2,
  0xb5,
  0x96,
  0x6f,
  0xd0,
  0x77,
  0x02,
  0x39,
  0x11,
);
const TARGET_ID_PATTERN = /^[0-9a-f]{32}$/;
const textEncoder = new TextEncoder();

export function deriveAnimationTargetId(path: readonly string[]): AnimationTargetIdValue {
  const segments = path.map((segment) => textEncoder.encode(segment));
  const input = new Uint8Array(
    NAMESPACE.length + segments.reduce((length, segment) => length + 4 + segment.length, 0),
  );
  input.set(NAMESPACE);

  const view = new DataView(input.buffer);
  let offset = NAMESPACE.length;
  for (const segment of segments) {
    view.setUint32(offset, segment.length, true);
    offset += 4;
    input.set(segment, offset);
    offset += segment.length;
  }

  const bytes = blake3(input).slice(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  ) as AnimationTargetIdValue;
}

export function isAnimationTargetId(value: unknown): value is AnimationTargetIdValue {
  return typeof value === 'string' && TARGET_ID_PATTERN.test(value);
}
