import type { RhiDevice, Texture } from '@forgeax/engine-rhi';
import { expect } from 'vitest';
import type { RenderPipelineFrame } from '../render-pipeline';
import { createTsrProgram, createTsrRasterProgram } from '../tsr/program';
import { half, unhalf } from './tsr-feedback';

type Tuple = readonly [number, number, number, number];
type Coordinate = readonly [number, number];
type Compile = NonNullable<
  RenderPipelineFrame['runtime']['immediateShaderModuleFactory']
>['createShaderModule'];

/** Independent identity oracle: center wins equal depths, then row-major order. */
function geometry(data: readonly Tuple[], w: number, h: number, uv: Coordinate, radius: number) {
  const x = Math.max(0, Math.min(w - 1, Math.trunc(Math.fround(uv[0] * w))));
  const y = Math.max(0, Math.min(h - 1, Math.trunc(Math.fround(uv[1] * h))));
  const center = data[y * w + x];
  if (!center) throw new Error('missing center');
  if (center[2] >= 0 && center[3] >= 1) return { packed: center, edge: false };
  const neighbors: Tuple[] = [];
  for (let dy = -radius; dy <= radius; dy++)
    for (let dx = -radius; dx <= radius; dx++) {
      const p =
        data[Math.max(0, Math.min(h - 1, y + dy)) * w + Math.max(0, Math.min(w - 1, x + dx))];
      if (!p) throw new Error('missing neighbor');
      neighbors.push(p);
    }
  const ranked = [center, ...neighbors]
    .map((packed, rank) => ({ packed, rank }))
    .filter(({ packed }) => packed[2] >= 0 && packed[3] < 2)
    .sort((a, b) => a.packed[2] - b.packed[2] || a.rank - b.rank);
  const packed = ranked[0]?.packed ?? center;
  return {
    packed,
    edge:
      packed[2] >= 0 &&
      (neighbors.some((p) => p[2] < 0) ||
        Math.max(...neighbors.map((p) => p[2])) - packed[2] > 0.0025 + packed[2] * 0.01),
  };
}

function acceptsHistory(p: Tuple, edge: boolean, uv: Coordinate, output: Coordinate) {
  return (
    p[2] >= 0 &&
    p[3] < 1 &&
    edge &&
    Math.hypot(p[0] * output[0], p[1] * output[1]) < 0.25 &&
    Math.fround(uv[0] - p[0]) >= 0 &&
    Math.fround(uv[0] - p[0]) < 1 &&
    Math.fround(uv[1] - p[1]) >= 0 &&
    Math.fround(uv[1] - p[1]) < 1
  );
}

interface CpuOracleFrame {
  readonly input: readonly Tuple[];
  readonly full: readonly Tuple[];
  readonly inputSize: Coordinate;
  readonly outputSize: Coordinate;
  readonly columns: readonly number[];
  readonly jitter: Coordinate;
  readonly tuples: readonly (readonly number[])[];
  readonly support: readonly (readonly number[])[];
  readonly colors: readonly (readonly number[])[];
  readonly label: string;
}

function verifyCpuGeometry(frame: CpuOracleFrame) {
  const [iw, ih] = frame.inputSize,
    [ow, oh] = frame.outputSize;
  for (let y = 0; y < oh; y++)
    for (const x of frame.columns) {
      const uv: Coordinate = [Math.fround((x + 0.5) / ow), Math.fround((y + 0.5) / oh)];
      const current: Coordinate = [
        Math.fround(uv[0] + frame.jitter[0]),
        Math.fround(uv[1] + frame.jitter[1]),
      ];
      const low = geometry(frame.input, iw, ih, current, 1),
        high = geometry(frame.full, ow, oh, current, 3);
      const chosen =
        low.packed[2] >= 0 && low.packed[3] >= 1 ? low : high.packed[2] >= 0 ? high : low;
      const index = y * ow + x,
        context = `${frame.label} at ${x},${y}`;
      expect(frame.tuples[index], context).toEqual(chosen.packed);
      expect((frame.support[index]?.[0] ?? NaN) > 0.2, context).toBe(
        acceptsHistory(chosen.packed, chosen.edge, uv, frame.outputSize),
      );
      expect(frame.colors[index], context).toEqual([4, 2, 1, 0.5]);
    }
}

