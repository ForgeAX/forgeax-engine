import { createHash } from 'node:crypto';
import {
  AssetRegistry,
  createCatalogSource,
  HANDLE_CUBE,
  HANDLE_QUAD,
  RuntimeMaterialValue,
  RuntimeMeshVertices,
  resolveAssetHandle,
} from '@forgeax/engine-assets-runtime';
import { FixedTime, FixedUpdate, Time, Update, World } from '@forgeax/engine-ecs';
import {
  buildMeshCardLayout,
  buildVisibilityDistanceField,
  createBoxGeometry,
  encodeMeshDistanceField,
  MESH_VISIBILITY_DISTANCE_FIELD_CODEC,
} from '@forgeax/engine-geometry';
import {
  ChildOf,
  GlobalTransform,
  readPresentationWorldMatrix,
  Transform,
  TransformInterpolation,
} from '@forgeax/engine-scene';
import { DEFAULT_SPRITE_PARAM_SCHEMA, ShaderRegistry } from '@forgeax/engine-shader';
import { Skin } from '@forgeax/engine-skinning';
import { type MaterialAsset, type MeshAsset, ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import {
  Camera,
  CameraView,
  DirectionalLight,
  Instances,
  MeshFilter,
  MeshRenderer,
  PointLight,
  Points,
  PostProcessParams,
  Skylight,
  SpriteRegionOverride,
  Visibility,
  VisibilityStateValue,
} from '../../components';
import type { RenderFeature } from '../../features/types';
import { Materials } from '../../materials';
import { PersistentRenderScene } from '../../scene/render-scene';
import { subsurfaceDemand } from '../../subsurface/demand';
import { renderPublicationTransfers } from '../contract';
import { publicationDispatchGroups } from '../dispatch-groups';
import { createRenderPublisher } from '../publisher';
import { RenderPublicationReceiver } from '../receiver';

function fixture(maxInFlight?: 2 | 3, features: readonly RenderFeature<unknown>[] = []) {
  const world = new World();
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const identity = { source: 'publication-test', epoch: 1 };
  const publisher = createRenderPublisher(
    world,
    assets,
    identity,
    undefined,
    features,
    undefined,
    undefined,
    maxInFlight,
  );
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 5] } },
      { component: Camera, data: { fov: Math.PI / 3 } },
    )
    .unwrap();
  const spawn = () =>
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: {} },
      )
      .unwrap();
  const first = spawn(),
    second = spawn();
  world.update(0).unwrap();
  const receiver = new RenderPublicationReceiver(identity),
    scene = new PersistentRenderScene();
  const publish = () => {
    const candidate = publisher.prepare(world.getResource(Time).elapsed).unwrap();
    const packet = structuredClone(candidate.packet, {
      transfer: renderPublicationTransfers(candidate.packet),
    });
    candidate.accept();
    const saved = structuredClone(packet);
    const accepted = receiver.accept(packet).unwrap();
    const frame = scene.consumePublication(accepted);
    const returned = structuredClone(renderPublicationTransfers(packet), {
      transfer: renderPublicationTransfers(packet),
    });
    publisher.recycle(packet.revision, returned).unwrap();
    // Preserve logical rows independently from the returned transport storage.
    return { packet: saved, frame, resources: accepted.resources };
  };
  return { world, assets, publisher, receiver, scene, first, second, spawn, publish };
}

