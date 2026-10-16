import type { NativeCooker } from '@forgeax/engine-pack/native-cooker';
import type { RhiDevice, RhiError, ShaderModule } from '@forgeax/engine-rhi';
import { directDfgLutBytes } from '@forgeax/engine-shader';
import { err, ok, type Result } from '@forgeax/engine-types';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { DeviceScope } from '../device/device-scope';
import { materialUsesDirectDfgLut } from '../device/direct-dfg-lut';
import type { LightSnapshot } from '../render-system-extract';
import { RAY_ATTRIBUTE_TRIANGLE_STRIDE, type RaySurfaceScene } from './attributes';
import {
  encodeIrradianceVolume,
  IRRADIANCE_VOLUME_ARTIFACT,
  IRRADIANCE_VOLUME_FORMAT,
  IRRADIANCE_VOLUME_KIND,
  IRRADIANCE_VOLUME_MEDIA_TYPE,
  type IrradianceVolumeContent,
  type IrradianceVolumeError,
  type IrradianceVolumeLattice,
  integrateIrradianceProbes,
  irradianceProbePosition,
  irradianceVolumeDigest,
  sphericalFibonacci,
  validateIrradianceLattice,
} from './irradiance-volume';
import type { ResolveSurfaceTexture } from './material-bindings';
import type { RayPathInitialRay } from './path-input';
import { createRayPathTracer, RAY_ACCUMULATION_STRIDE, type RayPathMaterial } from './path-tracer';
import { RAY_TRIANGLE_STRIDE } from './scene';

type CompileShader = (
  device: RhiDevice,
  desc: { code: string; label?: string },
) => Promise<Result<ShaderModule, RhiError>>;

/** Rays one path-tracer dispatch admits. */
const BAKE_BATCH_RAYS = 262144;
const NONE = 0xffffffff;

export interface IrradianceBakeSettings {
  /** Spherical Fibonacci directions per probe. */
  readonly raysPerProbe: number;
  /** Converged paths per direction. */
  readonly samples: number;
  /** Path vertices after the probe's first hit, the reference integrator's bounce budget. */
  readonly maxBounces?: number;
  readonly seed: number;
  readonly environment: readonly [number, number, number];
  readonly maxDistance: number;
}

/** Everything the bake reads; its canonical digest is the volume's input fingerprint. */
export interface IrradianceBakeInput {
  /** Reference path-tracer WGSL (`forgeax_ray::path_tracer`), compiled at build time. */
  readonly kernel: string;
  /** Build-time LUT kernel variant for explicitly opted-in materials. */
  readonly kernelLut?: string;
  readonly scene: RaySurfaceScene;
  readonly materials: readonly RayPathMaterial[];
  readonly lights: readonly LightSnapshot[];
  readonly resolveTexture?: ResolveSurfaceTexture;
  readonly lattice: IrradianceVolumeLattice;
  readonly settings: IrradianceBakeSettings;
}

export interface IrradianceBakeResult {
  readonly volume: IrradianceVolumeContent;
  readonly bytes: Uint8Array;
  readonly digest: string;
  readonly fingerprint: string;
  readonly rays: number;
  readonly batches: number;
}

type BakeFailure = IrradianceVolumeError | { readonly code: string; readonly expected: string };

const sum = (h: ReturnType<typeof sha256.create>, text: string) =>
  h.update(new TextEncoder().encode(`${text}\u0000`));

/**
 * Canonical build key of a bake: geometry bytes, material identities and
 * values, lights, lattice, settings, kernel source and the volume format. Equal
 * inputs give equal keys; any change in what the bake reads changes the key.
 */
export function irradianceBakeFingerprint(input: IrradianceBakeInput): string {
  const h = sha256.create();
  sum(h, `${IRRADIANCE_VOLUME_KIND}:${IRRADIANCE_VOLUME_FORMAT}`);
  const usesLut = input.materials.some((material) =>
    materialUsesDirectDfgLut(material.program.paramSchema),
  );
  sum(h, usesLut ? (input.kernelLut ?? 'missing-direct-dfg-lut-kernel') : input.kernel);
  if (usesLut) h.update(directDfgLutBytes());
  h.update(input.scene.triangles);
  h.update(input.scene.nodes);
  h.update(input.scene.attributes);
  for (const material of input.materials)
    sum(h, `${material.id}|${material.program.contract}|${stableJson(material.asset)}`);
  for (const light of input.lights) sum(h, stableJson(light));
  sum(h, stableJson(input.lattice));
  sum(h, stableJson({ maxBounces: 7, ...input.settings }));
  return `sha256:${bytesToHex(h.digest())}`;
}

