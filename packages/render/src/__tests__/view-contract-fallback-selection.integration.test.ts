import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetRegistry, selectMaterialPassProgram } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack/material-cook';
import { ShaderRegistry } from '@forgeax/engine-shader';
import type { MaterialAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { publishRuntimeAssets } from '../../../assets-runtime/src/__tests__/fixtures/runtime-publication';
import { createMaterialPackCooker } from '../../../shader-compiler/src/material/pack-cooker';
import { resolveMaterialShaderBindingContract } from '../assembly/material-shader-policy';
import { renderMaterialContext } from '../extract/material-context';

const PASS = 'particle-billboard';
const SOURCE = `#define_import_path game::view_fog_billboard
#pragma variant_axis ATMOSPHERE_AVAILABLE
#pragma variant_axis STORAGE_BUFFER_AVAILABLE
#import forgeax_view::common::{View, view}
#import forgeax_view::fog::{translucent_fog, ndc_world}
@group(0) @binding(1) var scene_depth: texture_depth_2d;
struct VertexOutput { @builtin(position) position: vec4<f32>, @location(0) clip: vec3<f32> };
@vertex fn vs_main(@location(0) position: vec3<f32>) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4<f32>(position, 1.0);
  output.clip = position;
  return output;
}
@fragment fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  var rgb = input.clip + view.cameraPos * 0.0;
  rgb += vec3<f32>(textureLoad(scene_depth, vec2<i32>(input.position.xy), 0));
  return vec4<f32>(translucent_fog(view, ndc_world(view, input.clip), rgb, 1.0), 1.0);
}
`;

// The device rows a renderer can report: both uniform fallback backends and
// the storage capabilities with and without the View atmosphere tables.
const DEVICES = [
  { name: 'webgl2 uniform fallback', caps: { backendKind: 'wgpu-webgl2', storageBuffer: false } },
  { name: 'webgpu uniform fallback', caps: { backendKind: 'webgpu', storageBuffer: false } },
  { name: 'webgpu storage', caps: { backendKind: 'webgpu', storageBuffer: true } },
  {
    name: 'webgpu storage with atmosphere',
    caps: { backendKind: 'webgpu', storageBuffer: true },
    limits: { maxSampledTexturesPerShaderStage: 32 },
  },
] as const;

it('selects the cooked View-contract fog program for every device context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'view-contract-fallback-selection-'));
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  try {
    await writeFile(join(root, 'view-fog-billboard.wgsl'), SOURCE);
    const output = await createMaterialPackCooker([root]).cook({
      guid: '5b1f6f0e-4d7c-4c58-9a55-0f2f6f3f7f11',
      source: {
        kind: 'material',
        parameters: [],
        passes: [
          {
            name: PASS,
            program: {
              module: 'game::view_fog_billboard',
              bindings: 'view-and-scene-depth',
              sceneDepth: 'before-pass',
            },
            renderState: { tags: { LightMode: 'Forward' }, queue: 3000, depthWriteEnabled: false },
          },
        ],
      } as unknown as MaterialAsset,
    });
    const record = validateCookedMaterialRecord(
      (output.payload as { cooked: unknown }).cooked,
    ).unwrap();
    publishRuntimeAssets(assets, [{ guid: record.guid, asset: output.payload as MaterialAsset }]);
    const material = (await assets.load(record.guid, 'material')).unwrap();
    const projection = assets.getMaterialProjectionForPayload(
      runtimeAssets(assets).borrow<MaterialAsset>(material).unwrap(),
    );
    if (projection === undefined) throw new Error('material projection is missing');

    const selectedKeys = new Map<string, string>();
    for (const device of DEVICES) {
      const { materialContext } = renderMaterialContext(
        device.caps,
        'limits' in device ? device.limits : undefined,
      );
      if (materialContext === undefined) throw new Error(`${device.name}: no material context`);
      // The particle feature selects with exactly these arguments.
      const selected = selectMaterialPassProgram(projection, PASS, materialContext, 'direct', true);
      expect(
        record.programs.map((program) => program.specializationKey),
        device.name,
      ).toContain(selected.specializationKey);
      const artifact = assets.shaderRegistry.findMaterialArtifact(selected.specializationKey);
      if (!artifact.ok) throw new Error(`${device.name}: selected program is not installed`);
      const receipt = artifact.value.receipt;
      if (receipt === undefined) throw new Error(`${device.name}: selected program has no receipt`);
      const bindingContract = resolveMaterialShaderBindingContract(receipt);
      expect(receipt.entryPoints, device.name).toBeDefined();
      expect(bindingContract.entryPoints, device.name).toBe(receipt.entryPoints);
      expect(bindingContract, device.name).toEqual({
        bindings: 'view-and-scene-depth',
        sceneDepth: 'before-pass',
        entryPoints: receipt.entryPoints,
      });
      // A cooked program is addressed by its key alone: no manifest row exists
      // whose selector axes a variant lookup could miss.
      expect(
        assets.shaderRegistry.materialShaderManifestEntry(selected.specializationKey),
        device.name,
      ).toBeUndefined();
      const wgsl = artifact.value.source;
      expect(wgsl, device.name).toContain('fogHeightOpacity');
      expect(wgsl, device.name).not.toContain('cluster_data_texture');
      expect(wgsl, device.name).not.toMatch(/@group\([1-9]\)/);
      selectedKeys.set(device.name, selected.specializationKey);
    }
    // Both fallback backends and the two storage capabilities own their programs.
    expect(new Set(selectedKeys.values()).size).toBe(DEVICES.length);
  } finally {
    assets.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
