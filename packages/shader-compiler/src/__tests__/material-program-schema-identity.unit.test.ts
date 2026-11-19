import { createMaterialProgramArtifactReceipt, ShaderRegistry } from '@forgeax/engine-shader';
import {
  derive,
  type MaterialAsset,
  type MaterialParameter,
  projectMaterialParameterSchema,
} from '@forgeax/engine-types';
import { beforeAll, describe, expect, it } from 'vitest';
import { type CompileResult, compileShader } from '../compile.js';
import type { MaterialCookedPass } from '../material/cook.js';
import { materialPrograms } from '../material/publication.js';
import { DEFAULT_MATERIAL_VARIANT_CONTEXT } from '../material/variant-context.js';

const source = `
@vertex fn vs_main() -> @builtin(position) vec4f { return vec4f(0, 0, 0, 1); }
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }
`;
let compile: CompileResult;
const parameters: readonly MaterialParameter[] = [
  { name: 'emissive', type: 'vec3', colorSpace: 'linear', default: [0, 0, 0] },
  { name: 'roughness', type: 'f32', default: 1 },
];

beforeAll(async () => {
  compile = (await compileShader(source)).unwrap();
});

function pass(declarations: readonly MaterialParameter[], name = 'forward'): MaterialCookedPass {
  const schema = projectMaterialParameterSchema(declarations, 'schema-identity', 'cook').unwrap();
  return {
    pass: name,
    module: 'game::schema-identity',
    context: DEFAULT_MATERIAL_VARIANT_CONTEXT,
    parameters: declarations,
    paramSchema: schema,
    generatedModule: '',
    sourceClosure: ['game::schema-identity'],
    sourceClosureDigest: 'same-source-closure',
    compile,
    layoutIdentity: derive(schema).layoutIdentity,
    abi: createMaterialProgramArtifactReceipt({
      schema,
      directEntry: 'vs_main',
      vertexInputs: [],
    }),
  };
}

function publication(declarations = parameters, guid = 'first-material', name = 'forward') {
  const cooked = pass(declarations, name);
  const asset: MaterialAsset = {
    kind: 'material',
    passes: [{ name, program: { module: cooked.module } }],
    parameters: declarations,
    values: {},
  };
  const program = materialPrograms([cooked], {
    guid,
    source: asset,
    compilerFingerprint: 'same-compiler',
  })[0];
  if (program === undefined) throw new Error('Expected one published program');
  const schema = cooked.paramSchema.map((entry) => {
    if (!('default' in entry)) return entry;
    const { default: _default, ...parameter } = entry;
    return parameter;
  });
  return { cooked, program, schema };
}

describe('published raster program parameter identity', () => {
  it('versions a changed fog contract even when source and parameter layout are identical', () => {
    const cooked = pass(parameters);
    const input = {
      guid: 'fog-identity',
      source: { kind: 'material' as const },
      compilerFingerprint: 'same-compiler',
    };
    const unmarked = materialPrograms([cooked], input)[0];
    const marked = materialPrograms(
      [{ ...cooked, abi: { ...cooked.abi, forwardFog: 'height-vertex/1' } }],
      input,
    )[0];
    expect(unmarked?.artifact.digest).toBe(marked?.artifact.digest);
    expect(unmarked?.specializationKey).not.toBe(marked?.specializationKey);
    expect(marked?.selections[0]?.abi?.forwardFog).toBe('height-vertex/1');
  });
  it('distinguishes color-space metadata with identical physical layout and WGSL', () => {
    const linear = publication();
    const srgb = publication([
      { ...parameters[0], name: 'emissive', type: 'vec3', colorSpace: 'srgb' },
      parameters[1] ?? { name: 'roughness', type: 'f32' },
    ]);
    expect(linear.cooked.layoutIdentity).toBe(srgb.cooked.layoutIdentity);
    expect(linear.program.artifact.digest).toBe(srgb.program.artifact.digest);
    expect(linear.schema).not.toEqual(srgb.schema);
    expect(linear.program.specializationKey).not.toBe(srgb.program.specializationKey);
  });

  it('distinguishes an absent color-space policy from an explicit linear policy', () => {
    const implicit = publication([
      { name: 'emissive', type: 'vec3' },
      { name: 'roughness', type: 'f32' },
    ]);
    const explicit = publication();
    expect(implicit.cooked.layoutIdentity).toBe(explicit.cooked.layoutIdentity);
    expect(implicit.program.specializationKey).not.toBe(explicit.program.specializationKey);
  });

  it('retains the same key when only root defaults, optionality or material identity change', () => {
    const changed = publication(
      [
        {
          name: 'emissive',
          type: 'vec3',
          colorSpace: 'linear',
          default: [1, 2, 3],
          optional: true,
        },
        { name: 'roughness', type: 'f32', default: 0.2, optional: true },
      ],
      'independent-material',
    );
    const original = publication();
    expect(changed.schema).toEqual(original.schema);
    expect(changed.program.specializationKey).toBe(original.program.specializationKey);
  });

  it('projects declaration field construction order through the existing schema owner', () => {
    const reordered = publication([
      { colorSpace: 'linear', type: 'vec3', name: 'emissive', default: [0, 0, 0] },
      { default: 1, type: 'f32', name: 'roughness' },
    ]);
    expect(reordered.program.specializationKey).toBe(publication().program.specializationKey);
  });

  it('admits both distinct-schema programs while rejecting a forged same-key schema', () => {
    const linear = publication();
    const srgb = publication([
      { name: 'emissive', type: 'vec3', colorSpace: 'srgb' },
      { name: 'roughness', type: 'f32' },
    ]);
    const shaders = new ShaderRegistry({ manifestUrl: undefined });
    for (const row of [linear, srgb]) {
      const input = {
        bytes: row.program.artifact.bytes,
        digest: row.program.artifact.digest,
        paramSchema: row.schema,
        receipt: row.cooked.abi,
      };
      expect(shaders.validateMaterialArtifactBytes(row.program.specializationKey, input).ok).toBe(
        true,
      );
      shaders.installMaterialArtifactBytes(row.program.specializationKey, input);
    }
    expect(
      shaders.validateMaterialArtifactBytes(linear.program.specializationKey, {
        bytes: srgb.program.artifact.bytes,
        digest: srgb.program.artifact.digest,
        paramSchema: srgb.schema,
        receipt: srgb.cooked.abi,
      }),
    ).toMatchObject({ ok: false, error: { detail: { dimension: 'param-schema' } } });
  });

  it('keeps color and shadow selections on one same-schema program', () => {
    const forward = pass(parameters, 'forward');
    const shadow = pass(parameters, 'shadow');
    const programs = materialPrograms([forward, shadow], {
      guid: 'shared-selection',
      source: {
        kind: 'material',
        passes: [
          { name: 'forward', program: { module: forward.module } },
          { name: 'shadow', program: { module: shadow.module } },
        ],
        values: {},
      },
      compilerFingerprint: 'same-compiler',
    });
    expect(programs).toHaveLength(1);
    expect(programs[0]?.selections.map((selection) => selection.pass)).toEqual([
      'forward',
      'shadow',
    ]);
  });
});
