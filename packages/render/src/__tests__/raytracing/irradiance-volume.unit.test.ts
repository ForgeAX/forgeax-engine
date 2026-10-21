import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { freezeRenderProfile, validateRenderProfile } from '../../assembly/renderer-facade';
import {
  DEFAULT_STANDARD_PROFILE,
  type StandardBakedDiffuseGi,
  type StandardProfile,
} from '../../pipeline/standard-profile';
import { irradianceBakeFingerprint } from '../../raytracing/irradiance-bake';
import {
  IRRADIANCE_FIELD_MAX_PROBES,
  IRRADIANCE_FIELD_PROBE_STRIDE,
  IRRADIANCE_FIELD_TEXELS,
  validateDiffuseGi,
} from '../../raytracing/irradiance-field-plan';
import {
  decodeIrradianceVolume,
  encodeIrradianceVolume,
  IRRADIANCE_OCT_DIRECTIONS,
  IRRADIANCE_VOLUME_KIND,
  type IrradianceVolumeLattice,
  integrateIrradianceProbes,
  irradianceProbePosition,
  irradianceVolumeContribution,
  irradianceVolumeDigest,
  irradianceVolumeProbeBlocks,
  sphericalFibonacci,
  validateIrradianceLattice,
} from '../../raytracing/irradiance-volume';

const lattice: IrradianceVolumeLattice = {
  origin: [-1, 0, 2],
  spacing: 0.5,
  dimensions: [2, 3, 1],
};
const PER_PROBE = 4096;

function rays(radianceOf: (dz: number) => number, status = 0) {
  const directions = sphericalFibonacci(PER_PROBE);
  const total = 6 * PER_PROBE;
  const radiance = new Float32Array(total * 3);
  const distance = new Float32Array(total).fill(status === 0 ? -1 : 0.25);
  for (let ray = 0; ray < total; ray++)
    radiance.fill(radianceOf(directions[(ray % PER_PROBE) * 3 + 2] ?? 0), ray * 3, ray * 3 + 3);
  return { directions, radiance, distance, status: new Uint8Array(total).fill(status) };
}

function integrated(radianceOf: (dz: number) => number, status = 0) {
  return integrateIrradianceProbes(lattice, rays(radianceOf, status)).unwrap();
}

describe('irradiance volume integration', () => {
  it('reproduces a constant environment exactly (D = L) with clamped moments', () => {
    const volume = integrated(() => 0.75);
    expect(volume.probeCount).toBe(6);
    for (let t = 0; t < volume.probeCount * IRRADIANCE_FIELD_TEXELS; t++) {
      expect(volume.irradiance[t * 4]).toBeCloseTo(0.75, 5);
      expect(volume.irradiance[t * 4 + 3]).toBe(1);
      expect(volume.moments[t * 2]).toBeCloseTo(1, 5);
      expect(volume.moments[t * 2 + 1]).toBeCloseTo(1, 5);
    }
    expect([...volume.meta.subarray(0, 4)]).toEqual([1, 1, 0, PER_PROBE]);
  });

  it('applies the cosine lobe: an upper hemisphere sky lights +z texels, not -z', () => {
    const volume = integrated((dz) => (dz > 0 ? 1 : 0));
    const up = 3 * 8 + 3;
    expect(IRRADIANCE_OCT_DIRECTIONS[up * 3 + 2]).toBeGreaterThan(0.9);
    expect(IRRADIANCE_OCT_DIRECTIONS[2]).toBeLessThan(-0.9);
    expect(volume.irradiance[up * 4]).toBeGreaterThan(0.95);
    expect(volume.irradiance[0]).toBeLessThan(0.05);
  });

  it('records hit distances and marks backface-dominated probes invalid', () => {
    const hit = integrated(() => 1, 1);
    expect(hit.moments[0]).toBeCloseTo(0.25, 5);
    expect(hit.meta[1]).toBe(1);
    const inside = integrated(() => 1, 2);
    expect([...inside.meta.subarray(0, 4)]).toEqual([1, 0, PER_PROBE, PER_PROBE]);
    expect(inside.irradiance[3]).toBe(0);
  });

  it('rejects malformed lattices and ray records', () => {
    expect(validateIrradianceLattice({ ...lattice, spacing: 0 }).ok).toBe(false);
    expect(validateIrradianceLattice({ ...lattice, dimensions: [1, 1, 0] }).ok).toBe(false);
    expect(
      validateIrradianceLattice({ ...lattice, dimensions: [IRRADIANCE_FIELD_MAX_PROBES + 1, 1, 1] })
        .ok,
    ).toBe(false);
    const short = rays(() => 1);
    const bad = integrateIrradianceProbes(lattice, { ...short, status: short.status.subarray(1) });
    expect(!bad.ok && bad.error.code).toBe('irradiance-volume-invalid-rays');
  });

  it('places probes x-fastest from the lattice origin', () => {
    expect(irradianceProbePosition(lattice, 0)).toEqual([-1, 0, 2]);
    expect(irradianceProbePosition(lattice, 1)).toEqual([-0.5, 0, 2]);
    expect(irradianceProbePosition(lattice, 5)).toEqual([-0.5, 1, 2]);
  });
});

