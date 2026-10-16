import { createMaterialShaderProgram, type MaterialShaderArtifact } from '@forgeax/engine-shader';
import { describe, expect, it } from 'vitest';
import { GpuDrivenProduction } from '../gpu-driven/production-raster';
import type { PreparedBatch } from '../gpu-driven/production-raster-prepare';

function batch(program = 'static-caster', generation = 1): PreparedBatch {
  const artifact = {
    material: 'caster',
    pass: 'ShadowCaster',
    layoutIdentity: 'shadow-layout',
    program: createMaterialShaderProgram(program),
    receipt: { receiptIdentity: 'caster-receipt', generation },
  } as MaterialShaderArtifact;
  return {
    batch: {
      prepared: {
        identity: { material: 'caster', deformation: 'rigid' },
        receiptIdentity: 'caster-receipt',
        receiptGeneration: generation,
      },
    },
    artifact,
  } as PreparedBatch;
}

function observer() {
  const production = Object.create(GpuDrivenProduction.prototype) as {
    observedShadowArtifacts: ReadonlyMap<string, string | undefined>;
    observeShadowArtifacts(
      batches: readonly PreparedBatch[],
      artifacts: ReadonlyMap<string, MaterialShaderArtifact> | undefined,
    ): ReadonlyMap<string, string | undefined>;
  };
  production.observedShadowArtifacts = new Map();
  return (batches: readonly PreparedBatch[]) =>
    production.observeShadowArtifacts(batches, undefined);
}

describe('shadow program publication observation', () => {
  it('retains the observation across repeated mesh/instance batches', () => {
    const observe = observer();
    const staticCaster = batch();
    const first = observe([staticCaster]);
    expect(observe([staticCaster, staticCaster])).toBe(first);
    expect(observe([staticCaster, batch()])).toBe(first);
    expect(observe([staticCaster])).toBe(first);
  });

  it('invalidates program replacement, receipt generation, and removal of the last program user', () => {
    const observe = observer();
    const first = observe([batch()]);
    const replacement = observe([batch('changed-shadow-wgsl')]);
    expect(replacement).not.toBe(first);
    const generation = observe([batch('changed-shadow-wgsl', 2)]);
    expect(generation).not.toBe(replacement);
    expect(observe([])).not.toBe(generation);
  });
});
