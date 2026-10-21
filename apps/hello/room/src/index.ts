import {
  configureRuntimeAssetCatalog,
  createRuntimeAssetImportTransport,
  runtimeBinding,
} from '@forgeax/apps-shared/asset-runtime-config';
// apps/hello/room - importable SUT entry (feat-20260531-hoist-onerror-gate-
// to-apps-shared-and-fix-hello-room M3 / w6).
//
// This file is the room demo's importable entry, matching the learn-render
// consumer shape (16 sections expose a `bootstrap(canvas)` + a top-level
// `void bootstrap(canvas)` self-call). The onerror-gate browser test imports
// this module via `() => import('../index.ts')`, so the bootstrap must wire
// `renderer.subscribe` error channel into the `globalThis.__learnRenderErrors` bus before the
// gate's 5s poll window samples it (charter F1: read one learn-render entry,
// reuse the same pattern here).
//
// Scene recipe is unchanged from the previous main.ts; the only behavioural
// difference is the unlit MaterialAsset is now constructed by the
// `Materials.unlit` factory (a valid pass-based POD) instead of the legacy
// hand-written unlit-discriminant shape that carried no passes, resolved to
// zero passes at draw time, and fired `material-resolved-empty-passes`
// through the renderer error event.

import { createWorldContext, World } from '@forgeax/engine-ecs';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
import { renderComponentsPlugin } from '@forgeax/engine-render';
import { scenePlugin } from '@forgeax/engine-scene';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const ROOM_SCENE_GUID = '019e2808-d3ba-735f-811f-ae7bbb465392';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('hello-room: missing <canvas id="app"> in index.html');

void bootstrap(canvas);

export async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  try {
    const constructed = await constructRuntimeRendererHost(
      target,
      {},
      {
        ...forgeaxBundlerAdapter(),
        importTransport: createRuntimeAssetImportTransport(runtimeBinding),
      },
    );
    if (!constructed.ok) throw constructed.error;
    const { renderer, assets } = constructed.value;
    // Forward every renderer error into the onerror-gate bus (charter P3
    // structured failure: AI users consume `.code` / `.hint`). The gate
    // installs `__learnRenderErrors` before importing this module; when the
    // bus is absent (normal dev / smoke run) the push is skipped.
    renderer.subscribe((event) => {
      if (event.kind !== 'error') return;
      const e = event.error;
      console.error('[room] renderer error:', e.code, e.hint);
      const bus = (
        globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }
      ).__learnRenderErrors;
      if (bus !== undefined) bus.push({ code: e.code, hint: e.hint });
    });

    console.warn('[room] Standard pipeline active');

    configureRuntimeAssetCatalog(assets, runtimeBinding);

    // Step 2: prepare World + register every component the SceneAsset
    // references. The SceneInstanceContainer resolver looks tokens up by
    // name; pre-registering keeps the spawn surface compile-time stable.
    const world = new World({ assets });
    const worldContext = await createWorldContext(world, [renderComponentsPlugin(), scenePlugin()]);
    const worldAttachment1 = renderer.attach(world);
    if (!worldAttachment1.ok) throw worldAttachment1.error;
    const frameRequest = {
      leases: [worldAttachment1.value],
      camera: { lease: worldAttachment1.value },
      environment: { lease: worldAttachment1.value },
    };

    const sceneRes = await assets.load(assets.parseGuid(ROOM_SCENE_GUID), 'scene');
    if (!sceneRes.ok) throw sceneRes.error;
    // Instantiation retains the same runtime scene identity.
    const sceneHandle = sceneRes.value;
    const instanceRes = assets.instantiate(sceneHandle, world);
    assets.release(sceneHandle).unwrap();
    if (!instanceRes.ok) {
      const e = instanceRes.error as { code: string };
      console.error('[room] scene instantiate failed:', e.code);
      return;
    }

    const frame = (): void => {
      void worldContext;
      world.update().unwrap();
      const r = renderer.draw(frameRequest);
      if (!r.ok) console.error('[room] draw error:', r.error);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  } catch (err: unknown) {
    if (err instanceof EngineEnvironmentError) console.error('[room] no usable backend:', err);
    else console.error('[room] bootstrap error:', err);
  }
}