describe('native render publication', () => {
  it('transfers affine transforms and ordinary lens offsets without retaining author storage', () => {
    const f = fixture();
    try {
      const camera = [...f.world.query({ read: [Camera] }).unwrap()][0]?.entity;
      if (camera === undefined) throw new Error('missing camera');
      f.world.set(camera, Camera, { projectionOffset: [0.25, -0.5] }).unwrap();
      f.world.set(f.first, Transform, { shear: [0.5, 0.25, -0.2] }).unwrap();
      f.world.update(0).unwrap();
      const first = f.publish().frame;
      expect(first.cameras[0]?.projectionOffset).toEqual([0.25, -0.5]);
      const mesh = first.renderables.find((row) => row.entityKey === f.first);
      expect(mesh?.transform.world[4]).toBeCloseTo(0.5);
      expect(mesh?.transform.world[8]).toBeCloseTo(0.25);
      expect(mesh?.transform.world[9]).toBeCloseTo(-0.2);
      f.world.set(camera, Camera, { projectionOffset: [-0.25, 0.5] }).unwrap();
      f.world.set(f.first, Transform, { shear: [0, 0, 0] }).unwrap();
      f.world.update(0).unwrap();
      const changed = f.publish().frame;
      expect(changed.cameras[0]?.projectionOffset).toEqual([-0.25, 0.5]);
      expect(changed.renderables.find((row) => row.entityKey === f.first)?.transform.world[4]).toBe(
        0,
      );
      expect(first.cameras[0]?.projectionOffset).toEqual([0.25, -0.5]);
    } finally {
      f.publisher.dispose();
      f.receiver.dispose();
      f.scene.dispose();
    }
  });

  it.each([NaN, Infinity, -Infinity])('rejects non-finite transforms atomically: %s', (value) => {
    const f = fixture();
    try {
      const candidate = f.publisher.prepare(0).unwrap();
      const packet = structuredClone(candidate.packet);
      candidate.accept();
      const original = packet.transforms[packet.transforms.length - 1] as number;
      packet.transforms[packet.transforms.length - 1] = value;
      expect(f.receiver.accept(packet)).toMatchObject({ ok: false });
      packet.transforms[packet.transforms.length - 1] = original;
      const accepted = f.receiver.accept(packet).unwrap();
      expect(f.scene.consumePublication(accepted).renderables).toHaveLength(2);
    } finally {
      f.publisher.dispose();
      f.receiver.dispose();
      f.scene.dispose();
    }
  });

  it('owns dispatch membership without freezing borrowed packet rows or nested material values', () => {
    const f = fixture();
    const candidate = f.publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet);
    candidate.accept();
    try {
      const source = packet.templates[0]?.dispatch[0];
      expect(source).toBeDefined();
      const accepted = f.receiver.accept(packet).unwrap();
      const groups = publicationDispatchGroups(accepted.frame);
      expect(groups).toBeDefined();
      expect(Object.isFrozen(accepted.frame.dispatch)).toBe(true);
      expect(accepted.frame.dispatch.every(Object.isFrozen)).toBe(true);
      expect(Object.isFrozen(source)).toBe(false);
      for (const [index, row] of accepted.frame.renderables.entries()) {
        expect(groups?.[index]).toEqual(
          accepted.frame.dispatch.filter((entry) => entry.renderableIndex === index),
        );
        expect(row.entityKey).toBeGreaterThan(0);
      }
      if (source !== undefined) Object.assign(source, { renderableIndex: 1000 });
      const first = accepted.frame.dispatch[0];
      expect(first?.renderableIndex).toBe(0);
      if (first !== undefined) {
        first.tags.observed = 'live-nested-value';
        expect(groups?.[0]?.[0]?.tags.observed).toBe('live-nested-value');
      }
      const late = f.receiver.snapshot(accepted);
      expect(publicationDispatchGroups(late.frame)).toBeDefined();
      expect(late.frame.dispatch.every(Object.isFrozen)).toBe(true);
      expect(f.scene.consumePublication(late).renderables).toHaveLength(2);
    } finally {
      f.publisher.dispose();
      f.receiver.dispose();
      f.scene.dispose();
    }
  });

  it('observes replacement borrowed dispatch and accessors instead of retaining accepted membership', () => {
    const f = fixture();
    const candidate = f.publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet);
    candidate.accept();
    try {
      const accepted = f.receiver.accept(packet).unwrap();
      let reads = 0;
      const dispatch = accepted.frame.dispatch.map((entry) => ({
        ...entry,
        get renderableIndex() {
          reads++;
          return entry.renderableIndex;
        },
      }));
      const borrowed = { ...accepted, frame: { ...accepted.frame, dispatch } };
      expect(publicationDispatchGroups(borrowed.frame)).toBeUndefined();
      const frame = f.scene.consumePublication(borrowed);
      expect(reads).toBeGreaterThan(0);
      expect(Object.isFrozen(dispatch)).toBe(false);
      expect(dispatch.every((entry) => !Object.isFrozen(entry))).toBe(true);
      expect(frame.dispatch.map((entry) => entry.materialHandle)).toEqual(
        accepted.frame.dispatch.map((entry) => entry.materialHandle),
      );
    } finally {
      f.publisher.dispose();
      f.receiver.dispose();
      f.scene.dispose();
    }
  });

  it.each([
    2, 3,
  ])('keeps custom packet getters isolated from a late failure (%s stable reads)', (stableReads) => {
    const f = fixture();
    const initial = f.publish();
    const candidate = f.publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet);
    candidate.accept();
    const guid = 'c8888888-8888-4888-8888-888888888888';
    const material = Materials.unlit([0, 1, 0, 1]);
    const handle = f.world.allocSharedRef('MaterialAsset', material);
    let reads = 0;
    const changing = {
      ...packet,
      get assets() {
        return ++reads <= stableReads ? [] : [{ handle, guid, value: material }];
      },
    };
    const failing = new Proxy(f.assets, {
      get(target, key) {
        if (key === 'shaderRegistry') throw new Error('admission interrupted');
        return Reflect.get(target, key, target);
      },
    });
    try {
      expect(() => f.receiver.accept(changing, failing)).toThrow('admission interrupted');
      expect(f.receiver.acceptedRevision).toBe(packet.base);
      expect(initial.resources.handleForGuid?.(guid)).toBeUndefined();
    } finally {
      f.publisher.dispose();
      f.receiver.dispose();
      f.scene.dispose();
    }
  });
  it('walks the GUID namespace once when a packet retires several assets', () => {
    const f = fixture();
    f.publish();
    const candidate = f.publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet);
    candidate.accept();
    const rows = Array.from({ length: 8 }, (_, index) => {
      const value = Materials.unlit([1, 0, 0, 1]);
      return {
        guid: `c9999999-9999-4999-8999-${String(index).padStart(12, '0')}`,
        handle: f.world.allocSharedRef('MaterialAsset', value),
        value,
      };
    });
    const handles = new Set(rows.map((row) => row.handle));
    const iterator = Map.prototype[Symbol.iterator];
    let visits = 0;
    try {
      f.receiver.accept({ ...packet, assets: rows }).unwrap();
      const retire = rows.slice(0, 3).map((row) => row.handle);
      vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(function* (
        this: Map<unknown, unknown>,
      ) {
        for (const row of iterator.call(this)) {
          if (typeof row[0] === 'string' && row[0].startsWith('c9999999-') && handles.has(row[1]))
            visits++;
          yield row;
        }
        return undefined;
      });
      const accepted = f.receiver
        .accept({
          ...packet,
          base: packet.revision,
          revision: packet.revision + 1,
          retiredAssets: retire,
        })
        .unwrap();
      expect(visits).toBe(16); // Eight membership visits and eight entries copied on the first write.
      for (const row of rows) {
        expect(accepted.resources.handleForGuid?.(row.guid)).toBe(
          retire.includes(row.handle) ? undefined : row.handle,
        );
      }
    } finally {
      vi.restoreAllMocks();
      f.publisher.dispose();
      f.receiver.dispose();
      f.scene.dispose();
    }
  });
  it('keeps a failed GUID admission retryable and retires the committed namespace', () => {
    const f = fixture();
    const initial = f.publish();
    const candidate = f.publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet);
    candidate.accept();
    const guid = 'c7777777-7777-4777-8777-777777777777';
    const material = Materials.unlit([0, 1, 0, 1]);
    const handle = f.world.allocSharedRef('MaterialAsset', material);
    const changed = { ...packet, assets: [{ handle, guid, value: material }] };
    const failing = new Proxy(f.assets, {
      get(target, key) {
        if (key === 'shaderRegistry') throw new Error('admission interrupted');
        return Reflect.get(target, key, target);
      },
    });
    try {
      expect(() => f.receiver.accept(changed, failing)).toThrow('admission interrupted');
      expect(f.receiver.acceptedRevision).toBe(packet.base);
      expect(initial.resources.handleForGuid?.(guid)).toBeUndefined();
      const admitted = f.receiver.accept(changed, f.assets).unwrap();
      expect(admitted.resources.handleForGuid?.(guid)).toBe(handle);
      const retired = f.receiver
        .accept({
          ...packet,
          base: packet.revision,
          revision: packet.revision + 1,
          retiredAssets: [handle],
        })
        .unwrap();
      expect(retired.resources.handleForGuid?.(guid)).toBeUndefined();
      expect(retired.resources.resolveAsset(handle).ok).toBe(false);
    } finally {
      f.publisher.dispose();
      f.receiver.dispose();
      f.scene.dispose();
    }
  });
  it('preserves the captured GUID namespace across reentrant shader admission', () => {
    const f = fixture();
    f.publish();
    const candidate = f.publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet);
    candidate.accept();
    const guid = 'c6666666-6666-4666-8666-666666666666';
    const material = Materials.unlit([0, 1, 0, 1]);
    const handle = f.world.allocSharedRef('MaterialAsset', material);
    let entered = false;
    const assets = new Proxy(f.assets, {
      get(target, key) {
        if (key === 'shaderRegistry' && !entered) {
          entered = true;
          f.receiver.accept({ ...packet, assets: [{ handle, guid, value: material }] }).unwrap();
          expect(
            f.receiver
              .snapshot(
                f.receiver
                  .accept({
                    ...packet,
                    base: packet.revision,
                    revision: packet.revision + 1,
                  })
                  .unwrap(),
              )
              .resources.handleForGuid?.(guid),
          ).toBe(handle);
        }
        return Reflect.get(target, key, target);
      },
    });
    try {
      const accepted = f.receiver.accept(packet, assets).unwrap();
      expect(entered).toBe(true);
      expect(accepted.resources.handleForGuid?.(guid)).toBeUndefined();
    } finally {
      f.publisher.dispose();
      f.receiver.dispose();
      f.scene.dispose();
    }
  });
  it('does not recopy the accepted GUID namespace for transform-only packets', () => {
    const f = fixture();
    const guid = 'c5555555-5555-4555-8555-555555555555';
    const material = f.assets.catalog(guid, Materials.unlit([1, 0, 0, 1])).unwrap();
    const handle = f.world.allocSharedRef('MaterialAsset', material);
    f.world.set(f.first, MeshRenderer, { materials: [handle] }).unwrap();
    f.publish();
    const candidate = f.publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet);
    candidate.accept();
    expect(packet.assets).toHaveLength(0);
    expect(packet.retiredAssets).toHaveLength(0);
    const NativeMap = Map;
    let copiedMaps = 0;
    const observedMap = new Proxy(NativeMap, {
      construct(target, args, newTarget) {
        if (args[0] instanceof NativeMap) copiedMaps++;
        return Reflect.construct(target, args, newTarget);
      },
    });
    try {
      vi.stubGlobal('Map', observedMap);
      for (let step = 0; step < 8; step++) {
        const accepted = f.receiver
          .accept({
            ...packet,
            base: packet.base + step,
            revision: packet.revision + step,
          })
          .unwrap();
        expect(accepted.resources.handleForGuid?.(guid)).toBe(handle);
      }
      expect(copiedMaps).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      f.publisher.dispose();
      f.receiver.dispose();
      f.scene.dispose();
    }
  });
  it('retains unchanged slot dispatch after a removal rebases the materialized rows', () => {
    const f = fixture();
    f.spawn();
    const last = f.spawn();
    const original = f.publish().frame;
    const originalIndex = original.renderables.findIndex((row) => row.entityKey === last);
    const originalDraws = original.dispatch.filter((row) => row.renderableIndex === originalIndex);
    expect(originalDraws.length).toBeGreaterThan(0);
    f.world.despawn(f.first).unwrap();
    const reordered = f.publish().frame;
    const index = reordered.renderables.findIndex((row) => row.entityKey === last);
    expect(index).not.toBe(originalIndex);
    const draws = reordered.dispatch.filter((row) => row.renderableIndex === index);
    expect(draws.length).toBe(originalDraws.length);
    for (let step = 0; step < 8; step++) {
      f.world
        .set(f.second, MeshFilter, { assetHandle: step % 2 ? HANDLE_CUBE : HANDLE_QUAD })
        .unwrap();
      f.world.update(0).unwrap();
      const next = f.publish();
      expect(Array.from(next.packet.upserts).filter((_, i) => i % 2 === 0)).toEqual([f.second]);
      expect(next.frame.renderables.findIndex((row) => row.entityKey === last)).toBe(index);
      const current = next.frame.dispatch.filter((row) => row.renderableIndex === index);
      expect(current.length).toBe(draws.length);
      for (let i = 0; i < draws.length; i++) expect(current[i]).toBe(draws[i]);
      expect(originalDraws.every((row) => row.renderableIndex === originalIndex)).toBe(true);
    }
    f.publisher.dispose();
    f.receiver.dispose();
    f.scene.dispose();
  });
  it('publishes only the new member when an occupied source block grows or shrinks', () => {
    const f = fixture();
    for (let i = 2; i < 511; i++) f.spawn();
    f.publish();
    const appended = f.spawn();
    const added = f.publish();
    expect(Array.from(added.packet.upserts).filter((_, index) => index % 2 === 0)).toEqual([
      appended,
    ]);
    expect(added.frame.renderables).toHaveLength(512);
    f.world.despawn(appended).unwrap();
    const removed = f.publish();
    expect(removed.packet.upserts).toHaveLength(0);
    expect(Array.from(removed.packet.removed)).toEqual([appended]);
    expect(removed.frame.renderables).toHaveLength(511);
    f.publisher.dispose();
  });

  it('retains descendant visibility when parent components are removed across table migrations', () => {
    const f = fixture();
    const parent = f.world
      .spawn(
        { component: Transform, data: {} },
        { component: Visibility, data: { state: VisibilityStateValue.hidden } },
      )
      .unwrap();
    f.world.addComponent(f.first, { component: ChildOf, data: { parent } }).unwrap();
    f.world.addComponent(f.second, { component: ChildOf, data: { parent: f.first } }).unwrap();
    f.world.update(0).unwrap();
    expect(f.publish().frame.renderables).toHaveLength(0);

    f.world.removeComponent(parent, Visibility).unwrap();
    f.world.update(0).unwrap();
    expect(f.publish().frame.renderables).toHaveLength(2);
    f.world
      .addComponent(parent, {
        component: Visibility,
        data: { state: VisibilityStateValue.hidden },
      })
      .unwrap();
    f.world.update(0).unwrap();
    expect(f.publish().frame.renderables).toHaveLength(0);

    f.world.removeComponent(f.first, ChildOf).unwrap();
    f.world.update(0).unwrap();
    expect(f.publish().frame.renderables).toHaveLength(2);
    f.publisher.dispose();
  });

  it('publishes zero-demand Standard material edits through the retained receiver scene', async () => {
    const f = fixture();
    const guid = 'c4444444-4444-4444-8444-444444444444';
    f.assets.setCatalogSource(
      createCatalogSource({
        entries: [
          {
            guid,
            kind: 'material',
            packageUrl: '/surface.fpack',
            sourcePath: 'surface.pack.ts',
            sourceKey: 'surface',
          },
        ],
      }),
    );
    (await f.assets.enumerateCatalog()).unwrap();
    const material = f.assets
      .catalog(
        guid,
        Materials.standard({
          baseColor: [1, 0.4, 0.2, 1],
          subsurfaceRadius: [9, 6, 3],
          subsurfaceWeight: 1,
        }),
      )
      .unwrap();
    const handle = f.world.allocSharedRef('MaterialAsset', material);
    f.world.set(f.first, MeshRenderer, { materials: [handle] }).unwrap();
    const radius = f.world
      .spawn({
        component: RuntimeMaterialValue,
        data: { asset: handle, parameter: 'subsurfaceRadius', kind: 2, value: [9, 6, 3] },
      })
      .unwrap();
    f.world
      .spawn({
        component: RuntimeMaterialValue,
        data: { asset: handle, parameter: 'subsurfaceWeight', kind: 0, value: [1] },
      })
      .unwrap();
    f.world.update(0).unwrap();
    const snapshots = vi.spyOn(f.assets, 'listCatalog');
    const active = f.publish();
    expect(active.resources.sourceForAsset(handle)).toEqual({ guid, sourceKey: 'surface' });
    expect(snapshots).not.toHaveBeenCalled();
    const activeMaterial = active.frame.renderables.find((row) => row.entityKey === f.first)
      ?.materials[0];
    expect(activeMaterial?.paramSnapshot?.subsurfaceRadius).toEqual([9, 6, 3]);
    expect(subsurfaceDemand(activeMaterial === undefined ? [] : [activeMaterial])).toBe(true);

    f.world.set(radius, RuntimeMaterialValue, { value: [0, 0, 0] }).unwrap();
    f.world.update(0).unwrap();
    const disabled = f.publish();
    expect(disabled.resources.sourceForAsset(handle)).toEqual({ guid, sourceKey: 'surface' });
    expect(snapshots).not.toHaveBeenCalled();
    const disabledMaterial = disabled.frame.renderables.find((row) => row.entityKey === f.first)
      ?.materials[0];
    expect(disabled.packet.invalidatedAssets).toContain(handle);
    expect(disabledMaterial?.paramSnapshot?.subsurfaceRadius).toEqual([0, 0, 0]);
    expect(subsurfaceDemand(disabledMaterial === undefined ? [] : [disabledMaterial])).toBe(false);
    expect(
      f.scene.shadowCasterProjection()?.renderables.find((row) => row.entityKey === f.first)
        ?.materials[0]?.paramSnapshot?.subsurfaceRadius,
    ).toEqual([0, 0, 0]);
    f.publisher.dispose();
    f.scene.dispose();
  });

  it('keeps material values through changed visit order, retirement and reappearance', () => {
    const f = fixture();
    const material = (color: [number, number, number, number]): MaterialAsset => ({
      kind: 'material',
      passes: [{ name: 'Forward', program: { module: 'forgeax::default-standard-pbr' } }],
      values: { baseColor: color },
    });
    const red = f.world.allocSharedRef('MaterialAsset', material([1, 0, 0, 1]));
    const blue = f.world.allocSharedRef('MaterialAsset', material([0, 0, 1, 1]));
    f.world.set(f.first, MeshRenderer, { materials: [red] }).unwrap();
    f.world.set(f.second, MeshRenderer, { materials: [blue] }).unwrap();
    const initial = f.publish();
    const order = (packet: typeof initial.packet) =>
      packet.templates.map((template) => template.snapshot.material.materialHandle);
    expect(order(initial.packet)).toEqual([red, blue]);

    f.world.set(f.first, MeshRenderer, { materials: [blue] }).unwrap();
    f.world.set(f.second, MeshRenderer, { materials: [red] }).unwrap();
    f.world.update(0).unwrap();
    const reordered = f.publish();
    expect(order(reordered.packet)).toEqual([blue, red]);
    expect(
      reordered.frame.renderables.find((row) => row.entityKey === f.first)?.material.baseColor[2],
    ).toBe(1);
    expect(
      reordered.frame.renderables.find((row) => row.entityKey === f.second)?.material.baseColor[0],
    ).toBe(1);

    f.world.despawn(f.second).unwrap();
    expect(f.publish().packet.retiredAssets).toContain(red);
    const replacement = f.spawn();
    f.world.set(replacement, MeshRenderer, { materials: [red] }).unwrap();
    f.world.update(0).unwrap();
    const restored = f.publish();
    expect(
      restored.frame.renderables.find((row) => row.entityKey === replacement)?.material
        .baseColor[0],
    ).toBe(1);
    expect(
      restored.frame.renderables.find((row) => row.entityKey === f.first)?.material.baseColor[2],
    ).toBe(1);
    expect(order(initial.packet)).toEqual([red, blue]);
    f.publisher.dispose();
  });

  it.each([
    'fallback',
    'shared',
    'independent',
  ] as const)('serializes each material once while preserving value deduplication (%s)', (kind) => {
    const f = fixture();
    if (kind !== 'fallback') {
      const sprite = kind === 'independent';
      if (sprite)
        f.assets.shaderRegistry.installMaterialArtifact('forgeax::sprite', {
          source: 'fn main() {}',
          paramSchema: DEFAULT_SPRITE_PARAM_SCHEMA,
        });
      const material: MaterialAsset = {
        kind: 'material',
        passes: [
          {
            name: 'Forward',
            program: { module: sprite ? 'forgeax::sprite' : 'forgeax::default-standard-pbr' },
          },
        ],
        values: { baseColor: [1, 0, 0, 1] },
      };
      const handle = f.world.allocSharedRef('MaterialAsset', material);
      for (const entity of [f.first, f.second]) {
        f.world.set(entity, MeshRenderer, { materials: [handle] }).unwrap();
        if (sprite) {
          f.world.set(entity, MeshFilter, { assetHandle: HANDLE_QUAD }).unwrap();
          f.world
            .addComponent(entity, {
              component: SpriteRegionOverride,
              data: { region: new Float32Array([0, 0, 0.5, 1]) },
            })
            .unwrap();
        }
      }
    }
    const visits = new Map<object, number>();
    const stringify = JSON.stringify;
    const observer = vi
      .spyOn(JSON, 'stringify')
      .mockImplementation((value: unknown, replacer: unknown, space?: string | number) => {
        if (typeof replacer !== 'function')
          return stringify(value, replacer as (string | number)[] | null | undefined, space);
        return stringify(
          value,
          function (key, item: unknown) {
            if (
              item !== null &&
              typeof item === 'object' &&
              'baseColor' in item &&
              'metallic' in item &&
              'roughness' in item
            )
              visits.set(item, (visits.get(item) ?? 0) + 1);
            return replacer.call(this, key, item);
          },
          space,
        );
      });
    try {
      const candidate = f.publisher.prepare(0).unwrap();
      // Equal per-sprite projections share a template despite distinct objects.
      expect(candidate.packet.templates).toHaveLength(1);
      expect([...candidate.packet.upserts]).toEqual([f.first, 0, f.second, 0]);
      expect(visits.size).toBe(kind === 'independent' ? 2 : 1);
      expect([...visits.values()]).toEqual(Array.from({ length: visits.size }, () => 1));
      candidate.discard();
    } finally {
      observer.mockRestore();
      f.publisher.dispose();
    }
  });

  it('retains distinct receiver channels, changes and high-bit light masks in transferred rows', () => {
    const f = fixture();
    f.world.set(f.first, MeshRenderer, { lightingChannels: 0x80000000 }).unwrap();
    f.world.set(f.second, MeshRenderer, { lightingChannels: 1 }).unwrap();
    const sun = f.world
      .spawn({
        component: DirectionalLight,
        data: { castShadow: true, lightingChannels: 0x80000001 },
      })
      .unwrap();
    f.world.update(0).unwrap();
    const initial = f.publish();
    expect(initial.frame.renderables.map((row) => row.lightingChannels)).toEqual([0x80000000, 1]);
    expect(initial.frame.lights.directional?.lightingChannels).toBe(0x80000001);
    f.world.set(f.first, MeshRenderer, { lightingChannels: 0 }).unwrap();
    f.world.set(sun, DirectionalLight, { lightingChannels: 0xffffffff }).unwrap();
    f.world.update(0).unwrap();
    const changed = f.publish();
    expect(
      changed.frame.renderables.find((row) => row.entityKey === f.first)?.lightingChannels,
    ).toBe(0);
    expect(
      changed.frame.renderables.find((row) => row.entityKey === f.second)?.lightingChannels,
    ).toBe(1);
    expect(changed.frame.lights.directional?.lightingChannels).toBe(0xffffffff);
    f.publisher.dispose();
  });

  it('transfers point decay edits and rejects malformed exponents before baseline adoption', () => {
    const f = fixture();
    const point = f.world.spawn({ component: PointLight, data: { decay: 1.4 } }).unwrap();
    const candidate = f.publisher.prepare(0).unwrap();
    for (const decay of [-1, null, NaN, Infinity, Number.MAX_VALUE, '2']) {
      const packet = structuredClone(candidate.packet);
      const light = packet.metadata.lights.point[0];
      if (light === undefined) throw new Error('missing point fixture');
      Reflect.set(light, 'decay', decay);
      expect(f.receiver.accept(packet)).toMatchObject({
        ok: false,
        error: { detail: { reason: 'shape' } },
      });
      expect(f.receiver.acceptedRevision).toBe(0);
    }
    const missing = structuredClone(candidate.packet);
    Reflect.set(missing.metadata.lights, 'point', [undefined]);
    expect(f.receiver.accept(missing)).toMatchObject({
      ok: false,
      error: { detail: { reason: 'shape' } },
    });
    expect(f.receiver.acceptedRevision).toBe(0);
    candidate.discard();
    expect(f.publish().frame.lights.point[0]?.decay).toBeCloseTo(1.4);
    f.world.set(point, PointLight, { decay: 0 }).unwrap();
    f.world.update(0).unwrap();
    expect(f.publish().frame.lights.point[0]?.decay).toBe(0);
    f.publisher.dispose();
  });

  it('serializes shared material parameters once across repeated entities and passes', () => {
    const f = fixture();
    const material = f.world.allocSharedRef(
      'MaterialAsset',
      Materials.standard({ baseColor: [0.2, 0.4, 0.6, 1] }),
    );
    for (const entity of [f.first, f.second])
      f.world.set(entity, MeshRenderer, { materials: [material] }).unwrap();
    const arrays = new Map<object, number>();
    const stringify = JSON.stringify;
    const observer = vi
      .spyOn(JSON, 'stringify')
      .mockImplementation((value: unknown, replacer: unknown, space?: string | number) => {
        if (typeof replacer !== 'function')
          return stringify(value, replacer as (string | number)[] | null | undefined, space);
        return stringify(
          value,
          function (key, item: unknown) {
            if (Array.isArray(item)) arrays.set(item, (arrays.get(item) ?? 0) + 1);
            return replacer.call(this, key, item);
          },
          space,
        );
      });
    try {
      const candidate = f.publisher.prepare(0).unwrap();
      const color = candidate.packet.templates[0]?.snapshot.material.paramSnapshot?.baseColor;
      expect(Array.isArray(color)).toBe(true);
      expect(arrays.get(color as object)).toBe(1);
      expect(candidate.packet.templates).toHaveLength(1);
      const packet = structuredClone(candidate.packet, {
        transfer: renderPublicationTransfers(candidate.packet),
      });
      candidate.accept();
      const frame = f.scene.consumePublication(f.receiver.accept(packet).unwrap());
      expect(frame.renderables.map((row) => row.material.paramSnapshot?.baseColor)).toEqual([
        color,
        color,
      ]);
      f.publisher.recycle(packet.revision, renderPublicationTransfers(packet)).unwrap();
    } finally {
      observer.mockRestore();
      f.publisher.dispose();
      f.scene.dispose();
    }
  });

  it('transfers entity-owned instance payloads without serializing impossible template matches', () => {
    const f = fixture();
    const transforms = new Float32Array(32);
    for (let base = 0; base < transforms.length; base += 16)
      for (let i = 0; i < 16; i += 5) transforms[base + i] = 1;
    for (const entity of [f.first, f.second])
      f.world.addComponent(entity, { component: Instances, data: { transforms } }).unwrap();
    const stringify = JSON.stringify;
    let serializedInstances = 0;
    const observer = vi
      .spyOn(JSON, 'stringify')
      .mockImplementation((value: unknown, replacer: unknown, space?: string | number) => {
        if (typeof replacer !== 'function')
          return stringify(value, replacer as (string | number)[] | null | undefined, space);
        return stringify(
          value,
          function (key, item: unknown) {
            if (key === 'transforms' && item instanceof Float32Array) serializedInstances++;
            return replacer.call(this, key, item);
          },
          space,
        );
      });
    try {
      const published = f.publish();
      expect(serializedInstances).toBe(0);
      expect(published.packet.templates).toHaveLength(2);
      expect(published.frame.renderables.map((row) => row.instances?.cacheKey)).toEqual([
        f.first,
        f.second,
      ]);
      for (const row of published.frame.renderables)
        expect(row.instances?.transforms).toEqual(transforms);
    } finally {
      observer.mockRestore();
      f.publisher.dispose();
      f.scene.dispose();
    }
  });

  it('skips template comparison when changed meshes have no other candidate', () => {
    const f = fixture();
    f.world.set(f.second, MeshFilter, { assetHandle: HANDLE_QUAD }).unwrap();
    const stringify = JSON.stringify;
    let serializedTemplates = 0;
    const observer = vi
      .spyOn(JSON, 'stringify')
      .mockImplementation((value: unknown, replacer: unknown, space?: string | number) => {
        if (
          value !== null &&
          typeof value === 'object' &&
          'snapshot' in value &&
          'dispatch' in value
        )
          serializedTemplates++;
        return stringify(value, replacer as (string | number)[] | null | undefined, space);
      });
    try {
      const published = f.publish();
      expect(serializedTemplates).toBe(0);
      expect(published.packet.templates).toHaveLength(2);
      expect(published.frame.renderables.map((row) => row.assetHandle)).toEqual([
        HANDLE_CUBE,
        HANDLE_QUAD,
      ]);
    } finally {
      observer.mockRestore();
      f.publisher.dispose();
      f.scene.dispose();
    }
  });

  it('rejects malformed light and receiver masks without consuming a baseline', () => {
    const f = fixture();
    const candidate = f.publisher.prepare(0).unwrap();
    for (const value of [-1, 0.5, 0x100000000, null]) {
      const receiverPacket = structuredClone(candidate.packet);
      const template = receiverPacket.templates[0];
      if (template === undefined) throw new Error('missing receiver template');
      Reflect.set(template.snapshot, 'lightingChannels', value);
      expect(f.receiver.accept(receiverPacket)).toMatchObject({
        ok: false,
        error: { detail: { reason: 'shape' } },
      });
      const lightPacket = structuredClone(candidate.packet);
      Reflect.set(lightPacket.metadata.lights, 'point', [{ lightingChannels: value }]);
      expect(f.receiver.accept(lightPacket)).toMatchObject({
        ok: false,
        error: { detail: { reason: 'shape' } },
      });
      expect(f.receiver.acceptedRevision).toBe(0);
    }
    const nullLight = structuredClone(candidate.packet);
    Reflect.set(nullLight.metadata.lights, 'point', [null]);
    expect(f.receiver.accept(nullLight).ok).toBe(false);
    candidate.discard();
    expect(f.publish().frame.renderables).toHaveLength(2);
    f.publisher.dispose();
  });

  it('queries detached bounds by publication identity and rejects another epoch', () => {
    const f = fixture();
    const identity = { source: 'publication-test', epoch: 1 };
    expect(f.scene.bounds(identity, f.first)).toBeUndefined();
    f.publish();
    const bounds = f.scene.bounds(identity, f.first);
    expect(bounds).toBeDefined();
    expect(f.scene.bounds({ ...identity, epoch: 2 }, f.first)).toBeUndefined();
    expect(f.scene.bounds({ source: 'other', epoch: 1 }, f.first)).toBeUndefined();
    if (bounds !== undefined) Reflect.set(bounds.min, '0', -999);
    expect(f.scene.bounds(identity, f.first)?.min[0]).not.toBe(-999);
    f.publisher.dispose();
  });

  it('publishes a numeric baseline, observes no static delta and retains the same CPU slots', () => {
    const f = fixture();
    const initial = f.publish();
    expect(initial.frame.renderables).toHaveLength(2);
    expect(initial.packet.templates).toHaveLength(1);
    const slots = f.scene.compositionSlots().map((slot) => [slot.slot, slot.generation]);
    const next = f.publish();
    expect(
      next.packet.upserts.length + next.packet.transforms.length + next.packet.removed.length,
    ).toBe(0);
    expect(next.packet.assets).toHaveLength(0);
    expect(f.scene.compositionSlots().map((slot) => [slot.slot, slot.generation])).toEqual(slots);
    f.publisher.dispose();
  });

  it('accumulates changes across a slow consumer without transferring ECS columns', () => {
    const f = fixture();
    f.publish();
    f.world.set(f.first, Transform, { pos: [1, 0, 0] }).unwrap();
    f.world.update(1 / 60).unwrap();
    f.world.set(f.second, Transform, { pos: [2, 0, 0] }).unwrap();
    f.world.update(1 / 60).unwrap();
    const next = f.publish();
    expect(next.packet.upserts).toHaveLength(0);
    expect(new Set(next.packet.transformEntities)).toEqual(new Set([f.first, f.second]));
    for (const entity of [f.first, f.second]) {
      const matrix = f.world.get(entity, GlobalTransform).unwrap().world;
      expect(matrix.byteLength).toBe(64);
      expect([
        ...(next.frame.renderables.find((row) => row.entityKey === entity)?.transform.world ?? []),
      ]).toEqual([...matrix]);
    }
    f.publisher.dispose();
  });

  it('reconciles destruction and generation reuse without reviving the old render identity', () => {
    const f = fixture();
    f.publish();
    f.world.despawn(f.first).unwrap();
    const replacement = f.spawn();
    f.world.update(0).unwrap();
    const next = f.publish();
    expect(next.packet.removed).toContain(f.first);
    expect(next.frame.renderables.map((row) => row.entityKey)).toEqual(
      expect.arrayContaining([replacement, f.second]),
    );
    expect(next.frame.renderables.some((row) => row.entityKey === f.first)).toBe(false);
    f.publisher.dispose();
  });

  it('rejects old epochs before the first baseline and wrong revisions without advancing acceptance', () => {
    const f = fixture();
    const candidate = f.publisher.prepare(0).unwrap();
    expect(f.receiver.accept({ ...candidate.packet, epoch: 0 })).toMatchObject({
      ok: false,
      error: { detail: { reason: 'identity' } },
    });
    expect(f.receiver.accept({ ...candidate.packet, base: 1 })).toMatchObject({
      ok: false,
      error: { detail: { reason: 'base' } },
    });
    expect(f.receiver.accept({ ...candidate.packet, revision: 2 })).toMatchObject({
      ok: false,
      error: { detail: { reason: 'revision' } },
    });
    expect(f.receiver.acceptedRevision).toBe(0);
    candidate.discard();
    f.publish();
    expect(f.receiver.acceptedRevision).toBe(1);
    f.publisher.dispose();
  });

  it('rejects malformed columns and missing dependencies without consuming the baseline', () => {
    const f = fixture();
    const candidate = f.publisher.prepare(0).unwrap();
    for (const packet of [
      { ...candidate.packet, transforms: new Float32Array(1) },
      { ...candidate.packet, assets: [] },
      { ...candidate.packet, upserts: new Uint32Array([f.first, 99]) },
      { ...candidate.packet, removed: new Uint32Array([f.first]) },
    ]) {
      expect(f.receiver.accept(packet).ok).toBe(false);
      expect(f.receiver.acceptedRevision).toBe(0);
    }
    candidate.discard();
    expect(f.publish().frame.renderables).toHaveLength(2);
    f.publisher.dispose();
  });

  it('retries observed transforms after a discarded synchronous publication', () => {
    const f = fixture();
    f.publish();
    f.world.set(f.first, Transform, { pos: [3, 0, 0] }).unwrap();
    f.world.update(0).unwrap();
    const discarded = f.publisher.prepare(0).unwrap();
    discarded.discard();
    const next = f.publish();
    expect(
      next.frame.renderables.find((row) => row.entityKey === f.first)?.transform.world[12],
    ).toBe(3);
    f.publisher.dispose();
  });
});

