import { isStandardRootModule } from '@forgeax/engine-pack';
import {
  STANDARD_DIRECT_DFG_LUT_BINDING,
  STANDARD_OBJECT_SPACE_NORMAL_BIT,
  STANDARD_PHYSICAL_BINDING_START,
  STANDARD_SAMPLE_REUSE,
  STANDARD_SHARED_TRANSMISSION_DEFINE,
  STANDARD_SHARED_TRANSMISSION_SLOTS,
  STANDARD_TEXTURE_MASK_OVERRIDE,
  STANDARD_TRIPLANAR_PROJECTION_BIT,
  standardTextureMask,
} from '@forgeax/engine-shader';
import type {
  MaterialParameter,
  MaterialPass,
  MaterialStaticSwitches,
  ParamSchemaEntry,
  Result,
  StandardLayerPlan,
} from '@forgeax/engine-types';
import {
  createMaterialError,
  derive,
  deriveStandardLayerPlan,
  err,
  isMaterialPhysicalContractError,
  type MaterialError,
  ok,
  projectMaterialParameterSchema,
  STANDARD_MATERIAL_PARAM_SCHEMA,
  STANDARD_PHYSICAL_TEXTURE_FIELDS,
  STANDARD_TRANSMISSION_PARAMETER_NAMES,
  standardPhysicalTextureFields,
} from '@forgeax/engine-types';

/** The one build-time projection consumed by both Pack cooking and Vite. */
export interface LoweredStandardContract {
  readonly layerPlan: StandardLayerPlan;
  readonly paramSchema: readonly ParamSchemaEntry[];
  readonly defines: Readonly<Record<string, boolean>>;
  readonly layoutIdentity: string;
}

function usesStandardTemplate(passes: readonly MaterialPass[] | undefined): boolean {
  return passes?.some((pass) => isStandardRootModule(pass.program.module)) ?? false;
}

function hasTransmission(names: ReadonlySet<string>): boolean {
  return [...names].some(
    (name) => STANDARD_TRANSMISSION_PARAMETER_NAMES.has(name) && name !== 'ior',
  );
}

/** Shared by exact-root cooking and the engine's fixed-layout shader producer. */
export function standardMaterialDefines(
  schema: readonly ParamSchemaEntry[],
): Record<string, boolean> {
  const defines: Record<string, boolean> = {};
  if (schema.some((parameter) => parameter.type === 'texture2d'))
    defines.MATERIAL_TEXTURE_COORDINATES_AVAILABLE = true;
  if (
    schema.some((parameter) => parameter.name === 'subsurfaceRadius') &&
    schema.some((parameter) => parameter.name === 'subsurfaceWeight')
  )
    defines.SUBSURFACE_DIFFUSION_AVAILABLE = true;
  if (schema.some((parameter) => parameter.name === 'alphaCutoff'))
    defines.ALPHA_CLIPPING_AVAILABLE = true;
  if (schema.some((parameter) => parameter.name === 'alphaHash'))
    defines.ALPHA_HASH_AVAILABLE = true;
  if (schema.some((parameter) => parameter.name === 'triplanarSpace'))
    defines.TRIPLANAR_PROJECTION_AVAILABLE = true;
  if (schema.some((parameter) => parameter.name === 'normalMapSpace'))
    defines.OBJECT_SPACE_NORMAL_AVAILABLE = true;
  if (schema.some((parameter) => parameter.name === 'directMultiscatteringLut'))
    defines.DIRECT_DFG_LUT_AVAILABLE = true;
  for (const parameter of schema) {
    if (parameter.type === 'texture2d') {
      const name = parameter.name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
      defines[`${name}_AVAILABLE`] = true;
    }
  }
  return defines;
}

function defineStandardFeatures(
  schema: readonly ParamSchemaEntry[],
  layerPlan: StandardLayerPlan,
): Readonly<Record<string, boolean>> {
  const names = new Set(schema.map((entry) => entry.name));
  const defines = standardMaterialDefines(schema);
  const hasLayer = (name: string): boolean => layerPlan.layers.some((layer) => layer.name === name);
  if (hasLayer('anisotropy')) defines.ANISOTROPY_AVAILABLE = true;
  if (hasLayer('sheen')) defines.SHEEN_AVAILABLE = true;
  if (hasLayer('iridescence')) defines.IRIDESCENCE_AVAILABLE = true;
  if (hasLayer('clearcoat')) defines.CLEARCOAT_AVAILABLE = true;
  if (hasLayer('diffuseTransmission')) defines.DIFFUSE_TRANSMISSION_AVAILABLE = true;
  if (hasTransmission(names)) {
    defines.TRANSMISSION_AVAILABLE = true;
  }
  return defines;
}

/**
 * Lower one Standard root contract exactly once.  The result is deliberately
 * independent of runtime values, texture GUIDs, or sampler identity: only
 * declared parameter names select the physical source and ABI.
 */
