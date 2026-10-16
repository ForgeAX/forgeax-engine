import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  ANTIALIAS_NONE,
  Camera,
  DirectionalLight,
  Instances,
  Materials,
  MeshFilter,
  MeshRenderer,
} from '@forgeax/engine-render';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, it, vi } from 'vitest';
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { constructRuntimeRendererHost } from '../renderer-host';

it('presents empty, populated, then empty instance holders across completed frames', async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  document.body.append(canvas);
  const errors: unknown[] = [];
  const consoleError = vi
    .spyOn(console, 'error')
    .mockImplementation((...args) => errors.push(args));
  try {
    const host = await constructRuntimeRendererHost(
      canvas,
      {},
      { shaderManifestUrl: '/shaders/manifest.json' },
    );
    if (!host.ok) throw host.error;
    const renderer = host.value.renderer;
    const world = new World();
    const transforms = registerPropagateTransforms(world);
    const mesh = world.allocSharedRef('MeshAsset', createBoxGeometry(1, 1, 1).unwrap());
    const material = world.allocSharedRef('MaterialAsset', Materials.unlit([1, 0, 0, 1]));
    const holder = world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material] } },
        { component: Instances, data: { transforms: new Float32Array(0) } },
      )
      .unwrap();
    world
      .spawn({
        component: DirectionalLight,
        data: {
          mapSize: testQuality.shadowMapSize,
          cascadeCount: testQuality.cascadeCount,
          direction: [0, -1, -1],
          intensity: 1,
          color: [1, 1, 1],
        },
      })
      .unwrap();
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 4] } },
        {
          component: Camera,
          data: { fov: Math.PI / 3, aspect: 1, near: 0.1, far: 100, antialias: ANTIALIAS_NONE },
        },
      )
      .unwrap();
    const attached = renderer.attach(world);
    if (!attached.ok) throw attached.error;
    const lease = attached.value;
    const unsubscribe = renderer.subscribe((event) => {
      if (event.kind === 'error') errors.push(event.error);
    });
    try {
      for (const matrices of [
        new Float32Array(0),
        new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
        new Float32Array(0),
      ]) {
        world.set(holder, Instances, { transforms: matrices }).unwrap();
        let presentation: string | undefined;
        for (let frame = 0; frame < 60; frame++) {
          world.update(1 / 60).unwrap();
          const drawn = renderer.draw({
            leases: [lease],
            camera: { lease, entityKey: camera },
            environment: { lease },
          });
          if (!drawn.ok) throw drawn.error;
          const completed = await drawn.value.completed;
          if (!completed.ok) throw completed.error;
          presentation = drawn.value.presentation;
        }
        expect(presentation).toBe('ready');
      }
      expect(errors).toEqual([]);
    } finally {
      unsubscribe();
      lease.dispose();
      transforms();
      await renderer.dispose();
    }
  } finally {
    canvas.remove();
    consoleError.mockRestore();
  }
}, 60_000);