it('publishes shared material changes and their removal, and retires detached dependencies', () => {
  const f = fixture();
  const asset: MaterialAsset = {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::default-standard-pbr' },
        renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
      },
    ],
    values: { baseColor: [1, 0, 0, 1] },
  };
  const freeze = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  freeze(asset);
  const handle = f.world.allocSharedRef('MaterialAsset', asset);
  f.world.set(f.first, MeshRenderer, { materials: [handle] }).unwrap();
  f.world.set(f.second, MeshRenderer, { materials: [handle] }).unwrap();
  f.publish();
  const content = f.world
    .spawn({
      component: RuntimeMaterialValue,
      data: { asset: handle, parameter: 'baseColor', kind: 2, value: [0, 1, 0, 1] },
    })
    .unwrap();
  const changed = f.publish();
  expect(changed.packet.upserts.length).toBe(4);
  expect(changed.packet.invalidatedAssets).toContain(handle);
  expect(changed.frame.renderables.every((row) => row.material.baseColor[1] === 1)).toBe(true);
  f.world.despawn(content).unwrap();
  expect(f.publish().frame.renderables.every((row) => row.material.baseColor[0] === 1)).toBe(true);
  f.world.despawn(f.first).unwrap();
  f.world.despawn(f.second).unwrap();
  expect(f.publish().packet.retiredAssets).toContain(handle);
  f.publisher.dispose();
});

