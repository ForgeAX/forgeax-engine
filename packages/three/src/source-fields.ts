type Notify = () => void;
type Listeners = Notify | Map<Notify, number>;
interface FieldAccess {
  readonly key: string;
  readonly offset: number;
  owners: number;
  get(this: object): unknown;
  set(this: object, value: unknown): void;
}

// One packed row per observed object. Each live field occupies three references:
// shared accessor, current value, and listeners. The common single owner needs no Map.
const rows = new WeakMap<object, unknown[]>();
const stride = 3;
const inherited = Symbol();
const shapes = new Map<string, Map<number, FieldAccess>>();
const byGetter = new WeakMap<() => unknown, FieldAccess>();

function fieldAccess(key: string, offset: number): FieldAccess {
  let offsets = shapes.get(key);
  if (!offsets) {
    offsets = new Map();
    shapes.set(key, offsets);
  }
  const previous = offsets.get(offset);
  if (previous) return previous;
  const access: FieldAccess = {
    key,
    offset,
    owners: 0,
    get(this: object) {
      for (let owner: object | null = this; owner; owner = Object.getPrototypeOf(owner)) {
        const row = rows.get(owner);
        if (row?.[offset] === access) {
          const value = row[offset + 1];
          return value === inherited ? Reflect.get(Object.getPrototypeOf(owner), key) : value;
        }
      }
      return undefined;
    },
    set(this: object, value: unknown) {
      const row = rows.get(this);
      if (row?.[offset] !== access) {
        Object.defineProperty(this, key, {
          value,
          writable: true,
          configurable: true,
          enumerable: true,
        });
        return;
      }
      const old = row[offset + 1];
      if (Object.is(old, value)) return;
      if (old === inherited) Object.defineProperty(this, key, { enumerable: true });
      row[offset + 1] = value;
      const listeners = row[offset + 2] as Listeners;
      if (typeof listeners === 'function') listeners();
      else for (const notify of listeners.keys()) notify();
    },
  };
  offsets.set(offset, access);
  byGetter.set(access.get, access);
  return access;
}

/** Enrollment grows rows incrementally. Trim spare slots once the object is admitted. */
export function compactFieldRow(object: object): void {
  const row = rows.get(object);
  if (row) rows.set(object, row.slice());
}

export function ownSourceValue(object: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor === undefined || 'value' in descriptor) return descriptor?.value;
  const access = descriptor.get && byGetter.get(descriptor.get);
  const row = rows.get(object);
  if (!access || access.key !== key || row?.[access.offset] !== access) return undefined;
  const value = row[access.offset + 1];
  return value === inherited ? undefined : value;
}

/** A write observer on a missing field does not declare an authored input. */
export function hasSourceField(object: object, key: string): boolean {
  for (let owner: object | null = object; owner; owner = Object.getPrototypeOf(owner)) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (descriptor === undefined) continue;
    const access = descriptor.get && byGetter.get(descriptor.get);
    if (access && rows.get(owner)?.[access.offset + 1] === inherited) continue;
    return true;
  }
  return false;
}

export function observedData(
  object: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor,
): boolean {
  if ('value' in descriptor) return true;
  const access = descriptor.get && byGetter.get(descriptor.get);
  return !!access && access.key === key && rows.get(object)?.[access.offset] === access;
}

export function observeField(
  object: object,
  key: string,
  notify: Notify,
  allowInherited = false,
): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  const row = rows.get(object);
  if (descriptor && !('value' in descriptor)) {
    const access = descriptor.get && byGetter.get(descriptor.get);
    if (!access || access.key !== key || row?.[access.offset] !== access) return false;
    const index = access.offset + 2;
    let listeners = row[index] as Listeners;
    if (typeof listeners === 'function') row[index] = listeners = new Map([[listeners, 1]]);
    listeners.set(notify, (listeners.get(notify) ?? 0) + 1);
    return true;
  }
  if (
    descriptor
      ? !descriptor.configurable || !descriptor.writable
      : !(allowInherited && Object.isExtensible(object))
  )
    return false;
  if (!descriptor) {
    for (let proto = Object.getPrototypeOf(object); proto; proto = Object.getPrototypeOf(proto)) {
      const field = Object.getOwnPropertyDescriptor(proto, key);
      if (field) {
        if (!('value' in field) || !field.writable) return false;
        break;
      }
    }
  }
  const size = row?.length ?? 0;
  let offset = size;
  for (let i = 0; row && i < size; i += stride) {
    const active = row[i] as FieldAccess | undefined;
    if (active?.key === key) return false;
    if (!active && offset === row.length) offset = i;
  }
  const access = fieldAccess(key, offset);
  Object.defineProperty(object, key, {
    configurable: true,
    enumerable: descriptor?.enumerable === true,
    get: access.get,
    set: access.set,
  });
  const value = descriptor ? descriptor.value : inherited;
  if (row) {
    row[offset] = access;
    row[offset + 1] = value;
    row[offset + 2] = notify;
  } else rows.set(object, [access, value, notify]);
  access.owners++;
  return true;
}

