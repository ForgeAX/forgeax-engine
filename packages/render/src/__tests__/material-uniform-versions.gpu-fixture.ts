import { vec3 } from '@forgeax/engine-math';
import { createShaderModule } from '@forgeax/engine-rhi-webgpu';
import { type AssetHandle, ok } from '@forgeax/engine-types';
import { assert, expect } from 'vitest';
import { MaterialResource } from '../material-resource';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { PerSubmeshMaterialBgDeps } from '../record/main-pass-material';
import {
  materialUniformResources,
  prepareMaterialUniform,
  recordMaterialUniforms,
} from '../record/material-uniforms';
import { MATERIAL_PER_ENTITY_STRIDE } from '../record/render-context';
import { nativeDeviceFixture } from './native-device-fixture';

/** Both draws share one physical submission: queue writes cannot impersonate version capture. */
export async function verifyMaterialUniformVersions(
  kind: 'material' | 'texture' | 'prepared-parameters' = 'material',
) {
  const { device, native } = await nativeDeviceFixture(
    kind === 'texture' ? { requiredFeatures: ['texture-compression-bc'] } : undefined,
  );
  native.pushErrorScope('validation');
  const textureVersions =
    kind === 'texture'
      ? [2, 4].map((width) => ({
          asset: {
            kind: 'texture',
            shape: { viewDimension: '2d', extent: { width, height: 4 } },
            format: 'bc1-rgba-unorm',
          },
          texture: device
            .createTexture({
              size: { width: 4, height: 4 },
              format: 'bc1-rgba-unorm',
              usage: 4 | 2,
            })
            .unwrap(),
        }))
      : [];
  const textureViews = textureVersions.map(({ texture }) =>
    device.createTextureView(texture, {}).unwrap(),
  );
  const shader = (
    await createShaderModule(device, {
      code: `
${kind === 'texture' ? 'struct Numeric { pad: array<vec4<f32>, 5>, uv: vec4<f32> }; @group(0) @binding(0) var<uniform> numeric: Numeric;' : '@group(0) @binding(0) var<uniform> tint: vec4<f32>;'}
@vertex fn vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let p = array<vec2<f32>, 3>(vec2<f32>(-1., -1.), vec2<f32>(3., -1.), vec2<f32>(-1., 3.));
  return vec4<f32>(p[i], 0., 1.);
}
@fragment fn fragment() -> @location(0) vec4<f32> { return ${kind === 'texture' ? 'select(vec4<f32>(0.,1.,0.,1.),vec4<f32>(1.,0.,0.,1.),numeric.uv.x < 0.75)' : 'tint'}; }
`,
    })
  ).unwrap();
  const uniforms = device
    .createBuffer({ size: MATERIAL_PER_ENTITY_STRIDE * 2, usage: 64 | 8 })
    .unwrap();
  const layout = device
    .createBindGroupLayout({
      entries: [{ binding: 0, visibility: 2, buffer: { type: 'uniform', hasDynamicOffset: true } }],
    })
    .unwrap();
  const group = device
    .createBindGroup({
      layout,
      entries: [
        {
          binding: 0,
          resource: {
            kind: 'buffer',
            value: { buffer: uniforms, size: kind === 'texture' ? 96 : 16 },
          },
        },
      ],
    })
    .unwrap();
  const pipeline = device
    .createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
      vertex: { module: shader, entryPoint: 'vertex', buffers: [] },
      fragment: { module: shader, entryPoint: 'fragment', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    })
    .unwrap();
  const target = device
    .createTexture({ size: { width: 16, height: 4 }, format: 'rgba8unorm', usage: 16 | 1 })
    .unwrap();
  const view = device.createTextureView(target, {}).unwrap();
  const readback = device.createBuffer({ size: 256 * 4, usage: 1 | 8 }).unwrap();
  const root = new MaterialResource({
    passes: [],
    baseColor: vec3.create(1, 0, 0),
    metallic: 0,
    roughness: 1,
    ...(kind === 'texture'
      ? { textureHandles: new Map([['baseColorTexture', 17 as AssetHandle<'texture'>]]) }
      : { materialParamSchema: [{ name: 'baseColor', type: 'vec4' as const }] }),
  });
  const firstParameters = Object.freeze({ baseColor: [1, 0, 0, 1] });
  const nextParameters = Object.freeze({ baseColor: [0, 1, 0, 1] });
  let parameters = firstParameters;
  const deps = {
    runtime: {
      device,
      ...(kind === 'prepared-parameters' ? { preparedMaterialParameters: () => parameters } : {}),
    },
    frameState: {},
    pipelineState: { materialUniformBuffer: { buffer: uniforms } },
  } as unknown as PerSubmeshMaterialBgDeps;
  const resources =
    textureViews.length === 0
      ? [materialUniformResources([]), materialUniformResources([])]
      : textureViews.map((view) => materialUniformResources([view]));
  const scopes =
    kind === 'texture'
      ? textureVersions.map(
          ({ asset }, index) =>
            ({
              identity: `texture-version-${index}`,
              resolveAsset: () => ok(asset),
            }) as unknown as RenderResourceScope,
        )
      : [{} as RenderResourceScope, {} as RenderResourceScope];
  const [oldScope, newScope] = scopes;
  const [oldResources, newResources] = resources;
  assert(oldScope && newScope && oldResources && newResources);
  const old = root.snapshot;
  try {
    recordMaterialUniforms(() => {
      const encoder = device.createCommandEncoder().unwrap();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
      });
      pass.setPipeline(pipeline);
      const before = prepareMaterialUniform(deps, old, oldScope, oldResources);
      pass.setViewport(0, 0, 8, 4, 0, 1);
      pass.setBindGroup(0, group, [before * MATERIAL_PER_ENTITY_STRIDE]);
      pass.draw(3);
      if (kind === 'material') root.adopt({ ...old, baseColor: vec3.create(0, 1, 0) });
      if (kind === 'prepared-parameters') parameters = nextParameters;
      const after = prepareMaterialUniform(deps, root.snapshot, newScope, newResources);
      expect(after).not.toBe(before);
      if (kind === 'prepared-parameters') {
        expect(root.snapshot).toBe(old);
        expect(prepareMaterialUniform(deps, old, oldScope, oldResources)).toBe(after);
        parameters = firstParameters;
      }
      expect(prepareMaterialUniform(deps, old, oldScope, oldResources)).toBe(before);
      pass.setViewport(8, 0, 8, 4, 0, 1);
      pass.setBindGroup(0, group, [after * MATERIAL_PER_ENTITY_STRIDE]);
      pass.draw(3);
      pass.end();
      encoder.copyTextureToBuffer(
        { texture: target },
        { buffer: readback, bytesPerRow: 256, rowsPerImage: 4 },
        { width: 16, height: 4, depthOrArrayLayers: 1 },
      );
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
    });
    await device.queue.onSubmittedWorkDone();
    const mapping = (await readback.mapAsync(1)).unwrap();
    const pixels = new Uint8Array(mapping.getMappedRange().unwrap().slice(0));
    mapping.unmap();
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 16; x++) {
        expect(Array.from(pixels.subarray(y * 256 + x * 4, y * 256 + x * 4 + 4))).toEqual(
          x < 8 ? [255, 0, 0, 255] : [0, 255, 0, 255],
        );
      }
    expect(await native.popErrorScope()).toBeNull();
  } finally {
    device.destroyBuffer(uniforms).unwrap();
    device.destroyBuffer(readback).unwrap();
    device.destroyTexture(target).unwrap();
    for (const { texture } of textureVersions) device.destroyTexture(texture).unwrap();
    native.destroy();
  }
}
