import { type Buffer, RhiError, type Sampler } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import type { RendererGenerationFence } from '../assembly/renderer-frame-transaction';
import { ResidencyLifetime } from '../device/residency-lifetime';
import type { StandardExactDiffuseGi } from '../pipeline/standard-profile';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { RenderSystemInternals } from '../record/render-context';
import type { LightSnapshot } from '../render-system-extract';
import type { PersistentGpuDrivenState } from '../scene/render-scene';
import { createRayDiffuseComposite } from './diffuse-composite';
import { prepareSurfaceMaterialTextures } from './material-residency';
import { packLights } from './path-input';
import { createSubmittedRayPathTracer, RAY_PATH_STRIDE, type RayPathTracer } from './path-tracer';
import { createRasterRayGenerator } from './raster-source';
import { type PreparedRayReflections, prepareRayReflections } from './reflections-prepare';
import {
  prepareRendererDiffuseReconstruction,
  type RendererDiffuseReconstruction,
} from './renderer-diffuse-reconstruction';
import { rayReferenceFailure } from './scene';
import { projectRayScene } from './scene-projection';

type TexturePreparation = Extract<
  ReturnType<typeof prepareSurfaceMaterialTextures>,
  { ok: true }
>['value'];

interface RayDiffuseFrameInput {
  readonly runtime: RenderSystemInternals;
  readonly scene: PersistentGpuDrivenState;
  readonly worlds: readonly RenderResourceScope[];
  readonly lights: readonly LightSnapshot[];
  readonly sampler: Sampler;
  readonly profile: StandardExactDiffuseGi;
  readonly width: number;
  readonly height: number;
}

export interface RayDiffuseInspection {
  readonly state: 'preparing' | 'ready' | 'failed';
  readonly generation: number;
  readonly submittedFrames: number;
  readonly pixelCount: number;
  readonly error?: Pick<RhiError, 'code' | 'expected' | 'hint' | 'detail'>;
  readonly reconstruction?: ReturnType<RendererDiffuseReconstruction['inspect']>;
  /** Lite reflections denoise history, present when they are reconstructed. */
  readonly reflectionReconstruction?: ReturnType<RendererDiffuseReconstruction['inspect']>;
}

/** A frozen content snapshot; the ordinary graph supplies this frame's G-buffer/View. */
export interface PreparedRayDiffuse {
  readonly generation: number;
  readonly fence: RendererGenerationFence;
  readonly pixelCount: number;
  readonly records: Buffer;
  readonly recordBytes: number;
  readonly rays: Buffer;
  readonly sample: Buffer;
  readonly textures: readonly TexturePreparation[];
  readonly transport: RayPathTracer;
  readonly generate: Extract<ReturnType<typeof createRasterRayGenerator>, { ok: true }>['value'];
  readonly composite: Extract<ReturnType<typeof createRayDiffuseComposite>, { ok: true }>['value'];
  readonly reconstruction?: RendererDiffuseReconstruction;
  /** Lite reflections: world specular lane sharing this content snapshot. */
  readonly reflections?: PreparedRayReflections;
  /** Upload the seed/sample index for this attempted frame. Failed submits do not advance it. */
  writeSample(): void;
  track(completed: Promise<unknown>): void;
  commit(): void;
  retire(): void;
}

/** Renderer-owned preparation. A static sequence never invalidates by frame number.
 * UE LumenSceneRendering owns scene work outside view tracing; this exact-query
 * reference uses the same separation without claiming UE cache/gather behavior. */
export class RendererRayDiffuse {
  #input: RayDiffuseFrameInput | undefined;
  #key = '';
  #generation = 0;
  #pending = false;
  #ready: PreparedRayDiffuse | undefined;
  #error: RhiError | undefined;
  #disposed = false;
  #submitted = 0;

  get ready(): PreparedRayDiffuse | undefined {
    const ready = this.#ready;
    return ready?.fence.currentGeneration() === ready?.generation ? ready : undefined;
  }