it('publishes static mesh attachments across realms and restores them after vertex content removal', async () => {
  const f = fixture();
  const geometry = createBoxGeometry(1, 1, 1).unwrap();
  const positions = geometry.attributes.position;
  if (!(positions instanceof Float32Array) || !geometry.indices)
    throw new Error('expected indexed box');
  const field = (
    await buildVisibilityDistanceField(positions, geometry.indices, {
      voxelSize: 0.5,
      triangleSidedness: new Uint8Array(geometry.indices.length / 3),
    })
  ).unwrap();
  const encoded = (await encodeMeshDistanceField(field)).unwrap();
  const artifact = {
    integrity: {
      algorithm: 'sha256' as const,
      digest: `sha256:${createHash('sha256').update(encoded).digest('hex')}`,
    },
    assetCodec: MESH_VISIBILITY_DISTANCE_FIELD_CODEC,
  };
  const original = {
    ...geometry,
    cardLayout: (
      await buildMeshCardLayout(positions, geometry.indices, { resolution: 8 })
    ).unwrap(),
    distanceField: {
      ...field,
      sectionSidedness: geometry.submeshes.map(() => 0 as const),
      artifact,
    },
  };
  const handle = f.world.allocSharedRef('MeshAsset', original);
  f.world.set(f.first, MeshFilter, { assetHandle: handle }).unwrap();
  f.world.set(f.second, MeshFilter, { assetHandle: handle }).unwrap();
  const initial = f.publish();
  const copied = resolveAssetHandle<MeshAsset>(initial.resources, handle).unwrap();
  expect(copied.distanceField).toEqual(original.distanceField);
  expect(copied.distanceField?.values.buffer).not.toBe(original.distanceField.values.buffer);
  expect(copied.distanceField?.bricks.buffer).not.toBe(original.distanceField.bricks.buffer);
  expect(copied.cardLayout).toEqual(original.cardLayout);
  expect(original.distanceField.values.byteLength).toBeGreaterThan(0);
  const vertices = new Float32Array(original.vertices);
  vertices[0] = Number(vertices[0]) + 0.25;
  const content = f.world
    .spawn({ component: RuntimeMeshVertices, data: { asset: handle, vertices } })
    .unwrap();
  const changed = f.publish();
  expect(changed.packet.invalidatedAssets).toContain(handle);
  const projected = resolveAssetHandle<MeshAsset>(changed.resources, handle).unwrap();
  expect(projected.vertices[0]).toBe(vertices[0]);
  expect(projected).not.toHaveProperty('distanceField');
  expect(projected).not.toHaveProperty('cardLayout');
  f.world.despawn(content).unwrap();
  const restored = resolveAssetHandle<MeshAsset>(f.publish().resources, handle).unwrap();
  expect(restored.vertices[0]).toBe(original.vertices[0]);
  expect(restored.distanceField).toEqual(original.distanceField);
  expect(restored.cardLayout).toEqual(original.cardLayout);
  expect(resolveAssetHandle<MeshAsset>(f.world, handle).unwrap()).toBe(original);
  f.publisher.dispose();
});

