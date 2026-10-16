import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack/material-cook';
import { GPU_DRIVEN_MATERIAL_ROW_BYTES } from '@forgeax/engine-shader';
import type { MaterialAsset, MaterialPass } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { cookMaterialAsset, generateParameterModule } from '../cook.js';
import { createMaterialPackCooker } from '../pack-cooker.js';
import { materialPrograms } from '../publication.js';
import { buildMaterialSourceCatalog } from '../source-catalog.js';
import {
  DEFAULT_MATERIAL_VARIANT_CONTEXT,
  type MaterialVariantContext,
} from '../variant-context.js';

const source = `#define_import_path test::entries
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
}
@vertex fn vs_main() -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  output.color = vec4<f32>(1.0);
  return output;
}
@fragment fn fs_main(@location(0) color: vec4<f32>) -> @location(0) vec4<f32> {
  return color;
}
@fragment fn fs_wrong_input(@location(0) color: vec3<f32>) -> @location(0) vec4<f32> {
  return vec4<f32>(color, 1.0);
}
`;

it('publishes an empty custom root beside the Engine shadow with complete direct ABI facts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'empty-custom-shadow-'));
  try {
    await writeFile(join(root, 'entries.wgsl'), source);
    const cooked = await createMaterialPackCooker([root]).cook({
      guid: 'empty-custom-shadow',
      source: {
        kind: 'material',
        parameters: [],
        passes: [
          { name: 'Forward', program: { module: 'test::entries' } },
          { name: 'ShadowCaster', program: { module: 'forgeax::default-shadow-caster' } },
        ],
      },
    });
    const record = validateCookedMaterialRecord(
      (cooked.payload as { cooked: unknown }).cooked,
    ).unwrap();
    const contexts = [
      ['webgpu', 'storage-buffer'],
      ['webgpu', 'uniform-fallback'],
      ['webgl2', 'uniform-fallback'],
      ['webgpu', 'storage-buffer-minimum'],
      ['webgpu', 'storage-buffer-projector'],
      ['webgpu', 'storage-buffer-atmosphere'],
    ] as const;
    expect(record.programs).toHaveLength(contexts.length * 2);
    const selections = record.programs.flatMap((program) => program.selections);
    for (const selection of selections) {
      expect(selection.address).toBe('direct');
      expect(selection.abi?.materialRow).toEqual({ byteLength: 0, fields: [] });
      expect(selection.abi?.sceneIndexEntry).toBeUndefined();
    }
    for (const [backend, capability] of contexts)
      expect(
        selections
          .filter(
            (selection) =>
              selection.context.backend === backend && selection.context.capability === capability,
          )
          .map((selection) => selection.pass),
      ).toEqual(['Forward', 'ShadowCaster']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  undefined,
  [{ name: 'heat', type: 'f32' as const, visibility: 'fragment' as const, lane: 0 }],
])('publishes authored direct stream inputs with optional particle lanes: %j', async (particleInputs) => {
  const root = await mkdtemp(join(tmpdir(), 'custom-particle-abi-'));
  try {
    await writeFile(
      join(root, 'particle.wgsl'),
      `#define_import_path test::particle
#import forgeax_material::parameters::{material}
struct Input { @location(0) position: vec3<f32>, @location(4) center: vec3<f32>, @location(10) heat: vec4<f32> }
@vertex fn vs_main(input: Input) -> @builtin(position) vec4<f32> { return vec4<f32>(input.position + input.center + input.heat.xyz * 0.01, 1.0); }
@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(material.factor); }
`,
    );
    const cooked = await createMaterialPackCooker([root]).cook({
      guid: 'custom-particle-abi',
      source: {
        kind: 'material',
        parameters: [{ name: 'factor', type: 'f32', default: 1 }],
        ...(particleInputs === undefined ? {} : { particleInputs }),
        passes: [{ name: 'particle-mesh', program: { module: 'test::particle' } }],
      },
    });
    const record = validateCookedMaterialRecord(
      (cooked.payload as { cooked: unknown }).cooked,
    ).unwrap();
    for (const selection of record.programs.flatMap((program) => program.selections)) {
      expect(selection.abi?.vertexInputs).toEqual([
        { semantic: 'position', location: 0, format: 'float32x3' },
        { semantic: 'center', location: 4, format: 'float32x3' },
        { semantic: 'heat', location: 10, format: 'float32x4' },
      ]);
      expect(selection.abi?.skinPaletteAddress).toBeUndefined();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('publishes the tracked Arc Nova core stream without requiring custom particle lanes or a palette', async () => {
  const root = new URL('../../../../../apps/game-capability-lab/assets/', import.meta.url);
  const pack = JSON.parse(await readFile(new URL('arc-nova-sigil.shader.pack.json', root), 'utf8'));
  const cooked = await createMaterialPackCooker([fileURLToPath(root)]).cook({
    guid: 'tracked-arc-nova-sigil',
    source: pack.assets['arc-nova-sigil.wgsl'].payload as MaterialAsset,
  });
  const record = validateCookedMaterialRecord(
    (cooked.payload as { cooked: unknown }).cooked,
  ).unwrap();
  for (const selection of record.programs.flatMap((program) => program.selections)) {
    expect(selection.address).toBe('direct');
    expect(selection.abi?.skinPaletteAddress).toBeUndefined();
    expect(selection.abi?.vertexInputs).toContainEqual({
      semantic: 'base_color',
      location: 4,
      format: 'float32x4',
    });
    expect(selection.abi?.vertexInputs).toContainEqual({
      semantic: 'emissive_intensity',
      location: 5,
      format: 'float32x4',
    });
    expect(
      selection.abi?.vertexInputs.some(
        (input) => input.semantic === 'skinIndex' || input.semantic === 'skinWeight',
      ),
    ).toBe(false);
  }
});

it.each([
  '',
  '@group(2) @binding(1) var<uniform> palette: array<vec4<f32>, 4>;',
])('rejects declared skin indices with an absent or incorrectly strided joint palette: %s', async (palette) => {
  const result = await cook(
    'vs_main',
    'fs_main',
    `#define_import_path test::entries
${palette}
struct Input { @location(0) position: vec3<f32>, @location(4) skinIndex: vec4<u32> }
@vertex fn vs_main(input: Input) -> @builtin(position) vec4<f32> { return vec4<f32>(input.position + vec3<f32>(input.skinIndex.xyz), 1.0)${palette ? ' + palette[0]' : ''}; }
@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }
`,
  );
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe('shader-compile-failed');
    expect(result.error.message).toContain('invalid reflected palette stride');
  }
});

async function cook(
  vertexEntry: string,
  fragmentEntry: string | undefined,
  moduleSource = source,
  passName = 'Forward',
  parameters: readonly { readonly name: string; readonly type: 'color' | 'f32' }[] = [],
  context: MaterialVariantContext = DEFAULT_MATERIAL_VARIANT_CONTEXT,
) {
  const sources = buildMaterialSourceCatalog({
    engine: [
      {
        path: 'common.wgsl',
        source: await readFile(
          new URL('../../../../shader/src/common.wgsl', import.meta.url),
          'utf8',
        ),
      },
    ],
    project: [{ path: 'entries.wgsl', source: moduleSource }],
  });
  if (!sources.ok) throw sources.error;
  return cookMaterialAsset({
    material: 'entry-validation',
    context,
    table: {
      'entry-validation': {
        kind: 'material',
        parameters,
        passes: [
          {
            name: passName,
            program: {
              module: 'test::entries',
              vertexEntry,
              ...(fragmentEntry === undefined ? {} : { fragmentEntry }),
            },
          },
        ],
      },
    },
    sources: sources.value,
  });
}

const sceneIndexSource = `#define_import_path test::entries
#import forgeax_material::parameters::{material}
struct VsInput {
  @location(0) position : vec3<f32>,
}
struct VsOutput {
  @builtin(position) clip : vec4<f32>,
}
@vertex fn vs_main(in : VsInput, @builtin(instance_index) idx : u32) -> VsOutput {
  var out : VsOutput;
  out.clip = vec4<f32>(in.position, 1.0);
  return out;
}
@vertex fn vs_scene_index(in : VsInput, @builtin(instance_index) idx : u32) -> VsOutput {
  let visible = visibleItems[idx];
  let tint = sceneMaterials[visible.y].tint;
  var out : VsOutput;
  out.clip = vec4<f32>(in.position + vec3<f32>(tint.x * 0.0), 1.0);
  return out;
}
@fragment fn fs_main() -> @location(0) vec4<f32> {
  return material.tint;
}
`;

const nativeSceneIndexSource = `#define_import_path test::entries
#import forgeax_material::parameters::{material}
#import forgeax_view::common::{view}
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
#import forgeax_view::common::{sceneIndexDraw}
#else
#import forgeax_view::common::{meshes, instances}
#endif
struct VsInput {
  @location(0) position : vec3<f32>,
}
struct VsOutput {
  @builtin(position) clip : vec4<f32>,
  @location(0) @interpolate(flat) materialIndex : u32,
}
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
@vertex fn vs_scene_index(input : VsInput, @builtin(instance_index) idx : u32) -> VsOutput {
  let visible = visibleItems[idx];
  let draw = sceneIndexDraw(visible.x);
  var output : VsOutput;
  output.clip = view.worldViewProj * draw.world * vec4<f32>(input.position, 1.0);
  output.materialIndex = visible.y;
  return output;
}
#else
@vertex fn vs_main(input : VsInput, @builtin(instance_index) idx : u32) -> VsOutput {
  var output : VsOutput;
  output.clip = view.worldViewProj * meshes[0].worldFromLocal * instances[idx].localFromInstance * vec4<f32>(input.position, 1.0);
  output.materialIndex = 0u;
  return output;
}
#endif
@fragment fn fs_main(input : VsOutput) -> @location(0) vec4<f32> {
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
  return sceneMaterials[input.materialIndex].tint;
#else
  return material.tint;
#endif
}
`;

const wrongStrideSceneIndexSource = `#define_import_path test::entries
struct MaterialParameters {
  tint : vec4<f32>,
  _gpuDrivenPadding : vec4<f32>,
}
struct VsInput {
  @location(0) position : vec3<f32>,
}
struct VsOutput {
  @builtin(position) clip : vec4<f32>,
}
@group(1) @binding(46) var<storage, read> sceneMaterials : array<MaterialParameters>;
@group(3) @binding(2) var<storage, read> visibleItems : array<vec4<u32>>;
@vertex fn vs_main(in : VsInput) -> VsOutput {
  var out : VsOutput;
  out.clip = vec4<f32>(in.position, 1.0);
  return out;
}
@vertex fn vs_scene_index(in : VsInput, @builtin(instance_index) idx : u32) -> VsOutput {
  let visible = visibleItems[idx];
  let tint = sceneMaterials[visible.y].tint;
  var out : VsOutput;
  out.clip = vec4<f32>(in.position + vec3<f32>(tint.x * 0.0), 1.0);
  return out;
}
@fragment fn fs_main() -> @location(0) vec4<f32> {
  return vec4<f32>(1.0);
}
`;

const wrongBindingSceneIndexSource = wrongStrideSceneIndexSource.replace(
  '@group(1) @binding(46) var<storage, read> sceneMaterials',
  '@group(2) @binding(9) var<storage, read> sceneMaterials',
);

const readOnlySceneIndexSource = `#define_import_path test::entries
struct MaterialParameters {
  tint : vec4<f32>,
}
struct VsInput {
  @location(0) position : vec3<f32>,
}
struct VsOutput {
  @builtin(position) clip : vec4<f32>,
}
@group(1) @binding(46) var<storage, read> sceneMaterials : array<MaterialParameters>;
@group(3) @binding(2) var<storage, read> visibleItems : array<vec4<u32>>;
@vertex fn vs_main(in : VsInput) -> VsOutput {
  var out : VsOutput;
  out.clip = vec4<f32>(in.position, 1.0);
  return out;
}
@vertex fn vs_scene_index(in : VsInput, @builtin(instance_index) idx : u32) -> VsOutput {
  let visible = visibleItems[idx];
  let tint = sceneMaterials[visible.y].tint;
  var out : VsOutput;
  out.clip = vec4<f32>(in.position + vec3<f32>(tint.x * 0.0), 1.0);
  return out;
}
@fragment fn fs_main() -> @location(0) vec4<f32> {
  return vec4<f32>(1.0);
}
`;

const readWriteSceneMaterialsSource = readOnlySceneIndexSource.replace(
  '@group(1) @binding(46) var<storage, read> sceneMaterials',
  '@group(1) @binding(46) var<storage, read_write> sceneMaterials',
);

const readWriteVisibleItemsSource = readOnlySceneIndexSource.replace(
  '@group(3) @binding(2) var<storage, read> visibleItems',
  '@group(3) @binding(2) var<storage, read_write> visibleItems',
);

const authoredEquivalentSceneIndexSource = `#define_import_path test::entries
struct Material {
  tint : vec4<f32>,
}
struct MaterialParameters {
  tint : vec4<f32>,
}
@group(1) @binding(0) var<uniform> material : Material;
@group(1) @binding(46) var<storage, read> sceneMaterials : array<MaterialParameters>;
@group(3) @binding(2) var<storage, read> visibleItems : array<vec4<u32>>;
struct VsInput {
  @location(0) position : vec3<f32>,
}
struct VsOutput {
  @builtin(position) clip : vec4<f32>,
}
@vertex fn vs_main(in : VsInput) -> VsOutput {
  var out : VsOutput;
  out.clip = vec4<f32>(in.position + vec3<f32>(material.tint.x * 0.0), 1.0);
  return out;
}
@vertex fn vs_scene_index(in : VsInput, @builtin(instance_index) idx : u32) -> VsOutput {
  let visible = visibleItems[idx];
  let tint = sceneMaterials[visible.y].tint;
  var out : VsOutput;
  out.clip = vec4<f32>(in.position + vec3<f32>(tint.x * 0.0), 1.0);
  return out;
}
@fragment fn fs_main() -> @location(0) vec4<f32> {
  return material.tint;
}
`;

describe('selected material graphics entries', () => {
  it('publishes a padded scene-index parameter module without changing direct-only output', () => {
    const schema = [
      { name: 'tint', type: 'color' as const },
      { name: 'roughness', type: 'f32' as const },
    ];
    const direct = generateParameterModule(schema);
    const scene = generateParameterModule(schema, { sceneIndex: true });
    const shadowScene = generateParameterModule(schema, {
      sceneIndex: true,
      visibleItemsBinding: 2,
    });
    expect(direct).not.toContain('sceneMaterials');
    expect(scene).toContain('@group(1) @binding(46) var<storage, read> sceneMaterials');
    expect(scene).not.toContain('_gpuDrivenPadding');
    expect(scene).toContain('MATERIAL_SCENE_ROW_VEC4_COUNT: u32 = 2u');
    expect(shadowScene).toContain(
      '@group(3) @binding(2) var<storage, read> visibleItems : array<vec4<u32>>',
    );
  });

  it('accepts a matching stage pair', async () => {
    expect((await cook('vs_main', 'fs_main')).ok).toBe(true);
  });

  it('publishes a producer-backed custom scene-index ABI from one source closure', async () => {
    const result = await cook('vs_main', 'fs_main', sceneIndexSource, 'Forward', [
      { name: 'tint', type: 'color' },
    ]);
    expect(
      result.ok,
      result.ok ? '' : `${result.error.message} ${JSON.stringify(result.error.detail)}`,
    ).toBe(true);
    if (!result.ok) return;
    const pass = result.value.passes[0];
    expect(pass?.abi).toMatchObject({
      directEntry: 'vs_main',
      sceneIndexEntry: 'vs_scene_index',
      materialRow: { byteLength: 16 },
      vertexInputs: [{ semantic: 'position', location: 0, format: 'float32x3' }],
    });
    expect(pass?.compile.wgsl).toContain('sceneMaterials');
    expect(pass?.compile.wgsl).toContain('visibleItems');
  });

  it.each([
    'Forward',
    'ShadowCaster',
  ])('cooks native conditional direct/scene-index programs for %s', async (passName) => {
    const result = await cook('vs_main', 'fs_main', nativeSceneIndexSource, passName, [
      { name: 'tint', type: 'color' },
    ]);
    expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
    if (!result.ok) return;
    const pass = result.value.passes[0];
    expect(pass?.abi?.sceneIndexEntry).toBe('vs_scene_index');
    expect(pass?.sceneCompile).toBeDefined();
    const direct = pass?.compile.wgsl;
    const scene = pass?.sceneCompile?.wgsl;
    expect(direct).toContain('fn vs_main');
    expect(direct).not.toContain('fn vs_scene_index');
    expect(direct).not.toContain('sceneTransforms');
    expect(scene).toContain('fn vs_scene_index');
    expect(scene).not.toContain('fn vs_main');
    expect(scene).toContain('sceneTransforms');
    expect(scene).toContain('sceneInstances');
    expect(scene).toContain('scenePrimitives');
    expect(scene).not.toMatch(/var<[^>]+> (?:meshes|instances)\b/);
    const programs = materialPrograms(result.value.passes, {
      guid: 'entry-validation',
      source: result.value.resolved.asset,
    });
    expect(programs).toHaveLength(2);
    expect(
      programs.flatMap((program) => program.selections.map((selection) => selection.address)),
    ).toEqual(['direct', 'scene-index']);
  });

  it.each([
    false,
    true,
  ])('publishes native opaque shadows beside a custom scene program, shadow first: %s', async (shadowFirst) => {
    const root = await mkdtemp(join(tmpdir(), 'custom-scene-shadow-'));
    try {
      await writeFile(join(root, 'entries.wgsl'), nativeSceneIndexSource);
      const forward: MaterialPass = {
        name: 'Forward',
        program: { module: 'test::entries', vertexEntry: 'vs_main', fragmentEntry: 'fs_main' },
      };
      const shadow: MaterialPass = {
        name: 'ShadowCaster',
        program: { module: 'forgeax::default-shadow-caster' },
      };
      const source: MaterialAsset = {
        kind: 'material',
        parameters: [{ name: 'tint', type: 'color' }],
        passes: shadowFirst ? [shadow, forward] : [forward, shadow],
      };
      const cooked = await createMaterialPackCooker([root]).cook({
        guid: 'custom-with-native-shadow',
        source,
      });
      const record = validateCookedMaterialRecord(
        (cooked.payload as { cooked: unknown }).cooked,
      ).unwrap();
      expect(record.resolved.parameters).toEqual(source.parameters);
      expect(record.programs.flatMap((program) => program.selections)).toHaveLength(20);
      for (const capability of [
        'storage-buffer-minimum',
        'storage-buffer-projector',
        'storage-buffer',
        'storage-buffer-atmosphere',
      ]) {
        for (const pass of ['Forward', 'ShadowCaster']) {
          const selections = record.programs
            .flatMap((program) => program.selections)
            .filter(
              (selection) => selection.pass === pass && selection.context.capability === capability,
            );
          expect(selections.map((selection) => selection.address)).toEqual([
            'direct',
            'scene-index',
          ]);
          for (const selection of selections) {
            expect(selection.abi?.materialRow.fields).toEqual(['tint']);
            expect(selection.abi?.vertexInputs).toEqual([
              { semantic: 'position', location: 0, format: 'float32x3' },
            ]);
          }
        }
      }
      const shadowScene = record.programs.find((program) =>
        program.selections.some(
          (selection) => selection.pass === 'ShadowCaster' && selection.address === 'scene-index',
        ),
      );
      expect(shadowScene).toBeDefined();
      const wgsl = new TextDecoder().decode(shadowScene?.artifact.bytes);
      expect(wgsl).toContain('sceneTransforms');
      expect(wgsl).toContain('shadowCasterCascade');
      expect(wgsl).toContain('applyViewClipping');
      expect(wgsl).toContain('applyLodCoverage');
      expect(wgsl).not.toContain('material.metallic');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an invalid conditional scene entry instead of publishing only the direct program', async () => {
    const result = await cook(
      'vs_main',
      'fs_main',
      nativeSceneIndexSource.replace('draw.world', 'draw.missingWorld'),
      'Forward',
      [{ name: 'tint', type: 'color' }],
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('shader-compile-failed');
  });

  it('keeps native conditional shaders direct-only on uniform-fallback devices', async () => {
    const result = await cook(
      'vs_main',
      'fs_main',
      nativeSceneIndexSource,
      'Forward',
      [{ name: 'tint', type: 'color' }],
      {
        ...DEFAULT_MATERIAL_VARIANT_CONTEXT,
        capability: 'uniform-fallback',
      },
    );
    expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
    if (!result.ok) return;
    expect(result.value.passes[0]?.sceneCompile).toBeUndefined();
    expect(result.value.passes[0]?.abi).toMatchObject({ directEntry: 'vs_main' });
    expect(result.value.passes[0]?.abi.sceneIndexEntry).toBeUndefined();
  });

  it('publishes an authored equivalent row when a full-custom source owns Material', async () => {
    const result = await cook('vs_main', 'fs_main', authoredEquivalentSceneIndexSource, 'Forward', [
      { name: 'tint', type: 'color' },
    ]);
    expect(
      result.ok,
      result.ok ? '' : `${result.error.message} ${JSON.stringify(result.error.detail)}`,
    ).toBe(true);
    if (!result.ok) return;
    expect(result.value.passes[0]?.abi).toMatchObject({
      directEntry: 'vs_main',
      sceneIndexEntry: 'vs_scene_index',
      materialRow: { byteLength: 16, fields: ['tint'] },
    });
  });

  it('rejects a custom scene-index storage row with the wrong element stride', async () => {
    const result = await cook('vs_main', 'fs_main', wrongStrideSceneIndexSource, 'Forward', [
      { name: 'tint', type: 'color' },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('material-schema-mismatch');
    expect(result.error.message).toContain('storage array stride 32');
    expect(result.error.detail).toMatchObject({
      mismatchKind: 'type-mismatch',
      availableBytes: GPU_DRIVEN_MATERIAL_ROW_BYTES,
      owner: 'shader-compiler scene-index publication',
    });
  });

  it('rejects authored scene-index bindings outside the engine-owned coordinates', async () => {
    const result = await cook('vs_main', 'fs_main', wrongBindingSceneIndexSource, 'Forward', [
      { name: 'tint', type: 'color' },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('material-schema-mismatch');
    expect(result.error.message).toContain('@group(2) @binding(9)');
    expect(result.error.detail).toMatchObject({
      mismatchKind: 'type-mismatch',
      owner: 'shader-compiler scene-index publication',
    });
  });

  it('accepts read-only scene-index storage in the reflected bind-group layouts', async () => {
    const result = await cook('vs_main', 'fs_main', readOnlySceneIndexSource, 'Forward', [
      { name: 'tint', type: 'color' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.passes[0]?.abi?.materialRow.byteLength).toBe(16);
  });

  it.each([
    ['sceneMaterials', readWriteSceneMaterialsSource],
    ['visibleItems', readWriteVisibleItemsSource],
  ])('rejects %s when the reflected bind-group layout is read-write', async (_name, sourceCode) => {
    const result = await cook('vs_main', 'fs_main', sourceCode, 'Forward', [
      { name: 'tint', type: 'color' },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('material-schema-mismatch');
    expect(result.error.message).toContain('read-only storage');
    expect(result.error.detail).toMatchObject({
      mismatchKind: 'type-mismatch',
      owner: 'shader-compiler scene-index publication',
    });
  });

  it('publishes every byte of a full canonical page without truncating the last parameter', async () => {
    const parameters = [
      { name: 'tint', type: 'color' as const },
      ...Array.from({ length: GPU_DRIVEN_MATERIAL_ROW_BYTES / 16 - 1 }, (_, index) => ({
        name: `extra${String.fromCharCode(65 + Math.floor(index / 26))}${String.fromCharCode(65 + (index % 26))}`,
        type: 'color' as const,
      })),
    ];
    const result = await cook('vs_main', 'fs_main', sceneIndexSource, 'Forward', parameters);
    expect(
      result.ok,
      result.ok ? '' : `${result.error.message} ${JSON.stringify(result.error.detail)}`,
    ).toBe(true);
    if (!result.ok) return;
    expect(result.value.passes[0]?.abi?.materialRow.byteLength).toBe(GPU_DRIVEN_MATERIAL_ROW_BYTES);
    expect(result.value.passes[0]?.abi?.materialRow.fields.at(-1)).toBe(parameters.at(-1)?.name);
  });

  it('reports an oversized custom scene-index row as structured ABI overflow', async () => {
    const parameters = Array.from(
      { length: GPU_DRIVEN_MATERIAL_ROW_BYTES / 16 + 1 },
      (_, index) => ({
        name: `color${index}`,
        type: 'color' as const,
      }),
    );
    const result = await cook('vs_main', 'fs_main', sceneIndexSource, 'Forward', parameters);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('material-schema-mismatch');
    expect(result.error.detail).toMatchObject({
      mismatchKind: 'bg-overflow',
      expectedBytes: GPU_DRIVEN_MATERIAL_ROW_BYTES + 16,
      availableBytes: GPU_DRIVEN_MATERIAL_ROW_BYTES,
      owner: 'shader-compiler scene-index publication',
    });
  });

  it.each([
    ['Forward', 'fs_main'],
    ['Deferred', 'fs_gbuffer'],
    ['ShadowCaster', 'fs_shadow'],
  ])('validates the implicit %s fragment entry', async (passName, fragment) => {
    const matchingSource = source.replace('fn fs_main(', `fn ${fragment}(`);
    expect((await cook('vs_main', undefined, matchingSource, passName)).ok).toBe(true);
    const result = await cook(
      'vs_main',
      undefined,
      source.replace('fn fs_main(', 'fn fs_other('),
      passName,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('shader-compile-failed');
    expect(result.error.message).toContain(`fragment entry '${fragment}'`);
  });

  it.each([
    ['vs_missing', 'fs_main', "vertex entry 'vs_missing'"],
    ['vs_main', 'fs_missing', "fragment entry 'fs_missing'"],
    ['fs_main', 'fs_main', "vertex entry 'fs_main'"],
    ['vs_main', 'vs_main', "fragment entry 'vs_main'"],
    ['vs_main', 'fs_wrong_input', '@location(0)'],
  ])('rejects %s / %s before publication', async (vertex, fragment, diagnostic) => {
    const result = await cook(vertex, fragment);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('shader-compile-failed');
    expect(result.error.message).toContain(diagnostic);
  });
});
