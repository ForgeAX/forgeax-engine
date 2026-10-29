/** Snapshot finite native descriptor dictionaries while preserving ordered slots. */
export function snapshotPipelineDescriptor(value: unknown, depth = 0): unknown {
  if (depth > 24) throw new Error('Pipeline descriptor nesting exceeds 24');
  if (
    value === undefined ||
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  )
    return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object')
    throw new Error('Pipeline descriptor must contain finite POD values');
  if (Array.isArray(value)) return snapshotArray(value, depth);
  return snapshotObject(value, depth);
}

function snapshotArray(value: readonly unknown[], depth: number): unknown[] {
  const result: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = Object.getOwnPropertyDescriptor(value, String(i));
    if (item === undefined || !('value' in item))
      throw new Error('Pipeline array requires data slots');
    result.push(snapshotPipelineDescriptor(item.value, depth + 1));
  }
  return result;
}

function snapshotObject(value: object, depth: number): Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error('Unknown native pipeline dependency');
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype')
      throw new Error('Invalid descriptor key');
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (property === undefined || !('value' in property))
      throw new Error('Pipeline descriptor requires plain data');
    const child = snapshotPipelineDescriptor(property.value, depth + 1);
    if (child !== undefined) result[key] = child;
  }
  return result;
}

/** Shared producer/runtime spelling. Labels are stripped only by their owner. */
export function pipelineDescriptorJson(value: unknown): string {
  return JSON.stringify(snapshotPipelineDescriptor(value));
}
