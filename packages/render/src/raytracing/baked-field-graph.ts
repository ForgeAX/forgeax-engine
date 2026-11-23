import type {
  GraphResourceResolver,
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
  RenderGraphNativePass,
} from '@forgeax/engine-render-graph';
import type { TextureView } from '@forgeax/engine-rhi';
import type { Result } from '@forgeax/engine-types';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import type { RenderPipelineFrame } from '../render-pipeline';
import type { RayDiffuseTargets } from './diffuse-graph';
import type { IrradianceFieldViewResource } from './irradiance-field';
import { viewUniform } from './irradiance-field-graph';
import type { BakedFieldExtent, PreparedBakedField } from './renderer-baked-field';

function bound<T>(input: T | undefined): T {
  if (input === undefined) throw new Error('baked GI requires an active view recording');
  return input;
}

function frameVolume(frame: RenderPipelineFrame) {
  return (frame as _InternalRenderPipelineContext).bakedField;
}

/** The parent supplies its deferred lighting and surface ports. The volume owns
 * the probe storage, sampler, gather grid and optional upsample for this issue. */
export function addBakedFieldPasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  target: RayDiffuseTargets,
): Result<void, RenderGraphError> {
  const view = viewUniform(graph, 'baked-field');
  const {
    scene: { view: scene },
    normal: { view: normalPort },
    depth: depthPort,
    subsurfaceDiffuse: subsurface,
    diffuseGiBaseline: baseline,
    compactGbuffer,
  } = target;
  let volume: PreparedBakedField | undefined;
  let extent: BakedFieldExtent | undefined;
  let resources: GraphResourceResolver | undefined;
  let depth: TextureView | undefined;
  let normal: TextureView | undefined;
  const bindings: IrradianceFieldViewResource[] = [];
  const viewBinding = {
    get buffer() {
      return bound(resources).buffer(view).unwrap();
    },
    size: VIEW_UNIFORM_BYTES,
  };
  const gathered = {
    get buffer() {
      return bound(extent).gathered;
    },
  };
  const upsampled = {
    get buffer() {
      return bound(bound(extent).upsampled);
    },
  };
  const gather: RenderGraphNativePass = {
    kind: 'compute',
    name: 'baked-field.gather',
    encode(pass) {
      const field = bound(volume),
        grid = bound(extent);
      field.source.view.gatherField
        .record(pass, bindings, field.source.sample, grid.gatherWidth * grid.gatherHeight)
        .unwrap();
    },
  };
  const upsample: RenderGraphNativePass = {
    kind: 'compute',
    name: 'baked-field.upsample',
    encode(pass) {
      const field = bound(volume),
        grid = bound(extent);
      field.source.view.upsampleField
        .record(pass, bindings, field.source.sample, grid.width * grid.height)
        .unwrap();
    },
  };
  const color = (handle: GraphTextureView) => ({
    get view() {
      return bound(resources).textureView(handle).unwrap();
    },
    loadOp: 'load' as const,
    storeOp: 'store' as const,
  });
  const input = {
    get irradiance() {
      const grid = bound(extent);
      return grid.upsampled ?? grid.gathered;
    },
    get baseline() {
      return bound(resources).buffer(baseline).unwrap();
    },
    get depth() {
      return bound(depth);
    },
    get normal() {
      return bound(normal);
    },
    subsurface: subsurface !== undefined,
    ...(compactGbuffer === true ? { compactGbuffer: true as const } : {}),
  };
  const composite: RenderGraphNativePass = {
    kind: 'raster',
    name: 'baked-field.composite',
    descriptor: {
      label: 'baked-field.composite',
      colorAttachments:
        subsurface === undefined ? [color(scene)] : [color(scene), color(subsurface.view)],
    },
    encode(pass) {
      const grid = bound(extent);
      bound(volume)
        .source.composite.record(pass, input, grid.width * grid.height)
        .unwrap();
    },
  };
  return graph.addSubgraphPass('baked-field', {
    profilePasses: () => [gather, upsample, composite],
    accesses: [
      { resource: view, usage: 'uniform-read' },
      { resource: depthPort, usage: 'sampled-read' },
      { resource: normalPort, usage: 'sampled-read' },
      { resource: baseline, usage: 'storage-read' },
      { resource: scene, usage: 'color-attachment' },
      ...(subsurface === undefined
        ? []
        : [{ resource: subsurface.view, usage: 'color-attachment' as const }]),
    ],
    appendPassNames(frame, names) {
      const field = frameVolume(frame);
      if (field === undefined) return;
      names.push(gather.name);
      if (field.extent.upsampled !== undefined) names.push(upsample.name);
      names.push(composite.name);
    },
    commandsDirect(frame, resolved, issue, recording) {
      const field = frameVolume(frame);
      if (field === undefined) return;
      if (field.fence.currentGeneration() !== field.generation)
        throw new Error('baked GI cannot issue a retired volume');
      const grid = field.extent;
      const size = resolved.textureViewExtent(scene).unwrap();
      if (grid.width !== size.width || grid.height !== size.height)
        throw new Error('baked GI gather extent differs from the lighting target');
      try {
        volume = field;
        extent = grid;
        resources = resolved;
        depth = resolved.textureView(depthPort).unwrap();
        normal = resolved.textureView(normalPort).unwrap();
        bindings.push(grid.frame, depth, normal, viewBinding, gathered);
        issue(recording, gather);
        if (grid.upsampled !== undefined) {
          bindings.push(upsampled);
          issue(recording, upsample);
        }
        issue(recording, composite);
      } finally {
        bindings.length = 0;
        volume = extent = resources = depth = normal = undefined;
      }
    },
  });
}
