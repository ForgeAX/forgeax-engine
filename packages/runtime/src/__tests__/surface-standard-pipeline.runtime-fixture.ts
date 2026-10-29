import { type App, createApp } from '@forgeax/engine-app';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { type EntityHandle, Time, Update, World } from '@forgeax/engine-ecs';
import { createPlaneGeometry } from '@forgeax/engine-geometry';
import { mat4 } from '@forgeax/engine-math';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  ANTIALIAS_MSAA,
  CAMERA_PROJECTION_ORTHOGRAPHIC,
  type CAMERA_PROJECTION_PERSPECTIVE,
  Camera,
  DirectionalLight,
  type FrameReceipt,
  Instances,
  LightProbe,
  Materials,
  MeshFilter,
  MeshRenderer,
  ReadonlyDynamicInputPage,
  type Renderer,
  type RenderWorldLease,
  type SurfaceDynamicInputFrame,
  type SurfaceDynamicInputMemberIdentity,
} from '@forgeax/engine-render';
import { type RhiDevice, RhiError } from '@forgeax/engine-rhi';
import { GlobalTransform, propagateTransforms, Transform } from '@forgeax/engine-scene';
import type { AssetHandle, MaterialAsset } from '@forgeax/engine-types';
import { ok } from '@forgeax/engine-types';
import {
  loadVfxGpuEffect,
  ParticleEffectPlayer,
  VFX_GPU_RUNTIME_RESOURCE_KEY,
  type VfxGpuRuntime,
} from '@forgeax/engine-vfx';
import { createVfxRuntimeHost, type VfxRuntimeHost } from '@forgeax/engine-vfx-render';
import {
  SURFACE_OPTICAL_BACKGROUND_GUID,
  SURFACE_OPTICAL_BACKGROUND_SOURCE_KEY,
  SURFACE_OPTICAL_CASES,
  type SurfaceOpticalEvidenceCase,
  type SurfaceOpticalParameters,
} from '../../../../apps/preview/src/surface-optical-evidence';
import { surfaceEvidenceGuid } from '../../../../apps/preview/src/surface-standard-evidence-identity';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import quality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import {
  assetGuid,
  PACKAGE_IDS,
  RUSTED_IRON_MATERIAL_GUID,
} from '../../../../templates/game-3d/assets/shared/asset-refs';
import { testPlatform } from '../../../app/src/__tests__/platform-fixture';
import type { RhiBackendInstrumentation } from '../../../render/src/assembly/backend-contract';
import { extractCameraSnapshots } from '../../../render/src/render-system-extract';
import { installDefaultAssetDecoders } from '../asset-contributions';
import { testAssets } from './helpers/runtime-assets';
import {
  compareSurfaceAppLifecycleRois,
  createSurfaceAppLifecycleCoverageMask,
  createSurfaceAppLifecycleMask,
  readSurfaceAppLifecycleRoi,
  type SurfaceAppLifecycleComparison,
  type SurfaceAppLifecycleRoi,
} from './surface-app-lifecycle-oracle';
import {
  createSurfaceMsaaEdgeMask,
  evaluateSurfaceMsaaEdgeMask,
  type SurfaceMsaaEdgeGeometry,
  type SurfaceMsaaEdgeResolveExpectation,
  surfaceRgbDistance,
} from './surface-msaa-edge-oracle';

export const SURFACE_CLOSURE = 'forgeax_material::surface_v1';
export const SURFACE_WIDTH = quality.viewport.width;
export const SURFACE_HEIGHT = quality.viewport.height;
export const SURFACE_PIXEL_EPSILON = 0.05;
export const SURFACE_OPTICAL_PIXEL_EPSILON = 0.05;
export const SURFACE_OPTICAL_WIDTH = SURFACE_WIDTH;
export const SURFACE_OPTICAL_HEIGHT = SURFACE_HEIGHT;
export const SURFACE_OPTICAL_ORTHO = Object.freeze({
  left: -3,
  right: 3,
  bottom: -2,
  top: 2,
  cameraZ: 8,
  near: 0.1,
  far: 20,
});

const SURFACE_CELL_SPACING = 1.45;
const SURFACE_PLANE_SIZE = 1.3;

function requireSurfaceReceiptBackendId(
  receipt: FrameReceipt,
  context: string,
): NonNullable<FrameReceipt['backendId']> {
  const backendId = receipt.backendId;
  if (backendId === undefined) {
    throw new Error(`${context}: completed receipt has no backend identity`);
  }
  return backendId;
}

type SurfaceOpticalProjection =
  | typeof CAMERA_PROJECTION_ORTHOGRAPHIC
  | typeof CAMERA_PROJECTION_PERSPECTIVE;

/**
 * Independent surface-to-camera ray used by the optical reference. An
 * orthographic camera contributes one parallel ray for every surface point;
 * a perspective camera contributes the position-dependent camera delta. The
 * orthographic direction is an explicit fixture camera-pose fact (the optical
 * camera uses the identity rotation, so surface-to-camera is +Z), rather than
 * a product optical helper or a direction inferred from the sampled point.
 */
export function evaluateSurfaceOpticalViewDirection(
  projection: SurfaceOpticalProjection,
  surfacePosition: readonly [number, number, number],
  cameraPosition: readonly [number, number, number],
  fixtureOrthographicSurfaceToCamera: readonly [number, number, number],
): readonly [number, number, number] {
  const ray =
    projection === CAMERA_PROJECTION_ORTHOGRAPHIC
      ? fixtureOrthographicSurfaceToCamera
      : ([
          cameraPosition[0] - surfacePosition[0],
          cameraPosition[1] - surfacePosition[1],
          cameraPosition[2] - surfacePosition[2],
        ] as const);
  const length = Math.hypot(ray[0], ray[1], ray[2]);
  if (!Number.isFinite(length) || length <= Number.EPSILON) {
    throw new Error('surface-optical: surface-to-camera direction is degenerate');
  }
  return [ray[0] / length, ray[1] / length, ray[2] / length];
}

export type { SurfaceOpticalEvidenceCase, SurfaceOpticalParameters };
export {
  SURFACE_OPTICAL_BACKGROUND_GUID,
  SURFACE_OPTICAL_BACKGROUND_SOURCE_KEY,
  SURFACE_OPTICAL_CASES,
};

export const SURFACE_CASES = [
  {
    id: 'default-base',
    guid: AssetGuid.format(assetGuid(PACKAGE_IDS.materials, 'material/ground')),
    sourceKey: 'material/ground',
    sourceClosure: ['templates/game-3d/assets/materials.pack.ts'],
    pass: 'deferred',
    rootPlan: 'base-deferred',
  },
  {
    id: 'custom-base',
    guid: AssetGuid.format(RUSTED_IRON_MATERIAL_GUID),
    sourceKey: 'material/rusted-iron',
    sourceClosure: [
      'templates/game-3d/assets/materials.pack.ts',
      'templates/game-3d/assets/shaders/rusted-iron.wgsl',
    ],
    pass: 'deferred',
    rootPlan: 'base-deferred',
  },
  {
    id: 'default-physical',
    guid: surfaceEvidenceGuid('material/painted-evidence'),
    sourceKey: 'material/painted-evidence',
    sourceClosure: ['apps/preview/assets/surface-standard-evidence.pack.ts'],
    pass: 'forward',
    rootPlan: 'physical-forward',
  },
  {
    id: 'custom-physical',
    guid: surfaceEvidenceGuid('material/rusted-iron-custom-physical'),
    sourceKey: 'material/rusted-iron-custom-physical',
    sourceClosure: [
      'apps/preview/assets/surface-standard-evidence.pack.ts',
      'templates/game-3d/assets/shaders/rusted-iron.wgsl',
    ],
    pass: 'forward',
    rootPlan: 'physical-forward',
  },
  {
    id: 'water-surface-a',
    guid: surfaceEvidenceGuid('material/water-surface-a'),
    sourceKey: 'material/water-surface-a',
    sourceClosure: [
      'apps/preview/assets/surface-standard-evidence.pack.ts',
      'apps/preview/assets/shaders/water-surface-a.wgsl',
    ],
    pass: 'forward',
    rootPlan: 'single-layer-medium',
  },
  {
    id: 'water-surface-b',
    guid: surfaceEvidenceGuid('material/water-surface-b'),
    sourceKey: 'material/water-surface-b',
    sourceClosure: [
      'apps/preview/assets/surface-standard-evidence.pack.ts',
      'apps/preview/assets/shaders/water-surface-b.wgsl',
    ],
    pass: 'forward',
    rootPlan: 'single-layer-medium',
  },
] as const;

export type SurfaceCase = (typeof SURFACE_CASES)[number];

export function createSurfaceWaterInstanceTransforms(): Float32Array {
  const transforms = new Float32Array(32);
  for (let instance = 0; instance < 2; instance += 1) {
    const offset = instance * 16;
    transforms[offset] = 1;
    transforms[offset + 5] = 1;
    transforms[offset + 10] = 1;
    transforms[offset + 15] = 1;
    transforms[offset + 12] = instance === 0 ? -0.18 : 0.18;
  }
  return transforms;
}

export function parseSurfaceGuid(guid: string): AssetGuid {
  const parsed = AssetGuid.parse(guid);
  if (!parsed.ok) throw new Error(`surface-standard: invalid fixture GUID ${guid}`);
  return parsed.value;
}

export function assertMaterialPayload(
  surfaceCase: SurfaceCase,
  material: MaterialAsset,
): MaterialAsset {
  if (material.passes === undefined || material.passes.length === 0) {
    throw new Error(`surface-standard: ${surfaceCase.id} has no cooked passes`);
  }
  const expectedSurfaceModule =
    surfaceCase.id === 'water-surface-a'
      ? 'preview::water_surface_a'
      : surfaceCase.id === 'water-surface-b'
        ? 'preview::water_surface_b'
        : surfaceCase.id.includes('custom')
          ? 'game_3d::rusted_iron_surface'
          : 'forgeax_material::default_standard_surface';
  const firstPass = material.passes[0];
  const expectedProgram = surfaceCase.id.startsWith('water-')
    ? 'forgeax::single-layer-medium'
    : 'forgeax_material::standard';
  if (firstPass?.program.module !== expectedProgram) {
    throw new Error(`surface-standard: ${surfaceCase.id} selected a non-Standard program`);
  }
  const observedSurfaceModule = surfaceCase.id.startsWith('water-')
    ? material.surface?.module
    : firstPass.program.moduleSlots?.surface;
  if (observedSurfaceModule !== expectedSurfaceModule) {
    throw new Error(
      `surface-standard: ${surfaceCase.id} Surface module mismatch; expected ${expectedSurfaceModule} observed ${observedSurfaceModule ?? '<missing>'}`,
    );
  }
  if (surfaceCase.id.startsWith('water-')) {
    const dynamicInput = material.surface?.dynamicInput;
    if (
      dynamicInput?.name !== 'waterEvents' ||
      dynamicInput.maxDomains !== 2 ||
      dynamicInput.maxEventsPerSample !== 8
    ) {
      throw new Error(`surface-standard: ${surfaceCase.id} dynamic input domain contract mismatch`);
    }
  }
  const passNames = material.passes.map((pass) => pass.name);
  const expectedPasses =
    surfaceCase.pass === 'deferred'
      ? ['forward', 'deferred', 'shadow-caster']
      : surfaceCase.id.startsWith('water-')
        ? ['color']
        : ['forward', 'shadow-caster'];
  if (
    passNames.length !== expectedPasses.length ||
    expectedPasses.some((name, index) => passNames[index] !== name)
  ) {
    throw new Error(
      `surface-standard: ${surfaceCase.id} pass policy mismatch; expected ${expectedPasses.join(',')} observed ${passNames.join(',')}`,
    );
  }
  const expectedEntries = expectedPasses.map((name) => ({
    name,
    fragmentEntry:
      name === 'forward' || name === 'color'
        ? 'fs_main'
        : name === 'deferred'
          ? 'fs_gbuffer'
          : 'fs_shadow',
    lightMode:
      name === 'forward' || name === 'color'
        ? 'Forward'
        : name === 'deferred'
          ? 'Deferred'
          : 'ShadowCaster',
  }));
  if (surfaceCase.id.startsWith('water-')) return material;
  for (const [index, expected] of expectedEntries.entries()) {
    const actual = material.passes[index];
    const actualLightMode = (actual?.renderState?.tags as Record<string, string> | undefined)
      ?.LightMode;
    if (
      actual?.program.fragmentEntry !== expected.fragmentEntry ||
      actualLightMode !== expected.lightMode
    ) {
      throw new Error(
        `surface-standard: ${surfaceCase.id} entry mismatch at ${expected.name}; expected ${expected.fragmentEntry}/${expected.lightMode}`,
      );
    }
  }
  return material;
}

export function assertSurfacePixelFalsification(
  records: readonly {
    readonly id: string;
    readonly samples: readonly [number, number, number, number];
  }[],
): void {
  const byId = new Map(records.map((record) => [record.id, record.samples]));
  const distance = (left: readonly number[], right: readonly number[]) =>
    Math.max(...left.slice(0, 3).map((value, index) => Math.abs(value - (right[index] ?? 0)))) /
    255;
  for (const [customId, defaultId] of [
    ['custom-base', 'default-base'],
    ['custom-physical', 'default-physical'],
  ] as const) {
    const custom = byId.get(customId);
    const baseline = byId.get(defaultId);
    if (custom === undefined || baseline === undefined) {
      throw new Error(
        `surface-standard: pixel falsification pair missing (${defaultId}, ${customId})`,
      );
    }
    if (distance(custom, baseline) <= SURFACE_PIXEL_EPSILON) {
      throw new Error(
        `surface-standard: ${customId} is pixel-identical to ${defaultId}; custom Surface was not observed`,
      );
    }
  }
}

export function populateSurfaceWorld(
  world: World,
  materials: readonly MaterialAsset[],
  waterInstanceTransforms?: Float32Array,
  options?: { readonly msaa4x?: boolean },
): {
  readonly cameraEntity: EntityHandle;
  readonly mediumMembers: readonly SurfaceDynamicInputMemberIdentity[];
  readonly probeDomains: readonly [
    { readonly entity: EntityHandle; readonly irradiance: Float32Array },
    { readonly entity: EntityHandle; readonly irradiance: Float32Array },
  ];
} {
  const plane = createPlaneGeometry(SURFACE_PLANE_SIZE, SURFACE_PLANE_SIZE);
  if (!plane.ok) throw new Error(`surface-standard: plane geometry failed: ${plane.error.code}`);
  const mesh = testAssets(world).create(plane.value).unwrap();
  const secondSubmesh = plane.value.submeshes[0];
  if (secondSubmesh === undefined) {
    throw new Error('surface-standard: plane submesh unavailable');
  }
  const multiSubmeshMesh = testAssets(world)
    .create({
      ...plane.value,
      materialSlots: [
        plane.value.materialSlots[0] ?? { slotName: 'Default' },
        { slotName: 'WaterB' },
      ],
      submeshes: [secondSubmesh, { ...secondSubmesh, materialSlot: 1 }],
    })
    .unwrap();
  const mediumMembers: SurfaceDynamicInputMemberIdentity[] = [];
  const materialHandles = new Map<MaterialAsset, AssetHandle<'material'>>();
  for (const [index, material] of materials.entries()) {
    let handle = materialHandles.get(material);
    if (handle === undefined) {
      handle = testAssets(world).create(material).unwrap();
      materialHandles.set(material, handle);
    }
    const center = (materials.length - 1) / 2;
    const isWaterB =
      material.surface?.model === 'single-layer-medium' && mediumMembers.length === 1;
    const entity = world
      .spawn(
        {
          component: Transform,
          data: { pos: [(index - center) * SURFACE_CELL_SPACING, 0, 0] },
        },
        { component: MeshFilter, data: { assetHandle: isWaterB ? multiSubmeshMesh : mesh } },
        { component: MeshRenderer, data: { materials: isWaterB ? [handle, handle] : [handle] } },
        ...(isWaterB && waterInstanceTransforms !== undefined
          ? [{ component: Instances, data: { transforms: waterInstanceTransforms } }]
          : []),
      )
      .unwrap();
    if (material.surface?.model === 'single-layer-medium') {
      const drawCount = isWaterB ? 2 : 1;
      const instanceCount =
        isWaterB && waterInstanceTransforms !== undefined ? waterInstanceTransforms.length / 16 : 1;
      for (let drawItemIndex = 0; drawItemIndex < drawCount; drawItemIndex += 1) {
        for (let instanceOrdinal = 0; instanceOrdinal < instanceCount; instanceOrdinal += 1) {
          mediumMembers.push({
            worldIdentity: world.identity,
            entityKey: entity,
            drawItemIndex,
            instanceOrdinal,
          });
        }
      }
    }
  }
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 6] } },
      {
        component: Camera,
        data: {
          fov: Math.PI / 4,
          aspect: SURFACE_WIDTH / SURFACE_HEIGHT,
          near: 0.1,
          far: 20,
          ...(options?.msaa4x === true ? { antialias: ANTIALIAS_MSAA } : {}),
          clearColor: [0, 0, 0, 1],
        },
      },
    )
    .unwrap();
  world.spawn({
    component: DirectionalLight,
    data: {
      direction: [0, 0, -1],
      color: [1, 1, 1],
      intensity: 1,
      castShadow: true,
      mapSize: quality.shadowMapSize,
      cascadeCount: quality.cascadeCount,
    },
  });
  const redDomain = new Float32Array(27);
  redDomain[0] = 64;
  const blueDomain = new Float32Array(27);
  blueDomain[2] = 64;
  const redProbe = world
    .spawn(
      { component: Transform, data: { pos: [2.175, 0, 0] } },
      { component: LightProbe, data: { irradiance: redDomain, radius: 1.0 } },
    )
    .unwrap();
  const blueProbe = world
    .spawn(
      { component: Transform, data: { pos: [3.625, 0, 0] } },
      { component: LightProbe, data: { irradiance: blueDomain, radius: 1.0 } },
    )
    .unwrap();
  // The standalone renderer host does not install scenePlugin for this
  // fixture. Publish the authored local transforms before extract so the
  // camera and four cells reach the real render path with their world poses.
  propagateTransforms(world).unwrap();
  return {
    cameraEntity: camera,
    mediumMembers,
    probeDomains: [
      { entity: redProbe, irradiance: redDomain },
      { entity: blueProbe, irradiance: blueDomain },
    ],
  };
}

export function createSurfaceDynamicInput(
  materials: readonly MaterialAsset[],
  members: readonly SurfaceDynamicInputMemberIdentity[],
  deviceGeneration: number,
) {
  const schema = materials.find((material) => material.surface?.model === 'single-layer-medium')
    ?.surface?.dynamicInput;
  if (schema === undefined) {
    throw new Error('surface-standard: authored medium dynamic input schema unavailable');
  }
  if (members.length < 2) {
    throw new Error(`surface-standard: expected medium members, observed ${members.length}`);
  }
  const page = ReadonlyDynamicInputPage.create({
    sourceId: 'preview-surface-water-events',
    pageId: 1,
    schema,
  }).unwrap();
  page.reconfigureDevice(deviceGeneration).unwrap();
  const record = (position: readonly number[], time: number, eventId: number) => ({
    position,
    time,
    eventId,
    ...(schema.fields.some((field) => field.name === 'strength') ? { strength: 1 } : {}),
  });
  page.writeRecord(0, record([2.0, 0.2, 0.0], 0.15, 101)).unwrap();
  page.writeRecord(1, record([2.4, -0.2, 0.0], 0.55, 102)).unwrap();
  page.writeRecord(2, record([3.45, 0.2, 0.0], 0.25, 201)).unwrap();
  page.writeRecord(3, record([3.8, -0.2, 0.0], 0.7, 202)).unwrap();
  return {
    page,
    ranges: reserveSurfaceDynamicInputRanges(page, members),
    projectionRevision: 1,
  };
}

function reserveSurfaceDynamicInputRanges(
  page: ReadonlyDynamicInputPage,
  members: readonly SurfaceDynamicInputMemberIdentity[],
) {
  return members.map((member, index) =>
    page
      .reserveRange({
        domain: index === 0 ? 'water-domain-a' : 'water-domain-b',
        recordStart: index === 0 ? 0 : 2,
        recordCount: 2,
        instanceIndex: index,
        member,
      })
      .unwrap(),
  );
}

