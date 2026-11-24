import type {
  GraphBuffer,
  GraphTextureView,
  RenderGraphBuilder,
} from '@forgeax/engine-render-graph';
import { ok, type Result } from '@forgeax/engine-types';
import type { DepthPyramid } from '../depth-pyramid/graph';
import { addDepthPyramidPasses } from '../depth-pyramid/graph';
import { addSingleLayerMediumRawDepthProducer } from '../pipeline/single-layer-medium-passes';
import type { StandardForwardReceiverInputs } from '../pipeline/standard-forward-receiver';
import type {
  RenderPipelineBuildContext,
  RenderPipelineBuildError,
  RenderPipelineFrame,
  RenderPipelineTarget,
  RenderPipelineTopology,
} from '../render-pipeline';
import { createRenderPipelineTarget } from '../render-pipeline';
import type { RendererState } from '../render-system';
import { addSsrHitColor } from '../ssr/color-mips';
import { addSsrSpatialPasses } from '../ssr/graph';
import type { SsrGBufferInput } from '../ssr/shader-layout';
import { isWaterSsrAdmitted } from '../ssr/water-profile';
import { FORWARD_PASS_SELECTOR } from '../systems/pass-selector';
import { addTypedFullscreenPass, addTypedScenePass } from '../typed-render-graph-primitives';
import { addWaterFluidGraph } from './fluid-graph';

export interface WaterSlwGraphInputs {
  readonly graph: RenderGraphBuilder<RenderPipelineFrame>;
  readonly topology: RenderPipelineTopology;
  readonly context: RenderPipelineBuildContext<RenderPipelineFrame>;
  readonly color: RenderPipelineTarget;
  readonly forward?: true;
  /** Nearest opaque sample supplies refraction; color keeps the average display resolve. */
  readonly refractionColor?: RenderPipelineTarget;
  readonly opaqueRawDepth?: RenderPipelineTarget;
  readonly depth: RenderPipelineTarget;
  readonly opaqueTemporal?: RenderPipelineTarget;
  readonly opaqueSurface?: SsrGBufferInput & {
    readonly normal: RenderPipelineTarget;
    readonly fallback: RenderPipelineTarget;
  };
  readonly receiver: StandardForwardReceiverInputs;
  readonly view: GraphBuffer;
  readonly depthPyramid?: DepthPyramid;
  readonly width: number;
  readonly height: number;
  readonly foamSimulation:
    | { readonly kind: 'no-simulation' }
    | { readonly kind: 'produced'; readonly view: GraphTextureView };
  readonly beforeSceneColorCopy?: () => Result<void, RenderPipelineBuildError>;
}

/** Graph identities are immutable; physical generation and completion belong to FrameReceipt. */
export interface WaterSlwGraphResources {
  readonly noWaterColor: RenderPipelineTarget;
  readonly noWaterDepth: RenderPipelineTarget;
  readonly depth: RenderPipelineTarget;
  readonly normal?: RenderPipelineTarget;
  readonly coverage: RenderPipelineTarget;
  readonly temporal: RenderPipelineTarget;
  readonly optics?: RenderPipelineTarget;
  readonly captureSky?: RenderPipelineTarget;
  readonly reflectionWeight?: RenderPipelineTarget;
  readonly foamSimulation: GraphTextureView;
  readonly reflection?: GraphTextureView;
}

const COMPOSITE_CAPTURE = 'forgeax.water-slw-capture-composite';
const COMPOSITE_SSR = 'forgeax.water-slw-ssr-composite';
const SCENE_TEMPORAL = 'forgeax.water-scene-temporal';

function compositeSource(ssr: boolean): string {
  return `
struct VertexOutput { @builtin(position) position: vec4<f32> };
@group(1) @binding(0) var noWaterScene: texture_2d<f32>;
@group(1) @binding(1) var sceneSampler: sampler;
@group(1) @binding(2) var waterOptics: texture_2d<f32>;
@group(1) @binding(3) var waterCaptureSky: texture_2d<f32>;
@group(1) @binding(4) var waterReflectionWeight: texture_2d<f32>;
${ssr ? '@group(1) @binding(5) var waterSsr: texture_2d<f32>;' : ''}
@vertex fn vs_main(@builtin(vertex_index) vertex: u32) -> VertexOutput {
  var positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return VertexOutput(vec4<f32>(positions[vertex], 0.0, 1.0));
}
@fragment fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let pixel = vec2<i32>(input.position.xy);
  let original = textureLoad(noWaterScene, pixel, 0);
  let optical = textureLoad(waterOptics, pixel, 0);
  let capture = textureLoad(waterCaptureSky, pixel, 0).rgb;
  let weight = textureLoad(waterReflectionWeight, pixel, 0).r;
  ${ssr ? 'let ssr = textureLoad(waterSsr, pixel, 0); let reflected = ssr.rgb + capture * (1.0 - ssr.a);' : 'let reflected = capture;'}
  return vec4<f32>(mix(original.rgb, optical.rgb + reflected * weight, optical.a), original.a);
}`;
}

