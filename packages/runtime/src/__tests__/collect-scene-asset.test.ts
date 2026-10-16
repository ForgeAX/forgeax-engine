import * as SceneOwner from '@forgeax/engine-scene';

// w9 — writeback round-trip semantic equivalence tests, migrated to
// rootsToSceneAsset (plan-strategy D-1: semantic equivalence not byte
// equivalence because full writeback materializes defaults — decisions #8 OOS).
//
// Old w10 (handleToGuid tests) removed — engine now self-resolves GUIDs
// via AssetRegistry, no external handleToGuid table needed. Those scenarios
// are covered by m2-t3 in roots-to-scene-asset.test.ts.
//
// NOTE: rootsToSceneAsset omits the transient synthetic SceneInstance anchor.
// Entity counts therefore describe authored keyed declarations only.
//
// M1T7 AUDIT (feat-20260707-engine-world-clone-transient-for-editor-ssot):
//   Classification: (b) false-positive modification risk — all 10 tests
//   preserved as-is. These tests check entity count, component value fidelity,
//   and round-trip semantics using custom non-transient test components
//   (Test_Transform, Test_Pos3, etc.). None of them assert on Children or
//   SceneInstance presence in output. Entity-count checks (n entities + 1
//   synthetic root) are unaffected by transient — transient only skips
//   component-level keys, not entity-level entries.
//   VERDICT: zero expectations encoded pre-fix bug.

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { type Component, defineComponent as defineEcsComponent, World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { SceneInstance } from '@forgeax/engine-render';
import { ChildOf, Children, Transform } from '@forgeax/engine-scene';
import type { SceneAsset, SceneEntity } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { rootsToSceneAsset, serializeSceneAssetToPack } from '../collect-scene-asset';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

const TEST_COMPONENTS: Component[] = [];

function defineComponent(name: string, fields: Record<string, unknown>): Component {
  const component = defineEcsComponent(name, fields as never);
  TEST_COMPONENTS.push(component);
  return component;
}

function registerSceneComponents(world: World): void {
  for (const component of [SceneInstance, ChildOf, Children, Transform, ...TEST_COMPONENTS]) {
    world.components.register(component).unwrap();
  }
}

function makeRegistry(): AssetRegistry {
  return new AssetRegistry(makeMockShaderRegistry());
}

// biome-ignore lint/suspicious/noExplicitAny: allocSharedRef('SceneAsset') returns branded Handle<"SceneAsset", ...> but instantiateScene expects Handle<string, ...>
function registerSceneAsset(world: World, asset: SceneAsset): any {
  registerSceneComponents(world);
  return world.allocSharedRef('SceneAsset', asset);
}

function comp(entity: SceneEntity, name: string): Record<string, unknown> | undefined {
  const map = entity.components as Record<string, Record<string, unknown>>;
  return map[name];
}

function def<T>(v: T | undefined | null, label = 'value'): T {
  if (v === undefined || v === null) throw new Error(`expected ${label} to be defined`);
  return v;
}

/** Find the entity in the scene that has the given component. */
function findEntityWith(
  entities: Readonly<Record<string, SceneEntity>> | readonly SceneEntity[],
  compName: string,
): SceneEntity {
  const list = Array.isArray(entities) ? entities : Object.values(entities);
  const found = list.find(
    (e) => (e.components as Record<string, Record<string, unknown>>)[compName] !== undefined,
  );
  if (!found) throw new Error(`no entity with component ${compName}`);
  return found;
}

describe('w9 — round-trip semantic equivalence', () => {
  it('(a) entity count and localId set survive instantiate->collect round-trip', () => {
    defineComponent('Test_Transform', {
      pos: 'array<f32, 3>',
    });

    const asset: SceneAsset = {
      kind: 'scene',
      entities: {
        'entity-0': { components: { Test_Transform: { pos: [1, 2, 3] } } },
        'entity-1': { components: { Test_Transform: { pos: [4, 5, 6] } } },
        'entity-2': { components: { Test_Transform: { pos: [7, 8, 9] } } },
      },
    };

    const world = new World();
    const reg = makeRegistry();
    const sg = AssetGuid.parse('00000000-0000-0000-0000-000000000000');
    if (sg.ok) reg.catalog(sg.value, asset);
    const handle = registerSceneAsset(world, asset);
    const res = SceneOwner.worldInstantiateScene(world, handle);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const root = res.value.root;

    const collected = rootsToSceneAsset(reg, world, [root]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;
    const scene = collected.value;
    expect(scene.kind).toBe('scene');
    // Three authored declarations; the transient anchor is omitted.
    expect(Object.keys(scene.entities)).toHaveLength(3);

    const entityWithTransform = findEntityWith(scene.entities, 'Test_Transform');
    expect(entityWithTransform).toBeDefined();
  });

  it('(b) component value semantic equivalence — f32 fields round-trip', () => {
    defineComponent('Test_Pos3', {
      x: 'f32',
      y: 'f32',
      z: 'f32',
    });

    const asset: SceneAsset = {
      kind: 'scene',
      entities: { 'entity-0': { components: { Test_Pos3: { x: 10.5, y: 20.5, z: 30.5 } } } },
    };

    const world = new World();
    const reg = makeRegistry();
    const sg = AssetGuid.parse('00000000-0000-0000-0000-000000000000');
    if (sg.ok) reg.catalog(sg.value, asset);
    const handle = registerSceneAsset(world, asset);
    const res = SceneOwner.worldInstantiateScene(world, handle);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const root = res.value.root;

    const collected = rootsToSceneAsset(reg, world, [root]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;
    const scene = collected.value;
    // one authored entity; the transient anchor is omitted.
    expect(Object.keys(scene.entities)).toHaveLength(1);
    const e = findEntityWith(scene.entities, 'Test_Pos3');
    const tp = def(comp(e, 'Test_Pos3'), 'Test_Pos3');
    expect(Math.abs((tp.x as number) - 10.5)).toBeLessThan(0.001);
    expect(Math.abs((tp.y as number) - 20.5)).toBeLessThan(0.001);
    expect(Math.abs((tp.z as number) - 30.5)).toBeLessThan(0.001);
  });

  it('(c) default value materialization accepted (semantic != byte equivalence)', () => {
    defineComponent('Test_WithDefault', {
      required: 'f32',
      optional: { type: 'f32', default: 42 },
    });

    const asset: SceneAsset = {
      kind: 'scene',
      entities: { 'entity-0': { components: { Test_WithDefault: { required: 7 } } } },
    };

    const world = new World();
    const reg = makeRegistry();
    const sg = AssetGuid.parse('00000000-0000-0000-0000-000000000000');
    if (sg.ok) reg.catalog(sg.value, asset);
    const handle = registerSceneAsset(world, asset);
    const res = SceneOwner.worldInstantiateScene(world, handle);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const root = res.value.root;

    const collected = rootsToSceneAsset(reg, world, [root]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;
    const scene = collected.value;
    expect(Object.keys(scene.entities)).toHaveLength(1);
    const e = findEntityWith(scene.entities, 'Test_WithDefault');
    const tw = def(comp(e, 'Test_WithDefault'), 'Test_WithDefault');
    expect(tw.required).toBe(7);
    expect(tw.optional).toBe(42);
  });

  it('(d) empty scene (no entities) round-trips to empty entities[]', () => {
    const asset: SceneAsset = { kind: 'scene', entities: {} };
    const world = new World();
    const reg = makeRegistry();
    const sg = AssetGuid.parse('00000000-0000-0000-0000-000000000000');
    if (sg.ok) reg.catalog(sg.value, asset);
    const handle = registerSceneAsset(world, asset);
    const res = SceneOwner.worldInstantiateScene(world, handle);
    // Empty scene may still instantiate; root should be present.
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const root = res.value.root;

    const collected = rootsToSceneAsset(reg, world, [root]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;
    const scene = collected.value;
    expect(scene.kind).toBe('scene');
    // Empty scene has no authored declarations.
    expect(Object.keys(scene.entities)).toHaveLength(0);
  });

  it('(e) string field round-trips through rootsToSceneAsset', () => {
    defineComponent('Test_Name', {
      label: 'string',
    });

    const asset: SceneAsset = {
      kind: 'scene',
      entities: { 'entity-0': { components: { Test_Name: { label: 'hello' } } } },
    };

    const world = new World();
    const reg = makeRegistry();
    const sg = AssetGuid.parse('00000000-0000-0000-0000-000000000000');
    if (sg.ok) reg.catalog(sg.value, asset);
    const handle = registerSceneAsset(world, asset);
    const res = SceneOwner.worldInstantiateScene(world, handle);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const root = res.value.root;

    const collected = rootsToSceneAsset(reg, world, [root]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;
    const scene = collected.value;
    expect(Object.keys(scene.entities)).toHaveLength(1);
    const e = findEntityWith(scene.entities, 'Test_Name');
    const tn = def(comp(e, 'Test_Name'), 'Test_Name');
    expect(tn.label).toBe('hello');
  });

  it('(f) multiple components per entity round-trip correctly', () => {
    defineComponent('Test_A', { val: 'f32' });
    defineComponent('Test_B', { flag: 'bool' });
    defineComponent('Test_C', { name: 'string' });

    const asset: SceneAsset = {
      kind: 'scene',
      entities: {
        'entity-0': {
          components: {
            Test_A: { val: 1 },
            Test_B: { flag: true },
            Test_C: { name: 'multi' },
          },
        },
      },
    };

    const world = new World();
    const reg = makeRegistry();
    const sg = AssetGuid.parse('00000000-0000-0000-0000-000000000000');
    if (sg.ok) reg.catalog(sg.value, asset);
    const handle = registerSceneAsset(world, asset);
    const res = SceneOwner.worldInstantiateScene(world, handle);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const root = res.value.root;

    const collected = rootsToSceneAsset(reg, world, [root]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;
    const scene = collected.value;
    expect(Object.keys(scene.entities)).toHaveLength(1);
    const e = findEntityWith(scene.entities, 'Test_A');
    expect(def(comp(e, 'Test_A'), 'Test_A').val).toBe(1);
    expect(def(comp(e, 'Test_B'), 'Test_B').flag).toBe(true);
    expect(def(comp(e, 'Test_C'), 'Test_C').name).toBe('multi');
  });

  it('(g) bool field round-trips through rootsToSceneAsset', () => {
    defineComponent('Test_Flag', { enabled: 'bool' });

    const asset: SceneAsset = {
      kind: 'scene',
      entities: {
        'entity-0': { components: { Test_Flag: { enabled: true } } },
        'entity-1': { components: { Test_Flag: { enabled: false } } },
      },
    };

    const world = new World();
    const reg = makeRegistry();
    const sg = AssetGuid.parse('00000000-0000-0000-0000-000000000000');
    if (sg.ok) reg.catalog(sg.value, asset);
    const handle = registerSceneAsset(world, asset);
    const res = SceneOwner.worldInstantiateScene(world, handle);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const root = res.value.root;

    const collected = rootsToSceneAsset(reg, world, [root]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;
    const scene = collected.value;
    // two authored children; the transient anchor is omitted.
    expect(Object.keys(scene.entities)).toHaveLength(2);

    // Find the two entities with Test_Flag.
    const flagged = Object.values(scene.entities).filter(
      (e) => (e.components as Record<string, Record<string, unknown>>).Test_Flag !== undefined,
    );
    expect(flagged).toHaveLength(2);

    // One should have true, one false.
    const values = flagged.map(
      (e) => (e.components as Record<string, Record<string, unknown>>).Test_Flag?.enabled,
    );
    expect(values).toContain(true);
    expect(values).toContain(false);
  });

  it('(h) serializeSceneAssetToPack produces valid pack envelope', () => {
    defineComponent('Test_Pack', { a: 'f32' });

    const asset: SceneAsset = {
      kind: 'scene',
      entities: { 'entity-0': { components: { Test_Pack: { a: 99 } } } },
    };

    const packResult = serializeSceneAssetToPack(
      asset,
      new Map(),
      'aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee',
    );
    expect(packResult.ok).toBe(true);
    if (!packResult.ok) return;
    const pack = packResult.value;
    expect(pack.schemaVersion).toBe('2.0.0');
    expect(pack.assets).toEqual([expect.objectContaining({ artifacts: {} })]);
    expect(pack.kind).toBe('internal-text-package');
    const assets = pack.assets as Array<Record<string, unknown>>;
    expect(Array.isArray(assets)).toBe(true);
    expect(assets).toHaveLength(1);

    const assetEntry = def(assets[0], 'assets[0]');
    expect(assetEntry.guid).toBe('aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee');
    expect(assetEntry.kind).toBe('scene');
    const payload = assetEntry.payload as Record<string, unknown>;
    expect(
      payload.entities !== null &&
        typeof payload.entities === 'object' &&
        !Array.isArray(payload.entities),
    ).toBe(true);
    expect(Object.keys(payload.entities as Record<string, unknown>)).toHaveLength(1);
  });

  it('(i) serializeSceneAssetToPack without guid uses a generated guid', () => {
    const asset: SceneAsset = { kind: 'scene', entities: {} };

    const packResult = serializeSceneAssetToPack(asset, new Map());
    expect(packResult.ok).toBe(true);
    if (!packResult.ok) return;
    const pack = packResult.value;
    expect(pack.schemaVersion).toBe('2.0.0');
    expect(pack.assets).toEqual([expect.objectContaining({ artifacts: {} })]);
    expect(pack.kind).toBe('internal-text-package');
    const assets = pack.assets as Array<Record<string, unknown>>;
    expect(Array.isArray(assets)).toBe(true);
    expect(assets).toHaveLength(1);
    const entry0 = def(assets[0], 'assets[0]');
    expect(typeof entry0.guid).toBe('string');
    expect((entry0.guid as string).length).toBeGreaterThan(0);
  });

  it('(j) full round-trip instantiate->collect->serialize->check', () => {
    defineComponent('Test_Full', {
      posX: 'f32',
      posY: 'f32',
      name: 'string',
    });

    const asset: SceneAsset = {
      kind: 'scene',
      entities: {
        'entity-0': { components: { Test_Full: { posX: 1.5, posY: 2.5, name: 'e0' } } },
        'entity-1': { components: { Test_Full: { posX: 3.5, posY: 4.5, name: 'e1' } } },
      },
    };

    const world = new World();
    const reg = makeRegistry();
    const sg = AssetGuid.parse('00000000-0000-0000-0000-000000000000');
    if (sg.ok) reg.catalog(sg.value, asset);
    const handle = registerSceneAsset(world, asset);
    const res = SceneOwner.worldInstantiateScene(world, handle);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const root = res.value.root;

    const collected = rootsToSceneAsset(reg, world, [root]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;
    // Two authored declarations; the transient anchor is omitted.
    expect(Object.keys(collected.value.entities)).toHaveLength(2);

    const packResult = serializeSceneAssetToPack(
      collected.value,
      world.components.entries(),
      '11111111-2222-4333-8444-555555555555',
    );
    expect(packResult.ok).toBe(true);
    if (!packResult.ok) return;
    const pack = packResult.value;
    expect(pack.kind).toBe('internal-text-package');
    const assets = pack.assets as Array<Record<string, unknown>>;
    const payload = def(assets[0], 'assets[0]').payload as Record<string, unknown>;
    const entities = Object.values(payload.entities as Record<string, Record<string, unknown>>);
    expect(entities).toHaveLength(2);

    // Find entities with Test_Full in serialized output.
    const tfEntities = entities.filter(
      (ent) => (ent.components as Record<string, Record<string, unknown>>).Test_Full !== undefined,
    );
    expect(tfEntities).toHaveLength(2);

    const names = tfEntities.map(
      (ent) =>
        (
          (ent.components as Record<string, Record<string, unknown>>).Test_Full as Record<
            string,
            unknown
          >
        ).name,
    );
    expect(names).toContain('e0');
    expect(names).toContain('e1');
  });
});

// feat-20260709-transform-serialization-vec-fields-and-field-trans M1 / w1:
// Field-level transient collect skip (AC-02 + AC-03, TDD red-first).
//
// AC-02: a Transform-carrying entity serializes with no `world` key in its
//   component output (world is field-level transient, D-5).
// AC-03: the skip is a generic mechanism — ANY component declaring ANY field
//   transient:true has that field skipped, while undeclared fields serialize
//   as usual. No hardcoded 'world'/'Transform' special-case (collect field
//   loop reads comp.fields[fieldName].transient).
describe('w1 — field-level transient collect skip (AC-02 + AC-03)', () => {
  it('(AC-02) Transform entity serializes without a world key', () => {
    const asset: SceneAsset = {
      kind: 'scene',
      entities: { 'entity-0': { components: { Transform: { pos: [1, 2, 3] } } } },
    };

    const world = new World();
    const reg = makeRegistry();
    const sg = AssetGuid.parse('00000000-0000-0000-0000-000000000000');
    if (sg.ok) reg.catalog(sg.value, asset);
    const handle = registerSceneAsset(world, asset);
    const res = SceneOwner.worldInstantiateScene(world, handle);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const collected = rootsToSceneAsset(reg, world, [res.value.root]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;

    // Every Transform-carrying entity (synthetic identity root + the authored
    // child) must omit the transient world field.
    const transformEntities = Object.values(collected.value.entities).filter(
      (e) => (e.components as Record<string, Record<string, unknown>>).Transform !== undefined,
    );
    expect(transformEntities.length).toBeGreaterThan(0);
    for (const e of transformEntities) {
      const t = def(comp(e, 'Transform'), 'Transform');
      // world field is transient -> absent from serialized output.
      expect('world' in t).toBe(false);
    }

    // The authored entity retains its persisted local TRS. Its implicit
    // ChildOf edge to the transient anchor is omitted, so identify it by data.
    const authored = transformEntities.find((e) => {
      const pos = (e.components as Record<string, Record<string, unknown>>).Transform?.pos;
      return Array.isArray(pos) && pos[0] === 1 && pos[1] === 2 && pos[2] === 3;
    });
    const t = def(comp(def(authored, 'authored'), 'Transform'), 'Transform');
    expect(t.pos).toEqual([1, 2, 3]);
    // Reference the imported Transform token so the schema is registered.
    expect(Transform.name).toBe('Transform');
  });

  it('(AC-03) generic: an arbitrary component field declared transient is skipped, others kept', () => {
    // Brand-new component, arbitrary field names -> proves no Transform/world
    // hardcode in the collect skip path.
    defineComponent('W1_GenericTransient', {
      persisted: { type: 'f32', default: 0 },
      cache: { type: 'array<f32, 4>', default: new Float32Array(4), transient: true },
    });

    const asset: SceneAsset = {
      kind: 'scene',
      entities: {
        'entity-0': { components: { W1_GenericTransient: { persisted: 7, cache: [9, 9, 9, 9] } } },
      },
    };

    const world = new World();
    const reg = makeRegistry();
    const sg = AssetGuid.parse('00000000-0000-0000-0000-000000000000');
    if (sg.ok) reg.catalog(sg.value, asset);
    const handle = registerSceneAsset(world, asset);
    const res = SceneOwner.worldInstantiateScene(world, handle);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const collected = rootsToSceneAsset(reg, world, [res.value.root]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;

    const e = findEntityWith(collected.value.entities, 'W1_GenericTransient');
    const c = def(comp(e, 'W1_GenericTransient'), 'W1_GenericTransient');
    // transient field skipped.
    expect('cache' in c).toBe(false);
    // undeclared field kept.
    expect(c.persisted).toBeCloseTo(7, 5);
  });

  it('(AC-03 control) a component with no transient field serializes every field', () => {
    defineComponent('W1_NoTransient', {
      a: { type: 'f32', default: 0 },
      b: { type: 'f32', default: 0 },
    });

    const asset: SceneAsset = {
      kind: 'scene',
      entities: { 'entity-0': { components: { W1_NoTransient: { a: 3, b: 4 } } } },
    };

    const world = new World();
    const reg = makeRegistry();
    const sg = AssetGuid.parse('00000000-0000-0000-0000-000000000000');
    if (sg.ok) reg.catalog(sg.value, asset);
    const handle = registerSceneAsset(world, asset);
    const res = SceneOwner.worldInstantiateScene(world, handle);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const collected = rootsToSceneAsset(reg, world, [res.value.root]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;

    const e = findEntityWith(collected.value.entities, 'W1_NoTransient');
    const c = def(comp(e, 'W1_NoTransient'), 'W1_NoTransient');
    expect(c.a).toBeCloseTo(3, 5);
    expect(c.b).toBeCloseTo(4, 5);
  });
});

// feat-20260803-audio-listener-marker-roundtrip: an empty-schema component is
// still authored presence. The collector must keep it in the SceneAsset and
// Pack v2 payload so marker components such as AudioListener survive reopen.
describe('marker component scene-pack round-trip', () => {
  it('preserves an authored empty-schema component', () => {
    defineComponent('Test_EmptySchemaMarker', {});
    const asset: SceneAsset = {
      kind: 'scene',
      entities: { 'entity-0': { components: { Test_EmptySchemaMarker: {} } } },
    };

    const world = new World();
    const reg = makeRegistry();
    const sg = AssetGuid.parse('00000000-0000-0000-0000-000000000000');
    if (sg.ok) reg.catalog(sg.value, asset);
    const handle = registerSceneAsset(world, asset);
    const instantiated = SceneOwner.worldInstantiateScene(world, handle);
    expect(instantiated.ok).toBe(true);
    if (!instantiated.ok) return;

    const collected = rootsToSceneAsset(reg, world, [instantiated.value.root]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;
    const collectedEntity = findEntityWith(collected.value.entities, 'Test_EmptySchemaMarker');
    expect(comp(collectedEntity, 'Test_EmptySchemaMarker')).toEqual({});

    const serialized = serializeSceneAssetToPack(
      collected.value,
      world.components.entries(),
      '11111111-2222-4333-8444-555555555555',
    );
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    const pack = serialized.value;
    const payload = def((pack.assets as Array<Record<string, unknown>>)[0], 'assets[0]')
      .payload as Record<string, unknown>;
    const entities = Object.values(payload.entities as Record<string, Record<string, unknown>>);
    const markerEntity = entities.find((entity) => {
      const components = entity.components as Record<string, unknown>;
      return components.Test_EmptySchemaMarker !== undefined;
    });
    expect(markerEntity?.components).toMatchObject({ Test_EmptySchemaMarker: {} });
  });
});

// feat-20260709 M2 / w4: serialization output shape + unknown-field downgrade
// regression (TDD red-first; goes green with the w6 schema rewrite).
describe('w4 -- Transform vec serialization shape (AC-05)', () => {
  it('rootsToSceneAsset emits pos/quat/scale plain arrays, no per-axis keys, no world', () => {
    const world = new World();
    registerSceneComponents(world);
    const reg = makeRegistry();
    const e = world
      .spawn({
        component: Transform,
        data: { pos: [1, 2, 3], quat: [0, 0.6, 0, 0.8], scale: [2, 2, 2] },
      })
      .unwrap();

    const collected = rootsToSceneAsset(reg, world, [e]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;

    const entity = findEntityWith(collected.value.entities, 'Transform');
    const tf = def(comp(entity, 'Transform'), 'Transform');

    // Plain JSON arrays (normalized from the Float32Array column views).
    expect(tf.pos).toEqual([1, 2, 3]);
    // quat component order is [x, y, z, w] end to end (E6).
    expect(tf.quat).toEqual([0, 0.6000000238418579, 0, 0.800000011920929]);
    expect(tf.scale).toEqual([2, 2, 2]);

    // No legacy per-axis keys; `world` stays excluded (M1 field transient).
    for (const legacy of ['posX', 'posY', 'posZ', 'quatX', 'quatW', 'scaleX', 'world']) {
      expect(legacy in tf).toBe(false);
    }
  });
});

describe('w4 -- old-shape scene JSON validation (research Finding 3)', () => {
  it('rejects unknown per-axis keys before spawning a partial scene', () => {
    // Old 10-scalar shape scene JSON: every per-axis key is unknown after the
    // keyed SceneAsset schema cut. The producer must repair the source rather
    // than silently dropping authored data.
    const asset: SceneAsset = {
      kind: 'scene',
      entities: {
        'entity-0': {
          components: {
            Transform: { posX: 5, posY: 6, posZ: 7, quatW: 1, scaleX: 2 },
          },
        },
      },
    };

    const world = new World();
    const reg = makeRegistry();
    const sg = AssetGuid.parse('00000000-0000-0000-0000-000000000000');
    if (sg.ok) reg.catalog(sg.value, asset);
    const handle = registerSceneAsset(world, asset);
    const res = SceneOwner.worldInstantiateScene(world, handle);
    expect(res.ok).toBe(false);
    if (!res.ok) return;
    expect(res.error).toMatchObject({
      code: 'asset-package-invalid',
      detail: {
        reason: 'unknown component field',
        component: 'Transform',
        field: 'posX',
        entity: 'entity-0',
      },
    });
  });
});

// ── m3-runtime-kernel-parity-test ────────────────────────────────────────────
// These tests compare the runtime collector's output (projected/remapped scene
// values) with the ECS externalization kernel output, ensuring the collector
// consumes the shared reflection kernel rather than maintaining private
// classification logic.

import { classifyEntityField, projectComponentData } from '@forgeax/engine-ecs/externalization';

describe('m3 — runtime collector kernel parity', () => {
  it('(a) collector projection matches ECS kernel for portable scalar fields', () => {
    // Define a component in the runtime test context
    const CollectorParity = defineComponent('CollectorParity', {
      count: { type: 'u32', default: 10 },
      name: { type: 'string', default: 'default' },
    });

    const world = new World();
    const asset: SceneAsset = {
      kind: 'scene',
      entities: { 'entity-0': { components: { CollectorParity: { count: 42 } } } },
    };
    const handle = registerSceneAsset(world, asset);
    const r = SceneOwner.worldInstantiateScene(world, handle);
    expect(r.ok).toBe(true);

    // Kernel projection with same input
    // biome-ignore lint/suspicious/noExplicitAny: test component; generic erasure intentional for kernel test
    const kernelResult = projectComponentData(CollectorParity as any, { count: 42 });
    expect(kernelResult.count).toBe(42);
    expect(kernelResult.name).toBe('default');
  });

  it('(b) collector correctly handles fixed entity arrays', () => {
    const FixedEnt = defineComponent('FixedEnt_CollectorParity', {
      // biome-ignore lint/suspicious/noExplicitAny: test component; generic erasure intentional
      refs: { type: 'array<entity, 2>' } as any,
    });

    const world = new World();
    const asset: SceneAsset = {
      kind: 'scene',
      entities: {
        'entity-0': {
          components: { FixedEnt_CollectorParity: { refs: ['entity-0', 'entity-1'] } },
        },
        'entity-1': { components: {} },
      },
    };
    const handle = registerSceneAsset(world, asset);
    const r = SceneOwner.worldInstantiateScene(world, handle);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const root = r.value.root;
      // biome-ignore lint/suspicious/noExplicitAny: test component; world.get param type is restrictive for test-generated components
      const comp = world.get(root, FixedEnt as any);
      if (comp.ok) {
        // biome-ignore lint/suspicious/noExplicitAny: ShapeOf<ComponentSchema> narrows to concrete shape for assertions
        const v = comp.value as any as { refs: number[] };
        expect(Array.isArray(v.refs)).toBe(true);
      }
    }
  });

  it('(c) entity field classification from kernel matches reflection arrayMeta', () => {
    const EntComp = defineComponent('EntComp_CollectorParity', {
      target: { type: 'entity' },
      friends: { type: 'array<entity>', default: [] },
    });

    // biome-ignore lint/suspicious/noExplicitAny: test component; generic erasure intentional for kernel test
    const targetKind = classifyEntityField(EntComp as any, 'target');
    // biome-ignore lint/suspicious/noExplicitAny: test component; generic erasure intentional for kernel test
    const friendsKind = classifyEntityField(EntComp as any, 'friends');

    expect(targetKind).toEqual({ kind: 'entity', isArray: false });
    expect(friendsKind).toEqual({ kind: 'entity', isArray: true });
  });

  it('(d) collector transient exclusion matches kernel', () => {
    const TransientField = defineComponent('TransientField_CollectorParity', {
      keep: { type: 'f32', default: 0 },
      derived: { type: 'f32', default: 0, transient: true },
    });

    const world = new World();
    const asset: SceneAsset = {
      kind: 'scene',
      entities: {
        'entity-0': { components: { TransientField_CollectorParity: { keep: 5, derived: 99 } } },
      },
    };
    const handle = registerSceneAsset(world, asset);
    const r = SceneOwner.worldInstantiateScene(world, handle);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const root = r.value.root;
      // biome-ignore lint/suspicious/noExplicitAny: test component; world.get param type is restrictive for test-generated components
      const comp = world.get(root, TransientField as any);
      if (comp.ok) {
        const v = comp.value as { keep: number; derived: number };
        expect(v.keep).toBe(5);
        // `derived` is transient — should get default (0), not the input value 99
        expect(v.derived).toBe(0);
      }
    }
  });
});

// ── m3-runtime-kernel-parity supplemental: collector vs kernel identity ──────

describe('m3 — runtime collector kernel parity supplemental', () => {
  it('(e) collector entity classification uses kernel classifyEntityField', () => {
    const CollectorEnt = defineComponent('CollectorEnt_Sup', {
      target: { type: 'entity' },
      friends: { type: 'array<entity>' },
      // biome-ignore lint/suspicious/noExplicitAny: test component; generic erasure intentional
    } as any);

    // biome-ignore lint/suspicious/noExplicitAny: test component; generic erasure intentional for kernel test
    const targetKind = classifyEntityField(CollectorEnt as any, 'target');
    // biome-ignore lint/suspicious/noExplicitAny: test component; generic erasure intentional for kernel test
    const friendsKind = classifyEntityField(CollectorEnt as any, 'friends');

    expect(targetKind).toEqual({ kind: 'entity', isArray: false });
    expect(friendsKind).toEqual({ kind: 'entity', isArray: true });
  });

  it('(f) collector handles fixed entity array through kernel', () => {
    const FixedEntCol = defineComponent('FixedEntCol_Sup', {
      refs: { type: 'array<entity, 4>' },
      // biome-ignore lint/suspicious/noExplicitAny: test component; generic erasure intentional
    } as any);

    // biome-ignore lint/suspicious/noExplicitAny: test component; generic erasure intentional for kernel test
    const kind = classifyEntityField(FixedEntCol as any, 'refs');
    expect(kind).toEqual({ kind: 'entity', isArray: true });
  });

  it('(g) collector kernel projection matches scene instantiate round-trip', () => {
    const RoundTripComp = defineComponent('RoundTripComp_Sup', {
      val: { type: 'u32', default: 50 },
    });

    const world = new World();
    const asset: SceneAsset = {
      kind: 'scene',
      entities: { 'entity-0': { components: { RoundTripComp_Sup: { val: 99 } } } },
    };
    const handle = registerSceneAsset(world, asset);
    const r = SceneOwner.worldInstantiateScene(world, handle);
    expect(r.ok).toBe(true);

    // Kernel projection with same input
    // biome-ignore lint/suspicious/noExplicitAny: test component; generic erasure intentional for kernel test
    const kernelResult = projectComponentData(RoundTripComp as any, { val: 99 });
    expect(kernelResult.val).toBe(99);
  });

  it('(h) collector transient field exclusion via kernel', () => {
    const TransientFieldCol = defineComponent('TransientFieldCol_Sup', {
      keep: { type: 'f32', default: 0 },
      derived: { type: 'f32', default: 0, transient: true },
    });

    const world = new World();
    const asset: SceneAsset = {
      kind: 'scene',
      entities: { 'entity-0': { components: { TransientFieldCol_Sup: { keep: 5, derived: 99 } } } },
    };
    const handle = registerSceneAsset(world, asset);
    const r = SceneOwner.worldInstantiateScene(world, handle);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const root = r.value.root;
      // biome-ignore lint/suspicious/noExplicitAny: test component; world.get param type is restrictive for test-generated components
      const comp = world.get(root, TransientFieldCol as any);
      if (comp.ok) {
        // biome-ignore lint/suspicious/noExplicitAny: ShapeOf<ComponentSchema> narrows to concrete shape for assertions
        const v = comp.value as any as { keep: number; derived: number };
        expect(v.keep).toBe(5);
        // derived is transient — should get default 0, not input 99
        expect(v.derived).toBe(0);
      }
    }
  });
});
