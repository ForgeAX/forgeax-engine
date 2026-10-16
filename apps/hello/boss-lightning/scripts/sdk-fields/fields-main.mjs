import { createToolPreviewHost, createToolPreviewRecipe, replayToolPreviewCapture } from '@forgeax/engine/app';
import { FixedTime } from '@forgeax/engine/ecs';
import { scenePlugin } from '@forgeax/engine/scene';
import { createVfxRuntimeHost } from '@forgeax/engine/vfx-render';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import snapshot from '../roi21-field-snapshot.json';
import { FIELD_DT, FIELD_HEIGHT, FIELD_WIDTH, fieldCamera, populateFieldScene } from './field-scene.ts';

// The installed SDK owns App, Catalog, GPU resources, capture and replay.
// This consumer only supplies the same ordinary assets and bounded recipe.
const key = new URLSearchParams(location.search).get('field') ?? 'constant';
const vfx = createVfxRuntimeHost({ camera: fieldCamera });
const state = { phase: 'bootstrap', key, devicePixelRatio: window.devicePixelRatio };
Object.assign(globalThis, { __roi21SDK: state });
try {
  const created = await createToolPreviewHost({
    snapshot,
    recipe: createToolPreviewRecipe({
      frames: 60, deltaSeconds: FIELD_DT, presentation: 'visible',
      viewport: { width: FIELD_WIDTH, height: FIELD_HEIGHT },
    }),
    app: { features: [vfx.feature], plugins: [scenePlugin()] },
    bundler: forgeaxBundlerAdapter(),
    async prepare(app) {
      if (app.assets === undefined) throw new Error('SDK App must own an AssetRegistry');
      const attached = await vfx.attachWorld({ world: app.world, assets: app.assets });
      if (!attached.ok) throw attached.error;
      await populateFieldScene(app.world, app.assets, key);
    },
    async onDispose(app) {
      const detached = await vfx.detachWorld({ world: app.world });
      if (!detached.ok) throw detached.error;
    },
  });
  if (!created.ok) throw created.error;
  const host = created.value;
  state.phase = 'capture';
  state.dispose = async () => {
    const disposed = await host.dispose();
    if (!disposed.ok) throw disposed.error;
    state.disposed = true;
  };
  const capture = await host.capture();
  if (!capture.ok) throw capture.error;
  state.phase = 'receipt-drain';
  const drainStartedAt = performance.now();
  while (host.app.execution.report().frame.completed < 60 && performance.now() - drainStartedAt < 300000) {
    await new Promise(resolve => setTimeout(resolve, 16));
  }
  state.executionFrame = host.app.execution.report().frame;
  state.completedFrames = state.executionFrame.completed;
  state.fixed = { ...host.app.world.getResource(FixedTime) };
  state.host = vfx.inspect(host.app.world);
  if (state.completedFrames !== 60 || state.executionFrame.submitted !== 60 || state.executionFrame.inFlight !== 0 || state.fixed.tick !== 60 || capture.value.appErrors.length !== 0) {
    throw new Error(JSON.stringify({ completedFrames: state.completedFrames, executionFrame: state.executionFrame, fixed: state.fixed, errors: capture.value.appErrors }));
  }
  // Keep the PNG sampled inside host.capture() paired with this tape. The
  // receipt drain can complete after the capture frame and must not replace it.
  state.capture = capture.value;
  state.phase = 'fresh-device-replay';
  const replay = await replayToolPreviewCapture(state.capture);
  if (!replay.ok) throw replay.error;
  state.replay = replay.value;
  if (replay.value.drawCalls === 0 || replay.value.nonBlackPixels === 0) {
    throw new Error('the installed field consumer must draw real pixels');
  }
  state.phase = 'complete';
} catch (error) {
  state.phase = 'failed';
  state.error = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error;
  throw error;
}
