import { decodeMeshDistanceFieldAttachment, createBoxGeometry, createPlaneGeometry } from '@forgeax/engine-geometry';
import { cookMeshDistanceFieldProduct } from '@forgeax/engine-import';
import { definePack } from '@forgeax/engine-pack/source';
import { createBuiltinMaterialAsset } from '@forgeax/engine-shader';
import { ok } from '@forgeax/engine-types';
import { cookParticleCodeEffect } from '@forgeax/engine-vfx-compiler';
import { SDF_PACKAGE, sdfGuid } from '../src/sdf-guids.ts';
import { SDF_MODULES } from './sdf-programs.ts';

export default definePack({
  schemaVersion: '2.0.0', packageId: SDF_PACKAGE, name: 'Managed SDF collision',
  async build() {
    const mesh = createBoxGeometry(2, 2, 2).unwrap();
    const product = await cookMeshDistanceFieldProduct(mesh, sdfGuid('mesh/box'), { resolution: 32 }, [0]);
    const attached = await decodeMeshDistanceFieldAttachment(mesh, product.payload, product.artifacts['distance-field.bin'].bytes);
    if (!attached.ok) return attached;
    const plane = createPlaneGeometry(2, 2).unwrap();
    const planeProduct = await cookMeshDistanceFieldProduct(plane, sdfGuid('mesh/plane'), { resolution: 32 }, [1]);
    const planeAttached = await decodeMeshDistanceFieldAttachment(plane, planeProduct.payload, planeProduct.artifacts['distance-field.bin'].bytes);
    if (!planeAttached.ok) return planeAttached;
    const effect = async (module: string, capacity = 1024) => {
      // Renderer source admission is bounded at 65536 per emitter. Keep exact
      // total simulation and presentation capacity, including the remainder.
      const capacities = Array.from({ length: Math.ceil(capacity / 65536) }, (_, index) =>
        Math.min(65536, capacity - index * 65536));
      const cooked = await cookParticleCodeEffect({ schemaVersion: 3, emitters: capacities.map((count, index) => ({
        id: `collision-${index}`, capacity: count, backend: { required: 'gpu' }, space: 'world',
        bounds: { kind: 'aabb', min: [-4, -4, -4], max: [4, 4, 4] },
        simulationWhenCulled: 'continue', schedule: { rate: 0, bursts: [{ time: 0, count }] },
        program: { module }, renderers: [{ kind: 'billboard', capacity: count, material: sdfGuid('material/particle') }],
      })) }, SDF_MODULES);
      return cooked;
    };
    const collision = await effect('sdf-collision.vfx.wgsl');
    if (!collision.ok) return collision;
    const free = await effect('sdf-free.vfx.wgsl');
    if (!free.ok) return free;
    const material = createBuiltinMaterialAsset('unlit');
    const benchmarks = {} as Record<string, typeof collision.value.asset>;
    for (const capacity of [10_000, 100_000, 1_000_000]) {
      for (const [label, module] of [['collision', 'sdf-collision.vfx.wgsl'], ['free', 'sdf-free.vfx.wgsl']] as const) {
        const cooked = await effect(module, capacity);
        if (!cooked.ok) return cooked;
        benchmarks[`effect/benchmark/${capacity}/${label}`] = cooked.value.asset;
      }
    }
    return ok({
      'mesh/box': { ...mesh, distanceField: attached.value },
      'mesh/plane': { ...plane, distanceField: planeAttached.value },
      'mesh/no-field': mesh,
      'material/obstacle': { ...material, values: { ...material.values, baseColor: [0.15, 0.2, 0.3, 1] } },
      'material/particle': material,
      'effect/collision': collision.value.asset,
      'effect/free': free.value.asset,
      ...benchmarks,
    });
  },
});
