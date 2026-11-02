import type { ManifestEntry, ShaderReflectionBoundGlobal } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  validateLightTextureResampleProgramPair,
  validateLightTextureResampleProgramPublication,
} from '../prepare/extended-lighting/light-texture-resample';
import { LIGHT_TEXTURE_RESAMPLE_TEST_PROGRAMS } from './light-texture-resample-programs.fixture';

const compute = LIGHT_TEXTURE_RESAMPLE_TEST_PROGRAMS.compute;
const fragment = LIGHT_TEXTURE_RESAMPLE_TEST_PROGRAMS.fragment;

function rejected(program: ManifestEntry, stage: 'compute' | 'fragment' = 'compute'): boolean {
  return !validateLightTextureResampleProgramPublication(program, stage).ok;
}

describe('published light-texture resampling ABI', () => {
  it('accepts both complete fixture publications', () => {
    expect(validateLightTextureResampleProgramPublication(compute, 'compute').ok).toBe(true);
    expect(validateLightTextureResampleProgramPublication(fragment, 'fragment').ok).toBe(true);
    expect(validateLightTextureResampleProgramPair({ compute, fragment }).ok).toBe(true);
  });

  it('fails closed when the source or compiler identity is absent', () => {
    expect(rejected({ ...compute, hash: 'missing' })).toBe(true);
    const { sourceDigest: presentSourceDigest, ...withoutSourceDigest } = compute;
    expect(presentSourceDigest).toBeDefined();
    expect(rejected(withoutSourceDigest)).toBe(true);
    const { compilerProfile: presentCompilerProfile, ...withoutCompilerProfile } = compute;
    expect(presentCompilerProfile).toBeDefined();
    expect(rejected(withoutCompilerProfile)).toBe(true);
  });

  it('rejects entry-point or reflected parameter drift', () => {
    expect(
      rejected({
        ...compute,
        entryPoints: [{ name: 'light_texture_resample', stage: 'fragment', bindings: [] }],
      }),
    ).toBe(true);
    if (compute.reflection === undefined) throw new Error('fixture reflection missing');
    const firstGlobal = compute.reflection.boundGlobals[0];
    if (firstGlobal?.members === undefined || firstGlobal.members[4] === undefined) {
      throw new Error('fixture parameter members missing');
    }
    const firstMembers = firstGlobal.members;
    const reflection = {
      ...compute.reflection,
      boundGlobals: compute.reflection.boundGlobals.map((global, index) =>
        index === 0
          ? {
              ...global,
              members: firstMembers.map((member, memberIndex) =>
                memberIndex === 4 ? { ...member, offset: 28 } : member,
              ),
            }
          : global,
      ),
    };
    expect(rejected({ ...compute, reflection })).toBe(true);
  });

  it('rejects incompatible storage access, array stride, and output contract', () => {
    const bindings = JSON.parse(compute.bindings) as Array<{
      entries: Array<{ binding: number; buffer?: { type: string } }>;
    }>;
    const levels = bindings[0]?.entries.find((row) => row.binding === 2);
    if (levels?.buffer === undefined) throw new Error('fixture storage binding missing');
    levels.buffer.type = 'read-only-storage';
    expect(rejected({ ...compute, bindings: JSON.stringify(bindings) })).toBe(true);

    if (compute.reflection === undefined) throw new Error('fixture reflection missing');
    const reflection = {
      ...compute.reflection,
      boundGlobals: compute.reflection.boundGlobals.map((global, index) =>
        index === 2 ? { ...global, elementStride: 8 } : global,
      ),
    };
    expect(rejected({ ...compute, reflection })).toBe(true);

    const contract = compute.programContract;
    if (contract === undefined || contract.numerical === undefined)
      throw new Error('fixture contract missing');
    const precisionDrift = {
      ...contract,
      numerical: { ...contract.numerical, intermediatePrecision: 'f16' as const },
    };
    expect(rejected({ ...compute, programContract: precisionDrift })).toBe(true);
  });

  it('requires Naga access and texture facts to match the published BGL', () => {
    const reflection = compute.reflection;
    if (reflection === undefined) throw new Error('fixture reflection missing');
    const mutateGlobal = (
      binding: number,
      change: (global: ShaderReflectionBoundGlobal) => object,
    ): ManifestEntry => ({
      ...compute,
      reflection: {
        ...reflection,
        boundGlobals: reflection.boundGlobals.map((global) =>
          global.binding === binding ? { ...global, ...change(global) } : global,
        ),
      },
    });
    expect(rejected(mutateGlobal(2, () => ({ resourceAccess: 'read-only' })))).toBe(true);
    expect(rejected(mutateGlobal(1, () => ({ textureClass: 'storage' })))).toBe(true);
    expect(rejected(mutateGlobal(1, () => ({ sampleType: 'float' })))).toBe(true);
    expect(rejected(mutateGlobal(1, () => ({ viewDimension: '2d-array' })))).toBe(true);
    expect(rejected(mutateGlobal(1, () => ({ multisampled: true })))).toBe(true);

    const bindings = JSON.parse(compute.bindings) as Array<{
      entries: Array<{ binding: number; texture?: { sampleType: string } }>;
    }>;
    const sourceTexture = bindings[0]?.entries.find((row) => row.binding === 1);
    if (sourceTexture?.texture === undefined) throw new Error('fixture texture binding missing');
    sourceTexture.texture.sampleType = 'float';
    expect(rejected({ ...compute, bindings: JSON.stringify(bindings) })).toBe(true);
  });

  it('rejects mismatched fragment target formats before pipeline construction', () => {
    const contract = fragment.programContract;
    if (contract?.colorTargets === undefined) throw new Error('fixture targets missing');
    const targetDrift = {
      ...contract,
      colorTargets: contract.colorTargets.map((target, index) =>
        index === 0 ? { ...target, format: 'rgba16float' } : target,
      ),
    };
    expect(rejected({ ...fragment, programContract: targetDrift }, 'fragment')).toBe(true);
  });

  it('requires compute and fragment numerical, parameter, define, and compiler contracts to match', () => {
    const fragmentCompilerProfile = fragment.compilerProfile;
    const fragmentContract = fragment.programContract;
    if (fragmentCompilerProfile === undefined || fragmentContract?.numerical === undefined) {
      throw new Error('fragment fixture contract missing');
    }
    expect(
      validateLightTextureResampleProgramPair({
        compute,
        fragment: { ...fragment, defines: { DIFFERENT_VARIANT: true } },
      }).ok,
    ).toBe(false);
    expect(
      validateLightTextureResampleProgramPair({
        compute,
        fragment: {
          ...fragment,
          compilerProfile: { ...fragmentCompilerProfile, nagaVersion: '30.0.0' },
        },
      }).ok,
    ).toBe(false);
    expect(
      validateLightTextureResampleProgramPair({
        compute,
        fragment: {
          ...fragment,
          programContract: {
            ...fragmentContract,
            numerical: { ...fragmentContract.numerical, reduction: 'weighted' },
          },
        },
      }).ok,
    ).toBe(false);
  });
});
