import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ParamSchemaEntry } from '@forgeax/engine-types';
import { deriveStandardLayerPlan } from '@forgeax/engine-types';
import { prepareStandardSource } from '../src/material/compose.js';
import { buildMaterialSourceCatalog } from '../src/material/source-catalog.js';

/**
 * The Standard WGSL template is a compiler input, not a standalone product.
 * Keep one test-only fixture schema here and prepare the real engine template
 * through the same Surface/parameter lowering used by Pack and Vite.
 */
const STANDARD_TEST_SCHEMA: readonly ParamSchemaEntry[] = [
  { name: 'baseColor', type: 'color', default: [1, 1, 1, 1] },
  { name: 'metallic', type: 'f32', default: 0 },
  { name: 'roughness', type: 'f32', default: 0.5 },
  { name: 'metallicChannel', type: 'f32', default: 2 },
  { name: 'roughnessChannel', type: 'f32', default: 1 },
  { name: 'aoChannel', type: 'f32', default: 0 },
  { name: 'normalScale', type: 'vec2', default: [1, 1] },
  { name: 'emissive', type: 'vec3', default: [0, 0, 0] },
  { name: 'emissiveIntensity', type: 'f32', default: 0 },
  { name: 'occlusionStrength', type: 'f32', default: 1 },
  { name: 'alphaCutoff', type: 'f32', default: 0 },
  { name: 'ior', type: 'f32', default: 1.5 },
  { name: 'clearcoat', type: 'f32', default: 0 },
  { name: 'clearcoatRoughness', type: 'f32', default: 0.5 },
  { name: 'baseColorTexture', type: 'texture2d' },
  { name: 'metallicRoughnessTexture', type: 'texture2d' },
  { name: 'normalTexture', type: 'texture2d' },
  { name: 'emissiveTexture', type: 'texture2d' },
  { name: 'occlusionTexture', type: 'texture2d' },
];

const ENGINE_SOURCES = [
  'common.wgsl',
  'scene-temporal.wgsl',
  'fog.wgsl',
  'cloud.wgsl',
  'brdf.wgsl',
  'pbr-temporal.wgsl',
  'ibl-shared.wgsl',
  'ibl-sampling.wgsl',
  'tbn.wgsl',
  'lighting-directional.wgsl',
  'lighting-punctual.wgsl',
  'lighting-probe.wgsl',
  'standard-lighting.wgsl',
  'standard-gbuffer.wgsl',
  'standard-gbuffer-output.wgsl',
  'lighting-spot-modifiers.wgsl',
  'lighting-ies-profile.wgsl',
  'lighting-rect-area.wgsl',
  'lighting-attenuation.wgsl',
  'shadow-pcf.wgsl',
  'standard-cluster.wgsl',
  'surface_v1.wgsl',
  'surface-sampling.wgsl',
  'default_standard_surface.wgsl',
  'material/standard-physical-layer.wgsl',
  'default-standard-pbr.wgsl',
  'default-standard-pbr-skin.wgsl',
] as const;

function shaderRoot(): string {
  return join(import.meta.dirname, '..', '..', 'shader', 'src');
}

/** Prepare one real rigid/skinned Standard template through compiler lowering. */
export function prepareBuiltInStandard(file: 'default-standard-pbr.wgsl' | 'default-standard-pbr-skin.wgsl') {
  const root = shaderRoot();
  const templatePath = join(root, file);
  const templateSource = readFileSync(templatePath, 'utf8');
  const catalog = buildMaterialSourceCatalog({
    engine: ENGINE_SOURCES.map((relativePath) => ({
      path: join(root, relativePath),
      source: readFileSync(join(root, relativePath), 'utf8'),
    })),
    project: [],
  });
  if (!catalog.ok) throw new Error(catalog.error.message);
  const layerPlan = deriveStandardLayerPlan(STANDARD_TEST_SCHEMA);
  if (!layerPlan.ok) throw new Error(layerPlan.error.message);
  const prepared = prepareStandardSource({
    material: 'test-standard',
    pass: 'Forward',
    templateModule: file === 'default-standard-pbr.wgsl' ? 'forgeax_material::standard' : 'forgeax_material::pbr-skin',
    templatePath,
    templateSource,
    surfaceModule: 'forgeax_material::default_standard_surface',
    sourceRecords: catalog.value.entries(),
    paramSchema: STANDARD_TEST_SCHEMA,
    layerPlan: layerPlan.value,
  });
  if (!prepared.ok) throw new Error(prepared.error.message);
  return prepared.value;
}
