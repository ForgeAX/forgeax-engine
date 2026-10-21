import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { type Buffer, RhiError } from '@forgeax/engine-rhi';
import type { AssetHandle } from '@forgeax/engine-types';
import type { RendererGenerationFence } from '../assembly/renderer-frame-transaction';
import { ResidencyLifetime } from '../device/residency-lifetime';
import type { StandardBakedDiffuseGi } from '../pipeline/standard-profile';
import type { RenderSystemInternals } from '../record/render-context';
import { createRayDiffuseComposite } from './diffuse-composite';
import {
  createIrradianceFieldViewKernels,
  IRRADIANCE_FIELD_FRAME_BYTES,
  IRRADIANCE_FIELD_UNIFORM_BYTES,
  packIrradianceFieldUniform,
} from './irradiance-field';
import type { FieldGatherExtent, FieldGatherSource } from './irradiance-field-graph';
import { IRRADIANCE_FIELD_PROBE_BYTES } from './irradiance-field-plan';
import {
  type IrradianceVolume,
  irradianceVolumeKind,
  irradianceVolumeProbeBlocks,
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
  readonly gathered: Buffer;
  readonly lifetime: ResidencyLifetime;
}

/** One loaded volume's resident probes; the graph gathers them, nothing traces. */
export interface PreparedBakedField extends FieldGatherSource<BakedFieldExtent> {
  readonly generation: number;
  readonly fence: RendererGenerationFence;
  readonly volume: IrradianceVolume;
  readonly buffers: Readonly<
    Record<
      'field' | 'frame' | 'irradiance' | 'moments' | 'meta',
      { readonly buffer: Buffer; readonly size: number }
    >
  >;
  track(completed: Promise<unknown>): void;
  commit(): void;
  retire(): void;
}

const storage = 128 | 12;
/** Renderer-owned baked diffuse GI: a Catalog irradiance volume gathered per
 * pixel through the irradiance-field sampler. The generation follows the
 * device, the selected volume content and the profile; no frame traces or updates probes. */
export class RendererBakedField {
  #input: BakedFieldFrameInput | undefined;
  #key = '';
  #generation = 0;
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
    return ready?.fence.currentGeneration() === ready?.generation ? ready : undefined;
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
              digest: ready.volume.digest,
              dimensions: ready.volume.dimensions,
              probes: ready.volume.probeCount,
              bytes:
                ready.buffers.irradiance.size +
                ready.buffers.moments.size +
                ready.buffers.meta.size,
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

  #signature(): string {
    const input = this.#input;
    if (input === undefined) return '';
    return JSON.stringify([
      input.runtime.deviceScope.generation,
      this.#source === undefined
        ? undefined
        : runtimeAssets(this.#source.assets).version(this.#source.handle).unwrap(),
      input.profile.volume,
      input.profile.resolution,
    ]);
  }

