/** Execute the generated query declarations without re-running page asset setup. */
export function generatedPlayerQueries(source: string): string {
  const queryStart = source.indexOf('const query = new URLSearchParams(location.search);');
  const queryEnd = source.indexOf('const resourceValue =', queryStart);
  const diagnosticsStart = source.indexOf('const gpuPassTiming =', queryEnd);
  const diagnosticsEnd = source.indexOf('const recipeValue =', diagnosticsStart);
  if (
    queryStart < 0 ||
    queryEnd <= queryStart ||
    diagnosticsStart <= queryEnd ||
    diagnosticsEnd <= diagnosticsStart
  ) {
    throw new Error('Generated player query declaration boundaries are missing');
  }
  return `${source.slice(queryStart, queryEnd)}\n${source.slice(diagnosticsStart, diagnosticsEnd)}`;
}