type SurfaceLossInfo = Awaited<RhiDevice['lost']>;

export interface SurfaceHostLossSignal {
  readonly device: RhiDevice;
  readonly generation: number;
  readonly trigger: () => void;
  readonly triggerOnNextSubmit: () => void;
}

/**
 * Host loss test capability wired into each real RHI device. It resolves the
 * device's actual `lost` promise and lets Renderer own teardown and rebuild;
 * it does not mutate Renderer state or substitute a resource.
 */
export function createSurfaceHostLossInstrumentation(): {
  readonly signals: SurfaceHostLossSignal[];
  readonly instrumentation: RhiBackendInstrumentation;
} {
  const signals: SurfaceHostLossSignal[] = [];
  const armedSubmitFailures = new WeakSet<RhiDevice>();
  const deviceLost: NonNullable<RhiBackendInstrumentation['deviceLost']> = (device) => {
    let resolveLoss!: (info: SurfaceLossInfo) => void;
    const lost = new Promise<SurfaceLossInfo>((resolve) => {
      resolveLoss = resolve;
    });
    const generation = signals.length;
    signals.push({
      device,
      generation,
      trigger: () =>
        resolveLoss({
          reason: 'unknown',
          message: `host-injected surface lifecycle loss for generation ${generation}`,
        }),
      triggerOnNextSubmit: () => {
        armedSubmitFailures.add(device);
      },
    });
    return lost;
  };
  const beforeSubmit: NonNullable<RhiBackendInstrumentation['beforeSubmit']> = (device) => {
    const signal = signals.find((candidate) => candidate.device === device);
    if (signal === undefined || !armedSubmitFailures.delete(device)) {
      return undefined;
    }
    signal.trigger();
    return new RhiError({
      code: 'queue-submit-failed',
      expected: 'the replacement-device recovery fixture to reject the armed submission once',
      hint: 'recover the renderer and retry the still-queued VFX continuation',
    });
  };
  return { signals, instrumentation: { beforeSubmit, deviceLost } };
}

const SURFACE_APP_EVENT_LIFETIME_SECONDS = 0.45;
const SURFACE_SPLASH_AUTHORED_LIFETIME_SECONDS = 0.34;
export const SURFACE_SPLASH_EFFECT_GUID = '7a0e0000-0000-7000-8000-000000000001';

/** Production VFX host used by both Dawn and Browser Surface journeys. */
export function createSurfaceSplashRuntimeHost(): VfxRuntimeHost {
  return createVfxRuntimeHost({
    maxQueuedTicks: 128,
    camera: {
      read: (world) => {
        const row = world
          .query({ with: [Camera, Transform] })
          .unwrap()
          [Symbol.iterator]()
          .next().value;
        if (row === undefined) return undefined;
        const camera = row.get(Camera);
        const transform = row.get(Transform);
        const position = new Float32Array(transform.pos);
        const target = new Float32Array([transform.pos[0], transform.pos[1], 0]);
        return {
          position,
          right: new Float32Array([1, 0, 0]),
          up: new Float32Array([0, 1, 0]),
          viewProjection: mat4.computeViewProj(
            mat4.create(),
            position,
            target,
            new Float32Array([0, 1, 0]),
            camera.fov,
            camera.aspect,
            camera.near,
            camera.far,
          ),
        };
      },
    },
  });
}

export interface SurfaceAppLifecycleFrameEvidence {
  readonly label:
    | 'baseline'
    | 'active'
    | 'resumed'
    | 'pre-loss'
    | 'recovered'
    | 'coverage-clipped'
    | 'expired';
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly backendId?: string | undefined;
  readonly graphGeneration: number;
  readonly textureIdentity: number;
  readonly readbackIdentity: number;
  readonly format: string;
  readonly width: number;
  readonly height: number;
  readonly bytesPerRow: number;
  readonly waterA: readonly [number, number, number, number];
  readonly waterB: readonly [number, number, number, number];
  readonly splash: readonly [number, number, number, number];
}

export interface SurfaceAppLifecycleEvidence {
  readonly worldIdentity: string;
  readonly eventTime: number;
  readonly impactIds: readonly [number, number];
  readonly emittedSplashCount: number;
  readonly splashEffectGuid: string;
  readonly splashRendererKinds: readonly string[];
  readonly activeVfxPlayerCount: number;
  readonly expiredVfxPlayerCount: number;
  readonly splashIntents: readonly {
    readonly sequence: number;
    readonly tick: number;
    readonly player: number;
    readonly spawnCount: number;
    readonly reset: boolean;
  }[];
  readonly duplicateImpactCount: number;
  readonly pausedWaitMilliseconds: number;
  readonly pausedWorldTime: number;
  readonly resumedWorldTime: number;
  readonly expiredWorldTime: number;
  readonly resumedEventAge: number;
  readonly expiredEventAge: number;
  readonly submittedFrames: number;
  readonly completedFrames: number;
  readonly cameraCoverageTransitions: number;
  readonly deviceRecovery: {
    readonly oldGeneration: number;
    readonly newGeneration: number;
    readonly oldFrameId: number;
    readonly recoveredFrameId: number;
    readonly lateObservationErrorCode: string;
    readonly staleObservationErrorCode: string;
    readonly worldTimeBeforeLoss: number;
    readonly worldTimeAfterRecovery: number;
    readonly eventAgeBeforeLoss: number;
    readonly eventAgeAfterRecovery: number;
    readonly observationResourcesBeforeLoss: number;
    readonly observationResourcesAfterRecovery: number;
    readonly vfxHostGenerationBeforeLoss: number;
    readonly vfxHostGenerationAfterRecovery: number;
    readonly vfxRenderGenerationBeforeLoss: number;
    readonly vfxRenderGenerationAfterRecovery: number;
    readonly vfxQueueSequencesBeforeLoss: readonly number[];
    readonly vfxQueueSequencesAfterRecovery: readonly number[];
    readonly queuedContinuationsBeforeLoss: readonly {
      readonly player: number;
      readonly sequence: number;
      readonly phaseTick: number;
      readonly playCycle: number;
      readonly reset: boolean;
    }[];
    readonly vfxPlayersBeforeLoss: readonly SurfaceVfxRecoveryPlayerEvidence[];
    readonly vfxPlayersAfterRecovery: readonly SurfaceVfxRecoveryPlayerEvidence[];
    readonly recoveredSubmission: {
      readonly status: string;
      readonly actualLane: string | undefined;
      readonly frameId: number;
      readonly deviceGeneration: number;
      readonly graphGeneration: number;
      readonly resourceGeneration: number | undefined;
      readonly passes: readonly {
        readonly pass: string;
        readonly commandKinds: readonly string[];
      }[];
    };
  };
  readonly baseline: SurfaceAppLifecycleFrameEvidence;
  readonly active: SurfaceAppLifecycleFrameEvidence;
  /** Pausing preserves the exact active completed frame rather than publishing a new one. */
  readonly paused: SurfaceAppLifecycleFrameEvidence;
  readonly resumed: SurfaceAppLifecycleFrameEvidence;
  readonly preLoss: SurfaceAppLifecycleFrameEvidence;
  readonly recovered: SurfaceAppLifecycleFrameEvidence;
  readonly coverageClipped: SurfaceAppLifecycleFrameEvidence;
  readonly expired: SurfaceAppLifecycleFrameEvidence;
  readonly comparisons: {
    readonly activeWaterA: SurfaceAppLifecycleComparison;
    readonly activeWaterB: SurfaceAppLifecycleComparison;
    readonly activeSplash: SurfaceAppLifecycleComparison;
    readonly preLossSplash: SurfaceAppLifecycleComparison;
    readonly recoveredSplash: SurfaceAppLifecycleComparison;
    readonly recoverySplashParity: SurfaceAppLifecycleComparison;
    readonly resumedWaterA: SurfaceAppLifecycleComparison;
    readonly resumedWaterB: SurfaceAppLifecycleComparison;
    readonly recoveredWaterA: SurfaceAppLifecycleComparison;
    readonly recoveredWaterB: SurfaceAppLifecycleComparison;
    readonly coverageWaterA: SurfaceAppLifecycleComparison;
    readonly coverageMask: SurfaceAppLifecycleComparison;
    readonly expiredWaterA: SurfaceAppLifecycleComparison;
    readonly expiredWaterB: SurfaceAppLifecycleComparison;
    readonly expiredSplash: SurfaceAppLifecycleComparison;
  };
}

export interface SurfaceVfxRecoveryPlayerEvidence {
  readonly player: number;
  readonly assetGuid: string;
  readonly programFingerprint: string;
  readonly seed: number;
  readonly playing: boolean;
  readonly valueGeneration: number;
  readonly queuedIntents: number;
  readonly queuedTicks: number;
  readonly lastCommitted: {
    readonly sequence: number;
    readonly tick: number;
    readonly phaseTick: number;
    readonly playCycle: number;
    readonly spawnCount: number;
    readonly reset: boolean;
  } | null;
  readonly sessions: readonly {
    readonly id: string;
    readonly sessionEnabled: boolean;
    readonly phaseTick: number | null;
    readonly tick: number | null;
    readonly playCycle: number | null;
  }[];
}

interface SurfaceAppLifecycleFrameCapture {
  readonly evidence: SurfaceAppLifecycleFrameEvidence;
  readonly waterA: SurfaceAppLifecycleRoi;
  readonly waterB: SurfaceAppLifecycleRoi;
  readonly coverage: SurfaceAppLifecycleRoi;
  readonly splash: SurfaceAppLifecycleRoi;
  readonly diagnostics: SurfaceAppLifecycleCameraDiagnostics;
}

interface SurfaceAppLifecycleCameraDiagnostics {
  readonly worldTime: number;
  readonly receipt: {
    readonly frameId: number;
    readonly deviceGeneration: number;
    readonly graphGeneration: number;
  };
  readonly submission:
    | {
        readonly sequence: number;
        readonly frameId: number;
        readonly requestedLane: 'direct' | 'gpu-driven';
        readonly actualLane: 'direct' | 'gpu-driven';
        readonly actualLaneReason: string | undefined;
        readonly deviceGeneration: number;
        readonly graphGeneration: number;
        readonly viewIdentity: 'main:0';
        readonly resourceGeneration: number | undefined;
        readonly status: 'submitted' | 'completed';
        readonly passes: readonly {
          readonly pass: 'nearest-layer' | 'color';
          readonly memberEvidence: string;
          readonly memberIds: readonly string[] | undefined;
          readonly commandKinds: readonly string[];
        }[];
      }
    | undefined;
  readonly submissionMatchesReceipt: boolean;
  readonly camera: {
    readonly position: readonly number[];
    readonly quat: readonly number[];
    readonly scale: readonly number[];
    readonly globalTransformWorld: readonly number[];
    readonly extractedView: {
      readonly cameraEntityKey: number;
      readonly source: 'extract-camera' | 'global-transform-fallback';
      readonly viewMatrix: readonly number[];
      readonly viewIdentity: 'main:0';
      readonly frameId: number;
      readonly matchesReceipt: boolean;
    };
    readonly projection: number;
    readonly fov: number;
    readonly aspect: number;
    readonly near: number;
    readonly far: number;
    readonly left: number;
    readonly right: number;
    readonly bottom: number;
    readonly top: number;
  };
}

type SurfaceAppLifecycleInput = {
  readonly renderer: Renderer;
  readonly assets: AssetRegistry;
  readonly vfxHost: VfxRuntimeHost;
  readonly hostLossSignals: readonly SurfaceHostLossSignal[];
  readonly pauseWaitMilliseconds?: number;
  /** Exercise replacement-device recovery while a VFX tick continuation is pending. */
  readonly queueVfxContinuationDuringLoss?: boolean;
  /** Node/Dawn has no live host rAF; Browser must leave this omitted. */
  readonly hostFrameScheduler?: 'timer';
};

type SurfaceAppLifecycleSplashIntents = SurfaceAppLifecycleEvidence['splashIntents'];
type SurfaceAppLifecycleDeviceRecovery = SurfaceAppLifecycleEvidence['deviceRecovery'];
type SurfaceAppLifecycleDynamicInput = Omit<
  ReturnType<typeof createSurfaceDynamicInput>,
  'projectionRevision'
> & { readonly projectionRevision: number };

const SURFACE_APP_IMPACT_POSITIONS = [
  [2.05, 0.08, 0],
  [2.3, -0.08, 0],
] as const;

function isExpectedDeviceLossError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'device-operation-failed' &&
    'detail' in error &&
    typeof error.detail === 'object' &&
    error.detail !== null &&
    'cause' in error.detail &&
    typeof error.detail.cause === 'object' &&
    error.detail.cause !== null &&
    'code' in error.detail.cause &&
    error.detail.cause.code === 'device-lost'
  );
}

function surfaceAppErrorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : 'unknown';
}

/**
 * Node/Dawn has no live host rAF. The timer scheduler replaces the global
 * frame callbacks for one run and restores the originals afterwards.
 */
class SurfaceTimerFrameScheduler {
  readonly originalRaf = globalThis.requestAnimationFrame;
  readonly originalCaf = globalThis.cancelAnimationFrame;
  readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  nextRafId = 1;

  install(): void {
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback): number => {
      const id = this.nextRafId++;
      const timer = setTimeout(() => {
        this.timers.delete(id);
        callback(performance.now());
      }, 16);
      this.timers.set(id, timer);
      return id;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = ((id: number): void => {
      const timer = this.timers.get(id);
      if (timer !== undefined) clearTimeout(timer);
      this.timers.delete(id);
    }) as typeof cancelAnimationFrame;
  }

