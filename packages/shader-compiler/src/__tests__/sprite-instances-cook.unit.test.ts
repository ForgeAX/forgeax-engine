import { fileURLToPath } from 'node:url';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack/material-cook';
import { createBuiltinMaterialAsset } from '@forgeax/engine-shader';
import type { MaterialAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { cookMaterialAsset } from '../material/cook.js';
import { collectMaterialSources, createMaterialPackCooker } from '../material/pack-cooker.js';
import { buildMaterialSourceCatalog } from '../material/source-catalog.js';
import { DEFAULT_MATERIAL_VARIANT_CONTEXT } from '../material/variant-context.js';

function sprite(module = 'forgeax::sprite'): MaterialAsset {
  const base = createBuiltinMaterialAsset('sprite');
  if (base.parent !== undefined) throw new Error('Expected built-in root material');
  return {
    ...base,
    passes: [{ name: 'forward', program: { module } }],
    parameters: [
      ...(base.parameters ?? []),
      { name: 'region', type: 'vec4' },
      { name: 'pivotAndSize', type: 'vec4' },
      { name: 'slicesAndMode', type: 'vec4' },
      { name: 'baseColorTexture', type: 'texture' },
    ],
  };
}
const instanceStruct = (wgsl: string) => wgsl.match(/struct InstanceData[^{]*\{([^}]+)\}/)?.[1];

describe('published SpriteInstances programs', () => {
  it.each([
    'forgeax::sprite',
    'forgeax_material::sprite',
    'forgeax::sprite-lit',
    'forgeax_material::sprite-lit',
  ])('publishes ordinary and region-bearing layouts for %s', async (module) => {
    const output = await createMaterialPackCooker().cook({
      guid: 'd81bc8b3-0d67-4f7e-97e5-ebbbf8615ade',
      source: sprite(module),
    });
    const parsed = validateCookedMaterialRecord(
      (output.payload as { cooked: unknown }).cooked,
    ).unwrap();
    const programs = parsed.programs.map((program) => ({
      selections: program.selections,
      wgsl: new TextDecoder().decode(program.artifact.bytes),
    }));
    const ordinary = programs.find((program) =>
      program.selections.some((selection) => selection.context.geometry === 'mesh'),
    );
    const instanced = programs.find((program) =>
      program.selections.some((selection) => selection.context.geometry === 'sprite-instances'),
    );
    expect(ordinary).toBeDefined();
    expect(instanced).toBeDefined();
    if (!ordinary || !instanced) throw new Error('Missing published geometry program');
    expect(instanceStruct(ordinary.wgsl)).toContain('previousLocalFromInstance');
    expect(instanceStruct(ordinary.wgsl)).not.toMatch(/\bregion\s*:/);
    expect(instanceStruct(instanced.wgsl)).toContain('previousLocalFromInstance');
    expect(instanceStruct(instanced.wgsl)).toMatch(/\bregion\s*:\s*vec4/);
    // Declaring the right stride is insufficient: vertex UVs must read it.
    expect(/instances\w*\[[^\]]+\]\.region/.test(instanced.wgsl)).toBe(true);
    expect(/instances\w*\[[^\]]+\]\.region/.test(ordinary.wgsl)).toBe(false);
  }, 30_000);

  it('compiles the uniform fallback without the previous transform', async () => {
    const root = fileURLToPath(new URL('../../../shader/src', import.meta.url));
    const sources = await collectMaterialSources([root], [root]);
    const catalog = buildMaterialSourceCatalog({ roots: [root], ...sources }).unwrap();
    const cooked = (
      await cookMaterialAsset({
        material: 'sprite',
        table: { sprite: sprite() },
        sources: catalog,
        context: {
          ...DEFAULT_MATERIAL_VARIANT_CONTEXT,
          backend: 'webgl2',
          capability: 'uniform-fallback',
          geometry: 'sprite-instances',
        },
      })
    ).unwrap();
    const pass = cooked.passes[0];
    if (!pass) throw new Error('Missing uniform sprite pass');
    const struct = instanceStruct(pass.compile.wgsl);
    expect(struct).toContain('localFromInstance');
    expect(struct).toMatch(/\bregion\s*:\s*vec4/);
    expect(struct).not.toContain('previousLocalFromInstance');
  }, 30_000);
});
