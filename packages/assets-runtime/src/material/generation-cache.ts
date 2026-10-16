import {
  createMaterialError,
  err,
  type MaterialErrorFor,
  type MaterialGenerationVector,
  ok,
  type Result,
} from '@forgeax/engine-types';

export type { MaterialGenerationVector } from '@forgeax/engine-types';

export interface MaterialCachedArtifact {
  readonly bytes: Uint8Array;
}

export type MaterialStaleGenerationError =
  MaterialErrorFor<'material-specialization-stale-generation'>;

function sameVector(left: MaterialGenerationVector, right: MaterialGenerationVector): boolean {
  const names = new Set([...Object.keys(left.dependencies), ...Object.keys(right.dependencies)]);
  return [...names].every((name) => left.dependencies[name] === right.dependencies[name]);
}

interface MaterialGenerationState {
  readonly resolved: Map<string, Promise<unknown>>;
  dependencies: readonly string[];
  specializationKey?: string;
  error?: MaterialStaleGenerationError;
}

export class MaterialGenerationCache {
  readonly #materials = new Map<string, MaterialGenerationState>();
  readonly #artifacts = new Map<string, MaterialCachedArtifact>();
  readonly #generations = new Map<string, number>();
  readonly #dependents = new Map<string, Set<string>>();

  resolve<T>(
    materialGuid: string,
    specializationKey: string,
    load: () => Promise<T>,
    publicationGeneration = 0,
  ): Promise<T> {
    const cacheKey = `${materialGuid}:${specializationKey}:${publicationGeneration}`;
    const previous = this.#materials.get(materialGuid)?.resolved.get(cacheKey);
    if (previous !== undefined) return previous as Promise<T>;
    const promise = load();
    this.material(materialGuid).resolved.set(cacheKey, promise);
    void promise.then(
      (value) => {
        if (isStaleGenerationResult(value)) this.removeResolved(materialGuid, cacheKey, promise);
      },
      () => this.removeResolved(materialGuid, cacheKey, promise),
    );
    return promise;
  }

  linkResolved(materialGuid: string, specializationKey: string): void {
    this.material(materialGuid).specializationKey = specializationKey;
  }

  getResolvedKey(materialGuid: string): string | undefined {
    return this.#materials.get(materialGuid)?.specializationKey;
  }

  storeArtifact(key: string, artifact: MaterialCachedArtifact): void {
    this.#artifacts.set(key, artifact);
  }

  getArtifact(key: string): MaterialCachedArtifact | undefined {
    return this.#artifacts.get(key);
  }

  bump(dependency: string): number {
    const generation = (this.#generations.get(dependency) ?? 0) + 1;
    this.#generations.set(dependency, generation);
    for (const materialGuid of this.#dependents.get(dependency) ?? []) {
      this.#materials.get(materialGuid)?.resolved.clear();
    }
    return generation;
  }

  generationError(materialGuid: string): MaterialStaleGenerationError | undefined {
    return this.#materials.get(materialGuid)?.error;
  }

  async loadWithGeneration<T>(
    materialGuid: string,
    dependencies: readonly string[],
    load: (
      generation: MaterialGenerationVector,
    ) => Promise<{ readonly generation: MaterialGenerationVector; readonly value: T }>,
  ): Promise<Result<T, MaterialStaleGenerationError>> {
    const dependencySet = Object.freeze([...dependencies]);
    this.trackDependencies(materialGuid, dependencySet);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const generation = this.vector(dependencySet);
      const loaded = await load(generation);
      const observed = snapshotVector(loaded.generation);
      const current = this.vector(dependencySet);
      if (sameVector(observed, current)) {
        delete this.material(materialGuid).error;
        return ok(loaded.value);
      }
      if (attempt === 1) {
        const error = staleGenerationError(materialGuid, dependencySet, observed, current);
        this.material(materialGuid).error = error;
        return err(error);
      }
    }
    const current = this.vector(dependencySet);
    return err(staleGenerationError(materialGuid, dependencySet, current, current));
  }

  private trackDependencies(materialGuid: string, dependencies: readonly string[]): void {
    const state = this.material(materialGuid);
    for (const dependency of state.dependencies) {
      const dependents = this.#dependents.get(dependency);
      dependents?.delete(materialGuid);
      if (dependents?.size === 0) this.#dependents.delete(dependency);
    }
    state.dependencies = dependencies;
    for (const dependency of dependencies) {
      const dependents = this.#dependents.get(dependency) ?? new Set<string>();
      dependents.add(materialGuid);
      this.#dependents.set(dependency, dependents);
    }
  }

  private removeResolved(materialGuid: string, cacheKey: string, promise: Promise<unknown>): void {
    const state = this.#materials.get(materialGuid);
    if (state?.resolved.get(cacheKey) !== promise) return;
    state.resolved.delete(cacheKey);
    if (
      state.resolved.size === 0 &&
      state.dependencies.length === 0 &&
      state.specializationKey === undefined &&
      state.error === undefined
    )
      this.#materials.delete(materialGuid);
  }

  private material(materialGuid: string): MaterialGenerationState {
    let state = this.#materials.get(materialGuid);
    if (state === undefined) {
      state = { resolved: new Map(), dependencies: [] };
      this.#materials.set(materialGuid, state);
    }
    return state;
  }

  private vector(dependencies: readonly string[]): MaterialGenerationVector {
    return snapshotVector({
      dependencies: Object.fromEntries(
        dependencies.map((dependency) => [dependency, this.#generations.get(dependency) ?? 0]),
      ),
    });
  }
}

function snapshotVector(vector: MaterialGenerationVector): MaterialGenerationVector {
  return Object.freeze({ dependencies: Object.freeze({ ...vector.dependencies }) });
}

function staleGenerationError(
  material: string,
  dependencies: readonly string[],
  observed: MaterialGenerationVector,
  current: MaterialGenerationVector,
): MaterialStaleGenerationError {
  const detail = Object.freeze({
    code: 'material-specialization-stale-generation' as const,
    material,
    dependencies,
    observed,
    current,
  });
  return Object.freeze(createMaterialError('material-specialization-stale-generation', detail));
}

function isStaleGenerationResult(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const result = value as { readonly ok?: unknown; readonly error?: unknown };
  if (result.ok !== false || result.error === null || typeof result.error !== 'object')
    return false;
  return (
    (result.error as { readonly code?: unknown }).code ===
    'material-specialization-stale-generation'
  );
}