it('propagates parent visibility and reuses returned storage without allocation growth', () => {
  const f = fixture();
  f.publish();
  const parent = f.world
    .spawn(
      { component: Transform, data: {} },
      { component: Visibility, data: { state: VisibilityStateValue.visible } },
    )
    .unwrap();
  f.world.addComponent(f.first, { component: ChildOf, data: { parent } }).unwrap();
  f.world.update(0).unwrap();
  f.publish();
  f.world.set(parent, Visibility, { state: VisibilityStateValue.hidden }).unwrap();
  expect(f.publish().frame.renderables.some((row) => row.entityKey === f.first)).toBe(false);
  f.world.set(parent, Visibility, { state: VisibilityStateValue.visible }).unwrap();
  f.publish();
  const allocations = f.publisher.inspect().allocations;
  for (let i = 0; i < 12; i++) {
    f.world.set(f.second, Transform, { pos: [i, 0, 0] }).unwrap();
    f.world.update(0).unwrap();
    f.publish();
  }
  expect(f.publisher.inspect().allocations).toBe(allocations);
  f.publisher.dispose();
});

it('ignores unbound geometry vocabulary just like local extraction', () => {
  const f = fixture();
  f.publish();
  f.world.spawn({ component: Points, data: {} }).unwrap();
  const result = f.publisher.prepare(0);
  expect(result.ok).toBe(true);
  if (result.ok) result.value.discard();
  f.publisher.dispose();
});

