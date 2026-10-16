import {
  type BindGroup,
  type BindGroupLayout,
  type Buffer,
  type RenderPipeline,
  RhiError,
  type RhiRenderPassEncoder,
  type TextureFormat,
  type TextureView,
} from '@forgeax/engine-rhi';
import { toShared } from '@forgeax/engine-types';
import { getIblProbeBackgroundSource } from '../ibl/IblPipelineCache';
import { prepareMaterialSkylight } from '../record/main-pass-material';
import type {
  _InternalRenderPipelineContext,
  RenderSystemInternals,
} from '../record/render-context';
import type { CameraSnapshot } from '../render-contract';

export interface ProbeBackgroundResources {
  readonly pipeline: RenderPipeline;
  readonly layout: BindGroupLayout;
  readonly uniform: Buffer;
  readonly groups: WeakMap<TextureView, BindGroup>;
}

/** One shared buffer is sufficient: the probe owner schedules one face per frame. */
export async function createProbeBackgroundResources(
  runtime: RenderSystemInternals,
  format: TextureFormat,
): Promise<ProbeBackgroundResources | undefined> {
  const code = getIblProbeBackgroundSource();
  if (code === undefined) return undefined;
  const device = runtime.device;
  const descriptor = { code, label: 'reflection-probe-background' };
  const module =
    runtime.createShaderModule === undefined
      ? runtime.shaderModuleFactory?.createShaderModule(descriptor)
      : await runtime.createShaderModule(device, descriptor);
  if (module === undefined) return undefined;
  const layout = device
    .createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 2, texture: { sampleType: 'float', viewDimension: 'cube' } },
        { binding: 1, visibility: 2, sampler: { type: 'filtering' } },
        { binding: 2, visibility: 3, buffer: { type: 'uniform', minBindingSize: 80 } },
      ],
    })
    .unwrap();
  const pipeline = device
    .createRenderPipeline({
      label: descriptor.label,
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
      vertex: { module: module.unwrap(), entryPoint: 'probe_background_vs', buffers: [] },
      fragment: {
        module: module.unwrap(),
        entryPoint: 'probe_background_fs',
        targets: [{ format }],
      },
      primitive: { topology: 'triangle-list' },
      depthStencil: {
        format: 'depth32float-stencil8',
        depthWriteEnabled: false,
        depthCompare: 'greater-equal',
      },
    })
    .unwrap();
  const uniform = device
    .createBuffer({ label: descriptor.label, size: 80, usage: 0x40 | 0x08 })
    .unwrap();
  return { pipeline, layout, uniform, groups: new WeakMap() };
}

/** Capture the scene's environment in the same raw HDR pass as its geometry. */
export function recordProbeBackground(
  resources: ProbeBackgroundResources | undefined,
  context: _InternalRenderPipelineContext,
  camera: CameraSnapshot,
  pass: RhiRenderPassEncoder,
  environmentCube?: TextureView,
): void {
  if (
    environmentCube === undefined &&
    context.skylight === undefined &&
    context.skybox === undefined
  )
    return;
  if (resources === undefined)
    throw new RhiError({
      code: 'shader-compile-failed',
      expected: 'the compiled probe environment background program',
      hint: 'rebuild the Engine shader manifest before enabling ReflectionProbe',
    });
  const { skylightResources } = prepareMaterialSkylight(context);
  const skybox = context.skybox;
  const source = skybox ?? context.skylight;
  const image =
    source === undefined
      ? undefined
      : context.store.getCubemapGpuView(toShared<'EquirectAsset'>(source.equirectHandle));
  const view = environmentCube ?? image ?? skylightResources.prefilterView;
  const rotation =
    environmentCube === undefined ? (source?.rotation ?? [0, 0, 0, 1]) : [0, 0, 0, 1];
  const scale =
    environmentCube !== undefined || skybox !== undefined
      ? [1, 1, 1]
      : (context.skylight?.color.map((value) => value * (context.skylight?.intensity ?? 0)) ?? [
          0, 0, 0,
        ]);
  const pose = camera.world;
  context.runtime.device.queue
    .writeBuffer(
      resources.uniform,
      0,
      new Float32Array([
        pose[0] ?? 1,
        pose[1] ?? 0,
        pose[2] ?? 0,
        0,
        pose[4] ?? 0,
        pose[5] ?? 1,
        pose[6] ?? 0,
        0,
        pose[8] ?? 0,
        pose[9] ?? 0,
        pose[10] ?? 1,
        0,
        ...rotation,
        ...scale,
        0,
      ]),
    )
    .unwrap();
  let group = resources.groups.get(view);
  if (group === undefined) {
    group = context.runtime.device
      .createBindGroup({
        layout: resources.layout,
        entries: [
          { binding: 0, resource: { kind: 'textureView', value: view } },
          { binding: 1, resource: { kind: 'sampler', value: skylightResources.prefilterSampler } },
          { binding: 2, resource: { kind: 'buffer', value: { buffer: resources.uniform } } },
        ],
      })
      .unwrap();
    resources.groups.set(view, group);
  }
  pass.setPipeline(resources.pipeline);
  pass.setBindGroup(0, group);
  pass.draw(3);
}