  restore(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    if (this.originalRaf === undefined)
      delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
    else globalThis.requestAnimationFrame = this.originalRaf;
    if (this.originalCaf === undefined)
      delete (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame;
    else globalThis.cancelAnimationFrame = this.originalCaf;
  }
}

/** The water scene, its splash players and the fixed ROIs every capture reads. */
interface SurfaceAppLifecycleScene {
  readonly assets: AssetRegistry;
  readonly world: World;
  readonly mediumMembers: ReturnType<typeof populateSurfaceWorld>['mediumMembers'];
  readonly dynamicInput: SurfaceAppLifecycleDynamicInput;
  readonly splashRendererKinds: readonly string[];
  readonly splashPlayers: readonly EntityHandle[];
  readonly camera: EntityHandle;
}

async function prepareSurfaceAppLifecycleScene(
  input: SurfaceAppLifecycleInput,
): Promise<SurfaceAppLifecycleScene> {
  const { renderer } = input;
  const assets = surfaceAssets(input.assets);
  const materials = await Promise.all(
    SURFACE_CASES.map(async ({ guid }) =>
      (await loadSurfaceMaterial(assets, parseSurfaceGuid(guid))).unwrap(),
    ),
  );
  const world = new World({
    assets,
    time: { fixedDeltaSeconds: 1 / 60, maxStepsPerUpdate: 120, maxDeltaSeconds: 3 },
  });
  const { mediumMembers } = populateSurfaceWorld(world, materials);
  const dynamicInput = createSurfaceDynamicInput(
    materials,
    mediumMembers,
    renderer.inspect().frame.deviceGeneration,
  );
  for (let index = 0; index < 4; index += 1) {
    dynamicInput.page
      .writeRecord(index, { position: [0, 0, 0], time: -1_000, eventId: 0 })
      .unwrap();
  }

  const attachedVfx = await input.vfxHost.attachWorld({ world, assets });
  if (!attachedVfx.ok) throw attachedVfx.error;
  const loadedSplash = await loadVfxGpuEffect(assets, SURFACE_SPLASH_EFFECT_GUID);
  if (!loadedSplash.ok) throw loadedSplash.error;
  const splashRendererKinds = Object.freeze(
    assets
      .read(loadedSplash.value)
      .unwrap()
      .program.emitters.flatMap((emitter) => emitter.renderers.map((renderer) => renderer.kind)),
  );
  if (splashRendererKinds.length === 0) {
    throw new Error('surface-app-lifecycle: cooked splash effect has no renderer');
  }
  const effect = loadedSplash.value;
  const splashPlayers = SURFACE_APP_IMPACT_POSITIONS.map((position, index) =>
    world
      .spawn(
        { component: Transform, data: { pos: position } },
        {
          component: ParticleEffectPlayer,
          data: { effect, playing: false, seed: 101 + index, timeScale: 1 },
        },
      )
      .unwrap(),
  );
  const camera = world
    .query({ with: [Camera, Transform] })
    .unwrap()
    [Symbol.iterator]()
    .next().value?.entity;
  if (camera === undefined) throw new Error('surface-app-lifecycle: camera unavailable');
  return {
    assets,
    world,
    mediumMembers,
    dynamicInput,
    splashRendererKinds,
    splashPlayers,
    camera,
  };
}

interface SurfaceAppLifecycleMasks {
  readonly coverageGeometry: ReturnType<typeof createSurfaceAppLifecycleCoverageMask>;
  readonly waterA: ReturnType<typeof createSurfaceAppLifecycleMask>;
  readonly waterB: ReturnType<typeof createSurfaceAppLifecycleMask>;
  readonly coverage: ReturnType<typeof createSurfaceAppLifecycleCoverageMask>['mask'];
  readonly splash: ReturnType<typeof createSurfaceAppLifecycleMask>;
}

function lifecycleCameraPosition(
  world: World,
  camera: EntityHandle,
): readonly [number, number, number] {
  const transform = world.get(camera, Transform).unwrap();
  const x = transform.pos[0];
  const y = transform.pos[1];
  const z = transform.pos[2];
  if (
    typeof x !== 'number' ||
    !Number.isFinite(x) ||
    typeof y !== 'number' ||
    !Number.isFinite(y) ||
    typeof z !== 'number' ||
    !Number.isFinite(z)
  ) {
    throw new Error('surface-app-lifecycle: camera transform position must be finite');
  }
  return [x, y, z];
}

/** Fixed-ROI masks derived from the authored geometry before any pixel is read. */
function createSurfaceAppLifecycleMasks(
  world: World,
  camera: EntityHandle,
): SurfaceAppLifecycleMasks {
  const lifecycleCamera = world.get(camera, Camera).unwrap();
  const [lifecycleCameraX, lifecycleCameraY, lifecycleCameraZ] = lifecycleCameraPosition(
    world,
    camera,
  );
  const waterACenterX =
    (SURFACE_CASES.length - 2 - (SURFACE_CASES.length - 1) / 2) * SURFACE_CELL_SPACING;
  const waterBCenterX =
    (SURFACE_CASES.length - 1 - (SURFACE_CASES.length - 1) / 2) * SURFACE_CELL_SPACING;
  const coverageMask = createSurfaceAppLifecycleCoverageMask({
    width: SURFACE_WIDTH,
    height: SURFACE_HEIGHT,
    cellIndex: SURFACE_CASES.length - 2,
    cellCount: SURFACE_CASES.length,
    // Preserve the original world-space probe in the gap between the two planes.
    // Prove coverage from the same geometry before reading pixels.
    offsetX: (-23 * SURFACE_WIDTH) / 960,
    radius: (6 * SURFACE_WIDTH) / 960,
    baselineCamera: {
      x: lifecycleCameraX,
      y: lifecycleCameraY,
      z: lifecycleCameraZ,
      fov: lifecycleCamera.fov,
      aspect: lifecycleCamera.aspect,
    },
    movedCamera: {
      x: 0.9,
      y: lifecycleCameraY,
      z: lifecycleCameraZ,
      fov: lifecycleCamera.fov,
      aspect: lifecycleCamera.aspect,
    },
    surfaces: [
      {
        id: 'water-a',
        center: [waterACenterX, 0, 0],
        size: [SURFACE_PLANE_SIZE, SURFACE_PLANE_SIZE],
      },
      {
        id: 'water-b',
        center: [waterBCenterX, 0, 0],
        size: [SURFACE_PLANE_SIZE, SURFACE_PLANE_SIZE],
      },
    ],
  });
  if (
    coverageMask.baseline.coveredPixelCount !== coverageMask.mask.length ||
    coverageMask.baseline.coveredSurfaceIds.length !== 1 ||
    coverageMask.baseline.coveredSurfaceIds[0] !== 'water-a' ||
    coverageMask.moved.coveredPixelCount !== 0
  ) {
    throw new Error(
      `surface-app-lifecycle: authored camera coverage premise failed ${JSON.stringify({
        baseline: coverageMask.baseline,
        moved: coverageMask.moved,
      })}`,
    );
  }
  const waterAMask = createSurfaceAppLifecycleMask({
    width: SURFACE_WIDTH,
    height: SURFACE_HEIGHT,
    cellIndex: SURFACE_CASES.length - 2,
    cellCount: SURFACE_CASES.length,
    radius: (8 * SURFACE_WIDTH) / 960,
  });
  const waterBMask = createSurfaceAppLifecycleMask({
    width: SURFACE_WIDTH,
    height: SURFACE_HEIGHT,
    cellIndex: SURFACE_CASES.length - 1,
    cellCount: SURFACE_CASES.length,
    radius: (8 * SURFACE_WIDTH) / 960,
  });
  // Authored splash particles start 0.72 m above the impact. This fixed
  // screen-space ROI sits above the 1.3 m water plane, so Surface foam cannot
  // masquerade as particle visibility.
  const splashMask = createSurfaceAppLifecycleMask({
    width: SURFACE_WIDTH,
    height: SURFACE_HEIGHT,
    cellIndex: SURFACE_CASES.length - 2,
    cellCount: SURFACE_CASES.length,
    radius: (8 * SURFACE_WIDTH) / 960,
    offsetY: (-86 * SURFACE_HEIGHT) / 540,
  });
  return {
    coverageGeometry: coverageMask,
    waterA: waterAMask,
    waterB: waterBMask,
    coverage: coverageMask.mask,
    splash: splashMask,
  };
}

type SurfaceVfxRecoveryState = {
  readonly hostGeneration: number;
  readonly renderGeneration: number;
  readonly queueSequences: readonly number[];
  readonly queuedContinuations: readonly {
    readonly player: number;
    readonly sequence: number;
    readonly phaseTick: number;
    readonly playCycle: number;
    readonly reset: boolean;
  }[];
  readonly players: readonly SurfaceVfxRecoveryPlayerEvidence[];
};

function surfaceVfxPlayerEvidence(
  player: NonNullable<ReturnType<VfxRuntimeHost['inspect']>>['players'][number],
): SurfaceVfxRecoveryPlayerEvidence {
  return {
    player: Number(player.player),
    assetGuid: player.assetGuid,
    programFingerprint: player.programFingerprint,
    seed: player.seed,
    playing: player.playing,
    valueGeneration: player.values.generation,
    queuedIntents: player.queuedIntents,
    queuedTicks: player.queuedTicks,
    lastCommitted:
      player.lastCommitted === null
        ? null
        : {
            sequence: player.lastCommitted.sequence,
            tick: player.lastCommitted.tick,
            phaseTick: player.lastCommitted.phaseTick,
            playCycle: player.lastCommitted.playCycle,
            spawnCount: player.lastCommitted.spawnCount,
            reset: player.lastCommitted.reset,
          },
    sessions: player.emitters.map((emitter) => ({
      id: emitter.id,
      sessionEnabled: emitter.sessionEnabled,
      phaseTick: emitter.phaseTick,
      tick: emitter.tick,
      playCycle: emitter.playCycle,
    })),
  };
}

/** Device-loss facts recorded before recovery. */
interface SurfaceAppLifecycleLoss {
  readonly oldGeneration: number;
  readonly oldReceipt: FrameReceipt;
  readonly lateObservation: ReturnType<Renderer['observe']>;
  readonly observationResourcesBeforeLoss: number;
  readonly vfxBeforeLoss: SurfaceVfxRecoveryState;
  readonly worldTimeBeforeLoss: number;
  readonly eventTimeAtLoss: number;
  readonly eventAgeBeforeLoss: number;
}

/** Recovery facts observed before the first recovered frame. */
interface SurfaceAppLifecycleRecovery {
  readonly newGeneration: number;
  readonly worldTimeAfterRecovery: number;
  readonly eventAgeAfterRecovery: number;
  readonly lateObservationError: unknown;
  readonly staleObservationError: unknown;
  readonly observationResourcesAfterRecovery: number;
}

interface SurfaceAppLifecyclePause {
  readonly active: SurfaceAppLifecycleFrameCapture;
  readonly pausedSpawnIntents: SurfaceAppLifecycleSplashIntents;
  readonly pausedWorldTime: number;
  readonly pausedReceiptCount: number;
  readonly activeVfxPlayerCount: number;
  readonly pausedWaitMilliseconds: number;
}

interface SurfaceAppLifecycleExpiry {
  readonly coverageClipped: SurfaceAppLifecycleFrameCapture;
  readonly expired: SurfaceAppLifecycleFrameCapture;
  readonly expiredWorldTime: number;
  readonly expiredVfxPlayerCount: number;
}

interface SurfaceAppLifecycleCaptures {
  readonly baseline: SurfaceAppLifecycleFrameCapture;
  readonly active: SurfaceAppLifecycleFrameCapture;
  readonly resumed: SurfaceAppLifecycleFrameCapture;
  readonly preLoss: SurfaceAppLifecycleFrameCapture;
  readonly recovered: SurfaceAppLifecycleFrameCapture;
  readonly coverageClipped: SurfaceAppLifecycleFrameCapture;
  readonly expired: SurfaceAppLifecycleFrameCapture;
}

function compareSurfaceAppLifecycleCaptures(
  captures: SurfaceAppLifecycleCaptures,
): SurfaceAppLifecycleEvidence['comparisons'] {
  const { baseline, active, resumed, preLoss, recovered, coverageClipped, expired } = captures;
  return {
    activeWaterA: compareSurfaceAppLifecycleRois(baseline.waterA, active.waterA),
    activeWaterB: compareSurfaceAppLifecycleRois(baseline.waterB, active.waterB),
    activeSplash: compareSurfaceAppLifecycleRois(baseline.splash, active.splash),
    preLossSplash: compareSurfaceAppLifecycleRois(baseline.splash, preLoss.splash),
    recoveredSplash: compareSurfaceAppLifecycleRois(baseline.splash, recovered.splash),
    recoverySplashParity: compareSurfaceAppLifecycleRois(preLoss.splash, recovered.splash),
    resumedWaterA: compareSurfaceAppLifecycleRois(baseline.waterA, resumed.waterA),
    resumedWaterB: compareSurfaceAppLifecycleRois(baseline.waterB, resumed.waterB),
    recoveredWaterA: compareSurfaceAppLifecycleRois(baseline.waterA, recovered.waterA),
    recoveredWaterB: compareSurfaceAppLifecycleRois(baseline.waterB, recovered.waterB),
    coverageWaterA: compareSurfaceAppLifecycleRois(active.waterA, coverageClipped.waterA),
    coverageMask: compareSurfaceAppLifecycleRois(active.coverage, coverageClipped.coverage),
    expiredWaterA: compareSurfaceAppLifecycleRois(baseline.waterA, expired.waterA),
    expiredWaterB: compareSurfaceAppLifecycleRois(baseline.waterB, expired.waterB),
    expiredSplash: compareSurfaceAppLifecycleRois(baseline.splash, expired.splash),
  };
}

function expectSurfaceAppLifecyclePixels(
  comparisons: SurfaceAppLifecycleEvidence['comparisons'],
  queueVfxContinuationDuringLoss: boolean | undefined,
): void {
  const { activeWaterA, activeWaterB, activeSplash, preLossSplash, recoveredSplash } = comparisons;
  const { recoverySplashParity, resumedWaterA, resumedWaterB, recoveredWaterA } = comparisons;
  const { recoveredWaterB } = comparisons;
  if (activeWaterA.failedPixelCount === 0) {
    throw new Error('surface-app-lifecycle: active water impacts did not change the water A ROI');
  }
  if (
    activeWaterB.failedPixelCount !== 0 ||
    resumedWaterB.failedPixelCount !== 0 ||
    recoveredWaterB.failedPixelCount !== 0
  ) {
    throw new Error('surface-app-lifecycle: water A impacts leaked into water B domain');
  }
  if (activeSplash.failedPixelCount === 0) {
    throw new Error('surface-app-lifecycle: cooked splash produced no fixed-ROI pixels');
  }
  if (preLossSplash.failedPixelCount === 0 || recoveredSplash.failedPixelCount === 0) {
    throw new Error(
      `surface-app-lifecycle: splash was not visible across device recovery ${JSON.stringify({ preLossSplash, recoveredSplash, recoverySplashParity })}`,
    );
  }
  if (
    queueVfxContinuationDuringLoss !== true &&
    (recoverySplashParity.failedPixelCount !== 0 || recoverySplashParity.maxError > 0.05)
  ) {
    throw new Error(
      `surface-app-lifecycle: recovered splash changed fixed-ROI pixels ${JSON.stringify(recoverySplashParity)}`,
    );
  }
  if (resumedWaterA.failedPixelCount === 0) {
    throw new Error('surface-app-lifecycle: resumed event disappeared before its lifetime');
  }
  if (recoveredWaterA.failedPixelCount === 0) {
    throw new Error('surface-app-lifecycle: valid water event did not survive device recovery');
  }
}

function expectExpiredSurfacePixels(comparisons: SurfaceAppLifecycleEvidence['comparisons']): void {
  if (
    comparisons.expiredWaterA.failedPixelCount !== 0 ||
    comparisons.expiredWaterB.failedPixelCount !== 0
  ) {
    throw new Error('surface-app-lifecycle: expired water events did not return to baseline');
  }
  if (comparisons.expiredSplash.failedPixelCount !== 0) {
    throw new Error('surface-app-lifecycle: expired splash pixels did not retire');
  }
}

type SurfaceRenderSubmission = ReturnType<Renderer['inspect']>['renderScene']['submission'];

function expectRecoveredSurfaceSubmission(
  recoveredSubmission: SurfaceRenderSubmission,
  recoveredReceipt: FrameReceipt,
  newGeneration: number,
): NonNullable<SurfaceRenderSubmission> {
  const recoveredPassNames = recoveredSubmission?.passes.map((pass) => pass.pass) ?? [];
  if (
    recoveredSubmission === undefined ||
    recoveredSubmission.status !== 'completed' ||
    recoveredSubmission.frameId !== recoveredReceipt.frameId ||
    recoveredSubmission.deviceGeneration !== newGeneration ||
    recoveredSubmission.actualLane !== 'gpu-driven' ||
    recoveredPassNames.length !== 2 ||
    new Set(recoveredPassNames).size !== 2 ||
    !recoveredPassNames.includes('nearest-layer') ||
    !recoveredPassNames.includes('color') ||
    recoveredSubmission.passes.some((pass) => pass.memberEvidence !== 'indirect-visible-readback')
  ) {
    throw new Error(
      `surface-app-lifecycle: recovered Surface GPU submission evidence missing ${JSON.stringify({
        actualLane: recoveredSubmission?.actualLane,
        passes: recoveredSubmission?.passes.map((pass) => ({
          pass: pass.pass,
          memberEvidence: pass.memberEvidence,
        })),
      })}`,
    );
  }
  return recoveredSubmission;
}

/** One public App-owned water lifecycle run and the World-time event state it drives. */
class SurfaceAppLifecycleRun {
  readonly input: SurfaceAppLifecycleInput;
  readonly renderer: Renderer;
  readonly scene: SurfaceAppLifecycleScene;
  readonly world: World;
  readonly camera: EntityHandle;
  dynamicInput: SurfaceAppLifecycleDynamicInput;
  readonly pendingImpacts: Array<{
    readonly eventId: number;
    readonly position: readonly [number, number, number];
  }> = [];
  readonly acceptedImpactIds = new Set<number>();
  eventTime: number | undefined;
  duplicateImpactCount = 0;
  projectionRevision = 1;
  splashesRetired = false;
  cameraCoverageTransitions = 0;
  cameraMoved = false;
  cameraRestored = false;
  readonly receipts: FrameReceipt[] = [];
  readonly errors: unknown[] = [];
  acceptingRecoveryErrors = false;
  acceptingQueuedFrameError = false;
  pauseAfterReceiptCount: number | undefined;
  app: App | undefined;
  readonly masks: SurfaceAppLifecycleMasks;

  constructor(
    input: SurfaceAppLifecycleInput,
    scene: SurfaceAppLifecycleScene,
    masks: SurfaceAppLifecycleMasks,
  ) {
    this.input = input;
    this.masks = masks;
    this.renderer = input.renderer;
    this.scene = scene;
    this.world = scene.world;
    this.camera = scene.camera;
    this.dynamicInput = scene.dynamicInput;
  }

  /** The World Update system: the single time snapshot owner for events and play edges. */
  installEventSystem(): void {
    this.world
      .addSystem(Update, {
        name: 'surface-water-public-event-lifecycle',
        queries: [],
        fn: () => this.updateWaterEvents(),
      })
      .unwrap();
  }

  subscribeFrames(): () => void {
    return this.renderer.subscribe((event) => {
      if (event.kind === 'frame-submitted') {
        this.receipts.push(event.receipt);
        if (this.receipts.length === this.pauseAfterReceiptCount) {
          this.pauseAfterReceiptCount = undefined;
          this.app?.pause().unwrap();
        }
      }
    });
  }

  onAppError(error: unknown): void {
    const expectedDeviceLoss = isExpectedDeviceLossError(error);
    if (!this.acceptingQueuedFrameError && (!this.acceptingRecoveryErrors || !expectedDeviceLoss)) {
      this.errors.push(error);
    }
  }

