import type { RenderGraphBuilder, RenderGraphError } from '@forgeax/engine-render-graph';
import type {
  BindGroup,
  BindGroupLayout,
  Buffer,
  RenderPipeline,
  RhiDevice,
  Sampler,
  TextureView,
} from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import type { RenderPipelineFrame, RenderPipelineTarget } from '../render-pipeline';
import { addAtmosphereIbl, type GraphEnvironment } from './ibl';
import { addAtmosphereLuts } from './luts';
import { atmosphereStorage, stageAtmospherePublish } from './storage';
import { writeAtmosphereUniform } from './uniform';
import {
  type AtmosphereVisibility,
  atmosphereVisibilityAccesses,
  atmosphereVisibilityGroup,
  atmosphereVisibilityLayout,
} from './visibility';

const CUBE_SIZE = 128;

/** Group 0 of the `atmosphere_background` program, shared by scene and capture backgrounds. */
export function createAtmosphereBackgroundLayout(device: RhiDevice): BindGroupLayout {
  return device
    .createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 2, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 1, visibility: 2, sampler: { type: 'filtering' } },
        {
          binding: 2,
          visibility: 2,
          buffer: { type: 'uniform', minBindingSize: VIEW_UNIFORM_BYTES },
        },
        { binding: 3, visibility: 2, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 4, visibility: 2, texture: { sampleType: 'float', viewDimension: '2d' } },
      ],
    })
    .unwrap();
}

export function createAtmosphereBackgroundGroup(
  device: RhiDevice,
  layout: BindGroupLayout,
  input: {
    readonly sky: TextureView;
    readonly sampler: Sampler;
    readonly viewBuffer: Buffer;
    readonly viewOffset: number;
    readonly transmittance: TextureView;
    readonly multiple: TextureView;
  },
): BindGroup {
  return device
    .createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { kind: 'textureView', value: input.sky } },
        { binding: 1, resource: { kind: 'sampler', value: input.sampler } },
        {
          binding: 2,
          resource: {
            kind: 'buffer',
            value: { buffer: input.viewBuffer, offset: input.viewOffset, size: VIEW_UNIFORM_BYTES },
          },
        },
        { binding: 3, resource: { kind: 'textureView', value: input.transmittance } },
        { binding: 4, resource: { kind: 'textureView', value: input.multiple } },
      ],
    })
    .unwrap();
}

