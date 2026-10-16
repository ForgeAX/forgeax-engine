import { describe, expect, it } from 'vitest';
import {
  compareSurfaceAppLifecycleRois,
  createSurfaceAppLifecycleCoverageMask,
  createSurfaceAppLifecycleMask,
  readSurfaceAppLifecycleRoi,
} from './surface-app-lifecycle-oracle';

function readback(fill: readonly [number, number, number, number]) {
  const width = 64;
  const height = 32;
  const bytes = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < bytes.length; offset += 4) bytes.set(fill, offset);
  return { bytes, width, height, bytesPerRow: width * 4, format: 'rgba8unorm-srgb' };
}

function hdrReadback(fillWord: number) {
  const width = 64;
  const height = 32;
  const bytes = new Uint8Array(width * height * 8);
  const view = new DataView(bytes.buffer);
  for (let offset = 0; offset < bytes.length; offset += 8) {
    view.setUint16(offset, fillWord, true);
    view.setUint16(offset + 2, fillWord, true);
    view.setUint16(offset + 4, fillWord, true);
    view.setUint16(offset + 6, 0x3c00, true);
  }
  return { bytes, width, height, bytesPerRow: width * 8, format: 'rgba16float' };
}

function writeHdrPixel(
  readback: ReturnType<typeof hdrReadback>,
  x: number,
  y: number,
  word: number,
): void {
  const view = new DataView(readback.bytes.buffer);
  const offset = y * readback.bytesPerRow + x * 8;
  view.setUint16(offset, word, true);
  view.setUint16(offset + 2, word, true);
  view.setUint16(offset + 4, word, true);
}

