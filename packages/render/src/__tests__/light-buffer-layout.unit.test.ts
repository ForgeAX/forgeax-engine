import type { Vec3 } from '@forgeax/engine-math';
import { describe, expect, it } from 'vitest';
import {
  DIRECT_LIGHT_SLOT_KIND_MASK,
  DIRECT_LIGHT_SLOT_LAYOUT,
  DIRECT_LIGHT_SLOT_METADATA_SENTINEL,
  DIRECT_LIGHT_SLOT_PCF_SHIFT,
  DIRECT_LIGHT_SLOT_PROJECTOR_FLAG,
  DIRECT_LIGHT_SLOT_TILE_MASK,
  DirectLightSlotKind,
  packDirectLightSlot,
} from '../light-buffer-layout';
import type { SpotLightSnapshot } from '../render-system-extract';

const snapshot: SpotLightSnapshot = {
  kind: 'spot',
  position: new Float32Array([2, 3, 4]) as Vec3,
  direction: new Float32Array([0, 1, 0]) as Vec3,
  color: new Float32Array([4, 2, 1]) as Vec3,
  intensity: 4,
  invRangeSquared: 0.25,
  cosInner: 0.98,
  cosOuter: 0.7,
  rollDeg: 17,
  castShadow: false,
  lightViewProj: undefined,
  mapSize: 2048,
  nearPlane: 0.1,
  farPlane: 50,
  shadowAtlasTile: -1,
};

const point = {
  kind: 'point',
  position: [1, 2, 3],
  color: [4, 5, 6],
  invRangeSquared: 0.25,
  shadowAtlasLayer: -1,
  iesProfileSlice: undefined,
  cookieSlice: undefined,
};

const spot = {
  kind: 'spot',
  position: [7, 8, 9],
  color: [10, 11, 12],
  invRangeSquared: 0.125,
  direction: [0, -1, 0],
  cosInner: 0.9,
  cosOuter: 0.6,
  shadowAtlasTile: 3,
  iesProfileSlice: 5,
  cookieSlice: 7,
};

const rect = {
  kind: 'rect-area',
  position: [-1, -2, -3],
  color: [0.25, 0.5, 0.75],
  invRangeSquared: 0.01,
  halfWidth: 2,
  halfHeight: 3,
  axisX: [1, 0, 0],
  axisY: [0, 1, 0],
  shadowAtlasTile: -1,
  iesProfileSlice: undefined,
  cookieSlice: undefined,
};

describe('direct light snapshot buffer layout', () => {
  it('packs the normalized snapshot without changing its public semantics', () => {
    const packed = packDirectLightSlot(snapshot);

    expect([...packed.slice(0, 7)]).toEqual([2, 3, 4, 0.25, 4, 2, 1]);
    expect(packed[7]).toBeCloseTo(0.98, 5);
    expect([...packed.slice(8, 11)]).toEqual([0, 1, 0]);
    expect(packed[11]).toBeCloseTo(0.7, 5);
    expect(packed[15]).toBe(17);
  });

  it('does not introduce a pipeline-specific intensity multiplier', () => {
    const packed = packDirectLightSlot(snapshot);

    expect(packed[4]).toBe(snapshot.color[0]);
    expect(packed[5]).toBe(snapshot.color[1]);
    expect(packed[6]).toBe(snapshot.color[2]);
  });
});