/** One device-owned sky cube feeds the graph background; the sun disc is added only there. */
export function addAtmosphereBackground(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  color: RenderPipelineTarget,
  visibility: AtmosphereVisibility = {},
): Result<GraphEnvironment, RenderGraphError> {
  const cube = graph.importTexture(
    'atmosphere-sky',
    {
      format: 'rgba16float',
      size: { width: CUBE_SIZE, height: CUBE_SIZE, depthOrArrayLayers: 6 },
      usage: 0x14,
    },
    (frame) => atmosphereStorage(frame).sky,
  );
  if (!cube.ok) return cube;
  const cubeView = graph.view(cube.value, { dimension: 'cube', arrayLayerCount: 6 });
  if (!cubeView.ok) return cubeView;
  const params = graph.importBuffer(
    'atmosphere-params',
    { size: VIEW_UNIFORM_BYTES, usage: 0x48 },
    (frame) => atmosphereStorage(frame).params,
  );
  if (!params.ok) return params;
  const vertices = graph.importBuffer(
    'atmosphere-face-vertices',
    { size: 6 * 3 * 3 * 4, usage: 0x28 },
    (frame) => atmosphereStorage(frame).vertices,
  );
  if (!vertices.ok) return vertices;
  const view = graph.importBuffer(
    'atmosphere-view',
    { size: VIEW_UNIFORM_BYTES, usage: 0x40 | 0x08 },
    (frame) => (frame as _InternalRenderPipelineContext).pipelineState.viewUniformBuffer,
  );
  if (!view.ok) return view;
  let state:
    | {
        cubePipeline: RenderPipeline;
        cubeLayout: BindGroupLayout;
        backgroundPipeline: RenderPipeline;
        backgroundLayout: BindGroupLayout;
        sampler: Sampler;
        cubeGroup?: BindGroup;
        backgroundGroup?: BindGroup;
      }
    | undefined;
  const frameOf = (frame: RenderPipelineFrame) => frame as _InternalRenderPipelineContext;
  const dirty = (frame: RenderPipelineFrame) =>
    frameOf(frame).frameState.environmentFrame?.environmentSignature !==
      atmosphereStorage(frame).submittedSignature &&
    atmosphereStorage(frame).recordedEncoder !== frame.encoder;
  const upload = graph.addCopyPass('atmosphere-prepare', {
    accesses: [
      { resource: params.value, usage: 'copy-dst' },
      { resource: vertices.value, usage: 'copy-dst' },
    ],
    executeIf: dirty,
    encode: ({ frame, resources }) => {
      const environment = frameOf(frame).frameState.environmentFrame;
      const sun = environment?.sun;
      if (environment?.source.kind !== 'atmosphere' || sun === undefined) {
        throw new RhiError({
          code: 'webgpu-runtime-error',
          expected: 'selected Atmosphere frame carries its directional sun',
          hint: 'publish the validated resource-owner environment frame before graph recording',
        });
      }
      const settings = environment.source.atmosphere;
      const values = new Float32Array(VIEW_UNIFORM_BYTES / 4);
      values.set(
        sun.direction.map((v) => -v),
        16,
      );
      values.set(
        sun.color.map((v) => v * sun.intensity),
        20,
      );
      values.set(settings.capturePosition, 24);
      writeAtmosphereUniform(values, 292, settings, 96000);
      frame.runtime.device.queue
        .writeBuffer(resources.buffer(params.value).unwrap(), 0, values)
        .unwrap();
      const triangles = new Float32Array(6 * 9);
      for (let face = 0; face < 6; face += 1) {
        triangles.set([-1, -1, face + 1, 3, -1, face + 1, -1, 3, face + 1], face * 9);
      }
      frame.runtime.device.queue
        .writeBuffer(resources.buffer(vertices.value).unwrap(), 0, triangles)
        .unwrap();
    },
  });
  if (!upload.ok) return upload;
  const tables = addAtmosphereLuts(graph, params.value, dirty, visibility);
  if (!tables.ok) return tables;
  const ensureState = (frame: RenderPipelineFrame) => {
    if (state !== undefined) return state;
    const sources = frame.atmosphereShaders;
    const factory = frame.runtime.shaderModuleFactory;
    if (sources === undefined || factory === undefined) {
      throw new RhiError({
        code: 'shader-compile-failed',
        expected: 'shader manifest includes the Atmosphere cube and background programs',
        hint: 'rebuild the Engine shader manifest with the package-owned Atmosphere entries',
      });
    }
    const device = frame.runtime.device;
    const cubeModule = factory
      .createShaderModule({ code: sources.cube, label: 'atmosphere_cube' })
      .unwrap();
    const backgroundModule = factory
      .createShaderModule({ code: sources.background, label: 'atmosphere_background' })
      .unwrap();
    const cubeLayout = device
      .createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: 2,
            buffer: { type: 'uniform', minBindingSize: VIEW_UNIFORM_BYTES },
          },
          { binding: 1, visibility: 2, texture: { sampleType: 'float', viewDimension: '2d' } },
          { binding: 3, visibility: 2, sampler: { type: 'filtering' } },
        ],
      })
      .unwrap();
    const backgroundLayout = createAtmosphereBackgroundLayout(device);
    const cubePipeline = device
      .createRenderPipeline({
        label: 'atmosphere_cube',
        layout: device.createPipelineLayout({ bindGroupLayouts: [cubeLayout] }).unwrap(),
        vertex: {
          module: cubeModule,
          entryPoint: 'atmosphere_cubemap_vs',
          buffers: [
            {
              arrayStride: 12,
              attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
            },
          ],
        },
        fragment: {
          module: cubeModule,
          entryPoint: 'atmosphere_cubemap_fs',
          targets: [{ format: 'rgba16float' }],
        },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
      })
      .unwrap();
    const backgroundPipeline = device
      .createRenderPipeline({
        label: 'atmosphere_background',
        layout: device
          .createPipelineLayout({
            bindGroupLayouts: [backgroundLayout, atmosphereVisibilityLayout(device)],
          })
          .unwrap(),
        vertex: { module: backgroundModule, entryPoint: 'atmosphere_background_vs', buffers: [] },
        fragment: {
          module: backgroundModule,
          entryPoint: 'atmosphere_background_fs',
          targets: [{ format: color.format }],
        },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        multisample: { count: color.sampleCount },
      })
      .unwrap();
    const sampler = device
      .createSampler({ minFilter: 'linear', magFilter: 'linear', mipmapFilter: 'linear' })
      .unwrap();
    state = { cubePipeline, cubeLayout, backgroundPipeline, backgroundLayout, sampler };
    return state;
  };
  for (let face = 0; face < 6; face += 1) {
    const faceView = graph.view(cube.value, {
      dimension: '2d',
      baseArrayLayer: face,
      arrayLayerCount: 1,
    });
    if (!faceView.ok) return faceView;
    const pass = graph.addRasterPass(`atmosphere-cube-${face}`, {
      accesses: [
        { resource: faceView.value, usage: 'color-attachment' },
        { resource: params.value, usage: 'uniform-read' },
        { resource: vertices.value, usage: 'vertex-read' },
        { resource: tables.value.captureSky, usage: 'sampled-read' },
      ],
      colorAttachments: [{ view: faceView.value, loadOp: 'clear', storeOp: 'store' }],
      executeIf: dirty,
      encode: ({ pass, frame, resources }) => {
        const current = ensureState(frame);
        current.cubeGroup = frame.runtime.device
          .createBindGroup({
            layout: current.cubeLayout,
            entries: [
              {
                binding: 0,
                resource: {
                  kind: 'buffer',
                  value: {
                    buffer: resources.buffer(params.value).unwrap(),
                    size: VIEW_UNIFORM_BYTES,
                  },
                },
              },
              {
                binding: 1,
                resource: {
                  kind: 'textureView',
                  value: resources.textureView(tables.value.captureSky).unwrap(),
                },
              },
              { binding: 3, resource: { kind: 'sampler', value: current.sampler } },
            ],
          })
          .unwrap();
        pass.setPipeline(current.cubePipeline);
        pass.setBindGroup(0, current.cubeGroup);
        pass.setVertexBuffer(0, resources.buffer(vertices.value).unwrap());
        pass.draw(3, 1, face * 3, 0);
        if (face === 5) {
          const signature = frameOf(frame).frameState.environmentFrame?.environmentSignature;
          const storage = atmosphereStorage(frame);
          stageAtmospherePublish(frameOf(frame).frameState, () => {
            storage.submittedSignature = signature;
          });
        }
      },
    });
    if (!pass.ok) return pass;
  }
  const ibl = addAtmosphereIbl(graph, cubeView.value, vertices.value, dirty);
  if (!ibl.ok) return ibl;
  const background = graph.addRasterPass('atmosphere-background', {
    accesses: [
      ...atmosphereVisibilityAccesses(visibility),
      { resource: tables.value.skyView, usage: 'sampled-read' },
      { resource: tables.value.transmittance, usage: 'sampled-read' },
      { resource: tables.value.multipleScattering, usage: 'sampled-read' },
      { resource: view.value, usage: 'uniform-read' },
      { resource: color.view, usage: 'color-attachment' },
    ],
    // Initialize scene radiance before opaque and transparent draws. Geometry
    // uses the normal scene depth authority, so alpha blending sees the sky
    // and no later background pass can overwrite a transparent foreground.
    colorAttachments: [{ view: color.view, loadOp: 'clear', storeOp: 'store' }],
    encode: ({ pass, frame, resources }) => {
      const current = ensureState(frame);
      current.backgroundGroup = createAtmosphereBackgroundGroup(
        frame.runtime.device,
        current.backgroundLayout,
        {
          sky: resources.textureView(tables.value.skyView).unwrap(),
          sampler: current.sampler,
          viewBuffer: resources.buffer(view.value).unwrap(),
          viewOffset: 0,
          transmittance: resources.textureView(tables.value.transmittance).unwrap(),
          multiple: resources.textureView(tables.value.multipleScattering).unwrap(),
        },
      );
      pass.setPipeline(current.backgroundPipeline);
      pass.setBindGroup(0, current.backgroundGroup);
      pass.setBindGroup(
        1,
        atmosphereVisibilityGroup(
          frame,
          resources.buffer(view.value).unwrap(),
          0,
          visibility.directional === undefined
            ? undefined
            : resources.textureView(visibility.directional).unwrap(),
          visibility.cloud === undefined
            ? undefined
            : resources.textureView(visibility.cloud).unwrap(),
        ),
      );
      pass.draw(3);
    },
  });
  return background.ok ? ok({ ...ibl.value, atmosphere: tables.value }) : background;
}
