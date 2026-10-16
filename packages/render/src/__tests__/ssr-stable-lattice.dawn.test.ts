import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { GPU_SHADER_STAGE_COMPUTE } from '../gpu-stage';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_STORAGE_BINDING,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_MAP_READ,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import { temporalJitterSample } from '../temporal/temporal-view';
import { gbufferSource, writePackedNormals } from './standard-gbuffer.fixture';

it.for([
  'production',
  'orthographic',
  'presentation-feedback',
  'ignored-hit-reactivity',
  'ignored-vertical-neighbor',
  'ignored-confidence-loss',
  'forgotten-source-history',
  'spurious-confidence-mask',
  'resolved-mask-feedback',
] as const)('checks stable history and reactive source through real GPU feedback (%s)', async (variant, {
  annotate,
}) => {
  const presentationFeedback = variant === 'presentation-feedback';
  const orthographic = variant === 'orthographic';
  const compiler = await import(
    /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
  );
  let source = readFileSync(resolve('packages/shader/src/ssr-temporal.wgsl'), 'utf8');
  if (variant === 'resolved-mask-feedback') {
    const flag = 'let sourceReactivity = f32(packedNormalSource & 1u);';
    expect(source).toContain(flag);
    source = source.replace(flag, 'let sourceReactivity = finiteUnit(surface.r);');
  }
  if (variant === 'spurious-confidence-mask') {
    const response = 'sourceReactivity, current.color.a <= 0.0, current.reactivity > 0.0';
    expect(source).toContain(response);
    source = source.replace(
      response,
      'max(sourceReactivity, finiteUnit(history.color.a - resolved.a)), current.color.a <= 0.0, current.reactivity > 0.0',
    );
  }
  if (variant === 'ignored-vertical-neighbor') {
    const start = source.indexOf('fn sampleCurrentSsr(');
    const end = source.indexOf('// Reflection-only mip reduction', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const footprint = source.slice(start, end);
    expect(footprint).toContain('vec2<i32>(0, 1)');
    expect(footprint).toContain('vec2<i32>(1, 1)');
    source =
      source.slice(0, start) +
      footprint
        .replace('vec2<i32>(0, 1)', 'vec2<i32>(0, 0)')
        .replace('vec2<i32>(1, 1)', 'vec2<i32>(1, 0)') +
      source.slice(end);
  }
  if (variant === 'forgotten-source-history') {
    const firstMiss = 'current.color.a <= 0.0 && !history.missing';
    expect(source).toContain(firstMiss);
    source = source.replace(firstMiss, 'false');
  }
  if (variant === 'ignored-confidence-loss') {
    expect(source).toContain('min(requestedWeight, historyLimit)');
    source = source.replace('min(requestedWeight, historyLimit)', 'min(requestedWeight, 0.9)');
  }
  if (variant === 'ignored-hit-reactivity') {
    const merged = 'max(temporal.w, sourceReactivity)';
    expect(source).toContain(merged);
    source = source.replace(merged, 'temporal.w');
  }
  if (presentationFeedback) {
    const fixedSample = 'let history = resolveSsrAt(uv, fullSize);';
    expect(source).toContain(fixedSample);
    // Negative control: feed the reconstructed raster position back into
    // fixed history. Repeated subpixel filtering must fail the detail gate.
    source = source.replace(
      fixedSample,
      'let history = resolveSsrAt(uv - params.currentJitterUv, fullSize);',
    );
  }
  const compiled = await compiler.compileShader(source, {
    id: 'forgeax_ssr::temporal',
    imports: {
      'forgeax_view::common': readFileSync(resolve('packages/shader/src/common.wgsl'), 'utf8'),
      'forgeax_pbr::gbuffer': gbufferSource,
    },
  });
  if (!compiled.ok) throw compiled.error;
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const width = 32,
    height = 8,
    fullWidth = width * 2,
    fullHeight = height * 2;
  const sampled = GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING;
  const historyUsage = sampled | GPU_TEXTURE_USAGE_STORAGE_BINDING | GPU_TEXTURE_USAGE_COPY_SRC;
  const texture = (
    w: number,
    h: number,
    format: 'rgba16float' | 'rgba32float' | 'rgba8unorm' | 'r32uint' | 'depth32float' | 'r32float',
    usage: number,
  ) => {
    const texture = device
      .createTexture({
        size: { width: w, height: h, depthOrArrayLayers: 1 },
        format,
        textureBindingViewDimension: '2d',
        usage,
      })
      .unwrap();
    return { texture, view: device.createTextureView(texture, {}).unwrap() };
  };
  const trace = texture(width, height, 'rgba32float', sampled);
  const hitReactivity = texture(width, height, 'r32float', sampled);
  const normal = texture(
    fullWidth,
    fullHeight,
    'r32uint',
    sampled | GPU_TEXTURE_USAGE_STORAGE_BINDING,
  );
  const temporal = texture(fullWidth, fullHeight, 'rgba32float', sampled);
  const depth = texture(
    fullWidth,
    fullHeight,
    'depth32float',
    GPU_TEXTURE_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
  );
  const history = [
    texture(width, height, 'rgba16float', historyUsage),
    texture(width, height, 'rgba16float', historyUsage),
  ] as const;
  const surfaces = [
    texture(width, height, 'rgba8unorm', historyUsage),
    texture(width, height, 'rgba8unorm', historyUsage),
  ] as const;
  const resolved = texture(width, height, 'rgba16float', historyUsage);
  const params = device
    .createBuffer({ size: 32, usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST })
    .unwrap();
  const view = device
    .createBuffer({
      size: VIEW_UNIFORM_BYTES,
      usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  const readback = device
    .createBuffer({
      size: width * height * 8,
      usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  try {
    device.queue
      .writeTexture(
        { texture: hitReactivity.texture },
        new Float32Array(width * height),
        { bytesPerRow: width * 4, rowsPerImage: height },
        { width, height, depthOrArrayLayers: 1 },
      )
      .unwrap();
    const upload = (target: typeof trace, w: number, h: number, values: Float32Array) =>
      device.queue
        .writeTexture(
          { texture: target.texture },
          values,
          { bytesPerRow: w * 16, rowsPerImage: h },
          { width: w, height: h, depthOrArrayLayers: 1 },
        )
        .unwrap();
    writePackedNormals(
      device,
      normal.texture,
      fullWidth,
      fullHeight,
      new Float32Array(
        Array.from({ length: fullWidth * fullHeight }, () => [0.5, 0.5, 1, 0.1]).flat(),
      ),
    );
    upload(temporal, fullWidth, fullHeight, new Float32Array(fullWidth * fullHeight * 4));
    const payload = new Float32Array(VIEW_UNIFORM_BYTES / 4);
    for (const base of [44, 212]) for (let i = 0; i < 4; i++) payload[base + i * 5] = 1;
    if (orthographic) {
      // A coherent reverse-Z orthographic pair maps view depth 4 to 2/3.
      // Clip W stays 1; it cannot stand in for the receiver's view distance.
      payload[54] = -9;
      payload[58] = 10;
      payload[222] = -1 / 9;
      payload[226] = 10 / 9;
      payload[227] = 1;
    } else {
      payload[227] = 4; // Perspective clip W is the planar view distance.
    }
    payload.set([1, 10, orthographic ? 1 : 0, 0], 228);
    device.queue.writeBuffer(view, 0, payload).unwrap();
    const seed = createShaderModuleImmediate(device, {
      code: `
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4<f32>{
 let p=array<vec2<f32>,3>(vec2<f32>(-1.0),vec2<f32>(3.0,-1.0),vec2<f32>(-1.0,3.0));return vec4<f32>(p[i],0.0,1.0);
}
@fragment fn fs()->@builtin(frag_depth) f32{return ${orthographic ? '(10.0-4.0)/9.0' : '(10.0/4.0-1.0)/9.0'};}`,
    }).unwrap();
    const seedPipeline = device
      .createRenderPipeline({
        layout: 'auto',
        vertex: { module: seed, entryPoint: 'vs', buffers: [] },
        fragment: { module: seed, entryPoint: 'fs', targets: [] },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
      })
      .unwrap();
    const seedEncoder = device.createCommandEncoder().unwrap();
    const seedPass = seedEncoder.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: depth.view,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        depthClearValue: 0,
      },
    });
    seedPass.setPipeline(seedPipeline);
    seedPass.draw(3);
    seedPass.end();
    device.queue.submit([seedEncoder.finish().unwrap()]).unwrap();
    const layout = device
      .createBindGroupLayout({
        entries: [
          ...[0, 1, 2, 3, 4, 9, 11].map((binding) => ({
            binding,
            visibility: GPU_SHADER_STAGE_COMPUTE,
            texture: {
              sampleType:
                binding === 2
                  ? ('uint' as const)
                  : binding === 1
                    ? ('depth' as const)
                    : ('unfilterable-float' as const),
              viewDimension: '2d' as const,
            },
          })),
          ...[5, 7, 10].map((binding) => ({
            binding,
            visibility: GPU_SHADER_STAGE_COMPUTE,
            storageTexture: {
              access: 'write-only' as const,
              format: binding === 10 ? ('rgba8unorm' as const) : ('rgba16float' as const),
              viewDimension: '2d' as const,
            },
          })),
          ...[6, 8].map((binding) => ({
            binding,
            visibility: GPU_SHADER_STAGE_COMPUTE,
            buffer: { type: 'uniform' as const },
          })),
        ],
      })
      .unwrap();
    const module = createShaderModuleImmediate(device, { code: compiled.value.wgsl }).unwrap();
    const pipeline = device
      .createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
        compute: { module, entryPoint: 'ssr_temporal' },
      })
      .unwrap();
    const createGroup = (i: 0 | 1) =>
      device
        .createBindGroup({
          layout,
          entries: [
            ...[
              [0, trace.view],
              [1, depth.view],
              [2, normal.view],
              [3, history[i].view],
              [4, temporal.view],
              [5, history[i === 0 ? 1 : 0].view],
              [7, resolved.view],
              [9, surfaces[i].view],
              [10, surfaces[i === 0 ? 1 : 0].view],
              [11, hitReactivity.view],
            ].map(([binding, value]) => ({
              binding: binding as number,
              resource: { kind: 'textureView' as const, value: value as typeof trace.view },
            })),
            { binding: 6, resource: { kind: 'buffer', value: { buffer: params } } },
            { binding: 8, resource: { kind: 'buffer', value: { buffer: view } } },
          ],
        })
        .unwrap();
    const groups = [createGroup(0), createGroup(1)] as const;
    const field = (x: number) => 1 + 0.8 * Math.sin((x * Math.PI) / 4);
    const reference = Array.from(
      { length: width },
      (_, x) =>
        Array.from({ length: 8 }, (_, phase) => {
          const jitter = temporalJitterSample(phase)[0] / 2;
          const p = x + jitter,
            first = Math.floor(p),
            f = p - first;
          return field(first - jitter) * (1 - f) + field(first + 1 - jitter) * f;
        }).reduce((a, b) => a + b, 0) / 8,
    );
    // An independent vertical signal exercises all four footprint corners;
    // a horizontal stripe alone cannot reveal duplicated/missing bottom taps.
    const verticalField = (y: number) => 0.5 + 0.35 * Math.sin((y * Math.PI) / 4);
    const verticalReference = Array.from(
      { length: height },
      (_, y) =>
        Array.from({ length: 8 }, (_, phase) => {
          const jitter = temporalJitterSample(phase)[1] / 2;
          const p = y + jitter;
          const first = Math.floor(p);
          const f = p - first;
          return verticalField(first - jitter) * (1 - f) + verticalField(first + 1 - jitter) * f;
        }).reduce((a, b) => a + b, 0) / 8,
    );
    let maxError = 0,
      minContrast = Infinity;
    let maxVerticalError = 0;
    for (let frame = 0; frame < 256; frame++) {
      const jitter = temporalJitterSample(frame),
        previous = temporalJitterSample(Math.max(0, frame - 1));
      upload(
        trace,
        width,
        height,
        new Float32Array(
          Array.from({ length: width * height }, (_, i) => [
            field((i % width) - jitter[0] / 2),
            verticalField(Math.floor(i / width) - jitter[1] / 2),
            0.25,
            1,
          ]).flat(),
        ),
      );
      const values = new ArrayBuffer(32),
        p = new DataView(values);
      p.setUint32(0, frame > 0 ? 1 : 0, true);
      p.setFloat32(4, 0.9, true);
      p.setFloat32(8, 0.02, true);
      p.setFloat32(12, 0.9, true);
      [
        jitter[0] / fullWidth,
        jitter[1] / fullHeight,
        previous[0] / fullWidth,
        previous[1] / fullHeight,
      ].forEach((v, i) => {
        p.setFloat32(16 + i * 4, v, true);
      });
      device.queue.writeBuffer(params, 0, new Uint8Array(values)).unwrap();
      const encoder = device.createCommandEncoder().unwrap(),
        pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, groups[frame % 2 === 0 ? 0 : 1]);
      pass.dispatchWorkgroups(width / 8, height / 8);
      pass.end();
      if (frame >= 248)
        encoder.copyTextureToBuffer(
          { texture: history[frame % 2 === 0 ? 1 : 0].texture },
          { buffer: readback, bytesPerRow: width * 8, rowsPerImage: height },
          { width, height, depthOrArrayLayers: 1 },
        );
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      if (frame < 248) continue;
      const mapped = (await readback.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap(),
        raw = new DataView(mapped.getMappedRange().unwrap().slice(0));
      mapped.unmap();
      const row = Array.from({ length: width - 4 }, (_, i) => {
        const half = raw.getUint16((2 * width + i + 2) * 8, true);
        expect(half >>> 10).toBeGreaterThan(0);
        expect(half >>> 10).toBeLessThan(31);
        return (1 + (half & 1023) / 1024) * 2 ** ((half >>> 10) - 15);
      });
      maxError = Math.max(
        maxError,
        ...row.map((v, i) => {
          const target = reference[i + 2];
          if (target === undefined) throw new Error('Missing integrated reference sample');
          return Math.abs(v - target);
        }),
      );
      minContrast = Math.min(minContrast, Math.max(...row) - Math.min(...row));
      for (let y = 2; y < height - 2; y++) {
        const half = raw.getUint16((y * width + 8) * 8 + 2, true);
        const value = (1 + (half & 1023) / 1024) * 2 ** ((half >>> 10) - 15);
        const target = verticalReference[y];
        if (target === undefined) throw new Error('Missing vertical reference sample');
        maxVerticalError = Math.max(maxVerticalError, Math.abs(value - target));
      }
    }
    await annotate('SSR detail integration', {
      contentType: 'application/json',
      bodyEncoding: 'utf-8',
      body: JSON.stringify({
        variant,
        frames: 256,
        maxError,
        minContrast,
        maxVerticalError,
        reference: 'independent eight-phase jitter integration',
      }),
    });
    if (presentationFeedback) {
      expect(maxError, 'the gate must detect the wrong history lattice').toBeGreaterThan(0.015);
      expect(minContrast, 'the gate must detect repeated reconstruction blur').toBeLessThan(1.4);
      return;
    }
    if (variant === 'ignored-vertical-neighbor') {
      expect(
        maxVerticalError,
        'the gate must detect a collapsed current footprint',
      ).toBeGreaterThan(0.015);
      return;
    }
    expect(
      maxError,
      'fixed-coordinate history against independent jitter-cycle integration',
    ).toBeLessThan(0.015);
    expect(minContrast, 'history must not diffuse away the reflected texture').toBeGreaterThan(1.4);
    expect(maxVerticalError, 'vertical jitter-cycle integration').toBeLessThan(0.015);
    const stableEncoder = device.createCommandEncoder().unwrap();
    stableEncoder.copyTextureToBuffer(
      { texture: surfaces[0].texture },
      { buffer: readback, bytesPerRow: 256, rowsPerImage: height },
      { width, height, depthOrArrayLayers: 1 },
    );
    device.queue.submit([stableEncoder.finish().unwrap()]).unwrap();
    const stableMapping = (await readback.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap();
    const stableValues = new Uint8Array(stableMapping.getMappedRange().unwrap().slice(0));
    stableMapping.unmap();
    expect(stableValues[2 * 256 + 8 * 4], 'steady coverage does not reject TAA history').toBe(0);
    expect(stableValues[2 * 256 + 8 * 4 + 3], 'steady coverage keeps full SSR confidence').toBe(
      255,
    );
    // Same static receiver and valid history on both sides. Only the right
    // source changes: the production entry must read the trace-owned mask.
    // Wide local color bounds prevent clipping from hiding a missing binding.
    upload(
      trace,
      width,
      height,
      new Float32Array(
        Array.from({ length: width * height }, (_, i) => [
          i % 8 === 0 ? 3 : i % 8 === 1 ? 4 : 0,
          0.5,
          0.25,
          1,
        ]).flat(),
      ),
    );
    device.queue
      .writeTexture(
        { texture: hitReactivity.texture },
        new Float32Array(
          Array.from({ length: width * height }, (_, i) => (i % width >= 16 ? 1 : 0)),
        ),
        { bytesPerRow: width * 4, rowsPerImage: height },
        { width, height, depthOrArrayLayers: 1 },
      )
      .unwrap();
    const reactiveParams = new DataView(new ArrayBuffer(32));
    reactiveParams.setUint32(0, 1, true);
    reactiveParams.setFloat32(4, 0.9, true);
    reactiveParams.setFloat32(8, 0.02, true);
    reactiveParams.setFloat32(12, 0.9, true);
    device.queue.writeBuffer(params, 0, new Uint8Array(reactiveParams.buffer)).unwrap();
    const reactiveEncoder = device.createCommandEncoder().unwrap();
    const reactivePass = reactiveEncoder.beginComputePass();
    reactivePass.setPipeline(pipeline);
    reactivePass.setBindGroup(0, groups[0]);
    reactivePass.dispatchWorkgroups(width / 8, height / 8);
    reactivePass.end();
    reactiveEncoder.copyTextureToBuffer(
      { texture: history[1].texture },
      { buffer: readback, bytesPerRow: width * 8, rowsPerImage: height },
      { width, height, depthOrArrayLayers: 1 },
    );
    device.queue.submit([reactiveEncoder.finish().unwrap()]).unwrap();
    const reactiveMapping = (await readback.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap();
    const reactiveValues = new DataView(reactiveMapping.getMappedRange().unwrap().slice(0));
    reactiveMapping.unmap();
    const readRed = (x: number) => {
      const h = reactiveValues.getUint16((2 * width + x) * 8, true);
      return (1 + (h & 1023) / 1024) * 2 ** ((h >>> 10) - 15);
    };
    expect(readRed(8), 'static source still accumulates accepted history').toBeLessThan(2);
    if (variant === 'ignored-hit-reactivity') {
      expect(
        readRed(16),
        'negative control retains stale reflection when source metadata is ignored',
      ).toBeLessThan(2);
    } else {
      expect(readRed(16), 'reactive hit rejects history despite zero receiver motion').toBeCloseTo(
        3,
        3,
      );
    }
    device.queue
      .writeTexture(
        { texture: hitReactivity.texture },
        new Float32Array(width * height),
        { bytesPerRow: width * 4, rowsPerImage: height },
        { width, height, depthOrArrayLayers: 1 },
      )
      .unwrap();
    // A moving occluder may leave no admitted radiance at all. Confidence
    // cannot gate its reactivity: static misses decay, reactive misses retire.
    upload(trace, width, height, new Float32Array(width * height * 4));
    const misses = [];
    for (let missed = 1; missed <= 8; missed++) {
      const missEncoder = device.createCommandEncoder().unwrap();
      const missPass = missEncoder.beginComputePass();
      missPass.setPipeline(pipeline);
      missPass.setBindGroup(0, groups[missed % 2 === 1 ? 1 : 0]);
      missPass.dispatchWorkgroups(width / 8, height / 8);
      missPass.end();
      missEncoder.copyTextureToBuffer(
        { texture: surfaces[missed % 2 === 1 ? 0 : 1].texture },
        { buffer: readback, bytesPerRow: 256, rowsPerImage: height },
        { width, height, depthOrArrayLayers: 1 },
      );
      device.queue.submit([missEncoder.finish().unwrap()]).unwrap();
      const mapping = (await readback.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap();
      const values = new Uint8Array(mapping.getMappedRange().unwrap().slice(0));
      mapping.unmap();
      const staticConfidence = values[2 * 256 + 8 * 4 + 3];
      misses.push({
        frame: missed,
        staticConfidence,
        staticReactivity: values[2 * 256 + 8 * 4],
        movingConfidence: values[2 * 256 + 16 * 4 + 3],
        movingReactivity: values[2 * 256 + 16 * 4],
      });
      if (missed === 1) {
        expect(staticConfidence, 'a single unsupported miss keeps history').toBeGreaterThan(0);
        if (variant === 'spurious-confidence-mask')
          expect(
            values[2 * 256 + 8 * 4],
            'negative control turns sampling loss into source motion',
          ).toBeGreaterThan(0);
        else
          expect(values[2 * 256 + 8 * 4], 'a single miss does not amplify into TAA rejection').toBe(
            0,
          );
        expect(
          values[2 * 256 + 16 * 4],
          'prior reactive source propagates after its hit disappears',
        ).toBe(variant === 'forgotten-source-history' ? 0 : 255);
        expect(values[2 * 256 + 16 * 4 + 3]).toBe(
          variant === 'ignored-hit-reactivity' || variant === 'forgotten-source-history'
            ? staticConfidence
            : 0,
        );
      }
      if (missed === 2) {
        const loss = values[2 * 256 + 8 * 4] ?? 0;
        if (variant === 'spurious-confidence-mask') expect(loss).toBeGreaterThan(0);
        else
          expect(loss, 'static unavailable radiance retires inside SSR without resetting TAA').toBe(
            0,
          );
      }
      if (missed === 8) {
        if (variant === 'ignored-confidence-loss')
          expect(staticConfidence, 'negative control retains the stale reflection').toBeGreaterThan(
            100,
          );
        else
          expect(
            staticConfidence,
            'unsupported reflection retires within eight frames',
          ).toBeLessThanOrEqual(1);
      }
    }
    await annotate('SSR miss recovery', {
      contentType: 'application/json',
      bodyEncoding: 'utf-8',
      body: JSON.stringify({ variant, misses, domain: 'rgba8unorm codes' }),
    });
    // Full coverage can carry negligible energy. Losing it must not repeatedly
    // reset TAA's stable age merely because its confidence was large.
    upload(
      trace,
      width,
      height,
      new Float32Array(
        Array.from({ length: width * height }, () => [0.001, 0.001, 0.001, 1]).flat(),
      ),
    );
    device.queue.writeBuffer(params, 0, new Uint32Array([0])).unwrap();
    const lowEnergySeedEncoder = device.createCommandEncoder().unwrap();
    const lowEnergySeedPass = lowEnergySeedEncoder.beginComputePass();
    lowEnergySeedPass.setPipeline(pipeline);
    lowEnergySeedPass.setBindGroup(0, groups[0]);
    lowEnergySeedPass.dispatchWorkgroups(width / 8, height / 8);
    lowEnergySeedPass.end();
    device.queue.submit([lowEnergySeedEncoder.finish().unwrap()]).unwrap();
    // A response generated on the presentation lattice is not a fixed-grid
    // source flag. The source flag stays zero even when the response is one.
    device.queue
      .writeTexture(
        { texture: surfaces[1].texture },
        new Uint8Array(Array.from({ length: width * height }, () => [255, 128, 128, 255]).flat()),
        { bytesPerRow: width * 4, rowsPerImage: height },
        { width, height, depthOrArrayLayers: 1 },
      )
      .unwrap();
    device.queue.writeBuffer(params, 0, new Uint32Array([1])).unwrap();
    upload(trace, width, height, new Float32Array(width * height * 4));
    const lowEnergy = [];
    for (let frame = 1; frame <= 8; frame++) {
      const encoder = device.createCommandEncoder().unwrap();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, groups[frame % 2 === 1 ? 1 : 0]);
      pass.dispatchWorkgroups(width / 8, height / 8);
      pass.end();
      encoder.copyTextureToBuffer(
        { texture: surfaces[frame % 2 === 1 ? 0 : 1].texture },
        { buffer: readback, bytesPerRow: 256, rowsPerImage: height },
        { width, height, depthOrArrayLayers: 1 },
      );
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      const mapping = (await readback.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap();
      const values = new Uint8Array(mapping.getMappedRange().unwrap().slice(0));
      mapping.unmap();
      const reactive = values[2 * 256 + 8 * 4] ?? 0;
      lowEnergy.push({ frame, reactive });
      if (variant === 'resolved-mask-feedback' && frame === 1) {
        expect(reactive, 'negative control feeds a resolved response back as a source').toBe(255);
        expect(values[2 * 256 + 8 * 4 + 3]).toBe(0);
      } else if (variant === 'spurious-confidence-mask' && frame === 2)
        expect(reactive, 'negative control spuriously resets static TAA').toBeGreaterThan(0);
      else if (variant !== 'spurious-confidence-mask' && variant !== 'resolved-mask-feedback')
        expect(reactive, 'negligible retired energy leaves TAA accumulation intact').toBe(0);
    }
    await annotate('SSR low-energy retirement', {
      contentType: 'application/json',
      bodyEncoding: 'utf-8',
      body: JSON.stringify({ variant, radiance: 0.001, lowEnergy, domain: 'rgba8unorm codes' }),
    });
    // Clearing a receiver cannot preserve radiance, source reactivity or
    // confidence from the preceding occupied depth, including orthographic.
    const emptyEncoder = device.createCommandEncoder().unwrap();
    const emptyDepth = emptyEncoder.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: depth.view,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        depthClearValue: 0,
      },
    });
    emptyDepth.end();
    const emptyPass = emptyEncoder.beginComputePass();
    emptyPass.setPipeline(pipeline);
    emptyPass.setBindGroup(0, groups[0]);
    emptyPass.dispatchWorkgroups(width / 8, height / 8);
    emptyPass.end();
    emptyEncoder.copyTextureToBuffer(
      { texture: resolved.texture },
      { buffer: readback, bytesPerRow: width * 8, rowsPerImage: height },
      { width, height, depthOrArrayLayers: 1 },
    );
    device.queue.submit([emptyEncoder.finish().unwrap()]).unwrap();
    const emptyMapping = (await readback.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap();
    const emptyRadiance = new Uint8Array(emptyMapping.getMappedRange().unwrap().slice(0));
    emptyMapping.unmap();
    expect(
      emptyRadiance.every((byte) => byte === 0),
      'cleared receiver has no resolved energy or confidence',
    ).toBe(true);
  } finally {
    for (const t of [
      trace,
      hitReactivity,
      normal,
      temporal,
      depth,
      ...history,
      ...surfaces,
      resolved,
    ])
      device.destroyTexture(t.texture).unwrap();
    for (const b of [params, view, readback]) device.destroyBuffer(b).unwrap();
  }
});
