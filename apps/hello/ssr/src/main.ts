import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { atmosphereEvidenceControls, type AtmosphereEvidenceSettings } from './atmosphere-evidence';
import { installSurfaceControls } from './surface-controls';
import { verifyProbeAtmosphere } from './probe-atmosphere-evidence';
import { verifyProbeUpdates } from './probe-update-evidence';
import {
  deriveReflectionProbeRecoveryEvidence,
  REFLECTION_PROBE_SETTLE_FRAMES,
} from '../scripts/ssr-fallback-evidence.mjs';
// Screen-space reflection with producer-owned probe/environment fallback.

import { captureCanvasPixels } from '@forgeax/apps-shared/canvas-capture';
import { replayCapturedFrameInBrowser } from '@forgeax/apps-shared/rhi-debug-browser-replay';
import {
  exposeLearnRenderTestApp,
  trackLearnRenderTestBootstrap,
} from '../../../shared/src/learn-render-test-lifecycle';
import { createApp } from '@forgeax/engine-app/browser';

import { World, type EntityHandle } from '@forgeax/engine-ecs';
import type { RhiDevice, RhiError } from '@forgeax/engine-rhi';
import type { MaterialAsset } from '@forgeax/engine-types';
import {
  createCloudLayerFeature,
  Camera,
  CUBE_CAMERA_FACE_ORDER,
  CubeCamera,
  DEFAULT_STANDARD_PROFILE,
  DirectionalLight,
  ReflectionProbe,
  Materials,
  MeshFilter,
  MeshRenderer,
  ScreenSpaceReflection,
  Skylight,
  type RenderTarget,
  type RenderTargetReadbackTicket,
  type RenderTargetTextureSource,
  type SsrDependenciesInspection,
  type SsrSpatialInspection,
  perspective,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import './ssr-reflection.wgsl';
import { spawnReflectionScene, resolveSsrFixture, SSR_PARAMETERS } from './reflection-scene.mjs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
const BUILTIN_CUBE = createPrimitiveMesh('cube').unwrap();
const BUILTIN_SPHERE = createPrimitiveMesh('sphere').unwrap();


const TARGET_ID = 'target-hello-ssr';
const CUBE_REFLECTION_SHADER_ID = 'hello_ssr::reflection' as const;
const TARGET_WIDTH = 64;
const TARGET_HEIGHT = 64;
// Dedicated SSR browser/Dawn smokes keep the full 60-frame evidence window.
// The Vitest browser onerror gate only needs to boot this owner and can use a
// bounded preparation budget on the overloaded CI runner.
const REFLECTION_PROBE_CAPTURE_FRAMES =
  import.meta.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1' ? 8 : 60;
const CUBE_FACE_COLORS = CUBE_CAMERA_FACE_ORDER.map((face) => {
  switch (face) {
    case '+X':
      return [1, 0, 0, 1] as const;
    case '-X':
      return [0, 1, 1, 1] as const;
    case '+Y':
      return [0, 1, 0, 1] as const;
    case '-Y':
      return [1, 0, 1, 1] as const;
    case '+Z':
      return [0, 0, 1, 1] as const;
    case '-Z':
      return [1, 1, 0, 1] as const;
  }
});

type LearnRenderError = {
  readonly code: string;
  readonly hint?: string;
  readonly detail?: unknown;
};
type DeviceLostInfo = Awaited<RhiDevice['lost']>;
type CubeFaceEvidence = {
  readonly face: (typeof CUBE_CAMERA_FACE_ORDER)[number];
  readonly faceIndex: number;
  readonly mipLevel: number;
  readonly expected: readonly [number, number, number, number];
  readonly observed: readonly [number, number, number, number];
  readonly epsilon: number;
  readonly nearestColorIndex: number;
  readonly generation: number;
  readonly resolveIdentity: 'msaa-resolve';
};
type PlusZMarkerOracle = {
  readonly face: '+Z';
  readonly faceIndex: 4;
  readonly expectedQuadrant: 'upper-left';
  readonly upperLeftPixels: number;
  readonly upperRightPixels: number;
  readonly lowerPixels: number;
  readonly detected: boolean;
};
type TargetReport = {
  readonly stableTargetIds: readonly string[];
  readonly launchUrl: string;
  readonly targetShape: 'cube';
  readonly cubeFaceOrder: readonly string[];
  readonly faceBudget: number;
  readonly backend: string;
  readonly device: string;
  readonly sourceSha: string;
  readonly resolveIdentity: 'msaa-resolve';
  readonly faces?: readonly CubeFaceEvidence[];
  readonly epsilon?: number;
  readonly plusZMarkerOracle?: PlusZMarkerOracle;
  readonly swappedFaceFalsifierEpsilon?: number;
  readonly faceContentFalsifier?: {
    readonly distinctObservedFaces: number;
    readonly rejectsUniformClear: boolean;
  };
  readonly materialSampling?: {
    readonly shaderId: typeof CUBE_REFLECTION_SHADER_ID;
    readonly sourceShape: 'cube';
    readonly sourceTargetId: typeof TARGET_ID;
    readonly sampled: boolean;
    readonly canvasPixel: readonly [number, number, number, number];
    readonly canvasFaceMatchEpsilon: number;
  };
  readonly uncapturedGpuErrors: readonly LearnRenderError[];
  readonly receiptObservation?: {
    readonly frameId: number;
    readonly deviceGeneration: number;
    readonly byteLength: number;
  };
  readonly recoveryCode?: string;
  readonly recoveryGuard?: {
    readonly state: 'alive';
    readonly code: 'renderer-state-invalid';
    readonly reason: 'healthy-recover-guard';
  };
  readonly reflectionProbe?: {
    readonly frames?: number;
    readonly rawFaces: number;
    readonly filteredSteps: number;
    readonly roughnessLod: readonly [number, number];
    readonly insideSelection: 'probe';
    readonly outsideSelection: 'skylight';
    readonly receiptFrameId: number;
    readonly deviceGeneration: number;
    readonly pngByteLength: number;
    readonly roi: {
      readonly center: readonly [number, number, number, number];
      readonly outside: readonly [number, number, number, number];
    };
    readonly gpuErrors: readonly LearnRenderError[];
    readonly owner: {
      readonly factCount: number;
      readonly acceptedCount: number;
      readonly activeCount: number;
      readonly rawFacesCaptured: number;
      readonly filteredStepsCompleted: number;
      readonly filteredMipLevels: readonly number[];
      readonly scheduledRawFaces: number;
      readonly scheduledFilteredSteps: number;
      readonly pipelineReady: boolean;
      readonly pipelineWarmupAttempts: number;
      readonly pipelineWarmupFailure?: string;
      readonly reflectionFallback: {
        readonly source: 'probe' | 'skylight' | 'neutral';
        readonly sourceGeneration: number;
        readonly projectionGeneration: number;
        readonly deviceGeneration: number;
        readonly state: string;
        readonly candidateVisible: false;
      };
    };
    readonly initialOwner?: {
      readonly reflectionFallbacks?: readonly unknown[];
      readonly reflectionFallbackReadback?: unknown;
    };
    readonly neutralOwner?: {
      readonly reflectionFallbacks?: readonly unknown[];
      readonly reflectionFallbackReadback?: unknown;
    };
    readonly initialSsrDependencies?: SsrDependenciesInspection;
    readonly neutralSsrDependencies?: SsrDependenciesInspection;
    readonly submitFailure?: {
      readonly drawError: string;
      readonly before: unknown;
      readonly after: unknown;
      readonly failureStage?: string;
      readonly failureCode?: string;
      readonly preservedLkg: boolean;
      readonly generationStable: boolean;
      readonly candidateInvisible: boolean;
    };
    readonly deviceRecovery?: {
      readonly triggered: boolean;
      readonly lostState: string;
      readonly recoverCode: string;
      readonly beforeDeviceGeneration: number;
      readonly afterDeviceGeneration: number;
      readonly generationChanged: boolean;
      readonly replacementRow: unknown;
      readonly readback: unknown;
      readonly matchingReplacement: boolean;
      readonly beforeSsr: SsrSpatialInspection;
      readonly afterSsr: SsrSpatialInspection;
      readonly replacementTemporal: SsrDependenciesInspection['temporal'];
      readonly replacementSsrReady: boolean;
    };
    readonly ssrDependencies: SsrDependenciesInspection;
    readonly ssr?: SsrSpatialInspection;
  };
};

function hasNestedErrorCode(
  value: unknown,
  expectedCode: string,
  seen = new Set<object>(),
): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if ('code' in value && (value as { readonly code?: unknown }).code === expectedCode) return true;
  for (const key of ['cause', 'detail', 'error', 'causes'] as const) {
    if (
      key in value &&
      hasNestedErrorCode((value as Record<string, unknown>)[key], expectedCode, seen)
    ) {
      return true;
    }
  }
  return false;
}

