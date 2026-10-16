import type {
  GraphBuffer,
  GraphResourceResolver,
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
  RenderGraphFrame,
} from '@forgeax/engine-render-graph';
import type { BindGroup, Buffer } from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import type { RenderPipelineFrame } from '../render-pipeline';
import type { RayDiffuseTargets } from './diffuse-graph';
import {
  type Binding,
  IRRADIANCE_FIELD_PENDING_OFFSET,
  IRRADIANCE_FIELD_REFLECTION_HISTORY_BYTES,
  IRRADIANCE_FIELD_REFLECTION_RAY_BYTES,
  type IrradianceFieldKernelInput,
  type IrradianceFieldKernelStage,
} from './irradiance-field';
import {
  type KernelGraphHandle,
  kernelGraphAccess,
  resolveKernelBinding,
} from './kernel-graph-access';
import { addCardAtlasPasses } from './probe-card-graph';
import type { IrradianceFieldExtent, PreparedIrradianceField } from './renderer-irradiance-field';
import type { PreparedWorldAcceleration } from './renderer-world-acceleration';

type ViewKernels = PreparedIrradianceField['view'];

type ViewRecordInput = 'reflectionRays' | 'reflectionSignal';
type RayQueryInput = 'tlas' | 'traversalInstances' | 'faceNormals';
/** Field-scoped handles; per-view reflection records are bound by their own passes.
 * The Ray Query handles exist exactly when the field selected that traversal. */
export type IrradianceFieldGraphHandles = Readonly<
  Record<Exclude<IrradianceFieldKernelInput, ViewRecordInput | RayQueryInput>, KernelGraphHandle> &
    Partial<Record<RayQueryInput, KernelGraphHandle>> & { visibility: GraphTextureView }
>;

/** Graph identity: one-shot producer passes, Card capture imports and the view extent
 * change topology. In-place installs and removals change capture buffers, so they re-plan. */
export function irradianceFieldGraphShape(prepared: PreparedIrradianceField) {
  const extent = prepared.extent();
  return [
    prepared.generation,
    prepared.composeRequired(),
    prepared.capture(),
    prepared.cards.capture.revision,
    prepared.cards.capture.bufferReads.length,
    prepared.cards.capture.textureReads.length,
    extent.width,
    extent.height,
    extent.gathered !== undefined,
    extent.reflection !== undefined,
  ];
}

/** Region -> Card surfaces -> Card light -> probe trace/update -> radiosity ->
 * view gather (-> upsample) -> the shared additive diffuse composite. */
