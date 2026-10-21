import {
  type GraphAccess,
  type GraphResourceResolver,
  type GraphTextureView,
  type RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import type { RhiDevice, RhiRenderPassEncoder } from '@forgeax/engine-rhi';
import { err, mipDimension, numMipLevels, ok, type Result } from '@forgeax/engine-types';
import {
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import type {
  RenderPipelineFrame,
  RenderPipelineTarget,
  RenderPipelineTopology,
} from '../render-pipeline';
import { createRenderPipelineTarget } from '../render-pipeline';
import type { TransmissionDemand } from './projection';

export const TRANSMISSION_BACKDROP_PHASES = [
  'opaque-resolve',
  'transmission-backdrop-copy',
  'transmission-backdrop-mip',
  'transmission-forward',
  'transparent',
  'temporal',
] as const;

export type TransmissionBackdropPhase = (typeof TRANSMISSION_BACKDROP_PHASES)[number];

type TransmissionTopologyInput = RenderPipelineTopology & {
  readonly transmissionDemand?: TransmissionDemand | undefined;
};

export function transmissionDemandForTopology(
  topology: RenderPipelineTopology,
): TransmissionDemand {
  return (
    (topology as TransmissionTopologyInput).transmissionDemand ?? {
      activeCount: 0,
      needsRoughMips: false,
    }
  );
}

export interface TransmissionBackdropTopologyInput {
  readonly demand: TransmissionDemand;
  readonly sourceSampleCount: 1 | 4;
}

export interface TransmissionBackdropTopology {
  readonly active: boolean;
  readonly sourceSampleCount: 1 | 4;
  readonly copyCount: number;
  readonly mipCount: number;
  readonly submitCount: 1;
  readonly aliasCount: 0;
  readonly phases: readonly TransmissionBackdropPhase[];
}

export function resolveTransmissionBackdropTopology(
  input: TransmissionBackdropTopologyInput,
): TransmissionBackdropTopology {
  if (input.demand.activeCount === 0) {
    return {
      active: false,
      sourceSampleCount: input.sourceSampleCount,
      copyCount: 0,
      mipCount: 0,
      submitCount: 1,
      aliasCount: 0,
      phases: [],
    };
  }
  const phases: TransmissionBackdropPhase[] = ['opaque-resolve', 'transmission-backdrop-copy'];
  if (input.demand.needsRoughMips) phases.push('transmission-backdrop-mip');
  phases.push('transmission-forward', 'transparent', 'temporal');
  return {
    active: true,
    sourceSampleCount: input.sourceSampleCount,
    copyCount: 1,
    mipCount: input.demand.needsRoughMips ? 1 : 0,
    submitCount: 1,
    aliasCount: 0,
    phases,
  };
}

export interface TransmissionCapabilityFacts {
  readonly format: string;
  readonly renderAttachment: boolean;
  readonly copySrc: boolean;
  readonly textureBinding: boolean;
  readonly mipView: boolean;
  readonly filteringSampler: boolean;
  readonly bindGroupLayout: boolean;
  readonly msaaResolve: boolean;
  readonly resourceCreation: boolean;
  /** Accepted as diagnostic input only; it never changes the verdict. */
  readonly backendKind?: string | undefined;
}

export type TransmissionCapabilityFact =
  | 'format'
  | 'renderAttachment'
  | 'copySrc'
  | 'textureBinding'
  | 'mipView'
  | 'filteringSampler'
  | 'bindGroupLayout'
  | 'msaaResolve'
  | 'resourceCreation';

/** Probe the complete backdrop descriptor once per device generation. */
export function probeTransmissionCapability(
  device: RhiDevice,
  format: RenderPipelineTarget['format'] = 'rgba16float',
): TransmissionCapabilityFacts {
  const formatSupported =
    format === 'rgba16float'
      ? device.caps.rgba16floatRenderable
      : format === 'rgba32float' &&
        device.caps.float32Filterable &&
        device.features.has('float32-filterable') &&
        device.features.has('float32-blendable');
  const texture = formatSupported
    ? device.createTexture({
        label: 'transmission-capability-probe',
        size: { width: 2, height: 2, depthOrArrayLayers: 1 },
        format,
        usage:
          GPU_TEXTURE_USAGE_COPY_SRC |
          GPU_TEXTURE_USAGE_TEXTURE_BINDING |
          GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        mipLevelCount: 2,
        sampleCount: 1,
        dimension: '2d',
        textureBindingViewDimension: '2d',
      })
    : undefined;
  let resourceCreation = false;
  let renderAttachment = false;
  let copySrc = false;
  let textureBinding = false;
  let mipView = false;
  let filteringSampler = false;
  let bindGroupLayout = false;
  if (texture?.ok === true) {
    resourceCreation = true;
    copySrc = true;
    const view = device.createTextureView(texture.value, { baseMipLevel: 0, mipLevelCount: 1 });
    const mip = device.createTextureView(texture.value, { baseMipLevel: 1, mipLevelCount: 1 });
    renderAttachment = view.ok;
    textureBinding = view.ok;
    mipView = mip.ok;
    const sampler = device.createSampler({
      minFilter: 'linear',
      magFilter: 'linear',
      mipmapFilter: 'linear',
    });
    filteringSampler = sampler.ok;
    const layout = device.createBindGroupLayout({
      label: 'transmission-capability-probe',
      entries: [
        { binding: 0, visibility: 2, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 1, visibility: 2, sampler: { type: 'filtering' } },
      ],
    });
    bindGroupLayout = layout.ok;
    device.destroyTexture(texture.value);
  }
  return {
    format,
    renderAttachment: formatSupported && renderAttachment,
    copySrc,
    textureBinding,
    mipView,
    filteringSampler,
    bindGroupLayout,
    msaaResolve: formatSupported && renderAttachment,
    resourceCreation,
  };
}

export type TransmissionCapabilityVerdict =
  | { readonly ok: true; readonly missing: readonly [] }
  | { readonly ok: false; readonly missing: readonly TransmissionCapabilityFact[] };

export function evaluateTransmissionCapability(
  facts: TransmissionCapabilityFacts,
): TransmissionCapabilityVerdict {
  const missing: TransmissionCapabilityFact[] = [];
  if (facts.format !== 'rgba16float' && facts.format !== 'rgba32float') missing.push('format');
  for (const field of [
    'renderAttachment',
    'copySrc',
    'textureBinding',
    'mipView',
    'filteringSampler',
    'bindGroupLayout',
    'msaaResolve',
    'resourceCreation',
  ] as const) {
    if (!facts[field]) missing.push(field);
  }
  return missing.length === 0 ? { ok: true, missing: [] } : { ok: false, missing };
}

export type TransmissionAdmissionResult =
  | {
      readonly ok: true;
      readonly published: true;
      readonly generation: number;
      readonly demand: TransmissionDemand;
    }
  | {
      readonly ok: false;
      readonly published: false;
      readonly generation: number;
      readonly demand: TransmissionDemand;
      readonly missing: readonly TransmissionCapabilityFact[];
    };

export interface TransmissionBackdropExtent {
  readonly width: number;
  readonly height: number;
}

/** Detached physical facts committed with a backdrop candidate. */
export interface TransmissionBackdropResourceFacts {
  readonly extent: TransmissionBackdropExtent;
  readonly format: string;
  /** Total resident mip levels, including level zero. */
  readonly mipCount: number;
  readonly bytes: number;
  readonly deviceGeneration: number;
}

export type TransmissionLifecycleState =
  | 'inactive'
  | 'resident'
  | 'recovering'
  | 'device-lost'
  | 'failed';

export type TransmissionRecoveryState =
  | 'idle'
  | 'compatible-lkg'
  | 'rebuild-required'
  | 'recovered'
  | 'failed';

export interface TransmissionCandidateAdmissionInspection {
  readonly generation: number;
  readonly demand: TransmissionDemand;
  readonly capability: TransmissionCapabilityVerdict;
  readonly lifecycle: TransmissionLifecycleState;
  readonly lastKnownGood: boolean;
  readonly recovery: TransmissionRecoveryState;
  readonly resource?: TransmissionBackdropResourceFacts;
}

function sameDemand(left: TransmissionDemand, right: TransmissionDemand): boolean {
  return (
    left.activeCount === right.activeCount &&
    left.needsRoughMips === right.needsRoughMips &&
    left.needsBackPass === right.needsBackPass
  );
}

function cloneResource(
  resource: TransmissionBackdropResourceFacts,
): TransmissionBackdropResourceFacts {
  return {
    ...resource,
    extent: { ...resource.extent },
  };
}

function resourceCompatible(
  current: TransmissionBackdropResourceFacts | undefined,
  candidate: TransmissionBackdropResourceFacts | undefined,
): boolean {
  if (candidate === undefined) return true;
  if (current === undefined) return false;
  return (
    current.deviceGeneration === candidate.deviceGeneration &&
    current.format === candidate.format &&
    current.mipCount === candidate.mipCount &&
    current.extent.width === candidate.extent.width &&
    current.extent.height === candidate.extent.height
  );
}

/** Candidate/LKG fence for the private backdrop topology. */
export class TransmissionCandidateAdmission {
  private generation = 0;
  private demand: TransmissionDemand = { activeCount: 0, needsRoughMips: false };
  private capability: TransmissionCapabilityVerdict = { ok: true, missing: [] };
  private lifecycle: TransmissionLifecycleState = 'inactive';
  private lastKnownGood = false;
  private recovery: TransmissionRecoveryState = 'idle';
  private resource: TransmissionBackdropResourceFacts | undefined;

  admit(
    demand: TransmissionDemand,
    facts: TransmissionCapabilityFacts,
    resource?: TransmissionBackdropResourceFacts,
  ): TransmissionAdmissionResult {
    const verdict = evaluateTransmissionCapability(facts);
    this.capability = verdict;
    if (!verdict.ok) {
      const compatible =
        this.lastKnownGood &&
        sameDemand(this.demand, demand) &&
        resourceCompatible(this.resource, resource);
      if (!compatible && this.lastKnownGood) {
        // A rejected candidate with a different extent, mip shape, format, or
        // device generation cannot safely keep the previous physical target as
        // an LKG. Retire that resource identity immediately; persistent
        // demand remains so the next successful admission can rebuild it.
        this.resource = undefined;
        this.lastKnownGood = false;
      }
      this.lifecycle = compatible ? 'resident' : 'failed';
      this.recovery = compatible ? 'compatible-lkg' : 'rebuild-required';
      return {
        ok: false,
        published: false,
        generation: this.generation,
        demand: this.demand,
        missing: verdict.missing,
      };
    }
    this.generation += 1;
    this.demand = demand;
    this.resource = resource === undefined ? undefined : cloneResource(resource);
    this.lastKnownGood = demand.activeCount > 0 && resource !== undefined;
    this.lifecycle = demand.activeCount > 0 ? 'resident' : 'inactive';
    this.recovery = this.generation === 1 ? 'idle' : 'recovered';
    return { ok: true, published: true, generation: this.generation, demand };
  }

  inspect(): { readonly generation: number; readonly demand: TransmissionDemand } {
    return { generation: this.generation, demand: this.demand };
  }

  /**
   * Drop physical resource identity after device loss without dropping the
   * persistent material demand. The next successful admission must publish a
   * replacement resource before it can become the LKG.
   */
  markDeviceLost(): void {
    this.resource = undefined;
    this.lastKnownGood = false;
    this.lifecycle = this.demand.activeCount > 0 ? 'device-lost' : 'inactive';
    this.recovery = this.demand.activeCount > 0 ? 'rebuild-required' : 'idle';
  }

  markRecoveryStarted(): void {
    this.resource = undefined;
    this.lastKnownGood = false;
    this.lifecycle = this.demand.activeCount > 0 ? 'recovering' : 'inactive';
    this.recovery = this.demand.activeCount > 0 ? 'rebuild-required' : 'idle';
  }

  inspectLifecycle(): TransmissionCandidateAdmissionInspection {
    return {
      generation: this.generation,
      demand: { ...this.demand },
      capability: this.capability.ok
        ? { ok: true, missing: [] }
        : { ok: false, missing: [...this.capability.missing] },
      lifecycle: this.lifecycle,
      lastKnownGood: this.lastKnownGood,
      recovery: this.recovery,
      ...(this.resource === undefined ? {} : { resource: cloneResource(this.resource) }),
    };
  }
}

export interface TransmissionBackdropGraphInput {
  readonly name?: string;
  readonly graph: RenderGraphBuilder<RenderPipelineFrame>;
  /** The resolved single-sample source; MSAA source is never copied directly. */
  readonly source: RenderPipelineTarget;
  readonly demand: TransmissionDemand;
  readonly copySize: { readonly width: number; readonly height: number };
  /** Graph surface extent; the backdrop and its rough-mip scratch derive their levels from it. */
  readonly surfaceSize: { readonly width: number; readonly height: number };
  /**
   * Renderer-owned fullscreen/downsample record path for rough mips. The
   * callback must bind the existing cached sampler/pipeline and draw into the
   * supplied destination view on the graph-owned render pass.
   */
  readonly encodeRoughMip?: TransmissionBackdropMipEncoder | undefined;
  /** Production callers install typed scene consumers after the copy/mip chain. */
  readonly includeConsumerPasses?: boolean;
}

export interface TransmissionBackdropMipEncoderContext {
  readonly pass: RhiRenderPassEncoder;
  readonly frame: RenderPipelineFrame;
  readonly resources: GraphResourceResolver;
  readonly source: GraphTextureView;
  readonly destination: GraphTextureView;
  readonly format: RenderPipelineTarget['format'];
  readonly level: number;
}

/** Existing fullscreen/downsample owner injected by the renderer assembly. */
export type TransmissionBackdropMipEncoder = (
  context: TransmissionBackdropMipEncoderContext,
) => void;

function roughMipEncoderMissing(): RenderGraphError {
  return new RenderGraphError({
    code: 'resource-descriptor-invalid',
    expected: 'rough transmission mip generation to use the existing fullscreen/downsample owner',
    hint: 'provide encodeRoughMip from the renderer-owned downsample path before enabling rough transmission',
    detail: {
      resourceLabel: 'transmission-backdrop',
      field: 'roughMipEncoder',
      expected: 'renderer-owned fullscreen/downsample encoder',
      actual: 'missing',
    },
  });
}

export interface TransmissionBackdropGraph {
  readonly topology: TransmissionBackdropTopology;
  readonly backdrop: RenderPipelineTarget | undefined;
  readonly mipViews: readonly GraphTextureView[];
}

/**
 * Adds the private backdrop and its ordered consumers to the caller's graph.
 * The returned target stays inside the Standard pipeline owner; no public
 * render-target or per-object copy is created.
 */
export function addTransmissionBackdropPasses(
  input: TransmissionBackdropGraphInput,
): Result<TransmissionBackdropGraph, RenderGraphError> {
  const topology = resolveTransmissionBackdropTopology({
    demand: input.demand,
    sourceSampleCount: input.source.sampleCount,
  });
  if (!topology.active) {
    return ok({ topology, backdrop: undefined, mipViews: [] });
  }

  if (topology.mipCount > 0 && input.encodeRoughMip === undefined) {
    return err(roughMipEncoderMissing());
  }

  const label = input.name ?? 'transmission-backdrop';
  const mipLevelCount = topology.mipCount === 0 ? 1 : numMipLevels(input.copySize);
  const backdrop = createRenderPipelineTarget(input.graph, label, {
    format: input.source.format,
    size: input.surfaceSize,
    sampleCount: 1,
    mipLevelCount,
  });
  if (!backdrop.ok) return backdrop;
  const mip0 = input.graph.view(backdrop.value.texture, {
    label: `${label}.mip-0`,
    baseMipLevel: 0,
    mipLevelCount: 1,
  });
  if (!mip0.ok) return mip0;
  const mipViews: GraphTextureView[] = [mip0.value];
  for (let level = 1; level < mipLevelCount; level += 1) {
    const mip = input.graph.view(backdrop.value.texture, {
      label: `${label}.mip-${level}`,
      baseMipLevel: level,
      mipLevelCount: 1,
    });
    if (!mip.ok) return mip;
    mipViews.push(mip.value);
  }

  const copy = input.graph.addCopyPass(`${label}-copy`, {
    accesses: [
      { resource: input.source.view, usage: 'copy-src' },
      { resource: mip0.value, usage: 'copy-dst' },
    ],
    encode: ({ encoder, resources }) => {
      const source = resources.texture(input.source.texture);
      const target = resources.texture(backdrop.value.texture);
      if (!source.ok) throw source.error;
      if (!target.ok) throw target.error;
      encoder.copyTextureToTexture(
        { texture: source.value, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
        { texture: target.value, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
        { ...input.copySize, depthOrArrayLayers: 1 },
      );
    },
  });
  if (!copy.ok) return copy;

  if (topology.mipCount > 0) {
    const encodeRoughMip = input.encodeRoughMip;
    if (encodeRoughMip === undefined) return err(roughMipEncoderMissing());
    // Each level renders into scratch and is copied back, so no draw samples
    // its own attachment texture; some WebGL2 drivers reject that as a
    // feedback loop even when the sampled and attached mips are disjoint.
    const levelSize = (level: number) => ({
      width: mipDimension(input.surfaceSize.width, level),
      height: mipDimension(input.surfaceSize.height, level),
    });
    const scratch = input.graph.createTexture(`${label}-scratch`, {
      format: backdrop.value.format,
      size: levelSize(1),
      sampleCount: 1,
      mipLevelCount: mipLevelCount - 1,
    });
    if (!scratch.ok) return scratch;
    for (let level = 1; level < mipViews.length; level += 1) {
      const source = mipViews[level - 1];
      const destination = mipViews[level];
      if (source === undefined || destination === undefined) {
        return err(
          new RenderGraphError({
            code: 'resource-descriptor-invalid',
            expected: 'every rough transmission mip level to have a graph view',
            hint: 'rebuild the backdrop mip chain before adding its raster passes',
            detail: {
              resourceLabel: label,
              field: 'mipViews',
              expected: `mip views for level ${level - 1} and ${level}`,
              actual: 'missing',
            },
          }),
        );
      }
      const scratchView = input.graph.view(scratch.value, {
        label: `${label}-scratch.mip-${level - 1}`,
        baseMipLevel: level - 1,
        mipLevelCount: 1,
      });
      if (!scratchView.ok) return scratchView;
      const mip = input.graph.addRasterPass(
        level === 1 ? `${label}-mip` : `${label}-mip-${level}`,
        {
          accesses: [
            { resource: source, usage: 'sampled-read' },
            { resource: scratchView.value, usage: 'color-attachment' },
          ] satisfies GraphAccess[],
          colorAttachments: [
            {
              view: scratchView.value,
              clearValue: { r: 0, g: 0, b: 0, a: 1 },
              loadOp: 'clear',
              storeOp: 'store',
            },
          ],
          encode: ({ pass, frame, resources }) =>
            encodeRoughMip({
              pass,
              frame,
              resources,
              source,
              destination: scratchView.value,
              format: backdrop.value.format,
              level,
            }),
        },
      );
      if (!mip.ok) return mip;
      const copied = input.graph.addCopyPass(`${label}-mip-copy-${level}`, {
        accesses: [
          { resource: scratchView.value, usage: 'copy-src' },
          { resource: destination, usage: 'copy-dst' },
        ],
        encode: ({ encoder, resources }) => {
          const from = resources.texture(scratch.value);
          const to = resources.texture(backdrop.value.texture);
          if (!from.ok) throw from.error;
          if (!to.ok) throw to.error;
          encoder.copyTextureToTexture(
            { texture: from.value, mipLevel: level - 1, origin: { x: 0, y: 0, z: 0 } },
            { texture: to.value, mipLevel: level, origin: { x: 0, y: 0, z: 0 } },
            { ...levelSize(level), depthOrArrayLayers: 1 },
          );
        },
      });
      if (!copied.ok) return copied;
    }
  }

  if (input.includeConsumerPasses !== false) {
    const transmission = input.graph.addRasterPass('transmission-forward', {
      accesses: [
        { resource: mip0.value, usage: 'sampled-read' },
        { resource: input.source.view, usage: 'color-attachment' },
      ],
      colorAttachments: [{ view: input.source.view, loadOp: 'load', storeOp: 'store' }],
      encode: () => undefined,
    });
    if (!transmission.ok) return transmission;

    for (const name of ['transparent', 'temporal'] as const) {
      const pass = input.graph.addRasterPass(name, {
        accesses: [{ resource: input.source.view, usage: 'color-attachment' }],
        colorAttachments: [{ view: input.source.view, loadOp: 'load', storeOp: 'store' }],
        encode: () => undefined,
      });
      if (!pass.ok) return pass;
    }
  }

  return ok({ topology, backdrop: backdrop.value, mipViews });
}

/** Adds the final ordering marker after typed transmission and transparent draws. */
export function addTransmissionBackdropTemporalPass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  source: RenderPipelineTarget,
): Result<void, RenderGraphError> {
  return graph.addRasterPass('temporal', {
    accesses: [{ resource: source.view, usage: 'color-attachment' }],
    colorAttachments: [{ view: source.view, loadOp: 'load', storeOp: 'store' }],
    encode: () => undefined,
  });
}