function reportError(label: string, error: unknown): void {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { readonly code: string }).code
      : undefined;
  const host = globalThis as typeof globalThis & {
    __learnRenderExpectedErrorCodes?: Record<string, number>;
  };
  const expectedBudget = host.__learnRenderExpectedErrorCodes;
  const expectedCode =
    expectedBudget === undefined
      ? undefined
      : Object.keys(expectedBudget).find(
          (candidate) =>
            (expectedBudget[candidate] ?? 0) > 0 && hasNestedErrorCode(error, candidate),
        );
  const expected = expectedCode !== undefined;
  if (expectedCode !== undefined && expectedBudget !== undefined)
    expectedBudget[expectedCode] = (expectedBudget[expectedCode] ?? 0) - 1;
  if (!expected) console.error(label, error);
  if (code === undefined || typeof error !== 'object' || error === null) return;
  if (expected) return;
  const hint = 'hint' in error ? (error as { readonly hint?: string }).hint : undefined;
  const detail = 'detail' in error ? (error as { readonly detail?: unknown }).detail : undefined;
  console.error(label, { code, hint, detail });
  const bus = (globalThis as unknown as { __learnRenderErrors?: LearnRenderError[] })
    .__learnRenderErrors;
  bus?.push({
    code,
    ...(hint === undefined ? {} : { hint }),
    ...(detail === undefined ? {} : { detail }),
  });
}

function descriptor() {
  return {
    shape: 'cube' as const,
    width: TARGET_WIDTH,
    height: TARGET_HEIGHT,
    format: 'rgba8unorm-srgb' as const,
    mipLevels: 1 as const,
    sampleCount: 4 as const,
    sampled: true,
    readback: true,
  };
}

function readRgba8Pixel(
  bytes: Uint8Array,
  bytesPerRow: number,
  x: number,
  y: number,
): readonly [number, number, number, number] {
  const offset = y * bytesPerRow + x * 4;
  return [
    (bytes[offset] ?? 0) / 255,
    (bytes[offset + 1] ?? 0) / 255,
    (bytes[offset + 2] ?? 0) / 255,
    (bytes[offset + 3] ?? 0) / 255,
  ];
}

function nearestCubeFaceEpsilon(pixel: readonly [number, number, number, number]): number {
  return Math.min(
    ...CUBE_FACE_COLORS.map((expected) =>
      Math.max(...expected.map((value, channel) => Math.abs(value - pixel[channel]!))),
    ),
  );
}

function nearestCubeFaceIndex(pixel: readonly [number, number, number, number]): number {
  return CUBE_FACE_COLORS.reduce(
    (best, expected, index) => {
      const distance = Math.max(
        ...expected.map((value, channel) => Math.abs(value - pixel[channel]!)),
      );
      return distance < best.distance ? { distance, index } : best;
    },
    { distance: Infinity, index: -1 },
  ).index;
}

function inspectPlusZMarker(bytes: Uint8Array, bytesPerRow: number): PlusZMarkerOracle {
  let upperLeft = 0;
  let upperRight = 0;
  let lower = 0;
  for (let y = 0; y < TARGET_HEIGHT; y += 1) {
    for (let x = 0; x < TARGET_WIDTH; x += 1) {
      const offset = y * bytesPerRow + x * 4;
      if (
        (bytes[offset] ?? 0) < 204 ||
        (bytes[offset + 1] ?? 0) < 204 ||
        (bytes[offset + 2] ?? 0) < 204
      ) {
        continue;
      }
      if (y < TARGET_HEIGHT / 2 && x < TARGET_WIDTH / 2) upperLeft += 1;
      else if (y < TARGET_HEIGHT / 2) upperRight += 1;
      else lower += 1;
    }
  }
  return {
    face: '+Z',
    faceIndex: 4,
    expectedQuadrant: 'upper-left',
    upperLeftPixels: upperLeft,
    upperRightPixels: upperRight,
    lowerPixels: lower,
    detected: upperLeft > 8 && upperLeft > upperRight * 4 && upperLeft > lower * 4,
  };
}

function findMaterialSamplingPixel(
  bytes: Uint8Array,
  width: number,
  height: number,
): readonly [number, number, number, number] | undefined {
  let best: readonly [number, number, number, number] | undefined;
  let bestScore = -Infinity;
  for (let y = Math.floor(height * 0.3); y < Math.ceil(height * 0.7); y += 4) {
    for (let x = Math.floor(width * 0.3); x < Math.ceil(width * 0.7); x += 4) {
      const pixel = readRgba8Pixel(bytes, width * 4, x, y);
      const epsilon = nearestCubeFaceEpsilon(pixel);
      const saturation =
        Math.max(pixel[0], pixel[1], pixel[2]) - Math.min(pixel[0], pixel[1], pixel[2]);
      if (epsilon <= 0.2 && saturation >= 0.2 && saturation - epsilon > bestScore) {
        best = pixel;
        bestScore = saturation - epsilon;
      }
    }
  }
  return best;
}

function semanticColorName(color: readonly [number, number, number, number]): string {
  if (color[0] === 1 && color[1] === 0 && color[2] === 0) return 'RED';
  if (color[0] === 0 && color[1] === 1 && color[2] === 1) return 'CYAN';
  if (color[0] === 0 && color[1] === 1 && color[2] === 0) return 'GREEN';
  if (color[0] === 1 && color[1] === 0 && color[2] === 1) return 'MAGENTA';
  if (color[0] === 0 && color[1] === 0 && color[2] === 1) return 'BLUE';
  return 'YELLOW';
}

function mountCubeFaceLegend(): void {
  const canvas = document.querySelector<HTMLCanvasElement>('#app');
  if (canvas === null) return;
  const legend = document.createElement('aside');
  legend.setAttribute('aria-label', 'CubeCamera face mapping legend');
  legend.style.cssText =
    'display:grid;grid-template-columns:repeat(3,max-content);gap:6px 12px;margin-top:8px;' +
    'font:12px/1.2 monospace;color:#dce7f5;';
  for (const [index, face] of CUBE_CAMERA_FACE_ORDER.entries()) {
    const color = CUBE_FACE_COLORS[index]!;
    const item = document.createElement('span');
    item.style.cssText = 'display:inline-flex;align-items:center;gap:4px;';
    const swatch = document.createElement('i');
    swatch.setAttribute('aria-hidden', 'true');
    swatch.style.cssText =
      `display:inline-block;width:10px;height:10px;border:1px solid #dce7f5;` +
      `background:rgb(${color[0] * 255},${color[1] * 255},${color[2] * 255});`;
    const label = document.createElement('span');
    label.textContent = `${face} ${semanticColorName(color)}`;
    item.append(swatch, label);
    legend.append(item);
  }
  canvas.insertAdjacentElement('afterend', legend);
}

