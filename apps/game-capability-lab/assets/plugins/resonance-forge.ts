import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { Time, Update, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { quat } from '@forgeax/engine-math';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import { SceneInstance } from '@forgeax/engine-render';
import { Transform, worldDespawnScene } from '@forgeax/engine-scene';
import type { SceneAsset } from '@forgeax/engine-types';
import {
  createResonanceFormation,
  RESONANCE_ROLE_COUNTS,
  resonancePose,
  type ResonanceNode,
  type ResonancePose,
  type ResonanceRole,
} from '../procedural/resonance-blueprint';

const PACKAGE_ID = '019fb264-1000-7000-8000-000000000000';
const PACKAGE_NAMESPACE = (() => {
  const parsed = PackageId.parse(PACKAGE_ID);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
})();

function assetGuid(sourceKey: string): string {
  return AssetGuid.format(AssetGuid.derive(PACKAGE_NAMESPACE, sourceKey));
}

export type { ResonanceNode, ResonancePose, ResonanceRole };

export interface ResonanceForgeSnapshot {
  readonly status: 'ready' | 'unavailable' | 'failed';
  readonly packageId: string;
  readonly outputCount: number;
  readonly meshCount: number;
  readonly materialCount: number;
  readonly sceneCount: number;
  readonly nodeCount: number;
  readonly roles: Readonly<Record<ResonanceRole, number>>;
  readonly elapsed: number;
  readonly errorCode: string | null;
}

export interface ResonanceForge {
  readonly snapshot: () => ResonanceForgeSnapshot;
  dispose(): void;
}

function parsedGuid(value: string) {
  const parsed = AssetGuid.parse(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

async function loadOutput<T>(assets: AssetRegistry, value: string): Promise<T> {
  const loaded = await assets.loadByGuid<T>(parsedGuid(value));
  if (!loaded.ok) throw loaded.error;
  return loaded.value;
}

/** Materialize one animated formation from the cooked outputs of resonance-forge.pack.ts. */
export async function createResonanceForge(
  world: World,
  assets: AssetRegistry | undefined,
): Promise<ResonanceForge> {
  let status: ResonanceForgeSnapshot['status'] = assets === undefined ? 'unavailable' : 'failed';
  let errorCode: string | null = assets === undefined ? 'asset-registry-unavailable' : null;
  let elapsed = 0;
  const entities: EntityHandle[] = [];
  let sceneRoot: EntityHandle | undefined;
  const nodes = createResonanceFormation();
  const snapshot = (): ResonanceForgeSnapshot => ({
    status,
    packageId: PACKAGE_ID,
    outputCount: 16,
    meshCount: 5,
    materialCount: 4,
    sceneCount: 1,
    nodeCount: entities.length,
    roles: RESONANCE_ROLE_COUNTS,
    elapsed,
    errorCode,
  });
  if (assets === undefined) return { snapshot, dispose() {} };

  try {
    const scene = await loadOutput<SceneAsset>(assets, assetGuid('scene/formation'));
    const sceneHandle = world.allocSharedRef('SceneAsset', scene);
    const instantiated = assets.instantiate(sceneHandle, world);
    if (!instantiated.ok) throw instantiated.error;
    sceneRoot = instantiated.value;
    const instance = world.get(sceneRoot, SceneInstance);
    if (!instance.ok) throw instance.error;
    const mapping = instance.value.mapping as unknown as { readonly [index: number]: number };
    const rotation = quat.create();
    for (let localId = 0; localId < nodes.length; localId++) {
      const entity = mapping[localId];
      if (entity === undefined || entity === 0xffffffff) {
        throw new Error(`Resonance SceneAsset localId ${localId} was not instantiated`);
      }
      entities.push(entity as EntityHandle);
    }
    world.addSystem(Update, {
      name: 'resonance-forge-animation',
      queries: [] as const,
      fn: () => {
        elapsed = world.getResource(Time).elapsed;
        for (let index = 0; index < entities.length; index++) {
          const entity = entities[index];
          const node = nodes[index];
          if (entity === undefined || node === undefined) continue;
          const pose = resonancePose(node, elapsed, rotation);
          world.set(entity, Transform, { pos: pose.position, quat: rotation, scale: pose.scale });
        }
      },
    }).unwrap();
    status = 'ready';
  } catch (error) {
    errorCode = typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : 'resonance-forge-initialization-failed';
  }

  return {
    snapshot,
    dispose() {
      if (status === 'ready') world.removeSystem(Update, 'resonance-forge-animation');
      if (sceneRoot !== undefined) worldDespawnScene(world, sceneRoot);
      entities.length = 0;
    },
  };
}
