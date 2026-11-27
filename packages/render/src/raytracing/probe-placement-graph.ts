import type {
  GraphBuffer,
  GraphTextureView,
  RenderGraphBuilder,
} from '@forgeax/engine-render-graph';
import { ok } from '@forgeax/engine-types';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import type { RenderPipelineFrame, RenderPipelineTarget } from '../render-pipeline';
import type { PreparedProbePlacement } from './renderer-probe-placement';

export interface ProbePlacementTargets {
  readonly depth: GraphTextureView;
  readonly normal: RenderPipelineTarget;
  readonly identity: RenderPipelineTarget;
}
export interface ProbePlacementGraphBuffers {
  readonly probes: GraphBuffer;
  readonly candidate: GraphBuffer;
}
/** Cached topology resolves every borrowed allocation from this attempted frame. */
export function addProbePlacementPass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  shape: Pick<PreparedProbePlacement, 'count' | 'recordBytes'>,
  targets: ProbePlacementTargets,
) {
  const { count, recordBytes } = shape;
  const current = (frame: RenderPipelineFrame) => {
    const value = frame.probePlacement;
    if (
      value === undefined ||
      value.count !== count ||
      value.recordBytes !== recordBytes ||
      value.fence.currentGeneration() !== value.generation
    )
      throw new Error('stale placement graph: prepare the current view and row shape');
    return value;
  };
  const input = (
    name: 'probes' | 'accepted' | 'candidate' | 'diagnostics' | 'records' | 'viewRect',
    size: number,
    usage = 128 | 12,
  ) =>
    graph
      .importBuffer(`probe-placement.${name}`, { size, usage }, (frame) => current(frame)[name])
      .unwrap();
  const probes = input('probes', count * 32);
  const accepted = input('accepted', count * 32);
  const candidate = input('candidate', count * 32);
  const diagnostics = input('diagnostics', count * 16);
  const records = input('records', recordBytes);
  const viewRect = input('viewRect', 16, 64 | 8);
  const view = graph
    .importBuffer(
      'probe-placement.view',
      { size: VIEW_UNIFORM_BYTES, usage: 64 | 8 },
      (frame) => frame.pipelineState.viewUniformBuffer,
    )
    .unwrap();
  const placed = graph.addComputePass(
    'probe-placement.update',
    {
      accesses: [
        { resource: targets.depth, usage: 'sampled-read' },
        { resource: targets.normal.view, usage: 'sampled-read' },
        { resource: targets.identity.view, usage: 'sampled-read' },
        ...[probes, accepted, records].map((resource) => ({
          resource,
          usage: 'storage-read' as const,
        })),
        ...[candidate, diagnostics].map((resource) => ({
          resource,
          usage: 'storage-write' as const,
        })),
        ...[view, viewRect].map((resource) => ({ resource, usage: 'uniform-read' as const })),
      ],
      encodeDirect: (pass, frame, resources) =>
        current(frame)
          .record(
            pass,
            {
              depth: resources.textureView(targets.depth).unwrap(),
              normal: resources.textureView(targets.normal.view).unwrap(),
              identity: resources.textureView(targets.identity.view).unwrap(),
              records: { buffer: resources.buffer(records).unwrap(), size: recordBytes },
              view: { buffer: resources.buffer(view).unwrap(), size: VIEW_UNIFORM_BYTES },
              probes: resources.buffer(probes).unwrap(),
              accepted: resources.buffer(accepted).unwrap(),
              candidate: resources.buffer(candidate).unwrap(),
              diagnostics: resources.buffer(diagnostics).unwrap(),
              viewRect: resources.buffer(viewRect).unwrap(),
            },
            count,
          )
          .unwrap(),
    },
    'transfer',
  );
  if (!placed.ok) return placed;
  return ok({ probes, candidate } satisfies ProbePlacementGraphBuffers);
}
