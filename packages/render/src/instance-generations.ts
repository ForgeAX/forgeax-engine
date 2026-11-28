/** An instance generation identifies the submitted pose even when the row moves. */
interface GenerationRange {
  readonly kind: 'range';
  readonly first: number;
  readonly length: number;
}

interface GenerationSlots {
  readonly kind: 'slots';
  readonly first: number;
  /** Zero is absent, otherwise the previous ordinal plus one. */
  readonly positions: Uint32Array;
}

interface SortedGenerations {
  readonly kind: 'sorted';
  readonly values: Uint32Array;
  /** Present only when the authored order differs from generation order. */
  readonly ordinals?: Uint32Array;
}

interface HashedGenerations {
  readonly kind: 'hashed';
  readonly values: Uint32Array;
  readonly positions: Uint32Array;
}

type GenerationOrder = GenerationRange | GenerationSlots | SortedGenerations | HashedGenerations;
const issuedOrder = Symbol('issued instance generations');
type GenerationColumn = Uint32Array & { readonly [issuedOrder]?: GenerationOrder | null };

function measureOrder(values: Uint32Array): GenerationOrder | null {
  const count = values.length;
  if (count === 0) return { kind: 'range', first: 0, length: 0 };
  let min = values[0] as number;
  let max = min;
  let last = min;
  let ascending = true;
  for (let i = 1; i < count; i++) {
    const value = values[i] as number;
    ascending &&= value > last;
    min = Math.min(min, value);
    max = Math.max(max, value);
    last = value;
  }
  if (min === 0) return null;
  const span = max - min + 1;
  if (ascending) {
    return span === count
      ? { kind: 'range', first: min, length: count }
      : { kind: 'sorted', values };
  }
  if (span < count) return null;
  if (span <= count * 2) {
    const positions = new Uint32Array(span);
    for (let i = 0; i < count; i++) {
      const key = (values[i] as number) - min;
      if (positions[key] !== 0) return null;
      positions[key] = i + 1;
    }
    return { kind: 'slots', first: min, positions };
  }
  // Store ordinals only. IDs remain in their owning column even across a full u32 span.
  let capacity = 2;
  while (capacity < count + Math.ceil(count / 2)) capacity *= 2;
  const positions = new Uint32Array(capacity);
  const mask = capacity - 1;
  for (let i = 0; i < count; i++) {
    const value = values[i] as number;
    let bin = generationHash(value) & mask;
    let probes = 0;
    while (positions[bin] !== 0) {
      if (values[(positions[bin] as number) - 1] === value) return null;
      // Bound construction and unsuccessful searches for clustered input.
      if (++probes === PROBE_LIMIT) return sortedOrdinals(values);
      bin = (bin + 1) & mask;
    }
    positions[bin] = i + 1;
  }
  return { kind: 'hashed', values, positions };
}

const PROBE_LIMIT = 32;

function generationHash(value: number): number {
  const mixed = Math.imul(value ^ (value >>> 16), 0x9e3779b1);
  return mixed ^ (mixed >>> 16);
}

function sortedOrdinals(values: Uint32Array): SortedGenerations | null {
  const count = values.length;
  const ordinals = new Uint32Array(count);
  for (let i = 0; i < count; i++) ordinals[i] = i;
  ordinals.sort((a, b) => (values[a] as number) - (values[b] as number));
  for (let i = 1; i < count; i++)
    if (values[ordinals[i] as number] === values[ordinals[i - 1] as number]) return null;
  return { kind: 'sorted', values, ordinals };
}

function orderOf(column: GenerationColumn): GenerationOrder | null {
  const fixed = column[issuedOrder];
  return fixed === undefined ? measureOrder(column) : fixed;
}

/** Freshly detached data owns its index. Foreign and transported columns are read as supplied. */
export function captureInstanceGenerations(source: Uint32Array): Uint32Array {
  const values = new Uint32Array(source);
  Object.defineProperty(values, issuedOrder, { value: measureOrder(values) });
  return values;
}

