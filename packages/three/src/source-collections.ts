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
const subscribers = new WeakMap<object, Listener | Set<Listener>>();
function notify(raw: object, edit: CollectionEdit, item?: unknown) {
  const listeners = subscribers.get(raw);
  if (typeof listeners === 'function') listeners(edit, item);
  else if (listeners) for (const listener of listeners) listener(edit, item);
}
const handler: ProxyHandler<object> = {
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
};
/** Injected at pinned r187 allocation sites in the private bundled copy of Three. */
export function ownedCollection<T extends object>(target: T): T {
  if (users === 0) return target;
  const proxy = new Proxy(target, handler) as T;
  collections.set(proxy, target);
  return proxy;
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
  if (!raw) return;
  const listeners = subscribers.get(raw);
  if (!listeners) subscribers.set(raw, notify);
  else if (typeof listeners === 'function') subscribers.set(raw, new Set([listeners, notify]));
  else listeners.add(notify);
  return () => {
    const current = subscribers.get(raw);
    if (current === notify) subscribers.delete(raw);
    else if (current instanceof Set) {
      current.delete(notify);
      if (!current.size) subscribers.delete(raw);
      else if (current.size === 1) for (const remaining of current) subscribers.set(raw, remaining);
    }
  };
}

/** Storage for internal stock matrix operations. The caller keeps the public array attached. */
export function matrixStorage<T extends number[]>(elements: T): T {
  return (collections.get(elements) as T | undefined) ?? elements;
}

/** Stock Matrix4 kernels notify the same subscribers as a direct element edit. */
export function publishMatrixWrite(elements: number[], storage: number[]): void {
  if (elements !== storage) notify(storage, 'other');
}

// Internal matrix kernels bypass array proxy traps. Dependents subscribe to
// publication even when another renderer owns the producing scene.
const worldReaders = new WeakMap<object, Set<() => void>>();
let worldReaderCount = 0;

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
  let readers = worldReaders.get(elements);
  if (!readers) {
    readers = new Set();
    worldReaders.set(elements, readers);
  }
  readers.add(dirty);
  worldReaderCount++;
  return () => {
    readers.delete(dirty);
    if (!readers.size) worldReaders.delete(elements);
    worldReaderCount--;
  };
}

export function publishWorldMatrix(elements: number[]): void {
  if (!worldReaderCount) return;
  const readers = worldReaders.get(elements);
  if (readers) for (const dirty of readers) dirty();
}
