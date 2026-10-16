import type {
  GraphTextureDescriptor,
  GraphTextureView,
  ImportedTextureDescriptor,
  RenderGraphBuilder,
} from '@forgeax/engine-render-graph';
import type { BindGroup, BindGroupLayout, RenderPipeline } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import { GPU_SHADER_STAGE_FRAGMENT, GPU_SHADER_STAGE_VERTEX } from '../gpu-stage';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_UNIFORM } from '../gpu-usage';
import { getOrCreateFromChain } from '../record/mesh-ssbo';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import { deriveRenderDataTexture } from '../render-data';
import {
  createRenderPipelineTarget,
  type RenderPipelineFrame,
  type RenderPipelineTarget,
} from '../render-pipeline';
import { ProjectedDecalInvalidError } from './component';
import { DECAL_TEXTURE_FIELDS, MAX_PROJECTED_DECALS, type ProjectedDecalSnapshot } from './extract';

export type ProjectedDecalTopology = readonly (readonly (
  | ImportedTextureDescriptor
  | undefined
)[])[];

/** Only resource shapes enter graph identity; transforms and material values stay per-frame. */
export function projectedDecalTopology(
  decals: readonly ProjectedDecalSnapshot[],
): ProjectedDecalTopology {
  if (decals.length > MAX_PROJECTED_DECALS)
    throw new ProjectedDecalInvalidError(
      'count',
      `at most ${MAX_PROJECTED_DECALS} visible decals across all Worlds`,
    );
  return decals.map((decal) =>
    decal.textures.map((texture) => {
      if (texture === undefined) return undefined;
      const layout = deriveRenderDataTexture(texture).unwrap();
      return {
        format: layout.format,
        size: layout.physicalExtent,
        mipLevelCount: layout.mipLevelCount,
        usage: layout.usage,
      };
    }),
  );
}

const PARAM_BYTES = 288;
const PARAM_STRIDE = 512;
function parameters(decal: ProjectedDecalSnapshot): Float32Array {
  const values = new Float32Array(PARAM_BYTES / 4);
  const material = decal.material;
  const params = material.paramSnapshot;
  const color = params?.baseColor;
  const normalScale = params?.normalScale;
  values.set(decal.inverse, 0);
  values.set(decal.transform, 16);
  values.set([...material.baseColor, Array.isArray(color) ? (color[3] ?? 1) : 1], 32);
  values.set([decal.colorOpacity, decal.normalOpacity, decal.roughnessOpacity, decal.opacity], 36);
  values.set(
    [
      material.roughness,
      Array.isArray(normalScale) ? (normalScale[0] ?? 1) : 1,
      Array.isArray(normalScale) ? (normalScale[1] ?? 1) : 1,
      decal.normalThreshold,
    ],
    40,
  );
  values.set(
    [
      decal.textures[1] === undefined ? 0 : 1,
      Number(params?.roughnessChannel ?? 1),
      Number(params?.alphaCutoff ?? 0),
      0,
    ],
    44,
  );
  DECAL_TEXTURE_FIELDS.forEach((field, index) => {
    const coordinates = material.textureCoordinates?.get(field);
    const transform = coordinates?.transform;
    const scale = transform?.scale ?? [1, 1];
    const offset = transform?.offset ?? [0, 0];
    const rotation = transform?.rotation ?? 0;
    const physical = coordinates?.physicalUvScale ?? [1, 1];
    const c = Math.cos(rotation);
    const s = Math.sin(rotation);
    values.set(
      [
        c * scale[0] * physical[0],
        -s * scale[1] * physical[0],
        offset[0] * physical[0],
        0,
        s * scale[0] * physical[1],
        c * scale[1] * physical[1],
        offset[1] * physical[1],
        0,
      ],
      48 + index * 8,
    );
  });
  return values;
}

