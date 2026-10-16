import type { EntityHandle, QueryRow, QuerySpan, World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import type { SceneAsset } from '@forgeax/engine-types';
import {
  ChildOf,
  GlobalTransform,
  MorphWeights,
  propagateTransforms,
  Transform,
  worldInstantiateScenePayload,
} from '../index';

declare const world: World;
declare const entity: EntityHandle;
declare const camera: EntityHandle;
declare const renderer: Renderer;
declare const sceneAsset: SceneAsset;

type RenderProjection = {
  readonly spans: readonly {
    readonly fields: Readonly<Record<string, ArrayLike<number>>>;
  }[];
};
type RenderWorldLease = {
  querySpans(request: {
    readonly components: readonly {
      readonly component: object;
      readonly fields: readonly string[];
    }[];
  }): RenderProjection;
};
type Renderer = { attach(world: World): unknown };

// These owner packages intentionally do not become scene dependencies (the
// animation and physics owners consume scene, while picking is downstream of
// render). Their public signatures are probed structurally at this boundary;
// the production implementations remain the package owners.
type AnimationBinding = (
  world: World,
  player: EntityHandle,
  targets: readonly EntityHandle[],
) => unknown;
type PhysicsComponentRegistration = (world: World) => () => void;
type PickingQuery = (
  world: World,
  camera: EntityHandle,
  screenX: number,
  screenY: number,
  viewportWidth: number,
  viewportHeight: number,
) => unknown;
declare const bindAnimationTargets: AnimationBinding;
declare const registerPhysicsComponents: PhysicsComponentRegistration;
declare const pick: PickingQuery;

// The authoring/import lane writes local TRS, while scene propagation owns the
// derived world column. The payload entrypoint is the import owner.
const authored = world.set(entity, Transform, { pos: [1, 2, 3] });
const imported = worldInstantiateScenePayload(world, sceneAsset);
const propagated = propagateTransforms(world);
void authored;
void imported;
void propagated;

// Query and QuerySpan are the typed world-read lanes used by extraction.
const transformQuery = world.query({ read: [Transform] });
if (transformQuery.ok) {
  for (const row of transformQuery.value) {
    const transform = row.get(Transform);
    const localPosition: Readonly<Float32Array> = transform.pos;
    void localPosition;
  }
}
const globalQuery = world.query({ read: [GlobalTransform] });
if (globalQuery.ok) {
  for (const row of globalQuery.value) {
    const worldMatrix: Float32Array = row.get(GlobalTransform).world;
    void worldMatrix;
  }
  const spans = globalQuery.value.spans();
  if (spans.ok) {
    for (const span of spans.value) {
      const worldColumn: Readonly<Float32Array> = span.get(GlobalTransform).world;
      void worldColumn;
    }
  }
}

// Renderer sync consumes only the ECS projection lease and the derived world
// field; it does not receive a World mutation API or a backend object.
const lease: RenderWorldLease = createRenderReadLease(world);
const renderSpans = lease.querySpans({
  components: [{ component: GlobalTransform, fields: ['world'] }],
});
const rendererAttachment = renderer.attach(world);
void renderSpans;
void rendererAttachment;

// Existing adapter consumers read the same Transform token without taking
// ownership of its propagation or creating a parallel transform component.
const animationTargets = bindAnimationTargets(world, entity, [entity]);
const animationQuery = world.query({ read: [Transform] });
const cameraQuery = world.query({ read: [Transform] });
const physicsRelease = registerPhysicsComponents(world);
const physicsQuery = world.query({ read: [Transform] });
const picked = pick(world, camera, 0, 0, 1, 1);
void animationTargets;
void animationQuery;
void cameraQuery;
void physicsRelease;
void physicsQuery;
void picked;

// Keep the row and span signatures explicit at the adapter boundary.
declare const renderRow: QueryRow<readonly [typeof GlobalTransform], readonly []>;
declare const renderSpan: QuerySpan<readonly [typeof GlobalTransform], readonly []>;
const renderRowWorld: Readonly<Float32Array> = renderRow.get(GlobalTransform).world;
const renderSpanWorld: Readonly<Float32Array> = renderSpan.get(GlobalTransform).world;
void renderRowWorld;
void renderSpanWorld;

// These remain dedicated lanes. Their tokens are recorded for census and are
// not folded into a Transform carrier prototype.
const dedicatedLanes = {
  skin: 'Skin',
  morph: MorphWeights,
  points: 'Points',
  lines: 'Lines',
  meshGeometry: 'MeshFilter',
  meshMaterial: 'MeshRenderer',
  hierarchy: ChildOf,
} as const;
const consumerImpactReceipt = {
  schemaVersion: 1,
  channels: {
    tsImport: true,
    typeErasure: true,
    jsonSchema: true,
  },
  consumers: {
    authoringImport: true,
    propagation: true,
    query: true,
    querySpan: true,
    rendererSync: true,
  },
  adapters: {
    animation: true,
    physics: true,
    picking: true,
    render: true,
  },
  dedicatedLanes: Object.keys(dedicatedLanes),
  unclassifiedConsumers: [] as const,
} as const;
void consumerImpactReceipt;
