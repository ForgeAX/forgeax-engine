import {
  readMaterialTemplateSources,
  validateMaterialTemplatePublication,
} from '@forgeax/engine-pack/material-cook';
import { createBuiltinMaterialAsset } from '@forgeax/engine-shader';
import { beforeAll, expect, it, vi } from 'vitest';
import {
  compileMaterialSelection,
  compileRayMaterialSelection,
  type PreparedShaderCompiler,
  prepareShaderCompiler,
  prepareShaderProgramCompiler,
} from '../../program.js';
import { cookMaterialAsset } from '../cook.js';
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
  expect(compile).toHaveBeenCalledTimes(1);
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
