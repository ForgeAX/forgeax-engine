import { AssetGuid, type PackageId } from '@forgeax/engine-pack/guid';
import type { MaterialAsset } from '@forgeax/engine-types';
import { deriveStandardLayerPlan } from '@forgeax/engine-types';

type SurfacePack = {
  packageId: PackageId;
  build: () =>
    | { readonly ok: true; readonly value: Readonly<Record<string, MaterialAsset>> }
    | Promise<{ readonly ok: true; readonly value: Readonly<Record<string, MaterialAsset>> }>;
};

type ViteImportMeta = ImportMeta & {
  glob<T>(
    patterns: readonly string[],
    options: { readonly eager: true; readonly import: 'default' },
  ): Readonly<Record<string, T>>;
};

const packModules = Object.values(
  (import.meta as ViteImportMeta).glob<SurfacePack>(
    [
      '../../../../templates/game-3d/assets/materials.pack.ts',
      '../../../../apps/preview/assets/surface-standard-evidence.pack.ts',
    ],
    {
      eager: true,
      import: 'default',
    },
  ),
);
if (packModules.length !== 2)
  throw new Error('surface-evidence-fixture: required pack module missing');

const builtPacks = packModules.map((pack) => {
  const built = pack.build();
  if (built instanceof Promise || !built.ok) {
    throw new Error('surface-evidence-fixture: materials pack did not produce outputs');
  }
  return { packageId: pack.packageId, values: built.value };
});
const materials = Object.assign({}, ...builtPacks.map((pack) => pack.values)) as Record<
  string,
  MaterialAsset | undefined
>;

function guidForSourceKey(sourceKey: string): AssetGuid {
  const owner = builtPacks.find((pack) => Object.hasOwn(pack.values, sourceKey));
  if (owner === undefined) {
    throw new Error(`surface-evidence-fixture: source key '${sourceKey}' is not published`);
  }
  return AssetGuid.derive(owner.packageId, sourceKey);
}

const rustedIron = materials['material/rusted-iron'];

const defaultBase = materials['material/ground'];
const defaultPhysical = materials['material/painted'];
const customPhysical = materials['material/rusted-iron-custom-physical'];
if (
  rustedIron === undefined ||
  defaultBase === undefined ||
  defaultPhysical === undefined ||
  customPhysical === undefined
)
  throw new Error('surface-evidence-fixture: required material row missing');

export const SURFACE_CLOSURE = 'forgeax_material::surface_v1';
export const SURFACE_SOURCE_CLOSURE = [
  'templates/game-3d/assets/materials.pack.ts',
  'templates/game-3d/assets/shaders/rusted-iron.wgsl',
] as const;
export const SURFACE_SOURCE_PATH = 'templates/game-3d/assets/shaders/rusted-iron.wgsl';
export const SURFACE_MATERIAL_SOURCE_KEY = 'material/rusted-iron';
export const EVIDENCE_SOURCE_SHA =
  (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
    ?.VITE_FORGEAX_EVIDENCE_SOURCE_SHA ?? 'unavailable';

export const SURFACE_CASES = [
  {
    id: 'default-base',
    material: defaultBase,
    materialGuid: AssetGuid.format(guidForSourceKey('material/ground')),
    surfaceModule: defaultBase.passes?.[0]?.program.moduleSlots?.surface ?? '',
    physical: false,
  },
  {
    id: 'custom-base',
    material: rustedIron,
    materialGuid: AssetGuid.format(guidForSourceKey('material/rusted-iron')),
    surfaceModule: rustedIron.passes?.[0]?.program.moduleSlots?.surface ?? '',
    physical: false,
  },
  {
    id: 'default-physical',
    material: defaultPhysical,
    materialGuid: '019fb7ce-3200-7000-8000-000000000002',
    surfaceModule: defaultPhysical.passes?.[0]?.program.moduleSlots?.surface ?? '',
    physical: true,
  },
  {
    id: 'custom-physical',
    material: customPhysical,
    materialGuid: '019fb7ce-3f00-7000-8000-000000000001',
    surfaceModule: customPhysical.passes?.[0]?.program.moduleSlots?.surface ?? '',
    physical: true,
  },
] as const;

export function layerPlanFor(surfaceCase: (typeof SURFACE_CASES)[number]) {
  return deriveStandardLayerPlan(
    surfaceCase.physical ? (surfaceCase.material.parameters ?? []) : [],
  );
}

export function baseColorFor(
  surfaceCase: (typeof SURFACE_CASES)[number],
): readonly [number, number, number] {
  const values = surfaceCase.material.values ?? {};
  const value = values.baseColor ?? values.ironColor;
  if (!Array.isArray(value) || value.length < 3) {
    throw new Error(`surface-evidence-fixture: missing base color for ${surfaceCase.id}`);
  }
  return [Number(value[0]), Number(value[1]), Number(value[2])];
}

export function passFor(surfaceCase: (typeof SURFACE_CASES)[number]): 'forward' | 'deferred' {
  return layerPlanFor(surfaceCase).mode === 'physical' ? 'forward' : 'deferred';
}

export function publicationGenerationFor(_surfaceCase: (typeof SURFACE_CASES)[number]): number {
  return 1;
}
