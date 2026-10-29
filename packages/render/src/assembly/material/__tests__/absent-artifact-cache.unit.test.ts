import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
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
