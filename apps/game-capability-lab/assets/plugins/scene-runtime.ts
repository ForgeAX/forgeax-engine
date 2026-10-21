import type { AssetHandle } from '@forgeax/engine-types';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { CharacterController, Collider, ColliderShapeValue, CollidingEntities, RigidBody, RigidBodyTypeValue } from '@forgeax/engine-physics';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { Materials, MeshFilter, MeshRenderer, SceneInstance } from '@forgeax/engine-render';
import type { SceneBinding } from '../capability-matrix.plugin';
import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { SceneAsset } from '@forgeax/engine-types';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import { Transform } from '@forgeax/engine-scene';
import { Rotatable } from './rotating-target';
import { ScoringTarget } from './scoring-target';
import { cloneWithClearcoat } from './clearcoat-material';
import { BouncyBallHazard, DamageHazard, PlayerHealth } from './counterattack';
import { ProjectileCover, Sentinel } from './components/gameplay';

export type MatHandle = AssetHandle<'material'>;
export type GameContext = {
  world: World;
  assets?: AssetRegistry;
};
export type PackNode = {
  localId: number;
  components: Record<string, Record<string, unknown>>;
};
export type LoadedScene = {
  mapping: ReadonlyMap<number, EntityHandle>;
  nodes: PackNode[];
};
export type ScenePhysics = {
  props: Array<{ e: EntityHandle; materials: readonly MatHandle[]; clearcoat?: boolean }>;
  animatedMaterial?: { e: EntityHandle; mat: MatHandle };
};

export const SCENE_PACKAGE_ID = '019fb264-1000-7000-8000-000000000100';
const SCENE_PACKAGE_NAMESPACE = (() => {
  const parsed = PackageId.parse(SCENE_PACKAGE_ID);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
})();
export function sceneAssetGuid(sourceKey: string): string {
  return AssetGuid.format(AssetGuid.derive(SCENE_PACKAGE_NAMESPACE, sourceKey));
}
export const SCENE_GUID = sceneAssetGuid('scene/main');
export const NESTED_SCENE_GUID = sceneAssetGuid('scene/nested-target');
export const PLAYER_Y = 0.75;
// Collision groups stay broad for impact classification; only solver response excludes covers from supporting the dynamic relay target.
export const YELLOW_TARGET_SOLVER_GROUPS = 0x0001_0001;
export const PROJECTILE_COVER_SOLVER_GROUPS = 0x0002_ffff;

type NestedSceneAsset = Pick<SceneAsset, 'entities'>;

type ExpandedScene = {
  readonly nodes: PackNode[];
  readonly byAddress: ReadonlyMap<string, PackNode>;
  readonly addressByNode: ReadonlyMap<PackNode, readonly string[]>;
  readonly slotCount: number;
};

function addressKey(address: readonly string[]): string {
  return JSON.stringify(address);
}

function normalizeComponents(raw: unknown): Record<string, Record<string, unknown>> {
  const components: Record<string, Record<string, unknown>> = {};
  if (typeof raw !== 'object' || raw === null) return components;
  for (const [name, fields] of Object.entries(raw)) {
    if (typeof fields === 'object' && fields !== null) {
      components[name] = { ...(fields as Record<string, unknown>) };
    }
  }
  return components;
}

/**
 * Expand authored nested SceneAsset members into the same private slot view used by
 * gameplay. The ECS mapping is already a flattened parent window; mirroring
 * that offset here keeps Name-based gameplay (physics, scoring, reset) on the
 * authored asset path instead of adding a second scene traversal in main.ts.
 *
 * The slot order is the Scene owner's derived order: own keys first, instance
 * carrier keys second, then each child instance's complete window. Numeric
 * slots never cross the SceneAsset boundary; they are only the lookup index
 * used by this gameplay adapter.
 */
