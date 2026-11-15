import { ResourceNotFoundError } from './errors';

const RESOURCE_ID = Symbol.for('forgeax.ecs.resource.identity');
declare const RESOURCE_VALUE: unique symbol;

export interface ResourceIdentity {
  readonly name: string;
  readonly [RESOURCE_ID]: true;
}

/** An invariant read/write resource identity. Names are diagnostic labels only. */
export interface Resource<T> extends ResourceIdentity {
  readonly [RESOURCE_VALUE]: (value: T) => T;
}

export function defineResource<T>(name: string): Resource<T> {
  if (name.length === 0) throw new RangeError('A resource requires a diagnostic name');
  return Object.freeze({ name, [RESOURCE_ID]: true as const }) as Resource<T>;
}

export interface ResourceEntry {
  value: unknown;
  added: number;
  changed: number;
}

export interface ResourceStore {
  readonly entries: Map<ResourceIdentity, ResourceEntry>;
}

export function createResourceStore(): ResourceStore {
  return { entries: new Map() };
}

export function assertResource(key: ResourceIdentity): void {
  if (typeof key !== 'object' || key === null || key[RESOURCE_ID] !== true)
    throw new TypeError('Use defineResource to create a resource token');
}

export function insertResource<T>(
  store: ResourceStore,
  key: Resource<T>,
  value: NoInfer<T>,
  epoch = 0,
): void {
  assertResource(key);
  const current = store.entries.get(key);
  if (current === undefined) store.entries.set(key, { value, added: epoch, changed: epoch });
  else {
    current.value = value;
    current.changed = epoch;
  }
}

export function getResource<T>(store: ResourceStore, key: Resource<T>): T {
  assertResource(key);
  const entry = store.entries.get(key);
  if (entry === undefined) throw new ResourceNotFoundError(key.name);
  return entry.value as T;
}

export function hasResource(store: ResourceStore, key: ResourceIdentity): boolean {
  assertResource(key);
  return store.entries.has(key);
}

export function removeResource(store: ResourceStore, key: ResourceIdentity): boolean {
  assertResource(key);
  return store.entries.delete(key);
}
