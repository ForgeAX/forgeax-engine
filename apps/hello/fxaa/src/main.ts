import { Update } from '@forgeax/engine-ecs';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine-input';
// apps/hello/fxaa -- FXAA real-time comparison demo
// (feat-20260529-fxaa-demo-real-antialiasing-comparison-runtime-tog / M2).
//
// What this demo exercises end-to-end (charter F1 progressive disclosure):
//   - createApp(canvas, opts) -- one-screen takeoff with rAF + auto
//     input-attach + Time resource (feat-20260518-app-shell-game-loop).
//   - HANDLE_SPHERE -- the 4th builtin mesh handle (id=4, radius=1
//     16x12, 12-float interleaved layout, same as HANDLE_CUBE /
//     HANDLE_TRIANGLE / HANDLE_QUAD).
//   - Space toggle runtime: reads InputSnapshot.keyboard.down('Space'),
//     derives a press-edge from prev-frame level tracking, toggles
//     Camera.antialias between ANTIALIAS_NONE and ANTIALIAS_FXAA via
//     world.set(camEntity, Camera, { antialias }). The engine extract
//     stage re-reads antialias every frame (zero engine-side code change).
//   - DOM HUD overlay (charter F2 text over image): #fxaa-hud span
//     updates textContent to "FXAA: ON" / "FXAA: OFF" on every toggle.
//
// Scene: 4 static geometries (triangle + cube + quad + sphere) under a
// single slant-directional light direction ~(-0.4, -0.6, -0.7). All
// geometries are stationary (D-5) so dual-pass smoke can diff cleanly.
//
// Recipe (charter P1 progressive disclosure):
//   (1) createApp(canvas, {}, { shaderManifestUrl }) + spawn Camera with clear* fields
//   (2) define the 5 standard components via defineComponent (globally live)
//   (3) assets.register<MaterialAsset>(standard PBR) -> materialHandle
//   (4) world.spawn 4 geometries, DirectionalLight, Camera (save entity)
//   (5) world.addSystem press-edge toggle + HUD sync
//   (6) app.start()

import { createApp } from '@forgeax/engine-app/browser';
import type { CanvasAppError } from '@forgeax/engine-app';

import { HANDLE_CUBE, HANDLE_QUAD, HANDLE_SPHERE, HANDLE_TRIANGLE } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';

import {
  ANTIALIAS_FXAA,
  ANTIALIAS_NONE,
  Materials,
  TONEMAP_LINEAR,
  perspective,
  type Antialias,
  type Renderer,
} from '@forgeax/engine-render';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer, ShadowParticipation } from '@forgeax/engine-render';

import type { Handle } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import {
  DARK_GRADIENT_FIXTURE,
  resolveDarkGradientBrowserBackend,
  type DarkGradientBackend,
  type DarkGradientRhiBackendKind,
} from './dark-gradient-fixture';
import { createDarkGradientTexture, darkGradientQuad } from '../scripts/dark-gradient-scene.mjs';
import { runMipmapPipelineProbe } from './mipmap-pipeline-probe';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) {
  throw new Error('[fxaa] missing <canvas id="app"> in index.html');
}

type DarkGradientLane = 'direct' | 'clustered';

interface DarkGradientBrowserObservation {
  readonly schema: 'forgeax.dark-gradient-browser-observation/1';
  readonly fixtureId: string;
  readonly lane: DarkGradientLane;
  readonly backendId: DarkGradientBackend;
  readonly actualBackendKind: DarkGradientRhiBackendKind;
  readonly frameId: number;
  readonly observationId: string;
  readonly rendererInspectionRef: string;
  readonly phase: 'none' | 'fxaa';
  readonly sampleFrameCount: number;
  readonly antialias?: Antialias;
  readonly surfaceProfile?: 'dual-view' | 'raw-only';
  readonly rgba16floatRenderable: boolean;
  readonly passNames: readonly string[];
  readonly standardOutputColor?: {
    readonly format: string;
    readonly domain?: string;
    readonly width: number;
    readonly height: number;
    readonly sampleCount: number;
    readonly usage: number;
  };
  readonly surface: {
    readonly storageFormat: string;
    readonly displayFormat: string;
    readonly intermediateFormat: string;
    readonly domain: 'display-encoded' | 'linear';
    readonly endpoint: string;
  };
  readonly presentationProof?: {
    readonly descriptor: boolean;
    readonly acquisition: boolean;
    readonly validation: boolean;
  };
  readonly status: 'ready' | 'insufficient-evidence';
  readonly reason?: string;
}

