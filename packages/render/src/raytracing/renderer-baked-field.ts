import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { type Buffer, RhiError } from '@forgeax/engine-rhi';
import type { AssetHandle } from '@forgeax/engine-types';
import type { RendererGenerationFence } from '../assembly/renderer-frame-transaction';
import { ResidencyLifetime } from '../device/residency-lifetime';
import type { StandardBakedDiffuseGi } from '../pipeline/standard-profile';
import type { RenderSystemInternals } from '../record/render-context';
import { recordContext } from '../world/view-record-context';
import { createRayDiffuseComposite } from './diffuse-composite';
import {
  createBakedIrradianceFieldViewKernels,
  IRRADIANCE_FIELD_FRAME_BYTES,
  IRRADIANCE_FIELD_UNIFORM_BYTES,
  packIrradianceFieldUniform,
} from './irradiance-field';
import type { FieldGatherExtent } from './irradiance-field-graph';
import { IRRADIANCE_FIELD_PROBE_BYTES } from './irradiance-field-plan';
import {
  type IrradianceVolume,
  irradianceVolumeKind,
  irradianceVolumeProbeBlocks,
  irradianceVolumeProbeMeta,
  validateIrradianceVolume,
} from './irradiance-volume';
import { requirePublishedKernel } from './published-kernel';

export interface BakedFieldFrameInput {
  readonly runtime: RenderSystemInternals;
  readonly profile: StandardBakedDiffuseGi;
  readonly width: number;
  readonly height: number;
}

export interface BakedFieldInspection {
  readonly gather: 'baked';
  readonly state: 'preparing' | 'ready' | 'failed';
  readonly generation: number;
  readonly submittedFrames: number;
  readonly pixelCount: number;
  readonly volume?: {
    readonly guid: string;
    readonly digest: string;
    readonly dimensions: readonly [number, number, number];
    readonly probes: number;
    /** Resident probe bytes (irradiance blocks, moments, meta). */
    readonly bytes: number;
  };
  readonly error?: Pick<RhiError, 'code' | 'expected' | 'hint' | 'detail'>;
}

export interface BakedFieldExtent extends FieldGatherExtent {
  readonly device: RenderSystemInternals['device'];
  readonly deviceGeneration: number;
  readonly output: { readonly buffer: Buffer; readonly lifetime: ResidencyLifetime };
  readonly frame: { readonly buffer: Buffer };
  readonly gathered: Buffer;
  readonly lifetime: ResidencyLifetime;
}

interface ResidentBakedVolume {
  readonly volume: IrradianceVolume;
  readonly bytes: number;
  readonly view: Awaited<ReturnType<typeof createBakedPrograms>>['view'];
  readonly composite: Awaited<ReturnType<typeof createBakedPrograms>>['composite'];
  readonly sample: import('@forgeax/engine-rhi').BindGroup;
  readonly lifetime: ResidencyLifetime;
  readonly fence: RendererGenerationFence;
}

/** The exact volume and view grid borrowed by one or more compatible submissions. */
export interface PreparedBakedField {
  readonly generation: number;
  readonly fence: RendererGenerationFence;
  readonly source: ResidentBakedVolume;
  readonly extent: BakedFieldExtent;
  track(completed: Promise<unknown>): void;
  commit(): void;
}

const storage = 128 | 12;

function allocateViewOutput(device: RenderSystemInternals['device'], size: number) {
  const buffer = device
    .createBuffer({ label: 'baked-field.output', size, usage: storage })
    .unwrap();
  return { buffer, lifetime: new ResidencyLifetime(() => device.destroyBuffer(buffer)) };
}

