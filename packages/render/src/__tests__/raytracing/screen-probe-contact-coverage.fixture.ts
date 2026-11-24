import { buildVisibilityDistanceField } from '@forgeax/engine-geometry';
import { SDF_SURFACE_AFFINE_LOCAL_RAY_WGSL } from '../../../../shader/src/sdf-surface-interval-wgsl';
import { SDF_SURFACE_INVERSE_WGSL } from '../../../../shader/src/sdf-surface-pool-wgsl';
import { SDF_SURFACE_RAY_USABLE_WGSL } from '../../../../shader/src/sdf-surface-root-request-wgsl';
import { SDF_SURFACE_TRACE_RECEIVER_WGSL } from '../../../../shader/src/sdf-surface-trace-wgsl';
import { packFieldReceiverGpuSource } from '../../raytracing/field-receiver-texture';
import { packGlobalSdfComposition } from '../../raytracing/global-sdf';
import type { SceneFieldReceiverProof } from '../../raytracing/scene-field-projection';
import { screenProbeWorldWgsl } from '../../raytracing/screen-probe-kernels';
import {
  packScreenProbeFrame,
  planScreenProbeLayout,
  SCREEN_PROBE_DEFAULTS,
} from '../../raytracing/screen-probe-plan';
import {
  SCREEN_PROBE_CONTACT_WGSL,
  screenProbeReceiverWgsl,
} from '../../raytracing/screen-probe-receiver';
import type { SdfSurfaceCoverage } from '../../raytracing/sdf-surface-coverage';
import { endpointFunction } from './sdf-surface-endpoint-aggregation.fixture';

const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
export const PREPARE_OPAQUE_GATE = '||(!local&&!sdfSurfacePrimitiveOpaque(packet,primitive))';
export const CONTACT_OPAQUE_GATE =
  '||(!local&&!sdfSurfacePrimitiveOpaque(packet,probe.receiverPrimitive))';
export type ContactVariant = 'production' | 'prepare-removed' | 'contact-removed';

function removeOnce(source: string, gate: string) {
  if (source.split(gate).length !== 2) throw Error('One actual owning opacity gate required');
  return source.replace(gate, '');
}

/** The real World's contact rejection branch is observed before traversal.
 * A successful admission stays WORLD, never a fabricated miss or resolved GI. */
export function screenContactCoverageCode(variant: ContactVariant = 'production') {
  const actual = screenProbeWorldWgsl('global-sdf');
  const start = actual.indexOf('fn withStatus('),
    entry = actual.indexOf('fn traceWorldProbes(', start),
    end = actual.indexOf(' let origin=', entry);
  if (
    start < 0 ||
    entry < start ||
    end < entry ||
    actual.indexOf('fn traceWorldProbes(', entry + 1) !== -1
  )
    throw Error('One actual World admission prefix required');
  const prefix = actual.slice(start, end);
  let prepare = screenProbeReceiverWgsl(),
    contact = SCREEN_PROBE_CONTACT_WGSL;
  if (variant === 'prepare-removed') prepare = removeOnce(prepare, PREPARE_OPAQUE_GATE);
  if (variant === 'contact-removed') contact = removeOnce(contact, CONTACT_OPAQUE_GATE);
  return {
    prefix,
    code: `${prepare}
${SDF_SURFACE_AFFINE_LOCAL_RAY_WGSL}${SDF_SURFACE_INVERSE_WGSL}${SDF_SURFACE_RAY_USABLE_WGSL}
${endpointFunction(SDF_SURFACE_TRACE_RECEIVER_WGSL, 'sdfSurfaceVertex')}
struct SdfSurfaceContact { row:u32, primitive:u32, valid:u32 }
${contact}
@group(0) @binding(7) var<storage,read_write> rays:array<ProbeRay>;
@group(0) @binding(8) var<storage,read> probesIn:array<ScreenProbe>;
${prefix}
 rays[i]=ray;
}
`,
  };
}