export function lowerStandardContract(
  parameters: readonly MaterialParameter[],
  passes?: readonly MaterialPass[],
  material = '<anonymous>',
  staticSwitches?: MaterialStaticSwitches,
): Result<LoweredStandardContract, MaterialError> {
  const standard = usesStandardTemplate(passes);
  let layerPlan: StandardLayerPlan;
  try {
    layerPlan = deriveStandardLayerPlan(
      standard ? parameters : [],
      standard ? passes : undefined,
      staticSwitches,
    );
  } catch (error) {
    if (isMaterialPhysicalContractError(error)) {
      return err(
        createMaterialError('material-physical-contract-invalid', error.detail, error.message),
      );
    }
    throw error;
  }
  const schema = projectMaterialParameterSchema(parameters, material, 'cook', staticSwitches);
  if (!schema.ok) return schema;
  const directDfg = standard
    ? schema.value.find((entry) => entry.name === 'directMultiscatteringLut')
    : undefined;
  if (directDfg !== undefined && directDfg.type !== 'u32') {
    return err({
      ...createMaterialError(
        'material-parameter-type-unsupported',
        {
          code: 'material-parameter-type-unsupported',
          stage: 'cook',
          material,
          parameter: directDfg.name,
          type: directDfg.type,
          action: 'use-supported-type',
        },
        'Standard directMultiscatteringLut must be declared as u32',
      ),
      hint: 'declare directMultiscatteringLut as u32: zero selects the fit; nonzero selects the LUT',
    });
  }
  const defines = {
    ...(standard ? defineStandardFeatures(schema.value, layerPlan) : {}),
    ...(parameters.some((parameter) => parameter.name === 'fragmentOutput')
      ? { MATERIAL_FRAGMENT_OUTPUT_AVAILABLE: true }
      : {}),
    MATERIAL_CLIPPING_AVAILABLE: parameters.some(
      (parameter) => parameter.name === 'clippingControl',
    ),
  };
  return ok({
    layerPlan,
    paramSchema: schema.value,
    defines,
    layoutIdentity: derive(schema.value).layoutIdentity,
  });
}

/**
 * Move the template's reserved physical texture declarations into the compact
 * resource region for this exact root contract.  The template keeps readable
 * canonical slots (26, 28, …) while the cooked artifact owns the final ABI;
 * absent slots are removed by the normal boolean-define specialization pass.
 */
