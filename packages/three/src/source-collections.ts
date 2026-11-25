import { WorldMatrixRow, worldMatrixRow } from './world-matrix-storage';

/** Only future facade-owned containers opt in. Existing references always keep their identity. */
let users = 0;
export function enableThreeSourceTracking(): () => void {
  users++;
  let active = true;
  return () => {
    if (active) users--;
    active = false;
  };
}

// Only the three internal Object3D pose allocations carry this private constructor argument.
export const poseConstruction = Symbol();
export function creatingTrackedPose(token: unknown): boolean {
  return token === poseConstruction && users > 0;
}

type CollectionEdit = 'append' | 'delete-tail' | 'shrink-one' | 'unchanged-length' | 'other';
type Listener = (edit: CollectionEdit, item?: unknown) => void;
const collections = new WeakMap<object, object>();
// A live source usually has one reader. Count repeated attachments to the same
// callback so either consumer can detach independently.
type SourceObservers<T> = WeakMap<object, T | Map<T, number>>;

function attach<T extends (...args: never[]) => void>(
  observers: SourceObservers<T>,
  source: object,
  listener: T,
): () => void {
  const current = observers.get(source);
  if (current === undefined) observers.set(source, listener);
  else {
    const readers = typeof current === 'function' ? new Map([[current, 1]]) : current;
    readers.set(listener, (readers.get(listener) ?? 0) + 1);
    if (readers !== current) observers.set(source, readers);
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const readers = observers.get(source);
    if (!(readers instanceof Map)) {
      observers.delete(source);
      return;
    }
    const count = readers.get(listener) as number;
    if (count > 1) readers.set(listener, count - 1);
    else readers.delete(listener);
    if (readers.size === 1) {
      for (const [remaining, references] of readers)
        if (references === 1) observers.set(source, remaining);
    }
  };
}

const subscribers: SourceObservers<Listener> = new WeakMap();
function notify(raw: object, edit: CollectionEdit, item?: unknown) {
  const listeners = subscribers.get(raw);
  if (typeof listeners === 'function') listeners(edit, item);
  else if (listeners) for (const listener of listeners.keys()) listener(edit, item);
}
const handler = {
  defineProperty(raw, key, desc) {
    const length = Array.isArray(raw) ? raw.length : -1;
    const append = length >= 0 && key === String(length) && 'value' in desc;
    const sameLength = key === 'length' && desc.value === length;
    const shrink = key === 'length' && desc.value === length - 1;
    const ok = Reflect.defineProperty(raw, key, desc);
    if (ok)
      notify(
        raw,
        append ? 'append' : sameLength ? 'unchanged-length' : shrink ? 'shrink-one' : 'other',
        desc.value,
      );
    return ok;
  },
  deleteProperty(raw, key) {
    const previous = Object.getOwnPropertyDescriptor(raw, key);
    const tail = Array.isArray(raw) && key === String(raw.length - 1);
    const ok = Reflect.deleteProperty(raw, key);
    if (ok && previous) notify(raw, tail ? 'delete-tail' : 'other', previous.value);
    return ok;
  },
} satisfies ProxyHandler<object>;

// Dense matrix inputs can be read by stock kernels. Retire that privilege when a caller
// installs accessors, creates holes, or changes the prototype. The public proxy stays live.
const stockMatrixStorage = new WeakSet<object>();
const customReads = new WeakSet<object>();
const matrixHandler: ProxyHandler<object> = {
  defineProperty(raw, key, desc) {
    if ('get' in desc || 'set' in desc || key === 'length') customReads.add(raw);
    return handler.defineProperty(raw, key, desc);
  },
  deleteProperty(raw, key) {
    customReads.add(raw);
    return handler.deleteProperty(raw, key);
  },
  setPrototypeOf(raw, proto) {
    customReads.add(raw);
    return Reflect.setPrototypeOf(raw, proto);
  },
};

/** Injected at pinned r187 allocation sites in the private bundled copy of Three. */
export function ownedCollection<T extends object>(
  target: T,
  traps: ProxyHandler<object> = handler,
): T {
  if (users === 0) return target;
  const proxy = new Proxy(target, traps) as T;
  collections.set(proxy, target);
  return proxy;
}

export function ownedMatrixElements(elements: number[]): number[] {
  if (users > 0) stockMatrixStorage.add(elements);
  return ownedCollection(elements, matrixHandler);
}

export function ownedWorldMatrixElements(elements: number[]): number[] {
  if (users === 0) return elements;
  const row = new WorldMatrixRow(elements);
  row.elements = ownedCollection(row.view, matrixHandler);
  return row.elements;
}

