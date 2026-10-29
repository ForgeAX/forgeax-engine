import type {
  BindGroup,
  Buffer,
  ComputePipeline,
  PipelineLayout,
  RhiCommandEncoder,
  RhiDevice,
  RhiError,
  Sampler,
  ShaderModule,
  TextureView,
} from '@forgeax/engine-rhi';
import type { RayMaterialError } from '@forgeax/engine-shader';
import { ok, type Result } from '@forgeax/engine-types';
import { DeviceScope } from '../device/device-scope';
import { getOrCreateDirectDfgLut, materialUsesDirectDfgLut } from '../device/direct-dfg-lut';
import type { LightSnapshot } from '../render-system-extract';
import { captureViewProjection, type SurfaceViewProjection } from './capture-view';
import type { ResolveSurfaceTexture } from './material-bindings';
import { packLights } from './path-input';
import { type RayReferenceError, rayGeometryKey, rayReferenceFailure } from './scene';
import { packSdfScene, type SdfMeshInstance, sdfInstanceKey } from './sdf-query';
import {
  CARD_PLANES,
  createSurfaceCapture,
  packCardProjection,
  type SurfaceCapture,
  type SurfaceCardSource,
  surfaceCardKey,
} from './surface-cards';

export const GI_PIXEL_STRIDE = 80;
export const GI_SURFACE_STRIDE = 64;
export const GI_PROBE_SAMPLE_STRIDE = 32;
export const GiStatus = { background: 0, complete: 1, incomplete: 2, invalidMaterial: 3 } as const;
type GiBufferName =
  | 'instances'
  | 'fields'
  | 'cards'
  | 'lights'
  | 'surfaceA'
  | 'surfaceB'
  | 'probes'
  | 'field'
  | 'reference'
  | 'settings';
