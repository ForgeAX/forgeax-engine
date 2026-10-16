import type { ParamSchemaEntry } from '../index.js';
import type { MaterialParameter } from './asset.js';
import {
  STANDARD_PHYSICAL_PARAMETER_NAMES,
  STANDARD_TRANSMISSION_PARAMETER_NAMES,
} from './standard-layer-plan.js';

/** The single Standard material parameter vocabulary shared by shader, cookers, and importers. */
export const STANDARD_MATERIAL_PARAM_SCHEMA: readonly ParamSchemaEntry[] = [
  { name: 'baseColor', type: 'color', default: [1, 1, 1, 1] },
  { name: 'metallic', type: 'f32', default: 0 },
  { name: 'roughness', type: 'f32', default: 0.5 },
  { name: 'subsurfaceRadius', type: 'vec3', default: [0, 0, 0] },
  { name: 'subsurfaceWeight', type: 'f32', default: 0 },
  { name: 'metallicChannel', type: 'f32', default: 2 },
  { name: 'roughnessChannel', type: 'f32', default: 1 },
  { name: 'aoChannel', type: 'f32', default: 0 },
  { name: 'extraChannel', type: 'f32', default: 0 },
  { name: 'emissive', type: 'vec3', colorSpace: 'srgb', default: [0, 0, 0] },
  { name: 'emissiveIntensity', type: 'f32', default: 0 },
  { name: 'occlusionStrength', type: 'f32', default: 1 },
  { name: 'alphaCutoff', type: 'f32', default: 0 },
  { name: 'specular', type: 'f32', default: 1 },
  { name: 'alphaHash', type: 'f32', default: 0 },
  { name: 'specularColor', type: 'vec3', colorSpace: 'srgb', default: [1, 1, 1] },
  { name: 'normalScale', type: 'vec2', default: [1, 1] },
  { name: 'bumpScale', type: 'f32', default: 1 },
  { name: 'transmission', type: 'f32', default: 0 },
  { name: 'ior', type: 'f32', default: 1.5 },
  { name: 'thickness', type: 'f32', default: 0 },
  { name: 'attenuationColor', type: 'vec3', colorSpace: 'linear', default: [1, 1, 1] },
  { name: 'attenuationDistance', type: 'f32' },
  { name: 'baseColorTexture', type: 'texture2d' },
  { name: 'metallicRoughnessTexture', type: 'texture2d' },
  { name: 'normalTexture', type: 'texture2d' },
  { name: 'specularColorTexture', type: 'texture2d' },
  { name: 'emissiveTexture', type: 'texture2d' },
  { name: 'occlusionTexture', type: 'texture2d' },
  { name: 'transmissionTexture', type: 'texture2d' },
  { name: 'thicknessTexture', type: 'texture2d' },
  { name: 'bumpTexture', type: 'texture2d' },
  { name: 'anisotropyStrength', type: 'f32', default: 0 },
  { name: 'anisotropyRotation', type: 'f32', default: 0 },
  { name: 'iridescence', type: 'f32', default: 0 },
  { name: 'iridescenceIor', type: 'f32', default: 1.3 },
  { name: 'iridescenceThicknessMinimum', type: 'f32', default: 100 },
  { name: 'iridescenceThicknessMaximum', type: 'f32', default: 400 },
  { name: 'sheenColor', type: 'vec3', colorSpace: 'linear', default: [0, 0, 0] },
  { name: 'sheenRoughness', type: 'f32', default: 0 },
  { name: 'clearcoat', type: 'f32', default: 0 },
  { name: 'clearcoatRoughness', type: 'f32', default: 0 },
  { name: 'clearcoatNormalScale', type: 'f32', default: 1 },
  { name: 'clearcoatTexture', type: 'texture2d' },
  { name: 'clearcoatRoughnessTexture', type: 'texture2d' },
  { name: 'clearcoatNormalTexture', type: 'texture2d' },
  { name: 'anisotropyTexture', type: 'texture2d' },
  { name: 'sheenColorTexture', type: 'texture2d' },
  { name: 'sheenRoughnessTexture', type: 'texture2d' },
  { name: 'iridescenceTexture', type: 'texture2d' },
  { name: 'iridescenceThicknessTexture', type: 'texture2d' },
  { name: 'specularTexture', type: 'texture2d' },
  { name: 'alphaChannel', type: 'f32', default: 1 },
  { name: 'metallicTexture', type: 'texture2d' },
  { name: 'roughnessTexture', type: 'texture2d' },
  { name: 'alphaTexture', type: 'texture2d' },
  { name: 'displacementScale', type: 'f32', default: 1 },
  { name: 'displacementBias', type: 'f32', default: 0 },
  { name: 'displacementTexture', type: 'texture2d' },
  { name: 'diffuseTransmission', type: 'f32', default: 0 },
  { name: 'diffuseTransmissionColor', type: 'vec3', colorSpace: 'linear', default: [1, 1, 1] },
  { name: 'diffuseTransmissionTexture', type: 'texture2d' },
  { name: 'diffuseTransmissionColorTexture', type: 'texture2d' },
  // 0 = UV mapping, 1 = world-space triplanar, 2 = object-space triplanar.
  { name: 'triplanarSpace', type: 'f32', default: 0 },
  { name: 'triplanarScale', type: 'f32', default: 1 },
  { name: 'triplanarSharpness', type: 'f32', default: 1 },
  // 0 = tangent-space normal map, 1 = object-space normal map.
  { name: 'normalMapSpace', type: 'f32', default: 0 },
  // Optional resource capability: 0 uses the fit, nonzero samples the shared LUT.
  // Declaration is explicit; no baseline or canonical material acquires this field.
  { name: 'directMultiscatteringLut', type: 'u32', default: 1 },
] as const;

