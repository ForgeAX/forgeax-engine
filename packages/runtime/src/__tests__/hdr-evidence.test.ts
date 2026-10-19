import { parseImage } from '@forgeax/engine-image/parse-image';
import { expect, it } from 'vitest';
import { luminancePng } from './hdr-evidence.fixture';

it('writes zoomed HDR evidence with Reinhard exposure and sRGB display bytes', () => {
  const decoded = parseImage(luminancePng(new Float32Array([0, 0.25, 1, 0]), 2), 'image/png');
  expect(decoded.ok).toBe(true);
  if (!decoded.ok) return;
  expect(decoded.value.width).toBe(8);
  expect(decoded.value.height).toBe(8);
  for (const [x, y, byte] of [
    [0, 0, 0],
    [7, 0, 188],
    [0, 7, 231],
    [7, 7, 0],
  ] as const) {
    const offset = (y * 8 + x) * 4;
    expect([...decoded.value.bytes.slice(offset, offset + 4)]).toEqual([byte, byte, byte, 255]);
  }
});
