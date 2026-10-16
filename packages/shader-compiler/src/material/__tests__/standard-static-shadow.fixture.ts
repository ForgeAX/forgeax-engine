import { fileURLToPath } from 'node:url';
import {
  type MaterialAsset,
  type MaterialStaticSwitches,
  standardSurfaceParameters,
} from '@forgeax/engine-types';
import { cookMaterialAsset } from '../cook.js';
import { collectMaterialSources } from '../pack-cooker.js';
import { buildMaterialSourceCatalog } from '../source-catalog.js';
import { DEFAULT_MATERIAL_VARIANT_CONTEXT, type MaterialVariantContext } from '../variant-context';

const shaderRoot = fileURLToPath(new URL('../../../../shader/src', import.meta.url));
const collected = await collectMaterialSources([shaderRoot], [shaderRoot]);
const standard = collected.engine.find(
  (entry) => entry.moduleId === 'forgeax_material::default_standard_surface',
);
if (standard === undefined) throw new Error('missing Standard Surface source');
const sources = buildMaterialSourceCatalog({
  engine: collected.engine,
  project: [
    {
      path: 'static-shadow-custom.wgsl',
      source: standard.source
        .replace('forgeax_material::default_standard_surface', 'static_shadow_test::custom')
        .replace('var baseSample =', 'if (input.uv0.x < 0.5) { discard; }\n  var baseSample ='),
    },
  ],
}).unwrap();

export const OPAQUE_SWITCHES = {
  alphaClipping: false,
  alphaHash: false,
  displacement: false,
} as const satisfies MaterialStaticSwitches;

export async function cookStaticShadow(
  options: {
    readonly staticSwitches?: MaterialStaticSwitches;
    readonly custom?: boolean;
    readonly normalMapped?: boolean;
    readonly context?: Partial<MaterialVariantContext>;
  } = {},
) {
  const surface = options.custom
    ? 'static_shadow_test::custom'
    : 'forgeax_material::default_standard_surface';
  const asset: MaterialAsset = {
    kind: 'material',
    parameters: standardSurfaceParameters([
      { name: 'baseColorTexture', type: 'texture' },
      ...(options.normalMapped ? [{ name: 'normalTexture', type: 'texture' as const }] : []),
      { name: 'displacementTexture', type: 'texture' },
      { name: 'clippingControl', type: 'vec4' },
      ...['A', 'B', 'C', 'D', 'E', 'F'].map((suffix) => ({
        name: `clippingPlane${suffix}`,
        type: 'vec4' as const,
      })),
    ]),
    staticSwitches: options.staticSwitches ?? OPAQUE_SWITCHES,
    values: { alphaCutoff: 0, alphaHash: 0, displacementScale: 0 },
    passes: [
      {
        name: 'forward',
        program: {
          module:
            options.context?.geometry === 'skinned'
              ? 'forgeax_material::pbr-skin'
              : 'forgeax_material::standard',
          moduleSlots: { surface },
        },
      },
      {
        name: 'shadow-caster',
        program: { module: 'forgeax::default-shadow-caster', moduleSlots: { surface } },
      },
    ],
  };
  const cooked = (
    await cookMaterialAsset({
      material: 'static-shadow-test',
      table: { 'static-shadow-test': asset },
      sources,
      context: { ...DEFAULT_MATERIAL_VARIANT_CONTEXT, ...options.context },
    })
  ).unwrap();
  const shadow = cooked.passes.find((pass) => pass.pass === 'shadow-caster');
  const forward = cooked.passes.find((pass) => pass.pass === 'forward');
  if (shadow === undefined || forward === undefined) throw new Error('missing raster pass');
  return { ...cooked, shadow, forward };
}
