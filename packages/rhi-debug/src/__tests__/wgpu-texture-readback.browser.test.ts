import { ensureReady, requestAdapter } from '@forgeax/engine-rhi-wgpu';
import { expect, it } from 'vitest';
import { readbackTexturePixelsBatch } from '../readback';
import { computeTextureLayout } from '../texel-layout';

for (const format of ['rgba8unorm', 'rgba16float'] as const) {
  it.each([
    '2d',
    'cube',
  ] as const)(`reads every %s ${format} face/mip through the real RHI snapshot path`, async (dimension) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 4;
    document.body.append(canvas);
    await ensureReady();
    const device = (
      await (await requestAdapter(undefined, canvas)).unwrap().requestDevice()
    ).unwrap();
    const layers = dimension === 'cube' ? 6 : 1;
    const layout = computeTextureLayout(format, 4, 4, layers, 3);
    if (layout === undefined) throw new Error('missing texture layout');
    const texture = device
      .createTexture({
        size: { width: 4, height: 4, depthOrArrayLayers: layers },
        format,
        mipLevelCount: 3,
        textureBindingViewDimension: dimension,
        usage: 0x01 | 0x02 | 0x04,
      })
      .unwrap();
    const expected = new Uint8Array(layout.totalBytes);
    const values = new DataView(expected.buffer);
    try {
      for (const slice of layout.slices) {
        for (let pixel = 0; pixel < slice.width * slice.height; pixel++) {
          const offset = slice.byteOffset + pixel * layout.bytesPerBlock;
          for (let channel = 0; channel < 4; channel++) {
            if (format === 'rgba16float') {
              values.setUint16(
                offset + channel * 2,
                0x3000 + slice.layer * 0x100 + slice.mip * 0x20 + pixel + channel,
                true,
              );
            } else {
              expected[offset + channel] = 1 + slice.layer * 32 + slice.mip * 8 + pixel + channel;
            }
          }
        }
        device.queue
          .writeTexture(
            { texture, mipLevel: slice.mip, origin: { x: 0, y: 0, z: slice.layer } },
            expected.subarray(slice.byteOffset, slice.byteOffset + slice.byteLength),
            { bytesPerRow: slice.width * layout.bytesPerBlock, rowsPerImage: slice.height },
            { width: slice.width, height: slice.height, depthOrArrayLayers: 1 },
          )
          .unwrap();
      }
      const result = await readbackTexturePixelsBatch(device, [
        { handleId: 'source', texture, ...layout },
      ]);
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      const buffer = result.value.get('source');
      expect(buffer).toBeDefined();
      const actual = new Uint8Array(buffer as ArrayBuffer);
      expect(actual.byteLength).toBe(expected.byteLength);
      for (const slice of layout.slices) {
        const end = slice.byteOffset + slice.byteLength;
        expect(
          [...actual.subarray(slice.byteOffset, end)],
          `${dimension} ${format} face ${slice.layer} mip ${slice.mip}`,
        ).toEqual([...expected.subarray(slice.byteOffset, end)]);
      }
    } finally {
      device.destroyTexture(texture).unwrap();
      canvas.remove();
    }
  });
}