  inspect(): RayDiffuseInspection {
    return {
      state: this.#error ? 'failed' : this.ready ? 'ready' : 'preparing',
      generation: this.#generation,
      submittedFrames: this.#submitted,
      pixelCount: this.#input ? this.#input.width * this.#input.height : 0,
      ...(this.ready?.reconstruction === undefined
        ? {}
        : { reconstruction: this.ready.reconstruction.inspect() }),
      ...(this.ready?.reflections?.reconstruction === undefined
        ? {}
        : { reflectionReconstruction: this.ready.reflections.reconstruction.inspect() }),
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
    const lights = packLights(input.lights);
    return JSON.stringify([
      input.runtime.deviceScope.generation,
      input.scene.scene.contentRevision,
      input.runtime.assets.catalogEpoch,
      input.runtime.gpuStore.materialResourceEpoch,
      input.worlds.map((world) => world.identity),
      input.width,
      input.height,
      input.runtime.standardProfile?.diffuseGi,
      // Shadow/camera-derived fields do not change transport light inputs.
      lights.ok ? [...lights.value] : lights.error,
    ]);
  }

  prepare(input: RayDiffuseFrameInput): void {
    if (this.#disposed) return;
    const sceneChanged = this.#input?.scene.scene !== input.scene.scene;
    this.#input = input;
    let key: string;
    try {
      key = this.#signature();
    } catch (cause) {
      this.#fail(input.runtime, cause);
      return;
    }
    if (sceneChanged || key !== this.#key) {
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
      currentGeneration: () => {
        if (this.#disposed || this.#generation !== generation) return -1;
        try {
          return this.#signature() === this.#key ? generation : -1;
        } catch {
          return -1;
        }
      },
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
    this.#error = new RhiError({
      code: 'rhi-not-available',
      expected: 'a complete, current rigid scene and published materials for reference diffuse GI',
      hint: 'inspect the GI preparation cause and repair its producer before retrying the changed scene',
      detail: {
        error: {
          code: 'ray-diffuse-preparation',
          message: cause instanceof Error ? cause.message : JSON.stringify(cause),
          ...(typeof cause === 'object' && cause !== null ? { detail: cause } : {}),
        },
      },
    });
    runtime.errorRegistry.fire(this.#error);
  }

  async #build(
    input: RayDiffuseFrameInput,
    fence: RendererGenerationFence,
  ): Promise<PreparedRayDiffuse> {
    const { runtime, width, height, profile } = input;
    const device = runtime.device;
    const shaders = runtime.shaderRegistry;
    const compile = runtime.createShaderModule;
    if (shaders === undefined || compile === undefined)
      throw new Error(
        'reference diffuse GI requires the ordinary shader registry and compiler adapter',
      );
    const pixelCount = width * height;
    if (!Number.isInteger(pixelCount) || pixelCount < 1 || pixelCount > 262144)
      throw new Error('reference diffuse GI requires 1..262144 internal texels');
    const projected = projectRayScene(
      input.scene.slots,
      input.worlds,
      Math.min(1_048_576, Math.floor(device.limits.maxStorageBufferBindingSize / 64)),
    );
    if (projected.surfaces.records.byteLength === 0)
      throw new Error('no admitted receiver records');
    const entries = [...shaders.entries()];
    const source = (entryPoint: string): string => {
      const matched = entries.filter((entry) => entry.wgsl.includes(`fn ${entryPoint}(`));
      const entry = matched[0];
      if (matched.length !== 1 || entry === undefined)
        throw new Error(`expected one published ${entryPoint} kernel`);
      return entry.wgsl;
    };
    const transportPublication = [...shaders.materialShaderManifestEntries()].find(
      (entry) => entry.identifier === 'forgeax::engine-ray-path-tracer',
    );
    const transportSource = transportPublication?.variants.find(
      (variant) => variant.defines.DIRECT_DFG_LUT_AVAILABLE === false,
    )?.composedWgsl;
    if (transportSource === undefined)
      throw new Error('reference diffuse GI requires the published fit path-tracer variant');
    const transportLutSource = transportPublication?.variants.find(
      (variant) => variant.defines.DIRECT_DFG_LUT_AVAILABLE === true,
    )?.composedWgsl;
    const rasterSource = source('generateRasterRays');
    const compositeSource = source('fs_ray_diffuse');
    const owned: Buffer[] = [];
    const textures: TexturePreparation[] = [];
    let transport: RayPathTracer | undefined;
    let reflectionTransport: RayPathTracer | undefined;
    const destroy = () => {
      transport?.dispose();
      reflectionTransport?.dispose();
      for (const buffer of owned) device.destroyBuffer(buffer);
      for (const texture of textures) void texture.release();
    };
    const buffer = (label: string, size: number, usage: number): Buffer => {
      const result = device.createBuffer({ label, size, usage }).unwrap();
      owned.push(result);
      return result;
    };
    try {
      const recordBytes = projected.surfaces.records.byteLength;
      const records = buffer('ray-diffuse.records', recordBytes, 128 | 8);
      const rays = buffer('ray-diffuse.initial-rays', pixelCount * RAY_PATH_STRIDE, 128 | 8);
      const sample = buffer('ray-diffuse.sample', 16, 64 | 8);
      device.queue.writeBuffer(records, 0, projected.surfaces.records).unwrap();
      for (const material of projected.materials) {
        const world = input.worlds[material.worldId];
        if (world === undefined) throw new Error('missing transport material World');
        const selected = material.snapshot.materialSurfacePrograms?.['ray-hit'];
        if (selected === undefined)
          return rayReferenceFailure('material has no accepted ray program').unwrap();
        const shader = shaders.findMaterialArtifact(selected.programKey).unwrap();
        textures.push(
          prepareSurfaceMaterialTextures(
            runtime.gpuStore,
            input.sampler,
            shader.paramSchema,
            world,
            material.snapshot,
          ).unwrap(),
        );
      }
      // Offscreen texture uploads can advance residency during synchronous
      // preparation. Capture that settled epoch before the first asynchronous compile.
      this.#key = this.#signature();
      const rasterModule = (
        await compile(device, { label: 'ray-diffuse.generate', code: rasterSource })
      ).unwrap();
      const compositeModule = (
        await compile(device, { label: 'ray-diffuse.composite', code: compositeSource })
      ).unwrap();
      const generate = createRasterRayGenerator(device, rasterModule).unwrap();
      const composite = createRayDiffuseComposite(
        device,
        compositeModule,
        profile.reconstruction === undefined ? 'raw' : 'reconstructed',
      ).unwrap();
      const transportFor = async (rayBuffer: Buffer, seed: number) =>
        (
          await createSubmittedRayPathTracer(device, compile, {
            kernel: transportSource,
            ...(transportLutSource === undefined ? {} : { kernelLut: transportLutSource }),
            deviceScope: runtime.deviceScope,
            scene: projected.scene,
            shaders,
            lights: input.lights,
            settings: { ...profile, seed, width, height, rayBuffer },
            generationFence: fence,
            materials: projected.materials.map((material, id) => ({
              id,
              snapshot: material.snapshot,
            })),
            resolveTexture: (id, parameter) => {
              const value = textures[id]?.textures.get(parameter);
              if (value === undefined)
                throw new Error(`missing accepted texture ${id}:${parameter}`);
              return ok(value);
            },
          })
        ).unwrap();
      transport = await transportFor(rays, profile.seed);
      const lifetime = new ResidencyLifetime(destroy);
      let samples = 0;
      const reconstruction =
        profile.reconstruction === undefined
          ? undefined
          : prepareRendererDiffuseReconstruction(
              device,
              (
                await compile(device, {
                  label: 'ray-diffuse.reconstruct',
                  code: source('reconstructDiffuse'),
                })
              ).unwrap(),
              pixelCount,
              profile.reconstruction,
              buffer,
              () => samples,
            );
      const reflectionProfile = profile.reflections;
      const reflections =
        reflectionProfile === undefined
          ? undefined
          : await prepareRayReflections({
              device,
              profile: { ...profile, reflections: reflectionProfile },
              pixelCount,
              compile: async (label, entryPoint) =>
                (await compile(device, { label, code: source(entryPoint) })).unwrap(),
              allocate: buffer,
              transport: async (rayBuffer, seed) => {
                reflectionTransport = await transportFor(rayBuffer, seed);
                return reflectionTransport;
              },
              submittedSamples: () => samples,
            });
      return {
        generation: fence.capturedGeneration,
        fence,
        pixelCount,
        records,
        recordBytes,
        rays,
        sample,
        textures,
        transport,
        generate,
        composite,
        ...(reconstruction === undefined ? {} : { reconstruction }),
        ...(reflections === undefined ? {} : { reflections }),
        writeSample: () =>
          device.queue
            .writeBuffer(sample, 0, new Uint32Array([profile.seed, samples, 0, 0]))
            .unwrap(),
        track: (completed) => {
          lifetime.track(completed);
          for (const texture of textures) texture.track(completed);
        },
        commit: () => {
          reconstruction?.commit();
          reflections?.reconstruction?.commit();
          samples++;
          if (this.#ready?.generation === fence.capturedGeneration) this.#submitted++;
        },
        retire: () => lifetime.retire(),
      };
    } catch (cause) {
      destroy();
      throw cause;
    }
  }

  disable(): void {
    if (this.#input === undefined) return;
    this.#generation++;
    this.#ready?.retire();
    this.#ready = undefined;
    this.#input = undefined;
    this.#key = '';
    this.#error = undefined;
    this.#submitted = 0;
  }

  dispose(): void {
    this.#disposed = true;
    this.disable();
  }
}
