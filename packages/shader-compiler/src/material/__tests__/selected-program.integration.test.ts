import {
  readMaterialTemplateSources,
  validateMaterialTemplatePublication,
} from '@forgeax/engine-pack/material-cook';
import { createBuiltinMaterialAsset } from '@forgeax/engine-shader';
import { type MaterialAsset, standardSurfaceParameters } from '@forgeax/engine-types';
import { beforeAll, expect, it, vi } from 'vitest';
import {
  compileMaterialSelection,
  compileRayMaterialSelection,
  type PreparedShaderCompiler,
  prepareShaderCompiler,
  prepareShaderProgramCompiler,
} from '../../program.js';
import { compileMaterialAddressSelection, cookMaterialAsset } from '../cook.js';
import { collectMaterialSources, materialShaderSourceRoots } from '../pack-cooker.js';
import { createMaterialTemplateDraft } from '../pack-template.js';
import { cookRayMaterial } from '../ray-material.js';
import { buildMaterialSourceCatalog, type MaterialSourceCatalog } from '../source-catalog.js';
import { DEFAULT_MATERIAL_VARIANT_CONTEXT } from '../variant-context.js';

const material = 'standard';
const table = { [material]: createBuiltinMaterialAsset('standard') };
let sources: MaterialSourceCatalog;
let compiler: PreparedShaderCompiler;

beforeAll(async () => {
  const roots = materialShaderSourceRoots();
  const records = await collectMaterialSources(roots, roots);
  sources = buildMaterialSourceCatalog({ roots, ...records }).unwrap();
  compiler = (await prepareShaderCompiler()).unwrap();
});

it.each([
  ['webgpu', 'storage-buffer', 2],
  ['webgl2', 'uniform-fallback', 1],
] as const)('compiles the selected %s Standard pass with identical WGSL and ABI', async (backend, capability, count) => {
  const request = {
    material,
    table,
    sources,
    context: { ...DEFAULT_MATERIAL_VARIANT_CONTEXT, backend, capability },
  };
  const compile = vi.fn(compiler.compile);
  const actual = compileMaterialSelection(request, { ...compiler, compile }, ['forward']).unwrap();
  const cooked = (await cookMaterialAsset(request, undefined, ['forward'])).unwrap();
  expect(actual).toEqual(cooked);
  expect(actual.passes.map((pass) => pass.pass)).toEqual(['forward']);
  expect(compile).toHaveBeenCalledTimes(count);
});

it('compiles and validates one requested address at a time', () => {
  const request = { material, table, sources, context: DEFAULT_MATERIAL_VARIANT_CONTEXT };
  const both = compileMaterialSelection(request, compiler, ['forward']).unwrap().passes[0];
  if (both?.sceneCompile === undefined) throw new Error('Expected a published GPU Scene entry');
  const compile = vi.fn(compiler.compile);
  const service = { ...compiler, compile };
  const direct = compileMaterialAddressSelection(request, service, {
    pass: 'forward',
    address: 'direct',
  }).unwrap();
  expect(compile).toHaveBeenCalledTimes(1);
  expect(direct?.compile.wgsl).toEqual(both.compile.wgsl);
  expect(direct?.abi.sceneIndexEntry).toBeUndefined();

  const scene = compileMaterialAddressSelection(request, service, {
    pass: 'forward',
    address: 'scene-index',
  }).unwrap();
  expect(compile).toHaveBeenCalledTimes(2);
  expect(scene?.compile.wgsl).toEqual(both.sceneCompile.wgsl);
  expect(scene?.abi.vertexInputs).toEqual(both.abi.vertexInputs);
  expect(scene?.abi.sceneIndexEntry).toEqual(both.abi.sceneIndexEntry);
  expect(scene?.abi.tangentFrame32).toEqual(both.abi.tangentFrame32);

  const uniform = {
    ...request,
    context: {
      ...request.context,
      backend: 'webgl2' as const,
      capability: 'uniform-fallback' as const,
    },
  };
  expect(
    compileMaterialAddressSelection(uniform, service, {
      pass: 'forward',
      address: 'scene-index',
    }).unwrap(),
  ).toBeUndefined();
  expect(compile).toHaveBeenCalledTimes(2);
});

