import type { LoaderRegistry } from '@forgeax/engine-assets-runtime';
import { err, ok, type Result } from '@forgeax/engine-types';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  IRRADIANCE_FIELD_MAX_PROBES,
  IRRADIANCE_FIELD_OCT,
  IRRADIANCE_FIELD_PROBE_STRIDE,
  IRRADIANCE_FIELD_TEXELS,
} from './irradiance-field-plan';

/** Pack asset kind of a baked irradiance volume. */
export const IRRADIANCE_VOLUME_KIND = 'irradiance-volume';
/** Artifact name holding the encoded volume inside the asset. */
export const IRRADIANCE_VOLUME_ARTIFACT = 'volume';
export const IRRADIANCE_VOLUME_MEDIA_TYPE = 'application/x-forgeax-irradiance-volume';
/** Binary layout version; a change makes every cooked volume rebake. */
export const IRRADIANCE_VOLUME_FORMAT = 1;
const MAGIC = 0x56495846; // 'FXIV'
const HEADER_BYTES = 64;

export type IrradianceVolumeErrorCode =
  | 'irradiance-volume-invalid-lattice'
  | 'irradiance-volume-invalid-rays'
  | 'irradiance-volume-corrupt';

export interface IrradianceVolumeError {
  readonly code: IrradianceVolumeErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly reason: string };
}

const EXPECTED: Record<IrradianceVolumeErrorCode, readonly [string, string]> = {
  'irradiance-volume-invalid-lattice': [
    `a finite lattice origin, a positive f32 spacing and 1..${IRRADIANCE_FIELD_MAX_PROBES} probes`,
    'derive the lattice from the irradiance-field plan of the baked region',
  ],
  'irradiance-volume-invalid-rays': [
    'one direction, radiance, distance and status per probe ray',
    'pass the traced ray records in probe-major order with matching lengths',
  ],
  'irradiance-volume-corrupt': [
    `a format-${IRRADIANCE_VOLUME_FORMAT} irradiance volume with finite nonnegative probes`,
    'rebake the volume through its NativeCooker; never patch the cooked bytes',
  ],
};

function failure(
  code: IrradianceVolumeErrorCode,
  reason: string,
): Result<never, IrradianceVolumeError> {
  const [expected, hint] = EXPECTED[code];
  return err({ code, expected, hint, detail: { reason } });
}

/** One fixed probe lattice: cell `c` sits at `origin + c * spacing`. */
export interface IrradianceVolumeLattice {
  readonly origin: readonly [number, number, number];
  readonly spacing: number;
  readonly dimensions: readonly [number, number, number];
}

/** Decoded volume in the irradiance-field probe vocabulary (D = E / pi). */
export interface IrradianceVolume extends IrradianceVolumeLattice {
  readonly probeCount: number;
  /** Per probe 64 x rgba: the 8x8 octahedral D map; w = 1 where any live ray contributed. */
  readonly irradiance: Float32Array;
  /** Per probe 64 x (mean, mean^2) of the ray distance clamped to `2 * spacing`. */
  readonly moments: Float32Array;
  /** Per probe [updates, valid, backfaces, traced], the live field's meta record. */
  readonly meta: Uint32Array;
  /** `sha256:` digest of the encoded artifact bytes. */
  readonly digest: string;
}

export type IrradianceVolumeContent = Omit<IrradianceVolume, 'digest'>;

/** Ray records of one bake, probe-major: `raysPerProbe` rays per probe. */
export interface IrradianceProbeRays {
  /** Unit directions shared by every probe, `raysPerProbe * 3`. */
  readonly directions: Float32Array;
  /** Mean incoming radiance per ray, `rays * 3`. */
  readonly radiance: Float32Array;
  /** Hit distance per ray; any negative value is a miss. */
  readonly distance: Float32Array;
  /** `IrradianceFieldRayStatus`: 0 miss, 1 hit, 2 backface, 3 skip. */
  readonly status: Uint8Array;
}

const finite32 = (value: number) => Number.isFinite(value) && Number.isFinite(Math.fround(value));

