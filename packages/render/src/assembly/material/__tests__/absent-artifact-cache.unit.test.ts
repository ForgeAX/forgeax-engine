import { ok, type ShaderSource } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { resolveMaterialShaderVariantSet } from '../../material-shader-policy';
import { resolveMaterialShaderArtifact } from '../assembly';

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
