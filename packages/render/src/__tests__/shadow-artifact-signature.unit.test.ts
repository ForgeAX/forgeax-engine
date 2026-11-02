import { createMaterialShaderProgram, type MaterialShaderArtifact } from '@forgeax/engine-shader';
import { assert, describe, expect, it, vi } from 'vitest';
import type { PreparedBatch } from '../gpu-driven/production-raster-prepare';
import { sameConsumedArtifact } from '../gpu-driven/production-raster-shadow';
import {
  observeShadowArtifacts,
  type ShadowArtifactObservations,
} from '../gpu-driven/production-raster-support';

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
  let observed: ShadowArtifactObservations = new Map();
  return (batches: readonly PreparedBatch[]) => {
    observed = observeShadowArtifacts(observed, batches);
    return observed;
  };
}

describe('shadow program publication observation', () => {
  it('does not reserialize unchanged observed fields, including fresh equal wrappers', () => {
    const observe = observer();
    const first = observe([batch()]);
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      expect(observe([batch(), batch()])).toBe(first);
      const signatures = stringify.mock.calls.filter(
        ([value]) =>
          (Array.isArray(value) && value[0] === 'caster' && value[1] === 'ShadowCaster') ||
          (typeof value === 'object' &&
            value !== null &&
            value.material === 'caster' &&
            value.pass === 'ShadowCaster'),
      );
      expect(signatures).toHaveLength(0);
    } finally {
      stringify.mockRestore();
    }
  });

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

  it('captures scalar facts independently of later edits to the same artifact', () => {
    const observe = observer();
    const caster = batch();
    const first = observe([caster]);
    const receipt = caster.artifact?.receipt as { generation: number };
    receipt.generation += 1;
    const changed = observe([caster]);
    expect(changed).not.toBe(first);
    expect(observe([caster])).toBe(changed);
    receipt.generation -= 1;
    expect(observe([caster])).not.toBe(changed);
  });

  it.each([
    ['material', 'replacement'],
    ['pass', 'replacement'],
    ['layoutIdentity', 'replacement'],
    ['receipt', { receiptIdentity: 'changed', generation: 1 }],
    ['receipt', { receiptIdentity: 'caster-receipt', generation: 1, sceneIndexEntry: 'changed' }],
    ['variantSet', 'changed'],
    ['program', createMaterialShaderProgram('changed')],
    ['specializationKey', 'changed'],
    ['vertexEntry', 'changed'],
    ['fragmentEntry', 'changed'],
    ['uvSetCount', 2],
    ['reflectionFallbackOutputAvailable', true],
  ])('observes an in-place %s replacement', (field, value) => {
    const observe = observer(),
      caster = batch();
    const first = observe([caster]);
    Object.assign(caster.artifact, { [field as string]: value });
    const replacement = observe([caster]);
    expect(replacement).not.toBe(first);
    expect(observe([caster])).toBe(replacement);
  });

  it('compares reverted values against an independently retained earlier observation', () => {
    const observe = observer(),
      caster = batch();
    const original = observe([caster]);
    observe([batch('changed')]);
    const reverted = observe([batch()]);
    expect(sameConsumedArtifact(caster.batch, original, reverted)).toBe(true);
  });

  it('preserves JSON defaults and non-finite numeric equality', () => {
    const observe = observer(),
      caster = batch();
    Object.assign(caster.artifact, { uvSetCount: Number.NaN });
    const first = observe([caster]);
    Object.assign(caster.artifact, { uvSetCount: Number.POSITIVE_INFINITY });
    expect(observe([caster])).toBe(first);
    Object.assign(caster.artifact, { uvSetCount: -0 });
    const zero = observe([caster]);
    Object.assign(caster.artifact, { uvSetCount: 0 });
    expect(observe([caster])).toBe(zero);
  });

  it('reads borrowed artifact getters in the original order on both cold and equal observations', () => {
    const caster = batch(),
      reads: PropertyKey[] = [];
    const sourceReceipt = caster.artifact.receipt;
    assert(sourceReceipt);
    const receipt = new Proxy(sourceReceipt, {
      get(target, key, receiver) {
        reads.push(`receipt.${String(key)}`);
        return Reflect.get(target, key, receiver);
      },
    });
    Object.assign(caster.artifact, { receipt });
    const borrowed = {
      ...caster,
      artifact: new Proxy(caster.artifact, {
        get(target, key, receiver) {
          reads.push(key);
          return Reflect.get(target, key, receiver);
        },
      }),
    };
    const observe = observer();
    const expected = [
      'material',
      'pass',
      'layoutIdentity',
      'receipt',
      'receipt.receiptIdentity',
      'receipt',
      'receipt.generation',
      'variantSet',
      'program',
      'specializationKey',
      'receipt',
      'receipt.sceneIndexEntry',
      'vertexEntry',
      'receipt',
      'receipt.sceneIndexEntry',
      'fragmentEntry',
      'uvSetCount',
      'reflectionFallbackOutputAvailable',
    ];
    const first = observe([borrowed]);
    expect(reads).toEqual(expected);
    reads.length = 0;
    expect(observe([borrowed])).toBe(first);
    expect(reads).toEqual(expected);
  });
});
