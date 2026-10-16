import { HANDLE_SPHERE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createPlaneGeometry } from '@forgeax/engine-geometry';
import {
  Camera,
  ANTIALIAS_NONE,
  DEFAULT_STANDARD_PROFILE,
  LightProbe,
  Materials,
  MeshFilter,
  MeshRenderer,
  RectAreaLight,
  Skylight,
  SpotLight,
  TONEMAP_ACES_FILMIC,
  type FrameReceipt,
  type Renderer,
  type RenderInspection,
  type RenderWorldLease,
} from '@forgeax/engine-render';
import type { RendererLegacyHostAdapter } from '@forgeax/engine-render/internal/construct-renderer';
import { ok, type RhiDevice, type RhiInstance } from '@forgeax/engine-rhi';
import {
  _internal_getRawDevice,
  rhi as webgpuRhi,
  translateErrorEventToRhiError,
} from '@forgeax/engine-rhi-webgpu';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
import { Transform } from '@forgeax/engine-scene';
import type {
  Handle,
  IesProfileAsset,
  MaterialAsset,
  MeshAsset,
  TextureAsset,
} from '@forgeax/engine-types';
import type { LightingSceneManifest } from './lighting-reference';
import { constantProbeSh } from './probe-reference';

export const EXTENDED_LIGHTING_RUNTIME_MODES = [
  'rect',
  'ies',
  'cookie',
  'probe',
  'spot-combined',
  'probe-boundary',
  'probe-radius',
  'probe-no-sky',
  'recovery',
  'rect-backface',
] as const;

export type ExtendedLightingRuntimeMode = (typeof EXTENDED_LIGHTING_RUNTIME_MODES)[number];

export interface ExtendedLightingRuntimeAssets {
  readonly ies: IesProfileAsset;
  readonly cookie: TextureAsset;
}

export interface ExtendedLightingRuntimeSession {
  readonly renderer: Renderer;
  readonly observationHost: RendererLegacyHostAdapter;
  readonly device: RhiDevice;
  readonly world: World;
  readonly lease: RenderWorldLease;
  readonly frameCount: number;
  readonly lastReceipt: FrameReceipt;
  readonly renderErrors: readonly {
    readonly code: string;
    readonly expected?: string;
    readonly hint?: string;
  }[];
  /** Test-only real-device loss trigger used by the recovery carrier. */
  readonly forceDeviceLoss?: () => void;
  inspect(): RenderInspection;
  draw(frameCount?: number): Promise<FrameReceipt>;
  dispose(): Promise<void>;
}

type RuntimeBundler = Parameters<typeof constructRuntimeRendererHost>[2];

interface ControlledDeviceLoss {
  readonly force: () => void;
  readonly rhi: RhiInstance;
}

function linearMaterialColor(
  rgba: readonly [number, number, number, number],
  colorSpace: 'srgb' | 'linear',
): readonly [number, number, number, number] {
  return colorSpace === 'srgb' ? Materials.srgb(rgba) : rgba;
}

/**
 * Wrap the browser RHI only for the recovery carrier. The raw GPU device is
 * still destroyed by the caller, but its loss promise is projected as an
 * unknown loss so the production recovery state machine is exercised instead
 * of the intentional `destroyed` teardown branch. The RhiDevice object is
 * kept intact (rather than cloned) so the WebGPU shim's opaque-handle maps
 * continue to resolve shader modules and canvas configuration.
 */
function createControlledDeviceLoss(
  destroyCurrentDevice: () => void,
): ControlledDeviceLoss {
  let triggerCurrent: (() => void) | undefined;
  const controlledRhi = Object.assign({}, webgpuRhi, {
    _internal_getRawDevice,
    translateErrorEventToRhiError,
    async requestAdapter(...args: Parameters<RhiInstance['requestAdapter']>) {
      const adapterResult = await webgpuRhi.requestAdapter(...args);
      if (!adapterResult.ok) return adapterResult;
      const adapter = adapterResult.value;
      return ok({
        features: adapter.features,
        limits: adapter.limits,
        async requestDevice(...deviceArgs: Parameters<typeof adapter.requestDevice>) {
          const deviceResult = await adapter.requestDevice(...deviceArgs);
          if (!deviceResult.ok) return deviceResult;
          let settled = false;
          let resolveLoss: (
            info: { readonly reason: 'destroyed' | 'unknown'; readonly message: string },
          ) => void;
          const lost = new Promise<{
            readonly reason: 'destroyed' | 'unknown';
            readonly message: string;
          }>((resolve) => {
            resolveLoss = resolve;
          });
          Object.defineProperty(deviceResult.value, 'lost', {
            configurable: true,
            value: lost,
          });
          triggerCurrent = () => {
            if (settled) return;
            settled = true;
            triggerCurrent = undefined;
            resolveLoss({ reason: 'unknown', message: 'controlled comparison loss' });
            destroyCurrentDevice();
          };
          return deviceResult;
        },
      });
    },
  }) as RhiInstance;
  return {
    rhi: controlledRhi,
    force: () => {
      if (triggerCurrent === undefined) {
        throw new Error('controlled device-loss trigger is not armed');
      }
      triggerCurrent();
    },
  };
}