export function lowerStandardPhysicalBindings(
  source: string,
  schema: readonly ParamSchemaEntry[],
  specializeTextures = false,
  defines: Readonly<Record<string, boolean>> = {},
): string {
  const fields = standardPhysicalTextureFields(schema);
  const names = new Set(schema.map((entry) => entry.name));
  const physicalFieldSet = new Set<string>(fields);
  const nonPhysicalSchema = schema.filter((entry) => !physicalFieldSet.has(entry.name));
  const nonPhysical = derive(nonPhysicalSchema);
  let lowered = source;
  const loadOnlySamplers = new Set(
    schema.flatMap((parameter) =>
      'sampleType' in parameter && parameter.sampleType === 'unfilterable-float'
        ? [`${parameter.name}_sampler`, `${parameter.name.replace(/Texture$/, '')}Sampler`]
        : [],
    ),
  );
  // These unreachable witnesses compensate for Naga's helper-call reflection.
  // They must not invent filtering use for a declared load-only texture.
  if (loadOnlySamplers.size > 0) {
    lowered = lowered.replace(/fn materialTextureFilteringWitness\(\) \{[\s\S]*?\n\}/g, (witness) =>
      witness
        .split('\n')
        .filter((line) => {
          const sampler = /textureSample\([^,]+,\s*(\w+)/.exec(line)?.[1];
          return sampler === undefined || !loadOnlySamplers.has(sampler);
        })
        .join('\n'),
    );
  }
  // The template keeps readable canonical slots for the base textures and
  // engine injections.  The effective root may omit the old specular-color
  // pair or any transmission pair, so move each fixed declaration to the
  // exact binding derived from the effective non-physical schema before
  // compacting IBL/transmission and the declaration-driven physical tail.
  const bindingByName = new Map<string, number>();
  for (const resource of nonPhysical.resourceBindings) {
    bindingByName.set(resource.name, resource.binding);
    if (resource.kind === 'sampler' && resource.parameter !== undefined)
      bindingByName.set(`${resource.parameter.replace(/Texture$/, '')}Sampler`, resource.binding);
  }
  const iblNames = [
    'irradianceMap',
    'irradianceSampler',
    'prefilterMap',
    'prefilterSampler',
    'brdfLut',
    'skylight',
  ];
  for (const [index, name] of iblNames.entries())
    bindingByName.set(name, nonPhysical.userRegionBindingEnd + index);
  if (hasTransmission(names)) {
    bindingByName.set('transmissionBackdropSampler', nonPhysical.userRegionBindingEnd + 6);
    bindingByName.set('transmissionBackdropTexture', nonPhysical.userRegionBindingEnd + 7);
  }
  if (names.has('directMultiscatteringLut'))
    bindingByName.set('directDfgLut', STANDARD_DIRECT_DFG_LUT_BINDING);
  // The low-limit transmission variant declares no split scalar maps; its
  // transmission resources take over those exact pairs of the fixed layout.
  if (defines[STANDARD_SHARED_TRANSMISSION_DEFINE] === true) {
    for (const slot of STANDARD_SHARED_TRANSMISSION_SLOTS) {
      const texture = bindingByName.get(slot.host);
      const sampler = bindingByName.get(`${slot.host}_sampler`);
      if (texture === undefined || sampler === undefined)
        throw new Error(`shared transmission host ${slot.host} is absent from the Standard ABI`);
      bindingByName.set(slot.resource, texture);
      if ('sampler' in slot) bindingByName.set(slot.sampler, sampler);
    }
  }
  for (const [index, field] of STANDARD_PHYSICAL_TEXTURE_FIELDS.entries()) {
    if (!fields.includes(field)) continue;
    bindingByName.set(`${field}_sampler`, STANDARD_PHYSICAL_BINDING_START + index * 2);
    bindingByName.set(
      `${field.replace(/Texture$/, '')}Sampler`,
      STANDARD_PHYSICAL_BINDING_START + index * 2,
    );
    bindingByName.set(field, STANDARD_PHYSICAL_BINDING_START + 1 + index * 2);
  }
  // Remap named declarations in one pass. Replacing bare binding numbers can
  // move an unrelated generated resource twice and alias a physical texture.
  lowered = lowered.replace(
    /(@group\(1\)\s*@binding\()\d+(\)\s+var(?:<[^>]+>)?\s+([A-Za-z_]\w*)\b)/g,
    (declaration, prefix: string, suffix: string, name: string) => {
      const binding = bindingByName.get(name);
      return binding === undefined ? declaration : `${prefix}${binding}${suffix}`;
    },
  );
  // Canonical normal and height maps are mutually exclusive. Share their GPU
  // pair without merging their independent UV records or authored presence bits.
  if (specializeTextures && names.has('normalTexture') && names.has('bumpTexture')) {
    lowered = lowered
      .replace(/@group\(1\)\s*@binding\(\d+\)\s*var\s+bumpTexture(?:_sampler)?\s*:[^;]+;/g, '')
      .replace(/\bbumpTexture_sampler\b/g, 'normalTexture_sampler')
      .replace(/\bbumpTexture\b/g, 'normalTexture');
  }
  // A cooked root is already sparse. The shared engine entry keeps its stable
  // BGL, but the GPU compiler can eliminate absent sampling paths at PSO creation.
  // Both the runtime mask and these bit positions derive from the same schema.
  const textureFunctions = STANDARD_MATERIAL_PARAM_SCHEMA.filter(
    (entry) => entry.type === 'texture2d',
  )
    .map((entry, index) => {
      if (!names.has(entry.name)) return '';
      const name = entry.name[0]?.toUpperCase() + entry.name.slice(1);
      const value = specializeTextures ? `(standardTextureMask & ${2 ** index}u) != 0u` : 'true';
      return `fn standardUses${name}() -> bool { return ${value}; }`;
    })
    .join('\n');
  const sampleReuseFunctions = STANDARD_SAMPLE_REUSE.filter((entry) => names.has(entry.target))
    .flatMap((entry) =>
      entry.sources.map((source, index) => {
        const targetName = entry.target.charAt(0).toUpperCase() + entry.target.slice(1);
        const sourceName = source.charAt(0).toUpperCase() + source.slice(1);
        const selectorMask = 2 ** Math.ceil(Math.log2(entry.sources.length + 1)) - 1;
        const value = specializeTextures
          ? `((standardTextureMask >> ${entry.shift}u) & ${selectorMask}u) == ${index + 1}u`
          : 'false';
        return `fn standardReuses${targetName}From${sourceName}() -> bool { return ${value}; }`;
      }),
    )
    .join('\n');
  // Projection selectors change which slots sample and how; an unspecialized
  // entry keeps the UV/tangent path so no per-row value can alter control flow.
  const projectionFunctions = [
    ['TriplanarProjection', STANDARD_TRIPLANAR_PROJECTION_BIT],
    ['ObjectSpaceNormal', STANDARD_OBJECT_SPACE_NORMAL_BIT],
  ]
    .map(
      ([name, bit]) =>
        `fn standardUses${name}() -> bool { return ${specializeTextures ? `(standardTextureMask & ${bit}u) != 0u` : 'false'}; }`,
    )
    .join('\n');
  const textureOverride = specializeTextures
    ? `@id(${STANDARD_TEXTURE_MASK_OVERRIDE}) override standardTextureMask: u32 = ${standardTextureMask(STANDARD_MATERIAL_PARAM_SCHEMA)}u;\n`
    : '';
  // Keep the import prelude at the entry head. naga_oil resolves imports in
  // declaration order; prepending generated helper functions would make a
  // composable Surface import disappear before its inlined body is lowered.
  return `${lowered}\n${textureOverride}${textureFunctions}\n${sampleReuseFunctions}\n${projectionFunctions}`;
}
