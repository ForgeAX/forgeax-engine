import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import type { App } from '@forgeax/engine/app';
import { createApp } from '@forgeax/engine/app/browser';
import { createPrimitiveMesh } from '@forgeax/engine/geometry';
import { spawnCamera, spawnMesh, spawnSun, standard } from '../../../lab/stage';

export type Webgl2App =
  | { readonly ok: true; readonly app: App }
  | { readonly ok: false; readonly reason: string };

/**
 * The lab page boots its main App on the default backend chain; the wgpu lane needs
 * `ensureReady()` before construction, so these probes build a second App on a
 * hidden canvas with an explicit `rhi`.
 */
export async function bootWebgl2App(): Promise<Webgl2App> {
  try {
    const backend = await import('@forgeax/engine/rhi-wgpu');
    await backend.ensureReady();
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    canvas.style.cssText =
      'position:fixed;right:8px;bottom:8px;width:160px;height:90px;border:1px solid #888';
    document.body.appendChild(canvas);
    const created = await createApp(canvas, { rhi: backend.rhi }, forgeaxBundlerAdapter());
    if (!created.ok)
      return {
        ok: false,
        reason: `createApp failed: ${String((created.error as { code?: unknown }).code ?? created.error)}`,
      };
    const app = created.value;
    const assets = app.assets;
    if (assets === undefined) throw new Error('App asset service is unavailable');
    const stageCube = assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();

    spawnCamera(app.world, { eye: [0, 1.5, 4], target: [0, 0.5, 0] });
    spawnSun(app.world);
    spawnMesh(app.world, stageCube, standard(app.world, { baseColor: [1, 0.2, 0.1, 1] }), {
      pos: [0, 0.5, 0],
    });
    const started = app.start();
    if (!started.ok) return { ok: false, reason: `app.start failed: ${started.error.code}` };
    return { ok: true, app };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }
}

/** Resolves after `count` frame submissions of `app`, or after a timeout. */
export function submittedFrames(app: App, count: number, timeoutMs = 8000): Promise<number> {
  return new Promise((resolve) => {
    let seen = 0;
    const timer = setTimeout(() => {
      stop();
      resolve(seen);
    }, timeoutMs);
    const stop = app.renderer.subscribe((event) => {
      if (event.kind !== 'frame-submitted') return;
      seen += 1;
      if (seen >= count) {
        clearTimeout(timer);
        stop();
        resolve(seen);
      }
    });
  });
}
