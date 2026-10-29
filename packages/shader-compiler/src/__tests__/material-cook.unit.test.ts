import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  serializeCookedMaterialRecord,
  validateCookedMaterialRecord,
} from '@forgeax/engine-pack/material-cook';
import { createBuiltinMaterialAsset } from '@forgeax/engine-shader';
import {
  type MaterialAsset,
  standardMaterialParameters,
  standardSurfaceParameters,
} from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { cookMaterialAsset } from '../material/cook.js';
import { createMaterialPackCooker } from '../material/pack-cooker.js';
import { buildMaterialSourceCatalog } from '../material/source-catalog.js';

const source = `#define_import_path game::pulse
@vertex
fn vs_main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }
@fragment
fn fs_main() -> @location(0) vec4<f32> {
  let sample = textureSample(baseColorTexture, baseColorTexture_sampler, vec2<f32>(0.5));
  var color = material.baseColor * sample;
  return color;
}`;

const material: MaterialAsset = {
  kind: 'material',
  passes: [{ name: 'Forward', program: { module: 'game::pulse' } }],
  parameters: [
    { name: 'baseColor', type: 'color' },
    { name: 'baseColorTexture', type: 'texture' },
  ],
  values: { baseColor: [0.1, 0.2, 0.3, 1] },
};

function packShader(module: string, body: string): string {
  return `#define_import_path ${module}
${body}
`;
}

function packRecord(value: unknown) {
  return validateCookedMaterialRecord(value).unwrap();
}

function cookedPayload(value: { readonly payload: unknown }): unknown {
  if (value.payload === null || typeof value.payload !== 'object') {
    throw new Error('material pack fixture did not produce a payload');
  }
  return (value.payload as { readonly cooked?: unknown }).cooked;
}