function current(frame: RenderPipelineFrame, index: number) {
  const decal = frame.camera.projectedDecals?.[index];
  if (decal === undefined)
    throw new ProjectedDecalInvalidError('frame', 'the decal count used to compile this graph');
  const internal = frame as _InternalRenderPipelineContext;
  const scope =
    internal.resourceScopes?.[decal.worldId] ?? (decal.worldId === 0 ? internal.world : undefined);
  if (scope === undefined)
    throw new ProjectedDecalInvalidError('world', 'a live source resource scope');
  return { decal, internal, scope };
}

/** Three blended DBuffer channels, followed by one packed G-buffer composition. */
export function addProjectedDecalPasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  topology: ProjectedDecalTopology,
  input: {
    depth: GraphTextureView;
    normal: RenderPipelineTarget;
    albedo: RenderPipelineTarget;
    f0: RenderPipelineTarget;
    size: GraphTextureDescriptor['size'];
  },
) {
  if (topology.length === 0) return ok(input);
  const channels: RenderPipelineTarget[] = [];
  const outputs: RenderPipelineTarget[] = [];
  for (const name of ['color', 'normal', 'roughness']) {
    const channel = createRenderPipelineTarget(graph, `decal-${name}`, {
      format: 'rgba16float',
      size: input.size,
    });
    if (!channel.ok) return channel;
    channels.push(channel.value);
  }
  for (const name of ['normal', 'albedo', 'f0']) {
    const output = createRenderPipelineTarget(graph, `decal-surface-${name}`, {
      format: 'r32uint',
      size: input.size,
    });
    if (!output.ok) return output;
    outputs.push(output.value);
  }
  const uniforms = graph.createBuffer('decal-params', { size: topology.length * PARAM_STRIDE });
  if (!uniforms.ok) return uniforms;
  const view = graph.importBuffer(
    'decal-view',
    { size: VIEW_UNIFORM_BYTES, usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST },
    (frame) => frame.pipelineState.viewUniformBuffer,
  );
  if (!view.ok) return view;
  const textureViews: (GraphTextureView | undefined)[][] = [];
  for (const [index, descriptors] of topology.entries()) {
    const views: (GraphTextureView | undefined)[] = [];
    for (const [slot, descriptor] of descriptors.entries()) {
      if (descriptor === undefined) {
        views.push(undefined);
        continue;
      }
      const resident = (frame: RenderPipelineFrame) => {
        const { decal, internal, scope } = current(frame, index);
        const texture = decal.textures[slot];
        const handle = decal.material.textureHandles?.get(
          DECAL_TEXTURE_FIELDS[slot] as (typeof DECAL_TEXTURE_FIELDS)[number],
        );
        if (texture === undefined || handle === undefined)
          throw new ProjectedDecalInvalidError('texture', 'the declared texture slot');
        return internal.store.ensureResident(handle, texture, scope).unwrap();
      };
      const texture = graph.importTexture(
        `decal-${index}-texture-${slot}`,
        descriptor,
        (frame) => resident(frame).texture.handle,
      );
      if (!texture.ok) return texture;
      const view = graph.importView(
        texture.value,
        { dimension: '2d' },
        (frame) => resident(frame).view,
      );
      if (!view.ok) return view;
      views.push(view.value);
    }
    textureViews.push(views);
  }
  const upload = graph.addCopyPass('decal-prepare', {
    accesses: [{ resource: uniforms.value, usage: 'copy-dst' }],
    encode: ({ frame, resources }) => {
      const buffer = resources.buffer(uniforms.value).unwrap();
      topology.forEach((_, index) => {
        frame.runtime.device.queue
          .writeBuffer(buffer, index * PARAM_STRIDE, parameters(current(frame, index).decal))
          .unwrap();
      });
    },
  });
  if (!upload.ok) return upload;
  type State = {
    pipeline: RenderPipeline;
    layout: BindGroupLayout;
    groups: WeakMap<object, unknown>;
  };
  let project: State | undefined;
  const projectViews = [
    input.depth,
    input.normal.view,
    ...textureViews.flat().filter((view): view is GraphTextureView => view !== undefined),
  ];
  const projection = graph.addRasterPass('decal-project', {
    accesses: [
      ...projectViews.map((resource) => ({ resource, usage: 'sampled-read' as const })),
      ...channels.map(({ view: resource }) => ({ resource, usage: 'color-attachment' as const })),
      { resource: uniforms.value, usage: 'uniform-read' },
      { resource: view.value, usage: 'uniform-read' },
    ],
    colorAttachments: channels.map(({ view }) => ({
      view,
      loadOp: 'clear' as const,
      storeOp: 'store' as const,
      clearValue: { r: 0, g: 0, b: 0, a: 0 },
    })),
    encode: ({ pass, frame, resources }) => {
      const internal = frame as _InternalRenderPipelineContext;
      const device = frame.runtime.device;
      if (project === undefined) {
        const source = internal.runtime.standardDeferredShaders?.decalProject;
        const factory = frame.runtime.shaderModuleFactory;
        if (source === undefined || factory === undefined)
          throw new ProjectedDecalInvalidError('shader', 'cooked decal projection shader');
        const module = factory
          .createShaderModule({ code: source, label: 'forgeax::engine-decal-project' })
          .unwrap();
        const layout = device
          .createBindGroupLayout({
            entries: [
              {
                binding: 0,
                visibility: GPU_SHADER_STAGE_VERTEX | GPU_SHADER_STAGE_FRAGMENT,
                buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: PARAM_BYTES },
              },
              ...(['depth', 'uint', 'float', 'float', 'float'] as const).map(
                (sampleType, index) => ({
                  binding: index + 1,
                  visibility: GPU_SHADER_STAGE_FRAGMENT,
                  texture: { sampleType, viewDimension: '2d' as const },
                }),
              ),
              ...[6, 7, 8].map((binding) => ({
                binding,
                visibility: GPU_SHADER_STAGE_FRAGMENT,
                sampler: { type: 'filtering' as const },
              })),
            ],
          })
          .unwrap();
        const pipeline = device
          .createRenderPipeline({
            label: 'decal-project',
            layout: device
              .createPipelineLayout({
                bindGroupLayouts: [internal.pipelineState.viewBindGroupLayout, layout],
              })
              .unwrap(),
            vertex: { module, entryPoint: 'vs_main', buffers: [] },
            fragment: {
              module,
              entryPoint: 'fs_main',
              targets: channels.map(({ format }) => ({
                format,
                blend: {
                  color: {
                    operation: 'add' as const,
                    srcFactor: 'src-alpha' as const,
                    dstFactor: 'one-minus-src-alpha' as const,
                  },
                  alpha: {
                    operation: 'add' as const,
                    srcFactor: 'one' as const,
                    dstFactor: 'one-minus-src-alpha' as const,
                  },
                },
              })),
            },
            primitive: { topology: 'triangle-list' },
          })
          .unwrap();
        project = { pipeline, layout, groups: new WeakMap() };
      }
      pass.setPipeline(project.pipeline);
      if (internal.viewBindGroup === null)
        throw new ProjectedDecalInvalidError('view', 'a prepared camera bind group');
      pass.setBindGroup(0, internal.viewBindGroup, [internal.viewBindGroupDynamicOffset ?? 0, 0]);
      const buffer = resources.buffer(uniforms.value).unwrap();
      for (const [index, slots] of textureViews.entries()) {
        const { decal, scope } = current(frame, index);
        const views = [
          resources.textureView(input.depth).unwrap(),
          resources.textureView(input.normal.view).unwrap(),
          ...slots.map((view, slot) =>
            view === undefined
              ? slot === 1
                ? internal.pipelineState.defaultNormalTextureView
                : frame.pipelineState.defaultWhiteTextureView
              : resources.textureView(view).unwrap(),
          ),
        ];
        const samplers = DECAL_TEXTURE_FIELDS.map((field, slot) => {
          const handle = decal.material.samplerHandles?.get(field);
          const pod = decal.samplers[slot];
          return handle === undefined || pod === undefined
            ? frame.pipelineState.defaultSampler
            : internal.store.ensureSamplerResident(handle, pod, scope).unwrap();
        });
        const layout = project.layout;
        const group = getOrCreateFromChain(
          project.groups,
          [buffer, ...views, ...samplers],
          'decal-project',
          () =>
            device
              .createBindGroup({
                layout,
                entries: [
                  {
                    binding: 0,
                    resource: { kind: 'buffer', value: { buffer, offset: 0, size: PARAM_BYTES } },
                  },
                  ...views.map((value, i) => ({
                    binding: i + 1,
                    resource: { kind: 'textureView' as const, value },
                  })),
                  ...samplers.map((value, i) => ({
                    binding: i + 6,
                    resource: { kind: 'sampler' as const, value },
                  })),
                ],
              })
              .unwrap(),
          internal.bindGroupCounts,
        ) as BindGroup;
        pass.setBindGroup(1, group, [index * PARAM_STRIDE]);
        pass.draw(6);
      }
    },
  });
  if (!projection.ok) return projection;
  let apply: State | undefined;
  const applyViews = [
    input.normal.view,
    input.albedo.view,
    input.f0.view,
    ...channels.map(({ view }) => view),
  ];
  const composition = graph.addRasterPass('decal-apply', {
    accesses: [
      ...applyViews.map((resource) => ({ resource, usage: 'sampled-read' as const })),
      ...outputs.map(({ view: resource }) => ({ resource, usage: 'color-attachment' as const })),
    ],
    colorAttachments: outputs.map(({ view }) => ({
      view,
      loadOp: 'clear' as const,
      storeOp: 'store' as const,
    })),
    encode: ({ pass, frame, resources }) => {
      const internal = frame as _InternalRenderPipelineContext;
      const device = frame.runtime.device;
      if (apply === undefined) {
        const source = internal.runtime.standardDeferredShaders?.decalApply;
        const factory = frame.runtime.shaderModuleFactory;
        if (source === undefined || factory === undefined)
          throw new ProjectedDecalInvalidError('shader', 'cooked decal composition shader');
        const module = factory
          .createShaderModule({ code: source, label: 'forgeax::engine-decal-apply' })
          .unwrap();
        const layout = device
          .createBindGroupLayout({
            entries: applyViews.map((_, binding) => ({
              binding,
              visibility: GPU_SHADER_STAGE_FRAGMENT,
              texture: {
                sampleType: binding < 3 ? ('uint' as const) : ('unfilterable-float' as const),
                viewDimension: '2d' as const,
              },
            })),
          })
          .unwrap();
        const pipeline = device
          .createRenderPipeline({
            label: 'decal-apply',
            layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
            vertex: { module, entryPoint: 'vs_main', buffers: [] },
            fragment: {
              module,
              entryPoint: 'fs_main',
              targets: outputs.map(({ format }) => ({ format })),
            },
            primitive: { topology: 'triangle-list' },
          })
          .unwrap();
        apply = { pipeline, layout, groups: new WeakMap() };
      }
      const views = applyViews.map((view) => resources.textureView(view).unwrap());
      const layout = apply.layout;
      const group = getOrCreateFromChain(
        apply.groups,
        views,
        'decal-apply',
        () =>
          device
            .createBindGroup({
              layout,
              entries: views.map((value, binding) => ({
                binding,
                resource: { kind: 'textureView' as const, value },
              })),
            })
            .unwrap(),
        internal.bindGroupCounts,
      ) as BindGroup;
      pass.setPipeline(apply.pipeline);
      pass.setBindGroup(0, group);
      pass.draw(3);
    },
  });
  if (!composition.ok) return composition;
  return ok({
    ...input,
    normal: outputs[0] as RenderPipelineTarget,
    albedo: outputs[1] as RenderPipelineTarget,
    f0: outputs[2] as RenderPipelineTarget,
  });
}
