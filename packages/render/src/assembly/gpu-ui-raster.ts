import {
  type CompiledRenderGraph,
  type GraphAccess,
  type GraphTextureView,
  RenderGraphBuilder,
} from '@forgeax/engine-render-graph';
import type {
  BindGroup,
  BindGroupEntry,
  BindGroupLayout,
  BindGroupLayoutEntry,
  Buffer,
  RenderPipeline,
  RhiCommandEncoder,
  RhiDevice,
  Sampler,
  ShaderModule,
  Texture,
  TextureFormat,
  TextureView,
} from '@forgeax/engine-rhi';
import type { UiGpuDataTexture, UiGpuFrame, UiGpuPass, UiGpuShaders } from '@forgeax/engine-types';
import { RendererContractFailureError } from '../errors/render';

const sampled = (binding: number, sampleType: 'uint' | 'float'): BindGroupLayoutEntry => ({
  binding,
  visibility: 3,
  texture: { sampleType, viewDimension: '2d' },
});

/** Matches the pinned sparse-strip shader ABI, shared with real backend tests. */
const UI_GPU_PIPELINES = {
  strip: {
    stride: 24,
    formats: ['uint32', 'uint32', 'uint32', 'uint32', 'uint32', 'uint32'],
    groups: [
      [
        sampled(0, 'uint'),
        { binding: 1, visibility: 3, buffer: { type: 'uniform', minBindingSize: 32 } },
        sampled(2, 'float'),
      ],
      [sampled(0, 'float')],
      [sampled(0, 'uint')],
      [sampled(0, 'float')],
    ],
  },
  clear: { stride: 28, formats: ['uint32x2', 'uint32x2', 'uint32x2', 'uint32'], groups: [] },
  blend: {
    stride: 32,
    formats: Array<GPUVertexFormat>(8).fill('uint32'),
    groups: [[sampled(0, 'float'), sampled(1, 'float'), sampled(2, 'uint')]],
  },
  copy: {
    stride: 16,
    formats: Array<GPUVertexFormat>(4).fill('uint32'),
    groups: [[sampled(0, 'float')]],
  },
  filter: {
    stride: 36,
    formats: Array<GPUVertexFormat>(9).fill('uint32'),
    groups: [
      [sampled(0, 'uint')],
      [sampled(0, 'float'), { binding: 1, visibility: 2, sampler: { type: 'filtering' } }],
      [sampled(0, 'float')],
    ],
  },
} satisfies Record<
  UiGpuPass['kind'],
  {
    stride: number;
    formats: GPUVertexFormat[];
    groups: BindGroupLayoutEntry[][];
  }
>;

function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw result.error;
  return result.value;
}
function fail(detail: string): never {
  throw new RendererContractFailureError('draw', `UI raster: ${detail}`);
}

type Image = {
  texture: Texture;
  view: TextureView;
  width: number;
  height: number;
  format: TextureFormat;
};
type Pipeline = { pipeline: RenderPipeline; layouts: BindGroupLayout[] };

