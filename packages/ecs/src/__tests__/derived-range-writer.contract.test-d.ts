import type { Component } from '../component';
import { getDerivedWriter } from '../internal';
import type { DerivedColumnBinding, DerivedRangeKernel } from '../query/derived-range-writer';
import type { Query, QuerySpan } from '../query/query';

declare const Value: Component<'DerivedRangeWriterValue', { value: 'f32' }>;
declare const span: QuerySpan<readonly [], readonly [typeof Value]>;
declare const query: Query<readonly [], readonly [typeof Value]>;
declare const readOnlyQuery: Query<readonly [typeof Value], readonly []>;
declare const binding: DerivedColumnBinding<typeof Value, typeof Value>;
const kernel: DerivedRangeKernel<typeof Value, typeof Value> = (
  nextBinding,
  base,
  start,
  count,
  _context,
) => {
  nextBinding.write.value[base + start] = count;
  binding.write.value[0] = nextBinding.write.value[base + start] ?? 0;
};
void kernel;

// The derived writer is intentionally absent from the public Query contract.
// It is resolved through the package-internal typed accessor instead.
void getDerivedWriter(query, Value);
// @ts-expect-error Query must not expose the package-internal writer as a string method.
query.derivedWriter(Value);
// @ts-expect-error A read-only Query cannot create a derived writer.
readOnlyQuery.derivedWriter(Value);

// A writer is query-owned and package-internal; QuerySpan has no writer method.
// @ts-expect-error QuerySpan must not expose a public derived writer protocol.
span.derivedWriter(Value);
// @ts-expect-error QuerySpan must not expose raw table or storage handles.
span.table;
