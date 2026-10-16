import {
  type CompiledRenderGraph,
  type GraphAccess,
  RenderGraphBuilder,
} from '@forgeax/engine-render-graph';
import type {
  BindGroup,
  BindGroupLayout,
  RenderPipeline,
  RhiCommandEncoder,
  RhiDevice,
  ShaderModule,
  Texture,
  TextureFormat,
} from '@forgeax/engine-rhi';
import { RendererContractFailureError } from '../errors/render';
import { type OutputColorSpace, renderOutputGamutWgsl } from '../output-color-space';
import type { RendererOptions } from '../render-contract';
import { createGpuUiRaster } from './gpu-ui-raster';

const SOURCE = `
${renderOutputGamutWgsl()}
struct Vertex { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@vertex fn vertex(@builtin(vertex_index) i: u32) -> Vertex {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return Vertex(vec4f(p * 2.0 - 1.0, 0.0, 1.0), vec2f(p.x, 1.0 - p.y));
}
@group(0) @binding(0) var picture: texture_2d<f32>;
fn pixel(input: Vertex) -> vec4f {
  return textureLoad(picture, vec2i(input.uv * vec2f(textureDimensions(picture))), 0);
}
@fragment fn srgb(input: Vertex) -> @location(0) vec4f { return pixel(input); }
@fragment fn display_p3(input: Vertex) -> @location(0) vec4f {
  let premultiplied = pixel(input);
  let color = premultiplied.rgb / max(premultiplied.a, 0.000001);
  let linear = select(pow((color + 0.055) / 1.055, vec3f(2.4)), color / 12.92, color <= vec3f(0.04045));
  let p3 = max(LINEAR_SRGB_TO_LINEAR_DISPLAY_P3 * linear, vec3f(0.0));
  let encoded = select(1.055 * pow(p3, vec3f(1.0 / 2.4)) - 0.055, 12.92 * p3, p3 <= vec3f(0.0031308));
  return vec4f(encoded * premultiplied.a, premultiplied.a);
}`;

function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw result.error;
  return result.value;
}

