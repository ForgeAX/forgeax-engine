import { describe, expect, it } from 'vitest';
import {
  auditTileSeams,
  mirrorSegmentDistance,
  projectMirrorSegment,
  sampleLinearColor,
} from '../../apps/hello/ssr/scripts/audit-tile-reflection.mjs';

// Camera at the origin, facing -Z. Only full-resolution pixel (8,12)
// represents a smooth floor receiver. The fixture's finite wall geometry
// remains owned by auditTileSeams; these inputs model its camera G-buffer.
function fixture(receiverDistance: number) {
  const width = 16,
    height = 16,
    receiver = 12 * width + 8;
  const f = (receiverDistance * 0.5625) / 1.025;
  const a = -10 / 9,
    b = -10 / 9;
  const projection = [f, 0, 0, 0, 0, f, 0, 0, 0, 0, a, -1, 0, 0, b, 0];
  const inverse = [1 / f, 0, 0, 0, 0, 1 / f, 0, 0, 0, 0, 0, 1 / b, 0, 0, -1, a / b];
  const camera = { values: Array(240).fill(0) };
  camera.values.splice(0, 16, ...projection);
  camera.values.splice(44, 16, ...inverse);
  const depth = { width, height, values: Array(width * height).fill(1) };
  const normal = { width, height, values: Array(width * height * 4).fill(0) };
  const base = { width, height, values: Array(width * height * 4).fill(0) };
  const traced = { width: width / 2, height: height / 2, values: Array(width * height).fill(0) };
  depth.values[receiver] = -a + b / receiverDistance;
  normal.values.splice(receiver * 4, 4, 0.5, 1, 0.5, 0.08);
  // At distance 3.5 the reflection hits the front of the bottom tile.
  // At 3.97 it passes below that tile and hits the recessed wall backing,
  // projecting into the same floor pixel that occludes it from the camera.
  const wallDistance = receiverDistance < 3.9 ? 3.89 : 3.99;
  const sourceX = 8;
  const targetY = -1.025 + ((wallDistance - receiverDistance) * 1.025) / receiverDistance;
  const sourceY = Math.floor((0.5 - (targetY / wallDistance) * f * 0.5) * height);
  const source = sourceY * width + sourceX;
  if (source !== receiver) {
    depth.values[source] = -a + b / wallDistance;
    normal.values.splice(source * 4, 4, 0.5, 0.5, 1, 0.35);
    base.values.splice(source * 4, 4, 0.2, 0.5, 0.8, 1);
  }
  return { inputs: { traced, base, depth, normal, camera }, source, receiver };
}

describe('SSR finite-wall visibility oracle', () => {
  it('projects a planar reflected edge as a straight segment in receiver pixels', () => {
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const segment = projectMirrorSegment(
      [
        [-0.5, 0.5, 0],
        [0.5, 0.5, 0],
      ],
      0,
      identity,
      100,
      80,
    );
    expect(segment).toEqual([
      [25, 60],
      [75, 60],
    ]);
    expect(mirrorSegmentDistance([50, 60], segment)).toBe(0);
    expect(mirrorSegmentDistance([50, 63], segment)).toBe(3);
    expect(mirrorSegmentDistance([50, 56], segment)).toBe(4);
    expect(mirrorSegmentDistance([76, 60], segment)).toBe(Infinity);
    expect(
      mirrorSegmentDistance(
        [50, 60],
        [
          [25, 35],
          [75, 85],
        ],
      ),
    ).toBeCloseTo(0);
    expect(
      projectMirrorSegment(
        [
          [-0.5, 0.5, 0],
          [0.5, 0.5, 0],
        ],
        0,
        identity.map((value, i) => (i === 15 ? -1 : value)),
        100,
        80,
      ),
    ).toBeNull();
  });

  it('distinguishes subpixel outline coverage from a whole-pixel false reflection', () => {
    const nearEdge = fixture(0.78).inputs;
    const bowedEdge = fixture(0.5).inputs;
    for (const inputs of [nearEdge, bowedEdge]) {
      expect(auditTileSeams(inputs).outsideSilhouette.falseHits).toBe(0);
      inputs.traced.values[(6 * 8 + 4) * 4 + 3] = 1;
      expect(auditTileSeams(inputs).outsideSilhouette.upperEdge.falseHitsWithin16Pixels).toBe(1);
    }
    const near = auditTileSeams(nearEdge).outsideSilhouette.upperEdge.maximumReceiverPixelDistance;
    const bowed =
      auditTileSeams(bowedEdge).outsideSilhouette.upperEdge.maximumReceiverPixelDistance;
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThan(0.2);
    expect(bowed).toBeGreaterThan(1.5);
  });

  it('includes rough receivers when auditing the captured SSR admission range', () => {
    const { inputs, receiver } = fixture(3.5);
    inputs.normal.values[receiver * 4 + 3] = 0.45;
    expect(auditTileSeams({ ...inputs, maxRoughness: 0.65 }).groups.contact).toMatchObject({
      eligible: 1,
      missed: 1,
    });
    expect(auditTileSeams(inputs).groups.contact.eligible).toBe(0);
  });

  it('calibrates HDR bilinear color separately from visibility', () => {
    const image = { width: 2, height: 2, values: [4, 0, 0, 1, 0, 2, 0, 1, 0, 0, 8, 1, 1, 1, 1, 1] };
    expect(sampleLinearColor(image, [0.5, 0.5])).toEqual([1.25, 0.75, 2.25]);
    expect(sampleLinearColor(image, [0, 0])).toEqual([4, 0, 0]);
    expect(sampleLinearColor(image, [1, 1])).toEqual([1, 1, 1]);
    expect(sampleLinearColor(image, [0.25, 0.75])).toEqual([0, 0, 8]);
    expect(sampleLinearColor(image, [0.49, 0.25])[0]).toBeCloseTo(2.08);
    expect(sampleLinearColor(image, [0.51, 0.25])[0]).toBeCloseTo(1.92);
    expect(sampleLinearColor(image, [0.5, 0.5], (pixel) => pixel % 2 === 0)).toEqual([2, 0, 4]);
    expect(sampleLinearColor(image, [0.5, 0.5], () => false)).toEqual([0, 0, 0]);
    const { inputs } = fixture(3.5);
    expect(() => auditTileSeams({ ...inputs, colorFilter: 'linear-admitted' })).toThrow(
      'captured fallback coverage',
    );
    expect(auditTileSeams({ ...inputs, colorFilter: 'linear' }).groups.contact).toMatchObject({
      eligible: 1,
      missed: 1,
      unavailable: 0,
    });
  });

  it('keeps a visible wall miss in the acceptance denominator', () => {
    const { inputs, source, receiver } = fixture(3.5);
    expect(source).not.toBe(receiver);
    expect(auditTileSeams(inputs).groups.contact).toMatchObject({
      eligible: 1,
      missed: 1,
      unavailable: 0,
    });
  });

  it('does not call a wall visible through its nearby floor occluder', () => {
    const { inputs, source, receiver } = fixture(3.97);
    expect(source).toBe(receiver);
    expect(auditTileSeams(inputs).groups.contact).toMatchObject({
      eligible: 0,
      missed: 0,
      unavailable: 1,
    });
  });

  it('requires the sampled face to agree even when its depth matches exactly', () => {
    const { inputs, source } = fixture(3.5);
    inputs.normal.values.splice(source * 4, 4, 0.5, 1, 0.5, 0.35);
    expect(auditTileSeams(inputs).groups.contact).toMatchObject({
      eligible: 0,
      missed: 0,
      unavailable: 1,
    });
  });
});