describe('cookMaterialAsset', () => {
  it('cooks the public Unlit factory through the ordinary native material producer', {
    timeout: 30_000,
  }, async () => {
    const material = createBuiltinMaterialAsset('unlit');
    const draft = await createMaterialPackCooker().cook({
      guid: 'builtin-unlit-native-cook',
      source: material,
    });
    const record = packRecord(cookedPayload(draft));
    expect(record.resolved.values?.baseColor).toEqual([1, 1, 1, 1]);
    expect(
      record.programs.some((program) =>
        program.selections.some((selection) => selection.context.geometry === 'mesh'),
      ),
    ).toBe(true);
    expect(
      record.programs.some((program) =>
        program.selections.some((selection) => selection.context.geometry === 'skinned'),
      ),
    ).toBe(true);
    for (const program of record.programs) {
      expect(draft.artifacts[program.artifact.path]?.bytes).toEqual(program.artifact.bytes);
      for (const selection of program.selections)
        if (selection.context.pipeline !== 'ray' && selection.context.geometry === 'skinned') {
          expect(selection.abi?.positionBounds).toBe('standard-input');
          expect(selection.abi?.generation).toBe(5);
        }
    }
    // Explicit custom schemas remain authoritative: the native producer must
    // reject the original incomplete interface rather than fill it silently.
    await expect(
      createMaterialPackCooker().cook({
        guid: 'explicit-incomplete-unlit-native-cook',
        source: { ...material, parameters: [{ name: 'baseColor', type: 'color' }] },
      }),
    ).rejects.toMatchObject({
      code: 'material-derived-interface-mismatch',
      detail: { parameter: 'baseColorSampler' },
    });
  });

  it('publishes a shared ray-hit derivative of the ordinary Standard material', {
    timeout: 30_000,
  }, async () => {
    const source: MaterialAsset = {
      kind: 'material',
      parameters: standardSurfaceParameters(
        standardMaterialParameters(
          new Set(['baseColor', 'metallic', 'roughness', 'alphaCutoff', 'baseColorTexture']),
        ),
      ),
      passes: [{ name: 'Forward', program: { module: 'forgeax_material::standard' } }],
      values: {
        baseColor: [0.7, 0.3, 0.1, 1],
        metallic: 0,
        roughness: 0.6,
        alphaCutoff: 0.5,
        baseColorTexture: {
          texture: '12345678-1234-1234-1234-123456789abc',
          coordinates: { set: 1 },
        },
      },
    };
    const cooker = createMaterialPackCooker();
    const output = await cooker.cook({ guid: 'shared-ray-material', source });
    const record = packRecord(cookedPayload(output));
    const ray = record.programs.filter((program) =>
      program.selections.some((selection) => selection.context.pipeline === 'ray'),
    );
    expect(ray).toHaveLength(2);
    const card = ray.find((program) =>
      program.selections.some((selection) => selection.context.pass === 'card-capture'),
    );
    expect(card?.selections).toEqual([
      {
        pass: 'Forward',
        entry: 'vs_card',
        context: {
          backend: 'webgpu',
          capability: 'storage-buffer',
          pipeline: 'ray',
          geometry: 'mesh',
          pass: 'card-capture',
          profile: 'forgeax-material-ray-v1',
          toolchain: 'naga-oil',
          instrumentation: 'none',
        },
      },
    ]);
    expect(new TextDecoder().decode(card?.artifact.bytes)).toMatch(/fn vs_card\(/);
    expect(new TextDecoder().decode(card?.artifact.bytes)).toMatch(/fn fs_card\(/);
    expect(card?.specializationKey).not.toBe(ray[0]?.specializationKey);
    expect(card && output.artifacts[card.artifact.path]?.bytes).toEqual(card?.artifact.bytes);
    expect(ray[0]?.selections).toEqual([
      {
        pass: 'Forward',
        entry: 'cs_surface',
        context: {
          backend: 'webgpu',
          capability: 'storage-buffer',
          pipeline: 'ray',
          geometry: 'mesh',
          pass: 'ray-hit',
          profile: 'forgeax-material-ray-v1',
          toolchain: 'naga-oil',
          instrumentation: 'none',
        },
      },
    ]);
    expect(record.resolved.passes.map((pass) => pass.name)).not.toContain('ray-hit');
    expect(new TextDecoder().decode(ray[0]?.artifact.bytes)).toMatch(/fn cs_surface\(/);
    expect(record.sourceClosure).toContain('forgeax_material::ray_surface');
    const artifact = ray[0]?.artifact;
    if (artifact === undefined) throw new Error('missing derivative artifact');
    expect(output.artifacts[artifact.path]?.bytes).toEqual(artifact.bytes);
    const edited = packRecord(
      cookedPayload(
        await cooker.cook({
          guid: 'shared-ray-material',
          source: { ...source, values: { ...source.values, roughness: 0.2 } },
        }),
      ),
    );
    const editedRay = edited.programs.find((program) =>
      program.selections.some((selection) => selection.context.pipeline === 'ray'),
    );
    expect(editedRay?.specializationKey).toBe(ray[0]?.specializationKey);
    const editedCard = edited.programs.find((program) =>
      program.selections.some((selection) => selection.context.pass === 'card-capture'),
    );
    expect(editedCard?.specializationKey).toBe(card?.specializationKey);
    expect(editedCard?.artifact.bytes).toEqual(card?.artifact.bytes);
    expect(edited.receipt.identity.materialPublicationIdentity).not.toBe(
      record.receipt.identity.materialPublicationIdentity,
    );
  });

  it('does not infer Standard physical defines for a custom program', async () => {
    const conditionalSource = `#define_import_path game::conditional-clearcoat
#pragma variant_axis CLEARCOAT_AVAILABLE
struct Material {
  baseColor : vec4<f32>,
#ifdef CLEARCOAT_AVAILABLE
  clearcoat : f32,
  clearcoatRoughness : f32,
#endif
};
@group(1) @binding(0) var<uniform> material : Material;
@vertex
fn vs_main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }
@fragment
fn fs_main() -> @location(0) vec4<f32> { return material.baseColor; }
`;
    const catalog = buildMaterialSourceCatalog({
      engine: [],
      project: [{ path: 'conditional-clearcoat.wgsl', source: conditionalSource }],
    });
    expect(catalog.ok).toBe(true);
    if (!catalog.ok) return;

    const cook = (parameters: NonNullable<MaterialAsset['parameters']>) =>
      cookMaterialAsset({
        material: 'root',
        table: {
          root: {
            kind: 'material',
            passes: [{ name: 'Forward', program: { module: 'game::conditional-clearcoat' } }],
            parameters,
          },
        },
        sources: catalog.value,
      });

    const base = await cook([{ name: 'baseColor', type: 'color' }]);
    const physical = await cook([
      { name: 'baseColor', type: 'color' },
      { name: 'clearcoat', type: 'f32' },
      { name: 'clearcoatRoughness', type: 'f32' },
    ]);

    expect(base.ok, base.ok ? '' : base.error.message).toBe(true);
    expect(physical).toMatchObject({
      ok: false,
      error: { code: 'material-derived-interface-mismatch' },
    });
  });

  it('keeps a custom physical-named texture in the root resource layout', async () => {
    const catalog = buildMaterialSourceCatalog({
      engine: [],
      project: [
        { path: 'custom.wgsl', source: source.replaceAll('baseColorTexture', 'clearcoatTexture') },
      ],
    }).unwrap();
    const custom: MaterialAsset = {
      kind: 'material',
      passes: [{ name: 'Forward', program: { module: 'game::pulse' } }],
      parameters: [
        { name: 'baseColor', type: 'color' },
        { name: 'clearcoatTexture', type: 'texture' },
      ],
    };
    const result = await cookMaterialAsset({
      material: 'root',
      table: { root: custom },
      sources: catalog,
    });
    expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
    if (!result.ok) return;
    expect(result.value.passes[0]?.compile.reflection.boundGlobals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ group: 1, binding: 2, resourceKind: 'texture' }),
      ]),
    );
  });

  it('does not infer Standard transmission defines for a custom program', async () => {
    const transmissionSource = `#define_import_path game::transmission
#pragma variant_axis TRANSMISSION_AVAILABLE
#import forgeax_material::parameters::{material, transmissionTexture, transmissionTexture_sampler}
#ifdef TRANSMISSION_AVAILABLE
fn readTransmission() -> f32 {
  return textureSample(transmissionTexture, transmissionTexture_sampler, vec2<f32>(0.5)).r;
}
#else
fn readTransmission() -> f32 { return 0.0; }
#endif
@vertex
fn vs_main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }
@fragment
fn fs_main() -> @location(0) vec4<f32> {
  return vec4<f32>(material.transmission + readTransmission());
}`;
    const catalog = buildMaterialSourceCatalog({
      engine: [],
      project: [{ path: 'transmission.wgsl', source: transmissionSource }],
    });
    expect(catalog.ok).toBe(true);
    if (!catalog.ok) return;
    const result = await cookMaterialAsset({
      material: 'transmission-root',
      table: {
        'transmission-root': {
          kind: 'material',
          passes: [{ name: 'Forward', program: { module: 'game::transmission' } }],
          parameters: [
            { name: 'transmission', type: 'f32' },
            { name: 'transmissionTexture', type: 'texture' },
          ],
        },
      },
      sources: catalog.value,
    });
    expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
    if (!result.ok) return;
    expect(result.value.passes[0]?.compile.manifestEntry.wgsl).not.toContain('textureSample(');
    expect(result.value.passes[0]?.parameters).toHaveLength(2);
    expect(result.value.passes[0]?.abi.positionBounds).toBeUndefined();
  });

  it('exposes the Pack cooker from the shader compiler owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-material-pack-cooker-'));
    const sourcePath = resolve(root, 'pulse.wgsl');
    await writeFile(
      sourcePath,
      '#define_import_path game::pack\n@vertex\nfn vs_main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }\n@fragment\nfn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\n',
    );
    try {
      const draft = await createMaterialPackCooker([root]).cook({
        guid: 'material-pack-test',
        source: {
          kind: 'material',
          passes: [{ name: 'Forward', program: { module: 'game::pack' } }],
        },
        sourceKey: 'pulse.wgsl',
        sourcePath: resolve(root, 'material.pack.json'),
        refs: [],
      });
      expect(draft.payload).toMatchObject({
        passes: [{ renderState: { tags: { LightMode: 'Forward' } } }],
        cooked: {
          schemaVersion: 'material-cook/4',
          authored: { passes: [{ renderState: { tags: { LightMode: 'Forward' } } }] },
          resolved: { passes: [{ renderState: { tags: { LightMode: 'Forward' } } }] },
          receipt: { identity: { sourceClosureDigest: expect.any(String) } },
        },
      });
      expect(Object.keys(draft.artifacts)).toEqual([
        expect.stringMatching(/^materials\/programs\/[a-f0-9]{64}\.wgsl$/),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('publishes identical material bytes after relocation while retaining local source dependencies', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'forgeax-material-publication-'));
    const first = join(directory, 'first-checkout');
    const relocated = join(directory, 'relocated-checkout');
    await mkdir(first);
    await writeFile(join(first, 'pulse.wgsl'), source);
    const cook = (root: string) =>
      createMaterialPackCooker([root]).cook({
        guid: 'relocated-material',
        source: material,
      });
    const publicationDigest = (draft: { readonly payload: unknown }) =>
      createHash('sha256')
        .update(serializeCookedMaterialRecord(packRecord(cookedPayload(draft))))
        .digest('hex');
    try {
      const before = await cook(first);
      await rename(first, relocated);
      const after = await cook(relocated);
      expect(after.sourceDependencies).toContain(join(relocated, 'pulse.wgsl'));
      expect(after.sourceDependencies).not.toContain(join(first, 'pulse.wgsl'));
      expect(after.inputFingerprint).toBe(before.inputFingerprint);
      expect(publicationDigest(after)).toBe(publicationDigest(before));

      await writeFile(
        join(relocated, 'pulse.wgsl'),
        source.replace('return color;', 'return color * 0.5;'),
      );
      const changed = await cook(relocated);
      expect(changed.inputFingerprint).not.toBe(after.inputFingerprint);
      expect(publicationDigest(changed)).not.toBe(publicationDigest(after));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('projects an engine-owned Standard source into a Pack-owned material alias', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-material-standard-alias-'));
    const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
    const engineRoot = resolve(packageRoot, '../shader/src');
    const sourcePath = resolve(root, 'material-alias.pack.json');
    await writeFile(sourcePath, '{}');
    // Alias identity needs the real Engine template and one simple depth Surface.
    // Full Forward/physical/color/ray publications have dedicated real gates.
    await writeFile(
      join(root, 'surface.wgsl'),
      `#define_import_path game::alias-surface
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}
fn evaluate_surface(input: SurfaceInput) -> SurfaceData {
  return SurfaceData(vec3<f32>(0.6), input.vertexNormalWS, 0.0, 0.5, vec3<f32>(0.0), 1.0, 1.0, 0.0);
}`,
    );
    try {
      const draft = await createMaterialPackCooker().cook({
        guid: 'material-standard-alias-test',
        source: {
          kind: 'material',
          // Alias identity needs one real Standard interface; the complete
          // physical-layer fixture separately covers every texture binding.
          parameters: standardSurfaceParameters([]),
          passes: [
            {
              name: 'Depth',
              program: {
                module: 'game::standard-alias',
                moduleSlots: { surface: 'game::alias-surface' },
              },
            },
          ],
        },
        sourceKey: relative(root, resolve(engineRoot, 'default-standard-pbr.wgsl')),
        sourcePath,
        refs: [],
      });
      const artifact = Object.values(draft.artifacts)[0];
      expect(artifact).toBeDefined();
      if (artifact === undefined) return;
      expect(draft.payload).toMatchObject({
        cooked: {
          refs: { modules: ['forgeax_material::standard'] },
          resolved: {
            passes: [{ program: { module: 'forgeax_material::standard' } }],
          },
        },
      });
      const record = validateCookedMaterialRecord(
        (draft.payload as { cooked: unknown }).cooked,
      ).unwrap();
      const raster = record.programs
        .flatMap((program) => program.selections)
        .filter((selection) => selection.context.pipeline !== 'ray');
      expect(
        raster.every(
          (selection) =>
            selection.address !== undefined &&
            selection.entry !== undefined &&
            selection.abi !== undefined,
        ),
      ).toBe(true);
      expect(
        new Set(
          raster
            .filter((selection) => selection.context.capability === 'uniform-fallback')
            .map((selection) => selection.context.backend),
        ),
      ).toEqual(new Set(['webgpu', 'webgl2']));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses the canonical key for equivalent contracts and excludes runtime identities', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-material-specialization-'));
    const sourcePath = resolve(root, 'pack-key.wgsl');
    const slotPath = resolve(root, 'lighting.wgsl');
    await writeFile(
      sourcePath,
      packShader(
        'game::pack-key',
        '#pragma material_slot lighting\n#import forgeax_material::slot::lighting::{shade}\n@vertex\nfn vs_main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }\n@fragment\nfn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(material.value + shade(), 0.0, 0.0, 1.0); }',
      ),
    );
    await writeFile(slotPath, packShader('game::lighting', 'fn shade() -> f32 { return 0.0; }'));
    const sourceMaterial: MaterialAsset = {
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          program: {
            module: 'game::pack-key',
            fragmentEntry: 'fs_main',
            moduleSlots: { lighting: 'game::lighting' },
          },
        },
      ],
      parameters: [
        { name: 'value', type: 'f32' },
        { name: 'texture', type: 'texture' },
      ],
      values: {
        value: 0.5,
        texture: { texture: 'texture-a', sampler: 'sampler-a' },
      },
    };
    try {
      const cooker = createMaterialPackCooker([root]);
      const first = await cooker.cook({
        guid: 'material-root',
        source: sourceMaterial,
        sourcePath: resolve(root, 'material.pack.json'),
        sourceKey: 'pack-key.wgsl',
      });
      const second = await cooker.cook({
        guid: 'material-derived',
        source: {
          ...sourceMaterial,
          values: {
            value: 0.75,
            texture: { texture: 'texture-b', sampler: 'sampler-b' },
          },
        },
        sourcePath: resolve(root, 'material.pack.json'),
        sourceKey: 'pack-key.wgsl',
      });
      const firstRecord = packRecord(cookedPayload(first));
      const secondRecord = packRecord(cookedPayload(second));
      expect(firstRecord.programs).toHaveLength(6);
      expect(
        firstRecord.programs.map((program) => ({
          backend: program.selections[0]?.context.backend,
          capability: program.selections[0]?.context.capability,
        })),
      ).toEqual([
        { backend: 'webgpu', capability: 'storage-buffer' },
        { backend: 'webgpu', capability: 'uniform-fallback' },
        { backend: 'webgl2', capability: 'uniform-fallback' },
        { backend: 'webgpu', capability: 'storage-buffer-minimum' },
        { backend: 'webgpu', capability: 'storage-buffer-projector' },
        { backend: 'webgpu', capability: 'storage-buffer-atmosphere' },
      ]);
      expect(secondRecord.programs).toEqual(firstRecord.programs);
      expect(secondRecord.receipt.identity.materialPublicationIdentity).not.toBe(
        firstRecord.receipt.identity.materialPublicationIdentity,
      );
      expect(secondRecord.specializationKey).toBe(firstRecord.specializationKey);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('changes the canonical key for pass, module, and source changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-material-specialization-mutations-'));
    const sourcePath = resolve(root, 'mutation.wgsl');
    const otherPath = resolve(root, 'other.wgsl');
    const writeSource = async (path: string, module: string, value: number) => {
      await writeFile(
        path,
        packShader(
          module,
          `@vertex\nfn vs_main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }\n@fragment\nfn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(${value}.0); }`,
        ),
      );
    };
    await writeSource(sourcePath, 'game::mutation', 1);
    await writeSource(otherPath, 'game::other', 1);
    const materialFor = (module: string, name = 'Forward'): MaterialAsset => ({
      kind: 'material',
      passes: [{ name, program: { module, fragmentEntry: 'fs_main' } }],
      parameters: [],
    });
    try {
      const cooker = createMaterialPackCooker([root]);
      const cook = (source: MaterialAsset, sourceKey: string) =>
        cooker.cook({
          guid: 'material-mutation',
          source,
          sourcePath: resolve(root, 'material.pack.json'),
          sourceKey,
        });
      const baseline = packRecord(
        cookedPayload(await cook(materialFor('game::mutation'), 'mutation.wgsl')),
      );
      const pass = packRecord(
        cookedPayload(await cook(materialFor('game::mutation', 'Shadow'), 'mutation.wgsl')),
      );
      const module = packRecord(
        cookedPayload(await cook(materialFor('game::other'), 'other.wgsl')),
      );
      await writeSource(sourcePath, 'game::mutation', 2);
      const source = packRecord(
        cookedPayload(await cook(materialFor('game::mutation'), 'mutation.wgsl')),
      );

      expect(pass.specializationKey).not.toBe(baseline.specializationKey);
      expect(module.specializationKey).not.toBe(baseline.specializationKey);
      expect(source.specializationKey).not.toBe(baseline.specializationKey);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('generates the interface from MaterialAsset and reflects it', async () => {
    const catalog = buildMaterialSourceCatalog({
      engine: [],
      project: [{ path: 'shader-defs.wgsl', source }],
    });
    expect(catalog.ok).toBe(true);
    if (!catalog.ok) return;

    const result = await cookMaterialAsset({
      material: 'root',
      table: { root: material },
      sources: catalog.value,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    const pass = result.value.passes[0];
    expect(pass).toBeDefined();
    if (pass === undefined) return;
    expect(pass.generatedModule).toContain('var<uniform> material');
    expect(pass.generatedModule).toContain('baseColorTexture_sampler');
    expect(pass.compile.wgsl).toContain('baseColorTexture');
    expect(pass.compile.bindings.length).toBeGreaterThan(0);
  });

  it('accepts an explicit import of the generated parameters module', async () => {
    const explicitSource = source.replace(
      '@fragment\n',
      '#import forgeax_material::parameters::{material, baseColorTexture, baseColorTexture_sampler}\n@fragment\n',
    );
    const catalog = buildMaterialSourceCatalog({
      engine: [],
      project: [{ path: 'explicit.wgsl', source: explicitSource }],
    });
    expect(catalog.ok).toBe(true);
    if (!catalog.ok) return;
    const result = await cookMaterialAsset({
      material: 'root',
      table: { root: material },
      sources: catalog.value,
    });
    expect(result.ok).toBe(true);
  });

  it('accepts an authored Material interface without injecting a duplicate binding', async () => {
    const authoredSource = `#define_import_path game::authored
struct Material {
  baseColor : vec4<f32>,
};
@group(1) @binding(0) var<uniform> material : Material;
@vertex
fn vs_main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }
@fragment
fn fs_main() -> @location(0) vec4<f32> { return material.baseColor; }`;
    const catalog = buildMaterialSourceCatalog({
      engine: [],
      project: [{ path: 'authored.wgsl', source: authoredSource }],
    });
    expect(catalog.ok).toBe(true);
    if (!catalog.ok) return;
    const result = await cookMaterialAsset({
      material: 'root',
      table: {
        root: {
          kind: 'material',
          passes: [{ name: 'Forward', program: { module: 'game::authored' } }],
          parameters: [{ name: 'baseColor', type: 'color' }],
        },
      },
      sources: catalog.value,
    });
    expect(result.ok).toBe(true);
  });

  it('keeps the generated module out of disk lookup while closing transitive imports', async () => {
    const helper = `#define_import_path game::helper\n#import forgeax_material::parameters::{material}\nfn tint(value: vec4<f32>) -> vec4<f32> { return value * material.baseColor; }`;
    const root = `#define_import_path game::root\n#import game::helper::{tint}\n#import forgeax_material::parameters::{material}\n@vertex\nfn vs_main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }\n@fragment\nfn fs_main() -> @location(0) vec4<f32> { return tint(material.baseColor); }`;
    const catalog = buildMaterialSourceCatalog({
      engine: [],
      project: [
        { path: 'root.wgsl', source: root },
        { path: 'helper.wgsl', source: helper },
      ],
    });
    expect(catalog.ok).toBe(true);
    if (!catalog.ok) return;
    const result = await cookMaterialAsset({
      material: 'root',
      table: {
        root: {
          kind: 'material',
          passes: [{ name: 'Forward', program: { module: 'game::root' } }],
          parameters: [{ name: 'baseColor', type: 'color' }],
        },
      },
      sources: catalog.value,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.passes[0]?.sourceClosure).toEqual([
      'game::root',
      'forgeax_material::parameters',
      'game::helper',
    ]);
  });

  it('accepts an unused schema-derived interface injected into the composed shader', async () => {
    const unusedSource = `#define_import_path game::unused\n@vertex\nfn vs_main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }\n@fragment\nfn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }`;
    const catalog = buildMaterialSourceCatalog({
      engine: [],
      project: [{ path: 'unused.wgsl', source: unusedSource }],
    });
    expect(catalog.ok).toBe(true);
    if (!catalog.ok) return;

    const result = await cookMaterialAsset({
      material: 'root',
      table: {
        root: {
          kind: 'material',
          passes: [{ name: 'Forward', program: { module: 'game::unused' } }],
          parameters: [{ name: 'time', type: 'f32' }],
        },
      },
      sources: catalog.value,
    });

    expect(result.ok).toBe(true);
  });

  it('cooks every pass instead of silently truncating the material', async () => {
    const sourceA = source.replace('game::pulse', 'game::first');
    const sourceB = source
      .replace('game::pulse', 'game::second')
      .replace('vs_main', 'shadow_vs')
      .replace('fs_main', 'shadow_fs');
    const catalog = buildMaterialSourceCatalog({
      engine: [],
      project: [
        { path: 'first.wgsl', source: sourceA },
        { path: 'second.wgsl', source: sourceB },
      ],
    });
    expect(catalog.ok).toBe(true);
    if (!catalog.ok) return;
    const result = await cookMaterialAsset({
      material: 'root',
      table: {
        root: {
          ...material,
          passes: [
            {
              name: 'Forward',
              program: { module: 'game::first', vertexEntry: 'vs_main', fragmentEntry: 'fs_main' },
            },
            {
              name: 'Shadow',
              program: {
                module: 'game::second',
                vertexEntry: 'shadow_vs',
                fragmentEntry: 'shadow_fs',
              },
            },
          ],
        },
      },
      sources: catalog.value,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.passes.map((pass) => [pass.pass, pass.module])).toEqual([
      ['Forward', 'game::first'],
      ['Shadow', 'game::second'],
    ]);
  });

  it('preserves pass identity when passes share a module', async () => {
    const catalog = buildMaterialSourceCatalog({
      engine: [],
      project: [
        {
          path: 'shared.wgsl',
          source:
            source.replace('game::pulse', 'game::shared') +
            '\n@fragment fn overlay_fs() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }',
        },
      ],
    });
    expect(catalog.ok).toBe(true);
    if (!catalog.ok) return;
    const result = await cookMaterialAsset({
      material: 'root',
      table: {
        root: {
          ...material,
          passes: [
            { name: 'Forward', program: { module: 'game::shared', fragmentEntry: 'fs_main' } },
            { name: 'Overlay', program: { module: 'game::shared', fragmentEntry: 'overlay_fs' } },
          ],
        },
      },
      sources: catalog.value,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.passes.map((pass) => pass.pass)).toEqual(['Forward', 'Overlay']);
  });

  it('returns the derived layout identity for every cooked pass', async () => {
    const roots = ['/game/assets'];
    const catalog = buildMaterialSourceCatalog({
      roots,
      engine: [],
      project: [{ path: 'shader-defs.wgsl', source }],
    });
    expect(catalog.ok).toBe(true);
    if (!catalog.ok) return;
    const result = await cookMaterialAsset({
      material: 'root',
      table: { root: material },
      sources: catalog.value,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        resolved: { leaf: 'root' },
        passes: [{ layoutIdentity: expect.stringMatching(/^sha256-/) }],
      },
    });
  });

  it('composes the selected ABI-compatible module slot into the artifact', async () => {
    const entry = `#define_import_path game::slot-entry
#pragma material_slot lighting
#import forgeax_material::slot::lighting::{lighting_color}
@vertex
fn vs_main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }
@fragment
fn fs_main() -> @location(0) vec4<f32> { return lighting_color(); }`;
    const first = `#define_import_path game::lighting_a
fn lighting_color() -> vec4<f32> { return vec4<f32>(1.0, 0.0, 0.0, 1.0); }`;
    const second = first
      .replace('1.0, 0.0, 0.0', '0.0, 1.0, 0.0')
      .replace('lighting_a', 'lighting_b');
    const firstCatalog = buildMaterialSourceCatalog({
      engine: [],
      project: [
        { path: 'entry.wgsl', source: entry },
        { path: 'a.wgsl', source: first },
      ],
    });
    const secondCatalog = buildMaterialSourceCatalog({
      engine: [],
      project: [
        { path: 'entry.wgsl', source: entry },
        { path: 'b.wgsl', source: second },
      ],
    });
    expect(firstCatalog.ok).toBe(true);
    expect(secondCatalog.ok).toBe(true);
    if (!firstCatalog.ok || !secondCatalog.ok) return;
    const base: MaterialAsset = {
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          program: { module: 'game::slot-entry', moduleSlots: { lighting: 'game::lighting_a' } },
        },
      ],
    };
    const firstCook = await cookMaterialAsset({
      material: 'root',
      table: { root: base },
      sources: firstCatalog.value,
    });
    const secondCook = await cookMaterialAsset({
      material: 'root',
      table: {
        root: {
          ...base,
          passes: [
            {
              name: 'Forward',
              program: {
                module: 'game::slot-entry',
                moduleSlots: { lighting: 'game::lighting_b' },
              },
            },
          ],
        },
      },
      sources: secondCatalog.value,
    });
    expect(firstCook.ok).toBe(true);
    expect(secondCook.ok).toBe(true);
    if (!firstCook.ok || !secondCook.ok) return;
    expect(firstCook.value.passes[0]?.compile.wgsl).not.toBe(
      secondCook.value.passes[0]?.compile.wgsl,
    );
    expect(firstCook.value.passes[0]?.layoutIdentity).toBe(
      secondCook.value.passes[0]?.layoutIdentity,
    );
  });
});
