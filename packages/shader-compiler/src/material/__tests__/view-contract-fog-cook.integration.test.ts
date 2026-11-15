import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack/material-cook';
import type { MaterialAsset, MaterialProgramBindingContract } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createMaterialPackCooker } from '../pack-cooker.js';
import {
  DEFAULT_MATERIAL_VARIANT_CONTEXT,
  lowerMaterialProgramVariantContext,
  lowerMaterialVariantContext,
  materialBindingsCarryClusterGroup,
} from '../variant-context.js';

const GROUP_0_CONTRACTS = ['group-0', 'group-0-resource', 'view-only', 'view-and-scene-depth'];
const RENDER_MATERIAL_CONTRACTS = [
  'render-material',
  'render-material-with-scene-depth',
  'render-material-and-scene-depth',
];

describe('program binding contract selectors', () => {
  it.each(
    GROUP_0_CONTRACTS as MaterialProgramBindingContract[],
  )('%s never selects the cluster group', (bindings) => {
    expect(materialBindingsCarryClusterGroup(bindings)).toBe(false);
    for (const backend of ['webgpu', 'webgl2'] as const) {
      for (const capability of ['uniform-fallback', 'storage-buffer'] as const) {
        const context = { ...DEFAULT_MATERIAL_VARIANT_CONTEXT, backend, capability };
        expect(lowerMaterialProgramVariantContext(context, bindings)).toEqual({
          ...lowerMaterialVariantContext(context),
          CLUSTER_FORWARD_AVAILABLE: false,
        });
      }
    }
  });

  it.each([
    undefined,
    ...(RENDER_MATERIAL_CONTRACTS as MaterialProgramBindingContract[]),
  ])('%s keeps the context selectors', (bindings) => {
    expect(materialBindingsCarryClusterGroup(bindings)).toBe(true);
    for (const backend of ['webgpu', 'webgl2'] as const) {
      const context = {
        ...DEFAULT_MATERIAL_VARIANT_CONTEXT,
        backend,
        capability: 'uniform-fallback' as const,
      };
      expect(lowerMaterialProgramVariantContext(context, bindings)).toEqual(
        lowerMaterialVariantContext(context),
      );
      expect(lowerMaterialProgramVariantContext(context, bindings).CLUSTER_FORWARD_AVAILABLE).toBe(
        true,
      );
    }
  });
});

interface ProgramCase {
  readonly bindings: MaterialProgramBindingContract;
  readonly sceneDepth?: 'before-pass';
  readonly fog: boolean;
}

function programSource(program: ProgramCase): string {
  const view = program.bindings !== 'group-0' && program.bindings !== 'group-0-resource';
  const depthBinding =
    program.bindings === 'group-0-resource' ? 0 : program.sceneDepth === undefined ? undefined : 1;
  return `#define_import_path game::contract_fog
#pragma variant_axis ATMOSPHERE_AVAILABLE
#pragma variant_axis STORAGE_BUFFER_AVAILABLE
${view ? '#import forgeax_view::common::{View, view}' : ''}
${program.fog ? '#import forgeax_view::fog::{translucent_fog, ndc_world}' : ''}
${depthBinding === undefined ? '' : `@group(0) @binding(${depthBinding}) var scene_depth: texture_depth_2d;`}
struct VertexOutput { @builtin(position) position: vec4<f32>, @location(0) clip: vec3<f32> };
@vertex fn vs_main(@location(0) position: vec3<f32>) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4<f32>(position, 1.0);
  output.clip = position;
  return output;
}
@fragment fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  var rgb = input.clip;
  ${depthBinding === undefined ? '' : 'rgb += vec3<f32>(textureLoad(scene_depth, vec2<i32>(input.position.xy), 0));'}
  ${view ? 'rgb += view.cameraPos * 0.0;' : ''}
  ${program.fog ? 'rgb = translucent_fog(view, ndc_world(view, input.clip), rgb, 1.0);' : ''}
  return vec4<f32>(rgb, 1.0);
}
`;
}

async function cookProgram(program: ProgramCase) {
  const root = await mkdtemp(join(tmpdir(), 'view-contract-fog-cook-'));
  try {
    await writeFile(join(root, 'contract-fog.wgsl'), programSource(program));
    const source = {
      kind: 'material',
      parameters: [],
      passes: [
        {
          name: 'particle-billboard',
          program: {
            module: 'game::contract_fog',
            bindings: program.bindings,
            ...(program.sceneDepth === undefined ? {} : { sceneDepth: program.sceneDepth }),
          },
          renderState: { tags: { LightMode: 'Forward' }, queue: 3000, depthWriteEnabled: false },
        },
      ],
    } as unknown as MaterialAsset;
    const cooked = await createMaterialPackCooker([root]).cook({ guid: 'contract-fog', source });
    const record = validateCookedMaterialRecord(
      (cooked.payload as { cooked: unknown }).cooked,
    ).unwrap();
    return record.programs.flatMap((entry) =>
      entry.selections.map((selection) => ({
        backend: selection.context.backend,
        capability: selection.context.capability,
        bindings: selection.abi?.bindings,
        wgsl: new TextDecoder().decode(cooked.artifacts[entry.artifact.path]?.bytes),
      })),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const VIEW_CASES: readonly ProgramCase[] = [
  { bindings: 'view-only', fog: true },
  { bindings: 'view-and-scene-depth', sceneDepth: 'before-pass', fog: true },
  { bindings: 'view-only', fog: false },
  { bindings: 'view-and-scene-depth', sceneDepth: 'before-pass', fog: false },
  { bindings: 'group-0', fog: false },
  { bindings: 'group-0-resource', sceneDepth: 'before-pass', fog: false },
];

describe('group-0 and View programs on the uniform fallback', () => {
  it.each(
    VIEW_CASES,
  )('cooks $bindings (fog: $fog) for both fallback backends inside its contract', async (program) => {
    const selections = await cookProgram(program);
    for (const backend of ['webgpu', 'webgl2'] as const) {
      const fallback = selections.filter(
        (selection) => selection.backend === backend && selection.capability === 'uniform-fallback',
      );
      expect(fallback.length).toBeGreaterThan(0);
      for (const selection of fallback) {
        expect(selection.bindings).toBe(program.bindings);
        expect(selection.wgsl).not.toContain('cluster_data_texture');
        expect(selection.wgsl).not.toMatch(/@group\((?:[1-9]\d*)\)/);
        if (program.fog) expect(selection.wgsl).toContain('fogHeightOpacity');
      }
    }
    // The storage variants never bound a later group; the fallback now agrees.
    for (const selection of selections) {
      expect(selection.wgsl).not.toMatch(/@group\((?:[1-9]\d*)\)/);
    }
  });

  it('keeps the packed atmosphere of a Render material program', async () => {
    const selections = await cookProgram({ bindings: 'render-material', fog: true });
    for (const backend of ['webgpu', 'webgl2'] as const) {
      const fallback = selections.filter(
        (selection) => selection.backend === backend && selection.capability === 'uniform-fallback',
      );
      expect(fallback.length).toBeGreaterThan(0);
      for (const selection of fallback) {
        expect(selection.wgsl).toContain('cluster_data_texture');
      }
    }
    for (const selection of selections.filter(
      (candidate) => candidate.capability !== 'uniform-fallback',
    )) {
      expect(selection.wgsl).not.toContain('cluster_data_texture');
    }
  });
});