function readDarkGradientRoute(): DarkGradientLane | undefined {
  const params = new URLSearchParams(globalThis.location.search);
  if (params.get('fixture') !== 'dark-gradient') return undefined;
  const lane = params.get('lane');
  return lane === 'clustered' ? 'clustered' : 'direct';
}

function isMipmapPipelineProbeRoute(): boolean {
  return new URLSearchParams(globalThis.location.search).get('fixture') === 'mipmap-pipeline';
}

function readDarkGradientBackendHint(): DarkGradientBackend | undefined {
  const params = new URLSearchParams(globalThis.location.search);
  const backend = params.get('backend');
  return backend === 'chromium-webgl2' || backend === 'webkit-webgl2' ? backend : undefined;
}

function publishDarkGradientObservation(
  lane: DarkGradientLane,
  frameCount: number,
  phase: 'none' | 'fxaa',
  backendHint: DarkGradientBackend | undefined,
  app: { readonly renderer: Pick<Renderer, 'inspect'> },
): void {
  const inspection = app.renderer.inspect();
  const actualBackendKind = inspection.capabilities.backendKind;
  const backendId = backendHint ?? 'browser-webgpu';
  const resolvedBackend = resolveDarkGradientBrowserBackend(actualBackendKind, backendHint);
  const observation = inspection.observation;
  const passNames = observation.passNames;
  const standardOutputColor = observation.standardOutputColor;
  const missingFacts: string[] = [];
  if (resolvedBackend !== backendId) missingFacts.push('backend-identity');
  if (frameCount < DARK_GRADIENT_FIXTURE.frameCount || observation.frameId < DARK_GRADIENT_FIXTURE.frameCount) {
    missingFacts.push('60-frame-sample');
  }
  if (observation.observationId.length === 0) missingFacts.push('observation-identity');
  if (observation.antialias !== phase) missingFacts.push(`camera-antialias=${phase}`);
  if (phase === 'fxaa') {
    if (observation.surfaceProfile === undefined) missingFacts.push('surface-profile');
    if (actualBackendKind === 'wgpu-webgl2' && observation.surfaceProfile !== 'raw-only') {
      missingFacts.push('webkit-raw-only-surface-profile');
    }
    if (observation.rgba16floatRenderable !== true) missingFacts.push('rgba16float-renderable');
    if (!passNames.includes('output-transform')) missingFacts.push('output-transform-pass');
    if (!passNames.includes('fxaa')) missingFacts.push('fxaa-pass');
    if (standardOutputColor?.format !== 'rgba16float') missingFacts.push('standard-output-color-format');
    if (standardOutputColor?.domain !== 'display-encoded') missingFacts.push('standard-output-color-domain');
  }
  const ready = missingFacts.length === 0;
  const result: DarkGradientBrowserObservation = {
    schema: 'forgeax.dark-gradient-browser-observation/1',
    fixtureId: DARK_GRADIENT_FIXTURE.id,
    lane,
    backendId,
    actualBackendKind,
    frameId: observation.frameId,
    observationId: observation.observationId,
    rendererInspectionRef: `${observation.observationId}:frame-${observation.frameId}`,
    phase,
    sampleFrameCount: DARK_GRADIENT_FIXTURE.frameCount,
    ...(observation.antialias === undefined ? {} : { antialias: observation.antialias }),
    ...(observation.surfaceProfile === undefined ? {} : { surfaceProfile: observation.surfaceProfile }),
    rgba16floatRenderable: observation.rgba16floatRenderable === true,
    passNames: Object.freeze([...passNames]),
    ...(standardOutputColor === undefined
      ? {}
      : { standardOutputColor: Object.freeze({ ...standardOutputColor }) }),
    surface: {
      storageFormat: inspection.output.surfaceStorage,
      displayFormat: inspection.output.surfaceDisplay,
      intermediateFormat: inspection.output.intermediateFormat ?? '',
      domain: inspection.output.displayEncoded ? 'display-encoded' : 'linear',
      endpoint: inspection.output.endpoint,
    },
    ...(inspection.output.presentationProof === undefined
      ? {}
      : { presentationProof: inspection.output.presentationProof }),
    status: ready ? 'ready' : 'insufficient-evidence',
    ...(ready
      ? {}
      : {
          reason: resolvedBackend !== backendId
            ? `backend identity mismatch: actual=${actualBackendKind}, provider=${backendId}, hint=${backendHint ?? '<none>'}`
            : `missing observation facts: ${missingFacts.join(', ')}`,
        }),
  };
  const host = globalThis as typeof globalThis & {
    __forgeaxDarkGradientObservation?: DarkGradientBrowserObservation;
    __forgeaxDarkGradientObservations?: Partial<Record<'none' | 'fxaa', DarkGradientBrowserObservation>>;
    __forgeaxDarkGradientArmCapture?: (request: {
      readonly phase: 'none' | 'fxaa';
      readonly engineFrameId: number;
      readonly observationId?: string;
    }) => void;
  };
  host.__forgeaxDarkGradientObservation = Object.freeze(result);
  host.__forgeaxDarkGradientObservations = Object.freeze({
    ...host.__forgeaxDarkGradientObservations,
    [phase]: Object.freeze(result),
  });
}

