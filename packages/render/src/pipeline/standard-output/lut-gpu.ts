import type { RenderGraphBuilder, RenderGraphError } from '@forgeax/engine-render-graph';
import type {
  BindGroup,
  BindGroupLayout,
  RhiDevice,
  Sampler,
  Texture,
  TextureView,
} from '@forgeax/engine-rhi';
import type { AssetHandle } from '@forgeax/engine-types';
import { err, ok, type Result, type TextureAsset } from '@forgeax/engine-types';
import type { GpuResidencyCache, TextureGpuEntry } from '../../device/gpu-residency';
import type { RenderResourceScope } from '../../publication/resource-scope';
import type { RenderPipelineFrame, RenderPipelineTarget } from '../../render-pipeline';
import { addStandardColorStagePass } from './color-transform';
import {
  admitStandardColorLut,
  createStandardLutSamplerDescriptor,
  type StandardLutAdmissionError,
  type StandardLutAdmissionErrorCode,
} from './lut-admission';

/** Device-lifetime binding cached per managed reference; per-camera facts extend it. */
interface CachedLutBinding {
  readonly texture: Texture;
  readonly view: TextureView;
  readonly sampler: Sampler;
  readonly bindGroupLayout: BindGroupLayout;
  readonly bindGroup: BindGroup;
  readonly size: number;
}

export interface StandardLutGpuResources extends CachedLutBinding {
  readonly sourceKey: string;
  readonly strength: number;
}

export interface StandardLutGraphProjection {
  readonly view: import('@forgeax/engine-render-graph').GraphTextureView;
  readonly strength: number;
  bind(frame: RenderPipelineFrame): Pick<CachedLutBinding, 'bindGroupLayout' | 'bindGroup'>;
}

export interface StandardLutGpuPreparationInput {
  readonly world: RenderResourceScope;
  readonly handle: AssetHandle<'texture'>;
  readonly strength: number;
  readonly gpuStore: GpuResidencyCache;
  readonly device: RhiDevice;
}

const lutBindingCache = new WeakMap<object, Map<string, CachedLutBinding>>();

/** Release only the projection-owned LUT objects; texture residency is cache-owned. */
export function retireStandardLutGpuResources(_resources: StandardLutGpuResources): void {
  // RHI samplers and bind-group layouts are device-lifetime objects. The
  // GpuResidencyCache remains the sole owner of the resident TextureAsset.
}

export type StandardLutGpuErrorCode =
  | StandardLutAdmissionErrorCode
  | 'standard-lut-strength-invalid'
  | 'standard-lut-residency-failed'
  | 'standard-lut-not-resident'
  | 'standard-lut-3d-view-unavailable'
  | 'standard-lut-sampler-failed'
  | 'standard-lut-bind-group-layout-failed'
  | 'standard-lut-bind-failed';

export interface StandardLutGpuError {
  readonly code: StandardLutGpuErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: Readonly<Record<string, number | string | boolean>>;
}

export type StandardLutPreparationError = StandardLutAdmissionError | StandardLutGpuError;

function failure(
  code: StandardLutGpuErrorCode,
  expected: string,
  hint: string,
  detail: Readonly<Record<string, number | string | boolean>> = {},
): Result<never, StandardLutGpuError> {
  return err({ code, expected, hint, detail });
}

function causeDetail(cause: unknown): Readonly<Record<string, number | string | boolean>> {
  if (typeof cause !== 'object' || cause === null) return { cause: String(cause) };
  const value = cause as {
    readonly code?: unknown;
    readonly expected?: unknown;
    readonly hint?: unknown;
  };
  return {
    ...(typeof value.code === 'string' ? { causeCode: value.code } : {}),
    ...(typeof value.expected === 'string' ? { causeExpected: value.expected } : {}),
    ...(typeof value.hint === 'string' ? { causeHint: value.hint } : {}),
  };
}

