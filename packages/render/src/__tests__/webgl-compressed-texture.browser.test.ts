import { expect, it } from 'vitest';
import { verifyWebGlCompressedTextures } from './webgl-compressed-texture.fixture';

it('consumes actual advertised compressed families and RGBA device fallback for both Basis containers', async () => {
  const result = await verifyWebGlCompressedTextures();
  expect(result.rows.length).toBe((result.advertised.length + 1) * 2);
  expect(result.rows.every((row) => row.mips === 5 && row.maxError <= 8)).toBe(true);
}, 120_000);

it('samples retained mip levels on each advertised compressed family and RGBA fallback', async () => {
  const result = await verifyWebGlCompressedTextures(2);
  expect(result.rows.length).toBe((result.advertised.length + 1) * 2);
  for (const row of result.rows) {
    expect(row.mips).toBe(row.feature === 'uncompressed-request' ? 3 : 4);
    expect(row.maxError).toBeLessThanOrEqual(8);
  }
}, 120_000);