/** Hierarchy reads are ordinary on-object loads; only writes consult the active readers. */
function hierarchyField(key: 'parent' | 'children') {
  const value = Symbol(key);
  const readers: SourceObservers<() => void> = new WeakMap();
  type Storage = { [value]: unknown };
  function get(this: Storage) {
    return this[value];
  }
  function set(this: Storage, next: unknown) {
    if (!Object.hasOwn(this, value)) {
      Object.defineProperty(this, key, {
        value: next,
        writable: true,
        configurable: true,
        enumerable: true,
      });
      return;
    }
    if (this[value] === next) return;
    this[value] = next;
    const listeners = readers.get(this);
    if (typeof listeners === 'function') listeners();
    else if (listeners) for (const notify of listeners.keys()) notify();
  }
  return { key, value, readers, get, set };
}
const parentLink = hierarchyField('parent');
const childList = hierarchyField('children');
const hierarchyFields = [parentLink, childList] as const;

export function initializeSourceHierarchy(node: object): void {
  if (!trackedObjects.has(node)) return;
  for (const field of hierarchyFields) {
    const descriptor = Object.getOwnPropertyDescriptor(node, field.key);
    if (!descriptor?.writable || !descriptor.configurable || !descriptor.enumerable) continue;
    Object.defineProperty(node, field.value, {
      value: descriptor.value,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(node, field.key, {
      get: field.get,
      set: field.set,
      configurable: true,
      enumerable: true,
    });
  }
}

function hierarchyFieldFor(key: PropertyKey, descriptor: PropertyDescriptor) {
  const field = key === 'parent' ? parentLink : key === 'children' ? childList : undefined;
  return field && descriptor.get === field.get && descriptor.set === field.set ? field : undefined;
}

export function hierarchyStorageKey(
  key: PropertyKey,
  descriptor: PropertyDescriptor,
): symbol | undefined {
  return hierarchyFieldFor(key, descriptor)?.value;
}

export function watchSourceHierarchy(node: object, key: string, notify: () => void) {
  if (key !== 'parent' && key !== 'children') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(node, key);
  const field = descriptor && hierarchyFieldFor(key, descriptor);
  return field && attach(field.readers, node, notify);
}

const trackedObjects = new WeakSet<object>();
export function ownedChildren<T extends object>(owner: object, children: T): T {
  if (users > 0) trackedObjects.add(owner);
  return ownedCollection(children);
}
export function createdTracked(owner: object): boolean {
  return trackedObjects.has(owner);
}

export function ownsCollection(value: object): boolean {
  return collections.has(value);
}

export function watchCollection(value: object, notify: Listener): (() => void) | undefined {
  const raw = collections.get(value);
  return raw === undefined ? undefined : attach(subscribers, raw, notify);
}

/** Stock kernels can read the same backing array without invoking the write observer.
 * A caller-owned array or proxy keeps its original access semantics. */
export function sourceCollectionStorage<T extends object>(value: T): T {
  return (collections.get(value) as T | undefined) ?? value;
}

/** Only owned data slots can establish a primitive local input after composition. */
export function primitiveMatrixValues(elements: number[], storage: number[]): boolean {
  if (
    !stockMatrixStorage.has(storage) ||
    collections.get(elements) !== storage ||
    customReads.has(storage) ||
    storage.length !== 16
  )
    return false;
  for (let i = 0; i < 16; i++) if (typeof storage[i] !== 'number') return false;
  return true;
}

/** Bulk input kernels may unwrap dense matrix data. Custom reads retain the public receiver. */
export function matrixReadStorage<T extends object>(value: T): T {
  const raw = collections.get(value);
  return raw !== undefined && !customReads.has(raw) ? (raw as T) : value;
}

/** Select one operand exactly when its scalar reads begin. Another operand may
 * have installed accessors since the Matrix4 operation read the elements fields. */
export function worldMatrixInput(elements: number[]): number[] | Float64Array {
  const source = matrixReadStorage(elements);
  const row = worldMatrixRow(source);
  return row?.dense ?? row?.elements ?? source;
}

/** Stock Matrix4 kernels notify the same subscribers as a direct element edit. */
export function publishMatrixWrite(elements: number[], storage: number[]): void {
  if (elements !== storage) notify(storage, 'other');
}

// Internal matrix kernels bypass array proxy traps. Dependents subscribe to
// publication even when another renderer owns the producing scene.
const worldReaders: SourceObservers<() => void> = new WeakMap();

export function watchTargetMatrix(elements: number[], dirty: () => void): (() => void) | undefined {
  const stop = watchCollection(elements, dirty);
  if (!stop) return;
  const detach = watchPublishedWorldMatrix(elements, dirty);
  return () => {
    stop();
    detach();
  };
}

export function watchPublishedWorldMatrix(elements: number[], dirty: () => void): () => void {
  return attach(worldReaders, elements, dirty);
}

export function publishWorldMatrix(elements: number[]): void {
  const readers = worldReaders.get(elements);
  if (typeof readers === 'function') readers();
  else if (readers) for (const dirty of readers.keys()) dirty();
}
