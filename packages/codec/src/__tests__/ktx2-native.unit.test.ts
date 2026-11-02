import {
  decodeBc5ToRg8,
  inspectKtx2Native,
  type Ktx2Parsed,
  ktx2NativeTexture,
  parseKtx2,
} from '@forgeax/engine-codec';
import { encodeKtx2Native, type Ktx2NativeEncodeOptions } from '@forgeax/engine-codec/encode';
import { describe, expect, it } from 'vitest';

// R: endpoints 200 > 100 (eight-value palette), texel 0 uses index 2.
// G: endpoints 10 <= 20 (six-value palette), texel 0 index 6 (0), texel 1 index 7 (255).
const BC5_BLOCK = new Uint8Array([200, 100, 0x02, 0, 0, 0, 0, 0, 10, 20, 0x3e, 0, 0, 0, 0, 0]);

async function ktx2(options: Ktx2NativeEncodeOptions): Promise<Uint8Array> {
  const encoded = await encodeKtx2Native(options);
  if (!encoded.ok) throw new Error(encoded.error.code);
  return encoded.value;
}

function parse(bytes: Uint8Array): Ktx2Parsed {
  const parsed = parseKtx2(bytes);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function patchU32(bytes: Uint8Array, offset: number, value: number): Uint8Array {
  const copy = bytes.slice();
  new DataView(copy.buffer).setUint32(offset, value, true);
  return copy;
}

function withTransfer(bytes: Uint8Array, transfer: number): Uint8Array {
  const copy = bytes.slice();
  const dfd = new DataView(copy.buffer).getUint32(48, true);
  copy[dfd + 14] = transfer;
  return copy;
}

const rg8Levels = [
  Uint8Array.from({ length: 4 * 2 * 2 }, (_, i) => i * 7),
  Uint8Array.from({ length: 2 * 1 * 2 }, (_, i) => 200 + i),
  Uint8Array.from([9, 8]),
];

describe('non-Basis RG8 / BC5 KTX2', () => {
  it('admits a linear RG8 chain and unwraps every level base first', async () => {
    for (const supercompression of ['none', 'zstd'] as const) {
      const parsed = parse(
        await ktx2({
          format: 'rg8unorm',
          width: 4,
          height: 2,
          levels: rg8Levels,
          supercompression,
        }),
      );
      expect(inspectKtx2Native(parsed)).toEqual({
        ok: true,
        value: { format: 'rg8unorm', width: 4, height: 2, levelCount: 3 },
      });
      const texture = await ktx2NativeTexture(parsed);
      if (!texture.ok) throw new Error(texture.error.code);
      expect(texture.value.format).toBe('rg8unorm');
      expect(texture.value.mips.map((mip) => [mip.width, mip.height])).toEqual([
        [4, 2],
        [2, 1],
        [1, 1],
      ]);
      expect(texture.value.mips.map((mip) => [...mip.data])).toEqual(
        rg8Levels.map((level) => [...level]),
      );
    }
  });

  it('keeps BC5 blocks, or decodes them to RG8 and RGBA8 for devices without BC', async () => {
    const parsed = parse(
      await ktx2({ format: 'bc5-rg-unorm', width: 4, height: 4, levels: [BC5_BLOCK] }),
    );
    const blocks = await ktx2NativeTexture(parsed);
    if (!blocks.ok) throw new Error(blocks.error.code);
    expect(blocks.value.format).toBe('bc5-rg-unorm');
    expect([...(blocks.value.mips[0]?.data ?? [])]).toEqual([...BC5_BLOCK]);

    const rg = await ktx2NativeTexture(parsed, 'rg8unorm');
    if (!rg.ok) throw new Error(rg.error.code);
    const texels = rg.value.mips[0]?.data ?? new Uint8Array();
    expect([...texels.subarray(0, 6)]).toEqual([186, 0, 200, 255, 200, 10]);
    expect(texels).toEqual(decodeBc5ToRg8(BC5_BLOCK, 4, 4));

    const rgba = await ktx2NativeTexture(parsed, 'rgba8unorm');
    if (!rgba.ok) throw new Error(rgba.error.code);
    expect([...(rgba.value.mips[0]?.data.subarray(0, 8) ?? [])]).toEqual([
      186, 0, 0, 255, 200, 255, 0, 255,
    ]);
    expect(await ktx2NativeTexture(parsed, 'bc7-rgba-unorm')).toMatchObject({
      ok: false,
      error: { code: 'transcode-failed' },
    });
  });

  it('decodes partial edge blocks without writing outside the image', () => {
    expect([...decodeBc5ToRg8(BC5_BLOCK, 1, 1)]).toEqual([186, 0]);
  });

  it.each([
    ['srgb-transfer', async () => withTransfer(await rg8(), 2)],
    ['transfer-function', async () => withTransfer(await rg8(), 0)],
    ['format', async () => patchU32(await rg8(), 12, 37)],
    ['shape', async () => patchU32(await rg8(), 32, 2)],
    ['scheme', async () => patchU32(await rg8(), 44, 1)],
    ['level-length', async () => patchU32(await rg8(), 80 + 8, 3)],
  ] as const)('rejects %s with ktx2-native-unsupported', async (reason, build) => {
    const parsed = parse(await build());
    const failure = { ok: false, error: { code: 'ktx2-native-unsupported', detail: { reason } } };
    expect(inspectKtx2Native(parsed)).toMatchObject(failure);
    expect(await ktx2NativeTexture(parsed)).toMatchObject(failure);
  });

  it('refuses to write an incomplete level chain', async () => {
    expect(
      await encodeKtx2Native({
        format: 'rg8unorm',
        width: 4,
        height: 2,
        levels: [rg8Levels[1] ?? new Uint8Array()],
      }),
    ).toMatchObject({ ok: false, error: { code: 'ktx2-encode-failed' } });
  });
});

function rg8(): Promise<Uint8Array> {
  return ktx2({ format: 'rg8unorm', width: 4, height: 2, levels: rg8Levels });
}
