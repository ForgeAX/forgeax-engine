import { createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-webgpu';
import { expect } from 'vitest';
import { DeviceScope } from '../device/device-scope';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_MAP_READ } from '../gpu-usage';
import type { RenderFrameState } from '../record/frame-snapshot';
import {
  commitTemporalGpuSubmit,
  getTemporalBindGroupResources,
  getTemporalGpuState,
  getTemporalParamsBuffer,
  retireTemporalGpuState,
  stageTemporalGpuSubmit,
} from '../temporal/gpu';

export async function verifyTaaStabilityFeedback(
  source: string,
  scenario: 'feedback' | 'secondary-motion' | 'clipping-recovery' = 'feedback',
) {
  const secondaryMotion = scenario === 'secondary-motion';
  const clippingCycle = scenario === 'clipping-recovery';
  const frameCount = secondaryMotion || clippingCycle ? 658 : 528;
  const frameBytes = 768;
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const state = getTemporalGpuState(
    {} as RenderFrameState,
    device,
    DeviceScope.create(23, 'taa-feedback'),
    2,
    1,
  );
  const inputs = getTemporalBindGroupResources(state);
  if (inputs.sampler === null || inputs.temporalSampler === null)
    throw new Error('Missing TAA samplers');
  const params = getTemporalParamsBuffer(state);
  const module = createShaderModuleImmediate(device, { code: source }).unwrap();
  const empty = device.createBindGroupLayout({ entries: [] }).unwrap();
  const emptyGroup = device.createBindGroup({ layout: empty, entries: [] }).unwrap();
  const pipeline = device
    .createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [empty, inputs.layout] }).unwrap(),
      vertex: { module, entryPoint: 'vs_main', buffers: [] },
      fragment: {
        module,
        entryPoint: 'fs_main',
        targets: [{ format: 'rgba16float' }, { format: 'rgba16float' }, { format: 'r8unorm' }],
      },
      primitive: { topology: 'triangle-list' },
    })
    .unwrap();
  const current = Array.from({ length: 3 }, () => {
    const texture = device
      .createTexture({
        size: { width: 2, height: 1, depthOrArrayLayers: 1 },
        format: 'rgba16float',
        textureBindingViewDimension: '2d',
        usage: GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
      })
      .unwrap();
    return { texture, view: device.createTextureView(texture, {}).unwrap() };
  });
  const readback = device
    .createBuffer({
      size: frameBytes * frameCount,
      usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  try {
    const color = current[0];
    const temporal = current[1];
    const secondary = current[2];
    if (!color || !temporal || !secondary) throw new Error('Missing current inputs');
    device.queue
      .writeTexture(
        { texture: color.texture },
        new Uint16Array(Array(8).fill(0x3c00)),
        { bytesPerRow: 16, rowsPerImage: 1 },
        { width: 2, height: 1, depthOrArrayLayers: 1 },
      )
      .unwrap();
    const ages = [];
    const errors: number[] = [];
    let reference = 0;
    let previousActual = 0;
    let stepReference = 0;
    // Initial seed, eight stationary frames, motion, stop, reactive material,
    // then depth disocclusion. Values below are exact half-float encodings.
    const cycleTail: number[] = [];
    const earlyCycle: number[] = [];
    for (let frame = 0; frame < frameCount; frame++) {
      const reactive = secondaryMotion && frame === 528;
      const metadata = new Uint16Array([
        frame === 9 ? 0x3000 : 0,
        0,
        frame >= 14 ? 0x4400 : 0x4000,
        frame === 12 ? 0x3800 : 0,
      ]);
      if (frame >= 16) {
        // Complementary neighboring pixels keep the color bounds at [0, 1].
        // Only temporal feedback (not clipping or input quantization) changes
        // the analytic Karis recurrence. All input values are exact in FP16.
        const value = clippingCycle ? (frame >= 528 ? 0 : Number(frame % 8 !== 2)) : frame % 2;
        const neighbor = clippingCycle ? value : 1 - value;
        if (frame === 16) state.valid = false;
        device.queue
          .writeTexture(
            { texture: color.texture },
            new Uint16Array([
              value * 0x3c00,
              value * 0x3c00,
              value * 0x3c00,
              0x3c00,
              neighbor * 0x3c00,
              neighbor * 0x3c00,
              neighbor * 0x3c00,
              0x3c00,
            ]),
            { bytesPerRow: 16, rowsPerImage: 1 },
            { width: 2, height: 1, depthOrArrayLayers: 1 },
          )
          .unwrap();
      }
      device.queue
        .writeTexture(
          { texture: temporal.texture },
          new Uint16Array([...metadata, ...metadata]),
          { bytesPerRow: 16, rowsPerImage: 1 },
          { width: 2, height: 1, depthOrArrayLayers: 1 },
        )
        .unwrap();
      device.queue
        .writeTexture(
          { texture: secondary.texture },
          new Uint16Array([reactive ? 0x3c00 : 0, 0, 0, 0, reactive ? 0x3c00 : 0, 0, 0, 0]),
          { bytesPerRow: 16, rowsPerImage: 1 },
          { width: 2, height: 1, depthOrArrayLayers: 1 },
        )
        .unwrap();
      device.queue
        .writeBuffer(
          params,
          0,
          new Uint32Array([0, 0, Number(state.valid), frame, Number(secondaryMotion), 0, 0, 0]),
        )
        .unwrap();
      const index = state.readIndex;
      const group = device
        .createBindGroup({
          layout: inputs.layout,
          entries: [
            { binding: 0, resource: { kind: 'textureView', value: color.view } },
            { binding: 1, resource: { kind: 'sampler', value: inputs.sampler } },
            { binding: 2, resource: { kind: 'textureView', value: state.color[index].view } },
            { binding: 3, resource: { kind: 'sampler', value: inputs.sampler } },
            { binding: 4, resource: { kind: 'textureView', value: state.temporal[index].view } },
            { binding: 5, resource: { kind: 'sampler', value: inputs.temporalSampler } },
            { binding: 6, resource: { kind: 'textureView', value: temporal.view } },
            { binding: 7, resource: { kind: 'sampler', value: inputs.temporalSampler } },
            { binding: 8, resource: { kind: 'buffer', value: { buffer: params } } },
            { binding: 9, resource: { kind: 'textureView', value: state.stability[index].view } },
            { binding: 10, resource: { kind: 'textureView', value: secondary.view } },
            { binding: 11, resource: { kind: 'textureView', value: temporal.view } },
          ],
        })
        .unwrap();
      stageTemporalGpuSubmit(state);
      const next = state.pendingIndex;
      if (next === undefined) throw new Error('Missing staged history write');
      const encoder = device.createCommandEncoder().unwrap();
      const targets = [state.color[next], state.temporal[next], state.stability[next]];
      const pass = encoder.beginRenderPass({
        colorAttachments: targets.map(({ view }) => ({
          view,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        })),
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, emptyGroup);
      pass.setBindGroup(1, group);
      pass.draw(3, 1, 0, 0);
      pass.end();
      for (const [slot, surface] of targets.entries())
        encoder.copyTextureToBuffer(
          { texture: surface.texture },
          {
            buffer: readback,
            offset: frame * frameBytes + slot * 256,
            bytesPerRow: 256,
            rowsPerImage: 1,
          },
          { width: 1, height: 1, depthOrArrayLayers: 1 },
        );
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      expect(commitTemporalGpuSubmit(state)).toBe(true);
    }
    // Preserve every submitted frame and its three outputs, but synchronize
    // with the GPU once. No input depends on CPU readback; the analytic oracle
    // can consume the complete ordered history after the queue finishes.
    const mapped = (await readback.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap();
    const history = mapped.getMappedRange().unwrap().slice(0);
    mapped.unmap();
    for (let frame = 0; frame < frameCount; frame++) {
      const reactive = secondaryMotion && frame === 528;
      const metadata = [
        frame === 9 ? 0x3000 : 0,
        0,
        frame >= 14 ? 0x4400 : 0x4000,
        frame === 12 ? 0x3800 : 0,
      ];
      const bytes = history.slice(frame * frameBytes, (frame + 1) * frameBytes);
      if (frame >= 16) {
        const value = clippingCycle ? (frame >= 528 ? 0 : Number(frame % 8 !== 2)) : frame % 2;
        const settled = Math.max(0, Math.min(1, (frame - 16 - 64) / 64));
        const steadyWeight = 0.95 + 0.04 * settled * settled * (3 - 2 * settled);
        const weight = Math.min(steadyWeight, frame / (frame + 1));
        const a = (1 - weight) / (1 + value);
        const b = weight / (1 + reference);
        reference = frame === 16 ? value : (value * a + reference * b) / (a + b);
        const previousWeight = weight / (1 + previousActual);
        stepReference =
          frame === 16
            ? value
            : (value * a + previousActual * previousWeight) / (a + previousWeight);
      }
      const result = new Uint16Array(bytes, 0, 4);
      if (frame >= 16 && frame < 528 && !clippingCycle) {
        const half = result[0];
        if (half === undefined) throw new Error('Missing TAA color readback');
        const actual =
          half < 1024 ? half * 2 ** -24 : (1 + (half & 1023) / 1024) * 2 ** ((half >>> 10) - 15);
        // Stochastic FP16 rounding feeds its error into later frames, so a
        // per-frame formula check must start with the actual stored history.
        // Only the two adjacent FP16 values are legal (plus FP32 arithmetic
        // tolerance). The independent infinite-precision tail below still
        // detects accumulated bias; it is not reset to the GPU result.
        const spacing = 2 ** Math.max(-24, Math.floor(Math.log2(stepReference)) - 10);
        const lower = Math.floor(stepReference / spacing) * spacing;
        const upper = Math.ceil(stepReference / spacing) * spacing;
        const message = `TAA must follow delayed accumulation: frame=${frame}, actual=${actual}, expected=${stepReference}`;
        expect(actual, message).toBeGreaterThanOrEqual(lower - 0.000001);
        expect(actual, message).toBeLessThanOrEqual(upper + 0.000001);
        previousActual = actual;
      }
      if (frame < 16) {
        expect([...result]).toEqual([0x3c00, 0x3c00, 0x3c00, 0x3c00]);
        ages.push(new Uint8Array(bytes)[512]);
      } else if (frame >= 464 && frame < 528 && !clippingCycle) {
        const half = result[0];
        if (half === undefined) throw new Error('Missing TAA color readback');
        // The expected steady values are normal, positive half floats.
        expect(half >>> 10).toBeGreaterThan(0);
        expect(half >>> 10).toBeLessThan(31);
        const actual = (1 + (half & 1023) / 1024) * 2 ** ((half >>> 10) - 15);
        errors.push(actual - reference);
        expect(result[1]).toBe(half);
        expect(result[2]).toBe(half);
        expect(result[3]).toBe(0x3c00);
      }
      if (clippingCycle && frame >= 120 && frame < 128) {
        const half = result[0];
        if (half === undefined) throw new Error('Missing early clipping-cycle color');
        earlyCycle.push(
          half < 1024 ? half * 2 ** -24 : (1 + (half & 1023) / 1024) * 2 ** ((half >>> 10) - 15),
        );
        if (frame === 127)
          expect(
            Math.abs(earlyCycle.reduce((sum, value) => sum + value, 0) / earlyCycle.length - 7 / 9),
            'coverage must converge before increasing the stationary history weight',
          ).toBeLessThan(0.03);
      }
      if (clippingCycle && frame >= 464) {
        expect(
          new Uint8Array(bytes)[512],
          'color clipping must not discard the accepted stationary reconstruction footprint',
        ).toBeGreaterThanOrEqual(128);
        const half = result[0];
        if (half === undefined) throw new Error('Missing clipping-cycle color');
        const actual =
          half < 1024 ? half * 2 ** -24 : (1 + (half & 1023) / 1024) * 2 ** ((half >>> 10) - 15);
        if (frame < 528) cycleTail.push(actual);
        if (frame === 527)
          expect(
            Math.max(...cycleTail) - Math.min(...cycleTail),
            'phase-local clipping must not repeatedly erase settled history',
          ).toBeLessThan(0.03);
        if (frame >= 536)
          expect(
            actual,
            'persistent unmarked color change must recover within one jitter cycle',
          ).toBeLessThan(0.01);
      }
      if (frame >= 528 && !clippingCycle) {
        if (reactive) {
          expect(
            [...result],
            'secondary motion must reject old radiance on a stationary receiver',
          ).toEqual([0, 0, 0, 0x3c00]);
        }
        if (frame === 529) {
          const half = result[0];
          if (half === undefined) throw new Error('Missing post-motion color');
          const actual = (1 + (half & 1023) / 1024) * 2 ** ((half >>> 10) - 15);
          // A fresh white sample after reactive black must use fast 0.95
          // feedback, not the previously settled 0.99 history weight.
          expect(actual).toBeCloseTo(0.025 / 0.975, 4);
        }
        const expectedAge = Math.min(frame - 528, 128);
        expect(
          new Uint8Array(bytes)[512],
          'secondary motion restarts the complete settling cycle',
        ).toBe(expectedAge);
      }
      const expectedMetadata = [...metadata];
      if (reactive) expectedMetadata[3] = 0x3c00;
      expect([...new Uint16Array(bytes, 256, 4)]).toEqual(expectedMetadata);
    }
    expect(ages).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 0, 0, 1, 0, 1, 0, 1]);
    if (clippingCycle) {
      expect(cycleTail).toHaveLength(64);
      expect(
        Math.max(...cycleTail) - Math.min(...cycleTail),
        'phase-local clipping must not repeatedly erase settled history',
      ).toBeLessThan(0.03);
      expect(cycleTail.reduce((a, b) => a + b, 0) / cycleTail.length).toBeCloseTo(7 / 9, 2);
      return;
    }
    expect(errors).toHaveLength(64);
    expect(Math.abs(errors.reduce((sum, error) => sum + error, 0) / errors.length)).toBeLessThan(
      0.0005,
    );
    expect(Math.max(...errors.map(Math.abs))).toBeLessThan(0.001);
  } finally {
    device.destroyBuffer(readback).unwrap();
    for (const { texture } of current) device.destroyTexture(texture).unwrap();
    retireTemporalGpuState(state);
  }
}