  async waitForReceiptCount(count: number): Promise<void> {
    const receipts = this.receipts;
    const deadline = Date.now() + 30_000;
    while (receipts.length < count && Date.now() < deadline) {
      if (this.errors.length > 0) {
        throw new Error(
          `surface-app-lifecycle: App failed before receipt ${count}: ${JSON.stringify(this.errors)}`,
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    if (receipts.length < count) {
      throw new Error(
        `surface-app-lifecycle: expected ${count} receipts, observed ${receipts.length}`,
      );
    }
  }

  async waitForReceipts(count: number): Promise<void> {
    await this.waitForReceiptCount(count);
    const receipt = this.receipts[count - 1];
    if (receipt === undefined) throw new Error('surface-app-lifecycle: receipt unavailable');
    const completion = await receipt.completed;
    if (!completion.ok) throw completion.error;
  }

  async waitForRendererState(expected: 'alive' | 'device-lost'): Promise<void> {
    const renderer = this.renderer;
    const deadline = Date.now() + 30_000;
    while (renderer.state() !== expected && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    if (renderer.state() !== expected) {
      throw new Error(
        `surface-app-lifecycle: expected renderer state ${expected}, observed ${renderer.state()}`,
      );
    }
  }

  armLifecycleObservation(): void {
    const armed = this.renderer.requestObservation?.(['linear-hdr']);
    if (armed === undefined || !armed.ok) {
      throw new Error('surface-app-lifecycle: linear-hdr observation could not be armed');
    }
  }

  /** Step one App frame of `delta` seconds and wait for its completed receipt. */
  async stepAndComplete(app: App, delta: number, missing: string): Promise<FrameReceipt> {
    const index = this.receipts.length;
    app.stepFrame(delta).unwrap();
    await this.waitForReceipts(index + 1);
    const receipt = this.receipts[index];
    if (receipt === undefined) throw new Error(`surface-app-lifecycle: ${missing}`);
    return receipt;
  }

  async captureReceipt(
    label: SurfaceAppLifecycleFrameEvidence['label'],
    receipt: FrameReceipt,
  ): Promise<SurfaceAppLifecycleFrameCapture> {
    const masks = this.masks;
    const observed = await this.renderer.observe(receipt, { include: ['linear-hdr'] });
    if (!observed.ok) throw observed.error;
    const observation = observed.value.observations?.find(
      (candidate) => candidate.domain === 'linear-hdr',
    );
    if (observation === undefined) {
      throw new Error('surface-app-lifecycle: completed linear-hdr observation unavailable');
    }
    const { metadata, bytes } = observation;
    if (
      metadata.frameId !== receipt.frameId ||
      metadata.deviceGeneration !== receipt.deviceGeneration ||
      metadata.graphGeneration !== receipt.graphGeneration ||
      metadata.width !== SURFACE_WIDTH ||
      metadata.height !== SURFACE_HEIGHT
    ) {
      throw new Error('surface-app-lifecycle: observation crossed receipt or fixed ROI identity');
    }
    const readback = {
      bytes,
      width: metadata.width,
      height: metadata.height,
      bytesPerRow: metadata.bytesPerRow,
      format: metadata.format,
    };
    const waterA = readSurfaceAppLifecycleRoi(readback, masks.waterA);
    const waterB = readSurfaceAppLifecycleRoi(readback, masks.waterB);
    const coverage = readSurfaceAppLifecycleRoi(readback, masks.coverage);
    const splash = readSurfaceAppLifecycleRoi(readback, masks.splash);
    return {
      waterA,
      waterB,
      coverage,
      splash,
      diagnostics: this.cameraDiagnostics({
        frameId: receipt.frameId,
        deviceGeneration: receipt.deviceGeneration,
        graphGeneration: receipt.graphGeneration,
      }),
      evidence: {
        label,
        frameId: receipt.frameId,
        deviceGeneration: receipt.deviceGeneration,
        backendId: receipt.backendId,
        graphGeneration: metadata.graphGeneration,
        textureIdentity: metadata.textureIdentity,
        readbackIdentity: metadata.readbackIdentity,
        format: metadata.format,
        width: metadata.width,
        height: metadata.height,
        bytesPerRow: metadata.bytesPerRow,
        waterA: waterA.average,
        waterB: waterB.average,
        splash: splash.average,
      },
    };
  }

  inspectCommittedSplashes(): SurfaceAppLifecycleSplashIntents {
    return Object.freeze(
      this.input.vfxHost.inspect(this.world)?.players.flatMap((player) => {
        const committed = player.lastCommitted;
        return committed !== null && committed.spawnCount > 0 && committed.reset
          ? [
              {
                sequence: committed.sequence,
                tick: committed.tick,
                player: Number(player.player),
                spawnCount: committed.spawnCount,
                reset: committed.reset,
              },
            ]
          : [];
      }) ?? [],
    );
  }

  inspectVfxRecoveryState(): SurfaceVfxRecoveryState {
    const snapshot = this.input.vfxHost.inspect(this.world);
    if (snapshot === undefined) {
      throw new Error('surface-app-lifecycle: VFX recovery snapshot unavailable');
    }
    const runtime = this.world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
    return {
      hostGeneration: snapshot.generation,
      renderGeneration: snapshot.renderGeneration,
      queueSequences: Object.freeze(runtime.snapshot().map((intent) => intent.sequence)),
      queuedContinuations: Object.freeze(
        runtime.snapshot().map((intent) => ({
          player: Number(intent.player),
          sequence: intent.sequence,
          phaseTick: intent.phaseTick,
          playCycle: intent.playCycle,
          reset: intent.reset,
        })),
      ),
      players: Object.freeze(snapshot.players.map(surfaceVfxPlayerEvidence)),
    };
  }

  private updateWaterEvents(): void {
    const time = this.world.getResource(Time).elapsed;
    if (this.eventTime === undefined && this.pendingImpacts.length > 0) this.acceptImpacts(time);
    const age = this.eventTime === undefined ? -1 : time - this.eventTime;
    if (!this.cameraMoved && age >= 0.15) {
      this.world.set(this.camera, Transform, { pos: [0.9, 0, 6] }).unwrap();
      this.cameraMoved = true;
      this.cameraCoverageTransitions += 1;
    }
    if (!this.cameraRestored && age >= 0.25) {
      this.world.set(this.camera, Transform, { pos: [0, 0, 6] }).unwrap();
      this.cameraRestored = true;
      this.cameraCoverageTransitions += 1;
    }
    if (!this.splashesRetired && age >= SURFACE_APP_EVENT_LIFETIME_SECONDS) this.retireSplashes();
    this.renderer.setSurfaceDynamicInput({
      ...this.dynamicInput,
      projectionRevision: this.projectionRevision,
      frameTime: time,
    });
  }

  private acceptImpacts(time: number): void {
    this.eventTime = time;
    for (const impact of this.pendingImpacts) {
      if (this.acceptedImpactIds.has(impact.eventId)) {
        this.duplicateImpactCount += 1;
        continue;
      }
      if (this.acceptedImpactIds.size >= 2) continue;
      const recordIndex = this.acceptedImpactIds.size;
      this.acceptedImpactIds.add(impact.eventId);
      this.dynamicInput.page
        .writeRecord(recordIndex, {
          position: impact.position,
          time,
          eventId: impact.eventId,
        })
        .unwrap();
      const player = this.scene.splashPlayers[recordIndex];
      if (player === undefined) {
        throw new Error('surface-app-lifecycle: splash player unavailable');
      }
      this.world.set(player, ParticleEffectPlayer, { playing: true }).unwrap();
    }
    this.projectionRevision += 1;
    this.pendingImpacts.length = 0;
  }

  private retireSplashes(): void {
    for (const player of this.scene.splashPlayers) {
      this.world.despawn(player).unwrap();
    }
    for (let index = 0; index < 2; index += 1) {
      this.dynamicInput.page
        .writeRecord(index, { position: [0, 0, 0], time: -1_000, eventId: 0 })
        .unwrap();
    }
    this.projectionRevision += 1;
    this.splashesRetired = true;
  }

  private cameraDiagnostics(
    receipt: SurfaceAppLifecycleCameraDiagnostics['receipt'],
  ): SurfaceAppLifecycleCameraDiagnostics {
    const { world, camera } = this;
    const cameraValues = world.get(camera, Camera).unwrap();
    const transformValues = world.get(camera, Transform).unwrap();
    const globalTransformValues = world.get(camera, GlobalTransform).unwrap();
    const extractedCamera = extractCameraSnapshots(world).find(
      (candidate) => candidate.entityKey === (camera as number),
    );
    const extractedWorld = extractedCamera?.world ?? globalTransformValues.world;
    const extractedView = mat4.invert(mat4.create(), extractedWorld);
    const submission = surfaceSubmissionDiagnostics(this.renderer.inspect().renderScene.submission);
    return {
      worldTime: world.getResource(Time).elapsed,
      receipt,
      submission,
      submissionMatchesReceipt: submission?.frameId === receipt.frameId,
      camera: {
        position: Array.from(transformValues.pos),
        quat: Array.from(transformValues.quat),
        scale: Array.from(transformValues.scale),
        globalTransformWorld: Array.from(globalTransformValues.world),
        extractedView: {
          cameraEntityKey: extractedCamera?.entityKey ?? (camera as number),
          source: extractedCamera === undefined ? 'global-transform-fallback' : 'extract-camera',
          viewMatrix: Array.from(extractedView),
          viewIdentity: submission?.viewIdentity ?? 'main:0',
          frameId: submission?.frameId ?? -1,
          matchesReceipt: submission?.frameId === receipt.frameId,
        },
        projection: cameraValues.projection,
        fov: cameraValues.fov,
        aspect: cameraValues.aspect,
        near: cameraValues.near,
        far: cameraValues.far,
        left: cameraValues.left,
        right: cameraValues.right,
        bottom: cameraValues.bottom,
        top: cameraValues.top,
      },
    };
  }
}

function surfaceSubmissionDiagnostics(
  committedSubmission: SurfaceRenderSubmission,
): SurfaceAppLifecycleCameraDiagnostics['submission'] {
  if (committedSubmission === undefined) return undefined;
  return {
    sequence: committedSubmission.sequence,
    frameId: committedSubmission.frameId,
    requestedLane: committedSubmission.requestedLane,
    actualLane: committedSubmission.actualLane,
    actualLaneReason: committedSubmission.actualLaneReason,
    deviceGeneration: committedSubmission.deviceGeneration,
    graphGeneration: committedSubmission.graphGeneration,
    viewIdentity: committedSubmission.viewIdentity,
    resourceGeneration: committedSubmission.resourceGeneration,
    status: committedSubmission.status,
    passes: committedSubmission.passes.map((pass) => ({
      pass: pass.pass,
      memberEvidence: pass.memberEvidence,
      memberIds: pass.memberIds,
      commandKinds: pass.commands.map((command) => command.kind),
    })),
  };
}

/** Phase methods of the lifecycle drive, in their execution order. */
class SurfaceAppLifecycleDrive {
  readonly run: SurfaceAppLifecycleRun;
  readonly app: App;

  constructor(run: SurfaceAppLifecycleRun, app: App) {
    this.run = run;
    this.app = app;
  }

  // Freeze the baseline at submission, before later RAF ticks can use the
  // remaining receipt credit while this frame's GPU completion is pending.
  async captureBaseline(): Promise<SurfaceAppLifecycleFrameCapture> {
    const { run, app } = this;
    run.armLifecycleObservation();
    run.pauseAfterReceiptCount = 1;
    app.start().unwrap();
    await run.waitForReceipts(1);
    app.pause().unwrap();
    const baselineReceipt = run.receipts[0];
    if (baselineReceipt === undefined) {
      throw new Error('surface-app-lifecycle: baseline receipt unavailable');
    }
    return run.captureReceipt('baseline', baselineReceipt);
  }

  /** Publish the impacts, then capture the first frame showing water and splash together. */
  async captureActiveImpacts(): Promise<{
    readonly active: SurfaceAppLifecycleFrameCapture;
    readonly eventSpawnIntents: SurfaceAppLifecycleSplashIntents;
  }> {
    const { run, app } = this;
    run.pendingImpacts.push(
      { eventId: 701, position: SURFACE_APP_IMPACT_POSITIONS[0] },
      { eventId: 702, position: SURFACE_APP_IMPACT_POSITIONS[1] },
      { eventId: 701, position: SURFACE_APP_IMPACT_POSITIONS[0] },
    );
    // Update accepts the impact and publishes the ParticleEffectPlayer play
    // edge; its order against this frame's VFX update is unspecified. A second
    // App-owned frame is therefore the first frame where the formal VFX intent
    // and GPU splash are guaranteed to be observed together.
    const eventReceiptIndex = run.receipts.length;
    app.stepFrame(1 / 60).unwrap();
    await run.waitForReceipts(eventReceiptIndex + 1);
    const eventSpawnIntents = run.inspectCommittedSplashes();
    run.armLifecycleObservation();
    const activeReceipt = await run.stepAndComplete(app, 1 / 60, 'active receipt unavailable');
    return { active: await run.captureReceipt('active', activeReceipt), eventSpawnIntents };
  }

  /** A paused App advances neither World time, frames nor VFX intent state. */
  async verifyPause(
    active: SurfaceAppLifecycleFrameCapture,
    eventSpawnIntents: SurfaceAppLifecycleSplashIntents,
  ): Promise<SurfaceAppLifecyclePause> {
    const { run } = this;
    const { world, input } = run;
    const pausedWorldTime = world.getResource(Time).elapsed;
    const pausedReceiptCount = run.receipts.length;
    const activeVfxSnapshot = input.vfxHost.inspect(world);
    const activeVfxPlayerCount = activeVfxSnapshot?.players.length ?? 0;
    if (activeVfxPlayerCount !== 2) {
      throw new Error('surface-app-lifecycle: production VFX host did not retain two players');
    }
    const pausedSpawnIntents =
      eventSpawnIntents.length === 0 ? run.inspectCommittedSplashes() : eventSpawnIntents;
    const pausedVfxSnapshot = activeVfxSnapshot?.players.map(pausedVfxPlayerState);
    const pausedWaitMilliseconds = input.pauseWaitMilliseconds ?? 250;
    await new Promise<void>((resolve) => setTimeout(resolve, pausedWaitMilliseconds));
    if (
      world.getResource(Time).elapsed !== pausedWorldTime ||
      run.receipts.length !== pausedReceiptCount
    ) {
      throw new Error('surface-app-lifecycle: paused App advanced World time or submitted a frame');
    }
    const pausedVfxAfterWait = input.vfxHost.inspect(world)?.players.map(pausedVfxPlayerState);
    if (JSON.stringify(pausedVfxAfterWait) !== JSON.stringify(pausedVfxSnapshot)) {
      throw new Error('surface-app-lifecycle: paused VFX intent state changed without a frame');
    }
    return {
      active,
      pausedSpawnIntents,
      pausedWorldTime,
      pausedReceiptCount,
      activeVfxPlayerCount,
      pausedWaitMilliseconds,
    };
  }

  async captureResumed(pause: SurfaceAppLifecyclePause): Promise<{
    readonly resumed: SurfaceAppLifecycleFrameCapture;
    readonly resumedWorldTime: number;
  }> {
    const { run, app } = this;
    const { world, input } = run;
    run.armLifecycleObservation();
    // Stop at the selected submission: GPU completion can outlive later RAF
    // ticks, whose World clock must not replace this resumed frame's clock.
    run.pauseAfterReceiptCount = pause.pausedReceiptCount + 1;
    app.resume().unwrap();
    await run.waitForReceipts(pause.pausedReceiptCount + 1);
    app.pause().unwrap();
    const resumedWorldTime = world.getResource(Time).elapsed;
    if (world.getResource(Time).delta >= pause.pausedWaitMilliseconds / 1_000) {
      throw new Error('surface-app-lifecycle: resume accumulated paused host time');
    }
    const resumedReceipt = run.receipts[pause.pausedReceiptCount];
    if (resumedReceipt === undefined) {
      throw new Error('surface-app-lifecycle: resumed receipt unavailable');
    }
    const resumed = await run.captureReceipt('resumed', resumedReceipt);
    const pausedResetIdentities = new Set(
      pause.pausedSpawnIntents.map((intent) => `${intent.player}:${intent.sequence}`),
    );
    const resumedUnexpectedResets =
      input.vfxHost
        .inspect(world)
        ?.players.filter(
          (player) =>
            player.lastCommitted !== null &&
            player.lastCommitted.spawnCount > 0 &&
            player.lastCommitted.reset &&
            !pausedResetIdentities.has(`${Number(player.player)}:${player.lastCommitted.sequence}`),
        ) ?? [];
    if (resumedUnexpectedResets.length > 0) {
      throw new Error('surface-app-lifecycle: resume re-emitted a one-shot splash');
    }
    return { resumed, resumedWorldTime };
  }

  async capturePreLoss(): Promise<{
    readonly preLoss: SurfaceAppLifecycleFrameCapture;
    readonly preLossReceipt: FrameReceipt;
    readonly splashIntentsBeforeLoss: SurfaceAppLifecycleSplashIntents;
  }> {
    const { run, app } = this;
    run.armLifecycleObservation();
    const preLossReceipt = await run.stepAndComplete(
      app,
      0,
      'completed pre-loss receipt unavailable',
    );
    const preLoss = await run.captureReceipt('pre-loss', preLossReceipt);
    const settledVfxBeforeLoss = run.inspectVfxRecoveryState();
    const splashIntentsBeforeLoss = run.inspectCommittedSplashes();
    if (
      settledVfxBeforeLoss.players.length !== 2 ||
      settledVfxBeforeLoss.queueSequences.length !== 0 ||
      settledVfxBeforeLoss.players.some(
        (player) =>
          player.queuedIntents !== 0 ||
          player.queuedTicks !== 0 ||
          player.lastCommitted === null ||
          player.sessions.some((session) => !session.sessionEnabled),
      )
    ) {
      throw new Error('surface-app-lifecycle: pre-loss VFX player/session state is not settled');
    }
    return { preLoss, preLossReceipt, splashIntentsBeforeLoss };
  }

  // The public App advances the World and records the real VFX plan.
  // The backend-owned submit seam then resolves the real host-loss
  // promise and rejects this one submission before it can acknowledge
  // the continuation.
  abortQueuedContinuationFrame(hostLossSignal: SurfaceHostLossSignal): void {
    const { run, app } = this;
    const submittedBeforeQueuedFrame = run.receipts.length;
    let queuedFrameResult: ReturnType<App['stepFrame']>;
    run.acceptingRecoveryErrors = true;
    run.acceptingQueuedFrameError = true;
    hostLossSignal.triggerOnNextSubmit();
    try {
      queuedFrameResult = app.stepFrame(1 / 60);
    } finally {
      run.acceptingQueuedFrameError = false;
    }
    if (queuedFrameResult.ok || run.receipts.length !== submittedBeforeQueuedFrame) {
      throw new Error('surface-app-lifecycle: queued continuation frame did not abort');
    }
  }

  async submitInFlightFrame(): Promise<FrameReceipt> {
    const { run, app } = this;
    run.armLifecycleObservation();
    const oldReceiptIndex = run.receipts.length;
    app.stepFrame(0).unwrap();
    await run.waitForReceiptCount(oldReceiptIndex + 1);
    const inFlightReceipt = run.receipts[oldReceiptIndex];
    if (inFlightReceipt === undefined) {
      throw new Error('surface-app-lifecycle: in-flight pre-loss receipt unavailable');
    }
    return inFlightReceipt;
  }

  /** Lose the device with either a queued VFX continuation or an in-flight observed frame. */
  async loseDevice(preLossReceipt: FrameReceipt): Promise<SurfaceAppLifecycleLoss> {
    const { run } = this;
    const { renderer, input, world } = run;
    const queued = input.queueVfxContinuationDuringLoss === true;
    const oldGeneration = renderer.inspect().frame.deviceGeneration;
    const hostLossSignal = input.hostLossSignals.find(
      (signal) => signal.generation === oldGeneration,
    );
    if (hostLossSignal === undefined) {
      throw new Error('surface-app-lifecycle: host loss signal unavailable');
    }
    let oldReceipt = preLossReceipt;
    if (queued) this.abortQueuedContinuationFrame(hostLossSignal);
    else oldReceipt = await this.submitInFlightFrame();
    const observationResourceStatsBeforeLoss = renderer.inspect().observation.resourceStats;
    if (observationResourceStatsBeforeLoss === undefined) {
      throw new Error('surface-app-lifecycle: observation resource stats unavailable before loss');
    }
    const observationResourcesBeforeLoss = observationResourceStatsBeforeLoss.liveCount;
    if (!queued && observationResourcesBeforeLoss < 1) {
      throw new Error('surface-app-lifecycle: in-flight observation resource was not retained');
    }
    if (!queued) {
      run.acceptingRecoveryErrors = true;
      hostLossSignal.trigger();
    }
    const rendererLost = run.waitForRendererState('device-lost');
    // A rejected queued submission owns no observation capture. Wait for
    // its loss transition before asserting the stale receipt, instead of
    // racing the backend's loss notification against an unarmed read.
    // The other branch still starts a real in-flight read before loss settles.
    if (queued) await rendererLost;
    const lateObservation = renderer.observe(oldReceipt, { include: ['linear-hdr'] });
    await rendererLost;
    const vfxBeforeLoss = run.inspectVfxRecoveryState();
    if (
      queued
        ? vfxBeforeLoss.queuedContinuations.length !== 2 ||
          vfxBeforeLoss.queuedContinuations.some((intent) => intent.reset)
        : vfxBeforeLoss.queuedContinuations.length !== 0
    ) {
      throw new Error(
        `surface-app-lifecycle: queued recovery precondition missing ${JSON.stringify(vfxBeforeLoss.queuedContinuations)}`,
      );
    }
    const worldTimeBeforeLoss = world.getResource(Time).elapsed;
    const eventTimeAtLoss = run.eventTime;
    if (eventTimeAtLoss === undefined) {
      throw new Error('surface-app-lifecycle: event timestamp unavailable before loss');
    }
    const eventAgeBeforeLoss = worldTimeBeforeLoss - eventTimeAtLoss;
    if (eventAgeBeforeLoss < 0 || eventAgeBeforeLoss >= SURFACE_SPLASH_AUTHORED_LIFETIME_SECONDS) {
      throw new Error('surface-app-lifecycle: device loss missed the authored splash lifetime');
    }
    return {
      oldGeneration,
      oldReceipt,
      lateObservation,
      observationResourcesBeforeLoss,
      vfxBeforeLoss,
      worldTimeBeforeLoss,
      eventTimeAtLoss,
      eventAgeBeforeLoss,
    };
  }

  /** Recover onto a new device generation without advancing the World clock. */
  async recoverDevice(loss: SurfaceAppLifecycleLoss): Promise<SurfaceAppLifecycleRecovery> {
    const { run } = this;
    const { renderer, world } = run;
    const recoveredResult = await renderer.recover();
    if (!recoveredResult.ok) {
      throw new Error(
        `surface-app-lifecycle: recovery failed ${JSON.stringify(recoveredResult.error)}`,
      );
    }
    await run.waitForRendererState('alive');
    const newGeneration = renderer.inspect().frame.deviceGeneration;
    if (newGeneration <= loss.oldGeneration) {
      throw new Error('surface-app-lifecycle: recovery did not publish a new device generation');
    }
    this.reconfigureDynamicInput(newGeneration, loss.worldTimeBeforeLoss);
    const worldTimeAfterRecovery = world.getResource(Time).elapsed;
    const eventAgeAfterRecovery = worldTimeAfterRecovery - loss.eventTimeAtLoss;
    if (
      worldTimeAfterRecovery !== loss.worldTimeBeforeLoss ||
      eventAgeAfterRecovery !== loss.eventAgeBeforeLoss
    ) {
      throw new Error('surface-app-lifecycle: device recovery advanced the World clock');
    }
    const lateObservationResult = await loss.lateObservation;
    if (lateObservationResult.ok) {
      throw new Error('surface-app-lifecycle: late old-generation readback was published');
    }
    const staleObservationResult = await renderer.observe(loss.oldReceipt, {
      include: ['linear-hdr'],
    });
    if (staleObservationResult.ok) {
      throw new Error('surface-app-lifecycle: stale old-generation receipt was accepted');
    }
    const observationResourceStatsAfterRecovery = renderer.inspect().observation.resourceStats;
    if (observationResourceStatsAfterRecovery === undefined) {
      throw new Error(
        'surface-app-lifecycle: observation resource stats unavailable after recovery',
      );
    }
    const observationResourcesAfterRecovery = observationResourceStatsAfterRecovery.liveCount;
    if (observationResourcesAfterRecovery !== 0) {
      throw new Error('surface-app-lifecycle: old observation resources survived recovery');
    }
    return {
      newGeneration,
      worldTimeAfterRecovery,
      eventAgeAfterRecovery,
      lateObservationError: lateObservationResult.error,
      staleObservationError: staleObservationResult.error,
      observationResourcesAfterRecovery,
    };
  }

  private reconfigureDynamicInput(newGeneration: number, frameTime: number): void {
    const { run } = this;
    const reconfigured = run.dynamicInput.page.reconfigureDevice(newGeneration);
    if (!reconfigured.ok) throw reconfigured.error;
    run.projectionRevision += 1;
    run.dynamicInput = {
      page: run.dynamicInput.page,
      ranges: reserveSurfaceDynamicInputRanges(run.dynamicInput.page, run.scene.mediumMembers),
      projectionRevision: run.projectionRevision,
    };
    run.renderer.setSurfaceDynamicInput({
      ...run.dynamicInput,
      projectionRevision: run.projectionRevision,
      frameTime,
    });
  }

  /** Step zero-time frames until pipeline preparation presents the recovered scene. */
  async awaitRecoveredReadyReceipt(worldTimeBeforeLoss: number): Promise<FrameReceipt> {
    const { run, app } = this;
    run.armLifecycleObservation();
    let recoveredReceipt = await run.stepAndComplete(app, 0, 'recovered receipt unavailable');
    const preparationDeadline = Date.now() + 30_000;
    while (recoveredReceipt.presentation !== 'ready' && Date.now() < preparationDeadline) {
      run.armLifecycleObservation();
      recoveredReceipt = await run.stepAndComplete(app, 0, 'preparation receipt unavailable');
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    if (recoveredReceipt.presentation !== 'ready')
      throw new Error('surface-app-lifecycle: recovered scene did not become ready');
    if (run.world.getResource(Time).elapsed !== worldTimeBeforeLoss)
      throw new Error('surface-app-lifecycle: pipeline preparation advanced World time');
    return recoveredReceipt;
  }

  /** Recovery neither replays nor resets a VFX player or session. */
  verifyRecoveredVfx(
    loss: SurfaceAppLifecycleLoss,
    vfxAfterRecovery: SurfaceVfxRecoveryState,
    splashIntentsBeforeLoss: SurfaceAppLifecycleSplashIntents,
  ): void {
    const { run } = this;
    const { vfxBeforeLoss } = loss;
    const queued = run.input.queueVfxContinuationDuringLoss === true;
    const splashIntentsAfterRecovery = run.inspectCommittedSplashes();
    const semanticPlayers = (players: readonly SurfaceVfxRecoveryPlayerEvidence[]) =>
      players.map(({ valueGeneration: _valueGeneration, ...player }) => player);
    const queuedRecoveryAccepted =
      queued &&
      vfxAfterRecovery.queueSequences.length === 0 &&
      vfxBeforeLoss.queuedContinuations.every((continuation) => {
        const player = vfxAfterRecovery.players.find(
          (candidate) => candidate.player === continuation.player,
        );
        return (
          player?.lastCommitted?.sequence === continuation.sequence &&
          player.lastCommitted.phaseTick === continuation.phaseTick &&
          player.lastCommitted.playCycle === continuation.playCycle &&
          player.lastCommitted.reset === false
        );
      });
    const emptyRecoveryPreserved =
      !queued &&
      JSON.stringify(semanticPlayers(vfxAfterRecovery.players)) ===
        JSON.stringify(semanticPlayers(vfxBeforeLoss.players)) &&
      JSON.stringify(vfxAfterRecovery.queueSequences) ===
        JSON.stringify(vfxBeforeLoss.queueSequences);
    if (
      (!queuedRecoveryAccepted && !emptyRecoveryPreserved) ||
      JSON.stringify(splashIntentsAfterRecovery) !== JSON.stringify(splashIntentsBeforeLoss)
    ) {
      throw new Error('surface-app-lifecycle: recovery replayed or reset a VFX player/session');
    }
  }

  async captureRecovered(
    loss: SurfaceAppLifecycleLoss,
    recovery: SurfaceAppLifecycleRecovery,
    splashIntentsBeforeLoss: SurfaceAppLifecycleSplashIntents,
  ): Promise<{
    readonly recovered: SurfaceAppLifecycleFrameCapture;
    readonly deviceRecovery: SurfaceAppLifecycleDeviceRecovery;
  }> {
    const { run } = this;
    const recoveredReceipt = await this.awaitRecoveredReadyReceipt(loss.worldTimeBeforeLoss);
    const recovered = await run.captureReceipt('recovered', recoveredReceipt);
    const vfxAfterRecovery = run.inspectVfxRecoveryState();
    this.verifyRecoveredVfx(loss, vfxAfterRecovery, splashIntentsBeforeLoss);
    const recoveredSubmission = expectRecoveredSurfaceSubmission(
      run.renderer.inspect().renderScene.submission,
      recoveredReceipt,
      recovery.newGeneration,
    );
    const { vfxBeforeLoss } = loss;
    const deviceRecovery: SurfaceAppLifecycleDeviceRecovery = {
      oldGeneration: loss.oldGeneration,
      newGeneration: recovery.newGeneration,
      oldFrameId: loss.oldReceipt.frameId,
      recoveredFrameId: recoveredReceipt.frameId,
      lateObservationErrorCode: surfaceAppErrorCode(recovery.lateObservationError),
      staleObservationErrorCode: surfaceAppErrorCode(recovery.staleObservationError),
      worldTimeBeforeLoss: loss.worldTimeBeforeLoss,
      worldTimeAfterRecovery: recovery.worldTimeAfterRecovery,
      eventAgeBeforeLoss: loss.eventAgeBeforeLoss,
      eventAgeAfterRecovery: recovery.eventAgeAfterRecovery,
      observationResourcesBeforeLoss: loss.observationResourcesBeforeLoss,
      observationResourcesAfterRecovery: recovery.observationResourcesAfterRecovery,
      vfxHostGenerationBeforeLoss: vfxBeforeLoss.hostGeneration,
      vfxHostGenerationAfterRecovery: vfxAfterRecovery.hostGeneration,
      vfxRenderGenerationBeforeLoss: vfxBeforeLoss.renderGeneration,
      vfxRenderGenerationAfterRecovery: vfxAfterRecovery.renderGeneration,
      vfxQueueSequencesBeforeLoss: vfxBeforeLoss.queueSequences,
      vfxQueueSequencesAfterRecovery: vfxAfterRecovery.queueSequences,
      queuedContinuationsBeforeLoss: vfxBeforeLoss.queuedContinuations,
      vfxPlayersBeforeLoss: vfxBeforeLoss.players,
      vfxPlayersAfterRecovery: vfxAfterRecovery.players,
      recoveredSubmission: {
        status: recoveredSubmission.status,
        actualLane: recoveredSubmission.actualLane,
        frameId: recoveredSubmission.frameId,
        deviceGeneration: recoveredSubmission.deviceGeneration,
        graphGeneration: recoveredSubmission.graphGeneration,
        resourceGeneration: recoveredSubmission.resourceGeneration,
        passes: recoveredSubmission.passes.map((pass) => ({
          pass: pass.pass,
          commandKinds: pass.commands.map((command) => command.kind),
        })),
      },
    };
    run.acceptingRecoveryErrors = false;
    return { recovered, deviceRecovery };
  }

  /** Drive deterministic 50 ms frames through the camera clip window and event expiry. */
  async captureExpiry(): Promise<SurfaceAppLifecycleExpiryFrames> {
    const { run, app } = this;
    const { world } = run;
    let coverageClipped: SurfaceAppLifecycleFrameCapture | undefined;
    let expired: SurfaceAppLifecycleFrameCapture | undefined;
    for (let step = 0; step < 12; step += 1) {
      const label = surfaceExpiryLabel(
        world.getResource(Time).elapsed - (run.eventTime ?? 0) + 0.05,
      );
      run.armLifecycleObservation();
      const lifecycleReceipt = await run.stepAndComplete(
        app,
        0.05,
        'deterministic receipt unavailable',
      );
      const capture = await run.captureReceipt(label, lifecycleReceipt);
      if (coverageClipped === undefined && run.cameraMoved && !run.cameraRestored) {
        coverageClipped = capture;
      }
      expired = capture;
    }
    const expiredWorldTime = world.getResource(Time).elapsed;
    const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
    const expiredVfxPlayerCount = run.input.vfxHost.inspect(world)?.players.length ?? 0;
    if (
      runtime.inspectPlayers().length !== 0 ||
      runtime.snapshot().length !== 0 ||
      expiredVfxPlayerCount !== 0
    ) {
      throw new Error('surface-app-lifecycle: expired VFX players or intents were not reclaimed');
    }
    return { coverageClipped, expired, expiredWorldTime, expiredVfxPlayerCount };
  }
}

interface SurfaceAppLifecycleExpiryFrames {
  readonly coverageClipped: SurfaceAppLifecycleFrameCapture | undefined;
  readonly expired: SurfaceAppLifecycleFrameCapture | undefined;
  readonly expiredWorldTime: number;
  readonly expiredVfxPlayerCount: number;
}

function surfaceExpiryLabel(nextAge: number): SurfaceAppLifecycleFrameEvidence['label'] {
  if (nextAge >= SURFACE_APP_EVENT_LIFETIME_SECONDS) return 'expired';
  return nextAge >= 0.15 && nextAge < 0.25 ? 'coverage-clipped' : 'resumed';
}

function pausedVfxPlayerState(
  player: NonNullable<ReturnType<VfxRuntimeHost['inspect']>>['players'][number],
) {
  return {
    player: Number(player.player),
    playing: player.playing,
    queuedIntents: player.queuedIntents,
    queuedTicks: player.queuedTicks,
    lastCommitted: player.lastCommitted,
  };
}

/** Exactly two impacts and two one-shot splashes, with every required capture present. */
function requireExpiredLifecycle(
  run: SurfaceAppLifecycleRun,
  pausedSpawnIntents: SurfaceAppLifecycleSplashIntents,
  frames: SurfaceAppLifecycleExpiryFrames,
): SurfaceAppLifecycleExpiry & { readonly eventTime: number } {
  const eventTime = run.eventTime;
  if (
    eventTime === undefined ||
    run.acceptedImpactIds.size !== 2 ||
    run.duplicateImpactCount !== 1
  ) {
    throw new Error('surface-app-lifecycle: event dedupe did not accept exactly two impacts');
  }
  if (pausedSpawnIntents.length !== 2) {
    throw new Error(
      `surface-app-lifecycle: expected two one-shot splash intents, observed ${pausedSpawnIntents.length}`,
    );
  }
  const { coverageClipped, expired } = frames;
  if (coverageClipped === undefined || expired === undefined) {
    throw new Error('surface-app-lifecycle: required completed lifecycle capture is missing');
  }
  return {
    coverageClipped,
    expired,
    expiredWorldTime: frames.expiredWorldTime,
    expiredVfxPlayerCount: frames.expiredVfxPlayerCount,
    eventTime,
  };
}

function expectCameraCoverageClip(
  run: SurfaceAppLifecycleRun,
  captures: SurfaceAppLifecycleCaptures,
  comparisons: SurfaceAppLifecycleEvidence['comparisons'],
): void {
  if (comparisons.coverageMask.failedPixelCount !== 0) return;
  const { active, coverageClipped } = captures;
  console.error(
    JSON.stringify({
      kind: 'surface-app-lifecycle-camera-coverage-diagnostics',
      active: {
        evidence: active.evidence,
        diagnostics: active.diagnostics,
        waterA: active.waterA.average,
      },
      coverageClipped: {
        evidence: coverageClipped.evidence,
        diagnostics: coverageClipped.diagnostics,
        waterA: coverageClipped.waterA.average,
        coverage: coverageClipped.coverage.average,
      },
      comparison: comparisons.coverageMask,
      waterAComparison: comparisons.coverageWaterA,
      geometry: run.masks.coverageGeometry,
      transitions: {
        cameraMoved: run.cameraMoved,
        cameraRestored: run.cameraRestored,
        cameraCoverageTransitions: run.cameraCoverageTransitions,
      },
    }),
  );
  throw new Error('surface-app-lifecycle: camera move did not clip the geometry-owned ROI');
}

function expectEventAgesWithinLifetime(
  pausedWorldTime: number,
  resumedWorldTime: number,
  expiredWorldTime: number,
  eventTime: number,
): void {
  const resumedEventAge = resumedWorldTime - eventTime;
  const expiredEventAge = expiredWorldTime - eventTime;
  if (
    resumedWorldTime < pausedWorldTime ||
    resumedEventAge < 0 ||
    resumedEventAge >= SURFACE_APP_EVENT_LIFETIME_SECONDS ||
    expiredEventAge < SURFACE_APP_EVENT_LIFETIME_SECONDS
  ) {
    throw new Error('surface-app-lifecycle: resumed or expired event age is outside its lifetime');
  }
}

async function stopSurfaceApp(run: SurfaceAppLifecycleRun, app: App): Promise<void> {
  app.stop().unwrap();
  const stoppedReceiptCount = run.receipts.length;
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  if (run.receipts.length !== stoppedReceiptCount) {
    throw new Error('surface-app-lifecycle: stopped App submitted another frame');
  }
  if (run.errors.length > 0) {
    throw new Error(`surface-app-lifecycle: App errors ${JSON.stringify(run.errors)}`);
  }
}

/** Every lifecycle phase on one started App, ending with a stopped App and its evidence. */
async function driveSurfaceAppLifecycle(
  run: SurfaceAppLifecycleRun,
  app: App,
): Promise<SurfaceAppLifecycleEvidence> {
  const drive = new SurfaceAppLifecycleDrive(run, app);
  const baseline = await drive.captureBaseline();
  const { active, eventSpawnIntents } = await drive.captureActiveImpacts();
  const pause = await drive.verifyPause(active, eventSpawnIntents);
  const { resumed, resumedWorldTime } = await drive.captureResumed(pause);
  const { preLoss, preLossReceipt, splashIntentsBeforeLoss } = await drive.capturePreLoss();
  const loss = await drive.loseDevice(preLossReceipt);
  const recovery = await drive.recoverDevice(loss);
  const { recovered, deviceRecovery } = await drive.captureRecovered(
    loss,
    recovery,
    splashIntentsBeforeLoss,
  );
  const expiry = requireExpiredLifecycle(
    run,
    pause.pausedSpawnIntents,
    await drive.captureExpiry(),
  );
  const { coverageClipped, expired, expiredWorldTime, eventTime } = expiry;
  const captures = { baseline, active, resumed, preLoss, recovered, coverageClipped, expired };
  const comparisons = compareSurfaceAppLifecycleCaptures(captures);
  expectSurfaceAppLifecyclePixels(comparisons, run.input.queueVfxContinuationDuringLoss);
  expectCameraCoverageClip(run, captures, comparisons);
  expectExpiredSurfacePixels(comparisons);
  if (run.cameraCoverageTransitions !== 2) {
    throw new Error('surface-app-lifecycle: camera coverage transitions were not completed');
  }
  expectEventAgesWithinLifetime(
    pause.pausedWorldTime,
    resumedWorldTime,
    expiredWorldTime,
    eventTime,
  );
  await stopSurfaceApp(run, app);
  return {
    worldIdentity: run.world.identity,
    eventTime,
    impactIds: [701, 702],
    emittedSplashCount: pause.pausedSpawnIntents.length,
    splashEffectGuid: SURFACE_SPLASH_EFFECT_GUID,
    splashRendererKinds: run.scene.splashRendererKinds,
    activeVfxPlayerCount: pause.activeVfxPlayerCount,
    expiredVfxPlayerCount: expiry.expiredVfxPlayerCount,
    splashIntents: pause.pausedSpawnIntents.map((intent) => ({
      sequence: intent.sequence,
      tick: intent.tick,
      player: intent.player,
      spawnCount: intent.spawnCount,
      reset: intent.reset,
    })),
    duplicateImpactCount: run.duplicateImpactCount,
    pausedWaitMilliseconds: pause.pausedWaitMilliseconds,
    pausedWorldTime: pause.pausedWorldTime,
    resumedWorldTime,
    expiredWorldTime,
    resumedEventAge: resumedWorldTime - eventTime,
    expiredEventAge: expiredWorldTime - eventTime,
    submittedFrames: run.receipts.length,
    completedFrames: app.execution.report().frame.completed,
    cameraCoverageTransitions: run.cameraCoverageTransitions,
    deviceRecovery,
    baseline: baseline.evidence,
    active: active.evidence,
    paused: active.evidence,
    resumed: resumed.evidence,
    preLoss: preLoss.evidence,
    recovered: recovered.evidence,
    coverageClipped: coverageClipped.evidence,
    expired: expired.evidence,
    comparisons,
  };
}

/**
 * Run the public App-owned water lifecycle. The World Update system is the
 * single time snapshot owner for both Surface event timestamps and VFX play
 * edges; tests only enqueue domain events and operate App lifecycle methods.
 */
export async function runSurfaceAppLifecycle(
  input: SurfaceAppLifecycleInput,
): Promise<SurfaceAppLifecycleEvidence> {
  const scene = await prepareSurfaceAppLifecycleScene(input);
  const run = new SurfaceAppLifecycleRun(
    input,
    scene,
    createSurfaceAppLifecycleMasks(scene.world, scene.camera),
  );
  run.installEventSystem();
  const scheduler =
    input.hostFrameScheduler === 'timer' ? new SurfaceTimerFrameScheduler() : undefined;
  scheduler?.install();
  const unsubscribeFrames = run.subscribeFrames();
  try {
    const created = await createApp({
      platform: testPlatform(),
      renderer: input.renderer,
      world: scene.world,
      silenceUnhandledErrors: true,
    });
    if (!created.ok) throw created.error;
    const app = created.value;
    run.app = app;
    const unsubscribeErrors = app.onError((error) => run.onAppError(error));
    try {
      return await driveSurfaceAppLifecycle(run, app);
    } finally {
      unsubscribeErrors();
    }
  } finally {
    if (run.app !== undefined) await run.app.dispose();
    const detachedVfx = await input.vfxHost.detachWorld({ world: scene.world });
    // biome-ignore lint/correctness/noUnsafeFinally: a failed production host detach invalidates the lifecycle proof.
    if (!detachedVfx.ok) throw detachedVfx.error;
    unsubscribeFrames();
    run.dynamicInput.page.release().unwrap();
    input.renderer.setSurfaceDynamicInput(undefined);
    scene.assets.dispose();
    scheduler?.restore();
  }
}

const OPTICAL_GRID_COLUMNS = 5;
const OPTICAL_GRID_X0 = -2.4;
const OPTICAL_GRID_Y0 = 1.3;
const OPTICAL_GRID_STEP_X = 1.2;
const OPTICAL_GRID_STEP_Y = 1.3;
const OPTICAL_WATER_SIZE = 0.9;
const OPTICAL_TARGET_SIZE = 1.08;
const HALF_SUBMERGED_TILT = Math.PI * (25 / 180);

export interface SurfaceOpticalGridPosition {
  readonly x: number;
  readonly y: number;
}

export interface SurfaceOpticalLinearHdrObservation {
  readonly bytes: Uint8Array;
  readonly metadata: {
    readonly frameId: number;
    readonly deviceGeneration: number;
    readonly backendId?: string | undefined;
    readonly format: string;
    readonly graphGeneration: number;
    readonly textureIdentity: number;
    readonly readbackIdentity: number;
    readonly width: number;
    readonly height: number;
    readonly bytesPerRow: number;
  };
}

export interface SurfaceOpticalOracleSample {
  readonly label: string;
  readonly pixel: readonly [number, number];
  readonly world: readonly [number, number];
  readonly pairedBackground: readonly [number, number, number];
  readonly actual: readonly [number, number, number];
  readonly reference: readonly [number, number, number];
  readonly error: readonly [number, number, number];
}

export interface SurfaceOpticalOracleRecord {
  readonly id: string;
  readonly guid: string;
  readonly parameters: SurfaceOpticalParameters;
  readonly backgroundDistanceMeters?: number | undefined;
  readonly waterTiltYRadians: number;
  readonly samples: readonly SurfaceOpticalOracleSample[];
  readonly maxError: number;
  readonly maxErrorPosition: readonly [number, number];
  readonly maxErrorSample: SurfaceOpticalOracleSample;
  readonly falsifierMaxError?: number | undefined;
}

export function surfaceOpticalGridPosition(slot: number): SurfaceOpticalGridPosition {
  return {
    x: OPTICAL_GRID_X0 + (slot % OPTICAL_GRID_COLUMNS) * OPTICAL_GRID_STEP_X,
    y: OPTICAL_GRID_Y0 - Math.floor(slot / OPTICAL_GRID_COLUMNS) * OPTICAL_GRID_STEP_Y,
  };
}

function quaternionX(radians: number): readonly [number, number, number, number] {
  return [Math.sin(radians * 0.5), 0, 0, Math.cos(radians * 0.5)];
}

function quaternionY(radians: number): readonly [number, number, number, number] {
  return [0, Math.sin(radians * 0.5), 0, Math.cos(radians * 0.5)];
}

function quaternionZ(radians: number): readonly [number, number, number, number] {
  return [0, 0, Math.sin(radians * 0.5), Math.cos(radians * 0.5)];
}

export function assertSurfaceOpticalMaterialPayload(
  surfaceCase: SurfaceOpticalEvidenceCase,
  material: MaterialAsset,
): MaterialAsset {
  if (
    material.surface?.model !== 'single-layer-medium' ||
    material.surface.module !== 'preview::water_surface_a' ||
    material.passes?.[0]?.program.module !== 'forgeax::single-layer-medium'
  ) {
    throw new Error(`surface-optical: ${surfaceCase.id} did not load the authored medium route`);
  }
  for (const [name, expected] of Object.entries(surfaceCase.parameters)) {
    const actual = material.values?.[name];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        `surface-optical: ${surfaceCase.id}.${name} expected ${JSON.stringify(expected)} observed ${JSON.stringify(actual)}`,
      );
    }
  }
  return material;
}

export function populateSurfaceOpticalWorld(
  world: World,
  backgroundMaterial: MaterialAsset,
  materials: readonly MaterialAsset[],
): { readonly mediumMembers: readonly SurfaceDynamicInputMemberIdentity[] } {
  if (materials.length !== SURFACE_OPTICAL_CASES.length) {
    throw new Error(
      `surface-optical: expected ${SURFACE_OPTICAL_CASES.length} materials, observed ${materials.length}`,
    );
  }
  const waterPlane = createPlaneGeometry(OPTICAL_WATER_SIZE, OPTICAL_WATER_SIZE).unwrap();
  const targetPlane = createPlaneGeometry(OPTICAL_TARGET_SIZE, OPTICAL_TARGET_SIZE).unwrap();
  const waterMesh = testAssets(world).create(waterPlane).unwrap();
  const targetMesh = testAssets(world).create(targetPlane).unwrap();
  const backgroundHandle = testAssets(world).create(backgroundMaterial).unwrap();

  const control = surfaceOpticalGridPosition(0);
  world.spawn(
    { component: Transform, data: { pos: [control.x, control.y, 0] } },
    { component: MeshFilter, data: { assetHandle: targetMesh } },
    { component: MeshRenderer, data: { materials: [backgroundHandle] } },
  );

  const mediumMembers: SurfaceDynamicInputMemberIdentity[] = [];
  for (const [index, surfaceCase] of SURFACE_OPTICAL_CASES.entries()) {
    const position = surfaceOpticalGridPosition(index + 1);
    const materialHandle = testAssets(world)
      .create(materials[index] as MaterialAsset)
      .unwrap();
    if (surfaceCase.halfSubmergedTarget === true) {
      world.spawn(
        {
          component: Transform,
          data: {
            pos: [position.x, position.y, 0],
            quat: quaternionX(HALF_SUBMERGED_TILT),
          },
        },
        { component: MeshFilter, data: { assetHandle: targetMesh } },
        { component: MeshRenderer, data: { materials: [backgroundHandle] } },
      );
    } else if (surfaceCase.backgroundDistanceMeters !== undefined) {
      world.spawn(
        {
          component: Transform,
          data: { pos: [position.x, position.y, -surfaceCase.backgroundDistanceMeters] },
        },
        { component: MeshFilter, data: { assetHandle: targetMesh } },
        { component: MeshRenderer, data: { materials: [backgroundHandle] } },
      );
    }
    const water = world
      .spawn(
        {
          component: Transform,
          data: {
            pos: [position.x, position.y, 0],
            quat: quaternionY(surfaceCase.waterTiltYRadians ?? 0),
          },
        },
        { component: MeshFilter, data: { assetHandle: waterMesh } },
        { component: MeshRenderer, data: { materials: [materialHandle] } },
      )
      .unwrap();
    mediumMembers.push({
      worldIdentity: world.identity,
      entityKey: water,
      drawItemIndex: 0,
      instanceOrdinal: 0,
    });
  }

  world.spawn(
    { component: Transform, data: { pos: [0, 0, SURFACE_OPTICAL_ORTHO.cameraZ] } },
    {
      component: Camera,
      data: {
        projection: CAMERA_PROJECTION_ORTHOGRAPHIC,
        left: SURFACE_OPTICAL_ORTHO.left,
        right: SURFACE_OPTICAL_ORTHO.right,
        bottom: SURFACE_OPTICAL_ORTHO.bottom,
        top: SURFACE_OPTICAL_ORTHO.top,
        near: SURFACE_OPTICAL_ORTHO.near,
        far: SURFACE_OPTICAL_ORTHO.far,
        clearColor: [0, 0, 0, 1],
      },
    },
  );
  world.spawn({
    component: DirectionalLight,
    data: { direction: [0, 0, -1], color: [1, 1, 1], intensity: 1, castShadow: false },
  });
  propagateTransforms(world).unwrap();
  return { mediumMembers: Object.freeze(mediumMembers) };
}

export function createSurfaceOpticalDynamicInput(
  materials: readonly MaterialAsset[],
  members: readonly SurfaceDynamicInputMemberIdentity[],
  deviceGeneration: number,
): Omit<SurfaceDynamicInputFrame, 'frameTime'> {
  const schema = materials[0]?.surface?.dynamicInput;
  if (schema === undefined) throw new Error('surface-optical: dynamic input schema unavailable');
  const page = ReadonlyDynamicInputPage.create({
    sourceId: 'preview-surface-optical-events',
    pageId: 2,
    schema,
  }).unwrap();
  page.reconfigureDevice(deviceGeneration).unwrap();
  page.writeRecord(0, { position: [1000, 1000, 1000], time: 0, eventId: 1 }).unwrap();
  const ranges = members.map((member, instanceIndex) =>
    page
      .reserveRange({
        domain: 'water-optical',
        recordStart: 0,
        recordCount: 1,
        instanceIndex,
        member,
      })
      .unwrap(),
  );
  return { page, ranges, projectionRevision: 1 };
}

function decodeFloat16(word: number): number {
  const sign = (word & 0x8000) === 0 ? 1 : -1;
  const exponent = (word >>> 10) & 0x1f;
  const fraction = word & 0x03ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction === 0 ? sign * Number.POSITIVE_INFINITY : Number.NaN;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

function readLinearHdrPixel(
  observation: SurfaceOpticalLinearHdrObservation,
  x: number,
  y: number,
): readonly [number, number, number] {
  const clampedX = Math.min(observation.metadata.width - 1, Math.max(0, x));
  const clampedY = Math.min(observation.metadata.height - 1, Math.max(0, y));
  const offset = clampedY * observation.metadata.bytesPerRow + clampedX * 8;
  const view = new DataView(
    observation.bytes.buffer,
    observation.bytes.byteOffset,
    observation.bytes.byteLength,
  );
  return [
    decodeFloat16(view.getUint16(offset, true)),
    decodeFloat16(view.getUint16(offset + 2, true)),
    decodeFloat16(view.getUint16(offset + 4, true)),
  ];
}

function opticalWorldToPixel(position: SurfaceOpticalGridPosition): readonly [number, number] {
  const x =
    ((position.x - SURFACE_OPTICAL_ORTHO.left) /
      (SURFACE_OPTICAL_ORTHO.right - SURFACE_OPTICAL_ORTHO.left)) *
      SURFACE_OPTICAL_WIDTH -
    0.5;
  const y =
    ((SURFACE_OPTICAL_ORTHO.top - position.y) /
      (SURFACE_OPTICAL_ORTHO.top - SURFACE_OPTICAL_ORTHO.bottom)) *
      SURFACE_OPTICAL_HEIGHT -
    0.5;
  return [Math.round(x), Math.round(y)];
}

function opticalPixelToWorld(x: number, y: number): readonly [number, number] {
  return [
    SURFACE_OPTICAL_ORTHO.left +
      ((x + 0.5) / SURFACE_OPTICAL_WIDTH) *
        (SURFACE_OPTICAL_ORTHO.right - SURFACE_OPTICAL_ORTHO.left),
    SURFACE_OPTICAL_ORTHO.top -
      ((y + 0.5) / SURFACE_OPTICAL_HEIGHT) *
        (SURFACE_OPTICAL_ORTHO.top - SURFACE_OPTICAL_ORTHO.bottom),
  ];
}

function singleScatter(scattering: number, extinction: number, distance: number): number {
  if (extinction <= 0) return Math.max(scattering, 0) * Math.max(distance, 0);
  return (Math.max(scattering, 0) * -Math.expm1(-extinction * Math.max(distance, 0))) / extinction;
}

function evaluateOpticalReference(
  surfaceCase: SurfaceOpticalEvidenceCase,
  world: readonly [number, number],
  center: SurfaceOpticalGridPosition,
  pairedBackground: readonly [number, number, number],
  absorption = surfaceCase.parameters.absorption,
): readonly [number, number, number] {
  const tilt = surfaceCase.waterTiltYRadians ?? 0;
  const normal = [Math.sin(tilt), 0, Math.cos(tilt)] as const;
  const surfaceZ = -Math.tan(tilt) * (world[0] - center.x);
  let background = pairedBackground;
  let distance: number;
  if (surfaceCase.halfSubmergedTarget === true) {
    const targetZ = Math.tan(HALF_SUBMERGED_TILT) * (world[1] - center.y);
    if (targetZ >= surfaceZ - 0.0005) return pairedBackground;
    distance = surfaceZ - targetZ;
  } else if (surfaceCase.backgroundDistanceMeters !== undefined) {
    distance = surfaceZ + surfaceCase.backgroundDistanceMeters;
  } else {
    distance = surfaceCase.parameters.maxDistanceMeters;
    background = [0, 0, 0];
  }

  const sigmaS = surfaceCase.parameters.scattering.map((value) => Math.max(value, 0));
  const sigmaT = absorption.map((value, channel) => Math.max(value + (sigmaS[channel] ?? 0), 0));
  const transmittance = sigmaT.map((value) => Math.exp(-value * distance));
  const viewDirection = evaluateSurfaceOpticalViewDirection(
    CAMERA_PROJECTION_ORTHOGRAPHIC,
    [world[0], world[1], surfaceZ],
    [0, 0, SURFACE_OPTICAL_ORTHO.cameraZ],
    [0, 0, 1],
  );
  const phaseG = Math.min(0.95, Math.max(-0.95, surfaceCase.parameters.phaseG));
  const phaseCosine = -viewDirection[2];
  const phaseDenominator = Math.max(1 + phaseG * phaseG - 2 * phaseG * phaseCosine, 0.0001);
  const phase = (1 - phaseG * phaseG) / (12.5663706 * phaseDenominator ** 1.5);
  const directLight = Math.max(normal[2], 0);
  const ior = Math.max(surfaceCase.parameters.ior, 1.0001);
  const f = (ior - 1) / (ior + 1);
  const f0 = f * f;
  const normalDotView = Math.max(
    normal[0] * viewDirection[0] + normal[1] * viewDirection[1] + normal[2] * viewDirection[2],
    0,
  );
  const fresnel = Math.min(1, Math.max(0, f0 + (1 - f0) * (1 - normalDotView) ** 5));
  return [0, 1, 2].map((channel) => {
    const scatter = singleScatter(sigmaS[channel] ?? 0, sigmaT[channel] ?? 0, distance);
    const transmission = (background[channel] ?? 0) * (transmittance[channel] ?? 0);
    return Math.max(0, (transmission + scatter * phase * directLight) * (1 - fresnel));
  }) as [number, number, number];
}

/**
 * Compare the real receipt-bound rgba16float attachment with an independent
 * Number/Double implementation of the documented screen-space approximation.
 */
export function evaluateSurfaceOpticalOracle(
  observation: SurfaceOpticalLinearHdrObservation,
): readonly SurfaceOpticalOracleRecord[] {
  if (observation.metadata.format !== 'rgba16float') {
    throw new Error(`surface-optical: expected rgba16float, got ${observation.metadata.format}`);
  }
  const controlPixel = opticalWorldToPixel(surfaceOpticalGridPosition(0));
  const records: SurfaceOpticalOracleRecord[] = [];
  for (const [caseIndex, surfaceCase] of SURFACE_OPTICAL_CASES.entries()) {
    const center = surfaceOpticalGridPosition(caseIndex + 1);
    const centerPixel = opticalWorldToPixel(center);
    const sampleOffsets =
      surfaceCase.halfSubmergedTarget === true
        ? ([
            // Keep the original world-space sample centers when backing size changes.
            { label: 'foreground', x: 0, y: -Math.round(SURFACE_OPTICAL_HEIGHT / 18) },
            { label: 'submerged', x: 0, y: Math.round(SURFACE_OPTICAL_HEIGHT / 18) },
          ] as const)
        : ([{ label: 'center', x: 0, y: 0 }] as const);
    const samples: SurfaceOpticalOracleSample[] = [];
    let maxError = -1;
    let maxErrorPosition: readonly [number, number] = centerPixel;
    let maxErrorSample: SurfaceOpticalOracleSample | undefined;
    let falsifierMaxError = 0;
    for (const sampleOffset of sampleOffsets) {
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          const pixel = [
            centerPixel[0] + sampleOffset.x + dx,
            centerPixel[1] + sampleOffset.y + dy,
          ] as const;
          const pairedBackground = readLinearHdrPixel(
            observation,
            controlPixel[0] + dx,
            controlPixel[1] + dy,
          );
          const world = opticalPixelToWorld(pixel[0], pixel[1]);
          const actual = readLinearHdrPixel(observation, pixel[0], pixel[1]);
          const reference = evaluateOpticalReference(surfaceCase, world, center, pairedBackground);
          const error = actual.map((value, channel) =>
            Math.abs(value - (reference[channel] ?? 0)),
          ) as [number, number, number];
          const sampleMax = Math.max(...error);
          const evidenceSample = {
            label: sampleOffset.label,
            pixel,
            world,
            pairedBackground,
            actual,
            reference,
            error,
          } satisfies SurfaceOpticalOracleSample;
          if (sampleMax > maxError) {
            maxError = sampleMax;
            maxErrorPosition = pixel;
            maxErrorSample = evidenceSample;
          }
          if (surfaceCase.falsifierAbsorption !== undefined) {
            const wrong = evaluateOpticalReference(
              surfaceCase,
              world,
              center,
              pairedBackground,
              surfaceCase.falsifierAbsorption,
            );
            falsifierMaxError = Math.max(
              falsifierMaxError,
              ...actual.map((value, channel) => Math.abs(value - (wrong[channel] ?? 0))),
            );
          }
          samples.push(evidenceSample);
        }
      }
    }
    if (maxErrorSample === undefined) {
      throw new Error(`surface-optical: ${surfaceCase.id} produced no ROI samples`);
    }
    records.push({
      id: surfaceCase.id,
      guid: surfaceCase.guid,
      parameters: surfaceCase.parameters,
      backgroundDistanceMeters: surfaceCase.backgroundDistanceMeters,
      waterTiltYRadians: surfaceCase.waterTiltYRadians ?? 0,
      samples: Object.freeze(samples),
      maxError,
      maxErrorPosition,
      maxErrorSample,
      ...(surfaceCase.falsifierAbsorption === undefined ? {} : { falsifierMaxError }),
    });
  }
  return Object.freeze(records);
}

function surfaceAssets(source: AssetRegistry): AssetRegistry {
  const assets = new AssetRegistry({ shaderRegistry: source.shaderRegistry });
  installDefaultAssetDecoders(assets);
  if (source.catalogSource === undefined) throw new Error('Surface source Catalog is unavailable');
  assets.setCatalogSource(source.catalogSource);
  return assets;
}

/** Exercise shared Mesh defaults and last-probe retirement through both physical draw lanes. */
export async function runSurfaceManagedMediumOracle(renderer: Renderer, source: AssetRegistry) {
  const assets = surfaceAssets(source);
  const ordinary = assets
    .create(
      Materials.standard({
        baseColor: [1, 0.05, 0.05, 1],
        emissive: [1, 0, 0],
      }),
    )
    .unwrap();
  const medium = (await assets.load(parseSurfaceGuid(SURFACE_CASES[4].guid), 'material')).unwrap();
  const world = new World({ assets });
  const geometry = createPlaneGeometry(4, 4).unwrap();
  const slots = (material: AssetHandle<'material'>) => [
    { slotName: 'surface', defaultMaterial: material },
  ];
  const mesh = assets.create({ ...geometry, materialSlots: slots(ordinary) }).unwrap();
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [] } },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 6] } },
      {
        component: Camera,
        data: {
          fov: Math.PI / 4,
          aspect: SURFACE_WIDTH / SURFACE_HEIGHT,
          near: 0.1,
          far: 20,
          antialias: 0,
          bloom: 0,
          clearColor: [0.05, 0.1, 0.15, 1],
        },
      },
    )
    .unwrap();
  world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [0, 0, -1],
        intensity: 1,
        castShadow: false,
      },
    })
    .unwrap();
  propagateTransforms(world).unwrap();
  const dynamicInput = createSurfaceOpticalDynamicInput(
    [assets.read(medium).unwrap()],
    [{ worldIdentity: world.identity, entityKey: entity, drawItemIndex: 0, instanceOrdinal: 0 }],
    renderer.inspect().frame.deviceGeneration,
  );
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  const lease = attached.value;
  const profile = renderer.inspect().profile;
  let lastRenderError: unknown;
  const stopErrors = renderer.subscribe((event) => {
    if (event.kind === 'error') lastRenderError = event.error;
  });
  const evidence: {
    renderPath: 'forward' | 'deferred';
    geometryLane: 'direct' | 'automatic';
    meshDefaultDelta: number;
    localProbeDelta: number;
    retirementError: number;
    materialRestoreError: number;
  }[] = [];
  const distance = (left: readonly number[], right: readonly number[]) =>
    Math.max(...left.map((value, index) => Math.abs(value - (right[index] ?? Number.NaN))));
  try {
    for (const renderPath of ['forward', 'deferred'] as const) {
      const configured = renderer.setProfile({ ...profile, renderPath, ssao: false });
      if (!configured.ok) throw configured.error;
      for (const geometryLane of ['direct', 'automatic'] as const) {
        const capture = async (isMedium: boolean) => {
          renderer.setSurfaceDynamicInput(isMedium ? { ...dynamicInput, frameTime: 0 } : undefined);
          world.update(1 / 60).unwrap();
          propagateTransforms(world).unwrap();
          const receipt = await drawReadyFrame(
            renderer,
            {
              leases: [lease],
              camera: { lease },
              environment: { lease },
              geometryLane,
            },
            ['linear-hdr'],
          ).catch((cause) => {
            throw new Error(
              `managed-medium: ${String(cause)}; rendererError=${JSON.stringify(lastRenderError)}`,
              { cause },
            );
          });
          const observed = await renderer.observe(receipt, { include: ['linear-hdr'] });
          if (!observed.ok) throw observed.error;
          const image = observed.value.observations?.find(
            (entry) => entry.domain === 'linear-hdr',
          ) as SurfaceOpticalLinearHdrObservation | undefined;
          if (image === undefined || image.metadata.frameId !== receipt.frameId)
            throw new Error('managed-medium: current completed HDR observation unavailable');
          if (isMedium) {
            const submission = renderer.inspect().renderScene.submission;
            const expectedLane = geometryLane === 'direct' ? 'direct' : 'gpu-driven';
            if (submission?.frameId !== receipt.frameId || submission.actualLane !== expectedLane)
              throw new Error(`managed-medium: expected actual ${expectedLane} medium submission`);
          }
          const samples: number[] = [];
          const x = Math.floor(image.metadata.width / 2),
            y = Math.floor(image.metadata.height / 2);
          for (let dy = -2; dy <= 2; dy++)
            for (let dx = -2; dx <= 2; dx++)
              samples.push(...readLinearHdrPixel(image, x + dx, y + dy));
          if (!samples.every(Number.isFinite)) throw new Error('managed-medium: non-finite pixels');
          return samples;
        };
        const standard = await capture(false);
        assets.update(mesh, { materialSlots: slots(medium) }).unwrap();
        const baseline = await capture(true);
        const irradiance = new Float32Array(27);
        irradiance.set([256, 128, 64]);
        const probe = world
          .spawn(
            { component: Transform, data: {} },
            { component: LightProbe, data: { irradiance, radius: 20 } },
          )
          .unwrap();
        const lit = await capture(true);
        world.despawn(probe).unwrap();
        const retired = await capture(true);
        if ((renderer.inspect().renderScene.probeBlend?.records.length ?? 0) !== 0)
          throw new Error('managed-medium: last-probe retirement retained object records');
        assets.update(mesh, { materialSlots: slots(ordinary) }).unwrap();
        const restored = await capture(false);
        const result = {
          renderPath,
          geometryLane,
          meshDefaultDelta: distance(standard, baseline),
          localProbeDelta: distance(baseline, lit),
          retirementError: distance(baseline, retired),
          materialRestoreError: distance(standard, restored),
        };
        if (
          result.meshDefaultDelta <= SURFACE_PIXEL_EPSILON ||
          result.localProbeDelta <= SURFACE_PIXEL_EPSILON ||
          result.retirementError > SURFACE_PIXEL_EPSILON ||
          result.materialRestoreError > SURFACE_PIXEL_EPSILON
        )
          throw new Error(`managed-medium: pixel falsification failed ${JSON.stringify(result)}`);
        if (
          world.get(entity, MeshFilter).unwrap().assetHandle !== mesh ||
          world.get(entity, MeshRenderer).unwrap().materials.length !== 0
        )
          throw new Error('managed-medium: asset adoption rewrote the consuming entity');
        evidence.push(result);
      }
    }
    const restoredProfile = renderer.setProfile(profile);
    if (!restoredProfile.ok) throw restoredProfile.error;
    return evidence;
  } finally {
    stopErrors();
    renderer.setSurfaceDynamicInput(undefined);
    lease.dispose();
    dynamicInput.page.release().unwrap();
    assets.dispose();
  }
}