export function addIrradianceFieldPasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  prepared: PreparedIrradianceField,
  target: RayDiffuseTargets,
  /** A consumer that samples the field itself (Screen Probe gather) replaces
   * the view gather/upsample/composite after the field and Card radiance are current. */
  consume?: (handles: IrradianceFieldGraphHandles) => Result<void, RenderGraphError>,
) {
  const current = () => {
    if (prepared.fence.currentGeneration() !== prepared.generation)
      throw new Error('stale irradiance field graph; prepare the current scene');
    return prepared;
  };
  const extent = prepared.extent();
  const region = prepared.region;
  const imported = (
    name: string,
    value: { readonly buffer: Buffer; readonly size: number },
    uniform = false,
  ) =>
    graph
      .importBuffer(
        `irradiance-field.${name}`,
        { size: value.size, usage: (uniform ? 64 : 128) | 12 },
        () => value.buffer,
      )
      .unwrap();
  const regionBuffers = Object.fromEntries(
    (['instances', 'fields', 'bounds', 'settings', 'voxels'] as const).map((name) => [
      name,
      imported(`region.${name}`, region.input[name], name === 'settings'),
    ]),
  ) as Record<'instances' | 'fields' | 'bounds' | 'settings' | 'voxels', GraphBuffer>;
  const visibilityTexture = graph
    .importTexture(
      'irradiance-field.visibility',
      prepared.visibility.descriptor,
      () => current().visibility.texture,
    )
    .unwrap();
  const visibility = graph
    .importView(visibilityTexture, { dimension: '3d' }, () => current().visibility.view)
    .unwrap();
  const b = prepared.buffers;
  const field = imported('field', b.field, true);
  const frameUniform = imported('frame', b.frame, true);
  const lights = imported('lights', b.lights, true);
  const irradiance = imported('irradiance', b.irradiance);
  const moments = imported('moments', b.moments);
  const meta = imported('meta', b.meta);
  const probeRays = imported('probe-rays', b.probeRays);
  const probeList = imported('probe-list', b.probeList);
  const probeOrigins = imported('probe-origins', b.probeOrigins);
  const surfaces = imported('card-surfaces', b.surfaces);
  const cardDirect = imported('card-direct', b.cardDirect);
  const cardLit = imported('card-lit', b.cardLit);
  const cardSettings = imported('card-settings', prepared.cards.settings, true);
  const extentBuffer = (
    name: string,
    size: number,
    pick: (value: IrradianceFieldExtent) => Buffer | undefined,
  ) =>
    graph
      .importBuffer(`irradiance-field.${name}`, { size, usage: 128 | 12 }, () => {
        const value = pick(current().extent());
        if (value === undefined) throw new Error(`irradiance field lost its ${name} buffer`);
        return value;
      })
      .unwrap();
  if (prepared.composeRequired()) {
    const composed = graph.addComputePass('irradiance-field.compose', {
      accesses: [
        ...(['instances', 'fields', 'bounds'] as const).map((name) => ({
          resource: regionBuffers[name],
          usage: 'storage-read' as const,
        })),
        { resource: regionBuffers.settings, usage: 'uniform-read' },
        { resource: regionBuffers.voxels, usage: 'storage-write' },
      ],
      encode: ({ pass }) => {
        current()
          .region.compose(pass, region.input, region.voxelCount, current().composeDispatch())
          .unwrap();
        prepared.markEncoded('compose');
      },
    });
    if (!composed.ok) return composed;
    const projected = graph.addComputePass('irradiance-field.visibility', {
      accesses: [
        { resource: regionBuffers.voxels, usage: 'storage-read' },
        { resource: regionBuffers.settings, usage: 'uniform-read' },
        { resource: visibility, usage: 'storage-write' },
      ],
      encode: ({ pass }) => {
        const value = current();
        pass.setPipeline(value.visibility.pipeline);
        pass.setBindGroup(0, value.visibility.group);
        pass.dispatchWorkgroups(Math.ceil(value.region.voxelCount / 64));
      },
    });
    if (!projected.ok) return projected;
  }
  const atlasPasses = addCardAtlasPasses(
    graph,
    'irradiance-field.card',
    prepared.cards,
    prepared.capture(),
    () => current().cards,
    (_frame, pass) => current().recordCapture(pass),
  );
  if (!atlasPasses.ok) return atlasPasses;
  const { atlas, projections } = atlasPasses.value;
  const traced = addWorldAccelerationPass(
    graph,
    prepared.acceleration,
    () => {
      const value = current().acceleration;
      if (value === undefined) throw new Error('irradiance field lost its world acceleration');
      return value;
    },
    field,
  );
  if (!traced.ok) return traced;
  const handles: IrradianceFieldGraphHandles = {
    ...traced.value,
    visibility,
    voxels: regionBuffers.voxels,
    grid: regionBuffers.settings,
    instances: regionBuffers.instances,
    fields: regionBuffers.fields,
    bounds: regionBuffers.bounds,
    cards: projections,
    cardSettings,
    lights,
    frame: frameUniform,
    field,
    surfaces,
    cardLit,
    probeRays,
    probeList,
    probeOrigins,
    irradiance,
    moments,
    meta,
    ...atlas,
  };
  /** One TS-kernel pass whose accesses are exactly the stage's binding roster. */
  const kernelPass = (
    label: string,
    stage: IrradianceFieldKernelStage,
    work: (value: PreparedIrradianceField) => number,
    before?: (value: PreparedIrradianceField) => void,
    after: readonly IrradianceFieldKernelStage[] = [],
    executeIf?: () => boolean,
  ) =>
    graph.addComputePass(`irradiance-field.${label}`, {
      accesses: kernelAccesses(prepared.kernels[stage].bindings, handles, 'storage-write'),
      ...(executeIf === undefined ? {} : { executeIf }),
      encode: ({ pass, resources }) => {
        const value = current();
        before?.(value);
        for (const recorded of [stage, ...after])
          value.kernels[recorded]
            .record(
              pass,
              kernelResolver(value.kernels[recorded].bindings, handles, resources),
              work(value),
            )
            .unwrap();
      },
    });
  // Card direct light is skipped (its buffers keep last frame's values) unless a
  // capture slice, light change or edit made it stale; the frame upload therefore
  // opens in the always-run probe trace, still before this frame's submit.
  const direct = () => current().schedule().direct;
  const tileThreads = () => current().schedule().tiles * prepared.plan.cardResolution ** 2;
  const surfaced = kernelPass(
    'card-surface',
    'cardSurface',
    (value) => value.schedule().tiles * value.plan.cardResolution ** 2,
    undefined,
    [],
    direct,
  );
  if (!surfaced.ok) return surfaced;
  const lit = graph.addComputePass('irradiance-field.card-lighting', {
    executeIf: direct,
    accesses: [
      { resource: frameUniform, usage: 'uniform-read' },
      { resource: lights, usage: 'uniform-read' },
      { resource: surfaces, usage: 'storage-read' },
      { resource: cardDirect, usage: 'storage-write' },
    ],
    encode: ({ pass, resources }) =>
      current()
        .view.lightCards.record(
          pass,
          [frameUniform, lights, surfaces, cardDirect].map((r) => ({
            buffer: resources.buffer(r).unwrap(),
          })),
          undefined,
          tileThreads(),
        )
        .unwrap(),
  });
  if (!lit.ok) return lit;
  const placed = kernelPass('place-probes', 'placeProbes', (value) => value.schedule().probes);
  if (!placed.ok) return placed;
  const probesTraced = kernelPass(
    'trace-probes',
    'traceProbes',
    (value) => value.schedule().probes * value.plan.raysPerProbe,
    (value) => value.writeFrame(),
  );
  if (!probesTraced.ok) return probesTraced;
  // The derive kernel's bindings are a subset of the update kernel's accesses.
  const updated = kernelPass(
    'update-probes',
    'updateProbes',
    (value) => value.schedule().probes,
    undefined,
    ['deriveProbes'],
  );
  if (!updated.ok) return updated;
  const fieldReads = fieldReadsOf(handles);
  const radiated = graph.addComputePass('irradiance-field.radiosity', {
    accesses: [
      { resource: frameUniform, usage: 'uniform-read' },
      { resource: surfaces, usage: 'storage-read' },
      { resource: cardDirect, usage: 'storage-read' },
      { resource: cardLit, usage: 'storage-write' },
      ...fieldReads,
    ],
    encode: ({ pass, resources }) => {
      const value = current();
      value.view.radiateCards
        .record(
          pass,
          [frameUniform, surfaces, cardDirect, cardLit].map((r) => ({
            buffer: resources.buffer(r).unwrap(),
          })),
          value.sample,
          tileThreads(),
        )
        .unwrap();
    },
  });
  if (!radiated.ok) return radiated;
  const scope = { graph, current, target, extent, handles, extentBuffer, view: viewUniform(graph) };
  const gathered =
    consume === undefined
      ? addFieldGatherPasses({ ...scope, label: 'irradiance-field' })
      : consume(handles);
  if (!gathered.ok) return gathered;
  return addFieldReflectionPasses(scope);
}

