import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_COPY_SRC,
  GPU_BUFFER_USAGE_MAP_READ,
  GPU_BUFFER_USAGE_STORAGE,
} from '../gpu-usage';

const ROUGHNESS = Array.from({ length: 11 }, (_, i) => i / 10);
const NDOTV = [0.1, 0.3, 0.5, 0.7, 0.9, 1.0];
const GOLD_F0 = [1.0, 0.782, 0.344] as const;

/**
 * White-furnace proof for the split-sum specular albedo on a real Dawn device.
 * The LUT is produced by the shipped `brdfLutBake_fs`; the evaluator is the
 * shipped `specularEnvironmentAlbedo`. Under a uniform radiance of one, a white
 * metal must return one at every roughness, while the single-scatter split sum
 * it replaced (the falsifier) loses energy as roughness grows.
 */
it('conserves rough-metal specular energy in a white furnace', async () => {
  const compiler = await import(
    /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
  );
  const shared = readFileSync(resolve('packages/shader/src/ibl-shared.wgsl'), 'utf8');
  const imports = {
    'forgeax_pbr::ibl_shared': shared,
    'forgeax_pbr::brdf': readFileSync(resolve('packages/shader/src/brdf.wgsl'), 'utf8'),
  };
  const bake = await compiler.compileShader(
    readFileSync(resolve('packages/shader/src/ibl-brdf-lut.wgsl'), 'utf8'),
    { id: 'forgeax::ibl-furnace-lut-test', imports },
  );
  if (!bake.ok) throw bake.error;
  const probe = await compiler.compileShader(
    `${readFileSync(resolve('packages/shader/src/ibl-sampling.wgsl'), 'utf8')}
@group(0) @binding(0) var lut: texture_2d<f32>;
@group(0) @binding(1) var lutSampler: sampler;
@group(0) @binding(2) var<storage, read_write> outputs: array<vec4<f32>>;
const ROUGHNESS_COUNT: u32 = ${ROUGHNESS.length}u;
const NDOTV: array<f32, ${NDOTV.length}> = array<f32, ${NDOTV.length}>(${NDOTV.map((v) => v.toFixed(2)).join(', ')});
@compute @workgroup_size(1) fn furnace(@builtin(global_invocation_id) id: vec3<u32>) {
  let roughness = f32(id.x % ROUGHNESS_COUNT) / f32(ROUGHNESS_COUNT - 1u);
  let NdotV = NDOTV[id.x / ROUGHNESS_COUNT];
  let gold = vec3<f32>(${GOLD_F0.join(', ')});
  let ab = textureSampleLevel(lut, lutSampler, vec2<f32>(NdotV, roughness), 0.0).rg;
  let white = specularEnvironmentAlbedo(NdotV, roughness, vec3<f32>(1.0), lut, lutSampler);
  let goldMs = specularEnvironmentAlbedo(NdotV, roughness, gold, lut, lutSampler);
  let goldSs = fresnelSchlickRoughness(NdotV, gold, roughness) * ab.r + ab.g;
  // x: white multi-scatter, y: white single-scatter, z/w: gold blue lane.
  outputs[id.x] = vec4<f32>(white.x, ab.r + ab.g, goldMs.b, goldSs.b);
}`,
    { id: 'forgeax::ibl-furnace-probe-test', imports },
  );
  if (!probe.ok) throw probe.error;

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Dawn adapter unavailable');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const count = ROUGHNESS.length * NDOTV.length;
  const lut = device.createTexture({
    size: [256, 256],
    format: 'rgba16float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  const output = device.createBuffer({
    size: count * 16,
    usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_SRC,
  });
  const readback = device.createBuffer({
    size: count * 16,
    usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ,
  });
  try {
    const bakeModule = device.createShaderModule({ code: bake.value.wgsl });
    const bakePipeline = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module: bakeModule, entryPoint: 'fullscreen_vs' },
      fragment: {
        module: bakeModule,
        entryPoint: 'brdfLutBake_fs',
        targets: [{ format: 'rgba16float' }],
      },
    });
    const probePipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({ code: probe.value.wgsl }),
        entryPoint: 'furnace',
      },
    });
    const group = device.createBindGroup({
      layout: probePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: lut.createView() },
        {
          binding: 1,
          resource: device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
          }),
        },
        { binding: 2, resource: { buffer: output } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const lutPass = encoder.beginRenderPass({
      colorAttachments: [{ view: lut.createView(), loadOp: 'clear', storeOp: 'store' }],
    });
    lutPass.setPipeline(bakePipeline);
    lutPass.draw(3);
    lutPass.end();
    const pass = encoder.beginComputePass();
    pass.setPipeline(probePipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(count);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, count * 16);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(readback.getMappedRange()).slice();
    readback.unmap();
    expect(errors).toEqual([]);

    const at = (n: number, r: number) => {
      const base = (n * ROUGHNESS.length + r) * 4;
      return {
        white: values[base] ?? Number.NaN,
        single: values[base + 1] ?? Number.NaN,
        goldMs: values[base + 2] ?? Number.NaN,
        goldSs: values[base + 3] ?? Number.NaN,
      };
    };
    for (let n = 0; n < NDOTV.length; n++) {
      for (let r = 0; r < ROUGHNESS.length; r++) {
        const s = at(n, r);
        const label = `NdotV=${NDOTV[n]} roughness=${ROUGHNESS[r]}`;
        expect(s.white, `white furnace ${label}`).toBeGreaterThan(0.99);
        expect(s.white, `white furnace ${label}`).toBeLessThan(1.01);
        // Compensation only adds the missing bounce energy, never beyond one.
        expect(s.goldMs, `gold ${label}`).toBeGreaterThanOrEqual(s.goldSs - 1e-4);
        expect(s.goldMs, `gold ${label}`).toBeLessThan(1.0);
      }
    }
    // Falsifier: the single-scatter split sum loses a large share at full
    // roughness, so a regression to `F * A + B` fails the white-furnace bound.
    for (let n = 0; n < NDOTV.length; n++) {
      const rough = at(n, ROUGHNESS.length - 1);
      expect(rough.single, `single-scatter NdotV=${NDOTV[n]}`).toBeLessThan(0.85);
      expect(at(n, 0).single - rough.single).toBeGreaterThan(0.1);
      // Colored metal gains energy, bounded by the missing single-scatter share.
      expect(rough.goldMs - rough.goldSs).toBeGreaterThan(0.02);
      expect(rough.goldMs - rough.goldSs).toBeLessThan(1 - rough.single);
    }
  } finally {
    readback.destroy();
    output.destroy();
    lut.destroy();
    device.destroy();
  }
});
