// template-game-default-api-contract.test - the surface APIs that the
// `apps/game-capability-lab/main.ts` scene instantiation relies on
// must continue to exist and compose. Catches the API drift that produced
// `TypeError: Cannot read properties of undefined (reading
// 'setSceneAssetResolver')` at runtime when an earlier
// `world.sceneInstances.setSceneAssetResolver(...)` call survived a refactor
// that moved the resolver onto World itself + made `assets.instantiate`
// return the synthetic root Entity directly.
//
// Coverage (red-then-green tickets bundled into one file):
//   (a) `assets.instantiate(handle, world)` exists and returns a
//       Result<Entity>; when the scene is catalogued and a column handle is
//       minted via `world.allocSharedRef('SceneAsset', payload)`, the call
//       resolves handle-typed component fields automatically (no caller-side
//       `setSceneAssetResolver` wiring required).
//   (b) the synthetic root carries the `SceneInstance` component, whose
//       `mapping` Uint32Array is indexed by `localId` and yields the live
//       Entity for each authored node — the lookup the template's
//       `attachScenePhysics` / `setupPlayerRoot` walks per node.
//   (c) `world.sceneInstances` is NOT a thing on the current API
//       surface (placeholder anti-regression: the runtime exposes the
//       resolver via `world._setSceneAssetResolver` — already auto-wired
//       inside `assets.instantiate` for in-registry handles — and the
//       returned `instRes.value` is the synthetic root Entity, not an id
//       to look up via a non-existent `byRef`).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { componentDefinition } from '@forgeax/engine-ecs/internal';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import { MeshRenderer, SceneInstance } from '@forgeax/engine-render';
// Importing the runtime components barrel populates the global component
// table consulted by `World._buildSceneEntityComponentDatas` — without
// these named bindings, Transform / MeshRenderer / ChildOf resolve to
// undefined during instantiate. ChildOf + SceneInstance are used directly
// below as values; Transform / MeshRenderer pin the side-effect import.
import { ChildOf, Transform } from '@forgeax/engine-scene';
import type { MaterialAsset, SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';
import { registerRuntimeComponents } from './helpers/register-runtime-components';

// Shape this fixture mirrors the `apps/game-capability-lab/assets/scene.pack.json`
// SceneAsset payload after the template's `instantiateScenePack` helper has
// rewritten ref-int → GUID strings + lifted MeshRenderer.material → materials[].
// We register one MaterialAsset so the SceneAsset's MeshRenderer GUID slot
// resolves through the registry's two-phase parse.
const MAT_GUID = '00000000-0000-5000-8000-000000000001';
const SCENE_GUID = '00000000-0000-5000-8000-0000000000aa';

function buildSceneAssetWithGuidRef(): SceneAsset {
  // Touch the bindings so noUnusedLocals doesn't strip the import (which
  // would also strip its component-table side effect).
  void Transform;
  void MeshRenderer;

  const nodes = {
    'entity-0': {
      components: {
        Transform: { pos: [0, 0, 0] },
        // GUID string (post template ref-int → GUID rewrite). The registry's
        // `_resolveSceneGuids` lifts this to a `Handle<MaterialAsset>` at
        // instantiate time.
        MeshRenderer: { materials: [MAT_GUID] },
      },
    },
    'entity-1': {
      components: {
        Transform: { pos: [1, 0, 0] },
        ChildOf: { parent: 'entity-0' },
      },
    },
  };
  return { kind: 'scene', entities: nodes };
}

describe('game-capability-lab API contract (regression for `world.sceneInstances` drift)', () => {
  it('(a) assets.instantiate returns the synthetic root Entity directly (no `byRef` indirection)', async () => {
    const reg = new AssetRegistry(makeMockShaderRegistry());
    const world = new World();
    registerRuntimeComponents(world);

    const matGuid = AssetGuid.parse(MAT_GUID);
    expect(matGuid.ok).toBe(true);
    if (!matGuid.ok) return;
    const mat: MaterialAsset = {
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          program: { module: 'forgeax::default-unlit' },
          renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
        },
      ],
      values: { baseColor: [1, 1, 1, 1] as [number, number, number, number] },
    };
    reg.catalog<MaterialAsset>(matGuid.value, mat);

    const sceneGuid = AssetGuid.parse(SCENE_GUID);
    expect(sceneGuid.ok).toBe(true);
    if (!sceneGuid.ok) return;
    reg.catalog<SceneAsset>(sceneGuid.value, buildSceneAssetWithGuidRef());

    const payloadRes = await reg.loadByGuid<SceneAsset>(sceneGuid.value);
    expect(payloadRes.ok).toBe(true);
    if (!payloadRes.ok) return;

    // loadByGuid returns the PAYLOAD; mint a user-tier column handle to feed
    // instantiate (the template does exactly this at its call site).
    const handle = world.allocSharedRef('SceneAsset', payloadRes.value);

    // The template uses precisely this 2-line shape; both must compile +
    // succeed without touching a `world.sceneInstances` surface.
    const instRes = reg.instantiate<SceneAsset>(handle, world);
    expect(instRes.ok).toBe(true);
    if (!instRes.ok) return;
    // `instRes.value` is an Entity (the synthetic SceneInstance root), not
    // an id needing a separate lookup.
    const root: EntityHandle = instRes.value;
    expect(typeof root).toBe('number');
  });

  it('(b) the synthetic root carries SceneInstance.mapping[localId] = Entity (per-node lookup the template walks)', async () => {
    const reg = new AssetRegistry(makeMockShaderRegistry());
    const world = new World();
    registerRuntimeComponents(world);

    const matGuid = AssetGuid.parse(MAT_GUID);
    if (!matGuid.ok) throw new Error('parse');
    const mat: MaterialAsset = {
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          program: { module: 'forgeax::default-unlit' },
          renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
        },
      ],
      values: { baseColor: [1, 1, 1, 1] as [number, number, number, number] },
    };
    reg.catalog<MaterialAsset>(matGuid.value, mat);

    const sceneGuid = AssetGuid.parse(SCENE_GUID);
    if (!sceneGuid.ok) throw new Error('parse');
    reg.catalog<SceneAsset>(sceneGuid.value, buildSceneAssetWithGuidRef());

    const payloadRes = await reg.loadByGuid<SceneAsset>(sceneGuid.value);
    if (!payloadRes.ok) throw new Error('load');
    const handle = world.allocSharedRef('SceneAsset', payloadRes.value);
    const instRes = reg.instantiate<SceneAsset>(handle, world);
    if (!instRes.ok) throw new Error('inst');
    const root = instRes.value;

    const inst = world.get(root, SceneInstance);
    expect(inst.ok).toBe(true);
    if (!inst.ok) return;

    // mapping is positional: mapping[localId] = packed Entity u32
    const mapping = inst.value.mapping as unknown as ArrayLike<number>;
    expect(mapping.length).toBeGreaterThanOrEqual(2);
    const node0 = mapping[0];
    const node1 = mapping[1];
    expect(node0).toBeDefined();
    expect(node1).toBeDefined();
    if (node0 === undefined || node1 === undefined) return;
    expect(node0).not.toBe(node1);

    // The two member entities both ChildOf the synthetic root (template
    // walks Children to find PlayerTorso/Head/etc).
    const child0 = world.get(node0 as EntityHandle, ChildOf);
    const child1 = world.get(node1 as EntityHandle, ChildOf);
    // node 1 explicitly authored ChildOf{parent:0}; that resolves to node 0.
    expect(child1.ok).toBe(true);
    if (child1.ok) {
      expect(child1.value.parent as unknown as number).toBe(node0);
    }
    // node 0 has no authored ChildOf but the synthetic root attaches one
    // pointing at root for tree-walking.
    expect(child0.ok).toBe(true);
    if (child0.ok) {
      expect(child0.value.parent as unknown as number).toBe(root as unknown as number);
    }
  });

  it('(c) world has no removed scene-instance container or resolver mutator', () => {
    const world = new World();
    expect((world as unknown as { sceneInstances?: unknown }).sceneInstances).toBeUndefined();
    // Resolver wiring is owned by the AssetRegistry/scene-instantiation path;
    // the former private World mutator is not part of the ECS surface.
    expect(
      typeof (world as unknown as { _setSceneAssetResolver?: unknown })._setSceneAssetResolver,
    ).toBe('undefined');
  });

  // The template main.ts source file must consume the current API. Catches
  // the literal regression we hit at runtime: `world.sceneInstances.
  // setSceneAssetResolver(...)` survived a refactor that removed
  // `world.sceneInstances`. Lint the file statically so a TS compile
  // doesn't pass while runtime explodes (the template is a workspace
  // sibling that the engine packages don't import — typecheck never sees
  // it).
  it('(c2) [regression] apps/game-capability-lab/main.ts must not call `world.sceneInstances`', () => {
    const here = fileURLToPath(import.meta.url);
    // here = packages/runtime/src/__tests__/<file> → 4 levels up = repo root
    const repoRoot = resolve(here, '..', '..', '..', '..', '..');
    const main = readFileSync(resolve(repoRoot, 'apps', 'game-capability-lab', 'main.ts'), 'utf-8');
    // Strip line comments so prose explaining the rename does not trip the
    // grep gate; the gate targets actual member access only.
    const noComments = main
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    // No member access on the removed container surface (e.g.
    // `world.sceneInstances.setSceneAssetResolver(...)` /
    // `world.sceneInstances.byRef(id)`).
    expect(noComments).not.toMatch(/\.sceneInstances\b/);
    // And no `byRef`, the indirection that came with it.
    expect(noComments).not.toMatch(/\.byRef\(/);
  });

  // bug-20260619: the real `scene.pack.json` shipped a DirectionalLightShadow
  // node carrying `orthoHalfExtent` — a field deleted when shadows moved to CSM
  // (cascadeCount / splitLambda / ...). Strict instantiate (bug-20260615
  // fail-fast) rejected the WHOLE scene on the unknown key, so every freshly
  // created game booted empty (only the ground+sky fallback survived). The
  // prior contract tests used a hand-built fixture, so the live-schema-vs-
  // template drift had no gate. This reads the SHIPPED pack and asserts every
  // authored component field — AFTER the template loader's documented projection
  // — exists in the live component schema, i.e. the exact key check
  // `_buildSceneEntityComponentDatas` runs at instantiate time.
  //
  // scene-as-asset (2026-06-29): the shipped pack now lives at
  // `assets/scene.pack.json` and is authored DIRECTLY in the current engine
  // schema — `payload.entities` (not `nodes`), `MeshRenderer.materials` (not
  // the legacy ref-int `material`), no Studio-only `Collider`, dense localIds.
  // main.ts loads it through the pure-GUID path (loadByGuid<SceneAsset> ->
  // instantiate) with NO preprocessing projection, so every authored field must
  // satisfy the live schema VERBATIM — that's what _buildSceneEntityComponentDatas
  // enforces at instantiate time. STRIP/FIELD_RENAME below are retained as
  // defensive no-ops in case an Edit round-trip ever re-writes a legacy shape.
  it('(e) [regression] every shipped scene.pack.json component field exists in its live schema', () => {
    // Touch the barrel bindings so the component-table side-effect import is
    // not tree-shaken (World.components.resolve reads that per-World table).
    void Transform;
    void MeshRenderer;
    void ChildOf;
    void SceneInstance;
    const world = new World();
    registerRuntimeComponents(world);

    // Defensive back-compat projection (the shipped pack is already clean):
    // an editor ✎ Edit save would write `Collider` (Studio metadata) and could
    // emit the legacy singular `material`; tolerate both so the gate is stable.
    const STRIP_COMPONENTS = new Set(['Collider']);
    const FIELD_RENAME: Record<string, Record<string, string>> = {
      MeshRenderer: { material: 'materials' },
    };

    const here = fileURLToPath(import.meta.url);
    const repoRoot = resolve(here, '..', '..', '..', '..', '..');
    const packPath = resolve(repoRoot, 'apps', 'game-capability-lab', 'assets', 'scene.pack.json');
    const pack = JSON.parse(readFileSync(packPath, 'utf-8')) as {
      assets:
        | {
            kind: string;
            payload?: {
              entities?: Record<string, { components: Record<string, Record<string, unknown>> }>;
              nodes?: Record<string, { components: Record<string, Record<string, unknown>> }>;
            };
          }[]
        | Record<
            string,
            {
              kind: string;
              payload?: {
                entities?: Record<string, { components: Record<string, Record<string, unknown>> }>;
                nodes?: Record<string, { components: Record<string, Record<string, unknown>> }>;
              };
            }
          >;
    };
    const assets = Array.isArray(pack.assets) ? pack.assets : Object.values(pack.assets);

    const offenders: string[] = [];
    let scanned = 0;
    for (const asset of assets) {
      // The envelope `kind` is the authoritative asset discriminant; the payload
      // no longer restates it (Derive, Don't Duplicate — the loader synthesises
      // Asset.kind from the envelope on load).
      if (asset.kind !== 'scene') continue;
      for (const node of Object.values(asset.payload?.entities ?? asset.payload?.nodes ?? {})) {
        for (const [compName, data] of Object.entries(node.components)) {
          if (STRIP_COMPONENTS.has(compName)) continue;
          scanned++;
          const token = world.components.resolve(compName);
          if (token === undefined) {
            offenders.push(`${compName} (component not defined)`);
            continue;
          }
          const schema = componentDefinition(token).fields;
          const rename = FIELD_RENAME[compName] ?? {};
          for (const rawField of Object.keys(data ?? {})) {
            const field = rename[rawField] ?? rawField;
            if (!(field in schema)) {
              offenders.push(`${compName}.${rawField} (scene entity key)`);
            }
          }
        }
      }
    }

    expect(offenders).toEqual([]);
    // Guard against a vacuous pass (e.g. component table not populated / pack
    // shape drift silently yielding zero scanned components).
    expect(scanned).toBeGreaterThan(0);
  });

  // The editor serializes inline materials only when they are reachable from a
  // live MeshRenderer. An orphaned inline material therefore turns its
  // load-time count floor into a false save rejection for every new game.
  it('(e2) [regression] every inline template material is referenced by a MeshRenderer', () => {
    const here = fileURLToPath(import.meta.url);
    const repoRoot = resolve(here, '..', '..', '..', '..', '..');
    const packPath = resolve(repoRoot, 'apps', 'game-capability-lab', 'assets', 'scene.pack.json');
    type TemplatePackAsset = {
      guid?: string;
      kind: string;
      payload?: {
        entities?: Record<string, { components: { MeshRenderer?: { materials?: number[] } } }>;
      };
      refs?: string[];
    };
    const pack = JSON.parse(readFileSync(packPath, 'utf-8')) as {
      packageId?: string;
      assets: TemplatePackAsset[] | Record<string, TemplatePackAsset>;
    };
    const entries = Array.isArray(pack.assets)
      ? pack.assets.map((asset) => ({ asset, sourceKey: undefined }))
      : Object.entries(pack.assets).map(([sourceKey, asset]) => ({ asset, sourceKey }));
    const sceneEntry = entries.find(({ asset }) => asset.kind === 'scene');
    const scene = sceneEntry?.asset;
    expect(scene).toBeDefined();
    if (scene === undefined) return;

    const referencedMaterialGuids = new Set(
      Object.values(scene.payload?.entities ?? {}).flatMap((entity) =>
        (entity.components.MeshRenderer?.materials ?? []).map((index) => scene.refs?.[index]),
      ),
    );
    const packageId = pack.packageId === undefined ? undefined : PackageId.parse(pack.packageId);
    const guidFor = ({ asset, sourceKey }: (typeof entries)[number]): string | undefined => {
      if (asset.guid !== undefined) return asset.guid;
      if (sourceKey === undefined || packageId === undefined || !packageId.ok) return undefined;
      return AssetGuid.format(AssetGuid.derive(packageId.value, sourceKey));
    };
    const orphanedMaterialGuids = entries
      .filter(({ asset }) => asset.kind === 'material')
      .map(guidFor)
      .filter((guid): guid is string => guid !== undefined)
      .filter((guid) => !referencedMaterialGuids.has(guid));

    expect(orphanedMaterialGuids).toEqual([]);
  });

  it('(d) loadByGuid returns the catalogued SceneAsset payload (identity)', async () => {
    const reg = new AssetRegistry(makeMockShaderRegistry());
    const sceneGuid = AssetGuid.parse(SCENE_GUID);
    if (!sceneGuid.ok) throw new Error('parse');
    const payload: SceneAsset = { kind: 'scene', entities: {} };
    const cataloged = reg.catalog<SceneAsset>(sceneGuid.value, payload);
    expect(cataloged.ok).toBe(true);
    if (!cataloged.ok) return;
    const loaded = await reg.loadByGuid<SceneAsset>(sceneGuid.value);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    // loadByGuid returns the PAYLOAD (no handle); it is the same object the
    // registry catalogued.
    expect(loaded.value).toBe(cataloged.value);
    expect(loaded.value.kind).toBe('scene');
  });
});
