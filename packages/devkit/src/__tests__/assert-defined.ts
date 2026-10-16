import assert from 'node:assert/strict';

/** Fail the fixture at the missing value, before using it in a later assertion. */
export function defined<T>(value: T): NonNullable<T> {
  assert(value !== undefined && value !== null, 'required fixture value is absent');
  return value;
}