function publishDarkGradientRuntimeEvent(
  event: Readonly<Record<string, unknown>>,
): void {
  console.debug(`__forgeaxDarkGradientRuntime:${JSON.stringify(event)}`);
}

function projectRendererCause(cause: unknown): Record<string, unknown> | null {
  if (cause === null || typeof cause !== 'object') return null;
  const value = cause as {
    readonly code?: unknown;
    readonly expected?: unknown;
    readonly hint?: unknown;
    readonly detail?: unknown;
  };
  return {
    code: value.code ?? null,
    expected: value.expected ?? null,
    hint: value.hint ?? null,
    detail: value.detail ?? null,
  };
}

function projectRendererError(error: unknown): Record<string, unknown> | null {
  if (error === null || typeof error !== 'object') return null;
  const value = error as {
    readonly code?: unknown;
    readonly expected?: unknown;
    readonly hint?: unknown;
    readonly detail?: {
      readonly operation?: unknown;
      readonly frameId?: unknown;
      readonly deviceGeneration?: unknown;
      readonly cause?: unknown;
    };
  };
  const detail = value.detail;
  return {
    code: value.code ?? null,
    expected: value.expected ?? null,
    hint: value.hint ?? null,
    detail: {
      operation: detail?.operation ?? null,
      frameId: detail?.frameId ?? null,
      deviceGeneration: detail?.deviceGeneration ?? null,
      cause: projectRendererCause(detail?.cause),
    },
  };
}

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[fxaa] EngineEnvironmentError: webgpu inner=${code}`);
  } else {
    console.error('[fxaa] bootstrap error:', err);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  if (isMipmapPipelineProbeRoute()) {
    target.width = 4;
    target.height = 4;
    await runMipmapPipelineProbe(target);
    return;
  }
  // Step 1: createApp(canvas, opts) -- one-screen takeoff.
  const darkGradientLane = readDarkGradientRoute();
  const darkGradientBackendHint = readDarkGradientBackendHint();
  if (darkGradientLane !== undefined) {
    target.width = DARK_GRADIENT_FIXTURE.resolution.width;
    target.height = DARK_GRADIENT_FIXTURE.resolution.height;
  }
  const appRes = await createApp(
    target,
    {},
    forgeaxBundlerAdapter(),
  );
  if (!appRes.ok) {
    reportAppError(appRes.error);
    return;
  }
  const app = appRes.value;
  console.warn(`[fxaa] backend=${app.renderer.inspect().capabilities.backendKind}`);
  if (darkGradientLane !== undefined) {
    app.renderer.subscribe((event) => {
      const inspection = app.renderer.inspect();
      const backendId = darkGradientBackendHint ?? 'browser-webgpu';
      const base = {
        actualBackendKind: inspection.capabilities.backendKind,
        pixelSourceMethod: backendId === 'browser-webgpu'
          ? 'gpu-raw-readback'
          : backendId === 'chromium-webgl2' ? 'chromium-compositor-rgba8' : 'webkit-compositor-rgba8',
        configureUsageBefore: backendId === 'browser-webgpu' ? undefined : 0x10,
        configureUsageAfter: backendId === 'browser-webgpu' ? undefined : 0x10,
        surfaceIdentity: inspection.output.presentationProof?.surfaceIdentity ?? inspection.output.endpoint,
        presentationProof: inspection.output.presentationProof ?? null,
      };
      if (event.kind === 'frame-submitted') {
        publishDarkGradientRuntimeEvent({
          ...base,
          lastSuccessfulLifecyclePhase: 'frame-submitted',
          frameId: event.frameId,
          deviceGeneration: event.deviceGeneration,
        });
        return;
      }
      if (event.kind === 'error') {
        const rendererError = projectRendererError(event.error);
        if (rendererError !== null) {
          const detail = rendererError.detail as {
            readonly frameId?: unknown;
            readonly deviceGeneration?: unknown;
          };
          publishDarkGradientRuntimeEvent({
            ...base,
            rendererError,
            frameId: detail.frameId,
            deviceGeneration: detail.deviceGeneration,
          });
        }
      }
    });
    const inspection = app.renderer.inspect();
    publishDarkGradientRuntimeEvent({
      actualBackendKind: inspection.capabilities.backendKind,
      pixelSourceMethod: inspection.capabilities.backendKind === 'webgpu'
        ? 'gpu-raw-readback'
        : darkGradientBackendHint === 'chromium-webgl2'
          ? 'chromium-compositor-rgba8'
          : 'webkit-compositor-rgba8',
      configureUsageBefore: inspection.capabilities.backendKind === 'webgpu' ? undefined : 0x10,
      configureUsageAfter: inspection.capabilities.backendKind === 'webgpu' ? undefined : 0x10,
      surfaceIdentity: inspection.output.presentationProof?.surfaceIdentity ?? inspection.output.endpoint,
      presentationProof: inspection.output.presentationProof ?? null,
      lastSuccessfulLifecyclePhase: 'renderer-created',
    });
  }


  const world = app.world;
  let darkGradientFrameCount = 0;

  // Step 3: register the 5 standard components.

  // Step 4: spawn 4 static geometries (triangle + cube + quad + sphere).
  // Layout: 4 bodies spread horizontally so edges stay visible and
  // aliasing is obvious in the ANTIALIAS_NONE state (PI-3). Each
  // body is scaled to 0.5 to fit all 4 in view without overlap.
  const LAYOUT: readonly {
    readonly handle: Handle<'MeshAsset', 'shared'>;
    readonly pos: readonly [number, number, number];
  }[] = [
    { handle: HANDLE_TRIANGLE, pos: [-1.05, 0, 0]},
    { handle: HANDLE_CUBE, pos: [-0.35, 0, 0]},
    { handle: HANDLE_QUAD, pos: [0.35, 0, 0]},
    { handle: HANDLE_SPHERE, pos: [1.05, 0, 0]},
  ];
  if (darkGradientLane === undefined) {
    // Default demo material stays outside the dedicated dark-gradient scene.
    const materialHandle = world.allocSharedRef('MaterialAsset', {
      kind: 'material',
      passes: [
        { name: 'Forward', program: { module: 'forgeax::default-standard-pbr' }, renderState: { tags: { LightMode: 'Forward' }, queue: 2000 } },
      ],
      values: {
        baseColor: [0.7, 0.7, 0.7],
        metallic: 0.0,
        roughness: 0.4,
      },
    });
    for (const slot of LAYOUT) {
      world.spawn(
        {
          component: Transform,
          data: {
            pos: slot.pos,
            quat: [0, 0, 0, 1],
            scale: [0.5, 0.5, 0.5],
          },
        },
        { component: MeshFilter, data: { assetHandle: slot.handle } },
        { component: MeshRenderer, data: { materials: [materialHandle] } },
      ).unwrap();
    }
  }

  if (darkGradientLane !== undefined) {
    const gradientTexture = world.allocSharedRef('TextureAsset', createDarkGradientTexture());
    const gradientMaterial = world.allocSharedRef('MaterialAsset', Materials.standard({
      baseColor: [1, 1, 1, 1],
      baseColorTexture: gradientTexture,
      metallic: 0,
      roughness: 1,
      renderState: { cullMode: 'none' },
    }));
    const gradientQuad = darkGradientQuad();
    world.spawn(
      { component: Transform, data: { pos: gradientQuad.position, scale: gradientQuad.scale } },
      { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
      { component: MeshRenderer, data: { materials: [gradientMaterial] } },
      { component: ShadowParticipation, data: { cast: false, receive: true } },
    ).unwrap();
  }

  // Step 5: spawn directional light with slant direction.
  world.spawn({
    component: DirectionalLight,
    data: {
      direction: DARK_GRADIENT_FIXTURE.scene.lightDirection,
      color: [1, 1, 1],
      intensity: DARK_GRADIENT_FIXTURE.scene.lightIntensity,
    },
  }).unwrap();

  // Step 6: spawn camera starting at ANTIALIAS_NONE (OFF by default).
  // Save the entity handle so the toggle system (w7) can call world.set.
  const camEntity = world.spawn(
    {
      component: Transform,
      data: { pos: DARK_GRADIENT_FIXTURE.camera.position },
    },
    {
      component: Camera,
      data: {
        ...perspective({
          fov: DARK_GRADIENT_FIXTURE.camera.fovRadians,
          aspect: DARK_GRADIENT_FIXTURE.camera.aspect,
        }),
        clearColor: DARK_GRADIENT_FIXTURE.scene.clearColor,
        ...(darkGradientLane === undefined ? {} : { tonemap: TONEMAP_LINEAR }),
        antialias: ANTIALIAS_NONE,
      },
    },
  ).unwrap();

  // Step 7: Space-key press-edge toggle system.
  // InputSnapshot has only down (held-level) / up (release-edge), no
  // justPressed (D-6 F-1), so the demo tracks prev-frame level to derive
  // a false->true press edge (PD-2 / PI-2). The closure keeps prevSpace
  // and currentAntialias as local state -- no ECS resource needed
  // (charter P1: single-file readability).
  let prevSpace = false;
  let currentAntialias: number = ANTIALIAS_NONE;

  // HUD element (charter F2 text over image): #fxaa-hud span mirrors
  // the Camera.antialias value so AI users can read state from DOM.
  const hudEl = document.getElementById('fxaa-hud');

  world.addSystem(Update, {
    name: 'fxaa-space-toggle',
    after: ['input-frame-start-scan'],
    queries: [],
    fn: () => {
      const snap = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
      if (snap === undefined) return;

      // InputSnapshot.keyboard matches KeyboardEvent.key (browser backend
      // stores ev.key), so the spacebar is the literal ' ' -- NOT 'Space'
      // (that is ev.code). See packages/input/src/input-snapshot.ts down() doc.
      const cur = snap.keyboard.down(' ');
      if (cur && !prevSpace) {
        // Press edge: toggle antialias.
        const target =
          currentAntialias === ANTIALIAS_FXAA ? ANTIALIAS_NONE : ANTIALIAS_FXAA;
        const setRes = world.set(camEntity, Camera, { antialias: target });
        if (setRes.ok) {
          currentAntialias = target;
          if (hudEl) {
            hudEl.textContent =
              target === ANTIALIAS_FXAA ? 'FXAA: ON' : 'FXAA: OFF';
          }
        } else {
          // Surface the failure rather than silently dropping the toggle
          // (charter P3: an empty signal must not masquerade as success).
          console.error('[fxaa] toggle world.set failed:', setRes.error.code);
        }
      }
      prevSpace = cur;
    },
  });

  if (darkGradientLane !== undefined) {
    world.addSystem(Update, {
      name: 'dark-gradient-observation-publish',
      after: ['fxaa-space-toggle'],
      queries: [],
      fn: () => {
        darkGradientFrameCount += 1;
        if (darkGradientFrameCount === DARK_GRADIENT_FIXTURE.frameCount) {
          const host = globalThis as typeof globalThis & {
            __forgeaxDarkGradientArmCapture?: (request: {
              readonly phase: 'none' | 'fxaa';
              readonly engineFrameId: number;
              readonly observationId?: string;
            }) => void;
          };
          host.__forgeaxDarkGradientArmCapture?.({ phase: 'none', engineFrameId: darkGradientFrameCount });
          queueMicrotask(() => publishDarkGradientObservation(darkGradientLane, darkGradientFrameCount, 'none', darkGradientBackendHint, app));
        }
        if (darkGradientFrameCount === DARK_GRADIENT_FIXTURE.frameCount * 2) {
          const host = globalThis as typeof globalThis & {
            __forgeaxDarkGradientArmCapture?: (request: {
              readonly phase: 'none' | 'fxaa';
              readonly engineFrameId: number;
              readonly observationId?: string;
            }) => void;
          };
          host.__forgeaxDarkGradientArmCapture?.({ phase: 'fxaa', engineFrameId: darkGradientFrameCount });
          queueMicrotask(() => publishDarkGradientObservation(darkGradientLane, darkGradientFrameCount, 'fxaa', darkGradientBackendHint, app));
        }
      },
    });
  }

  // Step 8: arm the rAF loop.
  const startRes = app.start();
  if (!startRes.ok) {
    reportAppError(startRes.error);
    return;
  }
  console.warn('[fxaa] running. Press Space to toggle FXAA.');
}

function reportAppError(err: CanvasAppError | EngineEnvironmentError): void {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[fxaa] EngineEnvironmentError: webgpu inner=${code}`);
    return;
  }
  console.error(`[fxaa] ${err.code}: ${err.hint}`);
}
