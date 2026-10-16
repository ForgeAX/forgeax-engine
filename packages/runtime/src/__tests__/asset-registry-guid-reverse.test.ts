import * as SceneOwner from '@forgeax/engine-scene';

// asset-registry-guid-reverse.test.ts — M1 origin-index reverse-lookup TDD
// (feat-20260703-collect-nested-sceneinstance-to-mount-roundtrip).
//
// m1-t1: HIT path — after catalog + AssetRegistry.instantiate, the resolved
//   copy payload is reachable via world.getSceneAssetForInstance +
//   resolveAssetHandle, and _guidForAsset(copy) should return the original
//   catalog GUID (currently RED — Finding 1 MISS).
//
// m1-t2: MISS path — an uncatalogued, hand-assembled SceneAsset
//   allocated via world.allocSharedRef and instantiated still returns
//   undefined from _guidForAsset (AC-05 structural error path); also
//   rootsToSceneAsset on uncatalogued shared refs produces
//   SceneCollectAssetGuidUnresolvedError with complete .code / .expected /
//   .hint / .detail fields.

import {
  type Asset,
  AssetRegistry,
  HANDLE_CUBE,
  resolveAssetHandle,
  SceneCollectAssetGuidUnresolvedError,
} from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { MeshFilter, MeshRenderer, SceneInstance } from '@forgeax/engine-render';
import type {
  AnimationClip,
  Handle,
  MaterialAsset,
  MeshAsset,
  SceneAsset,
} from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { rootsToSceneAsset } from '../collect-scene-asset';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';
import { registerSceneComponents } from './helpers/register-scene-components';

function makeReg(): AssetRegistry {
  return new AssetRegistry(makeMockShaderRegistry());
}

function prepareWorld(world: World): void {
  registerSceneComponents(world, [MeshFilter, MeshRenderer]);
}

function cubeMesh(): MeshAsset {
  const r = createBoxGeometry(1, 1, 1);
  if (!r.ok) throw new Error('createBoxGeometry(1,1,1) failed');
  return r.value;
}

function unlitMaterial(): MaterialAsset {
  return {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::default-unlit' },
        renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
      },
    ],
    values: { baseColor: [1, 1, 1] },
  } as MaterialAsset;
}

/** Walk a SceneInstance subtree and return the first live MeshRenderer.materials[0]. */
function firstLiveMaterialHandle(world: World, root: Handle<string, 'shared'>): number | undefined {
  for (const c of world.iterDescendants(root as never)) {
    const mr = world.get(c, MeshRenderer);
    if (!mr.ok) continue;
    const mats = mr.value.materials as unknown as number[];
    if (mats && mats.length > 0 && (mats[0] as number) !== 0) return mats[0] as number;
  }
  return undefined;
}

function makeScene(entities?: SceneAsset['entities']): SceneAsset {
  return {
    kind: 'scene',
    entities: entities ?? { 'entity-0': { components: { Transform: {} } } },
  };
}

const GUID_A = 'cbe42beb-8975-5096-b3a1-3dda4cb4c077';

function parseGuid(s: string): AssetGuid {
  const r = AssetGuid.parse(s);
  if (!r.ok) throw new Error(`invalid test GUID: ${s}`);
  return r.value;
}

// ── m1-t1: HIT path ─────────────────────────────────────────────────────

describe('m1-t1 — origin index reverse-lookup HIT', () => {
  it('_guidForAsset on instantiate-resolved copy returns the original catalog GUID', () => {
    const reg = makeReg();
    const world = new World();
    prepareWorld(world);

    // Catalog the scene asset.
    const scene = makeScene();
    reg.catalog(parseGuid(GUID_A), scene);

    // Allocate a shared ref from the world (the column-handle path).
    const handle = world.allocSharedRef<'SceneAsset', SceneAsset>('SceneAsset', scene);

    // Instantiate via AssetRegistry.
    const instRes = reg.instantiate(handle, world);
    expect(instRes.ok).toBe(true);
    if (!instRes.ok) return;
    const root = instRes.value;

    // Get the SceneInstance's source handle and resolve to payload.
    const srcHandleRes = SceneOwner.worldGetSceneAssetForInstance(world, root);
    expect(srcHandleRes.ok).toBe(true);
    if (!srcHandleRes.ok) return;
    const srcHandle = srcHandleRes.value;

    const payloadRes = resolveAssetHandle<SceneAsset>(
      world,
      srcHandle as unknown as Handle<string, 'shared'>,
    );
    expect(payloadRes.ok).toBe(true);
    if (!payloadRes.ok) return;
    const copyPayload = payloadRes.value;

    // The copy is a different object from the catalogued original
    // (_resolveSceneGuids produces a deep copy).
    expect(copyPayload).not.toBe(scene);

    // Should return the catalog GUID after m1-i1; currently RED (undefined).
    const guid = reg._guidForAsset(copyPayload as Asset);
    expect(guid).toBe(GUID_A);
  });
});

