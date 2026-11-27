import { allocateRenderPassGeneration, encodeNativeRenderPass } from '@forgeax/engine-render-graph';
import type {
  BindGroup,
  BindGroupLayout,
  RenderPipeline,
  RhiCommandEncoder,
  RhiDevice,
  RhiRenderPassEncoder,
  ShaderModule,
  Texture,
  TextureFormat,
  TextureView,
} from '@forgeax/engine-rhi';
import { RendererContractFailureError } from '../errors/render';
import { type OutputColorSpace, renderOutputGamutWgsl } from '../output-color-space';
import type { RendererOptions } from '../render-contract';
import type {
  SurfaceUiEncodeOutcome,
  SurfaceUiFailed,
  SurfaceUiFailureCode,
  SurfaceUiOutcome,
} from '../world/surface-ui';
import { createGpuUiRaster, type UiRetire } from './gpu-ui-raster';

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

function failureDetail(cause: unknown): string {
  if (cause instanceof RendererContractFailureError) return cause.detail.cause;
  return cause instanceof Error ? cause.message : String(cause);
}

/** Document data has no GPU authority; raster and composition belong to Renderer. */
export async function createUiCompositor(options: {
  readonly source: NonNullable<RendererOptions['ui']>;
  readonly device: RhiDevice;
  readonly format: TextureFormat;
  readonly createShaderModule: (device: RhiDevice, source: string) => Promise<ShaderModule>;
  /** Releases `release` once the GPU work that may still read the resource completed. */
  readonly retire: UiRetire;
}) {
  let device = options.device;
  let module = await options.createShaderModule(device, SOURCE);
  const raster =
    options.source.kind === 'sparse-strips'
      ? await createGpuUiRaster({
          device,
          shaders: options.source.shaders,
          createShaderModule: options.createShaderModule,
          retire: options.retire,
        })
      : undefined;
  let layout: BindGroupLayout | undefined;
  let texture: Texture | undefined;
  let binding: BindGroup | undefined;
  let width = 0;
  let height = 0;
  let pixels: Uint8Array | undefined;
  let uploaded = false;
  const pipelines = new Map<OutputColorSpace, RenderPipeline>();
  let color: OutputColorSpace | undefined;
  let layerPipeline: RenderPipeline | undefined;
  let preparedFrame: number | undefined;
  let generation = 0;
  let output: { texture: Texture; view: TextureView; binding: BindGroup } | undefined;
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
      options.retire(owner, release);
    }
  }

  function retireOutput(): void {
    const retired = output;
    const owner = device;
    output = undefined;
    if (retired !== undefined)
      options.retire(owner, () => value(owner.destroyTexture(retired.texture)));
  }

  function resize(nextWidth: number, nextHeight: number): void {
    retireOutput();
    width = nextWidth;
    height = nextHeight;
    generation = 0;
  }

  type Painted = boolean | SurfaceUiFailed;
  const fail = (frame: number, code: SurfaceUiFailureCode, detail: string): SurfaceUiFailed => ({
    kind: 'failed',
    frame,
    code,
    detail,
  });

  function paintSparse(
    source: Extract<NonNullable<RendererOptions['ui']>, { kind: 'sparse-strips' }>,
    frame: number,
    timeMs: number,
    nextWidth: number,
    nextHeight: number,
  ): Painted {
    if (raster === undefined)
      return fail(frame, 'ui-raster-failed', 'UI GPU raster is not initialized');
    const changed = source.paint(timeMs, nextWidth, nextHeight);
    if (changed !== null) {
      if (changed.width !== nextWidth || changed.height !== nextHeight)
        return fail(
          frame,
          'ui-paint-extent-mismatch',
          'UI raster extent differs from the physical output',
        );
      try {
        raster.prepare(changed);
      } catch (cause) {
        return fail(frame, 'ui-raster-failed', failureDetail(cause));
      }
    }
    const nextTexture = raster.texture;
    if (width !== nextWidth || height !== nextHeight) resize(nextWidth, nextHeight);
    if (texture !== nextTexture) {
      binding = undefined;
      texture = nextTexture;
      generation = 0;
    }
    return changed !== null;
  }

  function paintRgba(
    source: Extract<NonNullable<RendererOptions['ui']>, { kind: 'rgba' }>,
    frame: number,
    timeMs: number,
    nextWidth: number,
    nextHeight: number,
  ): Painted {
    const changed = source.paint(timeMs, nextWidth, nextHeight);
    if (
      changed !== null &&
      (!(changed instanceof Uint8Array) || changed.length !== nextWidth * nextHeight * 4)
    ) {
      return fail(
        frame,
        'ui-paint-invalid-bytes',
        `UI paint must return tightly packed premultiplied sRGB RGBA8 matching the physical output extent: expected ${nextWidth} × ${nextHeight} (${nextWidth * nextHeight * 4} bytes), received ${Object.prototype.toString.call(changed)} (${ArrayBuffer.isView(changed) ? changed.byteLength : 'unknown'} bytes)`,
      );
    }
    try {
      if (width !== nextWidth || height !== nextHeight) {
        retireTexture();
        resize(nextWidth, nextHeight);
        pixels = undefined;
        uploaded = false;
      }
      if (changed !== null) {
        // The source may recycle its WASM buffer after this call. Retain one
        // owned image so device recovery can reupload an otherwise clean UI.
        pixels ??= new Uint8Array(changed.byteLength);
        pixels.set(changed);
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
    } catch (cause) {
      return fail(frame, 'ui-device-operation-failed', failureDetail(cause));
    }
    return changed !== null;
  }

  function pictureLayout(): BindGroupLayout {
    layout ??= value(
      device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 2, texture: { sampleType: 'float', viewDimension: '2d' } },
        ],
      }),
    );
    return layout;
  }

  function pictureBinding(view: TextureView): BindGroup {
    return value(
      device.createBindGroup({
        layout: pictureLayout(),
        entries: [{ binding: 0, resource: { kind: 'textureView', value: view } }],
      }),
    );
  }

  function createPipeline(colorSpace: OutputColorSpace, blend: boolean): RenderPipeline {
    const factor = {
      operation: 'add',
      srcFactor: 'one',
      dstFactor: 'one-minus-src-alpha',
    } as const;
    return value(
      device.createRenderPipeline({
        label: blend ? 'screen-ui-composite' : 'screen-ui-present',
        layout: value(device.createPipelineLayout({ bindGroupLayouts: [pictureLayout()] })),
        vertex: { module, entryPoint: 'vertex', buffers: [] },
        fragment: {
          module,
          entryPoint: colorSpace === 'srgb' ? 'srgb' : 'display_p3',
          targets: [
            {
              format: options.format,
              ...(blend ? { blend: { color: factor, alpha: factor } } : {}),
            },
          ],
        },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
      }),
    );
  }

  function prepareCommands(colorSpace: OutputColorSpace, capture: boolean): void {
    if (texture !== undefined) {
      layerPipeline = pipelines.get(colorSpace);
      if (layerPipeline === undefined) {
        layerPipeline = createPipeline(colorSpace, true);
        pipelines.set(colorSpace, layerPipeline);
      }
      binding ??= pictureBinding(
        value(device.createTextureView(texture, { format: 'rgba8unorm' })),
      );
    } else {
      layerPipeline = undefined;
    }
    const changeOutput = capture !== (output !== undefined);
    if (capture && output === undefined) {
      presentPipeline ??= createPipeline('srgb', false);
      const allocated = value(
        device.createTexture({
          label: 'screen-ui-output',
          format: options.format,
          size: { width, height, depthOrArrayLayers: 1 },
          usage: 0x10 | 0x04 | 0x01,
          textureBindingViewDimension: '2d',
        }),
      );
      try {
        const view = value(device.createTextureView(allocated, { format: options.format }));
        output = { texture: allocated, view, binding: pictureBinding(view) };
      } catch (cause) {
        device.destroyTexture(allocated);
        throw cause;
      }
    } else if (!capture && output !== undefined) {
      retireOutput();
    }
    if (generation === 0 || color !== colorSpace || changeOutput)
      generation = allocateRenderPassGeneration();
    color = colorSpace;
  }

  function drawLayer(pass: RhiRenderPassEncoder): void {
    if (binding === undefined || layerPipeline === undefined) return;
    pass.setPipeline(layerPipeline);
    pass.setBindGroup(0, binding);
    pass.draw(3);
  }
  function present(pass: RhiRenderPassEncoder): void {
    if (output === undefined || presentPipeline === undefined)
      throw new Error('Missing prepared UI output');
    pass.setPipeline(presentPipeline);
    pass.setBindGroup(0, output.binding);
    pass.draw(3);
  }

  return {
    get output() {
      return output?.texture;
    },
    get generation(): number {
      return generation;
    },
    async recover(nextDevice: RhiDevice): Promise<void> {
      const nextModule = await options.createShaderModule(nextDevice, SOURCE);
      if (disposed) return;
      preparedFrame = undefined;
      generation = 0;
      retireOutput();
      retireTexture();
      device = nextDevice;
      module = nextModule;
      layout = undefined;
      layerPipeline = undefined;
      pipelines.clear();
      presentPipeline = undefined;
      uploaded = false;
      await raster?.recover(nextDevice);
    },
    prepare(
      frame: number,
      timeMs: number,
      nextWidth: number,
      nextHeight: number,
      colorSpace: OutputColorSpace,
      capture: boolean,
    ): SurfaceUiOutcome {
      preparedFrame = undefined;
      if (disposed) return fail(frame, 'ui-device-operation-failed', 'UI compositor is disposed');
      const source = options.source;
      const painted =
        source.kind === 'sparse-strips'
          ? paintSparse(source, frame, timeMs, nextWidth, nextHeight)
          : paintRgba(source, frame, timeMs, nextWidth, nextHeight);
      if (typeof painted !== 'boolean') return painted;
      try {
        prepareCommands(colorSpace, capture);
      } catch (cause) {
        return fail(frame, 'ui-device-operation-failed', failureDetail(cause));
      }
      preparedFrame = frame;
      return { kind: painted ? 'painted' : 'retained', frame, generation };
    },
    encode(
      frame: number,
      encoder: RhiCommandEncoder,
      surface: Texture,
      clear: boolean,
      nativePassNames?: string[],
    ): SurfaceUiEncodeOutcome {
      if (preparedFrame !== frame)
        return {
          kind: 'failed',
          frame,
          code: 'ui-raster-failed',
          detail: 'prepare the UI for this frame before encoding',
        };
      const first = nativePassNames?.length ?? 0;
      try {
        raster?.encode(encoder);
        const surfaceView = value(device.createTextureView(surface, { format: options.format }));
        const context = { encoder, nativePassNames };
        encodeNativeRenderPass(
          context,
          {
            name: 'screen-ui-composite',
            kind: 'raster',
            descriptor: {
              label: 'screen-ui-composite',
              colorAttachments: [
                {
                  view: output?.view ?? surfaceView,
                  loadOp: clear ? 'clear' : 'load',
                  storeOp: 'store',
                  clearValue: { r: 0, g: 0, b: 0, a: 1 },
                },
              ],
            },
            encode: drawLayer,
          },
          0,
        );
        if (output !== undefined)
          encodeNativeRenderPass(
            context,
            {
              name: 'screen-ui-present',
              kind: 'raster',
              descriptor: {
                label: 'screen-ui-present',
                colorAttachments: [
                  {
                    view: surfaceView,
                    loadOp: 'clear',
                    storeOp: 'store',
                    clearValue: { r: 0, g: 0, b: 0, a: 1 },
                  },
                ],
              },
              encode: present,
            },
            1,
          );
      } catch (cause) {
        if (nativePassNames !== undefined) nativePassNames.length = first;
        return { kind: 'failed', frame, code: 'ui-raster-failed', detail: failureDetail(cause) };
      }
      return { kind: 'encoded' };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      preparedFrame = undefined;
      generation = 0;
      retireOutput();
      retireTexture();
      pixels = undefined;
      presentPipeline = undefined;
      layerPipeline = undefined;
      layout = undefined;
      raster?.dispose();
      pipelines.clear();
    },
  };
}
