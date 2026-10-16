// apps/hello/room - importable SUT entry (feat-20260531-hoist-onerror-gate-
// to-apps-shared-and-fix-hello-room M3 / w6).
//
// This file is the room demo's importable entry, matching the learn-render
// consumer shape (16 sections expose a `bootstrap(canvas)` + a top-level
// `void bootstrap(canvas)` self-call). The onerror-gate browser test imports
// this module via `() => import('../index.ts')`, so the bootstrap must wire
// `renderer.subscribe` error channel into the `globalThis.__learnRenderErrors` bus before the
// gate's 5s poll window samples it (charter F1: read one learn-render entry,
// reuse the same pattern here).
//
// Scene recipe is unchanged from the previous main.ts; the only behavioural
// difference is the unlit MaterialAsset is now constructed by the
// `Materials.unlit` factory (a valid pass-based POD) instead of the legacy
// hand-written unlit-discriminant shape that carried no passes, resolved to
// zero passes at draw time, and fired `material-resolved-empty-passes`
// through the renderer error event.

import { createWorldContext, World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
import { Materials, renderComponentsPlugin } from '@forgeax/engine-render';
import { scenePlugin } from '@forgeax/engine-scene';
import type { SceneAsset } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import roomPack from '../assets/room.pack.json';

const ROOM_SCENE_GUID = '019e2808-d3ba-735f-811f-ae7bbb465392';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('hello-room: missing <canvas id="app"> in index.html');

void bootstrap(canvas);

export async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  try {
    const constructed = await constructRuntimeRendererHost(target, {}, forgeaxBundlerAdapter());
    if (!constructed.ok) throw constructed.error;
    const { renderer, assets } = constructed.value;
    // Forward every renderer error into the onerror-gate bus (charter P3
    // structured failure: AI users consume `.code` / `.hint`). The gate
    // installs `__learnRenderErrors` before importing this module; when the
    // bus is absent (normal dev / smoke run) the push is skipped.
    renderer.subscribe((event) => {
      if (event.kind !== 'error') return;
      const e = event.error;
      console.error('[room] renderer error:', e.code, e.hint);
      const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
      if (bus !== undefined) bus.push({ code: e.code, hint: e.hint });
    });

    console.warn('[room] Standard pipeline active');

    // Step 1: catalogue the scene's non-builtin materials under the same GUIDs
    // declared in room.pack.json refs. `catalog` stores GUID->payload so the
    // D-19 embedded-GUID resolution (inside instantiate) can resolve the GUID
    // strings to payloads.
    // The cube mesh GUID (cbe42beb-...) is a builtin: the AssetRegistry
    // constructor pre-catalogues HANDLE_CUBE under it (feat-20260603 Tier 0),
    // so it resolves natively -- no manual registration needed (cataloguing
    // createBoxGeometry(1,1,1) under it would now collide).

    // Schema-driven register for the standard PBR material. Passes through
    // pass-based MaterialAsset validation in registerWithGuid.
    const stdMatGuidResult = AssetGuid.parse(
      'f6af7007-158f-4d92-9e47-93bf2f213e1f',
    );
    if (!stdMatGuidResult.ok) {
      console.error('[room] standard material GUID parse failed:', stdMatGuidResult.error);
      return;
    }
    assets.catalog(stdMatGuidResult.value, {
      kind: 'material',
      passes: [
        { name: 'Forward', program: { module: 'forgeax::default-standard-pbr' }, renderState: { tags: { LightMode: 'Forward' }, queue: 2000 } },
      ],
      values: {
        baseColor: [0.8, 0.4, 0.2],
        metallic: 0,
        roughness: 0.5,
      },
    });

    const unlitMatGuidResult = AssetGuid.parse(
      '008e4f75-e7a3-4715-b05b-b93a9ec12074',
    );
    if (!unlitMatGuidResult.ok) {
      console.error('[room] unlit material GUID parse failed:', unlitMatGuidResult.error);
      return;
    }
    // Pass-based unlit MaterialAsset via the Materials.unlit factory. The
    // legacy hand-written unlit-discriminant shape carried no `passes` array
    // and resolved to empty passes at draw time, firing
    // `material-resolved-empty-passes` through the renderer error event.
    assets.catalog(unlitMatGuidResult.value, Materials.unlit([0.2, 0.3, 0.9, 1]));

    // Step 2: prepare World + register every component the SceneAsset
    // references. The SceneInstanceContainer resolver looks tokens up by
    // name; pre-registering keeps the spawn surface compile-time stable.
    const world = new World();
    const worldContext = await createWorldContext(world, [
      renderComponentsPlugin(),
      scenePlugin(),
    ]);
    const worldAttachment1 = renderer.attach(world);
    if (!worldAttachment1.ok) throw worldAttachment1.error;
    const frameRequest = {
      leases: [worldAttachment1.value],
      camera: { lease: worldAttachment1.value },
      environment: { lease: worldAttachment1.value },
    };

    // Step 3: construct SceneAsset POD from room.pack.json with GUID strings
    // in handle fields (post-parseScenePayload intermediate state). The refs
    // array maps index->GUID; each handle field value N becomes refs[N].
    // resolveSceneGuids (called inside instantiate) resolves these GUID
    // strings to column handles by looking the payloads up in the catalogue
    // populated by the catalog() calls above.
    const sceneGuid = AssetGuid.parse(ROOM_SCENE_GUID);
    if (!sceneGuid.ok) {
      console.error('[room] room scene GUID parse failed:', sceneGuid.error);
      return;
    }
    const sceneEntry = (roomPack as { assets: Array<{
      kind: string;
      payload: { entities: Record<string, {
        components: Record<string, Record<string, unknown>>;
      }> };
    }> }).assets.find((a) => a.kind === 'scene');
    if (!sceneEntry) {
      console.error('[room] room.pack.json has no scene entry');
      return;
    }
    const refs = (roomPack as { assets: Array<{ refs?: string[] }> }).assets[0]?.refs ?? [];
    // Handle-typed component fields whose payload value is a refs[] index that
    // must be rewritten to the GUID string `resolveSceneGuids` resolves back to
    // a Handle. Restricted to the known handle fields per component: a blanket
    // "any small integer is a refs index" heuristic mis-rewrites Transform
    // fields whose literal value happens to be 0/1/2 (e.g. a zero pos lane -> refs[0]
    // GUID -> NaN position) and ChildOf.parent:0, pushing geometry out of
    // frustum so the frame renders empty (the F-8 false-green masked this).
    // Kept byte-for-byte identical to scripts/smoke-dawn.mjs HANDLE_FIELDS so
    // the browser SUT and the dawn smoke share one narrowing rule.
    const handleFieldsByComponent: Record<string, Set<string>> = {
      MeshFilter: new Set(['assetHandle']),
      // feat-20260608 M5 amend: MeshRenderer.material -> materials (array
      // of handles, positional 1-1 with MeshAsset.submeshes[]). The
      // resolver below now handles both scalar handle fields (assetHandle)
      // and array-of-handle fields (materials).
      MeshRenderer: new Set(['materials']),
    };
    const sceneAsset: SceneAsset = {
      kind: 'scene',
      entities: Object.fromEntries(Object.entries(sceneEntry.payload.entities).map(([key, n]) => {
        const components: Record<string, Record<string, unknown>> = {};
        for (const [name, data] of Object.entries(n.components)) {
          // Replace refs index numbers with GUID strings for handle-type
          // fields only. Non-handle fields (Transform, Camera,
          // DirectionalLight, ChildOf) pass through unchanged. feat-20260608
          // M5 amend: handle-type fields may also be number[] (arrays of
          // refs indices) -- map each element through refs[] same way.
          const handleFields = handleFieldsByComponent[name];
          const resolved: Record<string, unknown> = {};
          const isRefIndex = (v: unknown): v is number =>
            typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < refs.length;
          for (const [field, value] of Object.entries(data)) {
            if (handleFields?.has(field)) {
              if (isRefIndex(value)) {
                resolved[field] = refs[value];
              } else if (Array.isArray(value)) {
                resolved[field] = value.map((el) => (isRefIndex(el) ? refs[el] : el));
              } else {
                resolved[field] = value;
              }
            } else {
              resolved[field] = value;
            }
          }
          // Override DirectionalLight with M5 / w23 plan-spec values
          // (direction: [-0.3, -1.0, -0.5], color: [1, 0.95, 0.9],
          // intensity: 1.0) for the GGX direct lighting pipeline.
          if (name === 'DirectionalLight') {
            components[name] = {
              direction: [-0.3, -1.0, -0.5],
              color: [1.0, 0.95, 0.9],
              intensity: 1.0,
            };
            continue;
          }
          components[name] = resolved;
        }
        return [key, { components }];
      })),
    };
    // The SceneAsset is catalogued under the scene GUID so loadByGuid
    // resolves through the dev / fallback path (synchronous Map lookup).
    assets.catalog<SceneAsset>(sceneGuid.value, sceneAsset);
    const sceneRes = await assets.loadByGuid<SceneAsset>(sceneGuid.value);
    if (!sceneRes.ok) {
      console.error('[room] room scene loadByGuid failed:', sceneRes.error);
      return;
    }
    // loadByGuid returns the payload (D-17); mint a user-tier column handle.
    // instantiate resolves GUID strings in handle fields to Handle numbers
    // via resolveSceneGuids (plan-strategy D-1; feat-20260528 M2 / w6).
    const sceneHandle = world.allocSharedRef('SceneAsset', sceneRes.value);
    const instanceRes = assets.instantiate<SceneAsset>(sceneHandle, world);
    if (!instanceRes.ok) {
      const e = instanceRes.error as { code: string };
      console.error('[room] scene instantiate failed:', e.code);
      return;
    }

    const frame = (): void => {
      void worldContext;
      world.update().unwrap();
      const r = renderer.draw(frameRequest);
      if (!r.ok) console.error('[room] draw error:', r.error);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  } catch (err: unknown) {
    if (err instanceof EngineEnvironmentError) console.error('[room] no usable backend:', err);
    else console.error('[room] bootstrap error:', err);
  }
}
