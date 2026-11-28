import { readFileSync } from 'node:fs';
import type { MaterialAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { compileShader } from '../../index.js';
import { composeSurfaceSource } from '../compose.js';
import { generateParameterModule } from '../cook.js';
import { buildMaterialSourceCatalog } from '../source-catalog.js';
import { validateSurfaceDependency, validateSurfaceSource } from '../surface-contract.js';

const template = `#define_import_path forgeax_material::standard
#pragma material_slot surface
#import forgeax_material::slot::surface::{evaluate_surface}
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}
@fragment fn fs_main() -> @location(0) vec4<f32> {
  let input = SurfaceInput(vec3<f32>(0.0), vec3<f32>(0.0), vec3<f32>(0.0, 0.0, 1.0), vec3<f32>(0.0, 0.0, 1.0), vec4<f32>(1.0), vec3<f32>(0.0, 0.0, 1.0), vec2<f32>(0.0), vec2<f32>(0.0), vec2<f32>(0.0), vec2<f32>(0.0), vec2<f32>(0.0), vec2<f32>(0.0), vec2<f32>(0.0), vec2<f32>(0.0), vec4<f32>(1.0), true, vec4<f32>(0.0), vec4<f32>(0.0), mat3x3<f32>(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(0.0, 0.0, 1.0)), 0.0, 0.0);
  let surface = evaluate_surface(input);
  return vec4<f32>(surface.baseColor, surface.opacity);
}`;

const surfaceV1 = `#define_import_path forgeax_material::surface_v1
struct SurfaceInput { positionOS: vec3<f32>, positionWS: vec3<f32>, geometricNormalWS: vec3<f32>, vertexNormalWS: vec3<f32>, tangentWS: vec4<f32>, viewDirectionWS: vec3<f32>, uv0: vec2<f32>, uv1: vec2<f32>, uv2: vec2<f32>, uv3: vec2<f32>, uv4: vec2<f32>, uv5: vec2<f32>, uv6: vec2<f32>, uv7: vec2<f32>, vertexColor: vec4<f32>, frontFacing: bool, uvFootprint0: vec4<f32>, uvFootprint1: vec4<f32>, objectToWorld: mat3x3<f32>, frameTime: f32, materialTextureMipBias: f32,}
struct SurfaceData { baseColor: vec3<f32>, normalWS: vec3<f32>, metallic: f32, roughness: f32, emissive: vec3<f32>, occlusion: f32, opacity: f32, alphaClipThreshold: f32, reactive: f32 }`;

const defaultSurface = `#define_import_path forgeax_material::default_standard_surface
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}
fn evaluate_surface(input: SurfaceInput) -> SurfaceData { return SurfaceData(vec3<f32>(1.0), input.vertexNormalWS, 0.0, 0.5, vec3<f32>(0.0), 1.0, 1.0, 0.0, 0.0); }`;

const customSurface = `#define_import_path game::rusted_surface
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}
fn evaluate_surface(input: SurfaceInput) -> SurfaceData { return SurfaceData(vec3<f32>(0.6), input.vertexNormalWS, 0.2, 0.8, vec3<f32>(0.0), 1.0, 1.0, 0.0, 0.0); }`;

function catalog() {
  const result = buildMaterialSourceCatalog({
    engine: [
      { path: 'standard.wgsl', source: template },
      { path: 'surface_v1.wgsl', source: surfaceV1 },
      { path: 'default.wgsl', source: defaultSurface },
    ],
    project: [{ path: 'rusted-surface.wgsl', source: customSurface }],
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const material: MaterialAsset = {
  kind: 'material',
  passes: [{ name: 'forward', program: { module: 'forgeax_material::standard' } }],
  parameters: [],
};

describe('Surface composition owner-cut', () => {
  it.each([
    'unreachable',
    'engine',
    'project',
  ] as const)('admits a resource helper only from the actual template Engine closure (authority=%s)', async (authority) => {
    const sharedView = {
      path: 'shared-view.wgsl',
      source: `#define_import_path game::shared_view
struct TemplateView { tint: vec4<f32> }
@group(0) @binding(0) var<uniform> templateView: TemplateView;
fn sharedTint() -> vec3<f32> { return templateView.tint.rgb; }`,
    };
    const sources = buildMaterialSourceCatalog({
      engine: [
        {
          path: 'standard.wgsl',
          source:
            authority !== 'unreachable'
              ? template.replace(
                  '#pragma material_slot surface',
                  '#import game::shared_view::{sharedTint}\n#pragma material_slot surface',
                )
              : template,
        },
        { path: 'surface_v1.wgsl', source: surfaceV1 },
        ...(authority === 'project' ? [] : [sharedView]),
      ],
      project: [
        {
          path: 'surface.wgsl',
          source: customSurface
            .replace(
              'fn evaluate_surface',
              '#import game::shared_view::{sharedTint}\nfn evaluate_surface',
            )
            .replace('vec3<f32>(0.6)', 'sharedTint()'),
        },
        ...(authority === 'project' ? [sharedView] : []),
      ],
    }).unwrap();
    const composed = composeSurfaceSource({
      material: 'shared-template-resource',
      pass: 'forward',
      templateModule: 'forgeax_material::standard',
      surfaceModule: 'game::rusted_surface',
      sources,
    });
    if (authority !== 'engine') {
      expect(composed).toMatchObject({
        ok: false,
        error: {
          code: 'material-surface-forbidden-interface',
          detail: { source: 'shared-view.wgsl', interface: 'resource-binding' },
        },
      });
      return;
    }
    expect(composed.ok, composed.ok ? '' : composed.error.message).toBe(true);
    if (!composed.ok) return;
    const compiled = await compileShader(composed.value.source, {
      id: 'shared-template-resource',
      imports: composed.value.imports,
    });
    expect(compiled.ok, compiled.ok ? '' : compiled.error.message).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.value.reflection.boundGlobals).toMatchObject([{ group: 0, binding: 0 }]);
  });

  it.each([
    false,
    true,
  ])('gates the native scene depth reader on before-pass (%s)', async (enabled) => {
    const depth = readFileSync(
      new URL('../../../../shader/src/material-scene-depth.wgsl', import.meta.url),
      'utf8',
    );
    const sources = buildMaterialSourceCatalog({
      engine: [
        { path: 'standard.wgsl', source: template },
        { path: 'surface_v1.wgsl', source: surfaceV1 },
        { path: 'depth.wgsl', source: depth },
      ],
      project: [
        {
          path: 'surface.wgsl',
          source: customSurface
            .replace(
              'fn evaluate_surface',
              '#import forgeax_material::scene_depth::{sceneDepth}\nfn evaluate_surface',
            )
            .replace('vec3<f32>(0.6)', 'vec3<f32>(textureLoad(sceneDepth,vec2<i32>(0),0))'),
        },
      ],
    }).unwrap();
    const composed = composeSurfaceSource({
      material: 'depth',
      pass: 'forward',
      templateModule: 'forgeax_material::standard',
      surfaceModule: 'game::rusted_surface',
      sources,
      ...(enabled ? { sceneDepth: 'before-pass' as const } : {}),
    });
    if (!enabled) {
      expect(composed).toMatchObject({
        ok: false,
        error: { code: 'material-surface-forbidden-interface' },
      });
      return;
    }
    expect(composed.ok, composed.ok ? '' : composed.error.message).toBe(true);
    if (!composed.ok) return;
    const compiled = await compileShader(composed.value.source, {
      id: 'depth',
      imports: composed.value.imports,
    });
    expect(compiled.ok, compiled.ok ? '' : compiled.error.message).toBe(true);
    if (compiled.ok)
      expect(compiled.value.reflection.boundGlobals).toContainEqual(
        expect.objectContaining({ group: 0, binding: 1 }),
      );
  });

  it('imports generated type-only references while retaining local and member resource names', async () => {
    const sources = buildMaterialSourceCatalog({
      engine: [
        {
          path: 'standard.wgsl',
          source: `${template}
fn localTint() -> vec3<f32> {
  var value: MaterialParameters;
  return value.tint.rgb;
}`,
        },
        { path: 'surface_v1.wgsl', source: surfaceV1 },
      ],
      project: [
        {
          path: 'surface.wgsl',
          source: customSurface
            .replace(
              'fn evaluate_surface',
              '#import game::tint::{surfaceTint}\nstruct LocalNames { paletteTexture: vec3<f32> }\nfn evaluate_surface',
            )
            .replace(
              '{ return SurfaceData(vec3<f32>(0.6)',
              '{ let paletteTexture = vec3<f32>(0.25); let names = LocalNames(vec3<f32>(0.5)); return SurfaceData(paletteTexture + names.paletteTexture + surfaceTint() + localTint()',
            ),
        },
        {
          path: 'tint.wgsl',
          source: `#define_import_path game::tint
#import forgeax_material::parameters::{MaterialParameters}
fn surfaceTint() -> vec3<f32> {
  var value: MaterialParameters;
  return value.tint.rgb;
}`,
        },
      ],
    }).unwrap();
    const composed = composeSurfaceSource({
      material: 'type-only-resource-shadow',
      pass: 'forward',
      templateModule: 'forgeax_material::standard',
      surfaceModule: 'game::rusted_surface',
      generatedParameters: generateParameterModule([
        { name: 'tint', type: 'vec4' },
        { name: 'paletteTexture', type: 'texture2d' },
      ]),
      sources,
    }).unwrap();
    const canonicalImport = composed.source.split('\n')[0];
    expect(canonicalImport).toContain('MaterialParameters');
    expect(canonicalImport).not.toContain('paletteTexture');
    const compiled = await compileShader(composed.source, {
      id: 'type-only-resource-shadow',
      imports: composed.imports,
    });
    expect(compiled.ok, compiled.ok ? '' : compiled.error.message).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.value.reflection.boundGlobals).toEqual([]);
  });

  it.each([
    false,
    true,
  ])('shares generated implicit Surface resources with a composable material helper (scene=%s)', async (scene) => {
    const helperSurface = customSurface
      .replace('fn evaluate_surface', '#import game::tint::{surfaceTint}\nfn evaluate_surface')
      .replace(
        'vec3<f32>(0.6)',
        'textureSample(paletteTexture, paletteTexture_sampler, input.uv0).rgb * surfaceTint()',
      );
    const sources = buildMaterialSourceCatalog({
      engine: [
        {
          path: 'standard.wgsl',
          source: scene
            ? template.replace('  let input =', '  material.tint = vec4<f32>(0.5);\n  let input =')
            : template,
        },
        { path: 'surface_v1.wgsl', source: surfaceV1 },
      ],
      project: [
        { path: 'surface.wgsl', source: helperSurface },
        {
          path: 'tint.wgsl',
          source: `#define_import_path game::tint
#import forgeax_material::parameters::{material}
fn surfaceTint() -> vec3<f32> { return material.tint.rgb; }`,
        },
      ],
    }).unwrap();
    const composed = composeSurfaceSource({
      material: 'implicit-resource',
      pass: 'forward',
      templateModule: 'forgeax_material::standard',
      surfaceModule: 'game::rusted_surface',
      generatedParameters: generateParameterModule(
        [
          { name: 'tint', type: 'vec4' },
          { name: 'paletteTexture', type: 'texture2d' },
        ],
        scene
          ? { sceneIndex: true, sceneIndexDeclarations: false, sceneMaterialPrivate: true }
          : {},
      ),
      sources,
    }).unwrap();
    const compiled = await compileShader(composed.source, {
      id: `implicit-surface-resources-${scene}`,
      imports: composed.imports,
    });
    expect(compiled.ok, compiled.ok ? '' : compiled.error.message).toBe(true);
    if (!compiled.ok) return;
    const bindings = compiled.value.reflection.boundGlobals.map(
      (binding) => `${binding.group}:${binding.binding}`,
    );
    expect(new Set(bindings).size).toBe(bindings.length);
    expect(bindings).toEqual(scene ? ['1:1', '1:2'] : ['1:0', '1:1', '1:2']);
    if (scene) {
      const privateProviders = [
        ...compiled.value.wgsl.matchAll(/var<private>\s+(\w+)\s*:\s*MaterialParameters\w*/g),
      ];
      expect(privateProviders).toHaveLength(1);
      const provider = privateProviders[0]?.[1];
      const helperBody = /fn surfaceTint\w*\([\s\S]*?\n\}/.exec(compiled.value.wgsl)?.[0];
      expect(helperBody).toContain(`${provider}.tint`);
      expect(compiled.value.wgsl).toContain(`${provider}.tint =`);
    }
  });

  it('compiles a time-animated authored Surface against the actual Engine ABI', async () => {
    const sources = buildMaterialSourceCatalog({
      engine: [
        { path: 'standard.wgsl', source: template },
        {
          path: 'surface_v1.wgsl',
          source: readFileSync(
            new URL('../../../../shader/src/surface_v1.wgsl', import.meta.url),
            'utf8',
          ),
        },
        { path: 'default.wgsl', source: defaultSurface },
      ],
      project: [
        {
          path: 'timed-surface.wgsl',
          source: customSurface.replace('vec3<f32>(0.6)', 'vec3<f32>(input.frameTime)'),
        },
      ],
    }).unwrap();
    const composed = composeSurfaceSource({
      material: 'timed-surface',
      pass: 'forward',
      templateModule: 'forgeax_material::standard',
      surfaceModule: 'game::rusted_surface',
      sources,
    }).unwrap();
    const compiled = await compileShader(composed.source, {
      id: 'actual-surface-frame-clock',
      imports: composed.imports,
    });
    expect(compiled.ok, compiled.ok ? '' : JSON.stringify(compiled.error)).toBe(true);
  });

  it('shares pure helper symbols when Surface and template import the same module', async () => {
    const importedTemplate = template.replace(
      '@fragment',
      '#import game::lighting::{Lighting}\n#import game::normal::{normalStrength}\nvar<private> lighting: Lighting;\n@fragment',
    );
    const helperSurface = customSurface
      .replace(
        'fn evaluate_surface',
        '#import game::normal::{normalColor, normalStrength}\nfn evaluate_surface',
      )
      .replace('vec3<f32>(0.6)', 'normalColor() * normalStrength()');
    const sources = buildMaterialSourceCatalog({
      engine: [
        { path: 'standard.wgsl', source: importedTemplate },
        { path: 'surface_v1.wgsl', source: surfaceV1 },
        { path: 'default.wgsl', source: defaultSurface },
      ],
      project: [
        { path: 'surface.wgsl', source: helperSurface },
        {
          path: 'lighting.wgsl',
          source: '#define_import_path game::lighting\nstruct Lighting { color: vec3<f32> };',
        },
        {
          path: 'normal.wgsl',
          source:
            '#define_import_path game::normal\nfn normalColor() -> vec3<f32> { return vec3<f32>(0.5); }\nfn normalStrength() -> f32 { return 1.0; }',
        },
      ],
    }).unwrap();
    const result = composeSurfaceSource({
      material: 'helper-import',
      pass: 'forward',
      templateModule: 'forgeax_material::standard',
      surfaceModule: 'game::rusted_surface',
      sources,
    }).unwrap();
    const compiled = await compileShader(result.source, {
      id: 'pure-surface-helper',
      imports: result.imports,
    });
    expect(compiled.ok, compiled.ok ? '' : JSON.stringify(compiled.error)).toBe(true);
  });

  it('resolves the custom slot and records a deterministic transitive closure', () => {
    const result = composeSurfaceSource({
      material: 'rusted-iron',
      pass: 'forward',
      templateModule: 'forgeax_material::standard',
      surfaceModule: 'game::rusted_surface',
      sources: catalog(),
      generatedParameters: '#define_import_path forgeax_material::parameters\n',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.source).toContain('return SurfaceData');
    expect(result.value.source).toContain('vec3<f32>(0.6)');
    expect(result.value.source).not.toContain('slot::surface');
    expect(result.value.sourceClosure).toEqual([
      'forgeax_material::parameters',
      'forgeax_material::standard',
      'forgeax_material::surface_v1',
      'game::rusted_surface',
    ]);
    expect(result.value.sourceClosureDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.value.stages).toEqual([
      'slot-resolution',
      'source-closure',
      'surface-validation',
      'parameter-generation',
    ]);
  });

  it('selects the Engine default when a Standard template has no explicit module', () => {
    const result = composeSurfaceSource({
      material: 'standard',
      pass: 'forward',
      templateModule: 'forgeax_material::standard',
      sources: catalog(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.surfaceModule).toBe('forgeax_material::default_standard_surface');
  });

  it('keeps the default/custom module selection on one slot path', () => {
    const sources = catalog();
    const defaultResult = composeSurfaceSource({
      material: material.kind,
      pass: 'forward',
      templateModule: 'forgeax_material::standard',
      sources,
    });
    const customResult = composeSurfaceSource({
      material: 'rusted-iron',
      pass: 'forward',
      templateModule: 'forgeax_material::standard',
      surfaceModule: 'game::rusted_surface',
      sources,
    });
    expect(defaultResult.ok).toBe(true);
    expect(customResult.ok).toBe(true);
    if (!defaultResult.ok || !customResult.ok) return;
    expect(defaultResult.value.source).toContain('evaluate_surface');
    expect(customResult.value.source).toContain('vec3<f32>(0.6)');
  });

  it('returns typed ABI and interface failures before compilation', () => {
    const missing = validateSurfaceSource({
      material: 'probe',
      pass: 'forward',
      source: 'struct SurfaceInput {}',
      sourcePath: 'probe.wgsl',
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('material-surface-abi-mismatch');

    const forbidden = validateSurfaceSource({
      material: 'probe',
      pass: 'forward',
      source: `${customSurface}\n@group(1) @binding(0) var bad: sampler;`,
      sourcePath: 'probe.wgsl',
    });
    expect(forbidden.ok).toBe(false);
    if (!forbidden.ok) expect(forbidden.error.code).toBe('material-surface-forbidden-interface');
  });

  it('ignores forbidden declarations inside nested WGSL comments', () => {
    const result = validateSurfaceDependency({
      material: 'probe',
      pass: 'forward',
      sourcePath: 'helper.wgsl',
      source: '/* outer /* inner */ @group(1) @binding(0) var hidden: sampler; */',
    });
    expect(result.ok).toBe(true);
  });

  it('validates transitive Surface helpers instead of dropping their closure', () => {
    const helper = `#define_import_path game::surface_helper\n@group(1) @binding(0) var forbidden: sampler;`;
    const result = validateSurfaceDependency({
      material: 'probe',
      pass: 'forward',
      source: helper,
      sourcePath: 'surface-helper.wgsl',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('material-surface-forbidden-interface');
  });

  it('keeps a missing Surface catalog fail-closed before raw compilation', async () => {
    const incomplete = buildMaterialSourceCatalog({
      engine: [{ path: 'standard.wgsl', source: template }],
      project: [],
    });
    expect(incomplete.ok).toBe(true);
    if (!incomplete.ok) return;
    const result = composeSurfaceSource({
      material: 'probe',
      pass: 'forward',
      templateModule: 'forgeax_material::standard',
      sources: incomplete.value,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('material-surface-slot-missing');

    const compiled = await compileShader(template, {
      id: 'probe',
      generatedParameters:
        '#define_import_path forgeax_material::parameters\nstruct MaterialParameters {}\n@group(1) @binding(0) var<uniform> material : MaterialParameters;\n',
    });
    expect(compiled.ok).toBe(false);
    if (!compiled.ok) expect(compiled.error.code).toBe('shader-compile-failed');
  });
});