function createViewGrid(
  input: BakedFieldFrameInput,
  deviceGeneration: number,
  previous: BakedFieldExtent | undefined,
): BakedFieldExtent {
  const { width, height } = input;
  const device = input.runtime.device;
  if (width * height * 16 > device.limits.maxStorageBufferBindingSize)
    throw new Error('baked field view buffers exceed the storage binding limit');
  const half = input.profile.resolution === 'half';
  const gatherWidth = half ? Math.ceil(width / 2) : width;
  const gatherHeight = half ? Math.ceil(height / 2) : height;
  const sameOutput =
    previous !== undefined &&
    previous.device === device &&
    previous.deviceGeneration === deviceGeneration &&
    previous.width === width &&
    previous.height === height;
  const output = sameOutput ? previous.output : allocateViewOutput(device, width * height * 16);
  const created: Buffer[] = [];
  const make = (label: string, size: number, usage = storage) => {
    const buffer = device.createBuffer({ label: `baked-field.${label}`, size, usage }).unwrap();
    created.push(buffer);
    return buffer;
  };
  const destroy = () => {
    for (const buffer of created) device.destroyBuffer(buffer);
  };
  try {
    const frame = { buffer: make('frame', IRRADIANCE_FIELD_FRAME_BYTES, 64 | 8) };
    const dimensions = new Uint32Array([gatherWidth, gatherHeight, width, height]);
    device.queue.writeBuffer(frame.buffer, 20 * 4, new Uint8Array(dimensions.buffer)).unwrap();
    return {
      device,
      deviceGeneration,
      width,
      height,
      gatherWidth,
      gatherHeight,
      frame,
      output,
      gathered: half ? make('gathered', gatherWidth * gatherHeight * 16) : output.buffer,
      upsampled: half ? output.buffer : undefined,
      lifetime: new ResidencyLifetime(destroy),
    };
  } catch (cause) {
    destroy();
    if (!sameOutput) output.lifetime.retire();
    throw cause;
  }
}

async function createBakedPrograms(
  device: RenderSystemInternals['device'],
  compile: NonNullable<RenderSystemInternals['createShaderModule']>,
  gatherSource: string,
  compositeSource: string,
) {
  const [gather, fragment] = await Promise.all([
    compile(device, { label: 'baked-field.view', code: gatherSource }),
    compile(device, { label: 'baked-field.composite', code: compositeSource }),
  ]);
  const [viewPrograms, diffuseComposite] = await Promise.all([
    createBakedIrradianceFieldViewKernels(device, gather.unwrap()),
    createRayDiffuseComposite(device, fragment.unwrap(), 'reconstructed'),
  ]);
  const { sampleLayout, kernels: view } = viewPrograms.unwrap();
  const composite = diffuseComposite.unwrap();
  return { sampleLayout, view, composite };
}

/** Renderer-owned baked diffuse GI: a Catalog irradiance volume gathered per
 * pixel through the irradiance-field sampler. The generation follows the
 * device, the selected volume content and the profile; no frame traces or updates probes. */
export class RendererBakedField {
  #input: BakedFieldFrameInput | undefined;
  #deviceGeneration: number | undefined;
  #sourceVersion: number | undefined;
  #programs:
    | {
        readonly device: RenderSystemInternals['device'];
        readonly generation: number;
        readonly gather: string;
        readonly composite: string;
        readonly compile: NonNullable<RenderSystemInternals['createShaderModule']>;
        readonly ready: ReturnType<typeof createBakedPrograms>;
      }
    | undefined;
  #sourceGeneration = 0;
  #generation = 0;
  #resident: ResidentBakedVolume | undefined;
  #grid: BakedFieldExtent | undefined;
  #pending = false;
  #ready: PreparedBakedField | undefined;
  #error: RhiError | undefined;
  #disposed = false;
  #submitted = 0;
  #source:
    | {
        readonly assets: AssetRegistry;
        readonly guid: string;
        readonly handle: AssetHandle<'irradiance-volume', IrradianceVolume>;
      }
    | undefined;

  get ready(): PreparedBakedField | undefined {
    const ready = this.#ready;
    return ready !== undefined && ready.fence.currentGeneration() === ready.generation
      ? ready
      : undefined;
  }

