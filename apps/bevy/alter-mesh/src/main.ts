import { createApp } from '@forgeax/engine-app/browser';
import { Update } from '@forgeax/engine-ecs';
import { FRAME_START_SCAN_SYSTEM_NAME, INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine-input';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildAlterMeshWorld, stepAlterMesh } from './alter-mesh.js';

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[alter-mesh] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  const assets = app.assets;
  if (assets === undefined) throw new Error('asset owner unavailable');
  const state = buildAlterMeshWorld(app.world, assets);
  app.world.addSystem(Update, {
    name: 'bevy-alter-mesh-input',
    after: [FRAME_START_SCAN_SYSTEM_NAME],
    queries: [],
    fn: (world) => stepAlterMesh(
      world,
      assets,
      state,
      world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY),
    ),
  });
  const started = app.start();
  if (!started.ok) console.error('[alter-mesh] app.start() failed:', started.error);
  Object.assign(globalThis, { __bevyAlterMeshReady: true, __bevyAlterMeshState: state });
}

const canvas = document.getElementById('app') as HTMLCanvasElement | null;
if (!canvas) throw new Error('<canvas id="app"> not found');
bootstrap(canvas);