export function validateIrradianceLattice(
  lattice: IrradianceVolumeLattice,
): Result<number, IrradianceVolumeError> {
  const { origin, spacing, dimensions } = lattice;
  if (
    !Array.isArray(origin) ||
    origin.length !== 3 ||
    !origin.every(finite32) ||
    !finite32(spacing) ||
    !(Math.fround(spacing) > 0) ||
    !Array.isArray(dimensions) ||
    dimensions.length !== 3 ||
    !dimensions.every((n) => Number.isInteger(n) && n >= 1)
  )
    return failure('irradiance-volume-invalid-lattice', 'malformed origin, spacing or dimensions');
  const count = dimensions[0] * dimensions[1] * dimensions[2];
  if (count > IRRADIANCE_FIELD_MAX_PROBES)
    return failure('irradiance-volume-invalid-lattice', `${count} probes exceed the field limit`);
  return ok(count);
}

/** World position of probe `index` (x fastest), matching the sample shader. */
export function irradianceProbePosition(
  lattice: IrradianceVolumeLattice,
  index: number,
): readonly [number, number, number] {
  const [dx, dy] = lattice.dimensions;
  const cell = [index % dx, Math.floor(index / dx) % dy, Math.floor(index / (dx * dy))] as const;
  return [
    lattice.origin[0] + cell[0] * lattice.spacing,
    lattice.origin[1] + cell[1] * lattice.spacing,
    lattice.origin[2] + cell[2] * lattice.spacing,
  ];
}

/** Deterministic spherical Fibonacci directions (unit, f32-rounded). */
export function sphericalFibonacci(count: number): Float32Array {
  const out = new Float32Array(count * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const z = 1 - (2 * i + 1) / count;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const phi = golden * i;
    out.set([r * Math.cos(phi), r * Math.sin(phi), z], i * 3);
  }
  return out;
}

/** The unit direction of each 8x8 octahedral texel, folded exactly like the
 * GPU `octSurface` so the sampler's bilinear taps address the same lobes. */
export const IRRADIANCE_OCT_DIRECTIONS: Float32Array = (() => {
  const out = new Float32Array(IRRADIANCE_FIELD_TEXELS * 3);
  for (let texel = 0; texel < IRRADIANCE_FIELD_TEXELS; texel++) {
    const x = (((texel % IRRADIANCE_FIELD_OCT) + 0.5) / IRRADIANCE_FIELD_OCT) * 2 - 1;
    const y = ((Math.floor(texel / IRRADIANCE_FIELD_OCT) + 0.5) / IRRADIANCE_FIELD_OCT) * 2 - 1;
    const z = 1 - Math.abs(x) - Math.abs(y);
    const fold = (a: number, b: number) => (z < 0 ? (1 - Math.abs(b)) * (a >= 0 ? 1 : -1) : a);
    const v = [fold(x, y), fold(y, x), z];
    const length = Math.hypot(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0);
    out.set(
      v.map((c) => c / length),
      texel * 3,
    );
  }
  return out;
})();

/**
 * Integrate traced probe rays into the field's probe records.
 *
 * Irradiance texels use the cosine ratio estimator over every live ray,
 * sum(L max(cos, 0)) / sum(max(cos, 0)) = E / pi for equal-solid-angle
 * directions; the live field instead splats into the radiance level first and
 * re-derives, which a converged bake has no reason to approximate. Moments use
 * the live field's cos^16 splat, and probe validity its backface rule.
 */