async function expandNestedNodes(
  assets: NonNullable<GameContext['assets']>,
  asset: NestedSceneAsset,
  offset = 0,
  ancestors = new Set<string>(),
): Promise<ExpandedScene> {
  const keys = Object.keys(asset.entities).sort();
  const ownKeys = keys.filter((key) => asset.entities[key]?.instance === undefined);
  const instanceKeys = keys.filter((key) => asset.entities[key]?.instance !== undefined);
  const nodes: PackNode[] = [];
  const byAddress = new Map<string, PackNode>();
  const addressByNode = new Map<PackNode, readonly string[]>();

  const addNode = (node: PackNode, address: readonly string[]) => {
    nodes.push(node);
    byAddress.set(addressKey(address), node);
    addressByNode.set(node, address);
  };

  for (const [localId, key] of ownKeys.entries()) {
    addNode({ localId: offset + localId, components: normalizeComponents(asset.entities[key]?.components) }, [key]);
  }
  for (const [index, key] of instanceKeys.entries()) {
    addNode({
      localId: offset + ownKeys.length + index,
      components: normalizeComponents(asset.entities[key]?.components),
    }, [key]);
  }

  let nextMemberFirst = offset + ownKeys.length + instanceKeys.length;
  for (const key of instanceKeys) {
    const declaration = asset.entities[key]?.instance;
    if (declaration === undefined) continue;
    const sourceKey = typeof declaration.source === 'number' ? `ref:${declaration.source}` : `guid:${declaration.source.toLowerCase()}`;
    if (ancestors.has(sourceKey)) throw new Error(`Nested SceneAsset cycle detected at ${declaration.source}`);
    const handle = typeof declaration.source === 'number' ? declaration.source : (await assets.load(declaration.source, 'scene')).unwrap();
    const childAsset = assets.read(handle).unwrap();
    if (typeof declaration.source === 'string') assets.release(handle).unwrap();
    ancestors.add(sourceKey);
    const child = await expandNestedNodes(assets, childAsset, nextMemberFirst, ancestors);
    ancestors.delete(sourceKey);

    for (const [childNode, childAddress] of child.addressByNode) {
      const fullAddress = [key, ...childAddress];
      byAddress.set(addressKey(fullAddress), childNode);
      addressByNode.set(childNode, fullAddress);
    }
    for (const override of declaration.overrides ?? []) {
      const target = byAddress.get(addressKey([key, ...override.target]));
      if (target === undefined) throw new Error(`Nested SceneAsset override target is missing: ${override.target.join('.')}`);
      const current = target.components;
      for (const [component, fields] of Object.entries(normalizeComponents(override.components))) {
        current[component] = { ...(current[component] ?? {}), ...fields };
      }
    }
    nodes.push(...child.nodes);
    nextMemberFirst += child.slotCount;
  }

  // Resolve authored keyed entity references to the private slot view used by
  // gameplay helpers. The public SceneAsset remains string-addressed.
  const localByAddress = new Map<string, number>();
  for (const [key, node] of byAddress) localByAddress.set(key, node.localId);
  for (const node of nodes) {
    const childOf = node.components.ChildOf;
    if (childOf === undefined) continue;
    const parent = childOf.parent;
    const parts = typeof parent === 'string'
      ? [parent]
      : Array.isArray(parent) && parent.every((part): part is string => typeof part === 'string') ? parent : undefined;
    if (parts === undefined) continue;
    const nodeAddress = addressByNode.get(node) ?? [];
    const scope = nodeAddress.length > 1 ? nodeAddress.slice(0, -1) : [];
    const parentId = localByAddress.get(addressKey([...scope, ...parts]));
    if (parentId !== undefined) childOf.parent = parentId;
  }
  return { nodes, byAddress, addressByNode, slotCount: nextMemberFirst - offset };
}

export async function expandLoadedScene(
  assets: NonNullable<GameContext['assets']>,
  authored: SceneAsset,
  loaded: LoadedScene,
): Promise<LoadedScene> {
  const nestedNodes = (await expandNestedNodes(assets, authored)).nodes;
  return nestedNodes.length === loaded.nodes.length && loaded.nodes.every((node, i) => node.localId === nestedNodes[i]?.localId)
    ? loaded
    : { ...loaded, nodes: nestedNodes };
}

export async function loadScene(ctx: GameContext): Promise<LoadedScene | null> {
  if (!ctx.assets) return null;
  const assets = ctx.assets;
  const parsed = AssetGuid.parse(SCENE_GUID);
  if (!parsed.ok) {
    console.warn(`[game] authored scene GUID is invalid: ${parsed.error.code} — ${parsed.error.hint}`);
    return null;
  }
  const loaded = await assets.load(parsed.value, 'scene');
  if (!loaded.ok) {
    console.warn(`[game] authored scene load failed: ${loaded.error.code} — ${loaded.error.hint}`, loaded.error.detail);
    return null;
  }
  const handle = loaded.value;
  const authored = assets.read(handle).unwrap();
  const instance = assets.instantiate(handle, ctx.world);
  assets.release(handle).unwrap();
  if (!instance.ok) {
    console.warn(`[game] authored scene instantiate failed: ${instance.error.code} — ${instance.error.hint}`);
    return null;
  }
  const scene = ctx.world.get(instance.value, SceneInstance);
  if (!scene.ok) return null;
  const nodes = (await expandNestedNodes(ctx.assets, authored)).nodes;
  const mapping = new Map<number, EntityHandle>();
  const mappingArray = scene.value.mapping as unknown as { [index: number]: number };
  for (const node of nodes) {
    const entity = mappingArray[node.localId];
    if (entity !== undefined && entity !== 0xffffffff && entity !== 0) {
      mapping.set(node.localId, entity as EntityHandle);
    }
  }
  return { mapping, nodes };
}