/**
 * Engine-owned Standard fields required by the shared template even when an
 * import-first Surface does not author those values.  Physical and
 * transmission extensions and the DFG LUT stay caller-owned so this baseline cannot silently
 * change the derived layer/pass policy. Texture slots are always explicit:
 * an implicit normal slot would incorrectly take precedence over a bump slot.
 */
export const STANDARD_SURFACE_PARAM_SCHEMA: readonly ParamSchemaEntry[] =
  STANDARD_MATERIAL_PARAM_SCHEMA.filter(
    (entry) =>
      !entry.type.startsWith('texture') &&
      entry.name !== 'directMultiscatteringLut' &&
      !STANDARD_PHYSICAL_PARAMETER_NAMES.has(entry.name) &&
      (!STANDARD_TRANSMISSION_PARAMETER_NAMES.has(entry.name) || entry.name === 'ior'),
  );

/**
 * Project a selected Standard root contract into the authoring vocabulary.
 * The schema remains the only name/type/default authority; callers choose
 * declarations by name and never maintain a second Standard parameter list.
 */
export function standardMaterialParameters(
  names: ReadonlySet<string>,
): readonly MaterialParameter[] {
  return STANDARD_MATERIAL_PARAM_SCHEMA.filter((entry) => names.has(entry.name)).map((entry) => {
    const type = entry.type === 'texture2d' ? 'texture' : entry.type;
    const isRequired =
      entry.name === 'baseColor' || entry.name === 'metallic' || entry.name === 'roughness';
    const defaultValue =
      entry.type === 'texture2d' || entry.default === undefined ? {} : { default: entry.default };
    return {
      name: entry.name,
      type,
      ...(!('colorSpace' in entry) || entry.colorSpace === undefined
        ? {}
        : { colorSpace: entry.colorSpace }),
      ...defaultValue,
      ...(isRequired ? {} : { optional: true }),
    } as MaterialParameter;
  });
}

/**
 * Complete the Standard template contract at the authoring boundary.
 * The returned declarations are the root MaterialAsset's published parameters;
 * compiler and runtime project them without adding implicit fields.
 */
export function standardSurfaceParameters(
  parameters: readonly MaterialParameter[],
): readonly MaterialParameter[] {
  const authoredNames = new Set(parameters.map((parameter) => parameter.name));
  const implicitNames = new Set(STANDARD_SURFACE_PARAM_SCHEMA.map((entry) => entry.name));
  const implicit = standardMaterialParameters(implicitNames).map((parameter) => ({
    ...parameter,
    optional: true,
  }));
  return [...implicit.filter((parameter) => !authoredNames.has(parameter.name)), ...parameters];
}