function spawnMesh(
  world: World,
  mesh: Handle<'MeshAsset', 'shared'>,
  material: Handle<'MaterialAsset', 'shared'>,
  pos: readonly [number, number, number],
  scale: readonly [number, number, number] = [1, 1, 1],
): void {
  world
    .spawn(
      { component: Transform, data: { pos, scale } },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
}

function allocateMaterial(world: World, material: MaterialAsset): Handle<'MaterialAsset', 'shared'> {
  return world.allocSharedRef('MaterialAsset', material);
}

function allocateMesh(world: World, mesh: MeshAsset): Handle<'MeshAsset', 'shared'> {
  return world.allocSharedRef('MeshAsset', mesh);
}

function spawnProbe(
  world: World,
  identity: readonly [number, number, number],
  position: readonly [number, number, number],
  radius: number,
): void {
  world
    .spawn(
      { component: Transform, data: { pos: position } },
      {
        component: LightProbe,
        data: { irradiance: new Float32Array(constantProbeSh(identity)), radius },
      },
    )
    .unwrap();
}

function spawnProbeReceivers(
  world: World,
  positions: readonly number[],
  manifest: LightingSceneManifest,
  radius = 0.58,
): void {
  const probeMaterial = manifest.materials.probe;
  const sphereMaterial = allocateMaterial(
    world,
    Materials.standard({
      baseColor: linearMaterialColor(probeMaterial.baseColor, manifest.materials.colorSpace),
      metallic: probeMaterial.metallic,
      roughness: probeMaterial.roughness,
    }),
  );
  for (const x of positions) {
    spawnMesh(world, HANDLE_SPHERE, sphereMaterial, [x, -0.05, 0], [radius, radius, radius]);
  }
}

function populateProbeWorld(
  world: World,
  mode: ExtendedLightingRuntimeMode,
  manifest: LightingSceneManifest,
): void {
  const probeRow = manifest.geometry.probeRow;
  const rowPositions = Array.from(
    { length: probeRow.count },
    (_, index) => probeRow.startX + index * probeRow.step,
  );
  const skylight = manifest.lighting.skylight;
  if (mode === 'probe-boundary') {
    spawnProbeReceivers(world, [-4.2, -3.5, -2.1, 0, 2.1, 3.5, 4.2], manifest, 0.48);
    world.spawn({ component: Skylight, data: { color: skylight.probe.color, intensity: skylight.probe.intensity } }).unwrap();
    spawnProbe(world, [18, 0.12, 0.04], [0, 0, 0], 4.2);
    return;
  }
  if (mode === 'probe-radius') {
    spawnProbeReceivers(world, rowPositions, manifest, probeRow.radius);
    world.spawn({ component: Skylight, data: { color: [0.18, 0.24, 0.4], intensity: 0.7 } }).unwrap();
    spawnProbe(world, [18, 0.12, 0.04], [-1.8, 0, 0], 2.6);
    spawnProbe(world, [0.04, 0.2, 18], [1.8, 0, 0], 5.2);
    return;
  }
  spawnProbeReceivers(world, rowPositions, manifest, probeRow.radius);
  if (mode !== 'probe-no-sky') {
    world.spawn({ component: Skylight, data: { color: skylight.probe.color, intensity: skylight.probe.intensity } }).unwrap();
  }
  spawnProbe(world, [18, 0.12, 0.04], [-2.7, 0, 0], 4.2);
  spawnProbe(world, [0.04, 0.2, 18], [2.7, 0, 0], 4.2);
}

function spawnRect(
  world: World,
  reversed: boolean,
  manifest: LightingSceneManifest,
): void {
  const rect = manifest.lighting.rect;
  const emitterMesh = createPlaneGeometry(rect.emitterSize[0], rect.emitterSize[1]).unwrap();
  const emitter = allocateMaterial(
    world,
    Materials.unlit(linearMaterialColor([1, 0.68, 0.26, 1], manifest.materials.colorSpace)),
  );
  spawnMesh(world, allocateMesh(world, emitterMesh), emitter, rect.emitterPosition);
  world
    .spawn(
      {
        component: Transform,
        data: { pos: rect.position, quat: reversed ? [0, 0, 0, 1] : [0, 1, 0, 0] },
      },
      {
        component: RectAreaLight,
        data: {
          color: rect.color,
          intensity: rect.intensity,
          width: rect.width,
          height: rect.height,
          range: rect.range,
        },
      },
    )
    .unwrap();
}

function spawnSpot(
  world: World,
  mode: ExtendedLightingRuntimeMode,
  assets: ExtendedLightingRuntimeAssets,
  manifest: LightingSceneManifest,
  plainSpot = false,
): void {
  const useIes = !plainSpot && (mode === 'ies' || mode === 'spot-combined' || mode === 'recovery');
  const useCookie = !plainSpot && (mode === 'cookie' || mode === 'spot-combined' || mode === 'recovery');
  const spot = manifest.lighting.spot;
  world
    .spawn(
      { component: Transform, data: { pos: spot.position } },
      {
        component: SpotLight,
        data: {
          direction: spot.direction,
          color: plainSpot || (useIes && !useCookie) ? spot.iesColor : spot.cookieColor,
          intensity: spot.intensity,
          range: spot.range,
          innerConeDeg: spot.innerConeDeg,
          outerConeDeg: spot.outerConeDeg,
          castShadow: mode === 'spot-combined' || mode === 'recovery',
          rollDeg: useIes ? spot.rollDeg : 0,
          ...(useIes ? { iesProfile: world.allocSharedRef('IesProfileAsset', assets.ies) } : {}),
          ...(useCookie ? { cookie: world.allocSharedRef('TextureAsset', assets.cookie) } : {}),
        },
      },
    )
    .unwrap();
}

export function populateExtendedLightingWorld(
  world: World,
  mode: ExtendedLightingRuntimeMode,
  assets: ExtendedLightingRuntimeAssets,
  aspect: number,
  manifest: LightingSceneManifest,
  comparisonMode = false,
  plainSpot = false,
): void {
  const camera = manifest.camera;
  world
    .spawn(
      { component: Transform, data: { pos: camera.position, quat: camera.rotation } },
      {
        component: Camera,
        data: {
          fov: (camera.fovDeg * Math.PI) / 180,
          aspect,
          near: camera.near,
          far: camera.far,
          antialias: ANTIALIAS_NONE,
          clearColor: camera.clearColor,
          tonemap: TONEMAP_ACES_FILMIC,
          exposure: manifest.exposure.value,
        },
      },
    )
    .unwrap();

  if (mode === 'probe' || mode === 'probe-boundary' || mode === 'probe-radius' || mode === 'probe-no-sky') {
    populateProbeWorld(world, mode, manifest);
    return;
  }

  const [planeWidth, planeHeight, planeWidthSegments, planeHeightSegments] = manifest.geometry.receiverPlane;
  const plane = createPlaneGeometry(planeWidth, planeHeight, planeWidthSegments, planeHeightSegments).unwrap();
  const planeHandle = allocateMesh(world, plane);
  const receiverMaterial = manifest.materials.receiver;
  const receiver = allocateMaterial(
    world,
    Materials.standard({
      baseColor: linearMaterialColor(receiverMaterial.baseColor, manifest.materials.colorSpace),
      metallic: receiverMaterial.metallic,
      roughness: receiverMaterial.roughness,
    }),
  );
  const glossyMaterial = manifest.materials.glossy;
  const glossy = allocateMaterial(
    world,
    Materials.standard({
      baseColor: linearMaterialColor(glossyMaterial.baseColor, manifest.materials.colorSpace),
      metallic: glossyMaterial.metallic,
      roughness: glossyMaterial.roughness,
    }),
  );
  spawnMesh(world, planeHandle, receiver, [0, 0, 0]);
  for (const sphere of manifest.geometry.glossySpheres) {
    spawnMesh(world, HANDLE_SPHERE, glossy, sphere.position, [sphere.radius, sphere.radius, sphere.radius]);
  }

  if (mode === 'rect' || mode === 'rect-backface') {
    spawnRect(world, mode === 'rect-backface', manifest);
    return;
  }
  if (mode === 'recovery') {
    spawnRect(world, false, manifest);
    spawnProbe(world, [4, 0.1, 0.04], [-2.5, 0, 0], 3.8);
    spawnProbe(world, [0.04, 0.1, 4], [2.5, 0, 0], 3.8);
    world.spawn({ component: Skylight, data: { color: manifest.lighting.skylight.recovery.color, intensity: manifest.lighting.skylight.recovery.intensity } }).unwrap();
  }
  spawnSpot(world, mode, assets, manifest, plainSpot);
  // Three's native IES/SpotLight.map references in this app contain no
  // environment light. Suppress the authored direct Skylight only for the
  // explicit A/B scene so the diff measures the spot implementation rather
  // than an extra product-only ambient contribution. Standalone ForgeaX
  // demos retain the authored direct Skylight.
  if (mode !== 'recovery' && !comparisonMode) {
    world.spawn({ component: Skylight, data: { color: manifest.lighting.skylight.direct.color, intensity: manifest.lighting.skylight.direct.intensity } }).unwrap();
  }
}

async function drawFrames(
  renderer: Renderer,
  world: World,
  lease: RenderWorldLease,
  frameCount: number,
): Promise<FrameReceipt> {
  let receipt: FrameReceipt | undefined;
  for (let frame = 0; frame < frameCount; frame += 1) {
    world.update().unwrap();
    const drawn = renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } });
    if (!drawn.ok) throw drawn.error;
    receipt = drawn.value;
    const completed = await receipt.completed;
    if (!completed.ok) throw completed.error;
  }
  if (receipt === undefined) throw new Error('extended-lighting runtime submitted no frames');
  return receipt;
}