export function loadedFromScene(world: World, ctx: SceneBinding): LoadedScene | null {
  const root = ctx.root;
  if (root === undefined || ctx.asset === undefined) return null;
  const scene = world.get(root, SceneInstance);
  if (!scene.ok) return null;
  const mapping = new Map<number, EntityHandle>();
  const mappingArray = scene.value.mapping as unknown as { length: number; [index: number]: number };
  for (let localId = 0; localId < mappingArray.length; localId++) {
    const entity = mappingArray[localId];
    if (entity !== undefined && entity !== 0xffffffff && entity !== 0) {
      mapping.set(localId, entity as EntityHandle);
    }
  }
  const keys = Object.keys(ctx.asset.entities).sort();
  const ownKeys = keys.filter((key) => ctx.asset?.entities[key]?.instance === undefined);
  const instanceKeys = keys.filter((key) => ctx.asset?.entities[key]?.instance !== undefined);
  const nodes = [...ownKeys, ...instanceKeys].map((key, localId) => ({
    localId,
    components: normalizeComponents(ctx.asset?.entities[key]?.components),
  }));
  return { mapping, nodes };
}

export function spawnFallbackScene(ctx: GameContext & { assets: AssetRegistry }): void {
  const cubeMesh = ctx.assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  const material = ctx.assets.create(Materials.standard({
    baseColor: [0.48, 0.62, 0.35, 1], roughness: 0.95, metallic: 0,
  })).unwrap();
  ctx.world.spawn(
    { component: Transform, data: { pos: [0, -0.1, 0], scale: [24, 0.2, 24] } },
    { component: MeshFilter, data: { assetHandle: cubeMesh } },
    { component: MeshRenderer, data: { materials: [material] } },
  ).unwrap();
  ctx.assets.release(cubeMesh).unwrap();
  ctx.assets.release(material).unwrap();
}

