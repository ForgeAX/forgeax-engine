import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack';
import {
  createMaterialPackCooker,
  getShaderCompilerFingerprint,
} from '@forgeax/engine-shader-compiler';
import {
  type MaterialAsset,
  sha256,
  standardMaterialParameters,
  standardSurfaceParameters,
  withClipping,
} from '@forgeax/engine-types';
import type { Material } from 'three/src/Three.Core.js';
import { materialTextures, projectMaterial, type SupportedMaterial } from '../material';
import {
  bindThreeSurface,
  clearSurfaceProgramSelection,
  type NormalizedSurface,
  normalizeThreeSurface,
  type SurfaceExpression,
  ThreeSurfaceError,
  type ThreeSurfaceRecipe,
} from '../node-surface';
import { packMaterialPrograms } from './program-publication';

const wgslType = (type: SurfaceExpression['type']) =>
  type === 'float' ? 'f32' : type === 'bool' ? 'bool' : `${type}<f32>`;
const width = (type: SurfaceExpression['type']) =>
  type.startsWith('vec') ? Number(type.slice(3)) : 1;
const float = (value: number) =>
  Object.is(value, -0) ? '-0.0' : Number.isInteger(value) ? `${value}.0` : String(value);

function lowerConstruct(
  expression: SurfaceExpression,
  graph: NormalizedSurface,
  arg: (index: number, promote?: boolean) => string,
): string {
  const { args, type } = expression;
  const from = graph.expressions[args[0] ?? -1]?.type ?? 'float';
  if (args.length === 1 && width(from) > width(type))
    return width(type) === 1
      ? `${arg(0, false)}.x`
      : `${arg(0, false)}.${'xyzw'.slice(0, width(type))}`;
  if (args.length === 1 && width(from) > 1 && width(from) < width(type))
    return `${wgslType(type)}(${arg(0, false)}, ${Array.from({ length: width(type) - width(from) }, (_, k) => (width(from) + k === 3 ? '1.0' : '0.0')).join(', ')})`;
  else return `${wgslType(type)}(${args.map((_, i) => arg(i, false)).join(', ')})`;
}

/** Lower the already-admitted DAG; there is no second node support table. */
export function lowerThreeSurface(graph: NormalizedSurface, module: string): string {
  const lines: string[] = [];
  graph.expressions.forEach((expression, index) => {
    const { op, type, args, data } = expression;
    const operandWidth = Math.max(
      width(type),
      ...args.map((i) => width(graph.expressions[i]?.type ?? 'float')),
    );
    const operandType = operandWidth === 1 ? 'f32' : `vec${operandWidth}<f32>`;
    const arg = (i: number, promote = true) => {
      const id = args[i];
      const inputType = graph.expressions[id ?? -1]?.type ?? 'float';
      if (!promote || width(inputType) === operandWidth) return `n${id}`;
      if (width(inputType) === 1) return `${operandType}(n${id})`;
      return `${operandType}(n${id}, ${Array.from({ length: operandWidth - width(inputType) }, (_, k) => (width(inputType) + k === 3 ? '1.0' : '0.0')).join(', ')})`;
    };
    let value: string;
    if (op === 'const')
      value =
        type === 'bool'
          ? String(data)
          : `${wgslType(type)}(${(data as readonly number[]).map(float).join(', ')})`;
    else if (op === 'input') value = `material.${data}`;
    else if (op === 'uv') value = `input.uv${data}`;
    else if (op === 'texture') {
      const name = String(data);
      const uv =
        args.length === 0
          ? `surfaceUv(input, material.${name}CoordinatesTransform, material.${name}CoordinatesMetadata, material.${name}CoordinatesRotation)`
          : arg(0, false);
      value = `sampleSurfaceTexture(${name}, ${name}_sampler, (${uv}) * material.${name}CoordinatesMetadata.zw, surfaceTextureFootprint(input, material.${name}CoordinatesTransform, material.${name}CoordinatesMetadata))`;
    } else if (op === 'split') value = `${arg(0, false)}.${data}`;
    else if (op === 'construct') value = lowerConstruct(expression, graph, arg);
    else if (op === 'select')
      value = `select(${arg(2, false)}, ${arg(1, false)}, ${arg(0, false)})`;
    else if (['+', '-', '*', '/', '<', '<=', '>', '>=', '==', '!='].includes(op))
      value = `${arg(0)} ${op} ${arg(1)}`;
    else if (op === 'negate') value = `-${arg(0)}`;
    else if (op === 'oneMinus') value = `${operandType}(1.0) - ${arg(0)}`;
    else if (op === 'saturate')
      value = `clamp(${arg(0)}, ${operandType}(0.0), ${operandType}(1.0))`;
    else if (op === 'mod') value = `${arg(0)} - ${arg(1)} * floor(${arg(0)} / ${arg(1)})`;
    else value = `${op}(${args.map((_, i) => arg(i)).join(', ')})`;
    lines.push(`  let n${index}: ${wgslType(type)} = ${value};`);
  });
  const root = (name: keyof NormalizedSurface['roots']) => graph.roots[name];
  const color = root('colorNode'),
    opacity = root('opacityNode');
  const colorAlpha =
    color !== undefined && graph.expressions[color]?.type === 'vec4' ? `n${color}.a` : '1.0';
  if (color !== undefined)
    lines.push(
      `  surface.baseColor = n${color}${graph.expressions[color]?.type === 'vec4' ? '.rgb' : ''} * input.vertexColor.rgb;`,
    );
  if (color !== undefined || opacity !== undefined) {
    // Replaced maps are absent. Preserve ordinary color-map alpha and ordinary alphaMap
    // by evaluating a neutral opacity/color when that root is replaced.
    lines.push(
      `  surface.opacity = surface.opacity * ${colorAlpha}${opacity === undefined ? '' : ` * n${opacity}`};`,
    );
  }
  const assignments = {
    roughnessNode: 'roughness',
    metalnessNode: 'metallic',
    emissiveNode: 'emissive',
    alphaTestNode: 'alphaClipThreshold',
  } as const;
  for (const [name, target] of Object.entries(assignments)) {
    const id = root(name as keyof typeof assignments);
    if (id !== undefined) lines.push(`  surface.${target} = n${id};`);
  }
  if (graph.model === 'unlit')
    lines.push(
      '  let clipThreshold = surface.alphaClipThreshold;',
      '  surface = surfaceEmissionOnly(input, surface.baseColor, surface.opacity);',
      '  surface.alphaClipThreshold = clipThreshold;',
    );
  if (root('alphaTestNode') !== undefined)
    // Engine's generic positive-threshold gate treats zero as disabled. An
    // authored r187 alphaTestNode remains enabled at zero or negative values.
    // Recipes only publish raster programs, and native alphaCutoff selects MASK.
    lines.push(
      '#if ALPHA_MASK == true',
      '  if (surface.alphaClipThreshold <= 0.0 && surface.opacity <= surface.alphaClipThreshold) { discard; }',
      '#endif',
    );
  lines.push('  return surface;');
  const textures = graph.textures.map(({ name }) => `${name}, ${name}_sampler`);
  return `#define_import_path ${module}\n#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData, surfaceEmissionOnly}\n#import forgeax_material::parameters::{material${textures.length ? `, ${textures.join(', ')}` : ''}}\n#import forgeax_material::default_standard_surface::{evaluate_standard_surface${graph.textures.length ? ', surfaceUv' : ''}}\n${graph.textures.length ? '#import forgeax_material::surface_sampling::{sampleSurfaceTexture, surfaceTextureFootprint}\n' : ''}fn evaluate_surface(input: SurfaceInput) -> SurfaceData {\n  var surface = evaluate_standard_surface(input, material);\n${lines.join('\n')}\n}\n`;
}