type Current = () => PreparedIrradianceField;
type ExtentBuffer = (
  name: string,
  size: number,
  pick: (value: IrradianceFieldExtent) => Buffer | undefined,
) => GraphBuffer;
type FieldHandles = IrradianceFieldGraphHandles;
type KernelHandles = Partial<Record<IrradianceFieldKernelInput, KernelGraphHandle>>;
type KernelBindings = readonly (readonly [number, Binding, IrradianceFieldKernelInput])[];

function kernelHandle(handles: KernelHandles, name: IrradianceFieldKernelInput) {
  const handle = handles[name];
  if (handle === undefined) throw new Error(`irradiance field graph has no ${name} handle`);
  return handle;
}

function kernelAccesses(
  bindings: KernelBindings,
  handles: KernelHandles,
  storage: 'storage-write' | 'storage-read-write',
) {
  return bindings.map(([, kind, name]) =>
    kernelGraphAccess(kind, kernelHandle(handles, name), storage),
  );
}

function kernelResolver(
  bindings: KernelBindings,
  handles: KernelHandles,
  resources: GraphResourceResolver,
) {
  const kinds = new Map(bindings.map(([, kind, name]) => [name, kind]));
  return (name: IrradianceFieldKernelInput) => {
    const kind = kinds.get(name);
    if (kind === undefined) throw new Error(`irradiance field kernel has no ${name} binding`);
    return resolveKernelBinding(resources, kind, kernelHandle(handles, name));
  };
}

