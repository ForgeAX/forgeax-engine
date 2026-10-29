import {
  bufferFieldByteLength,
  type Component,
  type ComponentSchema,
  componentDefinition,
  componentId,
  type ScalarFieldType,
  type TypedArrayFor,
} from '../component';
import { QueryBatchUnavailableError } from '../errors/query-batch-errors';
import type { FieldView } from '../storage/column';
import type { Table } from '../storage/table';
import type { QueryDescriptor } from './query';

type InlineScalar = Exclude<ScalarFieldType, 'ref'> | 'entity';
type InlineField = InlineScalar | `buffer<${number}>` | `array<${InlineScalar}, ${number}>`;
type Schema<C> = C extends Component<string, infer S> ? S : never;
export type NumericField<C extends Component> = Extract<
  {
    [F in keyof Schema<C>]: Schema<C>[F] extends InlineField ? F : never;
  }[keyof Schema<C>],
  string
>;
type ArrayFor<C extends Component, F extends NumericField<C>> = Extract<
  TypedArrayFor<Schema<C>[F] & ComponentSchema[string]>,
  FieldView
>;

/** Read capability; mutators and the backing buffer are intentionally absent. */
export interface ReadonlyColumn<A extends ArrayLike<number> = ArrayLike<number>> {
  readonly length: number;
  readonly [index: number]: A[number];
}

export interface QueryBatchColumns<
  R extends readonly Component[] = readonly Component[],
  W extends readonly Component[] = readonly Component[],
  O extends readonly Component[] = readonly Component[],
> {
  readonly count: number;
  /** Full physical entity column; index by a physical row, not selection ordinal. */
  readonly entities: ReadonlyColumn<Uint32Array>;
  read<C extends R[number] | W[number], F extends NumericField<C>>(
    component: C,
    field: F,
  ): ReadonlyColumn<ArrayFor<C, F>>;
  read<C extends O[number], F extends NumericField<C>>(
    component: C,
    field: F,
  ): ReadonlyColumn<ArrayFor<C, F>> | undefined;
  stride<C extends R[number] | W[number] | O[number], F extends NumericField<C>>(
    component: C,
    field: F,
  ): number;
}

export type QueryBatch<
  R extends readonly Component[] = readonly Component[],
  W extends readonly Component[] = readonly Component[],
  O extends readonly Component[] = readonly Component[],
> = QueryBatchColumns<R, W, O> &
  (
    | { readonly kind: 'range'; readonly start: number; readonly end: number }
    | { readonly kind: 'indexed'; readonly rows: ReadonlyColumn<Uint32Array> }
  );

/** Prepared Query validation; column access has no per-entity wrapper. */
export interface BatchLease {
  structureEpoch: number;
  readonly assertReadable: () => void;
  active: boolean;
  generation: number;
}

function inlineField(component: Component, field: string) {
  const definition = componentDefinition(component);
  const reflection = definition.fields[field];
  if (reflection === undefined)
    throw new QueryBatchUnavailableError('unknown-field', component.name, field);
  const kind = definition.plan.fields[field]?.kind;
  const element = reflection.arrayMeta?.elementType;
  const numericArray =
    kind === 'fixed-array' &&
    element !== undefined &&
    element !== 'ref' &&
    !element.startsWith('shared<') &&
    !element.startsWith('asset<');
  if (
    !(kind === 'number' && reflection.type !== 'ref') &&
    kind !== 'bool' &&
    kind !== 'entity' &&
    kind !== 'fixed-buffer' &&
    !numericArray
  ) {
    throw new QueryBatchUnavailableError('non-numeric-field', component.name, field);
  }
  return reflection;
}

class BatchColumns<
  R extends readonly Component[],
  W extends readonly Component[],
  O extends readonly Component[],
> implements QueryBatchColumns<R, W, O>
{
  readonly #table: Table;
  readonly #descriptor: QueryDescriptor<R, W, O>;
  readonly #lease: BatchLease;
  readonly #generation: number;
  constructor(
    table: Table,
    descriptor: QueryDescriptor<R, W, O>,
    lease: BatchLease,
    readonly count: number,
  ) {
    this.#table = table;
    this.#descriptor = descriptor;
    this.#lease = lease;
    this.#generation = lease.generation;
  }

  protected assertLive(): void {
    if (!this.#lease.active || this.#lease.generation !== this.#generation)
      throw new QueryBatchUnavailableError('expired-batch');
    this.#lease.assertReadable();
  }

  get entities(): ReadonlyColumn<Uint32Array> {
    this.assertLive();
    return this.#table.entities.view as Uint32Array;
  }

  private field(component: Component, field: string) {
    this.assertLive();
    const required =
      this.#descriptor.read?.includes(component) === true ||
      this.#descriptor.write?.includes(component) === true;
    if (!required && this.#descriptor.optional?.includes(component) !== true)
      throw new QueryBatchUnavailableError('undeclared-component', component.name, field);
    inlineField(component, field);
    const column = this.#table.storage.get(componentId(component))?.fields.get(field);
    if (required && column === undefined)
      throw new QueryBatchUnavailableError('missing-required-data', component.name, field);
    return column;
  }

  read<C extends R[number] | W[number], F extends NumericField<C>>(
    component: C,
    field: F,
  ): ReadonlyColumn<ArrayFor<C, F>>;
  read<C extends O[number], F extends NumericField<C>>(
    component: C,
    field: F,
  ): ReadonlyColumn<ArrayFor<C, F>> | undefined;
  read(component: Component, field: string): ReadonlyColumn<FieldView> | undefined {
    return this.field(component, field)?.view;
  }

  stride<C extends R[number] | W[number] | O[number], F extends NumericField<C>>(
    component: C,
    field: F,
  ): number {
    const column = this.field(component, field);
    if (column !== undefined) return column.arity;
    const reflection = componentDefinition(component).fields[field];
    if (reflection === undefined)
      throw new QueryBatchUnavailableError('unknown-field', component.name, field);
    if (reflection.arrayMeta?.length !== undefined) return reflection.arrayMeta.length;
    return reflection.type.startsWith('buffer<') ? bufferFieldByteLength(reflection.type) : 1;
  }
}

export class RangeBatch<
  R extends readonly Component[],
  W extends readonly Component[],
  O extends readonly Component[],
> extends BatchColumns<R, W, O> {
  readonly kind = 'range' as const;
  constructor(
    table: Table,
    descriptor: QueryDescriptor<R, W, O>,
    lease: BatchLease,
    readonly start: number,
    readonly end: number,
  ) {
    super(table, descriptor, lease, end - start);
  }
}

export class IndexedBatch<
  R extends readonly Component[],
  W extends readonly Component[],
  O extends readonly Component[],
> extends BatchColumns<R, W, O> {
  readonly kind = 'indexed' as const;
  readonly #rows: Uint32Array;
  constructor(
    table: Table,
    descriptor: QueryDescriptor<R, W, O>,
    lease: BatchLease,
    rows: Uint32Array,
    count: number,
  ) {
    super(table, descriptor, lease, count);
    this.#rows = rows;
  }
  get rows(): ReadonlyColumn<Uint32Array> {
    this.assertLive();
    return this.#rows;
  }
}