function spawnConsumerScene(
  world: World,
  assets: AssetRegistry,
  target: RenderTarget,
  source: RenderTargetTextureSource,
  aspect: number,
  reflectionEvidence = false,
): {
  readonly sun?: EntityHandle;
  readonly atmosphere?: EntityHandle;
  readonly skylight?: EntityHandle;
  readonly reflectionProbe?: EntityHandle;
  readonly camera?: EntityHandle;
  readonly movingObject?: EntityHandle;
  readonly receiver?: EntityHandle;
} {
  if (reflectionEvidence) {
    const scene = spawnReflectionScene(
      world,
      assets,
      aspect,
      resolveSsrFixture(new URLSearchParams(location.search).get('fixture') ?? 'cube'),
      new URLSearchParams(location.search).get('aa') ?? 'taa',
    );
    if ('reflectionProbe' in scene && scene.reflectionProbe !== undefined) {
      world.set(scene.reflectionProbe, ReflectionProbe, { updateIntent: 1 }).unwrap();
    }
    return scene;
  }
  const cubeHandle = assets.create(BUILTIN_CUBE).unwrap();
  const sphereHandle = assets.create(BUILTIN_SPHERE).unwrap();
  let skylightEntity: EntityHandle | undefined;
  let reflectionProbeEntity: EntityHandle | undefined;
  const targetHandle = world.allocSharedRef('RenderTarget', target);
  const sourceHandle = { source: source };
  const materialPayload: MaterialAsset = reflectionEvidence
    ? Materials.standard({
        baseColor: [0.8, 0.9, 1, 1],
        metallic: 0.1,
        roughness: 0.35,
      })
    : {
        kind: 'material',
        passes: [
          {
            name: 'Forward',
            program: {
              module: CUBE_REFLECTION_SHADER_ID,
              vertexEntry: 'vs_main',
              fragmentEntry: 'fs_main',
            },
            renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
          },
        ],
        parameters: [
          { name: 'baseColor', type: 'color' },
          { name: 'cubeTexture', type: 'texture_cube' },
        ],
        values: {
          baseColor: [1, 1, 1, 1],
          cubeTexture: sourceHandle,
        },
      };
  const material = assets.create(materialPayload).unwrap();

  const panelTransforms: readonly [
    readonly [number, number, number],
    readonly [number, number, number],
  ][] = [
    [
      [3, 0, 0],
      [0.12, 2.4, 2.4],
    ],
    [
      [-3, 0, 0],
      [0.12, 2.4, 2.4],
    ],
    [
      [0, 3, 0],
      [2.4, 0.12, 2.4],
    ],
    [
      [0, -3, 0],
      [2.4, 0.12, 2.4],
    ],
    [
      [0, 0, 3],
      [2.4, 2.4, 0.12],
    ],
    [
      [0, 0, -3],
      [2.4, 2.4, 0.12],
    ],
  ];
  if (!reflectionEvidence) {
    for (let faceIndex = 0; faceIndex < CUBE_FACE_COLORS.length; faceIndex += 1) {
      const panelMaterial = assets.create(Materials.unlit(CUBE_FACE_COLORS[faceIndex]!)).unwrap();
      const [position, scale] = panelTransforms[faceIndex]!;
      world
        .spawn(
          {
            component: Transform,
            data: { pos: position, quat: [0, 0, 0, 1], scale },
          },
          { component: MeshFilter, data: { assetHandle: cubeHandle } },
          { component: MeshRenderer, data: { materials: [panelMaterial] } },
        )
        .unwrap();
    }

    const neutralAccentMaterial = assets.create(Materials.unlit([0.45, 0.45, 0.45, 1])).unwrap();
    const accentColumns: readonly [
      readonly [number, number, number],
      readonly [number, number, number],
    ][] = [
      [
        [-2.3, 0, 0.8],
        [0.55, 2, 0.55],
      ],
      [
        [2.3, 0, 0.8],
        [0.55, 2, 0.55],
      ],
      [
        [0, 2, 1.5],
        [0.9, 0.42, 0.9],
      ],
    ];
    for (const [position, scale] of accentColumns) {
      world
        .spawn(
          {
            component: Transform,
            data: { pos: position, quat: [0, 0, 0, 1], scale },
          },
          { component: MeshFilter, data: { assetHandle: cubeHandle } },
          { component: MeshRenderer, data: { materials: [neutralAccentMaterial] } },
        )
        .unwrap();
    }

    const markerMaterial = assets.create(Materials.unlit([1, 1, 1, 1])).unwrap();
    const plusZMarkerParts: readonly [
      readonly [number, number, number],
      readonly [number, number, number],
    ][] = [
      [
        [0.55, 0.78, 2.9],
        [0.85, 0.12, 0.05],
      ],
      [
        [0.2, 0.45, 2.9],
        [0.12, 0.78, 0.05],
      ],
    ];
    for (const [position, scale] of plusZMarkerParts) {
      world
        .spawn(
          {
            component: Transform,
            data: { pos: position, quat: [0, 0, 0, 1], scale },
          },
          { component: MeshFilter, data: { assetHandle: cubeHandle } },
          { component: MeshRenderer, data: { materials: [markerMaterial] } },
        )
        .unwrap();
    }
  }

  world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [-0.4, -1, -0.3],
        color: [1, 1, 1],
        intensity: 2,
        castShadow: false,
      },
    })
    .unwrap();

  if (reflectionEvidence) {
    // Keep the browser evidence fixture aligned with the Dawn lane: the
    // renderable outside the probe must resolve to a real Skylight source,
    // not a neutral projection with no producer data to write into the MRT.
    skylightEntity = world
      .spawn({
        component: Skylight,
        data: { color: [0.55, 0.7, 1], intensity: 1 },
      })
      .unwrap();
  }

  world
    .spawn(
      {
        component: Transform,
        data: {
          pos: [0, 0, 0],
          quat: [0, 0, 0, 1],
          scale: [1.7, 1.7, 1.7],
        },
      },
      { component: MeshFilter, data: { assetHandle: sphereHandle } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();

  if (reflectionEvidence) {
    reflectionProbeEntity = world
      .spawn(
        {
          component: Transform,
          data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
        },
        {
          component: ReflectionProbe,
          data: {
            halfExtents: [0.9, 0.9, 0.9],
            priority: 1,
            intensity: 1,
            resolution: 64,
            updateIntent: 0,
            invalidationVersion: 1,
          },
        },
      )
      .unwrap();
    const outsideMaterial = assets.create(Materials.standard({ baseColor: [1, 0.12, 0.04, 1], metallic: 0.1, roughness: 0.35 })).unwrap();
    world
      .spawn(
        {
          component: Transform,
          data: { pos: [2.25, 0, 0], quat: [0, 0, 0, 1], scale: [0.45, 0.45, 0.45] },
        },
        { component: MeshFilter, data: { assetHandle: cubeHandle } },
        { component: MeshRenderer, data: { materials: [outsideMaterial] } },
      )
      .unwrap();
  }

  const cameraEntity = world
    .spawn(
      {
        component: Transform,
        data: {
          pos: [6, 0, 6],
          quat: [0, 0.38268343, 0, 0.9238795],
          scale: [1, 1, 1],
        },
      },
      {
        component: Camera,
        data: {
          ...perspective({ fov: Math.PI / 3, aspect: 1, near: 0.1, far: 20 }),
          clearColor: [0.04, 0.06, 0.1, 1],
        },
      },
    )
    .unwrap();

  if (reflectionEvidence) {
    // The probe/environment fixture is also the first scene-level SSR
    // consumer. Keep the effect on the active camera while the renderer owns
    // all graph, history, and fallback resources.
    world
      .addComponent(cameraEntity, {
        component: ScreenSpaceReflection,
        data: { maxDistance: 12, thickness: 0.2, maxRoughness: 0.65 },
      })
      .unwrap();
  }

  world
    .spawn(
      {
        component: Transform,
        data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
      },
      {
        component: CubeCamera,
        data: {
          target: targetHandle,
          near: 0.1,
          far: 20,
          updateIntent: 0,
          requestVersion: 0,
          faceBudget: 6,
        },
      },
    )
    .unwrap();

  return {
    ...(skylightEntity === undefined ? {} : { skylight: skylightEntity }),
    ...(reflectionProbeEntity === undefined ? {} : { reflectionProbe: reflectionProbeEntity }),
  };
}

function publishReport(report: TargetReport): void {
  Object.assign(globalThis, { __renderTargetReflectionReport: report });
  console.info(`[hello-ssr] report=${JSON.stringify(report)}`);
}

async function bootstrap(canvas: HTMLCanvasElement): Promise<void> {
  const ssrIdentity = {
    sourceHead: import.meta.env.VITE_FORGEAX_SOURCE_SHA ?? 'unknown',
    sourceTree: import.meta.env.VITE_FORGEAX_SSR_SOURCE_TREE ?? 'unknown',
    lockSha256: import.meta.env.VITE_FORGEAX_SSR_LOCK_SHA256 ?? 'unknown',
    buildSha256: import.meta.env.VITE_FORGEAX_SSR_BUILD_SHA256 ?? 'unknown',
  } as const;
  // Opening hello-ssr must exercise SSR as well as the automated capture lane.
  // The browser onerror gate has a separate lightweight bootstrap profile: it
  // checks the renderer error contract, while the dedicated SSR browser/Dawn
  // smokes keep the full reflection fixture and evidence path.
  const browserOnerrorGate = (
    globalThis as typeof globalThis & {
      __forgeaxBrowserOnerrorGate?: string;
    }
  ).__forgeaxBrowserOnerrorGate;
  const reflectionEvidence =
    browserOnerrorGate !== 'hello-ssr' && import.meta.env.VITE_REFLECTION_PROBE_EVIDENCE !== '0';
  let submitFailureArmed = false;
  let resolveInjectedDeviceLoss: ((info: DeviceLostInfo) => void) | undefined;
  const faultInstrumentation = reflectionEvidence
    ? {
        beforeSubmit: (): RhiError | undefined => {
          if (!submitFailureArmed) return undefined;
          submitFailureArmed = false;
          const host = globalThis as typeof globalThis & {
            __learnRenderExpectedErrorCodes?: Record<string, number>;
          };
          host.__learnRenderExpectedErrorCodes ??= {};
          host.__learnRenderExpectedErrorCodes['queue-submit-failed'] =
            (host.__learnRenderExpectedErrorCodes['queue-submit-failed'] ?? 0) + 1;
          const failure = new Error('fixture-injected reflection fallback submit failure');
          Object.assign(failure, {
            code: 'queue-submit-failed',
            expected:
              'the reflection fallback fixture submit fault to be handled as a failed transaction',
            hint: 'fixture-injected reflection fallback submit failure',
          });
          return failure as unknown as RhiError;
        },
        deviceLost: (device: RhiDevice): RhiDevice['lost'] => {
          const injected = new Promise<DeviceLostInfo>((resolve) => {
            resolveInjectedDeviceLoss = resolve;
          });
          return Promise.race([device.lost, injected]);
        },
      }
    : undefined;
  const created = await createApp(
    canvas,
    {
      ssrIdentity,
      ...(new URLSearchParams(location.search).get('fixture') === 'atmosphere' ? { features: [createCloudLayerFeature()] } : {}),
      ...(new URLSearchParams(location.search).has('timings') ? { gpuPassTiming: {} } : {}),
      captureReflectionFallbackReadback: reflectionEvidence && import.meta.env.VITE_REFLECTION_PROBE_EVIDENCE === '1',
      ...(reflectionEvidence
        ? { standardProfile: { ...DEFAULT_STANDARD_PROFILE, renderPath: 'deferred' as const } }
        : {}),
      ...(faultInstrumentation === undefined ? {} : { rhiInstrumentation: faultInstrumentation }),
    },
    forgeaxBundlerAdapter(),
  );
  if (!created.ok) {
    reportError('[hello-ssr] createApp failed', created.error);
    return;
  }
  const app = created.value;
  exposeLearnRenderTestApp(app, canvas);
  const renderer = app.renderer;
  app.onError((error) => reportError('[hello-ssr] app error', error));

  const targetResult = renderer.createRenderTarget(descriptor());
  if (!targetResult.ok) {
    reportError('[hello-ssr] target creation failed', targetResult.error);
    return;
  }
  const sourceResult = renderer.createRenderTargetTextureSource(targetResult.value, {
    aspect: 'color',
    dimension: 'cube',
    mipLevel: 0,
  });
  if (!sourceResult.ok) {
    reportError('[hello-ssr] cube source creation failed', sourceResult.error);
    return;
  }
  const assets = app.assets;
  if (assets === undefined) throw new Error('SSR requires runtime assets');
  const world = app.world;
  const sceneEntities = spawnConsumerScene(
    world,
    assets,
    targetResult.value,
    sourceResult.value,
    canvas.width / canvas.height,
    reflectionEvidence,
  );
  const attached = renderer.attach(world);
  if (!attached.ok) {
    reportError('[hello-ssr] renderer attach failed', attached.error);
    return;
  }

  const baseReport: TargetReport = {
    stableTargetIds: [TARGET_ID],
    launchUrl: globalThis.location?.href ?? 'http://127.0.0.1:5197/',
    targetShape: 'cube',
    cubeFaceOrder: [...CUBE_CAMERA_FACE_ORDER],
    faceBudget: 6,
    backend: renderer.inspect().capabilities.backendKind,
    device: `rhi-device:${renderer.inspect().frame.deviceGeneration}`,
    sourceSha: import.meta.env.VITE_FORGEAX_SOURCE_SHA ?? 'unknown',
    resolveIdentity: 'msaa-resolve',
    uncapturedGpuErrors: [],
  };
  let lastTickets: RenderTargetReadbackTicket[] = [];
  const capture = async (): Promise<Uint8Array> => {
    const paused = app.pause();
    if (!paused.ok) throw paused.error;
    try {
      for (let face = 0; face < CUBE_CAMERA_FACE_ORDER.length; face += 1) {
        const updated = world.update(1 / 60);
        if (!updated.ok) throw updated.error;
        const next = renderer.draw({
          leases: [attached.value],
          camera: { lease: attached.value },
          environment: { lease: attached.value },
        });
        if (!next.ok) throw next.error;
        const completed = await next.value.completed;
        if (!completed.ok) throw completed.error;
      }
      // Finish all six faces before copying the promoted source. This same
      // display submission samples that source and owns every readback ticket.
      const cubeTickets: RenderTargetReadbackTicket[] = [];
      for (const face of CUBE_CAMERA_FACE_ORDER.keys()) {
        const ticketResult = renderer.requestTargetReadback(targetResult.value, {
          mipLevel: 0,
          layer: face,
        });
        if (!ticketResult.ok) throw ticketResult.error;
        cubeTickets.push(ticketResult.value);
      }
      lastTickets = cubeTickets;
      const updated = world.update(1 / 60);
      if (!updated.ok) throw updated.error;
      const next = renderer.draw({
        leases: [attached.value],
        camera: { lease: attached.value },
        environment: { lease: attached.value },
      });
      if (!next.ok) throw next.error;
      const finalReceipt = next.value;
      const completed = await finalReceipt.completed;
      if (!completed.ok) throw completed.error;
      const cubeObservation = await renderer.observe(finalReceipt, {
        include: ['target-readbacks'],
        targetReadbacks: cubeTickets,
      });
      if (!cubeObservation.ok) throw cubeObservation.error;
      const cubeData = cubeObservation.value.targetReadbacks ?? [];
      if (cubeData.length !== CUBE_CAMERA_FACE_ORDER.length) {
        throw new Error('cube readback returned an incomplete face set');
      }
      const faces = cubeData.map((entry, face) => {
        const expected = CUBE_FACE_COLORS[face]!;
        const observedPixel = readRgba8Pixel(
          entry.bytes,
          entry.bytesPerRow,
          Math.floor(TARGET_WIDTH / 2),
          Math.floor(TARGET_HEIGHT / 2),
        );
        const epsilon = Math.max(
          ...expected.map((value, index) => Math.abs(value - observedPixel[index]!)),
        );
        return {
          face: CUBE_CAMERA_FACE_ORDER[face]!,
          faceIndex: face,
          mipLevel: entry.mipLevel,
          expected,
          observed: observedPixel,
          epsilon,
          nearestColorIndex: nearestCubeFaceIndex(observedPixel),
          generation: entry.deviceGeneration,
          resolveIdentity: 'msaa-resolve' as const,
        };
      });
      const epsilon = Math.max(...faces.map((face) => face.epsilon));
      const plusZMarkerOracle = inspectPlusZMarker(cubeData[4]!.bytes, cubeData[4]!.bytesPerRow);
      const distinctObservedFaces = new Set(
        faces.map((face) => face.observed.map((value) => value.toFixed(4)).join(',')),
      ).size;
      const rejectsUniformClear = distinctObservedFaces > 1;
      const swappedEpsilon = Math.max(
        ...faces.map((face, index) =>
          Math.max(
            ...face.expected.map((value, channel) =>
              Math.abs(value - faces[faces.length - index - 1]!.observed[channel]!),
            ),
          ),
        ),
      );
      const pixelsResult = await captureCanvasPixels(canvas);
      if (!pixelsResult.ok) throw pixelsResult.error;
      const canvasPixel =
        findMaterialSamplingPixel(
          pixelsResult.value,
          Math.max(1, canvas.width),
          Math.max(1, canvas.height),
        ) ??
        readRgba8Pixel(
          pixelsResult.value,
          Math.max(1, canvas.width) * 4,
          Math.floor(Math.max(1, canvas.width) / 2),
          Math.floor(Math.max(1, canvas.height) / 2),
        );
      const canvasFaceMatchEpsilon = nearestCubeFaceEpsilon(canvasPixel);
      const materialSampling: TargetReport['materialSampling'] = reflectionEvidence
        ? undefined
        : {
            shaderId: CUBE_REFLECTION_SHADER_ID,
            sourceShape: 'cube' as const,
            sourceTargetId: TARGET_ID,
            sampled: canvasFaceMatchEpsilon <= 0.2,
            canvasPixel,
            canvasFaceMatchEpsilon,
          };
      publishReport({
        ...baseReport,
        faces,
        epsilon,
        plusZMarkerOracle,
        swappedFaceFalsifierEpsilon: swappedEpsilon,
        faceContentFalsifier: { distinctObservedFaces, rejectsUniformClear },
        uncapturedGpuErrors: [],
      });
      if (!rejectsUniformClear)
        throw new Error('cube face-content falsifier rejected uniform clear output');
      if (epsilon > 0.05) throw new Error(`cube face readback epsilon ${epsilon} exceeds 0.05`);
      if (faces.some((face) => face.nearestColorIndex !== face.faceIndex)) {
        throw new Error('cube face center nearest semantic color index mismatch');
      }
      if (!plusZMarkerOracle.detected) {
        throw new Error(`+Z L marker quadrant oracle failed: ${JSON.stringify(plusZMarkerOracle)}`);
      }
      if (swappedEpsilon <= 0.05) throw new Error('swapped-face falsifier unexpectedly passed');
      if (materialSampling !== undefined && !materialSampling.sampled) {
        throw new Error(
          `cube material sampling mismatch canvas=${materialSampling.canvasFaceMatchEpsilon}`,
        );
      }
      const recoveryState = renderer.state();
      const recovery = await renderer.recover();
      const recoveryCode = recovery.ok ? 'recovered' : recovery.error.code;
      if (recoveryState !== 'alive' || recovery.ok || recoveryCode !== 'renderer-state-invalid') {
        throw new Error(`healthy-recover guard changed state=${recoveryState} code=${recoveryCode}`);
      }
      publishReport({
        ...baseReport,
        faces,
        epsilon,
        plusZMarkerOracle,
        swappedFaceFalsifierEpsilon: swappedEpsilon,
        faceContentFalsifier: { distinctObservedFaces, rejectsUniformClear },
        uncapturedGpuErrors:
          (globalThis as unknown as { __learnRenderErrors?: LearnRenderError[] })
            .__learnRenderErrors ?? [],
        receiptObservation: {
          frameId: finalReceipt.frameId,
          deviceGeneration: finalReceipt.deviceGeneration,
          byteLength: cubeData.reduce((total, entry) => total + entry.byteLength, 0),
        },
        ...(materialSampling === undefined ? {} : { materialSampling }),
        recoveryCode,
        recoveryGuard: {
          state: recoveryState,
          code: 'renderer-state-invalid',
          reason: 'healthy-recover-guard',
        },
      });
      return pixelsResult.value;
    } finally {
      const resumed = app.resume();
      if (!resumed.ok) throw resumed.error;
    }
  };

  type ReflectionProbeInspection = ReturnType<typeof renderer.inspect>['reflectionProbes'];
  type ReflectionEvidenceReceipt = Awaited<ReturnType<typeof drawReflectionEvidenceFrame>>;

  const learnRenderErrors = (): LearnRenderError[] =>
    (globalThis as unknown as { __learnRenderErrors?: LearnRenderError[] }).__learnRenderErrors ??
    [];

  const drawReflectionEvidenceFrame = async (passNames: Set<string>) => {
    const updated = world.update(1 / 60);
    if (!updated.ok) throw updated.error;
    const next = renderer.draw({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
    if (!next.ok) throw next.error;
    const completed = await next.value.completed;
    if (!completed.ok) throw completed.error;
    for (const passName of renderer.inspect().perFramePassNames) passNames.add(passName);
    return next.value;
  };

  const prepareReflectionProbe = async (passNames: Set<string>): Promise<ReflectionEvidenceReceipt> => {
    let receipt: ReflectionEvidenceReceipt | undefined;
    for (let frame = 0; frame < REFLECTION_PROBE_CAPTURE_FRAMES; frame += 1) {
      receipt = await drawReflectionEvidenceFrame(passNames);
      (
        globalThis as typeof globalThis & { __transmissionFrameCount?: number }
      ).__transmissionFrameCount = frame + 1;
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
    if (receipt === undefined) throw new Error('probe evidence submitted no frame');
    return receipt;
  };

  const committedProbeReady = (inspection: ReflectionProbeInspection): boolean => {
    const fallbackReadback = inspection.reflectionFallbackReadback;
    const committedProbe = inspection.reflectionFallbacks?.find((row) => row.source === 'probe');
    return (
      inspection.rawFacesCaptured === 6 &&
      inspection.filteredStepsCompleted === 54 &&
      inspection.activeCount > 0 &&
      inspection.filteredMipLevels.length === 9 &&
      fallbackReadback?.readbackStatus === 'complete' &&
      fallbackReadback.linearHdr.slice(0, 3).some(
        (value) => Number.isFinite(value) && value !== 0,
      ) &&
      committedProbe !== undefined &&
      committedProbe.state === 'active' &&
      committedProbe.candidateVisible === false &&
      committedProbe.frameId === fallbackReadback.frameId &&
      committedProbe.deviceGeneration === fallbackReadback.deviceGeneration
    );
  };

  // A completion promise covers queue work, while inspection publication is
  // producer-owned state. Poll that state with a bounded real draw so the
  // baseline cannot capture the preceding Skylight/LKG row.
  const awaitCommittedProbe = async (passNames: Set<string>): Promise<ReflectionProbeInspection> => {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      if (committedProbeReady(renderer.inspect().reflectionProbes)) break;
      await drawReflectionEvidenceFrame(passNames);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
    const owner = renderer.inspect().reflectionProbes;
    if (!committedProbeReady(owner)) {
      throw new Error(`ReflectionProbe baseline publication did not settle: ${JSON.stringify(owner)}`);
    }
    return owner;
  };

  const readReflectionRoi = (pixels: Uint8Array) => {
    const width = Math.max(1, canvas.width);
    const centerOffset = (Math.floor(canvas.height / 2) * width + Math.floor(width / 2)) * 4;
    const outsideOffset = (Math.floor(canvas.height / 2) * width + Math.floor(width * 0.88)) * 4;
    const rgba = (offset: number): readonly [number, number, number, number] => [
      pixels[offset] ?? 0,
      pixels[offset + 1] ?? 0,
      pixels[offset + 2] ?? 0,
      pixels[offset + 3] ?? 0,
    ];
    return { center: rgba(centerOffset), outside: rgba(outsideOffset) };
  };

  const assertProbeBaseline = (owner: ReflectionProbeInspection): void => {
    const rawFaces = owner.rawFacesCaptured;
    const filteredSteps = owner.filteredStepsCompleted;
    const mipLevels = owner.filteredMipLevels;
    if (rawFaces !== 6 || filteredSteps !== 54) {
      throw new Error(
        `ReflectionProbe owner counters rawFaces=${rawFaces}, filteredSteps=${filteredSteps}`,
      );
    }
    if (mipLevels.length !== 9 || mipLevels[0] !== 0 || mipLevels[8] !== 8) {
      throw new Error(`ReflectionProbe owner mip levels=${JSON.stringify(mipLevels)}`);
    }
    const fallbackReadback = owner.reflectionFallbackReadback;
    if (
      fallbackReadback?.readbackStatus !== 'complete' ||
      !fallbackReadback.linearHdr.slice(0, 3).some((value) => Number.isFinite(value) && value !== 0)
    ) {
      throw new Error(
        `ReflectionProbe fallback MRT readback was not non-zero: ${JSON.stringify(fallbackReadback)}`,
      );
    }
    const committedProbe = owner.reflectionFallbacks?.find((row) => row.source === 'probe');
    if (
      committedProbe === undefined ||
      committedProbe.candidateVisible ||
      committedProbe.frameId !== fallbackReadback.frameId ||
      committedProbe.deviceGeneration !== fallbackReadback.deviceGeneration
    ) {
      throw new Error(
        `ReflectionProbe fallback receipt identity mismatch: ${JSON.stringify({ committedProbe, fallbackReadback })}`,
      );
    }
    const initialGpuErrors = learnRenderErrors();
    if (initialGpuErrors.length > 0) {
      throw new Error(`ReflectionProbe GPU errors=${JSON.stringify(initialGpuErrors)}`);
    }
  };

  const probeFallbackRow = (inspection: ReflectionProbeInspection) => {
    return inspection.reflectionFallbacks?.find((row) => row.source === 'probe');
  };

  /** One injected submit fault must keep the probe row as its last-known-good generation. */
  const injectSubmitFailure = () => {
    const beforeFailure = renderer.inspect().reflectionProbes;
    const beforeRow = probeFallbackRow(beforeFailure);
    submitFailureArmed = true;
    const updated = world.update(1 / 60);
    if (!updated.ok) throw updated.error;
    const failed = renderer.draw({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
    if (failed.ok) throw new Error('reflection fallback submit fault was not injected');
    const afterFailure = renderer.inspect().reflectionProbes;
    const afterRow = probeFallbackRow(afterFailure);
    const failureInspection = afterFailure.reflectionFallbackInspection;
    const preservedLkg =
      beforeRow !== undefined &&
      afterRow !== undefined &&
      afterRow.state === 'lkg' &&
      afterRow.sourceGeneration === beforeRow.sourceGeneration &&
      afterRow.projectionGeneration === beforeRow.projectionGeneration;
    const candidateInvisible = (afterFailure.reflectionFallbacks ?? []).every(
      (row) => row.candidateVisible === false,
    );
    return {
      drawError: failed.error.code,
      before: beforeRow,
      after: afterRow,
      ...(failureInspection.failureStage === undefined
        ? {}
        : { failureStage: failureInspection.failureStage }),
      ...(failureInspection.failureCode === undefined
        ? {}
        : { failureCode: failureInspection.failureCode }),
      preservedLkg,
      generationStable: preservedLkg,
      candidateInvisible,
    };
  };

  const loseReflectionDevice = async (): Promise<string> => {
    if (resolveInjectedDeviceLoss === undefined) {
      throw new Error('reflection fallback device-loss fault resolver was not installed');
    }
    const host = globalThis as typeof globalThis & {
      __learnRenderExpectedErrorCodes?: Record<string, number>;
    };
    host.__learnRenderExpectedErrorCodes ??= {};
    host.__learnRenderExpectedErrorCodes['device-lost'] =
      (host.__learnRenderExpectedErrorCodes['device-lost'] ?? 0) + 1;
    resolveInjectedDeviceLoss({
      reason: 'unknown',
      message: 'fixture-injected reflection fallback device replacement',
    });
    for (let attempt = 0; attempt < 10 && renderer.state() !== 'device-lost'; attempt += 1) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
    const lostState = renderer.state();
    if (lostState !== 'device-lost')
      throw new Error(`device-loss fault did not reach renderer: ${lostState}`);
    return lostState;
  };

  /** Replaces the device and settles until the probe and SSR republish on the new generation. */
  const replaceReflectionDevice = async (passNames: Set<string>) => {
    const beforeLoss = renderer.inspect();
    const beforeDeviceGeneration = beforeLoss.frame.deviceGeneration;
    const lostState = await loseReflectionDevice();
    const recovered = await renderer.recover();
    const recoverCode = recovered.ok ? 'recovered' : recovered.error.code;
    if (!recovered.ok) throw recovered.error;
    let recoveryReceipt: ReflectionEvidenceReceipt | undefined;
    let afterRecovery = renderer.inspect();
    let replacement = deriveReflectionProbeRecoveryEvidence(afterRecovery, beforeDeviceGeneration);
    for (let frame = 0; frame < REFLECTION_PROBE_SETTLE_FRAMES; frame += 1) {
      recoveryReceipt = await drawReflectionEvidenceFrame(passNames);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      afterRecovery = renderer.inspect();
      replacement = deriveReflectionProbeRecoveryEvidence(afterRecovery, beforeDeviceGeneration);
      if (replacement.matchingReplacement && replacement.replacementSsrReady) break;
    }
    const replacementOwner = afterRecovery.reflectionProbes;
    const deviceRecovery: NonNullable<NonNullable<TargetReport['reflectionProbe']>['deviceRecovery']> = {
      triggered: true,
      lostState,
      recoverCode,
      beforeDeviceGeneration,
      beforeSsr: beforeLoss.ssr,
      ...replacement,
    };
    if (!replacement.matchingReplacement || !replacement.replacementSsrReady || recoveryReceipt === undefined) {
      throw new Error(`device replacement receipt mismatch: ${JSON.stringify({ ...deviceRecovery, owner: replacementOwner })}`);
    }
    return { deviceRecovery, owner: replacementOwner, receipt: recoveryReceipt };
  };

  const assertSsrSceneCarrier = (passNames: Set<string>) => {
    const gpuErrors = learnRenderErrors();
    if (gpuErrors.length > 0)
      throw new Error(`ReflectionProbe GPU errors=${JSON.stringify(gpuErrors)}`);
    const gpuDriven = renderer.inspect().renderScene.gpuDriven;
    if (!gpuDriven.submitted || gpuDriven.indirectDrawCount === 0 || gpuDriven.cpuFallbackDrawItems !== 0)
      throw new Error(`SSR attachments disabled GPU-driven work: ${JSON.stringify(gpuDriven)}`);
    const ssr = renderer.inspect().ssr;
    if (ssr.status !== 'admitted') {
      throw new Error(`SSR scene carrier was not admitted: ${JSON.stringify(ssr)}`);
    }
    const ssrPassNames = [...passNames].filter((name) => name.startsWith('ssr-'));
    if (ssrPassNames.length < 4) {
      throw new Error(
        `SSR scene carrier pass roster is incomplete: ${JSON.stringify(ssrPassNames)}`,
      );
    }
    return { gpuErrors, ssr };
  };

  const drawNeutralTransitionFrame = async (): Promise<void> => {
    const updated = world.update(1 / 60);
    if (!updated.ok) throw updated.error;
    const next = renderer.draw({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
    if (!next.ok) throw next.error;
    const completed = await next.value.completed;
    if (!completed.ok) throw completed.error;
  };

  /** Removes the Skylight, observes the committed neutral fallback, then restores the authored scene. */
  const observeNeutralFallback = async (skylight: EntityHandle, passNames: Set<string>) => {
    const removed = world.despawn(skylight);
    if (!removed.ok) throw removed.error;
    // Move the local probe onto the outside renderable. The sphere then
    // becomes the selected neutral consumer while that outside row keeps
    // SSR demand admitted through the same producer-owned probe resource.
    if (sceneEntities.reflectionProbe !== undefined) {
      const movedProbe = world.set(sceneEntities.reflectionProbe, Transform, {
        pos: [2.25, 0, 0],
      });
      if (!movedProbe.ok) throw movedProbe.error;
    }
    await drawNeutralTransitionFrame();
    // The first frame publishes the generation change and resets temporal
    // history; settle one more successful frame before inspecting the
    // committed neutral fallback and its dependent temporal receipt.
    await drawNeutralTransitionFrame();
    // Inspecting the committed source generation intentionally invalidates
    // temporal history tied to the old projection. Submit one more frame
    // after that reset so neutral and temporal receipts share one generation.
    void renderer.inspect().ssrDependencies;
    await drawNeutralTransitionFrame();
    const neutralOwner = structuredClone(renderer.inspect().reflectionProbes);
    const neutralSsrDependencies: SsrDependenciesInspection = structuredClone(renderer.inspect().ssrDependencies);
    // Restore the authored scene before the verifier records its canonical
    // frame. Neutral-fallback diagnostics must not silently become the
    // capture while the report still describes probe/Skylight pixels.
    world.spawn({ component: Skylight, data: { color: [0.55, 0.7, 1], intensity: 1 } }).unwrap();
    if (sceneEntities.reflectionProbe !== undefined) {
      world.set(sceneEntities.reflectionProbe, Transform, { pos: [0, 0, 0] }).unwrap();
    }
    // A moved probe finishes its old cycle, then captures at the restored center.
    // Allow both bounded cycles before recording the canonical display frame.
    for (let settle = 0; settle < 100; settle += 1) await drawReflectionEvidenceFrame(passNames);
    return { neutralOwner, neutralSsrDependencies };
  };

  const captureReflectionProbe = async (): Promise<Uint8Array> => {
    if (!reflectionEvidence) throw new Error('reflection evidence mode is disabled');
    // Own the 60-frame preparation window. A running App can submit another
    // rAF frame while the async fallback readback resolves, which would race
    // the inspection snapshot with a newer candidate. Direct draws remain the
    // real renderer path; pausing only removes that unrelated frame authority.
    const paused = app.pause();
    if (!paused.ok) throw paused.error;
    const passNames = new Set<string>();
    let receipt = await prepareReflectionProbe(passNames);
    let owner = await awaitCommittedProbe(passNames);
    const pixels = await captureCanvasPixels(canvas);
    if (!pixels.ok) throw pixels.error;
    const roi = readReflectionRoi(pixels.value);
    const rawFaces = owner.rawFacesCaptured;
    const filteredSteps = owner.filteredStepsCompleted;
    const mipLevels = owner.filteredMipLevels;
    assertProbeBaseline(owner);
    // Preserve the completed probe publication before the fault and neutral
    // transition fixtures mutate the owner inspection. The verifier needs a
    // source row and readback from this exact baseline, not the replacement
    // device snapshot captured after recovery.
    const initialOwner = structuredClone(owner);
    const initialSsrDependencies = structuredClone(renderer.inspect().ssrDependencies);
    let submitFailure: ReturnType<typeof injectSubmitFailure> | undefined;
    if (faultInstrumentation !== undefined) {
      submitFailure = injectSubmitFailure();
      // A following successful frame must promote the same source-identical
      // candidate back to active before the device replacement scenario.
      await drawReflectionEvidenceFrame(passNames);
      owner = renderer.inspect().reflectionProbes;
    }
    let deviceRecovery: NonNullable<TargetReport['reflectionProbe']>['deviceRecovery'];
    if (faultInstrumentation !== undefined) {
      const replaced = await replaceReflectionDevice(passNames);
      deviceRecovery = replaced.deviceRecovery;
      owner = replaced.owner;
      receipt = replaced.receipt;
    }
    const { gpuErrors, ssr } = assertSsrSceneCarrier(passNames);
    const neutral =
      sceneEntities.skylight === undefined
        ? undefined
        : await observeNeutralFallback(sceneEntities.skylight, passNames);
    const report = (
      globalThis as typeof globalThis & {
        __renderTargetReflectionReport?: TargetReport;
      }
    ).__renderTargetReflectionReport;
    publishReport({
      ...(report ?? baseReport),
      reflectionProbe: {
        frames: REFLECTION_PROBE_CAPTURE_FRAMES,
        rawFaces,
        filteredSteps,
        roughnessLod: [Math.min(...mipLevels, 0), Math.max(...mipLevels, 4)],
        insideSelection: 'probe',
        outsideSelection: 'skylight',
        receiptFrameId: receipt.frameId,
        deviceGeneration: receipt.deviceGeneration,
        pngByteLength: pixels.value.byteLength,
        roi,
        gpuErrors,
        owner,
        ssrDependencies: initialSsrDependencies,
        ssr,
        initialOwner,
        initialSsrDependencies,
        ...(neutral === undefined ? {} : neutral),
        ...(submitFailure === undefined ? {} : { submitFailure }),
        ...(deviceRecovery === undefined ? {} : { deviceRecovery }),
      },
    });
    // The shared browser verifier arms the RHI capture capability immediately
    // after this preparation hook. Resume the loop so captureFrame can pause
    // one bounded frame through the normal App-owned transaction.
    const resumed = app.resume();
    if (!resumed.ok) throw resumed.error;
    return pixels.value;
  };

  const setAtmosphereSettings = atmosphereEvidenceControls(world,assets,sceneEntities);

  // Preparation owns every producer draw; live comparison reads the captured
  // presentation without advancing the cube or probe to a different frame.
  const readReflectionPixels = async (): Promise<Uint8Array> => {
    const pixels = await captureCanvasPixels(canvas);
    if (!pixels.ok) throw pixels.error;
    return pixels.value;
  };

  Object.assign(globalThis, {
    __captureRenderTargetReflection: capture,
    __destroyRenderTargetReflection: () => {
      return renderer.destroyRenderTarget(targetResult.value);
    },
    __renderTargetReflectionLastTickets: () => lastTickets,
    __captureReflectionProbe: captureReflectionProbe,
    __readReflectionPixels: readReflectionPixels,
    __replayReflectionCapture: replayCapturedFrameInBrowser,
    __verifyProbeAtmosphere: async () => {
      if (sceneEntities.reflectionProbe === undefined || sceneEntities.camera === undefined || sceneEntities.movingObject === undefined || sceneEntities.skylight === undefined || sceneEntities.sun === undefined)
        throw new Error('Use the plane and cube fixture');
      app.pause().unwrap();
      world.removeComponent(sceneEntities.camera, ScreenSpaceReflection).unwrap();
      try {
        const report = await verifyProbeAtmosphere(world, renderer, sceneEntities.reflectionProbe, sceneEntities.movingObject, sceneEntities.skylight, sceneEntities.sun,
          async () => {
            world.update(1 / 60).unwrap();
            const frame = await drawReadyFrame(renderer, { leases: [attached.value], camera: { lease: attached.value }, environment: { lease: attached.value } });
            await new Promise<void>(resolve => setTimeout(resolve, 0));
            if (new URLSearchParams(location.search).has('timings')) {
              const observation = await renderer.observe(frame, { include: ['timings'] });
              if (!observation.ok) throw observation.error;
              return observation.value.timings;
            }
            return undefined;
          }, readReflectionPixels);
        Object.assign(globalThis, { __probeAtmosphereEvidence: report });
        return report;
      } finally {
        world.addComponent(sceneEntities.camera, { component: ScreenSpaceReflection, data: SSR_PARAMETERS }).unwrap();
        // Restoring SSR can prepare a new graph before it submits visible work.
        // The shared recorder must capture a ready frame after this transition.
        await drawReadyFrame(renderer, { leases: [attached.value], camera: { lease: attached.value }, environment: { lease: attached.value } });
        app.resume().unwrap();
      }
    },
    __verifyProbeUpdates: async () => {
      if (
        sceneEntities.reflectionProbe === undefined ||
        sceneEntities.movingObject === undefined ||
        sceneEntities.camera === undefined ||
        sceneEntities.receiver === undefined
      )
        throw new Error('Use the probe-updates fixture');
      app.pause().unwrap();
      world.removeComponent(sceneEntities.camera, ScreenSpaceReflection).unwrap();
      try {
        const report = await verifyProbeUpdates(
          world,
          assets,
          renderer,
          sceneEntities.reflectionProbe,
          sceneEntities.movingObject,
          async () => {
            world.update(1 / 60).unwrap();
            const frame = renderer.draw({
              leases: [attached.value],
              camera: { lease: attached.value },
              environment: { lease: attached.value },
            });
            if (!frame.ok) throw frame.error;
            const completed = await frame.value.completed;
            if (!completed.ok) throw completed.error;
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
          },
          readReflectionPixels,
          sceneEntities.receiver,
        );
        Object.assign(globalThis, { __probeUpdateEvidence: report });
        return report;
      } finally {
        world
          .addComponent(sceneEntities.camera, {
            component: ScreenSpaceReflection,
            data: { maxDistance: 12, thickness: 0.2, maxRoughness: 0.65 },
          })
          .unwrap();
        app.resume().unwrap();
      }
    },
    __setAtmosphereEvidence: async (settings: AtmosphereEvidenceSettings) => {
      app.pause().unwrap();
      setAtmosphereSettings(settings);
      let timing;
      const timings=[];
      const cpuDrawMilliseconds=[];
      for (let i=0;i<(settings.frames ?? 3);i++) {
        const cpuStart=performance.now();
        world.update(1/60).unwrap();
        const submitted=renderer.draw({leases:[attached.value],camera:{lease:attached.value},environment:{lease:attached.value}});
        if (!submitted.ok) throw submitted.error;
        cpuDrawMilliseconds.push(performance.now()-cpuStart);
        const receipt=submitted.value;
        const completed=await receipt.completed;
        if (!completed.ok) throw completed.error;
        const observed=await renderer.observe(receipt,{include:['timings']});
        if (observed.ok) {timing=observed.value.timings;timings.push(timing);}
      }
      return {settings,timing,timings,cpuDrawMilliseconds,inspection:renderer.inspect(),distances:[100,1000,5000,20000],solarLux:100000,exposure:1/5000};
    },
    __inspectSsr: () => renderer.inspect(),
    __inspectSsrExecution: () => app.execution.report(),
    // Bounded evidence uses App's own paused-frame driver. Capture advances
    // exactly one submitted frame, retaining the live history between tapes.
    __setSsrEvidencePaused: (paused: boolean) => {
      const result = paused ? app.pause() : app.resume();
      if (!result.ok) throw result.error;
    },
    __stepSsrEvidenceFrame: async (timings = false) => {
      let unsubscribe = () => {};
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const submitted = timings ? new Promise<import('@forgeax/engine-render').FrameReceipt>((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Paused App frame did not submit')), 5000);
        unsubscribe = renderer.subscribe(event => {
          if (event.kind === 'frame-submitted') resolve(event.receipt);
        });
      }) : undefined;
      try {
        const cpuStart = performance.now();
        const result = app.stepFrame(0);
        const cpuSubmissionMs = performance.now() - cpuStart;
        if (!result.ok) throw result.error;
        if (submitted === undefined) return renderer.inspect().temporal;
        const receipt = await submitted;
        const completed = await receipt.completed;
        if (!completed.ok) throw completed.error;
        const observation = await renderer.observe(receipt, { include: ['timings'] });
        if (!observation.ok) throw observation.error;
        return { frameId: receipt.frameId, cpuSubmissionMs, timings: observation.value.timings,
          inspection: renderer.inspect(), execution: app.execution.report() };
      } finally {
        unsubscribe();
        if (timeout !== undefined) clearTimeout(timeout);
      }
    },
  });
  publishReport(baseReport);

  const reflectionControls = document.getElementById('reflection-controls');
  if (reflectionControls === null) throw new Error('Reflection controls container is missing');
  if (sceneEntities.reflectionProbe !== undefined) {
    const probe = sceneEntities.reflectionProbe;
    const snapshotProbe = () => {
      const data = world.get(probe, ReflectionProbe).unwrap();
      return { ...data, halfExtents: data.halfExtents.slice() };
    };
    let probeData = snapshotProbe();
    let probeEnabled = true;
    const probeButton = document.createElement('button');
    probeButton.id = 'probe-toggle';
    const setProbeEnabled = (value: boolean) => {
      if (value === probeEnabled) return;
      if (value) world.addComponent(probe, { component: ReflectionProbe, data: probeData }).unwrap();
      else {
        probeData = snapshotProbe();
        world.removeComponent(probe, ReflectionProbe).unwrap();
      }
      select.disabled = !value;
      refresh.disabled = !value;
      probeEnabled = value;
      probeButton.textContent = value ? 'Probe on' : 'Probe off';
      probeButton.setAttribute('aria-pressed', String(value));
    };
    probeButton.textContent = 'Probe on';
    probeButton.setAttribute('aria-pressed', 'true');
    probeButton.addEventListener('click', () => setProbeEnabled(!probeEnabled));
    reflectionControls.append(probeButton);
    Object.assign(globalThis, { __setProbeEnabled: setProbeEnabled });
    Object.assign(globalThis, {
      __setProbeUpdateIntent: (intent: 'once' | 'on-change' | 'continuous') => {
        const value = { once: 0, 'on-change': 1, continuous: 2 }[intent];
        if (value === undefined) throw new Error('Unknown probe update intent');
        world.set(probe, ReflectionProbe, { updateIntent: value }).unwrap();
      },
      __invalidateProbe: () => {
        const current = world.get(probe, ReflectionProbe).unwrap().invalidationVersion;
        world.set(probe, ReflectionProbe, { invalidationVersion: current + 1 }).unwrap();
      },
    });
    const select = document.createElement('select');
    select.id = 'probe-update';
    select.setAttribute('aria-label', 'Reflection probe updates');
    for (const [value, label] of [
      ['once', 'Probe: capture once'],
      ['on-change', 'Probe: update on scene changes'],
      ['continuous', 'Probe: continuous updates'],
    ]) {
      const option = document.createElement('option');
      option.value = value!;
      option.textContent = label!;
      select.append(option);
    }
    select.value = ['once', 'on-change', 'continuous'][probeData.updateIntent] ?? 'once';
    select.addEventListener('change', () => {
      const value = { once: 0, 'on-change': 1, continuous: 2 }[
        select.value as 'once' | 'on-change' | 'continuous'
      ];
      world.set(probe, ReflectionProbe, { updateIntent: value }).unwrap();
    });
    reflectionControls.append(select);
    const refresh = document.createElement('button');
    refresh.id = 'probe-refresh';
    refresh.textContent = 'Capture now';
    refresh.addEventListener('click', () => {
      const current = world.get(probe, ReflectionProbe).unwrap().invalidationVersion;
      world.set(probe, ReflectionProbe, { invalidationVersion: current + 1 }).unwrap();
    });
    reflectionControls.append(refresh);
  }

  if (sceneEntities.movingObject !== undefined) {
    const object = sceneEntities.movingObject;
    const origin = Array.from(world.get(object, Transform).unwrap().pos);
    Object.assign(globalThis, {
      __setSsrObjectOffset: (offset: number) => {
        if (!Number.isFinite(offset) || Math.abs(offset) > 1) {
          throw new Error('SSR evidence object offset must be within [-1, 1]');
        }
        world
          .set(object, Transform, {
            pos: [origin[0]! + offset, origin[1]!, origin[2]!],
          })
          .unwrap();
      },
    });
  }

  if (sceneEntities.camera !== undefined) {
    const camera = sceneEntities.camera;
    const cameraOrigin = Array.from(world.get(camera, Transform).unwrap().pos);
    Object.assign(globalThis, {
      // Capture changes authored pose through World; App still owns frames
      // and the renderer derives the real motion vectors and history gates.
      __setSsrCameraOffset: (offset: number) => {
        if (!Number.isFinite(offset) || Math.abs(offset) > 1) {
          throw new Error('SSR evidence camera offset must be within [-1, 1]');
        }
        world
          .set(camera, Transform, {
            pos: [cameraOrigin[0]! + offset, cameraOrigin[1]!, cameraOrigin[2]! - offset],
          })
          .unwrap();
      },
    });
    let enabled = true;
    const button = document.createElement('button');
    button.id = 'ssr-toggle';
    button.textContent = 'SSR on — click to compare';
    const setEnabled = (value: boolean) => {
      if (value === enabled) return;
      if (value)
        world
          .addComponent(sceneEntities.camera!, {
            component: ScreenSpaceReflection,
            data: SSR_PARAMETERS,
          })
          .unwrap();
      else world.removeComponent(sceneEntities.camera!, ScreenSpaceReflection).unwrap();
      enabled = value;
      button.textContent = enabled
        ? 'SSR on — click to compare'
        : 'SSR off — probe / environment only';
      button.setAttribute('aria-pressed', String(enabled));
    };
    button.setAttribute('aria-pressed', 'true');
    button.addEventListener('click', () => setEnabled(!enabled));
    reflectionControls.append(button);
    Object.assign(globalThis, { __setSsrEnabled: setEnabled });
  }
  if (reflectionEvidence) installSurfaceControls(reflectionControls, world, renderer, sceneEntities.movingObject, sceneEntities.skylight);
  const started = app.start();
  if (!started.ok) {
    reportError('[hello-ssr] app.start failed', started.error);
    return;
  }
  Object.assign(globalThis, { __learnRenderBootstrapComplete: true });
}

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error('[hello-ssr] missing #app canvas');
}
const defaultResolution = import.meta.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1' ? 128 : 512;
const resolution = Number(
  new URLSearchParams(location.search).get('resolution') ?? defaultResolution,
);
if (!Number.isInteger(resolution) || resolution < 128 || resolution > 2048) {
  throw new Error('[hello-ssr] resolution must be an integer in [128, 2048]');
}
const renderHeight = Number(new URLSearchParams(location.search).get('height') ?? resolution);
if (!Number.isInteger(renderHeight) || renderHeight < 128 || renderHeight > 2048) {
  throw new Error('[hello-ssr] height must be an integer in [128, 2048]');
}
canvas.width = resolution;
canvas.height = renderHeight;
canvas.style.width = `${resolution}px`;
canvas.style.height = `${renderHeight}px`;
document.documentElement.style.setProperty('--render-size', `${resolution}px`);
const fixtureDescription = document.getElementById('fixture-description');
if (fixtureDescription !== null) {
  const fixture = new URLSearchParams(location.search).get('fixture') ?? 'cube';
  fixtureDescription.textContent =
    fixture === 'cube'
      ? 'Plane + cube · compare SSR and local probe independently'
      : fixture === 'underside'
      ? 'Open-bottom shell · smooth floor (roughness 0.08)'
      : fixture === 'objects'
        ? 'Textured objects · smooth floor (roughness 0.12)'
        : fixture === 'probe-updates'
          ? 'Probe update fixture · bounded textured floor'
        : '8 × 8 floor tiles · fixed-seed roughness 0.08–0.85';
}

if (import.meta.env.VITE_REFLECTION_PROBE_EVIDENCE === '0') mountCubeFaceLegend();

const bootstrapPromise = bootstrap(canvas);
void bootstrapPromise.catch((error: unknown) => {
  if (error instanceof EngineEnvironmentError) {
    reportError('[hello-ssr] environment failure', error);
    return;
  }
  reportError('[hello-ssr] bootstrap failure', error);
});
trackLearnRenderTestBootstrap(bootstrapPromise, canvas);

declare global {
  interface Window {
    __captureRenderTargetReflection?: () => Promise<Uint8Array>;
    __destroyRenderTargetReflection?: () => unknown;
    __learnRenderBootstrapComplete?: boolean;
    __learnRenderErrors?: LearnRenderError[];
    __renderTargetReflectionLastTickets?: () => readonly RenderTargetReadbackTicket[];
    __renderTargetReflectionReport?: TargetReport;
    __captureReflectionProbe?: () => Promise<Uint8Array>;
    __readReflectionPixels?: () => Promise<Uint8Array>;
    __replayReflectionCapture?: typeof replayCapturedFrameInBrowser;
  }
}
