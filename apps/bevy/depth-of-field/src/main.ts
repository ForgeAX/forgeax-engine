import { createFullscreenRenderFeature } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import { Update } from '@forgeax/engine-ecs';
import { FRAME_START_SCAN_SYSTEM_NAME, INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine-input';
import { PostProcessParams } from '@forgeax/engine-render';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import dofShader from './depth-of-field.wgsl';
import { buildDepthOfFieldWorld, DOF_MODE_BOKEH, DOF_MODE_GAUSSIAN, DOF_MODE_OFF, DOF_PARAM_BYTES, packDofParams } from './depth-of-field.js';

export const DEPTH_OF_FIELD_ID = 'bevy-depth-of-field::camera';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-depth-of-field: missing <canvas id="app">');

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const initial = { focalDistance: 7, aperture: 0.8, mode: DOF_MODE_BOKEH };
  const initialParams = packDofParams(initial.focalDistance, initial.aperture, initial.mode);
  const effect = createFullscreenRenderFeature({
    identity: DEPTH_OF_FIELD_ID,
    source: dofShader.wgsl,
    reads: [{ key: 'sceneColor' }, { key: 'depth', sampleType: 'depth' }],
    params: { byteSize: DOF_PARAM_BYTES, defaultValue: initialParams },
  });
  const result = await createApp(target, { features: [effect] }, forgeaxBundlerAdapter());
  if (!result.ok) {
    console.error('[bevy-depth-of-field] createApp failed:', result.error);
    return;
  }
  const app = result.value;
  const scene = buildDepthOfFieldWorld(app.world, target.width / Math.max(target.height, 1));
  const paramsEntity = app.world.spawn({ component: PostProcessParams, data: { shader: DEPTH_OF_FIELD_ID, data: initialParams } }).unwrap();

  const state = { mode: initial.mode, focalDistance: initial.focalDistance, aperture: initial.aperture, meshCount: scene.meshCount, effect: DEPTH_OF_FIELD_ID };
  let spaceWasDown = false;
  app.world.addSystem(Update, {
    name: 'depth-of-field-controls',
    after: [FRAME_START_SCAN_SYSTEM_NAME],
    queries: [],
    fn: (world) => {
      const input = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
      const spaceDown = input.keyboard.down(' ');
      if (spaceDown && !spaceWasDown) state.mode = state.mode === DOF_MODE_OFF ? DOF_MODE_GAUSSIAN : state.mode === DOF_MODE_GAUSSIAN ? DOF_MODE_BOKEH : DOF_MODE_OFF;
      spaceWasDown = spaceDown;
      if (input.keyboard.down('ArrowUp')) state.focalDistance = Math.min(20, state.focalDistance + 0.08);
      if (input.keyboard.down('ArrowDown')) state.focalDistance = Math.max(0.5, state.focalDistance - 0.08);
      if (input.keyboard.down('ArrowRight')) state.aperture = Math.min(1.5, state.aperture + 0.01);
      if (input.keyboard.down('ArrowLeft')) state.aperture = Math.max(0.05, state.aperture - 0.01);
      world.set(paramsEntity, PostProcessParams, { data: packDofParams(state.focalDistance, state.aperture, state.mode) });
    },
  });
  app.onError((error) => console.error('[bevy-depth-of-field] app error:', error.code, error.hint));
  const started = app.start();
  if (!started.ok) {
    console.error('[bevy-depth-of-field] app.start failed:', started.error.code, started.error.hint);
    return;
  }
  Object.assign(globalThis, { __bevyDepthOfFieldReady: true, __bevyDepthOfFieldState: state });
}

bootstrap(canvas).catch((error: unknown) => console.error('[bevy-depth-of-field] bootstrap error:', error));