export interface DiffuseGiSettings {
  readonly view: SurfaceViewProjection;
  readonly resolution: number;
  readonly cardResolution: number;
  readonly probeOrigin: readonly [number, number, number];
  readonly probeSpacing: number;
  readonly probeCounts: readonly [number, number, number];
  readonly samples: number;
  /** Additional finite surface-scattering iterations after emission/analytic seed. */
  readonly iterations: number;
  readonly environment: readonly [number, number, number];
}
export interface DiffuseGi {
  readonly buffers: Readonly<{ surface: Buffer; probes: Buffer; field: Buffer; reference: Buffer }>;
  readonly view: SurfaceCapture;
  readonly cards: SurfaceCapture;
  readonly diagnostics: Readonly<{
    bytes: number;
    rayDistance: number;
    surfaceBias: number;
    probeCount: number;
    iterations: number;
  }>;
  /** A complete frozen generation; caller alone owns submission and retirement after completion. */
  record(encoder: RhiCommandEncoder): Result<void, RayReferenceError>;
  dispose(): void;
}
type Failure = RayReferenceError | RayMaterialError | RhiError;
/** Opt-in bounded GI experiment, no runtime compiler or implicit World/Renderer installation. */
export async function createDiffuseGi(
  device: RhiDevice,
  compile: (
    device: RhiDevice,
    desc: { code: string; label?: string },
  ) => Promise<Result<ShaderModule, RhiError>>,
  request: {
    readonly kernel: string;
    /** Cooked DIRECT_DFG_LUT_AVAILABLE variant, required by opted-in source materials. */
    readonly kernelLut?: string;
    readonly sources: readonly SurfaceCardSource[];
    /** Complete tracing snapshot, including explicitly missing representations. */
    readonly scene: readonly SdfMeshInstance[];
    readonly lights: readonly LightSnapshot[];
    readonly settings: DiffuseGiSettings;
    readonly resolveTexture?: ResolveSurfaceTexture;
  },
): Promise<Result<DiffuseGi, Failure>> {
  const s = request.settings;
  const admitted = admitGiRequest(request);
  if (!admitted.ok) return admitted;
  const { kernel, usesLut, projection, scene, lightData } = admitted.value;
  const owned: Buffer[] = [],
    captures: SurfaceCapture[] = [];
  let bytes = 0;
  const scope = usesLut ? DeviceScope.create(0, 'diffuse-gi') : undefined;
  const dispose = () => {
    for (const b of owned) device.destroyBuffer(b);
    for (const c of captures) c.dispose();
    owned.length = 0;
    captures.length = 0;
    scope?.dispose();
  };
  const fail = <E>(result: Result<never, E>) => {
    dispose();
    return result;
  };
  const make = (label: string, data: Uint8Array, uniform = false) => {
    const b = device.createBuffer({
      label: `gi.${label}`,
      size: data.byteLength,
      usage: (uniform ? 64 : 128) | 12,
    });
    if (!b.ok) return b;
    owned.push(b.value);
    bytes += data.byteLength;
    const w = device.queue.writeBuffer(b.value, 0, data);
    return w.ok ? b : w;
  };
  const lut = scope === undefined ? undefined : getOrCreateDirectDfgLut(device, scope);
  if (lut !== undefined && !lut.ok) return fail(lut);
  const directDfgLut = lut?.value;
  if (directDfgLut !== undefined) bytes += 1024;
  const capture = await createSurfaceCapture(
    device,
    compile,
    request.sources,
    { kind: 'cards', resolution: s.cardResolution },
    request.resolveTexture,
  );
  if (!capture.ok) return fail(capture);
  captures.push(capture.value);
  const view = await createSurfaceCapture(
    device,
    compile,
    request.sources,
    { kind: 'view', resolution: s.resolution, projection: s.view },
    request.resolveTexture,
  );
  if (!view.ok) return fail(view);
  captures.push(view.value);
  const cards = capture.value,
    texels = cards.width * cards.height,
    pixels = s.resolution * s.resolution;
  const { projections, count: index } = packGiCardProjections(cards);
  const probeCount = s.probeCounts.reduce((a, b) => a * b, 1);
  const bounds = giBounds(request.scene, s, projection);
  if (exceedsGiDomain(bounds, s.probeSpacing))
    return fail(
      rayReferenceFailure('GI domain is too large or SDF uncertainty exceeds half a probe cell'),
    );
  const settings = new Uint8Array(176),
    f = new Float32Array(settings.buffer),
    u = new Uint32Array(settings.buffer);
  f.set([...s.environment, bounds.distance], 0);
  f.set([...s.probeOrigin, s.probeSpacing], 4);
  u.set([...s.probeCounts, s.samples], 8);
  u.set([request.scene.length, index, s.cardResolution, request.lights.length], 12);
  u.set([s.resolution, probeCount, s.iterations, 0], 16);
  f.set([bounds.bias, 0, 0, 0], 20);
  f.set(projection.inverse, 24);
  f.set(projection.eye, 40);
  const data: Record<GiBufferName, Uint8Array> = {
    instances: scene.instances,
    fields: scene.fields,
    cards: projections,
    lights: lightData,
    surfaceA: new Uint8Array(texels * GI_SURFACE_STRIDE),
    surfaceB: new Uint8Array(texels * GI_SURFACE_STRIDE),
    probes: new Uint8Array(probeCount * s.samples * GI_PROBE_SAMPLE_STRIDE),
    field: new Uint8Array(pixels * GI_PIXEL_STRIDE),
    reference: new Uint8Array(pixels * GI_PIXEL_STRIDE),
    settings,
  };
  const buffers = {} as Record<GiBufferName, Buffer>;
  for (const key of Object.keys(data) as GiBufferName[]) {
    const b = make(key, data[key], key === 'settings');
    if (!b.ok) return fail(b);
    buffers[key] = b.value;
  }
  const bindings = createGiBindings(device, buffers, cards, view.value, directDfgLut, s.iterations);
  if (!bindings.ok) return fail(bindings);
  const { bgl, forward, backward, fieldGroup, referenceGroup, finalRead } = bindings.value;
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
  if (!layout.ok) return fail(layout);
  const shader = await compile(device, { code: kernel, label: 'gi.transport' });
  if (!shader.ok) return fail(shader);
  const pipelines = createGiPipelines(device, layout.value, shader.value);
  if (!pipelines.ok) return fail(pipelines);
  // Logical owned buffer/texture bytes; borrowed material textures and driver overhead are excluded.
  for (const c of captures) bytes += c.bytes;
  const keys = request.sources.map(surfaceCardKey),
    sceneKeys = request.scene.map(sdfInstanceKey),
    lightingKey = JSON.stringify(request.lights),
    settingsKey = JSON.stringify(s);
  let disposed = false;
  return ok({
    buffers: {
      surface: finalRead,
      probes: buffers.probes,
      field: buffers.field,
      reference: buffers.reference,
    },
    view: view.value,
    cards,
    diagnostics: {
      bytes,
      rayDistance: bounds.distance,
      surfaceBias: bounds.bias,
      probeCount,
      iterations: s.iterations,
    },
    record(encoder) {
      if (disposed) return rayReferenceFailure('GI batch is disposed');
      if (
        JSON.stringify(request.lights) !== lightingKey ||
        JSON.stringify(s) !== settingsKey ||
        request.sources.length !== keys.length ||
        request.scene.length !== sceneKeys.length ||
        request.sources.some((v, i) => surfaceCardKey(v) !== keys[i]) ||
        request.scene.some((v, i) => sdfInstanceKey(v) !== sceneKeys[i])
      )
        return rayReferenceFailure('GI snapshot changed; create a new generation before recording');
      const a = cards.record(encoder);
      if (!a.ok) return a;
      const b = view.value.record(encoder);
      if (!b.ok) return b;
      const dispatch = (
        pipeline: ComputePipeline,
        bindings: BindGroup,
        count: number,
        label: string,
      ) => {
        const p = encoder.beginComputePass({ label });
        p.setPipeline(pipeline);
        p.setBindGroup(0, bindings);
        p.dispatchWorkgroups(Math.ceil(count / 64));
        p.end();
      };
      dispatch(pipelines.value.seed, forward, texels, 'gi.seed');
      for (let i = 0; i < s.iterations; i++)
        dispatch(
          pipelines.value.feedback,
          i % 2 === 0 ? backward : forward,
          texels,
          `gi.feedback-${i + 1}`,
        );
      dispatch(pipelines.value.traceProbes, fieldGroup, probeCount * s.samples, 'gi.trace-probes');
      dispatch(pipelines.value.gatherField, fieldGroup, pixels, 'gi.gather-field');
      dispatch(pipelines.value.gatherReference, referenceGroup, pixels, 'gi.gather-reference');
      return ok(undefined);
    },
    dispose() {
      if (!disposed) {
        disposed = true;
        dispose();
      }
    },
  });
}
/** Validate every CPU input before any GPU resource exists. */
function admitGiRequest(request: Parameters<typeof createDiffuseGi>[2]) {
  const s = request.settings;
  const usesLut = request.sources.some((source) =>
    source.sections.some((section) =>
      materialUsesDirectDfgLut(section.material.program.paramSchema),
    ),
  );
  const kernel = usesLut ? request.kernelLut : request.kernel;
  if (kernel === undefined)
    return rayReferenceFailure(
      'LUT material requires the cooked DIRECT_DFG_LUT_AVAILABLE GI kernel',
    );
  if (!validGiSettings(s, request.lights.length))
    return rayReferenceFailure(
      'GI requires 8..512 view, 8..32 cards, 16..256 even samples, 0..2 iterations, 2..4 probes per axis, positive spacing, finite nonnegative environment and at most 4 lights',
      true,
    );
  const projection = captureViewProjection(s.view);
  if (!projection.ok) return projection;
  if (
    request.scene.some(
      (m) => !('missing' in m.field) && m.field.policy.kind === 'sampled-visibility',
    )
  )
    return rayReferenceFailure(
      'sampled visibility is not admitted by the geometric diffuse diagnostic',
      true,
    );
  const scene = packSdfScene(request.scene);
  if (!scene.ok) return scene;
  if (!capturesMatchTracing(request.sources, request.scene))
    return rayReferenceFailure('GI capture and tracing snapshots disagree');
  const lightData = packLights(request.lights);
  if (!lightData.ok) return lightData;
  return ok({
    kernel,
    usesLut,
    projection: projection.value,
    scene: scene.value,
    lightData: lightData.value,
  });
}

