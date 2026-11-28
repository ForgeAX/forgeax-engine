import type {
  GraphExtent,
  GraphResourceResolver,
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
  RenderGraphNativePass,
} from '@forgeax/engine-render-graph';
import type {
  BindGroup,
  BindGroupLayout,
  RenderPipeline,
  RhiRenderPassEncoder,
  TextureView,
} from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import { GPU_SHADER_STAGE_FRAGMENT } from '../gpu-stage';
import { type TransparencyImages, transparencyTargetsFor } from '../oit/current-targets';
import { OIT_COMPOSITE_EPSILON } from '../oit/weight';
import { prepareMainPassPipelines, selectMainPassMaterials } from '../record/main-pass';
import { getOrCreateFromChain } from '../record/mesh-ssbo';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import { SceneColorDraws } from '../record/scene-color-draws';
import { scenePassContext, scenePassMaterialRows } from '../record/scene-pass-work';
import {
  createRenderPipelineTarget,
  type RenderPipelineFrame,
  type RenderPipelineTarget,
  type RenderPipelineTopology,
} from '../render-pipeline';
import { FORWARD_PASS_SELECTOR, TRANSMISSION_BACK_PASS_SELECTOR } from '../systems/pass-selector';
import { currentTransmissionRaster } from '../transmission/current-backdrop';
import {
  addTypedScenePass,
  type PhysicalSceneRaster,
  type TypedScenePassOptions,
} from '../typed-render-graph-primitives';

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
  /** Later scene features may still write the original multisampled color. */
  readonly retainMsaaComposite?: boolean;
  readonly depth: RenderPipelineTarget;
  readonly size: GraphExtent;
  readonly transparency: RenderPipelineTopology['transparency'];
  readonly currentTransparency?: boolean | undefined;
  readonly currentTransmission?: true;
  readonly template: StandardTransparentPassTemplate;
}

/** Decide the single-sample view's material stages from its current queue. Each
 * transmitting face samples the scene contents immediately before its draw. */
export function addCurrentStandardTranslucency(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  input: StandardTransparencyInput,
): Result<void, RenderGraphError> {
  if (
    input.template.writer === undefined &&
    input.depth.currentMaterialDepthExtent !== undefined &&
    input.depth.format.includes('stencil') &&
    input.depth.sampleCount === 1 &&
    input.color.sampleCount === 1 &&
    input.color.resolveTarget === undefined &&
    input.resolve === undefined &&
    (input.template.colorStoreOp ?? 'store') === 'store'
  ) {
    const draws = new SceneColorDraws(input.color.view, input.depth.view);
    const sceneReads = graph.consumerReads('render-feature.scene');
    if (
      sceneReads.every((read) => draws.admitsRead(read)) &&
      (input.template.extraAccesses?.every((read) => draws.admitsRead(read)) ?? true) &&
      (input.template.sampled?.every(({ view }) =>
        draws.admitsRead({ resource: view, usage: 'sampled-read' }),
      ) ??
        true)
    ) {
      const recorded = recordCurrentTranslucency(graph, {
        ...input,
        template: { ...input.template, writer: draws },
      });
      if (!recorded.ok) return recorded;
      return draws.install(graph, 'standard-translucency');
    }
  }
  return recordCurrentTranslucency(graph, input);
}

function recordCurrentTranslucency(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  input: StandardTransparencyInput,
): Result<void, RenderGraphError> {
  const { color, depth } = input;
  const template = {
    ...input.template,
    color,
    depth,
    colorLoadOp: 'load',
    depthLoadOp: 'load',
    transparentDepthWrite: true,
  } as const;
  const backs = addTypedScenePass(
    graph,
    {
      ...template,
      name: 'transmission-backs',
      selector: TRANSMISSION_BACK_PASS_SELECTOR,
      recordMode: 'transmission',
      currentTransparencyPass: 'backs',
    },
    currentTransmissionRaster(color, depth, true),
  );
  if (!backs.ok) return backs;
  const prefix = addTypedScenePass(graph, {
    ...template,
    name: 'transparent-before-transmission',
    selector: FORWARD_PASS_SELECTOR,
    recordMode: 'translucent-before-transmission',
    currentTransparencyPass: 'prefix',
  });
  if (!prefix.ok) return prefix;
  const fronts = (weighted: boolean) =>
    addTypedScenePass(
      graph,
      {
        ...template,
        name: weighted ? 'weighted-transmission-front' : 'transmission-forward',
        selector: FORWARD_PASS_SELECTOR,
        recordMode: weighted ? 'transmission' : 'translucent',
        currentTransparencyPass: weighted ? 'weighted-front' : 'sorted-front',
      },
      currentTransmissionRaster(
        color,
        depth,
        false,
        weighted ? 'weighted-transmission' : 'sorted-transmission',
      ),
    );
  const sorted = fronts(false);
  if (!sorted.ok) return sorted;
  if (input.currentTransparency) {
    const weighted = fronts(true);
    if (!weighted.ok) return weighted;
  }
  return addStandardTransparentPasses(graph, { ...input, currentTransmission: true });
}

