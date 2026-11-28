export function bad(values: { size: number }[], items: number[], out: number[]): number {
  out.push(...items);
  return Math.max(...values.map((v) => v.size));
}
