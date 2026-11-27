import { ShaderRegistry } from '@forgeax/engine-shader';
import { expect, it } from 'vitest';
import { prepareShaderProgramCompiler } from '../../../shader-compiler/src/program-template';
import { buildEngineShaderTemplateManifest } from '../../../vite-plugin-shader/src/index';
import { STANDARD_OUTPUT_V2_PARAMS_LAYOUT } from '../standard-output';

let preparedSource: Promise<string> | undefined;
const compiled = () =>
  (preparedSource ??= (async () => {
    const wire = await buildEngineShaderTemplateManifest();
    const entry = wire.entries.find((row) => row.identifier === 'forgeax::standard-output-v2');
    if (entry === undefined) throw Error('Missing published native output recipe');
    const registry = new ShaderRegistry({
      manifestUrl: undefined,
      programCompiler: (await prepareShaderProgramCompiler()).unwrap(),
    });
    registry.installProgramTemplates(wire.library).unwrap();
    return registry.resolveProgramTemplate(entry.program, entry.selection).unwrap().manifestEntry
      .wgsl;
  })());
function at<T>(values: ArrayLike<T>, index: number): T {
  const value = values[index];
  if (value === undefined) throw Error(`Reference pixel index out of bounds: ${index}`);
  return value;
}
const width = 16;
const height = 8;
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const encode = (value: number) =>
  value <= 0.0031308 ? value * 12.92 : 1.055 * Math.max(0, value) ** (1 / 2.4) - 0.055;
const decode = (value: number) =>
  value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
const byte = (value: number) => Math.round(clamp(value) * 255);
const light = (color: readonly number[]) =>
  at(color, 0) * 0.299 + at(color, 1) * 0.587 + at(color, 2) * 0.114;