export function registerWaterSlwBuiltins(
  renderer: Pick<RendererState, 'registerBuiltinPostProcess'>,
): void {
  for (const { name, ...entry } of WATER_SLW_POST_PROCESS_PROGRAMS)
    renderer.registerBuiltinPostProcess(name, entry);
}

export const WATER_SLW_POST_PROCESS_PROGRAMS = [
  {
    name: SCENE_TEMPORAL,
    source: `
struct VertexOutput { @builtin(position) position: vec4<f32> };
@group(1) @binding(0) var waterTemporal: texture_2d<f32>;
@group(1) @binding(1) var sceneSampler: sampler;
@group(1) @binding(2) var waterCoverage: texture_2d<f32>;
@vertex fn vs_main(@builtin(vertex_index) vertex: u32) -> VertexOutput {
  var positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return VertexOutput(vec4<f32>(positions[vertex], 0.0, 1.0));
}
@fragment fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let pixel = vec2<i32>(input.position.xy);
  if (textureLoad(waterCoverage, pixel, 0).a <= 0.0) { discard; }
  return textureLoad(waterTemporal, pixel, 0);
}`,
    reads: ['input', 'water-coverage'],
  },
  {
    name: COMPOSITE_CAPTURE,
    source: compositeSource(false),
    reads: ['input', 'water-optics', 'water-capture-sky', 'water-reflection-weight'],
  },
  {
    name: COMPOSITE_SSR,
    source: compositeSource(true),
    reads: ['input', 'water-optics', 'water-capture-sky', 'water-reflection-weight', 'water-ssr'],
  },
] as const;

/** Publish the full-resolution water backdrops for refraction and composition. */
function copyWaterBackdrops(
  input: WaterSlwGraphInputs,
  noWaterColor: RenderPipelineTarget,
  displayColor: RenderPipelineTarget,
) {
  const { graph, width, height, color } = input;
  return graph.addCopyPass('water-no-water-color-copy', {
    accesses: [
      { resource: (input.refractionColor ?? color).view, usage: 'copy-src' },
      { resource: noWaterColor.view, usage: 'copy-dst' },
      ...(displayColor === noWaterColor
        ? []
        : [
            { resource: color.view, usage: 'copy-src' as const },
            { resource: displayColor.view, usage: 'copy-dst' as const },
          ]),
    ],
    encodeDirect: (encoder, _frame, resources) => {
      encoder.copyTextureToTexture(
        { texture: resources.texture((input.refractionColor ?? color).texture).unwrap() },
        { texture: resources.texture(noWaterColor.texture).unwrap() },
        { width, height, depthOrArrayLayers: 1 },
      );
      if (displayColor !== noWaterColor)
        encoder.copyTextureToTexture(
          { texture: resources.texture(color.texture).unwrap() },
          { texture: resources.texture(displayColor.texture).unwrap() },
          { width, height, depthOrArrayLayers: 1 },
        );
    },
  });
}

function prepareWaterBackdrops(
  input: WaterSlwGraphInputs,
  noWaterColor: RenderPipelineTarget,
  displayColor: RenderPipelineTarget,
) {
  const { context, topology, width, height } = input;
  const underwaterTransparency = input.beforeSceneColorCopy?.();
  if (underwaterTransparency !== undefined && !underwaterTransparency.ok)
    return underwaterTransparency;
  const copied = copyWaterBackdrops(input, noWaterColor, displayColor);
  if (!copied.ok) return copied;
  const useSsr =
    input.forward === true
      ? topology.inlineSsr === true &&
        !(topology.waterView?.kind === 'available' && topology.waterView.underwater)
      : isWaterSsrAdmitted(topology.ssr);
  return useSsr
    ? addSsrHitColor(context, topology, noWaterColor, { width, height }, 'water-ssr-color')
    : ok(undefined);
}

