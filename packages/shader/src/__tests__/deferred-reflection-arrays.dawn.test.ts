import { expect, it } from 'vitest';
import { compileShader } from '../../../shader-compiler/src/compile';
import { deferredShaderImports, deferredShaderSource } from './deferred-shader.fixture';

const WIDTH = 8;
const ROW_STRIDE = 256;

it('matches standalone Deferred lighting across resident and overflow PMREM classes', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Deferred reflection parity requires a GPU adapter');
  const device = await adapter.requestDevice({
    requiredLimits: { maxColorAttachmentBytesPerSample: 40 },
  });
  device.pushErrorScope('validation');
  let validation: GPUError | null | undefined;
  try {
    const boundsWitness = `
@fragment fn fs_overflow_bounds_witness(in : ReflectionOverflowVertex) -> @location(0) vec4<f32> {
  return vec4<f32>(f32(in.sizeClass), 1.0, 1.0, 1.0);
}`;
    const compiled = await compileShader(deferredShaderSource + boundsWitness, {
      id: 'forgeax_standard::deferred_lighting',
      imports: deferredShaderImports,
      defines: { PROJECTOR_AVAILABLE: false, EXTENDED_LIGHTING_AVAILABLE: false },
    });
    if (!compiled.ok) throw compiled.error;
    const { reflection, wgsl } = compiled.value;
    const module = device.createShaderModule({ code: wgsl });
    const geometry = await compileShader(
      `
#import forgeax_pbr::gbuffer_output::{GBufferOutput, encodeStandardGBuffer}
@vertex fn writerVertex(@builtin(vertex_index) index : u32) -> @builtin(position) vec4f {
  return vec4f(array<vec2f, 3>(vec2f(-1,-1), vec2f(3,-1), vec2f(-1,3))[index], 0.5, 1.0);
}
@fragment fn writerFragment(@builtin(position) p : vec4f) -> GBufferOutput {
  let x = u32(p.x);
  if (x == 0u) { discard; }
  let env = array<u32, 8>(0u, 0u, 1u, 3u, 1u, 1u, 5u, 5u)[x];
  let n = normalize(vec3f(0.2, 0.5, 0.84));
  return encodeStandardGBuffer(n, n, 0.34, vec3f(0.6, 0.65, 0.7), 0.25,
    vec4f(0.08, 0.08, 0.08, 1.0), 0.8, vec3f(0.01), 1.0, env, 0u, false, 1u, select(vec4f(0), vec4f(12, 6, 3, 1), x == 6u), false);
}`,
      { id: 'deferred_array_fixture', imports: deferredShaderImports },
    );
    if (!geometry.ok) throw geometry.error;
    const writerModule = device.createShaderModule({ code: geometry.value.wgsl });
    const formats = [
      'rgba16float',
      'rg32uint',
      'r32uint',
      'r32uint',
      'rg32uint',
      'rg32uint',
    ] as const;
    const writer = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module: writerModule, entryPoint: 'writerVertex' },
      fragment: {
        module: writerModule,
        entryPoint: 'writerFragment',
        targets: formats.map((format) => ({ format })),
      },
      depthStencil: { format: 'depth32float', depthCompare: 'always', depthWriteEnabled: true },
    });
    const attachment = (format: GPUTextureFormat, usage = 0) =>
      device.createTexture({
        size: [WIDTH, 1],
        format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | usage,
      });
    const gbuffer = formats.map((format) => attachment(format));
    const depth = attachment('depth32float');
    const encoder = device.createCommandEncoder();
    const colorAttachment = (view: GPUTextureView): GPURenderPassColorAttachment => ({
      view,
      loadOp: 'clear',
      storeOp: 'store',
      clearValue: [0, 0, 0, 0],
    });
    const geometryPass = encoder.beginRenderPass({
      colorAttachments: gbuffer.map((texture) => colorAttachment(texture.createView())),
      depthStencilAttachment: {
        view: depth.createView(),
        depthLoadOp: 'clear',
        depthClearValue: 0,
        depthStoreOp: 'store',
      },
    });
    geometryPass.setPipeline(writer);
    geometryPass.draw(3);
    geometryPass.end();

    const fillTexture = (
      width: number,
      height: number,
      layers: number,
      color: (layer: number, x: number, y: number) => number[],
    ) => {
      const texture = device.createTexture({
        size: [width, height, layers],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
      const data = new Uint8Array(bytesPerRow * height * layers);
      for (let layer = 0; layer < layers; layer++)
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++)
            data.set(color(layer, x, y), (layer * height + y) * bytesPerRow + x * 4);
      device.queue.writeTexture({ texture }, data, { bytesPerRow, rowsPerImage: height }, [
        width,
        height,
        layers,
      ]);
      return texture;
    };
    const irradiance = fillTexture(1, 1, 6, (layer) => [70 + layer * 4, 91, 135, 255]).createView({
      dimension: 'cube',
    });
    const brdf = fillTexture(1, 1, 1, () => [196, 22, 0, 255]).createView();
    const sky = fillTexture(1, 1, 1, () => [20, 27, 180, 255]).createView();
    const ao = fillTexture(1, 1, 1, () => [186, 0, 0, 255]).createView();
    const textures = [64, 128, 256].map((height) =>
      fillTexture(336, height, 3, (layer, x, y) => {
        if (layer === 1) return [155 + (x % 80), y % 64, 20, 255];
        if (layer === 0) return [x % 70, 135 + (y % 110), 20, 255];
        return [175 + (x % 64), 130 + (y % 120), 15, 255];
      }),
    );
    const arrays = textures.map((texture) => texture.createView({ dimension: '2d-array' }));
    const layerView = (texture: GPUTexture, baseArrayLayer: number) =>
      texture.createView({ dimension: '2d', baseArrayLayer, arrayLayerCount: 1 });
    const linear = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
    const comparison = device.createSampler({ compare: 'greater-equal' });
    const shadow = device
      .createTexture({
        size: [1, 1, 1],
        format: 'depth32float',
        usage: GPUTextureUsage.TEXTURE_BINDING,
      })
      .createView({ dimension: '2d-array' });
    const uniform = (values: Float32Array) => {
      const buffer = device.createBuffer({
        size: values.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(buffer, 0, values);
      return { buffer };
    };
    const skyData = [0.5, 0.8, 0.8, 0.8, 0, 0, 0, 1];
    const diffuse = [0.4, 0.4, 0.4, 0, 0, 0, 0, 1, 0.05, 0.06, 0.07, 0, 0.1, 0.07, 0.05, 1];
    const skyUniform = uniform(
      new Float32Array([...skyData, 0, 0, 0, 0, 0, 0, 0, 1, ...diffuse.slice(8)]),
    );
    const probes = [
      {
        env: 1,
        center: [-0.375, 0, 0.5],
        extents: [0.525, 0.9, 0.9],
        intensity: -1.8,
        box: 1,
        layer: 1,
      },
      { env: 3, center: [-0.125, 0, 0.5], extents: [0.2, 1, 1], intensity: -1.6, box: 0, layer: 0 },
      {
        env: 5,
        center: [0.625, 0, 0.5],
        extents: [0.24, 0.5, 0.5],
        intensity: -1.6,
        box: 1,
        layer: 2,
      },
    ];
    const probeUniforms = probes.map(({ env, center, extents, intensity, box }) => {
      const data = [...diffuse];
      data[3] = env;
      return uniform(new Float32Array([intensity, ...center, ...extents, box, ...data]));
    });
    const table = (classes: readonly number[]) => {
      const data = new Float32Array(576 / 4);
      data.set(diffuse);
      probes.forEach(({ env, center, extents, intensity, box, layer }, i) => {
        const address = layer * 32 + (classes[i] ?? 0) * 2 + box;
        data.set([...center, intensity, ...extents, address], 16 + (env - 1) * 8);
      });
      return uniform(data);
    };
    const view = reflection.boundGlobals.find(({ group, binding }) => group === 0 && binding === 0);
    if (view?.span === undefined) throw new Error('Missing Deferred view layout');
    const viewData = new Float32Array(view.span / 4);
    const viewU32 = new Uint32Array(viewData.buffer);
    const offset = (name: string) => {
      const member = view.members?.find((member) => member.name === name);
      if (member === undefined) throw new Error(`Missing View.${name}`);
      return member.offset / 4;
    };
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    viewData.set(identity, offset('inverseViewProj'));
    viewData.set(identity, offset('worldViewProj'));
    viewData[offset('viewportWidth')] = WIDTH;
    viewData[offset('viewportHeight')] = 1;
    viewData.set([0, 0, 3], offset('cameraPos'));
    viewData.set([0, 0, -1], offset('lightDir'));
    viewData.set([0.2, 0.2, 0.2], offset('lightColor'));
    viewU32[offset('lightingChannels')] = 1;
    const viewUniform = uniform(viewData);
    const params = uniform(new Float32Array([1, 0, 0, 0, 0.5, 0, 0, 0]));
    const storage = { buffer: device.createBuffer({ size: 256, usage: GPUBufferUsage.STORAGE }) };
    const viewResources = new Map<number, GPUBindingResource>([
      [0, viewUniform],
      [3, shadow],
      [4, comparison],
      [
        7,
        uniform(
          new Float32Array(
            (reflection.boundGlobals.find(({ group, binding }) => group === 0 && binding === 7)
              ?.span ?? 80) / 4,
          ),
        ),
      ],
      [8, shadow],
      [16, ao],
      [17, linear],
    ]);
    const shared = [
      [],
      [
        gbuffer[1]?.createView(),
        gbuffer[3]?.createView(),
        gbuffer[2]?.createView(),
        gbuffer[4]?.createView(),
        depth.createView(),
        ao,
        linear,
        params,
        irradiance,
        undefined,
        brdf,
        sky,
        undefined,
        storage,
        storage,
        gbuffer[5]?.createView(),
      ],
      [],
      [storage],
    ];
    const sceneColor: GPUColorTargetState = {
      format: 'rgba8unorm',
      blend: {
        color: { srcFactor: 'one', dstFactor: 'one' },
        alpha: { srcFactor: 'zero', dstFactor: 'one' },
      },
    };
    const renderPipelines = new Map<string, GPURenderPipeline>();
    const pipelineFor = async (name: string, overflow: boolean, sss = false) => {
      const key = `${name}:${sss}`;
      const held = renderPipelines.get(key);
      if (held !== undefined) return held;
      const pipeline = await device.createRenderPipelineAsync({
        layout: 'auto',
        vertex: {
          module,
          entryPoint: overflow
            ? 'vs_standard_deferred_reflection_overflow'
            : 'vs_standard_deferred',
        },
        fragment: {
          module,
          entryPoint: name,
          ...(sss ? { constants: { '64004': 1 } } : {}),
          targets: [
            sceneColor,
            { format: 'rgba8unorm' },
            {
              format: 'rgba8unorm',
              ...(overflow ? { writeMask: 0 } : {}),
            },
            {
              format: 'rgba8unorm',
              ...(overflow ? { writeMask: 0 } : {}),
            },
          ],
        },
      });
      renderPipelines.set(key, pipeline);
      return pipeline;
    };
    const record = async (classes: readonly number[], budget: 0 | 1 | 2, sss = false) => {
      const entryPoint = `fs_standard_deferred_reflections${budget === 0 ? '' : budget === 1 ? '_array_single' : '_array_dual'}`;
      const overflowEntry = 'fs_standard_deferred_reflections_overflow';
      const pipeline = await pipelineFor(entryPoint, false, sss);
      const overflowPipeline =
        budget !== 0 && new Set(classes).size > budget
          ? await pipelineFor(overflowEntry, true)
          : undefined;
      const reflectionTable = budget === 0 ? undefined : table(classes);
      const targets = Array.from({ length: 4 }, () =>
        attachment('rgba8unorm', GPUTextureUsage.COPY_SRC),
      );
      const pass = encoder.beginRenderPass({
        colorAttachments: targets.map((texture, index) => ({
          ...colorAttachment(texture.createView()),
          clearValue: [0, 0, 0, index === 0 ? 1 : 0],
        })),
      });
      const setGroups = (
        fragment: string,
        pipeline: GPURenderPipeline,
        prefilter: GPUTextureView | undefined,
        environment: GPUBufferBinding | undefined,
        pmrem: readonly (GPUTextureView | undefined)[],
      ) => {
        const reads = reflection.entryPoints?.find(({ name }) => name === fragment)?.bindings;
        if (reads === undefined) throw new Error(`Missing ${fragment} binding reflection`);
        for (const group of [0, 1, 3]) {
          const entries = reads
            .filter((read) => read.group === group)
            .map(({ binding }) => {
              const resource =
                group === 0
                  ? viewResources.get(binding)
                  : group === 1 && binding === 9
                    ? prefilter
                    : group === 1 && binding === 12
                      ? environment
                      : group === 3 && binding === 3
                        ? reflectionTable
                        : group === 3 && binding > 0
                          ? pmrem[binding - 1]
                          : shared[group]?.[binding];
              if (resource === undefined)
                throw new Error(`Missing test resource ${group}:${binding}`);
              return { binding, resource };
            });
          pass.setBindGroup(
            group,
            device.createBindGroup({ layout: pipeline.getBindGroupLayout(group), entries }),
          );
        }
      };
      pass.setPipeline(pipeline);
      if (budget === 0) {
        setGroups(entryPoint, pipeline, sky, skyUniform, []);
        pass.draw(3);
        for (const [i, probe] of probes.entries()) {
          const texture = textures[classes[i] ?? 0];
          if (texture === undefined) throw new Error('Missing test PMREM class');
          setGroups(entryPoint, pipeline, layerView(texture, probe.layer), probeUniforms[i], []);
          pass.draw(3);
        }
      } else {
        setGroups(entryPoint, pipeline, undefined, skyUniform, arrays.slice(0, budget));
        pass.draw(3);
      }
      if (overflowPipeline !== undefined) {
        pass.setPipeline(overflowPipeline);
        for (const sizeClass of new Set(classes)) {
          if (sizeClass < budget) continue;
          setGroups(overflowEntry, overflowPipeline, undefined, undefined, [arrays[sizeClass]]);
          pass.draw(6, 1, 0, sizeClass);
        }
      }
      pass.end();
      const output = device.createBuffer({
        size: targets.length * ROW_STRIDE,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      for (const [i, texture] of targets.entries()) {
        encoder.copyTextureToBuffer(
          { texture },
          { buffer: output, offset: i * ROW_STRIDE, bytesPerRow: ROW_STRIDE },
          [WIDTH, 1],
        );
      }
      return output;
    };
    const cases = [
      { classes: [0, 0, 0], budget: 1 },
      { classes: [0, 1, 1], budget: 2 },
      { classes: [0, 1, 1], budget: 1 },
      { classes: [0, 1, 2], budget: 2 },
      { classes: [0, 1, 2], budget: 1 },
    ] as const;
    const outputs = [];
    for (const { classes, budget } of cases)
      outputs.push(await record(classes, 0), await record(classes, budget));
    const splitOutput = await record([0, 1, 2], 2, true);
    const rasterBounds = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs_standard_deferred_reflection_overflow' },
      fragment: {
        module,
        entryPoint: 'fs_overflow_bounds_witness',
        targets: [{ format: 'rgba8unorm' }],
      },
    });
    const boundsViewData = new Float32Array(viewData);
    boundsViewData[offset('viewportWidth')] = 64;
    const ordinaryView = uniform(boundsViewData);
    // clip.w = world.z - 0.4. The class's boxes cross the eye plane.
    boundsViewData[offset('worldViewProj') + 11] = 1;
    boundsViewData[offset('worldViewProj') + 15] = -0.4;
    const eyePlaneView = uniform(boundsViewData);
    const bounds = device.createTexture({
      size: [64, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const readBounds = device.createBuffer({
      size: ROW_STRIDE * 2,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const boundsTable = device.createBindGroup({
      layout: rasterBounds.getBindGroupLayout(3),
      entries: [{ binding: 3, resource: table([0, 1, 1]) }],
    });
    for (const [index, view] of [ordinaryView, eyePlaneView].entries()) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [colorAttachment(bounds.createView())],
      });
      pass.setPipeline(rasterBounds);
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: rasterBounds.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: view }],
        }),
      );
      pass.setBindGroup(3, boundsTable);
      pass.draw(6, 1, 0, 1);
      pass.end();
      encoder.copyTextureToBuffer(
        { texture: bounds },
        { buffer: readBounds, offset: index * ROW_STRIDE, bytesPerRow: ROW_STRIDE },
        [64, 1],
      );
    }
    device.queue.submit([encoder.finish()]);
    validation = await device.popErrorScope();
    expect(validation?.message).toBeUndefined();
    await readBounds.mapAsync(GPUMapMode.READ);
    const covered = new Uint8Array(readBounds.getMappedRange());
    for (let x = 0; x < 64; x++) {
      expect(covered[x * 4 + 3], `projected span, pixel ${x}`).toBe(x >= 20 && x <= 61 ? 255 : 0);
      expect(covered[ROW_STRIDE + x * 4 + 3], `eye-plane fallback, pixel ${x}`).toBe(255);
    }
    readBounds.unmap();
    const pixels = await Promise.all(
      outputs.map(async (buffer) => {
        await buffer.mapAsync(GPUMapMode.READ);
        return new Uint8Array(buffer.getMappedRange().slice(0));
      }),
    );
    await splitOutput.mapAsync(GPUMapMode.READ);
    const split = new Uint8Array(splitOutput.getMappedRange());
    const unsplit = pixels[7]; // Same two base classes plus third-class overflow.
    if (unsplit === undefined) throw new Error('Missing unsplit control');
    const subsurfacePixel = 6 * 4;
    const carrier = 3 * ROW_STRIDE + subsurfacePixel;
    expect(split[carrier]).toBeGreaterThan(0);
    for (let channel = 0; channel < 3; channel++) {
      const combined = (split[subsurfacePixel + channel] ?? 0) + (split[carrier + channel] ?? 0);
      expect(Math.abs(combined - (unsplit[subsurfacePixel + channel] ?? 0))).toBeLessThanOrEqual(1);
    }
    expect(split.slice(ROW_STRIDE, 3 * ROW_STRIDE)).toEqual(
      unsplit.slice(ROW_STRIDE, 3 * ROW_STRIDE),
    );
    splitOutput.unmap();
    for (const [caseIndex, scenario] of cases.entries()) {
      const legacy = pixels[caseIndex * 2];
      const array = pixels[caseIndex * 2 + 1];
      if (legacy === undefined || array === undefined) throw new Error('Missing lighting readback');
      for (let target = 0; target < 4; target++) {
        const start = target * ROW_STRIDE;
        expect([...array.slice(start, start + 4)]).toEqual([0, 0, 0, target === 0 ? 255 : 0]);
        for (let byte = start; byte < start + WIDTH * 4; byte++)
          expect(
            Math.abs((array[byte] ?? 0) - (legacy[byte] ?? 0)),
            `${JSON.stringify(scenario)}, target ${target}, byte ${byte - start}`,
          ).toBeLessThanOrEqual(1);
      }
      const fallback = (x: number) => [...array.slice(ROW_STRIDE + x * 4, ROW_STRIDE + x * 4 + 3)];
      expect(fallback(1)[2]).toBeGreaterThan(fallback(1)[0] ?? 0);
      expect(fallback(2)[0]).toBeGreaterThan(fallback(2)[2] ?? 0);
      expect(fallback(3)[1]).toBeGreaterThan(fallback(3)[2] ?? 0);
      expect(fallback(4)[2]).toBeGreaterThan(fallback(2)[2] ?? 0);
      expect(fallback(5)[2]).toBeGreaterThan(fallback(5)[0] ?? 0);
      expect(fallback(6)[0]).toBeGreaterThan(fallback(6)[2] ?? 0);
      expect(fallback(7)[2]).toBeGreaterThan(fallback(7)[0] ?? 0);
    }
  } finally {
    if (validation === undefined) await device.popErrorScope();
    device.destroy();
  }
}, 30000);