it.each([
  10_000, 50_000,
])('keeps static publication delta and native scanned rows at zero for %i entities', (count) => {
  const f = fixture();
  for (let i = 2; i < count; i++) f.spawn();
  f.world.update(0).unwrap();
  const baseline = f.publish();
  expect(baseline.packet.upserts.length).toBe(count * 2);
  const allocations = f.publisher.inspect().allocations;
  for (let i = 0; i < 3; i++) {
    const next = f.publish();
    expect(
      next.packet.upserts.length +
        next.packet.transforms.length +
        next.packet.removed.length +
        next.packet.assets.length,
    ).toBe(0);
    expect(f.publisher.inspect().scannedRows).toBe(0);
    expect(f.publisher.inspect().allocations).toBe(allocations);
  }
  f.publisher.dispose();
}, 60_000);

it('publishes instance poses without detaching source storage and accumulates skipped updates', () => {
  const f = fixture();
  const matrices = new Float32Array(32);
  for (let i = 0; i < 2; i++) for (const j of [0, 5, 10, 15]) matrices[i * 16 + j] = 1;
  f.world.addComponent(f.first, { component: Instances, data: { transforms: matrices } }).unwrap();
  const initial = f.publish();
  expect(
    initial.frame.renderables.find((row) => row.entityKey === f.first)?.instances?.transforms,
  ).toEqual(matrices);
  matrices[12] = 0.5;
  f.world.set(f.first, Instances, { transforms: matrices }).unwrap();
  matrices[28] = -0.5;
  f.world.set(f.first, Instances, { transforms: matrices }).unwrap();
  const next = f.publish();
  expect(
    next.frame.renderables.find((row) => row.entityKey === f.first)?.instances?.transforms,
  ).toEqual(matrices);
  expect(f.world.get(f.first, Instances).unwrap().transforms.byteLength).toBe(128);
  expect(f.publish().packet.upserts).toHaveLength(0);
  f.publisher.dispose();
});