it('derives the two texture pairs of an authored packed Surface', async () => {
  const roots = materialShaderSourceRoots();
  const records = await collectMaterialSources(roots, roots);
  const source = `#define_import_path test::packed_surface
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}
#import forgeax_material::parameters::{colorAo, colorAo_sampler, normalRoughMetal, normalRoughMetal_sampler}
fn evaluate_surface(input: SurfaceInput) -> SurfaceData {
  let color = textureSample(colorAo, colorAo_sampler, input.uv0);
  let nrm = textureSample(normalRoughMetal, normalRoughMetal_sampler, input.uv0);
  let xy = nrm.rg * 2.0 - 1.0;
  let z = sqrt(max(1.0 - dot(xy, xy), 0.0));
  let n = normalize(input.vertexNormalWS);
  let t = normalize(input.tangentWS.xyz);
  let b = cross(n, t) * input.tangentWS.w;
  return SurfaceData(color.rgb, normalize(xy.x * t + xy.y * b + z * n), nrm.a, nrm.b,
    vec3<f32>(0.0), color.a, 1.0, 0.0, 0.0);
}`;
  const sourceCatalog = buildMaterialSourceCatalog({
    roots,
    ...records,
    project: [
      ...records.project,
      { path: 'packed-surface.wgsl', moduleId: 'test::packed_surface', source },
    ],
  }).unwrap();
  const asset: MaterialAsset = {
    kind: 'material',
    parameters: standardSurfaceParameters([
      { name: 'colorAo', type: 'texture' },
      { name: 'normalRoughMetal', type: 'texture' },
    ]),
    passes: [
      {
        name: 'forward',
        program: {
          module: 'forgeax_material::standard',
          moduleSlots: { surface: 'test::packed_surface' },
        },
      },
    ],
  };
  const compiled = compileMaterialAddressSelection(
    {
      material,
      table: { [material]: asset },
      sources: sourceCatalog,
      context: DEFAULT_MATERIAL_VARIANT_CONTEXT,
    },
    compiler,
    { pass: 'forward', address: 'direct' },
  ).unwrap();
  expect(
    compiled?.abi.resourceSlots
      ?.filter(({ kind }) => kind === 'texture')
      .map(({ parameter }) => parameter),
  ).toEqual(['colorAo', 'normalRoughMetal']);
});

it('validates each requested render entry for a shared composition', () => {
  const source = `
@vertex fn vs_main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }
@fragment fn fs_color() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }
@fragment fn fs_id() -> @location(0) u32 { return 4u; }
`;
  const select = (fragment: string, format: GPUTextureFormat) =>
    compiler.compile(source, {
      renderEntries: { vertex: 'vs_main', fragment, colorFormats: [format] },
    });
  const color = select('fs_color', 'rgba8unorm').unwrap();
  expect(select('fs_id', 'rgba8unorm').ok).toBe(false);
  expect(select('fs_missing', 'rgba8unorm').ok).toBe(false);
  expect(select('fs_id', 'r32uint').unwrap()).toEqual(color);
});

it.each([
  'ray-hit',
  'card-capture',
] as const)('compiles the selected %s derivative with identical WGSL and ABI', async (context) => {
  const request = { material, table, sources, context };
  const compile = vi.fn(compiler.compile);
  const actual = compileRayMaterialSelection(request, { ...compiler, compile }).unwrap();
  const cooked = (await cookRayMaterial(request)).unwrap();
  expect(actual).toEqual(cooked);
  const derivative = `forgeax_material::ray_surface::${context}`;
  const contracts =
    context === 'card-capture'
      ? [derivative, 'forgeax_material::card_parameter_contract']
      : [derivative];
  expect(compile.mock.calls.map(([, options]) => options?.id)).toEqual(contracts);
});

it('reopens source-only Standard publication and compiles one selected context', async () => {
  const guid = '01900000-0000-7000-8000-000000000072';
  const asset = createBuiltinMaterialAsset('standard');
  const draft = createMaterialTemplateDraft(
    { guid, source: asset, table: { [guid]: asset } },
    sources,
  );
  const payload = draft.payload as { template: unknown };
  const publication = validateMaterialTemplatePublication(payload.template).unwrap();
  expect(Object.keys(draft.artifacts)).toEqual([publication.sourceArtifact.path]);
  const artifact = draft.artifacts[publication.sourceArtifact.path];
  if (artifact === undefined) throw new Error('Material source artifact was not published');
  const library = readMaterialTemplateSources(
    artifact.bytes,
    publication.sourceArtifact.digest,
  ).unwrap();
  expect(Object.keys(library.engine).length).toBeLessThan(sources.entries().length);
  const service = (await prepareShaderProgramCompiler()).unwrap();
  const prepared = service
    .prepareMaterial?.({ guid, material: publication.resolved, sources: library })
    .unwrap();
  if (prepared === undefined) throw new Error('Material compiler was not prepared');
  const selected = prepared
    .select({
      pass: 'forward',
      context: DEFAULT_MATERIAL_VARIANT_CONTEXT,
      vertexColorAvailable: false,
    })
    .unwrap();
  const build = (
    await cookMaterialAsset({ material: guid, table: { [guid]: asset }, sources }, undefined, [
      'forward',
    ])
  ).unwrap();
  expect(selected?.direct.wgsl).toEqual(build.passes[0]?.compile.wgsl);
  expect(selected?.sceneIndex?.wgsl).toEqual(build.passes[0]?.sceneCompile?.wgsl);
});
