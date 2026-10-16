import { captureCanvasPixels } from '@forgeax/apps-shared/canvas-capture';
import { type App, type CanvasAppError } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import {
  Camera,
  DirectionalLight,
  DirectionalShadowFilterValue,
  DEFAULT_STANDARD_PROFILE,
  type GpuPassTimingObservation,
  type RenderError,
} from '@forgeax/engine-render';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { Transform } from '@forgeax/engine-scene';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import {
  exposeLearnRenderTestApp,
  trackLearnRenderTestBootstrap,
} from '../../../../shared/src/learn-render-test-lifecycle';
import { measureSsao } from './ssao-performance';
import { verifySsaoScene } from './ssao-evidence';
import { spawnSsaoRoom } from './ssao-room';
import { verifySsaoRoom } from './ssao-room-evidence';
import { spawnSsaoScene } from './ssao-scene.ts';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('SSAO example requires canvas#app');
const bootstrapPromise = bootstrap(canvas);
void bootstrapPromise.catch((error: unknown) => console.error('[ssao] bootstrap failed', error));
trackLearnRenderTestBootstrap(bootstrapPromise, canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const params = new URLSearchParams(location.search);
  const enabled = params.get('falsify') !== 'ssao-off';
  const algorithm = params.get('algorithm') === 'gtao' ? 'gtao' : 'ssao';
  const app = (
    await createApp(
      target,
      {
        ...(params.has('timings') ? { gpuPassTiming: {} } : {}),
        standardProfile: {
          ...DEFAULT_STANDARD_PROFILE,
          renderPath: 'deferred',
          ssao: enabled ? { algorithm, radius: 0.5, bias: 0.025, intensity: 1, quality: 'high' } : false,
        },
      },
      forgeaxBundlerAdapter(),
    )
  ).unwrap();
  exposeLearnRenderTestApp(app, target);
  app.onError((error) => window.__learnRenderErrors?.push({ code: error.code, hint: error.hint }));
  const { movingContact, camera } = spawnSsaoScene(app.world, target.width / target.height);
  if (params.get('lift') === '1') app.world.set(movingContact, Transform, { pos: [0, 1, 0] }).unwrap();
  const room = params.get('scene') === 'room' ? spawnSsaoRoom(app.world) : undefined;
  window.addEventListener('resize', () => {
    app.world.set(camera, Camera, { aspect: target.width / Math.max(1, target.height) }).unwrap();
  });
  app.start().unwrap();
  installCaptureHook(app, app.world, target);
  Object.assign(globalThis, {
    __verifySsao: async () => {
      app.pause().unwrap();
      try {
        if (!window.__captureSsao || !window.__advanceSsao)
          throw new Error('Missing SSAO frame/capture hooks');
        const evidence = room === undefined
          ? await verifySsaoScene(app, window.__captureSsao, movingContact)
          : await verifySsaoRoom(app, window.__captureSsao, window.__advanceSsao, room, camera);
        Object.assign(globalThis, { __ssaoEvidence: evidence });
        return evidence;
      } finally {
        app.resume().unwrap();
      }
    },
  });

  Object.assign(globalThis, {
    __measureSsao: async () => {
      app.pause().unwrap();
      try {
        if (!window.__captureSsao) throw new Error('Missing SSAO capture hook');
        const report = await measureSsao(app, window.__captureSsao, () => window.__lastSsaoTiming);
        const evidence = {
          ...report,
          width: target.width,
          height: target.height,
          backend: app.renderer.inspect().capabilities.backendKind,
        };
        Object.assign(globalThis, { __ssaoPerformance: evidence });
        return evidence;
      } finally {
        app.resume().unwrap();
      }
    },
  });
  const controls = document.createElement('aside');
  controls.innerHTML = `<nav><a href="?">Plane + cube</a> · <a href="?scene=room">Room</a></nav><strong>${room ? "Room: AO + soft shadows" : "Plane + cube"}</strong>
    <label><input id="ao-enabled" type="checkbox" ${enabled ? 'checked' : ''}> Ambient occlusion</label>
    <label>Algorithm <select id="ao-algorithm"><option value="ssao" ${algorithm === 'ssao' ? 'selected' : ''}>SSAO</option><option value="gtao" ${algorithm === 'gtao' ? 'selected' : ''}>GTAO</option></select></label>
    <label>Quality <select id="ao-quality"><option>low</option><option>medium</option><option selected>high</option></select></label>
    <label>Radius <input id="ao-radius" type="range" min="0.1" max="1.5" step="0.05" value="0.5"></label>
    <label>Strength <input id="ao-strength" type="range" min="0" max="3" step="0.1" value="1"></label>
    <label>Cube lift <input id="cube-lift" type="range" min="0" max="2" step="0.05" value="0"></label>
    ${room ? '<label>Shadows <select id="shadow-filter"><option value="off">Off</option><option value="pcf3">PCF 3</option><option value="pcf5">PCF 5</option><option value="pcssMedium" selected>PCSS medium</option><option value="pcssHigh">PCSS high</option></select></label><label>Sun angular radius <input id="shadow-radius" type="range" min="0.001" max="0.05" step="0.001" value="0.025"></label>' : ''}
    <small>Toggle AO at the contact edge, then lift the cube. Lights and exposure stay fixed.</small>`;
  document.body.append(controls);
  const input = (id: string) => {
    const element = controls.querySelector<HTMLInputElement>(`#${id}`);
    if (!element) throw new Error(`Missing ${id} control`);
    return element;
  };
  controls.addEventListener('input', () => {
    const quality = controls.querySelector<HTMLSelectElement>('#ao-quality')?.value as
      | 'low'
      | 'medium'
      | 'high';
    app.world
      .set(movingContact, Transform, { pos: [0, Number(input('cube-lift').value), 0] })
      .unwrap();
    const result = app.renderer.setProfile({
      ...app.renderer.inspect().profile,
      ssao: input('ao-enabled').checked
        ? {
            algorithm: controls.querySelector<HTMLSelectElement>('#ao-algorithm')?.value === 'gtao' ? 'gtao' : 'ssao',
            radius: Number(input('ao-radius').value),
            intensity: Number(input('ao-strength').value),
            quality,
          }
        : false,
    });
    if (!result.ok) reportAppError(result.error);
    if (room) {
      const selected = controls.querySelector<HTMLSelectElement>('#shadow-filter')?.value;
      const shadowFilter = selected === 'pcf3' ? DirectionalShadowFilterValue.pcf3
        : selected === 'pcf5' ? DirectionalShadowFilterValue.pcf5
        : selected === 'pcssHigh' ? DirectionalShadowFilterValue.pcssHigh
        : DirectionalShadowFilterValue.pcssMedium;
      app.world.set(room.light, DirectionalLight, {
        castShadow: selected !== 'off', shadowFilter,
        shadowAngularRadius: Number(input('shadow-radius').value),
      }).unwrap();
    }
  });
}