export function integrateIrradianceProbes(
  lattice: IrradianceVolumeLattice,
  rays: IrradianceProbeRays,
): Result<IrradianceVolumeContent, IrradianceVolumeError> {
  const counted = validateIrradianceLattice(lattice);
  if (!counted.ok) return counted;
  const probeCount = counted.value;
  const perProbe = rays.directions.length / 3;
  const total = probeCount * perProbe;
  if (
    !Number.isInteger(perProbe) ||
    perProbe < 1 ||
    rays.radiance.length !== total * 3 ||
    rays.distance.length !== total ||
    rays.status.length !== total
  )
    return failure(
      'irradiance-volume-invalid-rays',
      `expected ${total} rays for ${probeCount} probes x ${perProbe} directions`,
    );
  const clamp = 2 * Math.fround(lattice.spacing);
  const irradiance = new Float32Array(probeCount * IRRADIANCE_FIELD_TEXELS * 4);
  const moments = new Float32Array(probeCount * IRRADIANCE_FIELD_TEXELS * 2);
  const meta = new Uint32Array(probeCount * 4);
  const e = new Float64Array(IRRADIANCE_FIELD_TEXELS * 4);
  const m = new Float64Array(IRRADIANCE_FIELD_TEXELS * 3);
  const dirs = rays.directions;
  const oct = IRRADIANCE_OCT_DIRECTIONS;
  for (let probe = 0; probe < probeCount; probe++) {
    e.fill(0);
    m.fill(0);
    let traced = 0;
    let backfaces = 0;
    for (let r = 0; r < perProbe; r++) {
      const ray = probe * perProbe + r;
      const status = rays.status[ray] ?? 3;
      if (status !== 3) traced++;
      if (status === 2) backfaces++;
      if (status > 1) continue;
      const dx = dirs[r * 3] ?? 0;
      const dy = dirs[r * 3 + 1] ?? 0;
      const dz = dirs[r * 3 + 2] ?? 0;
      const lr = rays.radiance[ray * 3] ?? 0;
      const lg = rays.radiance[ray * 3 + 1] ?? 0;
      const lb = rays.radiance[ray * 3 + 2] ?? 0;
      const hit = rays.distance[ray] ?? -1;
      const d = Math.min(status === 1 && hit >= 0 ? hit : clamp, clamp);
      for (let t = 0; t < IRRADIANCE_FIELD_TEXELS; t++) {
        const c = Math.max(
          (oct[t * 3] ?? 0) * dx + (oct[t * 3 + 1] ?? 0) * dy + (oct[t * 3 + 2] ?? 0) * dz,
          0,
        );
        if (c === 0) continue;
        e[t * 4] = (e[t * 4] ?? 0) + lr * c;
        e[t * 4 + 1] = (e[t * 4 + 1] ?? 0) + lg * c;
        e[t * 4 + 2] = (e[t * 4 + 2] ?? 0) + lb * c;
        e[t * 4 + 3] = (e[t * 4 + 3] ?? 0) + c;
        const c2 = c * c;
        const c4 = c2 * c2;
        const c8 = c4 * c4;
        const w = c8 * c8;
        m[t * 3] = (m[t * 3] ?? 0) + d * w;
        m[t * 3 + 1] = (m[t * 3 + 1] ?? 0) + d * d * w;
        m[t * 3 + 2] = (m[t * 3 + 2] ?? 0) + w;
      }
    }
    for (let t = 0; t < IRRADIANCE_FIELD_TEXELS; t++) {
      const weight = e[t * 4 + 3] ?? 0;
      const texel = (probe * IRRADIANCE_FIELD_TEXELS + t) * 4;
      if (weight > 0)
        irradiance.set(
          [(e[t * 4] ?? 0) / weight, (e[t * 4 + 1] ?? 0) / weight, (e[t * 4 + 2] ?? 0) / weight, 1],
          texel,
        );
      const mw = m[t * 3 + 2] ?? 0;
      if (mw > 0)
        moments.set(
          [(m[t * 3] ?? 0) / mw, (m[t * 3 + 1] ?? 0) / mw],
          (probe * IRRADIANCE_FIELD_TEXELS + t) * 2,
        );
    }
    const valid = traced > 0 && backfaces * 4 <= traced;
    meta.set([traced > 0 ? 1 : 0, valid ? 1 : 0, backfaces, traced], probe * 4);
  }
  return ok({
    origin: [...lattice.origin] as unknown as IrradianceVolume['origin'],
    spacing: Math.fround(lattice.spacing),
    dimensions: [...lattice.dimensions] as unknown as IrradianceVolume['dimensions'],
    probeCount,
    irradiance,
    moments,
    meta,
  });
}

export function irradianceVolumeDigest(bytes: Uint8Array): string {
  return `sha256:${bytesToHex(sha256(bytes))}`;
}

function sections(probeCount: number) {
  const irradiance = probeCount * IRRADIANCE_FIELD_TEXELS * 4 * 4;
  const moments = probeCount * IRRADIANCE_FIELD_TEXELS * 2 * 4;
  const meta = probeCount * 16;
  return { irradiance, moments, meta, total: HEADER_BYTES + irradiance + moments + meta };
}

/** Little-endian, self-describing and byte-deterministic: equal content, equal bytes. */
export function encodeIrradianceVolume(
  volume: IrradianceVolumeContent,
): Result<Uint8Array, IrradianceVolumeError> {
  const counted = validateIrradianceLattice(volume);
  if (!counted.ok) return counted;
  const size = sections(counted.value);
  if (
    counted.value !== volume.probeCount ||
    volume.irradiance.byteLength !== size.irradiance ||
    volume.moments.byteLength !== size.moments ||
    volume.meta.byteLength !== size.meta
  )
    return failure('irradiance-volume-corrupt', 'probe sections do not match the lattice');
  const bytes = new Uint8Array(size.total);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, IRRADIANCE_VOLUME_FORMAT, true);
  for (const [i, n] of volume.dimensions.entries()) view.setUint32(8 + i * 4, n, true);
  view.setUint32(20, volume.probeCount, true);
  for (const [i, v] of volume.origin.entries()) view.setFloat32(24 + i * 4, v, true);
  view.setFloat32(36, volume.spacing, true);
  let offset = HEADER_BYTES;
  for (const section of [volume.irradiance, volume.moments, volume.meta]) {
    const words = new Uint32Array(section.buffer, section.byteOffset, section.byteLength / 4);
    for (let i = 0; i < words.length; i++) view.setUint32(offset + i * 4, words[i] ?? 0, true);
    offset += section.byteLength;
  }
  return ok(bytes);
}

