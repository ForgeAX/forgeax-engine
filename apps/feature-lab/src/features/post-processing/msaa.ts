import { ANTIALIAS_MSAA, ANTIALIAS_NONE, Camera } from '@forgeax/engine/render';
import { defineFeature } from '../../lab/feature';
import { spawnAliasingEdges } from './shared/scenes';

export default defineFeature({
  title: 'MSAA',
  catalog: 'MSAA',
  kind: 'visual',
  summary:
    'Camera.antialias = ANTIALIAS_MSAA renders scene and depth into 4x multisampled attachments and resolves them. ANTIALIAS_MSAA_FXAA adds the ordinary FXAA output pass after resolve. Standalone native WebGPU Fog uses per-sample depth; local volume fog uses a GPU nearest-depth resolve. WebGL2 qualifies its HDR/depth resolve profile on the actual device.',
  expect:
    'ON: bar edges are smooth and the thinnest bars stay continuous lines. OFF: hard stair-steps and dotted, broken bars.',
  setup({ world }) {
    const camera = spawnAliasingEdges(world, { antialias: ANTIALIAS_MSAA });
    return {
      toggle(on) {
        world
          .set(camera, Camera, { antialias: on ? ANTIALIAS_MSAA : ANTIALIAS_NONE } as never)
          .unwrap();
      },
    };
  },
});
