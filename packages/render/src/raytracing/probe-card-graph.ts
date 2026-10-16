import { encodeMipmapLevel } from '@forgeax/engine-assets-runtime';
import type {
  GraphBuffer,
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import type { RhiRenderPassEncoder, TextureView } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { RenderPipelineFrame } from '../render-pipeline';
import type { CardAtlasCapture } from './card-capture-schedule';
import { CARD_LOOKUP_STRIDE } from './card-lookup';
import { GLOBAL_CARD_CANDIDATE_STRIDE, type GlobalSdfCardLookupInputs } from './global-card-lookup';
import { PROBE_CARD_SUPPORT_STRIDE } from './probe-card-support';
import type { ProbeCardCapture } from './renderer-probe-cards';
import type { PreparedProbeGlobal } from './renderer-probe-global';
import { CARD_PLANES, CARD_TEXTURES } from './surface-cards';

export function probeCardGraphShape(global: PreparedProbeGlobal) {
  const value = global.cards;
  if (value === undefined) return undefined;
  const capture = value.region.capture;
  return [
    value.region.schedule.mode(),
    capture.width,
    capture.height,
    capture.bufferReads.map((r) => [r.size, r.usage]),
    value.region.textures.map((t) => [t.needsMipmaps, t.entry.receipt]),
    value.region.projections.size,
  ];
}

/** All Global and Card dependencies use the actual producer Graph handles. */
export function addProbeCardPasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  initial: PreparedProbeGlobal,
  shared: {
    readonly rays: GraphBuffer;
    readonly hits: GraphBuffer;
    readonly region: Readonly<
      Record<'instances' | 'fields' | 'bounds' | 'settings' | 'voxels', GraphBuffer>
    >;
  },
  currentGlobal: (frame: RenderPipelineFrame) => PreparedProbeGlobal,
) {
  const expected = initial.cards;
  if (expected === undefined) return ok(undefined);
  const current = (frame: RenderPipelineFrame) => {
    const value = currentGlobal(frame).cards;
    if (value === undefined || !value.region.current())
      throw new Error('stale native Card capture source');
    return value;
  };
  const atlasPasses = addCardAtlasPasses(
    graph,
    'probe-card',
    expected.region,
    expected.region.schedule.mode(),
    (frame) => current(frame).region,
    (frame, pass) => current(frame).capture(pass).unwrap(),
  );
  if (!atlasPasses.ok) return atlasPasses;
  const { atlas, projections: cards } = atlasPasses.value;
  const input = (name: 'candidates' | 'samples' | 'diagnostics', size: number) =>
    graph
      .importBuffer(
        `probe-card.${name}`,
        { size, usage: 128 | 12 },
        (frame) => current(frame)[name],
      )
      .unwrap();
  const rayCount = initial.rayCount;
  const candidates = input('candidates', rayCount * GLOBAL_CARD_CANDIDATE_STRIDE);
  const samples = input('samples', rayCount * 4 * CARD_LOOKUP_STRIDE);
  const diagnostics = input('diagnostics', rayCount * PROBE_CARD_SUPPORT_STRIDE);
  const settings = graph
    .importBuffer(
      'probe-card.settings',
      { size: 16, usage: 64 | 12 },
      (frame) => current(frame).region.settings.buffer,
    )
    .unwrap();
  for (const stage of ['selectCandidates', 'sampleCards'] as const) {
    const lookup = graph.addComputePass(`probe-card.${stage}`, {
      accesses: [
        ...[
          shared.hits,
          shared.region.instances,
          shared.region.fields,
          shared.region.bounds,
          cards,
        ].map((resource) => ({ resource, usage: 'storage-read' as const })),
        { resource: shared.region.settings, usage: 'uniform-read' },
        { resource: settings, usage: 'uniform-read' },
        {
          resource: candidates,
          usage: stage === 'selectCandidates' ? 'storage-write' : 'storage-read',
        },
        { resource: samples, usage: stage === 'sampleCards' ? 'storage-write' : 'storage-read' },
        ...CARD_TEXTURES.map((name) => ({ resource: atlas[name], usage: 'sampled-read' as const })),
      ],
      encode: ({ pass, resources, frame }) => {
        const global = currentGlobal(frame),
          value = current(frame);
        const range = (resource: GraphBuffer, size: number) => ({
          buffer: resources.buffer(resource).unwrap(),
          size,
        });
        const inputs: GlobalSdfCardLookupInputs = {
          hits: range(shared.hits, rayCount * 64),
          instances: range(shared.region.instances, global.region.input.instances.size),
          fields: range(shared.region.fields, global.region.input.fields.size),
          bounds: range(shared.region.bounds, global.region.input.bounds.size),
          grid: range(shared.region.settings, 48),
          cards: range(cards, value.region.projections.size),
          candidates: range(candidates, rayCount * GLOBAL_CARD_CANDIDATE_STRIDE),
          output: range(samples, rayCount * 4 * CARD_LOOKUP_STRIDE),
          settings: range(settings, 16),
          textures: Object.fromEntries(
            CARD_TEXTURES.map((name) => [name, resources.textureView(atlas[name]).unwrap()]),
          ) as GlobalSdfCardLookupInputs['textures'],
        };
        value.lookup(pass, inputs, rayCount, stage).unwrap();
      },
    });
    if (!lookup.ok) return lookup;
  }
  return graph.addComputePass('probe-card.support', {
    accesses: [
      ...[shared.rays, shared.hits, candidates, samples].map((resource) => ({
        resource,
        usage: 'storage-read' as const,
      })),
      { resource: diagnostics, usage: 'storage-write' },
    ],
    encode: ({ pass, resources, frame }) => {
      const range = (resource: GraphBuffer, size: number) => ({
        buffer: resources.buffer(resource).unwrap(),
        size,
      });
      current(frame)
        .support(
          pass,
          {
            rays: range(shared.rays, rayCount * 48),
            hits: range(shared.hits, rayCount * 64),
            candidates: range(candidates, rayCount * GLOBAL_CARD_CANDIDATE_STRIDE),
            samples: range(samples, rayCount * 4 * CARD_LOOKUP_STRIDE),
            output: range(diagnostics, rayCount * PROBE_CARD_SUPPORT_STRIDE),
          },
          rayCount,
        )
        .unwrap();
    },
  });
}