it('publishes frame-owned environment and post parameters without geometry churn', () => {
  const f = fixture();
  f.publish();
  f.world.spawn({ component: Skylight, data: { intensity: 2 } }).unwrap();
  f.world
    .spawn({
      component: PostProcessParams,
      data: { shader: 'test-post', data: new Uint8Array([1, 2, 3, 4]) },
    })
    .unwrap();
  const next = f.publish();
  expect(next.frame.skylight?.intensity).toBe(2);
  expect(next.frame.postProcessParams.get('test-post')).toEqual(new Uint8Array([1, 2, 3, 4]));
  expect(next.packet.upserts).toHaveLength(0);
  f.publisher.dispose();
});

it('publishes detached skin poses and follows joint changes across skipped source frames', () => {
  const f = fixture();
  const identity = new Float32Array(32);
  for (const base of [0, 16]) for (const lane of [0, 5, 10, 15]) identity[base + lane] = 1;
  const skeleton = f.world.allocSharedRef('SkeletonAsset', {
    kind: 'skeleton',
    jointCount: 2,
    inverseBindMatrices: identity,
  });
  const joint = f.world.spawn({ component: Transform, data: {} }).unwrap();
  const other = f.world.spawn({ component: Transform, data: { pos: [2, 0, 0] } }).unwrap();
  f.world
    .addComponent(f.first, {
      component: Skin,
      data: { skeleton, joints: new Uint32Array([joint, other]) },
    })
    .unwrap();
  f.world.update(0).unwrap();
  const initial = f.publish();
  const pose = initial.packet.templates.find((t) => t.snapshot.skinPose !== undefined)?.snapshot
    .skinPose;
  expect(pose?.jointCount).toBe(2);
  expect(pose?.jointWorlds[0]?.buffer).toBe(pose?.jointWorlds[1]?.buffer);
  expect(pose?.jointWorlds[1]?.byteOffset).toBe((pose?.jointWorlds[0]?.byteOffset ?? 0) + 64);
  expect(pose?.jointWorlds[1]?.[12]).toBe(2);
  expect(initial.packet.templates.every((t) => t.snapshot.skin === undefined)).toBe(true);
  f.world.set(joint, Transform, { pos: [0.5, 0, 0] }).unwrap();
  f.world.update(1 / 60).unwrap();
  f.world.set(joint, Transform, { pos: [1, 0, 0] }).unwrap();
  f.world.update(1 / 60).unwrap();
  const next = f.publish();
  const nextPose = next.packet.templates.find((t) => t.snapshot.skinPose !== undefined)?.snapshot
    .skinPose;
  expect(nextPose?.jointWorlds[0]?.[12]).toBe(1);
  expect(nextPose?.jointWorlds[1]?.[12]).toBe(2);
  expect(nextPose?.jointWorlds[0]?.buffer).toBe(nextPose?.jointWorlds[1]?.buffer);
  expect(nextPose?.jointWorlds[0]?.buffer).not.toBe(pose?.jointWorlds[0]?.buffer);
  expect(pose?.jointWorlds[0]?.[12]).toBe(0);
  expect(f.publish().packet.upserts).toHaveLength(0);
  f.world.removeComponent(f.first, Skin).unwrap();
  expect(
    f.publish().frame.renderables.find((row) => row.entityKey === f.first)?.skinPose,
  ).toBeUndefined();
  f.publisher.dispose();
});

it('renders a one-frame identity before its sealed removal and reuses two buffer slots', () => {
  const f = fixture();
  const seal = () => {
    const candidate = f.publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet, {
      transfer: renderPublicationTransfers(candidate.packet),
    });
    candidate.accept();
    return packet;
  };
  try {
    const first = seal();
    f.world.despawn(f.first).unwrap();
    const replacement = f.spawn();
    f.world.update(0).unwrap();
    const second = seal();
    expect(f.publisher.prepare(0)).toMatchObject({
      ok: false,
      error: { detail: { reason: 'in-flight' } },
    });
    // More source mutations cannot edit either already-transferred publication.
    f.world.despawn(replacement).unwrap();
    f.world.update(0).unwrap();
    const firstFrame = f.scene.consumePublication(f.receiver.accept(first).unwrap());
    expect(firstFrame.renderables.map((row) => row.entityKey)).toContain(f.first);
    f.publisher.recycle(first.revision, renderPublicationTransfers(first)).unwrap();
    const secondFrame = f.scene.consumePublication(f.receiver.accept(second).unwrap());
    expect(secondFrame.renderables.map((row) => row.entityKey)).toContain(replacement);
    expect(secondFrame.renderables.map((row) => row.entityKey)).not.toContain(f.first);
    f.publisher.recycle(second.revision, renderPublicationTransfers(second)).unwrap();
    // Warm both slots for equivalent changed-transform frames, then drain in pairs.
    let warmAllocations: number | undefined;
    for (let index = 0; index < 4; index++) {
      const packets = [1, 2].map((x) => {
        f.world.set(f.second, Transform, { pos: [x, index, 0] }).unwrap();
        f.world.update(0).unwrap();
        return seal();
      });
      const allocations = f.publisher.inspect().allocations;
      for (const packet of packets)
        f.publisher.recycle(packet.revision, renderPublicationTransfers(packet)).unwrap();
      warmAllocations ??= allocations;
      expect(allocations).toBe(warmAllocations);
    }
  } finally {
    f.publisher.dispose();
  }
});

it('keeps three transferred publications detached, ordered and bounded while reusing their storage', () => {
  const f = fixture(3);
  const seal = () => {
    const candidate = f.publisher.prepare(0).unwrap();
    const buffers = renderPublicationTransfers(candidate.packet);
    const packet = structuredClone(candidate.packet, { transfer: buffers });
    candidate.accept();
    expect(buffers.every((buffer) => buffer.byteLength === 0)).toBe(true);
    return packet;
  };
  try {
    const first = seal();
    f.world.despawn(f.first).unwrap();
    const replacement = f.spawn();
    f.world.update(0).unwrap();
    const second = seal();
    f.world.despawn(replacement).unwrap();
    f.world.set(f.second, Transform, { pos: [3, 0, 0] }).unwrap();
    f.world.update(0).unwrap();
    const third = seal();
    const packets = [first, second, third];
    expect(packets.map(({ revision, base }) => [revision, base])).toEqual([
      [1, 0],
      [2, 1],
      [3, 2],
    ]);
    expect(new Set(packets.flatMap(renderPublicationTransfers)).size).toBe(12);
    expect(f.publisher.inspect().inFlightCount).toBe(3);
    expect(f.publisher.prepare(0)).toMatchObject({
      ok: false,
      error: { detail: { reason: 'in-flight' } },
    });
    expect(f.publisher.recycle(second.revision, renderPublicationTransfers(second))).toMatchObject({
      ok: false,
      error: { detail: { reason: 'revision' } },
    });
    // Current World writes cannot alter any of the three already-sealed frames.
    f.world.set(f.second, Transform, { pos: [4, 0, 0] }).unwrap();
    f.world.update(0).unwrap();
    const firstFrame = f.scene.consumePublication(f.receiver.accept(first).unwrap());
    expect(firstFrame.renderables.map(({ entityKey }) => entityKey)).toContain(f.first);
    f.publisher.recycle(first.revision, renderPublicationTransfers(first)).unwrap();
    const secondFrame = f.scene.consumePublication(f.receiver.accept(second).unwrap());
    expect(secondFrame.renderables.map(({ entityKey }) => entityKey)).toContain(replacement);
    expect(secondFrame.renderables.map(({ entityKey }) => entityKey)).not.toContain(f.first);
    f.publisher.recycle(second.revision, renderPublicationTransfers(second)).unwrap();
    const thirdFrame = f.scene.consumePublication(f.receiver.accept(third).unwrap());
    expect(thirdFrame.renderables.map(({ entityKey }) => entityKey)).not.toContain(replacement);
    expect(
      thirdFrame.renderables.find(({ entityKey }) => entityKey === f.second)?.transform.world[12],
    ).toBe(3);
    f.publisher.recycle(third.revision, renderPublicationTransfers(third)).unwrap();

    let warmAllocations: number | undefined;
    for (let cycle = 0; cycle < 4; cycle++) {
      const next = [1, 2, 3].map((x) => {
        f.world.set(f.second, Transform, { pos: [x, cycle, 0] }).unwrap();
        f.world.update(0).unwrap();
        return seal();
      });
      const allocations = f.publisher.inspect().allocations;
      for (const packet of next)
        f.publisher.recycle(packet.revision, renderPublicationTransfers(packet)).unwrap();
      warmAllocations ??= allocations;
      expect(allocations).toBe(warmAllocations);
      expect(f.publisher.inspect().inFlightCount).toBe(0);
    }
  } finally {
    f.publisher.dispose();
    f.receiver.dispose();
    f.scene.dispose();
  }
});