/** No device acquisition, queue submission, readback, DOM or WASM ownership. */
export async function createGpuUiRaster(options: {
  readonly device: RhiDevice;
  readonly shaders: UiGpuShaders;
  readonly createShaderModule: (device: RhiDevice, source: string) => Promise<ShaderModule>;
}) {
  let device = options.device;
  let pipelines = new Map<UiGpuPass['kind'], Pipeline>();
  let sampler: Sampler;
  const textures = new Map<string, Image>();
  const uniforms = new Map<number, Buffer>();
  let instances: Buffer | undefined;
  let instanceCapacity = 0;
  let graph: CompiledRenderGraph<{ encoder: RhiCommandEncoder }> | undefined;
  let lastSubmission: Promise<void> = Promise.resolve();
  let lastFrame: UiGpuFrame | undefined;
  let pending = false;
  let disposed = false;

  async function initialize(next: RhiDevice): Promise<void> {
    if (next.limits.maxBindGroups < 4 || next.limits.maxVertexAttributes < 9)
      fail('device requires four bind groups and nine vertex attributes');
    const nextPipelines = new Map<UiGpuPass['kind'], Pipeline>();
    for (const kind of Object.keys(UI_GPU_PIPELINES) as UiGpuPass['kind'][]) {
      const contract = UI_GPU_PIPELINES[kind];
      const module = await options.createShaderModule(next, options.shaders[kind]);
      const layouts = contract.groups.map((entries) =>
        value(next.createBindGroupLayout({ entries })),
      );
      let offset = 0;
      const attributes = contract.formats.map((format, shaderLocation) => {
        const attribute = { format, shaderLocation, offset };
        offset += format === 'uint32x2' ? 8 : 4;
        return attribute;
      });
      const pipeline = value(
        next.createRenderPipeline({
          label: `ui-raster-${kind}`,
          layout: value(next.createPipelineLayout({ bindGroupLayouts: layouts })),
          vertex: {
            module,
            entryPoint: 'vs_main',
            buffers: [{ arrayStride: contract.stride, stepMode: 'instance', attributes }],
          },
          fragment: {
            module,
            entryPoint: 'fs_main',
            targets: [
              {
                format: 'rgba8unorm',
                ...(kind === 'strip'
                  ? {
                      blend: {
                        color: {
                          operation: 'add' as const,
                          srcFactor: 'one' as const,
                          dstFactor: 'one-minus-src-alpha' as const,
                        },
                        alpha: {
                          operation: 'add' as const,
                          srcFactor: 'one' as const,
                          dstFactor: 'one-minus-src-alpha' as const,
                        },
                      },
                    }
                  : {}),
              },
            ],
          },
          primitive: { topology: 'triangle-strip', cullMode: 'none' },
        }),
      );
      nextPipelines.set(kind, { pipeline, layouts });
    }
    if (disposed) return;
    device = next;
    pipelines = nextPipelines;
    sampler = value(
      next.createSampler({
        minFilter: 'linear',
        magFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      }),
    );
  }

  function retireTexture(image: Image): void {
    const owner = device;
    const release = () => {
      value(owner.destroyTexture(image.texture));
    };
    void lastSubmission.then(release, release);
  }
  function retireBuffer(buffer: Buffer): void {
    const owner = device;
    const release = () => {
      value(owner.destroyBuffer(buffer));
    };
    void lastSubmission.then(release, release);
  }
  function discardGraph(): void {
    void graph?.retire();
    graph = undefined;
  }
  function releaseResources(): void {
    discardGraph();
    for (const image of textures.values()) retireTexture(image);
    textures.clear();
    for (const uniform of uniforms.values()) retireBuffer(uniform);
    uniforms.clear();
    if (instances !== undefined) retireBuffer(instances);
    instances = undefined;
    instanceCapacity = 0;
    pipelines.clear();
  }
  function image(
    key: string,
    width: number,
    height: number,
    format: TextureFormat,
    renderable = false,
  ): Image {
    let current = textures.get(key);
    if (
      current !== undefined &&
      (current.width !== width || current.height !== height || current.format !== format)
    ) {
      retireTexture(current);
      textures.delete(key);
      current = undefined;
    }
    if (current === undefined) {
      const texture = value(
        device.createTexture({
          label: `ui-${key}`,
          format,
          size: { width, height, depthOrArrayLayers: 1 },
          usage: 0x01 | 0x02 | 0x04 | (renderable ? 0x10 : 0),
          textureBindingViewDimension: '2d',
        }),
      );
      current = {
        texture,
        view: value(device.createTextureView(texture, { format })),
        width,
        height,
        format,
      };
      textures.set(key, current);
    }
    return current;
  }
  function upload(target: Image, data: Uint8Array): void {
    value(
      device.queue.writeTexture(
        { texture: target.texture },
        data,
        {
          bytesPerRow: target.width * (target.format === 'rgba32uint' ? 16 : 4),
          rowsPerImage: target.height,
        },
        { width: target.width, height: target.height, depthOrArrayLayers: 1 },
      ),
    );
  }
  function integer(n: number, label: string, maximum = 0xffffffff): void {
    if (!Number.isSafeInteger(n) || n < 0 || n > maximum)
      fail(`${label} is outside its integer range`);
  }
  function extent(width: number, height: number): void {
    integer(width, 'width', Math.min(65535, device.limits.maxTextureDimension2D));
    integer(height, 'height', Math.min(65535, device.limits.maxTextureDimension2D));
    if (width === 0 || height === 0) fail('texture extent must be nonzero');
  }
  function dataTexture(data: UiGpuDataTexture, bytesPerPixel: number, powerOfTwo = false): void {
    extent(data.width, data.height);
    if (
      !(data.data instanceof Uint8Array) ||
      data.data.byteLength !== data.width * data.height * bytesPerPixel
    )
      fail('texture byte count differs from its extent');
    if (powerOfTwo && (data.width & (data.width - 1)) !== 0)
      fail('packed data texture width must be a power of two');
  }
  function validate(frame: UiGpuFrame): Set<number> {
    if (frame.version !== 1) fail('unsupported prepared scene version');
    extent(frame.width, frame.height);
    extent(frame.layerWidth, frame.layerHeight);
    if (frame.layerPages.length !== 2) fail('expected two layer parities');
    const targets = new Set([0]);
    if (frame.scratch) targets.add(1);
    for (const [parity, count] of frame.layerPages.entries()) {
      integer(count, 'layer page count', 32766);
      for (let page = 0; page < count; page++) targets.add(2 + 2 * page + parity);
    }
    dataTexture(frame.alphas, 16, true);
    dataTexture(frame.paints, 16, true);
    dataTexture(frame.filterData, 16);
    dataTexture(frame.gradients, 4);
    const ids = new Set<number>();
    for (const item of frame.images) {
      integer(item.id, 'image id');
      dataTexture(item, 4);
      if (ids.has(item.id)) fail('duplicate image id');
      ids.add(item.id);
    }
    let bytes = 0;
    const target = (id: number) => {
      if (!targets.has(id)) fail(`unknown target ${id}`);
    };
    for (const pass of frame.passes) {
      const contract = UI_GPU_PIPELINES[pass.kind];
      if (
        contract === undefined ||
        !(pass.instances instanceof Uint8Array) ||
        pass.instances.byteLength % contract.stride !== 0
      )
        fail('invalid raster pass or packed instance stride');
      bytes += pass.instances.byteLength;
      const output = pass.kind === 'blend' ? 1 : pass.target;
      target(output);
      const read = (id: number) => {
        target(id);
        if (id === output) fail('a raster pass reads its own output');
      };
      switch (pass.kind) {
        case 'strip':
          if (pass.child !== null) read(pass.child);
          if (pass.image !== null && !ids.has(pass.image)) fail('unknown image id');
          break;
        case 'clear':
          break;
        case 'blend':
          read(pass.even);
          read(pass.odd);
          break;
        case 'copy':
        case 'filter':
          read(pass.source);
          break;
      }
    }
    if (bytes > device.limits.maxBufferSize) fail('instance work exceeds the device buffer limit');
    return targets;
  }

  function prepare(frame: UiGpuFrame): void {
    if (disposed) fail('raster owner is disposed');
    const targets = validate(frame);
    discardGraph();
    const live = new Set(['dummy', 'alphas', 'paints', 'gradients', 'filterData']);
    const dummy = image('dummy', 1, 1, 'rgba8unorm');
    upload(dummy, new Uint8Array(4));
    for (const id of targets) {
      const key = `target:${id}`;
      live.add(key);
      image(
        key,
        id === 0 ? frame.width : frame.layerWidth,
        id === 0 ? frame.height : frame.layerHeight,
        'rgba8unorm',
        true,
      );
    }
    for (const name of ['alphas', 'paints', 'gradients', 'filterData'] as const) {
      const data = frame[name];
      upload(
        image(name, data.width, data.height, name === 'gradients' ? 'rgba8unorm' : 'rgba32uint'),
        data.data,
      );
    }
    for (const item of frame.images) {
      const key = `image:${item.id}`;
      live.add(key);
      const previous = textures.get(key);
      const next = image(key, item.width, item.height, 'rgba8unorm');
      if (next !== previous) upload(next, item.data);
    }
    for (const [key, retired] of textures)
      if (!live.has(key)) {
        textures.delete(key);
        retireTexture(retired);
      }
    for (const [id, buffer] of uniforms)
      if (!targets.has(id)) {
        uniforms.delete(id);
        retireBuffer(buffer);
      }
    const total = frame.passes.reduce((sum, pass) => sum + pass.instances.byteLength, 0);
    if (instances === undefined || total > instanceCapacity) {
      if (instances !== undefined) retireBuffer(instances);
      instanceCapacity = Math.max(4, total);
      instances = value(
        device.createBuffer({
          label: 'ui-raster-instances',
          size: instanceCapacity,
          usage: 0x08 | 0x20,
        }),
      );
    }
    const instanceBuffer = instances;
    const packed = new Uint8Array(total);
    let cursor = 0;
    for (const pass of frame.passes) {
      packed.set(pass.instances, cursor);
      cursor += pass.instances.byteLength;
    }
    if (total > 0) value(device.queue.writeBuffer(instanceBuffer, 0, packed));

    const builder = new RenderGraphBuilder<{ encoder: RhiCommandEncoder }>();
    const views = new Map<string, GraphTextureView>();
    const importedView = (key: string): GraphTextureView => {
      let view = views.get(key);
      if (view !== undefined) return view;
      const data = textures.get(key);
      if (data === undefined) return fail(`missing texture ${key}`);
      const imported = value(
        builder.importTexture(
          `ui-${key}`,
          {
            format: data.format,
            size: { width: data.width, height: data.height },
            usage: 0x01 | 0x02 | 0x04 | (key.startsWith('target:') ? 0x10 : 0),
          },
          () => data.texture,
        ),
      );
      view = value(builder.view(imported, { format: data.format }));
      views.set(key, view);
      return view;
    };
    const vertices = value(
      builder.importBuffer(
        'ui-raster-instances',
        { size: instanceCapacity, usage: 0x28 },
        () => instanceBuffer,
      ),
    );
    for (const id of targets) {
      if (id === 1) continue;
      const view = importedView(`target:${id}`);
      value(
        builder.addRasterPass(`ui-clear-target-${id}`, {
          accesses: [{ resource: view, usage: 'color-attachment' }],
          colorAttachments: [
            { view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } },
          ],
          encode() {},
        }),
      );
    }
    const configuration = new Map<
      number,
      { buffer: Buffer; resource: ReturnType<typeof builder.importBuffer> }
    >();
    const config = (target: number) => {
      let item = configuration.get(target);
      if (item !== undefined) return item;
      let buffer = uniforms.get(target);
      if (buffer === undefined) {
        buffer = value(
          device.createBuffer({ label: `ui-config-${target}`, size: 32, usage: 0x08 | 0x40 }),
        );
        uniforms.set(target, buffer);
      }
      const output = textures.get(`target:${target}`) ?? fail(`missing target ${target}`);
      value(
        device.queue.writeBuffer(
          buffer,
          0,
          new Uint32Array([
            output.width,
            output.height,
            4,
            Math.log2(frame.alphas.width),
            Math.log2(frame.paints.width),
            0,
            0,
            0,
          ]),
        ),
      );
      const retained = buffer;
      item = {
        buffer,
        resource: builder.importBuffer(
          `ui-config-${target}`,
          { size: 32, usage: 0x48 },
          () => retained,
        ),
      };
      configuration.set(target, item);
      return item;
    };
    cursor = 0;
    for (const [index, pass] of frame.passes.entries()) {
      const offset = cursor;
      cursor += pass.instances.byteLength;
      if (pass.instances.byteLength === 0) continue;
      const contract = UI_GPU_PIPELINES[pass.kind];
      const pipeline = pipelines.get(pass.kind) ?? fail(`missing pipeline ${pass.kind}`);
      const output = pass.kind === 'blend' ? 1 : pass.target;
      const reads = new Set<string>();
      const textureEntry = (binding: number, key: string): BindGroupEntry => {
        reads.add(key);
        const texture = textures.get(key) ?? fail(`missing texture ${key}`);
        return { binding, resource: { kind: 'textureView', value: texture.view } };
      };
      const groups: BindGroup[] = [];
      const bind = (entries: BindGroupEntry[]) => {
        const layout = pipeline.layouts[groups.length] ?? fail('missing bind group layout');
        groups.push(value(device.createBindGroup({ layout, entries })));
      };
      const extra: GraphAccess[] = [];
      switch (pass.kind) {
        case 'strip': {
          const uniform = config(output);
          bind([
            textureEntry(0, 'alphas'),
            {
              binding: 1,
              resource: { kind: 'buffer', value: { buffer: uniform.buffer, size: 32 } },
            },
            textureEntry(2, pass.child === null ? 'dummy' : `target:${pass.child}`),
          ]);
          bind([textureEntry(0, pass.image === null ? 'dummy' : `image:${pass.image}`)]);
          bind([textureEntry(0, 'paints')]);
          bind([textureEntry(0, 'gradients')]);
          extra.push({ resource: value(uniform.resource), usage: 'uniform-read' });
          break;
        }
        case 'clear':
          break;
        case 'blend':
          bind([
            textureEntry(0, `target:${pass.even}`),
            textureEntry(1, `target:${pass.odd}`),
            textureEntry(2, 'alphas'),
          ]);
          break;
        case 'copy':
          bind([textureEntry(0, `target:${pass.source}`)]);
          break;
        case 'filter': {
          bind([textureEntry(0, 'filterData')]);
          bind([
            textureEntry(0, `target:${pass.source}`),
            { binding: 1, resource: { kind: 'sampler', value: sampler } },
          ]);
          // The planner filters between layer pages; scratch only preserves
          // the original for shadow composition and is never a filter target.
          bind([textureEntry(0, frame.scratch ? 'target:1' : 'dummy')]);
          break;
        }
      }
      if (reads.has(`target:${output}`)) fail('raster pass has a sampled/attachment alias');
      const view = importedView(`target:${output}`);
      value(
        builder.addRasterPass(`ui-raster-${pass.kind}-${index}`, {
          accesses: [
            ...[...reads].map((key) => ({
              resource: importedView(key),
              usage: 'sampled-read' as const,
            })),
            ...extra,
            { resource: vertices, usage: 'vertex-read' },
            { resource: view, usage: 'color-attachment' },
          ],
          colorAttachments: [{ view, loadOp: 'load', storeOp: 'store' }],
          encode: ({ pass: encoder }) => {
            encoder.setPipeline(pipeline.pipeline);
            groups.forEach((group, slot) => {
              encoder.setBindGroup(slot, group);
            });
            encoder.setVertexBuffer(0, instanceBuffer, offset, pass.instances.byteLength);
            encoder.draw(4, pass.instances.byteLength / contract.stride);
          },
        }),
      );
    }
    graph = value(
      builder.compile({ device, surfaceSize: { width: frame.width, height: frame.height } }),
    );
    lastFrame = frame;
    pending = true;
  }

  await initialize(device);
  return {
    get texture(): Texture | undefined {
      return textures.get('target:0')?.texture;
    },
    prepare,
    encode(encoder: RhiCommandEncoder): void {
      if (pending && graph !== undefined) {
        value(graph.execute({ encoder }));
        pending = false;
      }
    },
    submitted(completed: Promise<void>): void {
      lastSubmission = completed;
    },
    async recover(next: RhiDevice): Promise<void> {
      releaseResources();
      await initialize(next);
      if (!disposed && lastFrame !== undefined) prepare(lastFrame);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      releaseResources();
      lastFrame = undefined;
    },
  };
}
