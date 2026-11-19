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

export function assertResource(key: ResourceIdentity): void {
  if (typeof key !== 'object' || key === null || key[RESOURCE_ID] !== true)
    throw new TypeError('Use defineResource to create a resource token');
}
