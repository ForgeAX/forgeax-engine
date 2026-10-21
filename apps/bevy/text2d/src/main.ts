import type { AssetHandle } from '@forgeax/engine-types';
import { createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine-app/browser';
import { Time, Update } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { Transform } from '@forgeax/engine-scene';

import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import {
  buildText2dFontRecoveryWorld,
  buildText2dWorld,
  createText2dFontRecoveryController,
  type Text2dFontRecoveryController,
  type Text2dFontRecoveryError,
  stepText2d,
} from './text2d';

const FONT_GUID = '019eb276-4d96-7f2c-9ecf-5124a020eebb';
const m34RecoveryMode = new URLSearchParams(globalThis.location.search).has('m34-font-recovery');

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-text2d: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((error: unknown) => {
  if (error instanceof EngineEnvironmentError) console.error('[bevy-text2d] no usable backend:', error);
  else console.error('[bevy-text2d] bootstrap error:', error);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const result = await createApp(
    target,
    import.meta.env.DEV && runtimeBinding !== undefined ? { assetRuntimeBinding: runtimeBinding } : {},
    { ...forgeaxBundlerAdapter(), importTransport: createRuntimeAssetImportTransport(runtimeBinding) },
  );
  if (!result.ok) {
    console.error('[bevy-text2d] createApp failed:', result.error);
    return;
  }

  const app = result.value;
  const assets = app.assets;
  if (assets === undefined) throw new Error('App asset service is unavailable');
  if (assets === undefined) {
    console.error('[bevy-text2d] assets unavailable');
    return;
  }

  const parsed = AssetGuid.parse(FONT_GUID);
  if (!parsed.ok) {
    console.error('[bevy-text2d] FONT_GUID parse failed:', parsed.error.code);
    return;
  }
  const font = await assets.load(parsed.value, 'font');
  if (!font.ok) {
    console.error('[bevy-text2d] font load failed:', font.error.code, font.error.hint);
    return;
  }

  const errors: Text2dFontRecoveryError[] = [];
  app.onError((error) => {
    const structured = error as unknown as Text2dFontRecoveryError & { hint?: string };
    errors.push({
      code: structured.code,
      ...(structured.expected === undefined ? {} : { expected: structured.expected }),
      ...(structured.detail === undefined ? {} : { detail: structured.detail }),
    });
    console.error('[bevy-text2d] app error:', JSON.stringify(error, (_key, value) => value instanceof Error ? Object.fromEntries(Object.getOwnPropertyNames(value).map((key) => [key, Reflect.get(value, key)])) : value));
  });
  const stepRecoveryFrame = async (): Promise<void> => {
    const deadline = performance.now() + 10_000;
    const waitForCredit = async () => {
      while (app.execution.report().frame.inFlight > 0) {
        if (performance.now() >= deadline) throw new Error('Text2d frame receipt did not complete');
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    };
    await waitForCredit();
    const stepped = app.stepFrame(1 / 60);
    if (!stepped.ok) throw stepped.error;
    await waitForCredit();
  };
  let recoveryController: Text2dFontRecoveryController | undefined;
  if (m34RecoveryMode) {
    const recoveryScene = buildText2dFontRecoveryWorld(app.world, assets.read(font.value).unwrap());
    let m34Phase = 0;
    app.world.addSystem(Update, {
      name: 'text2d-m34-frame-keepalive',
      queries: [],
      fn: (world) => {
        world.set(recoveryScene.unrelated, Transform, { pos: [m34Phase, 0, 0] });
        m34Phase += 0.001;
      },
    });
    recoveryController = createText2dFontRecoveryController(
      app.world,
      recoveryScene,
      stepRecoveryFrame,
      () => errors,
    );
  } else {
    const fontHandle: AssetHandle<'font'> = font.value;
    const scene = buildText2dWorld(app.world, fontHandle);
    app.world.addSystem(Update, {
      name: 'text2d-motion',
      queries: [],
      fn: (world) => stepText2d(world, scene, world.hasResource(Time) ? world.getResource(Time).delta : 0),
    });
  }
  console.info(`[bevy-text2d] state=${app.renderer.inspect().state}`);
  const started = app.start();
  if (!started.ok) {
    console.error('[bevy-text2d] app.start failed:', started.error.code, started.error.hint);
    return;
  }
  if (m34RecoveryMode) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const paused = app.pause();
    if (!paused.ok) {
      console.error('[bevy-text2d] M34 pause failed:', paused.error.code, paused.error.hint);
      return;
    }
  }
  const debugGlobal = globalThis as typeof globalThis & {
    __bevyText2dReady?: boolean;
    __prepareText2dCapture?: () => Promise<void>;
    __bevyText2dM34?: Text2dFontRecoveryController;
  };
  if (recoveryController !== undefined) debugGlobal.__bevyText2dM34 = recoveryController;
  debugGlobal.__prepareText2dCapture = async () => {
    if (m34RecoveryMode) {
      await stepRecoveryFrame();
    } else {
      const updated = app.world.update(1 / 60);
      if (!updated.ok) throw updated.error;
    }
  };
  debugGlobal.__bevyText2dReady = true;
}
