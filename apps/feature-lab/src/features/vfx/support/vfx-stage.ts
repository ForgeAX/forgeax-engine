import type { App, CreateAppOptions } from '@forgeax/engine/app';
import type { EntityHandle, World } from '@forgeax/engine/ecs';
import { createBoxGeometry } from '@forgeax/engine/geometry';
import { mat4, vec3 } from '@forgeax/engine/math';
import { Camera, Materials } from '@forgeax/engine/render';
import { GlobalTransform, Transform } from '@forgeax/engine/scene';
import type { MaterialAsset, MeshAsset } from '@forgeax/engine/types';
import {
  ParticleEffectPlayer,
  type VfxGpuAssetError,
  type VfxGpuEffectAssetAny,
  vfxGpuEffectPackLoader,
} from '@forgeax/engine/vfx';
import {
  createVfxRuntimeHost,
  type VfxRuntimeHost,
  type VfxRuntimeHostControl,
} from '@forgeax/engine/vfx-render';
import { spawnCamera, type Vec3 } from '../../../lab/stage';
import {
  LAB_CUBE_MESH_GUID,
  LAB_EFFECT_GUID,
  LAB_EMITTER_IDS,
  LAB_MATERIALS,
  type LabEmitterKind,
} from './lab-effect';
import fixture from './lab-effect.cooked.json';

type LoaderInput = Parameters<typeof vfxGpuEffectPackLoader.load>[0];
type LoaderContext = Parameters<typeof vfxGpuEffectPackLoader.load>[1];

export const LAB_EYE: Vec3 = [0, 1.2, 7.2];
export const LAB_TARGET: Vec3 = [0, 1, 0];

export interface LabHost {
  readonly appOptions: CreateAppOptions;
  host(): VfxRuntimeHost;
  camera: EntityHandle | undefined;
}

/** One host per page: the lab boots exactly one App per feature load, so the getter runs once. */
export function createLabHost(): LabHost {
  let host: VfxRuntimeHost | undefined;
  const lab: LabHost = {
    camera: undefined,
    host() {
      host ??= createVfxRuntimeHost({
        camera: { read: (world) => readCamera(world, lab.camera) },
        providers: [],
      });
      return host;
    },
    get appOptions(): CreateAppOptions {
      return { features: [lab.host().feature] };
    },
  };
  return lab;
}

function readCamera(world: World, entity: EntityHandle | undefined) {
  if (entity === undefined) return undefined;
  const transform = world.get(entity, Transform);
  const global = world.get(entity, GlobalTransform);
  const camera = world.get(entity, Camera);
  if (!transform.ok || !global.ok || !camera.ok) return undefined;
  const cameraWorld = global.value.world;
  const view = mat4.invert(mat4.create(), cameraWorld);
  const projection = mat4.perspectiveReverseZ(
    mat4.create(),
    camera.value.fov,
    camera.value.aspect,
    camera.value.near,
    camera.value.far,
  );
  return {
    position: new Float32Array(transform.value.pos),
    right: new Float32Array(mat4.getRight(vec3.create(), cameraWorld)),
    up: new Float32Array(mat4.getUp(vec3.create(), cameraWorld)),
    viewProjection: mat4.multiply(mat4.create(), projection, view),
  };
}

function particleMaterial(rgba: readonly [number, number, number, number]): MaterialAsset {
  const base = Materials.unlit(rgba);
  return {
    ...base,
    passes: (base.passes ?? []).map((pass) => ({
      ...pass,
      renderState: {
        ...pass.renderState,
        queue: 3000,
        depthWriteEnabled: false,
        blend: {
          color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        },
      },
    })),
  } as MaterialAsset;
}

function labRenderAssets(): Map<string, MaterialAsset | MeshAsset> {
  const cube = createBoxGeometry(1, 1, 1);
  const assets = new Map<string, MaterialAsset | MeshAsset>([
    [LAB_MATERIALS.billboard, particleMaterial([1, 1, 1, 1])],
    [
      LAB_MATERIALS.mesh,
      Materials.standard({
        baseColor: [0.2, 1, 0.3, 1],
        emissive: [0.1, 0.8, 0.2],
        emissiveIntensity: 1.5,
      }),
    ],
    [LAB_MATERIALS.ribbon, particleMaterial([1, 1, 1, 1])],
    [LAB_MATERIALS.trail, particleMaterial([1, 1, 1, 1])],
    [LAB_MATERIALS.beam, particleMaterial([1, 1, 1, 1])],
  ]);
  if (cube.ok) assets.set(LAB_CUBE_MESH_GUID, cube.value);
  return assets;
}

/** Runs the cooked fixture through the owner Pack loader, exactly as a catalog record would arrive. */
export function loadLabEffect(
  patch: (payload: Record<string, unknown>) => Record<string, unknown> = (payload) => payload,
): Promise<{ ok: true; value: VfxGpuEffectAssetAny } | { ok: false; error: VfxGpuAssetError }> {
  const input: LoaderInput = {
    guid: LAB_EFFECT_GUID,
    kind: 'particle-effect',
    payload: patch(structuredClone(fixture.payload) as unknown as Record<string, unknown>),
    artifacts: {
      'particle-effect/program.json': {
        descriptor: {
          path: 'particle-effect/program.json',
          mediaType: 'application/vnd.forgeax.vfx-program+json',
        },
        bytes: new TextEncoder().encode(fixture.programText),
      },
    },
  } as LoaderInput;
  return vfxGpuEffectPackLoader.load(input, {} as LoaderContext);
}

