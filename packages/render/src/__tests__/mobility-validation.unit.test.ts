import { type EntityHandle, World } from '@forgeax/engine-ecs';
import {
  ChildOf,
  Mobility,
  type MobilityDiagnostic,
  MobilityKindValue,
  sceneEntity,
  subscribeMobilityDiagnostics,
  Transform,
  worldInstantiateScene,
} from '@forgeax/engine-scene';
import type { SceneAsset } from '@forgeax/engine-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MeshFilter } from '../components/mesh-filter';
import { SceneInstance } from '../components/scene-instance';
import { detectMobilityInvalidKind } from '../scene/mobility-validation';

function meshWorld(): World {
  const world = new World();
  for (const component of [Mobility, MeshFilter, Transform, ChildOf, SceneInstance]) {
    world.components.register(component).unwrap();
  }
  return world;
}

function mesh(world: World) {
  return {
    component: MeshFilter,
    data: { assetHandle: world.allocSharedRef('MeshAsset', {} as never) },
  };
}

describe('mobility-invalid-kind (render mesh owner)', () => {
  let received: MobilityDiagnostic[];
  let unsubscribe: () => void;

  beforeEach(() => {
    received = [];
    unsubscribe = subscribeMobilityDiagnostics((_world, diagnostic) => received.push(diagnostic));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    unsubscribe();
    vi.restoreAllMocks();
  });

  it('reports a stationary mesh entity once', () => {
    const world = meshWorld();
    const entity = world
      .spawn(mesh(world), { component: Mobility, data: { kind: MobilityKindValue.stationary } })
      .unwrap();
    detectMobilityInvalidKind(world);
    world.set(entity, Mobility, { kind: MobilityKindValue.stationary }).unwrap();
    detectMobilityInvalidKind(world);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      code: 'mobility-invalid-kind',
      expected: expect.stringContaining("'stationary'"),
      hint: expect.stringContaining('MobilityKindValue.static'),
      detail: { entity },
    });
  });

  it('accepts static and movable meshes and stationary non-mesh entities', () => {
    const world = meshWorld();
    world.spawn(mesh(world), { component: Mobility, data: { kind: MobilityKindValue.static } });
    world.spawn(mesh(world), { component: Mobility, data: {} });
    world.spawn({ component: Mobility, data: { kind: MobilityKindValue.stationary } });
    detectMobilityInvalidKind(world);
    expect(received).toEqual([]);
  });

  it('reports when the kind or the mesh arrives later', () => {
    const world = meshWorld();
    const light = world
      .spawn({ component: Mobility, data: { kind: MobilityKindValue.stationary } })
      .unwrap();
    const retuned = world
      .spawn(mesh(world), { component: Mobility, data: { kind: MobilityKindValue.static } })
      .unwrap();
    detectMobilityInvalidKind(world);
    expect(received).toEqual([]);
    world.addComponent(light, mesh(world)).unwrap();
    world.set(retuned, Mobility, { kind: MobilityKindValue.stationary }).unwrap();
    detectMobilityInvalidKind(world);
    expect(received.map((d) => d.detail.entity).sort()).toEqual([light, retuned].sort());
  });

  it('locates an authored scene member through its SceneEntityRef', () => {
    const world = meshWorld();
    const asset: SceneAsset = {
      kind: 'scene',
      entities: {
        lamp: { components: { Transform: {}, Mobility: { kind: MobilityKindValue.stationary } } },
      },
    };
    const handle = world.allocSharedRef('SceneAsset', asset);
    const root = worldInstantiateScene(world, handle, undefined, 'level/main').unwrap().root;
    const lamp = world.get(root, SceneInstance).unwrap().mapping[0] as unknown as EntityHandle;
    world.addComponent(lamp, mesh(world)).unwrap();
    detectMobilityInvalidKind(world);
    expect(received).toHaveLength(1);
    expect(received[0]?.detail).toEqual({
      entity: lamp,
      sceneEntityRef: sceneEntity('level/main', 'lamp'),
    });
  });
});
