import type {
  GraphAccess,
  GraphBuffer,
  GraphResourceResolver,
  GraphTextureView,
  RenderGraphBuilder,
} from '@forgeax/engine-render-graph';
import {
  type BindGroupEntry,
  type BindGroupLayoutEntry,
  type ComputePipeline,
  type RenderPipeline,
  RhiError,
  type ShaderModule,
} from '@forgeax/engine-rhi';
import { shaderSourceDescriptor } from '@forgeax/engine-types';
import { getOrCreateFromChain } from '../record/mesh-ssbo';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import { registerScenePipelinePreparation } from '../record/scene-pipeline-preparation';
import type { RenderPipelineFrame, RenderPipelineTarget } from '../render-pipeline';
import { markPipelinePreparationPending } from '../render-system-presentation';
import { STANDARD_GBUFFER_COMPACT_PIPELINE_CONSTANTS } from '../standard-attachments';

const TILE_SIZE = 8;
const PARAM_BYTES = 96;
const GUIDE_BYTES_PER_PIXEL = 8;
// Two dispatchWorkgroupsIndirect commands followed by one drawIndirect command.
const COMMAND_BYTES = 40;
const VERTICAL_OFFSET = 12;
const COMPOSE_OFFSET = 24;

type Binding = {
  readonly layout: Omit<BindGroupLayoutEntry, 'visibility'>;
  readonly access: GraphAccess;
  readonly resolve: (resources: GraphResourceResolver) => BindGroupEntry['resource'];
};

function sampled(
  binding: number,
  view: GraphTextureView,
  sampleType: GPUTextureSampleType,
): Binding {
  return {
    layout: { binding, texture: { sampleType, viewDimension: '2d' } },
    access: { resource: view, usage: 'sampled-read' },
    resolve: (resources) => ({ kind: 'textureView', value: resources.textureView(view).unwrap() }),
  };
}

function storage(binding: number, view: GraphTextureView): Binding {
  return {
    layout: {
      binding,
      storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d' },
    },
    access: { resource: view, usage: 'storage-write' },
    resolve: (resources) => ({ kind: 'textureView', value: resources.textureView(view).unwrap() }),
  };
}

function bufferBinding(
  binding: number,
  resource: GraphBuffer,
  type: 'uniform' | 'storage' | 'read-only-storage',
  minBindingSize: number,
  initialized = false,
): Binding {
  return {
    layout: { binding, buffer: { type, minBindingSize } },
    access: {
      resource,
      usage:
        type === 'uniform'
          ? 'uniform-read'
          : type === 'read-only-storage'
            ? 'storage-read'
            : initialized
              ? 'storage-read-write'
              : 'storage-write',
    },
    resolve: (resources) => ({
      kind: 'buffer',
      value: { buffer: resources.buffer(resource).unwrap() },
    }),
  };
}