/** Resolve, admit, make resident, and bind one ordinary TextureAsset LUT. */
export function prepareStandardLutGpu(
  input: StandardLutGpuPreparationInput,
): Result<StandardLutGpuResources, StandardLutPreparationError> {
  if (!Number.isFinite(input.strength) || input.strength <= 0) {
    return failure(
      'standard-lut-strength-invalid',
      'the LUT blend strength must be finite and positive',
      'set Camera.colorLutStrength to a value in (0, 1]',
      { strength: String(input.strength) },
    );
  }
  const asset = input.world.resolveAsset<TextureAsset>(input.handle);
  if (!asset.ok) {
    return failure(
      'standard-lut-residency-failed',
      'the authored TextureAsset handle resolves in the active RenderResourceScope',
      'register or rebuild the TextureAsset, then retry the same camera generation',
      causeDetail(asset.error),
    );
  }
  const source = input.world.sourceForAsset(input.handle);
  const guid = source?.guid;
  const reference = `${input.world.identity}:${input.handle}`;
  const sourceKey = source?.sourceKey ?? reference;
  const resident = input.gpuStore.getTextureGpuView(input.handle, input.world);
  let entry: TextureGpuEntry | undefined;
  if (resident === undefined) {
    const prepared = input.gpuStore.ensureResident(input.handle, asset.value, input.world);
    if (!prepared.ok) {
      return failure(
        'standard-lut-residency-failed',
        'the LUT TextureAsset becomes resident through the producer-owned GPU store',
        'inspect the structured residency failure and rebuild the source asset before retrying',
        causeDetail(prepared.error),
      );
    }
    if (!('texture' in prepared.value)) {
      return failure(
        'standard-lut-residency-failed',
        'the LUT handle resolves to a resident TextureAsset, not a mesh resource',
        'repair the authored handle kind and retry the same source key',
        { guid: String(guid) },
      );
    }
    entry = prepared.value;
  }
  const view = resident ?? entry?.view;
  const texture =
    entry?.texture.handle ??
    input.gpuStore._getTextureGpuTexture(input.handle, input.world)?.handle;
  if (view === undefined || texture === undefined) {
    return failure(
      'standard-lut-not-resident',
      'the LUT has a live GPU texture and view before graph admission',
      'retain the current LKG and retry producer-owned residency for the same GUID/sourceKey',
      { guid: String(guid), sourceKey },
    );
  }
  const cache =
    lutBindingCache.get(input.device) ??
    (() => {
      const created = new Map<string, CachedLutBinding>();
      lutBindingCache.set(input.device, created);
      return created;
    })();
  const cached = cache.get(reference);
  if (cached !== undefined && cached.texture === texture) {
    return ok({ ...cached, sourceKey, strength: input.strength });
  }
  // Recreate the resident view with an explicit 3D descriptor.  This is a
  // live capability check rather than a shape assertion: a device that
  // rejects a 3D view cannot admit this LUT route.
  const liveView = input.device.createTextureView(texture, { dimension: '3d' });
  if (!liveView.ok) {
    return failure(
      'standard-lut-3d-view-unavailable',
      'the resident texture creates a live 3D texture view',
      'disable the LUT and retain the last known good output on this device',
      causeDetail(liveView.error),
    );
  }
  const sampler =
    cached === undefined
      ? input.device.createSampler(createStandardLutSamplerDescriptor())
      : ok(cached.sampler);
  if (!sampler.ok) {
    return failure(
      'standard-lut-sampler-failed',
      'the live device creates the filtering sampler required by the LUT',
      'disable the LUT and retain the last known good output',
      causeDetail(sampler.error),
    );
  }
  const bindGroupLayout =
    cached === undefined
      ? input.device.createBindGroupLayout({
          entries: [
            { binding: 0, visibility: 2, texture: { sampleType: 'float', viewDimension: '3d' } },
            { binding: 1, visibility: 2, sampler: { type: 'filtering' } },
          ],
        })
      : ok(cached.bindGroupLayout);
  if (!bindGroupLayout.ok) {
    return failure(
      'standard-lut-bind-group-layout-failed',
      'the live device accepts a filtering float 3D LUT bind-group layout',
      'disable the LUT and retain the last known good output',
      causeDetail(bindGroupLayout.error),
    );
  }
  let liveBindGroup: ReturnType<RhiDevice['createBindGroup']>;
  try {
    liveBindGroup = input.device.createBindGroup({
      layout: bindGroupLayout.value,
      entries: [
        { binding: 0, resource: { kind: 'textureView', value: liveView.value } },
        { binding: 1, resource: { kind: 'sampler', value: sampler.value } },
      ],
    });
  } catch (cause) {
    return failure(
      'standard-lut-filter-unavailable',
      'the live device binds the rgba16float 3D view with a filtering sampler',
      'disable the LUT and retain the last known good output on this device',
      { cause: String(cause) },
    );
  }
  // The result of the real BGL/BG probe is the filterability fact passed to
  // the pure shape admission. No device capability is inferred or forced.
  const admission = admitStandardColorLut({
    texture: asset.value,
    maxTextureDimension3D: input.device.limits.maxTextureDimension3D,
    rgba16floatFilterable: liveBindGroup.ok,
    bind: () => liveBindGroup.ok,
  });
  if (!admission.ok) {
    if (admission.error.code === 'standard-lut-filter-unavailable' && !liveBindGroup.ok) {
      return err({
        ...admission.error,
        detail: Object.freeze({
          ...admission.error.detail,
          ...causeDetail(liveBindGroup.error),
        }),
      });
    }
    return admission;
  }
  if (!liveBindGroup.ok) {
    return failure(
      'standard-lut-bind-failed',
      'the admitted LUT view and sampler bind successfully',
      'disable the LUT and retain the last known good output',
      causeDetail(liveBindGroup.error),
    );
  }
  const binding: CachedLutBinding = {
    texture,
    view: liveView.value,
    sampler: sampler.value,
    bindGroupLayout: bindGroupLayout.value,
    bindGroup: liveBindGroup.value,
    size: admission.value.extent.width,
  };
  cache.set(reference, binding);
  return ok({ ...binding, sourceKey, strength: input.strength });
}

const LUT_STAGE_WGSL = /* wgsl */ `
@group(1) @binding(0) var lut: texture_3d<f32>;
@group(1) @binding(1) var lutSampler: sampler;
@fragment fn color_stage_fs(input: VertexOutput) -> @location(0) vec4<f32> {
  let color = textureSampleLevel(source, sourceSampler, input.uv, 0.0);
  let mapped = textureSampleLevel(lut, lutSampler, clamp(color.rgb, vec3<f32>(0.0), vec3<f32>(1.0)), 0.0);
  return vec4<f32>(mix(color.rgb, mapped.rgb, LUT_STRENGTH), color.a);
}`;

/** Record a fullscreen 3D LUT sample into the same Standard graph. */
export function addStandardColorLutPass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  input: RenderPipelineTarget,
  output: RenderPipelineTarget,
  lut: StandardLutGraphProjection,
): Result<void, RenderGraphError> {
  return addStandardColorStagePass(
    graph,
    'standard-color-lut',
    input,
    output,
    LUT_STAGE_WGSL.replace('LUT_STRENGTH', String(lut.strength)),
    {
      accesses: [{ resource: lut.view, usage: 'sampled-read' }],
      bind: (_device, _resources, frame) => {
        const binding = lut.bind(frame);
        return { layout: binding.bindGroupLayout, bindGroup: binding.bindGroup };
      },
    },
  );
}
