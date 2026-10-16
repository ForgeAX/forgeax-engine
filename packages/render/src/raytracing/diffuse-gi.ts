import type {
  BindGroup,
  Buffer,
  ComputePipeline,
  RhiCommandEncoder,
  RhiDevice,
  RhiError,
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
  if (
    !Number.isInteger(s.resolution) ||
    s.resolution < 8 ||
    s.resolution > 512 ||
    !Number.isInteger(s.cardResolution) ||
    s.cardResolution < 8 ||
    s.cardResolution > 32 ||
    !Number.isInteger(s.samples) ||
    s.samples < 16 ||
    s.samples > 256 ||
    s.samples % 2 !== 0 ||
    !Number.isInteger(s.iterations) ||
    s.iterations < 0 ||
    s.iterations > 2 ||
    s.probeCounts.some((v) => !Number.isInteger(v) || v < 2 || v > 4) ||
    ![...s.probeOrigin, s.probeSpacing, ...s.environment].every((v) =>
      Number.isFinite(Math.fround(v)),
    ) ||
    s.probeSpacing <= 0 ||
    s.environment.some((v) => v < 0) ||
    request.lights.length > 4
  )
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
  for (const source of request.sources) {
    const instance = request.scene.find((v) => v.instanceId === source.instance.instanceId);
    if (
      !instance ||
      rayGeometryKey(
        instance,
        'missing' in instance.field ? 'missing' : instance.field.meshDigest,
      ) !== rayGeometryKey(source.instance, source.layout.meshDigest)
    )
      return rayReferenceFailure('GI capture and tracing snapshots disagree');
  }
  const lightData = packLights(request.lights);
  if (!lightData.ok) return lightData;
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
  const projections = new Uint8Array(
      Math.max(
        1,
        cards.entries.reduce((n, e) => n + e.projections.length, 0),
      ) * 80,
    ),
    pv = new DataView(projections.buffer);
  let index = 0;
  for (const entry of cards.entries)
    for (const projection of entry.projections) {
      projections.set(packCardProjection(projection), index * 80);
      pv.setUint32(index * 80 + 64, entry.instanceId, true);
      pv.setUint32(index * 80 + 68, 1, true);
      index++;
    }
  const probeCount = s.probeCounts.reduce((a, b) => a * b, 1);
  const bounds = giBounds(request.scene, s, projection.value);
  if (
    !Number.isFinite(bounds.distance) ||
    bounds.distance > 100000 ||
    bounds.bias >= s.probeSpacing * 0.5
  )
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
  f.set(projection.value.inverse, 24);
  f.set(projection.value.eye, 40);
  const data = {
    instances: scene.value.instances,
    fields: scene.value.fields,
    cards: projections,
    lights: lightData.value,
    surfaceA: new Uint8Array(texels * GI_SURFACE_STRIDE),
    surfaceB: new Uint8Array(texels * GI_SURFACE_STRIDE),
    probes: new Uint8Array(probeCount * s.samples * GI_PROBE_SAMPLE_STRIDE),
    field: new Uint8Array(pixels * GI_PIXEL_STRIDE),
    reference: new Uint8Array(pixels * GI_PIXEL_STRIDE),
    settings,
  };
  const buffers = {} as Record<keyof typeof data, Buffer>;
  for (const key of Object.keys(data) as (keyof typeof data)[]) {
    const b = make(key, data[key], key === 'settings');
    if (!b.ok) return fail(b);
    buffers[key] = b.value;
  }
  // Eight storage bindings fit the portable compute floor. Both cache generations are explicit.
  const bgl = device.createBindGroupLayout({
    entries: [
      ...Array.from({ length: 19 }, (_, binding) => ({
        binding,
        visibility: 4,
        ...(binding >= 9
          ? {
              texture: {
                sampleType: binding >= 17 ? ('depth' as const) : ('unfilterable-float' as const),
              },
            }
          : {
              buffer: {
                type:
                  binding === 8
                    ? ('uniform' as const)
                    : binding >= 5
                      ? ('storage' as const)
                      : ('read-only-storage' as const),
              },
            }),
      })),
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
  if (!bgl.ok) return fail(bgl);
  const views: TextureView[] = [];
  for (const c of [cards, view.value])
    for (const plane of CARD_PLANES) {
      const v = device.createTextureView(c.textures[plane], {});
      if (!v.ok) return fail(v);
      views.push(v.value);
    }
  for (const c of [cards, view.value]) {
    const v = device.createTextureView(c.textures.depth, {});
    if (!v.ok) return fail(v);
    views.push(v.value);
  }
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
        ...views.map((value, i) => ({
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
  const groups: BindGroup[] = [];
  for (const [read, write] of [
    [buffers.surfaceA, buffers.surfaceB],
    [buffers.surfaceB, buffers.surfaceA],
  ] as const) {
    const g = group(read, write, buffers.field);
    if (!g.ok) return fail(g);
    groups.push(g.value);
  }
  // Seed writes B; each feedback swap changes the source generation. Consumers bind the final one.
  const finalRead = s.iterations % 2 === 0 ? buffers.surfaceB : buffers.surfaceA;
  const other = s.iterations % 2 === 0 ? buffers.surfaceA : buffers.surfaceB;
  const fieldGroup = group(finalRead, other, buffers.field),
    referenceGroup = group(finalRead, other, buffers.reference);
  if (!fieldGroup.ok) return fail(fieldGroup);
  if (!referenceGroup.ok) return fail(referenceGroup);
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl.value] });
  if (!layout.ok) return fail(layout);
  const shader = await compile(device, { code: kernel, label: 'gi.transport' });
  if (!shader.ok) return fail(shader);
  const names = ['seed', 'feedback', 'traceProbes', 'gatherField', 'gatherReference'] as const;
  const pipelines = {} as Record<(typeof names)[number], ComputePipeline>;
  for (const name of names) {
    const p = device.createComputePipeline({
      label: `gi.${name}`,
      layout: layout.value,
      compute: { module: shader.value, entryPoint: name },
    });
    if (!p.ok) return fail(p);
    pipelines[name] = p.value;
  }
  // Logical owned buffer/texture bytes; borrowed material textures and driver overhead are excluded.
  for (const c of captures) bytes += c.bytes;
  const keys = request.sources.map(surfaceCardKey),
    sceneKeys = request.scene.map(sdfInstanceKey),
    lightingKey = JSON.stringify(request.lights),
    settingsKey = JSON.stringify(s);
  const forward = groups[0],
    backward = groups[1];
  if (!forward || !backward) return fail(rayReferenceFailure('missing GI generation bindings'));
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
        bindings: typeof fieldGroup.value,
        count: number,
        label: string,
      ) => {
        const p = encoder.beginComputePass({ label });
        p.setPipeline(pipeline);
        p.setBindGroup(0, bindings);
        p.dispatchWorkgroups(Math.ceil(count / 64));
        p.end();
      };
      dispatch(pipelines.seed, forward, texels, 'gi.seed');
      for (let i = 0; i < s.iterations; i++)
        dispatch(
          pipelines.feedback,
          i % 2 === 0 ? backward : forward,
          texels,
          `gi.feedback-${i + 1}`,
        );
      dispatch(pipelines.traceProbes, fieldGroup.value, probeCount * s.samples, 'gi.trace-probes');
      dispatch(pipelines.gatherField, fieldGroup.value, pixels, 'gi.gather-field');
      dispatch(pipelines.gatherReference, referenceGroup.value, pixels, 'gi.gather-reference');
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
