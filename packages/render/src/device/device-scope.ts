import { err, ok, type Result } from '@forgeax/engine-types';
import { LifecycleConstructionError } from '../errors/render';
import type { DeviceResourceKind, DeviceScopeReceipt } from './resource-types';

export {
  DEVICE_RESOURCE_KINDS,
  type DeviceResourceKind,
  type DeviceScopeReceipt,
} from './resource-types';

export type DeviceScopeState = 'active' | 'retiring' | 'retired' | 'abandoned' | 'disposed';

export interface ResourceRef<T> {
  readonly kind: DeviceResourceKind;
  readonly owner: string;
  readonly generation: number;
  readonly value: T;
  isCurrent(scope: DeviceScope): boolean;
  isStale(scope: DeviceScope): boolean;
}

export class DeviceResourceRef<T> implements ResourceRef<T> {
  readonly kind: DeviceResourceKind;
  readonly owner: string;
  readonly generation: number;
  readonly value: T;

  constructor(kind: DeviceResourceKind, owner: string, generation: number, value: T) {
    this.kind = kind;
    this.owner = owner;
    this.generation = generation;
    this.value = value;
  }

  isCurrent(scope: DeviceScope): boolean {
    return scope.accepts(this);
  }

  isStale(scope: DeviceScope): boolean {
    return !this.isCurrent(scope);
  }
}

interface OwnedResource {
  readonly ref: DeviceResourceRef<unknown>;
  readonly cleanup: (value: unknown) => void | Promise<void>;
}

function idempotentCleanup<T>(
  cleanup: (value: T) => void | Promise<void>,
): (value: T) => void | Promise<void> {
  let cleaned = false;
  return (value: T) => {
    if (cleaned) return;
    cleaned = true;
    return cleanup(value);
  };
}

export class DeviceScope {
  readonly generation: number;
  readonly owner: string;
  readonly parent: DeviceScope | undefined;
  private lifecycleState: DeviceScopeState = 'active';
  private readonly resources = new Map<ResourceRef<unknown>, OwnedResource>();
  private readonly children: DeviceScope[] = [];

  private constructor(generation: number, owner: string, parent?: DeviceScope) {
    this.generation = generation;
    this.owner = owner;
    this.parent = parent;
    parent?.children.push(this);
  }

  static create(generation: number, owner: string): DeviceScope {
    if (!Number.isSafeInteger(generation) || generation < 0) {
      throw new RangeError('DeviceScope generation must be a non-negative safe integer.');
    }
    if (owner.length === 0) throw new TypeError('DeviceScope owner must not be empty.');
    return new DeviceScope(generation, owner);
  }

  get state(): DeviceScopeState {
    return this.lifecycleState;
  }

  get childrenSnapshot(): readonly DeviceScope[] {
    return [...this.children];
  }

  /** Create a renderer-owned child scope without exposing a second device owner. */
  createChild(owner: string): DeviceScope {
    if (this.lifecycleState !== 'active') {
      throw new Error('Cannot create a child DeviceScope from an inactive scope.');
    }
    if (owner.length === 0) throw new TypeError('DeviceScope child owner must not be empty.');
    return new DeviceScope(this.generation, owner, this);
  }

  ref<T>(kind: DeviceResourceKind, value: T): ResourceRef<T> {
    const ref = new DeviceResourceRef(kind, this.owner, this.generation, value);
    this.resources.set(ref, { ref, cleanup: () => undefined });
    return ref;
  }

  accepts(ref: ResourceRef<unknown>): boolean {
    return (
      this.lifecycleState === 'active' &&
      ref.owner === this.owner &&
      ref.generation === this.generation
    );
  }

  isAlive(): boolean {
    return this.lifecycleState === 'active';
  }

  resourceDelta(): number {
    return this.resources.size;
  }

  /** @internal */
  _adopt<T>(
    kind: DeviceResourceKind,
    value: T,
    cleanup: (value: T) => void | Promise<void>,
  ): ResourceRef<T> {
    const ref = new DeviceResourceRef(kind, this.owner, this.generation, value);
    this.resources.set(ref, {
      ref,
      cleanup: idempotentCleanup(cleanup) as (resource: unknown) => void | Promise<void>,
    });
    return ref;
  }

  /** @internal Remove ownership only after the resource's cleanup succeeded. */
  _release(ref: ResourceRef<unknown>): void {
    this.resources.delete(ref);
  }

  /** @internal */
  _clearResources(): OwnedResource[] {
    const resources = [...this.resources.values()];
    this.resources.clear();
    for (const resource of resources.reverse()) {
      try {
        const pending = resource.cleanup(resource.ref.value);
        if (pending instanceof Promise) void pending.catch(() => undefined);
      } catch {
        // Synchronous scope termination is bounded; transaction cleanup owns
        // structured failure collection during construction and replacement.
      }
    }
    return resources;
  }

  /** Mark an active child as retiring without releasing in-flight resources. */
  beginRetire(): void {
    if (this.lifecycleState === 'active') this.lifecycleState = 'retiring';
  }

  private clearChildren(): void {
    for (const child of [...this.children].reverse()) {
      child.retire();
    }
  }

  private detachChild(child: DeviceScope): void {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
  }

  retire(): void {
    if (this.lifecycleState !== 'active' && this.lifecycleState !== 'retiring') return;
    this.lifecycleState = 'retiring';
    this.clearChildren();
    this._clearResources();
    this.lifecycleState = 'retired';
    this.parent?.detachChild(this);
  }

  abandon(): void {
    if (this.lifecycleState !== 'active') return;
    this.lifecycleState = 'abandoned';
    this.clearChildren();
    this._clearResources();
    this.parent?.detachChild(this);
  }