  prepare(input: BakedFieldFrameInput): void {
    if (this.#disposed) return;
    if (
      this.#input !== undefined &&
      (this.#input.runtime.assets !== input.runtime.assets ||
        this.#input.profile.volume !== input.profile.volume)
    )
      this.disable();
    this.#input = input;
    if (this.#source === undefined) {
      if (this.#pending || this.#error) return;
      this.#pending = true;
      const generation = this.#generation;
      const assets = input.runtime.assets;
      void assets
        .load(input.profile.volume, irradianceVolumeKind)
        .then((loaded) => {
          if (!loaded.ok) {
            if (!this.#disposed && this.#generation === generation)
              this.#fail(input.runtime, loaded.error);
            return;
          }
          if (this.#disposed || this.#generation !== generation) assets.release(loaded.value);
          else this.#source = { assets, guid: input.profile.volume, handle: loaded.value };
        })
        .catch((cause) => {
          if (!this.#disposed && this.#generation === generation) this.#fail(input.runtime, cause);
        })
        .finally(() => {
          this.#pending = false;
        });
      return;
    }
    const key = this.#signature();
    if (key !== this.#key) {
      this.#generation++;
      this.#key = key;
      this.#ready?.retire();
      this.#ready = undefined;
      this.#error = undefined;
      this.#submitted = 0;
    }
    if (this.#pending || this.#ready || this.#error) return;
    this.#pending = true;
    const generation = this.#generation;
    const fence: RendererGenerationFence = {
      capturedGeneration: generation,
      currentGeneration: () =>
        !this.#disposed && this.#generation === generation && this.#signature() === this.#key
          ? generation
          : -1,
    };
    void this.#build(input, fence)
      .then(
        (candidate) => {
          if (fence.currentGeneration() === generation) this.#ready = candidate;
          else candidate.retire();
        },
        (cause) => {
          if (fence.currentGeneration() === generation) this.#fail(input.runtime, cause);
        },
      )
      .finally(() => {
        this.#pending = false;
      });
  }

  #fail(runtime: RenderSystemInternals, cause: unknown): void {
    this.#ready?.retire();
    this.#ready = undefined;
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
  ): Promise<PreparedBakedField> {
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
      const entries = [...shaders.entries()];

      const [viewModule, compositeModule] = await Promise.all([
        compile(device, {
          label: 'baked-field.view',
          code: requirePublishedKernel(entries, 'gatherBakedField'),
        }),
        compile(device, {
          label: 'baked-field.composite',
          code: requirePublishedKernel(entries, 'fs_ray_diffuse'),
        }),
      ]);
      const { sampleLayout, kernels: view } = createIrradianceFieldViewKernels(
        device,
        viewModule.unwrap(),
        'baked',
      ).unwrap();
      const composite = createRayDiffuseComposite(
        device,
        compositeModule.unwrap(),
        'reconstructed',
      ).unwrap();
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
      let extent: BakedFieldExtent | undefined;
      const destroy = () => {
        extent?.lifetime.retire();
        for (const buffer of owned) device.destroyBuffer(buffer);
        fixed.dispose();
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
          frame: upload('frame', new Uint8Array(IRRADIANCE_FIELD_FRAME_BYTES), 64 | 8),
          irradiance: upload('irradiance', irradianceVolumeProbeBlocks(volume)),
          moments: upload('moments', volume.moments),
          meta: upload('meta', volume.meta),
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
        const half = profile.resolution === 'half';
        const lifetime = new ResidencyLifetime(destroy);
        const resize = (): BakedFieldExtent => {
          const { width, height } = this.#input ?? input;
          if (extent !== undefined && extent.width === width && extent.height === height)
            return extent;
          if (width * height * 16 > limit)
            throw new Error('baked field view buffers exceed the storage binding limit');
          const gatherWidth = half ? Math.ceil(width / 2) : width;
          const gatherHeight = half ? Math.ceil(height / 2) : height;
          const created: Buffer[] = [];
          const make = (label: string, size: number) => {
            const buffer = device
              .createBuffer({ label: `baked-field.${label}`, size, usage: storage })
              .unwrap();
            created.push(buffer);
            return buffer;
          };
          extent?.lifetime.retire();
          extent = {
            width,
            height,
            gatherWidth,
            gatherHeight,
            gathered: make('gathered', gatherWidth * gatherHeight * 16),
            upsampled: half ? make('upsampled', width * height * 16) : undefined,
            lifetime: new ResidencyLifetime(() => {
              for (const buffer of created) device.destroyBuffer(buffer);
            }),
          };
          // The gather/upsample kernels read only `gather` (u32 20..23) of the field frame.
          const frame = new Uint32Array(IRRADIANCE_FIELD_FRAME_BYTES / 4);
          frame.set([gatherWidth, gatherHeight, width, height], 20);
          device.queue.writeBuffer(buffers.frame.buffer, 0, new Uint8Array(frame.buffer)).unwrap();
          return extent;
        };
        resize();
        return {
          generation: fence.capturedGeneration,
          fence,
          volume,
          buffers,
          view,
          sample,
          composite,
          extent: resize,
          track: (completed) => {
            lifetime.track(completed);
            extent?.lifetime.track(completed);
          },
          commit: () => {
            if (
              fence.currentGeneration() === fence.capturedGeneration &&
              this.#ready?.generation === fence.capturedGeneration
            )
              this.#submitted++;
          },
          retire: () => lifetime.retire(),
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

  disable(): void {
    if (this.#input === undefined) return;
    this.#generation++;
    this.#ready?.retire();
    this.#ready = undefined;
    this.#input = undefined;
    if (this.#source !== undefined) this.#source.assets.release(this.#source.handle);
    this.#source = undefined;
    this.#key = '';
    this.#error = undefined;
    this.#submitted = 0;
  }

  dispose(): void {
    this.#disposed = true;
    this.disable();
  }
}