/**
 * The one transparent composition for a Standard view, shared by the forward
 * lane and both deferred topology branches.
 *
 * - `sorted` (or no eligible draw): the `transparent` pass, skipped per frame
 *   when its CPU selection is empty and it owns neither GPU work nor a resolve.
 * - `weighted-blended` with eligible draws: `transparent` adds ineligible
 *   draws to the background, `oit-accumulate` gathers eligible draws, and
 *   `oit-composite` blends the weighted result over scene color.
 */
export function addStandardTransparentPasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  input: StandardTransparencyInput,
): Result<void, RenderGraphError> {
  // The weighted contribution is already resolved before compositing. Blending
  // the same contribution into each scene sample commutes with resolving it.
  const compositeColor = input.retainMsaaComposite ? input.color : (input.resolve ?? input.color);
  const sorted = (recordMode: 'transparent' | 'oit-residual') => {
    // A residual is the last multisampled scene writer before a 1x composite.
    const resolve =
      recordMode === 'transparent' || compositeColor !== input.color ? input.resolve : undefined;
    return addTypedScenePass(
      graph,
      {
        ...input.template,
        name: 'transparent',
        ...(input.currentTransmission
          ? { currentTransparencyPass: 'ordinary' as const }
          : input.currentTransparency
            ? { currentTransparencyPass: 'residual' as const }
            : {}),
        color: input.color,
        depth: input.depth,
        ...(resolve === undefined ? {} : { resolve }),
        ...(recordMode === 'oit-residual' && resolve === undefined
          ? { colorStoreOp: 'store' as const }
          : {}),
        selector: FORWARD_PASS_SELECTOR,
        executeIf:
          input.template.executeIf === undefined &&
          (resolve !== undefined ||
            input.color.resolveTarget !== undefined ||
            (input.template.gpuDriven !== undefined &&
              input.template.gpuDriven.currentCameraWork === undefined))
            ? undefined
            : (frame, request) => {
                if (input.template.executeIf?.(frame, request) === false) return false;
                // An empty load/store pass needlessly opens the full-size color/depth
                // attachments. The recorder's selector is the membership authority;
                // never infer GPU emptiness from it or discard an attachment resolve.
                if (
                  (input.template.gpuDriven !== undefined &&
                    (input.template.gpuDriven.currentCameraWork?.() ?? true)) ||
                  resolve !== undefined ||
                  input.color.resolveTarget !== undefined
                )
                  return true;
                const internal = frame as _InternalRenderPipelineContext;
                const context = scenePassMaterialRows(internal, request);
                const selected = selectMainPassMaterials(
                  context,
                  FORWARD_PASS_SELECTOR,
                  recordMode,
                  input.template.excludeSelector,
                );
                if (selected?.size !== 0) return true;
                if (
                  internal.scenePassWork !== undefined &&
                  (internal.pipelinePreparationEntries?.length ?? 0) === 0
                )
                  return false;
                prepareMainPassPipelines(
                  scenePassContext(internal, request),
                  FORWARD_PASS_SELECTOR,
                  {
                    recordMode,
                    transparentDepthWrite: true,
                    ...(input.template.excludeSelector === undefined
                      ? {}
                      : { excludeSelector: input.template.excludeSelector }),
                  },
                  input.color.sampleCount,
                  [input.color.format as GPUTextureFormat],
                );
                return false;
              },
        colorLoadOp: 'load',
        depthLoadOp: 'load',
        recordMode,
        transparentDepthWrite: true,
      },
      input.currentTransparency ? currentResidualRaster(input) : undefined,
    );
  };
  if (input.currentTransparency) {
    const background = sorted('oit-residual');
    if (!background.ok) return background;
    return addCurrentWeightedPasses(graph, input);
  }
  if (input.transparency?.weightedBlended !== true) return sorted('transparent');
  if (input.transparency.residual) {
    const background = sorted('oit-residual');
    if (!background.ok) return background;
  }

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
  return addOitCompositePass(graph, {
    color: compositeColor,
    colorStoreOp: input.template.colorStoreOp,
    ...(compositeColor === input.color && input.resolve !== undefined
      ? { resolve: input.resolve }
      : {}),
    accum: accum.value.resolveTarget ?? accum.value.view,
    weight: weight.value.resolveTarget ?? weight.value.view,
  });
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
    readonly colorStoreOp?: GPUStoreOp | 'auto' | undefined;
    readonly resolve?: RenderPipelineTarget;
    readonly accum: GraphTextureView;
    readonly weight: GraphTextureView;
  },
): Result<void, RenderGraphError> {
  const encode = oitCompositeEncoder(input.color);
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
        storeOp: input.colorStoreOp ?? 'store',
      },
    ],
    encodeDirect: (pass, frame, resources) => {
      encode(
        pass,
        frame,
        resources.textureView(input.accum).unwrap(),
        resources.textureView(input.weight).unwrap(),
      );
    },
  });
}

