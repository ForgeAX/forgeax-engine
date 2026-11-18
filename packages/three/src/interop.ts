import { runtimeAssetRegistry } from '@forgeax/engine-assets-runtime/internal';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { CharacterController, RigidBody, RigidBodyTypeValue } from '@forgeax/engine-physics';
import {
  Fog,
  Camera as NativeCamera,
  type Renderer,
  type RenderWorldLease,
  SkyboxBackground,
  Skylight,
} from '@forgeax/engine-render';
import { ChildOf, Name, Transform } from '@forgeax/engine-scene';
import { err, ok, type Result } from '@forgeax/engine-types';
import {
  Camera,
  Color,
  LinearToneMapping,
  NoToneMapping,
  type Object3D,
  PCFShadowMap,
  Scene,
  type ToneMapping,
} from 'three/src/Three.Core.js';
import { cameraData, writeSceneClearColor } from './camera';
import { ThreeCompatibilityError } from './errors';
import { prepareMaterialPrograms } from './material-programs';
import { SceneProjection } from './scene';
import type { ShadowMapSettings } from './shadow';

export interface MountThreeSceneOptions {
  readonly world: World;
  /** Borrowed, initialized renderer using createThreePipeline(). No second renderer is created. */
  readonly renderer: Renderer;
  readonly scene: Scene;
  readonly camera: Camera;
  readonly shadowMap?: ShadowMapSettings & { readonly transmitted?: boolean };
  readonly toneMapping?: ToneMapping;
  readonly toneMappingExposure?: number;
  readonly materialPrograms?: readonly string[];
}

export interface ThreeSceneMount {
  /** Borrowed frame source; the mount holds and releases this lease. */
  readonly source: RenderWorldLease;
  /** Project author changes before native simulation. Does not tick, propagate or draw. */
  sync(): Result<void, ThreeCompatibilityError>;
  entityFor(object: Object3D): Result<EntityHandle, ThreeCompatibilityError>;
  dispose(): Result<void, ThreeCompatibilityError>;
}

// One lifecycle token per borrowed World, including asynchronous admission.
const mounts = new WeakMap<World, symbol>();

function failure(subject: string, cause?: unknown): ThreeCompatibilityError {
  if (cause instanceof ThreeCompatibilityError) return cause;
  if (cause !== undefined)
    return new ThreeCompatibilityError(
      'three-owner-failed',
      subject,
      'Inspect the original cause from the asset, shader, renderer, ECS or source operation; repair that owner and retry. No feature is silently dropped.',
      undefined,
      cause,
    );
  return new ThreeCompatibilityError(
    'three-interop-invalid',
    subject,
    'Use one live mount and one Three camera/environment owner. Do not mutate source-owned components or attach a native pose writer.',
    undefined,
    cause,
  );
}

