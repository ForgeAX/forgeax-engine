import type {
  RenderFeatureResourceDeclaration,
  RenderFeatureWork,
  RenderFeatureWorkPlan,
  RenderFeatureWorkScope,
} from './plan';

/** Scope is the resource namespace; it is never a synthetic Feature identity. */
export function featureScopeKey(scope: RenderFeatureWorkScope): string {
  return scope === 'frame' ? 'frame' : `view:${scope.view}`;
}

/** Shared graph compiler namespace for one scoped feature pass. */
export function sharedFeatureGraphPassPrefix(scope: string): string {
  return `${scope}:`;
}

/** Physical pass name used by hoisted WaterInfo/WaterAdvanced shared plans. */
export function viewSharedFeatureGraphPassName(view: string, name: string): string {
  return sharedFeatureGraphPassPrefix(featureScopeKey({ view })) + name;
}

export function featureResourceKey(scope: RenderFeatureWorkScope, name: string): string {
  return JSON.stringify([featureScopeKey(scope), name]);
}

export function featureResourceAllocationScope(
  identity: string,
  scope: RenderFeatureWorkScope,
): string {
  return JSON.stringify([identity, featureScopeKey(scope)]);
}

export interface FeatureWorkResources {
  readonly work: RenderFeatureWork;
  readonly closure: RenderFeatureWorkPlan;
  readonly native?: true;
  readonly keys: ReadonlyMap<string, string>;
  /** The declaring work scope for each source name in this row's closure. */
  readonly resourceScopes: ReadonlyMap<string, RenderFeatureWorkScope>;
  readonly resources: readonly RenderFeatureResourceDeclaration[];
}

const NO_WORK_RESOURCES: readonly FeatureWorkResources[] = Object.freeze([]);

function assertUniqueResourceNames(
  work: RenderFeatureWork,
  scope: string,
  sharedByName: ReadonlyMap<string, RenderFeatureResourceDeclaration>,
): void {
  const localNames = new Set<string>();
  for (const resource of work.resources) {
    if (
      localNames.has(resource.name) ||
      (work.scope !== 'frame' && sharedByName.has(resource.name))
    )
      throw new Error(`ambiguous RenderFeature resource: ${scope}/${resource.name}`);
    localNames.add(resource.name);
  }
}

function resourceScopesForWork(
  shared: readonly RenderFeatureResourceDeclaration[],
  work: RenderFeatureWork,
): ReadonlyMap<string, RenderFeatureWorkScope> {
  const scopes = new Map<string, RenderFeatureWorkScope>();
  for (const resource of shared) scopes.set(resource.name, 'frame');
  for (const resource of work.resources) scopes.set(resource.name, work.scope);
  return scopes;
}