/**
 * The `'ray-query'` lane's world: the TLAS and its traversal tables, built by
 * one copy pass before any trace reads them. Once the field generation's
 * acceleration settles, the pass stays declared (stable dependencies) but skips.
 */
export function addWorldAccelerationPass<FrameCtx extends RenderGraphFrame>(
  graph: RenderGraphBuilder<FrameCtx>,
  acceleration: PreparedWorldAcceleration | undefined,
  live: () => PreparedWorldAcceleration,
  /** The shared sampler rejects cache reads until this encoded roster is complete. */
  field?: GraphBuffer,
): Result<Partial<Record<RayQueryInput, KernelGraphHandle>>, RenderGraphError> {
  if (acceleration === undefined) return ok({});
  // Graph imports are frozen before encoding. Recovery must precede that
  // snapshot, otherwise traces and the coverage copy retain the abandoned TLAS.
  const frameResources = () => {
    const value = live();
    value.beginFrame().unwrap();
    return value.current();
  };
  const tlas = graph
    .importAccelerationStructure(
      'irradiance-field.world.tlas',
      { maxInstances: acceleration.maxInstances },
      () => frameResources().tlas,
    )
    .unwrap();
  const table = (name: 'traversalInstances' | 'faceNormals', label: string, size: number) =>
    graph
      .importBuffer(
        `irradiance-field.world.${label}`,
        { size, usage: 128 | 8 | (name === 'traversalInstances' ? 4 : 0) },
        () => frameResources()[name],
      )
      .unwrap();
  const traversalInstances = table(
    'traversalInstances',
    'traversal-instances',
    (acceleration.maxInstances + 1) * 16,
  );
  const faceNormals = table('faceNormals', 'face-normals', acceleration.maxTriangles * 16);
  const built = graph.addCopyPass('irradiance-field.world-acceleration', {
    accesses: [
      { resource: tlas, usage: 'acceleration-structure-build' },
      { resource: traversalInstances, usage: 'copy-dst' },
      { resource: faceNormals, usage: 'copy-dst' },
    ],
    executeIf: () => !live().settled(),
    encode: ({ encoder }) => live().record(encoder).unwrap(),
  });
  if (!built.ok) return built;
  if (field !== undefined) {
    const covered = graph.addCopyPass('irradiance-field.world-coverage', {
      accesses: [
        { resource: traversalInstances, usage: 'copy-src' },
        { resource: field, usage: 'copy-dst' },
      ],
      encode: ({ encoder, resources }) =>
        encoder.copyBufferToBuffer(
          resources.buffer(traversalInstances).unwrap(),
          0,
          resources.buffer(field).unwrap(),
          IRRADIANCE_FIELD_PENDING_OFFSET,
          4,
        ),
    });
    if (!covered.ok) return covered;
  }
  return ok({ tlas, traversalInstances, faceNormals });
}
interface ViewScope {
  readonly graph: RenderGraphBuilder<RenderPipelineFrame>;
  readonly current: Current;
  readonly target: RayDiffuseTargets;
  readonly extent: IrradianceFieldExtent;
  readonly handles: FieldHandles;
  readonly extentBuffer: ExtentBuffer;
  readonly view: GraphBuffer;
}

type FieldSampleHandles = Pick<FieldHandles, 'field' | 'irradiance' | 'moments' | 'meta'> &
  (
    | { readonly grid: FieldHandles['grid']; readonly visibility: GraphTextureView }
    | { readonly grid?: never; readonly visibility?: never }
  );

function fieldReadsOf(handles: FieldSampleHandles) {
  return [
    { resource: handles.field as GraphBuffer, usage: 'uniform-read' as const },
    ...[handles.irradiance, handles.moments, handles.meta].map((resource) => ({
      resource: resource as GraphBuffer,
      usage: 'storage-read' as const,
    })),
    ...(handles.visibility === undefined
      ? []
      : [
          { resource: handles.grid as GraphBuffer, usage: 'uniform-read' as const },
          { resource: handles.visibility, usage: 'sampled-read' as const },
        ]),
  ];
}