/** Document data has no GPU authority; raster and composition belong to Renderer. */
export async function createUiCompositor(options: {
  readonly source: NonNullable<RendererOptions['ui']>;
  readonly device: RhiDevice;
  readonly format: TextureFormat;
  readonly createShaderModule: (device: RhiDevice, source: string) => Promise<ShaderModule>;
}) {
  let device = options.device;
  let module = await options.createShaderModule(device, SOURCE);
  const raster =
    options.source.kind === 'sparse-strips'
      ? await createGpuUiRaster({
          device,
          shaders: options.source.shaders,
          createShaderModule: options.createShaderModule,
        })
      : undefined;
  let layout: BindGroupLayout | undefined;
  let texture: Texture | undefined;
  let binding: BindGroup | undefined;
  let width = 0;
  let height = 0;
  let pixels: Uint8Array | undefined;
  let uploaded = false;
  let lastSubmission: Promise<void> = Promise.resolve();
  const pipelines = new Map<OutputColorSpace, RenderPipeline>();
  type Frame = { encoder: RhiCommandEncoder; output: Texture };
  let graph: CompiledRenderGraph<Frame> | undefined;
  let graphKey = '';
  let output: Texture | undefined;
  let presentPipeline: RenderPipeline | undefined;
  let disposed = false;

  function retireTexture(): void {
    const retired = texture;
    const owner = device;
    texture = undefined;
    binding = undefined;
    if (retired !== undefined && raster === undefined) {
      const release = () => {
        value(owner.destroyTexture(retired));
      };
      void lastSubmission.then(release, release);
    }
  }

  function discardGraph(): void {
    void graph?.retire();
    graph = undefined;
    graphKey = '';
    const retired = output;
    const owner = device;
    output = undefined;
    if (retired !== undefined) {
      const release = () => {
        value(owner.destroyTexture(retired));
      };
      void lastSubmission.then(release, release);
    }
  }

  function prepareGraph(clear: boolean, colorSpace: OutputColorSpace, capture: boolean): void {
    const nextKey = `${width}:${height}:${clear}:${colorSpace}:${texture !== undefined}:${capture}`;
    if (graph === undefined || graphKey !== nextKey) {
      discardGraph();
      const builder = new RenderGraphBuilder<Frame>();
      const display = value(
        builder.importTexture(
          'display',
          {
            format: options.format,
            size: 'surface',
            usage: 0x10,
          },
          (frame) => frame.output,
        ),
      );
      if (capture) {
        output = value(
          device.createTexture({
            label: 'screen-ui-output',
            format: options.format,
            size: { width, height, depthOrArrayLayers: 1 },
            usage: 0x10 | 0x04 | 0x01,
            textureBindingViewDimension: '2d',
          }),
        );
      }
      const presentationOutput = output;
      const target =
        presentationOutput !== undefined
          ? value(
              builder.importTexture(
                'screen-ui-output',
                {
                  format: options.format,
                  size: 'surface',
                  usage: 0x10 | 0x04 | 0x01,
                  domain: 'display-encoded',
                },
                () => presentationOutput,
              ),
            )
          : display;
      const targetView = value(builder.view(target, { format: options.format }));
      let pipeline = pipelines.get(colorSpace);
      const reads: GraphAccess[] = [];
      if (texture !== undefined) {
        layout ??= value(
          device.createBindGroupLayout({
            entries: [
              {
                binding: 0,
                visibility: 2,
                texture: { sampleType: 'float', viewDimension: '2d' },
              },
            ],
          }),
        );
        if (pipeline === undefined) {
          pipeline = value(
            device.createRenderPipeline({
              label: 'screen-ui-composite',
              layout: value(device.createPipelineLayout({ bindGroupLayouts: [layout] })),
              vertex: { module, entryPoint: 'vertex', buffers: [] },
              fragment: {
                module,
                entryPoint: colorSpace === 'srgb' ? 'srgb' : 'display_p3',
                targets: [
                  {
                    format: options.format,
                    blend: {
                      color: {
                        operation: 'add',
                        srcFactor: 'one',
                        dstFactor: 'one-minus-src-alpha',
                      },
                      alpha: {
                        operation: 'add',
                        srcFactor: 'one',
                        dstFactor: 'one-minus-src-alpha',
                      },
                    },
                  },
                ],
              },
              primitive: { topology: 'triangle-list', cullMode: 'none' },
            }),
          );
          pipelines.set(colorSpace, pipeline);
        }
        const sourceTexture = texture;
        const source = value(
          builder.importTexture(
            'ui',
            {
              format: 'rgba8unorm',
              size: { width, height },
              usage: 0x04,
            },
            () => sourceTexture,
          ),
        );
        const view = value(builder.view(source, { format: 'rgba8unorm' }));
        binding ??= value(
          device.createBindGroup({
            layout,
            entries: [
              {
                binding: 0,
                resource: {
                  kind: 'textureView',
                  value: value(device.createTextureView(texture, { format: 'rgba8unorm' })),
                },
              },
            ],
          }),
        );
        reads.push({ resource: view, usage: 'sampled-read' });
      }
      const acceptedPipeline = pipeline;
      const acceptedBinding = binding;
      value(
        builder.addRasterPass('screen-ui-composite', {
          accesses: [...reads, { resource: targetView, usage: 'color-attachment' }],
          colorAttachments: [
            {
              view: targetView,
              loadOp: clear ? 'clear' : 'load',
              storeOp: 'store',
              clearValue: { r: 0, g: 0, b: 0, a: 1 },
            },
          ],
          encode: ({ pass }) => {
            if (acceptedPipeline === undefined || acceptedBinding === undefined) return;
            pass.setPipeline(acceptedPipeline);
            pass.setBindGroup(0, acceptedBinding);
            pass.draw(3);
          },
        }),
      );
      if (capture) {
        layout ??= value(
          device.createBindGroupLayout({
            entries: [
              { binding: 0, visibility: 2, texture: { sampleType: 'float', viewDimension: '2d' } },
            ],
          }),
        );
        presentPipeline ??= value(
          device.createRenderPipeline({
            label: 'screen-ui-present',
            layout: value(device.createPipelineLayout({ bindGroupLayouts: [layout] })),
            vertex: { module, entryPoint: 'vertex', buffers: [] },
            fragment: { module, entryPoint: 'srgb', targets: [{ format: options.format }] },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
          }),
        );
        const pipeline = presentPipeline;
        const presentLayout = layout;
        const displayView = value(builder.view(display, { format: options.format }));
        let presentBinding: BindGroup | undefined;
        value(
          builder.addRasterPass('screen-ui-present', {
            accesses: [
              { resource: targetView, usage: 'sampled-read' },
              { resource: displayView, usage: 'color-attachment' },
            ],
            colorAttachments: [
              {
                view: displayView,
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
              },
            ],
            encode: ({ pass, resources }) => {
              presentBinding ??= value(
                device.createBindGroup({
                  layout: presentLayout,
                  entries: [
                    {
                      binding: 0,
                      resource: {
                        kind: 'textureView',
                        value: value(resources.textureView(targetView)),
                      },
                    },
                  ],
                }),
              );
              pass.setPipeline(pipeline);
              pass.setBindGroup(0, presentBinding);
              pass.draw(3);
            },
          }),
        );
      }
      graph = value(builder.compile({ device, surfaceSize: { width, height } }));
      graphKey = nextKey;
    }
  }

  return {
    get output() {
      return output;
    },
    get generation(): number {
      return graph?.inspect().generation ?? 0;
    },
    async recover(nextDevice: RhiDevice): Promise<void> {
      const nextModule = await options.createShaderModule(nextDevice, SOURCE);
      if (disposed) return;
      discardGraph();
      retireTexture();
      device = nextDevice;
      module = nextModule;
      layout = undefined;
      pipelines.clear();
      presentPipeline = undefined;
      uploaded = false;
      await raster?.recover(nextDevice);
    },
    prepare(
      timeMs: number,
      nextWidth: number,
      nextHeight: number,
      clear: boolean,
      colorSpace: OutputColorSpace,
      capture: boolean,
    ): void {
      if (disposed) throw new RendererContractFailureError('draw', 'UI compositor is disposed');
      if (options.source.kind === 'sparse-strips') {
        if (raster === undefined)
          throw new RendererContractFailureError('draw', 'UI GPU raster is not initialized');
        const changed = options.source.paint(timeMs, nextWidth, nextHeight);
        if (changed !== null) {
          if (changed.width !== nextWidth || changed.height !== nextHeight)
            throw new RendererContractFailureError(
              'draw',
              'UI raster extent differs from the physical output',
            );
          raster.prepare(changed);
        }
        const nextTexture = raster.texture;
        if (width !== nextWidth || height !== nextHeight || texture !== nextTexture) {
          discardGraph();
          binding = undefined;
          width = nextWidth;
          height = nextHeight;
          texture = nextTexture;
        }
      } else {
        const changed = options.source.paint(timeMs, nextWidth, nextHeight);
        if (
          changed !== null &&
          (!(changed instanceof Uint8Array) || changed.length !== nextWidth * nextHeight * 4)
        ) {
          throw new RendererContractFailureError(
            'draw',
            `UI paint must return tightly packed premultiplied sRGB RGBA8 matching the physical output extent: expected ${nextWidth} × ${nextHeight} (${nextWidth * nextHeight * 4} bytes), received ${Object.prototype.toString.call(changed)} (${ArrayBuffer.isView(changed) ? changed.byteLength : 'unknown'} bytes)`,
          );
        }
        if (width !== nextWidth || height !== nextHeight) {
          discardGraph();
          retireTexture();
          width = nextWidth;
          height = nextHeight;
          pixels = undefined;
          uploaded = false;
        }
        if (changed !== null) {
          // The source may recycle its WASM buffer after this call. Retain one
          // owned image so device recovery can reupload an otherwise clean UI.
          pixels = changed.slice();
          uploaded = false;
        }
        if (pixels !== undefined && !uploaded) {
          if (texture === undefined) {
            texture = value(
              device.createTexture({
                label: 'screen-ui-pixels',
                size: { width, height, depthOrArrayLayers: 1 },
                format: 'rgba8unorm',
                usage: 0x02 | 0x04,
                textureBindingViewDimension: '2d',
              }),
            );
          }
          value(
            device.queue.writeTexture(
              { texture },
              pixels,
              { bytesPerRow: width * 4, rowsPerImage: height },
              { width, height, depthOrArrayLayers: 1 },
            ),
          );
          uploaded = true;
        }
      }
      prepareGraph(clear, colorSpace, capture);
    },
    encode(encoder: RhiCommandEncoder, surface: Texture): void {
      if (graph === undefined)
        throw new RendererContractFailureError('draw', 'prepare the UI before encoding');
      raster?.encode(encoder);
      value(graph.execute({ encoder, output: surface }));
    },
    submitted(completed: Promise<void>): void {
      lastSubmission = completed;
      raster?.submitted(completed);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      discardGraph();
      retireTexture();
      pixels = undefined;
      raster?.dispose();
      pipelines.clear();
    },
  };
}
