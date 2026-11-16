import { describe, expect, it } from 'vitest';
import type { WaterMeshTileInstance } from '../water-mesh.js';
import { buildWaterMeshContinuity, waterMeshContinuityVertex } from '../water-mesh-continuity.js';
import { continuityInput } from './water-mesh-continuity.fixture.js';

// Minimal numeric projection of current14 baseline, SHA256 863452c1246806a5e68b8d7fffbc1885a60585084a1d284918d45dfdb1f7471c.
// Paired work72/14 and work65/34 use the same 289-vertex grid and morph inputs.
const riverRing = [
  [184.75945663452148, -112],
  [179.70099592208862, -112],
  [179.032723903656, -115.16851234436035],
] as const;
const oceanRing = [
  [192, -112],
  [184.75945663452148, -112],
  [179.032723903656, -115.16851234436035],
  [178.438982963562, -117.9836540222168],
  [176.0014590000501, -128],
  [192, -128],
] as const;
function tile(transition: boolean): WaterMeshTileInstance {
  return {
    originXZ: [176, -128],
    extentXZ: [16, 16],
    sizeM: 16,
    fullyCovered: false,
    waterYM: 0,
    yMinM: -3,
    yMaxM: 3,
    ownerGuid: transition ? 'river' : 'ocean',
    ownerGeneration: transition ? 25 : 26,
    ownerRenderIndex: transition ? 4 : 2,
    ...(transition ? { transitionBodyGuid: 'ocean', transitionBodyGeneration: 26 } : {}),
    transitionRenderIndex: transition ? 2 : 0,
    materialKey: transition ? 'river-ocean' : 'ocean',
    densityKey: 0,
    densityIndex: 0,
    priorityU16: 0,
    lod0: 1,
    lod1: 2,
    lodScaleM: 32,
    maxMorphLod: 4,
    heightMorph01: 0,
    shouldMorph: true,
    canMorphTwice: true,
    quadsPerEdge: 16,
    far: false,
    flatFarBoundaryMask: 0,
    waveOriginOffsetXZ: [176, -128],
    cameraRelativeXZ: [38, 93],
    coverageRings: [(transition ? riverRing : oceanRing).map(([x, z]) => [x - 176, z + 128])],
  };
}
describe('current captured mouth triangle support', () => {
  it('closes all three actual morphed triangle vertices rather than only the sampled midpoint', () => {
    const input = continuityInput();
    const bodies = input.bodies.map((b) =>
      b.type === 'river'
        ? {
            ...b,
            generation: 25,
            polygon: { outer: riverRing },
            transitionContinuity: { centerXZ: [185, -88] as const, reachM: 52, blendWidthM: 8 },
          }
        : { ...b, generation: 26, polygon: { outer: oceanRing } },
    );
    const result = buildWaterMeshContinuity([tile(true), tile(false)], bodies).unwrap();
    const a = result[0]?.continuitySupport?.weights,
      b = result[1]?.continuitySupport?.weights;
    expect(a).toBeDefined();
    expect(a).toEqual(b);
    // Grid triangle at x181.89609/z-113.58426; indices are production template's 3 vertices.
    const ids = [244, 260, 261];
    for (const id of ids) expect(a?.[id]).toBe(1);
  });
  it('keeps the adjacent ordinary source patch on the same submitted boundary deformation', () => {
    const input = continuityInput();
    const ordinaryRing = [
      [179.032723903656, -115.16851234436035],
      [179.70099592208862, -112],
      [176, -112],
      [176, -116.8464708328247],
    ] as const;
    const bodies = input.bodies.map((b) =>
      b.type === 'river'
        ? {
            ...b,
            generation: 25,
            polygon: { outer: riverRing },
            transitionContinuity: { centerXZ: [185, -88] as const, reachM: 52, blendWidthM: 8 },
          }
        : { ...b, generation: 26, polygon: { outer: oceanRing } },
    );
    const {
      transitionBodyGuid: _guid,
      transitionBodyGeneration: _generation,
      ...sourceTile
    } = tile(true);
    const ordinary: WaterMeshTileInstance = {
      ...sourceTile,
      transitionRenderIndex: 0,
      materialKey: 'river',
      coverageRings: [ordinaryRing.map(([x, z]) => [x - 176, z + 128])],
    };
    const result = buildWaterMeshContinuity([tile(true), tile(false), ordinary], bodies).unwrap();
    const joined = result[2];
    expect(joined?.continuitySupport?.weights).toEqual(result[0]?.continuitySupport?.weights);
    expect(joined?.transitionBodyGuid).toBe('ocean');
    expect(joined?.transitionBodyGeneration).toBe(26);
    expect(joined?.transitionRenderIndex).toBe(2);
    expect(joined?.materialKey).toBe('river');
    expect(joined?.waveOriginOffsetXZ).toEqual([53, -93]);
    expect(ordinary.continuitySupport).toBeUndefined();
  });
  it('does not grant support for a clipped tile perimeter that is absent from the Body footprint', () => {
    const input = continuityInput();
    const bodies = input.bodies.map((b) =>
      b.type === 'river'
        ? {
            ...b,
            generation: 25,
            polygon: {
              outer: [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 1],
              ] as const,
            },
            transitionContinuity: { centerXZ: [185, -88] as const, reachM: 52, blendWidthM: 8 },
          }
        : { ...b, generation: 26, polygon: { outer: oceanRing } },
    );
    const result = buildWaterMeshContinuity([tile(true), tile(false)], bodies).unwrap();
    expect(result.every((t) => t.continuitySupport === undefined)).toBe(true);
  });
});

describe('production tile height morph projection', () => {
  it.each([
    0, 0.5, 1,
  ])('adds heightMorph %s after clamping the distance factor', (heightMorph01) => {
    const input: WaterMeshTileInstance = {
      ...tile(false),
      originXZ: [0, 0],
      lod0: 0,
      maxMorphLod: 1,
      lodScaleM: 64,
      cameraRelativeXZ: [1, 0],
      heightMorph01,
    };
    const height = Math.round(heightMorph01 * 8191) / 8191;
    expect(waterMeshContinuityVertex(input, 1, 0)).toEqual([
      Math.fround(1 - Math.fround(height)),
      0,
    ]);
  });
  it('clamps the combined height and distance factors without morphing later levels early', () => {
    const input: WaterMeshTileInstance = {
      ...tile(false),
      originXZ: [0, 0],
      lod0: 0,
      maxMorphLod: 1,
      lodScaleM: 1,
      cameraRelativeXZ: [-2, 0],
      heightMorph01: 0.5,
    };
    expect(waterMeshContinuityVertex(input, 1, 0)).toEqual([0, 0]);
  });
});
