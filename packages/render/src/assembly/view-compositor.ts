import {
  allocateRenderPassGeneration,
  encodeNativeRenderPass,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import type {
  BindGroup,
  BindGroupLayout,
  RenderPipeline,
  Result,
  RhiCommandEncoder,
  RhiDevice,
  RhiError,
  RhiRenderPassEncoder,
  Texture,
  TextureFormat,
  TextureView,
} from '@forgeax/engine-rhi';
import type { cameraViewExtent } from '../components/camera-view';
import {
  createRenderGraphPassInstrumentation,
  renderGraphPassInstrumentationActive,
} from '../record/frame-targets';
import { encodeFrameObservationCapture } from '../record/observation-capture';
import type { RenderSystemInternals } from '../record/render-context';
import type { RenderTargetPhysical } from '../targets/physical';
import { renderWorldFor } from '../world/render-world';
import { retireAfterSubmission } from '../world/submission-systems';

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

/** The produced camera picture owns its sampled binding until replaced or retired. */
export interface CompositeSource {
  readonly texture: Texture;
  readonly width: number;
  readonly height: number;
  binding?: {
    readonly layout: BindGroupLayout;
    readonly format: TextureFormat;
    readonly group: BindGroup;
  };
}

interface CompositeView {
  readonly source: CompositeSource | undefined;
  readonly viewport: ReturnType<typeof cameraViewExtent>;
  readonly channels: CompositeChannels;
}

function value<T>(result: Result<T, RhiError>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

function createCompositePrograms(
  internals: RenderSystemInternals,
  device: RhiDevice,
  format: TextureFormat,
  linear: boolean,
) {
  const factory = internals.immediateShaderModuleFactory;
  if (factory === undefined) return undefined;
  const module = value(
    factory.createShaderModule({ code: SOURCE, label: 'camera-view-composite' }),
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
  const sampler = value(device.createSampler({ minFilter: 'linear', magFilter: 'linear' }));
  const pipelines: Partial<Record<CompositeChannels, RenderPipeline>> = {};
  return {
    device,
    format,
    linear,
    layout,
    sampler,
    pipeline(channels: CompositeChannels): RenderPipeline {
      pipelines[channels] ??= value(
        device.createRenderPipeline({
          label: `camera-view-composite:${channels}`,
          layout: pipelineLayout,
          vertex: { module, entryPoint: 'vertex', buffers: [] },
          fragment: {
            module,
            entryPoint: linear ? 'linear_fragment' : 'fragment',
            targets: [{ format, writeMask: CHANNEL_WRITE_MASK[channels] }],
          },
          primitive: { topology: 'triangle-list', cullMode: 'none' },
        }),
      );
      return pipelines[channels];
    },
  };
}

type CompositePrograms = NonNullable<ReturnType<typeof createCompositePrograms>>;

function pictureBinding(
  programs: CompositePrograms,
  source: CompositeSource,
  format: TextureFormat,
  view?: TextureView,
): BindGroup {
  const previous = source.binding;
  if (previous?.layout === programs.layout && previous.format === format) return previous.group;
  const sampled = view ?? value(programs.device.createTextureView(source.texture, { format }));
  const group = value(
    programs.device.createBindGroup({
      layout: programs.layout,
      entries: [
        { binding: 0, resource: { kind: 'textureView', value: sampled } },
        { binding: 1, resource: { kind: 'sampler', value: programs.sampler } },
      ],
    }),
  );
  source.binding = { layout: programs.layout, format, group };
  return group;
}

function checkSource(source: CompositeSource | undefined, destination: Texture): void {
  if (source === undefined) throw new Error('Missing camera composite input');
  if (source.texture === destination)
    throw new RenderGraphError({
      code: 'access-conflict',
      expected: 'a camera picture and its color attachment are distinct textures',
      hint: 'compose to a separate output target',
      detail: {
        passName: 'camera-view-composite',
        resourceLabel: 'display',
        accesses: ['sampled-read', 'color-attachment'],
      },
    });
}

function drawPicture(
  pass: RhiRenderPassEncoder,
  pipeline: RenderPipeline,
  group: BindGroup,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  pass.setPipeline(pipeline);
  pass.setViewport(x, y, width, height, 0, 1);
  pass.setScissorRect(x, y, width, height);
  pass.setBindGroup(0, group);
  pass.draw(3);
}

interface ObservedOutput extends CompositeSource {
  readonly device: RhiDevice;
  readonly format: TextureFormat;
  readonly view: TextureView;
  readonly generation: number;
}

/** One active, copyable endpoint for a raw swapchain while readback is requested. */
function createObservedOutput(
  internals: RenderSystemInternals,
  width: number,
  height: number,
  format: TextureFormat,
): ObservedOutput {
  const device = internals.device;
  const texture = value(
    device.createTexture({
      label: 'observed-display',
      size: { width, height },
      format,
      usage: 0x10 | 0x04 | 0x01,
    }),
  );
  try {
    const view = value(device.createTextureView(texture, { format }));
    return {
      device,
      texture,
      view,
      width,
      height,
      format,
      generation: internals.deviceScope.generation,
    };
  } catch (cause) {
    device.destroyTexture(texture);
    throw cause;
  }
}

/** Issue the ordered rectangles directly into the destination for this frame. */
export function createViewCompositor(internals: RenderSystemInternals) {
  let programs: CompositePrograms | undefined;
  let observed: ObservedOutput | undefined;
  let generation = 0;
  let outputWidth = 0;
  let outputHeight = 0;
  function releaseObserved(): void {
    const old = observed;
    if (old === undefined) return;
    observed = undefined;
    retireAfterSubmission(renderWorldFor(internals), {
      generation: old.generation,
      queue: old.device.queue,
      release: () => old.device.destroyTexture(old.texture),
    });
  }
  return {
    get generation() {
      return generation;
    },
    dispose(): void {
      releaseObserved();
      programs = undefined;
      generation = 0;
    },
    encode(
      encoder: RhiCommandEncoder,
      pictures: readonly CompositeView[] | CompositeSource,
      output: Texture,
      target?: RenderTargetPhysical,
    ): boolean {
      const device = internals.device;
      const base = internals.getPipelineState();
      if (base === null) return false;
      const width = target?.descriptor.width ?? internals.canvas.width;
      const height = target?.descriptor.height ?? internals.canvas.height;
      const format = target?.descriptor.format ?? base.format;
      const linear = target !== undefined;
      const observeRaw =
        target === undefined &&
        base.surfaceProfile === 'raw-only' &&
        internals.deferFinalDisplayObservation !== true &&
        internals.observationCaptureDomains?.includes('final-display') === true;
      const observeDisplay =
        target === undefined && (base.surfaceProfile !== 'raw-only' || observeRaw);
      const replaced =
        programs?.device !== device || programs.format !== format || programs.linear !== linear;
      if (replaced) programs = createCompositePrograms(internals, device, format, linear);
      const ready = programs;
      if (ready === undefined) return false;
      const resize = width !== outputWidth || height !== outputHeight;
      if (replaced || resize) {
        releaseObserved();
        generation = allocateRenderPassGeneration();
        outputWidth = width;
        outputHeight = height;
      }
      // The composition procedure owns generation. A raw-only readback borrows
      // a per-request physical endpoint without changing the procedure identity.
      if (observeRaw) observed ??= createObservedOutput(internals, width, height, format);
      else releaseObserved();
      const endpoint = observed;
      const outputView = target?.view ?? value(device.createTextureView(output, { format }));
      const destination = endpoint?.texture ?? output;
      if ('texture' in pictures) checkSource(pictures, destination);
      else for (const picture of pictures) checkSource(picture.source, destination);

      const names = internals.framePassNames;
      const first = names?.length ?? 0;
      const frame = { encoder, nativePassNames: names };
      try {
        internals.observationGraphGeneration = generation;
        const instrumentation = renderGraphPassInstrumentationActive(internals)
          ? createRenderGraphPassInstrumentation({ internals, owner: 'composition', generation })
          : undefined;
        encodeNativeRenderPass(
          frame,
          {
            kind: 'raster',
            name: 'camera-view-composite',
            descriptor: {
              label: 'camera-view-composite',
              colorAttachments: [
                {
                  view: endpoint?.view ?? outputView,
                  loadOp: 'clear',
                  storeOp: 'store',
                  clearValue: { r: 0, g: 0, b: 0, a: 1 },
                },
              ],
            },
            encode(pass) {
              if ('texture' in pictures) {
                drawPicture(
                  pass,
                  ready.pipeline('all'),
                  pictureBinding(ready, pictures, base.format),
                  0,
                  0,
                  pictures.width,
                  pictures.height,
                );
              } else {
                for (const picture of pictures) {
                  const source = picture.source;
                  if (source === undefined) throw new Error('Missing camera composite input');
                  const v = picture.viewport;
                  drawPicture(
                    pass,
                    ready.pipeline(picture.channels),
                    pictureBinding(ready, source, base.format),
                    v.x,
                    v.y,
                    v.width,
                    v.height,
                  );
                }
              }
            },
          },
          0,
          instrumentation,
        );
        if (endpoint !== undefined) {
          encodeNativeRenderPass(
            frame,
            {
              kind: 'raster',
              name: 'camera-view-present',
              descriptor: {
                label: 'camera-view-present',
                colorAttachments: [{ view: outputView, loadOp: 'clear', storeOp: 'store' }],
              },
              encode(pass) {
                drawPicture(
                  pass,
                  ready.pipeline('all'),
                  pictureBinding(ready, endpoint, format, endpoint.view),
                  0,
                  0,
                  width,
                  height,
                );
              },
            },
            1,
            instrumentation,
          );
        }
        if (observeDisplay) {
          encodeNativeRenderPass(
            frame,
            {
              kind: 'copy',
              name: 'final-display-observation',
              encode(commands) {
                encodeFrameObservationCapture(internals, commands, {
                  texture: destination,
                  domain: 'final-display',
                  format: base.format,
                  width,
                  height,
                  graphGeneration: generation,
                  frameNumber: internals.observationFrameId ?? 0,
                });
              },
            },
            endpoint === undefined ? 1 : 2,
            instrumentation,
          );
        }
        if (internals.observationFrameId !== undefined)
          internals.observationCaptureOwner?.recordGraph(internals.observationFrameId, generation);
      } catch (cause) {
        if (names !== undefined) names.length = first;
        throw cause;
      }
      return true;
    },
  };
}