/** Kernel layout plus both feedback generations and the final field/reference bindings. */
function createGiBindings(
  device: RhiDevice,
  buffers: Readonly<Record<GiBufferName, Buffer>>,
  cards: SurfaceCapture,
  view: SurfaceCapture,
  directDfgLut: { readonly view: TextureView; readonly sampler: Sampler } | undefined,
  iterations: number,
) {
  // Eight storage bindings fit the portable compute floor. Both cache generations are explicit.
  const bgl = device.createBindGroupLayout({
    entries: [
      ...Array.from({ length: 19 }, (_, binding) => giKernelLayoutEntry(binding)),
      ...(directDfgLut === undefined
        ? []
        : [
            {
              binding: 19,
              visibility: 4,
              texture: { sampleType: 'float' as const, viewDimension: '2d' as const },
            },
            { binding: 20, visibility: 4, sampler: { type: 'filtering' as const } },
          ]),
    ],
  });
  if (!bgl.ok) return bgl;
  const views = createGiCaptureViews(device, cards, view);
  if (!views.ok) return views;
  const group = (read: Buffer, write: Buffer, output: Buffer) =>
    device.createBindGroup({
      layout: bgl.value,
      entries: [
        ...[
          buffers.instances,
          buffers.fields,
          buffers.cards,
          buffers.lights,
          read,
          write,
          buffers.probes,
          output,
          buffers.settings,
        ].map((buffer, binding) => ({
          binding,
          resource: { kind: 'buffer' as const, value: { buffer } },
        })),
        ...views.value.map((value, i) => ({
          binding: i + 9,
          resource: { kind: 'textureView' as const, value },
        })),
        ...(directDfgLut === undefined
          ? []
          : [
              { binding: 19, resource: { kind: 'textureView' as const, value: directDfgLut.view } },
              { binding: 20, resource: { kind: 'sampler' as const, value: directDfgLut.sampler } },
            ]),
      ],
    });
  const forward = group(buffers.surfaceA, buffers.surfaceB, buffers.field);
  if (!forward.ok) return forward;
  const backward = group(buffers.surfaceB, buffers.surfaceA, buffers.field);
  if (!backward.ok) return backward;
  // Seed writes B; each feedback swap changes the source generation. Consumers bind the final one.
  const finalRead = iterations % 2 === 0 ? buffers.surfaceB : buffers.surfaceA;
  const other = iterations % 2 === 0 ? buffers.surfaceA : buffers.surfaceB;
  const fieldGroup = group(finalRead, other, buffers.field),
    referenceGroup = group(finalRead, other, buffers.reference);
  if (!fieldGroup.ok) return fieldGroup;
  if (!referenceGroup.ok) return referenceGroup;
  return ok({
    bgl: bgl.value,
    forward: forward.value,
    backward: backward.value,
    fieldGroup: fieldGroup.value,
    referenceGroup: referenceGroup.value,
    finalRead,
  });
}

