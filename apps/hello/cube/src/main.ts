// apps/hello/cube - ECS-driven binding exemplar (M4 RHI canvas-context migration).
//
// shadingModel routing (feat-20260518-pbr-direct-lighting-mvp / w24 / AC-13;
// feat-20260523 M8-T03 doc refresh: StandardMaterialAsset retired in favour
// of the schema-driven register API):
//   `populateDemoWorld` spawns the cube with `MeshRenderer { data: {} }` — the
//   empty material handle drops through render-system-extract.ts case B fallback
//   to `defaultMaterialSnapshot()` (mid-grey, `shadingModel: 'unlit'`). The
//   demo intentionally does NOT register a PBR material; basic-primitive demos
//   like hello-cube belong on the unlit pipeline (no DirectionalLight coupling
//   required). For an explicit `MaterialAsset { shadingModel: 'unlit' }`
//   register-and-bind exemplar see `apps/learn-render/1.getting-started/4.textures/src/index.ts`;
//   for the flagship schema-driven GGX-PBR + DirectionalLight pairing (built
//   via `assetRegistry.registerMaterialAsset({ materialShader:
//   'forgeax::default-standard-pbr', ... })`) see `apps/hello/room/src/main.ts`.
//
// Four-step recipe AI users discover via @forgeax/engine-runtime
// (charter proposition 1 progressive disclosure):
//   (1) import component schemas + the host AssetRegistry.
//   (2) world.spawn(...) cube + Camera + DirectionalLight.
//   (3) await host initialization (D-S3 manifest -> pipeline -> assets serial).
//   (4) raf -> renderer.draw(world) (D-S2 RenderSystem internal phase).
//
// M4 RHI canvas-context migration (feat-20260510-rhi-resource-creation /
// w28): the previous D-S1 single-point escape hatch
// (`_internal_getRawDevice`) is replaced with the M3-shipped RHI
// canvas-context abstraction. The shim translates the forgeax RhiDevice
// brand passed to `canvasContext.configure({ device, ... })` into the
// underlying raw GPUDevice via RAW_DEVICE_MAP so the spec
// `GPUCanvasContext.configure({ device })` slot still receives a valid
// raw device handle while AI-user-facing code only sees the forgeax
// abstraction (charter proposition 5 consistent abstraction red line).
//
// The canonical 3-entity demo World (cube + camera + directional light)
// is shared with apps/inspector-demo via apps/shared/src/populate-demo-world.ts
// (feat-20260514-ci-jscpd-duplication-gate M3 T-014 / clone #2 path-A cash-out).

import type { CanvasAppError } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import { ok } from '@forgeax/engine-rhi';
import * as rhiWebgpu from '@forgeax/engine-rhi-webgpu';
import { Name } from '@forgeax/engine-scene';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { populateDemoWorld } from '../../../shared/src/populate-demo-world';

// feat-20260617-rhi-debug-layered-browser-capture M4 / w22 + w25: hello-cube
// bootstraps via createApp(canvas, {}, bundler) -- the canvas form owns the
// renderer + World + rAF driver + canvasContext.configure internally, and is
// the form that mounts globalThis.__forgeax.captureFrame(n) under
// FORGEAX_ENGINE_RHI_DEBUG=1 (create-app.ts guard, M3). The dev RHI-debug
// browser e2e (scripts/smoke-browser.mjs) drives that affordance. The prior
// createRenderer + acquireCanvasContext escape-hatch exemplar now lives in
// apps/hello/triangle; hello-cube keeps its role as the ECS binding +
// Name-component exemplar through populateDemoWorld + the Name round-trip below.
const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('hello-cube: missing <canvas id="app"> in index.html');

const deviceLossProbe = new URLSearchParams(location.search).has('m7-device-loss');
let adapterRequestCount = 0;
let deviceRequestCount = 0;
let deviceRefusalCount = 0;
let deviceRefusalRemaining = 0;
const browserRhi = deviceLossProbe ? rhiWebgpu : undefined;
if (browserRhi !== undefined) {
  const requestAdapter = browserRhi.rhi.requestAdapter;
  browserRhi.rhi.requestAdapter = async (
    ...args: Parameters<typeof browserRhi.rhi.requestAdapter>
  ): ReturnType<typeof browserRhi.rhi.requestAdapter> => {
    adapterRequestCount += 1;
    const adapterResult = await requestAdapter(...args);
    if (!adapterResult.ok) return adapterResult;
    const adapter = adapterResult.value;
    return ok({
      ...adapter,
      requestDevice: async (
        ...deviceArgs: Parameters<typeof adapter.requestDevice>
      ): ReturnType<typeof adapter.requestDevice> => {
        deviceRequestCount += 1;
        if (deviceRefusalRemaining > 0) {
          deviceRefusalRemaining -= 1;
          deviceRefusalCount += 1;
          throw new Error('M7 controlled transient requestDevice refusal');
        }
        return adapter.requestDevice(...deviceArgs);
      },
    });
  };
}

