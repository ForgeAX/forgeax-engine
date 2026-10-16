import type { Buffer, RhiDevice, ShaderModule } from '@forgeax/engine-rhi';
import type { StandardExactDiffuseGi, StandardLiteReflections } from '../pipeline/standard-profile';
import type { RayPathTracer } from './path-tracer';
import { RAY_PATH_STRIDE } from './path-tracer';
import { createRasterRayGenerator } from './raster-source';
import { createRayReflectionComposite } from './reflections-composite';
import {
  prepareRendererDiffuseReconstruction,
  type RendererDiffuseReconstruction,
} from './renderer-diffuse-reconstruction';

/** Decorrelates the reflection lane's bounce sequence from the diffuse lane's. */
const REFLECTION_SEED_SALT = 0x9e3779b9;

/** The reflection lane of one exact GI preparation: its own receiver rays, a second
 * transport over the same scene/material snapshot, optional denoise and composite. */
export interface PreparedRayReflections {
  readonly settings: StandardLiteReflections;
  readonly rays: Buffer;
  readonly sample: Buffer;
  readonly transport: RayPathTracer;
  readonly generate: Extract<ReturnType<typeof createRasterRayGenerator>, { ok: true }>['value'];
  readonly composite: Extract<
    ReturnType<typeof createRayReflectionComposite>,
    { ok: true }
  >['value'];
  readonly reconstruction?: RendererDiffuseReconstruction;
  writeSample(): void;
}

export interface RayReflectionPreparationInputs {
  readonly device: RhiDevice;
  readonly profile: StandardExactDiffuseGi & { readonly reflections: StandardLiteReflections };
  readonly pixelCount: number;
  readonly compile: (label: string, entryPoint: string) => Promise<ShaderModule>;
  readonly allocate: (label: string, bytes: number, usage: number) => Buffer;
  /** Build a transport over the caller's frozen snapshot with these initial rays/seed. */
  readonly transport: (rays: Buffer, seed: number) => Promise<RayPathTracer>;
  readonly submittedSamples: () => number;
}

export async function prepareRayReflections(
  input: RayReflectionPreparationInputs,
): Promise<PreparedRayReflections> {
  const { device, profile, pixelCount, allocate } = input;
  const settings = profile.reflections;
  const rays = allocate('ray-reflection.initial-rays', pixelCount * RAY_PATH_STRIDE, 128 | 8);
  const sample = allocate('ray-reflection.sample', 16, 64 | 8);
  const generate = createRasterRayGenerator(
    device,
    await input.compile('ray-reflection.generate', 'generateReflectionRays'),
    'generateReflectionRays',
  ).unwrap();
  const composite = createRayReflectionComposite(
    device,
    await input.compile('ray-reflection.composite', 'fs_ray_reflection'),
    profile.reconstruction === undefined ? 'raw' : 'reconstructed',
  ).unwrap();
  const seed = (profile.seed ^ REFLECTION_SEED_SALT) >>> 0;
  const reconstruction =
    profile.reconstruction === undefined
      ? undefined
      : prepareRendererDiffuseReconstruction(
          device,
          await input.compile('ray-reflection.reconstruct', 'reconstructDiffuse'),
          pixelCount,
          profile.reconstruction,
          allocate,
          input.submittedSamples,
          'ray-reflection',
        );
  const transport = await input.transport(rays, seed);
  const words = new Uint32Array(4);
  const limits = new Float32Array(words.buffer, 8, 2);
  limits.set([settings.maxRoughnessToTrace, settings.roughnessFadeLength]);
  return {
    settings,
    rays,
    sample,
    transport,
    generate,
    composite,
    ...(reconstruction === undefined ? {} : { reconstruction }),
    writeSample: () => {
      words[0] = seed;
      words[1] = input.submittedSamples();
      device.queue.writeBuffer(sample, 0, words).unwrap();
    },
  };
}