export function viewUniform(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  label = 'irradiance-field',
) {
  return graph
    .importBuffer(
      `${label}.view`,
      { size: VIEW_UNIFORM_BYTES, usage: 64 | 8 },
      (frame) => frame.pipelineState.viewUniformBuffer,
    )
    .unwrap();
}

/** The view-gather inputs a probe-field lane supplies: live (irradiance-field)
 * or baked (Catalog irradiance volume) probes share one sampler and composite. */
export interface FieldGatherSource<E extends FieldGatherExtent> {
  readonly view: Pick<ViewKernels, 'gatherField' | 'upsampleField'>;
  readonly sample: BindGroup;
  readonly composite: PreparedIrradianceField['composite'];
  extent(): E;
}
export interface FieldGatherExtent {
  readonly width: number;
  readonly height: number;
  readonly gatherWidth: number;
  readonly gatherHeight: number;
  readonly gathered: Buffer | undefined;
  readonly upsampled: Buffer | undefined;
}
export interface FieldGatherScope<E extends FieldGatherExtent> {
  /** Pass label prefix, the lane's inspection identity. */
  readonly label: string;
  readonly graph: RenderGraphBuilder<RenderPipelineFrame>;
  readonly current: () => FieldGatherSource<E>;
  readonly target: RayDiffuseTargets;
  readonly extent: E;
  readonly handles: FieldSampleHandles & Pick<FieldHandles, 'frame'>;
  readonly extentBuffer: (
    name: string,
    size: number,
    pick: (value: E) => Buffer | undefined,
  ) => GraphBuffer;
  readonly view: GraphBuffer;
}

/** Per-pixel gather (-> upsample) -> the shared additive diffuse composite. */
export function addFieldGatherPasses<E extends FieldGatherExtent>({
  label,
  graph,
  current,
  target,
  extent,
  handles,
  extentBuffer,
  view,
}: FieldGatherScope<E>): Result<void, RenderGraphError> {
  const pixelCount = extent.width * extent.height;
  const frameUniform = handles.frame as GraphBuffer;
  const fieldReads = fieldReadsOf(handles);
  const gathered = extentBuffer(
    'gathered',
    extent.gatherWidth * extent.gatherHeight * 16,
    (value) => value.gathered,
  );
  const upsampled =
    extent.upsampled === undefined
      ? undefined
      : extentBuffer('upsampled', pixelCount * 16, (value) => value.upsampled);
  const viewAccesses = [
    { resource: frameUniform, usage: 'uniform-read' as const },
    { resource: target.depth, usage: 'sampled-read' as const },
    { resource: target.normal.view, usage: 'sampled-read' as const },
    { resource: view, usage: 'uniform-read' as const },
    ...fieldReads,
  ];
  const gatheredPass = graph.addComputePass(`${label}.gather`, {
    accesses: [...viewAccesses, { resource: gathered, usage: 'storage-write' }],
    encode: ({ pass, resources }) => {
      const value = current();
      const size = value.extent();
      value.view.gatherField
        .record(
          pass,
          [
            { buffer: resources.buffer(frameUniform).unwrap() },
            resources.textureView(target.depth).unwrap(),
            resources.textureView(target.normal.view).unwrap(),
            { buffer: resources.buffer(view).unwrap(), size: VIEW_UNIFORM_BYTES },
            { buffer: resources.buffer(gathered).unwrap() },
          ],
          value.sample,
          size.gatherWidth * size.gatherHeight,
        )
        .unwrap();
    },
  });
  if (!gatheredPass.ok) return gatheredPass;
  let signal = gathered;
  if (upsampled !== undefined) {
    const upsampledPass = graph.addComputePass(`${label}.upsample`, {
      accesses: [
        ...viewAccesses,
        { resource: gathered, usage: 'storage-read' },
        { resource: upsampled, usage: 'storage-write' },
      ],
      encode: ({ pass, resources }) => {
        const value = current();
        value.view.upsampleField
          .record(
            pass,
            [
              { buffer: resources.buffer(frameUniform).unwrap() },
              resources.textureView(target.depth).unwrap(),
              resources.textureView(target.normal.view).unwrap(),
              { buffer: resources.buffer(view).unwrap(), size: VIEW_UNIFORM_BYTES },
              { buffer: resources.buffer(gathered).unwrap() },
              { buffer: resources.buffer(upsampled).unwrap() },
            ],
            value.sample,
            pixelCount,
          )
          .unwrap();
      },
    });
    if (!upsampledPass.ok) return upsampledPass;
    signal = upsampled;
  }
  const composited = graph.addRasterPass(`${label}.composite`, {
    accesses: [
      { resource: target.scene.view, usage: 'color-attachment' },
      { resource: signal, usage: 'storage-read' },
      { resource: target.depth, usage: 'sampled-read' },
      { resource: target.normal.view, usage: 'sampled-read' },
      { resource: target.albedo.view, usage: 'sampled-read' },
      { resource: target.f0.view, usage: 'sampled-read' },
      { resource: view, usage: 'uniform-read' },
    ],
    colorAttachments: [{ view: target.scene.view, loadOp: 'load', storeOp: 'store' }],
    encode: ({ pass, resources }) =>
      current()
        .composite.record(
          pass,
          {
            irradiance: resources.buffer(signal).unwrap(),
            depth: resources.textureView(target.depth).unwrap(),
            normal: resources.textureView(target.normal.view).unwrap(),
            albedoMetallic: resources.textureView(target.albedo.view).unwrap(),
            f0Occlusion: resources.textureView(target.f0.view).unwrap(),
            view: { buffer: resources.buffer(view).unwrap(), size: VIEW_UNIFORM_BYTES },
          },
          pixelCount,
        )
        .unwrap(),
  });
  if (!composited.ok) return composited;
  return ok(undefined);
}