/** Water receiver, opaque closest HZB and current scene color have distinct graph edges. */
export function addWaterSlwPasses(
  input: WaterSlwGraphInputs,
): Result<WaterSlwGraphResources, RenderPipelineBuildError> {
  const { graph, color, depth, receiver, topology, context, width, height } = input;
  const waterSsr = isWaterSsrAdmitted(topology.ssr) ? topology.ssr : undefined;
  const size = { width, height };
  const make = (name: string, format: RenderPipelineTarget['format']) =>
    createRenderPipelineTarget(graph, name, { format, size, sampleCount: 1 });
  const colorCopy = make('water-no-water-color-hdr', color.format);
  if (!colorCopy.ok) return colorCopy;
  const noWaterColor = colorCopy.value;
  const displayCopy =
    input.forward === true || input.refractionColor === undefined
      ? undefined
      : make('water-no-water-display-hdr', color.format);
  if (displayCopy !== undefined && !displayCopy.ok) return displayCopy;
  const displayColor = displayCopy?.ok === true ? displayCopy.value : noWaterColor;
  const noWaterDepth = make('water-no-water-depth', depth.format);
  if (!noWaterDepth.ok) return noWaterDepth;
  const waterDepth = make('water-prepass-depth', depth.format);
  if (!waterDepth.ok) return waterDepth;
  const noWaterDepthView = graph.view(noWaterDepth.value.texture, {
    aspect: 'depth-only',
    dimension: '2d',
    label: 'water-no-water-depth.sample',
  });
  if (!noWaterDepthView.ok) return noWaterDepthView;
  const copied = graph.addCopyPass('water-no-water-depth-copy', {
    accesses: [
      { resource: depth.view, usage: 'copy-src' },
      { resource: noWaterDepth.value.view, usage: 'copy-dst' },
      { resource: waterDepth.value.view, usage: 'copy-dst' },
    ],
    encodeDirect: (encoder, _frame, resources) => {
      const source = resources.texture(depth.texture).unwrap();
      const destination = resources.texture(noWaterDepth.value.texture).unwrap();
      encoder.copyTextureToTexture(
        { texture: source },
        { texture: destination },
        { width, height, depthOrArrayLayers: 1 },
      );
      encoder.copyTextureToTexture(
        { texture: source },
        { texture: resources.texture(waterDepth.value.texture).unwrap() },
        { width, height, depthOrArrayLayers: 1 },
      );
    },
  });
  if (!copied.ok) return copied;
  // The hit hierarchy is completed before any Water depth writer, from the opaque resolve.
  let depthPyramid = input.depthPyramid;
  const prepareOpaqueWaterDepthPyramid = () => {
    if (waterSsr !== undefined && depthPyramid === undefined) {
      const hitPyramid = addDepthPyramidPasses(graph, {
        label: 'water-closest-depth-pyramid',
        reduction: 'closest',
        depth: noWaterDepthView.value,
        width,
        height,
        view: input.view,
      });
      if (!hitPyramid.ok) return hitPyramid;
      depthPyramid = hitPyramid.value.pyramid;
    }
    return undefined;
  };
  const depthPyramidFailure = prepareOpaqueWaterDepthPyramid();
  if (depthPyramidFailure !== undefined) return depthPyramidFailure;
  // The Forward shader's level-zero tap also serves refraction. Only a
  // paired opaque backdrop can use the reflection hierarchy.
  const makeOpticalDepth = () => {
    const inline =
      input.forward === true &&
      topology.inlineSsr === true &&
      !(topology.waterView?.kind === 'available' && topology.waterView.underwater);
    if (inline) {
      const hierarchy = addDepthPyramidPasses(graph, {
        label: 'water-forward-hiz',
        fullResolutionSeed: true,
        nativeInputs: context.nativeInputs,
        depth: noWaterDepthView.value,
        width,
        height,
        view: input.view,
      });
      return hierarchy.ok ? ok(hierarchy.value.pyramid.pyramid) : hierarchy;
    }
    const raw =
      input.opaqueRawDepth === undefined
        ? addSingleLayerMediumRawDepthProducer({
            graph,
            label: 'water-no-water-raw-depth',
            sourceColor: color,
            sourceDepth: noWaterDepth.value,
            size,
          })
        : ok(input.opaqueRawDepth);
    return raw.ok ? ok(raw.value.view) : raw;
  };
  const rawDepth = makeOpticalDepth();
  if (!rawDepth.ok) return rawDepth;
  const fluid = addWaterFluidGraph(context);
  if (!fluid.ok) return fluid;
  const foamInput =
    fluid.value.foam === undefined
      ? input.foamSimulation
      : { kind: 'produced' as const, view: fluid.value.foam };
  let foamSimulation: GraphTextureView;
  const resolveWaterFoamSimulation = () => {
    switch (foamInput.kind) {
      case 'no-simulation': {
        const target = createRenderPipelineTarget(graph, 'water-foam-simulation', {
          format: 'rgba16float',
          size: { width: 512, height: 512 },
          sampleCount: 1,
        });
        if (!target.ok) return target;
        const initialized = graph.addRasterPass('water-foam-no-simulation-initialize', {
          accesses: [{ resource: target.value.view, usage: 'color-attachment' }],
          colorAttachments: [
            {
              view: target.value.view,
              loadOp: 'clear',
              storeOp: 'store',
              clearValue: { r: 0, g: 0, b: 0, a: 1 },
            },
          ],
          encodeDirect: () => {},
        });
        if (!initialized.ok) return initialized;
        foamSimulation = target.value.view;
        break;
      }
      case 'produced':
        foamSimulation = foamInput.view;
        break;
    }
    return undefined;
  };
  const foamFailure = resolveWaterFoamSimulation();
  if (foamFailure !== undefined) return foamFailure;
  const waterDepthView = graph.view(waterDepth.value.texture, {
    aspect: 'depth-only',
    dimension: '2d',
    label: 'water-prepass-depth.sample',
  });
  if (!waterDepthView.ok) return waterDepthView;
  const finishWaterSlwPasses = () => {
    const normal =
      waterSsr === undefined ? ok(undefined) : make('water-normal-roughness', 'rgba32uint');
    if (!normal.ok) return normal;
    const coverage = make('water-mask', 'rgba16float');
    if (!coverage.ok) return coverage;
    const temporal = make('water-wpo-velocity', 'rgba16float');
    if (!temporal.ok) return temporal;
    const surfacePair = {
      opaqueColor: noWaterColor.view,
      rawDepth: { status: 'available' as const, view: rawDepth.value },
    };
    const shared = {
      ...receiver,
      extraAccesses: [...receiver.extraAccesses, ...(context.getWaterMeshGraphAccesses?.() ?? [])],
      selector: FORWARD_PASS_SELECTOR,
      transmissionBackdrop: noWaterColor.view,
      surfacePair,
      surfaceFoamSimulation: foamSimulation,
      surfaceFluidSimulation: fluid.value,
    };
    const prepass = addTypedScenePass(graph, {
      ...shared,
      transmissionBackdrop: color.view,
      surfacePair: { ...surfacePair, opaqueColor: color.view },
      name: 'water-depth-mask-velocity',
      color: normal.value ?? coverage.value,
      colorTargets:
        normal.value === undefined
          ? [coverage.value, temporal.value]
          : [normal.value, coverage.value, temporal.value],
      depth: waterDepth.value,
      recordMode: normal.value === undefined ? 'water-visibility' : 'water-prepass',
      colorLoadOp: 'clear',
      depthLoadOp: 'load',
      colorClearValues: [
        ...(normal.value === undefined ? [] : [[0, 0, 0, 0] as const]),
        [0, 0, 0, 0],
        [0, 0, -1, 1],
      ],
    });
    if (!prepass.ok) return prepass;
    const hitColor = prepareWaterBackdrops(input, noWaterColor, displayColor);
    if (!hitColor.ok) return hitColor;
    const nearestDepth = addSingleLayerMediumRawDepthProducer({
      graph,
      label: 'water-nearest-raw-depth',
      sourceColor: coverage.value,
      sourceDepth: waterDepth.value,
      size,
    });
    if (!nearestDepth.ok) return nearestDepth;
    const addWaterTemporalProjection = () => {
      if (input.opaqueTemporal !== undefined) {
        // The prepass already resolved nearest Water motion and coverage for this exact view.
        const velocity = addTypedFullscreenPass(graph, {
          name: 'water-scene-temporal',
          shader: SCENE_TEMPORAL,
          input: temporal.value,
          outputs: [input.opaqueTemporal],
          additionalReads: [{ key: 'water-coverage', target: coverage.value }],
          colorLoadOp: 'load',
        });
        if (!velocity.ok) return velocity;
      }
      return undefined;
    };
    const temporalProjectionFailure = addWaterTemporalProjection();
    if (temporalProjectionFailure !== undefined) return temporalProjectionFailure;
    if (input.forward === true) {
      const shaded = addTypedScenePass(graph, {
        ...shared,
        ...(hitColor.value === undefined
          ? {}
          : { ssrSource: { hiZ: rawDepth.value, color: hitColor.value.view } }),
        name: 'water-slw-inner-color',
        color,
        depth,
        recordMode: 'water-forward-color',
        colorLoadOp: 'load',
        depthLoadOp: 'load',
        surfaceNearestLayer: coverage.value.view,
        surfaceNearestDepth: nearestDepth.value.view,
      });
      if (!shaded.ok) return shaded;
      return ok({
        noWaterColor,
        noWaterDepth: noWaterDepth.value,
        depth: waterDepth.value,
        coverage: coverage.value,
        temporal: temporal.value,
        foamSimulation,
      });
    }
    const addDeferredWaterShading = () => {
      const optics = make('water-slw-optics-hdr', 'rgba16float');
      if (!optics.ok) return optics;
      const captureSky = make('water-capture-sky-hdr', 'rgba16float');
      if (!captureSky.ok) return captureSky;
      const reflectionWeight = make('water-env-brdf-shore-weight', 'rgba16float');
      if (!reflectionWeight.ok) return reflectionWeight;
      // Empty optical pixels have no Water coverage; the composite retains the paired scene there.
      const optical = addTypedScenePass(graph, {
        ...shared,
        name: 'water-slw-inner-color',
        color: optics.value,
        colorTargets: [optics.value, captureSky.value, reflectionWeight.value],
        depth,
        recordMode: 'water-color',
        colorLoadOp: 'clear',
        clearColor: [0, 0, 0, 0],
        depthLoadOp: 'load',
        surfaceNearestLayer: coverage.value.view,
        surfaceNearestDepth: nearestDepth.value.view,
      });
      if (!optical.ok) return optical;
      let reflection: GraphTextureView | undefined;
      const addWaterSpatialReflection = () => {
        if (waterSsr !== undefined && normal.value !== undefined && hitColor.value !== undefined) {
          const spatial = addSsrSpatialPasses(graph, {
            admission: waterSsr,
            label: 'water-ssr',
            width,
            height,
            depth: noWaterDepthView.value,
            ...(input.opaqueSurface === undefined
              ? {}
              : {
                  ...input.opaqueSurface,
                  normal: input.opaqueSurface.normal.view,
                  fallback: input.opaqueSurface.fallback.view,
                }),
            scene: hitColor.value.view,
            sceneColorMipCount: hitColor.value.mipCount,
            ...(input.opaqueTemporal === undefined
              ? {}
              : { currentTemporal: input.opaqueTemporal.view }),
            origin: {
              depth: waterDepthView.value,
              normal: normal.value.view,
              coverage: coverage.value.view,
              temporal: temporal.value.view,
              ...(context.waterSsr === undefined
                ? {}
                : { inputParams: context.waterSsr.inputParams }),
              ...(context.ssrSceneColorHistory === undefined
                ? {}
                : { sceneColorHistory: context.ssrSceneColorHistory.view }),
            },
            view: input.view,
            ...(depthPyramid === undefined ? {} : { depthPyramid }),
          });
          if (!spatial.ok) return spatial;
          reflection = spatial.value.resources?.trace.view;
        }
        return undefined;
      };
      const spatialReflectionFailure = addWaterSpatialReflection();
      if (spatialReflectionFailure !== undefined) return spatialReflectionFailure;
      const composeWaterSlwReflection = () => {
        const composed = addTypedFullscreenPass(graph, {
          name: 'water-reflection-composite',
          shader: reflection === undefined ? COMPOSITE_CAPTURE : COMPOSITE_SSR,
          input: displayColor,
          outputs: [color],
          additionalReads: [
            { key: 'water-optics', target: optics.value },
            { key: 'water-capture-sky', target: captureSky.value },
            { key: 'water-reflection-weight', target: reflectionWeight.value },
            ...(reflection === undefined
              ? []
              : [{ key: 'water-ssr', target: { ...captureSky.value, view: reflection } }]),
          ],
        });
        if (!composed.ok) return composed;
        return ok({
          noWaterColor,
          noWaterDepth: noWaterDepth.value,
          depth: waterDepth.value,
          ...(normal.value === undefined ? {} : { normal: normal.value }),
          coverage: coverage.value,
          temporal: temporal.value,
          optics: optics.value,
          captureSky: captureSky.value,
          reflectionWeight: reflectionWeight.value,
          foamSimulation,
          ...(reflection === undefined ? {} : { reflection }),
        });
      };
      return composeWaterSlwReflection();
    };
    return addDeferredWaterShading();
  };
  return finishWaterSlwPasses();
}