function oitCompositeEncoder(color: RenderPipelineTarget) {
  let state:
    | { pipeline: RenderPipeline; layout: BindGroupLayout; groups: WeakMap<object, unknown> }
    | undefined;
  return (
    pass: RhiRenderPassEncoder,
    frame: RenderPipelineFrame,
    accum: TextureView,
    weight: TextureView,
    pair?: TransparencyImages,
  ): void => {
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
                format: color.format,
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
          multisample: { count: color.sampleCount },
        })
        .unwrap();
      state = { pipeline, layout, groups: new WeakMap() };
    }
    const layout = state.layout;
    let group: BindGroup;
    if (pair?.composite?.layout === layout) group = pair.composite.group;
    else {
      const buildGroup = () =>
        device
          .createBindGroup({
            label: 'oit-composite-bg',
            layout,
            entries: [
              { binding: 0, resource: { kind: 'textureView', value: accum } },
              { binding: 1, resource: { kind: 'textureView', value: weight } },
            ],
          })
          .unwrap();
      const counts = (frame as _InternalRenderPipelineContext).bindGroupCounts;
      if (pair === undefined)
        group = getOrCreateFromChain(
          state.groups,
          [accum, weight],
          'oit-composite',
          buildGroup,
          counts,
        );
      else {
        group = buildGroup();
        pair.composite = { layout, group };
        counts.createBindGroup++;
        counts.keys.push('oit-composite');
      }
    }
    pass.setPipeline(state.pipeline);
    pass.setBindGroup(0, group);
    pass.draw(3);
  };
}

/** The stock single-sample pass owns both transient images. The scene depth/color
 * and all scene bindings remain declared graph ports; both draws use the same
 * geometry and composite encoders as the authored raster passes. */
function addCurrentWeightedPasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  input: StandardTransparencyInput,
): Result<void, RenderGraphError> {
  return addTypedScenePass(
    graph,
    {
      ...input.template,
      name: OIT_ACCUMULATE_PASS,
      depth: input.depth,
      selector: FORWARD_PASS_SELECTOR,
      currentTransparencyPass: 'accumulate',
      depthLoadOp: 'load',
      recordMode: 'oit-accumulate',
      transparentDepthWrite: false,
    },
    {
      colorFormats: ['rgba16float', 'r16float'],
      add(builder, accesses, enabled, encodeScene) {
        accesses.push({ resource: input.color.view, usage: 'color-attachment' });
        const composite = oitCompositeEncoder(input.color);
        let frame: RenderPipelineFrame | undefined;
        let resources: GraphResourceResolver | undefined;
        let images: TransparencyImages | undefined;
        let sceneDepth: TextureView | undefined;
        let sceneColor: TextureView | undefined;
        function required<T>(value: T | undefined): T {
          if (value === undefined) throw new Error('Weighted transparency requires an active view');
          return value;
        }
        const accumulatePass: RenderGraphNativePass = {
          kind: 'raster',
          name: OIT_ACCUMULATE_PASS,
          descriptor: {
            label: OIT_ACCUMULATE_PASS,
            colorAttachments: [
              {
                get view() {
                  return required(images).accum.view;
                },
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
              },
              {
                get view() {
                  return required(images).weight.view;
                },
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
              },
            ],
            depthStencilAttachment: {
              get view() {
                return required(sceneDepth);
              },
              depthLoadOp: 'load',
              depthStoreOp: 'store',
              ...(input.depth.format.includes('stencil')
                ? { stencilLoadOp: 'load' as const, stencilStoreOp: 'store' as const }
                : {}),
            },
          },
          encode(pass) {
            encodeScene(pass, required(frame), required(resources));
          },
        };
        const compositePass: RenderGraphNativePass = {
          kind: 'raster',
          name: OIT_COMPOSITE_PASS,
          descriptor: {
            label: OIT_COMPOSITE_PASS,
            colorAttachments: [
              {
                get view() {
                  return required(sceneColor);
                },
                loadOp: 'load',
                storeOp: input.template.colorStoreOp === 'discard' ? 'discard' : 'store',
              },
            ],
          },
          encode(pass) {
            const pair = required(images);
            composite(pass, required(frame), pair.accum.view, pair.weight.view, pair);
          },
        };
        return builder.addSubgraphPass('weighted-transparency', {
          accesses,
          profilePasses: () => [accumulatePass, compositePass],
          executeIf: enabled,
          appendPassNames(current, names) {
            if (enabled(current)) names.push(OIT_ACCUMULATE_PASS, OIT_COMPOSITE_PASS);
          },
          commandsDirect(activeFrame, resolved, issue, recording) {
            try {
              frame = activeFrame;
              resources = resolved;
              sceneDepth = resources.textureView(input.depth.view).unwrap();
              sceneColor = resources.textureView(input.color.view).unwrap();
              const size =
                input.depth.currentMaterialDepthExtent ??
                resources.textureViewExtent(input.depth.view).unwrap();
              images = transparencyTargetsFor(frame as _InternalRenderPipelineContext).acquire(
                size.width,
                size.height,
              );
              issue(recording, accumulatePass);
              issue(recording, compositePass);
            } finally {
              frame = resources = images = sceneDepth = sceneColor = undefined;
            }
          },
        });
      },
    },
  );
}

/** The residual is an ordinary color/depth draw. It has no descriptor or material
 * work when every transparent draw in this frame belongs to the weighted phase. */
function currentResidualRaster(input: StandardTransparencyInput): PhysicalSceneRaster {
  return {
    colorFormats: [input.color.format as GPUTextureFormat],
    add(graph, accesses, enabled, encodeScene) {
      let frame: RenderPipelineFrame | undefined;
      let resources: GraphResourceResolver | undefined;
      let depth: TextureView | undefined;
      let color: TextureView | undefined;
      function required<T>(value: T | undefined): T {
        if (value === undefined) throw new Error('Residual transparency requires an active view');
        return value;
      }
      const pass: RenderGraphNativePass = {
        kind: 'raster',
        name: 'transparent',
        descriptor: {
          label: 'transparent',
          colorAttachments: [
            {
              get view() {
                return required(color);
              },
              loadOp: 'load',
              storeOp: 'store',
            },
          ],
          depthStencilAttachment: {
            get view() {
              return required(depth);
            },
            depthLoadOp: 'load',
            depthStoreOp: 'store',
            ...(input.depth.format.includes('stencil')
              ? { stencilLoadOp: 'load' as const, stencilStoreOp: 'store' as const }
              : {}),
          },
        },
        encode(encoder) {
          encodeScene(encoder, required(frame), required(resources));
        },
      };
      let issued = false;
      return graph.addSubgraphPass('residual-transparency', {
        accesses,
        profilePasses: () => [pass],
        executeIf(current) {
          issued = enabled(current);
          return issued;
        },
        appendPassNames(_frame, names) {
          if (issued) names.push(pass.name);
        },
        commandsDirect(activeFrame, resolved, issue, recording) {
          try {
            frame = activeFrame;
            resources = resolved;
            color = resources.textureView(input.color.view).unwrap();
            depth = resources.textureView(input.depth.view).unwrap();
            issue(recording, pass);
          } finally {
            frame = resources = depth = color = undefined;
          }
        },
      });
    },
  };
}
