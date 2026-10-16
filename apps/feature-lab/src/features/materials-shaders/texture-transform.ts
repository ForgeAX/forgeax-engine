import { Materials, MeshRenderer } from '@forgeax/engine/render';
import { defineFeature } from '../../lab/feature';
import { MESH, material, spawnCamera, spawnMesh, spawnSun } from '../../lab/stage';
import { checker, sampler } from './lib/textures';

export default defineFeature({
  title: 'Material texture transform',
  catalog: 'Material texture transform',
  kind: 'visual',
  summary:
    'A texture slot value { texture, sampler, coordinates: { set, transform: { offset, scale, rotation } } } re-maps UVs in the cooked material; no mesh UV patching. Left quad: Standard, right quad: Unlit, same texture value.',
  expect:
    'ON: both quads should show a dense, rotated red/yellow checker. OFF: both show the coarse 4x4 axis-aligned checker. Known gap: the Unlit shader ignores the transform, so the right quad stays coarse in both states.',
  setup({ world }) {
    spawnCamera(world, { eye: [0, 1, 4.5], target: [0, 1, 0] });
    spawnSun(world, { direction: [0, -0.3, -1], intensity: 3 });
    const tex = checker(world, [230, 30, 30, 255], [250, 220, 40, 255]);
    const samp = sampler(world, 'nearest', 'repeat');
    const slot = (scale: readonly [number, number], rotation: number): never =>
      ({
        texture: tex,
        sampler: samp,
        coordinates: { set: 0, transform: { offset: [0.1, 0.1], scale, rotation } },
      }) as never;
    const pair = (scale: readonly [number, number], rotation: number) => ({
      standard: material(
        world,
        Materials.standard({
          baseColor: [1, 1, 1, 1],
          roughness: 1,
          baseColorTexture: slot(scale, rotation),
        }),
      ),
      unlit: material(
        world,
        Materials.unlit([1, 1, 1, 1], {
          baseColorTexture: slot(scale, rotation),
        }),
      ),
    });
    const on = pair([4, 4], 0.6);
    const off = pair([1, 1], 0);
    const left = spawnMesh(world, MESH.quad, on.standard, {
      pos: [-1.3, 1, 0],
      scale: [2.2, 2.2, 1],
    });
    const right = spawnMesh(world, MESH.quad, on.unlit, { pos: [1.3, 1, 0], scale: [2.2, 2.2, 1] });
    return {
      toggle(enabled: boolean) {
        const set = enabled ? on : off;
        world.set(left, MeshRenderer, { materials: [set.standard] } as never);
        world.set(right, MeshRenderer, { materials: [set.unlit] } as never);
      },
    };
  },
});
