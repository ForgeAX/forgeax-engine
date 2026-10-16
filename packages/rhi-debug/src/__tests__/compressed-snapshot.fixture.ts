import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { wrap } from '../recorder';

/** Isolate compressed array/mip readback from shaders, scenes and tape transport. */
export async function verifyCompressedSnapshot() {
  const recorder = wrap(webgpu.rhi);
  const adapter = (await recorder.requestAdapter()).unwrap();
  if (!adapter.features.has('texture-compression-bc')) {
    return { status: 'unavailable' as const, reason: 'texture-compression-bc' };
  }
  const device = (
    await adapter.requestDevice({ requiredFeatures: ['texture-compression-bc'] })
  ).unwrap();
  const expected: Uint8Array[] = [];
  const formats = ['bc1-rgba-unorm', 'bc5-rg-unorm', 'bc7-rgba-unorm-srgb'] as const;
  const textures = formats.map((format, index) => {
    const texture = device
      .createTexture({
        label: `compressed-snapshot-${format}`,
        size: [16, 16, 2],
        mipLevelCount: 5,
        format,
        usage: 0x06,
      })
      .unwrap();
    const slices: Uint8Array[] = [];
    for (let layer = 0; layer < 2; layer++)
      for (let mip = 0; mip < 5; mip++) {
        const extent = Math.max(4, 16 >> mip);
        const bytesPerBlock = index === 0 ? 8 : 16;
        const rowBytes = (extent / 4) * bytesPerBlock;
        const bytes = Uint8Array.from(
          { length: (rowBytes * extent) / 4 },
          (_, i) => (i * 13 + mip * 31 + layer * 59 + index * 17) & 255,
        );
        slices.push(bytes);
        device.queue
          .writeTexture(
            { texture, mipLevel: mip, origin: [0, 0, layer] },
            bytes,
            { bytesPerRow: rowBytes, rowsPerImage: extent / 4 },
            { width: extent, height: extent, depthOrArrayLayers: 1 },
          )
          .unwrap();
      }
    const combined = new Uint8Array(slices.reduce((n, bytes) => n + bytes.length, 0));
    let offset = 0;
    for (const bytes of slices) {
      combined.set(bytes, offset);
      offset += bytes.length;
    }
    expected.push(combined);
    return texture;
  });
  try {
    recorder.arm(1).unwrap();
    (await recorder.snapshotAllLiveResources(15_000)).unwrap();
    const actual = [...recorder.getBlobPool().values()].map((bytes) => new Uint8Array(bytes));
    for (const bytes of expected) {
      if (
        !actual.some((copy) => copy.length === bytes.length && copy.every((v, i) => v === bytes[i]))
      ) {
        throw new Error('compressed mip/array snapshot does not match the authored block bytes');
      }
    }
    return {
      status: 'passed' as const,
      formats,
      layers: 2,
      mips: 5,
      bytes: expected.map((value) => value.byteLength),
    };
  } finally {
    recorder.transitionToError();
    recorder.disposeError();
    for (const texture of textures) device.destroyTexture(texture).unwrap();
  }
}