// ── m1-t2: MISS path ────────────────────────────────────────────────────

describe('m1-t2 — uncatalogued scene MISS path', () => {
  it('_guidForAsset on uncatalogued payload returns undefined', () => {
    const reg = makeReg();
    const scene = makeScene();

    // Never catalogued; just allocate a shared ref directly.
    const guid = reg._guidForAsset(scene as Asset);
    expect(guid).toBeUndefined();
  });

  it('rootsToSceneAsset on uncatalogued shared ref fails with SceneCollectAssetGuidUnresolvedError', () => {
    const reg = makeReg();
    const world = new World();
    prepareWorld(world);

    // Construct a scene with an entity that carries a shared<> field
    // referencing an uncatalogued MeshAsset (never catalogued).
    // world.allocSharedRef for the MeshAsset creates a user-tier handle,
    // but _guidForAsset has no catalogue entry for it.
    const mesh: Asset = {
      kind: 'mesh',
      vertices: new Float32Array(12 * 3),
      indices: new Uint16Array([0, 1, 2]),
    } as unknown as Asset;

    const meshHandle = world.allocSharedRef('MeshAsset', mesh);
    const asset: SceneAsset = {
      kind: 'scene',
      entities: {
        'entity-0': {
          components: {
            MeshFilter: { assetHandle: meshHandle as never },
            Transform: {},
          },
        },
      },
    };

    // Allocate shared ref for the scene and instantiate.
    const sceneHandle = world.allocSharedRef<'SceneAsset', SceneAsset>('SceneAsset', asset);
    const instRes = SceneOwner.worldInstantiateScene(world, sceneHandle);
    expect(instRes.ok).toBe(true);
    if (!instRes.ok) return;
    const root = instRes.value.root;

    // rootsToSceneAsset should fail-fast with the structured error.
    const res = rootsToSceneAsset(reg, world, [root]);
    expect(res.ok).toBe(false);
    if (res.ok) return;

    const err = res.error;
    expect(err).toBeInstanceOf(SceneCollectAssetGuidUnresolvedError);
    expect(err.code).toBe('scene-collect-asset-guid-unresolved');
    expect(typeof err.expected).toBe('string');
    expect(err.expected.length).toBeGreaterThan(0);
    expect(typeof err.hint).toBe('string');
    expect(err.hint.length).toBeGreaterThan(0);
    expect(err.detail).toBeDefined();
    expect(typeof err.detail.field).toBe('string');
    // detail.handle is optional on SceneCollectAssetGuidUnresolvedDetail;
    // the collect path emits handle (not guid).
    const detail = err.detail as { field: string; handle?: number; guid?: string };
    expect(typeof detail.handle).toBe('number');
  });
});

