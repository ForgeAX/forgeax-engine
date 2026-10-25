// GradientSky background passes. One skybox.wgsl module carries both entries:
// the scene entry draws HDR radiance inside the existing skybox pass, and the
// display entry fills the transparent coverage left in the encoded surface after
// every output stage, the way a CSS page colour shows behind the canvas.

import type { RenderGraphBuilder, RenderGraphError } from '@forgeax/engine-render-graph';
import type {
  BindGroupLayout,
  Buffer,
  RenderPipeline,
  RhiDevice,
  RhiRenderPassEncoder,
  ShaderModule,
  TextureFormat,
} from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import { tonemapToU32 } from '../components/camera';
import { type FogFrame, fogIsActive, type GradientSkyFrame } from '../extract/environment';
import { GPU_SHADER_STAGE_FRAGMENT } from '../gpu-stage';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_UNIFORM } from '../gpu-usage';
import { OUTPUT_GAMUT_CODE } from '../output-color-space';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import type { CameraSnapshot } from '../render-contract';
import type { RenderPipelineFrame, RenderPipelineTarget } from '../render-pipeline';
import type { SunCandidate } from './frame';

/** Byte size of `GradientSkyParams` in skybox.wgsl. */
export const GRADIENT_SKY_PARAMS_BYTES = 128;
/** Scene-referred disc radiance per unit of light intensity: a 3 lux sun blooms. */
export const GRADIENT_SKY_SUN_DISC_GAIN = 4;

export type GradientSkyDomain = 'scene' | 'display';

export interface GradientSkyOutput {
  readonly exposure: number;
  readonly whitePoint: number;
  readonly tonemap: number;
  readonly gamut: number;
}

/** Brightest channel scaled to 1: the light's hue without its intensity. */
function chroma(color: readonly number[]): readonly [number, number, number] {
  const peak = Math.max(color[0] ?? 0, color[1] ?? 0, color[2] ?? 0);
  if (!(peak > 0)) return [1, 1, 1];
  return [(color[0] ?? 0) / peak, (color[1] ?? 0) / peak, (color[2] ?? 0) / peak];
}

/**
 * Pack the `GradientSkyParams` lanes. Display skies keep the authored colours and a
 * whitened light-hued disc; scene skies give the disc radiance from the light intensity.
 */
export function packGradientSkyParams(
  sky: GradientSkyFrame,
  sun: SunCandidate | undefined,
  fog: FogFrame | undefined,
  output: GradientSkyOutput,
  domain: GradientSkyDomain,
): Float32Array {
  const values = new Float32Array(GRADIENT_SKY_PARAMS_BYTES / 4);
  const fogged = fog !== undefined && fogIsActive(fog);
  values.set([...sky.zenith, sky.exponent], 0);
  values.set([...sky.horizon, sky.fogBlend], 4);
  values.set([...sky.ground, fogged ? fog.maxOpacity : 0], 8);
  if (sun !== undefined && sky.sunSize > 0) {
    const hue = chroma(sun.color);
    values.set([...sun.direction, sky.sunSize], 12);
    // A display disc is a white-hot core in the light's hue; a scene disc is radiance.
    values.set(
      hue.map((channel) =>
        domain === 'scene'
          ? channel * sun.intensity * GRADIENT_SKY_SUN_DISC_GAIN
          : (channel + 1) / 2,
      ),
      16,
    );
    values.set([...hue, sky.sunGlow], 20);
  }
  if (fogged) values.set(fog.color, 24);
  values.set([output.exposure, output.whitePoint, output.tonemap, output.gamut], 28);
  return values;
}

/** True when this frame's environment draws a GradientSky in `domain`. */
export function gradientSkyIn(
  sky: GradientSkyFrame | undefined,
  domain: GradientSkyDomain,
): sky is GradientSkyFrame {
  return sky !== undefined && sky.toneMapped === (domain === 'scene');
}

/**
 * Main-pass clear colour. A GradientSky owns the background: the scene sky
 * overdraws a transparent clear and the display sky fills exactly the coverage
 * the scene leaves transparent. Without one, the camera's `clearColor` stands.
 */
export function gradientSkyClearColor(
  sky: GradientSkyFrame | undefined,
  cameraClear: CameraSnapshot['clearColor'],
): readonly [number, number, number, number] {
  if (sky !== undefined) return [0, 0, 0, 0];
  return [cameraClear[0], cameraClear[1], cameraClear[2], cameraClear[3]];
}

interface GradientSkyDeviceState {
  readonly layout: BindGroupLayout;
  readonly params: Buffer;
  readonly pipelines: Map<string, RenderPipeline>;
}

// Keyed by the compiled module, so a new device generation builds fresh state.
const deviceStates = new WeakMap<ShaderModule, GradientSkyDeviceState>();