export function spawnGroundCollider(ctx: GameContext): void {
  ctx.world.spawn(
    { component: Transform, data: { pos: [0, -5, 0] } },
    { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
    { component: Collider, data: { shape: ColliderShapeValue.cuboid, halfExtents: [60, 5, 60], friction: 0.9, restitution: 0 } },
  );
}

export function setupPlayerRoot(ctx: GameContext, entity: EntityHandle): void {
  ctx.world.addComponent(entity, { component: RigidBody, data: { type: RigidBodyTypeValue.kinematic } });
  ctx.world.addComponent(entity, { component: Collider, data: { shape: ColliderShapeValue.capsule, radius: 0.3, halfHeight: 0.4 } });
  ctx.world.addComponent(entity, { component: CharacterController, data: {} });
  ctx.world.addComponent(entity, { component: CollidingEntities, data: { entities: [] } });
  ctx.world.addComponent(entity, { component: PlayerHealth, data: {} });
}

export function attachScenePhysics(ctx: GameContext, loaded: LoadedScene): ScenePhysics {
  const { world } = ctx;
  const props: ScenePhysics['props'] = [];
  let animatedMaterial: ScenePhysics['animatedMaterial'];
  const materialsOf = (entity: EntityHandle): readonly MatHandle[] => {
    const renderer = world.get(entity, MeshRenderer);
    const materials = renderer.ok ? renderer.value.materials : undefined;
    return materials === undefined || materials.length === 0
      ? []
      : [...materials];
  };
  for (const node of loaded.nodes) {
    const name = (node.components.Name as { value?: string } | undefined)?.value;
    const entity = loaded.mapping.get(node.localId);
    if (entity === undefined || !name) continue;
    const authoredTransform = (node.components.Transform ?? {}) as { pos?: number[]; scale?: number[] };
    const liveTransform = world.get(entity, Transform);
    const scale = liveTransform.ok ? liveTransform.value.scale : authoredTransform.scale;
    const hx = (scale?.[0] ?? 1) * 0.5;
    const hy = (scale?.[1] ?? 1) * 0.5;
    const hz = (scale?.[2] ?? 1) * 0.5;
    const sphereRadius = scale?.[0] ?? 1;
    const box = (restitution: number) => world.addComponent(entity, { component: Collider, data: { shape: ColliderShapeValue.cuboid, halfExtents: [hx, hy, hz], restitution, friction: 0.7 } });
    const sphere = (restitution: number, isSensor = false) => world.addComponent(entity, { component: Collider, data: { shape: ColliderShapeValue.sphere, radius: sphereRadius, restitution, friction: 0.6, isSensor } });
    const dynamic = () => world.addComponent(entity, { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic, mass: 1, linearDamping: 0.05, angularDamping: 0.1, ccdEnabled: true } });
    const kinematic = () => world.addComponent(entity, { component: RigidBody, data: { type: RigidBodyTypeValue.kinematic, ccdEnabled: true } });
    const staticBody = () => world.addComponent(entity, { component: RigidBody, data: { type: RigidBodyTypeValue.static } });
    switch (name) {
      case 'Ground': break;
      case 'TreeTrunk': staticBody(); box(0.2); break;
      case 'TreeCanopy': staticBody(); sphere(0.2); break;
      case 'RedBox': dynamic(); box(0.25); props.push({ e: entity, materials: materialsOf(entity) }); world.addComponent(entity, { component: ScoringTarget, data: { points: 10, relayStep: 2 } }); break;
      case 'BlueBall': {
        dynamic();
        sphere(0.55);
        const authoredMaterials = materialsOf(entity);
        const authoredMat = authoredMaterials[0];
        const clearcoatMat = ctx.assets === undefined || authoredMat === undefined ? undefined : cloneWithClearcoat(authoredMat, ctx.assets);
        if (clearcoatMat !== undefined) {
          world.set(entity, MeshRenderer, { materials: [clearcoatMat] }).unwrap();
          ctx.assets!.release(clearcoatMat).unwrap();
        }
        props.push({ e: entity, materials: clearcoatMat === undefined ? authoredMaterials : [clearcoatMat], clearcoat: clearcoatMat !== undefined });
        world.addComponent(entity, { component: ScoringTarget, data: { points: 15, relayStep: 1 } });
        break;
      }
      case 'YellowPillar':
        kinematic();
        // The visible pillar rotates around Y, so its gameplay hit volume must not collapse edge-on with the rendered cuboid.
        world.addComponent(entity, { component: Collider, data: {
          shape: ColliderShapeValue.capsule,
          radius: 0.3,
          halfHeight: 0.45,
          restitution: 0.2,
          friction: 0.7,
          solverGroups: YELLOW_TARGET_SOLVER_GROUPS,
        } });
        world.addComponent(entity, { component: Rotatable, data: { speed: 0.3 } });
        const materials = materialsOf(entity);
        props.push({ e: entity, materials });
        if (materials[0] !== undefined) animatedMaterial = { e: entity, mat: materials[0] };
        world.addComponent(entity, { component: ScoringTarget, data: { points: 10, relayStep: 3 } });
        break;
      case 'BouncyBall':
        kinematic();
        sphere(0.92, true);
        props.push({ e: entity, materials: materialsOf(entity) });
        world.addComponent(entity, { component: ScoringTarget, data: { points: 25 } });
        world.addComponent(entity, { component: BouncyBallHazard, data: {} });
        world.addComponent(entity, { component: DamageHazard, data: {} });
        break;
      case 'NestedTarget':
        dynamic();
        box(0.25);
        props.push({ e: entity, materials: materialsOf(entity) });
        world.addComponent(entity, { component: ScoringTarget, data: { points: 20 } });
        break;
      case 'Sentinel':
        staticBody();
        box(0);
        world.addComponent(entity, { component: CollidingEntities, data: { entities: [] } });
        world.addComponent(entity, { component: ScoringTarget, data: { points: 20 } });
        world.addComponent(entity, { component: Sentinel, data: {} });
        props.push({ e: entity, materials: materialsOf(entity) });
        break;
      case 'ProjectileCoverLeft':
      case 'ProjectileCoverRight':
        staticBody();
        box(0);
        world.set(entity, Collider, { solverGroups: PROJECTILE_COVER_SOLVER_GROUPS });
        world.addComponent(entity, { component: CollidingEntities, data: { entities: [] } });
        world.addComponent(entity, { component: ProjectileCover, data: {} });
        break;
      default:
        if (name.startsWith('Crate')) { dynamic(); box(0.1); props.push({ e: entity, materials: materialsOf(entity) }); world.addComponent(entity, { component: ScoringTarget, data: { points: 5 } }); }
        break;
    }
  }
  return animatedMaterial === undefined ? { props } : { props, animatedMaterial };
}