export function releaseField(object: object, key: string, notify: Notify): void {
  const row = rows.get(object);
  if (!row) return;
  for (let i = 0; i < row.length; i += stride) {
    const access = row[i] as FieldAccess | undefined;
    if (access?.key !== key) continue;
    const listeners = row[i + 2] as Listeners;
    if (typeof listeners === 'function') {
      if (listeners !== notify) return;
    } else {
      const count = listeners.get(notify) ?? 0;
      if (count > 1) listeners.set(notify, count - 1);
      else listeners.delete(notify);
      if (listeners.size) {
        if (listeners.size === 1) {
          for (const [listener, references] of listeners)
            if (references === 1) row[i + 2] = listener;
        }
        return;
      }
    }
    const current = Object.getOwnPropertyDescriptor(object, key);
    if (current?.get === access.get && current.configurable) {
      const value = row[i + 1];
      if (value === inherited) Reflect.deleteProperty(object, key);
      else
        Object.defineProperty(object, key, {
          configurable: true,
          enumerable: current.enumerable === true,
          writable: true,
          value,
        });
    }
    row[i] = row[i + 1] = row[i + 2] = undefined;
    while (row.length && row[row.length - stride] === undefined) row.length -= stride;
    if (!row.length) rows.delete(object);
    if (--access.owners === 0) {
      const offsets = shapes.get(key);
      offsets?.delete(i);
      if (!offsets?.size) shapes.delete(key);
    }
    return;
  }
}

export function subscribe(
  object: object,
  key: string,
  notify: Notify,
  allowInherited = false,
): Notify | undefined {
  if (observeField(object, key, notify, allowInherited))
    return () => releaseField(object, key, notify);
  return undefined;
}

// TRS components change and retire together. Shared accessors preserve the original
// vector identity and require one subscription per consumer for the entire tuple.
type PoseStorage = { [slot: symbol]: number };
const poseListeners = new WeakMap<object, Notify | Set<Notify>>();
function tupleLayout(keys: readonly string[]) {
  const descriptors: PropertyDescriptorMap = {};
  const fields = keys.map((key) => {
    const slot = Symbol(key);
    function get(this: PoseStorage) {
      return this[slot];
    }
    function set(this: PoseStorage, value: number) {
      if (!Object.hasOwn(this, slot)) {
        Object.defineProperty(this, key, {
          value,
          writable: true,
          enumerable: true,
          configurable: true,
        });
        return;
      }
      const old = this[slot];
      this[slot] = value;
      if (Object.is(old, value)) return;
      const listeners = poseListeners.get(this);
      if (typeof listeners === 'function') listeners();
      else if (listeners) for (const listener of listeners) listener();
    }
    descriptors[slot] = { value: 0, configurable: true, writable: true };
    descriptors[key] = { get, set, enumerable: true, configurable: true };
    return { key, slot, get, set };
  });
  const first = fields[0];
  if (!first) throw new Error('Pose layout requires at least one axis');
  return { fields, descriptors, firstSlot: first.slot };
}
const xyz = tupleLayout(['x', 'y', 'z']);
const xyzw = tupleLayout(['_x', '_y', '_z', '_w']);

/** Called before the pinned Object3D pose constructor assigns its ordinary component values. */
export function initializePoseLayout(vector: object, quaternion: boolean): void {
  Object.defineProperties(vector, (quaternion ? xyzw : xyz).descriptors);
}

function observePoseTuple(vector: object, quaternion: boolean, notify: Notify): boolean {
  const storage = vector as PoseStorage;
  const layout = quaternion ? xyzw : xyz;
  const prepared = Object.hasOwn(vector, layout.firstSlot);
  if (!prepared && !Object.isExtensible(vector)) return false;
  for (const { key, slot, get, set } of layout.fields) {
    const field = Object.getOwnPropertyDescriptor(vector, key);
    if (!field?.enumerable || !field.configurable) return false;
    if (prepared) {
      if (field.get !== get || field.set !== set || typeof storage[slot] !== 'number') return false;
    } else if (!field.writable || typeof field.value !== 'number') return false;
  }
  if (!prepared) {
    for (const { key, slot, get, set } of layout.fields) {
      const value = Reflect.get(vector, key);
      Object.defineProperty(vector, slot, { value, writable: true, configurable: true });
      Object.defineProperty(vector, key, { get, set, configurable: true, enumerable: true });
    }
  }
  const listeners = poseListeners.get(vector);
  if (!listeners) poseListeners.set(vector, notify);
  else if (typeof listeners === 'function') {
    if (notify !== listeners) poseListeners.set(vector, new Set([listeners, notify]));
  } else listeners.add(notify);
  return true;
}

function releasePoseTuple(vector: object, quaternion: boolean, notify: Notify): void {
  const listeners = poseListeners.get(vector);
  if (listeners instanceof Set) {
    listeners.delete(notify);
    if (listeners.size) return;
  } else if (listeners !== notify) return;
  poseListeners.delete(vector);
  for (const { key, slot, get } of (quaternion ? xyzw : xyz).fields) {
    const field = Object.getOwnPropertyDescriptor(vector, key);
    if (field?.get === get && field.configurable)
      Object.defineProperty(vector, key, {
        enumerable: true,
        configurable: true,
        writable: true,
        value: (vector as PoseStorage)[slot],
      });
    Reflect.deleteProperty(vector, slot);
  }
}

export function observeScale(scale: object, notify: Notify): Notify | undefined {
  if (observePoseTuple(scale, false, notify)) return () => releasePoseTuple(scale, false, notify);
  return undefined;
}

export function observePose(
  position: object,
  scale: object,
  quaternion: object,
  translated: Notify,
  changed: Notify,
  hold: (release: Notify) => void,
): boolean {
  if (!observePoseTuple(position, false, translated)) return false;
  const hasScale = observePoseTuple(scale, false, changed);
  const complete = hasScale && observePoseTuple(quaternion, true, changed);
  hold(() => {
    releasePoseTuple(position, false, translated);
    if (hasScale) releasePoseTuple(scale, false, changed);
    if (complete) releasePoseTuple(quaternion, true, changed);
  });
  return complete;
}
