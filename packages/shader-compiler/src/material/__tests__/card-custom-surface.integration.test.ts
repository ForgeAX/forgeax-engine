import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type MaterialAsset, ok, standardSurfaceParameters } from '@forgeax/engine-types';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { compileShader } from '../../compile.js';
import { collectMaterialSources } from '../pack-cooker.js';
import { cookRayMaterial } from '../ray-material.js';
import { buildMaterialSourceCatalog } from '../source-catalog.js';

vi.hoisted(() => vi.stubEnv('FORGEAX_SHADER_COMPILE_WORKERS', '1'));
afterAll(() => vi.unstubAllEnvs());

const asset: MaterialAsset = {
  kind: 'material',
  parameters: standardSurfaceParameters([{ name: 'baseColor', type: 'color' }]),
  passes: [{ name: 'Forward', program: { module: 'forgeax_material::standard' } }],
  surface: { model: 'standard', module: 'game::card_surface' },
};

const color =
  'vec3<f32>(0.25 + input.uv0.x * 0.25, 0.125 + input.uv1.y * 0.25, input.vertexColor.b * 0.25)';

function source(expression = color, extra = ''): string {
  return `#define_import_path game::card_surface
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}
${extra}
fn evaluate_surface(input: SurfaceInput) -> SurfaceData {
  let color = ${expression};
  return SurfaceData(color, normalize(input.vertexNormalWS), 0.0, 0.5,
    vec3<f32>(0.125), 1.0, 1.0, 0.0, 0.0);
}
`;
}

const textureExpression =
  'textureSample(baseColorTexture, baseColorTexture_sampler, input.uv0).rgb';
const textureImport =
  '#import forgeax_material::parameters::{baseColorTexture, baseColorTexture_sampler}';
const texturedAsset: MaterialAsset = {
  ...asset,
  parameters: standardSurfaceParameters([{ name: 'baseColorTexture', type: 'texture' }]),
  values: { baseColorTexture: '019f0000-0000-7000-8000-00000000ca02' },
};