  inspect(): BakedFieldInspection {
    const ready = this.ready;
    const input = this.#input;
    return {
      gather: 'baked',
      state: this.#error ? 'failed' : ready ? 'ready' : 'preparing',
      generation: this.#generation,
      submittedFrames: this.#submitted,
      pixelCount: input ? input.width * input.height : 0,
      ...(ready === undefined || input === undefined
        ? {}
        : {
            volume: {
              guid: input.profile.volume,
              digest: ready.source.volume.digest,
              dimensions: ready.source.volume.dimensions,
              probes: ready.source.volume.probeCount,
              bytes: ready.source.bytes,
            },
          }),
      ...(this.#error === undefined
        ? {}
        : {
            error: {
              code: this.#error.code,
              expected: this.#error.expected,
              hint: this.#error.hint,
              detail: this.#error.detail,
            },
          }),
    };
  }

  prepare(input: BakedFieldFrameInput): void {
    if (this.#disposed) return;
    const deviceGeneration = recordContext(input.runtime).deviceScope.generation;
    if (
      this.#input !== undefined &&
      (this.#input.runtime.device !== input.runtime.device ||
        (this.#deviceGeneration !== undefined && this.#deviceGeneration !== deviceGeneration))
    )
      this.disable();
    if (
      this.#input !== undefined &&
      (this.#input.runtime.assets !== input.runtime.assets ||
        this.#input.profile.volume !== input.profile.volume)
    )
      this.#releaseVolume();
    if (
      this.#input !== undefined &&
      (this.#input.profile.resolution !== input.profile.resolution ||
        this.#input.width !== input.width ||
        this.#input.height !== input.height)
    ) {
      this.#generation++;
      this.#ready = undefined;
      this.#submitted = 0;
      if (this.#resident !== undefined) this.#error = undefined;
    }
    this.#input = input;
    if (this.#source === undefined) {
      const generation = this.#sourceGeneration;
      if (this.#pending || this.#error) return;
      this.#pending = true;
      const assets = input.runtime.assets;
      void assets
        .load(input.profile.volume, irradianceVolumeKind)
        .then((loaded) => {
          if (!loaded.ok) {
            if (!this.#disposed && this.#sourceGeneration === generation)
              this.#fail(input.runtime, loaded.error);
            return;
          }
          if (this.#disposed || this.#sourceGeneration !== generation) assets.release(loaded.value);
          else this.#source = { assets, guid: input.profile.volume, handle: loaded.value };
        })
        .catch((cause) => {
          if (!this.#disposed && this.#sourceGeneration === generation)
            this.#fail(input.runtime, cause);
        })
        .finally(() => {
          this.#pending = false;
        });
      return;
    }
    const source = this.#source;
    const records = runtimeAssets(source.assets);
    const version = records.version(source.handle).unwrap();
    if (deviceGeneration !== this.#deviceGeneration || version !== this.#sourceVersion) {
      this.#sourceGeneration++;
      this.#generation++;
      this.#deviceGeneration = deviceGeneration;
      this.#sourceVersion = version;
      this.#resident?.lifetime.retire();
      this.#resident = undefined;
      this.#ready = undefined;
      this.#error = undefined;
      this.#submitted = 0;
    }
    const generation = this.#sourceGeneration;
    if (this.#error !== undefined) return;
    if (this.#resident !== undefined) {
      if (this.#ready === undefined) this.#bindView(this.#resident, input, deviceGeneration);
      return;
    }
    if (this.#pending) return;
    this.#pending = true;
    const fence: RendererGenerationFence = {
      capturedGeneration: generation,
      currentGeneration: () =>
        !this.#disposed &&
        this.#sourceGeneration === generation &&
        recordContext(input.runtime).deviceScope.generation === deviceGeneration &&
        records.version(source.handle).unwrap() === version
          ? generation
          : -1,
    };
    void this.#build(input, fence)
      .then(
        (candidate) => {
          const current = this.#input;
          if (current !== undefined && fence.currentGeneration() === generation) {
            this.#resident = candidate;
            this.#bindView(candidate, current, deviceGeneration);
          } else candidate.lifetime.retire();
        },
        (cause) => {
          if (fence.currentGeneration() === generation) this.#fail(input.runtime, cause);
        },
      )
      .finally(() => {
        this.#pending = false;
      });
  }

  #bindView(
    source: ResidentBakedVolume,
    input: BakedFieldFrameInput,
    deviceGeneration: number,
  ): void {
    let grid = this.#grid;
    if (
      grid === undefined ||
      grid.device !== input.runtime.device ||
      grid.deviceGeneration !== deviceGeneration ||
      grid.width !== input.width ||
      grid.height !== input.height ||
      (grid.upsampled !== undefined) !== (input.profile.resolution === 'half')
    ) {
      try {
        grid = createViewGrid(input, deviceGeneration, grid);
      } catch (cause) {
        this.#fail(input.runtime, cause);
        return;
      }
      this.#replaceGrid(grid);
    }
    const extent = grid;
    const generation = this.#generation;
    const fence: RendererGenerationFence = {
      capturedGeneration: generation,
      currentGeneration: () =>
        this.#generation === generation &&
        source.fence.currentGeneration() === source.fence.capturedGeneration
          ? generation
          : -1,
    };
    this.#ready = {
      source,
      extent,
      generation,
      fence,
      track(completed) {
        source.lifetime.track(completed);
        extent.lifetime.track(completed);
        extent.output.lifetime.track(completed);
      },
      commit: () => {
        if (fence.currentGeneration() === generation) this.#submitted++;
      },
    };
  }

  #replaceGrid(next: BakedFieldExtent | undefined): void {
    const previous = this.#grid;
    this.#grid = next;
    previous?.lifetime.retire();
    if (previous !== undefined && previous.output !== next?.output)
      previous.output.lifetime.retire();
  }

  #fail(runtime: RenderSystemInternals, cause: unknown): void {
    this.#ready = undefined;
    this.#replaceGrid(undefined);
    this.#error =
      cause instanceof RhiError
        ? cause
        : new RhiError({
            code: 'rhi-not-available',
            expected:
              'a published irradiance-volume Catalog asset whose probes fit the storage binding limit for baked GI',
            hint: 'inspect the volume GUID in the Catalog; rebake it through the irradiance-volume NativeCooker',
            detail: {
              error: {
                code: 'baked-field-preparation',
                message: cause instanceof Error ? cause.message : JSON.stringify(cause),
                ...(typeof cause === 'object' && cause !== null ? { detail: cause } : {}),
              },
            },
          });
    runtime.errorRegistry.fire(this.#error);
  }

  async #build(
    input: BakedFieldFrameInput,
    fence: RendererGenerationFence,
  ): Promise<ResidentBakedVolume> {
    const { runtime, profile } = input;
    const device = runtime.device;
    const shaders = runtime.shaderRegistry;
    const compile = runtime.createShaderModule;
    if (shaders === undefined || compile === undefined)
      throw new Error('baked GI requires the ordinary shader registry and compiler');
    const sourceAsset = this.#source;
    if (
      sourceAsset === undefined ||
      sourceAsset.assets !== runtime.assets ||
      sourceAsset.guid !== profile.volume
    )
      throw new Error('baked GI requires its selected runtime volume');
    const fixed = runtimeAssets(runtime.assets).pin<IrradianceVolume>(sourceAsset.handle).unwrap();
    const volume = fixed.value;
    try {
      validateIrradianceVolume(volume).unwrap();
      const gatherSource = requirePublishedKernel(
        shaders.entries(),
        'gatherBakedField',
        'standard-gbuffer/2',
      );
      const compositeSource = requirePublishedKernel(
        shaders.entries(),
        'fs_ray_diffuse',
        'standard-gbuffer/2',
      );
      const generation = recordContext(runtime).deviceScope.generation;
      let programs = this.#programs;
      if (
        programs === undefined ||
        programs.device !== device ||
        programs.generation !== generation ||
        programs.gather !== gatherSource ||
        programs.composite !== compositeSource ||
        programs.compile !== compile
      ) {
        programs = {
          device,
          generation,
          gather: gatherSource,
          composite: compositeSource,
          compile,
          ready: createBakedPrograms(device, compile, gatherSource, compositeSource),
        };
        this.#programs = programs;
      }
      let kernels: Awaited<ReturnType<typeof createBakedPrograms>>;
      try {
        kernels = await programs.ready;
      } catch (cause) {
        if (this.#programs === programs) this.#programs = undefined;
        throw cause;
      }
      if (fence.currentGeneration() !== fence.capturedGeneration)
        throw new Error('baked field selection changed during program preparation');
      const { sampleLayout, view, composite } = kernels;
      const owned: Buffer[] = [];
      const limit = device.limits.maxStorageBufferBindingSize;
      const upload = (label: string, bytes: ArrayBufferView, usage = storage) => {
        if ((usage & 64) === 0 && bytes.byteLength > limit)
          throw new Error(
            `baked ${label} of ${bytes.byteLength} bytes exceeds the storage binding limit`,
          );
        const buffer = device
          .createBuffer({ label: `baked-field.${label}`, size: bytes.byteLength, usage })
          .unwrap();
        owned.push(buffer);
        device.queue
          .writeBuffer(buffer, 0, new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
          .unwrap();
        return { buffer, size: bytes.byteLength };
      };
      const destroy = () => {
        for (const buffer of owned) device.destroyBuffer(buffer);
      };
      try {
        const [dx, dy, dz] = volume.dimensions;
        const buffers = {
          field: upload(
            'field',
            packIrradianceFieldUniform(
              {
                origin: volume.origin,
                spacing: volume.spacing,
                dimensions: volume.dimensions,
                probeCount: volume.probeCount,
                levels: 1,
              },
              [{ window: [0, 0, 0], min: [0, 0, 0], max: [dx, dy, dz] }],
            ),
            64 | 8,
          ),
          irradiance: upload('irradiance', irradianceVolumeProbeBlocks(volume)),
          moments: upload('moments', volume.moments),
          meta: upload('meta', irradianceVolumeProbeMeta(volume)),
        };
        if (buffers.irradiance.size !== volume.probeCount * IRRADIANCE_FIELD_PROBE_BYTES)
          throw new Error('baked probe blocks do not match the field stride');
        if (buffers.field.size !== IRRADIANCE_FIELD_UNIFORM_BYTES)
          throw new Error('baked field uniform does not match the sampler layout');
        const sample = device
          .createBindGroup({
            layout: sampleLayout,
            entries: (['field', 'irradiance', 'moments', 'meta'] as const).map((name, binding) => ({
              binding,
              resource: { kind: 'buffer' as const, value: buffers[name] },
            })),
          })
          .unwrap();
        const lifetime = new ResidencyLifetime(() => {
          try {
            destroy();
          } finally {
            fixed.dispose();
          }
        });
        return {
          volume,
          bytes: buffers.irradiance.size + buffers.moments.size + buffers.meta.size,
          view,
          sample,
          composite,
          fence,
          lifetime,
        };
      } catch (cause) {
        destroy();
        throw cause;
      }
    } catch (cause) {
      fixed.dispose();
      throw cause;
    }
  }

  #releaseVolume(): void {
    if (this.#input === undefined) return;
    this.#sourceGeneration++;
    this.#generation++;
    this.#resident?.lifetime.retire();
    this.#resident = undefined;
    this.#ready = undefined;
    this.#input = undefined;
    if (this.#source !== undefined) this.#source.assets.release(this.#source.handle);
    this.#source = undefined;
    this.#deviceGeneration = undefined;
    this.#sourceVersion = undefined;
    this.#error = undefined;
    this.#submitted = 0;
  }

  disable(): void {
    this.#releaseVolume();
    this.#replaceGrid(undefined);
    this.#programs = undefined;
  }

  dispose(): void {
    this.#disposed = true;
    this.disable();
  }
}