  dispose(): void {
    if (this.lifecycleState === 'disposed') return;
    this.lifecycleState = 'disposed';
    this.clearChildren();
    this._clearResources();
    this.parent?.detachChild(this);
  }

  async replace(
    generation: number,
    resources: readonly LifecycleResourceSpec<unknown>[],
  ): Promise<LifecycleResult> {
    const replacement = new DeviceScope(generation, this.owner, this);
    const transaction = new LifecycleTransaction(replacement);
    for (const resource of resources) transaction.add(resource);
    const result = await transaction.commit();
    if (!result.ok) {
      replacement.abandon();
      return result;
    }
    if (!this.isAlive()) {
      replacement.dispose();
      return transaction.failure('dispose');
    }
    // The replacement is now the new owner. Detach it before retiring the
    // old parent so parent cleanup cannot retire the just-published child.
    this.detachChild(replacement);
    this.retire();
    return ok(replacement);
  }

  /** @internal */
  _receipt(): DeviceScopeReceipt {
    return {
      owner: this.owner,
      generation: this.generation,
      resourceCount: this.resources.size,
    };
  }
}

export function adoptBackendDevice<T>(
  scope: DeviceScope,
  device: T,
  dispose: ((device: T) => void | Promise<void>) | undefined,
): void {
  if (dispose !== undefined) scope._adopt('device', device, dispose);
}

export interface LifecycleResourceSpec<T> {
  readonly kind: DeviceResourceKind;
  readonly create: () => T | Promise<T>;
  readonly cleanup: (value: T) => void | Promise<void>;
}

export interface LifecycleCleanupFailure {
  readonly resourceKind: DeviceResourceKind;
  readonly cause: unknown;
}

export interface LifecycleFailure {
  readonly primary: LifecycleConstructionError;
  readonly cleanupFailures: readonly LifecycleCleanupFailure[];
  readonly receipt: DeviceScopeReceipt;
}

export type LifecycleResult = Result<DeviceScope, LifecycleFailure>;

export interface LifecycleTransactionOptions {
  readonly failureAt?: number;
}

interface CreatedResource {
  readonly spec: LifecycleResourceSpec<unknown>;
  readonly value: unknown;
  readonly cleanup: (value: unknown) => void | Promise<void>;
}

export class LifecycleTransaction {
  private readonly resources: LifecycleResourceSpec<unknown>[] = [];
  private readonly options: LifecycleTransactionOptions;
  private committed = false;

  constructor(
    private readonly scope: DeviceScope,
    options: LifecycleTransactionOptions = {},
  ) {
    this.options = options;
  }

  add<T>(spec: LifecycleResourceSpec<T>): this {
    if (this.committed) throw new Error('LifecycleTransaction is already committed.');
    this.resources.push(spec as LifecycleResourceSpec<unknown>);
    return this;
  }

  async commit(): Promise<LifecycleResult> {
    if (this.committed) return this.failure('create');
    this.committed = true;
    const created: CreatedResource[] = [];
    for (let index = 0; index < this.resources.length; index += 1) {
      const spec = this.resources[index];
      if (spec === undefined) continue;
      try {
        if (this.options.failureAt === index + 1) {
          throw new Error(`injected lifecycle failure at ${index + 1}`);
        }
        const value = await spec.create();
        if (!this.scope.isAlive()) {
          await this.cleanupOne(value, created, idempotentCleanup(spec.cleanup));
          return this.failure('dispose');
        }
        created.push({ spec, value, cleanup: idempotentCleanup(spec.cleanup) });
      } catch (cause) {
        const cleanupFailures = await this.cleanupCreated(created);
        return this.failure('create', spec.kind, cleanupFailures, cause);
      }
    }
    if (!this.scope.isAlive()) {
      const cleanupFailures = await this.cleanupCreated(created);
      return this.failure('dispose', this.resources.at(-1)?.kind ?? 'listener', cleanupFailures);
    }
    for (const item of created) this.scope._adopt(item.spec.kind, item.value, item.spec.cleanup);
    return ok(this.scope);
  }

  failure(
    operation: 'create' | 'dispose',
    resourceKind: DeviceResourceKind = this.resources.at(-1)?.kind ?? 'listener',
    cleanupFailures: readonly LifecycleCleanupFailure[] = [],
    cause: unknown = undefined,
  ): LifecycleResult {
    return err({
      primary: new LifecycleConstructionError({
        owner: this.scope.owner,
        generation: this.scope.generation,
        operation,
        resourceKind,
        cause,
        cleanupFailures,
        receipt: this.scope._receipt(),
      }),
      cleanupFailures,
      receipt: this.scope._receipt(),
    });
  }

  private async cleanupCreated(
    created: readonly CreatedResource[],
  ): Promise<LifecycleCleanupFailure[]> {
    const failures: LifecycleCleanupFailure[] = [];
    for (let index = created.length - 1; index >= 0; index -= 1) {
      const item = created[index];
      if (item === undefined) continue;
      try {
        await item.cleanup(item.value);
      } catch (cause) {
        failures.push({ resourceKind: item.spec.kind, cause });
      }
    }
    return failures;
  }

  private async cleanupOne(
    value: unknown,
    created: readonly CreatedResource[],
    cleanup: (value: unknown) => void | Promise<void>,
  ): Promise<void> {
    await this.cleanupCreated(created);
    try {
      await cleanup(value);
    } catch {
      // The terminal dispose result is intentionally bounded; prior cleanup
      // evidence remains in the transaction failure shape.
    }
  }
}