/** Mount source objects into an existing native World, retaining native rendering and resource ownership. */
export async function mountThreeScene(
  parameters: MountThreeSceneOptions,
): Promise<Result<ThreeSceneMount, ThreeCompatibilityError>> {
  const { world, renderer } = parameters;
  if (mounts.has(world)) return err(failure('World already has a Three scene mount'));
  const token = Symbol('three-mount');
  mounts.set(world, token);
  let input: MountThreeSceneOptions | undefined = parameters;
  let projection: SceneProjection | undefined;
  let source: RenderWorldLease | undefined;
  let unsubscribe: (() => void) | undefined;
  let syncing = false;
  let retiring = false;
  const clearColor = new Float32Array(4);
  const fallback = new Color(0);
  const createGlobals = () =>
    [NativeCamera, Skylight, SkyboxBackground, Fog].map((component) => ({
      component,
      query: world.query({ read: [component] }).unwrap(),
    }));
  let globals: ReturnType<typeof createGlobals> = [];
  const validateSource = (object: Object3D, entity: EntityHandle | undefined) => {
    if (
      object instanceof Scene &&
      (object.onBeforeRender !== Scene.prototype.onBeforeRender ||
        object.onAfterRender !== Scene.prototype.onAfterRender)
    )
      throw failure('Mixed Scene render callbacks require an actual Three renderer boundary');
    if (entity === undefined) return;
    if (!world.hasComponent(entity, Transform) || !world.hasComponent(entity, Name))
      throw failure(`Source entity is stale or missing owned components: ${object.uuid}`);
    if (world.hasComponent(entity, ChildOf))
      throw failure(`Source entity cannot have a native parent: ${object.uuid}`);
    if (
      world.hasComponent(entity, CharacterController) ||
      (world.hasComponent(entity, RigidBody) &&
        world.get(entity, RigidBody).unwrap().type !== RigidBodyTypeValue.static)
    )
      throw failure(`Source Transform cannot have a native pose writer: ${object.uuid}`);
  };
  const sync = (): Result<void, ThreeCompatibilityError> => {
    if (input === undefined || projection === undefined || retiring)
      return err(failure('Three scene mount is disposed'));
    if (syncing) return err(failure('Three scene synchronization is reentrant'));
    syncing = true;
    try {
      const cameraEntity = projection.entityFor(input.camera);
      const sceneEntity = projection.entityFor(input.scene);
      for (const { component, query } of globals)
        query.forEach((row) => {
          if (row.entity !== (component === NativeCamera ? cameraEntity : sceneEntity))
            throw failure(`Mixed World has another ${component.name} owner`);
        });
      const mode = input.toneMapping ?? NoToneMapping;
      if (input.shadowMap?.transmitted === true)
        throw new ThreeCompatibilityError(
          'three-unsupported',
          'Transmitted-color shadows',
          'Native colored shadow transport is not implemented.',
        );
      projection.sync(
        input.scene,
        input.camera,
        {
          ...cameraData(
            input.camera,
            mode === NoToneMapping ? LinearToneMapping : mode,
            mode === NoToneMapping ? 1 : (input.toneMappingExposure ?? 1),
          ),
          clearColor: writeSceneClearColor(clearColor, input.scene, fallback, 0),
        },
        {
          depth: true,
          stencil: false,
          sortObjects: true,
          opaque: true,
          transparent: true,
          updateMatrices: true,
          shadowMap: {
            enabled: input.shadowMap?.enabled ?? false,
            type: input.shadowMap?.type ?? PCFShadowMap,
            cameraLayers: input.camera.layers.mask,
          },
        },
      );
      return ok(undefined);
    } catch (cause) {
      return err(failure('Three scene synchronization failed', cause));
    } finally {
      syncing = false;
    }
  };
  const dispose = (): Result<void, ThreeCompatibilityError> => {
    if (input === undefined) return ok(undefined);
    if (syncing) return err(failure('Cannot dispose during Three synchronization'));
    try {
      projection?.assertRetirable();
      retiring = true;
      projection?.dispose();
      unsubscribe?.();
      unsubscribe = undefined;
      source?.dispose();
      source = undefined;
      input = undefined;
      projection = undefined;
      if (mounts.get(world) === token) mounts.delete(world);
      return ok(undefined);
    } catch (cause) {
      return err(failure('Three scene cleanup failed', cause));
    }
  };
  try {
    globals = createGlobals();
    if (!(parameters.scene instanceof Scene) || !(parameters.camera instanceof Camera))
      throw failure('A Three Scene and Camera are required');
    const assets = runtimeAssetRegistry(world.assets);
    const prepare = await prepareMaterialPrograms(assets, parameters.materialPrograms);
    projection = new SceneProjection(assets, undefined, prepare, {
      world,
      validateSource,
      propagate: false,
    });
    const admitted = sync();
    if (!admitted.ok) throw admitted.error;
    const attached = renderer.attach(world);
    if (!attached.ok) throw attached.error;
    source = attached.value;
    unsubscribe = renderer.subscribe((event) => {
      // UI-only/pending frames do not confirm source textures or shadow updates.
      if (
        event.kind === 'frame-submitted' &&
        event.receipt.presentation === 'ready' &&
        event.receipt.barrelDistortion !== undefined
      )
        projection?.submitted();
    });
    return ok({
      source: attached.value,
      sync,
      dispose,
      entityFor(object) {
        const entity = projection?.entityFor(object);
        return entity === undefined
          ? err(failure('Object has no live accepted Three binding'))
          : ok(entity);
      },
    });
  } catch (cause) {
    const cleaned = dispose();
    return err(cleaned.ok ? failure('Three scene admission failed', cause) : cleaned.error);
  }
}