function deviceState(device: RhiDevice, module: ShaderModule): GradientSkyDeviceState {
  const existing = deviceStates.get(module);
  if (existing !== undefined) return existing;
  const layout = device
    .createBindGroupLayout({
      label: 'gradient-sky-bgl',
      entries: [
        { binding: 2, visibility: GPU_SHADER_STAGE_FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 4, visibility: GPU_SHADER_STAGE_FRAGMENT, buffer: { type: 'uniform' } },
      ],
    })
    .unwrap();
  const params = device
    .createBuffer({
      label: 'gradient-sky-params',
      size: GRADIENT_SKY_PARAMS_BYTES,
      usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
      mappedAtCreation: false,
    })
    .unwrap();
  const state = { layout, params, pipelines: new Map<string, RenderPipeline>() };
  deviceStates.set(module, state);
  return state;
}

function pipelineFor(
  device: RhiDevice,
  module: ShaderModule,
  state: GradientSkyDeviceState,
  domain: GradientSkyDomain,
  format: TextureFormat,
  sampleCount: number,
): RenderPipeline {
  const key = `${domain}:${format}:${sampleCount}`;
  const cached = state.pipelines.get(key);
  if (cached !== undefined) return cached;
  // The display entry only fills coverage the scene left transparent.
  const under = { srcFactor: 'one-minus-dst-alpha', dstFactor: 'one', operation: 'add' } as const;
  const pipeline = device
    .createRenderPipeline({
      label: `gradient-sky-${domain}`,
      layout: device.createPipelineLayout({ bindGroupLayouts: [state.layout] }).unwrap(),
      vertex: { module, entryPoint: 'vs_main', buffers: [] },
      fragment: {
        module,
        entryPoint: domain === 'scene' ? 'gradient_sky_fs' : 'gradient_sky_display_fs',
        targets: [
          domain === 'scene' ? { format } : { format, blend: { color: under, alpha: under } },
        ],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      ...(sampleCount > 1 ? { multisample: { count: sampleCount } } : {}),
    })
    .unwrap();
  state.pipelines.set(key, pipeline);
  return pipeline;
}

function outputOf(c: _InternalRenderPipelineContext, camera: CameraSnapshot): GradientSkyOutput {
  return {
    exposure: camera.exposure,
    whitePoint: camera.whitePoint,
    tonemap: tonemapToU32(camera.tonemap),
    gamut: OUTPUT_GAMUT_CODE[c.runtime.outputColorSpace?.report.effective ?? 'srgb'],
  };
}

/** Draw the frame's GradientSky in `domain` into the open pass; absent skies record nothing. */
export function encodeGradientSky(
  c: _InternalRenderPipelineContext,
  pass: RhiRenderPassEncoder,
  domain: GradientSkyDomain,
  target: Pick<RenderPipelineTarget, 'format' | 'sampleCount'>,
): void {
  const environment = c.frameState.environmentFrame;
  const sky = environment?.sky;
  const module = c.pipelineState.perPassResources.skyboxModule;
  if (!gradientSkyIn(sky, domain) || module === undefined || module === null) return;
  const device = c.runtime.device;
  const state = deviceState(device, module);
  const params = packGradientSkyParams(
    sky,
    environment?.sun,
    environment?.fog,
    outputOf(c, c.camera),
    domain,
  );
  device.queue.writeBuffer(state.params, 0, params).unwrap();
  const group = device
    .createBindGroup({
      label: 'gradient-sky-bg',
      layout: state.layout,
      entries: [
        {
          binding: 2,
          resource: {
            kind: 'buffer',
            value: { buffer: c.pipelineState.viewUniformBuffer, size: VIEW_UNIFORM_BYTES },
          },
        },
        { binding: 4, resource: { kind: 'buffer', value: { buffer: state.params } } },
      ],
    })
    .unwrap();
  pass.setPipeline(pipelineFor(device, module, state, domain, target.format, target.sampleCount));
  pass.setBindGroup(0, group);
  pass.draw(3);
}

/**
 * Display-referred GradientSky behind the finished, encoded frame. It runs last
 * so FXAA, TAA, bloom and every encoded effect keep their own coverage edges.
 */
export function addGradientSkyDisplayPass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  target: RenderPipelineTarget,
): Result<void, RenderGraphError> {
  const internal = (frame: RenderPipelineFrame) => frame as _InternalRenderPipelineContext;
  const added = graph.addRasterPass('gradient-sky-display', {
    accesses: [{ resource: target.view, usage: 'color-attachment' }],
    colorAttachments: [{ view: target.view, loadOp: 'load', storeOp: 'store' }],
    executeIf: (frame) =>
      gradientSkyIn(internal(frame).frameState.environmentFrame?.sky, 'display'),
    encode: ({ pass, frame }) => encodeGradientSky(internal(frame), pass, 'display', target),
  });
  return added.ok ? ok(undefined) : added;
}
