/** Select one published module by its emitted entry-point spelling. */
export function findPublishedKernel(
  entries: Iterable<{ readonly wgsl: string }>,
  entryPoint: string,
): string | undefined {
  let source: string | undefined;
  for (const entry of entries) {
    if (!entry.wgsl.includes(`fn ${entryPoint}(`)) continue;
    if (source !== undefined) return undefined;
    source = entry.wgsl;
  }
  return source;
}

export function requirePublishedKernel(
  entries: Iterable<{ readonly wgsl: string }>,
  entryPoint: string,
): string {
  const source = findPublishedKernel(entries, entryPoint);
  if (source === undefined) throw new Error(`expected one published ${entryPoint} kernel`);
  return source;
}
