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
import { addCardRadiosityGraph } from './card-radiosity-graph';
import type { RayDiffuseTargets } from './diffuse-graph';
import {
  type Binding,
  type CardRadiosityInput,
  IRRADIANCE_FIELD_PENDING_OFFSET,
  IRRADIANCE_FIELD_REFLECTION_HISTORY_BYTES,
  IRRADIANCE_FIELD_REFLECTION_RAY_BYTES,
  type IrradianceFieldKernelInput,
} from './irradiance-field';
import {
  type KernelGraphHandle,
  kernelGraphAccess,
  resolveKernelBinding,
} from './kernel-graph-access';
import { addCardAtlasPasses } from './probe-card-graph';
import { addRayDiffuseCompositePass, snapshotRayReflectionFallback } from './ray-graph-shared';
import type { IrradianceFieldExtent, PreparedIrradianceField } from './renderer-irradiance-field';
import type { PreparedWorldAcceleration } from './renderer-world-acceleration';
import { worldAccelerationTableWords } from './world-acceleration-coverage';

type ViewKernels = PreparedIrradianceField['view'];
type FieldKernelStage = keyof PreparedIrradianceField['kernels'];

type ViewRecordInput = 'reflectionRays' | 'reflectionSignal';
type RayQueryInput = 'tlas' | 'traversalInstances' | 'faceNormals';
/** Field-scoped handles; per-view reflection records are bound by their own passes.
 * The Ray Query handles exist exactly when the field selected that traversal. */
export type IrradianceFieldGraphHandles = Readonly<
  Record<
    Exclude<IrradianceFieldKernelInput, ViewRecordInput | RayQueryInput | CardRadiosityInput>,
    KernelGraphHandle
  > &
    Partial<Record<RayQueryInput | CardRadiosityInput, KernelGraphHandle>> & {
      visibility: GraphTextureView;
      visibilityInputs: GraphBuffer;
      canonical: GraphTextureView;
    }
>;

export type FieldRadianceGraphHandles = Pick<
  IrradianceFieldGraphHandles,
  'field' | 'irradiance' | 'moments' | 'meta'
>;

/** Graph identity: one-shot producer passes, Card capture imports and the view extent
 * change topology. In-place installs and removals change capture buffers, so they re-plan. */