describe('DirectLightSlot ABI', () => {
  it('locks the six-row 96-byte host contract and closed kind values', () => {
    expect(DIRECT_LIGHT_SLOT_LAYOUT.byteSize).toBe(96);
    expect(DIRECT_LIGHT_SLOT_LAYOUT.rowByteOffsets).toEqual([0, 16, 32, 48, 64, 80]);
    expect(DIRECT_LIGHT_SLOT_LAYOUT.metadataByteOffset).toBe(64);
    expect(DIRECT_LIGHT_SLOT_LAYOUT.kindByteOffset).toBe(64);
    expect(DIRECT_LIGHT_SLOT_LAYOUT.shadowByteOffset).toBe(68);
    expect(DIRECT_LIGHT_SLOT_LAYOUT.iesProfileByteOffset).toBe(72);
    expect(DIRECT_LIGHT_SLOT_LAYOUT.cookieByteOffset).toBe(76);
    expect(DIRECT_LIGHT_SLOT_LAYOUT.rollDegByteOffset).toBe(60);
    expect(DIRECT_LIGHT_SLOT_METADATA_SENTINEL).toBe(0xffffffff);
    expect(DirectLightSlotKind).toEqual({ POINT: 0, SPOT: 1, RECT_AREA: 2 });
  });

  it('packs Point, Spot, and Rect fields into the same six rows', () => {
    const packedPoint = packDirectLightSlot(point as never);
    const packedSpot = packDirectLightSlot(spot as never);
    const packedRect = packDirectLightSlot(rect as never);

    for (const packed of [packedPoint, packedSpot, packedRect]) {
      expect(packed).toBeInstanceOf(Float32Array);
      expect(packed.byteLength).toBe(96);
    }

    expect([...packedPoint.slice(0, 4)]).toEqual([1, 2, 3, 0.25]);
    expect([...packedSpot.slice(4, 7)]).toEqual([10, 11, 12]);
    expect([...packedSpot.slice(8, 11)]).toEqual([0, -1, 0]);
    expect([...packedRect.slice(8, 16)]).toEqual([0, 1, 0, 3, 1, 0, 0, 0]);
  });

  it('uses 0xffffffff for absent shadow and modifier identities', () => {
    const pointWords = new Uint32Array(packDirectLightSlot(point as never).buffer);
    const rectWords = new Uint32Array(packDirectLightSlot(rect as never).buffer);

    expect(pointWords[16]).toBe(DirectLightSlotKind.POINT);
    expect(pointWords[17]).toBe(DIRECT_LIGHT_SLOT_METADATA_SENTINEL);
    expect(pointWords[18]).toBe(DIRECT_LIGHT_SLOT_METADATA_SENTINEL);
    expect(pointWords[19]).toBe(DIRECT_LIGHT_SLOT_METADATA_SENTINEL);
    expect(rectWords[16]).toBe(DirectLightSlotKind.RECT_AREA);
    expect(rectWords[17]).toBe(DIRECT_LIGHT_SLOT_METADATA_SENTINEL);
    expect(rectWords[18]).toBe(DIRECT_LIGHT_SLOT_METADATA_SENTINEL);
    expect(rectWords[19]).toBe(DIRECT_LIGHT_SLOT_METADATA_SENTINEL);
  });

  it('marks only the selected projector without changing the slot ABI', () => {
    const projector = {
      ...snapshot,
      projectorAsset: {} as never,
      lightViewProj: new Float32Array(16),
      projectorSlice: 3,
    };
    const selected = new Uint32Array(packDirectLightSlot(projector as never, true).buffer);
    const notSelected = new Uint32Array(packDirectLightSlot(projector as never, false).buffer);

    const selectedShadowMetadata = selected[17];
    expect(selectedShadowMetadata).toBe(DIRECT_LIGHT_SLOT_PROJECTOR_FLAG | 0);
    if (selectedShadowMetadata === undefined) return;
    expect(selectedShadowMetadata & DIRECT_LIGHT_SLOT_TILE_MASK).toBe(0);
    expect(selected[19]).toBe(3);
    expect(notSelected[17]).toBe(DIRECT_LIGHT_SLOT_METADATA_SENTINEL);
    expect(notSelected[19]).toBe(DIRECT_LIGHT_SLOT_METADATA_SENTINEL);
  });

  it('carries live Spot receiver bias and PCF width beside the closed kind', () => {
    const live = {
      ...snapshot,
      depthBias: 0.02,
      normalBias: 0.3,
      shadowIntensity: 0.5,
      pcfKernelSize: 5,
    };
    const packed = packDirectLightSlot(live);
    const words = new Uint32Array(packed.buffer);
    expect([...packed.slice(12, 15)]).toEqual([Math.fround(0.02), Math.fround(0.3), 0.5]);
    const kindWord = words[16] ?? 0;
    expect(kindWord & DIRECT_LIGHT_SLOT_KIND_MASK).toBe(DirectLightSlotKind.SPOT);
    expect(kindWord >>> DIRECT_LIGHT_SLOT_PCF_SHIFT).toBe(5);
    const defaults = new Uint32Array(packDirectLightSlot(snapshot).buffer)[16] ?? 0;
    expect(defaults >>> DIRECT_LIGHT_SLOT_PCF_SHIFT).toBe(3);
  });
});
