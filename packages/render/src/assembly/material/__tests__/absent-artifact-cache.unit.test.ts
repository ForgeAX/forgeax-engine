import {
  createMaterialShaderProgram,
  createStandardPbrArtifactReceipt,
  STANDARD_SURFACE_DISCARD_CLIPPING_AXIS,
  STANDARD_SURFACE_DISCARD_LOD_AXIS,
} from '@forgeax/engine-shader';
import { ok, type ShaderSource } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { resolveMaterialShaderVariantSet } from '../../material-shader-policy';
import { resolveMaterialShaderArtifact } from '../assembly';

it('shares the normalized discard key while the four raster requests rotate', () => {
  const vertex = '@vertex fn vs_main() -> @builtin(position) vec4f { return vec4f(0); }';
  const program = createMaterialShaderProgram(vertex);
  const receipt = createStandardPbrArtifactReceipt();
  const variants = Array.from({ length: 4 }, (_, mask) => {
    const defines = {
      [STANDARD_SURFACE_DISCARD_CLIPPING_AXIS]: (mask & 2) !== 0,
      [STANDARD_SURFACE_DISCARD_LOD_AXIS]: (mask & 1) !== 0,
    };
    return {
      defines,
      definesKey: Object.entries(defines)
        .map(([axis, on]) => `${axis}=${on}`)
        .join('+'),
      composedWgsl: vertex,
      receipt,
    };
  });
  const entry = { program, paramSchema: [], receipt };
  const publication = { variants };
  const materialProgram = vi.fn(() => program);
  const shader = {
    findMaterialArtifact: () => ok(entry),
    materialShaderManifestEntry: () => publication,
    materialProgram,
  } as unknown as Parameters<typeof resolveMaterialShaderArtifact>[1];
  const artifactFor = (surfaceDiscards: number) =>
    resolveMaterialShaderArtifact('game::raster', shader, { surfaceDiscards });
  const admitted = variants.map((variant, mask) => {
    const artifact = artifactFor(mask);
    expect(artifact?.variantSet).toBe(variant.definesKey);
    expect(
      resolveMaterialShaderArtifact('game::raster', shader, { variantSet: variant.definesKey }),
    ).toBe(artifact);
    return artifact;
  });
  for (let sample = 0; sample < 64; sample++)
    expect(artifactFor(sample)).toBe(admitted[sample & 3]);
  expect(materialProgram).toHaveBeenCalledTimes(4);
});

it('selects a published variant once per request, including requests with no variant', () => {
  let reads = 0;
  const entry = { paramSchema: {} };
  const manifest = {
    get variants() {
      reads++;
      return [{ defines: { A: true }, definesKey: 'A=true', composedWgsl: '' }];
    },
  };
  const shader = {
    findMaterialArtifact: () => ok(entry),
    materialShaderManifestEntry: () => manifest,
    materialProgram: () => {
      throw new Error('no variant matches, so no program is composed');
    },
  } as unknown as Parameters<typeof resolveMaterialShaderArtifact>[1];
  const request = { variantSet: 'A=false', pass: 'shadow', address: 'direct' } as const;
  expect(resolveMaterialShaderArtifact('game::unlit', shader, request)).toBeUndefined();
  const afterFirst = reads;
  expect(afterFirst).toBeGreaterThan(0);
  for (let draw = 0; draw < 10; draw++)
    expect(resolveMaterialShaderArtifact('game::unlit', shader, request)).toBeUndefined();
  expect(reads).toBe(afterFirst);
  const other = { ...request, variantSet: 'A=true' };
  expect(() => resolveMaterialShaderArtifact('game::unlit', shader, other)).toThrow(
    'no variant matches',
  );
});

it('keeps a genuinely missing normalized directional row unavailable instead of borrowing the primary', () => {
  // Preserve the original sparse roster: capability normalization does not publish a missing row.
  const row = (simple: boolean, transmission: boolean, probe: boolean, source: string) => {
    const defines = {
      STORAGE_BUFFER_AVAILABLE: true,
      TRANSMISSION_AVAILABLE: transmission,
      PROBE_BLEND_AVAILABLE: probe,
      DIRECTIONAL_SHADOW_SIMPLE: simple,
    };
    return {
      defines,
      definesKey: Object.entries(defines)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${value}`)
        .join('+'),
      composedWgsl: source,
    };
  };
  const variants = [
    row(false, false, false, 'primary-general'),
    row(true, false, false, 'published-simple'),
    row(false, true, true, 'published-transmission'),
  ];
  const entry = { source: 'primary-general', paramSchema: [] };
  const materialProgram = vi.fn((source: ShaderSource) => {
    expect(source.matches('published-simple')).toBe(true);
    throw new Error('matched published row reaches its program producer');
  });
  const shader = {
    findMaterialArtifact: () => ok(entry),
    materialShaderManifestEntry: () => ({ variants }),
    materialProgram,
  } as unknown as Parameters<typeof resolveMaterialShaderArtifact>[1];
  const normalized = resolveMaterialShaderVariantSet(
    'DIRECTIONAL_SHADOW_SIMPLE=true+PROBE_BLEND_AVAILABLE=true',
    variants,
    'webgpu',
    true,
  );
  expect(normalized).toContain('DIRECTIONAL_SHADOW_SIMPLE=false');
  expect(normalized).toContain('PROBE_BLEND_AVAILABLE=true');
  expect(normalized).toContain('TRANSMISSION_AVAILABLE=false');
  if (normalized === undefined)
    throw new Error('capability normalization must produce the request');
  const request = { variantSet: normalized, pass: 'forward', address: 'direct' } as const;
  expect(
    resolveMaterialShaderArtifact('game::sparse-directional', shader, request),
  ).toBeUndefined();
  expect(materialProgram).not.toHaveBeenCalled();
  const published = resolveMaterialShaderVariantSet(
    'DIRECTIONAL_SHADOW_SIMPLE=true',
    variants,
    'webgpu',
    true,
  );
  if (published === undefined)
    throw new Error('the positive control requires its published request');
  expect(() =>
    resolveMaterialShaderArtifact('game::sparse-directional', shader, {
      ...request,
      variantSet: published,
    }),
  ).toThrow('matched published row reaches its program producer');
  expect(materialProgram).toHaveBeenCalledTimes(1);
});