/** Shared Card atlas import and capture chain. Every consumer imports the
 * same producer-owned textures; the capture pass runs only while required. */
export function addCardAtlasPasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  label: string,
  region: ProbeCardCapture,
  captureMode: CardAtlasCapture,
  current: (frame: RenderPipelineFrame) => ProbeCardCapture,
  record: (frame: RenderPipelineFrame, pass: RhiRenderPassEncoder) => void,
): Result<
  {
    readonly atlas: Record<(typeof CARD_TEXTURES)[number], GraphTextureView>;
    readonly projections: GraphBuffer;
  },
  RenderGraphError
> {
  const capture = region.capture;
  const textures = new Map<TextureView, GraphTextureView>();
  const materialViews: GraphTextureView[] = [];
  for (const [index, item] of region.textures.entries()) {
    const receipt = item.entry.receipt;
    const resident = (frame: RenderPipelineFrame) => {
      const value = current(frame).textures[index];
      if (value === undefined) throw new Error('native Card material texture shape changed');
      return value.entry;
    };
    const allocation = graph
      .importTexture(
        `${label}.material.${index}`,
        {
          format: receipt.format,
          size: receipt.extent,
          mipLevelCount: receipt.mipLevelCount,
          usage: 4 | (item.needsMipmaps ? 16 : 0),
        },
        (frame) => resident(frame).texture.handle,
      )
      .unwrap();
    const view = graph
      .importView(
        allocation,
        { dimension: '2d', mipLevelCount: receipt.mipLevelCount },
        (frame) => resident(frame).view,
      )
      .unwrap();
    textures.set(item.entry.view, view);
    materialViews.push(view);
    if (captureMode === 'clear' && item.needsMipmaps) {
      let previous = graph.view(allocation, { baseMipLevel: 0, mipLevelCount: 1 }).unwrap();
      for (let mip = 1; mip < receipt.mipLevelCount; mip++) {
        const source = previous;
        const target = graph.view(allocation, { baseMipLevel: mip, mipLevelCount: 1 }).unwrap();
        const added = graph.addRasterPass(`${label}.material.${index}.mip-${mip}`, {
          accesses: [
            { resource: source, usage: 'sampled-read' },
            { resource: target, usage: 'color-attachment' },
          ],
          colorAttachments: [
            {
              view: target,
              loadOp: 'clear',
              storeOp: 'store',
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
            },
          ],
          encode: ({ pass, resources, frame }) =>
            encodeMipmapLevel(
              current(frame).device,
              pass,
              resources.textureView(source).unwrap(),
              receipt.format,
            ).unwrap(),
        });
        if (!added.ok) return err(added.error);
        previous = target;
      }
    }
  }
  if (capture.textureReads.some((view) => !textures.has(view)))
    throw new Error('native Card capture has an undeclared material texture');
  const atlas = Object.fromEntries(
    CARD_TEXTURES.map((name) => {
      const texture = graph
        .importTexture(
          `${label}.${name}`,
          {
            format: name === 'depth' ? 'depth32float' : 'rgba16float',
            size: { width: capture.width, height: capture.height },
            usage: 21,
          },
          (frame) => current(frame).capture.textures[name],
        )
        .unwrap();
      return [
        name,
        graph
          .importView(texture, { dimension: '2d' }, (frame) => current(frame).capture.views[name])
          .unwrap(),
      ];
    }),
  ) as Record<(typeof CARD_TEXTURES)[number], GraphTextureView>;
  if (captureMode !== undefined) {
    const reads = capture.bufferReads.map((read, index) => ({
      resource: graph
        .importBuffer(
          `${label}.capture-input.${index}`,
          { size: read.size, usage: (read.usage === 'uniform-read' ? 64 : 128) | 12 },
          (frame) => {
            const value = current(frame).capture.bufferReads[index];
            if (value === undefined) throw new Error('native Card capture buffer shape changed');
            return value.buffer;
          },
        )
        .unwrap(),
      usage: read.usage,
    }));
    const captured = graph.addRasterPass(`${label}.capture`, {
      accesses: [
        ...reads,
        ...materialViews.map((resource) => ({ resource, usage: 'sampled-read' as const })),
        ...CARD_PLANES.map((name) => ({
          resource: atlas[name],
          usage: 'color-attachment' as const,
        })),
        { resource: atlas.depth, usage: 'depth-stencil-write' },
      ],
      colorAttachments: CARD_PLANES.map((name) => ({
        view: atlas[name],
        loadOp: captureMode,
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      })),
      depthStencilAttachment: {
        view: atlas.depth,
        depthLoadOp: captureMode,
        depthStoreOp: 'store',
        depthClearValue: 1,
      },
      encode: ({ pass, frame }) => record(frame, pass),
    });
    if (!captured.ok) return err(captured.error);
  }
  const projections = graph
    .importBuffer(
      `${label}.projections`,
      { size: region.projections.size, usage: 128 | 12 },
      (frame) => current(frame).projections.buffer,
    )
    .unwrap();
  return ok({ atlas, projections });
}
