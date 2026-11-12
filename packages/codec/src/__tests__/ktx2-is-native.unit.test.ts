import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ktx2IsNative, parseKtx2 } from '@forgeax/engine-codec';
import { basisEncode } from '@forgeax/engine-codec/encode';
import { describe, expect, it } from 'vitest';

const ENCODER_GLUE = new URL('../../pkg/encode/basis_encoder.mjs', import.meta.url);
const built = existsSync(fileURLToPath(ENCODER_GLUE));

describe('ktx2IsNative', () => {
  // UASTC HDR 4x4 KTX2 files carry vkFormat ASTC_4x4_SFLOAT, not 0, yet are Basis.
  it.skipIf(!built)(
    'classifies every Basis profile, including UASTC HDR, as non-native',
    async () => {
      const ldr = new Uint8Array(64);
      const hdr = new Uint8Array(128);
      for (const [mode, pixels] of [
        ['etc1s', ldr],
        ['uastc-ldr', ldr],
        ['uastc-hdr', hdr],
      ] as const) {
        const encoded = await basisEncode(pixels, {
          mode,
          width: 4,
          height: 4,
          srgb: false,
          perceptual: false,
          uastcSupercompression: mode === 'uastc-ldr',
          mipGen: false,
          channels: 'rgba',
        });
        if (!encoded.ok) throw new Error(encoded.error.code);
        const parsed = await parseKtx2(encoded.value);
        if (!parsed.ok) throw new Error(parsed.error.code);
        expect(ktx2IsNative(parsed.value), mode).toBe(false);
      }
    },
  );
});
