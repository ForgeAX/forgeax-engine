import { expect, it } from 'vitest';
import { verifyWebGlCompressedTextures } from './webgl-compressed-texture.fixture';

it('consumes actual advertised compressed families and RGBA device fallback for both Basis containers', async () => {
  const result = await verifyWebGlCompressedTextures();
  expect(result.rows.length).toBe((result.advertised.length + 1) * 2);
  expect(result.rows.every((row) => row.mips === 5 && row.maxError <= 8)).toBe(true);
}, 120_000);
