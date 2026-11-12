import type { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { BindGroup, BindGroupLayout, ComputePipeline } from '@forgeax/engine-rhi';
import { TSR_OPAQUE_FRAGMENT_WGSL, TSR_OPAQUE_WGSL } from '@forgeax/engine-shader';
import { ok } from '@forgeax/engine-types';
import { renderInternalCopySize, renderInternalSize } from '../pipeline/render-extent';
import { createRasterState, type RasterState } from '../raster-graph-state';
import {
  createRenderPipelineTarget,
  type RenderPipelineFrame,
  type RenderPipelineTarget,
  type RenderPipelineTopology,
} from '../render-pipeline';
import { usesTsrCompute } from './capabilities';
import { TSR_ANALYSIS_FORMATS } from './layout';

/** Capture bounded opaque color before fog, transmission and transparency mutate scene. */
export function addTsrOpaqueGuide(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  scene: RenderPipelineTarget,
) {
  if (topology.camera.antialias !== 'tsr') return ok(undefined);
  const target = createRenderPipelineTarget(graph, 'tsr-opaque-guide', {
    format: TSR_ANALYSIS_FORMATS.opaque,
    size: renderInternalSize(topology),
  });
  if (!target.ok) return target;
  if (!usesTsrCompute(topology.lane)) {
    let state: RasterState | undefined;
    const bindings: { source: unknown; group: import('@forgeax/engine-rhi').BindGroup }[] = [];
    const added = graph.addRasterPass('tsr-measure-opaque', {
      accesses: [
        { resource: scene.view, usage: 'sampled-read' },
        { resource: target.value.view, usage: 'color-attachment' },
      ],
      colorAttachments: [{ view: target.value.view, loadOp: 'clear', storeOp: 'store' }],
      encodeDirect(pass, frame, resources) {
        state ??= createRasterState(
          frame,
          TSR_OPAQUE_FRAGMENT_WGSL,
          'tsr-measure-opaque',
          [{ binding: 0, visibility: 2, texture: { sampleType: 'float', viewDimension: '2d' } }],
          'tsr_fullscreen',
          'tsr_measure_opaque_fragment',
          [TSR_ANALYSIS_FORMATS.opaque],
        );
        const source = resources.textureView(scene.view).unwrap();
        let group = bindings.find((row) => row.source === source)?.group;
        if (!group) {
          group = frame.runtime.device
            .createBindGroup({
              layout: state.layout,
              entries: [{ binding: 0, resource: { kind: 'textureView', value: source } }],
            })
            .unwrap();
          if (bindings.length === 2) bindings.shift();
          bindings.push({ source, group });
        }
        pass.setPipeline(state.pipeline);
        pass.setBindGroup(0, group);
        const extent = renderInternalCopySize(topology);
        pass.setViewport(0, 0, extent.width, extent.height, 0, 1);
        pass.draw(3);
      },
    });
    return added.ok ? ok(target.value) : added;
  }
  let program: { readonly layout: BindGroupLayout; readonly pipeline: ComputePipeline } | undefined;
  const cached: {
    readonly source: unknown;
    readonly output: unknown;
    readonly group: BindGroup;
  }[] = [];
  const added = graph.addComputePass('tsr-measure-opaque', {
    accesses: [
      { resource: scene.view, usage: 'sampled-read' },
      { resource: target.value.view, usage: 'storage-write' },
    ],
    encodeDirect(pass, frame, resources) {
      const device = frame.runtime.device;
      if (!program) {
        const factory =
          frame.runtime.immediateShaderModuleFactory ?? frame.runtime.shaderModuleFactory;
        if (!factory) throw new Error('TSR requires a shader module factory');
        const module = factory
          .createShaderModule({ label: 'tsr-measure-opaque', code: TSR_OPAQUE_WGSL })
          .unwrap();
        const layout = device
          .createBindGroupLayout({
            entries: [
              { binding: 0, visibility: 4, texture: { sampleType: 'float', viewDimension: '2d' } },
              {
                binding: 1,
                visibility: 4,
                storageTexture: {
                  access: 'write-only',
                  format: TSR_ANALYSIS_FORMATS.opaque,
                  viewDimension: '2d',
                },
              },
            ],
          })
          .unwrap();
        const pipeline = device
          .createComputePipeline({
            label: 'tsr-measure-opaque',
            layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
            compute: { module, entryPoint: 'tsr_measure_opaque' },
          })
          .unwrap();
        program = { layout, pipeline };
      }
      const source = resources.textureView(scene.view).unwrap(),
        output = resources.textureView(target.value.view).unwrap();
      let group = cached.find((c) => c.source === source && c.output === output)?.group;
      if (!group) {
        group = device
          .createBindGroup({
            label: 'tsr-measure-opaque',
            layout: program.layout,
            entries: [
              { binding: 0, resource: { kind: 'textureView', value: source } },
              { binding: 1, resource: { kind: 'textureView', value: output } },
            ],
          })
          .unwrap();
        if (cached.length === 2) cached.shift();
        cached.push({ source, output, group });
      }
      pass.setPipeline(program.pipeline);
      pass.setBindGroup(0, group);
      const input = frame.camera.temporal?.input;
      pass.dispatchWorkgroups(
        Math.ceil((input?.internalWidth ?? frame.targetW) / 8),
        Math.ceil((input?.internalHeight ?? frame.targetH) / 8),
        1,
      );
    },
  });
  if (!added.ok) return added;
  return ok(target.value);
}
