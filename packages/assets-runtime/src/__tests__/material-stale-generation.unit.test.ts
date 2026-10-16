import { describe, expect, it } from 'vitest';
import { MaterialGenerationCache } from '../material/generation-cache.js';
import { inspectMaterialRuntime } from '../material/inspection.js';
import { createMaterialLoader, type MaterialLoadError } from '../material/loader.js';
import {
  materialPublicationFixture,
  materialRecordFixture,
} from './fixtures/material-publication.js';

const DERIVED_MATERIAL_GUID = '01935b00-7d8c-7c4e-9f12-345678abcd03';
const SPECIALIZATION_KEY = 'my-game::pulse-material';
const SPECIALIZATION_DEPENDENCIES = ['my-game::pulse-material', 'pack:pulse-material'] as const;

function createCookedMaterialLoader() {
  const record = materialRecordFixture({
    guid: DERIVED_MATERIAL_GUID,
    specializationKey: SPECIALIZATION_KEY,
  });
  return createMaterialLoader({
    loadPublication: async () => materialPublicationFixture(record),
    loadReference: async () => true,
  });
}

describe('material stale generation publication', () => {
  it('projects ready, pending, failed, and last-known-good producer states', async () => {
    const loader = createCookedMaterialLoader();
    const loaded = await loader.load({
      guid: DERIVED_MATERIAL_GUID,
      specializationKey: SPECIALIZATION_KEY,
    });
    expect(loaded.status).toBe('Ready');
    if (loaded.status !== 'Ready') return;

    expect(inspectMaterialRuntime(loaded)).toMatchObject({
      materialGuid: DERIVED_MATERIAL_GUID,
      readiness: 'ready',
      status: 'Ready',
    });

    const failed: MaterialLoadError = {
      status: 'Error',
      error: {
        code: 'material-specialization-not-cooked',
        expected: 'a cooked material specialization record and artifact',
        hint: 'run the material cooker',
        retryable: true,
        recoveryActions: ['retry-material-load'],
        detail: { guid: DERIVED_MATERIAL_GUID, specializationKey: SPECIALIZATION_KEY },
      },
    };
    expect(inspectMaterialRuntime(failed)).toMatchObject({
      materialGuid: DERIVED_MATERIAL_GUID,
      readiness: 'failed',
      status: 'Error',
      preparationFailure: failed.error,
    });

    const pending = inspectMaterialRuntime({
      status: 'Pending',
      guid: DERIVED_MATERIAL_GUID,
      specializationKey: SPECIALIZATION_KEY,
      reason: 'dependency-load',
    });
    expect(pending).toMatchObject({
      materialGuid: DERIVED_MATERIAL_GUID,
      readiness: 'pending',
      status: 'Pending',
      reason: 'dependency-load',
    });

    expect(
      inspectMaterialRuntime({ status: 'LastKnownGood', ready: loaded, failure: failed }),
    ).toMatchObject({
      materialGuid: DERIVED_MATERIAL_GUID,
      readiness: 'last-known-good',
      status: 'LastKnownGood',
      preparationFailure: failed.error,
      lastKnownGood: { status: 'Ready', readiness: 'ready' },
    });
  });

  it('retries once and reports the generation vector when dependencies change', async () => {
    const cache = new MaterialGenerationCache();
    let calls = 0;
    const result = await cache.loadWithGeneration('mat-a', ['texture/a'], async (generation) => {
      calls += 1;
      if (calls === 1) cache.bump('texture/a');
      return { generation, value: calls };
    });

    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
    expect(cache.generationError('mat-a')).toBeUndefined();
  });

  it('exposes stale-generation details after the retry budget is exhausted', async () => {
    const cache = new MaterialGenerationCache();
    const result = await cache.loadWithGeneration('mat-a', ['texture/a'], async (generation) => {
      cache.bump('texture/a');
      return { generation, value: 1 };
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'material-specialization-stale-generation' },
    });
  });

  it('retries a cooked material after the stale promise is rejected', async () => {
    const cache = new MaterialGenerationCache();
    const loader = createCookedMaterialLoader();
    const dependencies: string[] = [...SPECIALIZATION_DEPENDENCIES];
    const shaderDependency = SPECIALIZATION_DEPENDENCIES[0];
    let unstable = true;
    let loadCalls = 0;

    const loadSpecialization = () =>
      cache.loadWithGeneration(DERIVED_MATERIAL_GUID, dependencies, async (generation) => {
        loadCalls += 1;
        const loaded = await loader.load({
          guid: DERIVED_MATERIAL_GUID,
          specializationKey: SPECIALIZATION_KEY,
        });
        expect(loaded.status).toBe('Ready');
        if (loaded.status !== 'Ready') throw new Error('fixture material did not load');
        if (unstable) cache.bump(shaderDependency);
        return { generation, value: loaded.record };
      });

    const stale = await cache.resolve(
      DERIVED_MATERIAL_GUID,
      SPECIALIZATION_KEY,
      loadSpecialization,
    );
    expect(stale).toMatchObject({
      ok: false,
      error: { code: 'material-specialization-stale-generation' },
    });
    expect(loadCalls).toBe(2);
    expect(cache.generationError(DERIVED_MATERIAL_GUID)?.detail).toMatchObject({
      material: DERIVED_MATERIAL_GUID,
      dependencies: [...SPECIALIZATION_DEPENDENCIES],
      observed: {
        dependencies: { [SPECIALIZATION_DEPENDENCIES[0]]: 1, [SPECIALIZATION_DEPENDENCIES[1]]: 0 },
      },
      current: {
        dependencies: { [SPECIALIZATION_DEPENDENCIES[0]]: 2, [SPECIALIZATION_DEPENDENCIES[1]]: 0 },
      },
    });
    const staleError = cache.generationError(DERIVED_MATERIAL_GUID);
    expect(staleError?.code).toBe('material-specialization-stale-generation');
    expect(staleError?.detail.code).toBe('material-specialization-stale-generation');
    expect(Object.isFrozen(staleError?.detail)).toBe(true);
    expect(Object.isFrozen(staleError?.detail.dependencies)).toBe(true);
    expect(Object.isFrozen(staleError?.detail.observed.dependencies)).toBe(true);
    expect(Object.isFrozen(staleError?.detail.current.dependencies)).toBe(true);
    dependencies.push('mutated-after-publication');
    expect(staleError?.detail.dependencies).toEqual([...SPECIALIZATION_DEPENDENCIES]);

    const published: unknown[] = [];
    if (stale.ok) published.push(stale.value);
    expect(published).toHaveLength(0);

    unstable = false;
    const fresh = await cache.resolve(
      DERIVED_MATERIAL_GUID,
      SPECIALIZATION_KEY,
      loadSpecialization,
    );
    expect(fresh.ok).toBe(true);
    expect(loadCalls).toBe(3);
    if (fresh.ok) published.push(fresh.value);
    expect(published).toHaveLength(1);
    expect(cache.generationError(DERIVED_MATERIAL_GUID)).toBeUndefined();
  });

  it('recovers device loss without changing the published generation', async () => {
    const cache = new MaterialGenerationCache();
    const publicationGeneration = 7;
    let attempts = 0;
    const observedGenerations: number[] = [];
    const result = await cache.loadWithGeneration(
      DERIVED_MATERIAL_GUID,
      SPECIALIZATION_DEPENDENCIES,
      async (generation) => {
        attempts += 1;
        observedGenerations.push(generation.dependencies[SPECIALIZATION_KEY] ?? 0);
        if (attempts === 1) cache.bump(SPECIALIZATION_DEPENDENCIES[0]);
        return {
          generation,
          value: { publicationGeneration, recovery: attempts === 1 ? 'device-loss' : 'retry' },
        };
      },
    );

    expect(result).toEqual({
      ok: true,
      value: { publicationGeneration, recovery: 'retry' },
    });
    expect(attempts).toBe(2);
    expect(observedGenerations).toEqual([0, 1]);
    expect(cache.generationError(DERIVED_MATERIAL_GUID)).toBeUndefined();
  });
});
