/// <reference types="vite/client" />

// LearnOpenGL section 6.4 carrier: one Engine App, one Renderer, and one
// Standard-material scene exercising transmission, refraction, MASK, and a
// normal BLEND consumer. The transmission pipe owns the backdrop and temporal
// work; this app only authors materials and ECS entities.

declare module 'virtual:forgeax/bundler' {
  export function forgeaxBundlerAdapter(): {
    readonly shaderManifestUrl: string;
    readonly importTransport?: undefined;
  };
}

import { captureCanvasPixels } from '@forgeax/apps-shared/canvas-capture';
import { createApp } from '@forgeax/engine-app/browser';
import type { App, CanvasAppError } from '@forgeax/engine-app';
import { World } from '@forgeax/engine-ecs';
import { createPlaneGeometry, createSphereGeometry } from '@forgeax/engine-geometry';
import { Camera, DirectionalLight, Materials, MeshFilter, MeshRenderer, perspective, TONEMAP_LINEAR } from '@forgeax/engine-render';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { Transform } from '@forgeax/engine-scene';
import type { Handle, MaterialAsset } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import {
  exposeLearnRenderTestApp,
  trackLearnRenderTestBootstrap,
} from '../../../../shared/src/learn-render-test-lifecycle';

const WIDTH = 512;
const HEIGHT = 512;
const SPHERE_RADIUS = 0.78;
const SPACING = 1.72;

const ALPHA_BLEND = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
} as const;

type TransmissionOptions = Parameters<typeof Materials.standard>[0] & {
  readonly transmission?: number;
  readonly transmissionTexture?: unknown;
  readonly ior?: number;
  readonly thickness?: number;
  readonly thicknessTexture?: unknown;
  readonly attenuationColor?: readonly [number, number, number];
  readonly attenuationDistance?: number;
};

// The transmission pipe is landing beside this consumer. Keep the consumer
// source valid against the pre-pipe workspace while passing the exact Standard
// option shape through unchanged once the engine package is integrated.
const standardWithTransmission = Materials.standard as unknown as (
  options: TransmissionOptions,
) => MaterialAsset;

interface TransmissionCase {
  readonly id: 'smooth' | 'rough' | 'color' | 'thick' | 'MASK';
  readonly label: string;
  readonly baseColor: readonly [number, number, number, number];
  readonly roughness: number;
  readonly transmission: number;
  readonly ior: number;
  readonly thickness: number;
  readonly attenuationColor: readonly [number, number, number];
  readonly attenuationDistance: number;
  readonly queue?: number;
  readonly alphaCutoff?: number;
}

const TRANSMISSION_CASES: readonly TransmissionCase[] = [
  {
    id: 'smooth',
    label: 'smooth',
    baseColor: [0.76, 0.9, 1, 1],
    roughness: 0.06,
    transmission: 1,
    ior: 1.45,
    thickness: 0.12,
    attenuationColor: [0.9, 0.97, 1],
    attenuationDistance: 3,
  },
  {
    id: 'rough',
    label: 'rough',
    baseColor: [0.72, 0.85, 0.98, 1],
    roughness: 0.72,
    transmission: 1,
    ior: 1.5,
    thickness: 0.2,
    attenuationColor: [0.8, 0.9, 1],
    attenuationDistance: 2,
  },
  {
    id: 'color',
    label: 'color',
    baseColor: [1, 0.5, 0.25, 1],
    roughness: 0.24,
    transmission: 1,
    ior: 1.52,
    thickness: 0.35,
    attenuationColor: [1, 0.16, 0.04],
    attenuationDistance: 1,
  },
  {
    id: 'thick',
    label: 'thick',
    baseColor: [0.55, 0.88, 0.7, 1],
    roughness: 0.16,
    transmission: 1,
    ior: 1.6,
    thickness: 1.35,
    attenuationColor: [0.08, 0.8, 0.35],
    attenuationDistance: 1,
  },
  {
    id: 'MASK',
    label: 'MASK',
    baseColor: [0.72, 0.45, 1, 0.82],
    roughness: 0.3,
    transmission: 0.9,
    ior: 1.48,
    thickness: 0.26,
    attenuationColor: [0.45, 0.15, 1],
    attenuationDistance: 1.5,
    queue: 2450,
    alphaCutoff: 0.5,
  },
];

function makeTransmissionMaterial(testCase: TransmissionCase): MaterialAsset {
  return standardWithTransmission({
    baseColor: testCase.baseColor,
    metallic: 0,
    roughness: testCase.roughness,
    transmission: testCase.transmission,
    ior: testCase.ior,
    thickness: testCase.thickness,
    attenuationColor: testCase.attenuationColor,
    attenuationDistance: testCase.attenuationDistance,
    ...(testCase.queue === undefined ? {} : { queue: testCase.queue }),
    ...(testCase.alphaCutoff === undefined ? {} : { alphaCutoff: testCase.alphaCutoff }),
  });
}

function spawnMesh(
  world: World,
  mesh: Handle<'MeshAsset', 'shared'>,
  material: Handle<'MaterialAsset', 'shared'>,
  pos: readonly [number, number, number],
  scale: readonly [number, number, number] = [1, 1, 1],
): void {
  world.spawn(
    { component: Transform, data: { pos, scale } },
    { component: MeshFilter, data: { assetHandle: mesh } },
    { component: MeshRenderer, data: { materials: [material] } },
  ).unwrap();
}