export function irradianceFieldGraphShape(prepared: PreparedIrradianceField) {
  const extent = prepared.extent();
  return [
    prepared.generation,
    prepared.composeRequired(),
    prepared.canonical.required(),
    prepared.capture(),
    prepared.cards.capture.revision,
    prepared.cards.textureRevision,
    prepared.cards.capture.bufferReads.length,
    prepared.cards.capture.textureReads.length,
    extent.width,
    extent.height,
    extent.gathered !== undefined,
    extent.reflection !== undefined,
    prepared.cardRadiosity !== undefined,
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
  consume?: (
    handles: IrradianceFieldGraphHandles,
    far?: FieldRadianceGraphHandles,
  ) => Result<void, RenderGraphError>,
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
  const canonicalTexture = graph
    .importTexture(
      'irradiance-field.canonical-scene',
      prepared.canonical.descriptor,
      () => current().canonical.texture,
    )
    .unwrap();
  const canonical = graph
    .importView(canonicalTexture, { dimension: '2d' }, () => current().canonical.view)
    .unwrap();
  const canonicalParams = imported('canonical-params', prepared.canonical.params, true);
  const visibilityInputs = imported('visibility-inputs', prepared.visibilityInputs, true);
  const b = prepared.buffers;
  const field = imported('field', b.field, true);
  const frameUniform = imported('frame', b.frame, true);
  const lights = imported('lights', b.lights, true);
  const irradiance = imported('irradiance', b.irradiance);
  const moments = imported('moments', b.moments);
  const meta = imported('meta', b.meta);
  const farBuffers = prepared.farRadiance?.buffers;
  const far =
    farBuffers === undefined
      ? undefined
      : {
          field: imported('far-field', farBuffers.field, true),
          irradiance: imported('far-radiance', farBuffers.irradiance),
          moments: imported('far-moments', farBuffers.moments),
          meta: imported('far-meta', farBuffers.meta),
        };
  const probeRays = imported('probe-rays', b.probeRays);
  const probeList = imported('probe-list', b.probeList);
  const probeOrigins = imported('probe-origins', b.probeOrigins);
  const surfaces = imported('card-surfaces', b.surfaces);
  const cardDirect = imported('card-direct', b.cardDirect);
  const cardLit = imported('card-lit', b.cardLit);
  const radiosity = prepared.cardRadiosity;
  const radiosityHandles =
    radiosity === undefined
      ? {}
      : {
          cardDirect,
          cardRadiosityFrame: imported('card-radiosity.frame', radiosity.buffers.frame, true),
          cardRadiosityPages: imported('card-radiosity.pages', radiosity.buffers.pages),
          cardRadiosityOrigins: imported('card-radiosity.origins', radiosity.buffers.origins),
          cardRadiosityBounce: imported('card-radiosity.bounce', radiosity.buffers.bounce),
          cardRadiosityIndirect: imported('card-radiosity.indirect', radiosity.buffers.indirect),
          cardRadiosityRays: imported('card-radiosity.rays', radiosity.buffers.trace),
          cardRadiosityFiltered: imported('card-radiosity.filtered', radiosity.buffers.filtered),
          cardRadiositySh: imported('card-radiosity.sh', radiosity.buffers.sh),
          cardRadiosityMeta: imported('card-radiosity.meta', radiosity.buffers.meta),
          cardRadiosityVisibility: imported(
            'card-radiosity.visibility',
            radiosity.buffers.visibility,
          ),
        };
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
      encodeDirect: (pass, _graphframe, _graphresources) => {
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
      encodeDirect: (pass, _graphframe, _graphresources) => {
        const value = current();
        pass.setPipeline(value.visibility.pipeline);
        pass.setBindGroup(0, value.visibility.group);
        pass.dispatchWorkgroups(Math.ceil(value.region.voxelCount / 64));
      },
    });
    if (!projected.ok) return projected;
  }
  if (prepared.canonical.required()) {
    const settings = graph.addCopyPass('irradiance-field.visibility-inputs', {
      accesses: [
        { resource: regionBuffers.settings, usage: 'copy-src' },
        { resource: visibilityInputs, usage: 'copy-dst' },
      ],
      encodeDirect: (encoder, _frame, resources) =>
        encoder.copyBufferToBuffer(
          resources.buffer(regionBuffers.settings).unwrap(),
          0,
          resources.buffer(visibilityInputs).unwrap(),
          0,
          48,
        ),
    });
    if (!settings.ok) return settings;
    const projected = graph.addComputePass('irradiance-field.canonical-scene', {
      accesses: [
        { resource: regionBuffers.instances, usage: 'storage-read' },
        { resource: regionBuffers.fields, usage: 'storage-read' },
        { resource: canonicalParams, usage: 'uniform-read' },
        { resource: canonical, usage: 'storage-write' },
      ],
      encodeDirect: (pass) => {
        const value = current();
        value.canonical.record(pass).unwrap();
        value.markEncoded('canonical');
      },
    });
    if (!projected.ok) return projected;
  }
  const atlasPasses = addFieldCardCaptures(graph, prepared, current);
  if (!atlasPasses.ok) return atlasPasses;
  const { atlas, projections, primitiveIndex, cardReceivers } = atlasPasses.value;
  const traced = addWorldAccelerationPass(
    graph,
    prepared.acceleration,
    () => {
      const value = current().acceleration;
      if (value === undefined) throw new Error('irradiance field lost its world acceleration');
      return value;
    },
    field,
    far?.field,
  );
  if (!traced.ok) return traced;
  const handles: IrradianceFieldGraphHandles = {
    ...traced.value,
    visibility,
    visibilityInputs,
    canonical,
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
    cardReceivers,
    cardPrimitiveIndex: primitiveIndex,
    cardLit,
    probeRays,
    probeList,
    probeOrigins,
    irradiance,
    moments,
    meta,
    ...atlas,
    ...radiosityHandles,
  };
  /** One TS-kernel pass whose accesses are exactly the stage's binding roster. */
  const kernelPass = (
    label: string,
    stage: FieldKernelStage,
    work: (value: PreparedIrradianceField) => number,
    before?: (value: PreparedIrradianceField) => void,
    after: readonly FieldKernelStage[] = [],
    executeIf?: () => boolean,
    domain?: FieldRadianceGraphHandles,
  ) => {
    // World-cache updates read this source's direct light plus prior committed
    // Card indirect, not a Card atlas left over from a different source epoch.
    const domainHandles = domain === undefined ? handles : { ...handles, ...domain };
    const stageHandles =
      stage === 'traceProbes' && radiosityHandles.cardRadiosityBounce !== undefined
        ? { ...domainHandles, cardLit: radiosityHandles.cardRadiosityBounce }
        : domainHandles;
    return graph.addComputePass(`irradiance-field.${label}`, {
      accesses: kernelAccesses(prepared.kernels[stage].bindings, stageHandles, 'storage-write'),
      ...(executeIf === undefined ? {} : { executeIf }),
      encodeDirect: (pass, _graphframe, resources) => {
        const value = current();
        before?.(value);
        for (const recorded of [stage, ...after])
          value.kernels[recorded]
            .record(
              pass,
              kernelResolver(value.kernels[recorded].bindings, stageHandles, resources),
              work(value),
            )
            .unwrap();
      },
    });
  };
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
    encodeDirect: (pass, _graphframe, resources) =>
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
  const radiated = addCardRadiosityGraph({
    graph,
    prepared,
    current,
    kernelPass,
    frameUniform,
    surfaces,
    cardDirect,
    cardLit,
    tileThreads,
    fieldReads: () => fieldReadsOf(handles),
  });
  if (!radiated.ok) return radiated;
  if (far !== undefined) {
    // Both domains use the same schedule and sequentially reuse ray scratch.
    // Their history and per-probe relocation state are independently owned.
    const probes = (value: PreparedIrradianceField) => value.schedule().probes;
    const placed = kernelPass(
      'place-far-probes',
      'placeProbes',
      probes,
      undefined,
      [],
      undefined,
      far,
    );
    if (!placed.ok) return placed;
    const farTrace = kernelPass(
      'trace-far-probes',
      'traceProbes',
      (value) => probes(value) * value.plan.raysPerProbe,
      undefined,
      [],
      undefined,
      far,
    );
    if (!farTrace.ok) return farTrace;
    const updated = kernelPass(
      'update-far-probes',
      'updateProbes',
      probes,
      undefined,
      ['deriveProbes'],
      undefined,
      far,
    );
    if (!updated.ok) return updated;
  }
  const scope = { graph, current, target, extent, handles, extentBuffer, view: viewUniform(graph) };
  const gathered =
    consume === undefined
      ? addFieldGatherPasses({
          ...scope,
          label: 'irradiance-field',
        })
      : consume(handles, far);
  if (!gathered.ok) return gathered;
  return addFieldReflectionPasses(scope);
}