async function cook(
  text: string,
  context: 'card-capture' | 'ray-hit' = 'card-capture',
  compile = compileShader,
  material = asset,
) {
  const root = await mkdtemp(join(tmpdir(), 'card-custom-surface-'));
  try {
    await writeFile(join(root, 'surface.wgsl'), text);
    const engine = fileURLToPath(new URL('../../../../shader/src/', import.meta.url));
    const records = await collectMaterialSources([root, engine], [engine]);
    const sources = buildMaterialSourceCatalog(records).unwrap();
    return await cookRayMaterial(
      {
        material: 'custom-card',
        table: { 'custom-card': material },
        sources,
        context,
      },
      compile,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('static custom Surface Card qualification', { timeout: 30_000 }, () => {
  it('keeps static texture sampling eligible when Naga derives filtering from its actual use', async () => {
    const facts: { id: string | undefined; resources: unknown[] }[] = [];
    const compile: typeof compileShader = async (text, options) => {
      const result = await compileShader(text, options);
      if (result.ok)
        facts.push({
          id: options?.id,
          resources: result.value.reflection.boundGlobals.filter(
            (global) => global.group === 1 && global.resourceKind !== 'buffer',
          ),
        });
      return result;
    };
    const result = await cook(
      source(textureExpression, textureImport),
      'card-capture',
      compile,
      texturedAsset,
    );
    expect(result.ok, JSON.stringify({ error: result.ok ? undefined : result.error, facts })).toBe(
      true,
    );
  });

  it.each([
    [1, 'samplerType', 'comparison'],
    [2, 'sampleType', 'uint'],
    [2, 'viewDimension', '3d'],
  ] as const)('retains actual resource rejection at binding %i %s=%s', async (binding, field, value) => {
    const incompatible: typeof compileShader = async (text, options) => {
      const result = await compileShader(text, options);
      if (!result.ok || options?.id !== 'forgeax_material::ray_surface::card-capture')
        return result;
      return ok({
        ...result.value,
        reflection: {
          ...result.value.reflection,
          boundGlobals: result.value.reflection.boundGlobals.map((global) =>
            global.group === 1 && global.binding === binding
              ? { ...global, [field]: value }
              : global,
          ),
        },
      });
    };
    const result = await cook(
      source(textureExpression, textureImport),
      'card-capture',
      incompatible,
      texturedAsset,
    );
    expect(result.ok).toBe(false);
  });

  it('compiles the authored UV/color Surface into the real Card entries', async () => {
    const result = await cook(source());
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.value.program.context).toBe('card-capture');
    expect(result.value.program.wgsl).toContain('fn vs_card');
    expect(result.value.program.wgsl).toContain('fn fs_card');
    expect(result.value.sourceClosure).toContain('game::card_surface');
  });

  it.each([
    'input.viewDirectionWS',
    'vec3<f32>(input.frameTime)',
  ])('refuses unavailable static-cache context: %s', async (value) => {
    const result = await cook(source(value));
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'ray-material-unsupported',
        detail: { requirement: expect.stringContaining('static Card inputs') },
      },
    });
  });

  it('preserves a deliberate Card expression in the existing compiler context', async () => {
    const result = await cook(
      source(
        'cardColor(input)',
        `
fn cardColor(input: SurfaceInput) -> vec3<f32> {
#ifdef CARD_SURFACE_CONTEXT
  return vec3<f32>(input.uv0, 0.25);
#else
  return abs(input.viewDirectionWS);
#endif
}`,
      ),
    );
    expect(result.ok).toBe(true);
  });

  it('keeps fragment derivatives legal without admitting them to compute ray hits', async () => {
    const text = source(
      'clamp(vec3<f32>(fwidth(input.uv0), 0.25), vec3<f32>(0.0), vec3<f32>(1.0))',
    );
    expect((await cook(text)).ok).toBe(true);
    const ray = await cook(text, 'ray-hit');
    expect(ray).toMatchObject({ ok: false, error: { code: 'ray-material-unsupported' } });
  });

  it('does not hide an actual Card-context compile error as optional unsupported input', async () => {
    const result = await cook(source('notADeclaredFunction(input.uv0)'));
    expect(result).toMatchObject({ ok: false, error: { code: 'shader-compile-failed' } });
  });

  it('refuses a legacy producer with unknown member facts before publishing a Card program', async () => {
    const legacy: typeof compileShader = (source, options = {}) => {
      const { valueMemberReads: _request, ...ordinary } = options;
      return compileShader(source, ordinary);
    };
    expect(await cook(source(), 'card-capture', legacy)).toMatchObject({
      ok: false,
      error: {
        code: 'ray-material-unsupported',
        detail: { requirement: expect.stringContaining('missing typed member facts') },
      },
    });
  });

  it('accepts an unreachable view-dependent helper outside the actual Card call closure', async () => {
    const result = await cook(
      source(
        color,
        `
fn unusedViewHelper(input: SurfaceInput) -> vec3<f32> { return input.viewDirectionWS; }
`,
      ),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects an actual private renderer global without confusing the producer eye with Surface reads', async () => {
    expect(await cook(source('abs(card.eye.xyz)'))).toMatchObject({
      ok: false,
      error: {
        code: 'ray-material-unsupported',
        detail: { requirement: expect.stringContaining('renderer or private global') },
      },
    });
    expect(
      (
        await cook(
          source(color, 'fn unusedPrivate(input: SurfaceInput) -> vec3f { return card.eye.xyz; }'),
        )
      ).ok,
    ).toBe(true);
  });

  it('keeps missing lexical-global facts unknown instead of assuming no global dependencies', async () => {
    const incomplete: typeof compileShader = async (...args) => {
      const result = await compileShader(...args);
      if (!result.ok) return result;
      return ok({
        ...result.value,
        reflection: {
          ...result.value.reflection,
          entryPoints:
            result.value.reflection.entryPoints?.map((entry) =>
              entry.valueReads === undefined
                ? entry
                : {
                    ...entry,
                    valueReads: {
                      ...entry.valueReads,
                      structs: entry.valueReads.structs.map(
                        ({ consumerGlobals: _unknown, ...row }) => row,
                      ),
                    },
                  },
            ) ?? [],
        },
      });
    };
    expect(await cook(source(), 'card-capture', incomplete)).toMatchObject({
      ok: false,
      error: {
        code: 'ray-material-unsupported',
        detail: { requirement: expect.stringContaining('missing typed consumer global facts') },
      },
    });
  });

  it('rejects a matching group/binding whose actual Material uniform layout is wrong', async () => {
    const wrongLayout: typeof compileShader = async (source, options) => {
      const result = await compileShader(source, options);
      if (!result.ok || options?.id !== 'forgeax_material::ray_surface::card-capture')
        return result;
      return ok({
        ...result.value,
        reflection: {
          ...result.value.reflection,
          boundGlobals: result.value.reflection.boundGlobals.map((global) =>
            global.group === 1 && global.binding === 0
              ? { ...global, span: (global.span ?? 0) + 16 }
              : global,
          ),
        },
      });
    };
    expect(await cook(source(), 'card-capture', wrongLayout)).toMatchObject({
      ok: false,
      error: { code: 'material-derived-interface-mismatch' },
    });
  });

  it('refuses a direct capture-resource dependency in the Surface consumer', async () => {
    const result = await cook(
      source(
        'abs(captureEye.xyz)',
        `
@group(0) @binding(3) var<uniform> captureEye: vec4f;
`,
      ),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'material-surface-forbidden-interface' },
    });
  });

  it('retains the authoring rejection of unused raw resource declarations', async () => {
    const result = await cook(
      source(
        color,
        `
@group(3) @binding(0) var<uniform> unusedCamera: vec4f;
fn uncalledGlobal(input: SurfaceInput) -> vec3f { return unusedCamera.xyz + input.positionWS; }
`,
      ),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'material-surface-forbidden-interface' },
    });
  });

  it.each([
    '@ group(3) @ binding(0)',
    '@ /* outer /* nested */ end */ group(3) @ /* gap */ binding(0)',
  ])('refuses actual legal-WGSL raw attributes before Card publication: %s', async (attributes) => {
    expect(
      await cook(
        source('abs(externalView.xyz)', `${attributes} var<uniform> externalView: vec4f;`),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'material-surface-forbidden-interface' },
    });
  });

  it('compiles legal data attributes while ignoring commented pseudo resource declarations', async () => {
    expect(
      (
        await cook(
          source(
            color,
            `
/* @ group(3) /* @ vertex */ @ binding(0) */
struct LegalData { @align(16) @size(16) color: vec3f, }
`,
          ),
        )
      ).ok,
    ).toBe(true);
  });

  it('keeps an unavailable external global out of eligible Card publications', async () => {
    const result = await cook(
      source(
        'abs(externalView.xyz)',
        `
@group(3) @binding(0) var<uniform> externalView: vec4f;
`,
      ),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'material-surface-forbidden-interface' },
    });
  });

  it('refuses an ambiguous lookalike typed input while allowing its unused declaration', async () => {
    const extra = `
struct ForeignInput {
  positionOS: vec3f, positionWS: vec3f, geometricNormalWS: vec3f, vertexNormalWS: vec3f,
  tangentWS: vec4f, viewDirectionWS: vec3f, uv0: vec2f, uv1: vec2f, uv2: vec2f, uv3: vec2f,
  uv4: vec2f, uv5: vec2f, uv6: vec2f, uv7: vec2f, vertexColor: vec4f, frontFacing: bool,
  uvFootprint0: vec4f, uvFootprint1: vec4f, objectToWorld: mat3x3f, frameTime: f32,
}
fn makeForeign(input: SurfaceInput) -> ForeignInput {
  return ForeignInput(input.positionOS,input.positionWS,input.geometricNormalWS,input.vertexNormalWS,
    input.tangentWS,vec3f(0,0,1),input.uv0,input.uv1,input.uv2,input.uv3,input.uv4,input.uv5,input.uv6,input.uv7,
    input.vertexColor,input.frontFacing,input.uvFootprint0,input.uvFootprint1,input.objectToWorld,0.0);
}
fn foreignColor(input: ForeignInput) -> vec3f { return vec3f(input.frameTime); }
`;
    expect(await cook(source(color, extra))).toMatchObject({ ok: true });
    expect(await cook(source('foreignColor(makeForeign(input))', extra))).toMatchObject({
      ok: false,
      error: {
        code: 'ray-material-unsupported',
        detail: { requirement: expect.stringContaining('ambiguous') },
      },
    });
  });
});