// RHI-debug live-pixel hook for the capture smoke harness (pixel mode). Drives
// one update + draw + canvas capture so the live read is anchored to the same
// frame the capture records. Only meaningful when the page is served with
// FORGEAX_ENGINE_RHI_DEBUG=1; harmless otherwise.
function installCaptureHook(app: App, world: App['world'], canvas: HTMLCanvasElement): void {
  type CaptureHook = () => Promise<Uint8Array>;
  const win = window as unknown as { __captureSsao?: CaptureHook; __advanceSsao?: () => Promise<void> };
  const renderer = app.renderer;
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  const lease = attached.value;
  const advance = async (): Promise<void> => {
    world.update(1 / 60).unwrap();
    const frame = renderer.draw({
      leases: [lease],
      camera: { lease },
      environment: { lease },
    });
    if (!frame.ok) throw frame.error;
    const observed = await renderer.observe(frame.value, {
      include: [
        'draws',
        ...(new URLSearchParams(location.search).has('timings') ? ['timings' as const] : []),
      ],
    });
    if (!observed.ok) throw observed.error;
    Object.assign(globalThis, { __lastSsaoTiming: observed.value.timings });
  };
  win.__advanceSsao = advance;
  win.__captureSsao = async (): Promise<Uint8Array> => {
    await advance();
    const r = await captureCanvasPixels(canvas);
    if (!r.ok) {
      throw new Error(
        `[learn-render 5.9 ssao] canvas capture failed: ${r.error.code} -- ${r.error.hint ?? ''}`,
      );
    }
    return r.value;
  };
}

function reportAppError(err: CanvasAppError | RenderError | EngineEnvironmentError): void {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[learn-render 5.9 ssao] EngineEnvironmentError: webgpu inner=${code}`);
    return;
  }
  console.error(`[learn-render 5.9 ssao] ${err.code}: ${err.hint}`);
}

declare global {
  interface Window {
    __learnRenderErrors?: Array<{ code: string; hint?: string }>;
    __captureSsao?: () => Promise<Uint8Array>;
    __advanceSsao?: () => Promise<void>;
    __lastSsaoTiming?: GpuPassTimingObservation;
  }
}
