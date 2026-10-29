import { pipelineDescriptorJson, snapshotPipelineDescriptor } from '@forgeax/engine-types';

/** @internal Cold, immutable native state. Modules and layout are bound by the device. */
export class PipelineRecipeState {
  readonly #admitted = true;
  readonly key: string;
  readonly value: Readonly<Record<string, unknown>>;

  constructor(
    readonly kind: 'render' | 'compute',
    state: Record<string, unknown>,
  ) {
    if ('layout' in state || 'label' in state)
      throw new Error('Pipeline state excludes handles and labels');
    for (const stage of ['vertex', 'fragment', 'compute']) {
      const value = state[stage];
      if (value !== undefined && typeof value === 'object' && value !== null && 'module' in value)
        throw new Error('Pipeline state excludes shader handles');
    }
    const snapshot = snapshotPipelineDescriptor(state) as Record<string, unknown>;
    const freeze = (value: unknown): void => {
      if (value === null || typeof value !== 'object') return;
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    };
    freeze(snapshot);
    this.value = snapshot;
    this.key = pipelineDescriptorJson(snapshot);
    Object.freeze(this);
  }

  /** Compare a lazy projection using the same POD equality as the cold snapshot:
   * absent/undefined object values are omitted; array slots and null stay ordered. */
  matches(fields: Iterable<readonly [string, unknown]>): boolean {
    let count = 0;
    for (const [key, value] of fields) {
      if (value === undefined) continue;
      count++;
      if (!Object.hasOwn(this.value, key) || !sameFact(this.value[key], value)) return false;
    }
    return count === Object.keys(this.value).length;
  }

  static is(value: unknown): value is PipelineRecipeState {
    return value !== null && typeof value === 'object' && #admitted in value;
  }
}

/** @internal The same decomposition is used by raw requests and managed admission. */
export function pipelineDescriptorState(
  kind: 'render' | 'compute',
  descriptor: Record<string, unknown>,
): PipelineRecipeState {
  const { layout: _layout, label: _label, ...state } = descriptor;
  for (const stage of ['vertex', 'fragment', 'compute']) {
    const value = state[stage];
    if (value !== undefined) {
      const { module: _module, ...facts } = value as Record<string, unknown>;
      state[stage] = facts;
    }
  }
  return new PipelineRecipeState(kind, state);
}

function sameFact(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object')
    return false;
  if (Array.isArray(left)) return sameArray(left, right);
  if (Array.isArray(right)) return false;
  return sameObject(left as Record<string, unknown>, right);
}

function sameArray(left: readonly unknown[], right: object): boolean {
  if (!Array.isArray(right) || left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    const field = Object.getOwnPropertyDescriptor(right, String(i));
    if (field === undefined || !('value' in field) || !sameFact(left[i], field.value)) return false;
  }
  return true;
}

function sameObject(left: Record<string, unknown>, right: object): boolean {
  const prototype = Object.getPrototypeOf(right);
  if (prototype !== Object.prototype && prototype !== null) return false;
  let count = 0;
  for (const key of Object.keys(right)) {
    const field = Object.getOwnPropertyDescriptor(right, key);
    if (field === undefined || !('value' in field)) return false;
    if (field.value === undefined) continue;
    count++;
    if (!Object.hasOwn(left, key) || !sameFact((left as Record<string, unknown>)[key], field.value))
      return false;
  }
  return count === Object.keys(left).length;
}
