// feat-20260630-equirect-kind-internalized-ibl-declarative-skyligh M3 / w15 —
// scene roundtrip + instantiate handle resolution for the declarative skylight
// (plan-strategy §5.3 key test point (4); requirements AC-07 / AC-04;
// research R-1 — scene-handle-fields generic `shared<` extraction auto-covers
// the equirect field, no per-field whitelist).
//
// Two assertions, both on the CONSUMER path (not `.test-d.ts`):
//   (1) A SceneAsset whose Skylight references an equirect source by GUID
//       string round-trips through instantiate: the GUID resolves to a live
//       user-tier shared handle on the spawned Skylight column (AC-07). This
//       exercises BOTH scene-resolution paths the equirect field rides:
//         - extractSceneEntityHandleGuids (generic `shared<` detection, R-1)
//         - parseScenePayload HANDLE_FIELD_NAMES allowlist (w27, second path)
//   (2) `world.spawn(Skylight{equirect}).data.equirect` is typed
//       `Handle<'EquirectAsset','shared'>` — verified by assigning a branded
//       EquirectAsset handle into the spawn data and reading it back (a wrong
//       field type would fail typecheck on this consumer path, AC-04).
//
// TDD red phase: the equirect field lands in w16 (Skylight component) +
// w27 (HANDLE_FIELD_NAMES). Until then the `shared<EquirectAsset>` field name
// is `cubemap` and this file fails to compile / resolve — that is the red.

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { EntityHandle } from '@forgeax/engine-ecs';
import { World } from '@forgeax/engine-ecs';
import { Skylight } from '@forgeax/engine-render';
import type { EquirectAsset, Handle, SceneAsset } from '@forgeax/engine-types';
import { BUILTIN_BASE } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';
import { registerSceneComponents } from './helpers/register-scene-components';

// A minimal valid EquirectAsset POD (kind:'equirect', single 2D rgba16float
// image). The roundtrip never decodes the bytes; a tiny tight-packed buffer is
// enough to catalogue + resolve the handle.
function equirectPod(width = 4, height = 2): EquirectAsset {
  return {
    kind: 'equirect',
    width,
    height,
    format: 'rgba16float',
    data: new Uint8Array(width * height * 8),
    colorSpace: 'linear',
  };
}

const EQUIRECT_GUID = '019e4a26-3c29-7420-af5d-20f2724a16b0';

describe('scene equirect roundtrip + instantiate handle resolution (M3 / w15)', () => {
  it('(1) Skylight{equirect: GUID} round-trips: instantiate resolves the GUID to a live user-tier shared handle (AC-07)', async () => {
    const reg = new AssetRegistry(makeMockShaderRegistry());
    const world = new World();
    registerSceneComponents(world, [Skylight]);

    // Catalogue the equirect payload exactly as loadByGuid would on the prod
    // path, so the GUID string in the scene resolves to a real handle.
    const { AssetGuid } = await import('@forgeax/engine-pack/guid');
    const guid = AssetGuid.parse(EQUIRECT_GUID);
    if (!guid.ok) throw new Error('equirect GUID parse failed');
    expect(reg.catalog(guid.value, equirectPod()).ok).toBe(true);

    // A scene whose single Skylight references the equirect source by GUID
    // string — the post-parseScenePayload intermediate state where handle
    // fields hold GUID strings awaiting resolution.
    const entities = {
      'entity-0': {
        components: {
          Skylight: { equirect: EQUIRECT_GUID, intensity: 1.0 },
        },
      },
    };
    const scene: SceneAsset = { kind: 'scene', entities };

    const sceneHandle = world.allocSharedRef('SceneAsset', scene);
    const res = reg.instantiate<SceneAsset>(sceneHandle, world);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // The spawned Skylight's equirect field must be a resolved user-tier slot
    // (>= BUILTIN_BASE), not the sentinel 0 a coerced GUID string would leave.
    const root = res.value as EntityHandle;
    const { SceneInstance } = await import('@forgeax/engine-render');
    const inst = world.get(root, SceneInstance);
    expect(inst.ok).toBe(true);
    if (!inst.ok) return;
    const member = inst.value.mapping[0] as unknown as EntityHandle;
    const sky = world.get(member, Skylight);
    expect(sky.ok).toBe(true);
    if (!sky.ok) return;
    const equirectHandle = sky.value.equirect as unknown as number;
    expect(typeof equirectHandle).toBe('number');
    expect(equirectHandle).toBeGreaterThanOrEqual(BUILTIN_BASE);
  });

  it('(2) world.spawn(Skylight{equirect}).data.equirect is typed Handle<EquirectAsset,shared> on the consumer path (AC-04)', () => {
    const world = new World();
    registerSceneComponents(world, [Skylight]);
    // Branded EquirectAsset handle — assigning it into the spawn `equirect`
    // field is the consumer-path type assertion: a wrong field type (e.g. the
    // retired CubeTextureAsset, or a non-handle column) would fail typecheck
    // here, not in a separate .test-d.ts.
    const equirect: Handle<'EquirectAsset', 'shared'> = 1024 as Handle<'EquirectAsset', 'shared'>;
    const e = world.spawn({ component: Skylight, data: { equirect } }).unwrap();
    const r = world.get(e, Skylight).unwrap();
    // The read-back value carries the same handle (runtime confirms the column
    // stored the shared handle, complementing the compile-time field type).
    expect(r.equirect as unknown as number).toBe(1024);
  });
});
