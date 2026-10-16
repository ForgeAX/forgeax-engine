import { Materials } from '@forgeax/engine/render';
import { defineFeature } from '../../lab/feature';
import { MESH, material, spawnMesh, spawnStage } from '../../lab/stage';
import { materialToggle } from './lib/swap';

const RED = 1;
const ALL = 15;

export default defineFeature({
  title: 'Color write mask + polygon depth offset',
  catalog: 'Material color writes and polygon depth offset',
  kind: 'visual',
  summary:
    'renderState.colorWriteMask limits written channels; depthBias / depthBiasSlopeScale offset rasterized depth so a coplanar overlay wins the depth test without moving vertices.',
  expect:
    'ON: the white sphere writes only red (it shows red over the dark clear color) and the green coplanar floor patch is clean. OFF: the sphere is white and the unbiased green patch z-fights with the floor.',
  setup({ world }) {
    spawnStage(world);
    const masked = material(
      world,
      Materials.unlit([1, 1, 1, 1], { renderState: { colorWriteMask: RED } }),
    );
    const full = material(
      world,
      Materials.unlit([1, 1, 1, 1], { renderState: { colorWriteMask: ALL } }),
    );
    const sphere = spawnMesh(world, MESH.sphere, masked, {
      pos: [-0.9, 1.1, 0],
      scale: [1.2, 1.2, 1.2],
    });
    const overlay = (depthBias: number) =>
      material(
        world,
        Materials.unlit([0.1, 0.9, 0.2, 1], {
          renderState: { depthBias, depthBiasSlopeScale: depthBias, depthWriteEnabled: false },
        }),
      );
    const biased = overlay(-1);
    const flat = overlay(0);
    const patch = spawnMesh(world, MESH.quad, biased, {
      pos: [1.1, 0, 0.6],
      scale: [1.8, 1.8, 1],
      rotation: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2],
    });
    const sphereToggle = materialToggle(world, sphere, masked, full);
    const patchToggle = materialToggle(world, patch, biased, flat);
    return {
      toggle(on) {
        sphereToggle(on);
        patchToggle(on);
      },
    };
  },
});
