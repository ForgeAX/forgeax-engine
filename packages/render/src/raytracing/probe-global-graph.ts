import type { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RenderPipelineFrame } from '../render-pipeline';
import type { GlobalSdfCompositionInputs } from './global-sdf';
import { addProbeCardPasses, probeCardGraphShape } from './probe-card-graph';
import { PROBE_ORIGIN_SUPPORT_STRIDE } from './probe-origin-support';
import type { ProbePlacementGraphBuffers } from './probe-placement-graph';
import type { PreparedProbePlacement } from './renderer-probe-placement';

/** A composition shape change rebuilds topology; replacing equal-sized buffers
 * only changes this frame's imported allocations. A composed region has no writer. */
export function probeGlobalGraphShape(frame: PreparedProbePlacement) {
  const global = frame.global;
  return global === undefined
    ? undefined
    : [
        global.rayCount,
        global.composeRequired,
        global.region.voxelCount,
        probeCardGraphShape(global),
        ...Object.values(global.region.input).map((range) => range.size),
      ];
}

/** Uses the exact candidate/probes GraphBuffers returned by placement. */
export function addProbeGlobalPasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  shape: PreparedProbePlacement,
  placement: ProbePlacementGraphBuffers,
) {
  const expected = shape.global;
  if (expected === undefined) throw new Error('Global probe graph requires a prepared query');
  const shapeKey = JSON.stringify(probeGlobalGraphShape(shape));
  const current = (frame: RenderPipelineFrame) => {
    const value = frame.probePlacement;
    if (
      value === undefined ||
      value.global === undefined ||
      value.count !== shape.count ||
      value.fence.currentGeneration() !== value.generation ||
      JSON.stringify(probeGlobalGraphShape(value)) !== shapeKey
    )
      throw new Error('stale Global probe graph: prepare the current complete chain');
    return value.global;
  };
  const regionNames = ['instances', 'fields', 'bounds', 'settings', 'voxels'] as const;
  const region = Object.fromEntries(
    regionNames.map((name) => [
      name,
      graph
        .importBuffer(
          `probe-global.${name}`,
          { size: expected.region.input[name].size, usage: (name === 'settings' ? 64 : 128) | 12 },
          (frame) => current(frame).region.input[name].buffer,
        )
        .unwrap(),
    ]),
  ) as Record<(typeof regionNames)[number], typeof placement.candidate>;
  const output = (
    name: 'rays' | 'hits' | 'emission' | 'diagnostics' | 'raySettings' | 'querySettings',
    size: number,
    uniform = false,
  ) =>
    graph
      .importBuffer(
        `probe-global.${name}`,
        { size, usage: (uniform ? 64 : 128) | 12 },
        (frame) => current(frame)[name],
      )
      .unwrap();
  const rays = output('rays', expected.rayCount * 48),
    hits = output('hits', expected.rayCount * 64);
  const emission = output('emission', shape.count * 16),
    diagnostics = output('diagnostics', shape.count * PROBE_ORIGIN_SUPPORT_STRIDE);
  const raySettings = output('raySettings', 16, true),
    querySettings = output('querySettings', 16, true);
  if (expected.composeRequired) {
    const composed = graph.addComputePass('probe-global.compose', {
      accesses: [
        ...[region.instances, region.fields, region.bounds].map((resource) => ({
          resource,
          usage: 'storage-read' as const,
        })),
        { resource: region.settings, usage: 'uniform-read' },
        { resource: region.voxels, usage: 'storage-write' },
      ],
      encode: ({ pass, resources, frame }) => {
        const value = current(frame);
        const input = Object.fromEntries(
          regionNames.map((name) => [
            name,
            {
              buffer: resources.buffer(region[name]).unwrap(),
              size: value.region.input[name].size,
            },
          ]),
        ) as unknown as GlobalSdfCompositionInputs;
        value.compose(pass, input, value.region.voxelCount).unwrap();
      },
    });
    if (!composed.ok) return composed;
  }
  const emitted = graph.addComputePass('probe-global.emit-rays', {
    accesses: [
      ...[placement.probes, placement.candidate].map((resource) => ({
        resource,
        usage: 'storage-read' as const,
      })),
      { resource: raySettings, usage: 'uniform-read' },
      ...[rays, emission].map((resource) => ({ resource, usage: 'storage-write' as const })),
    ],
    encode: ({ pass, resources, frame }) =>
      current(frame)
        .emit(
          pass,
          {
            probes: { buffer: resources.buffer(placement.probes).unwrap(), size: shape.count * 32 },
            candidate: {
              buffer: resources.buffer(placement.candidate).unwrap(),
              size: shape.count * 32,
            },
            settings: { buffer: resources.buffer(raySettings).unwrap(), size: 16 },
            rays: { buffer: resources.buffer(rays).unwrap(), size: expected.rayCount * 48 },
            diagnostics: { buffer: resources.buffer(emission).unwrap(), size: shape.count * 16 },
          },
          shape.count,
          expected.resolution,
        )
        .unwrap(),
  });
  if (!emitted.ok) return emitted;
  const queried = graph.addComputePass('probe-global.query', {
    accesses: [
      ...[region.voxels, rays].map((resource) => ({ resource, usage: 'storage-read' as const })),
      ...[region.settings, querySettings].map((resource) => ({
        resource,
        usage: 'uniform-read' as const,
      })),
      { resource: hits, usage: 'storage-write' },
    ],
    encode: ({ pass, resources, frame }) =>
      current(frame)
        .query(
          pass,
          {
            voxels: {
              buffer: resources.buffer(region.voxels).unwrap(),
              size: expected.region.input.voxels.size,
            },
            grid: { buffer: resources.buffer(region.settings).unwrap(), size: 48 },
            rays: { buffer: resources.buffer(rays).unwrap(), size: expected.rayCount * 48 },
            hits: { buffer: resources.buffer(hits).unwrap(), size: expected.rayCount * 64 },
            settings: { buffer: resources.buffer(querySettings).unwrap(), size: 16 },
          },
          expected.rayCount,
        )
        .unwrap(),
  });
  if (!queried.ok) return queried;
  const supported = graph.addComputePass('probe-global.origin-support', {
    accesses: [
      ...[placement.probes, placement.candidate, emission, hits, region.voxels].map((resource) => ({
        resource,
        usage: 'storage-read' as const,
      })),
      { resource: region.settings, usage: 'uniform-read' },
      { resource: diagnostics, usage: 'storage-write' },
    ],
    encode: ({ pass, resources, frame }) =>
      current(frame)
        .support(
          pass,
          {
            probes: { buffer: resources.buffer(placement.probes).unwrap(), size: shape.count * 32 },
            candidate: {
              buffer: resources.buffer(placement.candidate).unwrap(),
              size: shape.count * 32,
            },
            emission: { buffer: resources.buffer(emission).unwrap(), size: shape.count * 16 },
            hits: { buffer: resources.buffer(hits).unwrap(), size: expected.rayCount * 64 },
            voxels: {
              buffer: resources.buffer(region.voxels).unwrap(),
              size: expected.region.input.voxels.size,
            },
            grid: { buffer: resources.buffer(region.settings).unwrap(), size: 48 },
            diagnostics: {
              buffer: resources.buffer(diagnostics).unwrap(),
              size: shape.count * PROBE_ORIGIN_SUPPORT_STRIDE,
            },
          },
          shape.count,
          expected.rayCount,
        )
        .unwrap(),
  });
  if (!supported.ok) return supported;
  return addProbeCardPasses(graph, expected, { rays, hits, region }, current);
}
