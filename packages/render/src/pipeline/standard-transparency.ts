import type {
  GraphExtent,
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import type { BindGroup, BindGroupLayout, RenderPipeline } from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import { GPU_SHADER_STAGE_FRAGMENT } from '../gpu-stage';
import { OIT_COMPOSITE_EPSILON } from '../oit/weight';
import { selectMainPassMaterials } from '../record/main-pass';
import { getOrCreateFromChain } from '../record/mesh-ssbo';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import {
  createRenderPipelineTarget,
  type RenderPipelineFrame,
  type RenderPipelineTarget,
  type RenderPipelineTopology,
} from '../render-pipeline';
import { FORWARD_PASS_SELECTOR } from '../systems/pass-selector';
import { addTypedScenePass, type TypedScenePassOptions } from '../typed-render-graph-primitives';

/** Pass names owned by the weighted blended OIT lane. */
export const OIT_ACCUMULATE_PASS = 'oit-accumulate';
export const OIT_COMPOSITE_PASS = 'oit-composite';

/** Shared scene-pass facts of the transparent set; the helper owns the rest. */
export type StandardTransparentPassTemplate = Omit<
  TypedScenePassOptions,
  | 'name'
  | 'color'
  | 'depth'
  | 'resolve'
  | 'recordMode'
  | 'colorTargets'
  | 'colorLoadOp'
  | 'depthLoadOp'
  | 'colorClearValues'
  | 'clearColor'
  | 'transparentDepthWrite'
  | 'selector'
>;

export interface StandardTransparencyInput {
  /** Scene color attachment (the MSAA target when `resolve` is present). */
  readonly color: RenderPipelineTarget;
  /** Single-sample scene color paired with an MSAA `color`. */
  readonly resolve?: RenderPipelineTarget | undefined;
  readonly depth: RenderPipelineTarget;
  readonly size: GraphExtent;
  readonly transparency: RenderPipelineTopology['transparency'];
  readonly template: StandardTransparentPassTemplate;
}

/**
 * The one transparent composition for a Standard view, shared by the forward
 * lane and both deferred topology branches.
 *
 * - `sorted` (or no eligible draw): the `transparent` pass, skipped per frame
 *   when its CPU selection is empty and it owns neither GPU work nor a resolve.
 * - `weighted-blended` with eligible draws: `oit-accumulate` (eligible draws
 *   into accum + weight, depth test only), `oit-composite` (full screen onto
 *   scene color), then `transparent` for the ineligible draws if any exist.
 */
export function addStandardTransparentPasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  input: StandardTransparencyInput,
): Result<void, RenderGraphError> {
  const sorted = (recordMode: 'transparent' | 'oit-residual') =>
    addTypedScenePass(graph, {
      ...input.template,
      name: 'transparent',
      color: input.color,
      depth: input.depth,
      ...(input.resolve === undefined ? {} : { resolve: input.resolve }),
      selector: FORWARD_PASS_SELECTOR,
      executeIf: (frame) => {
        if (input.template.executeIf?.(frame) === false) return false;
        // An empty load/store pass needlessly opens the full-size color/depth
        // attachments. The recorder's selector is the membership authority;
        // never infer GPU emptiness from it or discard an attachment resolve.
        if (
          input.template.gpuDriven !== undefined ||
          input.resolve !== undefined ||
          input.color.resolveTarget !== undefined
        )
          return true;
        return (
          selectMainPassMaterials(
            frame as _InternalRenderPipelineContext,
            FORWARD_PASS_SELECTOR,
            recordMode,
            input.template.excludeSelector,
          )?.size !== 0
        );
      },
      colorLoadOp: 'load',
      depthLoadOp: 'load',
      recordMode,
      transparentDepthWrite: true,
    });
  if (input.transparency?.weightedBlended !== true) return sorted('transparent');

  const msaa = input.color.sampleCount === 4;
  const accumTarget = (label: string, format: 'rgba16float' | 'r16float') => {
    const resolved = createRenderPipelineTarget(graph, label, {
      format,
      size: input.size,
      domain: 'linear-hdr',
    });
    if (!resolved.ok || !msaa) return resolved;
    const multisampled = createRenderPipelineTarget(graph, `${label}-msaa`, {
      format,
      size: input.size,
      sampleCount: 4,
      domain: 'linear-hdr',
    });
    if (!multisampled.ok) return multisampled;
    return ok({ ...multisampled.value, resolveTarget: resolved.value.view });
  };
  const accum = accumTarget('oit-accum', 'rgba16float');
  if (!accum.ok) return accum;
  const weight = accumTarget('oit-weight', 'r16float');
  if (!weight.ok) return weight;
  const accumulate = addTypedScenePass(graph, {
    ...input.template,
    name: OIT_ACCUMULATE_PASS,
    color: accum.value,
    colorTargets: [accum.value, weight.value],
    depth: input.depth,
    selector: FORWARD_PASS_SELECTOR,
    colorLoadOp: 'clear',
    colorClearValues: [
      [0, 0, 0, 1],
      [0, 0, 0, 0],
    ],
    depthLoadOp: 'load',
    recordMode: 'oit-accumulate',
    transparentDepthWrite: false,
  });
  if (!accumulate.ok) return accumulate;
  const composite = addOitCompositePass(graph, {
    color: input.color,
    ...(input.resolve === undefined ? {} : { resolve: input.resolve }),
    accum: accum.value.resolveTarget ?? accum.value.view,
    weight: weight.value.resolveTarget ?? weight.value.view,
  });
  if (!composite.ok) return composite;
  return input.transparency.residual ? sorted('oit-residual') : ok(undefined);
}

