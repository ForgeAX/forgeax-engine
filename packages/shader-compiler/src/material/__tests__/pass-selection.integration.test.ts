import { sha256 } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import type { compileShader } from '../../compile.js';
import {
  prepareShaderCompiler,
  publishMaterialSourceModules,
  readMaterialSourceModules,
  rebuildMaterialRasterProgram,
} from '../../program.js';
import { createShaderProgramCompiler } from '../../program-compiler.js';
import { cookMaterialAsset, type MaterialCookRequest } from '../cook.js';
import { createMaterialPackVariantCompiler } from '../pack-variant-reuse.js';
import { buildMaterialSourceCatalog } from '../source-catalog.js';

const source = `#define_import_path test::selected_pass
#import forgeax_material::parameters::{material}
@vertex fn vs_main() -> @builtin(position) vec4f { return vec4f(0, 0, 0, 1); }
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(material.roughness); }
`;
const request: MaterialCookRequest = {
  material: 'selected',
  table: {
    selected: {
      kind: 'material',
      parameters: [{ name: 'roughness', type: 'f32', default: 0.6 }],
      passes: [
        { name: 'forward', program: { module: 'test::selected_pass' } },
        { name: 'later', program: { module: 'test::selected_pass' } },
      ],
    },
  },
  sources: buildMaterialSourceCatalog({
    engine: [],
    project: [{ path: '/selected.wgsl', source }],
  }).unwrap(),
};

it('compiles only selected derivatives while retaining the complete material contract', async () => {
  const native = createShaderProgramCompiler();
  let calls = 0;
  const compile: typeof compileShader = (...args) => {
    calls++;
    return native(...args);
  };
  const full = (await cookMaterialAsset(request, compile)).unwrap();
  expect(calls).toBe(2);
  calls = 0;
  const selected = (await cookMaterialAsset(request, compile, ['forward'])).unwrap();
  expect(calls).toBe(1);
  expect(selected.passes).toEqual([full.passes[0]]);
  expect(selected.resolved).toEqual(full.resolved);
  expect(selected.layerPlan).toEqual(full.layerPlan);
  expect((await cookMaterialAsset(request, compile, ['missing'])).ok).toBe(false);
});

it('separates full and selected cache entries and canonicalizes selection membership', async () => {
  const native = createShaderProgramCompiler();
  let calls = 0;
  const cached = createMaterialPackVariantCompiler((...args) => {
    calls++;
    return native(...args);
  }).raster;
  expect((await cached(request, 'namespace', ['forward'])).unwrap().passes).toHaveLength(1);
  expect(calls).toBe(1);
  expect((await cached(request, 'namespace')).unwrap().passes).toHaveLength(2);
  expect(calls).toBe(3);
  expect((await cached(request, 'namespace', ['forward'])).unwrap().passes).toHaveLength(1);
  expect(calls).toBe(3);
  expect(
    (await cached(request, 'namespace', ['later', 'forward', 'forward'])).unwrap().passes,
  ).toHaveLength(2);
  expect(calls).toBe(5);
  expect((await cached(request, 'namespace', ['forward', 'later'])).unwrap().passes).toHaveLength(
    2,
  );
  expect(calls).toBe(5);
});

it('round-trips original source references and rebuilds just the selected artifact', async () => {
  const engineModule = 'forgeax_test::palette';
  const engineSource = `#define_import_path ${engineModule}
fn authoredColor() -> f32 { return 0.7; }`;
  const root = source
    .replace(
      '#import forgeax_material::parameters::',
      `#import ${engineModule}::{authoredColor}\n#import forgeax_material::parameters::`,
    )
    .replace('material.roughness', 'material.roughness * authoredColor()');
  const sources = buildMaterialSourceCatalog({
    engine: [{ source: engineSource, path: '/palette.wgsl' }],
    project: [{ source: root, path: '/selected.wgsl' }],
  }).unwrap();
  const rootRequest = { ...request, sources };
  const baseline = (await cookMaterialAsset(rootRequest)).unwrap().passes[0]?.compile;
  if (baseline === undefined) throw new Error('Missing native Pack program');
  const compiler = (await prepareShaderCompiler()).unwrap();
  const shared = {
    sources: { [sha256(engineSource)]: engineSource },
  };
  const publication = publishMaterialSourceModules(
    sources,
    ['test::selected_pass', engineModule, engineModule],
    shared,
  ).unwrap();
  expect(publication.modules).toEqual([
    { kind: 'engine', module: engineModule, digest: sha256(engineSource) },
    { kind: 'project', module: 'test::selected_pass', digest: sha256(root), source: root },
  ]);
  const transported: unknown = JSON.parse(JSON.stringify(publication));
  expect(readMaterialSourceModules(transported, { sources: {} }).ok).toBe(false);
  expect(publishMaterialSourceModules(sources, [engineModule], { sources: {} }).ok).toBe(false);
  const wrongName = JSON.parse(JSON.stringify(publication));
  wrongName.modules[0].module = 'forgeax_test::other';
  expect(readMaterialSourceModules(wrongName, shared).ok).toBe(false);
  const tampered = JSON.parse(JSON.stringify(publication));
  tampered.modules[1].source += '\n// tampering';
  expect(readMaterialSourceModules(tampered, shared).ok).toBe(false);
  const restored = readMaterialSourceModules(transported, shared).unwrap();
  const compile = vi.fn(compiler.compile);
  const runtimeRequest = { ...request, sources: restored };
  const selection = {
    pass: 'forward',
    address: 'direct',
    artifactDigest: `sha256:${sha256(baseline.wgsl)}`,
  } as const;
  expect(rebuildMaterialRasterProgram({ compile }, runtimeRequest, selection).unwrap()).toEqual(
    baseline,
  );
  expect(compile).toHaveBeenCalledOnce();
  expect(
    rebuildMaterialRasterProgram({ compile }, runtimeRequest, {
      ...selection,
      address: 'scene-index',
    }).ok,
  ).toBe(false);
  expect(
    rebuildMaterialRasterProgram({ compile }, runtimeRequest, { ...selection, pass: 'undeclared' })
      .ok,
  ).toBe(false);
  expect(compile).toHaveBeenCalledOnce();
  expect(
    rebuildMaterialRasterProgram({ compile }, runtimeRequest, {
      ...selection,
      artifactDigest: `sha256:${sha256('changed program')}`,
    }).ok,
  ).toBe(false);
});