const app = await createApp(
  canvas,
  deviceLossProbe ? { silenceUnhandledErrors: true } : {},
  forgeaxBundlerAdapter(),
);
if (!app.ok) {
  reportError(app.error);
} else {
  const world = app.value.world;
  if (app.value.assets === undefined) throw new Error('Demo requires the host AssetRegistry');
  populateDemoWorld(world, app.value.assets);

  // M7 browser/driver device-loss probe. Keep this opt-in so the normal Hello
  // Cube surface remains unchanged; the probe still calls only public Renderer
  // health/recover methods and observes the same World instance.
  const renderer = app.value.renderer;
  const identityIds = new WeakMap<object, number>();
  let nextIdentityId = 1;
  const identityOf = (value: object): number => {
    const existing = identityIds.get(value);
    if (existing !== undefined) return existing;
    const identity = nextIdentityId++;
    identityIds.set(value, identity);
    return identity;
  };
  const cpuScene = () => {
    const inspection = world.inspect();
    const query = world.query({});
    if (!query.ok) throw new Error(`M7 CPU scene query failed: ${query.error.code}`);
    return {
      entityCount: inspection.entityCount,
      entityHandles: Array.from(query.value, (row) => row.entity as number),
      activeComponents: [...inspection.activeComponents],
    };
  };
  const healthTransitions: unknown[] = [];
  const deviceLossErrors: Array<{ readonly code: string; readonly hint: string }> = [];
  if (deviceLossProbe) {
    renderer.subscribe((event) => {
      if (event.kind === 'state-changed') {
        healthTransitions.push({ state: event.current, previous: event.previous });
      }
      if (event.kind === 'error') {
        const detail = (event.error as unknown as { readonly detail?: unknown }).detail;
        const cause =
          detail !== null && typeof detail === 'object' && 'cause' in detail
            ? (detail as { readonly cause?: unknown }).cause
            : undefined;
        if (
          cause !== null &&
          typeof cause === 'object' &&
          (cause as { readonly code?: unknown }).code === 'device-lost'
        ) {
          deviceLossErrors.push({
            code: 'device-lost',
            hint: String((cause as { readonly hint?: unknown }).hint ?? ''),
          });
        }
      }
    });
  }

  const attached = renderer.attach(world);
  if (!attached.ok) throw new Error(`hello-cube: attach failed: ${attached.error.code}`);
  const lease = attached.value;

  // feat-20260515-ecs-name-component-and-string-schema M3 / w3-hello-cube-app
  // (AC-14): canonical Name + 'string' schema vocab end-to-end exemplar. AI
  // users discover the round-trip via `rg "Name { value:" apps/hello/cube` --
  // spawn + read + mutate + despawn, driven before app.start() so the
  // BufferPool 3-path release is observable independent of the frame loop.
  const player = world.spawn({ component: Name, data: { value: 'Player' } as never }).unwrap();
  const initialName = world.get(player, Name).unwrap().value;
  void initialName;
  world.set(player, Name, { value: 'Boss' } as never).unwrap();
  const mutatedName = world.get(player, Name).unwrap().value;
  void mutatedName;
  world.despawn(player).unwrap();

  app.value.start();
  if (deviceLossProbe) {
    Object.assign(globalThis, {
      __forgeaxM7DeviceRecovery: {
        health: () => renderer.inspect().state,
        recover: async () => {
          const result = await renderer.recover();
          return result.ok
            ? result
            : (() => {
                const detail = 'detail' in result.error ? result.error.detail : undefined;
                return {
                  ok: false,
                  error: {
                    name: result.error.name,
                    code: result.error.code,
                    expected: result.error.expected,
                    hint: result.error.hint,
                    detail,
                  },
                };
              })();
        },
        state: () => ({
          health: renderer.inspect().state,
          worldIdentity: identityOf(world),
          rendererIdentity: identityOf(renderer),
          deviceIdentity: renderer.inspect().frame.deviceGeneration,
          cpu: cpuScene(),
          adapterRequestCount,
          deviceRequestCount,
          deviceRefusalCount,
          deviceRefusalRemaining,
          deviceLossError: deviceLossErrors.at(-1),
        }),
        armDeviceRefusal: () => {
          deviceRefusalRemaining = 1;
        },
        clearDeviceRefusal: () => {
          deviceRefusalRemaining = 0;
        },
        pause: () => app.value.pause(),
        stepFrame: () => app.value.stepFrame(1 / 60),
        disposeTwice: () => {
          app.value.stop();
          renderer.dispose();
          renderer.dispose();
          return { ok: true };
        },
        entityCount: () => world.inspect().entityCount,
        healthTransitions: () => healthTransitions.slice(),
        debug: () => ({ rhiCaptureAvailable: app.value.rhiCapture !== undefined }),
        drawOnce: () => {
          const result = renderer.draw({
            leases: [lease],
            camera: { lease },
            environment: { lease },
          });
          return result.ok
            ? result
            : (() => {
                const detail = 'detail' in result.error ? result.error.detail : undefined;
                return {
                  ok: false,
                  error: {
                    name: result.error.name,
                    code: result.error.code,
                    expected: result.error.expected,
                    hint: result.error.hint,
                    detail,
                  },
                };
              })();
        },
      },
    });
  }
}

function reportError(err: CanvasAppError): void {
  if (err instanceof EngineEnvironmentError) {
    console.error('[cube] no usable backend:', err);
    return;
  }
  console.error(`[cube] ${err.code}: ${err.hint}`);
}