/** Build-only producer. Pass an explicitly constructed, host-neutral r187 graph. */
export async function cookThreeSurface(
  material: Material,
  { planarReflection = false }: { readonly planarReflection?: boolean } = {},
): Promise<{ readonly recipe: ThreeSurfaceRecipe; readonly publication: string }> {
  const graph = normalizeThreeSurface(material).unwrap();
  if (planarReflection && graph.model !== 'standard')
    throw new ThreeSurfaceError(
      material,
      'planarReflection',
      'unsupported-node',
      'Planar reflection requires a Standard surface.',
    );
  if (material.alphaHash || material.alphaToCoverage)
    throw new ThreeSurfaceError(
      material,
      'alphaHash/alphaToCoverage',
      'unsupported-node',
      'expression coverage requires separate derivative/hash acceptance',
    );
  const fingerprint = (await getShaderCompilerFingerprint()).unwrap();
  let programGuid = `forgeax-three-surface-${'0'.repeat(64)}`;
  let recipe: ThreeSurfaceRecipe = {
    version: 'three-r187-surface/1',
    graphKey: graph.graphKey,
    programGuid,
  };
  bindThreeSurface(material, recipe).unwrap();
  const textures = Object.fromEntries(
    materialTextures(material as SupportedMaterial).map(([name]) => [
      name,
      { texture: 'forgeax-three-surface-build-placeholder' },
    ]),
  );
  let source = projectMaterial(
    material as SupportedMaterial,
    textures,
    undefined,
    planarReflection,
  ).unwrap();
  const module = `forgeax_three::surface_${graph.graphKey}`;
  source = {
    ...source,
    parameters: standardSurfaceParameters([
      ...(source.parameters ??
        standardMaterialParameters(new Set(Object.keys(source.values ?? {})))),
      ...graph.parameters,
    ]),
    passes: source.passes?.map((pass) => ({
      ...pass,
      program: { ...pass.program, moduleSlots: { ...pass.program.moduleSlots, surface: module } },
    })) as MaterialAsset['passes'],
  } as MaterialAsset;
  const root = await mkdtemp(join(tmpdir(), 'forgeax-three-surface-'));
  try {
    const wgsl = lowerThreeSurface(graph, module);
    await writeFile(join(root, 'surface.wgsl'), wgsl);
    const cooker = createMaterialPackCooker([root], { profile: 'webgpu-storage' });
    const ownerIdentity = await cooker.cacheIdentity?.();
    const identity = [graph.graphKey, wgsl, fingerprint, ownerIdentity];
    if (planarReflection) identity.push('planar-reflection');
    programGuid = `forgeax-three-surface-${sha256(JSON.stringify(identity))}`;
    recipe = { ...recipe, programGuid };
    bindThreeSurface(material, recipe).unwrap();
    clearSurfaceProgramSelection(source);
    const cooked = await cooker.cook({
      guid: programGuid,
      source: withClipping(source, { planes: [] }),
    });
    const record = validateCookedMaterialRecord(
      (cooked.payload as { cooked: unknown }).cooked,
    ).unwrap();
    return { recipe, publication: await packMaterialPrograms([record]) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