function installCaptureHook(target: HTMLCanvasElement, app: App, world: World): void {
  const renderer = app.renderer;
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  const lease = attached.value;

  window.__captureTransmission = async (): Promise<Uint8Array> => {
    world.update(1 / 60).unwrap();
    const drawn = renderer.draw({
      leases: [lease],
      camera: { lease },
      environment: { lease },
    });
    if (!drawn.ok) throw drawn.error;
    const capture = await captureCanvasPixels(target);
    if (!capture.ok) throw new Error(`[transmission-refraction] ${capture.error.hint}`);
    return capture.value;
  };
}

function publishInspection(app: App): void {
  const inspection = app.renderer.inspect();
  window.__transmissionInspection = {
    status: 'ready',
    backend: inspection.capabilities.backendKind,
    rendererCount: 1,
    cases: TRANSMISSION_CASES.map(({ id, roughness, transmission, ior, thickness, queue }) => ({
      id,
      roughness,
      transmission,
      ior,
      thickness,
      queue: queue ?? 2000,
    })),
    ordinaryBlend: {
      queue: 3000,
      depthWriteEnabled: false,
      blend: true,
    },
    passNames: inspection.perFramePassNames,
  };
}

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    reportBootstrapError(appResult.error);
    return;
  }
  const app = appResult.value;
  exposeLearnRenderTestApp(app, target);
  const world = app.world;

  app.onError((error) => {
    console.error('[learn-render 6.pbr 4.transmission-refraction] app.onError:', error);
    window.__learnRenderErrors?.push(JSON.parse(JSON.stringify(error)));
  });

  const backgroundGeometry = createPlaneGeometry(11, 7);
  if (!backgroundGeometry.ok) throw backgroundGeometry.error;
  const backgroundMesh = world.allocSharedRef('MeshAsset', backgroundGeometry.value);
  const backgroundMaterial = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.03, 0.07, 0.14, 1], roughness: 0.82 }),
  );
  spawnMesh(world, backgroundMesh, backgroundMaterial, [0, 0, -1.6], [1, 1, 1]);

  const sphereGeometry = createSphereGeometry(SPHERE_RADIUS, 32, 16);
  if (!sphereGeometry.ok) throw sphereGeometry.error;
  const sphereMesh = world.allocSharedRef('MeshAsset', sphereGeometry.value);

  for (const [index, testCase] of TRANSMISSION_CASES.entries()) {
    const x = (index - (TRANSMISSION_CASES.length - 1) / 2) * SPACING;
    const material = world.allocSharedRef('MaterialAsset', makeTransmissionMaterial(testCase));
    spawnMesh(world, sphereMesh, material, [x, 0.15, 0]);
  }

  // A regular Standard BLEND consumer is intentionally separate from the
  // transmission cases: the pipe must order transmission before transparency.
  const blendMaterial = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({
      baseColor: [0.15, 0.55, 1, 0.38],
      metallic: 0,
      roughness: 0.28,
      queue: 3000,
      renderState: { depthWriteEnabled: false, blend: ALPHA_BLEND },
    }),
  );
  spawnMesh(world, sphereMesh, blendMaterial, [0, 0.15, 0.18], [0.48, 0.48, 0.48]);

  world.spawn(
    { component: Transform, data: { pos: [0, 0.2, 8] } },
    {
      component: Camera,
      data: {
        ...perspective({ fov: Math.PI / 3, aspect: WIDTH / HEIGHT, near: 0.1, far: 100 }),
        tonemap: TONEMAP_LINEAR,
        clearColor: [0.005, 0.008, 0.016, 1],
      },
    },
  ).unwrap();
  world.spawn({
    component: DirectionalLight,
    data: { direction: [0, 0, -1], color: [1, 1, 1], intensity: 2, castShadow: false },
  }).unwrap();

  installCaptureHook(target, app, world);
  const started = app.start();
  if (!started.ok) {
    console.error('[learn-render 6.pbr 4.transmission-refraction] app.start failed:', started.error);
    return;
  }
  publishInspection(app);
  console.warn(
    `[learn-render 6.pbr 4.transmission-refraction] backend=${app.renderer.inspect().capabilities.backendKind}`,
  );
}

function reportBootstrapError(error: CanvasAppError): void {
  if (error instanceof EngineEnvironmentError) {
    const inner = error.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(
      `[learn-render 6.pbr 4.transmission-refraction] EngineEnvironmentError: webgpu inner=${code}`,
    );
    return;
  }
  console.error(
    `[learn-render 6.pbr 4.transmission-refraction] ${error.code}: ${error.hint}`,
  );
}

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error("[learn-render 6.pbr 4.transmission-refraction] missing <canvas id='app'>");
}

window.__transmissionInspection = { status: 'booting', rendererCount: 0 };
window.__learnRenderErrors = [];
trackLearnRenderTestBootstrap(bootstrap(canvas), canvas);

declare global {
  interface Window {
    __captureTransmission?: () => Promise<Uint8Array>;
    __transmissionInspection?: Record<string, unknown>;
    __learnRenderErrors?: Array<{ code: string; hint?: string }>;
  }
}
