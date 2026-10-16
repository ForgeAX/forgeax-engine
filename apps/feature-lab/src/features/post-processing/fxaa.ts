import { ANTIALIAS_FXAA, ANTIALIAS_NONE, Camera } from '@forgeax/engine/render';
import { defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, unlit } from '../../lab/stage';
import { spawnAliasingEdges } from './shared/scenes';

export default defineFeature({
  title: 'FXAA',
  catalog: 'FXAA',
  kind: 'visual',
  summary:
    'Camera.antialias = ANTIALIAS_FXAA runs one fullscreen FXAA pass after tonemapping, with no TAA history.',
  expect:
    'ON: the thin white and red bars have smooth, slightly soft edges. OFF: every shallow bar shows hard stair-step jaggies and broken dotted segments.',
  setup({ world }) {
    const camera = spawnAliasingEdges(world, { antialias: ANTIALIAS_FXAA });
    const yellow = unlit(world, [1, 0.9, 0.1, 1]);
    for (let i = 0; i < 24; i++) {
      const angle = -0.35 - i * 0.03;
      spawnMesh(world, MESH.cube, yellow, {
        pos: [0, -2.4 + i * 0.2, -0.2],
        scale: [9, 0.03, 0.03],
        rotation: [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)],
      });
    }
    return {
      toggle(on) {
        world
          .set(camera, Camera, { antialias: on ? ANTIALIAS_FXAA : ANTIALIAS_NONE } as never)
          .unwrap();
      },
    };
  },
});
