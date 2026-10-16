import { type CompiledRenderGraph, RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type {
  BindGroupLayout,
  RenderPipeline,
  RhiCommandEncoder,
  Sampler,
  Texture,
  TextureFormat,
} from '@forgeax/engine-rhi';
import type { cameraViewExtent } from '../components/camera-view';
import { createPassTimingInstrumentation } from '../record/gpu-pass-timing/instrumentation';
import { encodeFrameObservationCapture } from '../record/observation-capture';
import type { RenderSystemInternals } from '../record/render-context';
import type { RenderTargetDescriptor } from '../targets/contracts';

const SOURCE = `
struct Vertex { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@vertex fn vertex(@builtin(vertex_index) i: u32) -> Vertex {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return Vertex(vec4f(p * 2.0 - 1.0, 0.0, 1.0), vec2f(p.x, 1.0 - p.y));
}
@group(0) @binding(0) var picture: texture_2d<f32>;
@group(0) @binding(1) var filtering: sampler;
@fragment fn fragment(input: Vertex) -> @location(0) vec4f {
  return textureSampleLevel(picture, filtering, input.uv, 0.0);
}
@fragment fn linear_fragment(input: Vertex) -> @location(0) vec4f {
  let color = textureSampleLevel(picture, filtering, input.uv, 0.0);
  let linear = select(pow((color.rgb + 0.055) / 1.055, vec3f(2.4)), color.rgb / 12.92, color.rgb <= vec3f(0.04045));
  return vec4f(linear, color.a);
}`;

/** Output channels a picture replaces; anaglyph eyes write complementary channels. */
export type CompositeChannels = 'all' | 'red' | 'cyan';

const CHANNEL_WRITE_MASK: Readonly<Record<CompositeChannels, number>> = Object.freeze({
  all: 0xf,
  red: 0x1 | 0x8,
  cyan: 0x2 | 0x4,
});

export interface CompositeView {
  readonly texture: Texture;
  readonly viewport: ReturnType<typeof cameraViewExtent>;
  readonly channels?: CompositeChannels;
}

/** Replace each rectangle in authored order, preserving encoded output exactly once. */
export function createViewCompositor(internals: RenderSystemInternals) {
  let resources:
    | {
        pipelines: Map<CompositeChannels, RenderPipeline>;
        create: (channels: CompositeChannels) => RenderPipeline;
        layout: BindGroupLayout;
        sampler: Sampler;
        format: TextureFormat;
      }
    | undefined;
  type Frame = { encoder: RhiCommandEncoder; views: readonly CompositeView[]; output: Texture };
  let compiled: CompiledRenderGraph<Frame> | undefined;
  let key = '';
  return {
    get generation() {
      return compiled?.inspect().generation ?? 0;
    },
    dispose() {
      void compiled?.retire();
      compiled = undefined;
    },
    encode(
      encoder: RhiCommandEncoder,
      views: readonly CompositeView[],
      output: Texture,
      target?: RenderTargetDescriptor,
    ): boolean {
      const device = internals.device;
      const base = internals.getPipelineState();
      if (base === null) return false;
      const width = target?.width ?? internals.canvas.width;
      const height = target?.height ?? internals.canvas.height;
      const format = target?.format ?? base.format;
      const value = <T>(
        result: import('@forgeax/engine-rhi').Result<T, import('@forgeax/engine-rhi').RhiError>,
      ): T => {
        if (!result.ok) throw result.error;
        return result.value;
      };
      if (resources === undefined || resources.format !== format) {
        const factory = internals.immediateShaderModuleFactory;
        if (factory === undefined) return false;
        const module = value(
          factory.createShaderModule({
            code: SOURCE,
            label: 'camera-view-composite',
          }),
        );
        const layout = value(
          device.createBindGroupLayout({
            entries: [
              { binding: 0, visibility: 2, texture: { sampleType: 'float', viewDimension: '2d' } },
              { binding: 1, visibility: 2, sampler: { type: 'filtering' } },
            ],
          }),
        );
        const pipelineLayout = value(device.createPipelineLayout({ bindGroupLayouts: [layout] }));
        const entryPoint = target === undefined ? 'fragment' : 'linear_fragment';
        const create = (channels: CompositeChannels) =>
          value(
            device.createRenderPipeline({
              label: `camera-view-composite:${channels}`,
              layout: pipelineLayout,
              vertex: { module, entryPoint: 'vertex', buffers: [] },
              fragment: {
                module,
                entryPoint,
                targets: [{ format, writeMask: CHANNEL_WRITE_MASK[channels] }],
              },
              primitive: { topology: 'triangle-list', cullMode: 'none' },
            }),
          );
        resources = {
          format,
          pipelines: new Map(),
          create,
          layout,
          sampler: value(device.createSampler({ minFilter: 'linear', magFilter: 'linear' })),
        };
      }
      const nextKey = JSON.stringify([
        width,
        height,
        format,
        views.map((v) => [v.viewport.renderWidth, v.viewport.renderHeight, v.channels ?? 'all']),
      ]);
      if (compiled === undefined || key !== nextKey) {
        const graph = new RenderGraphBuilder<Frame>();
        const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
          if (!r.ok) throw r.error;
          return r.value;
        };
        const color = unwrap(
          graph.importTexture(
            'display',
            {
              format,
              size: 'surface',
              usage: 0x10 | (target === undefined || target.readback ? 0x01 : 0),
            },
            (frame) => frame.output,
          ),
        );
        const colorView = unwrap(graph.view(color, { format }));
        const inputs = views.map((v, index) => {
          const texture = unwrap(
            graph.importTexture(
              `camera.${index}`,
              {
                format: base.format,
                size: { width: v.viewport.renderWidth, height: v.viewport.renderHeight },
                usage: 0x04,
              },
              (frame) => {
                const view = frame.views[index];
                if (view === undefined) throw new Error('Missing camera composite input');
                return view.texture;
              },
            ),
          );
          return unwrap(graph.view(texture, { format: base.format }));
        });
        const ready = resources;
        const pipelineFor = (channels: CompositeChannels) => {
          let pipeline = ready.pipelines.get(channels);
          if (pipeline === undefined) {
            pipeline = ready.create(channels);
            ready.pipelines.set(channels, pipeline);
          }
          return pipeline;
        };
        const viewPipelines = views.map((v) => pipelineFor(v.channels ?? 'all'));
        unwrap(
          graph.addRasterPass('camera-view-composite', {
            accesses: [
              ...inputs.map((resource) => ({ resource, usage: 'sampled-read' as const })),
              { resource: colorView, usage: 'color-attachment' },
            ],
            colorAttachments: [
              {
                view: colorView,
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
              },
            ],
            encode: ({ pass, frame, resources: resolved }) => {
              frame.views.forEach((view, index) => {
                const input = inputs[index];
                const pipeline = viewPipelines[index];
                if (input === undefined || pipeline === undefined)
                  throw new Error('Missing camera composite binding');
                pass.setPipeline(pipeline);
                const textureView = unwrap(resolved.textureView(input));
                const group = value(
                  device.createBindGroup({
                    layout: ready.layout,
                    entries: [
                      { binding: 0, resource: { kind: 'textureView', value: textureView } },
                      { binding: 1, resource: { kind: 'sampler', value: ready.sampler } },
                    ],
                  }),
                );
                const { x, y, width, height } = view.viewport;
                pass.setViewport(x, y, width, height, 0, 1);
                pass.setScissorRect(x, y, width, height);
                pass.setBindGroup(0, group);
                pass.draw(3);
              });
            },
          }),
        );
        if (target === undefined)
          unwrap(
            graph.addCopyPass('final-display-observation', {
              accesses: [{ resource: colorView, usage: 'copy-src' }],
              encode: ({ encoder, frame }) =>
                encodeFrameObservationCapture(internals, encoder, {
                  texture: frame.output,
                  domain: 'final-display',
                  format: base.format,
                  width: internals.canvas.width,
                  height: internals.canvas.height,
                  graphGeneration: compiled?.inspect().generation ?? 0,
                  frameNumber: internals.observationFrameId ?? 0,
                }),
            }),
          );
        const next = unwrap(
          graph.compile({
            device,
            surfaceSize: { width, height },
          }),
        );
        void compiled?.retire();
        compiled = next;
        key = nextKey;
      }
      const capture = internals.gpuPassTimingCapture;
      const executed = compiled.execute(
        { encoder, views, output },
        undefined,
        capture === undefined ? undefined : createPassTimingInstrumentation<Frame>(capture),
      );
      if (!executed.ok) throw executed.error;
      internals.framePassNames?.push(...compiled.inspect().passes.map((pass) => pass.name));
      if (target === undefined)
        internals.observationGraphGeneration = compiled.inspect().generation;
      return true;
    },
  };
}