type Current = () => PreparedIrradianceField;

/** The same graph submission orders material, identity, immutable source facts,
 * then direct light. Retained captures are revalidated against this source epoch. */
function addFieldCardCaptures(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  prepared: PreparedIrradianceField,
  current: Current,
) {
  const captured = addCardAtlasPasses(
    graph,
    'irradiance-field.card',
    prepared.cards,
    prepared.capture(),
    () => current().cards,
    (_frame, pass, phase) => current().recordCapture(pass, phase),
    prepared.traversal === 'global-sdf',
  );
  if (!captured.ok) return captured;
  const resources = prepared.cards.capture.receivers;
  const cardReceivers = graph
    .importBuffer(
      'irradiance-field.card-receivers',
      { size: resources.size, usage: 128 | 12 },
      () => current().cards.capture.receivers.buffer,
    )
    .unwrap();
  if (prepared.traversal === 'global-sdf') {
    const staging = graph
      .importBuffer(
        'irradiance-field.card-receiver-staging',
        { size: resources.size, usage: 128 | 12 },
        () => current().cards.capture.receivers.staging,
      )
      .unwrap();
    const published = graph.addCopyPass('irradiance-field.card-receivers', {
      executeIf: () => current().schedule().direct,
      accesses: [
        { resource: staging, usage: 'copy-src' },
        { resource: cardReceivers, usage: 'copy-dst' },
      ],
      encodeDirect: (encoder) => current().recordReceiverFacts(encoder),
    });
    if (!published.ok) return published;
  }
  return ok({ ...captured.value, cardReceivers });
}
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
  farField?: GraphBuffer,
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
    worldAccelerationTableWords(acceleration.maxInstances, acceleration.maxTriangles) * 4,
  );
  const faceNormals = table('faceNormals', 'face-normals', acceleration.maxTriangles * 16);
  const built = graph.addCopyPass('irradiance-field.world-acceleration', {
    accesses: [
      { resource: tlas, usage: 'acceleration-structure-build' },
      { resource: traversalInstances, usage: 'copy-dst' },
      { resource: faceNormals, usage: 'copy-dst' },
    ],
    executeIf: () => !live().settled(),
    encodeDirect: (encoder, _graphframe, _graphresources) => live().record(encoder).unwrap(),
  });
  if (!built.ok) return built;
  if (field !== undefined) {
    const fields = farField === undefined ? [field] : [field, farField];
    const covered = graph.addCopyPass('irradiance-field.world-coverage', {
      accesses: [
        { resource: traversalInstances, usage: 'copy-src' },
        ...fields.map((resource) => ({ resource, usage: 'copy-dst' as const })),
      ],
      encodeDirect: (encoder, _graphframe, resources) => {
        const table = resources.buffer(traversalInstances).unwrap();
        for (const target of fields) {
          encoder.copyBufferToBuffer(
            table,
            0,
            resources.buffer(target).unwrap(),
            IRRADIANCE_FIELD_PENDING_OFFSET,
            4,
          );
        }
        return ok(undefined);
      },
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
    | {
        readonly visibilityInputs: GraphBuffer;
        readonly visibility: GraphTextureView;
        readonly canonical: GraphTextureView;
      }
    | { readonly visibilityInputs?: never; readonly visibility?: never; readonly canonical?: never }
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
          { resource: handles.visibilityInputs, usage: 'uniform-read' as const },
          { resource: handles.visibility, usage: 'sampled-read' as const },
          { resource: handles.canonical, usage: 'sampled-read' as const },
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
  /** Present only when this field gathers the view. */
  readonly gathered: Buffer | undefined;
  readonly upsampled: Buffer | undefined;
}
interface FieldGatherScope<E extends FieldGatherExtent> {
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
  if (current().view.gatherField === undefined)
    throw new Error('field view gather requires its gather kernel');
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
    encodeDirect: (pass, _graphframe, resources) => {
      const value = current();
      const size = value.extent();
      const kernel = value.view.gatherField;
      if (kernel === undefined) throw new Error('field view gather requires its gather kernel');
      kernel
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
      encodeDirect: (pass, _graphframe, resources) => {
        const value = current();
        const kernel = value.view.upsampleField;
        if (kernel === undefined)
          throw new Error('half-resolution field requires its upsample kernel');
        kernel
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
  const composited = addRayDiffuseCompositePass(
    graph,
    `${label}.composite`,
    () => current().composite,
    target,
    signal,
    pixelCount,
  );
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
  const currentReflection = () => {
    const bundle = current().reflection();
    if (bundle.state !== 'ready')
      throw new Error('irradiance field reflection bundle is not ready');
    return bundle.value;
  };
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
    encodeDirect: (pass, _graphframe, resources) => {
      currentReflection()
        .view.generateFieldReflections.record(
          pass,
          [
            { buffer: resources.buffer(frameUniform).unwrap() },
            resources.textureView(target.depth).unwrap(),
            resources.textureView(target.normal.view).unwrap(),
            { buffer: resources.buffer(view).unwrap(), size: VIEW_UNIFORM_BYTES },
            { buffer: resources.buffer(rays).unwrap() },
            { buffer: resources.buffer(signal).unwrap() },
          ],
          current().sample,
          pixelCount,
        )
        .unwrap();
    },
  });
  if (!generated.ok) return generated;
  const kernel = currentReflection().trace;
  const local: KernelHandles = {
    ...handles,
    reflectionRays: rays,
    reflectionSignal: signal,
  };
  // The trace accumulates into the signal the generate pass seeded.
  const traced = graph.addComputePass('irradiance-field.reflection-trace', {
    accesses: kernelAccesses(kernel.bindings, local, 'storage-read-write'),
    encodeDirect: (pass, _graphframe, resources) => {
      currentReflection()
        .trace.record(pass, kernelResolver(kernel.bindings, local, resources), pixelCount)
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
    encodeDirect: (pass, _graphframe, resources) =>
      currentReflection()
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
    encodeDirect: (pass, _graphframe, resources) =>
      currentReflection()
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
  const fallbackBeforeComposite = snapshotRayReflectionFallback(
    graph,
    'irradiance-field.previous-fallback',
    reflection.fallback,
  );
  if (!fallbackBeforeComposite.ok) return fallbackBeforeComposite;
  const composited = graph.addRasterPass('irradiance-field.reflection-composite', {
    accesses: [
      { resource: target.scene.view, usage: 'color-attachment' },
      { resource: reflection.fallback.view, usage: 'color-attachment' },
      { resource: denoised, usage: 'storage-read' },
      { resource: target.depth, usage: 'sampled-read' },
      { resource: target.normal.view, usage: 'sampled-read' },
      { resource: reflection.response.view, usage: 'sampled-read' },
      { resource: fallbackBeforeComposite.value, usage: 'sampled-read' },
    ],
    colorAttachments: [
      { view: target.scene.view, loadOp: 'load', storeOp: 'store' },
      { view: reflection.fallback.view, loadOp: 'load', storeOp: 'store' },
    ],
    encodeDirect: (pass, _graphframe, resources) =>
      currentReflection()
        .composite.record(
          pass,
          {
            reconstructed: resources.buffer(denoised).unwrap(),
            depth: resources.textureView(target.depth).unwrap(),
            normal: resources.textureView(target.normal.view).unwrap(),
            response: resources.textureView(reflection.response.view).unwrap(),
            previous: resources.textureView(fallbackBeforeComposite.value).unwrap(),
          },
          pixelCount,
          reflection.composeReflection === true,
        )
        .unwrap(),
  });
  if (!composited.ok) return composited;
  return ok(undefined);
}