describe('Surface App lifecycle fixed ROI acceptance', () => {
  it.each([1, 0.5])('proves the camera coverage transition at scale %s', (scale) => {
    const coverage = createSurfaceAppLifecycleCoverageMask({
      width: 960 * scale,
      height: 540 * scale,
      cellIndex: 4,
      cellCount: 6,
      offsetX: -23 * scale,
      radius: 6 * scale,
      baselineCamera: { x: 0, y: 0, z: 6, fov: Math.PI / 4, aspect: 16 / 9 },
      movedCamera: { x: 0.9, y: 0, z: 6, fov: Math.PI / 4, aspect: 16 / 9 },
      surfaces: [
        { id: 'water-a', center: [2.175, 0, 0], size: [1.3, 1.3] },
        { id: 'water-b', center: [3.625, 0, 0], size: [1.3, 1.3] },
      ],
    });

    expect(coverage.baseline.coveredPixelCount).toBe(coverage.mask.length);
    expect(coverage.baseline.coveredSurfaceIds).toEqual(['water-a']);
    expect(coverage.moved.coveredPixelCount).toBe(0);
    expect(coverage.moved.coveredSurfaceIds).toEqual([]);
    expect(coverage.moved.projections[0]?.maxX).toBeLessThan(
      coverage.moved.projections[1]?.minX ?? Number.POSITIVE_INFINITY,
    );
    const noCameraMove = createSurfaceAppLifecycleCoverageMask({
      width: 960 * scale,
      height: 540 * scale,
      cellIndex: 4,
      cellCount: 6,
      offsetX: -23 * scale,
      radius: 6 * scale,
      baselineCamera: { x: 0, y: 0, z: 6, fov: Math.PI / 4, aspect: 16 / 9 },
      movedCamera: { x: 0, y: 0, z: 6, fov: Math.PI / 4, aspect: 16 / 9 },
      surfaces: [
        { id: 'water-a', center: [2.175, 0, 0], size: [1.3, 1.3] },
        { id: 'water-b', center: [3.625, 0, 0], size: [1.3, 1.3] },
      ],
    });
    expect(noCameraMove.moved.coveredPixelCount).toBe(noCameraMove.mask.length);
    expect(noCameraMove.moved.coveredSurfaceIds).toEqual(['water-a']);
  });

  it('freezes membership before actual pixels and rejects one damaged legal pixel', () => {
    const mask = createSurfaceAppLifecycleMask({
      width: 64,
      height: 32,
      cellIndex: 2,
      cellCount: 4,
    });
    const baselineReadback = readback([96, 112, 128, 255]);
    const baseline = readSurfaceAppLifecycleRoi(baselineReadback, mask);
    const mutatedReadback = readback([96, 112, 128, 255]);
    const damaged = mask[73];
    if (damaged === undefined) throw new Error('mutation position unavailable');
    mutatedReadback.bytes.set(
      [0, 0, 0, 255],
      damaged.y * mutatedReadback.bytesPerRow + damaged.x * 4,
    );
    const mutated = readSurfaceAppLifecycleRoi(mutatedReadback, mask);
    const report = compareSurfaceAppLifecycleRois(baseline, mutated);

    expect(mutated.mask).toBe(mask);
    expect(mutated.mask).toEqual(baseline.mask);
    expect(report).toMatchObject({
      pixelCount: 256,
      failedPixelCount: 1,
      maxError: 128 / 255,
    });
    expect(report.worstPosition).toEqual(damaged);
  });

  it('retains HDR values and enforces the exact 0.05 linear threshold', () => {
    const mask = createSurfaceAppLifecycleMask({
      width: 64,
      height: 32,
      cellIndex: 1,
      cellCount: 4,
    });
    const damaged = mask[91];
    if (damaged === undefined) throw new Error('HDR mutation position unavailable');
    const baseline = readSurfaceAppLifecycleRoi(hdrReadback(0x3e00), mask);
    const aboveReadback = hdrReadback(0x3e00);
    writeHdrPixel(aboveReadback, damaged.x, damaged.y, 0x3e36);
    const above = readSurfaceAppLifecycleRoi(aboveReadback, mask);
    const belowReadback = hdrReadback(0x3e00);
    writeHdrPixel(belowReadback, damaged.x, damaged.y, 0x3e33);
    const below = readSurfaceAppLifecycleRoi(belowReadback, mask);

    expect(baseline.pixels[0]).toEqual([1.5, 1.5, 1.5, 1]);
    expect(baseline.average).toEqual([1.5, 1.5, 1.5, 1]);
    expect(above.mask).toBe(mask);
    expect(compareSurfaceAppLifecycleRois(baseline, above)).toMatchObject({
      pixelCount: 256,
      failedPixelCount: 1,
      maxError: 0.052734375,
      worstPosition: damaged,
    });
    expect(compareSurfaceAppLifecycleRois(baseline, below)).toMatchObject({
      pixelCount: 256,
      failedPixelCount: 0,
      maxError: 0.0498046875,
      worstPosition: damaged,
    });
  });

  it('accepts an unchanged fixed ROI and rejects empty or mismatched masks', () => {
    const mask = createSurfaceAppLifecycleMask({
      width: 64,
      height: 32,
      cellIndex: 3,
      cellCount: 4,
    });
    const first = readSurfaceAppLifecycleRoi(readback([4, 8, 12, 255]), mask);
    const second = readSurfaceAppLifecycleRoi(readback([4, 8, 12, 255]), mask);
    expect(compareSurfaceAppLifecycleRois(first, second)).toMatchObject({
      pixelCount: 256,
      failedPixelCount: 0,
      maxError: 0,
    });
    expect(() => readSurfaceAppLifecycleRoi(readback([0, 0, 0, 255]), [])).toThrow(
      'fixed ROI mask is empty',
    );
    const otherMask = createSurfaceAppLifecycleMask({
      width: 64,
      height: 32,
      cellIndex: 2,
      cellCount: 4,
    });
    const other = readSurfaceAppLifecycleRoi(readback([4, 8, 12, 255]), otherMask);
    expect(() => compareSurfaceAppLifecycleRois(first, other)).toThrow('ROI mask identity changed');
    const hdr = readSurfaceAppLifecycleRoi(hdrReadback(0x3c00), mask);
    expect(() => compareSurfaceAppLifecycleRois(first, hdr)).toThrow('ROI color domain changed');
  });
});