export interface LabVfx {
  readonly app: App;
  readonly world: World;
  readonly host: VfxRuntimeHost;
  readonly control: VfxRuntimeHostControl;
  readonly player: EntityHandle;
  readonly camera: EntityHandle;
  /** Latest structured App error, unwrapped to the render-feature cause when present. */
  lastFailure(): string | undefined;
  /** Enable only `kinds` (LAB_DEFAULT_KINDS when omitted) for isolation. */
  only(kinds?: readonly LabEmitterKind[]): string | undefined;
}

export type LabSetupResult = { ok: true; value: LabVfx } | { ok: false; error: string };

/** Emitters enabled by default; pages narrow them with `only` for isolation. */
export const LAB_DEFAULT_KINDS: readonly LabEmitterKind[] = [
  'billboard',
  'mesh',
  'ribbon',
  'trail',
  'beam',
];

/**
 * Prepared material and mesh bindings resolve through the World's AssetRegistry, so the
 * in-memory lab assets are catalogued there under their GUIDs before the World attaches.
 */
function catalogRenderAssets(
  app: App,
  renderAssets: ReadonlyMap<string, MaterialAsset | MeshAsset>,
): string | undefined {
  const registry = app.assets;
  if (registry === undefined) return 'app.assets is unavailable';
  for (const [guid, asset] of renderAssets) {
    const result = registry.catalog(guid, asset);
    if (!result.ok) return `${result.error.code}: catalog ${guid}`;
  }
  return undefined;
}

export async function setupLabVfx(lab: LabHost, app: App, world: World): Promise<LabSetupResult> {
  let lastFailure: string | undefined;
  app.onError((error) => {
    type Cause = { code?: string; detail?: { reason?: string } };
    const detail = 'detail' in error ? (error.detail as { cause?: Cause } | undefined) : undefined;
    const cause = detail?.cause;
    lastFailure =
      cause === undefined
        ? error.code
        : `${error.code} <- ${cause.code}: ${cause.detail?.reason ?? ''}`;
  });
  const camera = spawnCamera(world, {
    eye: LAB_EYE,
    target: LAB_TARGET,
    data: { clearColor: [0.02, 0.02, 0.04, 1] },
  });
  lab.camera = camera;
  const host = lab.host();
  const renderAssets = labRenderAssets();
  const catalogued = catalogRenderAssets(app, renderAssets);
  if (catalogued !== undefined) return { ok: false, error: catalogued };
  const engineAssets = app.assets as unknown as
    | {
        lookup?: (guid: string) => unknown;
        getMaterialProjectionForPayload?: (material: MaterialAsset) => unknown;
      }
    | undefined;
  const assets = {
    loaders: { registerPackLoader: (_loader: unknown) => undefined },
    lookup: <T>(guid: string): T | undefined =>
      (renderAssets.get(guid) ?? engineAssets?.lookup?.call(engineAssets, guid)) as T | undefined,
    ...(engineAssets?.getMaterialProjectionForPayload === undefined
      ? {}
      : {
          getMaterialProjectionForPayload: (material: MaterialAsset) =>
            engineAssets.getMaterialProjectionForPayload?.call(engineAssets, material),
        }),
  };
  const attached = await host.attachWorld({ world, assets: assets as never });
  if (!attached.ok) return { ok: false, error: `${attached.error.code}: ${attached.error.hint}` };
  const loaded = await loadLabEffect();
  if (!loaded.ok) return { ok: false, error: `${loaded.error.code}: ${loaded.error.hint}` };
  const effect = world.allocSharedRef('ParticleEffectAsset', loaded.value);
  const player = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 0] } },
      {
        component: ParticleEffectPlayer,
        data: { effect, playing: true, seed: 0x1ab, timeScale: 1 },
      },
    )
    .unwrap() as EntityHandle;
  const control = host.acquireControl(world);
  if (!control.ok) return { ok: false, error: `${control.error.code}: ${control.error.hint}` };
  const only = (kinds: readonly LabEmitterKind[] = LAB_DEFAULT_KINDS): string | undefined => {
    for (const [kind, emitterId] of Object.entries(LAB_EMITTER_IDS) as [LabEmitterKind, string][]) {
      const enabled = kinds.includes(kind);
      const result = control.value.setEmitterSessionEnabled({ player, emitterId, enabled });
      if (!result.ok) return `${result.error.code}: ${result.error.hint}`;
    }
    return undefined;
  };
  const defaults = only();
  if (defaults !== undefined) return { ok: false, error: defaults };
  return {
    ok: true,
    value: {
      app,
      world,
      host,
      control: control.value,
      player,
      camera,
      only,
      lastFailure: () => lastFailure,
    },
  };
}
