import { World } from '@forgeax/engine-ecs';
import { createApp } from '@forgeax/engine-app/browser';
import { buildFogWorld, type FogDemoPhase, type FogPhase } from './fog.js';

declare global {
  var __bevyFogBrowser:
    | {
      readonly ready: boolean;
        applyPhase(phase: FogPhase): {
          readonly changedFrom: FogPhase | undefined;
          readonly revision: number;
          readonly ownerChanged: boolean;
          readonly resourceOwner: number;
        };
        setPhase(phase: FogDemoPhase): {
          readonly changedFrom: FogPhase | undefined;
          readonly revision: number;
          readonly ownerChanged: boolean;
          readonly resourceOwner: number;
        };
        currentPhase(): FogDemoPhase;
        resize(width: number, height: number): void;
        health(): { readonly reason: string };
        recover(): Promise<
          | { readonly ok: true }
          | { readonly ok: false; readonly error: { readonly code: string; readonly hint?: string } }
        >;
        readback(): Promise<
          | { readonly ok: true; readonly pixels: number[]; readonly width: number; readonly height: number }
          | { readonly ok: false; readonly error: { readonly code: string; readonly hint?: string } }
        >;
      }
    | undefined;
}

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-fog: missing <canvas id="app"> in index.html');

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(
    target,
    {},
  );
  if (!appResult.ok) {
    console.error('[bevy-fog] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  const fog = buildFogWorld(app.world, target.width / Math.max(target.height, 1));
  const resourceWorld = new World();
  let resourceOwner = 0;
  app.setDrawSource(() => ({
    worlds: [app.world, resourceWorld],
    cameraOwner: 0,
    resourceOwner,
  }));
  app.onError((error) => console.error('[bevy-fog] app error:', error.code, error.hint));
  const started = app.start();
  if (!started.ok) {
    console.error('[bevy-fog] app.start failed:', started.error);
    return;
  }

  let activeDemoPhase: Exclude<FogDemoPhase, 'disabled'> = 'height';
  const phaseLabel: Record<FogDemoPhase, string> = {
    disabled: 'FOG: OFF',
    uniform: 'FOG: UNIFORM',
    height: 'FOG: HEIGHT',
  };
  const status = document.querySelector<HTMLElement>('[data-fog-status]');
  const primaryButton = document.querySelector<HTMLButtonElement>('[data-fog-toggle]');
  const phaseButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-fog-phase]'),
  );
  const updateFogUi = (phase: FogDemoPhase): void => {
    if (status) status.textContent = phaseLabel[phase];
    for (const button of phaseButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.fogPhase === phase));
    }
    if (primaryButton) primaryButton.setAttribute('aria-pressed', String(phase !== 'disabled'));
  };
  const setDemoPhase = (phase: FogDemoPhase): void => {
    if (phase !== 'disabled') activeDemoPhase = phase;
    fog.setPhase(phase);
    updateFogUi(phase);
  };
  const toggleFog = (): void => {
    const phase = fog.currentPhase() === 'disabled' ? activeDemoPhase : 'disabled';
    setDemoPhase(phase);
  };
  for (const button of phaseButtons) {
    button.addEventListener('click', () => {
      const phase = button.dataset.fogPhase;
      if (phase === 'disabled' || phase === 'uniform' || phase === 'height') setDemoPhase(phase);
    });
  }
  primaryButton?.addEventListener('click', toggleFog);
  window.addEventListener('keydown', (event) => {
    if (event.key === 'f' || event.key === 'F') toggleFog();
    else if (event.key === '1') setDemoPhase('disabled');
    else if (event.key === '2') setDemoPhase('uniform');
    else if (event.key === '3') setDemoPhase('height');
  });
  updateFogUi('height');

  globalThis.__bevyFogBrowser = {
    ready: true,
    applyPhase(phase) {
      const state = fog.applyPhase(phase, phase === 'owner-switch' ? resourceWorld : undefined);
      if (state.ownerChanged) resourceOwner = 1;
      return { ...state, resourceOwner };
    },
    setPhase(phase) {
      const state = fog.setPhase(phase);
      if (phase !== 'disabled') activeDemoPhase = phase;
      updateFogUi(phase);
      return { ...state, resourceOwner };
    },
    currentPhase() {
      const phase = fog.currentPhase();
      return phase === 'disabled' || phase === 'uniform' || phase === 'height'
        ? phase
        : activeDemoPhase;
    },
    resize(width, height) {
      target.width = Math.max(1, Math.floor(width));
      target.height = Math.max(1, Math.floor(height));
      fog.resize(target.width / target.height);
    },
    health() {
      const state = app.renderer.state();
      return {
        reason:
          state === 'device-lost'
            ? 'device-lost'
            : state === 'faulted'
              ? 'internal-fault'
              : state === 'disposed'
                ? 'disposed'
                : 'alive',
      };
    },
    async recover() {
      const result = await app.renderer.recover();
      if (!result.ok) {
        return { ok: false, error: { code: result.error.code, hint: result.error.hint } };
      }
      const recoveredWidth = target.width;
      const recoveredHeight = target.height;
      target.width = recoveredWidth;
      target.height = recoveredHeight;
      fog.resize(recoveredWidth / Math.max(recoveredHeight, 1));
      return { ok: true };
    },
    async readback() {
      const dataUrl = target.toDataURL('image/png');
      const response = await fetch(dataUrl);
      const bitmap = await createImageBitmap(await response.blob());
      const readbackCanvas = document.createElement('canvas');
      readbackCanvas.width = bitmap.width;
      readbackCanvas.height = bitmap.height;
      const context = readbackCanvas.getContext('2d');
      if (context === null) return { ok: false, error: { code: 'browser-readback-unavailable' } };
      context.drawImage(bitmap, 0, 0);
      const width = bitmap.width;
      const height = bitmap.height;
      const pixels = Array.from(context.getImageData(0, 0, width, height).data);
      bitmap.close();
      return { ok: true, pixels, width, height };
    },
  };
}

bootstrap(canvas).catch((error: unknown) => {
  console.error('[bevy-fog] bootstrap error:', error);
});