describe('builtin reverse lookup ownership', () => {
  it('collects a builtin mesh GUID without cataloguing the process-static payload', () => {
    const registry = { guidOf: () => undefined };
    const world = new World();
    prepareWorld(world);
    const scene: SceneAsset = {
      kind: 'scene',
      entities: {
        'entity-0': {
          components: {
            Transform: {},
            MeshFilter: { assetHandle: HANDLE_CUBE as never },
          },
        },
      },
    };
    const sceneHandle = world.allocSharedRef<'SceneAsset', SceneAsset>('SceneAsset', scene);
    const instantiated = SceneOwner.worldInstantiateScene(world, sceneHandle);
    expect(instantiated.ok).toBe(true);
    if (!instantiated.ok) return;

    const collected = rootsToSceneAsset(registry, world, [instantiated.value.root]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;
    const meshEntity = Object.values(collected.value.entities).find(
      (entity) => entity.components.MeshFilter !== undefined,
    );
    expect(meshEntity?.components.MeshFilter?.assetHandle).toBe(GUID_A);
  });
});

// ── w14 (M4) PROBE: mounted-scene-with-material identity anchor ──────────
//
// feat-20260713 M4 / w14 (D-6, probe-first). Empirically anchors the true
// root cause of the 2026-07-06 owned-payload reverse-lookup MISS
// (`2026-07-06-nested-mount-material-guid-unresolved-on-save.md`).
//
// research Finding 3 FALSIFIED the original feedback premise ("instantiate
// deep-copies material payload"): the mount path does NOT deep-copy material
// payloads — identity (===) is preserved end-to-end (allocSharedRef stores the
// reference, shared-ref-store.ts:159). The only object deep-copied is the
// SceneAsset envelope itself (already covered by `_originIndex`).
//
// The probe below runs both candidate scenarios live to pin the MISS to:
//   (a) catalog override after a handle was minted -> the already-minted handle
//       dangles at the SUPERSEDED payload object (asset-registry.ts:976 replaces
//       the envelope.payload with a fresh object). `_guidForAsset` identity scan
//       then finds only the NEW object; the old one is in neither the catalog
//       (by identity) nor `_originIndex` -> undefined MISS. THIS is the observed
//       2026-07-06 state ("catalog has content-matching but different objects").
//   (b) minting a handle from a non-catalog POD (glyph-text / tilemap systems) —
//       ruled out for the material-save flow: those POD payloads never enter the
//       catalog and are never saved through rootsToSceneAsset.
//
// PROBE CONCLUSION (run 2026-07-13): root cause is (a). The basic mount case
// (probe test 1) HITs — proving no deep-copy (Finding 3). The catalog-override
// case (probe test 2) MISSes — the anchored root cause. w15 fixes (a) by
// recording the SUPERSEDED payload -> GUID in `_originIndex` (key widened to
// `WeakMap<object,string>`) at the catalog-override point (asset-registry.ts:976),
// so `_guidForAsset` reverse-resolves handles minted before the override.

const MAT_GUID = '11111111-2222-4333-8444-555566667777';
const MESH_GUID = '00d274da-e863-41d8-bafe-10b97d1468d4';
const CHILD_GUID = '22222222-3333-4444-8555-666677778888';
const PARENT_GUID = '33333333-4444-4555-8666-777788889999';

describe('w14 M4 probe — owned payload identity anchor', () => {
  it('atomically adopts a recooked Mesh identity for old handles, repeat loads, and collect/save', async () => {
    const reg = makeReg();
    const world = new World();
    prepareWorld(world);
    expect(reg.catalog(parseGuid(MESH_GUID), cubeMesh() as Asset).ok).toBe(true);
    const liveMesh = reg.lookup<MeshAsset>(MESH_GUID);
    expect(liveMesh).toBeDefined();
    if (liveMesh === undefined) return;
    const oldHandle = world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', liveMesh);

    const livePositions = liveMesh.attributes.position;
    expect(livePositions).toBeInstanceOf(Float32Array);
    if (!(livePositions instanceof Float32Array)) return;
    const oldPosition = livePositions[0];
    expect(oldPosition).toBeDefined();
    if (oldPosition === undefined) return;
    const recooked = cubeMesh();
    const recookedPositions = recooked.attributes.position;
    expect(recookedPositions).toBeInstanceOf(Float32Array);
    if (!(recookedPositions instanceof Float32Array)) return;
    recookedPositions[0] = oldPosition + 10;
    Object.assign(recooked, { materialSlots: [{ slotName: 'Recooked' }] });
    expect(reg.catalog(parseGuid(MESH_GUID), recooked as Asset).ok).toBe(true);
    expect(reg.adoptReloadedMeshMaterialSlots(MESH_GUID, liveMesh as Asset).ok).toBe(true);

    const oldResolved = resolveAssetHandle<MeshAsset>(world, oldHandle);
    expect(oldResolved.ok).toBe(true);
    if (!oldResolved.ok) return;
    expect(oldResolved.value).toBe(liveMesh);
    expect(oldResolved.value.materialSlots).toEqual([{ slotName: 'Recooked' }]);
    expect(oldResolved.value.attributes.position).toBe(livePositions);
    expect(livePositions[0]).toBe(oldPosition);

    const repeated = await reg.loadByGuid<MeshAsset>(reg.parseGuid(MESH_GUID));
    expect(repeated.ok).toBe(true);
    if (!repeated.ok) return;
    expect(repeated.value).toBe(liveMesh);
    expect(reg._guidForAsset(repeated.value as Asset)).toBe(MESH_GUID);

    const newHandle = world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', repeated.value);
    const scene: SceneAsset = {
      kind: 'scene',
      entities: {
        'entity-0': {
          components: {
            Transform: {},
            MeshFilter: { assetHandle: newHandle as never },
            MeshRenderer: { materials: [] },
          },
        },
      },
    };
    const sceneHandle = world.allocSharedRef<'SceneAsset', SceneAsset>('SceneAsset', scene);
    const instantiated = SceneOwner.worldInstantiateScene(world, sceneHandle);
    expect(instantiated.ok).toBe(true);
    if (!instantiated.ok) return;
    const collected = rootsToSceneAsset(reg, world, [instantiated.value.root]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;
    expect(Object.values(collected.value.entities)).toContainEqual(
      expect.objectContaining({
        components: expect.objectContaining({
          MeshFilter: expect.objectContaining({ assetHandle: MESH_GUID }),
        }),
      }),
    );
  });

  it('basic mount preserves material payload identity end-to-end (research Finding 3)', () => {
    const reg = makeReg();
    const world = new World();
    prepareWorld(world);

    const mesh = cubeMesh();
    const mat = unlitMaterial();
    expect(reg.catalog(parseGuid(MESH_GUID), mesh as Asset).ok).toBe(true);
    expect(reg.catalog(parseGuid(MAT_GUID), mat as Asset).ok).toBe(true);

    // Child scene: one owned entity with a MeshRenderer whose materials[0] is a
    // GUID string (post-parse intermediate shape), catalogued with refs edges.
    const child: SceneAsset = {
      kind: 'scene',
      entities: {
        'entity-0': {
          components: {
            Transform: {},
            MeshFilter: { assetHandle: MESH_GUID as never },
            MeshRenderer: { materials: [MAT_GUID] as never },
          },
        },
      },
    };
    reg.catalog(parseGuid(CHILD_GUID), child as Asset, [{ guid: MESH_GUID }, { guid: MAT_GUID }]);

    const parent: SceneAsset = {
      kind: 'scene',
      entities: {
        'entity-0': { components: { Transform: {} } },
        child: { components: {}, instance: { source: CHILD_GUID } },
      },
    };
    reg.catalog(parseGuid(PARENT_GUID), parent as Asset);

    const ph = world.allocSharedRef<'SceneAsset', SceneAsset>('SceneAsset', parent);
    const inst = reg.instantiate(ph, world);
    expect(inst.ok).toBe(true);
    if (!inst.ok) return;

    // Confirm a child SceneInstance materialised (the owned material lives under it).
    let hasChildSi = false;
    for (const c of world.iterDescendants(inst.value)) {
      if (c === inst.value) continue;
      if (world.get(c, SceneInstance).ok) hasChildSi = true;
    }
    expect(hasChildSi).toBe(true);

    const matHandle = firstLiveMaterialHandle(
      world,
      inst.value as unknown as Handle<string, 'shared'>,
    );
    expect(matHandle).toBeDefined();
    if (matHandle === undefined) return;

    const liveRes = resolveAssetHandle<MaterialAsset>(
      world,
      matHandle as unknown as Handle<string, 'shared'>,
    );
    expect(liveRes.ok).toBe(true);
    if (!liveRes.ok) return;

    // Finding 3: the live handle payload IS the catalogued object (no deep-copy).
    const catalogPayload = reg.assetCatalog.get(MAT_GUID.toLowerCase())?.payload;
    expect(liveRes.value).toBe(catalogPayload);
    expect(liveRes.value).toBe(mat);

    // Reverse-lookup HITs via the catalog identity scan.
    expect(reg._guidForAsset(liveRes.value as Asset)).toBe(MAT_GUID);
  });

  it('catalog override leaves already-minted handle reverse-lookupable (root cause a)', () => {
    // Reproduces the anchored 2026-07-06 state: a handle is minted from the
    // catalogued material, then the SAME GUID is re-catalogued with a fresh
    // object (re-import / loadByGuid refetch). The live handle still points at
    // the FIRST object; the catalog now holds a DIFFERENT object.
    const reg = makeReg();
    const world = new World();
    prepareWorld(world);

    const mat1 = unlitMaterial();
    expect(reg.catalog(parseGuid(MAT_GUID), mat1 as Asset).ok).toBe(true);

    // Mint a handle from the first catalogued payload (instantiate mints from
    // envelope.payload — identity preserved at mint time).
    const handle = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', mat1);

    // Re-catalog the SAME GUID with a different object.
    const mat2 = unlitMaterial();
    expect(mat2).not.toBe(mat1);
    expect(reg.catalog(parseGuid(MAT_GUID), mat2 as Asset).ok).toBe(true);

    const liveRes = resolveAssetHandle<MaterialAsset>(
      world,
      handle as unknown as Handle<string, 'shared'>,
    );
    expect(liveRes.ok).toBe(true);
    if (!liveRes.ok) return;

    // The live handle dangles at the superseded object (root cause a).
    expect(liveRes.value).toBe(mat1);
    expect(liveRes.value).not.toBe(reg.assetCatalog.get(MAT_GUID.toLowerCase())?.payload);

    // DESIRED (RED until w15): reverse-lookup must still resolve the GUID for
    // the superseded-but-live payload — otherwise collect/save fails with a
    // GUID-unresolved error (the 2026-07-06 crash).
    expect(reg._guidForAsset(liveRes.value as Asset)).toBe(MAT_GUID);
  });
});

// ── w16 (M4) AC-08: reverse-lookup HIT across payload kinds ─────────────
//
// feat-20260713 M4 / w16 (AC-08). With w15's fix in place, the reverse-lookup
// (`_guidForAsset`) hits for both material and AnimationClip payloads across the
// re-catalog boundary, hits consistently for a payload referenced by many
// entities, and correctly returns undefined (leading to a structured collect
// error, never a silent zero) for a fresh copy that was never catalogued
// (requirements edge case "modified payload judged as a new asset").

const CLIP_GUID = '44444444-5555-4666-8777-888899990000';
const MAT_GUID_B = '55555555-6666-4777-8888-99990000aaaa';

function mkClip(duration: number): AnimationClip {
  return { kind: 'animation-clip', duration, channels: [] } as AnimationClip;
}

describe('w16 M4 — AC-08 reverse-lookup hit across kinds', () => {
  it('material payload GUID reverse-lookup hits across a catalog override', () => {
    const reg = makeReg();
    const world = new World();

    const mat1 = unlitMaterial();
    expect(reg.catalog(parseGuid(MAT_GUID), mat1 as Asset).ok).toBe(true);
    const handle = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', mat1);

    // Re-import: same GUID re-catalogued with a fresh object.
    expect(reg.catalog(parseGuid(MAT_GUID), unlitMaterial() as Asset).ok).toBe(true);

    const live = resolveAssetHandle<MaterialAsset>(
      world,
      handle as unknown as Handle<string, 'shared'>,
    );
    expect(live.ok).toBe(true);
    if (!live.ok) return;
    expect(reg._guidForAsset(live.value as Asset)).toBe(MAT_GUID);
  });

  it('AnimationClip payload GUID reverse-lookup hits across a catalog override', () => {
    const reg = makeReg();
    const world = new World();

    const clip1 = mkClip(1.5);
    expect(reg.catalog(parseGuid(CLIP_GUID), clip1 as Asset).ok).toBe(true);
    const handle = world.allocSharedRef<'AnimationClip', AnimationClip>('AnimationClip', clip1);

    expect(reg.catalog(parseGuid(CLIP_GUID), mkClip(1.5) as Asset).ok).toBe(true);

    const live = resolveAssetHandle<AnimationClip>(
      world,
      handle as unknown as Handle<string, 'shared'>,
    );
    expect(live.ok).toBe(true);
    if (!live.ok) return;
    expect(reg._guidForAsset(live.value as Asset)).toBe(CLIP_GUID);
  });

  it('same shared payload referenced by many entities reverse-looks-up to one GUID', () => {
    const reg = makeReg();
    const world = new World();

    // Two distinct catalogued materials, each minted once, then both overridden.
    const matA1 = unlitMaterial();
    const matB1 = unlitMaterial();
    expect(reg.catalog(parseGuid(MAT_GUID), matA1 as Asset).ok).toBe(true);
    expect(reg.catalog(parseGuid(MAT_GUID_B), matB1 as Asset).ok).toBe(true);

    // Mint several handles that all share matA1 (one shared payload, N refs) and
    // one handle sharing matB1.
    const hA1 = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', matA1);
    const hA2 = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', matA1);
    const hB1 = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', matB1);

    // Override both GUIDs (re-import).
    expect(reg.catalog(parseGuid(MAT_GUID), unlitMaterial() as Asset).ok).toBe(true);
    expect(reg.catalog(parseGuid(MAT_GUID_B), unlitMaterial() as Asset).ok).toBe(true);

    for (const h of [hA1, hA2]) {
      const live = resolveAssetHandle<MaterialAsset>(
        world,
        h as unknown as Handle<string, 'shared'>,
      );
      expect(live.ok).toBe(true);
      if (!live.ok) return;
      // All references to the same shared payload resolve to the same GUID.
      expect(reg._guidForAsset(live.value as Asset)).toBe(MAT_GUID);
    }

    const liveB = resolveAssetHandle<MaterialAsset>(
      world,
      hB1 as unknown as Handle<string, 'shared'>,
    );
    expect(liveB.ok).toBe(true);
    if (!liveB.ok) return;
    expect(reg._guidForAsset(liveB.value as Asset)).toBe(MAT_GUID_B);
  });

  it('a fresh copy that was never catalogued is judged a new asset (structured collect error, not silent zero)', () => {
    // Edge case: "deep-copied payload modified before collect -> judged a new
    // asset, structured error, never silently zeroed". A payload object that was
    // never the catalog identity (a fresh copy) reverse-looks-up to undefined,
    // and collect surfaces SceneCollectAssetGuidUnresolvedError — not a silent 0.
    const reg = makeReg();
    const world = new World();
    prepareWorld(world);

    const mesh = cubeMesh();
    const mat = unlitMaterial();
    expect(reg.catalog(parseGuid(MESH_GUID), mesh as Asset).ok).toBe(true);
    expect(reg.catalog(parseGuid(MAT_GUID), mat as Asset).ok).toBe(true);

    // A structurally-modified COPY (fresh object, never catalogued).
    const modifiedCopy: MaterialAsset = {
      ...mat,
      values: { baseColor: [0.2, 0.2, 0.2] },
    } as MaterialAsset;
    expect(modifiedCopy).not.toBe(mat);

    // reverse-lookup misses (correctly — it is a new asset, not the catalogued one).
    expect(reg._guidForAsset(modifiedCopy as Asset)).toBeUndefined();

    // Drive it through a real collect: mint the copy onto a MeshRenderer and
    // confirm collect fails with the STRUCTURED error (not a silent zero).
    const meshHandle = world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', mesh);
    const matHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
      'MaterialAsset',
      modifiedCopy,
    );
    const scene: SceneAsset = {
      kind: 'scene',
      entities: {
        'entity-0': {
          components: {
            Transform: {},
            MeshFilter: { assetHandle: meshHandle as never },
            MeshRenderer: { materials: [matHandle] as never },
          },
        },
      },
    };
    const sceneHandle = world.allocSharedRef<'SceneAsset', SceneAsset>('SceneAsset', scene);
    const instRes = SceneOwner.worldInstantiateScene(world, sceneHandle);
    expect(instRes.ok).toBe(true);
    if (!instRes.ok) return;

    const res = rootsToSceneAsset(reg, world, [instRes.value.root]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBeInstanceOf(SceneCollectAssetGuidUnresolvedError);
    expect(res.error.code).toBe('scene-collect-asset-guid-unresolved');
  });
});