/** Source loads preserve each World's independent accepted program and dependency closure. */
export async function loadSurfaceMaterial(assets: AssetRegistry, guid: AssetGuid) {
  const loaded = await assets.load(guid, 'material');
  if (!loaded.ok) return loaded;
  return ok(runtimeAssets(assets).borrow<MaterialAsset>(loaded.value).unwrap());
}

export interface SurfaceOpticalRuntimeEvidence {
  readonly receipt: Pick<
    FrameReceipt,
    'frameId' | 'deviceGeneration' | 'backendId' | 'graphGeneration'
  >;
  readonly completion: 'completed';
  readonly observation: SurfaceOpticalLinearHdrObservation['metadata'];
  readonly submission: NonNullable<ReturnType<Renderer['inspect']>['renderScene']['submission']>;
  readonly camera: typeof SURFACE_OPTICAL_ORTHO;
  readonly materialGuids: readonly string[];
  readonly records: readonly SurfaceOpticalOracleRecord[];
}

function opticalDistance(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  return Math.max(...left.map((value, channel) => Math.abs(value - (right[channel] ?? 0))));
}

function centerActual(
  records: readonly SurfaceOpticalOracleRecord[],
  id: string,
  label = 'center',
): readonly [number, number, number] {
  const record = records.find((candidate) => candidate.id === id);
  const sample = record?.samples.find((candidate) => candidate.label === label);
  if (sample === undefined) throw new Error(`surface-optical: ${id}/${label} sample unavailable`);
  return sample.actual;
}