const OIT_COMPOSITE_WGSL = /* wgsl */ `
@group(0) @binding(0) var oitAccum : texture_2d<f32>;
@group(0) @binding(1) var oitWeight : texture_2d<f32>;

@vertex
fn vs_oit_composite(@builtin(vertex_index) index : u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
  return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}

// Weighted average color over the exact coverage 1 - prod(1 - a). The pipeline
// blends it over scene color with straight-alpha over.
@fragment
fn fs_oit_composite(@builtin(position) position : vec4<f32>) -> @location(0) vec4<f32> {
  let pixel = vec2<i32>(position.xy);
  let accum = textureLoad(oitAccum, pixel, 0);
  let revealage = accum.a;
  if (revealage >= 1.0) {
    discard;
  }
  let weight = textureLoad(oitWeight, pixel, 0).r;
  return vec4<f32>(accum.rgb / max(weight, ${OIT_COMPOSITE_EPSILON.toExponential()}), 1.0 - revealage);
}
`;

function addOitCompositePass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  input: {
    readonly color: RenderPipelineTarget;
    readonly resolve?: RenderPipelineTarget;
    readonly accum: GraphTextureView;
    readonly weight: GraphTextureView;
  },
): Result<void, RenderGraphError> {
  let state:
    | { pipeline: RenderPipeline; layout: BindGroupLayout; groups: WeakMap<object, unknown> }
    | undefined;
  return graph.addRasterPass(OIT_COMPOSITE_PASS, {
    accesses: [
      { resource: input.accum, usage: 'sampled-read' },
      { resource: input.weight, usage: 'sampled-read' },
      { resource: input.color.view, usage: 'color-attachment' },
      ...(input.resolve === undefined
        ? []
        : [{ resource: input.resolve.view, usage: 'color-attachment' as const }]),
    ],
    colorAttachments: [
      {
        view: input.color.view,
        ...(input.resolve === undefined ? {} : { resolveTarget: input.resolve.view }),
        loadOp: 'load',
        storeOp: 'store',
      },
    ],
    encode: ({ pass, frame, resources }) => {
      const device = frame.runtime.device;
      if (state === undefined) {
        // Same-frame built-in producer: the handle-first factory never reports
        // a pending module on the first OIT frame.
        const factory =
          frame.runtime.immediateShaderModuleFactory ?? frame.runtime.shaderModuleFactory;
        if (factory === undefined)
          throw new RhiError({
            code: 'rhi-not-available',
            expected: 'OIT composite shader module factory',
            hint: 'construct the renderer through a backend pack with shader module support',
          });
        const module = factory
          .createShaderModule({ code: OIT_COMPOSITE_WGSL, label: 'oit_composite' })
          .unwrap();
        const layout = device
          .createBindGroupLayout({
            label: 'oit-composite-bgl',
            entries: [0, 1].map((binding) => ({
              binding,
              visibility: GPU_SHADER_STAGE_FRAGMENT,
              texture: { sampleType: 'unfilterable-float' as const, viewDimension: '2d' as const },
            })),
          })
          .unwrap();
        const pipelineLayout = device
          .createPipelineLayout({ label: 'oit-composite-pl', bindGroupLayouts: [layout] })
          .unwrap();
        const pipeline = device
          .createRenderPipeline({
            label: 'oit_composite',
            layout: pipelineLayout,
            vertex: { module, entryPoint: 'vs_oit_composite', buffers: [] },
            fragment: {
              module,
              entryPoint: 'fs_oit_composite',
              targets: [
                {
                  format: input.color.format,
                  blend: {
                    color: {
                      operation: 'add',
                      srcFactor: 'src-alpha',
                      dstFactor: 'one-minus-src-alpha',
                    },
                    alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
                  },
                },
              ],
            },
            primitive: { topology: 'triangle-list' },
            multisample: { count: input.color.sampleCount },
          })
          .unwrap();
        state = { pipeline, layout, groups: new WeakMap() };
      }
      const accum = resources.textureView(input.accum).unwrap();
      const weight = resources.textureView(input.weight).unwrap();
      const layout = state.layout;
      const group = getOrCreateFromChain(
        state.groups,
        [accum, weight],
        'oit-composite',
        () =>
          device
            .createBindGroup({
              label: 'oit-composite-bg',
              layout,
              entries: [
                { binding: 0, resource: { kind: 'textureView' as const, value: accum } },
                { binding: 1, resource: { kind: 'textureView' as const, value: weight } },
              ],
            })
            .unwrap(),
        (frame as _InternalRenderPipelineContext).bindGroupCounts,
      ) as BindGroup;
      pass.setPipeline(state.pipeline);
      pass.setBindGroup(0, group);
      pass.draw(3);
    },
  });
}