/** The projection store mints successive IDs. Its ordinary range needs no inverse array. */
export function issueInstanceGenerations(first: number, count: number): Uint32Array {
  const values = new Uint32Array(count);
  for (let i = 0; i < count; i++) values[i] = first + i;
  const order: GenerationOrder | null =
    first > 0 && first + count - 1 <= 0xffffffff
      ? { kind: 'range', first, length: count }
      : measureOrder(values);
  Object.defineProperty(values, issuedOrder, { value: order });
  return values;
}

function ordinalOf(order: GenerationOrder, value: number): number | undefined {
  if (order.kind === 'range') {
    const ordinal = value - order.first;
    return ordinal >= 0 && ordinal < order.length ? ordinal : undefined;
  }
  if (order.kind === 'slots') {
    const encoded = order.positions[value - order.first] ?? 0;
    return encoded === 0 ? undefined : encoded - 1;
  }
  if (order.kind === 'hashed') {
    const mask = order.positions.length - 1;
    let bin = generationHash(value) & mask;
    for (let probes = 0; probes < PROBE_LIMIT; probes++) {
      const ordinal = (order.positions[bin] as number) - 1;
      if (ordinal < 0) return undefined;
      if (order.values[ordinal] === value) return ordinal;
      bin = (bin + 1) & mask;
    }
    return undefined;
  }
  let low = 0;
  let high = order.values.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const ordinal = order.ordinals?.[mid] ?? mid;
    const candidate = order.values[ordinal] as number;
    if (candidate === value) return ordinal;
    if (candidate < value) low = mid + 1;
    else high = mid - 1;
  }
  return undefined;
}

export const SAME_INSTANCE_ORDINALS = Symbol('same instance ordinals');
export type InstanceOrdinalOrder = GenerationOrder | typeof SAME_INSTANCE_ORDINALS;

/** Borrow the submitted column's order. Both generation columns must stay stable while read. */
export function matchInstanceOrdinals(
  current: Uint32Array,
  previous: Uint32Array,
): InstanceOrdinalOrder | undefined {
  const before = orderOf(previous);
  if (before === null) return undefined;
  if (current === previous) return SAME_INSTANCE_ORDINALS;
  const after = orderOf(current);
  if (after === null) return undefined;
  if (
    after.kind === 'range' &&
    before.kind === 'range' &&
    after.first === before.first &&
    after.length <= before.length
  )
    return SAME_INSTANCE_ORDINALS;
  if (after.kind === 'sorted' && before.kind === 'sorted' && current.length <= previous.length) {
    let ordinal = 0;
    while (ordinal < current.length && current[ordinal] === previous[ordinal]) ordinal++;
    if (ordinal === current.length) return SAME_INSTANCE_ORDINALS;
  }
  return before;
}

export function previousInstanceOrdinal(
  order: InstanceOrdinalOrder | undefined,
  generation: number | undefined,
  ordinal: number,
): number | undefined {
  if (order === SAME_INSTANCE_ORDINALS) return ordinal;
  return order === undefined || generation === undefined ? undefined : ordinalOf(order, generation);
}

/** Temporal validity requires an exact prior identity for every current row. */
export function survivingInstanceOrdinals(
  current: Uint32Array | undefined,
  previous: Uint32Array | undefined,
): InstanceOrdinalOrder | undefined {
  if (current === undefined || previous === undefined || current.length > previous.length)
    return undefined;
  const order = matchInstanceOrdinals(current, previous);
  if (order === undefined || order === SAME_INSTANCE_ORDINALS) return order;
  for (let i = 0; i < current.length; i++)
    if (ordinalOf(order, current[i] as number) === undefined) return undefined;
  return order;
}

export function uniqueInstanceIdentities(column: Uint32Array): boolean {
  return orderOf(column) !== null;
}
