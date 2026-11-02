import { describe, expect, it } from 'vitest';
import {
  comparePackedAo,
  decodePackedAoRegion,
  encodePackedAoWord,
  packedClusterWordByteOffset,
} from './forward-gtao-packed-ao';

describe('packed Cluster AO word readback addressing', () => {
  it('addresses u32 words through all four rgba32uint lanes', () => {
    expect(
      [0, 1, 2, 3].map((wordIndex) =>
        packedClusterWordByteOffset({
          wordIndex,
          physicalWidth: 2,
          physicalHeight: 2,
          bytesPerRow: 256,
          byteLength: 512,
        }),
      ),
    ).toEqual([0, 4, 8, 12]);
  });

  it('uses physical rows and padded readback row pitch', () => {
    expect(
      [3, 4, 7, 8].map((wordIndex) =>
        packedClusterWordByteOffset({
          wordIndex,
          physicalWidth: 2,
          physicalHeight: 2,
          bytesPerRow: 512,
          byteLength: 1024,
        }),
      ),
    ).toEqual([12, 16, 28, 512]);
    expect(
      packedClusterWordByteOffset({
        wordIndex: 8,
        physicalWidth: 2,
        physicalHeight: 2,
        bytesPerRow: 512,
        byteLength: 1024,
      }),
    ).toBe(512);
    expect(
      packedClusterWordByteOffset({
        wordIndex: 12,
        physicalWidth: 3,
        physicalHeight: 2,
        bytesPerRow: 512,
        byteLength: 1024,
      }),
    ).toBe(512);
    expect(
      packedClusterWordByteOffset({
        wordIndex: 19,
        physicalWidth: 5,
        physicalHeight: 2,
        bytesPerRow: 512,
        byteLength: 1024,
      }),
    ).toBe(76);
  });

  it('decodes and compares an odd-width AO region from both captured uniforms', () => {
    const clusterUniformBytes = new Uint8Array(96);
    const clusterUniform = new DataView(clusterUniformBytes.buffer);
    [32, 3, 2, 4].forEach((value, index) => {
      clusterUniform.setUint32(32 + index * 4, value, true);
    });
    const ssaoUniformBytes = new Uint8Array(256);
    const ssaoUniform = new DataView(ssaoUniformBytes.buffer);
    [3, 1, 5, 1].forEach((value, index) => {
      ssaoUniform.setUint32(224 + index * 4, value, true);
    });
    const region = decodePackedAoRegion({
      clusterUniformBytes,
      clusterAoByteOffset: 32,
      ssaoUniformBytes,
      ssaoClusterPackByteOffset: 224,
    });
    expect(region).toEqual({
      baseWord: 32,
      width: 3,
      height: 2,
      rowWords: 4,
      originX: 3,
      originY: 1,
      textureWidth: 5,
      packedWidth: 1,
    });

    const blurredBytes = new Uint8Array([0, 1, 127, 128, 254, 255]);
    const bytesPerRow = 512;
    const clusterBytes = new Uint8Array(bytesPerRow * 3);
    const physical = {
      bytes: clusterBytes,
      byteLength: clusterBytes.byteLength,
      bytesPerRow,
      format: 'rgba32uint',
      width: 5,
      height: 3,
      usage: 1,
      graphGeneration: 7,
      deviceGeneration: 2,
      textureIdentity: 99,
      targetRecordFrameNumber: 41,
      publicReceiptFrameId: 42,
      receiptPresentation: 'ready' as const,
      receiptCompleted: true as const,
    };
    expect(
      packedClusterWordByteOffset({
        wordIndex: region.baseWord,
        physicalWidth: physical.width,
        physicalHeight: physical.height,
        bytesPerRow,
        byteLength: physical.byteLength,
      }),
    ).toBe(560);
    const lastRegionWord =
      region.baseWord + (region.height - 1) * region.rowWords + region.width - 1;
    expect(
      packedClusterWordByteOffset({
        wordIndex: lastRegionWord,
        physicalWidth: physical.width,
        physicalHeight: physical.height,
        bytesPerRow,
        byteLength: physical.byteLength,
      }),
    ).toBe(584);
    const clusterView = new DataView(clusterBytes.buffer);
    for (let y = 0; y < region.height; y += 1) {
      for (let x = 0; x < region.width; x += 1) {
        const wordIndex = region.baseWord + y * region.rowWords + x;
        const byteOffset = packedClusterWordByteOffset({
          wordIndex,
          physicalWidth: physical.width,
          physicalHeight: physical.height,
          bytesPerRow,
          byteLength: physical.byteLength,
        });
        clusterView.setUint32(byteOffset, encodePackedAoWord(blurredBytes[y * 3 + x] ?? 0), true);
      }
    }
    const compared = comparePackedAo(
      physical,
      { bytes: blurredBytes, width: 3, height: 2 },
      region,
    );
    expect(compared).toMatchObject({
      mismatches: 0,
      total: 6,
      baseWord: 32,
      rowWords: 4,
      physicalRowWords: 20,
      readback: {
        byteLength: 1536,
        actualByteLength: 1536,
        bytesPerRow,
        graphGeneration: 7,
        deviceGeneration: 2,
        textureIdentity: 99,
        targetRecordFrameNumber: 41,
        publicReceiptFrameId: 42,
        receiptPresentation: 'ready',
        receiptCompleted: true,
      },
      aoRegion: region,
    });
  });

  it('reports AO-region and physical-buffer bounds without clamping', () => {
    const clusterUniformBytes = new Uint8Array(96);
    const clusterUniform = new DataView(clusterUniformBytes.buffer);
    [32, 3, 2, 4].forEach((value, index) => {
      clusterUniform.setUint32(32 + index * 4, value, true);
    });
    const ssaoUniformBytes = new Uint8Array(256);
    const ssaoUniform = new DataView(ssaoUniformBytes.buffer);
    [3, 2, 5, 1].forEach((value, index) => {
      ssaoUniform.setUint32(224 + index * 4, value, true);
    });
    const region = decodePackedAoRegion({
      clusterUniformBytes,
      clusterAoByteOffset: 32,
      ssaoUniformBytes,
      ssaoClusterPackByteOffset: 224,
    });
    expect(() =>
      comparePackedAo(
        {
          bytes: new Uint8Array(512 * 3),
          byteLength: 512 * 3,
          bytesPerRow: 512,
          format: 'rgba32uint',
          width: 5,
          height: 3,
          usage: 1,
          graphGeneration: 7,
          deviceGeneration: 2,
          textureIdentity: 99,
          targetRecordFrameNumber: 41,
          publicReceiptFrameId: 42,
          receiptPresentation: 'ready',
          receiptCompleted: true,
        },
        { bytes: new Uint8Array(6), width: 3, height: 2 },
        region,
      ),
    ).toThrow(/inconsistent packed AO region/);
    expect(() =>
      packedClusterWordByteOffset({
        wordIndex: 60,
        physicalWidth: 5,
        physicalHeight: 3,
        bytesPerRow: 512,
        byteLength: 1536,
      }),
    ).toThrow(/outside the captured texture/);
  });
});