/** Resolve only local and shared names. Cross-view reads have no lookup route. */
export function resolveFeatureWorkResources(
  works: readonly RenderFeatureWork[],
): readonly FeatureWorkResources[] {
  if (works.length === 0) return NO_WORK_RESOURCES;
  const scopes = new Set<string>();
  const shared = works.find((work) => work.scope === 'frame')?.resources ?? [];
  const sharedByName = new Map(shared.map((resource) => [resource.name, resource]));
  let frameKeys: ReadonlyMap<string, string> | undefined;
  return works.map((work) => {
    const scope = featureScopeKey(work.scope);
    if (scopes.has(scope)) throw new Error(`duplicate RenderFeature work scope: ${scope}`);
    scopes.add(scope);
    assertUniqueResourceNames(work, scope, sharedByName);
    const keys = new Map<string, string>();
    const resourceScopes = new Map<string, RenderFeatureWorkScope>();
    const captureWorkResourceKeys = () => {
      let canonicalFrameKeys = true;
      for (const resource of shared) {
        const alias = resource.name;
        const name = resource.name;
        keys.set(alias, frameKeys?.get(name) ?? featureResourceKey('frame', name));
        resourceScopes.set(alias, 'frame');
        canonicalFrameKeys &&= alias === name;
      }
      for (const resource of work.resources) {
        const alias = resource.name;
        const resourceScope = work.scope;
        const name = resource.name;
        const existing =
          resourceScope === 'frame' && canonicalFrameKeys ? keys.get(name) : undefined;
        keys.set(alias, existing ?? featureResourceKey(resourceScope, name));
        resourceScopes.set(alias, resourceScope);
        canonicalFrameKeys &&= alias === name && resourceScope === 'frame';
      }
      // Reuse the admitted frame namespace, not descriptors. Keep reading names
      // in each scope; changing getters cannot supply canonical encoded keys.
      if (scope === 'frame' && canonicalFrameKeys) frameKeys = keys;
    };
    captureWorkResourceKeys();
    const key = (name: string): string => {
      const resolved = keys.get(name);
      if (resolved === undefined)
        throw new Error(`unresolved RenderFeature resource: ${scope}/${name}`);
      return resolved;
    };
    const resources = work.resources.map((resource): RenderFeatureResourceDeclaration => {
      const name = key(resource.name);
      switch (resource.kind) {
        case 'compute-bindings':
          return {
            ...resource,
            name,
            program: key(resource.program),
            entries: resource.entries.map((entry) => ({ ...entry, resource: key(entry.resource) })),
          };
        case 'graphics-bindings':
          return {
            ...resource,
            name,
            program: key(resource.program),
          };
        case 'texture-alias':
          return { ...resource, name, resource: key(resource.resource) };
        case 'vertex-data':
        case 'index-data':
          return resource.buffer === undefined
            ? { ...resource, name }
            : { ...resource, name, buffer: key(resource.buffer) };
        default:
          return { ...resource, name };
      }
    });
    // A view observes only the shared resources its own declarations consume.
    // Tick-local simulation inputs belong to the frame graph, not every view's
    // signature or physical import identity. Keep source order for admission.
    const referenced = new Set<string>();
    const include = (name: string): void => {
      const resource = sharedByName.get(name);
      if (resource === undefined || referenced.has(name)) return;
      referenced.add(name);
      dependencies(resource);
    };
    const values = (value: unknown): void => {
      if (typeof value === 'string') include(value);
      else if (value !== null && typeof value === 'object' && !ArrayBuffer.isView(value)) {
        for (const child of Object.values(value)) values(child);
      }
    };
    const dependencies = (resource: RenderFeatureResourceDeclaration): void => {
      if (resource.kind === 'fullscreen-program') {
        for (const read of resource.reads ?? [])
          include(typeof read === 'string' ? read : read.key);
      } else if (resource.kind === 'compute-bindings') {
        include(resource.program);
        for (const entry of resource.entries) include(entry.resource);
      } else if (resource.kind === 'graphics-bindings') {
        include(resource.program);
        values(resource.values);
      } else if (resource.kind === 'texture-alias') {
        include(resource.resource);
      } else if (
        (resource.kind === 'vertex-data' || resource.kind === 'index-data') &&
        resource.buffer !== undefined
      ) {
        include(resource.buffer);
      } else if (
        resource.kind === 'prepared-gpu-resource' &&
        typeof resource.logicalTarget === 'string'
      ) {
        include(resource.logicalTarget);
      }
    };
    const includeWorkResourceDependencies = () => {
      if (work.scope !== 'frame') {
        for (const resource of shared)
          if (resource.kind === 'fullscreen-program') include(resource.name);
        for (const resource of work.resources) dependencies(resource);
        const includeWorkPassDependencies = () => {
          for (const pass of work.passes) {
            if (pass.kind === 'compute') {
              include(pass.program);
              include(pass.bindings);
              for (const dispatch of pass.dispatches) {
                if (dispatch.bindings !== undefined) include(dispatch.bindings);
                if (dispatch.kind === 'indirect') include(dispatch.resource);
              }
            } else if (pass.kind === 'copy') {
              for (const copy of pass.copies) {
                include(copy.source);
                include(copy.destination);
              }
            } else {
              if (pass.kind === 'raster')
                for (const target of pass.sampledTargets ?? [])
                  if (typeof target === 'string') include(target);
              for (const draw of pass.draws) {
                include(draw.program);
                for (const name of draw.bindings) include(name);
                for (const vertex of draw.vertexData) include(vertex.resource);
                if (draw.indexData !== undefined) include(draw.indexData.resource);
                if (
                  draw.draw.kind === 'draw-indirect' ||
                  draw.draw.kind === 'draw-indexed-indirect'
                )
                  include(draw.draw.resource);
              }
            }
          }
        };
        includeWorkPassDependencies();
      }
    };
    includeWorkResourceDependencies();
    return {
      work,
      closure: {
        ...(work.submission === undefined ? {} : { submission: work.submission }),
        ...(work.placement === undefined ? {} : { placement: work.placement }),
        ...(work.waterView === undefined ? {} : { waterView: work.waterView }),
        resources:
          work.scope === 'frame'
            ? work.resources
            : [...shared.filter((resource) => referenced.has(resource.name)), ...work.resources],
        passes: work.passes,
      },
      keys,
      resourceScopes,
      resources,
    };
  });
}