it('keeps three-flight source ACKs tied to admitted revisions through discard and terminal failure', () => {
  const submitted: unknown[] = [];
  const feature: RenderFeature<unknown> = {
    identity: 'three-flight-source',
    extract: ({ frameNumber }) => ok(frameNumber),
    plan: () => ok({ work: [] }),
    onSourceFrameSubmitted: (data, feedback) => submitted.push({ data, feedback }),
  };
  const f = fixture(3, [feature]);
  const seal = () => {
    const candidate = f.publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet, {
      transfer: renderPublicationTransfers(candidate.packet),
    });
    candidate.accept();
    return packet;
  };
  try {
    const first = seal();
    const second = seal();
    f.world.set(f.second, Transform, { pos: [3, 0, 0] }).unwrap();
    f.world.update(0).unwrap();
    const rejected = f.publisher.prepare(0).unwrap();
    expect(rejected.packet.revision).toBe(3);
    expect(f.publisher.prepare(0).ok).toBe(false);
    expect(() =>
      structuredClone(
        { packet: rejected.packet, invalid() {} },
        { transfer: renderPublicationTransfers(rejected.packet) },
      ),
    ).toThrow();
    expect(rejected.packet.transforms.byteLength).toBeGreaterThan(0);
    rejected.discard();
    expect(f.publisher.inspect().inFlightCount).toBe(2);
    expect(submitted).toEqual([]);
    const third = seal();
    expect(third.revision).toBe(3);
    const ack = (revision: number) =>
      f.publisher.acknowledgeFeatures(revision, [
        { identity: feature.identity, feedback: revision },
      ]);
    expect(ack(4).ok).toBe(false);
    ack(first.revision).unwrap();
    expect(ack(first.revision).ok).toBe(false);
    expect(submitted).toEqual([{ data: 1, feedback: 1 }]);
    ack(second.revision).unwrap();
    expect(submitted).toEqual([
      { data: 1, feedback: 1 },
      { data: 2, feedback: 2 },
    ]);
    // A terminal transport/renderer failure disposes the publisher without
    // inventing a submission ACK for the still-admitted third publication.
    f.publisher.dispose();
    expect(ack(third.revision)).toMatchObject({
      ok: false,
      error: { detail: { reason: 'disposed' } },
    });
    expect(submitted).toHaveLength(2);
    expect(f.publisher.inspect().inFlightCount).toBe(0);
  } finally {
    f.publisher.dispose();
    f.receiver.dispose();
    f.scene.dispose();
  }
});

it('publishes detached view configuration and seeds a late view from the current scene', () => {
  const f = fixture();
  const camera = f.world
    .spawn(
      { component: Transform, data: {} },
      { component: Camera, data: {} },
      { component: CameraView, data: { viewport: [0.5, 0, 0.5, 1], updateInterval: 4 } },
    )
    .unwrap();
  f.world.update(0).unwrap();
  const first = f.publish();
  expect(first.packet.metadata.cameras).toHaveLength(1);
  expect(first.packet.metadata.cameras[0]?.view).toMatchObject({ updateInterval: 4 });
  f.world.set(camera, CameraView, { viewport: [0, 0, 1, 1] }).unwrap();
  expect(Array.from(first.packet.metadata.cameras[0]?.view?.viewport ?? [])).toEqual([
    0.5, 0, 0.5, 1,
  ]);
  f.world.set(f.first, Transform, { pos: [3, 0, 0] }).unwrap();
  f.world.despawn(f.second).unwrap();
  f.world.update(0).unwrap();
  const candidate = f.publisher.prepare(1).unwrap();
  const packet = structuredClone(candidate.packet, {
    transfer: renderPublicationTransfers(candidate.packet),
  });
  candidate.accept();
  const accepted = f.receiver.accept(packet).unwrap();
  const late = new PersistentRenderScene();
  const frame = late.consumePublication(f.receiver.snapshot(accepted));
  expect(frame.renderables.map((row) => row.entityKey)).toEqual([Number(f.first)]);
  expect(frame.renderables[0]?.transform.world[12]).toBe(3);
  f.publisher.dispose();
});

it('publishes the same interpolated root, camera and animated skin across half-fixed frames', () => {
  const f = fixture();
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const skeleton = f.world.allocSharedRef('SkeletonAsset', {
    kind: 'skeleton',
    jointCount: 1,
    inverseBindMatrices: identity,
  });
  f.world.addComponent(f.first, { component: TransformInterpolation, data: {} }).unwrap();
  const joint = f.world
    .spawn({ component: Transform, data: {} }, { component: ChildOf, data: { parent: f.first } })
    .unwrap();
  f.world
    .addComponent(f.first, {
      component: Skin,
      data: { skeleton, joints: new Uint32Array([joint]) },
    })
    .unwrap();
  const camera = Array.from(f.world.query({ read: [Camera] }).unwrap())[0]?.entity;
  if (camera === undefined) throw new Error('expected fixture camera');
  f.world
    .addSystem(FixedUpdate, {
      name: 'move',
      queries: [],
      fn: () => {
        f.world
          .set(f.first, Transform, { pos: [f.world.getResource(FixedTime).tick, 0, 0] })
          .unwrap();
      },
    })
    .unwrap();
  f.world
    .addSystem(Update, {
      name: 'sample-camera-and-animation',
      after: [FixedUpdate],
      before: ['propagateTransforms'],
      queries: [],
      fn: () => {
        const root = readPresentationWorldMatrix(f.world, f.first);
        if (root === undefined) throw new Error('expected player pose');
        f.world.set(camera, Transform, { pos: [root[12] ?? 0, 0, 5] }).unwrap();
        f.world.set(joint, Transform, { pos: [f.world.getResource(Time).elapsed, 0, 0] }).unwrap();
      },
    })
    .unwrap();
  try {
    f.world.update(2 / 60).unwrap();
    let previous: number | undefined;
    for (let frame = 0; frame < 12; frame += 1) {
      f.world.update(1 / 120).unwrap();
      const published = f.publish();
      const root = published.frame.renderables.find((row) => row.entityKey === f.first);
      const expected = f.world.getResource(Time).elapsed * 60 - 1;
      expect(root?.transform.world[12]).toBeCloseTo(expected, 5);
      expect(root?.skinPose?.jointWorlds[0]?.[12]).toBeCloseTo(
        expected + f.world.getResource(Time).elapsed,
        5,
      );
      expect(published.frame.cameras[0]?.position[0]).toBeCloseTo(expected, 5);
      expect(published.packet.upserts.length).toBeGreaterThan(0);
      if (previous !== undefined) expect(root?.transform.world[12]).toBeCloseTo(previous + 0.5, 5);
      previous = root?.transform.world[12];
    }
  } finally {
    f.publisher.dispose();
  }
});
