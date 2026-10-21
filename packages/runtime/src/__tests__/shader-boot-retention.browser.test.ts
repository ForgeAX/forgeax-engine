import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { Camera, Materials, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, it, vi } from 'vitest';
import { createRenderer } from '../createRenderer';
import { testAssets } from './helpers/runtime-assets';

it('boots and completes 60 native frames without expanding unselected WGSL in variant queries', async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  document.body.append(canvas);
  const queryExpansions: { bytes: number; stack: string }[] = [];
  const join = Array.prototype.join;
  const spy = vi.spyOn(Array.prototype, 'join').mockImplementation(function (
    this: unknown[],
    separator?: string,
  ) {
    const value = Reflect.apply(join, this, [separator]) as string;
    if (separator === '' && /@(vertex|fragment|compute)\b/.test(value)) {
      const stack = new Error().stack ?? '';
      // Identifier-selected boot sources are needed for compilation. This
      // regression observes variant searches, where preceding candidates
      // must remain lazy; the native red distinguishes those two paths.
      if (stack.includes('Array.find') && !stack.includes('findEngineManifestEntry'))
        queryExpansions.push({ bytes: value.length * 2, stack });
    }
    return value;
  });
  try {
    const created = await createRenderer(
      canvas,
      {},
      { shaderManifestUrl: '/shaders/manifest.json' },
    );
    spy.mockRestore();
    if (!created.ok) throw created.error;
    const native = created.value;
    const world = new World();
    const transforms = registerPropagateTransforms(world);
    const errors: unknown[] = [];
    const off = native.subscribe((event) => {
      if (event.kind === 'error') errors.push(event.error);
    });
    try {
      const camera = world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 4] } },
          { component: Camera, data: { fov: Math.PI / 3, aspect: 1, near: 0.1, far: 100 } },
        )
        .unwrap();
      const mesh = testAssets(world)
        .create(createBoxGeometry(1, 1, 1).unwrap())
        .unwrap();
      const material = testAssets(world)
        .create(Materials.unlit([1, 0, 0, 1]))
        .unwrap();
      world
        .spawn(
          { component: Transform, data: {} },
          { component: MeshFilter, data: { assetHandle: mesh } },
          { component: MeshRenderer, data: { materials: [material] } },
        )
        .unwrap();
      const lease = native.attach(world).unwrap();
      try {
        for (let frame = 0; frame < 60; frame++) {
          world.update(1 / 60).unwrap();
          const draw = native
            .draw({ leases: [lease], camera: { lease, entityKey: camera }, environment: { lease } })
            .unwrap();
          (await draw.completed).unwrap();
          expect(draw.presentation).toBe('ready');
        }
        expect(errors).toEqual([]);
        console.log(
          '[shader-variant-query]',
          JSON.stringify({
            expansions: queryExpansions.length,
            nominalUtf16Bytes: queryExpansions.reduce((sum, row) => sum + row.bytes, 0),
            completedFrames: 60,
          }),
        );
        expect(queryExpansions).toEqual([]);
      } finally {
        lease.dispose();
      }
    } finally {
      off();
      transforms();
      await native.dispose();
    }
  } finally {
    spy.mockRestore();
    canvas.remove();
  }
}, 120_000);
