// RectAreaLight sourceTexture demo. The panel image lights the floor and is
// reflected by a glossy (left) and a rough (right) metal sphere.
//   ?source=<name> selects the initial emitter image (see SOURCES);
//   the S key cycles through them.

import type { CanvasAppError } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import { DEFAULT_STANDARD_PROFILE } from '@forgeax/engine-render';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { GALLERY } from './images.ts';
import { GALLERY_IMAGES, type PanelSource, populateRectLightTextureWorld } from './scene.ts';

const SOURCES: readonly PanelSource[] = [...GALLERY_IMAGES, 'textured', 'mirrored', 'uniform'];

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('[rect-light-texture] missing <canvas id="app">');

bootstrap(canvas).catch((err: unknown) => {
  console.error('[rect-light-texture] bootstrap error:', err);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appRes = await createApp(
    target,
    { standardProfile: DEFAULT_STANDARD_PROFILE },
    forgeaxBundlerAdapter(),
  );
  if (!appRes.ok) return reportAppError(appRes.error);
  const app = appRes.value;

  const requested = new URL(window.location.href).searchParams.get('source');
  let current = SOURCES.indexOf((requested ?? SOURCES[0]) as PanelSource);
  if (current < 0) current = 0;
  const scene = populateRectLightTextureWorld(
    app.world,
    target.clientWidth / Math.max(target.clientHeight, 1),
    SOURCES[current],
  );
  const hud = document.querySelector('#hud');
  const showSource = (): void => {
    const source = SOURCES[current] ?? 'uniform';
    const entry = source in GALLERY ? GALLERY[source as keyof typeof GALLERY] : undefined;
    const detail = entry ? ` - ${entry.width}x${entry.height} ${entry.encoding}` : '';
    if (hud) hud.textContent = `RectAreaLight sourceTexture: ${source}${detail} (press S to cycle)`;
  };
  showSource();
  window.addEventListener('keydown', (event) => {
    if (event.key !== 's' && event.key !== 'S') return;
    current = (current + 1) % SOURCES.length;
    scene.setSource(SOURCES[current] ?? 'uniform');
    showSource();
  });

  const started = app.start();
  if (!started.ok) reportAppError(started.error);
}

function reportAppError(err: CanvasAppError | EngineEnvironmentError): void {
  if (err instanceof EngineEnvironmentError) {
    console.error(`[rect-light-texture] EngineEnvironmentError: ${err.message}`);
    return;
  }
  console.error(`[rect-light-texture] ${err.code}: ${err.hint}`);
}
