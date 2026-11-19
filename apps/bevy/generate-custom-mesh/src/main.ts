import { InputFrameStartScan } from "@forgeax/engine-input";
import { defineSystem } from "@forgeax/engine-ecs";
import { createApp } from '@forgeax/engine-app/browser';
import { Update } from '@forgeax/engine-ecs';
import { INPUT_SNAPSHOT_RESOURCE_KEY } from '@forgeax/engine-input';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildCustomMeshWorld, makeCustomMeshTexture, stepCustomMesh } from './generate-custom-mesh.js';

type EvidenceGlobal = typeof globalThis & {
  __bevyGenerateCustomMeshReady?: boolean;
  __bevyGenerateCustomMeshState?: ReturnType<typeof buildCustomMeshWorld>;
  __prepareGenerateCustomMeshCapture?: () => Promise<void>;
};

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[generate-custom-mesh] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  const assets = app.assets;
  if (assets === undefined) throw new Error('asset owner unavailable');
  const texture = makeCustomMeshTexture();
  const textureHandle = assets.create(texture).unwrap();
  const state = buildCustomMeshWorld(app.world, assets, textureHandle);
  const systemToken1 = defineSystem({
    name: 'bevy-generate-custom-mesh-input',
    after: [InputFrameStartScan],
    queries: [],
    fn: (world) => stepCustomMesh(
      world,
      assets,
      state,
      world.getResource(INPUT_SNAPSHOT_RESOURCE_KEY),
    ),
  });
app.world.addSystem(Update, systemToken1);
  const started = app.start();
  if (!started.ok) console.error('[generate-custom-mesh] app.start() failed:', started.error);
  const evidenceGlobal = globalThis as EvidenceGlobal;
  evidenceGlobal.__prepareGenerateCustomMeshCapture = async () => {
    const updated = app.world.update(1 / 60);
    if (!updated.ok) throw updated.error;
  };
  Object.assign(evidenceGlobal, { __bevyGenerateCustomMeshReady: true, __bevyGenerateCustomMeshState: state });
}

const canvas = document.getElementById('app') as HTMLCanvasElement | null;
if (!canvas) throw new Error('<canvas id="app"> not found');
bootstrap(canvas);