export async function screenContactCoverageCases(
  options: {
    readonly receiverProof?: SceneFieldReceiverProof;
    readonly reconstruction?: 'current-support';
    readonly transform?: Float32Array;
    readonly twoSided?: boolean;
  } = {},
) {
  const field = (
    await buildVisibilityDistanceField(
      new Float32Array([-2, -2, 0.5, 2, -2, 0.5, 0, 2, 0.5, 2, -2, 0.5, 6, -2, 0.5, 4, 2, 0.5]),
      new Uint32Array([0, 1, 2, 3, 4, 5]),
      { voxelSize: 1, triangleSidedness: new Uint8Array(2).fill(options.twoSided ? 1 : 0) },
    )
  ).unwrap();
  const make = (name: string, coverage: SdfSurfaceCoverage, ready: boolean, epoch = 3) => {
    const composition = packGlobalSdfComposition(
      [
        {
          instanceId: 7,
          geometryId: 0,
          mask: 1,
          transform: options.transform ?? identity,
          field,
          surfaceCoverage: coverage,
        },
      ],
      {
        origin: [-4, -4, -2],
        dimensions: [8, 8, 4],
        spacing: 2,
        maxDistance: 8,
        coverageDistance: 1,
      },
      { index: false, capacity: 1, sourceEpoch: epoch },
    ).unwrap();
    if (!(composition.data.fields instanceof Uint8Array) || !composition.sourceExpected)
      throw Error('Actual Global Uint8 packet and independent expected tuple required');
    const expected = composition.sourceExpected;
    const source = packFieldReceiverGpuSource(
      [
        {
          rasterRow: 1,
          canonicalRow: 0,
          primitiveFirst: 0,
          primitiveCount: 2,
          forward: options.transform ?? identity,
          receiverProof: options.receiverProof ?? 'opaque-primitive',
        },
      ],
      1,
      expected,
      7,
      9,
      { maxTextureDimension2D: 1024, maxBytes: 1024 },
    ).unwrap();
    const query = new Uint8Array(8);
    new Uint32Array(query.buffer)[0] = 256;
    new Float32Array(query.buffer)[1] = 0.25;
    const frame = packScreenProbeFrame({
      ...(options.reconstruction ? { reconstruction: options.reconstruction } : {}),
      layout: planScreenProbeLayout(
        { ...SCREEN_PROBE_DEFAULTS, downsample: 4, adaptiveFraction: 0 },
        4,
        4,
      ),
      downsample: 4,
      frameIndex: 7,
      receiverRevision: 9,
      importance: 'uniform',
      screenSteps: 0,
      thickness: 0.01,
      environment: [0, 0, 0],
      maxDistance: 1,
      shortRangeAo: 0,
      maxFrames: 1,
      sceneHistory: false,
      pixelHistory: false,
      probeHistory: false,
      worldBias: 0,
      cardMargin: 0,
      query,
      reprojection: undefined,
      worldSource: { traversal: 'global-sdf', expected },
    });
    return { name, composition, source, frame, ready };
  };
  const partial = (bits: number): SdfSurfaceCoverage => ({
    kind: 'partial',
    opaquePrimitives: Uint32Array.of(bits),
  });
  const cases = [
    make('opaque-selected', partial(1), true),
    make('unknown-selected', partial(2), false),
    make('all-unknown', 'unknown', false),
  ];
  for (const mode of ['missing-record', 'corrupt-tail'] as const) {
    const row = make(mode, partial(1), false),
      words = new Uint32Array(row.composition.data.fields.buffer);
    const record = words[7] ?? 0;
    if (mode === 'missing-record') words[record] = 0xffffffff;
    else words[(words[record + 3] ?? 0) + 4] = 4;
    cases.push(row);
  }
  cases.push(make('new-source-epoch', partial(1), true, 4));
  return cases;
}
export type ContactCoverageCase = Awaited<ReturnType<typeof screenContactCoverageCases>>[number];