/** Execute the real Pack-loaded medium path and return its receipt-bound HDR proof. */
export async function runSurfaceOpticalOracle(
  renderer: Renderer,
  sourceAssets: AssetRegistry,
): Promise<SurfaceOpticalRuntimeEvidence> {
  const assets = surfaceAssets(sourceAssets);
  const backgroundLoaded = await loadSurfaceMaterial(
    assets,
    parseSurfaceGuid(SURFACE_OPTICAL_BACKGROUND_GUID),
  );
  if (!backgroundLoaded.ok) {
    throw new Error(`surface-optical: background load failed ${String(backgroundLoaded.error)}`);
  }
  const materials: MaterialAsset[] = [];
  for (const surfaceCase of SURFACE_OPTICAL_CASES) {
    const loaded = await loadSurfaceMaterial(assets, parseSurfaceGuid(surfaceCase.guid));
    if (!loaded.ok) {
      throw new Error(`surface-optical: ${surfaceCase.id} load failed ${String(loaded.error)}`);
    }
    materials.push(assertSurfaceOpticalMaterialPayload(surfaceCase, loaded.value));
  }

  const world = new World({ assets });
  const { mediumMembers } = populateSurfaceOpticalWorld(world, backgroundLoaded.value, materials);
  const dynamicInput = createSurfaceOpticalDynamicInput(
    materials,
    mediumMembers,
    renderer.inspect().frame.deviceGeneration,
  );
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  const renderErrors: unknown[] = [];
  const unsubscribeErrors = renderer.subscribe((event) => {
    if (event.kind === 'error') renderErrors.push(event.error);
  });
  let receipt: FrameReceipt | undefined;
  try {
    for (let frame = 0; frame < quality.staticFrames; frame += 1) {
      renderer.setSurfaceDynamicInput({ ...dynamicInput, frameTime: 0 });
      world.update(1 / 60).unwrap();
      if (frame === quality.staticFrames - 1) {
        const armed = renderer.requestObservation?.(['linear-hdr']);
        if (armed === undefined || !armed.ok) {
          throw new Error('surface-optical: linear-hdr observation could not be armed');
        }
      }
      const drawn = renderer.draw({
        leases: [attached.value],
        camera: { lease: attached.value },
        environment: { lease: attached.value },
        geometryLane: 'direct',
      });
      if (!drawn.ok) throw drawn.error;
      const completed = await drawn.value.completed;
      if (!completed.ok) throw completed.error;
      if (frame === quality.staticFrames - 1) receipt = drawn.value;
    }
    if (receipt === undefined) throw new Error('surface-optical: observation receipt unavailable');
    const observed = await renderer.observe(receipt, { include: ['linear-hdr'] });
    if (!observed.ok) throw observed.error;
    const observation = observed.value.observations?.find(
      (candidate) => candidate.domain === 'linear-hdr',
    );
    if (observation === undefined) {
      throw new Error('surface-optical: receipt has no linear-hdr observation');
    }
    const linearHdr = observation as SurfaceOpticalLinearHdrObservation;
    if (
      linearHdr.metadata.format !== 'rgba16float' ||
      linearHdr.metadata.frameId !== receipt.frameId ||
      linearHdr.metadata.deviceGeneration !== receipt.deviceGeneration ||
      linearHdr.metadata.graphGeneration !== receipt.graphGeneration ||
      linearHdr.metadata.textureIdentity === linearHdr.metadata.readbackIdentity
    ) {
      throw new Error('surface-optical: observation identity/format mismatch');
    }
    const submission = renderer.inspect().renderScene.submission;
    if (
      submission === undefined ||
      submission.frameId !== receipt.frameId ||
      submission.deviceGeneration !== receipt.deviceGeneration ||
      submission.graphGeneration !== receipt.graphGeneration ||
      submission.resourceGeneration === undefined ||
      submission.status !== 'completed' ||
      submission.actualLane !== 'direct' ||
      submission.passes.length !== 2 ||
      submission.passes.some(
        (pass) =>
          pass.commandCount === 0 ||
          pass.commands.some(
            (command) =>
              command.programEvidence !== 'producer-receipt' ||
              command.receiptIdentity === undefined ||
              command.receiptGeneration === undefined,
          ),
      )
    ) {
      throw new Error('surface-optical: actual nearest/color submission receipt is incomplete');
    }

    const records = evaluateSurfaceOpticalOracle(linearHdr);
    const failed = records.find(
      (record) =>
        !Number.isFinite(record.maxError) || record.maxError > SURFACE_OPTICAL_PIXEL_EPSILON,
    );
    if (failed !== undefined) {
      const worst = failed.samples.find((sample) => Math.max(...sample.error) === failed.maxError);
      throw new Error(
        `surface-optical: ${failed.id} max error ${failed.maxError} at ${failed.maxErrorPosition.join(',')} evidence=${JSON.stringify(worst)} renderErrors=${JSON.stringify(renderErrors)}`,
      );
    }
    const falsifier = records.find((record) => record.id === 'falsifier');
    if (
      falsifier?.falsifierMaxError === undefined ||
      falsifier.falsifierMaxError <= SURFACE_OPTICAL_PIXEL_EPSILON
    ) {
      throw new Error('surface-optical: changed-absorption falsifier did not cross the threshold');
    }
    for (const [nearId, farId] of [
      ['distance-near', 'distance-double'],
      ['ior-normal', 'ior-grazing'],
      ['shallow', 'deep'],
    ] as const) {
      if (
        opticalDistance(centerActual(records, nearId), centerActual(records, farId)) <=
        SURFACE_OPTICAL_PIXEL_EPSILON
      ) {
        throw new Error(`surface-optical: ${nearId}/${farId} did not falsify equal output`);
      }
    }
    if (
      opticalDistance(
        centerActual(records, 'half-submerged', 'foreground'),
        centerActual(records, 'half-submerged', 'submerged'),
      ) <= SURFACE_OPTICAL_PIXEL_EPSILON
    ) {
      throw new Error('surface-optical: half-submerged target did not produce two optical domains');
    }
    const finiteSky = centerActual(records, 'small-extinction-sky');
    if (!finiteSky.every(Number.isFinite)) {
      throw new Error('surface-optical: finite sky-miss sample is non-finite');
    }

    return Object.freeze({
      receipt: Object.freeze({
        frameId: receipt.frameId,
        deviceGeneration: receipt.deviceGeneration,
        backendId: requireSurfaceReceiptBackendId(receipt, 'surface-optical'),
        graphGeneration: receipt.graphGeneration,
      }),
      completion: 'completed' as const,
      observation: Object.freeze({ ...linearHdr.metadata }),
      submission,
      camera: SURFACE_OPTICAL_ORTHO,
      materialGuids: Object.freeze(SURFACE_OPTICAL_CASES.map((surfaceCase) => surfaceCase.guid)),
      records,
    });
  } finally {
    unsubscribeErrors();
    attached.value.dispose();
    dynamicInput.page.release().unwrap();
    assets.dispose();
  }
}

