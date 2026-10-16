import type { MaterialAsset, MaterialValue } from './asset.js';

/** Author choices select compiled Standard features; they never enter uniform values. */
export const MATERIAL_STATIC_SWITCH_NAMES = [
  'textures',
  'normalMapping',
  'displacement',
  'clearcoat',
  'sheen',
  'anisotropy',
  'iridescence',
  'diffuseTransmission',
  'transmission',
  'subsurfaceDiffusion',
  'alphaClipping',
  'alphaHash',
  'triplanarProjection',
  'objectSpaceNormal',
  'directMultiscattering',
] as const;

export type MaterialStaticSwitchName = (typeof MATERIAL_STATIC_SWITCH_NAMES)[number];
export type MaterialStaticSwitches = Readonly<Partial<Record<MaterialStaticSwitchName, boolean>>>;

/** Optional physical layers are compiled only after an explicit author opt-in. */
export const STANDARD_OPTIONAL_LAYER_SWITCHES = {
  clearcoat: false,
  sheen: false,
  anisotropy: false,
  iridescence: false,
  diffuseTransmission: false,
} as const satisfies MaterialStaticSwitches;

const STANDARD_ROOT_MODULES = new Set([
  'forgeax::default-standard-pbr',
  'forgeax::pbr-skin',
  'forgeax_material::standard',
  'forgeax_material::terrain',
  'forgeax_material::pbr-skin',
]);

/** Shared ownership predicate for Standard authoring and publication. */
export function isStandardRootModule(module: string): boolean {
  return STANDARD_ROOT_MODULES.has(module);
}

/** Resolve choices after inheritance; runtime weights never select a layer. */
export function standardMaterialStaticSwitches(
  authored?: MaterialStaticSwitches,
): MaterialStaticSwitches {
  return { ...STANDARD_OPTIONAL_LAYER_SWITCHES, ...authored };
}

/** Authored declarations survive; the selected graph derives the compiled ABI. */
export function standardMaterialParameterEnabled(
  parameter: { readonly name: string; readonly type: string },
  switches: MaterialStaticSwitches | undefined,
): boolean {
  if (switches === undefined) return true;
  const { name, type } = parameter;
  const texture = type === 'texture' || type.startsWith('texture');
  if (texture && switches.textures === false) return false;
  for (const feature of [
    'clearcoat',
    'sheen',
    'anisotropy',
    'iridescence',
    'diffuseTransmission',
  ] as const) {
    if (switches[feature] === false && name.startsWith(feature)) return false;
  }
  if (
    switches.transmission === false &&
    [
      'transmission',
      'transmissionTexture',
      'thickness',
      'thicknessTexture',
      'attenuationColor',
      'attenuationDistance',
    ].includes(name)
  )
    return false;
  if (
    switches.normalMapping === false &&
    ['normalTexture', 'bumpTexture', 'clearcoatNormalTexture'].includes(name)
  )
    return false;
  if (switches.displacement === false && name.startsWith('displacement')) return false;
  if (
    switches.subsurfaceDiffusion === false &&
    ['subsurfaceRadius', 'subsurfaceWeight'].includes(name)
  )
    return false;
  if (switches.alphaClipping === false && name === 'alphaCutoff') return false;
  if (switches.alphaHash === false && name === 'alphaHash') return false;
  if (switches.triplanarProjection === false && name.startsWith('triplanar')) return false;
  if (switches.objectSpaceNormal === false && name === 'normalMapSpace') return false;
  if (switches.directMultiscattering === false && name === 'directMultiscatteringLut') return false;
  return true;
}

/** Validate the closed author vocabulary at source and publication boundaries. */
export function isMaterialStaticSwitches(value: unknown): value is MaterialStaticSwitches {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([name, enabled]) =>
        (MATERIAL_STATIC_SWITCH_NAMES as readonly string[]).includes(name) &&
        typeof enabled === 'boolean',
    )
  );
}

/** Cook the active contract without mutating author assets or inherited values. */
export function selectMaterialStaticContract(
  asset: MaterialAsset,
  standardSource = asset.passes?.some((pass) => isStandardRootModule(pass.program.module)) ?? false,
): MaterialAsset {
  if (asset.parameters === undefined) return asset;
  const standard = standardSource;
  const switches = standard
    ? standardMaterialStaticSwitches(asset.staticSwitches)
    : asset.staticSwitches;
  if (switches === undefined) return asset;
  const featureParameters = asset.parameters.filter((parameter) =>
    standardMaterialParameterEnabled(parameter, switches),
  );
  const stock =
    standard &&
    (asset.surface?.module === undefined ||
      asset.surface.module === 'forgeax_material::default_standard_surface') &&
    asset.passes?.every(
      (pass) =>
        pass.program.moduleSlots?.surface === undefined ||
        pass.program.moduleSlots.surface === 'forgeax_material::default_standard_surface' ||
        pass.program.moduleSlots.surface === 'forgeax_material::opaque_surface',
    );
  const names = new Set(featureParameters.map((parameter) => parameter.name));
  const dependencies: Readonly<Record<string, readonly string[]>> = {
    alphaChannel: ['alphaTexture'],
    metallicChannel: ['metallicTexture', 'metallicRoughnessTexture'],
    roughnessChannel: ['roughnessTexture', 'metallicRoughnessTexture'],
    occlusionStrength: ['occlusionTexture'],
    normalScale: ['normalTexture'],
    clearcoatNormalScale: ['clearcoatNormalTexture'],
    bumpScale: ['bumpTexture'],
    displacementScale: ['displacementTexture'],
    displacementBias: ['displacementTexture'],
    normalMapSpace: ['normalTexture'],
    triplanarSpace: [
      'baseColorTexture',
      'metallicRoughnessTexture',
      'metallicTexture',
      'roughnessTexture',
      'alphaTexture',
      'normalTexture',
      'emissiveTexture',
      'occlusionTexture',
    ],
    triplanarScale: ['triplanarSpace'],
    triplanarSharpness: ['triplanarSpace'],
  };
  // Dead channel selectors have no stock Surface consumer. Custom Surfaces
  // retain their declared fields, including names that resemble stock inputs.
  if (stock) {
    names.delete('aoChannel');
    names.delete('extraChannel');
    for (const [name, maps] of Object.entries(dependencies)) {
      if (!maps.some((map) => names.has(map))) names.delete(name);
    }
  }
  const parameters = featureParameters.filter((parameter) => names.has(parameter.name));
  const active = new Set(parameters.map((parameter) => parameter.name));
  const values: Record<string, MaterialValue | null> = {};
  for (const [name, value] of Object.entries(asset.values ?? {})) {
    if (active.has(name)) values[name] = value;
  }
  return { ...asset, staticSwitches: switches, parameters, values };
}