interface NativeScopeRouting {
  readonly scope: string;
  readonly names: readonly string[];
  readonly keys: ReadonlyMap<string, string>;
}

/** The Feature slot owns source-name relationships across prepared frames.
 * Resource values and execution data still belong to each current publication. */
export class NativeFeatureWorkRouting {
  private shared: readonly string[] = [];
  private scopes: readonly NativeScopeRouting[] = [];

  resolve(works: readonly RenderFeatureWork[]): readonly FeatureWorkResources[] {
    if (works.length === 0) {
      this.shared = [];
      this.scopes = [];
      return NO_WORK_RESOURCES;
    }
    const sharedWork = works.find((work) => work.scope === 'frame');
    const shared = sharedWork?.resources ?? [];
    const sameShared =
      shared.length === this.shared.length &&
      shared.every((resource, index) => resource.name === this.shared[index]);
    const ordered =
      sharedWork === undefined || works[0] === sharedWork
        ? works
        : [sharedWork, ...works.filter((work) => work !== sharedWork)];
    let routes: NativeScopeRouting[] | undefined;
    const rows = ordered.map((work, index): FeatureWorkResources => {
      const scope = featureScopeKey(work.scope);
      let route = this.scopes[index];
      if (
        !sameShared ||
        route?.scope !== scope ||
        route.names.length !== work.resources.length ||
        !work.resources.every((resource, index) => resource.name === route?.names[index])
      ) {
        const keys = new Map(
          shared.map((resource) => [resource.name, featureResourceKey('frame', resource.name)]),
        );
        const local = new Set<string>();
        const names: string[] = [];
        for (const resource of work.resources) {
          if (local.has(resource.name) || (work.scope !== 'frame' && keys.has(resource.name)))
            throw new Error('Duplicate native feature resource');
          local.add(resource.name);
          names.push(resource.name);
          keys.set(resource.name, featureResourceKey(work.scope, resource.name));
        }
        route = { scope, names: Object.freeze(names), keys };
      }
      if (route !== this.scopes[index] && routes === undefined)
        routes = this.scopes.slice(0, index);
      routes?.push(route);
      return {
        work,
        native: true,
        closure:
          work.scope === 'frame'
            ? work
            : { ...work, resources: [...shared, ...work.resources], passes: work.passes },
        keys: route.keys,
        resourceScopes: resourceScopesForWork(shared, work),
        resources: work.resources,
      };
    });
    if (!sameShared) this.shared = Object.freeze(shared.map((resource) => resource.name));
    if (routes !== undefined) this.scopes = routes;
    else if (this.scopes.length !== ordered.length)
      this.scopes = this.scopes.slice(0, ordered.length);
    return rows;
  }
}
