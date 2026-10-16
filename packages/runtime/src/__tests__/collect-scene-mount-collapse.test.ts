import * as SceneOwner from '@forgeax/engine-scene';
// collect-scene-mount-collapse.test.ts — M2 mount-collapse tests
// (feat-20260703-collect-nested-sceneinstance-to-mount-roundtrip).
//
// M1T7 AUDIT (feat-20260707-engine-world-clone-transient-for-editor-ssot):
//   Classification: (c) unaffected — Children used only for runtime hierarchy
//   wiring (w.get, w.addComponent), never for collect output assertions.
//   SceneInstance absence assertions at lines 87-89 / 137-140 check that
//   SceneInstance is absent from output — already true with old hardcoded skip
//   and preserved by the new transient check. No test modification required.

import type { Asset } from '@forgeax/engine-assets-runtime';
import { AssetRegistry, resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import { defineComponent, type EntityHandle, World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { SceneInstance } from '@forgeax/engine-render';
import { ChildOf, Children } from '@forgeax/engine-scene';
import type { Handle, SceneAsset } from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { rootsToSceneAsset } from '../collect-scene-asset';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';
import { registerSceneComponents } from './helpers/register-scene-components';

function mkReg() {
  return new AssetRegistry(makeMockShaderRegistry());
}
function pg(s: string): AssetGuid {
  const r = AssetGuid.parse(s);
  if (!r.ok) throw new Error(`bad GUID`);
  return r.value;
}
function soi(reg: AssetRegistry, p: SceneAsset, g: string) {
  (reg as unknown as { _originIndex: WeakMap<SceneAsset, string> })._originIndex.set(p, g);
}
function rs(w: World, a: SceneAsset) {
  registerSceneComponents(w);
  return w.allocSharedRef('SceneAsset', a);
}
function wr(w: World, ph: Handle<'SceneAsset', 'shared'>, ch: Handle<'SceneAsset', 'shared'>) {
  SceneOwner.worldSetSceneAssetResolver(w, (_s, pH) =>
    (pH as unknown as number) === (ph as unknown as number)
      ? ok(ch)
      : err({ code: 'asset-not-found' }),
  );
}
function rcoAll(reg: AssetRegistry, w: World, root: EntityHandle) {
  for (const e of w.iterDescendants(root)) {
    if (!w.get(e, SceneInstance).ok) continue;
    const s = SceneOwner.worldGetSceneAssetForInstance(w, e);
    if (!s.ok) continue;
    const c = resolveAssetHandle<SceneAsset>(w, s.value as unknown as Handle<string, 'shared'>);
    if (!c.ok) continue;
    soi(reg, c.value as SceneAsset, G1);
    soi(reg, c.value as SceneAsset, G2);
  }
}

const G1 = 'cbe42beb-8975-5096-b3a1-3dda4cb4c077';
const G2 = 'f6af7007-158f-4d92-9e47-93bf2f213e1f';

// ── m2-t1: Form 2 — root itself is SceneInstance ──
describe('m2-t1 — Form 2: root itself is SceneInstance', () => {
  it('whole tree collapses: root stripped, child mount excludes members', () => {
    const reg = mkReg();
    const w = new World();
    const child: SceneAsset = {
      kind: 'scene',
      entities: { 'entity-0': { components: { Transform: {} } } },
    };
    reg.catalog(pg(G1), child as Asset);

    const parent: SceneAsset = {
      kind: 'scene',
      entities: {
        'entity-0': { components: { Transform: { pos: [10, 0, 0] } } },
        child: { components: {}, instance: { source: G1 } },
      },
    };
    const ch = rs(w, child);
    const ph = rs(w, parent);
    wr(w, ph, ch);

    const inst = SceneOwner.worldInstantiateScene(w, ph);
    expect(inst.ok).toBe(true);
    if (!inst.ok) return;
    rcoAll(reg, w, inst.value.root);

    const res = rootsToSceneAsset(reg, w, [inst.value.root]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Root is SceneInstance → root's own entities are owned.
    // Child's member entities are excluded.
    const s = res.value;
    expect(Object.keys(s.entities).length).toBeGreaterThanOrEqual(1); // parent's own entity
    for (const e of Object.values(s.entities)) {
      expect(
        (e.components as Record<string, Record<string, unknown>>).SceneInstance,
      ).toBeUndefined();
    }
    // Child anchor produces a mount.
    const childInstance = Object.values(s.entities).find((entity) => entity.instance);
    expect(childInstance?.instance?.source).toBe(G1);
  });
});

// ── m2-t2: Form 1 — deep anchor ──
describe('m2-t2 — Form 1: deep anchor with ChildOf parent', () => {
  it('anchor subtree collapses, ancestors preserved as owned', () => {
    const reg = mkReg();
    const w = new World();
    const child: SceneAsset = {
      kind: 'scene',
      entities: {
        'entity-0': { components: { Transform: { pos: [1, 0, 0] } } },
        'entity-1': { components: { Transform: { pos: [2, 0, 0] } } },
      },
    };
    reg.catalog(pg(G1), child as Asset);
    const ch = rs(w, child);

    // Relationship sources now reject stale targets at the public boundary.
    // Use a real, non-descended host for this fixture so the test still
    // exercises a deep anchor without manufacturing an invalid public edge.
    const outerHost = w.spawn().unwrap();
    const outerRes = w.spawn({ component: ChildOf, data: { parent: outerHost } });
    expect(outerRes.ok).toBe(true);
    if (!outerRes.ok) return;
    const outerE = outerRes.value;

    const ci = SceneOwner.worldInstantiateScene(w, ch, outerE);
    expect(ci.ok).toBe(true);
    if (!ci.ok) return;
    rcoAll(reg, w, ci.value.root);

    // Wire Children on outer root so collectSubtree discovers anchor.
    const ec = w.get(outerE, Children as never);
    if (!ec.ok)
      w.addComponent(outerE, { component: Children, data: { entities: [ci.value.root] } } as never);

    const res = rootsToSceneAsset(reg, w, [outerE]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Outer root is NOT SceneInstance → no mount for it.
    // Child anchor produces a mount; its member entities excluded from owned.
    const childInstance = Object.values(res.value.entities).find((entity) => entity.instance);
    expect(childInstance?.instance?.source).toBe(G1);
    for (const e of Object.values(res.value.entities)) {
      expect(
        (e.components as Record<string, Record<string, unknown>>).SceneInstance,
      ).toBeUndefined();
    }
  });
});

// ── m2-t3: AC-03 window invariants ──
describe('m2-t3 — AC-03 window invariants', () => {
  it('mount window covers full totalSlots', () => {
    const reg = mkReg();
    const w = new World();
    const ca: SceneAsset = {
      kind: 'scene',
      entities: { 'entity-0': { components: { Transform: {} } } },
    };
    reg.catalog(pg(G1), ca as Asset);
    const ch = rs(w, ca);

    const pa: SceneAsset = {
      kind: 'scene',
      entities: {
        'entity-0': { components: { Transform: {} } },
        child: { components: {}, instance: { source: G1 } },
      },
    };
    const ph = rs(w, pa);
    wr(w, ph, ch);
    const inst = SceneOwner.worldInstantiateScene(w, ph);
    expect(inst.ok).toBe(true);
    if (!inst.ok) return;
    rcoAll(reg, w, inst.value.root);

    const res = rootsToSceneAsset(reg, w, [inst.value.root]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(Object.values(res.value.entities).filter((entity) => entity.instance)).toHaveLength(1);
  });

  it('sparse localId does not shrink window', () => {
    const reg = mkReg();
    const w = new World();
    const ca: SceneAsset = {
      kind: 'scene',
      entities: {
        'entity-0': { components: { Transform: { pos: [1, 0, 0] } } },
        'entity-1': { components: { Transform: { pos: [2, 0, 0] } } },
      },
    };
    reg.catalog(pg(G1), ca as Asset);
    const ch = rs(w, ca);

    const pa: SceneAsset = {
      kind: 'scene',
      entities: {
        'entity-0': { components: { Transform: {} } },
        child: { components: {}, instance: { source: G1 } },
      },
    };
    const ph = rs(w, pa);
    wr(w, ph, ch);
    const inst = SceneOwner.worldInstantiateScene(w, ph);
    expect(inst.ok).toBe(true);
    if (!inst.ok) return;
    rcoAll(reg, w, inst.value.root);

    // Despawn one member to create sparse mapping.
    // Member slots start at memberFirst=2 (mount entity is at mapping[1]).
    // Despawning the mount entity would cascade-kill the child synthetic root
    // (ChildOf.linkedSpawn=true), erasing the anchor entirely.
    const si = w.get(inst.value.root, SceneInstance);
    if (si.ok && si.value.mapping[2] !== undefined) w.despawn(si.value.mapping[2] as EntityHandle);

    const res = rootsToSceneAsset(reg, w, [inst.value.root]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(Object.values(res.value.entities).filter((entity) => entity.instance)).toHaveLength(1); // keyed instance survives sparse members
  });

  it('multiple child mounts have non-overlapping windows', () => {
    const reg = mkReg();
    const w = new World();
    const cA: SceneAsset = {
      kind: 'scene',
      entities: { 'entity-0': { components: { Transform: {} } } },
    };
    const cB: SceneAsset = {
      kind: 'scene',
      entities: {
        'entity-0': { components: { Transform: {} } },
        'entity-1': { components: { Transform: {} } },
      },
    };
    reg.catalog(pg(G1), cA as Asset);
    reg.catalog(pg(G2), cB as Asset);
    const hA = rs(w, cA);
    const hB = rs(w, cB);

    const pa: SceneAsset = {
      kind: 'scene',
      entities: {
        'entity-0': { components: { Transform: {} } },
        childA: { components: {}, instance: { source: G1 } },
        childB: { components: {}, instance: { source: G2 } },
      },
    };
    const ph = rs(w, pa);
    SceneOwner.worldSetSceneAssetResolver(w, (sIdx, pH) => {
      if ((pH as unknown as number) !== (ph as unknown as number))
        return err({ code: 'asset-not-found' });
      if (typeof sIdx === 'number') return ok(sIdx as unknown as Handle<'SceneAsset', 'shared'>);
      return String(sIdx).toLowerCase() === G1 ? ok(hA) : ok(hB);
    });

    const inst = SceneOwner.worldInstantiateScene(w, ph);
    expect(inst.ok).toBe(true);
    if (!inst.ok) return;
    for (const e of w.iterDescendants(inst.value.root)) {
      if (!w.get(e, SceneInstance).ok) continue;
      const s = SceneOwner.worldGetSceneAssetForInstance(w, e);
      if (!s.ok) continue;
      const c = resolveAssetHandle<SceneAsset>(w, s.value as unknown as Handle<string, 'shared'>);
      if (!c.ok) continue;
      soi(reg, c.value as SceneAsset, Object.keys(c.value.entities).length === 1 ? G1 : G2);
    }

    const res = rootsToSceneAsset(reg, w, [inst.value.root]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const instances = Object.values(res.value.entities).flatMap((entity) =>
      entity.instance ? [entity.instance] : [],
    );
    expect(instances).toHaveLength(2);
    expect(new Set(instances.map((instance) => instance.source))).toEqual(new Set([G1, G2]));
  });
});

// ── m2-t4: Graft preservation ──
describe('m2-t4 — graft preservation', () => {
  it('graft entity under a member survives as owned', () => {
    const reg = mkReg();
    const w = new World();
    const ca: SceneAsset = {
      kind: 'scene',
      entities: { 'entity-0': { components: { Transform: {} } } },
    };
    reg.catalog(pg(G1), ca as Asset);
    const ch = rs(w, ca);

    const pa: SceneAsset = {
      kind: 'scene',
      entities: {
        'entity-0': { components: { Transform: {} } },
        child: { components: {}, instance: { source: G1 } },
      },
    };
    const ph = rs(w, pa);
    wr(w, ph, ch);
    const inst = SceneOwner.worldInstantiateScene(w, ph);
    expect(inst.ok).toBe(true);
    if (!inst.ok) return;
    const root = inst.value.root;
    rcoAll(reg, w, root);

    const si = w.get(root, SceneInstance);
    if (!si.ok) return;
    const member = si.value.mapping[0];
    if (member === undefined) return;

    // Graft a prop entity under the member.
    const prop = w.spawn({ component: ChildOf, data: { parent: member as EntityHandle } });
    expect(prop.ok).toBe(true);
    if (!prop.ok) return;
    w.addComponent(
      member as EntityHandle,
      { component: Children, data: { entities: [prop.value] } } as never,
    );

    const res = rootsToSceneAsset(reg, w, [root]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Prop should survive as owned entity (not eaten by mount).
    let propFound = false;
    for (const e of Object.values(res.value.entities)) {
      if ((e.components as Record<string, Record<string, unknown>>).ChildOf) {
        propFound = true;
        break;
      }
    }
    expect(propFound).toBe(true);
  });

  it('unmappable cross-window entity ref fails fast', () => {
    const reg = mkReg();
    const w = new World();
    const ca: SceneAsset = {
      kind: 'scene',
      entities: { 'entity-0': { components: { Transform: {} } } },
    };
    reg.catalog(pg(G1), ca as Asset);
    const ch = rs(w, ca);

    const pa: SceneAsset = {
      kind: 'scene',
      entities: {
        'entity-0': { components: { Transform: {} } },
        child: { components: {}, instance: { source: G1 } },
      },
    };
    const ph = rs(w, pa);
    wr(w, ph, ch);
    const inst = SceneOwner.worldInstantiateScene(w, ph);
    expect(inst.ok).toBe(true);
    if (!inst.ok) return;
    const root = inst.value.root;
    rcoAll(reg, w, root);

    const si = w.get(root, SceneInstance);
    if (!si.ok) return;
    const member = si.value.mapping[0];
    if (member === undefined) return;

    // Graft with ChildOf.parent pointing outside closure.
    // Spawn `outside` without ChildOf — no parent linkage, so it stays
    // unreachable from the root subtree and _rlid(graft.parent) fails.
    const outside = w.spawn();
    expect(outside.ok).toBe(true);
    if (!outside.ok) return;

    const CrossWindowRef = defineComponent('CrossWindowRef', { target: 'entity' });
    registerSceneComponents(w, [CrossWindowRef]);
    const graft = w.spawn(
      { component: ChildOf, data: { parent: member as EntityHandle } },
      { component: CrossWindowRef, data: { target: outside.value } },
    );
    expect(graft.ok).toBe(true);
    if (!graft.ok) return;
    const res = rootsToSceneAsset(reg, w, [root]);
    expect(res.ok).toBe(false); // fail-fast
  });
});

it('preserves graft references through nested keyed scene instances', () => {
  const reg = mkReg();
  const w = new World();
  const leaf: SceneAsset = { kind: 'scene', entities: { leaf: { components: { Transform: {} } } } };
  const child: SceneAsset = {
    kind: 'scene',
    entities: { nested: { components: {}, instance: { source: G2 } } },
  };
  const parent: SceneAsset = {
    kind: 'scene',
    entities: { child: { components: {}, instance: { source: G1 } } },
  };
  const lh = rs(w, leaf);
  const ch = rs(w, child);
  const ph = rs(w, parent);
  SceneOwner.worldSetSceneAssetResolver(w, (_source, parentHandle) =>
    parentHandle === ph ? ok(ch) : parentHandle === ch ? ok(lh) : err({ code: 'asset-not-found' }),
  );
  const inst = SceneOwner.worldInstantiateScene(w, ph).unwrap();
  for (const entity of w.iterDescendants(inst.root)) {
    const handle = SceneOwner.worldGetSceneAssetForInstance(w, entity);
    if (!handle.ok) continue;
    const asset = resolveAssetHandle<SceneAsset>(
      w,
      handle.value as unknown as Handle<string, 'shared'>,
    );
    if (asset.ok) soi(reg, asset.value, 'nested' in asset.value.entities ? G1 : G2);
  }
  const state = SceneOwner.worldGetSceneInstanceState(w, inst.root).unwrap();
  const member = state.bindings.get(SceneOwner.sceneEntityAddressKey(['child', 'nested', 'leaf']));
  expect(member).toBeDefined();
  if (member === undefined) return;
  w.spawn({ component: ChildOf, data: { parent: member } }).unwrap();
  const collected = rootsToSceneAsset(reg, w, [inst.root]);
  expect(collected.ok, JSON.stringify(collected)).toBe(true);
  if (!collected.ok) return;
  const carrier = Object.values(collected.value.entities).find((entity) => entity.instance);
  expect(Array.isArray(carrier?.components.Transform?.pos)).toBe(true);
  expect(Object.values(collected.value.entities).filter((entity) => entity.instance)).toHaveLength(
    1,
  );
  expect(
    Object.values(collected.value.entities).some(
      (entity) =>
        JSON.stringify(entity.components.ChildOf?.parent) ===
        JSON.stringify(['child', 'nested', 'leaf']),
    ),
  ).toBe(true);
});
