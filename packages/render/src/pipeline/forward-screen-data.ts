import type { GraphTextureView, RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type {
  BindGroup,
  BindGroupLayout,
  BindGroupLayoutEntry,
  RenderPipeline,
} from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { ok, shaderSourceDescriptor } from '@forgeax/engine-types';
import {
  buildCapsuleShadowFrame,
  capsuleTileTableWords,
  MAX_FRAME_CAPSULES,
} from '../capsule-shadow/frame';
import type { ProjectedDecalChannels } from '../decals/graph';
import { getOrCreateFromChain } from '../record/mesh-ssbo';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import {
  createRenderPipelineTarget,
  type RenderPipelineFrame,
  type RenderPipelineTarget,
} from '../render-pipeline';
import type { StandardSceneSurfaceDataTargets } from '../temporal/standard-scene-data';
import type { StandardClusterGraphBuffers } from './standard-lighting/graph';

/** Four surface-data tiles share the existing Forward sampled transport. */
export const FORWARD_SCREEN_TILE_AXIS = 2;

type ScreenProgram = 'forwardContact' | 'forwardScreenCompose' | 'forwardScreenPack';
interface ScreenRaster {
  readonly program: ScreenProgram;
  readonly name: string;
  readonly inputs: readonly GraphTextureView[];
  readonly output: GraphTextureView;
  readonly format: GPUTextureFormat;
  readonly parameters: (frame: RenderPipelineFrame) => Uint32Array | Float32Array;
  readonly load?: boolean;
  readonly viewport?: { readonly y: number; readonly width: number; readonly height: number };
}

function screenLayout(program: ScreenProgram, inputCount: number): BindGroupLayoutEntry[] {
  if (program === 'forwardContact')
    return [
      { binding: 0, visibility: 2, texture: { sampleType: 'depth', viewDimension: '2d' } },
      { binding: 1, visibility: 2, texture: { sampleType: 'uint', viewDimension: '2d' } },
      { binding: 2, visibility: 2, buffer: { type: 'uniform' } },
      {
        binding: 3,
        visibility: 2,
        texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
      },
      { binding: 4, visibility: 2, texture: { sampleType: 'uint', viewDimension: '2d' } },
    ];
  return [
    { binding: 0, visibility: 2, buffer: { type: 'uniform' } },
    ...Array.from({ length: inputCount }, (_, index) => ({
      binding: index + 1,
      visibility: 2,
      texture: { sampleType: 'unfilterable-float' as const, viewDimension: '2d' as const },
    })),
  ];
}

/** Private assembly for the three fixed screen-data programs; the graph owns submission. */
function addScreenRaster(graph: RenderGraphBuilder<RenderPipelineFrame>, work: ScreenRaster) {
  const uniform = graph.createBuffer(`${work.name}-params`, {
    size: work.program === 'forwardScreenCompose' ? 32 : 16,
  });
  if (!uniform.ok) return uniform;
  const upload = graph.addCopyPass(`${work.name}-prepare`, {
    accesses: [{ resource: uniform.value, usage: 'copy-dst' }],
    encodeDirect: (_encoder, frame, resources) => {
      frame.runtime.device.queue
        .writeBuffer(resources.buffer(uniform.value).unwrap(), 0, work.parameters(frame))
        .unwrap();
    },
  });
  if (!upload.ok) return upload;
  const view =
    work.program === 'forwardContact'
      ? graph.importBuffer(
          `${work.name}-view`,
          { size: VIEW_UNIFORM_BYTES, usage: 72 },
          (frame) => frame.pipelineState.viewUniformBuffer,
        )
      : undefined;
  if (view !== undefined && !view.ok) return view;
  let prepared:
    | {
        readonly pipeline: RenderPipeline;
        readonly layout: BindGroupLayout;
        readonly viewLayout: BindGroupLayout | undefined;
        readonly groups: WeakMap<object, unknown>;
      }
    | undefined;
  return graph.addRasterPass(work.name, {
    accesses: [
      ...work.inputs.map((resource) => ({ resource, usage: 'sampled-read' as const })),
      { resource: uniform.value, usage: 'uniform-read' },
      ...(view === undefined ? [] : [{ resource: view.value, usage: 'uniform-read' as const }]),
      { resource: work.output, usage: 'color-attachment' },
    ],
    colorAttachments: [
      {
        view: work.output,
        loadOp: work.load ? 'load' : 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      },
    ],
    encodeDirect: (pass, frame, resources) => {
      const internal = frame as _InternalRenderPipelineContext;
      const device = frame.runtime.device;
      if (prepared === undefined) {
        const source = internal.runtime.standardSceneShaders?.[work.program];
        const factory = frame.runtime.shaderModuleFactory;
        if (source === undefined || factory === undefined)
          throw new RhiError({
            code: 'feature-not-enabled',
            expected: `cooked ${work.program} program`,
            hint: 'Rebuild the Engine shader manifest with Forward screen-data utilities.',
          });
        const module = factory
          .createShaderModule(shaderSourceDescriptor(source, `forgeax::engine-${work.name}`))
          .unwrap();
        const layout = device
          .createBindGroupLayout({ entries: screenLayout(work.program, work.inputs.length) })
          .unwrap();
        const viewLayout =
          view === undefined
            ? undefined
            : device
                .createBindGroupLayout({
                  entries: [
                    {
                      binding: 0,
                      visibility: 2,
                      buffer: {
                        type: 'uniform',
                        hasDynamicOffset: true,
                        minBindingSize: VIEW_UNIFORM_BYTES,
                      },
                    },
                  ],
                })
                .unwrap();
        const pipeline = device
          .createRenderPipeline({
            label: work.name,
            layout: device
              .createPipelineLayout({
                bindGroupLayouts: viewLayout !== undefined ? [viewLayout, layout] : [layout],
              })
              .unwrap(),
            vertex: { module, entryPoint: 'vs_main', buffers: [] },
            fragment: { module, entryPoint: 'fs_main', targets: [{ format: work.format }] },
            primitive: { topology: 'triangle-list' },
          })
          .unwrap();
        prepared = { pipeline, layout, viewLayout, groups: new WeakMap() };
      }
      const buffer = resources.buffer(uniform.value).unwrap();
      const textures = work.inputs.map((input) => resources.textureView(input).unwrap());
      const entries =
        work.program === 'forwardContact'
          ? [
              ...textures.map((value, index) => ({
                binding: index < 2 ? index : index + 1,
                resource: { kind: 'textureView' as const, value },
              })),
              { binding: 2, resource: { kind: 'buffer' as const, value: { buffer } } },
            ]
          : [
              { binding: 0, resource: { kind: 'buffer' as const, value: { buffer } } },
              ...textures.map((value, index) => ({
                binding: index + 1,
                resource: { kind: 'textureView' as const, value },
              })),
            ];
      const layout = prepared.layout;
      const group = getOrCreateFromChain(
        prepared.groups,
        [buffer, ...textures],
        work.name,
        () => device.createBindGroup({ layout, entries }).unwrap(),
        internal.bindGroupCounts,
      ) as BindGroup;
      pass.setPipeline(prepared.pipeline);
      if (view !== undefined && prepared.viewLayout !== undefined) {
        const viewBuffer = resources.buffer(view.value).unwrap();
        const layout = prepared.viewLayout;
        const viewGroup = getOrCreateFromChain(
          prepared.groups,
          [viewBuffer],
          `${work.name}-view`,
          () =>
            device
              .createBindGroup({
                layout,
                entries: [
                  {
                    binding: 0,
                    resource: {
                      kind: 'buffer',
                      value: { buffer: viewBuffer, offset: 0, size: VIEW_UNIFORM_BYTES },
                    },
                  },
                ],
              })
              .unwrap(),
          internal.bindGroupCounts,
        ) as BindGroup;
        pass.setBindGroup(0, viewGroup, [internal.viewBindGroupDynamicOffset ?? 0]);
        pass.setBindGroup(1, group);
      } else pass.setBindGroup(0, group);
      if (work.viewport !== undefined)
        pass.setViewport(0, work.viewport.y, work.viewport.width, work.viewport.height, 0, 1);
      pass.draw(3);
    },
  });
}

/** Bounded numeric textures carry the existing posed capsule/tile ABI to a raster consumer. */
function addForwardCapsuleTextures(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  size: { readonly width: number; readonly height: number },
  enabled: boolean,
) {
  const width = enabled ? 256 : 1;
  const capsuleHeight = enabled ? Math.ceil((MAX_FRAME_CAPSULES * 2) / width) : 1;
  const tileHeight = enabled
    ? Math.ceil(capsuleTileTableWords(size.width, size.height) / (width * 4))
    : 1;
  const capsules = graph.createTexture('forward-capsules', {
    format: 'rgba32float',
    size: { width, height: capsuleHeight },
    usage: 2 | 4,
  });
  if (!capsules.ok) return capsules;
  const tiles = graph.createTexture('forward-capsule-tiles', {
    format: 'rgba32uint',
    size: { width, height: tileHeight },
    usage: 2 | 4,
  });
  if (!tiles.ok) return tiles;
  const capsuleView = graph.view(capsules.value);
  if (!capsuleView.ok) return capsuleView;
  const tileView = graph.view(tiles.value);
  if (!tileView.ok) return tileView;
  const prepared = graph.addCopyPass('forward-capsules-prepare', {
    accesses: [
      { resource: capsuleView.value, usage: 'copy-dst' },
      { resource: tileView.value, usage: 'copy-dst' },
    ],
    encodeDirect: (_encoder, frame, resources) => {
      const internal = frame as _InternalRenderPipelineContext;
      const light = enabled ? internal.capsuleShadowLight : undefined;
      const current =
        light === undefined
          ? undefined
          : buildCapsuleShadowFrame(
              light.renderables,
              internal.materialFrame,
              frame.camera,
              light.direction,
              light.coneHalfAngle,
              size.width,
              size.height,
              internal.runtime.demandCapsuleShadow ?? (() => undefined),
            );
      if (current !== undefined && frame.camera.captureProjection === undefined)
        internal.frameState.capsuleShadowSubmission = current.submission;
      const capsuleRows = Math.max(1, Math.ceil((current?.capsules.length ?? 0) / (width * 4)));
      const tileRows = Math.max(1, Math.ceil((current?.tiles.length ?? 0) / (width * 4)));
      const capsuleData = new Float32Array(width * capsuleRows * 4);
      const tileData = new Uint32Array(width * tileRows * 4);
      if (current !== undefined) {
        capsuleData.set(current.capsules);
        tileData.set(current.tiles);
      }
      const queue = frame.runtime.device.queue;
      queue
        .writeTexture(
          { texture: resources.texture(capsules.value).unwrap() },
          capsuleData,
          { bytesPerRow: width * 16, rowsPerImage: capsuleRows },
          { width, height: capsuleRows, depthOrArrayLayers: 1 },
        )
        .unwrap();
      queue
        .writeTexture(
          { texture: resources.texture(tiles.value).unwrap() },
          tileData,
          { bytesPerRow: width * 16, rowsPerImage: tileRows },
          { width, height: tileRows, depthOrArrayLayers: 1 },
        )
        .unwrap();
    },
  });
  return prepared.ok ? ok({ capsules: capsuleView.value, tiles: tileView.value }) : prepared;
}

export function addForwardScreenData(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  input: {
    readonly size: { readonly width: number; readonly height: number };
    readonly surface: StandardSceneSurfaceDataTargets;
    readonly contact: boolean;
    readonly capsules?: boolean;
    readonly decals: ProjectedDecalChannels | undefined;
    readonly ao: RenderPipelineTarget | undefined;
    readonly clusters: StandardClusterGraphBuffers | null;
  },
) {
  const { size } = input;
  const neutral = createRenderPipelineTarget(graph, 'forward-screen-neutral', {
    size: { width: 1, height: 1 },
    format: 'rgba8unorm',
  });
  if (!neutral.ok) return neutral;
  const cleared = graph.addRasterPass('forward-screen-neutral', {
    accesses: [{ resource: neutral.value.view, usage: 'color-attachment' }],
    colorAttachments: [
      {
        view: neutral.value.view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      },
    ],
    encodeDirect: () => {},
  });
  if (!cleared.ok) return cleared;
  let contact: RenderPipelineTarget | undefined;
  if (input.contact || input.capsules) {
    const capsuleTextures = addForwardCapsuleTextures(graph, size, input.capsules === true);
    if (!capsuleTextures.ok) return capsuleTextures;
    const made = createRenderPipelineTarget(graph, 'forward-contact-shadow', {
      size,
      format: 'r8unorm',
      usage: 1,
    });
    if (!made.ok) return made;
    contact = made.value;
    const depth = graph.view(input.surface.depth.texture, {
      dimension: '2d',
      aspect: 'depth-only',
    });
    if (!depth.ok) return depth;
    const rendered = addScreenRaster(graph, {
      program: 'forwardContact',
      name: 'forward-contact-shadow',
      inputs: [
        depth.value,
        input.surface.normal.view,
        capsuleTextures.value.capsules,
        capsuleTextures.value.tiles,
      ],
      output: contact.view,
      format: contact.format,
      parameters: (frame) =>
        new Float32Array([
          (frame.camera.temporal?.temporalFrameIndex ?? 0) % 64,
          Number(input.contact),
          input.capsules
            ? ((frame as _InternalRenderPipelineContext).capsuleShadowLight?.coneHalfAngle ?? 0)
            : 0,
          Math.ceil(size.width / 16),
        ]),
    });
    if (!rendered.ok) return rendered;
  }
  const atlas = createRenderPipelineTarget(graph, 'forward-screen-data', {
    size: { width: size.width * 2, height: size.height * 2 },
    format: 'rgba16float',
    usage: 1,
  });
  if (!atlas.ok) return atlas;
  const composed = addScreenRaster(graph, {
    program: 'forwardScreenCompose',
    name: 'forward-screen-compose',
    inputs: [
      input.ao?.view ?? neutral.value.view,
      contact?.view ?? neutral.value.view,
      input.decals?.color.view ?? neutral.value.view,
      input.decals?.normal.view ?? neutral.value.view,
      input.decals?.roughness.view ?? neutral.value.view,
    ],
    output: atlas.value.view,
    format: atlas.value.format,
    parameters: () =>
      new Uint32Array([
        size.width,
        size.height,
        0,
        0,
        Number(input.ao !== undefined),
        Number(input.contact || input.capsules),
        Number(input.decals !== undefined),
        0,
      ]),
  });
  if (!composed.ok) return composed;
  if (input.clusters?.kind === 'texture') {
    const region = input.clusters.textureLayout.screen;
    if (region === undefined)
      throw new Error('Forward screen data requires its reserved Cluster texture region');
    const packed = addScreenRaster(graph, {
      program: 'forwardScreenPack',
      name: 'forward-screen-pack',
      inputs: [atlas.value.view],
      output: input.clusters.texture,
      format: 'rgba32uint',
      parameters: () => new Uint32Array([region.originY, region.textureWidth, 0, 0]),
      load: true,
      viewport: { y: region.originY, width: region.textureWidth, height: region.writeHeight },
    });
    if (!packed.ok) return packed;
  }
  return ok(atlas.value);
}