function exceedsGiDomain(
  bounds: { distance: number; bias: number },
  probeSpacing: number,
): boolean {
  return (
    !Number.isFinite(bounds.distance) ||
    bounds.distance > 100000 ||
    bounds.bias >= probeSpacing * 0.5
  );
}

/** View, card, sample, iteration, probe-grid, environment and light bounds of the experiment. */
function validGiSettings(s: DiffuseGiSettings, lightCount: number): boolean {
  return (
    validGiSampling(s) &&
    s.probeCounts.every((v) => Number.isInteger(v) && v >= 2 && v <= 4) &&
    [...s.probeOrigin, s.probeSpacing, ...s.environment].every((v) =>
      Number.isFinite(Math.fround(v)),
    ) &&
    s.probeSpacing > 0 &&
    s.environment.every((v) => v >= 0) &&
    lightCount <= 4
  );
}

function validGiSampling(s: DiffuseGiSettings): boolean {
  return (
    isIntegerIn(s.resolution, 8, 512) &&
    isIntegerIn(s.cardResolution, 8, 32) &&
    isIntegerIn(s.samples, 16, 256) &&
    s.samples % 2 === 0 &&
    isIntegerIn(s.iterations, 0, 2)
  );
}

function isIntegerIn(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

/** Does every captured source name the same geometry the tracing snapshot traverses? */
function capturesMatchTracing(
  sources: readonly SurfaceCardSource[],
  scene: readonly SdfMeshInstance[],
): boolean {
  return sources.every((source) => {
    const instance = scene.find((v) => v.instanceId === source.instance.instanceId);
    return (
      instance !== undefined &&
      rayGeometryKey(
        instance,
        'missing' in instance.field ? 'missing' : instance.field.meshDigest,
      ) === rayGeometryKey(source.instance, source.layout.meshDigest)
    );
  });
}

/** Card projections tagged with their instance, at least one zero row. */
function packGiCardProjections(cards: SurfaceCapture): { projections: Uint8Array; count: number } {
  const projections = new Uint8Array(
      Math.max(
        1,
        cards.entries.reduce((n, e) => n + e.projections.length, 0),
      ) * 80,
    ),
    pv = new DataView(projections.buffer);
  let count = 0;
  for (const entry of cards.entries)
    for (const projection of entry.projections) {
      projections.set(packCardProjection(projection), count * 80);
      pv.setUint32(count * 80 + 64, entry.instanceId, true);
      pv.setUint32(count * 80 + 68, 1, true);
      count++;
    }
  return { projections, count };
}

// Eight storage bindings fit the portable compute floor; bindings 9.. are capture planes.
function giKernelLayoutEntry(binding: number) {
  if (binding >= 9)
    return {
      binding,
      visibility: 4,
      texture: {
        sampleType: binding >= 17 ? ('depth' as const) : ('unfilterable-float' as const),
      },
    };
  return {
    binding,
    visibility: 4,
    buffer: {
      type:
        binding === 8
          ? ('uniform' as const)
          : binding >= 5
            ? ('storage' as const)
            : ('read-only-storage' as const),
    },
  };
}

/** Card planes for both captures, then both depth planes, in kernel binding order. */
function createGiCaptureViews(
  device: RhiDevice,
  cards: SurfaceCapture,
  view: SurfaceCapture,
): Result<TextureView[], RhiError> {
  const views: TextureView[] = [];
  for (const c of [cards, view])
    for (const plane of CARD_PLANES) {
      const v = device.createTextureView(c.textures[plane], {});
      if (!v.ok) return v;
      views.push(v.value);
    }
  for (const c of [cards, view]) {
    const v = device.createTextureView(c.textures.depth, {});
    if (!v.ok) return v;
    views.push(v.value);
  }
  return ok(views);
}

const GI_KERNELS = ['seed', 'feedback', 'traceProbes', 'gatherField', 'gatherReference'] as const;

function createGiPipelines(
  device: RhiDevice,
  layout: PipelineLayout,
  module: ShaderModule,
): Result<Record<(typeof GI_KERNELS)[number], ComputePipeline>, RhiError> {
  const pipelines = {} as Record<(typeof GI_KERNELS)[number], ComputePipeline>;
  for (const name of GI_KERNELS) {
    const p = device.createComputePipeline({
      label: `gi.${name}`,
      layout,
      compute: { module, entryPoint: name },
    });
    if (!p.ok) return p;
    pipelines[name] = p.value;
  }
  return ok(pipelines);
}

function giBounds(
  scene: readonly SdfMeshInstance[],
  s: DiffuseGiSettings,
  projection: { inverse: Float32Array; depth: number },
): { distance: number; bias: number } {
  const points: number[][] = [
    Array.from(s.probeOrigin),
    s.probeOrigin.map((v, i) => v + ((s.probeCounts[i] ?? 0) - 1) * s.probeSpacing),
  ];
  const inv = projection.inverse;
  for (let corner = 0; corner < 8; corner++) {
    const p = [corner & 1 ? 1 : -1, corner & 2 ? 1 : -1, corner & 4 ? 1 : 0, 1];
    const w = p.reduce((sum, v, i) => sum + v * (inv[i * 4 + 3] ?? 0), 0);
    points.push(
      [0, 1, 2].map((a) => p.reduce((sum, v, i) => sum + v * (inv[i * 4 + a] ?? 0), 0) / w),
    );
  }
  let bias = 1e-4 + projection.depth / 1024;
  for (const instance of scene) {
    const { field, transform: m } = instance;
    if (!('missing' in field) && field.policy.kind !== 'sampled-visibility')
      bias = Math.max(
        bias,
        (2 * field.policy.errorBound + field.spacing * 0.02) *
          Math.hypot(...[0, 1, 2, 4, 5, 6, 8, 9, 10].map((i) => m[i] ?? 0)) +
          projection.depth / 1024,
      );
    for (let corner = 0; corner < 8; corner++) {
      const p = [0, 1, 2].map((a) =>
        corner & (1 << a) ? (field.bounds.max[a] ?? 0) : (field.bounds.min[a] ?? 0),
      );
      points.push(
        [0, 1, 2].map(
          (a) =>
            (m[a] ?? 0) * (p[0] ?? 0) +
            (m[4 + a] ?? 0) * (p[1] ?? 0) +
            (m[8 + a] ?? 0) * (p[2] ?? 0) +
            (m[12 + a] ?? 0),
        ),
      );
    }
  }
  const spans = [0, 1, 2].map(
    (a) => Math.max(...points.map((p) => p[a] ?? 0)) - Math.min(...points.map((p) => p[a] ?? 0)),
  );
  return { distance: Math.hypot(...spans) + bias * 4 + 1, bias };
}