export async function createContactCoveragePipelines(device: GPUDevice) {
  const pipeline = (variant: ContactVariant, entryPoint: string) =>
    device.createComputePipelineAsync({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({ code: screenContactCoverageCode(variant).code }),
        entryPoint,
      },
    });
  return {
    prepare: await pipeline('production', 'prepareScreenReceivers'),
    world: await pipeline('production', 'traceWorldProbes'),
    faultyPrepare: await pipeline('prepare-removed', 'prepareScreenReceivers'),
    faultyContact: await pipeline('contact-removed', 'traceWorldProbes'),
  };
}

/** Small real texture/buffer work, borrowing the existing Dawn device. No new
 * adapter, controller, geometry implementation or World query is introduced. */
export interface ContactRasterFixture {
  readonly pipeline: GPURenderPipeline;
  readonly positions: Float32Array;
  readonly viewProjection: Float32Array;
  readonly rasterMatrix: Float32Array;
  readonly opacity: number;
  readonly direction: readonly [number, number, number];
}

export function contactCoverageWork(
  device: GPUDevice,
  row: ContactCoverageCase,
  raster?: ContactRasterFixture,
) {
  const buffers: GPUBuffer[] = [],
    textures: GPUTexture[] = [];
  const dispose = () => {
    for (const b of buffers) b.destroy();
    for (const t of textures) t.destroy();
  };
  const buffer = (data: Uint8Array | Float32Array, usage = 128 | 8 | 4) => {
    const value = device.createBuffer({ size: data.byteLength, usage });
    buffers.push(value);
    device.queue.writeBuffer(value, 0, data);
    return value;
  };
  const texture = (width: number, height: number, words: Uint32Array) => {
    const value = device.createTexture({
      size: [width, height],
      format: 'rgba32uint',
      usage: 2 | 4 | (raster ? 16 | 1 : 0),
    });
    textures.push(value);
    device.queue.writeTexture({ texture: value }, words, { bytesPerRow: width * 16 }, [
      width,
      height,
    ]);
    return value;
  };
  try {
    const probeBytes = new Uint8Array(96);
    new Uint32Array(probeBytes.buffer)[7] = 0x10001;
    const rayBytes = new Uint8Array(64 * 32),
      rf = new Float32Array(rayBytes.buffer),
      ru = new Uint32Array(rayBytes.buffer);
    for (let i = 0; i < 64; i++) {
      rf.set(raster?.direction ?? [0, 0, 1], i * 8);
      ru[i * 8 + 3] = 1 << 12;
    }
    const grid = buffer(row.composition.data.settings, 64 | 8),
      instances = buffer(row.composition.data.instances),
      fields = buffer(row.composition.data.fields);
    const probes = buffer(probeBytes),
      worldProbes = buffer(probeBytes),
      rays = buffer(rayBytes),
      frame = buffer(row.frame, 64 | 8),
      view = buffer(raster?.viewProjection ?? identity, 64 | 8);
    const visible = new Uint32Array(4 * 4 * 4);
    for (let i = 0; i < 16; i++) visible.set([1, 0, 0, 1], i * 4);
    const visibleTexture = texture(4, 4, visible),
      visibleView = visibleTexture.createView(),
      sourceView = texture(row.source.width, row.source.height, row.source.words).createView();
    const rasterWork = raster && {
      vertices: buffer(raster.positions, 32 | 8),
      group: device.createBindGroup({
        layout: raster.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: buffer(raster.rasterMatrix, 64 | 8) } },
          {
            binding: 1,
            resource: { buffer: buffer(Float32Array.of(raster.opacity, 0.5, 0, 0), 64 | 8) },
          },
        ],
      }),
    };
    const prepareEntries: GPUBindGroupEntry[] = [
      [1, grid],
      [2, instances],
      [3, fields],
      [6, probes],
      [9, frame],
      [19, view],
    ].map(([binding, value]) => ({
      binding: binding as number,
      resource: { buffer: value as GPUBuffer },
    }));
    prepareEntries.push(
      { binding: 17, resource: visibleView },
      { binding: 18, resource: sourceView },
    );
    const worldEntries: GPUBindGroupEntry[] = [
      [1, grid],
      [2, instances],
      [3, fields],
      [7, rays],
      [8, worldProbes],
      [9, frame],
    ].map(([binding, value]) => ({
      binding: binding as number,
      resource: { buffer: value as GPUBuffer },
    }));
    const encode = (
      encoder: GPUCommandEncoder,
      p: GPUComputePipeline,
      entries: GPUBindGroupEntry[],
    ) => {
      const pass = encoder.beginComputePass();
      pass.setPipeline(p);
      pass.setBindGroup(0, device.createBindGroup({ layout: p.getBindGroupLayout(0), entries }));
      pass.dispatchWorkgroups(1);
      pass.end();
    };
    let lastVisible: Uint8Array | undefined;
    return {
      rasterVisible: () => lastVisible?.slice(),
      async run(p: GPUComputePipeline | undefined, w: GPUComputePipeline, oldProof?: Uint8Array) {
        device.queue.writeBuffer(rays, 0, rayBytes);
        if (oldProof) device.queue.writeBuffer(worldProbes, 0, oldProof);
        const encoder = device.createCommandEncoder();
        if (raster && rasterWork) {
          const pass = encoder.beginRenderPass({
            colorAttachments: [
              {
                view: visibleView,
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
              },
            ],
          });
          pass.setPipeline(raster.pipeline);
          pass.setBindGroup(0, rasterWork.group);
          pass.setVertexBuffer(0, rasterWork.vertices);
          pass.draw(3);
          pass.end();
        }
        if (p) {
          device.queue.writeBuffer(probes, 0, probeBytes);
          encode(encoder, p, prepareEntries);
          encoder.copyBufferToBuffer(probes, 0, worldProbes, 0, 96);
        }
        encode(encoder, w, worldEntries);
        const read = device.createBuffer({
          size: 96 + rayBytes.length + (raster ? 1024 : 0),
          usage: 1 | 8,
        });
        try {
          encoder.copyBufferToBuffer(worldProbes, 0, read, 0, 96);
          encoder.copyBufferToBuffer(rays, 0, read, 96, rayBytes.length);
          if (raster)
            encoder.copyTextureToBuffer(
              { texture: visibleTexture },
              { buffer: read, offset: 96 + rayBytes.length, bytesPerRow: 256 },
              [4, 4],
            );
          device.queue.submit([encoder.finish()]);
          await read.mapAsync(1);
          const bytes = new Uint8Array(read.getMappedRange().slice(0));
          read.unmap();
          if (raster) {
            lastVisible = new Uint8Array(256);
            for (let y = 0; y < 4; y++)
              lastVisible.set(
                bytes.subarray(96 + rayBytes.length + y * 256, 96 + rayBytes.length + y * 256 + 64),
                y * 64,
              );
          }
          return bytes.slice(0, 96 + rayBytes.length);
        } finally {
          read.destroy();
        }
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

export function checkContactCoverage(raw: Uint8Array, ready: boolean, status: 1 | 4) {
  if (raw.byteLength !== 96 + 64 * 32)
    throw Error('Complete actual probe and 64 World-admission records required');
  const words = new Uint32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  if (words[20] !== Number(ready)) throw Error('Incorrect actual reconstruction qualification');
  for (let ray = 0; ray < 64; ray++)
    if ((((words[24 + ray * 8 + 3] ?? 0) >>> 12) & 7) !== status)
      throw Error(
        'Incorrect actual World admission status: unavailable must not become miss/resolved',
      );
}