describe('irradiance volume codec', () => {
  const volume = integrated((dz) => 0.5 + 0.5 * dz);

  it('round-trips byte-identically with a stable digest', () => {
    const bytes = encodeIrradianceVolume(volume).unwrap();
    expect(encodeIrradianceVolume(integrated((dz) => 0.5 + 0.5 * dz)).unwrap()).toEqual(bytes);
    const decoded = decodeIrradianceVolume(bytes).unwrap();
    expect(decoded.digest).toBe(irradianceVolumeDigest(bytes));
    expect(decoded.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(decoded.irradiance).toEqual(volume.irradiance);
    expect(decoded.moments).toEqual(volume.moments);
    expect(decoded.meta).toEqual(volume.meta);
    expect(decoded.dimensions).toEqual(lattice.dimensions);
    expect(encodeIrradianceVolume(decoded).unwrap()).toEqual(bytes);
  });

  it('rejects corrupt bytes with one closed code', () => {
    const bytes = encodeIrradianceVolume(volume).unwrap();
    const magic = bytes.slice();
    magic[0] = 0;
    const nan = bytes.slice();
    new DataView(nan.buffer).setFloat32(64, Number.NaN, true);
    for (const corrupt of [magic, bytes.subarray(0, bytes.length - 4), bytes.subarray(0, 8), nan]) {
      const decoded = decodeIrradianceVolume(corrupt);
      expect(!decoded.ok && decoded.error.code).toBe('irradiance-volume-corrupt');
    }
  });

  it('decodes through the typed owner and fails structurally without the artifact', async () => {
    const bytes = encodeIrradianceVolume(volume).unwrap();
    expect(irradianceVolumeContribution.kind.kind).toBe(IRRADIANCE_VOLUME_KIND);
    const load = (artifacts: Record<string, { bytes: Uint8Array }>) =>
      irradianceVolumeContribution.decoder.decode({
        envelope: { guid: 'volume', artifacts },
        artifacts: { read: async (descriptor: { bytes: Uint8Array }) => ok(descriptor.bytes) },
        signal: new AbortController().signal,
      } as never);
    const loaded = (await load({ volume: { bytes } })) as {
      ok: boolean;
      value?: { digest: string };
    };
    expect(loaded.ok).toBe(true);
    expect(loaded.value?.digest).toBe(irradianceVolumeDigest(bytes));
    const missing = (await load({})) as { ok: boolean; error?: { code: string } };
    expect(missing.ok).toBe(false);
    expect(missing.error?.code).toBe('asset-package-invalid');
  });

  it('lays the D level into the field probe stride', () => {
    const blocks = irradianceVolumeProbeBlocks(volume);
    expect(blocks.length).toBe(volume.probeCount * IRRADIANCE_FIELD_PROBE_STRIDE * 4);
    const level = IRRADIANCE_FIELD_TEXELS * 4;
    expect(
      blocks.subarray(IRRADIANCE_FIELD_PROBE_STRIDE * 4, IRRADIANCE_FIELD_PROBE_STRIDE * 4 + level),
    ).toEqual(volume.irradiance.subarray(level, 2 * level));
  });
});

describe('baked diffuse GI profile', () => {
  const gi: StandardBakedDiffuseGi = {
    gather: 'baked',
    volume: '0f8c2a51-6b3d-4e7a-9c1f-2d4b6e8a0c13',
    resolution: 'half',
  };

  it('accepts one GUID and resolution, rejects everything else', () => {
    expect(validateDiffuseGi(gi).ok).toBe(true);
    expect(validateDiffuseGi({ ...gi, resolution: 'full' }).ok).toBe(true);
    expect(validateDiffuseGi({ ...gi, volume: 'not-a-guid' }).ok).toBe(false);
    expect(validateDiffuseGi({ ...gi, resolution: 'quarter' } as never).ok).toBe(false);
    expect(validateDiffuseGi({ ...gi, maxDistance: 10 } as never).ok).toBe(false);
  });

  it('validates and freezes inside a Standard profile', () => {
    const profile: StandardProfile = {
      ...DEFAULT_STANDARD_PROFILE,
      renderPath: 'deferred',
      ibl: false,
      diffuseGi: gi,
    };
    expect(validateRenderProfile(profile)).toBeUndefined();
    const frozen = freezeRenderProfile(profile).diffuseGi;
    expect(frozen).toEqual(gi);
    expect(Object.isFrozen(frozen)).toBe(true);
  });
});

describe('irradiance bake fingerprint', () => {
  const input = {
    kernel: 'fn main() {}',
    scene: {
      triangles: new Uint8Array([1, 2, 3]),
      nodes: new Uint8Array([4]),
      attributes: new Uint8Array([5]),
    },
    materials: [],
    lights: [],
    lattice,
    settings: { raysPerProbe: 64, samples: 4, seed: 7, environment: [0, 0, 0], maxDistance: 10 },
  } as never;

  it('is stable for equal inputs and changes with any read input', () => {
    const base = irradianceBakeFingerprint(input);
    expect(base).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(irradianceBakeFingerprint(structuredClone(input))).toBe(base);
    const settings = (input as { settings: object }).settings;
    expect(
      irradianceBakeFingerprint({
        ...(input as object),
        settings: { ...settings, maxBounces: 7 },
      } as never),
    ).toBe(base);
    expect(
      irradianceBakeFingerprint({
        ...(input as object),
        settings: { ...settings, seed: 8 },
      } as never),
    ).not.toBe(base);
    expect(
      irradianceBakeFingerprint({
        ...(input as object),
        lattice: { ...lattice, spacing: 1 },
      } as never),
    ).not.toBe(base);
  });

  it('keys the selected LUT kernel and ignores an unused fitted kernel', () => {
    const lut = {
      ...(input as object),
      kernel: 'fit-1',
      kernelLut: 'lut-1',
      materials: [
        {
          id: 1,
          program: {
            contract: 'lut',
            paramSchema: [{ name: 'directMultiscatteringLut', type: 'u32' }],
          },
          asset: {},
        },
      ],
    } as never;
    const fingerprint = irradianceBakeFingerprint(lut);
    expect(irradianceBakeFingerprint({ ...(lut as object), kernel: 'fit-2' } as never)).toBe(
      fingerprint,
    );
    expect(irradianceBakeFingerprint({ ...(lut as object), kernelLut: 'lut-2' } as never)).not.toBe(
      fingerprint,
    );
    expect(
      irradianceBakeFingerprint({ ...(lut as object), kernelLut: undefined } as never),
    ).not.toBe(fingerprint);
  });
});