const EDGE_FOREGROUND_CONTROL = Object.freeze({ x: -2.55, y: -1.55 });
const EDGE_BACKGROUND_CONTROL = Object.freeze({ x: 2.5, y: 1.55 });
const EDGE_CAMERA_OFFSETS = Object.freeze([-0.012, 0, 0.012] as const);
const EDGE_SAMPLE_POSITIONS_4X = Object.freeze([
  [0.375, 0.125],
  [0.875, 0.375],
  [0.125, 0.625],
  [0.625, 0.875],
] as const);
const EDGE_GEOMETRY = Object.freeze({
  thinRod: Object.freeze({
    center: [-1.35, 0] as const,
    width: 0.035,
    height: 3.2,
    rotation: Math.PI * (4 / 180),
  }),
  thinWall: Object.freeze({
    center: [0.15, 0.72] as const,
    width: 2.5,
    height: 0.045,
    rotation: -Math.PI * (17 / 180),
  }),
  diagonalShoreline: Object.freeze({
    center: [1.55, -0.72] as const,
    width: 2.65,
    height: 2.2,
    rotation: Math.PI * (19 / 180),
  }),
  roughFootprint: Object.freeze({
    center: [1.15, 1.08] as const,
    width: 0.82,
    height: 0.52,
    rotation: -Math.PI * (11 / 180),
  }),
});

export interface SurfaceEdgeViewport {
  readonly width: number;
  readonly height: number;
  setBackingSize(width: number, height: number): void;
}

interface SurfaceMsaaEdgeCapture {
  readonly sampleCount: 1 | 4;
  readonly cameraOffsetX: number;
  readonly receipt: Pick<
    FrameReceipt,
    'frameId' | 'deviceGeneration' | 'backendId' | 'graphGeneration'
  >;
  readonly observation: SurfaceOpticalLinearHdrObservation;
  readonly resourceGeneration: number;
  readonly viewIdentity: 'main:0';
  readonly pairedPasses: readonly string[];
}

export interface SurfaceMsaaEdgeWitness {
  readonly label:
    | 'thin-rod'
    | 'thin-wall'
    | 'diagonal-shoreline'
    | 'rough-footprint'
    | 'screen-edge';
  readonly pixel: readonly [number, number];
  readonly centerCovered: false;
  readonly coveredSampleIndices: readonly number[];
  readonly resolveExpectation: SurfaceMsaaEdgeResolveExpectation;
  readonly eligiblePixelCount: number;
  readonly failedPixelCount: number;
  readonly oneX: readonly [number, number, number];
  readonly fourX: readonly [number, number, number];
  readonly expectedColor: readonly [number, number, number];
  readonly maxError: number;
  readonly rejectedAlternativeDistance: number;
  readonly oneToFourDistance: number;
}

export interface SurfaceMsaaEdgeRuntimeEvidence {
  readonly completion: 'completed';
  readonly oneX: readonly (Omit<SurfaceMsaaEdgeCapture, 'observation'> & {
    readonly observation: SurfaceOpticalLinearHdrObservation['metadata'];
  })[];
  readonly fourX: readonly (Omit<SurfaceMsaaEdgeCapture, 'observation'> & {
    readonly observation: SurfaceOpticalLinearHdrObservation['metadata'];
  })[];
  readonly resized: {
    readonly oneX: Omit<SurfaceMsaaEdgeCapture, 'observation'> & {
      readonly observation: SurfaceOpticalLinearHdrObservation['metadata'];
    };
    readonly fourX: Omit<SurfaceMsaaEdgeCapture, 'observation'> & {
      readonly observation: SurfaceOpticalLinearHdrObservation['metadata'];
    };
  };
  readonly witnesses: readonly SurfaceMsaaEdgeWitness[];
  readonly movementWitnessCount: number;
  readonly resizedWitnessCount: number;
}

function edgeWorldToPixel(
  position: SurfaceOpticalGridPosition,
  metadata: SurfaceOpticalLinearHdrObservation['metadata'],
  cameraOffsetX: number,
): readonly [number, number] {
  const x =
    ((position.x - cameraOffsetX - SURFACE_OPTICAL_ORTHO.left) /
      (SURFACE_OPTICAL_ORTHO.right - SURFACE_OPTICAL_ORTHO.left)) *
      metadata.width -
    0.5;
  const y =
    ((SURFACE_OPTICAL_ORTHO.top - position.y) /
      (SURFACE_OPTICAL_ORTHO.top - SURFACE_OPTICAL_ORTHO.bottom)) *
      metadata.height -
    0.5;
  return [Math.round(x), Math.round(y)];
}

function createSurfaceMsaaEdgeWorld(
  world: World,
  backgroundMaterial: MaterialAsset,
  mainWaterMaterial: MaterialAsset,
  shorelineMaterial: MaterialAsset,
  roughWaterMaterial: MaterialAsset,
  sampleCount: 1 | 4,
): {
  readonly cameraEntity: EntityHandle;
  readonly mediumMembers: readonly SurfaceDynamicInputMemberIdentity[];
} {
  const mesh = (width: number, height: number) =>
    testAssets(world).create(createPlaneGeometry(width, height).unwrap()).unwrap();
  const backgroundHandle = testAssets(world).create(backgroundMaterial).unwrap();
  const foregroundHandle = testAssets(world)
    .create(
      Materials.standard({
        baseColor: [0, 0, 0, 1],
        metallic: 0,
        roughness: 1,
        emissive: [0.04, 0.48, 0.92],
        emissiveIntensity: 1,
      }),
    )
    .unwrap();
  const mainWaterHandle = testAssets(world).create(mainWaterMaterial).unwrap();
  const shorelineHandle = testAssets(world).create(shorelineMaterial).unwrap();
  const roughWaterHandle = testAssets(world).create(roughWaterMaterial).unwrap();

  const spawnPlane = (
    width: number,
    height: number,
    pos: readonly [number, number, number],
    material: typeof backgroundHandle,
    rotationZ = 0,
  ): EntityHandle =>
    world
      .spawn(
        {
          component: Transform,
          data: { pos, ...(rotationZ === 0 ? {} : { quat: quaternionZ(rotationZ) }) },
        },
        { component: MeshFilter, data: { assetHandle: mesh(width, height) } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();

  spawnPlane(6, 4, [0, 0, -2], backgroundHandle);
  spawnPlane(
    EDGE_GEOMETRY.thinRod.width,
    EDGE_GEOMETRY.thinRod.height,
    [...EDGE_GEOMETRY.thinRod.center, -1],
    foregroundHandle,
    EDGE_GEOMETRY.thinRod.rotation,
  );
  spawnPlane(
    EDGE_GEOMETRY.thinWall.width,
    EDGE_GEOMETRY.thinWall.height,
    [...EDGE_GEOMETRY.thinWall.center, -1],
    foregroundHandle,
    EDGE_GEOMETRY.thinWall.rotation,
  );
  spawnPlane(
    0.42,
    0.42,
    [EDGE_FOREGROUND_CONTROL.x, EDGE_FOREGROUND_CONTROL.y, -1],
    foregroundHandle,
  );

  const mediumMembers: SurfaceDynamicInputMemberIdentity[] = [];
  for (const [width, height, pos, rotationZ, handle] of [
    [6, 4, [0, 0, 0], 0, mainWaterHandle],
    [
      EDGE_GEOMETRY.diagonalShoreline.width,
      EDGE_GEOMETRY.diagonalShoreline.height,
      [...EDGE_GEOMETRY.diagonalShoreline.center, 0.012],
      EDGE_GEOMETRY.diagonalShoreline.rotation,
      shorelineHandle,
    ],
    [
      EDGE_GEOMETRY.roughFootprint.width,
      EDGE_GEOMETRY.roughFootprint.height,
      [...EDGE_GEOMETRY.roughFootprint.center, 0.024],
      EDGE_GEOMETRY.roughFootprint.rotation,
      roughWaterHandle,
    ],
  ] as const) {
    const entity = spawnPlane(width, height, pos, handle, rotationZ);
    mediumMembers.push({
      worldIdentity: world.identity,
      entityKey: entity,
      drawItemIndex: 0,
      instanceOrdinal: 0,
    });
  }
  const cameraEntity = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, SURFACE_OPTICAL_ORTHO.cameraZ] } },
      {
        component: Camera,
        data: {
          projection: CAMERA_PROJECTION_ORTHOGRAPHIC,
          left: SURFACE_OPTICAL_ORTHO.left,
          right: SURFACE_OPTICAL_ORTHO.right,
          bottom: SURFACE_OPTICAL_ORTHO.bottom,
          top: SURFACE_OPTICAL_ORTHO.top,
          near: SURFACE_OPTICAL_ORTHO.near,
          far: SURFACE_OPTICAL_ORTHO.far,
          ...(sampleCount === 4 ? { antialias: ANTIALIAS_MSAA } : {}),
          clearColor: [0, 0, 0, 1],
        },
      },
    )
    .unwrap();
  world.spawn({
    component: DirectionalLight,
    data: { direction: [0, 0, -1], color: [1, 1, 1], intensity: 1, castShadow: false },
  });
  propagateTransforms(world).unwrap();
  return { cameraEntity, mediumMembers: Object.freeze(mediumMembers) };
}

