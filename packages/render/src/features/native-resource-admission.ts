import type { Result } from '@forgeax/engine-types';
import type { RenderError } from '../errors/render';
import { featureResourceKey, featureScopeKey } from './frame-plan';
import type { RenderFeatureResourceDeclaration, RenderFeatureWorkScope } from './plan';
import type {
  RenderFeatureGpuBindingsRef,
  RenderFeatureGpuBufferRef,
  RenderFeatureGpuPreparedResourceRef,
  RenderFeatureGpuPrepareSession,
  RenderFeatureGpuProgramRef,
  RenderFeatureGpuResourceDomain,
  RenderFeatureNativeResourceAdmission,
  RenderFeatureNativeResourceDomain,
} from './prepared-gpu-work';
import { isOwnedRenderFeatureProgramData } from './prepared-gpu-work';
import type { RenderFeaturePreparedRef } from './prepared-graphics';

export interface PreparedPlanResources {
  readonly computePrograms: ReadonlyMap<string, RenderFeatureGpuProgramRef>;
  readonly graphicsPrograms: ReadonlyMap<string, RenderFeaturePreparedRef<'pipeline'>>;
  readonly buffers: ReadonlyMap<string, RenderFeatureGpuBufferRef>;
  readonly preparedGpuResources: ReadonlyMap<string, RenderFeatureGpuPreparedResourceRef>;
  readonly computeBindings: ReadonlyMap<string, RenderFeatureGpuBindingsRef>;
  readonly graphicsBindings: ReadonlyMap<string, RenderFeaturePreparedRef<'bindings'>>;
  readonly vertexData: ReadonlyMap<string, RenderFeaturePreparedRef<'vertex-data'>>;
  readonly indexData: ReadonlyMap<string, RenderFeaturePreparedRef<'index-data'>>;
}

class PreparedResourceLookup<T> extends Map<string, T> {
  constructor(
    private readonly parent: ReadonlyMap<string, T> | undefined,
    private readonly fallback?: ReadonlyMap<string, T>,
  ) {
    super();
  }
  override get(name: string): T | undefined {
    return super.get(name) ?? this.parent?.get(name) ?? this.fallback?.get(name);
  }
}

export function createPreparedResourceMaps(
  parent?: PreparedPlanResources,
  fallback?: PreparedPlanResources,
  inherit = true,
) {
  const map = <T>(kind: keyof PreparedPlanResources) =>
    inherit && (parent !== undefined || fallback !== undefined)
      ? new PreparedResourceLookup<T>(
          parent?.[kind] as ReadonlyMap<string, T> | undefined,
          fallback?.[kind] as ReadonlyMap<string, T> | undefined,
        )
      : new Map(inherit ? undefined : (parent?.[kind] as ReadonlyMap<string, T> | undefined));
  return {
    computePrograms: map<RenderFeatureGpuProgramRef>('computePrograms'),
    graphicsPrograms: map<RenderFeaturePreparedRef<'pipeline'>>('graphicsPrograms'),
    buffers: map<RenderFeatureGpuBufferRef>('buffers'),
    preparedGpuResources: map<RenderFeatureGpuPreparedResourceRef>('preparedGpuResources'),
    computeBindings: map<RenderFeatureGpuBindingsRef>('computeBindings'),
    graphicsBindings: map<RenderFeaturePreparedRef<'bindings'>>('graphicsBindings'),
    vertexData: map<RenderFeaturePreparedRef<'vertex-data'>>('vertexData'),
    indexData: map<RenderFeaturePreparedRef<'index-data'>>('indexData'),
  };
}

interface Domain {
  readonly session: RenderFeatureGpuPrepareSession;
  readonly scope: string;
  readonly prepared: PreparedPlanResources;
  readonly gpu: RenderFeatureGpuResourceDomain;
}

const domains = new WeakMap<RenderFeatureNativeResourceDomain, Domain>();
const kinds = [
  'computePrograms',
  'graphicsPrograms',
  'buffers',
  'preparedGpuResources',
  'computeBindings',
  'graphicsBindings',
  'vertexData',
  'indexData',
] as const;

function merge(destination: PreparedPlanResources, source: PreparedPlanResources): void {
  for (const kind of kinds) {
    const target = destination[kind] as Map<string, unknown>;
    for (const [name, reference] of source[kind]) {
      const previous = target.get(name);
      if (previous !== undefined && previous !== reference)
        throw new Error(`Native resource admission replaces an active name: ${name}`);
      target.set(name, reference);
    }
  }
}

/** One Host-issued resource ownership domain, backed by the GPU session's
 * existing candidate and completion leases. It is not a declaration cache. */