/** Frame-private half-resolution diffusion with GPU-built horizontal and vertical work lists. */
export function addSubsurfaceDiffusion(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  input: {
    readonly scene: RenderPipelineTarget;
    readonly diffuse: RenderPipelineTarget;
    readonly profiles: GraphTextureView;
    readonly normal: GraphTextureView;
    readonly depth: GraphTextureView;
    readonly size: { readonly width: number; readonly height: number };
    readonly scale: readonly [number, number];
    readonly quality: 'low' | 'high';
    readonly compact?: true;
  },
) {
  const size = { width: Math.ceil(input.size.width / 2), height: Math.ceil(input.size.height / 2) };
  const tilesX = Math.ceil(size.width / TILE_SIZE);
  const tilesY = Math.ceil(size.height / TILE_SIZE);
  const tileCount = tilesX * tilesY;
  // Two counts, one horizontal membership flag per tile, two full-capacity lists.
  const tileBytes = (2 + tileCount * 3) * Uint32Array.BYTES_PER_ELEMENT;
  const guideBytes = size.width * size.height * GUIDE_BYTES_PER_PIXEL;
  const params = graph.createBuffer('subsurface-params', { size: PARAM_BYTES });
  if (!params.ok) return params;
  const guide = graph.createBuffer('subsurface-half-guide', { size: guideBytes });
  if (!guide.ok) return guide;
  const tiles = graph.createBuffer('subsurface-tiles', { size: tileBytes });
  if (!tiles.ok) return tiles;
  const commands = graph.createBuffer('subsurface-indirect', { size: COMMAND_BYTES });
  if (!commands.ok) return commands;

  const halfTarget = (label: string) => {
    const texture = graph.createTexture(label, {
      size,
      format: 'rgba16float',
      domain: 'linear-hdr',
    });
    return texture.ok ? graph.view(texture.value, { dimension: '2d' }) : texture;
  };
  const halfDiffuse = halfTarget('subsurface-half-diffuse');
  if (!halfDiffuse.ok) return halfDiffuse;
  const horizontal = halfTarget('subsurface-half-horizontal');
  if (!horizontal.ok) return horizontal;
  const vertical = halfTarget('subsurface-half-vertical');
  if (!vertical.ok) return vertical;

  const payload = new ArrayBuffer(PARAM_BYTES);
  const viewParams = new Float32Array(payload, 0, 8);
  const profiles = new Uint32Array(payload, viewParams.byteLength);
  viewParams[3] = input.quality === 'low' ? 2 : 3;
  viewParams[4] = input.scale[0] * (size.width / input.size.width);
  viewParams[5] = input.scale[1] * (size.height / input.size.height);
  viewParams[7] = input.quality === 'low' ? 6 : 9;
  const upload = graph.addCopyPass(
    'subsurface-prepare',
    {
      accesses: [
        { resource: params.value, usage: 'copy-dst' },
        { resource: tiles.value, usage: 'copy-dst' },
        { resource: commands.value, usage: 'copy-dst' },
      ],
      encodeDirect: (encoder, frame, resources) => {
        const { camera, runtime } = frame;
        const limits = runtime.device.limits;
        const rowLength = Math.min(1024, tileCount, limits.maxComputeWorkgroupsPerDimension);
        if (
          !(rowLength > 0) ||
          Math.max(tilesX, tilesY, Math.ceil(tileCount / rowLength)) >
            limits.maxComputeWorkgroupsPerDimension ||
          Math.max(guideBytes, tileBytes, COMMAND_BYTES) > limits.maxStorageBufferBindingSize
        )
          throw new RhiError({
            code: 'rhi-not-available',
            expected:
              'subsurface tile grid and guide fit the device dispatch and storage binding limits',
            hint: 'reduce the internal render extent of this view',
          });
        encoder.clearBuffer(resources.buffer(tiles.value).unwrap(), 0, tileBytes);
        encoder.clearBuffer(resources.buffer(commands.value).unwrap(), 0, COMMAND_BYTES);
        viewParams[0] = camera.near;
        viewParams[1] = camera.far;
        viewParams[2] = Number(camera.projection === 'orthographic');
        viewParams[6] = rowLength;
        if (input.compact === true) {
          const profileTable = (frame as _InternalRenderPipelineContext).frameState
            .compactSubsurfaceProfiles;
          profiles.fill(0, profileTable?.length ?? 0);
          if (profileTable !== undefined) profiles.set(profileTable);
        }
        runtime.device.queue
          .writeBuffer(resources.buffer(params.value).unwrap(), 0, payload)
          .unwrap();
      },
    },
    'transfer',
  );
  if (!upload.ok) return upload;

  let module: ShaderModule | undefined;
  const shader = (frame: _InternalRenderPipelineContext) => {
    if (module !== undefined) return module;
    const code = frame.runtime.standardSceneShaders?.subsurface;
    const factory = frame.runtime.shaderModuleFactory;
    if (code === undefined || factory === undefined)
      throw new RhiError({
        code: 'shader-compile-failed',
        expected: 'cooked Standard subsurface diffusion shader and module factory',
        hint: 'rebuild shared shader inputs and initialize the Renderer',
      });
    const created = factory.createShaderModule(
      shaderSourceDescriptor(code, 'forgeax::engine-subsurface-diffusion'),
    );
    if (!created.ok && factory.isPending?.(created.error) === true) {
      markPipelinePreparationPending(frame.frameState, { code: 'scene-pipeline-preparation' });
      return;
    }
    module = created.unwrap();
    return module;
  };

  const surface = [
    sampled(1, input.profiles, 'uint'),
    sampled(2, input.normal, 'uint'),
    sampled(3, input.depth, 'depth'),
    bufferBinding(4, params.value, 'uniform', PARAM_BYTES),
  ];
  const original = sampled(0, input.diffuse.view, 'unfilterable-float');
  const writtenGuide = bufferBinding(8, guide.value, 'storage', guideBytes);
  const readGuide = bufferBinding(9, guide.value, 'read-only-storage', guideBytes);
  const readTiles = bufferBinding(11, tiles.value, 'read-only-storage', tileBytes);
  const indirect: GraphAccess = { resource: commands.value, usage: 'indirect-read' };

  const prepareStage = (
    bindings: readonly Binding[],
    visibility: number,
    label: string,
    frame: RenderPipelineFrame,
  ) => {
    const { device } = frame.runtime;
    const layout = device
      .createBindGroupLayout({
        label,
        entries: bindings.map(({ layout }) => ({ ...layout, visibility })),
      })
      .unwrap();
    const groups = new WeakMap<object, unknown>();
    return {
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
      group(context: _InternalRenderPipelineContext, resources: GraphResourceResolver) {
        const entries = bindings.map(({ layout, resolve }) => ({
          binding: layout.binding,
          resource: resolve(resources),
        }));
        return getOrCreateFromChain(
          groups,
          entries.map(({ resource }) =>
            resource.kind === 'buffer' ? resource.value.buffer : resource.value,
          ),
          label,
          () => device.createBindGroup({ layout, entries }).unwrap(),
          context.bindGroupCounts,
        );
      },
    };
  };

  const constants = input.compact === true ? STANDARD_GBUFFER_COMPACT_PIPELINE_CONSTANTS : {};
  const addCompute = (
    label: string,
    entryPoint: string,
    bindings: readonly Binding[],
    offset?: number,
  ) => {
    let stage: ReturnType<typeof prepareStage> | undefined;
    let pipeline: ComputePipeline | undefined;
    return graph.addComputePass(label, {
      accesses: [
        ...bindings.map(({ access }) => access),
        ...(offset === undefined ? [] : [indirect]),
      ],
      encodeDirect: (pass, frame, resources) => {
        const context = frame as _InternalRenderPipelineContext;
        const source = shader(context);
        if (source === undefined) return;
        stage ??= prepareStage(bindings, 4, label, frame);
        pipeline ??= frame.runtime.device
          .createComputePipeline({
            label,
            layout: stage.layout,
            compute: { module: source, entryPoint, constants },
          })
          .unwrap();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, stage.group(context, resources));
        if (offset === undefined) pass.dispatchWorkgroups(tilesX, tilesY, 1);
        else pass.dispatchWorkgroupsIndirect(resources.buffer(commands.value).unwrap(), offset);
      },
    });
  };

  const setup = addCompute('subsurface-setup', 'cs_subsurface_setup', [
    original,
    ...surface,
    storage(5, halfDiffuse.value),
    storage(6, horizontal.value),
    storage(7, vertical.value),
    writtenGuide,
    bufferBinding(10, tiles.value, 'storage', tileBytes, true),
    bufferBinding(12, commands.value, 'storage', COMMAND_BYTES, true),
  ]);
  if (!setup.ok) return setup;
  const h = addCompute(
    'subsurface-horizontal',
    'cs_subsurface_horizontal',
    [
      ...surface,
      storage(6, horizontal.value),
      readGuide,
      readTiles,
      sampled(13, halfDiffuse.value, 'unfilterable-float'),
    ],
    0,
  );
  if (!h.ok) return h;
  const v = addCompute(
    'subsurface-vertical',
    'cs_subsurface_vertical',
    [
      ...surface,
      storage(7, vertical.value),
      readGuide,
      readTiles,
      sampled(14, horizontal.value, 'unfilterable-float'),
    ],
    VERTICAL_OFFSET,
  );
  if (!v.ok) return v;

  const label = 'subsurface-compose';
  const compose = [
    original,
    ...surface,
    readGuide,
    sampled(15, vertical.value, 'unfilterable-float'),
  ];
  let stage: ReturnType<typeof prepareStage> | undefined;
  let pipeline: RenderPipeline | undefined;
  const result = graph.addRasterPass(label, {
    accesses: [
      ...compose.map(({ access }) => access),
      indirect,
      { resource: input.scene.view, usage: 'color-attachment' },
    ],
    colorAttachments: [{ view: input.scene.view, loadOp: 'load', storeOp: 'store' }],
    encodeDirect: (pass, frame, resources) => {
      const context = frame as _InternalRenderPipelineContext;
      const source = shader(context);
      if (source === undefined) return;
      stage ??= prepareStage(compose, 2, label, frame);
      pipeline ??= frame.runtime.device
        .createRenderPipeline({
          label,
          layout: stage.layout,
          vertex: { module: source, entryPoint: 'vs_subsurface', buffers: [] },
          fragment: {
            module: source,
            entryPoint: 'fs_subsurface',
            constants,
            targets: [
              {
                format: input.scene.format,
                blend: {
                  color: { operation: 'add', srcFactor: 'one', dstFactor: 'one' },
                  alpha: { operation: 'add', srcFactor: 'zero', dstFactor: 'one' },
                },
              },
            ],
          },
          primitive: { topology: 'triangle-list' },
        })
        .unwrap();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, stage.group(context, resources));
      pass.drawIndirect(resources.buffer(commands.value).unwrap(), COMPOSE_OFFSET);
    },
  });
  if (result.ok)
    registerScenePipelinePreparation(
      graph,
      (context) => {
        shader(context);
        return false;
      },
      'utility',
    );
  return result;
}
