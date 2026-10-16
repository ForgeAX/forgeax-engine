import {
  BUILTIN_BASE,
  BuiltinAssetRegistry,
  builtinMeshGuid,
  HANDLE_CUBE,
  HANDLE_CYLINDER,
  HANDLE_NINESLICE_QUAD,
  HANDLE_QUAD,
  HANDLE_SPHERE,
  HANDLE_TRIANGLE,
  resolveAssetHandle,
} from '@forgeax/engine/assets-runtime';
import { MeshRenderer } from '@forgeax/engine/render';
import { defineFeature, type FeatureCheck } from '../../lab/feature';
import { spawnMesh, spawnStage, standard } from '../../lab/stage';

const HANDLES = [
  ['cube', HANDLE_CUBE],
  ['triangle', HANDLE_TRIANGLE],
  ['quad', HANDLE_QUAD],
  ['sphere', HANDLE_SPHERE],
  ['nine-slice quad', HANDLE_NINESLICE_QUAD],
  ['cylinder', HANDLE_CYLINDER],
] as const;

const COLORS = [
  [0.9, 0.2, 0.2, 1],
  [0.95, 0.6, 0.15, 1],
  [0.95, 0.85, 0.2, 1],
  [0.2, 0.8, 0.3, 1],
  [0.2, 0.4, 0.95, 1],
  [0.7, 0.3, 0.9, 1],
] as const;

export default defineFeature({
  title: 'Builtin mesh handles',
  catalog: 'Builtin mesh handles',
  kind: 'visual',
  summary:
    'All six HANDLE_* builtins render straight from process-static payloads: no catalog, no loadByGuid, no World shared-ref slot. Each handle also maps to a stable builtin GUID.',
  expect:
    'ON: cube, triangle, quad, sphere, nine-slice quad and cylinder in six saturated colors. OFF: the same six shapes turn plain white. Checks: every handle resolves without a World, maps to a GUID, and sits below BUILTIN_BASE.',
  setup({ world }) {
    spawnStage(world);
    const liveBefore = world.sharedRefs._liveCount();
    const tinted = COLORS.map((baseColor) =>
      standard(world, { baseColor, roughness: 0.5, renderState: { cullMode: 'none' } }),
    );
    const white = standard(world, {
      baseColor: [1, 1, 1, 1],
      roughness: 0.5,
      renderState: { cullMode: 'none' },
    });
    const entities = HANDLES.map(([, handle], index) =>
      spawnMesh(world, handle, tinted[index] as (typeof tinted)[number], {
        pos: [-2.5 + index, 0.6, 0],
        scale: [0.8, 0.8, 0.8],
      }),
    );
    const liveAfter = world.sharedRefs._liveCount();
    return {
      toggle(on) {
        entities.forEach((entity, index) => {
          world.set(entity, MeshRenderer, { materials: [on ? tinted[index] : white] } as never);
        });
      },
      checks() {
        const perHandle: FeatureCheck[] = HANDLES.flatMap(([name, handle]) => {
          const payload = BuiltinAssetRegistry.resolve(handle);
          const viaWorld = resolveAssetHandle(world, handle);
          return [
            {
              name: `${name}: resolves without a World`,
              ok: payload !== null && payload.kind === 'mesh',
            },
            { name: `${name}: resolves through the World path`, ok: viaWorld.ok },
            {
              name: `${name}: stable builtin GUID`,
              ok: typeof builtinMeshGuid(handle) === 'string',
            },
            { name: `${name}: slot below BUILTIN_BASE`, ok: Number(handle) < BUILTIN_BASE },
          ];
        });
        return [
          ...perHandle,
          {
            name: 'builtin meshes take no shared-ref slot (only the 7 materials do)',
            ok: liveAfter - liveBefore === COLORS.length + 1,
            detail: `${liveAfter - liveBefore} slots`,
          },
        ];
      },
    };
  },
});