function stableJson(value: unknown): string {
  if (ArrayBuffer.isView(value)) return `[${Array.from(value as unknown as ArrayLike<number>)}]`;
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** (instanceId, primitive) -> outward shading normal of the triangle, from the attribute rows. */
function outwardNormals(scene: RaySurfaceScene): Map<string, readonly [number, number, number]> {
  const rows = new DataView(scene.triangles.buffer, scene.triangles.byteOffset);
  const attrs = new DataView(scene.attributes.buffer, scene.attributes.byteOffset);
  const out = new Map<string, readonly [number, number, number]>();
  for (let t = 0; t < scene.triangleCount; t++) {
    const key = `${rows.getUint32(t * RAY_TRIANGLE_STRIDE + 48, true)}:${rows.getUint32(t * RAY_TRIANGLE_STRIDE + 56, true)}`;
    const n = [0, 0, 0];
    for (let corner = 0; corner < 3; corner++)
      for (let axis = 0; axis < 3; axis++)
        n[axis] =
          (n[axis] ?? 0) +
          attrs.getFloat32(t * RAY_ATTRIBUTE_TRIANGLE_STRIDE + corner * 128 + 96 + axis * 4, true);
    out.set(key, [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0]);
  }
  return out;
}

/**
 * Bake the probe lattice with the exact reference path integrator: every probe
 * traces the same spherical Fibonacci directions through `samples` converged
 * paths of `maxBounces` vertices, and the CPU integrates them into the
 * field's D = E / pi octahedral maps, distance moments and validity. Build-time
 * only; a Renderer never runs this.
 */
export async function bakeIrradianceVolume(
  device: RhiDevice,
  compile: CompileShader,
  input: IrradianceBakeInput,
): Promise<Result<IrradianceBakeResult, BakeFailure>> {
  const counted = validateIrradianceLattice(input.lattice);
  if (!counted.ok) return counted;
  const { raysPerProbe, samples, seed } = input.settings;
  if (
    !Number.isInteger(raysPerProbe) ||
    raysPerProbe < 16 ||
    raysPerProbe > BAKE_BATCH_RAYS ||
    !Number.isInteger(samples) ||
    samples < 1
  )
    return err({
      code: 'irradiance-volume-invalid-rays',
      expected: 'integer raysPerProbe in 16..262144 and samples >= 1',
      hint: 'pick bake settings within the reference integrator budget',
      detail: { reason: `raysPerProbe ${raysPerProbe}, samples ${samples}` },
    });
  const scope = DeviceScope.create(0, 'irradiance-bake');
  try {
    const probeCount = counted.value;
    const directions = sphericalFibonacci(raysPerProbe);
    const total = probeCount * raysPerProbe;
    const radiance = new Float32Array(total * 3);
    const distance = new Float32Array(total);
    const status = new Uint8Array(total);
    const normals = outwardNormals(input.scene);
    const spread = Math.sqrt((4 * Math.PI) / raysPerProbe);
    const probesPerBatch = Math.max(1, Math.floor(BAKE_BATCH_RAYS / raysPerProbe));
    let batches = 0;
    for (let first = 0; first < probeCount; first += probesPerBatch, batches++) {
      const last = Math.min(probeCount, first + probesPerBatch);
      const rays: RayPathInitialRay[] = [];
      for (let probe = first; probe < last; probe++) {
        const origin = irradianceProbePosition(input.lattice, probe);
        for (let r = 0; r < raysPerProbe; r++)
          rays.push({
            origin,
            direction: [
              directions[r * 3] ?? 0,
              directions[r * 3 + 1] ?? 0,
              directions[r * 3 + 2] ?? 1,
            ],
            coneWidth: 0,
            coneSpread: spread,
            active: true,
          });
      }
      const trace = async (
        faces: 'material' | 'both',
        environment: readonly [number, number, number],
        maxBounces: number,
        count: number,
      ): Promise<Result<Float32Array, BakeFailure>> => {
        const tracer = await createRayPathTracer(device, compile, {
          kernel: input.kernel,
          ...(input.kernelLut === undefined ? {} : { kernelLut: input.kernelLut }),
          deviceScope: scope,
          scene: input.scene,
          materials: input.materials,
          faces,
          lights: input.lights,
          ...(input.resolveTexture === undefined ? {} : { resolveTexture: input.resolveTexture }),
          settings: {
            width: rays.length,
            height: 1,
            rays,
            maxBounces,
            seed: (seed + batches * 0x9e3779b9) >>> 0,
            environment,
            maxDistance: input.settings.maxDistance,
            receiver: 'full',
          },
        });
        if (!tracer.ok) return tracer;
        const read = await traceBatch(device, tracer.value, count, rays.length);
        tracer.value.dispose();
        return read;
      };
      const read = await trace(
        'material',
        input.settings.environment,
        input.settings.maxBounces ?? 7,
        samples,
      );
      if (!read.ok) return read;
      // Radiance honours each material's culling exactly like the reference; the
      // first-hit geometry (validity, distance) is two-sided like the live field,
      // so a probe inside a closed mesh sees its back faces instead of escaping.
      const seen = await trace('both', [0, 0, 0], 1, 1);
      if (!seen.ok) return seen;
      const f = read.value;
      const g = seen.value;
      const u = new Uint32Array(g.buffer);
      for (let i = 0; i < rays.length; i++) {
        const ray = first * raysPerProbe + i;
        const row = i * (RAY_ACCUMULATION_STRIDE / 4);
        const instance = u[row + 16] ?? NONE;
        if (instance === NONE) {
          status[ray] = 0;
          radiance.set([f[row] ?? 0, f[row + 1] ?? 0, f[row + 2] ?? 0], ray * 3);
          distance[ray] = -1;
          continue;
        }
        const n = normals.get(`${instance}:${u[row + 18] ?? 0}`);
        const r = i % raysPerProbe;
        const facing =
          n === undefined
            ? -1
            : n[0] * (directions[r * 3] ?? 0) +
              n[1] * (directions[r * 3 + 1] ?? 0) +
              n[2] * (directions[r * 3 + 2] ?? 0);
        distance[ray] = g[row + 15] ?? 0;
        if (facing > 0) status[ray] = 2;
        else {
          status[ray] = 1;
          radiance.set([f[row] ?? 0, f[row + 1] ?? 0, f[row + 2] ?? 0], ray * 3);
        }
      }
    }
    const volume = integrateIrradianceProbes(input.lattice, {
      directions,
      radiance,
      distance,
      status,
    });
    if (!volume.ok) return volume;
    const bytes = encodeIrradianceVolume(volume.value);
    if (!bytes.ok) return bytes;
    return ok({
      volume: volume.value,
      bytes: bytes.value,
      digest: irradianceVolumeDigest(bytes.value),
      fingerprint: irradianceBakeFingerprint(input),
      rays: total,
      batches,
    });
  } finally {
    scope.dispose();
  }
}

async function traceBatch(
  device: RhiDevice,
  tracer: Awaited<ReturnType<typeof createRayPathTracer>> extends Result<infer T, unknown>
    ? T
    : never,
  samples: number,
  rays: number,
): Promise<Result<Float32Array, BakeFailure>> {
  // Bound one native submission to one complete path sample. Deep MASK paths
  // can lose the device when many samples share an encoder; this changes only
  // submission cadence, not the requested sample or bounce budget.
  for (let sample = 0; sample < samples; sample++) {
    const encoder = device.createCommandEncoder({});
    if (!encoder.ok) return encoder;
    const recorded = tracer.recordSample(encoder.value);
    if (!recorded.ok) return recorded;
    const finished = encoder.value.finish();
    if (!finished.ok) return finished;
    const submitted = device.queue.submit([finished.value]);
    if (!submitted.ok) return submitted;
    await device.queue.onSubmittedWorkDone();
  }
  const size = rays * RAY_ACCUMULATION_STRIDE;
  const staging = device.createBuffer({ size, usage: 9 });
  if (!staging.ok) return staging;
  try {
    const encoder = device.createCommandEncoder({});
    if (!encoder.ok) return encoder;
    encoder.value.copyBufferToBuffer(tracer.buffers.accumulation, 0, staging.value, 0, size);
    const finished = encoder.value.finish();
    if (!finished.ok) return finished;
    const submitted = device.queue.submit([finished.value]);
    if (!submitted.ok) return submitted;
    const mapped = await staging.value.mapAsync(1);
    if (!mapped.ok) return mapped;
    const range = mapped.value.getMappedRange();
    if (!range.ok) return range;
    const out = new Float32Array(range.value.slice(0));
    mapped.value.unmap();
    return ok(out);
  } finally {
    device.destroyBuffer(staging.value);
  }
}

/** Cook input: the bake request plus the existing volume GUID it publishes under. */
export interface IrradianceVolumeCookInput extends IrradianceBakeInput {
  readonly guid: string;
  readonly device: RhiDevice;
  readonly compile: CompileShader;
}

export interface IrradianceVolumeCookPayload {
  readonly artifact: typeof IRRADIANCE_VOLUME_ARTIFACT;
  readonly digest: string;
  readonly dimensions: readonly [number, number, number];
}

/**
 * Explicit build-time producer of an `irradiance-volume` asset. The GUID is
 * caller-owned author identity (a rebake keeps it); the bake fingerprint is the
 * cook's input fingerprint. A failed bake throws so the transaction keeps its
 * last-known-good volume.
 */
export function createIrradianceVolumeCooker(): NativeCooker<
  IrradianceVolumeCookPayload,
  IrradianceVolumeCookInput
> {
  return {
    key: IRRADIANCE_VOLUME_KIND,
    async cook(input) {
      if (!input.guid) throw new TypeError('irradiance volume bake requires its volume GUID');
      const baked = await bakeIrradianceVolume(input.device, input.compile, input);
      if (!baked.ok) throw new TypeError(`${baked.error.code}: ${JSON.stringify(baked.error)}`);
      return {
        guid: input.guid,
        payload: {
          artifact: IRRADIANCE_VOLUME_ARTIFACT,
          digest: baked.value.digest,
          dimensions: baked.value.volume.dimensions,
        },
        refs: [],
        artifacts: {
          [IRRADIANCE_VOLUME_ARTIFACT]: {
            mediaType: IRRADIANCE_VOLUME_MEDIA_TYPE,
            bytes: baked.value.bytes,
          },
        },
        inputFingerprint: baked.value.fingerprint,
      };
    },
  };
}