export async function createExtendedLightingRuntime(input: {
  readonly canvas: HTMLCanvasElement;
  readonly mode: ExtendedLightingRuntimeMode;
  readonly assets: ExtendedLightingRuntimeAssets;
  readonly manifest: LightingSceneManifest;
  readonly bundler: RuntimeBundler;
  readonly frameCount?: number;
  /** Match the independent Three reference's absence of direct environment light. */
  readonly comparisonMode?: boolean;
  /** Test-only controlled baseline that removes IES/Cookie from the Spot. */
  readonly plainSpot?: boolean;
  readonly deviceLoss?: {
    readonly destroyCurrentDevice: () => void;
  };
}): Promise<ExtendedLightingRuntimeSession> {
  const controlledLoss =
    input.deviceLoss === undefined
      ? undefined
      : createControlledDeviceLoss(input.deviceLoss.destroyCurrentDevice);
  const constructed = await constructRuntimeRendererHost(
    input.canvas,
    {
      standardProfile: DEFAULT_STANDARD_PROFILE,
      ...(controlledLoss === undefined ? {} : { rhi: controlledLoss.rhi }),
    },
    input.bundler,
  );
  if (!constructed.ok) throw constructed.error;
  const renderer = constructed.value.renderer;
  const observationHost = constructed.value.debugDrawHost as unknown as RendererLegacyHostAdapter;
  const renderErrors: {
    code: string;
    expected?: string;
    hint?: string;
  }[] = [];
  const removeErrorListener = observationHost.onError((error) => {
    const candidate = error as unknown as {
      code?: unknown;
      expected?: unknown;
      hint?: unknown;
    };
    renderErrors.push({
      code: typeof candidate.code === 'string' ? candidate.code : 'unknown-render-error',
      ...(typeof candidate.expected === 'string' ? { expected: candidate.expected } : {}),
      ...(typeof candidate.hint === 'string' ? { hint: candidate.hint } : {}),
    });
  });
  const world = new World();
  populateExtendedLightingWorld(
    world,
    input.mode,
    input.assets,
    input.canvas.width / input.canvas.height,
    input.manifest,
    input.comparisonMode ?? false,
    input.plainSpot ?? false,
  );
  const attached = renderer.attach(world);
  if (!attached.ok) {
    removeErrorListener();
    await renderer.dispose();
    throw attached.error;
  }
  const lease = attached.value;
  const frameCount = input.frameCount ?? 12;
  const lastReceipt = await drawFrames(renderer, world, lease, frameCount);
  let disposed = false;
  return {
    renderer,
    observationHost,
    get device() {
      return constructed.value.debugDrawHost.device;
    },
    world,
    lease,
    frameCount,
    lastReceipt,
    renderErrors,
    ...(controlledLoss === undefined ? {} : { forceDeviceLoss: controlledLoss.force }),
    inspect: () => renderer.inspect(),
    draw: (count = 1) => drawFrames(renderer, world, lease, count),
    async dispose() {
      if (disposed) return;
      disposed = true;
      removeErrorListener();
      lease.dispose();
      const result = await renderer.dispose();
      if (!result.ok) throw result.error;
    },
  };
}
