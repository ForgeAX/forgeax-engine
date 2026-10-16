import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { DeviceScope } from '../device/device-scope';
import { GPU_SHADER_STAGE_COMPUTE } from '../gpu-stage';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_COPY_SRC,
  GPU_BUFFER_USAGE_MAP_READ,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';
import type { RenderFrameState } from '../record/frame-snapshot';
import {
  getTemporalBindGroupResources,
  getTemporalGpuState,
  retireTemporalGpuState,
} from '../temporal/gpu';

it('preserves an in-neighborhood chromatic history instead of forcing each jitter sample color', async () => {
  // Execute the production helper on the GPU. A red/blue subpixel edge can
  // legitimately accumulate purple; clipping must preserve that history.
  const source = readFileSync(
    resolve(process.cwd(), 'packages/shader/src/taa-resolve.wgsl'),
    'utf8',
  ).replace(/^#define_import_path.*$/gm, '');
  const ssr = readFileSync(resolve(process.cwd(), 'packages/shader/src/ssr-temporal.wgsl'), 'utf8');
  const start = ssr.indexOf('fn ssrLatticeCoordinate(');
  expect(start).toBeGreaterThanOrEqual(0);
  const historyCoordinateFunction = ssr.slice(start, ssr.indexOf('\n}', start) + 2);
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const state = getTemporalGpuState(
    {} as RenderFrameState,
    device,
    DeviceScope.create(21, 'taa-sampling-probe'),
    2,
    1,
  );
  const sampler = getTemporalBindGroupResources(state).sampler;
  if (sampler === null) throw new Error('Missing production TAA color sampler');
  const texture = device
    .createTexture({
      size: { width: 2, height: 1, depthOrArrayLayers: 1 },
      textureBindingViewDimension: '2d',
      // TAA filters HDR color. UNORM8 introduces format-dependent sample
      // quantization and does not exercise the production input contract.
      format: 'rgba16float',
      usage: GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    .unwrap();
  const view = device.createTextureView(texture, {}).unwrap();
  const diagonal = device
    .createTexture({
      size: { width: 3, height: 3, depthOrArrayLayers: 1 },
      textureBindingViewDimension: '2d',
      format: 'rgba8unorm',
      usage: GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    .unwrap();
  const diagonalView = device.createTextureView(diagonal, {}).unwrap();
  const footprint = device
    .createTexture({
      size: { width: 7, height: 7, depthOrArrayLayers: 1 },
      textureBindingViewDimension: '2d',
      format: 'rgba8unorm',
      usage: GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    .unwrap();
  const footprintView = device.createTextureView(footprint, {}).unwrap();
  const footprintPixels = new Uint8Array(7 * 7 * 4);
  footprintPixels.set([255, 255, 255, 255], (3 * 7 + 5) * 4);
  device.queue
    .writeTexture(
      { texture: footprint },
      footprintPixels,
      { bytesPerRow: 28, rowsPerImage: 7 },
      { width: 7, height: 7, depthOrArrayLayers: 1 },
    )
    .unwrap();
  const temporalTexture = device
    .createTexture({
      size: { width: 3, height: 3, depthOrArrayLayers: 1 },
      format: 'rgba32float',
      textureBindingViewDimension: '2d',
      usage: GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    .unwrap();
  const temporalView = device.createTextureView(temporalTexture, {}).unwrap();
  const temporalPixels = new Float32Array(36);
  for (let p = 0; p < 9; p++) temporalPixels.set([0, 0, -1, 1], p * 4);
  temporalPixels.set([0.125, 0.25, 4, 0], 0);
  temporalPixels.set([0.25, 0.5, 2, 0], 8 * 4);
  device.queue
    .writeTexture(
      { texture: temporalTexture, mipLevel: 0, origin: [0, 0, 0] },
      temporalPixels,
      { offset: 0, bytesPerRow: 48, rowsPerImage: 3 },
      { width: 3, height: 3, depthOrArrayLayers: 1 },
    )
    .unwrap();
  const diagonalPixels = new Uint8Array(36);
  for (let p = 0; p < 9; p++) {
    const value = [0, 2, 6, 8].includes(p) ? 255 : 0;
    diagonalPixels.set([value, value, value, 255], p * 4);
  }
  device.queue
    .writeTexture(
      { texture: diagonal, mipLevel: 0, origin: [0, 0, 0] },
      diagonalPixels,
      { offset: 0, bytesPerRow: 12, rowsPerImage: 3 },
      { width: 3, height: 3, depthOrArrayLayers: 1 },
    )
    .unwrap();
  device.queue
    .writeTexture(
      { texture, mipLevel: 0, origin: [0, 0, 0] },
      new Uint16Array([0x3c00, 0, 0, 0x3c00, 0, 0, 0x3c00, 0x3c00]),
      { offset: 0, bytesPerRow: 16, rowsPerImage: 1 },
      { width: 2, height: 1, depthOrArrayLayers: 1 },
    )
    .unwrap();
  const module = createShaderModuleImmediate(device, {
    code: `${source}
${historyCoordinateFunction}
@group(0) @binding(0) var<storage, read_write> result: array<vec4<f32>>;
@group(0) @binding(1) var edgeColor: texture_2d<f32>;
@group(0) @binding(2) var colorSampler: sampler;
fn probeClip(current : vec3<f32>, neighbors : array<vec3<f32>, 8>, history : vec3<f32>) -> vec3<f32> {
  var bounds = TaaBounds(rgbToYCoCg(current), rgbToYCoCg(current));
  for (var i = 0u; i < 8u; i++) {
    let sample = rgbToYCoCg(neighbors[i]);
    bounds.minimum = min(bounds.minimum, sample);
    bounds.maximum = max(bounds.maximum, sample);
  }
  return clipTaaHistory(bounds, history);
}
@compute @workgroup_size(1) fn probe() {
  let red = vec3<f32>(1.0, 0.0, 0.0);
  let blue = vec3<f32>(0.0, 0.0, 1.0);
  let history = vec3<f32>(0.75, 0.0, 0.25);
  result[0] = vec4<f32>(probeClip(red, array<vec3<f32>, 8>(red, blue, red, blue, red, blue, red, blue), history), 1.0);
  result[1] = vec4<f32>(probeClip(blue, array<vec3<f32>, 8>(blue, red, blue, red, blue, red, blue, red), history), 1.0);
  result[2] = vec4<f32>(probeClip(red, array<vec3<f32>, 8>(red, red, red, red, red, red, red, red), blue), 1.0);
  result[3] = vec4<f32>(probeClip(red * 4.0, array<vec3<f32>, 8>(red * 4.0, blue * 4.0, red * 4.0, blue * 4.0, red * 4.0, blue * 4.0, red * 4.0, blue * 4.0), history * 4.0), 1.0);
  // A quarter-texel cancellation must not be rounded to a whole pixel.
  result[4] = textureSampleLevel(edgeColor, colorSampler, vec2<f32>(0.375, 0.5), 0.0);
  // The fixed SSR history lattice retains the fractional reconstruction
  // coordinate; nearest rounding would discard the subpixel ray position.
  result[5] = vec4<f32>(ssrLatticeCoordinate(vec2<f32>(19.6875 / 64.0), vec2<u32>(64)), ssrLatticeCoordinate(vec2<f32>(22.5 / 64.0), vec2<u32>(64)));
  result[6] = vec4<f32>(clipTaaHistory(taaNeighborhood(vec2<f32>(0.5), vec3<f32>(0.0), false), vec3<f32>(0.25)), 1.0);
  result[7] = vec4<f32>(taaAccumulationWeight(0u, 0.875), taaAccumulationWeight(1u, 0.875), taaAccumulationWeight(3u, 0.875), taaAccumulationWeight(64u, 0.875));
  // Coverage gaps must inherit the nearest valid surface's complete motion
  // tuple, never the clear sentinel or an average of unrelated depths.
  result[8] = closestCurrentTemporal(vec2<i32>(1), vec2<i32>(3)).temporal;
  result[9] = closestCurrentTemporal(vec2<i32>(0), vec2<i32>(3)).temporal;
  result[10] = vec4<f32>(
    blendTaaHistory(vec3<f32>(4.0), vec3<f32>(0.0), 0.95).r,
    blendTaaHistory(vec3<f32>(0.0), vec3<f32>(4.0), 0.95).r,
    blendTaaHistory(vec3<f32>(2.0), vec3<f32>(2.0), 0.95).r,
    blendTaaHistory(vec3<f32>(0.0), vec3<f32>(0.0), 0.95).r);
  result[11] = vec4<f32>(blendTaaHistory(vec3<f32>(20.0, 0.0, 0.0), vec3<f32>(0.0, 5.0, 0.0), 0.9), 1.0);
  result[12] = vec4<f32>(taaStableAge(0.0, true, vec4<f32>(0.0), vec2<f32>(0.0)),
    taaStableAge(112.0 / 255.0, true, vec4<f32>(0.0), vec2<f32>(0.0)),
    taaStableAge(1.0, false, vec4<f32>(0.0), vec2<f32>(0.0)),
    taaStableAge(1.0, true, vec4<f32>(0.1, 0.0, 0.0, 0.0), vec2<f32>(0.0)));
  result[13] = vec4<f32>(taaStableAge(1.0, true, vec4<f32>(0.0, 0.0, 0.0, 0.5), vec2<f32>(0.0)),
    taaStableAge(1.0, true, vec4<f32>(0.0), vec2<f32>(0.1, 0.0)),
    taaStableAge(1.0, true, vec4<f32>(0.0), vec2<f32>(0.0)), 0.0);
}
@compute @workgroup_size(1) fn probe_footprint() {
  // One bright sample two texels to the right is part of the settled support,
  // but not the motion footprint. Crossing the jitter sign must not remove it.
  let negative = vec2<f32>(3.25 / 7.0, 0.5);
  let positive = vec2<f32>(3.75 / 7.0, 0.5);
  result[0] = vec4<f32>(clipTaaHistory(taaNeighborhood(negative, vec3<f32>(0.0), true), vec3<f32>(0.5)), 1.0);
  result[1] = vec4<f32>(clipTaaHistory(taaNeighborhood(positive, vec3<f32>(0.0), true), vec3<f32>(0.5)), 1.0);
  result[2] = vec4<f32>(clipTaaHistory(taaNeighborhood(negative, vec3<f32>(0.0), false), vec3<f32>(0.5)), 1.0);
  result[3] = vec4<f32>(clipTaaHistory(taaNeighborhood(positive, vec3<f32>(0.0), false), vec3<f32>(0.5)), 1.0);
}`,
  }).unwrap();
  const groupLayout = device
    .createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPU_SHADER_STAGE_COMPUTE, buffer: { type: 'storage' } },
        {
          binding: 1,
          visibility: GPU_SHADER_STAGE_COMPUTE,
          texture: { sampleType: 'float', viewDimension: '2d' },
        },
        { binding: 2, visibility: GPU_SHADER_STAGE_COMPUTE, sampler: { type: 'filtering' } },
      ],
    })
    .unwrap();
  const temporalParams = device
    .createBuffer({ size: 32, usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST })
    .unwrap();
  device.queue.writeBuffer(temporalParams, 0, new Uint8Array(32)).unwrap();
  const neighborhoodLayout = device
    .createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPU_SHADER_STAGE_COMPUTE,
          texture: { sampleType: 'float', viewDimension: '2d' },
        },
        { binding: 1, visibility: GPU_SHADER_STAGE_COMPUTE, sampler: { type: 'filtering' } },
        {
          binding: 6,
          visibility: GPU_SHADER_STAGE_COMPUTE,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
        },
        { binding: 8, visibility: GPU_SHADER_STAGE_COMPUTE, buffer: { type: 'uniform' } },
        {
          binding: 11,
          visibility: GPU_SHADER_STAGE_COMPUTE,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
        },
      ],
    })
    .unwrap();
  const neighborhoodGroup = device
    .createBindGroup({
      layout: neighborhoodLayout,
      entries: [
        { binding: 0, resource: { kind: 'textureView', value: diagonalView } },
        { binding: 1, resource: { kind: 'sampler', value: sampler } },
        { binding: 6, resource: { kind: 'textureView', value: temporalView } },
        { binding: 8, resource: { kind: 'buffer', value: { buffer: temporalParams } } },
        { binding: 11, resource: { kind: 'textureView', value: temporalView } },
      ],
    })
    .unwrap();
  const layout = device
    .createPipelineLayout({ bindGroupLayouts: [groupLayout, neighborhoodLayout] })
    .unwrap();
  const pipeline = device
    .createComputePipeline({ layout, compute: { module, entryPoint: 'probe' } })
    .unwrap();
  const output = device
    .createBuffer({ size: 224, usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_SRC })
    .unwrap();
  const readback = device
    .createBuffer({ size: 224, usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST })
    .unwrap();
  try {
    const group = device
      .createBindGroup({
        layout: groupLayout,
        entries: [
          { binding: 0, resource: { kind: 'buffer', value: { buffer: output } } },
          { binding: 1, resource: { kind: 'textureView', value: view } },
          { binding: 2, resource: { kind: 'sampler', value: sampler } },
        ],
      })
      .unwrap();
    const encoder = device.createCommandEncoder().unwrap();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.setBindGroup(1, neighborhoodGroup);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 224);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const mapped = (await readback.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap();
    const pixels = [...new Float32Array(mapped.getMappedRange().unwrap().slice(0))];
    mapped.unmap();
    expect(pixels.slice(0, 40)).toEqual([
      0.75, 0, 0.25, 1, 0.75, 0, 0.25, 1, 1, 0, 0, 1, 3, 0, 1, 1, 0.75, 0, 0.25, 1, 9.59375,
      9.59375, 11, 11, 0.25, 0.25, 0.25, 1, 0, 0.5, 0.75, 0.875, 0.25, 0.5, 2, 0, 0.125, 0.25, 4, 0,
    ]);
    expect(pixels[40]).toBeCloseTo(1 / 24, 5);
    expect(pixels[41]).toBeCloseTo(19 / 6, 5);
    expect(pixels[42]).toBeCloseTo(2, 5);
    expect(pixels[43]).toBe(0);
    expect(pixels.slice(48, 56)).toEqual([1, 113, 0, 0, 0, 0, 128, 0]);
    // Independent compress -> accumulate -> inverse oracle for Karis' linear
    // luminance operator. Saturated HDR inputs also catch per-channel curves
    // and the extra max-RGB compression in the former weight calculation.
    const luma = (v: readonly number[]) =>
      (v[0] ?? 0) * 0.2126 + (v[1] ?? 0) * 0.7152 + (v[2] ?? 0) * 0.0722;
    const compress = (v: readonly number[]) => v.map((c) => c / (1 + luma(v)));
    const a = compress([20, 0, 0]),
      b = compress([0, 5, 0]);
    const blended = a.map((c, i) => c * 0.1 + (b[i] ?? 0) * 0.9);
    const expected = blended.map((c) => c / (1 - luma(blended)));
    expected.forEach((value, i) => {
      expect(pixels[44 + i]).toBeCloseTo(value, 5);
    });
    const footprintGroup = device
      .createBindGroup({
        layout: neighborhoodLayout,
        entries: [
          { binding: 0, resource: { kind: 'textureView', value: footprintView } },
          { binding: 1, resource: { kind: 'sampler', value: sampler } },
          { binding: 6, resource: { kind: 'textureView', value: temporalView } },
          { binding: 8, resource: { kind: 'buffer', value: { buffer: temporalParams } } },
          { binding: 11, resource: { kind: 'textureView', value: temporalView } },
        ],
      })
      .unwrap();
    const footprintPipeline = device
      .createComputePipeline({
        layout,
        compute: { module, entryPoint: 'probe_footprint' },
      })
      .unwrap();
    const footprintEncoder = device.createCommandEncoder().unwrap();
    const footprintPass = footprintEncoder.beginComputePass();
    footprintPass.setPipeline(footprintPipeline);
    footprintPass.setBindGroup(0, group);
    footprintPass.setBindGroup(1, footprintGroup);
    footprintPass.dispatchWorkgroups(1);
    footprintPass.end();
    footprintEncoder.copyBufferToBuffer(output, 0, readback, 0, 64);
    device.queue.submit([footprintEncoder.finish().unwrap()]).unwrap();
    const footprintMapping = (await readback.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap();
    const footprintValues = [
      ...new Float32Array(footprintMapping.getMappedRange().unwrap().slice(0, 64)),
    ];
    footprintMapping.unmap();
    expect(
      footprintValues.slice(0, 8),
      'settled clipping support is invariant under jitter sign',
    ).toEqual([0.5, 0.5, 0.5, 1, 0.5, 0.5, 0.5, 1]);
    expect(footprintValues.slice(8), 'motion must not borrow the distant bright texel').toEqual([
      0, 0, 0, 1, 0, 0, 0, 1,
    ]);
  } finally {
    device.destroyBuffer(output).unwrap();
    device.destroyBuffer(readback).unwrap();
    device.destroyBuffer(temporalParams).unwrap();
    device.destroyTexture(texture).unwrap();
    device.destroyTexture(diagonal).unwrap();
    device.destroyTexture(footprint).unwrap();
    device.destroyTexture(temporalTexture).unwrap();
    retireTemporalGpuState(state);
  }
});