export function createNativeResourceAdmission(input: {
  readonly gpu: RenderFeatureGpuPrepareSession;
  readonly isActive: () => boolean;
  readonly prepare: (
    resources: readonly RenderFeatureResourceDeclaration[],
    keys: ReadonlyMap<string, string>,
    inherited: PreparedPlanResources,
  ) => Result<PreparedPlanResources, RenderError>;
}): {
  readonly admission: RenderFeatureNativeResourceAdmission;
  readonly prepared: (scope: RenderFeatureWorkScope) => PreparedPlanResources | undefined;
  readonly usedScopes: () => Iterable<string>;
  readonly requestsPreparation: () => boolean;
} {
  const scopes = new Map<string, PreparedPlanResources>();
  let preparationRequested = false;
  const programs = new Map<string, { readonly descriptor: object; readonly wait: boolean }>();
  const scopeState = (scope: RenderFeatureWorkScope) => {
    if (!input.isActive()) throw new Error('Native resource admission is outside its plan stage');
    const key = featureScopeKey(scope);
    let state = scopes.get(key);
    if (state === undefined) {
      state = createPreparedResourceMaps(scope === 'frame' ? undefined : scopes.get('frame'));
      scopes.set(key, state);
    }
    return state;
  };
  return {
    usedScopes: () => scopes.keys(),
    requestsPreparation: () => preparationRequested,
    prepared: (scope) => {
      const key = featureScopeKey(scope);
      let state = scopes.get(key);
      if (state === undefined && scope !== 'frame' && scopes.has('frame')) {
        state = createPreparedResourceMaps(scopes.get('frame'));
        scopes.set(key, state);
      }
      return state;
    },
    admission: {
      program: (scope, name, descriptor, waitForCompletion) => {
        const state = scopeState(scope);
        preparationRequested ||= waitForCompletion === true;
        const key = featureResourceKey(scope, name);
        const previous = programs.get(key);
        if (
          previous?.descriptor === descriptor &&
          isOwnedRenderFeatureProgramData(descriptor) &&
          (previous.wait || !waitForCompletion)
        )
          return;
        const prepared = input.gpu.prepareProgram(key, descriptor, waitForCompletion);
        if (!prepared.ok) throw prepared.error;
        programs.set(key, { descriptor, wait: waitForCompletion === true });
        (state.computePrograms as Map<string, typeof prepared.value>).set(name, prepared.value);
      },
      retain: (scope, token) => {
        const state = scopeState(scope);
        const domain = domains.get(token);
        if (domain?.session !== input.gpu || domain.scope !== featureScopeKey(scope)) return false;
        const retained = input.gpu.retainResourceDomain(domain.gpu);
        if (!retained.ok) throw retained.error;
        if (!retained.value) return false;
        merge(state, domain.prepared);
        return true;
      },
      admit: (scope, resources) => {
        const state = scopeState(scope);
        if (
          resources.some(
            (resource) =>
              (resource.kind !== 'buffer' && resource.kind !== 'compute-bindings') ||
              (resource.kind === 'buffer' &&
                (Object.hasOwn(resource, 'data') || Object.hasOwn(resource, 'uploads'))),
          )
        )
          throw new Error('Native resource domain accepts owned buffers and compute bindings only');
        const keys = new Map(
          resources.map((resource) => [resource.name, featureResourceKey(scope, resource.name)]),
        );
        const prepared = input.prepare(resources, keys, state);
        if (!prepared.ok) throw prepared.error;
        const captured = input.gpu.captureResourceDomain({
          programs: [...prepared.value.computePrograms.values()],
          buffers: [...prepared.value.buffers.values()],
          bindings: [...prepared.value.computeBindings.values()],
        });
        if (!captured.ok) throw captured.error;
        const owned = Object.fromEntries(
          kinds.map((kind) => [
            kind,
            new Map(prepared.value[kind] as ReadonlyMap<string, unknown>),
          ]),
        ) as unknown as PreparedPlanResources;
        for (const resource of resources) {
          if (resource.kind !== 'compute-bindings') continue;
          const program = prepared.value.computePrograms.get(resource.program);
          if (program !== undefined)
            (owned.computePrograms as Map<string, typeof program>).set(resource.program, program);
          for (const entry of resource.entries) {
            const buffer = prepared.value.buffers.get(entry.resource);
            if (buffer !== undefined)
              (owned.buffers as Map<string, typeof buffer>).set(entry.resource, buffer);
          }
        }
        const token = {} as RenderFeatureNativeResourceDomain;
        domains.set(token, {
          session: input.gpu,
          scope: featureScopeKey(scope),
          prepared: owned,
          gpu: captured.value,
        });
        merge(state, owned);
        return token;
      },
      upload: (scope, name, offset, data) => {
        const reference = scopeState(scope).buffers.get(name);
        if (reference === undefined) throw new Error(`Native upload buffer unavailable: ${name}`);
        const written = input.gpu.writeBuffer(reference, offset, data);
        if (!written.ok) throw written.error;
      },
    },
  };
}