export function decodeIrradianceVolume(
  bytes: Uint8Array,
): Result<IrradianceVolume, IrradianceVolumeError> {
  if (bytes.byteLength < HEADER_BYTES)
    return failure('irradiance-volume-corrupt', 'truncated header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC)
    return failure('irradiance-volume-corrupt', 'not an irradiance volume');
  const format = view.getUint32(4, true);
  if (format !== IRRADIANCE_VOLUME_FORMAT)
    return failure(
      'irradiance-volume-corrupt',
      `format ${format} is not ${IRRADIANCE_VOLUME_FORMAT}`,
    );
  const dimensions = [0, 1, 2].map((i) => view.getUint32(8 + i * 4, true)) as unknown as [
    number,
    number,
    number,
  ];
  const origin = [0, 1, 2].map((i) => view.getFloat32(24 + i * 4, true)) as unknown as [
    number,
    number,
    number,
  ];
  const spacing = view.getFloat32(36, true);
  const counted = validateIrradianceLattice({ origin, spacing, dimensions });
  if (!counted.ok) return failure('irradiance-volume-corrupt', counted.error.detail.reason);
  const probeCount = view.getUint32(20, true);
  const size = sections(probeCount);
  if (probeCount !== counted.value || bytes.byteLength !== size.total)
    return failure('irradiance-volume-corrupt', 'byte length does not match the lattice');
  const read = (offset: number, length: number) => {
    const words = new Uint32Array(length / 4);
    for (let i = 0; i < words.length; i++) words[i] = view.getUint32(offset + i * 4, true);
    return words;
  };
  const irradiance = new Float32Array(read(HEADER_BYTES, size.irradiance).buffer);
  const moments = new Float32Array(read(HEADER_BYTES + size.irradiance, size.moments).buffer);
  const meta = read(HEADER_BYTES + size.irradiance + size.moments, size.meta);
  for (const value of irradiance)
    if (!(Number.isFinite(value) && value >= 0))
      return failure(
        'irradiance-volume-corrupt',
        'irradiance holds a negative or non-finite value',
      );
  for (const value of moments)
    if (!(Number.isFinite(value) && value >= 0))
      return failure('irradiance-volume-corrupt', 'moments hold a negative or non-finite value');
  return ok({
    origin,
    spacing,
    dimensions,
    probeCount,
    irradiance,
    moments,
    meta,
    digest: irradianceVolumeDigest(bytes),
  });
}

/** GPU probe blocks in the field's 144-texel stride; only the D level is baked. */
export function irradianceVolumeProbeBlocks(volume: IrradianceVolumeContent): Float32Array {
  const blocks = new Float32Array(volume.probeCount * IRRADIANCE_FIELD_PROBE_STRIDE * 4);
  const level = IRRADIANCE_FIELD_TEXELS * 4;
  for (let probe = 0; probe < volume.probeCount; probe++)
    blocks.set(
      volume.irradiance.subarray(probe * level, (probe + 1) * level),
      probe * IRRADIANCE_FIELD_PROBE_STRIDE * 4,
    );
  return blocks;
}

type PackLoader = Parameters<LoaderRegistry['registerPackLoader']>[0];

/** Runtime loader: decodes the cooked artifact into an {@link IrradianceVolume}. */
export const irradianceVolumePackLoader: PackLoader = {
  kind: IRRADIANCE_VOLUME_KIND,
  load(input) {
    const artifact = input.artifacts[IRRADIANCE_VOLUME_ARTIFACT];
    const decoded =
      artifact === undefined
        ? failure('irradiance-volume-corrupt', 'missing volume artifact')
        : decodeIrradianceVolume(artifact.bytes);
    return decoded.ok ? { ok: true, value: decoded.value } : { ok: false, error: decoded.error };
  },
};
