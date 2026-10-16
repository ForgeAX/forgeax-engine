import { decompressZstd } from '@forgeax/engine/codec';
import { compressZstd } from '@forgeax/engine/codec/encode';
import { defineFeature } from '../../lab/feature';

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

export default defineFeature({
  title: 'Build-time Zstd encode',
  catalog: 'Build-time Zstd encode',
  kind: 'headless',
  summary:
    'compressZstd from the @forgeax/engine/codec/encode subpath emits deterministic Zstandard frames that the runtime decompressZstd reads back.',
  expect:
    'A repetitive 2 KiB input shrinks to a zstd frame with the standard magic, two encodes are byte-identical, the round trip is lossless, and the runtime codec entry does not export an encoder.',
  async run(checks) {
    const input = new TextEncoder().encode('forgeax feature lab zstd '.repeat(82));
    const first = await compressZstd(input);
    const second = await compressZstd(input);
    checks.ok('encode ok', first.ok && second.ok);
    if (!first.ok || !second.ok) return;
    checks.equal('zstd frame magic', Array.from(first.value.subarray(0, 4)), ZSTD_MAGIC);
    checks.ok(
      'output is smaller',
      first.value.byteLength < input.byteLength / 4,
      `${input.byteLength} -> ${first.value.byteLength}`,
    );
    checks.ok('deterministic bytes', Buffer.from(first.value).equals(Buffer.from(second.value)));
    const decoded = await decompressZstd(first.value);
    checks.ok(
      'round trip is lossless',
      decoded.ok && Buffer.from(decoded.value).equals(Buffer.from(input)),
    );
    const runtime = (await import('@forgeax/engine/codec')) as Record<string, unknown>;
    checks.ok(
      'runtime codec entry has no encoder',
      !('compressZstd' in runtime) && !('basisEncode' in runtime),
    );
  },
});
