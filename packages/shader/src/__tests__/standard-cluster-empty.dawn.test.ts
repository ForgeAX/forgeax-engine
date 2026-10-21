import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { composeShader } from '../../../naga/src/index';

const source = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

function countedCluster(): string {
  const text = source('standard-cluster.wgsl');
  const signature = /fn ndc_position_to_cluster\([\s\S]*?\) -> vec3<u32> \{/;
  if (!signature.test(text)) throw new Error('Missing Standard cluster lookup');
  // Instrument the real lookup, leaving membership and lighting evaluation intact.
  return text.replace(
    signature,
    (match) => `
var<private> clusterLookupCalls: u32;
fn clusterLookupCount() -> u32 { return clusterLookupCalls; }
${match}
  clusterLookupCalls += 1u;`,
  );
}

const common = `
#define_import_path forgeax_view::common
struct View { spotLightViewProj: array<mat4x4<f32>, 4> }
const view = View();
@group(0) @binding(0) var spotShadowMap: texture_depth_2d_array;
@group(0) @binding(1) var shadowSampler: sampler_comparison;
${source('common.wgsl').match(/fn lightingChannelsMatch\([^}]+\}/)?.[0] ?? ''}
`;

it.each([
  true,
  false,
])('Standard cluster storage=%s preserves 0 → 2 → 0 pixels without empty lookups', async (storage) => {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Dawn cluster regression requires a GPU adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const buffers: GPUBuffer[] = [];
  const textures: GPUTexture[] = [];
  const buffer = (size: number, usage: GPUBufferUsageFlags) => {
    const result = device.createBuffer({ size, usage });
    buffers.push(result);
    return result;
  };
  const texture = (descriptor: GPUTextureDescriptor) => {
    const result = device.createTexture(descriptor);
    textures.push(result);
    return result;
  };
  try {
    const code = await composeShader(
      `
#import forgeax_standard::cluster::{evaluateStandardClusterLights, clusterLookupCount, cluster_uniform}
#import forgeax_pbr::lighting_punctual::{evalPoint}
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  return vec4(f32((i << 1u) & 2u)*2.0-1.0, 1.0-f32(i & 2u)*2.0, 0.0, 1.0);
}
struct Output { @location(0) actual: vec4<f32>, @location(1) expected: vec4<f32> }
@fragment fn fs(@builtin(position) p: vec4<f32>) -> Output {
  let right = p.x >= 8.0;
  let far = p.y >= 2.0;
  let channels = select(1u, 2u, u32(p.y) % 2u != 0u);
  let ndc = vec3((p.x / 16.0) * 2.0 - 1.0, 0.0, 0.5);
  let worldPos = vec3((p.x - 8.0) / 16.0, 0.0, 0.0);
  let normal = normalize(vec3(0.2, 0.0, 1.0));
  let viewDir = vec3(0.0, 0.0, 1.0);
  let baseColor = vec3(0.4, 0.6, 0.8);
  let f0 = vec3(0.06);
  let actual = evaluateStandardClusterLights(ndc, p.xy, select(-2.0, -8.0, far),
    worldPos, normal, viewDir, baseColor, 0.3, 0.25, f0, vec3(0.0), false, false,
    channels, false);
  var expected = vec3(0.0);
  if (cluster_uniform.grid.w != 0u) {
    // Independently selected cell membership and channels; real punctual BRDF.
    if (right && channels == 1u) {
      expected += evalPoint(vec3(-0.5,0.0,2.0), vec3(4.0,2.0,1.0), 0.01, 2.0,
        worldPos, normal, viewDir, baseColor, 0.3, 0.25, f0, vec3(0.0), false);
    }
    if (far && channels == 2u) {
      expected += evalPoint(vec3(0.5,0.0,3.0), vec3(1.0,3.0,5.0), 0.01, 2.0,
        worldPos, normal, viewDir, baseColor, 0.3, 0.25, f0, vec3(0.0), false);
    }
  }
  return Output(vec4(actual, f32(clusterLookupCount())), vec4(expected, 1.0));
}`,
      {
        'forgeax_view::common': common,
        'forgeax_standard::cluster': countedCluster(),
        'forgeax_pbr::lighting_punctual': source('lighting-punctual.wgsl'),
        'forgeax_pbr::lighting_spot_modifiers': source('lighting-spot-modifiers.wgsl'),
        'forgeax_pbr::lighting_spot_projector': source('lighting-spot-projector.wgsl'),
        'forgeax_pbr::lighting_ies_profile': source('lighting-ies-profile.wgsl'),
        'forgeax_pbr::lighting_rect_area': source('lighting-rect-area.wgsl'),
        'forgeax_pbr::lighting_attenuation': source('lighting-attenuation.wgsl'),
        'forgeax_pbr::brdf': source('brdf.wgsl'),
        'forgeax_pbr::shadow_pcf': source('shadow-pcf.wgsl'),
      },
      { CLUSTER_FORWARD_AVAILABLE: true, ...(storage ? { STORAGE_BUFFER_AVAILABLE: true } : {}) },
    );
    const module = device.createShaderModule({ code });
    expect((await module.getCompilationInfo()).messages.filter((m) => m.type === 'error')).toEqual(
      [],
    );
    const pipeline = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: {
        module,
        entryPoint: 'fs',
        targets: [{ format: 'rgba32float' }, { format: 'rgba32float' }],
      },
    });
    const depth = texture({
      size: [1, 1, 4],
      format: 'depth32float',
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    const shadows = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: depth.createView({ dimension: '2d-array' }) },
        { binding: 1, resource: device.createSampler({ compare: 'greater' }) },
      ],
    });
    const empty = device.createBindGroup({ layout: pipeline.getBindGroupLayout(1), entries: [] });
    const actual = texture({
      size: [16, 4],
      format: 'rgba32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const expected = texture({
      size: [16, 4],
      format: 'rgba32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const readback = buffer(2048, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    const uniform = buffer(32, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    // Match the renderer's 96-byte DirectLightSlot and grid.w admitted-count ABI.
    const lightData = new ArrayBuffer(256 * 96);
    const lightFloats = new Float32Array(lightData);
    const lightWords = new Uint32Array(lightData);
    lightFloats.set([-0.5, 0, 2, 0.01, 4, 2, 1, 2]);
    lightFloats.set([0.5, 0, 3, 0.01, 1, 3, 5, 2], 24);
    for (let i = 0; i < 2; i++) {
      lightWords.set([0, 0xffffffff, 0xffffffff, 0xffffffff, 1 << i, 0, 0, 0], i * 24 + 16);
    }
    const indices = new Uint32Array([0, 1, 0, 1]);
    const entries: GPUBindGroupEntry[] = [{ binding: 6, resource: { buffer: uniform } }];
    let gridBuffer: GPUBuffer | undefined;
    let dataTexture: GPUTexture | undefined;
    if (storage) {
      const lights = buffer(lightData.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      const indexList = buffer(
        indices.byteLength,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      );
      gridBuffer = buffer(32, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      device.queue.writeBuffer(lights, 0, lightData);
      device.queue.writeBuffer(indexList, 0, indices);
      entries.push(
        { binding: 3, resource: { buffer: lights } },
        { binding: 4, resource: { buffer: gridBuffer } },
        { binding: 5, resource: { buffer: indexList } },
      );
    } else {
      dataTexture = texture({
        size: [1024, 2],
        format: 'rgba32uint',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      entries.push({ binding: 3, resource: dataTexture.createView() });
    }
    const clusters = device.createBindGroup({ layout: pipeline.getBindGroupLayout(2), entries });
    const calls: number[][] = [];
    for (const lightCount of [0, 2, 0]) {
      const payload = new ArrayBuffer(32);
      new Uint32Array(payload).set([2, 1, 2, lightCount]);
      new Float32Array(payload).set([1, 16, Math.log(16), 0], 4);
      device.queue.writeBuffer(uniform, 0, payload);
      // Four cells: empty, first light, second light, both lights.
      const grid =
        lightCount === 0 ? new Uint32Array(8) : new Uint32Array([0, 0, 0, 1, 1, 1, 2, 2]);
      if (gridBuffer) device.queue.writeBuffer(gridBuffer, 0, grid);
      if (dataTexture) {
        const words = new Uint32Array(1024 * 2 * 4);
        words.set(lightWords);
        words.set(grid, 256 * 24);
        words.set(indices, 256 * 24 + 8);
        device.queue.writeTexture(
          { texture: dataTexture },
          words,
          { bytesPerRow: 1024 * 16 },
          [1024, 2],
        );
      }
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [actual, expected].map((target) => ({
          view: target.createView(),
          loadOp: 'clear',
          storeOp: 'store',
        })),
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, shadows);
      pass.setBindGroup(1, empty);
      pass.setBindGroup(2, clusters);
      pass.draw(3);
      pass.end();
      encoder.copyTextureToBuffer(
        { texture: actual },
        { buffer: readback, bytesPerRow: 256 },
        [16, 4],
      );
      encoder.copyTextureToBuffer(
        { texture: expected },
        { buffer: readback, offset: 1024, bytesPerRow: 256 },
        [16, 4],
      );
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const pixels = new Float32Array(readback.getMappedRange()).slice();
      readback.unmap();
      expect(errors).toEqual([]);
      const frameCalls: number[] = [];
      let brightest = 0;
      for (let i = 0; i < 64; i++) {
        expect(pixels[256 + i * 4 + 3]).toBe(1);
        for (let c = 0; c < 3; c++) {
          const value = pixels[i * 4 + c] ?? Number.NaN;
          expect(value, `count=${lightCount} pixel=${i} channel=${c}`).toBeCloseTo(
            pixels[256 + i * 4 + c] ?? Number.NaN,
            6,
          );
          brightest = Math.max(brightest, value);
        }
        frameCalls.push(pixels[i * 4 + 3] ?? Number.NaN);
      }
      if (lightCount === 0) expect(brightest).toBe(0);
      else expect(brightest).toBeGreaterThan(0.05);
      calls.push(frameCalls);
    }
    expect(calls, 'Empty admitted-light frames must not perform cluster lookup').toEqual(
      [0, 1, 0].map((count) => Array.from({ length: 64 }, () => count)),
    );
  } finally {
    for (const value of buffers) value.destroy();
    for (const value of textures) value.destroy();
    device.destroy();
  }
});