const smooth = (low: number, high: number, value: number) => {
  const t = clamp((value - low) / (high - low));
  return t * t * (3 - 2 * t);
};
function params() {
  const values = new Float32Array(STANDARD_OUTPUT_V2_PARAMS_LAYOUT.byteSize / 4);
  values.set([1, 1, 1, 2]);
  values[4] = 1;
  values[9] = 1;
  values[14] = 1;
  values[25] = 0.5;
  values[26] = 0.5;
  values[33] = 1;
  return values;
}
function image(pixel: (x: number, y: number) => readonly number[]) {
  const bytes = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) bytes.set(pixel(x, y), (y * width + x) * 4);
  return bytes;
}
// Independent normalized clamp-to-edge bilinear sampling, including off-center FXAA taps.
function sample(bytes: Uint8Array, u: number, v: number): number[] {
  const x = u * width - 0.5,
    y = v * height - 0.5,
    ix = Math.floor(x),
    iy = Math.floor(y);
  return [0, 1, 2, 3].map((channel) => {
    let result = 0;
    for (const dy of [0, 1])
      for (const dx of [0, 1]) {
        const sx = Math.max(0, Math.min(width - 1, ix + dx)),
          sy = Math.max(0, Math.min(height - 1, iy + dy));
        result +=
          (at(bytes, (sy * width + sx) * 4 + channel) / 255) *
          (dx ? x - ix : 1 - x + ix) *
          (dy ? y - iy : 1 - y + iy);
      }
    return result;
  });
}
async function fixture() {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw Error('Native output acceptance requires a GPU adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const code = await compiled();
  const module = device.createShaderModule({ code });
  expect((await module.getCompilationInfo()).messages.filter((m) => m.type === 'error')).toEqual(
    [],
  );
  const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
  const owned: (GPUTexture | GPUBuffer)[] = [];
  const texture = (bytes: Uint8Array | Uint16Array, depth = 1) => {
    const size = {
      width: depth === 1 ? width : 2,
      height: depth === 1 ? height : 2,
      depthOrArrayLayers: depth,
    };
    const value = device.createTexture({
      size,
      format: bytes instanceof Uint16Array ? 'rgba16float' : 'rgba8unorm',
      dimension: depth === 1 ? '2d' : '3d',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    owned.push(value);
    device.queue.writeTexture(
      { texture: value },
      bytes,
      {
        bytesPerRow: size.width * (bytes instanceof Uint16Array ? 8 : 4),
        rowsPerImage: size.height,
      },
      size,
    );
    return value;
  };
  const draw = async (
    entry: string,
    values: Float32Array,
    input: Uint8Array | Uint16Array | GPUTexture,
    options: {
      format?: 'rgba8unorm' | 'rgba16float';
      exposure?: number;
      bloom?: Uint8Array;
      lut?: readonly number[];
    } = {},
  ) => {
    const hasBloom = entry.includes('bloom'),
      hasLut = entry.includes('lut'),
      grade = entry.startsWith('fs_grade');
    const inputTexture =
      input instanceof Uint8Array || input instanceof Uint16Array ? texture(input) : input;
    const format = options.format ?? 'rgba8unorm';
    const uniform = device.createBuffer({
      size: 160,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    owned.push(uniform);
    device.queue.writeBuffer(uniform, 0, values);
    const candidate = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    owned.push(candidate);
    device.queue.writeBuffer(candidate, 0, new Float32Array([options.exposure ?? 1, 0, 0, 0]));
    const entries: GPUBindGroupLayoutEntry[] = [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform', minBindingSize: 160 },
      },
    ];
    const bindings: GPUBindGroupEntry[] = [
      { binding: 0, resource: inputTexture.createView() },
      { binding: 1, resource: sampler },
      { binding: 2, resource: { buffer: uniform } },
    ];
    if (grade) {
      entries.push({
        binding: 3,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform', minBindingSize: 16 },
      });
      bindings.push({ binding: 3, resource: { buffer: candidate } });
    }
    if (hasBloom) {
      entries.push({
        binding: 4,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      });
      bindings.push({
        binding: 4,
        resource: texture(options.bloom ?? image(() => [0, 0, 0, 255])).createView(),
      });
    }
    const inputLayout = device.createBindGroupLayout({ entries });
    const lutLayout = hasLut
      ? device.createBindGroupLayout({
          entries: [
            {
              binding: 0,
              visibility: GPUShaderStage.FRAGMENT,
              texture: { sampleType: 'float', viewDimension: '3d' },
            },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
          ],
        })
      : undefined;
    const pipeline = await device.createRenderPipelineAsync({
      layout: device.createPipelineLayout({
        bindGroupLayouts: lutLayout === undefined ? [inputLayout] : [inputLayout, lutLayout],
      }),
      vertex: { module, entryPoint: 'vs_main' },
      fragment: { module, entryPoint: entry, targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    const target = device.createTexture({
      size: [width, height],
      format,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });
    owned.push(target);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, device.createBindGroup({ layout: inputLayout, entries: bindings }));
    if (lutLayout !== undefined) {
      const lutBytes = new Uint8Array(32);
      for (let texel = 0; texel < 8; texel++)
        lutBytes.set(options.lut ?? [0, 0, 0, 255], texel * 4);
      pass.setBindGroup(
        1,
        device.createBindGroup({
          layout: lutLayout,
          entries: [
            { binding: 0, resource: texture(lutBytes, 2).createView({ dimension: '3d' }) },
            { binding: 1, resource: sampler },
          ],
        }),
      );
    }
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
    return target;
  };
  const readback = async (target: GPUTexture) => {
    expect(target.format).toBe('rgba8unorm');
    const output = device.createBuffer({
      size: 256 * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    owned.push(output);
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: target }, { buffer: output, bytesPerRow: 256 }, [
      width,
      height,
    ]);
    device.queue.submit([encoder.finish()]);
    await output.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(output.getMappedRange()),
      result = new Uint8Array(width * height * 4);
    for (let row = 0; row < height; row++)
      result.set(mapped.subarray(row * 256, row * 256 + width * 4), row * width * 4);
    output.unmap();
    return result;
  };
  return {
    draw,
    readback,
    render: async (...args: Parameters<typeof draw>) => readback(await draw(...args)),
    dispose: async () => {
      await device.queue.onSubmittedWorkDone();
      expect(errors).toEqual([]);
      for (const value of owned) value.destroy();
      device.destroy();
    },
  };
}
function close(actual: Uint8Array, expected: Uint8Array, tolerance = 1) {
  expect(actual.length).toBe(expected.length);
  let maximum = 0;
  for (let i = 0; i < actual.length; i++)
    maximum = Math.max(maximum, Math.abs(at(actual, i) - at(expected, i)));
  expect(maximum).toBeLessThanOrEqual(tolerance);
}
it('Grade fuses same-frame exposure, white balance, tone, optional Bloom and LUT with one encoding', async () => {
  const gpu = await fixture();
  try {
    const input = image(() => [46, 10, 102, 128]);
    for (const entry of ['fs_grade', 'fs_grade_lut', 'fs_grade_bloom', 'fs_grade_lut_bloom']) {
      const values = params();
      values[1] = 0.5;
      values[4] = 0.5;
      values[9] = 1.25;
      values[14] = 1.5;
      values[19] = 0.25;
      values[20] = 0.3;
      values[21] = 0.8;
      const actual = await gpu.render(entry, values, input, {
        exposure: 2,
        bloom: image(() => [10, 20, 30, 255]),
        lut: [77, 128, 179, 255],
      });
      const expected = [46, 10, 102].map((v, channel) => {
        const bloom = entry.includes('bloom') ? (at([10, 20, 30], channel) / 255) * 0.3 : 0;
        const toned = clamp((v / 255 + bloom) * at([0.5, 1.25, 1.5], channel));
        return byte(
          encode(
            entry.includes('lut')
              ? toned * 0.75 + decode(at([77, 128, 179], channel) / 255) * 0.25
              : toned,
          ),
        );
      });
      close(
        actual,
        image(() => [...expected, 128]),
      );
    }
  } finally {
    await gpu.dispose();
  }
});
it('Grade keeps CA on the scene before adding unshifted Bloom and applies vignette before encoding', async () => {
  const gpu = await fixture();
  try {
    const input = image((x, y) => [10 + x * 10, 10 + y * 20, 100 + x * 4, 128]);
    const values = params();
    values.set([0.2, 0.1, 0.2, 0], 16);
    values.set([0.5, 0.4, 0.5, 0], 24);
    values.set([0.1, 0.2, 0.3, 0], 28);
    values[20] = 0.3;
    const actual = await gpu.render('fs_grade_bloom', values, input, {
      bloom: image(() => [20, 20, 20, 255]),
    });
    const expected = image((x, y) => {
      const uv = [(x + 0.5) / width, (y + 0.5) / height],
        lens = uv.map((v) => v * 2 - 1);
      const pull = lens.map((v) => Math.sign(v) * clamp(Math.abs(v) - 0.2));
      const r = at(
        sample(
          input,
          (at(lens, 0) - at(pull, 0) * 0.2) * 0.5 + 0.5,
          (at(lens, 1) - at(pull, 1) * 0.2) * 0.5 + 0.5,
        ),
        0,
      );
      const g = at(
        sample(
          input,
          (at(lens, 0) - at(pull, 0) * 0.1) * 0.5 + 0.5,
          (at(lens, 1) - at(pull, 1) * 0.1) * 0.5 + 0.5,
        ),
        1,
      );
      const b = at(input, (y * width + x) * 4 + 2) / 255;
      const vignette = 0.5 * smooth(0.4, 0.9, Math.hypot(...lens));
      return [
        ...[r, g, b].map((v, i) =>
          byte(
            encode(
              clamp(v + (20 / 255) * 0.3) * (1 - vignette) + at([0.1, 0.2, 0.3], i) * vignette,
            ),
          ),
        ),
        128,
      ];
    });
    close(actual, expected);
  } finally {
    await gpu.dispose();
  }
});
it('Final uses encoded FXAA and edge-suppressed sharpening, preserving center alpha', async () => {
  const gpu = await fixture();
  try {
    const input = image((x, y) => {
      const v = x + y * 2 > 12 ? 220 : 25;
      return [v, v - 10, v + 10, 64 + x * 8];
    });
    const values = params();
    values[34] = 0.3;
    for (const aa of [false, true]) {
      const actual = await gpu.render(aa ? 'fs_final_fxaa' : 'fs_final', values, input);
      const expected = image((x, y) => {
        const u = (x + 0.5) / width,
          v = (y + 0.5) / height,
          center = sample(input, u, v);
        const corners = [
          [-1, -1],
          [1, -1],
          [-1, 1],
          [1, 1],
        ].map((offset) => sample(input, u + at(offset, 0) / width, v + at(offset, 1) / height));
        const lights = corners.map(light),
          minimum = Math.min(light(center), ...lights),
          maximum = Math.max(light(center), ...lights),
          contrast = maximum - minimum;
        let color = center.slice(0, 3);
        if (aa && contrast > Math.max(0.0312, maximum * 0.1)) {
          let dx = -(at(lights, 0) + at(lights, 1) - at(lights, 2) - at(lights, 3)),
            dy = at(lights, 0) + at(lights, 2) - at(lights, 1) - at(lights, 3);
          const reduce = Math.max(lights.reduce((a, b) => a + b, 0) * 0.03125, 0.0078125),
            scale = 1 / (Math.min(Math.abs(dx), Math.abs(dy)) + reduce);
          dx = Math.max(-8, Math.min(8, dx * scale)) / width;
          dy = Math.max(-8, Math.min(8, dy * scale)) / height;
          const inner = [-1 / 6, 1 / 6].map((t) => sample(input, u + dx * t, v + dy * t)),
            outer = [-0.5, 0.5].map((t) => sample(input, u + dx * t, v + dy * t));
          const a = [0, 1, 2].map((i) => (at(at(inner, 0), i) + at(at(inner, 1), i)) * 0.5),
            b = a.map(
              (value, i) => value * 0.5 + (at(at(outer, 0), i) + at(at(outer, 1), i)) * 0.25,
            );
          color = light(b) < minimum || light(b) > maximum ? a : b;
        }
        return [
          ...color.map((value, i) =>
            byte(
              value +
                (at(center, i) - corners.reduce((sum, c) => sum + at(c, i), 0) * 0.25) *
                  0.3 *
                  (1 - smooth(0.04, 0.22, contrast)),
            ),
          ),
          byte(at(center, 3)),
        ];
      });
      close(actual, expected, 2);
      if (aa) expect(actual).not.toEqual(await gpu.render('fs_final', values, input));
    }
  } finally {
    await gpu.dispose();
  }
});
it('Grade reads scene HDR16F before exposure and stores display UNORM8 only after grading', async () => {
  const gpu = await fixture();
  try {
    // Exact binary16 values: 2, 1.5, 0.125, 0.5. A premature [0,1] store loses HDR.
    const input = new Uint16Array(width * height * 4);
    for (let i = 0; i < width * height; i++) input.set([0x4000, 0x3e00, 0x3000, 0x3800], i * 4);
    const values = params();
    values[1] = 0.25;
    const actual = await gpu.render('fs_grade', values, input, { exposure: 2 });
    close(
      actual,
      image(() => [byte(encode(1)), byte(encode(0.75)), byte(encode(0.0625)), 128]),
    );
  } finally {
    await gpu.dispose();
  }
});

it('pointwise-only output can omit Final while retaining Grade UNORM8 and deterministic grain/dither', async () => {
  const gpu = await fixture();
  try {
    const input = image(() => [46, 77, 18, 128]),
      values = params();
    values[32] = 0.025;
    values[35] = 1.25;
    new Uint32Array(values.buffer)[38] = 1;
    const grade = await gpu.render('fs_grade', values, input);
    const split = await gpu.render('fs_final', values, grade);
    new Uint32Array(values.buffer)[39] = 1;
    const fused = await gpu.render('fs_grade', values, input);
    close(fused, split, 0);
    close(await gpu.render('fs_grade', values, input), fused, 0);
    values[35] = 2.5;
    expect(await gpu.render('fs_grade', values, input)).not.toEqual(fused);
  } finally {
    await gpu.dispose();
  }
});

it('preserves negative Rec.709 components of representable Display-P3 colors through Grade', async () => {
  const gpu = await fixture();
  try {
    // Binary16: [-0.125, 0.5, -0.03125] is inside P3 but outside Rec.709.
    const input = new Uint16Array(width * height * 4);
    for (let i = 0; i < width * height; i++) input.set([0xb000, 0x3800, 0xa800, 0x3c00], i * 4);
    const values = params();
    new Uint32Array(values.buffer)[36] = 1;
    const rgb = [-0.125, 0.5, -0.03125];
    const p3 = [
      0.822461963 * at(rgb, 0) + 0.177538037 * at(rgb, 1),
      0.0331941992 * at(rgb, 0) + 0.966805816 * at(rgb, 1),
      0.0170826316 * at(rgb, 0) + 0.0723974407 * at(rgb, 1) + 0.910519958 * at(rgb, 2),
    ];
    close(
      await gpu.render('fs_grade', values, input),
      image(() => [...p3.map((v) => byte(encode(clamp(v)))), 255]),
    );
  } finally {
    await gpu.dispose();
  }
});

/** Positive binary16 inputs with normal exponents, plus the clear endpoint. */
function linearHalf(value: number): number {
  if (value === 0) return 0;
  const exponent = Math.floor(Math.log2(value));
  return ((exponent + 14) << 10) + Math.round((value / 2 ** exponent) * 1024);
}

it('preserves dark ramps, low-contrast FXAA and alpha through the dithered UNORM8 seam', async () => {
  const gpu = await fixture();
  try {
    const rampCodes = (x: number) => (x === 0 ? 0 : 1.375 + (x - 1) * 0.27);
    const pattern = (codes: (x: number, y: number) => number) => {
      const input = new Uint16Array(width * height * 4);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const shade = linearHalf(decode(codes(x, y) / 255));
          const alpha = linearHalf(x / (width - 1));
          input.set([shade, shade, shade, alpha], (y * width + x) * 4);
        }
      return input;
    };
    const policy = (dither: 0 | 1 | 2) => {
      const values = params();
      new Uint32Array(values.buffer)[38] = dither;
      return values;
    };
    const encodeAndFilter = async (input: Uint16Array, compact: boolean, dither: 0 | 1 | 2) => {
      const values = policy(dither);
      const grade = await gpu.draw('fs_grade', values, input, {
        format: compact ? 'rgba8unorm' : 'rgba16float',
      });
      return gpu.render('fs_final_fxaa', values, grade);
    };
    const ramp = pattern(rampCodes);
    const compact = await encodeAndFilter(ramp, true, 2);
    const float = await encodeAndFilter(ramp, false, 1);
    const undithered = await encodeAndFilter(ramp, true, 0);
    close(compact, float, 1);
    const firstDarkColumn = Array.from({ length: height }, (_, y) =>
      at(compact, (y * width + 1) * 4),
    );
    expect(new Set(firstDarkColumn)).toEqual(new Set([1, 2]));
    expect(
      new Set(Array.from({ length: height }, (_, y) => at(undithered, (y * width + 1) * 4))),
    ).toEqual(new Set([1]));
    expect(await encodeAndFilter(ramp, true, 2)).toEqual(compact);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4;
        expect(Math.abs(at(compact, offset) - rampCodes(x))).toBeLessThanOrEqual(1);
        expect(Math.abs(at(compact, offset + 3) - byte(x / (width - 1)))).toBeLessThanOrEqual(1);
      }

    // A shallow diagonal with 9/255 of contrast exercises FXAA close to its
    // 0.0312 absolute threshold, with room for one input quantization step.
    const edge = pattern((x, y) => (x * 2 + y > 16 ? 19.45 : 10.45));
    const grade = await gpu.draw('fs_grade', policy(2), edge);
    const preAA = await gpu.readback(grade);
    const afterAA = await gpu.render('fs_final_fxaa', policy(2), grade);
    const floatEdge = await encodeAndFilter(edge, false, 1);
    close(afterAA, floatEdge, 2);
    expect(afterAA.some((value, i) => i % 4 !== 3 && Math.abs(value - at(preAA, i)) >= 2)).toBe(
      true,
    );
    expect(afterAA.filter((_value, i) => i % 4 === 3)).toEqual(
      preAA.filter((_value, i) => i % 4 === 3),
    );
  } finally {
    await gpu.dispose();
  }
});
