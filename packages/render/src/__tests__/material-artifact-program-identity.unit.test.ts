import { createMaterialShaderProgram, type MaterialShaderArtifact } from '@forgeax/engine-shader';
import { describe, expect, it, vi } from 'vitest';
import * as programIdentity from '../assembly/material/artifact-program-identity';
import {
  materialArtifactProgramIdentity,
  sameMaterialArtifactProgram,
} from '../assembly/material/artifact-program-identity';
import { sameMaterialArtifact } from '../gpu-driven/production-raster-prepare';

function artifact(source: string): MaterialShaderArtifact {
  return { program: createMaterialShaderProgram(source) } as MaterialShaderArtifact;
}

describe('material artifact program identity', () => {
  it('shares immutable source identity across pass projections', () => {
    const published = artifact('fn fs_main() -> vec4f { return vec4f(1.0); }');
    const projected = { ...published, fragmentEntry: 'fs_gbuffer' };
    expect(projected.program).toBe(published.program);
    expect(materialArtifactProgramIdentity(projected)).toBe(
      materialArtifactProgramIdentity(published),
    );
  });

  it('publishes changed source and layout as one replacement', () => {
    const original = artifact('fn fs_main() -> vec4f { return vec4f(1.0); }');
    const edited = {
      ...original,
      program: createMaterialShaderProgram('@group(2) @binding(3) var<uniform> cluster: vec4f;'),
    };
    expect(materialArtifactProgramIdentity(edited)).not.toBe(
      materialArtifactProgramIdentity(original),
    );
    expect(edited.program.group2).toBe('cluster');
    expect(original.program.group2).toBe('mesh');
  });

  it('distinguishes specialization identities without rescanning source', () => {
    const original = artifact('source');
    const specialized = { ...original, specializationKey: 'scene-index-program' };
    expect(materialArtifactProgramIdentity(specialized)).not.toBe(
      materialArtifactProgramIdentity(original),
    );
    expect(specialized.program).toBe(original.program);
  });
});

it('compares specialization program facts without repeatedly serializing their identity', () => {
  const original = { ...artifact('source'), specializationKey: 'selected-program' };
  const projected = { ...original };
  const identity = vi.spyOn(programIdentity, 'materialArtifactProgramIdentity');
  try {
    expect(sameMaterialArtifact(original, projected)).toBe(true);
    expect(sameMaterialArtifact(original, { ...projected, specializationKey: 'changed' })).toBe(
      false,
    );
    expect(sameMaterialArtifact(original, { ...projected, fragmentEntry: 'changed' })).toBe(false);
    expect(identity).not.toHaveBeenCalled();
  } finally {
    identity.mockRestore();
  }
});

it('keeps specialization identity distinct from arbitrary program strings', () => {
  const reads: string[] = [];
  const raw = (label: string, key: string | undefined): MaterialShaderArtifact =>
    ({
      ...artifact('source'),
      get specializationKey() {
        reads.push(label);
        return key;
      },
    }) as MaterialShaderArtifact;
  expect(sameMaterialArtifactProgram(raw('left', 'selected'), raw('right', 'selected'))).toBe(true);
  expect(reads).toEqual(['left', 'right']);
  const special = { ...artifact('source'), specializationKey: 'selected' };
  const aliased = {
    ...artifact('source'),
    program: { ...artifact('source').program, identity: 'specialization:selected' },
  };
  expect(sameMaterialArtifactProgram(special, aliased)).toBe(false);
  expect(sameMaterialArtifactProgram(aliased, special)).toBe(false);
  expect(sameMaterialArtifactProgram(special, artifact('source'))).toBe(false);
});

it('invalidates a specialized program when its source changes under the same registry key', () => {
  const original = { ...artifact('before'), specializationKey: 'selected-program' };
  const replacement = { ...artifact('after'), specializationKey: 'selected-program' };
  expect(sameMaterialArtifact(original, replacement)).toBe(false);
  expect(materialArtifactProgramIdentity(original)).not.toBe(
    materialArtifactProgramIdentity(replacement),
  );
});
