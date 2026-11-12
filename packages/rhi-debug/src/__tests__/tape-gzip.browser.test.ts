import { decodeTape, encodeTape } from '@forgeax/engine-rhi-debug';
import { expect, it } from 'vitest';
import { equalBytes } from '../../../../scripts/test/byte-equality.mjs';
import { gzip, ungzip } from '../protocol/gzip';

it('keeps the browser gzip container and portable codec interoperable for complete subviews', () => {
  const backing = Uint8Array.from({ length: 65_551 }, (_, index) => (index * 73) & 255);
  const bytes = backing.subarray(7, -3);
  expect(equalBytes(ungzip(gzip(bytes)), bytes)).toBe(true);
  const encoded = encodeTape({
    header: { formatVersion: 7, rhiCaps: {}, eventCount: 0, blobCount: 1 },
    bootstrap: [],
    events: [],
    blobs: [{ hash: 'complete-browser-payload', bytes, compression: 'gzip' }],
  }).unwrap();
  const decoded = decodeTape(encoded).unwrap();
  expect(equalBytes(decoded.blobs[0]?.bytes, bytes)).toBe(true);
  expect(equalBytes(encodeTape(decoded).unwrap(), encoded)).toBe(true);
});
