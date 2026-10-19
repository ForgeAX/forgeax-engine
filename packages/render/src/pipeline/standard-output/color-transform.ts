import { halfFloat } from '@forgeax/engine-math';
import type {
  ColorValueDomain,
  GraphAccess,
  GraphResourceResolver,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import type {
  BindGroup,
  BindGroupLayout,
  RenderPipeline,
  RhiDevice,
  Sampler,
  ShaderModule,
} from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { DeviceScope } from '../../device/device-scope';
import type { _InternalRenderPipelineContext } from '../../record/render-context';
import type { RenderPipelineFrame, RenderPipelineTarget } from '../../render-pipeline';
import { bradfordAdaptD65 } from './auto-exposure/oracle';

export const LINEAR_HDR_DOMAIN: ColorValueDomain = 'linear-hdr';
export const LINEAR_LDR_DOMAIN: ColorValueDomain = 'linear-ldr';
export const DISPLAY_ENCODED_DOMAIN: ColorValueDomain = 'display-encoded';

type StandardRgb = readonly [number, number, number];
type StandardRgba = readonly [number, number, number, number];

/** Apply the camera's Bradford white-balance adaptation in linear HDR. */
export function applyStandardWhiteBalance(
  rgb: StandardRgb,
  temperature: number,
  tint: number,
): [number, number, number] {
  const adapted = bradfordAdaptD65(rgb, temperature);
  if (tint === 0) return adapted;
  const greenScale = Math.max(0, 1 - tint);
  const magentaScale = Math.max(0, 1 + tint);
  return [adapted[0] * magentaScale, adapted[1] * greenScale, adapted[2] * magentaScale];
}

interface StandardColorLutData {
  readonly size: number;
  /** RGBA half-float texels in z-major, y-major, x-major order. */
  readonly data: ArrayLike<number>;
}

function lutValue(data: ArrayLike<number>, index: number): number {
  const value = data[index] ?? 0;
  if (data instanceof Uint8Array) {
    const byte = index * 2;
    return halfFloat.f16ToF32((data[byte] ?? 0) | ((data[byte + 1] ?? 0) << 8));
  }
  return data instanceof Uint16Array ? halfFloat.f16ToF32(value) : value;
}

function sampleNearest(data: StandardColorLutData, x: number, y: number, z: number): StandardRgba {
  const size = data.size;
  const texel = ((z * size + y) * size + x) * 4;
  return [
    lutValue(data.data, texel),
    lutValue(data.data, texel + 1),
    lutValue(data.data, texel + 2),
    lutValue(data.data, texel + 3),
  ];
}

/** CPU reference for the fixed clamp-to-edge, texel-center trilinear LUT sample. */
export function sampleStandardColorLut(
  data: StandardColorLutData,
  rgb: StandardRgb,
  strength = 1,
  alpha = 1,
): StandardRgba {
  if (!Number.isInteger(data.size) || data.size < 2) return [rgb[0], rgb[1], rgb[2], alpha];
  const size = data.size;
  const coordinate = rgb.map((value) =>
    Math.min(size - 1, Math.max(0, Math.min(1, value) * size - 0.5)),
  ) as [number, number, number];
  const base = coordinate.map(Math.floor) as [number, number, number];
  const fraction: [number, number, number] = [
    coordinate[0] - base[0],
    coordinate[1] - base[1],
    coordinate[2] - base[2],
  ];
  const sampled: [number, number, number, number] = [0, 0, 0, 0];
  for (let dz = 0; dz <= 1; dz += 1) {
    for (let dy = 0; dy <= 1; dy += 1) {
      for (let dx = 0; dx <= 1; dx += 1) {
        const sample = sampleNearest(
          data,
          Math.min(size - 1, base[0] + dx),
          Math.min(size - 1, base[1] + dy),
          Math.min(size - 1, base[2] + dz),
        );
        const weight =
          (dx === 0 ? 1 - fraction[0] : fraction[0]) *
          (dy === 0 ? 1 - fraction[1] : fraction[1]) *
          (dz === 0 ? 1 - fraction[2] : fraction[2]);
        sampled[0] += sample[0] * weight;
        sampled[1] += sample[1] * weight;
        sampled[2] += sample[2] * weight;
        sampled[3] += sample[3] * weight;
      }
    }
  }
  const amount = Math.min(1, Math.max(0, strength));
  return [
    rgb[0] + (sampled[0] - rgb[0]) * amount,
    rgb[1] + (sampled[1] - rgb[1]) * amount,
    rgb[2] + (sampled[2] - rgb[2]) * amount,
    alpha,
  ];
}

const COLOR_STAGE_PRELUDE_WGSL = /* wgsl */ `
struct VertexOutput { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn color_stage_vs(@builtin(vertex_index) index: u32) -> VertexOutput {
  var positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -3.0), vec2<f32>(3.0, 1.0), vec2<f32>(-1.0, 1.0));
  let p = positions[index];
  return VertexOutput(vec4<f32>(p, 0.0, 1.0), vec2<f32>(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5));
}
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var sourceSampler: sampler;
`;

/** Stage-owned GPU inputs, bound at `@group(1)` beside the shared group-0 source. */
interface StandardColorStageResources {
  readonly accesses: readonly GraphAccess[];
  bind(
    device: RhiDevice,
    resources: GraphResourceResolver,
  ): { readonly layout: BindGroupLayout; readonly bindGroup: BindGroup };
}

interface ColorStageProgram {
  readonly device: RhiDevice;
  readonly factory: object;
  readonly createModule: unknown;
  readonly name: string;
  readonly code: string;
  readonly module: ShaderModule;
  readonly moduleLabel: string;
  readonly format: string;
  readonly sampleCount: number;
  readonly stageLayout: BindGroupLayout | undefined;
  readonly layout: BindGroupLayout;
  readonly sampler: Sampler;
  readonly pipeline: RenderPipeline;
}

const colorStagePrograms = new WeakMap<DeviceScope, ColorStageProgram[]>();
const MAX_COLOR_STAGE_PROGRAMS = 16;

function programsFor(scope: DeviceScope): ColorStageProgram[] {
  let programs = colorStagePrograms.get(scope);
  if (programs === undefined) {
    programs = [];
    colorStagePrograms.set(scope, programs);
    const owned = programs;
    scope._adopt('post-effect', programs, () => {
      colorStagePrograms.delete(scope);
      owned.length = 0;
    });
  }
  return programs;
}

/**
 * Record one fullscreen Standard color stage. `fragmentWgsl` follows the
 * shared prelude (`source` / `sourceSampler` / `VertexOutput`) and defines
 * `color_stage_fs`.
 */
export function addStandardColorStagePass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  name: string,
  input: RenderPipelineTarget,
  output: RenderPipelineTarget,
  fragmentWgsl: string,
  stage?: StandardColorStageResources,
): Result<void, RenderGraphError> {
  const code = COLOR_STAGE_PRELUDE_WGSL + fragmentWgsl;
  // The adapter keys modules by label; strengths and other source constants
  // must not alias the first module requested under the stage's display name.
  let moduleLabel: string | undefined;
  let unscopedPrograms: ColorStageProgram[] | undefined;
  const added = graph.addRasterPass(name, {
    accesses: [
      { resource: input.view, usage: 'sampled-read' },
      ...(stage?.accesses ?? []),
      { resource: output.view, usage: 'color-attachment' },
    ],
    colorAttachments: [
      {
        view: output.view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      },
    ],
    encode: ({ pass, frame, resources }) => {
      const runtime = (frame as _InternalRenderPipelineContext).runtime;
      const device = runtime.device;
      const scope = runtime.deviceScope;
      const factory = runtime.immediateShaderModuleFactory ?? runtime.shaderModuleFactory;
      if (factory === undefined) throw new Error(`${name} shader factory unavailable`);
      const stageBinding = stage?.bind(device, resources);
      if (scope === undefined) unscopedPrograms ??= [];
      const programs =
        scope === undefined ? unscopedPrograms : scope.isAlive() ? programsFor(scope) : undefined;
      moduleLabel ??=
        programs?.find((entry) => entry.name === name && entry.code === code)?.moduleLabel ??
        `${name}-sha256:${bytesToHex(sha256(utf8ToBytes(code)))}`;
      // The factory remains the module/pending authority, including invalidation
      // that does not replace its object or method.
      const source = factory.createShaderModule({ code, label: moduleLabel });
      if (!source.ok) throw source.error;
      let program = programs?.find(
        (entry) =>
          entry.device === device &&
          entry.factory === factory &&
          entry.createModule === factory.createShaderModule &&
          entry.name === name &&
          entry.code === code &&
          entry.module === source.value &&
          entry.format === output.format &&
          entry.sampleCount === output.sampleCount &&
          entry.stageLayout === stageBinding?.layout,
      );
      if (program === undefined) {
        const createdLayout = device.createBindGroupLayout({
          label: `${name}.bgl`,
          entries: [
            { binding: 0, visibility: 2, texture: { sampleType: 'float', viewDimension: '2d' } },
            { binding: 1, visibility: 2, sampler: { type: 'filtering' } },
          ],
        });
        if (!createdLayout.ok) throw createdLayout.error;
        const layout = createdLayout.value;
        const createdSampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
        if (!createdSampler.ok) throw createdSampler.error;
        const pipelineLayout = device.createPipelineLayout({
          label: `${name}.layout`,
          bindGroupLayouts: stageBinding === undefined ? [layout] : [layout, stageBinding.layout],
        });
        if (!pipelineLayout.ok) throw pipelineLayout.error;
        const created = device.createRenderPipeline({
          label: name,
          layout: pipelineLayout.value,
          vertex: { module: source.value, entryPoint: 'color_stage_vs', buffers: [] },
          fragment: {
            module: source.value,
            entryPoint: 'color_stage_fs',
            targets: [{ format: output.format as GPUTextureFormat }],
          },
          primitive: { topology: 'triangle-list' },
        });
        if (!created.ok) throw created.error;
        program = {
          device,
          factory,
          createModule: factory.createShaderModule,
          name,
          code,
          module: source.value,
          moduleLabel,
          format: output.format,
          sampleCount: output.sampleCount,
          stageLayout: stageBinding?.layout,
          layout,
          sampler: createdSampler.value,
          pipeline: created.value,
        };
        // Graph views/bind groups remain current; only immutable device objects
        // survive a topology replacement. Failed creations never enter this list.
        if (programs !== undefined && (scope === undefined || scope.isAlive())) {
          if (programs.length === MAX_COLOR_STAGE_PROGRAMS) programs.shift();
          programs.push(program);
        }
      }
      const inputView = resources.textureView(input.view);
      if (!inputView.ok) throw inputView.error;
      const bindings = device.createBindGroup({
        layout: program.layout,
        entries: [
          { binding: 0, resource: { kind: 'textureView', value: inputView.value } },
          { binding: 1, resource: { kind: 'sampler', value: program.sampler } },
        ],
      });
      if (!bindings.ok) throw bindings.error;
      pass.setPipeline(program.pipeline);
      pass.setBindGroup(0, bindings.value);
      if (stageBinding !== undefined) pass.setBindGroup(1, stageBinding.bindGroup);
      pass.draw(3, 1, 0, 0);
    },
  });
  return added.ok ? ok(undefined) : added;
}
