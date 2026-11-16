import {
  buildWaterMeshView,
  buildWaterWaveUploadPlan,
  cookGerstnerWaveSet,
  WATER_WAVE_LWC_TILE_LENGTH_M,
  type WaterWaveUploadBody,
  waterBodyOwnerKey,
} from '@forgeax/engine-water';
import { createWaterMeshLayoutReceipt } from '@forgeax/engine-water/internal';
import { describe, expect, it } from 'vitest';
import { continuityInput } from '../../../../water/src/__tests__/water-mesh-continuity.fixture.js';
import { buildWaterMaterialFrameUpload, buildWaterMeshInstanceUpload } from '../wave-material.js';

function fixture() {
  const mesh = buildWaterMeshView(continuityInput(), {
    viewId: 'mouth',
    observerM: [8, 8, 8],
  }).unwrap();
  const waveSet = cookGerstnerWaveSet({
    kind: 'water-wave-set',
    sourceMode: 'predefined',
    inputDigest: 'a'.repeat(64),
    waves: [{ directionXZ: [1, 0], wavelengthM: 8, amplitudeM: 0.5, steepness: 0.25 }],
    depthMaskM: 4,
    maxWaveHeightM: 0.5,
    timeSource: 'scene-clock',
  }).unwrap();
  const bodies: WaterWaveUploadBody[] = continuityInput().bodies.map((b) => ({
    worldId: 0,
    worldIdentity: 'world',
    bodyGuid: b.guid,
    waveSetGuid: 'waves',
    bodyGeneration: b.generation,
    zoneGeneration: 3,
    waveSet,
    timeSeconds: 2,
    previousTimeSeconds: 1,
    baseHeightM: b.baseHeightM,
    tileOriginWorldXZ: b.waveOriginXZ,
    tileLengthM: WATER_WAVE_LWC_TILE_LENGTH_M,
    heightSource: {
      kind: 'water-info',
      zoneIndex: 0,
      slice: 0,
      fixedHeightM: b.baseHeightM,
      fixedDepthM: 12,
      fixedVelocityXZ: b.type === 'river' ? [2.8, 0] : [0, 0],
    },
    supportsWaves: b.type === 'ocean',
    usesFlatSurfaceHeight: b.type === 'ocean',
    meshEdgeOverlayEnabled: false,
  }));
  const plan = buildWaterWaveUploadPlan(bodies).unwrap();
  const draws = mesh.buckets
    .flatMap((b) => b.ownerDraws)
    .map((d) => ({
      drawKey: d.drawKey,
      bodyGuid: waterBodyOwnerKey('world', d.ownerGuid, d.ownerGeneration, 3),
      bodyGeneration: d.ownerGeneration,
      zoneGeneration: 3,
      viewIdentity: mesh.viewId,
      transitionTargets: d.instances.flatMap((t, instanceIndex) =>
        t.transitionBodyGuid === undefined || t.transitionBodyGeneration === undefined
          ? []
          : [
              {
                instanceIndex,
                bodyGuid: waterBodyOwnerKey(
                  'world',
                  t.transitionBodyGuid,
                  t.transitionBodyGeneration,
                  3,
                ),
                bodyGeneration: t.transitionBodyGeneration,
                zoneGeneration: 3,
              },
            ],
      ),
      bytes: d.instanceBytes,
      coverageBytes: d.coverageBytes,
      layout: d.layout,
    }));
  const descriptors = new Map([...plan.bodyIndices.keys()].map((k) => [k, new Uint8Array(48)]));
  return { mesh, bodies, plan, draws, descriptors };
}
describe('terminal continuity accepted upload closure', () => {
  it('packs nonzero storage windows, remaps the actual target row and detaches held results', () => {
    const { plan, draws, descriptors } = fixture();
    const held = buildWaterMaterialFrameUpload(plan, descriptors, draws, 256).waterMeshInstances;
    const saved = held.bytes.slice();
    for (const draw of draws) {
      const offset = held.dynamicOffsets.get(draw.drawKey);
      if (offset === undefined) throw Error('missing draw');
      const source = new DataView(draw.bytes.buffer, draw.bytes.byteOffset, draw.bytes.byteLength),
        packed = new DataView(held.bytes.buffer);
      for (let i = 0; i < draw.bytes.length / 96; i++) {
        const pointer = source.getUint32(i * 96 + 92, true) >>> 4;
        if (pointer === 0) continue;
        expect(packed.getUint32(offset + i * 96 + 92, true) >>> 4).toBe(pointer);
        expect(packed.getUint32(offset + pointer * 4, true)).toBe(0x57434e31);
      }
      for (const target of draw.transitionTargets)
        expect(packed.getUint32(offset + target.instanceIndex * 96 + 32, true)).toBe(
          (plan.bodyIndices.get(target.bodyGuid) ?? -1) + 1,
        );
    }
    buildWaterMaterialFrameUpload(
      plan,
      descriptors,
      draws.map((d) => ({ ...d, drawKey: `${d.drawKey}:next` })),
      64,
    );
    expect(held.bytes).toEqual(saved);
  });
  it('rejects stale target generations and independent depth authority rather than changing source physics', () => {
    const { plan, draws, descriptors, bodies } = fixture();
    const stale = draws.map((d) => ({
      ...d,
      transitionTargets: d.transitionTargets.map((t) => ({
        ...t,
        bodyGeneration: t.bodyGeneration + 1,
      })),
    }));
    expect(() => buildWaterMaterialFrameUpload(plan, descriptors, stale)).toThrow(
      'missing or stale',
    );
    const other = buildWaterWaveUploadPlan(
      bodies.map((b) =>
        b.bodyGuid === 'river' ? { ...b, heightSource: { ...b.heightSource, slice: 1 } } : b,
      ),
    ).unwrap();
    expect(() => buildWaterMaterialFrameUpload(other, descriptors, draws)).toThrow(
      'shared source depth authority',
    );
    expect(bodies.find((b) => b.bodyGuid === 'river')?.heightSource.fixedVelocityXZ).toEqual([
      2.8, 0,
    ]);
  });
  it('uses the same WaterInfo depth even when unused fixed fallbacks differ', () => {
    const { bodies, draws, descriptors } = fixture();
    const plan = buildWaterWaveUploadPlan(
      bodies.map((b) =>
        b.bodyGuid === 'river' ? { ...b, heightSource: { ...b.heightSource, fixedDepthM: 2 } } : b,
      ),
    ).unwrap();
    expect(() => buildWaterMaterialFrameUpload(plan, descriptors, draws)).not.toThrow();
  });
  it('rejects a rehashed corrupt support pointer in borrowed upload admission', () => {
    const { draws } = fixture();
    const draw = draws.find(
      (d) => new DataView(d.bytes.buffer, d.bytes.byteOffset).getUint32(92, true) >>> 4 !== 0,
    );
    if (!draw) throw Error('missing support');
    const bytes = draw.bytes.slice();
    new DataView(bytes.buffer).setUint32(92, 0xfffffff0, true);
    expect(() =>
      buildWaterMeshInstanceUpload([
        { ...draw, bytes, layout: createWaterMeshLayoutReceipt(bytes, draw.coverageBytes) },
      ]),
    ).toThrow('invalid instance layout receipt');
  });
});
