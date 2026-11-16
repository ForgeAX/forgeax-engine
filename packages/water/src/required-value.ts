/** Runtime counterpart for values guaranteed by validated Water data invariants. */
export function requireWaterValue<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error('Water data invariant expected a present value');
  }
  return value;
}
