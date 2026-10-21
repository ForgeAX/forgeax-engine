import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import {
  type AssetError,
  type AssetHandle,
  type AssetReferenceOwner,
  err,
  type NavigationMeshAsset,
  ok,
  type Result,
  type ResultOk,
} from '@forgeax/engine-types';
import { invalidInput, type NavigationError } from './errors';
import { createNavigationMesh, type NavigationMesh } from './navmesh';

type SurfaceError = NavigationError | AssetError;

/** One active reference and its derived query data; no character or asset roster. */
export class NavigationSurface {
  version: string;
  private disposed = false;

  private constructor(
    private readonly owner: AssetReferenceOwner,
    private handle: AssetHandle<'navigation-mesh'>,
    private revision: number,
    private prepared: ResultOk<NavigationMesh>,
  ) {
    this.version = `${handle}:${revision}`;
  }

  static create(
    owner: AssetReferenceOwner | undefined,
    handle: AssetHandle<'navigation-mesh'>,
  ): Result<NavigationSurface, SurfaceError> {
    if (owner === undefined)
      return err(invalidInput('World.assets', undefined, 'Bind the owning runtime asset service'));
    const records = runtimeAssets(owner);
    const held = owner.retain(handle, 'navigation-mesh');
    if (!held.ok) return held;
    const revision = records.version(handle);
    if (!revision.ok) {
      owner.release(handle).unwrap();
      return revision;
    }
    const content = records.resolveAsset<NavigationMeshAsset>(handle);
    const prepared = content.ok ? createNavigationMesh(content.value) : content;
    if (!prepared.ok) {
      owner.release(handle).unwrap();
      return prepared;
    }
    return ok(new NavigationSurface(owner, handle, revision.value, prepared));
  }

  /** Called only by an actual query or motor step; unchanged content reuses its BVH. */
  current(): Result<NavigationMesh, SurfaceError> {
    const records = runtimeAssets(this.owner);
    const revision = records.version(this.handle);
    if (!revision.ok) return revision;
    if (revision.value === this.revision) return this.prepared;
    const content = records.resolveAsset<NavigationMeshAsset>(this.handle);
    const prepared = content.ok ? createNavigationMesh(content.value) : content;
    if (!prepared.ok) return prepared;
    this.prepared = prepared;
    this.revision = revision.value;
    this.version = `${this.handle}:${revision.value}`;
    return prepared;
  }

  replace(handle: AssetHandle<'navigation-mesh'>): Result<void, SurfaceError> {
    if (handle === this.handle) {
      const current = this.current();
      return current.ok ? ok(undefined) : current;
    }
    const candidate = NavigationSurface.create(this.owner, handle);
    if (!candidate.ok) return candidate;
    const previous = this.handle;
    this.handle = candidate.value.handle;
    this.revision = candidate.value.revision;
    this.prepared = candidate.value.prepared;
    this.version = candidate.value.version;
    this.owner.release(previous).unwrap();
    return ok(undefined);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // The gameplay owner may already have retired the complete World scope.
    if (this.owner.validate(this.handle).ok) this.owner.release(this.handle).unwrap();
  }
}
