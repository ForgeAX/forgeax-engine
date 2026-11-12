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

interface CompositeView {
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
  const variants = new Map<boolean, CompiledRenderGraph<Frame>>();
  const retireGraphs = () => {
    for (const graph of variants.values()) void graph.retire();
    variants.clear();
    compiled = undefined;
  };
  let key = '';
  return {
    get generation() {
      return compiled?.inspect().generation ?? 0;
    },
    dispose: retireGraphs,
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
      const { observeDisplay, observeRawDisplay, displayUsage } = displayObservationRoute(
        internals,
        target,
        base.surfaceProfile,
      );
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
      if (key !== nextKey) {
        retireGraphs();
        key = nextKey;
      }
      // Observation demand has only two raw-surface routes. Retain both so
      // diagnostic frames do not repeatedly compile and retire identical graphs.
      compiled = variants.get(observeRawDisplay);
      if (compiled === undefined) {
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
              usage: displayUsage,
            },
            (frame) => frame.output,
          ),
        );
        const colorView = unwrap(graph.view(color, { format }));
        // Raw-only swapchains are render-only. Demand a copyable encoded
        // endpoint only for observations; ordinary composition stays direct.
        const observedColor = observeRawDisplay
          ? unwrap(
              graph.createTexture('observed-display', {
                format,
                size: 'surface',
                usage: 0x10 | 0x04 | 0x01,
              }),
            )
          : color;
        const observedView = observeRawDisplay
          ? unwrap(graph.view(observedColor, { format }))
          : colorView;
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
              { resource: observedView, usage: 'color-attachment' },
            ],
            colorAttachments: [
              {
                view: observedView,
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
              },
            ],
            encodeDirect: (pass, frame, resolved) => {
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
        if (observeRawDisplay)
          unwrap(
            graph.addRasterPass('camera-view-present', {
              accesses: [
                { resource: observedView, usage: 'sampled-read' },
                { resource: colorView, usage: 'color-attachment' },
              ],
              colorAttachments: [{ view: colorView, loadOp: 'clear', storeOp: 'store' }],
              encodeDirect(pass, _frame, resolved) {
                pass.setPipeline(pipelineFor('all'));
                pass.setBindGroup(
                  0,
                  value(
                    device.createBindGroup({
                      layout: ready.layout,
                      entries: [
                        {
                          binding: 0,
                          resource: {
                            kind: 'textureView',
                            value: unwrap(resolved.textureView(observedView)),
                          },
                        },
                        { binding: 1, resource: { kind: 'sampler', value: ready.sampler } },
                      ],
                    }),
                  ),
                );
                pass.setViewport(0, 0, width, height, 0, 1);
                pass.setScissorRect(0, 0, width, height);
                pass.draw(3);
              },
            }),
          );
        if (observeDisplay)
          unwrap(
            graph.addCopyPass('final-display-observation', {
              accesses: [{ resource: observedView, usage: 'copy-src' }],
              encodeDirect: (encoder, _frame, resolved) =>
                encodeFrameObservationCapture(internals, encoder, {
                  texture: unwrap(resolved.texture(observedColor)),
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
        compiled = next;
        variants.set(observeRawDisplay, next);
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

/** Native copyable surfaces retain their stable copy pass; only raw-only
 * surfaces need a distinct observation route and encoded intermediate. */
function displayObservationRoute(
  internals: Pick<
    RenderSystemInternals,
    'deferFinalDisplayObservation' | 'observationCaptureDomains'
  >,
  target: RenderTargetDescriptor | undefined,
  surfaceProfile: 'dual-view' | 'raw-only' | undefined,
) {
  const requestedDisplay =
    target === undefined &&
    internals.deferFinalDisplayObservation !== true &&
    internals.observationCaptureDomains?.includes('final-display') === true;
  const observeRawDisplay = requestedDisplay && surfaceProfile === 'raw-only';
  const observeDisplay =
    target === undefined && (surfaceProfile !== 'raw-only' || observeRawDisplay);
  return {
    observeDisplay,
    observeRawDisplay,
    displayUsage: 0x10 | ((observeDisplay && !observeRawDisplay) || target?.readback ? 0x01 : 0),
  };
}