/** Real production dispatch with two-dimensional halos, partial groups and FP16 motion tags. */
export async function verifyTsrGeometry(
  device: RhiDevice,
  compile: Compile,
  shape: 'partial' | 'rounding' = 'partial',
  execution: 'compute' | 'raster' = 'compute',
) {
  const iw = shape === 'rounding' ? 960 : 9,
    ih = shape === 'rounding' ? 9 : 5,
    ow = shape === 'rounding' ? 1920 : 31,
    oh = 19;
  const stride = Math.ceil((ow * 8) / 256) * 256;
  const columns =
    shape === 'rounding'
      ? [0, 1, 7, 8, 127, 128, 129, 134, 135, 136, 239, 240, 247, 248, 249, 1918, 1919]
      : Array.from({ length: ow }, (_, x) => x);
  const frame = {
    runtime: { device, immediateShaderModuleFactory: { createShaderModule: compile } },
  } as unknown as RenderPipelineFrame;
  const buildProgram = execution === 'compute' ? createTsrProgram : createTsrRasterProgram;
  const program = buildProgram(frame, false);
  // Let the same GPU evaluate rounding-sensitive UVs. The reference gathers
  // directly from the original textures and does not use either geometry cache.
  const reference =
    shape === 'rounding'
      ? buildProgram(
          {
            runtime: {
              device,
              immediateShaderModuleFactory: {
                createShaderModule: (descriptor: Parameters<Compile>[0]) => {
                  let code = descriptor.code;
                  for (const [from, to] of [
                    [
                      'tsrInputGeometry(sourcePixel,inputOrigin)',
                      'tsrClosestTemporalAt(sceneTemporal,sourcePixel,1)',
                    ],
                    [
                      'tsrCoverageGeometry(coveragePixel,coverageRadius,coverageOrigin,input.column)',
                      'tsrClosestTemporalAt(coverage,coveragePixel,coverageRadius)',
                    ],
                  ] as const) {
                    if (!code.includes(from)) throw new Error('missing geometry reference route');
                    code = code.replace(from, to);
                  }
                  return compile({ ...descriptor, label: 'tsr-direct-geometry-reference', code });
                },
              },
            },
          } as unknown as RenderPipelineFrame,
          false,
        )
      : undefined;
  const textures: Texture[] = [];
  function surface(width: number, height: number, format: 'rgba16float' | 'rgba8unorm') {
    const texture = device
      .createTexture({
        size: { width, height },
        format,
        usage: 1 | 2 | 4 | (execution === 'compute' ? 8 : 16),
      })
      .unwrap();
    textures.push(texture);
    return { texture, view: device.createTextureView(texture, {}).unwrap(), width, height, format };
  }
  const scene = surface(iw, ih, 'rgba16float'),
    temporal = surface(iw, ih, 'rgba16float');
  const oldColor = surface(ow, oh, 'rgba16float'),
    oldTemporal = surface(ow, oh, 'rgba16float');
  const oldMetadata = surface(ow, oh, 'rgba8unorm'),
    decision = surface(iw, ih, 'rgba16float');
  const secondary = surface(ow, oh, 'rgba8unorm'),
    coverage = surface(ow, oh, 'rgba16float');
  const color = surface(ow, oh, 'rgba16float'),
    output = surface(ow, oh, 'rgba16float');
  const metadata = surface(ow, oh, 'rgba8unorm');
  const params = device.createBuffer({ size: 64, usage: 64 | 8 }).unwrap();
  const readback = device.createBuffer({ size: stride * oh, usage: 1 | 8 }).unwrap();
  const upload = (s: ReturnType<typeof surface>, pixels: readonly Tuple[]) => {
    const data =
      s.format === 'rgba16float'
        ? new Uint16Array(pixels.flatMap((p) => p.map(half)))
        : new Uint8Array(pixels.flatMap((p) => p.map((v) => Math.round(v * 255))));
    device.queue
      .writeTexture(
        { texture: s.texture },
        data,
        { bytesPerRow: s.width * (s.format === 'rgba16float' ? 8 : 4), rowsPerImage: s.height },
        { width: s.width, height: s.height },
      )
      .unwrap();
  };
  const fill = (w: number, h: number, p: Tuple) => Array.from({ length: w * h }, () => p);
  async function read(s: ReturnType<typeof surface>) {
    const encoder = device.createCommandEncoder().unwrap();
    encoder.copyTextureToBuffer(
      { texture: s.texture },
      { buffer: readback, bytesPerRow: stride, rowsPerImage: oh },
      { width: ow, height: oh },
    );
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const mapped = (await readback.mapAsync(1)).unwrap();
    const bytes = new Uint8Array(mapped.getMappedRange().unwrap().slice(0));
    mapped.unmap();
    return Array.from({ length: ow * oh }, (_, i) => {
      const offset = Math.floor(i / ow) * stride + (i % ow) * (s.format === 'rgba16float' ? 8 : 4);
      return s.format === 'rgba16float'
        ? Array.from(new Uint16Array(bytes.buffer, offset, 4), unhalf)
        : Array.from(bytes.subarray(offset, offset + 4), (v) => v / 255);
    });
  }
  const tag = (x: number, y: number, depth: number, reactive = 0): Tuple => [
    x / 8192,
    y / 8192,
    depth,
    reactive,
  ];
  try {
    upload(scene, fill(iw, ih, [4, 2, 1, 0.5]));
    upload(oldColor, fill(ow, oh, [4, 2, 1, 0.5]));
    upload(oldTemporal, fill(ow, oh, [0, 0, -1, 0]));
    upload(oldMetadata, fill(ow, oh, [128 / 255, 0, 0, 1]));
    upload(decision, fill(iw, ih, [1, 0, 0, 1]));
    for (const pattern of ['ties', 'mixed', 'background', 'invalid', 'far-invalid'] as const)
      for (const phase of shape === 'rounding' ? [-0.25, 0.25] : [0, 0.25, -0.49]) {
        const input = Array.from({ length: iw * ih }, (_, i) => tag(i % iw, Math.floor(i / iw), 6));
        // An explicit input veto must survive otherwise valid full-resolution coverage.
        input[2 * iw + 4] = tag(4, 2, 6, 2);
        const full = Array.from({ length: ow * oh }, (_, i) => {
          const x = i % ow,
            y = Math.floor(i / ow);
          if (pattern === 'background') return tag(x, y, -1);
          if (pattern === 'invalid') return tag(x, y, 2, ((x + y) % 2) + 1);
          if (pattern === 'far-invalid')
            return tag(x, y, (x + y) % 7 === 0 ? 7 : 2, (x + y) % 7 === 0 ? 2 : 0);
          if (pattern === 'mixed')
            return tag(
              x,
              y,
              x < 9 && y < 9 ? -1 : (x * 3 + y * 5) % 4 === 0 ? 1 : 3,
              (x + y) % 11 === 0 ? 2 : 0,
            );
          return tag(x, y, 2);
        });
        upload(temporal, input);
        upload(coverage, full);
        const data = new ArrayBuffer(64),
          f = new Float32Array(data),
          u = new Uint32Array(data);
        f.set([phase / iw, -phase / ih, 0, 0, iw, ih, iw, ih]);
        u.set([1, 1, 1, 0, 1], 8);
        f[13] = 1 / 60;
        device.queue.writeBuffer(params, 0, new Uint8Array(data)).unwrap();
        const reads = [
          scene,
          temporal,
          oldColor,
          oldTemporal,
          oldMetadata,
          decision,
          secondary,
          coverage,
        ];
        const dispatch = (active: typeof program, lane: 'compute' | 'raster' = execution) => {
          const group = device
            .createBindGroup({
              layout: active.layout,
              entries: [
                ...reads.map((s, binding) => ({
                  binding,
                  resource: { kind: 'textureView' as const, value: s.view },
                })),
                { binding: 8, resource: { kind: 'sampler', value: active.sampler } },
                { binding: 9, resource: { kind: 'buffer', value: { buffer: params } } },
                ...(lane === 'compute' ? [color, output, metadata] : []).map((s, i) => ({
                  binding: 10 + i,
                  resource: { kind: 'textureView' as const, value: s.view },
                })),
              ],
            })
            .unwrap();
          const encoder = device.createCommandEncoder().unwrap();
          if (lane === 'compute') {
            const pass = encoder.beginComputePass();
            pass.setPipeline(active.pipeline as ReturnType<typeof createTsrProgram>['pipeline']);
            pass.setBindGroup(0, group);
            pass.dispatchWorkgroups(Math.ceil(ow / 8), Math.ceil(oh / 8), 1);
            pass.end();
          } else {
            const pass = encoder.beginRenderPass({
              colorAttachments: [color, output, metadata].map((s) => ({
                view: s.view,
                loadOp: 'clear' as const,
                storeOp: 'store' as const,
              })),
            });
            pass.setPipeline(
              active.pipeline as ReturnType<typeof createTsrRasterProgram>['pipeline'],
            );
            pass.setBindGroup(0, group);
            pass.draw(3);
            pass.end();
          }
          device.queue.submit([encoder.finish().unwrap()]).unwrap();
        };
        dispatch(program);
        const tuples = await read(output),
          support = await read(metadata),
          colors = await read(color);
        if (reference) {
          dispatch(reference);
          const expectedTuples = await read(output),
            expectedSupport = await read(metadata),
            expectedColors = await read(color);
          for (let y = 0; y < oh; y++)
            for (const x of columns) {
              const index = y * ow + x,
                context = `${pattern}/${phase} at ${x},${y}`;
              expect(tuples[index], context).toEqual(expectedTuples[index]);
              expect(support[index], context).toEqual(expectedSupport[index]);
              expect(colors[index], context).toEqual(expectedColors[index]);
            }
          continue;
        }
        verifyCpuGeometry({
          input,
          full,
          inputSize: [iw, ih],
          outputSize: [ow, oh],
          columns,
          jitter: [f[0] ?? 0, f[1] ?? 0],
          tuples,
          support,
          colors,
          label: `${pattern}/${phase}`,
        });
      }
  } finally {
    await device.queue.onSubmittedWorkDone();
    for (const texture of textures) device.destroyTexture(texture).unwrap();
    device.destroyBuffer(readback).unwrap();
    device.destroyBuffer(params).unwrap();
  }
}