async function captureSurfaceMsaaEdgeFrame(input: {
  readonly renderer: Renderer;
  readonly world: World;
  readonly lease: RenderWorldLease;
  readonly cameraEntity: EntityHandle;
  readonly dynamicInput: Omit<SurfaceDynamicInputFrame, 'frameTime'>;
  readonly sampleCount: 1 | 4;
  readonly cameraOffsetX: number;
  readonly warmupFrames: number;
}): Promise<SurfaceMsaaEdgeCapture> {
  input.world
    .set(input.cameraEntity, Transform, {
      pos: [input.cameraOffsetX, 0, SURFACE_OPTICAL_ORTHO.cameraZ],
    })
    .unwrap();
  propagateTransforms(input.world).unwrap();
  let receipt: FrameReceipt | undefined;
  for (let frame = 0; frame < input.warmupFrames; frame += 1) {
    input.renderer.setSurfaceDynamicInput({ ...input.dynamicInput, frameTime: 0 });
    input.world.update(1 / 60).unwrap();
    if (frame === input.warmupFrames - 1) {
      const armed = input.renderer.requestObservation?.(['linear-hdr']);
      if (armed === undefined || !armed.ok) {
        throw new Error('surface-msaa-edge: linear-hdr observation could not be armed');
      }
    }
    const drawn = input.renderer.draw({
      leases: [input.lease],
      camera: { lease: input.lease, entityKey: input.cameraEntity },
      environment: { lease: input.lease },
      geometryLane: 'direct',
    });
    if (!drawn.ok) throw drawn.error;
    const completed = await drawn.value.completed;
    if (!completed.ok) throw completed.error;
    if (frame === input.warmupFrames - 1) receipt = drawn.value;
  }
  if (receipt === undefined) throw new Error('surface-msaa-edge: completed receipt unavailable');
  const observed = await input.renderer.observe(receipt, { include: ['linear-hdr'] });
  if (!observed.ok) throw observed.error;
  const observation = observed.value.observations?.find(
    (candidate) => candidate.domain === 'linear-hdr',
  ) as SurfaceOpticalLinearHdrObservation | undefined;
  const inspection = input.renderer.inspect();
  const submission = inspection.renderScene.submission;
  if (
    observation === undefined ||
    observation.metadata.format !== 'rgba16float' ||
    observation.metadata.frameId !== receipt.frameId ||
    observation.metadata.deviceGeneration !== receipt.deviceGeneration ||
    observation.metadata.graphGeneration !== receipt.graphGeneration ||
    submission === undefined ||
    submission.status !== 'completed' ||
    submission.frameId !== receipt.frameId ||
    submission.graphGeneration !== receipt.graphGeneration ||
    submission.deviceGeneration !== receipt.deviceGeneration ||
    submission.resourceGeneration === undefined ||
    submission.passes.length !== 2 ||
    submission.passes.some((pass) => pass.commandCount === 0)
  ) {
    throw new Error('surface-msaa-edge: observation/submission identity is incomplete');
  }
  const pairedPasses = inspection.perFramePassNames.filter((name) =>
    name.startsWith('single-layer-medium-'),
  );
  const expectedPasses =
    input.sampleCount === 4
      ? [
          'single-layer-medium-opaque-resolve-color-producer',
          'single-layer-medium-opaque-resolve-depth-producer',
          'single-layer-medium-nearest-resolve-color-producer',
          'single-layer-medium-nearest-resolve-depth-producer',
        ]
      : [
          'single-layer-medium-raw-depth-producer',
          'single-layer-medium-nearest-depth-sampled-producer',
        ];
  if (expectedPasses.some((name) => !pairedPasses.includes(name))) {
    throw new Error(
      `surface-msaa-edge: ${input.sampleCount}x paired pass facts missing ${JSON.stringify(pairedPasses)}`,
    );
  }
  return Object.freeze({
    sampleCount: input.sampleCount,
    cameraOffsetX: input.cameraOffsetX,
    receipt: Object.freeze({
      frameId: receipt.frameId,
      deviceGeneration: receipt.deviceGeneration,
      backendId: requireSurfaceReceiptBackendId(receipt, 'surface-msaa-edge'),
      graphGeneration: receipt.graphGeneration,
    }),
    observation,
    resourceGeneration: submission.resourceGeneration,
    viewIdentity: submission.viewIdentity,
    pairedPasses: Object.freeze([...pairedPasses]),
  });
}

function detachSurfaceMsaaEdgeCapture(capture: SurfaceMsaaEdgeCapture): Omit<
  SurfaceMsaaEdgeCapture,
  'observation'
> & {
  readonly observation: SurfaceOpticalLinearHdrObservation['metadata'];
} {
  return Object.freeze({
    ...capture,
    observation: Object.freeze({ ...capture.observation.metadata }),
  });
}

function createRuntimeSurfaceMsaaEdgeMask(
  capture: SurfaceMsaaEdgeCapture,
  input: {
    readonly geometry: SurfaceMsaaEdgeGeometry;
    readonly excludedGeometries: readonly SurfaceMsaaEdgeGeometry[];
    readonly min: SurfaceOpticalGridPosition;
    readonly max: SurfaceOpticalGridPosition;
  },
) {
  const metadata = capture.observation.metadata;
  return createSurfaceMsaaEdgeMask({
    projection: {
      width: metadata.width,
      height: metadata.height,
      left: SURFACE_OPTICAL_ORTHO.left,
      right: SURFACE_OPTICAL_ORTHO.right,
      bottom: SURFACE_OPTICAL_ORTHO.bottom,
      top: SURFACE_OPTICAL_ORTHO.top,
      cameraOffsetX: capture.cameraOffsetX,
    },
    geometry: input.geometry,
    excludedGeometries: input.excludedGeometries,
    min: input.min,
    max: input.max,
    samplePositions: EDGE_SAMPLE_POSITIONS_4X,
  });
}

function findSurfaceMsaaEdgeWitness(input: {
  readonly label: SurfaceMsaaEdgeWitness['label'];
  readonly oneX: SurfaceMsaaEdgeCapture;
  readonly fourX: SurfaceMsaaEdgeCapture;
  readonly mask: ReturnType<typeof createSurfaceMsaaEdgeMask>;
  readonly outsideEndpoint: readonly [number, number, number];
  readonly insideEndpoint: readonly [number, number, number];
  readonly resolveExpectation: SurfaceMsaaEdgeWitness['resolveExpectation'];
}): SurfaceMsaaEdgeWitness {
  const oneXMetadata = input.oneX.observation.metadata;
  const fourXMetadata = input.fourX.observation.metadata;
  if (
    input.oneX.cameraOffsetX !== input.fourX.cameraOffsetX ||
    oneXMetadata.width !== fourXMetadata.width ||
    oneXMetadata.height !== fourXMetadata.height
  ) {
    throw new Error(`surface-msaa-edge: ${input.label} paired capture dimensions or camera differ`);
  }
  // This is the acceptance boundary: geometry, camera, and fixed sample positions
  // freeze every eligible pixel before either actual HDR image is read.
  const report = evaluateSurfaceMsaaEdgeMask({
    mask: input.mask,
    oneX: {
      width: oneXMetadata.width,
      height: oneXMetadata.height,
      read: (x, y) => readLinearHdrPixel(input.oneX.observation, x, y),
    },
    fourX: {
      width: fourXMetadata.width,
      height: fourXMetadata.height,
      read: (x, y) => readLinearHdrPixel(input.fourX.observation, x, y),
    },
    outsideEndpoint: input.outsideEndpoint,
    insideEndpoint: input.insideEndpoint,
    resolveExpectation: input.resolveExpectation,
    epsilon: SURFACE_OPTICAL_PIXEL_EPSILON,
  });
  if (!report.passed) {
    throw new Error(
      `surface-msaa-edge: ${input.label} failed ${report.failedPixelCount}/${report.eligiblePixelCount} pixels; worst=${JSON.stringify(report.worst)}`,
    );
  }
  const worst = report.worst;
  const coverage = worst.coveredSampleIndices.length / EDGE_SAMPLE_POSITIONS_4X.length;
  const coverageAverage = [0, 1, 2].map(
    (channel) =>
      (input.outsideEndpoint[channel] ?? 0) * (1 - coverage) +
      (input.insideEndpoint[channel] ?? 0) * coverage,
  ) as [number, number, number];
  const rejectedAlternative =
    input.resolveExpectation === 'nearest-opaque-pair' ? coverageAverage : input.insideEndpoint;
  return Object.freeze({
    label: input.label,
    pixel: worst.pixel,
    centerCovered: false as const,
    coveredSampleIndices: worst.coveredSampleIndices,
    resolveExpectation: input.resolveExpectation,
    eligiblePixelCount: report.eligiblePixelCount,
    failedPixelCount: report.failedPixelCount,
    oneX: worst.actualOneX,
    fourX: worst.actualFourX,
    expectedColor: worst.expectedFourX,
    maxError: report.maxError,
    rejectedAlternativeDistance: surfaceRgbDistance(worst.actualFourX, rejectedAlternative),
    oneToFourDistance: surfaceRgbDistance(worst.actualOneX, worst.actualFourX),
  });
}

/**
 * Execute 1x and 4x authored medium scenes and retain receipt-bound edge proof.
 * The oracle only decodes completed linear-HDR observations; it does not call
 * the production paired-resolve shader or reuse its selection implementation.
 */
export async function runSurfaceMsaaEdgeOracle(
  renderer: Renderer,
  sourceAssets: AssetRegistry,
  viewport: SurfaceEdgeViewport,
): Promise<SurfaceMsaaEdgeRuntimeEvidence> {
  const assets = sourceAssets;
  const backgroundLoaded = await loadSurfaceMaterial(
    assets,
    parseSurfaceGuid(SURFACE_OPTICAL_BACKGROUND_GUID),
  );
  const mainWaterCase = SURFACE_OPTICAL_CASES.find(
    (candidate) => candidate.id === 'zero-extinction',
  );
  const shorelineCase = SURFACE_OPTICAL_CASES.find(
    (candidate) => candidate.id === 'absorption-red',
  );
  const roughWaterCase = SURFACE_CASES.find((candidate) => candidate.id === 'water-surface-b');
  if (
    !backgroundLoaded.ok ||
    mainWaterCase === undefined ||
    shorelineCase === undefined ||
    roughWaterCase === undefined
  ) {
    throw new Error('surface-msaa-edge: authored fixture identities unavailable');
  }
  const mainWaterLoaded = await loadSurfaceMaterial(assets, parseSurfaceGuid(mainWaterCase.guid));
  const shorelineLoaded = await loadSurfaceMaterial(assets, parseSurfaceGuid(shorelineCase.guid));
  const roughWaterLoaded = await loadSurfaceMaterial(assets, parseSurfaceGuid(roughWaterCase.guid));
  if (!mainWaterLoaded.ok || !shorelineLoaded.ok || !roughWaterLoaded.ok) {
    throw new Error('surface-msaa-edge: authored material load failed');
  }
  const mainWater = assertSurfaceOpticalMaterialPayload(mainWaterCase, mainWaterLoaded.value);
  const shoreline = assertSurfaceOpticalMaterialPayload(shorelineCase, shorelineLoaded.value);
  const roughWater = assertMaterialPayload(roughWaterCase, roughWaterLoaded.value);
  const originalSize = { width: viewport.width, height: viewport.height };

  const runLane = async (
    sampleCount: 1 | 4,
    offsets: readonly number[],
  ): Promise<readonly SurfaceMsaaEdgeCapture[]> => {
    const laneAssets = surfaceAssets(sourceAssets);
    const laneMaterials = await Promise.all(
      [
        SURFACE_OPTICAL_BACKGROUND_GUID,
        mainWaterCase.guid,
        shorelineCase.guid,
        roughWaterCase.guid,
      ].map(async (guid) =>
        (await loadSurfaceMaterial(laneAssets, parseSurfaceGuid(guid))).unwrap(),
      ),
    );
    const [laneBackground, laneMainWater, laneShoreline, laneRoughWater] = laneMaterials;
    if (
      laneBackground === undefined ||
      laneMainWater === undefined ||
      laneShoreline === undefined ||
      laneRoughWater === undefined
    )
      throw new Error('surface-msaa-edge: complete material closure required');
    const world = new World({ assets: laneAssets });
    const { cameraEntity, mediumMembers } = createSurfaceMsaaEdgeWorld(
      world,
      laneBackground,
      laneMainWater,
      laneShoreline,
      laneRoughWater,
      sampleCount,
    );
    const dynamicInput = createSurfaceOpticalDynamicInput(
      [mainWater, shoreline, roughWater],
      mediumMembers,
      renderer.inspect().frame.deviceGeneration,
    );
    const attached = renderer.attach(world);
    if (!attached.ok) throw attached.error;
    try {
      const captures: SurfaceMsaaEdgeCapture[] = [];
      for (const [index, cameraOffsetX] of offsets.entries()) {
        captures.push(
          await captureSurfaceMsaaEdgeFrame({
            renderer,
            world,
            lease: attached.value,
            cameraEntity,
            dynamicInput,
            sampleCount,
            cameraOffsetX,
            // Static preparation is shared by Browser and Dawn. Every 1x/4x
            // pixel witness, camera offset and resized pair remains below.
            warmupFrames: index === 0 ? quality.staticFrames : 2,
          }),
        );
      }
      return Object.freeze(captures);
    } finally {
      attached.value.dispose();
      dynamicInput.page.release().unwrap();
      laneAssets.dispose();
    }
  };

  try {
    const oneX = await runLane(1, EDGE_CAMERA_OFFSETS);
    const fourX = await runLane(4, EDGE_CAMERA_OFFSETS);
    const centeredOneX = oneX.find((capture) => capture.cameraOffsetX === 0);
    const centeredFourX = fourX.find((capture) => capture.cameraOffsetX === 0);
    if (centeredOneX === undefined || centeredFourX === undefined) {
      throw new Error('surface-msaa-edge: centered lane evidence unavailable');
    }
    const findWitnesses = (
      oneXCapture: SurfaceMsaaEdgeCapture,
      fourXCapture: SurfaceMsaaEdgeCapture,
    ): readonly SurfaceMsaaEdgeWitness[] => {
      // Freeze all eligibility rows before sampling any actual HDR value.
      const masks = {
        thinRod: createRuntimeSurfaceMsaaEdgeMask(fourXCapture, {
          geometry: EDGE_GEOMETRY.thinRod,
          excludedGeometries: [
            EDGE_GEOMETRY.thinWall,
            EDGE_GEOMETRY.diagonalShoreline,
            EDGE_GEOMETRY.roughFootprint,
          ],
          min: { x: -1.48, y: -1.7 },
          max: { x: -1.22, y: 1.7 },
        }),
        thinWall: createRuntimeSurfaceMsaaEdgeMask(fourXCapture, {
          geometry: EDGE_GEOMETRY.thinWall,
          excludedGeometries: [
            EDGE_GEOMETRY.thinRod,
            EDGE_GEOMETRY.diagonalShoreline,
            EDGE_GEOMETRY.roughFootprint,
          ],
          min: { x: -1.2, y: 0.25 },
          max: { x: 1.5, y: 1.2 },
        }),
        diagonalShoreline: createRuntimeSurfaceMsaaEdgeMask(fourXCapture, {
          geometry: EDGE_GEOMETRY.diagonalShoreline,
          excludedGeometries: [
            EDGE_GEOMETRY.thinRod,
            EDGE_GEOMETRY.thinWall,
            EDGE_GEOMETRY.roughFootprint,
          ],
          min: { x: 0.0, y: -1.85 },
          max: { x: 2.95, y: 0.65 },
        }),
        roughFootprint: createRuntimeSurfaceMsaaEdgeMask(fourXCapture, {
          geometry: EDGE_GEOMETRY.roughFootprint,
          excludedGeometries: [
            EDGE_GEOMETRY.thinRod,
            EDGE_GEOMETRY.thinWall,
            EDGE_GEOMETRY.diagonalShoreline,
          ],
          min: { x: 0.65, y: 0.65 },
          max: { x: 1.72, y: 1.48 },
        }),
        screenEdge: createRuntimeSurfaceMsaaEdgeMask(fourXCapture, {
          geometry: EDGE_GEOMETRY.diagonalShoreline,
          excludedGeometries: [
            EDGE_GEOMETRY.thinRod,
            EDGE_GEOMETRY.thinWall,
            EDGE_GEOMETRY.roughFootprint,
          ],
          min: { x: 2.82, y: -1.75 },
          max: { x: 2.99, y: 0.45 },
        }),
      } as const;
      const sampleControl = (position: SurfaceOpticalGridPosition) => {
        const pixel = edgeWorldToPixel(
          position,
          fourXCapture.observation.metadata,
          fourXCapture.cameraOffsetX,
        );
        return readLinearHdrPixel(fourXCapture.observation, pixel[0], pixel[1]);
      };
      const foreground = sampleControl(EDGE_FOREGROUND_CONTROL);
      const background = sampleControl(EDGE_BACKGROUND_CONTROL);
      const shorelineInside = sampleControl({ x: 1.55, y: -0.72 });
      const shorelineOutside = sampleControl({ x: -0.15, y: -0.72 });
      const roughInside = sampleControl({ x: 1.15, y: 1.08 });
      const roughOutside = sampleControl({ x: 1.68, y: 1.08 });
      if (
        surfaceRgbDistance(foreground, background) <= 0.25 ||
        surfaceRgbDistance(shorelineInside, shorelineOutside) <= 0.05 ||
        surfaceRgbDistance(roughInside, roughOutside) <= 0.05
      ) {
        throw new Error(
          `surface-msaa-edge: authored controls are not discriminating foreground=${surfaceRgbDistance(foreground, background)} shoreline=${surfaceRgbDistance(shorelineInside, shorelineOutside)} rough=${surfaceRgbDistance(roughInside, roughOutside)} values=${JSON.stringify({ shorelineInside, shorelineOutside, roughInside, roughOutside })}`,
        );
      }
      return Object.freeze([
        findSurfaceMsaaEdgeWitness({
          label: 'thin-rod',
          oneX: oneXCapture,
          fourX: fourXCapture,
          mask: masks.thinRod,
          outsideEndpoint: background,
          insideEndpoint: foreground,
          resolveExpectation: 'nearest-opaque-pair',
        }),
        findSurfaceMsaaEdgeWitness({
          label: 'thin-wall',
          oneX: oneXCapture,
          fourX: fourXCapture,
          mask: masks.thinWall,
          outsideEndpoint: background,
          insideEndpoint: foreground,
          resolveExpectation: 'nearest-opaque-pair',
        }),
        findSurfaceMsaaEdgeWitness({
          label: 'diagonal-shoreline',
          oneX: oneXCapture,
          fourX: fourXCapture,
          mask: masks.diagonalShoreline,
          outsideEndpoint: shorelineOutside,
          insideEndpoint: shorelineInside,
          resolveExpectation: 'water-coverage-average',
        }),
        findSurfaceMsaaEdgeWitness({
          label: 'rough-footprint',
          oneX: oneXCapture,
          fourX: fourXCapture,
          mask: masks.roughFootprint,
          outsideEndpoint: roughOutside,
          insideEndpoint: roughInside,
          resolveExpectation: 'water-coverage-average',
        }),
        findSurfaceMsaaEdgeWitness({
          label: 'screen-edge',
          oneX: oneXCapture,
          fourX: fourXCapture,
          mask: masks.screenEdge,
          outsideEndpoint: shorelineOutside,
          insideEndpoint: shorelineInside,
          resolveExpectation: 'water-coverage-average',
        }),
      ]);
    };
    const witnesses = findWitnesses(centeredOneX, centeredFourX);
    let movementWitnessCount = 0;
    for (const moved of fourX) {
      if (
        moved.sampleCount !== 4 ||
        moved.observation.metadata.format !== 'rgba16float' ||
        moved.receipt.frameId !== moved.observation.metadata.frameId ||
        moved.receipt.graphGeneration !== moved.observation.metadata.graphGeneration
      ) {
        throw new Error('surface-msaa-edge: moving-camera capture identity mismatch');
      }
      const matchingOneX = oneX.find((capture) => capture.cameraOffsetX === moved.cameraOffsetX);
      if (matchingOneX === undefined) {
        throw new Error('surface-msaa-edge: moving-camera 1x pair unavailable');
      }
      movementWitnessCount += findWitnesses(matchingOneX, moved).length;
    }

    const resizedWidth = Math.round(originalSize.width * 1.25);
    const resizedHeight = Math.round(originalSize.height * 1.25);
    viewport.setBackingSize(resizedWidth, resizedHeight);
    const resizedOneX = (await runLane(1, [0.008]))[0];
    const resizedFourX = (await runLane(4, [0.008]))[0];
    if (
      resizedOneX === undefined ||
      resizedFourX === undefined ||
      resizedOneX.observation.metadata.width !== resizedWidth ||
      resizedOneX.observation.metadata.height !== resizedHeight ||
      resizedFourX.observation.metadata.width !== resizedWidth ||
      resizedFourX.observation.metadata.height !== resizedHeight ||
      resizedFourX.receipt.graphGeneration === centeredFourX.receipt.graphGeneration
    ) {
      throw new Error('surface-msaa-edge: resize/DPR graph evidence unavailable');
    }
    const resizedWitnessCount = findWitnesses(resizedOneX, resizedFourX).length;

    return Object.freeze({
      completion: 'completed' as const,
      oneX: Object.freeze(oneX.map(detachSurfaceMsaaEdgeCapture)),
      fourX: Object.freeze(fourX.map(detachSurfaceMsaaEdgeCapture)),
      resized: Object.freeze({
        oneX: detachSurfaceMsaaEdgeCapture(resizedOneX),
        fourX: detachSurfaceMsaaEdgeCapture(resizedFourX),
      }),
      witnesses,
      movementWitnessCount,
      resizedWitnessCount,
    });
  } finally {
    viewport.setBackingSize(originalSize.width, originalSize.height);
  }
}