/** Lite reflections from the radiance cache: generate (cache sample + trace
 * weight) -> Global SDF/Card trace with cache fallback -> temporal accumulation
 * -> spatial filter -> additive specular into scene color and the
 * SSR-replaceable fallback, exactly like the exact lane. */
function addFieldReflectionPasses({
  graph,
  current,
  target,
  extent,
  handles,
  extentBuffer,
  view,
}: ViewScope): Result<void, RenderGraphError> {
  const reflection = target.reflection;
  if (extent.reflection === undefined || reflection === undefined) return ok(undefined);
  const pixelCount = extent.width * extent.height;
  const frameUniform = handles.frame as GraphBuffer;
  const rays = extentBuffer(
    'reflection-rays',
    pixelCount * IRRADIANCE_FIELD_REFLECTION_RAY_BYTES,
    (value) => value.reflection?.rays,
  );
  const signal = extentBuffer(
    'reflection-signal',
    pixelCount * 16,
    (value) => value.reflection?.signal,
  );
  const generated = graph.addComputePass('irradiance-field.reflection-generate', {
    accesses: [
      { resource: frameUniform, usage: 'uniform-read' },
      { resource: target.depth, usage: 'sampled-read' },
      { resource: target.normal.view, usage: 'sampled-read' },
      { resource: view, usage: 'uniform-read' },
      ...fieldReadsOf(handles),
      { resource: rays, usage: 'storage-write' },
      { resource: signal, usage: 'storage-write' },
    ],
    encode: ({ pass, resources }) => {
      const value = current();
      value.view.generateFieldReflections
        .record(
          pass,
          [
            { buffer: resources.buffer(frameUniform).unwrap() },
            resources.textureView(target.depth).unwrap(),
            resources.textureView(target.normal.view).unwrap(),
            { buffer: resources.buffer(view).unwrap(), size: VIEW_UNIFORM_BYTES },
            { buffer: resources.buffer(rays).unwrap() },
            { buffer: resources.buffer(signal).unwrap() },
          ],
          value.sample,
          pixelCount,
        )
        .unwrap();
    },
  });
  if (!generated.ok) return generated;
  const kernel = current().kernels.traceReflections;
  const local: KernelHandles = {
    ...handles,
    reflectionRays: rays,
    reflectionSignal: signal,
  };
  // The trace accumulates into the signal the generate pass seeded.
  const traced = graph.addComputePass('irradiance-field.reflection-trace', {
    accesses: kernelAccesses(kernel.bindings, local, 'storage-read-write'),
    encode: ({ pass, resources }) => {
      current()
        .kernels.traceReflections.record(
          pass,
          kernelResolver(kernel.bindings, local, resources),
          pixelCount,
        )
        .unwrap();
    },
  });
  if (!traced.ok) return traced;
  const historyBytes = pixelCount * IRRADIANCE_FIELD_REFLECTION_HISTORY_BYTES;
  const previous = extentBuffer(
    'reflection-history.previous',
    historyBytes,
    (value) => value.reflection?.history().previous,
  );
  const history = extentBuffer(
    'reflection-history.current',
    historyBytes,
    (value) => value.reflection?.history().current,
  );
  const denoised = extentBuffer(
    'reflection-denoised',
    pixelCount * 16,
    (value) => value.reflection?.denoised,
  );
  const accumulated = graph.addComputePass('irradiance-field.reflection-temporal', {
    accesses: [
      { resource: frameUniform, usage: 'uniform-read' },
      { resource: target.depth, usage: 'sampled-read' },
      { resource: target.normal.view, usage: 'sampled-read' },
      { resource: target.motion.view, usage: 'sampled-read' },
      { resource: view, usage: 'uniform-read' },
      { resource: signal, usage: 'storage-read' },
      { resource: previous, usage: 'storage-read' },
      { resource: history, usage: 'storage-write' },
      { resource: rays, usage: 'storage-read' },
    ],
    encode: ({ pass, resources }) =>
      current()
        .view.accumulateFieldReflections.record(
          pass,
          [
            { buffer: resources.buffer(frameUniform).unwrap() },
            resources.textureView(target.depth).unwrap(),
            resources.textureView(target.normal.view).unwrap(),
            { buffer: resources.buffer(view).unwrap(), size: VIEW_UNIFORM_BYTES },
            { buffer: resources.buffer(signal).unwrap() },
            { buffer: resources.buffer(previous).unwrap() },
            { buffer: resources.buffer(history).unwrap() },
            resources.textureView(target.motion.view).unwrap(),
            { buffer: resources.buffer(rays).unwrap() },
          ],
          undefined,
          pixelCount,
        )
        .unwrap(),
  });
  if (!accumulated.ok) return accumulated;
  const filtered = graph.addComputePass('irradiance-field.reflection-denoise', {
    accesses: [
      { resource: frameUniform, usage: 'uniform-read' },
      { resource: view, usage: 'uniform-read' },
      { resource: history, usage: 'storage-read' },
      { resource: denoised, usage: 'storage-write' },
    ],
    encode: ({ pass, resources }) =>
      current()
        .view.filterFieldReflections.record(
          pass,
          [
            { buffer: resources.buffer(frameUniform).unwrap() },
            { buffer: resources.buffer(view).unwrap(), size: VIEW_UNIFORM_BYTES },
            { buffer: resources.buffer(history).unwrap() },
            { buffer: resources.buffer(denoised).unwrap() },
          ],
          undefined,
          pixelCount,
        )
        .unwrap(),
  });
  if (!filtered.ok) return filtered;
  const composited = graph.addRasterPass('irradiance-field.reflection-composite', {
    accesses: [
      { resource: target.scene.view, usage: 'color-attachment' },
      { resource: reflection.fallback.view, usage: 'color-attachment' },
      { resource: denoised, usage: 'storage-read' },
      { resource: target.depth, usage: 'sampled-read' },
      { resource: target.normal.view, usage: 'sampled-read' },
      { resource: reflection.response.view, usage: 'sampled-read' },
    ],
    colorAttachments: [
      { view: target.scene.view, loadOp: 'load', storeOp: 'store' },
      { view: reflection.fallback.view, loadOp: 'load', storeOp: 'store' },
    ],
    encode: ({ pass, resources }) =>
      current()
        .reflectionComposite.record(
          pass,
          {
            reconstructed: resources.buffer(denoised).unwrap(),
            depth: resources.textureView(target.depth).unwrap(),
            normal: resources.textureView(target.normal.view).unwrap(),
            response: resources.textureView(reflection.response.view).unwrap(),
          },
          pixelCount,
        )
        .unwrap(),
  });
  if (!composited.ok) return composited;
  return ok(undefined);
}
